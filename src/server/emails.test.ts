// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { OnchainSuiteServer, OnchainSuiteError, type FetchLike } from "./index";

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A fetch that answers from a queue and records what it was asked. */
function mockFetch(
  ...responses: Array<
    | { status?: number; body?: unknown; headers?: Record<string, string> }
    | Error
  >
) {
  const calls: Call[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    });
    const next = responses.shift();
    if (!next) throw new Error("unexpected extra request");
    if (next instanceof Error) throw next;
    const status = next.status ?? 200;
    const h = new Headers(next.headers ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: h,
      text: async () => (next.body === undefined ? "" : JSON.stringify(next.body)),
    };
  };
  return { fn, calls };
}

const ok = (data: unknown, status = 200) => ({
  status,
  body: { success: true, message: "ok", data, timestamp: "t", requestId: "r" },
});

const apiError = (
  status: number,
  code: string,
  details?: unknown,
  headers?: Record<string, string>,
) => ({
  status,
  headers,
  body: {
    success: false,
    error: { code, message: `${code} happened`, details: { code, message: "m", details } },
    meta: { timestamp: "t", path: "/x", requestId: "req_123" },
  },
});

const client = (fn: FetchLike, opts: Record<string, unknown> = {}) =>
  new OnchainSuiteServer("sk_test_abc", { fetch: fn, ...opts });

const email = { from: "Acme <r@acme.xyz>", to: "ada@example.com", subject: "Hi", text: "yo" };

describe("emails.send", () => {
  it("POSTs to /emails with the bearer key and unwraps the envelope", async () => {
    const m = mockFetch(ok({ id: "em_1" }, 202));
    const res = await client(m.fn).emails.send(email);
    expect(res).toEqual({ id: "em_1" });
    expect(m.calls[0].url).toBe("https://api.onchainsuite.com/api/v1/emails");
    expect(m.calls[0].method).toBe("POST");
    expect(m.calls[0].headers.Authorization).toBe("Bearer sk_test_abc");
    expect(m.calls[0].headers["Content-Type"]).toBe("application/json");
    expect(m.calls[0].body).toEqual(email);
    expect(m.calls[0].headers["Idempotency-Key"]).toBeUndefined();
  });

  it("sends the Idempotency-Key header", async () => {
    const m = mockFetch(ok({ id: "em_1" }));
    await client(m.fn).emails.send(email, { idempotencyKey: "order-42" });
    expect(m.calls[0].headers["Idempotency-Key"]).toBe("order-42");
  });

  it("serialises a Date scheduled_at to ISO 8601 with Z", async () => {
    const m = mockFetch(ok({ id: "em_1" }));
    await client(m.fn).emails.send({ ...email, scheduled_at: new Date(Date.UTC(2026, 10, 25, 9, 30)) });
    expect((m.calls[0].body as { scheduled_at: string }).scheduled_at).toBe("2026-11-25T09:30:00.000Z");
  });

  it("passes wallet and name recipients through untouched", async () => {
    const m = mockFetch(ok({ id: "em_1" }));
    const wallet = "0xAbC0000000000000000000000000000000000001";
    await client(m.fn).emails.send({ ...email, to: wallet });
    expect((m.calls[0].body as { to: string }).to).toBe(wallet);
  });

  it("rejects an obviously empty request without calling the API", () => {
    const m = mockFetch();
    const c = client(m.fn);
    expect(() => c.emails.send({ ...email, to: [] })).toThrow(/to needs/);
    expect(() => c.emails.send({ ...email, from: "" })).toThrow(/from is required/);
    expect(m.calls).toHaveLength(0);
  });

  it("honours a custom baseUrl and strips its trailing slash", async () => {
    const m = mockFetch(ok({ id: "em_1" }));
    await client(m.fn, { baseUrl: "http://localhost:3000/api/v1/" }).emails.send(email);
    expect(m.calls[0].url).toBe("http://localhost:3000/api/v1/emails");
  });
});

describe("errors", () => {
  it("become OnchainSuiteError with code, status, inner details and requestId", async () => {
    const m = mockFetch(apiError(422, "VALIDATION_FAILED", { field: "subject" }));
    const err = await client(m.fn).emails.send(email).catch((e) => e);
    expect(err).toBeInstanceOf(OnchainSuiteError);
    expect(err.code).toBe("VALIDATION_FAILED");
    expect(err.status).toBe(422);
    expect(err.details).toEqual({ field: "subject" });
    expect(err.requestId).toBe("req_123");
    expect(err.message).toBe("VALIDATION_FAILED happened");
  });

  it("expose Retry-After seconds on a 429", async () => {
    const m = mockFetch(
      apiError(429, "DAILY_LIMIT_EXCEEDED", { dailyCap: 10000 }, { "Retry-After": "3600" }),
    );
    const err = await client(m.fn).emails.send(email).catch((e) => e);
    expect(err.code).toBe("DAILY_LIMIT_EXCEEDED");
    expect(err.retryAfter).toBe(3600);
    // 1 h is above maxRetryDelayMs: returned, not slept on.
    expect(m.calls).toHaveLength(1);
  });

  it("survive a non-JSON error body", async () => {
    const fn: FetchLike = async () => ({
      ok: false,
      status: 502,
      headers: new Headers(),
      text: async () => "<html>Bad gateway</html>",
    });
    const err = await client(fn, { maxRetries: 0 }).emails.get("em_1").catch((e) => e);
    expect(err.code).toBe("INTERNAL_ERROR");
    expect(err.status).toBe(502);
  });
});

