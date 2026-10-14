/**
 * Web bundler config (pure-JS toolchain: Rollup + TypeScript).
 *
 * Why not Vite/esbuild: this project must build and run inside restricted
 * environments (and on plain Node) without spawning native helper binaries.
 * Rollup + tsc are pure JavaScript, so `npm run build` behaves identically on
 * Windows, macOS, Linux, in CI and in the Docker image.
 *
 * Output: packages/web/dist/{index.html, assets/app.js}
 */
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const watching = process.argv.includes('--watch') || process.argv.includes('-w');
/**
 * Output directory. The default `dist` is what the server serves and what
 * Docker ships; `AIA_WEB_OUTDIR` lets parallel developers build into a private
 * directory without racing on the shared bundle.
 */
const outDirName = process.env.AIA_WEB_OUTDIR || 'dist';
const outDir = resolvePath(here, outDirName);
/** Minification is on by default; set AIA_WEB_MINIFY=0 for readable output. */
const minify = process.env.AIA_WEB_MINIFY !== '0';
/** Source maps are emitted for local debugging, skipped in slim builds. */
const sourcemap = process.env.AIA_WEB_SOURCEMAP !== '0';

/**
 * Value substituted for `process.env.NODE_ENV` in the browser bundle.
 *
 * The browser has no `process` global: React, ReactDOM and ECharts ship CommonJS
 * entry points that branch on `process.env.NODE_ENV`, so leaving those
 * expressions in the bundle makes the very first line of `app.js` throw
 * `ReferenceError: process is not defined`, `#root` stays empty and the page is
 * blank. Node's test runner cannot catch that (Node *has* `process`), hence this
 * build-time replacement.
 */
const nodeEnv = process.env.AIA_WEB_NODE_ENV || 'production';

/**
 * Replaces `process.env.NODE_ENV` with a string literal in every module.
 *
 * A tiny inline plugin instead of @rollup/plugin-replace keeps the toolchain
 * dependency-free (the project deliberately builds with pure-JS helpers only).
 * The `process.emit` references in React's error hook are guarded by
 * `typeof process === 'object'`, so only `process.env` needs rewriting.
 */
function defineProcessEnv(value) {
  return {
    name: 'define-process-env',
    transform(code) {
      if (!code.includes('process.env.NODE_ENV')) return null;
      return {
        code: code.replace(/process\.env\.NODE_ENV/g, JSON.stringify(value)),
        map: { mappings: '' },
      };
    },
  };
}

/** Copies the static shell into dist so the server can serve it directly. */
function copyHtml() {
  const copy = () => {
    mkdirSync(resolvePath(outDir, 'assets'), { recursive: true });
    copyFileSync(resolvePath(here, 'index.html'), resolvePath(outDir, 'index.html'));
    copyFileSync(resolvePath(here, 'src/styles.css'), resolvePath(outDir, 'assets/styles.css'));
  };
  return {
    name: 'copy-html',
    buildStart: copy,
    watchChange(id) {
      if (id.endsWith('index.html') || id.endsWith('styles.css')) copy();
    },
  };
}

export default {
  input: resolvePath(here, 'src/main.tsx'),
  output: {
    dir: resolvePath(outDir, 'assets'),
    entryFileNames: 'app.js',
    chunkFileNames: '[name].js',
    assetFileNames: '[name][extname]',
    format: 'esm',
    sourcemap,
    inlineDynamicImports: true,
    plugins: minify
      ? [
          terser({
            ecma: 2022,
            compress: { passes: 2, drop_debugger: true },
            format: { comments: false },
          }),
        ]
      : [],
  },
  treeshake: { moduleSideEffects: 'no-external' },
  plugins: [
    defineProcessEnv(nodeEnv),
    copyHtml(),
    resolve({
      browser: true,
      preferBuiltins: false,
      extensions: ['.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
    }),
    commonjs({ transformMixedEsModules: true }),
    typescript({
      tsconfig: resolvePath(here, 'tsconfig.json'),
      noForceEmit: true,
      compilerOptions: { noEmit: false, declaration: false, declarationMap: false },
    }),
  ],
  onwarn(warning, warn) {
    if (warning.code === 'MODULE_LEVEL_DIRECTIVE') return;
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    if (warning.code === 'SOURCEMAP_ERROR') return;
    warn(warning);
  },
  watch: watching ? { clearScreen: false, include: 'src/**' } : undefined,
};
