/**
 * Service worker — offline support.
 *
 * Strategy: cache-first for the app shell; the network is the fallback and the
 * source for anything not already cached.
 *
 * Cache-first is what makes this app usable, because it is opened in the one
 * place a network is least likely to be: standing next to the display, phone in
 * hand, on someone else's Wi-Fi or on none at all. Nothing here needs the network
 * at runtime — the CSP forbids outbound requests and the display is reached over
 * Bluetooth — so a cached shell is not a degraded app, it is the whole app.
 *
 * ---------------------------------------------------------------------------
 * BUMPING CACHE_VERSION  —  read this before you ship a change
 *
 * Cache-first means a client that already holds the old files KEEPS SERVING
 * THEM. Editing index.html or a module is not enough. Bump CACHE_VERSION in the
 * same commit and every client re-downloads the whole shell on its next load.
 *
 * Why that works: the browser fetches this file itself, never through the fetch
 * handler below, and any byte-level change to it makes a new worker. Changing
 * CACHE_VERSION changes this file, so the new worker installs, precaches into a
 * fresh cache, skipWaiting()s, and drops the old cache on activate. It is also
 * why the host config sends `Cache-Control: no-cache` for sw.js — an sw.js stuck
 * in the HTTP cache is a worker that can never be replaced.
 *
 *   v1 -> v2 -> v3 …   any new value works; only inequality matters.
 *
 * In development you want none of this. serve.js sends `no-store`, but the HTTP
 * cache is not this cache and the worker ignores it, so tick "Bypass for network"
 * (DevTools -> Application -> Service Workers) or unregister the worker.
 * Otherwise you will spend an hour debugging code you are not running.
 */

const CACHE_VERSION = 'v4';

/** Prefix shared by every cache this app owns, so we can tell ours from a neighbour's. */
const CACHE_PREFIX = 'web-findxeink-f15-';

const CACHE = `${CACHE_PREFIX}${CACHE_VERSION}`;

/**
 * Everything needed for a cold start with no network.
 *
 * Relative throughout, resolved against this file's URL — that is what lets the
 * app be hosted from a subdirectory (user.github.io/web-findxeink-f15/) with no
 * edit. An absolute '/index.html' would quietly point at the domain root and
 * precache somebody else's page.
 *
 * A file missing from this list is not fatal: the fetch handler caches every
 * same-origin GET it serves, so anything omitted is picked up on the first online
 * load. The list only front-runs that.
 */
const APP_SHELL = [
  './',
  './index.html',
  './app.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/protocol.js',
  './js/device.js',
  './js/image.js',
  './js/crop.js',
  './js/render.js',
  './js/qrcode.js',
  './js/automation.js',
  './js/runner.js',
  './js/storage.js',
  './js/util.js',
  './assets/icons/favicon.svg',
  './assets/icons/apple-touch-icon.png',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // cache.add per file rather than cache.addAll, which is all-or-nothing: one
    // renamed file would abort the install and leave the app with no offline copy
    // whatsoever. Failures are logged instead — a stale entry in APP_SHELL is a
    // bug worth seeing, just not one worth breaking the install over.
    await Promise.all(APP_SHELL.map((url) => cache.add(url).catch((err) => {
      console.warn(`[sw] precache miss: ${url} — ${err && err.message}`);
    })));
    // Take over immediately instead of waiting for every tab to close. Safe here
    // because the shell is versioned as one unit, so a client is never left
    // holding a new index.html with old modules.
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    // Only ever delete our own. caches.keys() covers the whole ORIGIN, so on a
    // shared one (username.github.io, or a personal domain hosting several apps)
    // an unfiltered sweep wipes the neighbours' offline data.
    await Promise.all(
      names.filter((n) => n.startsWith(CACHE_PREFIX) && n !== CACHE).map((n) => caches.delete(n)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Never touch anything cross-origin, and nothing that is not plain http(s)
  // (chrome-extension:, blob:, data: — cache.put() throws on those anyway).
  // There should be no cross-origin request at all: the CSP blocks them and the
  // app ships every byte it uses. A service worker that quietly proxies
  // third-party traffic is exactly what this app promises not to be, so the
  // guard is here to make that promise structural rather than incidental.
  if (url.origin !== self.location.origin) return;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return;

  event.respondWith((async () => {
    // Our own cache, by name. The bare caches.match() searches every cache on the
    // origin, so on a shared origin it can answer with a neighbouring app's copy
    // of a same-named file.
    const cache = await caches.open(CACHE);

    const cached = await cache.match(request);
    if (cached) return cached;

    try {
      const fresh = await fetch(request);
      // Only keep real successes. An opaque response has status 0 and an
      // unreadable body, and caching a 404 would pin the mistake in place until
      // the next CACHE_VERSION bump.
      if (fresh && fresh.status === 200 && fresh.type === 'basic') {
        // Not awaited — the response must not wait on disk — but the rejection
        // has to be swallowed, or a full storage quota surfaces as an unhandled
        // promise rejection instead of a slightly staler cache.
        cache.put(request, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch {
      // Offline, and this exact URL is not cached. Any navigation within scope
      // still resolves to the one page this app has, so serve the shell rather
      // than a browser error page.
      if (request.mode === 'navigate') {
        const shell = (await cache.match('./index.html')) || (await cache.match('./'));
        if (shell) return shell;
      }
      return new Response('Offline, and this file is not in the cache.', {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});

/**
 * Lets the page force an immediate takeover after an update — postMessage
 * 'skipWaiting' to the waiting worker from an "update available, reload" prompt.
 * Harmless if the page never sends it.
 */
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') self.skipWaiting();
});
