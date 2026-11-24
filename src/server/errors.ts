/**
 * Every failed API call rejects with an {@link OnchainSuiteError}.
 *
 * `code` is the API's machine-readable code (`RATE_LIMITED`,
 * `DOMAIN_NOT_VERIFIED`, …) — branch on it, never on `message`. Two codes are
 * produced by the client itself rather than the API: `NETWORK_ERROR` (the
 * request never got an HTTP answer) and `TIMEOUT`. Both have `status` 0.
 */
export class OnchainSuiteError extends Error {
  readonly code: string;
  /** HTTP status, or 0 when no response arrived. */
  readonly status: number;
  /** The API's `details` object (`field`, `index`, `now`, `latest`, …). */
  readonly details: unknown;
  /** Quote this when contacting support. */
  readonly requestId: string | undefined;
  /** Seconds the API asked us to wait (`Retry-After`), on a 429 or 503. */
  readonly retryAfter: number | undefined;

  constructor(init: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    requestId?: string;
    retryAfter?: number;
    cause?: unknown;
  }) {
    super(init.message);
    this.name = "OnchainSuiteError";
    this.code = init.code;
    this.status = init.status;
    this.details = init.details;
    this.requestId = init.requestId;
    this.retryAfter = init.retryAfter;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }
}

/** `Retry-After` is either delay-seconds or an HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfter(
  value: string | null,
  now: number = Date.now(),
): number | undefined {
  if (value == null) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

type ErrorBody = {
  error?: { code?: unknown; message?: unknown; details?: unknown };
  meta?: { requestId?: unknown };
  requestId?: unknown;
  message?: unknown;
};

/**
 * Builds the error from a non-2xx response body.
 *
 * The API nests its own error object inside `error.details`
 * (`{ code, message, details: { field } }`), so the useful `details` are one
 * level down. We take the inner one when it is that shape and fall back to
 * whatever is there otherwise.
 */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers: { get(name: string): string | null },
): OnchainSuiteError {
  const b = (body && typeof body === "object" ? body : {}) as ErrorBody;
  const err = b.error ?? {};
  const code =
    typeof err.code === "string" && err.code ? err.code : fallbackCode(status);

  let details: unknown = err.details;
  if (
    details &&
    typeof details === "object" &&
    "details" in details &&
    ("code" in details || "message" in details)
  ) {
    details = (details as { details: unknown }).details;
  }

  const rawMessage = err.message ?? b.message;
  const message = Array.isArray(rawMessage)
    ? rawMessage.join("; ")
    : typeof rawMessage === "string" && rawMessage
      ? rawMessage
      : `Request failed with status ${status}`;

  const requestId =
    pickString(b.meta?.requestId) ??
    pickString(b.requestId) ??
    headers.get("x-request-id") ??
    undefined;

  return new OnchainSuiteError({
    code,
    message,
    status,
    details,
    requestId: requestId === "unknown" ? undefined : requestId,
    retryAfter: parseRetryAfter(headers.get("retry-after")),
  });
}

function pickString(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function fallbackCode(status: number): string {
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "INTERNAL_ERROR";
  return "HTTP_ERROR";
}
