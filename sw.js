// Service worker minimal supaya aplikasi bisa dipasang ke layar utama.
// Tidak menyimpan cache, jadi data selalu segar.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => e.respondWith(fetch(e.request)));
