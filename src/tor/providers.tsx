/**
 * providers.tsx — `#/ai`: the AI provider desk.
 *
 * The rule this page exists to enforce: **the only thing a user types into a
 * secret field here is an API key.** Every endpoint is a constant from `ai.ts`,
 * rendered read-only with a link to the vendor's own documentation, because a
 * page that lets someone paste a key next to an editable URL is a page that can
 * be talked into sending that key anywhere.
 *
 * Model names come from a fixed list per provider (documented defaults), so there
 * is no second free-text field that could be confused with a credential either.
 */
import { useState } from "react";
import { PROVIDERS, chat, keyVault } from "./ai";
import type { Provider, ProviderId } from "./ai";
import { useToast } from "./ui";
import { GuardNotice } from "./security";

/** Documented model names per provider — a picklist, not a free-text field. */
const MODELS: Record<ProviderId, string[]> = {
  node: ["openrouter/free"],
  openrouter: ["openrouter/auto", "openrouter/free"],
  openai: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini"],
  anthropic: ["claude-3-5-sonnet-latest", "claude-3-5-haiku-latest"],
  huggingface: ["meta-llama/Meta-Llama-3-8B-Instruct", "mistralai/Mistral-7B-Instruct-v0.3"],
  venice: ["venice-uncensored", "llama-3.1-70b"],
  ollama: ["llama3.2", "qwen2.5:7b-instruct", "mistral"],
};

/* ------------------------------------------------------------ default route */

const ROUTE_SLOT = "tor.ai.route";

export type Route = { provider: ProviderId; model: string };

/** Provider + model are not secrets, so they may be remembered across visits. */
export function defaultRoute(): Route {
  try {
    const raw = JSON.parse(localStorage.getItem(ROUTE_SLOT) || "null") as Route | null;
    if (raw?.provider && PROVIDERS.some((item) => item.id === raw.provider)) {
      return { provider: raw.provider, model: raw.model || "" };
    }
  } catch {
    /* fall through to the node default */
  }
  return { provider: "node", model: "" };
}

export function setDefaultRoute(route: Route) {
  try {
    localStorage.setItem(ROUTE_SLOT, JSON.stringify(route));
  } catch {
    /* private mode: the choice just will not survive a reload */
  }
}

/* --------------------------------------------------------------------- card */

