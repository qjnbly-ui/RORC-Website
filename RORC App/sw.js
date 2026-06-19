const CACHE_VERSION = "rorc-app-v35";
const APP_SHELL = [
  "./",
  "./index.html",
  "./app.css",
  "./app.js?v=20260619-monthly-billing",
  "./app.config.js",
  "./manifest.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "/scripts/rorc-password-reveal.js",
  "/scripts/rorc-supabase-client.js",
  "/Images/LOGOS/LOGO.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      const staleAppCaches = keys.filter((key) => key.startsWith("rorc-app-") && key !== CACHE_VERSION);
      await Promise.all(staleAppCaches.map((key) => caches.delete(key)));
      await self.clients.claim();

      if (staleAppCaches.length > 0) {
        const appClients = await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true
        });
        await Promise.all(appClients
          .filter((client) => client.url.startsWith(self.registration.scope))
          .map((client) => {
            client.postMessage({ type: "RORC_APP_UPDATED", cacheVersion: CACHE_VERSION });
            return "navigate" in client ? client.navigate(client.url) : undefined;
          }));
      }
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put("./index.html", copy));
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }

        return response;
      })
      .catch(() => caches.match(request))
  );
});
