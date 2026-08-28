import type { Eip1193Provider } from "./types.js";

/**
 * EIP-6963 — Multi Injected Provider Discovery.
 *
 * Before 6963, a page had one `window.ethereum`, and with several extension
 * wallets installed it was whatever won a last-writer race — so the SDK could
 * grab MetaMask when the user meant to sign with Rabby. 6963 replaces that guess
 * with an event handshake: the page dispatches `eip6963:requestProvider`, and
 * every wallet answers with `eip6963:announceProvider` carrying its own provider
 * object. We enumerate them and pick the right one (the one holding the address
 * we're signing for, or the one already connected) instead of hoping.
 */

/** Wallet-identifying info from an announce event (the subset we use). */
export interface Eip6963ProviderInfo {
  uuid: string;
  name: string;
  icon?: string;
  rdns?: string;
}

/** One announced injected provider. */
export interface Eip6963ProviderDetail {
  info: Eip6963ProviderInfo;
  provider: Eip1193Provider;
}

/** The window surface we touch — narrow, and injectable so tests need no globals. */
export interface WindowLike {
  addEventListener?: (type: string, cb: (e: unknown) => void) => void;
  removeEventListener?: (type: string, cb: (e: unknown) => void) => void;
  dispatchEvent?: (e: unknown) => boolean;
  ethereum?: Eip1193Provider;
  Event?: typeof Event;
}

function getWindow(win?: WindowLike): WindowLike | undefined {
  if (win) return win;
  return typeof window !== "undefined"
    ? (window as unknown as WindowLike)
    : undefined;
}

/**
 * Enumerate every injected EVM wallet that speaks EIP-6963 (MetaMask, Rabby,
 * Coinbase, Brave, Zerion, Frame, …).
 *
 * Spec-compliant wallets answer synchronously while `dispatchEvent` runs, so the
 * short timeout is only a grace window for any that defer. Resolves to `[]` when
 * there is no window or nothing answers — an older single-injection wallet won't,
 * and the caller then falls back to `window.ethereum`.
 */
export function discoverEip6963Providers(
  win?: WindowLike,
  timeoutMs = 200
): Promise<Eip6963ProviderDetail[]> {
  const w = getWindow(win);
  if (!w?.addEventListener || !w.dispatchEvent) return Promise.resolve([]);
  return new Promise((resolve) => {
    const found = new Map<string, Eip6963ProviderDetail>();
    const onAnnounce = (e: unknown) => {
      const detail = (e as { detail?: Eip6963ProviderDetail })?.detail;
      if (detail?.info?.uuid && detail.provider) {
        // Keyed by uuid so a wallet announcing twice counts once.
        found.set(detail.info.uuid, detail);
      }
    };
    w.addEventListener!("eip6963:announceProvider", onAnnounce);
    try {
      const evt = w.Event
        ? new w.Event("eip6963:requestProvider")
        : ({ type: "eip6963:requestProvider" } as unknown as Event);
      w.dispatchEvent!(evt);
    } catch {
      /* dispatch unsupported — resolve with whatever announced synchronously */
    }
    const done = () => {
      w.removeEventListener?.("eip6963:announceProvider", onAnnounce);
      resolve([...found.values()]);
    };
    if (timeoutMs <= 0) done();
    else setTimeout(done, timeoutMs);
  });
}

async function safeAccounts(p: Eip1193Provider): Promise<string[]> {
  try {
    // eth_accounts is non-interactive: it returns the already-authorized
    // accounts (or []), and never prompts — safe to poll across every wallet.
    const a = await p.request({ method: "eth_accounts" });
    return Array.isArray(a) ? (a as string[]) : [];
  } catch {
    return [];
  }
}

/**
 * Choose the best injected EVM provider to sign with, WITHOUT a wallet-selection
 * UI. Preference order:
 *
 *   1. an explicit provider the caller passed (`opts.provider`);
 *   2. the EIP-6963 wallet whose accounts already include `preferAddress` — i.e.
 *      the wallet that actually holds the address we're about to sign for;
 *   3. any EIP-6963 wallet that is already connected (non-empty accounts);
 *   4. `window.ethereum` — the legacy single-injection default;
 *   5. the first EIP-6963 wallet that announced (idle — it will prompt).
 *
 * Returns `undefined` only when no injected EVM wallet exists at all.
 */
export async function resolveInjectedEvmProvider(
  params: {
    explicit?: Eip1193Provider;
    preferAddress?: string;
    win?: WindowLike;
    timeoutMs?: number;
  } = {}
): Promise<Eip1193Provider | undefined> {
  if (params.explicit) return params.explicit;
  const w = getWindow(params.win);
  const details = await discoverEip6963Providers(w, params.timeoutMs);

  if (details.length) {
    const want = params.preferAddress?.toLowerCase();
    let firstConnected: Eip1193Provider | undefined;
    for (const d of details) {
      const accounts = await safeAccounts(d.provider);
      if (want && accounts.some((a) => a.toLowerCase() === want)) {
        return d.provider; // exact wallet for this address — the best possible pick
      }
      if (!firstConnected && accounts.length) firstConnected = d.provider;
    }
    if (firstConnected) return firstConnected;
  }

  return w?.ethereum ?? details[0]?.provider;
}
