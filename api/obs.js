// GET /api/obs?lat=..&lon=..
// Última medição REAL da estação automática do Inmet mais próxima (até 80 km): temperatura, umidade, chuva, vento.
// Diferente do restante do site, que usa modelo de previsão.
const BASE = 'https://apitempo.inmet.gov.br';
const MAX_KM = 80;

const km = (a, b, c, d) => {
  const r = Math.PI / 180, x = (c - a) * r, y = (d - b) * r * Math.cos((a + c) / 2 * r);
  return Math.sqrt(x * x + y * y) * 6371;
};
const num = v => { if (v == null || v === '') return null; const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };

async function get(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'clima-br-site/1.0', accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

let ST = { at: 0, list: null };
async function stations() {
  if (ST.list && Date.now() - ST.at < 12 * 3600 * 1000) return ST.list;
  const j = await get(BASE + '/estacoes/T');
  const list = (Array.isArray(j) ? j : []).map(s => ({
    code: s.CD_STATION || s.codigo, name: s.DC_NOME || s.nome || s.CD_STATION, uf: s.SG_ESTADO || s.uf || '',
    lat: num(s.VL_LATITUDE), lon: num(s.VL_LONGITUDE), on: !s.CD_SITUACAO || /oper/i.test(s.CD_SITUACAO)
  })).filter(s => s.code && s.lat != null && s.lon != null && s.on);
  if (!list.length) throw new Error('sem estações');
  ST = { at: Date.now(), list };
  return list;
}
const ymd = d => d.toISOString().slice(0, 10);

const MEMO = new Map(), TTL = 600000;
module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return res.status(405).json({ ok: false }); }
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -35 || lat > 6 || lon < -75 || lon > -32) return res.status(400).json({ ok: false });
  const key = lat.toFixed(2) + ',' + lon.toFixed(2), hit = MEMO.get(key);
  if (hit && Date.now() - hit.at < TTL) { res.setHeader('Cache-Control', 'public, s-maxage=600'); return res.status(200).send(hit.body); }
  const send = res.send.bind(res); res.send = b => { if (res.statusCode === 200 && b && String(b).includes('"ok":true')) { if (MEMO.size >= 500) MEMO.delete(MEMO.keys().next().value); MEMO.set(key, { at: Date.now(), body: b }); } return send(b); };
  try {
    const list = await stations();
    const near = list.map(s => ({ s, d: km(lat, lon, s.lat, s.lon) })).sort((a, b) => a.d - b.d).slice(0, 3).filter(x => x.d <= MAX_KM);
    if (!near.length) { res.setHeader('Cache-Control', 'public, s-maxage=1800'); return res.status(200).send(JSON.stringify({ ok: false, reason: 'sem estação próxima' })); }
    const now = new Date(), d1 = ymd(new Date(now - 36 * 3600 * 1000)), d2 = ymd(now);
    for (const { s, d } of near) {
      let rows;
      try { rows = await get(`${BASE}/estacao/${d1}/${d2}/${s.code}`); } catch { continue; }
      if (!Array.isArray(rows)) continue;
      rows = rows.filter(r => num(r.TEM_INS) != null).sort((a, b) => String(a.DT_MEDICAO + a.HR_MEDICAO).localeCompare(String(b.DT_MEDICAO + b.HR_MEDICAO)));
      const last = rows[rows.length - 1]; if (!last) continue;
      const hh = String(last.HR_MEDICAO || '0000').padStart(4, '0');
      const at = new Date(`${last.DT_MEDICAO}T${hh.slice(0, 2)}:${hh.slice(2)}:00Z`);
      if (!Number.isFinite(+at) || now - at > 6 * 3600 * 1000) continue; // medição velha demais: tenta a próxima estação
      const rain24 = rows.filter(r => now - new Date(`${r.DT_MEDICAO}T${String(r.HR_MEDICAO || '0000').padStart(4, '0').slice(0, 2)}:00:00Z`) <= 24 * 3600 * 1000).reduce((a, r) => a + (num(r.CHUVA) || 0), 0);
      res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=1200, stale-if-error=3600');
      return res.status(200).send(JSON.stringify({
        ok: true, station: { code: s.code, name: s.name, uf: s.uf, km: Math.round(d) }, at: at.toISOString(),
        t: num(last.TEM_INS), rh: num(last.UMD_INS), rain1h: num(last.CHUVA), rain24h: Math.round(rain24 * 10) / 10, wind: num(last.VEN_VEL) != null ? Math.round(num(last.VEN_VEL) * 3.6) : null
      }));
    }
    res.setHeader('Cache-Control', 'public, s-maxage=300');
    res.status(200).send(JSON.stringify({ ok: false, reason: 'sem medição recente' }));
  } catch {
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    res.status(200).send(JSON.stringify({ ok: false, reason: 'Inmet indisponível' }));
  }
};
module.exports.km = km;
