/**
 * `@onchainsuite/sdk/server` — the server-side client (secret `sk_…` keys).
 *
 * A separate entry point on purpose: nothing here is imported by the browser
 * build (`@onchainsuite/sdk`, `inapp.js`), so a secret-key client cannot end
 * up in a page bundle by accident.
 */
import { Emails } from "./emails.js";
import { HttpClient, type ServerClientOptions } from "./http.js";

export { Emails } from "./emails.js";
export { OnchainSuiteError } from "./errors.js";
export { DEFAULT_BASE_URL } from "./http.js";
export type { FetchLike, ServerClientOptions } from "./http.js";
export {
  verifyWebhook,
  WebhookVerificationError,
  SIGNATURE_HEADER,
  DEFAULT_TOLERANCE_SECONDS,
} from "./webhooks.js";
export type {
  EmailWebhookData,
  EmailWebhookType,
  HeadersLike,
  VerifyWebhookOptions,
  WebhookEvent,
} from "./webhooks.js";
export type * from "./types.js";

export class OnchainSuiteServer {
  readonly emails: Emails;

  /**
   * @param apiKey a secret key (`sk_live_…` / `sk_test_…`). Defaults to the
   *   `ONCHAINSUITE_API_KEY` environment variable.
   */
  constructor(apiKey?: string, options: ServerClientOptions = {}) {
    const key = apiKey ?? readEnvKey();
    if (!key) {
      throw new Error(
        "OnchainSuite: pass a secret API key (sk_live_… / sk_test_…) or set ONCHAINSUITE_API_KEY",
      );
    }
    if (key.startsWith("sk_live_") && isBrowser()) {
      throw new Error(
        "OnchainSuite: a live secret key (sk_live_…) must never run in a browser — " +
          "anyone who opens the page can read it and send mail as you. " +
          "Call the Email API from your server and rotate this key.",
      );
    }
    this.emails = new Emails(new HttpClient(key, options));
  }
}

function readEnvKey(): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } })
    .process;
  return p?.env?.ONCHAINSUITE_API_KEY || undefined;
}

function isBrowser(): boolean {
  const g = globalThis as { window?: { document?: unknown } };
  return typeof g.window !== "undefined" && typeof g.window.document !== "undefined";
}
