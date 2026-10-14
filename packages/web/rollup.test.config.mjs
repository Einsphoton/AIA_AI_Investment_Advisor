/**
 * Bundles the headless render smoke test into a single Node-runnable file.
 *
 * Why: this project has no browser test runner (and must not spawn native build
 * tools). `react-dom/server`'s `renderToString` executes the whole component
 * tree without a DOM, which catches import errors, bad hooks usage and crashes
 * in the initial render path of every page.
 */
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  input: resolvePath(here, 'test/render.test.tsx'),
  output: {
    dir: resolvePath(here, 'dist-test'),
    entryFileNames: 'render.test.js',
    format: 'esm',
    sourcemap: true,
    inlineDynamicImports: true,
  },
  treeshake: false,
  plugins: [
    resolve({
      browser: false,
      preferBuiltins: true,
      exportConditions: ['node', 'import', 'default'],
      extensions: ['.ts', '.tsx', '.mjs', '.js', '.jsx', '.json'],
    }),
    commonjs({ transformMixedEsModules: true }),
    typescript({
      tsconfig: resolvePath(here, 'tsconfig.test.json'),
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
};
