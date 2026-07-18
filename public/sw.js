/**
 * SmartZap Service Worker
 *
 * Estratégias de cache:
 * - Cache-first: assets estáticos (JS, CSS, fontes, imagens)
 * - Network-first: API calls (dados sempre atualizados)
 * - Network-first com fallback /offline: navegação HTML
 */

const CACHE_VERSION = 'smartzap-v2'
const STATIC_CACHE = `${CACHE_VERSION}-static`
const DYNAMIC_CACHE = `${CACHE_VERSION}-dynamic`

// Shell mínimo (sem HTML autenticado que redireciona para login)
const PRECACHE_ASSETS = [
  '/login',
  '/offline',
  '/manifest.json',
  '/manifest-atendimento.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
]

const STATIC_PATTERNS = [
  /\/_next\/static\//,
  /\.(?:js|css|woff2?|ttf|eot)$/,
  /\/icons\//,
]

const IGNORE_PATTERNS = [
  /\/api\//,
  /\/_next\/webpack-hmr/,
  /chrome-extension/,
  /\.(?:mp3|wav|ogg|m4a|aac)$/,
]

// =============================================================================
// INSTALL - Pre-cache shell assets
// =============================================================================

self.addEventListener('install', (event) => {
  console.log('[SW] Installing...')

  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then((cache) => {
        console.log('[SW] Pre-caching app shell')
        return cache.addAll(PRECACHE_ASSETS)
      })
      .then(() => {
        console.log('[SW] Install complete, skipping waiting')
        return self.skipWaiting()
      })
      .catch((error) => {
        console.error('[SW] Pre-cache failed:', error)
      })
  )
})

// =============================================================================
// ACTIVATE - Clean old caches
// =============================================================================

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...')

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames
            .filter((name) => name.startsWith('smartzap-') && name !== STATIC_CACHE && name !== DYNAMIC_CACHE)
            .map((name) => {
              console.log('[SW] Deleting old cache:', name)
              return caches.delete(name)
            })
        )
      })
      .then(() => {
        console.log('[SW] Claiming clients')
        return self.clients.claim()
      })
  )
})

// =============================================================================
// FETCH - Handle requests with appropriate strategy
// =============================================================================

self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  if (shouldIgnore(url)) {
    return
  }

  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirst(request, DYNAMIC_CACHE))
    return
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE))
    return
  }

  // Navegação HTML: network-first com fallback /offline
  if (request.mode === 'navigate' || request.headers.get('accept')?.includes('text/html')) {
    event.respondWith(navigateWithOfflineFallback(request))
    return
  }

  event.respondWith(networkFirst(request, DYNAMIC_CACHE))
})

// =============================================================================
// PUSH - Handle push notifications
// =============================================================================

self.addEventListener('push', (event) => {
  console.log('[SW] Push received')

  let data = {
    title: 'SmartZap',
    body: 'Nova mensagem recebida',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    tag: 'smartzap-notification',
    data: { url: '/inbox' }
  }

  try {
    if (event.data) {
      const payload = event.data.json()
      data = { ...data, ...payload }
    }
  } catch (error) {
    console.error('[SW] Error parsing push data:', error)
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: data.icon,
      badge: data.badge,
      tag: data.tag,
      data: data.data,
      vibrate: [200, 100, 200],
      requireInteraction: true,
      actions: [
        { action: 'open', title: 'Abrir' },
        { action: 'dismiss', title: 'Dispensar' }
      ]
    })
  )
})

// =============================================================================
// NOTIFICATION CLICK - Handle notification interactions
// =============================================================================

self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification clicked:', event.action)

  event.notification.close()

  if (event.action === 'dismiss') {
    return
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        const isAttendantContext = clientList.some((client) => {
          try {
            return new URL(client.url).pathname.startsWith('/atendimento')
          } catch {
            return false
          }
        })

        const fallbackUrl = isAttendantContext ? '/atendimento' : '/inbox'
        const url = event.notification.data?.url || fallbackUrl

        for (const client of clientList) {
          try {
            const path = new URL(client.url).pathname
            const matchesContext = isAttendantContext
              ? path.startsWith('/atendimento')
              : !path.startsWith('/atendimento')
            if (matchesContext && 'focus' in client) {
              if ('navigate' in client && typeof client.navigate === 'function') {
                return client.navigate(url).then(() => client.focus())
              }
              return client.focus()
            }
          } catch {
            // ignore invalid client urls
          }
        }

        if (clients.openWindow) {
          return clients.openWindow(url)
        }
      })
  )
})

// =============================================================================
// CACHE STRATEGIES
// =============================================================================

async function navigateWithOfflineFallback(request) {
  try {
    const response = await fetch(request)
    if (response.ok && request.method === 'GET') {
      // Cache only public shell pages to avoid storing auth redirects
      const url = new URL(request.url)
      const cacheable =
        url.pathname === '/login' ||
        url.pathname === '/offline' ||
        url.pathname === '/atendimento' ||
        url.pathname.startsWith('/atendimento/')

      if (cacheable) {
        const cache = await caches.open(DYNAMIC_CACHE)
        cache.put(request, response.clone())
      }
    }
    return response
  } catch (error) {
    console.error('[SW] Navigation fetch failed:', error)
    const offline = await caches.match('/offline')
    if (offline) return offline
    const cached = await caches.match(request)
    if (cached) return cached
    return new Response('Offline', { status: 503, statusText: 'Offline' })
  }
}

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request)
  if (cached) {
    return cached
  }

  try {
    const response = await fetch(request)
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(cacheName)
      cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    console.error('[SW] Cache-first fetch failed:', error)
    return new Response('Offline', { status: 503 })
  }
}

async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request)
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(cacheName)
      cache.put(request, response.clone())
    }
    return response
  } catch (error) {
    const cached = await caches.match(request)
    if (cached) {
      return cached
    }
    return new Response(JSON.stringify({ error: 'Offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function shouldIgnore(url) {
  return IGNORE_PATTERNS.some((pattern) => pattern.test(url.href))
}

function isStaticAsset(url) {
  return STATIC_PATTERNS.some((pattern) => pattern.test(url.href))
}

// =============================================================================
// MESSAGE HANDLER - Communication with main thread
// =============================================================================

self.addEventListener('message', (event) => {
  console.log('[SW] Message received:', event.data)

  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    event.waitUntil(
      caches.keys().then((names) =>
        Promise.all(names.map((name) => caches.delete(name)))
      )
    )
  }
})
