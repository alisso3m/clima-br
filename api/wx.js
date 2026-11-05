// GET /api/wx?u=<url da Open-Meteo codificada>
// Proxy com cache: milhares de visitantes pedindo as mesmas cidades viram 1 chamada à Open-Meteo a cada
// alguns minutos. NÃO é um proxy aberto: só aceita 2 endpoints, uma lista fixa de parâmetros e coordenadas
// dentro do Brasil; qualquer outra coisa é recusada com 400.
const ENDPOINTS = {
  'api.open-meteo.com': { path: '/v1/forecast', ttl: 300, keys: ['latitude', 'longitude', 'current', 'hourly', 'daily', 'minutely_15', 'forecast_minutely_15', 'past_days', 'forecast_days', 'timezone'] },
  'air-quality-api.open-meteo.com': { path: '/v1/air-quality', ttl: 900, keys: ['latitude', 'longitude', 'current', 'timezone'] }
};
const COORD = /^-?\d{1,3}(\.\d{1,6})?$/;
const VALUE = /^[A-Za-z0-9_,.:%+\-\/]{1,700}$/;
const MAX_COORDS = 40, MAX_ENTRIES = 300, MAX_BYTES = 3 * 1024 * 1024;
const MEM = new Map(); // chave canônica -> {at, body}

function validate(raw) {
  if (typeof raw !== 'string' || raw.length > 2500) return null;
  let u; try { u = new URL(raw); } catch { return null; }
  const ep = ENDPOINTS[u.hostname];
  if (u.protocol !== 'https:' || !ep || u.port || u.username || u.password || u.pathname !== ep.path || u.hash) return null;
  const out = new URLSearchParams(); const seen = new Set();
  for (const [k, v] of u.searchParams) {
    if (!ep.keys.includes(k) || seen.has(k) || !VALUE.test(v)) return null;
    seen.add(k); out.set(k, v);
  }
  const la = (out.get('latitude') || '').split(','), lo = (out.get('longitude') || '').split(',');
  if (!la[0] || la.length !== lo.length || la.length > MAX_COORDS) return null;
  for (let i = 0; i < la.length; i++) {
    if (!COORD.test(la[i]) || !COORD.test(lo[i])) return null;
    if (+la[i] < -35 || +la[i] > 6 || +lo[i] < -75 || +lo[i] > -32) return null; // só Brasil
  }
  for (const k of ['past_days', 'forecast_days', 'forecast_minutely_15']) if (out.has(k) && !/^\d{1,2}$/.test(out.get(k))) return null;
  out.sort();
  return { url: `https://${u.hostname}${ep.path}?${out.toString()}`, ttl: ep.ttl };
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return res.status(405).json({ error: 'método não permitido' }); }
  const v = validate(req.query && req.query.u);
  if (!v) return res.status(400).json({ error: 'parâmetros inválidos' });
  const hit = MEM.get(v.url);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (hit && Date.now() - hit.at < v.ttl * 1000) {
    res.setHeader('Cache-Control', `public, s-maxage=${v.ttl}, stale-while-revalidate=900, stale-if-error=3600`);
    return res.status(200).send(hit.body);
  }
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(v.url, { signal: ctl.signal, redirect: 'error', headers: { 'user-agent': 'clima-br-site/1.0', accept: 'application/json' } });
    const body = await r.text();
    if (!r.ok || body.length > MAX_BYTES) { res.setHeader('Cache-Control', 'no-store'); return res.status(r.status === 429 ? 429 : 502).json({ error: 'fonte indisponível' }); }
    if (MEM.size >= MAX_ENTRIES) MEM.delete(MEM.keys().next().value);
    MEM.set(v.url, { at: Date.now(), body });
    res.setHeader('Cache-Control', `public, s-maxage=${v.ttl}, stale-while-revalidate=900, stale-if-error=3600`);
    res.status(200).send(body);
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    res.status(504).json({ error: 'tempo esgotado' });
  } finally { clearTimeout(t); }
};
module.exports.validate = validate;
