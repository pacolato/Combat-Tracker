// Bump this version whenever you add or rename files in FILES below.
const CACHE = "combat-tracker-v1";

// Paths are relative so this works from a GitHub Pages subfolder.
const FILES = [
    "./",
    "./index.html",
    "./style.css",
    "./app.js",
    "./manifest.json",
    "./icons/icon-192.png",
    "./icons/icon-512.png",
];

// Install: save the app's files so it can start with no connection.
self.addEventListener("install", (event) => {
    event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));
    self.skipWaiting();
});

// Activate: delete caches left over from older versions.
self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

// Fetch: answer from the cache straight away, and refresh the cached copy in the
// background. Edits you push show up the next time the app is opened after that.
self.addEventListener("fetch", (event) => {
    if (event.request.method !== "GET") return;

    event.respondWith(
        caches.open(CACHE).then(async (cache) => {
            const cached = await cache.match(event.request, { ignoreSearch: true });
            const refresh = fetch(event.request)
                .then((response) => {
                    if (response.ok && new URL(event.request.url).origin === location.origin) {
                        cache.put(event.request, response.clone());
                    }
                    return response;
                })
                .catch(() => cached);
            return cached || refresh;
        })
    );
});