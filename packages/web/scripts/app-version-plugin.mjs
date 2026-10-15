/**
 * Build-time app version injection.
 *
 * The root `package.json` `version` is the single source of truth for the app
 * version. The web bundle cannot read a file at runtime, so this plugin
 * substitutes the literal into every `__AIA_VERSION__` reference — the same
 * technique (and the same "no native tooling" constraint) as the
 * `define-process-env` plugin in `rollup.config.mjs`.
 *
 * Used by all three web bundles: the browser bundle (`rollup.config.mjs`), the
 * headless render test and the financials preview (`rollup.test.config.mjs`,
 * `rollup.preview.config.mjs`). Keeping the substitution in every bundle means
 * `typeof __AIA_VERSION__ === 'string'` is always true there, so the constant
 * has a real value instead of silently degrading.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Reads `version` from the root package.json; `''` when unreadable. */
export function readAppVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(here, '..', '..', '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && pkg.version.trim() !== '' ? pkg.version.trim() : '';
  } catch {
    return '';
  }
}

/**
 * Replaces `__AIA_VERSION__` with the version literal.
 *
 * Only modules inside an app `src/` tree are touched. Test code legitimately
 * *mentions* the token (it asserts that the app reads it), and rewriting those
 * mentions would corrupt the test source — e.g. a regex literal `/__AIA_VERSION__/`
 * would silently become `/"0.1.0"/` and stop matching.
 *
 * A missing/unreadable version leaves the token in place; every consumer guards
 * the identifier with `typeof`, so that case degrades to "unknown version"
 * instead of a `ReferenceError` that would blank the page.
 */
export function defineAppVersion(version = readAppVersion(), options = {}) {
  const include = options.include ?? ((id) => /[\\/]src[\\/]/.test(id));
  return {
    name: 'define-app-version',
    transform(code, id) {
      if (version === '' || !include(id) || !code.includes('__AIA_VERSION__')) return null;
      return {
        code: code.replace(/__AIA_VERSION__/g, JSON.stringify(version)),
        map: { mappings: '' },
      };
    },
  };
}
