// Bobcat Bites service worker — v3
// Network-first for pages (so updates ship instantly), cache fallback for offline shell.
const CACHE = "bobcat-bites-v3";
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

// --- Web Push: new-order alerts for vendors ---
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(d.title || "Bobcat Bites", {
    body: d.body || "You have a new order.",
    tag: d.tag || "new-order",
    icon: "icon-vendor-192.png",
    badge: "icon-vendor-192.png",
    data: { url: d.url || "./vendor_app.html" },
    requireInteraction: true,
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.includes("vendor_app") && "focus" in c) return c.focus();
    return clients.openWindow(e.notification.data?.url || "./vendor_app.html");
  }));
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
