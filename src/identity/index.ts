import { poseidon2 } from "poseidon-lite/poseidon2";
import type { SignMessageFn } from "../types.js";

/**
 * `@onchainsuite/sdk/identity`: bind a wallet to a channel (email today) on
 * OnchainSuite's privacy-preserving identity protocol.
 *
 * Its own entry point, so in-app users who never bind a channel don't ship
 * Poseidon. The server contract it implements is
 * `docs/ZK_IDENTITY_SDK_CONTRACT.md` in onchain-backend.
 *
 * A bind is accepted only when three proofs agree on the same (wallet, value):
 *  - the wallet signs {@link identityBindMessage}, which names the value hash;
 *  - for email, an OTP that was sent to THAT address;
 *  - when the org requires it, a Semaphore membership proof (supplied by you —
 *    this package does not bundle the Semaphore circuits).
 */

/** The BN254 scalar field; field elements are reduced modulo this. */
const SNARK_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Channel keys, as the server names them in messages, scopes and groups. */
export type IdentityChannel = "email" | "telegram" | "x" | "discord" | "farcaster";

/**
 * The exact string the wallet must sign to bind `valueHash` on `channel`.
 * `walletAddress` must be the address exactly as sent in the bind body — the
 * server verifies the signature against the string as presented.
 */
export function identityBindMessage(params: {
  channel: IdentityChannel;
  valueHash: string;
  walletAddress: string;
  commitment: string;
}): string {
  const { channel, valueHash, walletAddress, commitment } = params;
  return `Bind ${channel} channel ${valueHash} for wallet ${walletAddress} to identity ${commitment}`;
}

/**
 * The server's channel value hash: Poseidon(field(sha256(lower(trim(value)))),
 * field(salt)), as `0x` hex. `salt` is the org's protocol salt
 * ({@link IdentityClient.getProtocolSalt}). Matches the server byte for byte;
 * a mismatch is refused as SIGNATURE_MISMATCH / MESSAGE_MISMATCH.
 */
export async function computeValueHash(
  value: string,
  salt: string
): Promise<string> {
  const normalized = String(value ?? "").trim().toLowerCase();
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalized)
  );
  const hex = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
  const valueField = BigInt(`0x${hex}`) % SNARK_FIELD || 1n;
  const saltHex = salt.startsWith("0x") ? salt : `0x${salt}`;
  const saltField = BigInt(saltHex) % SNARK_FIELD;
  return `0x${poseidon2([valueField, saltField]).toString(16)}`;
}

/** A Semaphore v4 proof as `@semaphore-protocol/proof`'s `generateProof` returns it. */
export interface SemaphoreProofLike {
  merkleTreeDepth: number;
  merkleTreeRoot: string;
  nullifier: string;
  message: string;
  scope: string;
  points: string[];
}

/**
 * Builds the membership proof for a bind. Call
 * `generateProof(identity, group, message, scope)` with these exact values,
 * against a group built from `GET /identity/group/members/state` fetched just
 * before proving.
 */
export type ProveFn = (args: {
  /** Decimal form of the value hash. */
  message: string;
  /** `<channel>-bind-<organizationId>`. */
  scope: string;
}) => Promise<SemaphoreProofLike>;

export interface IdentityClientOptions {
  /** API origin, e.g. "https://api.onchainsuite.com". Default: same origin. */
  apiBaseUrl?: string;
  /** The org id, needed only to build the Semaphore `scope`. */
  organizationId?: string;
}

export interface IdentityStatus {
  registered: boolean;
  commitment: string | null;
  channels: Record<string, boolean>;
}

export interface BindResult {
  success: boolean;
  bindingId: string;
  channelType: string;
  commitment: string;
  verifiedAt: string;
}

/** Thrown for a non-2xx response; `code` is the server's error string. */
export class IdentityError extends Error {
  constructor(
    readonly status: number,
    readonly code: string
  ) {
    super(code);
    this.name = "IdentityError";
  }
}

/**
 * Identity calls with a publishable key.
 *
 * ```ts
 * const id = new IdentityClient("pk_live_...", { apiBaseUrl });
 * await id.requestEmailCode({ walletAddress, email });
 * // …user types the code from their inbox…
 * await id.bindEmail({ walletAddress, email, otp, signMessage });
 * ```
 */
