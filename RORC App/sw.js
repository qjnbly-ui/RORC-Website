const CACHE_VERSION = "rorc-app-v68";
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const NAVIGATION_CACHE = `${CACHE_VERSION}-navigation`;
const OFFLINE_PAGE = "./index.html";
const APP_SHELL = [
  OFFLINE_PAGE,
  "./app.css?v=20260808-mobile-actions-safe-area",
  "./resource-coordinator.js?v=20260808-reliable-sync",
  "./app.js?v=20260808-reliable-sync",
  "./vendor/supabase.min.js?v=2.112.2",
  "./manifest.webmanifest",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "/scripts/rorc-password-reveal.js?v=20260808",
  "/scripts/rorc-supabase-client.js?v=20260808-realtime-stability",
  "/Images/LOGOS/LOGO.png"
];

function isCacheableResponse(response) {
  return Boolean(response?.ok && (response.type === "basic" || response.type === "default"));
}

function isVersionedStaticRequest(request, url) {
  if (!url.searchParams.has("v")) return false;
  return ["font", "script", "style", "worker"].includes(request.destination);
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheableResponse(response)) {
    await cache.put(request, response.clone());
  }
  return response;
}

async function staleWhileRevalidateNavigation(request, event) {
  const navigationCache = await caches.open(NAVIGATION_CACHE);
  const cached = await navigationCache.match(OFFLINE_PAGE) || await caches.match(OFFLINE_PAGE);
  const refresh = fetch(request).then(async (response) => {
    if (isCacheableResponse(response)) {
      await navigationCache.put(OFFLINE_PAGE, response.clone());
    }
    return response;
  });

  if (cached) {
    event.waitUntil(refresh.catch(() => undefined));
    return cached;
  }

  return refresh;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const activeCaches = new Set([STATIC_CACHE, NAVIGATION_CACHE]);
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key.startsWith("rorc-app-") && !activeCaches.has(key))
          .map((key) => caches.delete(key))
      );

      // The page handles controllerchange and performs one guarded reload.
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || request.headers.has("authorization")) return;

  if (request.mode === "navigate") {
    event.respondWith(staleWhileRevalidateNavigation(request, event));
    return;
  }

  if (isVersionedStaticRequest(request, url)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // Unversioned assets are always checked on the network. Precached copies are
  // used only as an offline fallback, so mutable resources never become stale.
  event.respondWith(fetch(request).catch(() => caches.match(request)));
});
