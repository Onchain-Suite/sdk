// @vitest-environment node
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhook, WebhookVerificationError } from "./index";

const secret = "whsec_test_secret";
const T = 1_764_000_000; // fixed unix seconds
const now = new Date(T * 1000);

/** Reproduces the backend's signer (webhook-dispatch.service.ts) byte for byte. */
function backendSign(body: string, t: number, key = secret) {
  const sig = crypto.createHmac("sha256", key).update(`${t}.${body}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

const body = JSON.stringify({
  id: "6f1c-delivery",
  type: "email.bounced",
  createdAt: "2026-11-24T10:00:05.120Z",
  data: {
    email_id: "cm3x",
    recipient_id: "cm3r2",
    to: "bob@example.com",
    recipient_type: "email",
    created_at: "2026-11-24T10:00:05.000Z",
    environment: "live",
    tags: [{ name: "kind", value: "receipt" }],
    bounce: { type: "hard", subtype: "NoEmail" },
  },
});

describe("verifyWebhook", () => {
  it("accepts a delivery signed the way the backend signs it, and returns the event", async () => {
    const event = await verifyWebhook(body, { "x-onchain-signature": backendSign(body, T) }, secret, { now });
    expect(event.type).toBe("email.bounced");
    expect(event.data.bounce).toEqual({ type: "hard", subtype: "NoEmail" });
  });

  it("accepts a Fetch Headers object, mixed-case keys, a Buffer body, or the header string", async () => {
    const sig = backendSign(body, T);
    await expect(verifyWebhook(body, new Headers({ "X-OnChain-Signature": sig }), secret, { now })).resolves.toBeTruthy();
    await expect(verifyWebhook(body, { "X-OnChain-Signature": sig }, secret, { now })).resolves.toBeTruthy();
    await expect(verifyWebhook(Buffer.from(body), sig, secret, { now })).resolves.toBeTruthy();
  });

  it("verifies non-ASCII bodies over their UTF-8 bytes", async () => {
    const b = JSON.stringify({ id: "x", type: "email.sent", createdAt: "c", data: { to: "zoë@例え.jp" } });
    await expect(verifyWebhook(Buffer.from(b, "utf8"), backendSign(b, T), secret, { now })).resolves.toBeTruthy();
  });

  it("rejects a tampered body", async () => {
    const sig = backendSign(body, T);
    const tampered = body.replace("bob@", "eve@");
    await expect(verifyWebhook(tampered, sig, secret, { now })).rejects.toBeInstanceOf(WebhookVerificationError);
  });

  it("rejects the wrong secret", async () => {
    await expect(verifyWebhook(body, backendSign(body, T, "other"), secret, { now })).rejects.toThrow(/does not match/);
  });

  it("rejects a re-serialised body (the signature covers the raw bytes)", async () => {
    const pretty = JSON.stringify(JSON.parse(body), null, 2);
    await expect(verifyWebhook(pretty, backendSign(body, T), secret, { now })).rejects.toThrow(/does not match/);
  });

  it("rejects a timestamp swapped onto a valid signature", async () => {
    const sig = backendSign(body, T).replace(`t=${T}`, `t=${T + 1}`);
    await expect(verifyWebhook(body, sig, secret, { now })).rejects.toThrow(/does not match/);
  });

  it("enforces the tolerance window in both directions", async () => {
    const sig = backendSign(body, T);
    await expect(verifyWebhook(body, sig, secret, { now: (T + 300) * 1000 })).resolves.toBeTruthy();
    await expect(verifyWebhook(body, sig, secret, { now: (T + 301) * 1000 })).rejects.toThrow(/tolerance/);
    await expect(verifyWebhook(body, sig, secret, { now: (T - 301) * 1000 })).rejects.toThrow(/tolerance/);
    await expect(
      verifyWebhook(body, sig, secret, { now: (T + 3600) * 1000, toleranceSeconds: 7200 }),
    ).resolves.toBeTruthy();
  });

  it("accepts when any of several v1 signatures matches (secret rotation)", async () => {
    const good = backendSign(body, T).split(",")[1];
    const header = `t=${T},v1=${"0".repeat(64)},${good}`;
    await expect(verifyWebhook(body, header, secret, { now })).resolves.toBeTruthy();
  });

  it("rejects missing or malformed headers", async () => {
    await expect(verifyWebhook(body, {}, secret, { now })).rejects.toThrow(/Missing/);
    await expect(verifyWebhook(body, "v1=" + "a".repeat(64), secret, { now })).rejects.toThrow(/timestamp/);
    await expect(verifyWebhook(body, `t=${T}`, secret, { now })).rejects.toThrow(/v1/);
    await expect(verifyWebhook(body, `t=${T},v1=nothex`, secret, { now })).rejects.toThrow(/v1/);
  });

  it("refuses parsed JSON instead of the raw body", async () => {
    await expect(
      verifyWebhook(JSON.parse(body) as never, backendSign(body, T), secret, { now }),
    ).rejects.toThrow(/raw request body/);
  });

  it("requires a secret", async () => {
    await expect(verifyWebhook(body, backendSign(body, T), "", { now })).rejects.toThrow(/secret/);
  });
});
