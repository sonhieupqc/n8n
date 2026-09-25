// Service worker: cho phép mở app khi không có mạng và lưu đệm thư viện từ CDN.
const VERSION = 'pdf-scanner-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'imaging.js', 'converters.js', 'ai.js', 'storage.js', 'manifest.webmanifest', 'icon.svg'];
const SHARE_CACHE = 'pdf-scanner-share';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Nhận file được chia sẻ từ ứng dụng khác (Web Share Target)
  if (req.method === 'POST' && url.origin === location.origin) {
    e.respondWith(
      (async () => {
        const form = await req.formData();
        const cache = await caches.open(SHARE_CACHE);
        const files = form.getAll('files');
        await Promise.all(files.map((f, i) => cache.put(`shared/${Date.now()}-${i}`, new Response(f, { headers: { 'x-name': encodeURIComponent(f.name), 'content-type': f.type } }))));
        return Response.redirect('./?shared=1', 303);
      })(),
    );
    return;
  }
  if (req.method !== 'GET') return;

  // Thư viện CDN: dùng bản đệm, cập nhật ngầm
  if (url.hostname === 'cdn.jsdelivr.net') {
    e.respondWith(
      caches.open(VERSION).then(async (c) => {
        const hit = await c.match(req);
        const net = fetch(req).then((res) => {
          if (res.ok) c.put(req, res.clone());
          return res;
        }).catch(() => hit);
        return hit || net;
      }),
    );
    return;
  }

  // Giao diện app: ưu tiên mạng, mất mạng thì dùng bản đệm
  if (url.origin === location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) caches.open(VERSION).then((c) => c.put(req, res.clone()));
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true })),
    );
  }
});
