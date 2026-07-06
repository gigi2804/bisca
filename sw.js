self.addEventListener('install', (e) => {
    console.log('[Service Worker] Installato con successo.');
});

self.addEventListener('fetch', (e) => {
    // Lasciamo passare tutte le richieste normalmente
    e.respondWith(fetch(e.request));
});