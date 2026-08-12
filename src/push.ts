import type { PushRegistration, PushStatus } from "./types";

/**
 * Web push registration.
 *
 * WHAT THIS BUYS THE USER
 *
 * The in-app channel only reaches someone while your page is open. Web push
 * reaches them when the browser is closed — including on a phone, via a mobile
 * browser or an installed PWA on iOS 16.4+. It needs no configuration from you:
 * OnchainSuite holds one platform-wide VAPID key.
 *
 * THE PERMISSION RULE THAT MATTERS MOST
 *
 * A user who taps "Block" is **never asked again** — the browser remembers, and
 * there is no API to re-prompt. So a prompt fired at a moment the user has no
 * context for does not cost you a retry; it costs you that user permanently.
 *
 * That is why {@link enablePush} must be called from your own UI, in response to
 * something the user did, and why nothing here prompts on its own. It is also
 * why we check the server has push configured *before* prompting: asking for
 * permission we cannot then use is the worst of both outcomes.
 */

/** VAPID keys travel as base64url; PushManager wants raw bytes. */
function urlBase64ToUint8Array(base64: string): BufferSource {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(normalized);
  // Allocate the ArrayBuffer explicitly: a plain `new Uint8Array(n)` is typed
  // over ArrayBufferLike, which does not satisfy BufferSource under lib.dom's
  // stricter generic in TS 5.7+.
  const buffer = new ArrayBuffer(raw.length);
  const output = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/** Whether this browser can do web push at all. */
export function isPushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

/**
 * Current permission state, without prompting.
 *
 * `"unsupported"` and `"denied"` are both terminal for this browser — treat them
 * the same in your UI and do not offer a "turn on notifications" button, because
 * pressing it can no longer do anything.
 */
export function getPushStatus(): PushStatus {
  if (!isPushSupported()) return "unsupported";
  const permission = Notification.permission;
  if (permission === "granted") return "granted";
  if (permission === "denied") return "denied";
  return "prompt";
}

/**
 * Subscribe this browser to push and hand the subscription to the server.
 *
 * @param deps.serviceWorkerPath where your service worker is served from. It
 *   must be at or above the scope you want covered — a worker at `/sw.js`
 *   covers the whole origin, one at `/app/sw.js` covers only `/app`.
 * @returns the registration payload sent to the server, or null when push is
 *   unavailable or the user declined.
 */
export async function subscribeToPush(deps: {
  vapidPublicKey: string;
  serviceWorkerPath: string;
  prompt: boolean;
}): Promise<PushRegistration | null> {
  if (!isPushSupported()) return null;

  // Reuse an existing registration for this scope rather than registering a
  // second worker — calling register() repeatedly with the same URL is a no-op
  // in browsers, but a DIFFERENT path silently creates a competing worker and
  // the two fight over the same push events.
  const registration = await navigator.serviceWorker.register(
    deps.serviceWorkerPath
  );
  await navigator.serviceWorker.ready;

  if (Notification.permission === "denied") return null;
  if (Notification.permission !== "granted") {
    if (!deps.prompt) return null;
    const result = await Notification.requestPermission();
    if (result !== "granted") return null;
  }

  // An existing subscription is reused, which is what makes calling this on
  // every page load cheap. The browser returns the same endpoint, and the
  // server upserts on it.
  const existing = await registration.pushManager.getSubscription();
  const subscription =
    existing ??
    (await registration.pushManager.subscribe({
      // Required by every browser: a push that shows nothing is not permitted,
      // and silent pushes are how push permission gets abused.
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(deps.vapidPublicKey),
    }));

  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };

  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    // All three are needed to encrypt a payload (RFC 8291). A partial
    // subscription cannot receive anything, so sending it would only create a
    // row that fails later.
    return null;
  }

  return {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  };
}

/**
 * Unsubscribe this browser locally.
 *
 * Returns the endpoint that was removed so the caller can tell the server,
 * which cannot otherwise know which of a wallet's browsers just opted out.
 */
export async function unsubscribeFromPush(
  serviceWorkerPath: string
): Promise<string | null> {
  if (!isPushSupported()) return null;

  const registration = await navigator.serviceWorker.getRegistration(
    serviceWorkerPath
  );
  const subscription = await registration?.pushManager.getSubscription();
  if (!subscription) return null;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  return endpoint;
}
