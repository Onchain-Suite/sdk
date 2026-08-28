import { base58encode } from "./base58.js";

/**
 * Solana wallet discovery + signing — the SVM analogue of eip6963.ts.
 *
 * There is no single `window.solana` truth: Phantom injects at both
 * `window.solana` and `window.phantom.solana`, while Solflare, Backpack and Glow
 * each use their own name. We check every known injection point, dedupe (Phantom
 * appears twice), and prefer a wallet that's already connected so a multi-wallet
 * user signs with the one they're actually using. Dependency-free on purpose —
 * the whole SDK avoids pulling in a wallet-adapter stack.
 */

/** Minimal shape of an injected Solana wallet (the subset we use). */
export interface SolanaProvider {
  isConnected?: boolean;
  publicKey?: SolanaPublicKey | null;
  connect?: (opts?: {
    onlyIfTrusted?: boolean;
  }) => Promise<{ publicKey?: SolanaPublicKey } | undefined>;
  signMessage?: (
    message: Uint8Array,
    encoding?: string
  ) => Promise<{ signature: Uint8Array } | Uint8Array>;
}

/** A Solana public key as the various wallets expose it. */
export interface SolanaPublicKey {
  toBytes?: () => Uint8Array;
  toBase58?: () => string;
  toString?: () => string;
}

/** The window surface we touch — injectable so tests need no globals. */
export interface SolanaWindowLike {
  solana?: SolanaProvider;
  solflare?: SolanaProvider;
  backpack?: SolanaProvider;
  glow?: SolanaProvider;
  coinbaseSolana?: SolanaProvider;
  phantom?: { solana?: SolanaProvider };
}

function getWindow(win?: SolanaWindowLike): SolanaWindowLike {
  if (win) return win;
  return (
    typeof globalThis !== "undefined" ? globalThis : {}
  ) as unknown as SolanaWindowLike;
}

/**
 * Every injected Solana wallet that can sign, deduped. Phantom-first because it
 * is dominant; a connected wallet is promoted ahead of idle ones by
 * {@link getSolanaProvider}.
 */
export function getSolanaProviders(win?: SolanaWindowLike): SolanaProvider[] {
  const w = getWindow(win);
  const candidates = [
    w.phantom?.solana,
    w.solana,
    w.solflare,
    w.backpack,
    w.glow,
    w.coinbaseSolana,
  ].filter(
    (p): p is SolanaProvider => !!p && typeof p.signMessage === "function"
  );

  const seen = new Set<SolanaProvider>();
  const out: SolanaProvider[] = [];
  for (const p of candidates) {
    if (seen.has(p)) continue; // window.solana === window.phantom.solana for Phantom
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** The Solana wallet to use: a connected one if any, else the first available. */
export function getSolanaProvider(
  win?: SolanaWindowLike
): SolanaProvider | undefined {
  const providers = getSolanaProviders(win);
  return providers.find((p) => p.isConnected && p.publicKey) ?? providers[0];
}

/** base58 address from a public key object, across the wallet implementations. */
function pubkeyToAddress(pk: SolanaPublicKey | null | undefined): string | undefined {
  if (!pk) return undefined;
  if (typeof pk.toBase58 === "function") return pk.toBase58();
  if (typeof pk.toBytes === "function") {
    try {
      return base58encode(pk.toBytes());
    } catch {
      /* fall through */
    }
  }
  if (typeof pk.toString === "function") {
    const s = pk.toString();
    if (s && s !== "[object Object]") return s;
  }
  return undefined;
}

/**
 * Connect (prompting only if necessary) and return the wallet's base58 address.
 * Tries a silent `onlyIfTrusted` reconnect first so a returning user isn't
 * re-prompted; falls back to an interactive connect.
 */
export async function connectSolana(
  provider: SolanaProvider
): Promise<string | undefined> {
  const existing = pubkeyToAddress(provider.publicKey);
  if (existing) return existing;
  if (typeof provider.connect !== "function") return undefined;

  const silent = await provider
    .connect({ onlyIfTrusted: true })
    .catch(() => undefined);
  const silentAddr =
    pubkeyToAddress(silent?.publicKey) ?? pubkeyToAddress(provider.publicKey);
  if (silentAddr) return silentAddr;

  const res = await provider.connect();
  return pubkeyToAddress(res?.publicKey) ?? pubkeyToAddress(provider.publicKey);
}

/**
 * Sign the challenge with an injected Solana wallet and return the base58
 * signature the backend verifies (ed25519 over the utf-8 message bytes). The
 * wallet returns a raw 64-byte signature; base58 is the wire form the backend's
 * `bs58.decode` expects, matching the base58 pubkey that is the address.
 */
export async function signWithSolana(
  provider: SolanaProvider,
  message: string
): Promise<string> {
  if (typeof provider.signMessage !== "function") {
    throw new Error("Solana wallet cannot sign messages");
  }
  const encoded = new TextEncoder().encode(message);
  const res = await provider.signMessage(encoded, "utf8");
  const raw =
    (res as { signature?: Uint8Array })?.signature ?? (res as Uint8Array);
  return base58encode(
    raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayLike<number>)
  );
}
