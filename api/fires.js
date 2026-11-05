// GET /api/fires?lat=..&lon=..
// Focos de calor detectados por satélite (INPE/Programa Queimadas) nas últimas ~24 h num raio de 50 km.
// Foco de calor não é incêndio confirmado: é um pixel de satélite com temperatura anômala.
const BASE = 'https://dataserver-coids.inpe.br/queimadas/queimadas/focos/csv/diario/Brasil/focos_diario_br_';
const RADIUS = 50;

const km = (a, b, c, d) => {
  const r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r * Math.cos((a + c) / 2 * r);
  return Math.sqrt(x * x + y * y) * 6371;
};
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

async function getCsv(day) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(BASE + day + '.csv', { signal: ctl.signal, headers: { 'user-agent': 'clima-br-site/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
function parse(text) {
  const lines = text.split(/\r?\n/); if (lines.length < 2) return [];
  const head = lines[0].toLowerCase().split(',').map(s => s.trim().replace(/"/g, ''));
  const iLat = head.indexOf('lat'), iLon = head.indexOf('lon'), iT = head.findIndex(h => h.startsWith('data'));
  if (iLat < 0 || iLon < 0) return [];
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(','); const la = +p[iLat], lo = +p[iLon];
    if (Number.isFinite(la) && Number.isFinite(lo)) out.push({ la, lo, t: iT >= 0 ? Date.parse(String(p[iT]).replace(' ', 'T') + (/Z|[+-]\d\d:?\d\d$/.test(p[iT]) ? '' : 'Z')) : NaN });
  }
  return out;
}

let CACHE = { at: 0, pts: null };
async function load() {
  if (CACHE.pts && Date.now() - CACHE.at < 30 * 60 * 1000) return CACHE.pts;
  const now = new Date(), days = [ymd(now), ymd(new Date(now - 24 * 3600 * 1000))];
  const res = await Promise.allSettled(days.map(getCsv));
  const pts = []; let okAny = false;
  res.forEach(r => { if (r.status === 'fulfilled') { okAny = true; pts.push(...parse(r.value)); } });
  if (!okAny) throw new Error('sem arquivo');
  const cut = Date.now() - 24 * 3600 * 1000;
  CACHE = { at: Date.now(), pts: pts.filter(p => !Number.isFinite(p.t) || p.t >= cut) };
  return CACHE.pts;
}

const MEMO = new Map(), TTL = 1200000;
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return res.status(405).json({ ok: false }); }
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -35 || lat > 6 || lon < -75 || lon > -32) return res.status(400).json({ ok: false });
  const key = lat.toFixed(2) + ',' + lon.toFixed(2), hit = MEMO.get(key);
  if (hit && Date.now() - hit.at < TTL) { res.setHeader('Cache-Control', 'public, s-maxage=600'); return res.status(200).send(hit.body); }
  const send = res.send.bind(res); res.send = b => { if (res.statusCode === 200 && b && String(b).includes('"ok":true')) { if (MEMO.size >= 500) MEMO.delete(MEMO.keys().next().value); MEMO.set(key, { at: Date.now(), body: b }); } return send(b); };
  try {
    const pts = await load();
    const d = pts.filter(p => Math.abs(p.la - lat) < 0.7 && Math.abs(p.lo - lon) < 0.7).map(p => km(lat, lon, p.la, p.lo));
    const within = d.filter(x => x <= RADIUS);
    const nearest = d.length ? Math.round(Math.min(...d)) : null;
    res.setHeader('Cache-Control', 'public, s-maxage=1200, stale-while-revalidate=3600, stale-if-error=7200');
    res.status(200).send(JSON.stringify({ ok: true, radius: RADIUS, n: within.length, nearest, total: pts.length }));
  } catch {
    res.setHeader('Cache-Control', 'public, s-maxage=120');
    res.status(200).send(JSON.stringify({ ok: false }));
  }
};
module.exports.km = km;