export class IdentityClient {
  private readonly base: string;

  constructor(
    private readonly publishableKey: string,
    private readonly opts: IdentityClientOptions = {}
  ) {
    if (!publishableKey || !publishableKey.startsWith("pk_")) {
      throw new Error("A publishable key (pk_live_… / pk_test_…) is required");
    }
    this.base = (opts.apiBaseUrl ?? "").replace(/\/$/, "");
  }

  /** Whether the wallet is registered, its commitment, and verified channels. */
  getStatus(walletAddress: string): Promise<IdentityStatus> {
    const q = encodeURIComponent(walletAddress);
    return this.request("GET", `/identity/status?walletAddress=${q}`);
  }

  /** The org's protocol salt, the second input to {@link computeValueHash}. */
  async getProtocolSalt(): Promise<string> {
    const { salt } = await this.request<{ salt: string }>(
      "GET",
      "/identity/protocol-salt"
    );
    return salt;
  }

  /**
   * Email a one-time code to `email`. The code redeems a bind of THAT address
   * only, once, within 10 minutes and 5 attempts.
   */
  requestEmailCode(params: {
    walletAddress: string;
    email: string;
  }): Promise<{ success: boolean; expiresAt: string }> {
    return this.request("POST", "/identity/otp", {
      walletAddress: params.walletAddress,
      channelType: "EMAIL",
      destination: params.email,
    });
  }

  /**
   * Bind `email` to the wallet. Signs {@link identityBindMessage} with
   * `signMessage` (one wallet prompt). Pass `prove` when the org requires
   * Semaphore proofs, which is the server default.
   */
  bindEmail(params: {
    walletAddress: string;
    email: string;
    otp: string;
    signMessage: SignMessageFn;
    prove?: ProveFn;
  }): Promise<BindResult> {
    return this.bind({
      walletAddress: params.walletAddress,
      channel: "email",
      value: params.email,
      otp: params.otp,
      signMessage: params.signMessage,
      prove: params.prove,
    });
  }

  /**
   * Bind `value` on `channel`. Fetches the wallet's commitment and the org
   * salt, computes the value hash, asks the wallet to sign the bind message,
   * optionally builds the Semaphore proof, then posts the bind.
   */
  async bind(params: {
    walletAddress: string;
    channel: IdentityChannel;
    value: string;
    otp?: string;
    signMessage: SignMessageFn;
    prove?: ProveFn;
  }): Promise<BindResult> {
    const walletAddress = params.walletAddress.trim();
    const value = params.value.trim();
    const [status, salt] = await Promise.all([
      this.getStatus(walletAddress),
      this.getProtocolSalt(),
    ]);
    if (!status.registered || !status.commitment) {
      throw new IdentityError(401, "IDENTITY_NOT_REGISTERED");
    }
    const commitment = status.commitment;
    const valueHash = await computeValueHash(value, salt);

    const bindingSignature = await params.signMessage(
      identityBindMessage({
        channel: params.channel,
        valueHash,
        walletAddress,
        commitment,
      }),
      walletAddress
    );

    let semaphoreProof: SemaphoreProofLike | undefined;
    if (params.prove) {
      if (!this.opts.organizationId) {
        throw new Error("organizationId is required to build a Semaphore proof");
      }
      semaphoreProof = await params.prove({
        message: BigInt(valueHash).toString(10),
        scope: `${params.channel}-bind-${this.opts.organizationId}`,
      });
    }

    return this.request("POST", "/identity/bind", {
      walletAddress,
      channelType: params.channel.toUpperCase(),
      value,
      ...(params.otp ? { otp: params.otp } : {}),
      bindingSignature,
      ...(semaphoreProof
        ? { identityCommitment: commitment, semaphoreProof }
        : {}),
    });
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(`${this.base}/api/v1${path}`, {
      method,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-key": this.publishableKey,
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      data?: T;
      error?: { message?: string };
      message?: string | string[];
    };
    if (!res.ok) {
      const msg = data?.error?.message ?? data?.message;
      const code = Array.isArray(msg) ? msg.join("; ") : msg;
      throw new IdentityError(res.status, code ?? `Request failed (${res.status})`);
    }
    return data && typeof data === "object" && "data" in data
      ? (data.data as T)
      : (data as unknown as T);
  }
}
