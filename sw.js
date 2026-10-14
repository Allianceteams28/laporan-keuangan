// Service worker: aplikasi tetap bisa dibuka saat offline.
// Strategi: coba internet dulu (supaya selalu versi terbaru), kalau gagal atau lambat pakai salinan tersimpan.
const CACHE = "keuangan-v2";
const SHELL = ["./", "index.html", "app.js", "firebase-config.js", "manifest.webmanifest", "icon.svg"];
const SDK = ["app", "auth", "firestore"].map(n => `https://www.gstatic.com/firebasejs/10.12.2/firebase-${n}.js`);

self.addEventListener("install", e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(SHELL.map(u => c.add(u).catch(() => {})));
    await Promise.all(SDK.map(u => c.add(new Request(u, { mode: "cors" })).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Hanya berkas aplikasi dan pustaka Firebase. Lalu lintas data (Firestore/Auth) tidak disentuh.
  if (url.origin !== self.location.origin && url.hostname !== "www.gstatic.com") return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000))
    ]);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    if (req.mode === "navigate") {
      const shell = (await cache.match("index.html")) || (await cache.match("./"));
      if (shell) return shell;
    }
    throw err;
  }
}
