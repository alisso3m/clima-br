/* Service worker do Clima Brasil: abre offline com o último dado e verifica avisos oficiais em segundo plano. */
const V = 'clima-br-v1', SHELL = ['/', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== 'clima-br-state').map(k => caches.delete(k)))).then(() => self.clients.claim())); });

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== location.origin) return;
  if (u.pathname === '/api/wx') return; // o app já guarda o último dado no aparelho
  if (r.mode === 'navigate' || u.pathname.startsWith('/api/')) {
    e.respondWith(fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r.mode === 'navigate' ? '/' : r, cp)); } return res; })
      .catch(() => caches.match(r.mode === 'navigate' ? '/' : r).then(m => m || new Response('', {status: 503}))));
    return;
  }
  e.respondWith(caches.match(r).then(m => m || fetch(r).then(res => { if (res.ok) { const cp = res.clone(); caches.open(V).then(c => c.put(r, cp)); } return res; })));
});

/* estado compartilhado (a página não deixa o localStorage ao alcance do worker) */
const state = {
  async get(k) { const c = await caches.open('clima-br-state'); const r = await c.match('/__' + k); return r ? r.json() : null; },
  async set(k, v) { const c = await caches.open('clima-br-state'); await c.put('/__' + k, new Response(JSON.stringify(v))); }
};
self.addEventListener('message', e => {
  const d = e.data || {};
  const okStr = v => typeof v === 'string' && v.length <= 80;
  if (d.type === 'pin') e.waitUntil(state.set('pin', d.city && okStr(d.city.name) && okStr(d.city.uf || '') ? {name: d.city.name, uf: d.city.uf || ''} : null));
  if (d.type === 'notified' && Array.isArray(d.ids)) e.waitUntil(state.set('notified', d.ids.filter(okStr).slice(-60)));
});

async function checkAlerts() {
  const pin = await state.get('pin'); if (!pin || !pin.name) return;
  let j; try { j = await (await fetch('/api/alerts?' + new URLSearchParams({city: pin.name, uf: pin.uf || ''}))).json(); } catch { return; }
  if (!j || !j.ok) return;
  const done = new Set((await state.get('notified')) || []); const fresh = j.alerts.filter(a => a.sev >= 2 && !done.has('o:' + a.id));
  for (const a of fresh) {
    done.add('o:' + a.id);
    await self.registration.showNotification('⚠️ ' + a.title + ' · ' + pin.name, {body: (a.risks || a.detail || 'Aviso oficial do Inmet para a sua cidade.').slice(0, 140), tag: 'o:' + a.id, icon: '/icon-192.png', badge: '/icon-192.png', data: {url: '/'}});
  }
  if (fresh.length) await state.set('notified', [...done].slice(-60));
}
self.addEventListener('periodicsync', e => { if (e.tag === 'check-alerts') e.waitUntil(checkAlerts()); });
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(cs => cs.length ? cs[0].focus() : self.clients.openWindow((e.notification.data && e.notification.data.url) || '/')));
});
