// Vercel Serverless Function: GET /api/enso
// Lê dados públicos da NOAA/CPC no servidor (o navegador não pode, por CORS) e devolve JSON enxuto.
const DISC_URL = 'https://www.cpc.ncep.noaa.gov/products/analysis_monitoring/enso_advisory/ensodisc.shtml';
const NINO_URL = 'https://www.cpc.ncep.noaa.gov/data/indices/ersst5.nino.mth.91-20.ascii';
const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

const clean = s => s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

function parseNino(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const p = line.trim().split(/\s+/);
    if (p.length >= 10 && /^\d{4}$/.test(p[0]) && /^\d{1,2}$/.test(p[1])) {
      const v = Number(p[9]);
      if (Number.isFinite(v)) rows.push({ y: +p[0], m: +p[1], anom: v, sst: Number(p[8]) });
    }
  }
  return rows.slice(-8);
}

function parseDisc(html) {
  const text = clean(html);
  const st = text.match(/ENSO Alert System Status:?\s*((?:Final )?(?:El Ni[ñn]o|La Ni[ñn]a)\s+(?:Advisory|Watch)|ENSO-neutral|Not Active|Inactive)/i);
  const status = st ? st[1].trim() : null;
  const sy = text.match(/Synopsis:?\s*(.{20,400}?\.)(?:\s|$)/);
  const dt = text.match(new RegExp('\\b(\\d{1,2}) (' + MONTHS + ') (\\d{4})\\b'));
  return { status, synopsis: sy ? sy[1].trim() : null, issued: dt ? dt[0] : null };
}

async function get(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { 'user-agent': 'clima-mg-site/1.0' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.setHeader('Allow', 'GET, HEAD'); return res.status(405).json({ error: 'método não permitido' }); }
  const [d, n] = await Promise.allSettled([get(DISC_URL), get(NINO_URL)]);
  const out = { source: 'NOAA/CPC', fetchedAt: new Date().toISOString(), discussion: null, nino34: null };
  if (d.status === 'fulfilled') out.discussion = parseDisc(d.value);
  if (n.status === 'fulfilled') out.nino34 = parseNino(n.value);
  const ok = (out.discussion && out.discussion.status) || (out.nino34 && out.nino34.length);
  res.setHeader('Cache-Control', ok ? 'public, s-maxage=21600, stale-while-revalidate=86400' : 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(ok ? 200 : 502).send(JSON.stringify(ok ? out : { error: 'NOAA indisponível' }));
};
module.exports.parseDisc = parseDisc; module.exports.parseNino = parseNino;
