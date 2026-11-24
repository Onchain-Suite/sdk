/**
 * Shapes of the Email API, kept in the API's own snake_case so what you read
 * in the HTTP docs is exactly what you type here.
 */

/**
 * A recipient: an email address (`ada@example.com` or `Ada <ada@example.com>`),
 * an EVM wallet (`0x…`), or a Solana wallet (base58). Name-service names
 * (`vitalik.eth`, `toly.sol`) are accepted by the type and will be by the API
 * once it resolves them.
 */
export type Recipient = string;

export type Tag = { name: string; value: string };

export interface SendEmailParams {
  /** `address` or `Name <address>`, on a verified domain of your workspace. */
  from: string;
  to: Recipient | Recipient[];
  cc?: Recipient | Recipient[];
  bcc?: Recipient | Recipient[];
  reply_to?: string | string[];
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
  tags?: Tag[] | Record<string, string>;
  /**
   * Send later: an ISO 8601 timestamp WITH an offset (`Z` or `+01:00`), or a
   * `Date`. Up to 72 hours ahead. Omit or `null` to send now.
   */
  scheduled_at?: string | Date | null;
}

export interface RequestOptions {
  /**
   * Same key + same body within 24 h returns the original id and sends
   * nothing. Also what makes a POST safe for the client to retry.
   */
  idempotencyKey?: string;
}

export type EmailStatus =
  | "queued"
  | "scheduled"
  | "sending"
  | "sent"
  | "delivered"
  | "partially_failed"
  | "failed"
  | "canceled";

export type RecipientStatus =
  | "queued"
  | "sent"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "suppressed"
  | "canceled";

export type Environment = "live" | "test";

export interface EmailRecipient {
  id: string;
  kind: "to" | "cc" | "bcc";
  /** What you addressed: for `type: "wallet"`, the wallet — never the email it resolved to. */
  address: string;
  type: "email" | "wallet" | (string & {});
  status: RecipientStatus;
  last_event_at: string | null;
}

export interface Bounce {
  type: "hard" | "soft" | "undetermined";
  subtype: string | null;
}

export interface EmailEvent {
  type:
    | "sent"
    | "delivered"
    | "delivery_delayed"
    | "bounced"
    | "complained"
    | "failed"
    | "suppressed"
    | (string & {});
  recipient_id: string;
  created_at: string;
  bounce?: Bounce;
}

export interface Email {
  id: string;
  environment: Environment;
  from: string;
  subject: string;
  created_at: string;
  status: EmailStatus;
  scheduled_at: string | null;
  tags: Tag[];
  recipients: EmailRecipient[];
  events: EmailEvent[];
}

/** One row of `emails.list()`. The list may omit the per-recipient events. */
export type EmailSummary = Omit<Email, "events" | "recipients"> & {
  recipients?: EmailRecipient[];
  [key: string]: unknown;
};

export interface ListEmailsParams {
  limit?: number;
  /** `next_cursor` from the previous page. */
  cursor?: string;
  status?: EmailStatus;
  environment?: Environment;
  created_after?: string | Date;
  created_before?: string | Date;
  tag?: string;
  /** Only emails addressed to this wallet. */
  wallet?: string;
}

export interface EmailListPage {
  data: EmailSummary[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface UpdateEmailParams {
  scheduled_at: string | Date;
}

export interface CreatedEmail {
  id: string;
}

export interface RescheduledEmail {
  id: string;
  status: "scheduled";
  scheduled_at: string;
}

export interface CanceledEmail {
  id: string;
  status: "canceled";
}
