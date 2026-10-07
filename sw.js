// DavDags CRM service worker: opens instantly (cached app shell) and shows phone notifications.
const CACHE = "davdags-crm-v6";
const SHELL = ["./", "index.html", "styles.css?v=5", "calls.js?v=5", "app.js?v=6", "manifest.webmanifest", "icons/icon-192.png", "icons/favicon-64.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// App files: network first (so updates arrive), cache as fallback. API calls always go to the network.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(event.request, copy));
        return res;
      })
      .catch(() => caches.match(event.request).then((hit) => hit || caches.match("index.html"))),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "DavDags CRM", body: event.data?.text() }; }
  event.waitUntil(self.registration.showNotification(data.title || "DavDags CRM", {
    body: data.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: data.tag || undefined,
    renotify: true,
    data: { chat: data.chat || null },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const chat = event.notification.data?.chat;
  const target = new URL(chat ? `./?chat=${chat}` : "./", self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (w.url.startsWith(self.registration.scope)) {
        w.postMessage({ openChat: chat });
        return w.focus();
      }
    }
    return self.clients.openWindow(target);
  })());
});
