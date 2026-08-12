import {
  getPushStatus,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "./push";
import { createToastRenderer, type ToastRenderer } from "./renderer.js";
import type {
  ClientEvent,
  Eip1193Provider,
  EventType,
  Notification,
  OnchainSuiteOptions,
  PushStatus,
  DevicePlatform,
} from "./types.js";

export type {
  Notification,
  EventType,
  DisplayOptions,
  OnchainSuiteOptions,
  PushStatus,
  PushRegistration,
  DevicePlatform,
  NotificationActions,
  SignMessageFn,
} from "./types.js";

/** Minimal socket shape we rely on (a subset of socket.io-client's Socket). */
interface MinimalSocket {
  on(event: string, cb: (...args: unknown[]) => void): void;
  emit(event: string, ...args: unknown[]): void;
  connect(): void;
  disconnect(): void;
  connected: boolean;
}
type IoFactory = (uri: string, opts?: Record<string, unknown>) => MinimalSocket;

const WS_PATH = "/api/v1/inapp/register";

/**
 * OnchainSuite in-app notifications — one class, key in the constructor.
 *
 * ```ts
 * const os = new OnchainSuite("pk_live_...");
 * await os.start();               // wallet signs in, notifications start showing
 * ```
 *
 * Handles the whole path: wallet auth (challenge → sign → verify), a self-
 * reconnecting socket, rendering (built-in toast or your own), and analytics
 * reporting. Zero framework; the only runtime dep is socket.io-client.
 */
export class OnchainSuite {
  private readonly publishableKey: string;
  private readonly opts: OnchainSuiteOptions;
  private readonly base: string;
  private readonly renderer: ToastRenderer | null;
  private readonly listeners = new Map<
    ClientEvent,
    Set<(payload: unknown) => void>
  >();

  private socket: MinimalSocket | null = null;
  private walletAddress: string | null = null;
  /** Kept after auth: push registration uses the same session as the socket. */
  private sessionToken: string | null = null;
  /**
   * deliveryIds already shown this session.
   *
   * A user can meet the same notification twice — once as an OS push they tap,
   * and again as the socket replay that fires when the page opens. Both carry
   * the same deliveryId precisely so this is possible to prevent.
   */
  private readonly seen = new Set<string>();

  constructor(publishableKey: string, options: OnchainSuiteOptions = {}) {
    if (!publishableKey || !publishableKey.startsWith("pk_")) {
      throw new Error("A publishable key (pk_live_… / pk_test_…) is required");
    }
    this.publishableKey = publishableKey;
    this.opts = options;
    this.base = (options.apiBaseUrl ?? "").replace(/\/$/, "");
    this.renderer =
      options.display === false
        ? null
        : createToastRenderer(options.display ?? undefined);
  }

  /**
   * Authenticate a wallet and start receiving notifications. If `walletAddress`
   * is omitted, the injected wallet (window.ethereum) is prompted to connect and
   * sign. Resolves once connected.
   */
  async start(walletAddress?: string): Promise<void> {
    const wallet = (walletAddress ?? (await this.discoverWallet()))?.trim();
    if (!wallet) throw new Error("No wallet address available");
    this.walletAddress = wallet;
    const { token, wsUrl } = await this.authenticate(wallet);
    this.sessionToken = token;
    await this.openSocket(wsUrl, token, wallet);

    // Re-register a browser that ALREADY granted permission. This never
    // prompts — and it is not optional: browsers expire push subscriptions
    // without telling anyone, so re-registering on every start is the only way
    // a silently-rotated subscription is ever noticed. Failure is non-fatal;
    // the socket is already up and in-app delivery works regardless.
    void this.syncPushSubscription({ prompt: false }).catch((err: unknown) =>
      this.log("push re-registration failed", err)
    );
  }

  /** Stop receiving notifications and clear any built-in toasts. */
  stop(): void {
    try {
      this.socket?.disconnect();
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.sessionToken = null;
    this.seen.clear();
    this.renderer?.destroy();
  }

  /** Subscribe: "notification" | "connected" | "disconnected" | "error". Returns an unsubscribe fn. */
  on(event: ClientEvent, cb: (payload: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(cb);
    this.listeners.set(event, set);
    return () => set.delete(cb);
  }

  /** Report an interaction (also called automatically by the built-in UI). */
  report(n: Notification, type: EventType): void {
    if (!this.socket) return;
    try {
      this.socket.emit("EVENT", {
        campaignRunId: n.campaignRunId,
        deliveryId: n.deliveryId,
        type,
        walletAddress: this.walletAddress ?? undefined,
      });
    } catch (err) {
      this.log("report failed", err);
    }
  }

  /**
   * Ask this browser for notification permission and subscribe it.
   *
   * **Call this from your own UI, in response to something the user did.** A
   * user who taps "Block" is never asked again — the browser remembers and
   * there is no API to re-prompt — so a prompt at a moment they have no context
   * for does not cost you a retry, it costs you that user permanently. The
   * moment that works is just after they did something a notification would
   * obviously help with.
   *
   * Safe to call repeatedly: an already-granted browser re-registers without
   * prompting.
   *
   * @returns the resulting status. `"granted"` means notifications will now
   *   arrive with the page closed.
   */
  async enablePush(): Promise<PushStatus> {
    if (!this.sessionToken) {
      throw new Error("Call start() before enablePush()");
    }
    const registered = await this.syncPushSubscription({ prompt: true });
    return registered ? "granted" : getPushStatus();
  }

  /**
   * Whether this browser can receive OS notifications, and whether it will.
   *
   * `"unsupported"` and `"denied"` are both terminal — do not offer a "turn on
   * notifications" button for either, because pressing it can no longer do
   * anything.
   */
  pushStatus(): PushStatus {
    return getPushStatus();
  }

  /** Turn OS notifications off for this browser, and tell the server. */
  async disablePush(): Promise<void> {
    const path = this.serviceWorkerPath();
    const endpoint = await unsubscribeFromPush(path);
    if (!endpoint || !this.sessionToken) return;

    // Told to the server explicitly: it cannot otherwise know WHICH of a
    // wallet's browsers just opted out.
    await this.authedPost("/api/v1/inapp/push", { endpoint }, "DELETE").catch(
      (err: unknown) => this.log("push unregister failed", err)
    );
  }

  /**
   * Register a mobile device token so this wallet can receive native OS
   * notifications.
   *
   * WHY THE SDK DOES NOT FETCH THE TOKEN ITSELF
   *
   * Getting an APNs or FCM token requires native code, and every React Native
   * app already has an opinion about how — `expo-notifications`,
   * `@react-native-firebase/messaging`, or a hand-rolled bridge. Bundling one of
   * them would pin your React Native version, force a linking step, and break
   * web builds of this package for the majority of users who never wanted
   * mobile at all.
   *
   * So you fetch the token however your app already does, and hand it here.
   *
   * ```ts
   * import messaging from "@react-native-firebase/messaging";
   *
   * await messaging().requestPermission();      // YOUR app chooses the moment
   * const token = await messaging().getToken();
   * await client.registerDevice(token, "android");
   *
   * // Tokens rotate. Re-register whenever that happens:
   * messaging().onTokenRefresh((t) => client.registerDevice(t, "android"));
   * ```
   *
   * **Call this on every app launch, not only after the permission prompt.**
   * Tokens rotate on reinstall and sometimes on OS upgrade, and nothing
   * announces it — re-registering is the only way a rotated token is noticed.
   * Repeat calls upsert; they do not accumulate devices.
   *
   * @param appId your bundle identifier / package name. Optional, but it is
   *   what lets support tell two of your apps apart.
   */
  async registerDevice(
    token: string,
    platform: DevicePlatform,
    appId?: string
  ): Promise<void> {
    if (!this.sessionToken) {
      throw new Error("Call start() before registerDevice()");
    }
    const trimmed = String(token ?? "").trim();
    if (!trimmed) throw new Error("A device token is required");

    await this.authedPost("/api/v1/inapp/push/device", {
      token: trimmed,
      platform,
      appId,
    });
    this.log("device registered", platform);
  }

  /**
   * Stop sending native notifications to one device.
   *
   * Takes the token because the server cannot otherwise know WHICH of a
   * wallet's devices just opted out — a person may have a phone, a tablet and a
   * browser all registered.
   */
  async unregisterDevice(token: string): Promise<void> {
    if (!this.sessionToken) return;
    const trimmed = String(token ?? "").trim();
    if (!trimmed) return;

    await this.authedPost("/api/v1/inapp/push", { token: trimmed }, "DELETE");
    this.log("device unregistered");
  }

  // --- internals -----------------------------------------------------------

  private serviceWorkerPath(): string {
    const configured = this.opts.push === false ? null : this.opts.push;
    return configured?.serviceWorkerPath ?? "/onchainsuite-sw.js";
  }

  /**
   * Fetch the platform VAPID key, subscribe, and register with the server.
   *
   * Checks the server has push configured BEFORE prompting. Asking for
   * permission we cannot then use is the worst available outcome — it burns the
   * one prompt the browser will ever give us.
   */
  private async syncPushSubscription(opts: {
    prompt: boolean;
  }): Promise<boolean> {
    if (this.opts.push === false || !this.sessionToken) return false;
    if (!isPushSupported()) return false;

    const config = await this.post<{ enabled: boolean; publicKey: string | null }>(
      "/api/v1/inapp/push/vapid-key",
      undefined,
      "GET"
    );
    if (!config?.enabled || !config.publicKey) {
      this.log("web push is not configured on the server");
      return false;
    }

    const registration = await subscribeToPush({
      vapidPublicKey: config.publicKey,
      serviceWorkerPath: this.serviceWorkerPath(),
      prompt: opts.prompt,
    });
    if (!registration) return false;

    await this.authedPost("/api/v1/inapp/push/web", registration);
    this.log("web push registered");
    return true;
  }

  /** POST/DELETE carrying the in-app session token the socket also uses. */
  private async authedPost<T>(
    path: string,
    body: unknown,
    method: "POST" | "DELETE" = "POST"
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.sessionToken ?? ""}`,
      },
      // DELETE carries a body here — it names WHICH subscription to remove.
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${method} ${path} failed: ${res.status}`);
    }
    return (await res.json()) as T;
  }


  private async authenticate(
    wallet: string
  ): Promise<{ token: string; wsUrl: string }> {
    const challenge = await this.post<{ message: string }>(
      "/api/v1/inapp/challenge",
      { walletAddress: wallet }
    );
    const signature = await this.sign(challenge.message, wallet);
    return this.post<{ token: string; wsUrl: string }>("/api/v1/inapp/verify", {
      walletAddress: wallet,
      signature,
    });
  }

  private async openSocket(
    wsUrl: string,
    token: string,
    wallet: string
  ): Promise<void> {
    const io = await this.resolveIo();
    let origin =
      this.base || (typeof location !== "undefined" ? location.origin : "");
    let path = WS_PATH;
    try {
      const u = new URL(wsUrl, origin || undefined);
      origin = u.origin;
      path = u.pathname;
    } catch {
      /* fall back to base + WS_PATH */
    }

    const socket = io(origin, {
      path,
      auth: { token },
      transports: ["websocket"],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.5,
      withCredentials: true,
    });
    this.socket = socket;

    socket.on("connect", () => {
      socket.emit("REGISTER", { walletAddress: wallet });
      this.emit("connected", { walletAddress: wallet });
      this.log("connected");
    });
    socket.on("disconnect", (reason: unknown) => {
      this.emit("disconnected", { reason });
      this.log("disconnected", reason);
    });
    socket.on("connect_error", (err: unknown) => {
      this.emit("error", err);
      this.log("connect_error", err);
    });
    socket.on("PUSH", (item: unknown) =>
      this.handleNotification(item as Notification)
    );

    if (!socket.connected) {
      await new Promise<void>((resolve) => {
        socket.on("connect", () => resolve());
        setTimeout(resolve, 8000);
      });
    }
  }

  private handleNotification(n: Notification): void {
    if (!n || !n.deliveryId) return;

    // Already shown — almost always an OS push the user tapped, followed by the
    // socket replay on page open. Reporting `delivered` twice would also
    // double-count the analytics.
    if (this.seen.has(n.deliveryId)) return;
    this.seen.add(n.deliveryId);

    this.report(n, "delivered");
    this.emit("notification", n);

    const actions = {
      report: (type: EventType) => this.report(n, type),
      click: () => {
        this.report(n, "clicked");
        if (n.cta?.url && typeof window !== "undefined") {
          window.open(n.cta.url, "_blank", "noopener,noreferrer");
        }
      },
      dismiss: () => this.report(n, "dismissed"),
    };

    const suppress = this.opts.onNotification?.(n, actions) === false;
    if (suppress || !this.renderer) return;

    this.renderer.show(n, {
      onView: () => this.report(n, "viewed"),
      onClick: () => this.report(n, "clicked"),
      onDismiss: () => this.report(n, "dismissed"),
    });
  }

  private async sign(message: string, wallet: string): Promise<string> {
    if (this.opts.signMessage) return this.opts.signMessage(message, wallet);
    const provider = this.getProvider();
    if (!provider)
      throw new Error(
        "No signer available — pass `signMessage` or an EIP-1193 `provider`."
      );
    const sig = await provider.request({
      method: "personal_sign",
      params: [message, wallet],
    });
    return String(sig);
  }

  private async discoverWallet(): Promise<string | undefined> {
    const provider = this.getProvider();
    if (!provider) return undefined;
    const accounts = (await provider.request({
      method: "eth_requestAccounts",
    })) as string[] | undefined;
    return Array.isArray(accounts) ? accounts[0] : undefined;
  }

  private getProvider(): Eip1193Provider | undefined {
    if (this.opts.provider) return this.opts.provider;
    const w = globalThis as unknown as { ethereum?: Eip1193Provider };
    return w.ethereum;
  }

  private async resolveIo(): Promise<IoFactory> {
    if (this.opts.ioClient) return this.opts.ioClient as IoFactory;
    const g = globalThis as unknown as { io?: IoFactory };
    if (typeof g.io === "function") return g.io;
    try {
      // socket.io-client is a bundled dependency — a literal dynamic import
      // lets bundlers resolve/code-split it while keeping startup lazy.
      const mod = (await import("socket.io-client")) as { io?: IoFactory };
      if (mod.io) return mod.io;
    } catch {
      /* CDN/script-tag environments land in the error below */
    }
    throw new Error(
      "socket.io-client could not be loaded. In script-tag setups load socket.io-client first, or pass `ioClient`."
    );
  }

  private async post<T>(
    path: string,
    body: unknown,
    method: "POST" | "GET" = "POST",
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "x-publishable-key": this.publishableKey,
      },
      // A GET with a body is rejected by fetch.
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      data?: T;
      error?: { message?: string };
      message?: string;
    };
    if (!res.ok) {
      throw new Error(
        data?.error?.message ?? data?.message ?? `Request failed (${res.status})`
      );
    }
    return data && typeof data === "object" && "data" in data
      ? (data.data as T)
      : (data as unknown as T);
  }

  private emit(event: ClientEvent, payload: unknown): void {
    this.listeners.get(event)?.forEach((cb) => {
      try {
        cb(payload);
      } catch {
        /* listener errors shouldn't break the client */
      }
    });
  }

  private log(...args: unknown[]): void {
    if (this.opts.debug) console.log("[onchainsuite]", ...args);
  }
}

/** Factory alias for `new OnchainSuite(key, options)`. */
export function createClient(
  publishableKey: string,
  options?: OnchainSuiteOptions
): OnchainSuite {
  return new OnchainSuite(publishableKey, options);
}
