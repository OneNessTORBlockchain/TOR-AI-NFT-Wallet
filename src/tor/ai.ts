/**
 * ai.ts — bring-your-own-key AI providers, with the endpoints nailed down.
 *
 * Two rules shape this file:
 *
 *   1. **The endpoint is not an input.** Every provider's base URL is a constant
 *      here and is shown read-only on screen. The only thing a user types is an
 *      API key. That is what stops a phishing page (or a careless support reply)
 *      from persuading someone to paste a key "into" a URL someone else chose:
 *      there is no field to type a URL into.
 *   2. **A key lives in memory, not on disk.** Keys sit in a module-level Map for
 *      the life of the page. "Keep for this tab" moves them to `sessionStorage`,
 *      which dies with the tab. `localStorage` is never used — a key that survives
 *      a browser restart is a key that survives a stolen laptop.
 *
 * The node itself can answer without any key: `POST /api/ai/chat` proxies a free
 * OpenRouter model, and that is the default. The BYO providers exist for when the
 * node's own key is unset or the caller wants a specific model.
 */
import { API_BASE } from "./api";
import type { NftMetadata } from "./api";

export type ProviderId =
  | "node"
  | "openrouter"
  | "openai"
  | "anthropic"
  | "huggingface"
  | "venice"
  | "ollama";

export type Provider = {
  id: ProviderId;
  label: string;
  /** Fixed origin. Displayed, never editable. */
  endpoint: string;
  /** Where a human creates the key. */
  keyUrl: string;
  /** The provider's own API reference — the documentation this adapter follows. */
  docsUrl: string;
  /** Shown under the key box so a wrong paste is caught before the call. */
  keyHint: string;
  /** Cheap shape check. Not a security control — the provider is the authority. */
  pattern?: RegExp;
  needsKey: boolean;
  defaultModel: string;
  /** One line describing the wire format, for the panel and the docs. */
  transport: string;
  note?: string;
};

export const PROVIDERS: Provider[] = [
  {
    id: "node",
    label: "OneNess TOR node",
    endpoint: `${API_BASE}/api/ai/chat`,
    keyUrl: "",
    docsUrl: `${API_BASE}/api/docs/endpoints`,
    keyHint: "no key needed — the node holds its own OpenRouter key server-side",
    needsKey: false,
    defaultModel: "openrouter/free",
    transport: "POST /api/ai/chat {prompt, model, nft} → the node prepends the I AM THIS NFT persona",
    note: "The safest option: the key never reaches a browser. If the node's upstream is down it says so instead of inventing an answer.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    keyUrl: "https://openrouter.ai/keys",
    docsUrl: "https://openrouter.ai/docs/api-reference/overview",
    keyHint: "sk-or-v1-…",
    pattern: /^sk-or-v1-[0-9a-f]{64}$/i,
    needsKey: true,
    defaultModel: "openrouter/auto",
    transport: "POST /chat/completions, Authorization: Bearer <key>, OpenAI-compatible messages[]",
  },
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1/chat/completions",
    keyUrl: "https://platform.openai.com/api-keys",
    docsUrl: "https://platform.openai.com/docs/api-reference/chat/create",
    keyHint: "sk-… (project keys start sk-proj-)",
    pattern: /^sk-[A-Za-z0-9_-]{20,}$/,
    needsKey: true,
    defaultModel: "gpt-4o-mini",
    transport: "POST /v1/chat/completions, Authorization: Bearer <key>, messages[]",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    endpoint: "https://api.anthropic.com/v1/messages",
    keyUrl: "https://console.anthropic.com/settings/keys",
    docsUrl: "https://docs.anthropic.com/en/api/messages",
    keyHint: "sk-ant-…",
    pattern: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
    needsKey: true,
    defaultModel: "claude-3-5-sonnet-latest",
    transport:
      "POST /v1/messages, x-api-key + anthropic-version: 2023-06-01 + anthropic-dangerous-direct-browser-access: true",
    note: "Anthropic requires the direct-browser header for CORS from a web page. That header is why this call works from a browser at all — it is also why a key pasted here is a key this page can see.",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    endpoint: "https://api-inference.huggingface.co/models/{model}",
    keyUrl: "https://huggingface.co/settings/tokens",
    docsUrl: "https://huggingface.co/docs/api-inference/tasks/text-generation",
    keyHint: "hf_…",
    pattern: /^hf_[A-Za-z0-9]{20,}$/,
    needsKey: true,
    defaultModel: "meta-llama/Meta-Llama-3-8B-Instruct",
    transport: "POST /models/{model} {inputs, parameters} — text-generation task, not chat completions",
    note: "The model path is the {model} segment of the URL. A cold model may answer 503 while it loads; the error is shown verbatim.",
  },
  {
    id: "venice",
    label: "Venice AI",
    endpoint: "https://api.venice.ai/api/v1/chat/completions",
    keyUrl: "https://venice.ai/settings/api",
    docsUrl: "https://docs.venice.ai/api-reference/endpoint/chat/completions",
    keyHint: "a Venice API key from Settings → API",
    needsKey: true,
    defaultModel: "venice-uncensored",
    transport: "POST /api/v1/chat/completions, Authorization: Bearer <key>, OpenAI-compatible messages[]",
  },
  {
    id: "ollama",
    label: "Local Ollama",
    endpoint: "http://127.0.0.1:11434/api/chat",
    keyUrl: "",
    docsUrl: "https://github.com/ollama/ollama/blob/main/docs/api.md",
    keyHint: "no key — the model runs on your machine",
    needsKey: false,
    defaultModel: "llama3.2",
    transport: "POST /api/chat {model, messages, stream:false} → message.content",
    note: "Nothing leaves your machine. Start it with `ollama serve` and allow this origin: OLLAMA_ORIGINS=https://<this-host>.",
  },
];

