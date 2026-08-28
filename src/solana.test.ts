import { describe, it, expect } from "vitest";
import {
  getSolanaProviders,
  getSolanaProvider,
  connectSolana,
  signWithSolana,
  type SolanaProvider,
  type SolanaWindowLike,
} from "./solana";
import { base58encode } from "./base58";

/** A fake injected Solana wallet. */
function fakeSolana(
  opts: {
    address?: string;
    connected?: boolean;
    connectsTo?: string;
    trusted?: boolean;
    signature?: Uint8Array;
  } = {}
): SolanaProvider {
  const pk = (addr: string) => ({ toBase58: () => addr, toString: () => addr });
  return {
    isConnected: opts.connected ?? false,
    publicKey: opts.address ? pk(opts.address) : null,
    connect: async (o) => {
      if (o?.onlyIfTrusted && !opts.trusted) throw new Error("not trusted");
      return { publicKey: opts.connectsTo ? pk(opts.connectsTo) : undefined };
    },
    signMessage: async () => ({
      signature: opts.signature ?? new Uint8Array(64).fill(7),
    }),
  };
}

describe("getSolanaProviders", () => {
  it("dedupes Phantom announced as both window.solana and window.phantom.solana", () => {
    const phantom = fakeSolana({ address: "P1" });
    const win: SolanaWindowLike = { solana: phantom, phantom: { solana: phantom } };
    expect(getSolanaProviders(win)).toEqual([phantom]);
  });

  it("collects distinct wallets across injection points", () => {
    const win: SolanaWindowLike = {
      solana: fakeSolana({ address: "P1" }),
      solflare: fakeSolana({ address: "S1" }),
      backpack: fakeSolana({ address: "B1" }),
    };
    expect(getSolanaProviders(win)).toHaveLength(3);
  });

  it("ignores objects that cannot sign", () => {
    const win = { solana: { isConnected: true } } as unknown as SolanaWindowLike;
    expect(getSolanaProviders(win)).toEqual([]);
  });
});

describe("getSolanaProvider", () => {
  it("prefers a connected wallet over an idle one", () => {
    const idle = fakeSolana({ address: undefined, connected: false });
    const live = fakeSolana({ address: "LIVE", connected: true });
    const win: SolanaWindowLike = { solana: idle, solflare: live };
    expect(getSolanaProvider(win)).toBe(live);
  });

  it("falls back to the first available when none are connected", () => {
    const first = fakeSolana({ connected: false });
    const win: SolanaWindowLike = { solana: first, solflare: fakeSolana() };
    expect(getSolanaProvider(win)).toBe(first);
  });
});

describe("connectSolana", () => {
  it("returns the already-connected address without calling connect", async () => {
    expect(await connectSolana(fakeSolana({ address: "ALREADY" }))).toBe(
      "ALREADY"
    );
  });

  it("uses a silent onlyIfTrusted reconnect when trusted", async () => {
    const wallet = fakeSolana({ trusted: true, connectsTo: "TRUSTED" });
    expect(await connectSolana(wallet)).toBe("TRUSTED");
  });

  it("falls back to interactive connect when not trusted", async () => {
    const wallet = fakeSolana({ trusted: false, connectsTo: "INTERACTIVE" });
    expect(await connectSolana(wallet)).toBe("INTERACTIVE");
  });
});

describe("signWithSolana", () => {
  it("base58-encodes the raw signature the backend verifies", async () => {
    const sig = new Uint8Array(64).fill(9);
    const wallet = fakeSolana({ signature: sig });
    expect(await signWithSolana(wallet, "hello")).toBe(base58encode(sig));
  });

  it("accepts a wallet that returns the signature bytes directly", async () => {
    const raw = new Uint8Array([1, 2, 3, 4]);
    const wallet: SolanaProvider = { signMessage: async () => raw };
    expect(await signWithSolana(wallet, "m")).toBe(base58encode(raw));
  });

  it("throws when the wallet cannot sign", async () => {
    await expect(signWithSolana({}, "m")).rejects.toThrow(/cannot sign/);
  });
});
