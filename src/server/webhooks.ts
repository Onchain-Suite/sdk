import type { Bounce, Environment, Tag } from "./types.js";

/**
 * Verifying `email.*` (and every other OnchainSuite) webhook.
 *
 * Matches the backend's signer exactly (webhook-dispatch.service.ts):
 *
 *   X-OnChain-Signature: t=<unix seconds>,v1=<hex>
 *   v1 = hex(HMAC-SHA256(secret as UTF-8, "<t>." + raw body))
 *
 * Built on Web Crypto, so it runs on Node 18+, Deno, Bun and edge runtimes
 * alike. The comparison is `crypto.subtle.verify`, which is constant-time —
 * a `===` on hex strings leaks, through timing, how many leading characters
 * of a forged signature were right.
 */

export const SIGNATURE_HEADER = "x-onchain-signature";
export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface EmailWebhookData {
  email_id: string;
  recipient_id: string;
  /** The address as you sent it; for `recipient_type: "wallet"`, the wallet. */
  to: string;
  recipient_type: "email" | "wallet" | (string & {});
  created_at: string;
  environment: Environment;
  tags: Tag[];
  /** On `email.bounced` only. */
  bounce?: Bounce;
}

export type EmailWebhookType =
  | "email.sent"
  | "email.delivered"
  | "email.delivery_delayed"
  | "email.bounced"
  | "email.complained"
  | "email.failed"
  | "email.suppressed";

export interface WebhookEvent<T = EmailWebhookData> {
  /** Delivery id: the same across retries of one delivery (also `X-OnChain-Delivery`). */
  id: string;
  type: EmailWebhookType | (string & {});
  /** When the webhook was emitted; `data.created_at` is when the event happened. */
  createdAt: string;
  data: T;
}

/** A Fetch `Headers`, Node's `req.headers`, or a plain object. */
export type HeadersLike =
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

export interface VerifyWebhookOptions {
  /**
   * Reject signatures whose timestamp is further than this from now, in
   * seconds. Default 300. `Infinity` turns the check off (not recommended:
   * it lets a captured delivery be replayed forever).
   */
  toleranceSeconds?: number;
  /** Override "now" (tests). */
  now?: Date | number;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

/**
 * Verifies a webhook and returns the parsed event. Throws
 * {@link WebhookVerificationError} if it is not authentic or too old.
 *
 * `payload` must be the RAW request body, exactly as received: the signature
 * covers bytes, and `JSON.stringify(JSON.parse(body))` does not reproduce them.
 *
 * @param headers the request headers, or the `X-OnChain-Signature` value itself
 * @param secret the endpoint's signing secret (shown once when you create it)
 */
export async function verifyWebhook<T = EmailWebhookData>(
  payload: string | Uint8Array | ArrayBuffer,
  headers: HeadersLike | string,
  secret: string,
  options: VerifyWebhookOptions = {},
): Promise<WebhookEvent<T>> {
  const body = toBytes(payload);
  if (typeof secret !== "string" || !secret) {
    throw new TypeError("verifyWebhook: the endpoint signing secret is required");
  }

  const header =
    typeof headers === "string" ? headers : readHeader(headers, SIGNATURE_HEADER);
  if (!header) {
    throw new WebhookVerificationError("Missing X-OnChain-Signature header");
  }
  const { timestamp, signatures } = parseSignatureHeader(header);

  const subtle = await getSubtle();
  const enc = new TextEncoder();
  const key = await subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const prefix = enc.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + body.length);
  signed.set(prefix, 0);
  signed.set(body, prefix.length);

  let valid = false;
  for (const sig of signatures) {
    // Check every candidate (no early exit) so timing does not reveal which matched.
    const ok = await subtle.verify("HMAC", key, sig, signed);
    valid = valid || ok;
  }
  if (!valid) {
    throw new WebhookVerificationError("Signature does not match the payload");
  }

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowMs =
    options.now instanceof Date
      ? options.now.getTime()
      : (options.now ?? Date.now());
  if (Math.abs(nowMs / 1000 - timestamp) > tolerance) {
    throw new WebhookVerificationError(
      `Timestamp is outside the ${tolerance}s tolerance`,
    );
  }

  try {
    return JSON.parse(new TextDecoder().decode(body)) as WebhookEvent<T>;
  } catch {
    throw new WebhookVerificationError("Payload is signed but is not JSON");
  }
}

/** `t=<digits>,v1=<64 hex>[,v1=…]`. Unknown schemes are ignored. */
function parseSignatureHeader(header: string): {
  timestamp: number;
  signatures: ArrayBuffer[];
} {
  let timestamp: number | undefined;
  const signatures: ArrayBuffer[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t" && /^\d+$/.test(v)) timestamp = Number(v);
    else if (k === "v1" && /^[0-9a-fA-F]{64}$/.test(v)) signatures.push(hexToBytes(v).buffer as ArrayBuffer);
  }
  if (timestamp === undefined) {
    throw new WebhookVerificationError("Signature header has no timestamp (t=)");
  }
  if (signatures.length === 0) {
    throw new WebhookVerificationError("Signature header has no v1 signature");
  }
  return { timestamp, signatures };
}

function readHeader(headers: HeadersLike, name: string): string | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(n: string): string | null }).get(name) ?? undefined;
  }
  const rec = headers as Record<string, string | string[] | undefined>;
  for (const k of Object.keys(rec)) {
    if (k.toLowerCase() !== name) continue;
    const v = rec[k];
    return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function toBytes(payload: unknown): Uint8Array {
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  if (payload instanceof Uint8Array) return payload; // Node Buffer included
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  throw new TypeError(
    "verifyWebhook: pass the raw request body (string or Buffer), not parsed JSON. " +
      "In Express use express.raw({ type: 'application/json' }) on the webhook route.",
  );
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function getSubtle(): Promise<SubtleCrypto> {
  const g = (globalThis as { crypto?: Crypto }).crypto;
  if (g?.subtle) return g.subtle;
  // Node 18 has Web Crypto but not as a global. A variable specifier keeps
  // bundlers from trying to resolve a Node builtin for the browser.
  const spec = "node:crypto";
  const mod = (await import(/* @vite-ignore */ spec)) as {
    webcrypto?: { subtle?: SubtleCrypto };
  };
  if (mod.webcrypto?.subtle) return mod.webcrypto.subtle;
  throw new Error("verifyWebhook: Web Crypto is not available in this runtime");
}