describe("retries", () => {
  it("retry a 429 on a POST without an idempotency key, waiting Retry-After", async () => {
    vi.useFakeTimers();
    try {
      const m = mockFetch(apiError(429, "RATE_LIMITED", {}, { "Retry-After": "2" }), ok({ id: "em_1" }));
      const p = client(m.fn).emails.send(email);
      await vi.advanceTimersByTimeAsync(1999);
      expect(m.calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      await expect(p).resolves.toEqual({ id: "em_1" });
      expect(m.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never retry a 5xx on a POST without an idempotency key (could double-send)", async () => {
    const m = mockFetch(apiError(503, "SEND_UNAVAILABLE"), ok({ id: "em_2" }));
    const err = await client(m.fn).emails.send(email).catch((e) => e);
    expect(err.code).toBe("SEND_UNAVAILABLE");
    expect(m.calls).toHaveLength(1);
  });

  it("never retry a dropped connection on a POST without an idempotency key", async () => {
    const m = mockFetch(new TypeError("socket hang up"), ok({ id: "em_2" }));
    const err = await client(m.fn).emails.send(email).catch((e) => e);
    expect(err.code).toBe("NETWORK_ERROR");
    expect(err.status).toBe(0);
    expect(m.calls).toHaveLength(1);
  });

  it("retry a 5xx on a POST that carries an idempotency key, with the same key", async () => {
    vi.useFakeTimers();
    try {
      const m = mockFetch(apiError(503, "SEND_UNAVAILABLE"), ok({ id: "em_1" }));
      const p = client(m.fn).emails.send(email, { idempotencyKey: "k1" });
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(p).resolves.toEqual({ id: "em_1" });
      expect(m.calls.map((c) => c.headers["Idempotency-Key"])).toEqual(["k1", "k1"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retry a GET on a network error, up to maxRetries", async () => {
    vi.useFakeTimers();
    try {
      const m = mockFetch(new TypeError("reset"), new TypeError("reset"), new TypeError("reset"));
      const p = client(m.fn, { maxRetries: 2 }).emails.get("em_1").catch((e) => e);
      await vi.advanceTimersByTimeAsync(20_000);
      const err = await p;
      expect(err.code).toBe("NETWORK_ERROR");
      expect(m.calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("do not retry a 4xx", async () => {
    const m = mockFetch(apiError(404, "NOT_FOUND"));
    await expect(client(m.fn).emails.get("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(m.calls).toHaveLength(1);
  });

  it("maxRetries: 0 turns retrying off", async () => {
    const m = mockFetch(apiError(429, "RATE_LIMITED", {}, { "Retry-After": "1" }));
    await expect(client(m.fn, { maxRetries: 0 }).emails.send(email)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryAfter: 1,
    });
  });

  it("time out a hung request", async () => {
    const fn: FetchLike = (_url, init) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      });
    const err = await client(fn, { timeoutMs: 20, maxRetries: 0 }).emails.get("em_1").catch((e) => e);
    expect(err.code).toBe("TIMEOUT");
  });
});

describe("emails.batch / get / update / cancel", () => {
  it("batch POSTs an array and returns ids in order", async () => {
    const m = mockFetch(ok([{ id: "a" }, { id: "b" }], 202));
    const res = await client(m.fn).emails.batch([email, { ...email, to: "bob@example.com" }], {
      idempotencyKey: "b1",
    });
    expect(res).toEqual([{ id: "a" }, { id: "b" }]);
    expect(m.calls[0].url).toMatch(/\/emails\/batch$/);
    expect(Array.isArray(m.calls[0].body)).toBe(true);
    expect(m.calls[0].headers["Idempotency-Key"]).toBe("b1");
  });

  it("batch refuses an empty array", () => {
    expect(() => client(mockFetch().fn).emails.batch([])).toThrow(TypeError);
  });

  it("get encodes the id", async () => {
    const m = mockFetch(ok({ id: "a/b" }));
    await client(m.fn).emails.get("a/b");
    expect(m.calls[0].url).toMatch(/\/emails\/a%2Fb$/);
    expect(m.calls[0].method).toBe("GET");
    expect(m.calls[0].body).toBeUndefined();
  });

  it("update PATCHes only scheduled_at", async () => {
    const m = mockFetch(ok({ id: "e", status: "scheduled", scheduled_at: "2026-11-25T12:00:00.000Z" }));
    const res = await client(m.fn).emails.update("e", { scheduled_at: new Date("2026-11-25T12:00:00Z") });
    expect(res.status).toBe("scheduled");
    expect(m.calls[0].method).toBe("PATCH");
    expect(m.calls[0].body).toEqual({ scheduled_at: "2026-11-25T12:00:00.000Z" });
  });

  it("update requires scheduled_at", () => {
    const c = client(mockFetch().fn);
    expect(() => c.emails.update("e", {} as never)).toThrow(/scheduled_at/);
  });

  it("cancel POSTs to /emails/:id/cancel with no body", async () => {
    const m = mockFetch(ok({ id: "e", status: "canceled" }));
    await expect(client(m.fn).emails.cancel("e")).resolves.toEqual({ id: "e", status: "canceled" });
    expect(m.calls[0].url).toMatch(/\/emails\/e\/cancel$/);
    expect(m.calls[0].body).toBeUndefined();
  });

  it("cancel surfaces EMAIL_NOT_SCHEDULED with its status", async () => {
    const m = mockFetch(apiError(409, "EMAIL_NOT_SCHEDULED", { status: "sent" }));
    await expect(client(m.fn).emails.cancel("e")).rejects.toMatchObject({
      code: "EMAIL_NOT_SCHEDULED",
      details: { status: "sent" },
    });
  });
});

describe("emails.list / listAll", () => {
  it("sends the filters as query params and returns the page", async () => {
    const page = { data: [{ id: "a" }], has_more: true, next_cursor: "c2" };
    const m = mockFetch(ok(page));
    const res = await client(m.fn).emails.list({
      limit: 10,
      status: "failed",
      environment: "live",
      created_after: new Date("2026-11-01T00:00:00Z"),
      tag: "kind:receipt",
      wallet: "0xabc",
    });
    expect(res).toEqual(page);
    const u = new URL(m.calls[0].url);
    expect(u.pathname).toBe("/api/v1/emails");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      limit: "10",
      status: "failed",
      environment: "live",
      created_after: "2026-11-01T00:00:00.000Z",
      tag: "kind:receipt",
      wallet: "0xabc",
    });
  });

  it("listAll follows next_cursor until has_more is false", async () => {
    const m = mockFetch(
      ok({ data: [{ id: "a" }, { id: "b" }], has_more: true, next_cursor: "c2" }),
      ok({ data: [{ id: "c" }], has_more: false, next_cursor: null }),
    );
    const ids: string[] = [];
    for await (const e of client(m.fn).emails.listAll({ status: "sent", limit: 2 })) ids.push(e.id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(new URL(m.calls[1].url).searchParams.get("cursor")).toBe("c2");
    expect(new URL(m.calls[1].url).searchParams.get("status")).toBe("sent");
  });

  it("listAll stops on break without fetching the next page", async () => {
    const m = mockFetch(ok({ data: [{ id: "a" }, { id: "b" }], has_more: true, next_cursor: "c2" }));
    for await (const e of client(m.fn).emails.listAll()) {
      expect(e.id).toBe("a");
      break;
    }
    expect(m.calls).toHaveLength(1);
  });

  it("listAll stops if the cursor does not advance", async () => {
    const m = mockFetch(
      ok({ data: [{ id: "a" }], has_more: true, next_cursor: "same" }),
      ok({ data: [{ id: "b" }], has_more: true, next_cursor: "same" }),
    );
    const ids: string[] = [];
    for await (const e of client(m.fn).emails.listAll()) ids.push(e.id);
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("construction", () => {
  it("reads ONCHAINSUITE_API_KEY when no key is passed", async () => {
    const prev = process.env.ONCHAINSUITE_API_KEY;
    process.env.ONCHAINSUITE_API_KEY = "sk_test_env";
    try {
      const m = mockFetch(ok({ id: "e" }));
      await new OnchainSuiteServer(undefined, { fetch: m.fn }).emails.get("e");
      expect(m.calls[0].headers.Authorization).toBe("Bearer sk_test_env");
    } finally {
      if (prev === undefined) delete process.env.ONCHAINSUITE_API_KEY;
      else process.env.ONCHAINSUITE_API_KEY = prev;
    }
  });

  it("throws without a key", () => {
    const prev = process.env.ONCHAINSUITE_API_KEY;
    delete process.env.ONCHAINSUITE_API_KEY;
    try {
      expect(() => new OnchainSuiteServer()).toThrow(/secret API key/);
    } finally {
      if (prev !== undefined) process.env.ONCHAINSUITE_API_KEY = prev;
    }
  });

  it("allows a live key outside a browser", () => {
    expect(() => new OnchainSuiteServer("sk_live_x", { fetch: mockFetch().fn })).not.toThrow();
  });
});
