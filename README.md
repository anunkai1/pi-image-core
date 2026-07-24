# pi-image-core

Shared core for the `pi-*-image` extensions (`pi-venice-image`,
`pi-openrouter-image`, `pi-openai-codex-image`, `pi-local-image`).

Before this package existed, each extension copy-pasted the same plumbing —
upload persistence, the `~/.config/acb/image-model` override file, retrying
image-API fetch, model resolution, and (worst) `pi-local-image` *mirrored*
the Venice / OpenRouter / Codex model catalogs and HTTP calls so it could
route `/imggen` to any backend "without a fragile cross-extension import".

`pi-image-core` is that shared import. It is loaded by pi via jiti exactly
like the extensions themselves (no build step — `.ts` source all the way
down), and each extension depends on it via a `file:../pi-image-core`
dependency (symlinked into its `node_modules` on `npm install`).

## What lives here

| module | holds |
|---|---|
| `persist` | `OUTPUT_URL_PREFIX`, `resolveOutputDir`, `resolveFormat`, `writeBase64`, `ensureOutputDir`, `persistImage` |
| `override` | the shared override file + source-tag helpers (`tag`/`untag`/`imageModelSource`), legacy migration |
| `resolve` | parameterized `resolveModel({ ownPrefix, envVar, defaultModel })` |
| `retry` | `sleep`, `withTimeout`, and a generic retrying `callImageApi` |
| `catalogs` | the Venice / OpenRouter / OpenRouter / Codex / Local model lists + `is*Model` classifiers |
| `auth` | `getVeniceKey`, `getOpenRouterKey`, `getOpenAICodexAuth` (with refresh) |
| `util` | `formatCost`, `extFromMediaType`, `extFromOutputFormat`, `resolveInputImageUrl`, `sniffMimeType` |

Each extension keeps only its provider-specific bits: the endpoint URL,
the response type, and a thin call wrapper.