export function provider(id: ProviderId): Provider {
  const found = PROVIDERS.find((item) => item.id === id);
  if (!found) throw new Error(`unknown AI provider ${id}`);
  return found;
}

/* --------------------------------------------------------------- key vault */

/**
 * Memory first, sessionStorage only on request. `localStorage` is deliberately
 * absent: this module has no code path that can write a key to disk.
 */
const memory = new Map<ProviderId, string>();
const SESSION_SLOT = "tor.ai.keys";
let remember = false;

function readTabStore(): Partial<Record<ProviderId, string>> {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_SLOT) || "{}");
  } catch {
    return {};
  }
}

export const keyVault = {
  /** The key for this provider, or "" — never throws, never logs. */
  get(id: ProviderId): string {
    const inMemory = memory.get(id);
    if (inMemory) return inMemory;
    if (!remember) return "";
    const stored = readTabStore()[id];
    if (typeof stored === "string" && stored) {
      memory.set(id, stored);
      return stored;
    }
    return "";
  },
  set(id: ProviderId, value: string) {
    const key = value.trim();
    if (!key) return keyVault.forget(id);
    memory.set(id, key);
    if (remember) {
      const store = readTabStore();
      store[id] = key;
      try {
        sessionStorage.setItem(SESSION_SLOT, JSON.stringify(store));
      } catch {
        /* quota or a locked-down browser: memory still holds it for this page */
      }
    }
  },
  forget(id: ProviderId) {
    memory.delete(id);
    const store = readTabStore();
    delete store[id];
    try {
      sessionStorage.setItem(SESSION_SLOT, JSON.stringify(store));
    } catch {
      /* nothing to clean up */
    }
  },
  forgetAll() {
    memory.clear();
    try {
      sessionStorage.removeItem(SESSION_SLOT);
    } catch {
      /* nothing to clean up */
    }
  },
  /** Whether "keep for this tab" is on. */
  remembering: () => remember,
  setRemembering(next: boolean) {
    remember = next;
    if (!next) {
      try {
        sessionStorage.removeItem(SESSION_SLOT);
      } catch {
        /* nothing to clean up */
      }
    }
  },
  /** A display-safe fragment: enough to tell two keys apart, useless as a key. */
  redact(value: string): string {
    if (!value) return "";
    if (value.length <= 12) return `${value.slice(0, 3)}…`;
    return `${value.slice(0, 7)}…${value.slice(-4)}`;
  },
};

