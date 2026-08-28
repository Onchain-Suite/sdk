import { describe, it, expect } from "vitest";
import {
  discoverEip6963Providers,
  resolveInjectedEvmProvider,
  type WindowLike,
} from "./eip6963";
import type { Eip1193Provider } from "./types";

/** A window backed by a real EventTarget so each test is isolated (no globals). */
function makeWin(ethereum?: Eip1193Provider): WindowLike & { et: EventTarget } {
  const et = new EventTarget();
  return {
    et,
    ethereum,
    Event,
    addEventListener: (t, cb) => et.addEventListener(t, cb as EventListener),
    removeEventListener: (t, cb) =>
      et.removeEventListener(t, cb as EventListener),
    dispatchEvent: (e) => et.dispatchEvent(e as Event),
  };
}

/** Install a 6963 wallet that announces itself when the page requests providers. */
function installWallet(
  win: WindowLike & { et: EventTarget },
  uuid: string,
  provider: Eip1193Provider
): void {
  win.et.addEventListener("eip6963:requestProvider", () => {
    win.et.dispatchEvent(
      new CustomEvent("eip6963:announceProvider", {
        detail: { info: { uuid, name: uuid }, provider },
      })
    );
  });
}

/** A fake EIP-1193 provider whose eth_accounts returns the given addresses. */
function fakeEvm(accounts: string[]): Eip1193Provider {
  return {
    request: async ({ method }) =>
      method === "eth_accounts" || method === "eth_requestAccounts"
        ? accounts
        : null,
  };
}

describe("discoverEip6963Providers", () => {
  it("returns [] when the environment has no window plumbing", async () => {
    expect(await discoverEip6963Providers({}, 10)).toEqual([]);
  });

  it("collects every announcing wallet", async () => {
    const win = makeWin();
    const a = fakeEvm(["0xaaa"]);
    const b = fakeEvm(["0xbbb"]);
    installWallet(win, "wallet-a", a);
    installWallet(win, "wallet-b", b);

    const found = await discoverEip6963Providers(win, 20);
    expect(found.map((d) => d.info.uuid).sort()).toEqual([
      "wallet-a",
      "wallet-b",
    ]);
    expect(found.map((d) => d.provider)).toContain(a);
  });

  it("dedupes a wallet that announces twice (keyed by uuid)", async () => {
    const win = makeWin();
    const a = fakeEvm(["0xaaa"]);
    installWallet(win, "wallet-a", a);
    installWallet(win, "wallet-a", a); // same uuid announced again

    const found = await discoverEip6963Providers(win, 20);
    expect(found).toHaveLength(1);
  });
});

describe("resolveInjectedEvmProvider", () => {
  it("prefers an explicit provider and skips discovery entirely", async () => {
    const explicit = fakeEvm(["0x111"]);
    const win = makeWin();
    installWallet(win, "other", fakeEvm(["0x999"]));
    expect(await resolveInjectedEvmProvider({ explicit, win, timeoutMs: 20 })).toBe(
      explicit
    );
  });

  it("picks the wallet that holds preferAddress (case-insensitive)", async () => {
    const win = makeWin();
    const a = fakeEvm(["0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"]);
    const b = fakeEvm(["0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"]);
    installWallet(win, "wallet-a", a);
    installWallet(win, "wallet-b", b);

    const chosen = await resolveInjectedEvmProvider({
      preferAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      win,
      timeoutMs: 20,
    });
    expect(chosen).toBe(b);
  });

  it("prefers a connected wallet when no address is specified", async () => {
    const win = makeWin();
    const idle = fakeEvm([]); // installed but not connected
    const connected = fakeEvm(["0xccc"]);
    installWallet(win, "idle", idle);
    installWallet(win, "connected", connected);

    expect(await resolveInjectedEvmProvider({ win, timeoutMs: 20 })).toBe(
      connected
    );
  });

  it("falls back to window.ethereum when no wallet speaks 6963", async () => {
    const legacy = fakeEvm(["0xddd"]);
    const win = makeWin(legacy);
    expect(await resolveInjectedEvmProvider({ win, timeoutMs: 20 })).toBe(legacy);
  });

  it("returns undefined when there is no injected wallet at all", async () => {
    const win = makeWin();
    expect(
      await resolveInjectedEvmProvider({ win, timeoutMs: 20 })
    ).toBeUndefined();
  });
});
