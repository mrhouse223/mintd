// mintd.fun service worker.
//
// Deliberately conservative for a financial app: the HTML is always fetched
// fresh when the network allows (network-first), so a stale build can never
// show wrong contract addresses. Static assets are cache-first for speed.
// Chain RPC and API calls are never cached.
// BUMP THIS WHENEVER A PRECACHED ASSET'S BYTES CHANGE. activate() deletes only
// caches whose key does NOT end with VERSION, so leaving it alone means the old
// cache is kept and nothing is ever re-fetched. The arcswap rebrand shipped a
// new logo and icon set and every visitor kept seeing mintd's green mark,
// because this string still said v1.
const VERSION = "mintd-v22";
const SHELL = "shell-" + VERSION;
const ASSETS = "assets-" + VERSION;

// only same-origin static files, and only ones that are safe to serve stale
const STATIC = /\.(png|jpg|jpeg|svg|webp|ico|woff2?)$/i;

// Split by which cache serves them. Images used to be precached into SHELL while
// the static handler refreshed into ASSETS, and caches.match() with no cacheName
// searches every cache in creation order, so SHELL's copy won every lookup and
// the background refresh could never take effect. Precaching an asset into the
// same cache that serves it is what makes the refresh able to replace it.
const PRECACHE_SHELL = ["/", "/index.html"];
const PRECACHE_ASSETS = [
  "/logo.png",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const [shell, assets] = await Promise.all([caches.open(SHELL), caches.open(ASSETS)]);
    // never fail the install because one optional asset 404s
    await Promise.allSettled([
      ...PRECACHE_SHELL.map((u) => shell.add(u)),
      ...PRECACHE_ASSETS.map((u) => assets.add(u)),
    ]);
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
      // Read and write the SAME cache. caches.match(req) with no cacheName
      // searches all of them and returns the first hit, which meant a copy in
      // any other cache permanently shadowed the one being refreshed here.
      const c = await caches.open(ASSETS);
      const cached = await c.match(req);
      const network = fetch(req).then((res) => {
        if (res && res.ok) c.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) || Response.error();
    })());
  }
});