function ProviderCard({ item, onChanged }: { item: Provider; onChanged: () => void }) {
  const toast = useToast();
  const [reveal, setReveal] = useState(false);
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState(item.defaultModel);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState("");
  const [error, setError] = useState("");

  const stored = keyVault.get(item.id);
  const loaded = !item.needsKey || Boolean(stored);
  const looksRight = !item.needsKey || !draft || !item.pattern || item.pattern.test(draft.trim());

  const save = () => {
    const key = draft.trim();
    if (!key) return;
    if (item.pattern && !item.pattern.test(key)) {
      setError(`${item.label} keys look like ${item.keyHint} — this does not. Nothing was saved.`);
      return;
    }
    keyVault.set(item.id, key);
    setDraft("");
    setReveal(false);
    setError("");
    setResult(`saved the ${item.label} key (${keyVault.redact(key)}) — held in this tab only`);
    onChanged();
    toast(`${item.label} key saved for this tab`);
  };

  const run = async () => {
    setBusy(true);
    setError("");
    setResult("");
    try {
      const reply = await chat({
        provider: item.id,
        model,
        messages: [{ role: "user", content: "Reply with exactly: CHAIN-BOUND OK" }],
        system: "You are a connectivity probe. Answer with the exact text you were asked for.",
      });
      setResult(`${reply.model} · ${reply.ms} ms · “${reply.text.slice(0, 160)}”`);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "the call failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="panel stack">
      <div className="spread">
        <div className="row" style={{ gap: 8 }}>
          <b>{item.label}</b>
          <span className={`pill ${loaded ? "on" : ""}`}>
            {item.needsKey ? (stored ? "key loaded" : "no key") : "no key needed"}
          </span>
        </div>
        {item.needsKey && stored ? (
          <button
            type="button"
            className="ghost small"
            onClick={() => {
              keyVault.forget(item.id);
              setResult("");
              setError("");
              onChanged();
              toast(`${item.label} key forgotten`);
            }}
          >
            Forget key
          </button>
        ) : null}
      </div>

      <div className="tiny muted">
        <div className="mono" style={{ wordBreak: "break-all" }}>{item.endpoint}</div>
        <div style={{ marginTop: 4 }}>
          <a href={item.docsUrl} target="_blank" rel="noreferrer">API documentation ↗</a>
          {item.keyUrl ? (
            <>
              {" · "}
              <a href={item.keyUrl} target="_blank" rel="noreferrer">create a key ↗</a>
            </>
          ) : null}
        </div>
        <div className="mono" style={{ marginTop: 4 }}>{item.transport}</div>
      </div>

      {item.needsKey ? (
        <div className="field">
          <label htmlFor={`key-${item.id}`}>API key — {item.keyHint}</label>
          <div className="row" style={{ gap: 8 }}>
            <input
              id={`key-${item.id}`}
              type={reveal ? "text" : "password"}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={stored ? `stored: ${keyVault.redact(stored)} — paste to replace` : item.keyHint}
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              style={{ flex: 1 }}
            />
            <button type="button" className="ghost small" onClick={() => setReveal((value) => !value)}>
              {reveal ? "hide" : "show"}
            </button>
            <button type="button" className="primary small" disabled={!draft.trim() || !looksRight} onClick={save}>
              Save
            </button>
          </div>
          {!looksRight ? (
            <div className="tiny bad" style={{ marginTop: 4 }}>
              that does not look like {item.keyHint} — saving is disabled until it does
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="field">
        <label htmlFor={`model-${item.id}`}>Model (not a secret)</label>
        <select id={`model-${item.id}`} value={model} onChange={(event) => setModel(event.target.value)}>
          {MODELS[item.id].map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
      </div>

      <div className="row">
        <button type="button" className="primary small" disabled={busy || !loaded} onClick={() => void run()}>
          {busy ? "calling…" : "Test this provider"}
        </button>
        <span className="muted tiny">sends one real request and prints the real latency</span>
      </div>

      {result ? <div className="good tiny" style={{ wordBreak: "break-word" }}>{result}</div> : null}
      {error ? <div className="bad tiny" style={{ wordBreak: "break-word" }}>{error}</div> : null}
      {item.note ? <div className="muted tiny">{item.note}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------------- page */

export function AiProvidersPage() {
  const toast = useToast();
  const [, setVersion] = useState(0);
  const [remember, setRemember] = useState(keyVault.remembering());
  const [defaults, setDefaults] = useState<string>(() => {
    const route = defaultRoute();
    return `${route.provider}:${route.model || "default"}`;
  });
  const bump = () => setVersion((value) => value + 1);
  const loadedCount = PROVIDERS.filter((item) => item.needsKey && keyVault.get(item.id)).length;

  return (
    <div className="stack">
      <section className="hero">
        <div className="tag">AI PROVIDERS · BRING YOUR OWN KEY</div>
        <h1 style={{ fontSize: "clamp(22px, 3vw, 34px)" }}>Keys in, nothing else</h1>
        <p className="muted tiny" style={{ margin: "6px 0 0", maxWidth: 780 }}>
          Seven ways to answer as an AI-NFT. The endpoints are fixed constants with links to each
          vendor's own documentation; the only thing you type here is an API key. Keys stay in this
          tab's memory — never <code>localStorage</code>, never a cookie, never a log line.
        </p>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="pill on">{loadedCount} key{loadedCount === 1 ? "" : "s"} loaded</span>
          <span className="pill">{remember ? "tab memory on" : "memory only"}</span>
          <span className="pill">default {defaults}</span>
        </div>
      </section>

      <GuardNotice action="talk to an AI provider" />

      <div className="panel stack">
        <div className="spread">
          <h3 style={{ margin: 0 }}>How a key is handled here</h3>
          <div className="row" style={{ gap: 8 }}>
            <label className="tiny muted row" style={{ gap: 6, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={remember}
                onChange={(event) => {
                  keyVault.setRemembering(event.target.checked);
                  setRemember(event.target.checked);
                  bump();
                  toast(event.target.checked ? "keys kept for this tab" : "keys no longer stored");
                }}
              />
              keep for this tab
            </label>
            <button
              type="button"
              className="ghost small"
              onClick={() => {
                keyVault.forgetAll();
                bump();
                toast("all AI keys wiped from this tab");
              }}
            >
              Wipe all keys
            </button>
          </div>
        </div>
        <table>
          <tbody>
            <tr><th style={{ width: 220 }}>Where the key lives</th><td className="tiny">A module-level <code>Map</code> for the life of the page. Optionally also <code>sessionStorage</code>, which the browser deletes when the tab closes.</td></tr>
            <tr><th>What is never used</th><td className="tiny"><code>localStorage</code>, cookies, the URL, any analytics call. There is no code path in <code>src/tor/ai.ts</code> that can write a key to disk.</td></tr>
            <tr><th>Where it is sent</th><td className="tiny">Only to that provider's fixed origin, over HTTPS, in the header the vendor documents. Nothing else in this app receives it — not even the OneNess node.</td></tr>
            <tr><th>Who else can see it</th><td className="tiny">Any script running on this origin, and the provider. That is unavoidable for a browser-held key, which is why the node gateway exists: its key never leaves the server.</td></tr>
            <tr><th>When it disappears</th><td className="tiny">On reload, tab close, <b>Forget key</b>, <b>Wipe all keys</b>, or sign-out. Nothing to revoke from this device afterwards.</td></tr>
          </tbody>
        </table>
      </div>

      <div className="panel stack">
        <div className="field">
          <label htmlFor="default-route">Default route for the ChatBox</label>
          <select
            id="default-route"
            value={defaults}
            onChange={(event) => {
              const value = event.target.value;
              const cut = value.indexOf(":");
              const providerId = value.slice(0, cut) as ProviderId;
              const model = value.slice(cut + 1);
              setDefaultRoute({ provider: providerId, model });
              setDefaults(value);
              toast(`ChatBox now uses ${providerId}`);
            }}
          >
            {PROVIDERS.flatMap((item) =>
              MODELS[item.id].map((name) => (
                <option key={`${item.id}:${name}`} value={`${item.id}:${name}`}>
                  {item.label} · {name}
                </option>
              )),
            )}
          </select>
          <span className="muted tiny">
            Stored as a preference only — the provider name and model, never a key.
          </span>
        </div>
      </div>

      <div className="grid cols-2">
        {PROVIDERS.map((item) => (
          <ProviderCard key={item.id} item={item} onChanged={bump} />
        ))}
      </div>

      <div className="panel stack">
        <h3>Prefer the node gateway when you can</h3>
        <p className="muted tiny" style={{ margin: 0 }}>
          <b>OneNess TOR node</b> is the default for a reason: <code>POST /api/ai/chat</code> keeps the
          upstream key on the server, so there is no credential in your browser at all. A key pasted into
          this page is a key this page can read — that is the trade you are making when you choose a BYO
          provider, and it is worth choosing only when the node's own upstream is down or you need a
          specific model.
        </p>
        <p className="muted tiny" style={{ margin: 0 }}>
          Local Ollama is the other side of the same coin: no key, no third party, but it needs
          <code> ollama serve</code> on this machine and <code>OLLAMA_ORIGINS</code> set to this origin, or
          the browser will block the call before it reaches the model.
        </p>
        <div className="row">
          <a className="btn small ghost" href="#/security">Chain binding →</a>
          <a className="btn small ghost" href="#/chat">Open the ChatBox</a>
        </div>
      </div>
    </div>
  );
}
