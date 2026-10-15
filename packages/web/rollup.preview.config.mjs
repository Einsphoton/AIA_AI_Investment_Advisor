/**
 * Bundles the 财报面板 preview generator into a Node-runnable file
 * (`npm run preview:financials`).
 *
 * Sibling of `rollup.test.config.mjs`: same plugins, different entry — the preview
 * renders the real component with real datasource data into a self-contained HTML
 * so a human can eyeball the panel in a browser (this project has no browser test
 * runner, and headless browsers cannot start inside the local sandbox).
 */
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export default {
  input: resolvePath(here, 'test/preview-financials.tsx'),
  output: {
    file: resolvePath(here, 'dist-test/preview-financials.js'),
    format: 'esm',
    inlineDynamicImports: true,
  },
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
    if (warning.code === 'MODULE_LEVEL_DIRECTIVE' || warning.code === 'CIRCULAR_DEPENDENCY') return;
    if (warning.code === 'SOURCEMAP_ERROR') return;
    warn(warning);
  },
};
