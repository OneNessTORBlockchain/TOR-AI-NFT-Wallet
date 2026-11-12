# AI providers — endpoint reference

Everything here is implemented in `src/tor/ai.ts` and rendered read-only on `#/ai`. The endpoint is a
**constant**; the only thing a user types is a key.

| id | Label | Endpoint | Key | Docs |
| --- | --- | --- | --- | --- |
| `node` | OneNess TOR node | `POST {node}/api/ai/chat` | none | `GET {node}/api/docs/endpoints` |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1/chat/completions` | yes | https://openrouter.ai/docs/api-reference/overview |
| `openai` | OpenAI | `https://api.openai.com/v1/chat/completions` | yes | https://platform.openai.com/docs/api-reference/chat/create |
| `anthropic` | Anthropic | `https://api.anthropic.com/v1/messages` | yes | https://docs.anthropic.com/en/api/messages |
| `huggingface` | Hugging Face | `https://api-inference.huggingface.co/models/{model}` | yes | https://huggingface.co/docs/api-inference/tasks/text-generation |
| `venice` | Venice AI | `https://api.venice.ai/api/v1/chat/completions` | yes | https://docs.venice.ai/api-reference/endpoint/chat/completions |
| `ollama` | Local Ollama | `http://127.0.0.1:11434/api/chat` | none | https://github.com/ollama/ollama/blob/main/docs/api.md |

`{node}` is `API_BASE` from `src/tor/api.ts` — `https://www.torblockchain.fun` unless the build overrode it.

---

## The node gateway (default)

```http
POST {node}/api/ai/chat
content-type: application/json

{ "prompt": "Who are you?", "messages": [...], "model": "openrouter/free", "nft": { ... } }
```

The node prepends its `I AM THIS NFT` persona block, holds the upstream key server-side, and returns
`data` with the answer. **No credential exists in the browser on this path**, which is why it is the
default.

The `nft` field carries only the fields `persona_block` reads (`personaFields()`), never the raw metadata
document.

Live status on 2026-11-12: `HTTP 502 · OPENROUTER_ERROR · OpenRouter answered 401 — "User not found"`.
That is the node's upstream key, not this client. The UI prints that string; it does not paper over it.

---

## OpenRouter

```http
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer sk-or-v1-…
HTTP-Referer: <this page's origin>
X-Title: TOR AI-NFT Wallet

{ "model": "openrouter/auto", "messages": [{ "role": "system", … }, { "role": "user", … }] }
```

Keys look like `sk-or-v1-` + 64 hex; the save button refuses anything that does not. `openrouter/auto`
picks a model; `openrouter/free` restricts to free ones.

## OpenAI

```http
POST https://api.openai.com/v1/chat/completions
Authorization: Bearer sk-…
```

OpenAI-compatible chat completions. Project keys (`sk-proj-…`) work identically. CORS is allowed from
browser origins, so no proxy is needed.

## Anthropic

```http
POST https://api.anthropic.com/v1/messages
x-api-key: sk-ant-…
anthropic-version: 2023-06-01
anthropic-dangerous-direct-browser-access: true

{ "model": "claude-3-5-sonnet-latest", "max_tokens": 1024,
  "system": "…", "messages": [{ "role": "user", "content": "…" }] }
```

Three differences from OpenAI and all three matter:

1. the key goes in `x-api-key`, not `Authorization: Bearer`;
2. `anthropic-version` is mandatory and the version is pinned to `2023-06-01`;
3. `anthropic-dangerous-direct-browser-access: true` is required for a page to call it at all. The header
   name is Anthropic's own warning: a browser-held key is exposed to the page.

The system prompt is a top-level `system` field, not a `role: "system"` message.

## Hugging Face

```http
POST https://api-inference.huggingface.co/models/{model}
Authorization: Bearer hf_…

{ "inputs": "<system>\n\nUser: …\n\nAssistant:", "parameters": { "max_new_tokens": 512, "return_full_text": false } }
```

Text-generation, not chat completions: the conversation is flattened into one transcript and the model
path is the `{model}` URL segment (`meta-llama/Meta-Llama-3-8B-Instruct`). A cold model can answer `503`
while it loads — the message is shown verbatim rather than retried silently.

## Venice AI

```http
POST https://api.venice.ai/api/v1/chat/completions
Authorization: Bearer <venice key>
```

OpenAI-compatible. Keys are created at https://venice.ai/settings/api.

## Local Ollama

```bash
ollama serve
# and, so the browser is allowed to call it:
OLLAMA_ORIGINS=https://<this-host> ollama serve
```

```http
POST http://127.0.0.1:11434/api/chat
{ "model": "llama3.2", "stream": false, "messages": [ … ] }
```

No key, no third party, no data leaving the machine. Two things to get right: `stream: false` (the
adapter reads a single JSON body) and `OLLAMA_ORIGINS` (otherwise the browser blocks the preflight
before Ollama ever sees the request). A page served over `https://` calling `http://127.0.0.1` is a
mixed-content request: browsers treat loopback as potentially-trustworthy, but if it is blocked, run the
wallet over `http://127.0.0.1:9010`.

---

## Key handling contract

| | |
| --- | --- |
| Storage | module-level `Map`; optional `sessionStorage` behind "keep for this tab" |
| Never | `localStorage`, cookies, URL, `window.name`, IndexedDB, logs, analytics |
| Display | `keyVault.redact()` only — e.g. `sk-or-v1…4f2a` |
| Transport | that provider's fixed origin, over HTTPS, in the documented header |
| Lifetime | until reload, tab close, **Forget key**, **Wipe all keys**, or sign-out |
| Pre-flight | shape check against the provider's documented key format before saving |

A browser-held key is exposed to any script on the origin. That is a property of the browser, not a bug to
be fixed here — `#/ai` says so in plain words and points at the node gateway instead.

---

## Testing a provider

`#/ai` → **Test this provider** sends one real request (`"Reply with exactly: CHAIN-BOUND OK"`) and prints
the model, the measured round-trip in milliseconds, and the answer — or the provider's own error text.
Nothing is simulated; a wrong key shows the provider's rejection, not a friendly message.