/* ----------------------------------------------------------------- persona */

/**
 * The same block the node prepends, built locally for the BYO providers so an
 * AI-NFT speaks the same way whichever model is behind it.
 */
export function personaBlock(nft: NftMetadata | null): string {
  if (!nft) return "";
  const traits = (nft.attributes || [])
    .map((attribute) => `${attribute.trait_type}: ${attribute.value}`)
    .join(", ");
  return [
    "I AM THIS NFT.",
    `Name: ${nft.name || "unnamed"}`,
    `Symbol: ${nft.symbol || "—"}`,
    `Token id: ${nft.token_id ?? "—"}`,
    `Chain: ${nft.chain || "—"}`,
    `Owner: ${nft.owner_wallet || "—"}`,
    `Traits: ${traits || "none"}`,
    nft.description ? `Description: ${nft.description}` : "",
    "Answer in the first person as this NFT, using only the facts above and the OneNess TOR chain context. Never invent a balance, a price or a transaction.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Exactly the fields the node's `persona_block` reads. The raw metadata document
 * stays home — the model never needs a copy of it, and neither does the wire.
 */
export function personaFields(nft: NftMetadata | null): Record<string, unknown> | undefined {
  if (!nft) return undefined;
  return {
    address: nft.address,
    token_id: nft.token_id,
    chain: nft.chain,
    source: nft.source,
    standard: nft.standard,
    name: nft.name,
    symbol: nft.symbol,
    description: nft.description,
    image: nft.image,
    animation_url: nft.animation_url,
    external_url: nft.external_url,
    attributes: nft.attributes,
  };
}

/** One turn of a conversation, in the shape every adapter understands. */
export type Turn = { role: "user" | "assistant"; content: string };

export type ChatRequest = {
  provider: ProviderId;
  model?: string;
  messages: Turn[];
  /** System prompt — the persona for an AI-NFT, or the chain context for a wallet. */
  system?: string;
  /** The resolved NFT, when the caller is chatting as one. */
  nft?: NftMetadata | null;
  signal?: AbortSignal;
};

export type ChatReply = {
  text: string;
  provider: ProviderId;
  model: string;
  /** Round-trip milliseconds measured around the fetch. */
  ms: number;
};

/** Whatever the provider called it, find the text. */
function pickText(payload: unknown): string {
  const body = payload as Record<string, any> | null;
  if (!body) return "";
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  return (
    choice?.message?.content ??
    choice?.text ??
    body.message?.content ??
    body.answer ??
    body.reply ??
    body.content ??
    body.text ??
    (Array.isArray(body) ? body[0]?.generated_text : null) ??
    body.generated_text ??
    ""
  );
}

const TIMEOUT_MS = 120_000;

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const relay = () => controller.abort();
  signal?.addEventListener("abort", relay, { once: true });
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    let payload: unknown = raw;
    try {
      payload = JSON.parse(raw);
    } catch {
      /* a non-JSON body is still an answer worth showing verbatim */
    }
    return { status: response.status, payload };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", relay);
  }
}

/**
 * Talk to one provider. The key, when there is one, is read from the vault rather
 * than passed in by the caller, so no component ever holds it in state.
 */
