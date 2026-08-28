import { describe, it, expect } from "vitest";
import { base58encode } from "./base58";

const b = (...n: number[]) => new Uint8Array(n);
const ascii = (s: string) => new TextEncoder().encode(s);

describe("base58encode", () => {
  // Canonical Bitcoin/Solana base58 vectors.
  it("matches known vectors", () => {
    expect(base58encode(b())).toBe("");
    expect(base58encode(b(0))).toBe("1"); // leading zero → '1'
    expect(base58encode(b(0, 0))).toBe("11");
    expect(base58encode(b(0x61))).toBe("2g");
    expect(base58encode(b(0x62, 0x62, 0x62))).toBe("a3gV");
    expect(base58encode(b(0x63, 0x63, 0x63))).toBe("aPEr");
    expect(base58encode(ascii("simply a long string"))).toBe(
      "2cFupjhnEsSn59qHXstmK2ffpLv2",
    );
  });

  it("preserves leading zero bytes as leading 1s", () => {
    expect(base58encode(b(0, 0, 0x61))).toBe("112g");
  });

  it("encodes a 64-byte ed25519 signature to a plausible length", () => {
    const sig = new Uint8Array(64).fill(0xff);
    const out = base58encode(sig);
    expect(out.length).toBeGreaterThan(80); // 64 bytes → ~87–88 base58 chars
    expect(/^[1-9A-HJ-NP-Za-km-z]+$/.test(out)).toBe(true); // valid base58 alphabet
  });
});
