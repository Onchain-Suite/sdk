/**
 * OnchainSuite service worker.
 *
 * Copy this file to the ROOT of your web server so it is served at
 * `/onchainsuite-sw.js`. The path matters: a service worker can only control
 * pages at or below its own URL, so one served from `/static/sw.js` covers
 * `/static` and nothing else. Root is almost always what you want.
 *
 * If you already have a service worker, do not add a second one — import this
 * into yours instead:
 *
 *     importScripts("/onchainsuite-sw.js");
 *
 * Two workers registered at the same scope fight over the same push events and
 * only one wins, unpredictably.
 */

/**
 * A push arrived.
 *
 * `event.waitUntil` is not optional. The browser may terminate a service worker
 * the moment its handler returns, and without waitUntil that can happen before
 * the notification is shown — the push is consumed and nothing appears. It is
 * the single most common reason "push works locally but not in production".
 */
self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    // A push that is not our JSON is not ours to render. Showing a fallback
    // would be worse than silence: browsers require every push to display
    // something, so a generic "You have a notification" is what users learn to
    // ignore.
    payload = {};
  }

  const title = payload.title || "";
  if (!title) return;

  event.waitUntil(
    self.registration.showNotification(title, {
      body: payload.body || "",
      // Grouped by deliveryId so the same notification arriving twice replaces
      // rather than stacks.
      tag: payload.deliveryId || undefined,
      data: {
        deliveryId: payload.deliveryId,
        url: payload.url,
      },
      icon: payload.icon || undefined,
    })
  );
});

/**
 * The user tapped the notification.
 *
 * Focus an existing tab rather than opening a new one where possible — someone
 * who already has the app open does not want a second copy of it, and the
 * in-app render will dedupe on the same deliveryId once they land.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = event.notification.data && event.notification.data.url;

  event.waitUntil(
    (async () => {
      const clientList = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      for (const client of clientList) {
        // Same origin and already open: bring it forward.
        if ("focus" in client) {
          await client.focus();
          if (target && "navigate" in client) {
            try {
              await client.navigate(target);
            } catch {
              // Cross-origin target, or navigation refused. Focusing the tab is
              // still the better outcome than opening a duplicate.
            }
          }
          return;
        }
      }

      if (target && self.clients.openWindow) {
        await self.clients.openWindow(target);
      }
    })()
  );
});

/**
 * Take control of open pages as soon as this worker activates.
 *
 * Without it a freshly-installed worker sits idle until every tab is closed and
 * reopened, so the first visit after adding push receives nothing — which reads
 * as "it doesn't work" rather than "it starts next time".
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim())
);
