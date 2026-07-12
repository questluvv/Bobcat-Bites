// Bobcat Bites service worker — v1
// Network-first for pages (so updates ship instantly), cache fallback for offline shell.
const CACHE = "bobcat-bites-v2";
const SHELL = [
  "./index.html",
  "./vendor_app.html",
  "./manifest-student.webmanifest",
  "./manifest-vendor.webmanifest",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-vendor-192.png",
  "./icon-vendor-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.includes("index.html"));
      if (existing) return existing.focus();
      return self.clients.openWindow("./index.html");
    })
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never intercept API/data calls — always live
  if (url.hostname.endsWith("supabase.co")) return;
  if (e.request.method !== "GET") return;

  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
