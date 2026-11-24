# @onchainsuite/sdk

Dead-simple in-app push notifications for any dApp. Wallet-authenticated,
real-time, and tiny. Built-in toast UI you can fully restyle or render your own.

Also: a server-side client for transactional email, to addresses or wallets.
See [Transactional email (server)](#transactional-email-server).

```ts
import { OnchainSuite } from "@onchainsuite/sdk";

const os = new OnchainSuite("pk_live_yourorg_xxx");
await os.start(); // wallet signs in → notifications start showing
```

That's the whole integration. No framework required — `socket.io-client` is
bundled as a dependency, nothing else to install.

## OS notifications (web push)

The in-app toast only reaches someone while your page is open. Web push reaches
them when the browser is **closed** — including on a phone, through a mobile
browser or a home-screen PWA on iOS 16.4+.

It needs no configuration from you. OnchainSuite holds one platform-wide key.

### 1. Serve the service worker

Copy `node_modules/@onchainsuite/sdk/public/onchainsuite-sw.js` to the **root**
of your site, so it is served at `/onchainsuite-sw.js`.

The path matters: a service worker only controls pages at or below its own URL,
so one served from `/static/sw.js` covers `/static` and nothing else.

Already have a service worker? Do not add a second — import ours into yours:

```js
importScripts("/onchainsuite-sw.js");
```

Two workers at the same scope fight over the same push events, and only one wins.

### 2. Ask, at the right moment

```ts
const client = createClient("pk_live_…", { apiBaseUrl: "https://api.onchainsuite.com" });
await client.start();

// Later — from a button, after the user did something a notification helps with
if (client.pushStatus() === "prompt") {
  const status = await client.enablePush();   // "granted" | "denied" | …
}
```

> **Do not call** **`enablePush()`** **on page load.** A user who taps "Block" is
> **never asked again** — the browser remembers and there is no API to
> re-prompt. A prompt at a moment they have no context for does not cost you a
> retry, it costs you that user permanently.
>
> The moment that works is right after they did something a notification would
> obviously help with — placed an order, opened a position, joined a list.

`pushStatus()` returns `"unsupported" | "denied" | "prompt" | "granted"`. Treat
the first two the same: do not show a "turn on notifications" button, because
pressing it can no longer do anything.

### 3. That is it

`start()` re-registers a browser that has already granted permission, without
prompting. That is not an optimisation — browsers expire push subscriptions
without telling anyone, and re-registering on every load is the only way a
silently-rotated subscription is ever noticed.

To turn it off:

```ts
await client.disablePush();
```

### What arrives, and when

A notification takes exactly one path per recipient:

| <br />                    | <br />                                     |
| ------------------------- | ------------------------------------------ |
| Your page is open         | in-app toast only                          |
| Page closed, push enabled | OS notification                            |
| Neither                   | held, and delivered next time they connect |

Never both — a phone banner about the thing already on screen reads as a bug.

The OS notification carries a **summary** (title, body, link), not the full
content: it renders on a lock screen where anyone holding the phone can read it.
Both carry the same `deliveryId`, and the SDK dedupes on it — so a user who taps
a notification and lands on your page does not see it twice.

## Mobile (React Native)

Native OS notifications on iOS and Android. Same backend, same analytics, same
`deliveryId` dedupe as web.

### Why you fetch the token, not us

Getting an APNs or FCM token needs native code, and your app already has an
opinion about how — `expo-notifications`, `@react-native-firebase/messaging`, or
your own bridge. Bundling one would pin your React Native version, force a
linking step, and break web builds of this package for everyone who never wanted
mobile.

So you get the token however you already do, and hand it over:

```ts
import messaging from "@react-native-firebase/messaging";

await client.start(walletAddress);

// YOUR app chooses when to ask — see the warning below
await messaging().requestPermission();
const token = await messaging().getToken();
await client.registerDevice(token, "android");

// Tokens rotate. Re-register when they do:
messaging().onTokenRefresh((t) => client.registerDevice(t, "android"));
```

> **Call** **`registerDevice`** **on every app launch**, not only after the permission
> prompt. Tokens rotate on reinstall and sometimes on OS upgrade, and nothing
> announces it — re-registering is the only way a rotated token is ever noticed.
> Repeat calls upsert; they do not accumulate devices.

> **The permission prompt is yours to time.** A user who declines is **never
> asked again** on either platform. Prompting on first launch is how apps lose
> half their addressable audience permanently.

To stop notifications for one device:

```ts
await client.unregisterDevice(token);
```

### What your customer has to set up

Native push needs a credential from *your* Apple or Google account, uploaded once
in OnchainSuite settings — an APNs `.p8`, or a Firebase service account JSON.
It is verified on upload, so you find out immediately whether it works.

**Web push needs none of this.** If you have a website as well as an app, web
push reaches phones with zero setup — start there.

### Handling a tap

Route the notification's `deliveryId` into your app and the SDK dedupes it
against the in-app render, so a user who taps a notification and lands in your
app does not see the same thing twice.

### Options

```ts
createClient("pk_live_…", {
  push: { serviceWorkerPath: "/onchainsuite-sw.js" },  // default
  // push: false,                                       // disable entirely
});
```

## Install

```bash
npm i @onchainsuite/sdk
```

### No build step (plain HTML, PHP, any server-rendered page)

**One self-contained `<script>`** — `dist/inapp.js` bundles `socket.io-client`, so
there's nothing else to load. Point the tag at a publishable `pk_*` key and it
auto-inits `window.onchainsuite`:

```html
<script src="https://cdn.jsdelivr.net/npm/@onchainsuite/sdk/dist/inapp.js"
        data-key="pk_live_yourorg_xxx"></script>
<script>
  // `window.onchainsuite` is a ready instance — start it once a wallet connects:
  document.querySelector("#connect").onclick = () =>
    window.onchainsuite.start(/* walletAddress?, or omit to auto-detect an injected wallet */);
  window.onchainsuite.on("notification", (n) => console.log(n));
</script>
```

- `data-key` is a **publishable** `pk_live_…` / `pk_test_…` key — **never** the
  `sk_*` secret key (that's server-side only).
- Optional: `data-api="https://api.onchainsuite.com"` to override the endpoint;
  `data-autostart` to begin the wallet handshake on load.
- The same file also exposes the class, so you can construct it yourself instead:
  `const os = new OnchainSuite("pk_live_…")`.

_(PHP/any backend: render the tag above for the browser render, and use the plain
REST API — `sk_*` Bearer — for server-side sends. The SDK is browser-only.)_

**ESM from a CDN**, if you prefer modules (load `socket.io-client` first so the SDK
finds `window.io`):

```html
<script src="https://cdn.socket.io/4.8.3/socket.io.min.js"></script>
<script type="module">
  import { OnchainSuite } from "https://esm.sh/@onchainsuite/sdk";
  const os = new OnchainSuite("pk_live_yourorg_xxx", {
    apiBaseUrl: "https://api.onchainsuite.com",
  });
  await os.start();
</script>
```

## Usage

### 1. Simplest (uses the connected wallet)

```ts
const os = new OnchainSuite("pk_live_...", {
  apiBaseUrl: "https://api.onchainsuite.com",
});
await os.start(); // discovers a browser-extension wallet and prompts it to sign
```

The zero-config path auto-detects **injected** wallets: EVM via EIP-6963
(MetaMask, Rabby, Coinbase, Brave, Zerion, Frame — it picks the wallet that
holds your address, or the one already connected, rather than guessing
`window.ethereum`), then Solana (Phantom, Solflare, Backpack, Glow). Pass an
address to `start(address)` to skip discovery.

### 2. Bring your own signer (wagmi / WalletConnect / Privy / Dynamic / Solana adapter)

`signMessage` is the universal path — it works for **every** wallet, including
ones that don't inject (WalletConnect, Privy, Dynamic, Coinbase Wallet SDK,
smart/AA wallets, Solana wallet-adapter). Your connector signs; the SDK never
touches the wallet.

```ts
const os = new OnchainSuite("pk_live_...", {
  apiBaseUrl: "https://api.onchainsuite.com",
  signMessage: async (message) => signMessageAsync({ message }), // your wallet lib
});
await os.start(walletAddress);
```

### 3. React

```tsx
useEffect(() => {
  const os = new OnchainSuite("pk_live_...", {
    apiBaseUrl: "https://api.onchainsuite.com",
  });
  os.start();
  return () => os.stop();
}, []);
```

## Send a notification (from your backend)

Sending is a server-to-server call authenticated with your **secret** key
(`sk_*`) — never expose it in the browser. One `POST`:

```ts
// Node / any backend
await fetch("https://api.onchainsuite.com/api/v1/inapp/push", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: "Bearer sk_live_xxx",
  },
  body: JSON.stringify({
    walletAddress: "0xabc...",
    title: "GM 👋",
    body: "Your rewards are ready to claim.",
    ctaLabel: "Claim",
    ctaUrl: "https://app.myprotocol.xyz/rewards",
  }),
});
```

The recipient's dApp (running the SDK from **Usage** above) receives it in real
time — or on next connect if they're offline.

## Transactional email (server)

`@onchainsuite/sdk/server` is a server-side client for the Email API: receipts,
sign-in links, alerts, sent from your own verified domain, to an email address
or to a wallet. It authenticates with a **secret** key, so it is a separate
entry point that the browser build never imports. Node 18+ (or Deno, Bun, an
edge runtime: anything with `fetch`). No extra dependencies.

```ts
import { OnchainSuiteServer } from "@onchainsuite/sdk/server";

const onchain = new OnchainSuiteServer(process.env.ONCHAINSUITE_API_KEY); // sk_live_… / sk_test_…

const { id } = await onchain.emails.send(
  {
    from: "Acme <receipts@acme.xyz>",
    to: "ada@example.com",
    subject: "Your receipt",
    html: "<p>Thanks for your order.</p>",
    tags: [{ name: "kind", value: "receipt" }],
  },
  { idempotencyKey: `receipt-${order.id}` },
);
```

`new OnchainSuiteServer()` with no argument reads `ONCHAINSUITE_API_KEY`. A
`sk_test_` key runs every check and stores the email but sends nothing; the
recipients move straight to `delivered`, and the webhooks fire with
`environment: "test"`. Constructing the client with an `sk_live_` key in a
browser throws: anyone who opens the page could read the key and send mail as you.

### Send later

```ts
const { id } = await onchain.emails.send({
  from: "Acme <hello@acme.xyz>",
  to: "ada@example.com",
  subject: "Your trial ends tomorrow",
  text: "…",
  scheduled_at: new Date(Date.now() + 24 * 3600_000), // or "2026-11-25T09:30:00Z"
});

await onchain.emails.update(id, { scheduled_at: "2026-11-25T12:00:00Z" }); // reschedule
await onchain.emails.cancel(id); // nothing is sent
```

Up to 72 hours ahead. A string must carry an offset (`Z` or `+01:00`); a
local time with no offset is refused rather than guessed. Once an email has
been released for sending, `update` and `cancel` fail with
`EMAIL_NOT_SCHEDULED`.

### Send to a wallet

```ts
await onchain.emails.send({
  from: "Acme <alerts@acme.xyz>",
  to: "0x4b2f…c91a", // EVM (any casing) or a Solana address
  subject: "Your position is close to liquidation",
  text: "…",
});
```

The email goes to the address that wallet's owner shared with your workspace.
You never see that address: `get`, `list` and webhooks show the wallet. A
wallet must be the only recipient (a Cc would expose its address), so to reach
several wallets use `batch`. If the owner has not shared an email, the send
fails with `RECIPIENT_NOT_RESOLVABLE` and nothing is stored. Name-service
recipients (`vitalik.eth`, `toly.sol`) currently fail with
`RECIPIENT_TYPE_NOT_SUPPORTED_YET`; the client passes them through unchanged
so they will work as soon as the API resolves them.

### Batch, look up, list

```ts
const ids = await onchain.emails.batch(
  wallets.map((w) => ({ from: "Acme <alerts@acme.xyz>", to: w, subject: "GM", text: "…" })),
  { idempotencyKey: `drop-${dropId}` },
); // 1–100 emails, all accepted or none; ids in request order

const email = await onchain.emails.get(id);
email.status; // "queued" | "scheduled" | "sent" | "delivered" | "partially_failed" | "failed" | …
email.recipients; // per-recipient status
email.events; // sent / delivered / bounced / …, oldest first

// One page
const page = await onchain.emails.list({ status: "failed", limit: 50 });
page.data; page.has_more; page.next_cursor; // pass next_cursor back as `cursor`

// Or every match, fetching pages as you go
for await (const e of onchain.emails.listAll({
  environment: "live",
  created_after: new Date(Date.now() - 7 * 86400_000),
  wallet: "0x4b2f…c91a",
})) {
  console.log(e.id, e.status);
}
```

`list` filters: `limit`, `cursor`, `status`, `environment`, `created_after`,
`created_before` (ISO string or `Date`), `tag`, `wallet`.

### Errors

Every failure rejects with an `OnchainSuiteError`:

```ts
import { OnchainSuiteError } from "@onchainsuite/sdk/server";

try {
  await onchain.emails.send(email);
} catch (err) {
  if (err instanceof OnchainSuiteError) {
    err.code;       // "DOMAIN_NOT_VERIFIED", "RATE_LIMITED", "VALIDATION_FAILED", …
    err.status;     // HTTP status (0 = no response: NETWORK_ERROR / TIMEOUT)
    err.details;    // e.g. { field: "subject" }, { index: 3 } in a batch
    err.retryAfter; // seconds, on a 429
    err.requestId;  // quote this to support
  }
}
```

Branch on `code`, never on `message`. The full list of codes is in the Email
API reference.

### Retries, and why a POST is not retried by default

The client retries up to `maxRetries` times (default 2) with exponential
backoff, waiting `Retry-After` when the API gives one. What it retries depends
on whether repeating the request could send the email twice:

- **429** is always retried. The API rate-limits before it stores anything,
  so a refused request left nothing behind.
- **5xx, a timeout or a dropped connection** is ambiguous: the API may have
  stored and queued the email and then failed to answer. Repeating that
  `POST` would send it again. So these are retried for `get`, `list` and
  `update`, and for `send`/`batch` **only when you pass an `idempotencyKey`**.
  With a key, a repeat is safe: the API answers with the original id and
  sends nothing new.

So pass an `idempotencyKey` on every send that matters, derived from your own
record (`receipt-${order.id}`), never from a random value made per attempt.
That makes your own retries (a job queue re-running a handler) safe too.

A `Retry-After` longer than `maxRetryDelayMs` (default 60 s), such as
`DAILY_LIMIT_EXCEEDED`, which resets at 00:00 UTC, is not slept on: you get
the error with `retryAfter` set and decide what to do.

| Option            | Default                                 |                                       |
| ----------------- | --------------------------------------- | ------------------------------------- |
| `baseUrl`         | `https://api.onchainsuite.com/api/v1`   |                                       |
| `maxRetries`      | `2`                                     | `0` turns retrying off.               |
| `maxRetryDelayMs` | `60000`                                 | Longest single wait.                  |
| `timeoutMs`       | `30000`                                 | Per attempt.                          |
| `fetch`           | global `fetch`                          | Custom transport (tests, proxies).    |

### Verify webhooks

Subscribe an endpoint to the `email.*` topics (`email.sent`,
`email.delivered`, `email.delivery_delayed`, `email.bounced`,
`email.complained`, `email.failed`, `email.suppressed`) in **Settings →
Integrations**, then verify each delivery against its **raw** body before
you trust it:

```ts
import express from "express";
import { verifyWebhook, WebhookVerificationError } from "@onchainsuite/sdk/server";

app.post(
  "/webhooks/onchainsuite",
  express.raw({ type: "application/json" }), // the raw bytes, not parsed JSON
  async (req, res) => {
    let event;
    try {
      event = await verifyWebhook(req.body, req.headers, process.env.ONCHAINSUITE_WEBHOOK_SECRET!);
    } catch (err) {
      if (err instanceof WebhookVerificationError) return res.sendStatus(400);
      throw err;
    }
    if (event.type === "email.bounced" && event.data.bounce?.type === "hard") {
      await markUndeliverable(event.data.to);
    }
    res.sendStatus(200); // answer quickly; do slow work after
  },
);
```

In a Fetch-style handler (Next.js route, Hono, Workers):
`await verifyWebhook(await req.text(), req.headers, secret)`.

`verifyWebhook` checks `X-OnChain-Signature` (`t=<unix seconds>,v1=<hex>`,
HMAC-SHA256 of `"<t>.<raw body>"` with the endpoint secret) using a
constant-time comparison, rejects a timestamp more than 5 minutes from now
(`{ toleranceSeconds }` to change it), and returns the parsed event. Parse
first and re-serialise, and the bytes no longer match. Deliveries are retried
on a non-2xx and can repeat, so dedupe on `email_id` + `recipient_id` + `type`.

## Make it yours — display is fully flexible

Everything about the built-in UI is overridable. Change timing, position, colors,
or opt out entirely.

```ts
new OnchainSuite("pk_live_...", {
  display: {
    position: "top-right",      // bottom-right | bottom-left | top-right | top-left
    accent: "#00e0b8",          // CTA / accent color
    background: "#0b0d12",
    foreground: "#ffffff",
    duration: 12000,            // ms on screen; 0 = sticky until dismissed
    maxVisible: 4,
    cardStyle: { borderRadius: "20px" }, // any CSS on the card
  },
});
```

Per-notification display time — pass a function:

```ts
new OnchainSuite("pk_live_...", {
  display: {
    duration: (n) => (n.cta ? 0 : 6000), // CTAs stay sticky, others auto-hide
  },
});
```

Render it 100% yourself (your own toast/modal/banner) — return `false` to skip the
built-in UI. Analytics still work via the provided actions:

```ts
new OnchainSuite("pk_live_...", {
  display: false, // turn the built-in UI off
  onNotification: (n, actions) => {
    myUI.toast({
      title: n.title,
      body: n.body,
      cta: n.cta,
      onShow: () => actions.report("viewed"),
      onClick: () => actions.click(), // reports "clicked" + opens the CTA url
      onClose: () => actions.dismiss(),
    });
  },
});
```

## API

### `new OnchainSuite(publishableKey, options?)`

`publishableKey` — `pk_live_*` / `pk_test_*` from **Dashboard → Integrations →
In-App**.

| Option           | Type                               | Default           | Notes                                               |
| ---------------- | ---------------------------------- | ----------------- | --------------------------------------------------- |
| `apiBaseUrl`     | `string`                           | same-origin       | API host, no `/api/v1`.                             |
| `signMessage`    | `(msg, wallet) => Promise<string>` | injected wallet   | Custom signer — the universal path (WalletConnect / Privy / Dynamic / Solana adapter). |
| `provider`       | EIP-1193                           | EIP-6963 / `window.ethereum` | Force a specific EVM provider; else auto-discovered. |
| `display`        | `DisplayOptions \| false`          | enabled           | `false` = headless. See table below.                |
| `onNotification` | `(n, actions) => boolean \| void`  | —                 | Custom handler; return `false` to skip built-in UI. |
| `ioClient`       | `io` factory                       | auto              | Provide socket.io-client's `io` explicitly.         |
| `debug`          | `boolean`                          | `false`           | Verbose logging.                                    |

`DisplayOptions`: `position`, `accent`, `background`, `foreground`,
`duration` (`number | (n) => number`, `0` = sticky), `maxVisible`, `zIndex`,
`cardStyle`.

### Methods

- `start(walletAddress?) → Promise<void>` — auth + start receiving.
- `stop()` — disconnect + clear toasts.
- `on(event, cb) → unsubscribe` — `"notification" | "connected" | "disconnected" | "error"`.
- `report(notification, type)` — `"delivered" | "viewed" | "dismissed" | "clicked"`.

### Notification shape

```ts
interface Notification {
  deliveryId: string;
  campaignRunId: string;
  walletAddress: string;
  title: string;
  body: string;
  cta?: { label: string; url: string };
  createdAt: string;
  expiresAt: string;
}
```

## How it works & security

1. `POST /api/v1/inapp/challenge` (publishable-key auth) → a message to sign.
2. Wallet signs (EIP-191); `POST /api/v1/inapp/verify` → short-lived session JWT +
   WebSocket URL.
3. Socket.IO connects to `/api/v1/inapp/register` with the token, auto-reconnects,
   and replays notifications missed while offline.
4. Each notification is reported `delivered`, then rendered (or handed to
   `onNotification`), then `viewed/clicked/dismissed` from the UI.

Security notes:

- **No secrets in the browser.** Only the *publishable* key ships to the client;
  it's scoped by **allow-listed origins** (Dashboard → Integrations → In-App →
  Origins). Wrong origin → `401`.
- **Wallet ownership is proven** by an EIP-191 signature over a single-use,
  5-minute nonce; the challenge/verify endpoints are rate-limited server-side.
- **XSS-safe rendering** — content is set via `textContent`, never `innerHTML`.

## Docs

- Runnable demo: [`example/index.html`](./example/index.html).

