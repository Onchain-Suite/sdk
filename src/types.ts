/** A notification as delivered over the gateway (mirrors the server's InappPushItem). */
export interface Notification {
  deliveryId: string;
  campaignRunId: string;
  walletAddress: string;
  title: string;
  body: string;
  cta?: { label: string; url: string };
  createdAt: string;
  expiresAt: string;

  /**
   * Which rendering contract this payload was built for. Currently `1`.
   *
   * The presentation fields below are additive-optional, which is what keeps
   * older SDK builds working — and also means this is the only way to tell
   * which fields a payload is promising. **Render an unrecognised version on
   * your best-effort path rather than refusing**: a notification that looks
   * slightly wrong beats one that never appears.
   */
  renderVersion?: number;

  /** Presentation hints. Honoured by the built-in renderer where it can. */
  placement?: "modal" | "banner" | "slide-in" | "inline" | "mobile-push";
  accent?: string;
  dismissible?: boolean;

  /** Behaviour hints, honoured client-side. */
  trigger?: "wallet-connect" | "page-view" | "manual";
  frequency?: "once-per-wallet" | "once-per-session" | "every-time" | "until-dismissed";
  maxPerSession?: number;
}

/** Whether this browser can receive OS notifications, and whether it will. */
export type PushStatus = "unsupported" | "denied" | "prompt" | "granted";

/** A browser push subscription, in the shape the server accepts verbatim. */
export interface PushRegistration {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Mobile platforms that can receive a native OS notification. */
export type DevicePlatform = "ios" | "android";

/** Interaction types reported back to the server for analytics. */
export type EventType = "delivered" | "viewed" | "dismissed" | "clicked";

/** Signs an arbitrary message with the user's wallet, returning the signature. */
export type SignMessageFn = (
  message: string,
  walletAddress: string
) => Promise<string>;

/** Minimal EIP-1193 provider shape (e.g. window.ethereum) used for the default signer. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/**
 * Look-and-feel of the built-in notification UI. Every field is optional — set
 * only what you want to change. Set `display: false` on the client to turn the
 * built-in UI off entirely and render your own via `onNotification`.
 */
export interface DisplayOptions {
  /** Corner to anchor toasts. Default "bottom-right". */
  position?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  /** Accent / CTA button color. */
  accent?: string;
  /** Card background color. */
  background?: string;
  /** Text color. */
  foreground?: string;
  /**
   * How long a notification stays on screen, in ms. `0` = sticky until dismissed.
   * Can be a fixed number, or a function of the notification for per-message
   * control. Default 8000.
   */
  duration?: number | ((n: Notification) => number);
  /** Max toasts visible at once. Default 3. */
  maxVisible?: number;
  /** Base z-index. Default 2147483000. */
  zIndex?: number;
  /** Extra CSS applied to each card (escape hatch for custom design). */
  cardStyle?: Partial<CSSStyleDeclaration>;
}

/** Passed to `onNotification` so custom UIs can drive the analytics lifecycle. */
export interface NotificationActions {
  report(type: EventType): void;
  /** Convenience: report "clicked" and open the CTA url (if any). */
  click(): void;
  /** Convenience: report "dismissed". */
  dismiss(): void;
}

export interface OnchainSuiteOptions {
  /**
   * API host, e.g. "https://api.onchainsuite.com" (no trailing /api/v1).
   * Defaults to same-origin.
   */
  apiBaseUrl?: string;
  /**
   * How to sign the auth challenge. Omit to use the injected wallet
   * (window.ethereum personal_sign). Provide your own to use a specific signer.
   */
  signMessage?: SignMessageFn;
  /** EIP-1193 provider for the default signer + wallet discovery. Defaults to window.ethereum. */
  provider?: Eip1193Provider;
  /**
   * Built-in notification UI. Pass display options to theme it, or `false` to
   * turn it off and render notifications yourself via `onNotification`.
   * Default: enabled with defaults.
   */
  display?: DisplayOptions | false;
  /**
   * Called for every notification. Return `false` to suppress the built-in UI
   * for this one (e.g. you rendered it yourself). Reporting still works via the
   * provided actions.
   */
  onNotification?: (n: Notification, actions: NotificationActions) => boolean | void;
  /** Provide socket.io-client's `io` explicitly (else auto-detected). */
  ioClient?: unknown;
  /** Enable verbose console logging. Default false. */
  debug?: boolean;

  /**
   * Web push — OS notifications that arrive when your page is CLOSED.
   *
   * Requires a service worker file served from your origin (we publish one you
   * can copy). Set `false` to disable entirely.
   *
   * **Nothing here ever prompts on its own.** `start()` re-registers a browser
   * that has *already* granted permission — which is required, because browsers
   * expire subscriptions silently and re-registering is the only way that is
   * ever noticed. Asking for permission the first time is `enablePush()`, which
   * you call from your own UI.
   */
  push?:
    | false
    | {
        /** Path to your service worker. Default "/onchainsuite-sw.js". */
        serviceWorkerPath?: string;
      };
}

/** Client event names for `.on(...)`. */
export type ClientEvent = "notification" | "connected" | "disconnected" | "error";
