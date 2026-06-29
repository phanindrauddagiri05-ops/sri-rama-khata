const CACHE_NAME = 'khatabook-cache-v1';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/app.js',
  '/js/i18n.js',
  '/manifest.json',
  '/images/icon-512.png',
  'https://unpkg.com/lucide@latest',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=Inter:wght@300;400;500;600;700&display=swap'
];

// Install Event - Pre-cache essential static shell files
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[Service Worker] Pre-caching static assets');
      return cache.addAll(ASSETS_TO_CACHE);
    }).then(() => self.skipWaiting())
  );
});

// Activate Event - Clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            console.log('[Service Worker] Clearing old cache', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch Event - Network first, falling back to cache strategy for assets; bypass API
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass API endpoints - always go to network, never cache API responses
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  // Network-First with Cache-Fallback strategy for web assets
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // If request succeeded, clone response and update cache
        if (response && response.status === 200) {
          const responseToCache = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return response;
      })
      .catch(() => {
        // If network request failed, look for it in the cache
        console.log('[Service Worker] Offline - Serving resource from cache:', event.request.url);
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          
          // If it's a navigation request and not in cache, fallback to index.html
          if (event.request.mode === 'navigate') {
            return caches.match('/index.html');
          }
        });
      })
  );
});
