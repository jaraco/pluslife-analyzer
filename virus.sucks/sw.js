// SPDX-License-Identifier: MPL-2.0
// SPDX-FileCopyrightText: Lucentia gGmbH and contributors.

/*
  Service worker for PWA caching (for now, only caches the Pluslife app,
  but scoped to the top level - this is also why it has to live in /).

  Script does NOT get processed by esbuild.
*/

const CACHE_VERSION = "v1";
const CACHE_NAME = `vs-pwa-cache-${CACHE_VERSION}`;

const urlsToCache = [
  "/pluslife_app/",
  "/pluslife/power.webp",
  "/_js/main.js",
  "/_js/pluslife_app.js",
  "/assets/icons/bluetooth.svg",
  "/assets/icons/usb-c.svg",
  "/assets/icons/exclamation-triangle.svg",
  "/assets/icons/thermometer-half.svg",
  "/assets/icons/info-circle.svg",
  "/assets/icons/question-circle-fill.svg",
  "/favicon.ico",
];

self.addEventListener("install", (event) => {
  console.log("Service worker installing...");
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log("Opened cache");
      return cache.addAll(urlsToCache);
    }),
  );
  self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isPrecached = urlsToCache.includes(url.pathname);

  if (isPrecached) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        const cachedResponse = await cache.match(event.request);
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          if (networkResponse.ok) {
            cache.put(event.request, networkResponse.clone());
          }
          return networkResponse;
        });

        return cachedResponse || fetchPromise;
      }),
    );
  }
});

self.addEventListener("activate", (event) => {
  console.log("Service worker activating...");
  const cacheWhitelist = [CACHE_NAME];
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheWhitelist.indexOf(cacheName) === -1) {
              return caches.delete(cacheName);
            }
          }),
        );
      })
      .then(() => self.clients.claim()),
  );
});
