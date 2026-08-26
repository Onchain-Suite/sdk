/**
 * Browser IIFE entry — the no-build, single-`<script>` distribution.
 *
 * Bundled (with `socket.io-client` inlined) into `dist/inapp.js`, this makes the
 * SDK usable from a plain HTML page, a PHP-rendered page, or anything without a
 * bundler — no npm, no ESM import, no separate socket.io script:
 *
 * ```html
 * <!-- ready-to-use instance, auto-initialised from the tag's data-* -->
 * <script src="https://cdn.jsdelivr.net/npm/@onchainsuite/sdk/dist/inapp.js"
 *         data-key="pk_live_yourorg_xxx"></script>
 * <script>
 *   // window.onchainsuite is the instance; call start() once a wallet connects
 *   await window.onchainsuite.start(walletAddress);
 * </script>
 * ```
 *
 * Or construct it yourself from the exposed class:
 * ```html
 * <script src="…/inapp.js"></script>
 * <script>
 *   const os = new OnchainSuite("pk_live_…", { apiBaseUrl: "https://api.onchainsuite.com" });
 *   await os.start(walletAddress);
 * </script>
 * ```
 *
 * `pk_*` (publishable) keys only — never the `sk_*` secret key in the browser.
 */
import { io } from "socket.io-client";
import { OnchainSuite, createClient } from "./index.js";

const DEFAULT_API = "https://api.onchainsuite.com";

const g = globalThis as unknown as {
  io?: unknown;
  OnchainSuite?: typeof OnchainSuite;
  createClient?: typeof createClient;
  onchainsuite?: unknown;
};

// Make the bundled socket.io-client discoverable by the SDK's resolveIo()
// (`globalThis.io`), so this file is fully self-contained — every usage below,
// auto-init or manual, works without a separate socket.io <script>.
if (!g.io) g.io = io;

// Expose the class + factory so no-bundler pages can `new OnchainSuite(...)`.
g.OnchainSuite = OnchainSuite;
g.createClient = createClient;

/** Find the loader's own <script> tag to read its data-* config. */
function loaderScript(): HTMLScriptElement | null {
  if (typeof document === "undefined") return null;
  // `currentScript` is set for a classic sync script; null for async/defer —
  // fall back to an explicit marker, then to the filename.
  const cur = document.currentScript as HTMLScriptElement | null;
  return (
    cur ??
    document.querySelector<HTMLScriptElement>("script[data-onchainsuite]") ??
    document.querySelector<HTMLScriptElement>('script[src*="inapp.js"]')
  );
}

// Zero-JS auto-init: if the loader tag carries a publishable key, build a client
// and expose it as `window.onchainsuite`. Optional `data-autostart` begins the
// wallet handshake immediately (prompts window.ethereum); otherwise the page
// calls `window.onchainsuite.start(wallet)` when its own wallet connects — which
// is the norm, since a dApp already manages wallet connection.
try {
  const el = loaderScript();
  const key = el?.dataset.key?.trim();
  if (key) {
    const client = new OnchainSuite(key, {
      apiBaseUrl: el?.dataset.api?.trim() || DEFAULT_API,
      ioClient: io,
    });
    g.onchainsuite = client;
    if (el && "autostart" in el.dataset) {
      void Promise.resolve(client.start()).catch(() => {
        /* the page can retry via window.onchainsuite.start(wallet) */
      });
    }
  }
} catch {
  /* no DOM (SSR) — the globals above are still exported for manual use */
}

export { OnchainSuite, createClient };
