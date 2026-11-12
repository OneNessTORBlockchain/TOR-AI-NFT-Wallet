/**
 * AI-NFT ChatBox — the node's ChatBox, answered by OpenRouter free models.
 *
 * Any NFT the node can read becomes an AI-NFT here: paste its token address and
 * token ID, the box resolves the real metadata through `GET /api/nft/metadata`,
 * shows the image and traits, and attaches the record to every `/api/ai/chat`
 * call so the node prepends its `I AM THIS NFT` persona block.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, nftMetadata } from "./api";
import type { Model, NftMetadata } from "./api";
import { asset, shortAddress } from "./brand";
import { useToast } from "./ui";
import { PROVIDERS, chat, keyVault } from "./ai";
import type { ProviderId } from "./ai";
import { defaultRoute } from "./providers";
import { useChainGuard } from "./security";

type Message = { role: "user" | "assistant"; content: string };

/** What a page may hand in: anything that names an NFT the node can resolve. */
export type NftSeed = { address?: string | null; token_id?: string | number | null };

type Props = {
  title?: string;
  hint?: string;
  nft?: NftSeed | null;
  system?: string;
  compact?: boolean;
  /** Called when the box drops its NFT, so a page picker can clear itself. */
  onDetach?: () => void;
};

/** `ipfs://` / `ar://` need a gateway; node paths need the API host. */
export function nftImageSrc(uri?: string | null): string {
  const value = (uri || "").trim();
  if (!value) return "";
  if (value.startsWith("ipfs://")) {
    const path = value.slice("ipfs://".length).replace(/^ipfs\//, "");
    return `https://ipfs.io/ipfs/${path}`;
  }
  if (value.startsWith("ar://")) {
    return `https://arweave.net/${value.slice("ar://".length)}`;
  }
  return asset(value);
}

/* personaPayload lives in `ai.ts` as `personaFields` now — one definition, used by
   both the node gateway and the bring-your-own-key providers. */
/* --------------------------------------------------------- metadata card */

function NftCard({ nft, prompt, onDetach }: { nft: NftMetadata; prompt: string; onDetach: () => void }) {
  const [broken, setBroken] = useState(false);
  const src = nftImageSrc(nft.image);

  useEffect(() => setBroken(false), [src]);

  return (
    <div className="nft-card">
      {src && !broken ? (
        <img
          src={src}
          alt={nft.name ? `${nft.name} artwork` : "AI-NFT artwork"}
          onError={() => setBroken(true)}
        />
      ) : (
        <div className="thumb">
          <b>{(nft.symbol || "NFT").slice(0, 5)}</b>
          <span>{src ? "artwork did not load" : "no image in metadata"}</span>
        </div>
      )}

      <div className="body">
        <div className="row" style={{ gap: 8 }}>
          <b>{nft.name || "Unnamed NFT"}</b>
          {nft.symbol ? <span className="pill">${nft.symbol}</span> : null}
          {nft.token_id ? <span className="pill">#{nft.token_id}</span> : null}
          <span className="pill">{nft.chain || "unknown chain"}</span>
          <span className="pill on">AI-NFT · I AM THIS NFT</span>
        </div>

        <div className="mono tiny muted" style={{ wordBreak: "break-all" }}>
          {nft.address || "—"}
        </div>

        {nft.description ? (
          <p className="muted tiny" style={{ margin: 0, lineHeight: 1.6 }}>{nft.description}</p>
        ) : null}

        {nft.attributes?.length ? (
          <div className="row" style={{ gap: 6 }}>
            {nft.attributes.map((item, index) => (
              <span key={`${item.trait_type}-${index}`} className="pill">
                {item.trait_type}: {item.value}
              </span>
            ))}
          </div>
        ) : null}

        <div className="muted tiny">
          {nft.owner_wallet ? `minted by ${nft.owner_wallet}` : nft.source ? `source ${nft.source}` : ""}
          {nft.txid ? ` · tx ${shortAddress(nft.txid)}` : ""}
          {nft.height ? ` · height ${nft.height}` : ""}
        </div>

        <div className="row" style={{ gap: 8 }}>
          {nft.metadata_url || nft.metadata_uri ? (
            <a
              className="pill"
              href={nftImageSrc(nft.metadata_url || nft.metadata_uri)}
              target="_blank"
              rel="noreferrer"
            >
              metadata{nft.metadata_pinned ? " · pinned" : ""}
            </a>
          ) : null}
          <button type="button" className="small ghost" onClick={onDetach}>
            Detach
          </button>
        </div>

        {prompt ? (
          <details>
            <summary className="muted tiny">What the model is told (persona block)</summary>
            <pre className="persona mono tiny">{prompt}</pre>
          </details>
        ) : null}
      </div>
    </div>
  );
}



export function ChatBox({ title = "AI-NFT ChatBox", hint, nft = null, system, compact, onDetach }: Props) {
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [source, setSource] = useState("");
  const [prompt, setPrompt] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const thread = useRef<HTMLDivElement | null>(null);
  const toast = useToast();
  /* The gate: a model may not be called while the chain binding is unverified. */
  const guard = useChainGuard();
  const [initialRoute] = useState(defaultRoute);
  const [providerId, setProviderId] = useState<ProviderId>(initialRoute.provider);
  /* Real evidence of the last answer: which provider, which model, how long. */
  const [evidence, setEvidence] = useState("");
  const activeProvider = PROVIDERS.find((item) => item.id === providerId) ?? null;
  const keyLoaded = !activeProvider?.needsKey || Boolean(keyVault.get(providerId));

  /* the AI-NFT loader: two fields, the node does the resolving */
  const [address, setAddress] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [attached, setAttached] = useState<NftMetadata | null>(null);
  const [attachedPrompt, setAttachedPrompt] = useState("");
  const [loadError, setLoadError] = useState("");
  const [loadingNft, setLoadingNft] = useState(false);
  const attachedId = useRef("");
  const onDetachRef = useRef(onDetach);
  useEffect(() => {
    onDetachRef.current = onDetach;
  }, [onDetach]);

  useEffect(() => {
    api
      .get<{ models: Model[]; default: string; source: string }>("/api/ai/models")
      .then((data) => {
        setModels(data.models || []);
        setModel(data.default || data.models?.[0]?.id || "");
        setSource(data.source || "");
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    thread.current?.scrollTo({ top: thread.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  const detach = useCallback(() => {
    attachedId.current = "";
    setAttached(null);
    setAttachedPrompt("");
    setAddress("");
    setTokenId("");
    setMessages([]);
    onDetachRef.current?.();
  }, []);

  /** Resolve the NFT behind the two fields and make it the chat's identity. */
  const load = useCallback(
    async (rawAddress: string, rawToken: string) => {
      const wanted = rawAddress.trim();
      const token = rawToken.trim().replace(/^#/, "");
      if (!wanted) {
        setLoadError("paste the NFT's token address first — TOR1…onion or a Solana mint");
        return;
      }
      if (token && !/^\d+$/.test(token)) {
        setLoadError("token ID must be a whole number, e.g. 3");
        return;
      }
      setLoadError("");
      setLoadingNft(true);
      try {
        const data = await nftMetadata(wanted, token);
        const resolved = data.nft;
        const identity = `${resolved.address || wanted}#${resolved.token_id ?? token}`;
        if (attachedId.current !== identity) {
          attachedId.current = identity;
          setMessages([]); // a new identity starts a new conversation
        }
        setAttached(resolved);
        setAttachedPrompt(data.prompt || "");
        setAddress(resolved.address || wanted);
        setTokenId(resolved.token_id ? String(resolved.token_id) : token);
        toast(`Speaking as ${resolved.name || "that NFT"}`);
      } catch (problem) {
        const text = problem instanceof Error ? problem.message : "the node could not resolve that NFT";
        setLoadError(
          attachedId.current
            ? `${text} — the box still speaks as the AI-NFT already attached`
            : text,
        );
        toast(text, true);
      } finally {
        setLoadingNft(false);
      }
    },
    [toast],
  );

  /* a page (the catalogue picker) can hand in an NFT to load */
  const seedAddress = (nft?.address || "").trim();
  const seedToken = nft?.token_id === null || nft?.token_id === undefined ? "" : String(nft.token_id);
  const seedKey = seedAddress ? `${seedAddress}#${seedToken}` : "";
  const lastSeed = useRef("__start__");

  useEffect(() => {
    if (seedKey === lastSeed.current) return;
    lastSeed.current = seedKey;
    if (!seedKey) {
      detach();
      return;
    }
    setAddress(seedAddress);
    setTokenId(seedToken);
    void load(seedAddress, seedToken);
  }, [seedKey, seedAddress, seedToken, load, detach]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    /* The gate comes before the network call, not after it. */
    if (!guard.allowed) {
      toast(`refusing to call a model: ${guard.reason || "the chain binding did not pass"}`, true);
      return;
    }
    const history: Message[] = [...messages, { role: "user", content: text }];
    setMessages(history);
    setPrompt("");
    setBusy(true);
    setEvidence("");
    try {
      const reply = await chat({
        provider: providerId,
        /* The node picks its own free model from the list above; BYO providers use their default. */
        model: providerId === "node" ? model : undefined,
        messages: history,
        system,
        nft: attached,
      });
      setMessages([...history, { role: "assistant", content: reply.text }]);
      setEvidence(`${reply.provider} · ${reply.model} · ${reply.ms} ms`);
    } catch (problem) {
      const reason = problem instanceof Error ? problem.message : "the model did not answer";
      setMessages([...history, { role: "assistant", content: `⚠ ${reason}` }]);
      toast(reason, true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel stack">
      <div className="spread">
        <div>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <p className="muted tiny" style={{ margin: "4px 0 0" }}>
            {hint || "Free OpenRouter models, proxied by this node — the key never reaches your browser."}
          </p>
        </div>
        <span className="pill">{source === "openrouter" ? `${models.length} free models` : source || "gateway"}</span>
      </div>

      <div className="grid cols-2" style={{ gap: 10 }}>
        <div className="field">
          <label htmlFor="chat-provider">Model provider</label>
          <select
            id="chat-provider"
            value={providerId}
            onChange={(event) => setProviderId(event.target.value as ProviderId)}
          >
            {PROVIDERS.map((item) => (
              <option key={item.id} value={item.id}>{item.label}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Model</label>
          {providerId === "node" ? (
            <select value={model} onChange={(event) => setModel(event.target.value)}>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} · {item.context_length ? `${Math.round(item.context_length / 1000)}k ctx` : "ctx n/a"}
                </option>
              ))}
            </select>
          ) : (
            <div className="mono tiny" style={{ padding: "11px 0" }}>
              {activeProvider?.defaultModel ?? "—"}
            </div>
          )}
          <span className="muted tiny">
            {providerId === "node"
              ? "the node's own free models — no key leaves the browser because none is sent"
              : "the model and endpoint are fixed on the AI Providers page"}
          </span>
        </div>
      </div>
      {!keyLoaded ? (
        <div className="bad tiny">
          <b>{activeProvider?.label}</b> needs an API key.{" "}
          <a href="#/ai">Paste one on the AI Providers page →</a>
        </div>
      ) : null}

      {/* -------------------------------------------- load any nft as an AI-NFT */}
      <div className="nft-loader">
        <div className="spread">
          <div>
            <h2 style={{ margin: 0 }}>Load any AI-NFT</h2>
            <p className="muted tiny" style={{ margin: "4px 0 0" }}>
              Two fields — the token address and the token ID. The node resolves the real metadata
              (mints on this node, Solana Metaplex mints, metadata URIs) and the model speaks as it.
            </p>
          </div>
          <span className={`pill ${attached ? "on" : ""}`}>
            {attached ? "AI-NFT attached" : "general chat"}
          </span>
        </div>

        <form
          className="fields"
          onSubmit={(event) => {
            event.preventDefault();
            void load(address, tokenId);
          }}
        >
          <div className="field">
            <label htmlFor="nft-address">AI-NFT token address</label>
            <input
              id="nft-address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="TOR1…onion or a Solana mint"
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="field token-field">
            <label htmlFor="nft-token-id">Token ID</label>
            <input
              id="nft-token-id"
              value={tokenId}
              onChange={(event) => setTokenId(event.target.value)}
              placeholder="3"
              inputMode="numeric"
              autoComplete="off"
            />
          </div>
          <button className="primary" disabled={loadingNft || !address.trim()}>
            {loadingNft ? "Resolving…" : "Load AI-NFT"}
          </button>
        </form>

        {loadError ? <div className="tiny bad">{loadError}</div> : null}

        {attached ? (
          <NftCard nft={attached} prompt={attachedPrompt} onDetach={detach} />
        ) : (
          <div className="muted tiny">
            Nothing attached yet — the box answers as the TOR assistant until an NFT is loaded.
          </div>
        )}
      </div>

      <div className="chat">
        <div className="thread" ref={thread} style={compact ? { maxHeight: 220 } : undefined}>
          {messages.length === 0 ? (
            <div className="msg assistant">
              {attached
                ? `You are talking to ${attached.name || "this AI-NFT"}. It answers in its own voice — the node puts "I AM THIS NFT" and its metadata in front of every reply.`
                : "Load an AI-NFT above to let the model speak as it, or just ask about the chain, a token or a pool. Every number comes from the node's own market engine, never from the model's memory."}
            </div>
          ) : null}
          {messages.map((message, index) => (
            <div key={index} className={`msg ${message.role}`}>
              {message.content}
            </div>
          ))}
          {busy ? <div className="msg assistant">thinking…</div> : null}
        </div>
        {!guard.allowed ? (
          <div className="bad tiny">
            <b>AI calls are disabled until the chain binding passes.</b>{" "}
            {guard.reason || "the probe has not finished"}{" "}
            <a href="#/security">Open the security panel →</a>
          </div>
        ) : null}
        {evidence ? <div className="muted tiny mono">{evidence}</div> : null}
        <form className="composer" onSubmit={send}>
          <input
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder={attached ? `Ask ${attached.name || "the AI-NFT"}…` : "Ask the AI-NFT…"}
          />
          <button className="primary" disabled={busy || !prompt.trim() || !guard.allowed}>
            Send
          </button>
        </form>
      </div>
    </div>
  );
}
