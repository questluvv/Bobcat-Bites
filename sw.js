// Bobcat Bites service worker — v4
// Network-first for pages (so updates ship instantly), cache fallback for offline shell.
const CACHE = "bobcat-bites-v4";
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

// --- Web Push: order alerts. Two audiences arrive on this same handler:
//     "vendor"  → new order came in        (routes to vendor_app.html)
//     "student" → their order changed status (routes to index.html)
//     The server sets `audience`; fall back to vendor for older payloads.
self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  const isStudent = d.audience === "student";
  const icon = isStudent ? "icon-192.png" : "icon-vendor-192.png";
  e.waitUntil(self.registration.showNotification(d.title || "Bobcat Bites", {
    body: d.body || (isStudent ? "Your order was updated." : "You have a new order."),
    tag: d.tag || (isStudent ? "bb-order-update" : "new-order"),
    renotify: true,
    icon,
    badge: icon,
    data: { url: d.url || (isStudent ? "./index.html" : "./vendor_app.html") },
    // Vendors must not miss an order; students shouldn't have a sticky banner.
    requireInteraction: !isStudent,
  }));
});

// Shared by both apps: student order-update notifications (fired locally from
// index.html) and vendor new-order push notifications (fired server-side above).
// Route to whichever page the notification's own data says, defaulting to the
// student app since that's the more common case.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = e.notification.data?.url || "./index.html";
  const targetFile = target.replace("./", "");
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => c.url.includes(targetFile));
      if (existing) return existing.focus();
      return self.clients.openWindow(target);
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
