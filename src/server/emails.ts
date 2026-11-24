import type { HttpClient } from "./http.js";
import type {
  CanceledEmail,
  CreatedEmail,
  Email,
  EmailListPage,
  EmailSummary,
  ListEmailsParams,
  RequestOptions,
  RescheduledEmail,
  SendEmailParams,
  UpdateEmailParams,
} from "./types.js";

/**
 * `client.emails` — the transactional Email API.
 *
 * Validation lives on the server (limits change; the API names the failing
 * field in `details.field`). The client only catches mistakes that would
 * otherwise produce a confusing request: a missing `to`/`from`, a non-array
 * batch, an empty id.
 */
export class Emails {
  constructor(private readonly http: HttpClient) {}

  /** `POST /emails`. Resolves to `{ id }`; delivery is asynchronous. */
  send(params: SendEmailParams, options: RequestOptions = {}): Promise<CreatedEmail> {
    return this.http.request<CreatedEmail>({
      method: "POST",
      path: "/emails",
      body: serializeEmail(params, "params"),
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** `POST /emails/batch`: 1–100 emails, all accepted or none. Ids in request order. */
  batch(
    emails: SendEmailParams[],
    options: RequestOptions = {},
  ): Promise<CreatedEmail[]> {
    if (!Array.isArray(emails) || emails.length === 0) {
      throw new TypeError("emails.batch() takes a non-empty array of emails");
    }
    return this.http.request<CreatedEmail[]>({
      method: "POST",
      path: "/emails/batch",
      body: emails.map((e, i) => serializeEmail(e, `emails[${i}]`)),
      idempotencyKey: options.idempotencyKey,
    });
  }

  /** `GET /emails/:id`: status, recipients and events. Never the body. */
  get(id: string): Promise<Email> {
    return this.http.request<Email>({ method: "GET", path: `/emails/${encodeId(id)}` });
  }

  /** `GET /emails`: one page. Pass `next_cursor` back as `cursor` for the next. */
  async list(params: ListEmailsParams = {}): Promise<EmailListPage> {
    const res = await this.http.request<unknown>({
      method: "GET",
      path: "/emails",
      query: {
        limit: params.limit,
        cursor: params.cursor,
        status: params.status,
        environment: params.environment,
        created_after: iso(params.created_after),
        created_before: iso(params.created_before),
        tag: params.tag,
        wallet: params.wallet,
      },
    });
    return toPage(res);
  }

  /**
   * Every email matching `params`, fetching pages as you iterate:
   *
   * ```ts
   * for await (const email of client.emails.listAll({ status: "failed" })) { … }
   * ```
   *
   * Stop early with `break`; no further pages are requested.
   */
  async *listAll(
    params: Omit<ListEmailsParams, "cursor"> & { cursor?: string } = {},
  ): AsyncGenerator<EmailSummary, void, undefined> {
    let cursor = params.cursor;
    for (;;) {
      const page = await this.list({ ...params, cursor });
      for (const email of page.data) yield email;
      // A cursor that does not advance would loop forever; stop instead.
      if (!page.has_more || !page.next_cursor || page.next_cursor === cursor) return;
      cursor = page.next_cursor;
    }
  }

  /** `PATCH /emails/:id`: move a `scheduled` email to a new time. */
  update(id: string, params: UpdateEmailParams): Promise<RescheduledEmail> {
    if (!params || params.scheduled_at == null) {
      throw new TypeError(
        "emails.update() needs scheduled_at; to send now, cancel and send again",
      );
    }
    return this.http.request<RescheduledEmail>({
      method: "PATCH",
      path: `/emails/${encodeId(id)}`,
      body: { scheduled_at: iso(params.scheduled_at) },
    });
  }

  /** `POST /emails/:id/cancel`: a `scheduled` email is never sent. */
  cancel(id: string): Promise<CanceledEmail> {
    return this.http.request<CanceledEmail>({
      method: "POST",
      path: `/emails/${encodeId(id)}/cancel`,
    });
  }
}

function serializeEmail(p: SendEmailParams, label: string): Record<string, unknown> {
  if (!p || typeof p !== "object") {
    throw new TypeError(`${label} must be an email object`);
  }
  if (typeof p.from !== "string" || !p.from.trim()) {
    throw new TypeError(`${label}.from is required`);
  }
  const to = Array.isArray(p.to) ? p.to : p.to == null ? [] : [p.to];
  if (to.length === 0 || to.some((r) => typeof r !== "string" || !r.trim())) {
    throw new TypeError(`${label}.to needs at least one recipient`);
  }
  const out: Record<string, unknown> = { ...p };
  if (p.scheduled_at instanceof Date) out.scheduled_at = iso(p.scheduled_at);
  return out;
}

function iso(v: string | Date | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new TypeError("Invalid Date");
    return v.toISOString();
  }
  return v;
}

function encodeId(id: string): string {
  if (typeof id !== "string" || !id.trim()) {
    throw new TypeError("An email id is required");
  }
  return encodeURIComponent(id);
}

/** Accepts the documented `{ data, has_more, next_cursor }` and a bare array. */
function toPage(res: unknown): EmailListPage {
  if (Array.isArray(res)) {
    return { data: res as EmailSummary[], has_more: false, next_cursor: null };
  }
  const r = (res ?? {}) as Partial<EmailListPage>;
  return {
    data: Array.isArray(r.data) ? r.data : [],
    has_more: Boolean(r.has_more),
    next_cursor: typeof r.next_cursor === "string" && r.next_cursor ? r.next_cursor : null,
  };
}
