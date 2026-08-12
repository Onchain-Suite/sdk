import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getPushStatus,
  isPushSupported,
  subscribeToPush,
  unsubscribeFromPush,
} from "./push";

const SUBSCRIPTION = {
  endpoint: "https://push.example/abc",
  keys: { p256dh: "p256dh-value", auth: "auth-value" },
};

/** Install a browser-shaped push environment on the jsdom globals. */
function stubBrowser(opts: {
  permission?: NotificationPermission;
  existing?: unknown;
  requestPermission?: NotificationPermission;
  supported?: boolean;
}) {
  const subscribe = vi.fn(async () => ({
    endpoint: SUBSCRIPTION.endpoint,
    toJSON: () => SUBSCRIPTION,
  }));
  const getSubscription = vi.fn(async () => opts.existing ?? null);
  const unsubscribe = vi.fn(async () => true);
  const requestPermission = vi.fn(
    async () => opts.requestPermission ?? "granted"
  );

  const registration = {
    pushManager: { subscribe, getSubscription },
  };

  const g = globalThis as Record<string, unknown>;

  if (opts.supported === false) {
    delete (navigator as unknown as Record<string, unknown>).serviceWorker;
    delete g.PushManager;
    delete g.Notification;
    return { subscribe, getSubscription, requestPermission, unsubscribe };
  }

  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register: vi.fn(async () => registration),
      getRegistration: vi.fn(async () => ({
        pushManager: {
          getSubscription: vi.fn(async () => ({
            endpoint: SUBSCRIPTION.endpoint,
            unsubscribe,
          })),
        },
      })),
      ready: Promise.resolve(registration),
    },
  });

  g.PushManager = class {};
  g.Notification = Object.assign(class {}, {
    permission: opts.permission ?? "default",
    requestPermission,
  });

  return { subscribe, getSubscription, requestPermission, unsubscribe };
}

describe("push support detection", () => {
  it("reports unsupported when the browser lacks the APIs", () => {
    stubBrowser({ supported: false });
    expect(isPushSupported()).toBe(false);
    expect(getPushStatus()).toBe("unsupported");
  });

  it.each([
    ["granted", "granted"],
    ["denied", "denied"],
    ["default", "prompt"],
  ] as const)("maps permission %s to status %s", (permission, expected) => {
    stubBrowser({ permission });
    expect(getPushStatus()).toBe(expected);
  });
});

describe("subscribeToPush", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the subscription in the shape the server accepts", async () => {
    stubBrowser({ permission: "granted" });

    const result = await subscribeToPush({
      vapidPublicKey: "BLxxx-key_value",
      serviceWorkerPath: "/onchainsuite-sw.js",
      prompt: false,
    });

    expect(result).toEqual(SUBSCRIPTION);
  });

  it("reuses an existing subscription rather than creating a second", async () => {
    // This is what makes calling it on every page load cheap — and what stops a
    // browser accumulating subscriptions the server would treat as separate
    // devices.
    const { subscribe } = stubBrowser({
      permission: "granted",
      existing: { endpoint: SUBSCRIPTION.endpoint, toJSON: () => SUBSCRIPTION },
    });

    await subscribeToPush({
      vapidPublicKey: "key",
      serviceWorkerPath: "/sw.js",
      prompt: false,
    });

    expect(subscribe).not.toHaveBeenCalled();
  });

  describe("the permission rule", () => {
    it("does NOT prompt when prompt is false", async () => {
      // start() re-registers already-granted browsers. If that prompted, every
      // returning visitor would see a permission dialog they never asked for.
      const { requestPermission } = stubBrowser({ permission: "default" });

      const result = await subscribeToPush({
        vapidPublicKey: "key",
        serviceWorkerPath: "/sw.js",
        prompt: false,
      });

      expect(result).toBeNull();
      expect(requestPermission).not.toHaveBeenCalled();
    });

    it("prompts when asked and the user has not decided", async () => {
      const { requestPermission } = stubBrowser({ permission: "default" });

      await subscribeToPush({
        vapidPublicKey: "key",
        serviceWorkerPath: "/sw.js",
        prompt: true,
      });

      expect(requestPermission).toHaveBeenCalled();
    });

    it("never prompts a user who already declined", async () => {
      // The browser would refuse anyway, and there is no API to re-ask — but
      // calling it makes the intent explicit and keeps the "denied is terminal"
      // rule in one place.
      const { requestPermission } = stubBrowser({ permission: "denied" });

      const result = await subscribeToPush({
        vapidPublicKey: "key",
        serviceWorkerPath: "/sw.js",
        prompt: true,
      });

      expect(result).toBeNull();
      expect(requestPermission).not.toHaveBeenCalled();
    });

    it("returns null when the user declines the prompt", async () => {
      stubBrowser({ permission: "default", requestPermission: "denied" });

      expect(
        await subscribeToPush({
          vapidPublicKey: "key",
          serviceWorkerPath: "/sw.js",
          prompt: true,
        })
      ).toBeNull();
    });
  });

  it("subscribes with userVisibleOnly", async () => {
    // Every browser requires it: a push that displays nothing is not permitted,
    // and omitting it makes subscribe() throw rather than warn.
    const { subscribe } = stubBrowser({ permission: "granted" });

    await subscribeToPush({
      vapidPublicKey: "key",
      serviceWorkerPath: "/sw.js",
      prompt: false,
    });

    expect(subscribe.mock.calls[0][0]).toMatchObject({ userVisibleOnly: true });
  });

  it("returns null on an unsupported browser instead of throwing", async () => {
    stubBrowser({ supported: false });

    expect(
      await subscribeToPush({
        vapidPublicKey: "key",
        serviceWorkerPath: "/sw.js",
        prompt: true,
      })
    ).toBeNull();
  });
});

describe("unsubscribeFromPush", () => {
  it("returns the endpoint that was removed", async () => {
    // The server cannot otherwise know WHICH of a wallet's browsers opted out.
    stubBrowser({ permission: "granted" });
    expect(await unsubscribeFromPush("/sw.js")).toBe(SUBSCRIPTION.endpoint);
  });

  it("is harmless on an unsupported browser", async () => {
    stubBrowser({ supported: false });
    expect(await unsubscribeFromPush("/sw.js")).toBeNull();
  });
});
