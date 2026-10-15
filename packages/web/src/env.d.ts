/**
 * Build-time globals injected by the web Rollup configs.
 *
 * `declare` only — the identifier exists solely during bundling, and every use
 * is guarded with `typeof __AIA_VERSION__ === 'string'` so a bundle built
 * without the substitution degrades to "unknown version" rather than throwing.
 *
 * Kept in a `.d.ts` file on purpose: the substitution runs over transpiled
 * modules, and rewriting the token inside a `declare const` statement would
 * produce invalid TypeScript. Type-only files are never loaded as modules, so
 * the plugin cannot touch this one.
 */
declare const __AIA_VERSION__: string;
