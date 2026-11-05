// GET /api/alerts?city=Nome&uf=MG
// Avisos meteorológicos OFICIAIS ativos do Inmet, filtrados para a cidade.
// O formato do Inmet pode mudar, então a leitura é defensiva: se algo falhar, devolve { ok:false } e o site
// mostra um link para os avisos oficiais em vez de afirmar que "não há avisos".
const URL_ATIVOS = 'https://apiprevmet3.inmet.gov.br/avisos/ativos';

const norm = s => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const pick = (o, keys) => { for (const k of keys) if (o && o[k] != null && o[k] !== '') return o[k]; return null; };
const flat = v => Array.isArray(v) ? v.map(flat).join(', ') : (v && typeof v === 'object') ? Object.values(v).map(flat).join(', ') : String(v == null ? '' : v);

function sevOf(a) {
  const t = norm(flat(pick(a, ['severidade', 'aviso_severidade', 'nivel', 'severity'])));
  if (t.includes('grande')) return 3;
  if (t.includes('potencial')) return 1;
  if (t.includes('perigo')) return 2;
  const c = String(pick(a, ['aviso_cor', 'cor']) || '').toLowerCase();
  if (/f00|ff0000|e00|red|verm/.test(c)) return 3;
  if (/f80|ffa|ff9|orange|laranj/.test(c)) return 2;
  return 1;
}

function normalize(a) {
  const areas = flat(pick(a, ['municipios', 'cidades', 'areas', 'area', 'descricao_areas', 'geocodes']));
  const estados = flat(pick(a, ['estados', 'uf', 'ufs']));
  const ini = pick(a, ['data_inicio', 'inicio', 'onset']), fim = pick(a, ['data_fim', 'fim', 'expires']);
  const hi = pick(a, ['hora_inicio']), hf = pick(a, ['hora_fim']);
  const riscos = pick(a, ['riscos', 'risco']);
  return {
    id: String(pick(a, ['id', 'id_aviso', 'identificador']) || ''),
    sev: sevOf(a),
    title: String(pick(a, ['descricao', 'evento', 'aviso_descricao', 'titulo', 'headline']) || 'Aviso meteorológico').slice(0, 120),
    detail: String(pick(a, ['meteorologista', 'observacoes', 'detalhes', 'texto']) || '').slice(0, 400),
    risks: flat(riscos).slice(0, 300), tips: flat(pick(a, ['instrucoes', 'recomendacoes'])).slice(0, 400),
    start: ini ? String(ini) + (hi ? ' ' + hi : '') : '', end: fim ? String(fim) + (hf ? ' ' + hf : '') : '',
    _areas: norm(areas), _uf: norm(estados)
  };
}

let CACHE = { at: 0, list: null };
async function fetchAll() {
  if (CACHE.list && Date.now() - CACHE.at < 4 * 60 * 1000) return CACHE.list;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
  try {
    const r = await fetch(URL_ATIVOS, { signal: ctl.signal, headers: { 'user-agent': 'clima-br-site/1.0', accept: 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    const arr = Array.isArray(j) ? j : [].concat(j.hoje || [], j.futuro || [], j.avisos || [], j.data || []);
    if (!Array.isArray(arr)) throw new Error('formato');
    CACHE = { at: Date.now(), list: arr.map(normalize) };
    return CACHE.list;
  } finally { clearTimeout(t); }
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const city = norm(req.query.city || '').trim(), uf = norm(req.query.uf || '').trim();
  if (!city) return res.status(400).json({ ok: false, error: 'city obrigatório' });
  try {
    const all = await fetchAll();
    const re = new RegExp('(^|[^a-z])' + city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)');
    const mine = all.filter(a => re.test(a._areas) && (!uf || !a._uf || a._uf.includes(uf) || a._areas.includes(uf)));
    const inUf = uf ? all.filter(a => a._uf.includes(uf) || a._areas.includes('(' + uf + ')')).length : 0;
    mine.sort((a, b) => b.sev - a.sev);
    res.setHeader('Cache-Control', 'public, s-maxage=240, stale-while-revalidate=600, stale-if-error=1800');
    res.status(200).send(JSON.stringify({ ok: true, at: new Date().toISOString(), total: all.length, inUf, alerts: mine.slice(0, 6).map(({ _areas, _uf, ...x }) => x) }));
  } catch (e) {
    res.setHeader('Cache-Control', 'public, s-maxage=60');
    res.status(200).send(JSON.stringify({ ok: false, error: 'Inmet indisponível' }));
  }
};
module.exports.normalize = normalize; module.exports.sevOf = sevOf;
