// GET /api/wx?u=<url da Open-Meteo codificada>
// Proxy com cache de borda: milhares de visitantes pedindo as mesmas cidades viram 1 chamada à Open-Meteo
// a cada alguns minutos. Só aceita os dois hosts da Open-Meteo (não é um proxy aberto).
const ALLOW = new Set(['api.open-meteo.com', 'air-quality-api.open-meteo.com']);

module.exports = async (req, res) => {
  let u;
  try { u = new URL(String(req.query.u || '')); } catch { return res.status(400).json({ error: 'url inválida' }); }
  if (u.protocol !== 'https:' || !ALLOW.has(u.hostname)) return res.status(400).json({ error: 'host não permitido' });
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(u.toString(), { signal: ctl.signal, headers: { 'user-agent': 'clima-br-site/1.0', accept: 'application/json' } });
    const body = await r.text();
    if (!r.ok) { res.setHeader('Cache-Control', 'no-store'); return res.status(r.status === 429 ? 429 : 502).json({ error: 'fonte indisponível' }); }
    const air = u.hostname.startsWith('air-quality');
    res.setHeader('Cache-Control', `public, s-maxage=${air ? 900 : 300}, stale-while-revalidate=900, stale-if-error=3600`);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(body);
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    res.status(504).json({ error: 'tempo esgotado' });
  } finally { clearTimeout(t); }
};
