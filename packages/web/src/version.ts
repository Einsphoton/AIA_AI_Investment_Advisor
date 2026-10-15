/**
 * Bundle-level version identity (owner: Lead).
 *
 * `__AIA_VERSION__` is replaced with the root `package.json` version at build
 * time by every web bundle (`packages/web/scripts/app-version-plugin.mjs`), so the
 * corner badge can show the version of the code that is *actually loaded in this
 * browser* without waiting for the API (and without a hand-maintained copy that
 * would drift). The identifier is declared in `env.d.ts`.
 */
export const BUNDLE_VERSION: string = typeof __AIA_VERSION__ === 'string' ? __AIA_VERSION__ : '';
