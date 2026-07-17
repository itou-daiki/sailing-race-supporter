const CACHE_NAME = 'sailing-race-supporter-v2'
const APP_SHELL = ['/manifest.webmanifest', '/icon.svg', '/icon-180.png', '/icon-192.png', '/icon-512.png']

async function cacheApplicationShell() {
  const cache = await caches.open(CACHE_NAME)
  const response = await fetch('/', { cache: 'reload' })
  if (!response.ok) throw new Error('Unable to cache application shell')
  const html = await response.clone().text()
  await cache.put('/', response)
  const assetPaths = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/gu)].map((match) => match[1])
  await cache.addAll([...new Set([...APP_SHELL, ...assetPaths])])
}

self.addEventListener('install', (event) => {
  event.waitUntil(cacheApplicationShell())
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
    )),
  )
  self.clients.claim()
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone()
          void caches.open(CACHE_NAME).then((cache) => Promise.all([
            cache.put(request, copy.clone()),
            cache.put('/', copy),
          ]))
          return response
        })
        .catch(async () => (await caches.match(request)) ?? caches.match('/')),
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) {
        const copy = response.clone()
        void caches.open(CACHE_NAME).then((cache) => cache.put(request, copy))
      }
      return response
    })),
  )
})