export async function chat(request: ChatRequest): Promise<ChatReply> {
  const target = provider(request.provider);
  const model = (request.model || target.defaultModel).trim();
  const key = target.needsKey ? keyVault.get(target.id) : "";
  const system = request.system ?? personaBlock(request.nft ?? null);
  const turns = request.messages.length
    ? request.messages
    : [{ role: "user" as const, content: "Introduce yourself in one sentence." }];

  if (target.needsKey && !key) {
    throw new Error(
      `${target.label} needs an API key — paste one on #/ai. It is kept in this tab only.`,
    );
  }

  const started = performance.now();
  let payload: unknown;
  let status = 0;

  /* ---- the node's own gateway: no key leaves the browser because none is sent */
  if (target.id === "node") {
    const lastUser = [...turns].reverse().find((turn) => turn.role === "user");
    const answer = await postJson(
      `${API_BASE}/api/ai/chat`,
      {},
      {
        prompt: lastUser?.content ?? "",
        messages: turns,
        model,
        nft: personaFields(request.nft ?? null),
      },
      request.signal,
    );
    status = answer.status;
    payload = answer.payload;
    const body = payload as { ok?: boolean; data?: unknown; error?: unknown } | null;
    if (status >= 400 || body?.ok === false) throw failure(status, body?.error ?? payload, target.label);
    payload = body?.data ?? payload;
  }

  /* ---- Hugging Face: text-generation, not chat completions */
  else if (target.id === "huggingface") {
    const transcript = [
      system,
      ...turns.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.content}`),
      "Assistant:",
    ]
      .filter(Boolean)
      .join("\n\n");
    const answer = await postJson(
      `https://api-inference.huggingface.co/models/${encodeURIComponent(model)}`,
      { authorization: `Bearer ${key}` },
      { inputs: transcript, parameters: { max_new_tokens: 512, return_full_text: false } },
      request.signal,
    );
    status = answer.status;
    payload = answer.payload;
    if (status >= 400) throw failure(status, payload, target.label);
  }

  /* ---- Anthropic: /v1/messages, system is its own field, x-api-key not Bearer */
  else if (target.id === "anthropic") {
    const answer = await postJson(
      target.endpoint,
      {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        /* Required for a browser origin; without it the preflight fails. */
        "anthropic-dangerous-direct-browser-access": "true",
      },
      {
        model,
        max_tokens: 1024,
        ...(system ? { system } : {}),
        messages: turns.map((turn) => ({ role: turn.role, content: turn.content })),
      },
      request.signal,
    );
    status = answer.status;
    payload = answer.payload;
    if (status >= 400) throw failure(status, payload, target.label);
  }

  /* ---- OpenAI-compatible: OpenAI, OpenRouter, Venice, and local Ollama's chat */
  else if (target.id === "ollama") {
    const answer = await postJson(
      "http://127.0.0.1:11434/api/chat",
      {},
      {
        model,
        stream: false,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
        ],
      },
      request.signal,
    );
    status = answer.status;
    payload = answer.payload;
    if (status >= 400) throw failure(status, payload, target.label);
  }

  /* ---- plain OpenAI-compatible chat completions */
  else {
    const headers: Record<string, string> = { authorization: `Bearer ${key}` };
    if (target.id === "openrouter") {
      /* OpenRouter attributes traffic with these two optional headers. */
      headers["HTTP-Referer"] = window.location.origin;
      headers["X-Title"] = "TOR AI-NFT Wallet";
    }
    const answer = await postJson(
      target.endpoint,
      headers,
      {
        model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          ...turns.map((turn) => ({ role: turn.role, content: turn.content })),
        ],
      },
      request.signal,
    );
    status = answer.status;
    payload = answer.payload;
    if (status >= 400) throw failure(status, payload, target.label);
  }

  const text = String(pickText(payload) || "").trim();
  if (!text) {
    throw new Error(
      `${target.label} answered ${status} with no readable text — raw body: ${JSON.stringify(payload).slice(0, 300)}`,
    );
  }
  return { text, provider: target.id, model, ms: Math.round(performance.now() - started) };
}

/** The provider's own words for a failure, never our guess at them. */
function failure(status: number, payload: unknown, label: string): Error {
  const body = payload as Record<string, any> | null;
  const text =
    body?.error?.message ??
    body?.error ??
    body?.message ??
    (typeof payload === "string" ? payload : "");
  const detail = typeof text === "string" && text ? text : `HTTP ${status}`;
  const error = new Error(`${label} refused the call: ${detail}`);
  (error as Error & { status?: number }).status = status;
  return error;
}
