import { afterEach, describe, expect, it, vi } from "vitest";
import {
  IdentityClient,
  IdentityError,
  computeValueHash,
  identityBindMessage,
} from "./index";

const SALT = "0x" + "11".repeat(32);
// Computed with onchain-backend's computeValueHash (channel-crypto.ts) for
// ("alice@example.com", SALT). If this drifts, binds fail server-side.
const ALICE_HASH =
  "0x108d457bc3f8a1a1ac5eea19e85c4012a34bd2e41218beeba6ca4474487a8aab";

describe("computeValueHash", () => {
  it("matches the server's Poseidon value hash", async () => {
    expect(await computeValueHash("alice@example.com", SALT)).toBe(ALICE_HASH);
  });

  it("normalises case and whitespace like the server", async () => {
    expect(await computeValueHash("  Alice@Example.COM ", SALT)).toBe(
      ALICE_HASH
    );
  });

  it("accepts a salt without 0x", async () => {
    expect(await computeValueHash("alice@example.com", "11".repeat(32))).toBe(
      ALICE_HASH
    );
  });
});

describe("identityBindMessage", () => {
  it("is the exact string the server verifies", () => {
    expect(
      identityBindMessage({
        channel: "email",
        valueHash: "0xabc",
        walletAddress: "0xWallet",
        commitment: "123",
      })
    ).toBe("Bind email channel 0xabc for wallet 0xWallet to identity 123");
  });
});

describe("IdentityClient.bindEmail", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubApi(status: object) {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        const body = url.includes("/identity/status")
          ? status
          : url.includes("/identity/protocol-salt")
            ? { salt: SALT }
            : { success: true, bindingId: "pii-1", channelType: "EMAIL", commitment: "123", verifiedAt: "t" };
        return new Response(JSON.stringify({ data: body }), { status: 200 });
      })
    );
    return calls;
  }

  it("signs the value-bound message and sends it as bindingSignature", async () => {
    const calls = stubApi({ registered: true, commitment: "123", channels: {} });
    const signMessage = vi.fn(async () => "0xsig");
    const id = new IdentityClient("pk_test_x", { apiBaseUrl: "https://api.test/" });

    await id.bindEmail({
      walletAddress: "0xWallet",
      email: " Alice@Example.com ",
      otp: "123456",
      signMessage,
    });

    expect(signMessage).toHaveBeenCalledWith(
      `Bind email channel ${ALICE_HASH} for wallet 0xWallet to identity 123`,
      "0xWallet"
    );
    const bind = calls.find((c) => c.url.endsWith("/api/v1/identity/bind"))!;
    expect(bind.url).toBe("https://api.test/api/v1/identity/bind");
    expect((bind.init.headers as Record<string, string>)["x-publishable-key"]).toBe(
      "pk_test_x"
    );
    expect(JSON.parse(String(bind.init.body))).toEqual({
      walletAddress: "0xWallet",
      channelType: "EMAIL",
      value: "Alice@Example.com",
      otp: "123456",
      bindingSignature: "0xsig",
    });
  });

  it("passes the proof the server expects when prove is given", async () => {
    const calls = stubApi({ registered: true, commitment: "123", channels: {} });
    const prove = vi.fn(async ({ message, scope }) => ({
      merkleTreeDepth: 20,
      merkleTreeRoot: "1",
      nullifier: "2",
      message,
      scope,
      points: ["1", "2", "3", "4", "5", "6", "7", "8"],
    }));
    const id = new IdentityClient("pk_test_x", { organizationId: "org-1" });

    await id.bindEmail({
      walletAddress: "0xWallet",
      email: "alice@example.com",
      otp: "123456",
      signMessage: async () => "0xsig",
      prove,
    });

    expect(prove).toHaveBeenCalledWith({
      message: BigInt(ALICE_HASH).toString(10),
      scope: "email-bind-org-1",
    });
    const body = JSON.parse(String(calls.at(-1)!.init.body));
    expect(body.identityCommitment).toBe("123");
    expect(body.semaphoreProof.scope).toBe("email-bind-org-1");
  });

  it("refuses an unregistered wallet before prompting it to sign", async () => {
    stubApi({ registered: false, commitment: null, channels: {} });
    const signMessage = vi.fn(async () => "0xsig");
    const id = new IdentityClient("pk_test_x");

    await expect(
      id.bindEmail({ walletAddress: "0xW", email: "a@b.c", otp: "1", signMessage })
    ).rejects.toBeInstanceOf(IdentityError);
    expect(signMessage).not.toHaveBeenCalled();
  });

  it("surfaces the server's error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ message: "OTP_DESTINATION_MISMATCH" }), {
          status: 400,
        })
      )
    );
    const id = new IdentityClient("pk_test_x");
    await expect(id.getProtocolSalt()).rejects.toMatchObject({
      status: 400,
      code: "OTP_DESTINATION_MISMATCH",
    });
  });
});
