/*
 * Modaafa service worker.
 *
 * It exists for one reason: Chrome and Edge only raise their one-tap install
 * prompt (the beforeinstallprompt event) for a site that registers a service
 * worker with a fetch handler. Everything else about installing works without
 * one.
 *
 * It deliberately caches nothing and answers nothing. The platform shows a
 * signed-in customer's ad accounts, spend and recommendations; a worker that
 * kept pages would put a stale copy of that on the device. With an empty
 * fetch handler every request goes to the network exactly as if no worker
 * were there.
 */
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function () {
  // Intentionally empty: the browser handles the request itself.
});
