/**
 * mint.tsx — Create an AI-NFT and pay the node's own mint fee.
 *
 * The flow is the one the brief asks for, in the order the node enforces it:
 * metadata first (name, symbol, description, image, traits), then `POST /api/nft/mint`
 * with the signed-in wallet, which charges the live `nft_mint` price on-chain and
 * stamps the txid. The screen then asks the marketplace engine for a sweep so the
 * token is auto-listed at `fee × multiplier` — no administrator, no manual row.
 *
 * Nothing here is simulated: if the node refuses (no session, no balance, bad
 * image URI) its message is printed verbatim and no success state is shown.
 */
import { useMemo, useState } from "react";
import { api } from "./api";
import { engine } from "./engine";
import { MINT_TARGET_TOR, useMintFee } from "./pricing";
import { useWallet } from "./wallet";
import { shortAddress, tor as fmtTor } from "./brand";
import { Stat, useToast } from "./ui";

type MintResponse = {
  nft?: { id?: string; token_id?: number | string; name?: string; image?: string };
  resolved?: Record<string, unknown>;
  txid?: string;
  height?: number | null;
  charge?: { code?: string; amount_micro?: number; amount_tor?: string | number };
};

type Trait = { trait_type: string; value: string };

/** `Rarity:legendary` per line → the node's `attributes` object. */
function parseTraits(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(":");
    if (at < 1) continue;
    const key = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

export function CreateNft() {
  const { session, profile } = useWallet();
  const fee = useMintFee();
  const toast = useToast();

  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [image, setImage] = useState("");
  const [traitText, setTraitText] = useState("Aura:cyan\nRarity:legendary");
  const [animationUrl, setAnimationUrl] = useState("");
  const [externalUrl, setExternalUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<MintResponse | null>(null);
  const [swept, setSwept] = useState("");

  const traits = useMemo(() => parseTraits(traitText), [traitText]);
  const balance = Number.parseFloat(String(profile?.wallet?.balance_tor ?? ""));
  const price = fee.row?.tor ?? null;
  const enough = Number.isFinite(balance) && price !== null ? balance >= price : null;

  const blocked = !session
    ? "sign in first — the mint is paid and owned by your own account wallet"
    : price === null
      ? fee.error || "the node has not published an nft_mint price yet"
      : enough === false
        ? `your wallet holds ${balance} TOR, the mint costs ${price} TOR`
        : !name.trim()
          ? "give the NFT a name"
          : "";

  async function mint() {
    if (!session || blocked) return;
    setBusy(true);
    setError("");
    setDone(null);
    setSwept("");
    try {
      const result = await api.post<MintResponse>(
        "/api/nft/mint",
        {
          name: name.trim(),
          symbol: symbol.trim() || "NFT",
          description: description.trim(),
          image: image.trim(),
          attributes: traits,
          animation_url: animationUrl.trim(),
          external_url: externalUrl.trim(),
          wallet: session.wallet,
        },
        180_000,
      );
      setDone(result);
      toast(`minted${result.nft?.id ? ` ${result.nft.id}` : ""} · ${result.charge?.amount_tor ?? price} TOR`);
      /* auto-listing: the engine mirrors the node every 20 s; ask it now instead of waiting */
      try {
        await engine.sync();
        setSwept("engine swept — the token is on the board at fee × multiplier");
      } catch (problem) {
        setSwept(
          `minted, but the engine sweep failed: ${problem instanceof Error ? problem.message : "no answer"} — it retries every 20 s`,
        );
      }
    } catch (problem) {
      const text = problem instanceof Error ? problem.message : "the node refused the mint";
      setError(text);
      toast(text, true);
    } finally {
      setBusy(false);
    }
  }


  function pickFile(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast("that file is not an image", true);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const uri = String(reader.result || "");
      setImage(uri);
      toast(uri.length > 400_000 ? "large image inlined as a data URI — a hosted URL is lighter" : "image attached");
    };
    reader.onerror = () => toast("the browser could not read that file", true);
    reader.readAsDataURL(file);
  }

  return (
    <div className="stack">
      <section className="hero">
        <div className="tag">CREATE · MINT · AUTO-LIST</div>
        <h1 style={{ fontSize: "clamp(24px, 3.4vw, 38px)" }}>Create an AI-NFT</h1>
        <p>
          The node charges the live <b>{fee.row?.code ?? "nft_mint"}</b> price on-chain and stamps the
          txid on your metadata; the marketplace engine then lists the token automatically. Your key
          never leaves the node — this form only carries your wallet session.
        </p>
      </section>

      <div className="grid cols-4">
        <Stat
          label="Mint fee"
          value={price === null ? "—" : fmtTor(price, 4)}
          hint={fee.row ? `${fee.row.micro_tor} micro-TOR · live` : fee.error || "reading /api/pricing"}
        />
        <Stat
          label="Brief says"
          value={fmtTor(MINT_TARGET_TOR, 4)}
          hint={fee.row && !fee.matchesTarget ? "node is above the brief — override unsigned" : "node matches the brief"}
        />
        <Stat label="Your balance" value={Number.isFinite(balance) ? fmtTor(balance, 4) : "—"} hint={session ? session.wallet : "sign in to mint"} />
        <Stat label="After mint" value="auto-listed" hint="ask = fee × engine multiplier" />
      </div>

      <div className="create-grid">
        <div className="panel stack">
          <div className="field">
            <label htmlFor="mint-name">Name *</label>
            <input id="mint-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="Live Cyan Warden" maxLength={64} />
          </div>
          <div className="row" style={{ alignItems: "flex-start" }}>
            <div className="field" style={{ flex: "1 1 180px" }}>
              <label htmlFor="mint-symbol">Symbol</label>
              <input id="mint-symbol" value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} placeholder="NFT" maxLength={12} />
            </div>
            <div className="field" style={{ flex: "2 1 240px" }}>
              <label htmlFor="mint-external">External URL</label>
              <input id="mint-external" value={externalUrl} onChange={(event) => setExternalUrl(event.target.value)} placeholder="https://…" />
            </div>
          </div>
          <div className="field">
            <label htmlFor="mint-description">Description</label>
            <textarea id="mint-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="What is this artefact, and what does it know?" />
          </div>
          <div className="field">
            <label htmlFor="mint-image">Image — https, ipfs:// or a file</label>
            <input id="mint-image" value={image.startsWith("data:") ? "(file attached)" : image} onChange={(event) => setImage(event.target.value)} placeholder="https://…  ·  ipfs://…" spellCheck={false} />
            <input type="file" accept="image/*" onChange={(event) => pickFile(event.target.files?.[0])} aria-label="Upload an image" />
          </div>
          <div className="field">
            <label htmlFor="mint-traits">Traits — one "trait: value" per line</label>
            <textarea id="mint-traits" className="mono" value={traitText} onChange={(event) => setTraitText(event.target.value)} rows={4} />
            {Object.keys(traits).length ? (
              <div className="row" style={{ gap: 6 }}>
                {Object.entries(traits).map(([key, value]) => (
                  <span key={key} className="pill">{key}: {value}</span>
                ))}
              </div>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="mint-animation">Animation URL (optional)</label>
            <input id="mint-animation" value={animationUrl} onChange={(event) => setAnimationUrl(event.target.value)} placeholder="https://… .mp4" />
          </div>
        </div>

        <div className="panel stack create-preview">
          <h3>Preview</h3>
          {image ? (
            <img src={image} alt="artwork preview" />
          ) : (
            <div className="create-preview__empty">no artwork yet</div>
          )}
          <b>{name || "Untitled AI-NFT"}</b>
          <span className="muted tiny">
            {symbol ? `$${symbol}` : "$NFT"} · {Object.keys(traits).length} trait
            {Object.keys(traits).length === 1 ? "" : "s"}
          </span>
          <p className="muted tiny" style={{ margin: 0 }}>{description || "no description"}</p>
          <div className="spread">
            <span className="pill">{price === null ? "fee unknown" : `${price} TOR`}</span>
            <span className="muted tiny">{session ? shortAddress(session.address) : "not signed in"}</span>
          </div>
          <button type="button" className="primary" disabled={Boolean(blocked) || busy} onClick={() => void mint()}>
            {busy ? "Signing and minting…" : price === null ? "Waiting for the fee" : `Mint for ${price} TOR`}
          </button>
          {blocked ? <div className="tiny bad">{blocked}</div> : null}
          {fee.row && !fee.matchesTarget ? (
            <div className="tiny muted">
              the node charges {fmtTor(fee.row.tor, 4)} while the brief says {fmtTor(MINT_TARGET_TOR, 4)} —
              the button quotes the node, because the node is what debits your wallet.
            </div>
          ) : null}
        </div>
      </div>

      {error ? <div className="panel tight bad tiny">{error}</div> : null}

      {done ? (
        <div className="panel stack">
          <div className="spread">
            <h3 style={{ margin: 0 }}>Minted on the OneNess TOR chain</h3>
            <span className="pill on">txid {done.txid ? shortAddress(done.txid) : "—"}</span>
          </div>
          <div className="grid cols-3">
            <Stat label="Token" value={done.nft?.id ?? "—"} hint={done.nft?.token_id ? `#${done.nft.token_id}` : ""} />
            <Stat label="Charged" value={done.charge?.amount_tor ? fmtTor(Number(done.charge.amount_tor), 4) : "—"} hint={done.charge?.code ?? ""} />
            <Stat label="Height" value={done.height === null || done.height === undefined ? "—" : String(done.height)} hint="block that carries the mint" />
          </div>
          <div className="row">
            {done.nft?.id ? <a className="btn primary" href={`#/market/${encodeURIComponent(done.nft.id)}`}>Open the token</a> : null}
            <a className="btn ghost" href="#/market">See the board</a>
            {done.txid ? <a className="btn ghost" href={`#/verify/${done.txid}`}>Verify the txid</a> : null}
            <button type="button" className="ghost" onClick={() => { setDone(null); setName(""); setDescription(""); setImage(""); }}>
              Mint another
            </button>
          </div>
          {swept ? <div className="tiny muted">{swept}</div> : null}
          <div className="tiny muted">
            auto-listing: the engine mirrors the node catalogue every 20 s and writes a listing row at
            fee × multiplier — nothing was added by hand.
          </div>
        </div>
      ) : null}
    </div>
  );
}
