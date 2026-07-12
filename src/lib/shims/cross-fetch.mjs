// ESM shim for `cross-fetch` (a CommonJS package). The workerd runtime — both the `astro dev`
// module runner and production Workers — provides a global `fetch`/`Headers`/`Request`/`Response`,
// so `cross-fetch`'s Node ponyfill is dead weight and, worse, its raw CJS can't be evaluated by the
// dev module runner (`exports is not defined`). `@supadata/js` only uses cross-fetch as a fallback
// (`fetch || crossFetch`), so aliasing it to the native globals is behaviour-preserving.
//
// Bindings are read off `globalThis` into module-scoped consts so the named exports are real static
// bindings (Rollup/ESLint reject bare-global re-exports).
const nativeFetch = globalThis.fetch;

export default nativeFetch;
export const fetch = nativeFetch;
export const Headers = globalThis.Headers;
export const Request = globalThis.Request;
export const Response = globalThis.Response;
