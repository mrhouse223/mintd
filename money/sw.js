// mintd.fun service worker.
//
// Deliberately conservative for a financial app: the HTML is always fetched
// fresh when the network allows (network-first), so a stale build can never
// show wrong contract addresses. Static assets are cache-first for speed.
// Chain RPC and API calls are never cached.
const VERSION = "mintd-v1";
const SHELL = "shell-" + VERSION;
const ASSETS = "assets-" + VERSION;

// only same-origin static files, and only ones that are safe to serve stale
const STATIC = /\.(png|jpg|jpeg|svg|webp|ico|woff2?)$/i;

const PRECACHE = [
  "/",
  "/index.html",
  "/logo.png",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // never fail the install because one optional asset 404s
    await Promise.allSettled(PRECACHE.map((u) => c.add(u)));
    self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => !k.endsWith(VERSION)).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (e) => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  // never touch chain or market data: always live, never cached
  if (!sameOrigin) return;

  // navigations and the HTML document: network first, cache only as a fallback
  if (req.mode === "navigate" || (req.headers.get("accept") || "").includes("text/html")) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const c = await caches.open(SHELL);
        c.put("/index.html", fresh.clone());
        return fresh;
      } catch {
        const cached = await caches.match("/index.html");
        return cached || Response.error();
      }
    })());
    return;
  }

  // static assets: serve from cache, refresh in the background
  if (STATIC.test(url.pathname)) {
    e.respondWith((async () => {
      const cached = await caches.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) caches.open(ASSETS).then((c) => c.put(req, res.clone()));
        return res;
      }).catch(() => null);
      return cached || (await network) || Response.error();
    })());
  }
});
