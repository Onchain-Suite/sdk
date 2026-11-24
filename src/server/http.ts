import { OnchainSuiteError, errorFromResponse } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.onchainsuite.com/api/v1";

export type FetchLike = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}>;

export interface ServerClientOptions {
  /** Defaults to `https://api.onchainsuite.com/api/v1`. */
  baseUrl?: string;
  /**
   * Retries for a failed request that is safe to repeat (see README,
   * "Retries"). Default 2. Set 0 to turn retrying off entirely.
   */
  maxRetries?: number;
  /**
   * Never sleep longer than this for one retry, in ms. A `Retry-After` above it
   * (a daily cap that resets at midnight UTC) is returned to you as the error
   * instead of being waited out. Default 60_000.
   */
  maxRetryDelayMs?: number;
  /** Per-attempt timeout in ms. Default 30_000. */
  timeoutMs?: number;
  /** A custom `fetch` (tests, proxies, older runtimes). Defaults to the global one. */
  fetch?: FetchLike;
}

export interface RequestOptions {
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  idempotencyKey?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Transport: auth, the `{ success, data }` envelope, typed errors, retries.
 *
 * Retry policy — the whole point is never to send an email twice:
 * - A 429 is always retried (within `maxRetries`/`maxRetryDelayMs`): the API
 *   refuses rate-limited requests before it stores anything.
 * - A 5xx, a timeout or a dropped connection is ambiguous: the email may
 *   already be stored and queued. Those are retried only for GET/PATCH and
 *   for a POST that carries an Idempotency-Key, where the API replays the
 *   original answer instead of sending again.
 */
export class HttpClient {
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly maxRetryDelayMs: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(
    private readonly apiKey: string,
    options: ServerClientOptions = {},
  ) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 2));
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    const f =
      options.fetch ??
      (typeof fetch === "function" ? (fetch as unknown as FetchLike) : undefined);
    if (!f) {
      throw new Error(
        "OnchainSuite: no global fetch. Use Node 18+ or pass `fetch` in the options.",
      );
    }
    this.fetchImpl = f;
  }

  async request<T>(opts: RequestOptions): Promise<T> {
    const url = this.baseUrl + opts.path + toQuery(opts.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: "application/json",
    };
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;
    const body = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const ambiguousIsRetryable =
      opts.method !== "POST" || Boolean(opts.idempotencyKey);

    for (let attempt = 0; ; attempt++) {
      let error: OnchainSuiteError;
      try {
        const res = await this.once(url, opts.method, headers, body);
        const parsed = parseJson(await res.text());
        if (res.ok) return unwrap<T>(parsed);
        error = errorFromResponse(res.status, parsed, res.headers);
      } catch (e) {
        if (!(e instanceof OnchainSuiteError)) throw e;
        error = e;
      }

      const retryable =
        error.status === 429 ||
        ((error.status >= 500 || error.status === 0) && ambiguousIsRetryable);
      if (!retryable || attempt >= this.maxRetries) throw error;
      const delay =
        error.retryAfter !== undefined
          ? error.retryAfter * 1000
          : backoff(attempt);
      if (delay > this.maxRetryDelayMs) throw error;
      await sleep(delay);
    }
  }

  private async once(
    url: string,
    method: string,
    headers: Record<string, string>,
    body: string | undefined,
  ) {
    const controller =
      typeof AbortController === "function" ? new AbortController() : undefined;
    let timedOut = false;
    const timer = controller
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, this.timeoutMs)
      : undefined;
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        body,
        signal: controller?.signal,
      });
    } catch (cause) {
      throw new OnchainSuiteError({
        code: timedOut ? "TIMEOUT" : "NETWORK_ERROR",
        message: timedOut
          ? `Request timed out after ${this.timeoutMs} ms`
          : `Network error: ${cause instanceof Error ? cause.message : String(cause)}`,
        status: 0,
        cause,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** 0.5 s, 1 s, 2 s, … capped at 8 s, with ±25 % jitter so clients spread out. */
function backoff(attempt: number): number {
  const base = Math.min(8000, 500 * 2 ** attempt);
  return Math.round(base * (0.75 + Math.random() * 0.5));
}

function toQuery(q?: Record<string, string | number | undefined>): string {
  if (!q) return "";
  const parts: string[] = [];
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function unwrap<T>(body: unknown): T {
  if (
    body &&
    typeof body === "object" &&
    "success" in body &&
    "data" in body
  ) {
    return (body as { data: T }).data;
  }
  return body as T;
}
