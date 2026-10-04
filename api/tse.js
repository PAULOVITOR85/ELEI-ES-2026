const TSE = 'https://resultados.tse.jus.br/oficial/ele2026';

const CARGOS = {
  presidente: { ele: '6257', cod: '0001' },
  governador: { ele: '6259', cod: '0003' },
  senador: { ele: '6259', cod: '0005' },
  depfed: { ele: '6259', cod: '0006' },
  depest: { ele: '6259', cod: '0007' }
};

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v ?? '').trim();
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(',', '.');
  return Number(s) || 0;
}

function pick(o, keys) {
  for (const k of keys) if (o?.[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return null;
}

function parse(j) {
  const s = j?.s || {};
  const v = j?.v || {};
  const total = num(pick(s, ['ts','total','tt','totalSecoes']));
  const count = num(pick(s, ['st','sc','secoesTotalizadas','sec']));
  const valid = num(pick(v, ['vv','validos','valid']));
  const arr = Array.isArray(j?.cand) ? j.cand : Array.isArray(j?.candidatos) ? j.candidatos : [];
  const candidates = arr.map(c => ({
    name: pick(c, ['nm','nmu','nome','name']),
    number: pick(c, ['n','num','numero']),
    party: pick(c, ['sgp','sg','partido','sigla','part']),
    votes: num(pick(c, ['vap','votos','vv','tv','v'])),
    percent: num(pick(c, ['pvapn','pvap','percentual','p'])),
    photo: pick(c, ['foto','fot','urlFoto','fotoUrl','photo','photoUrl'])
  })).filter(c => c.name);
  return { total, count, valid, candidates };
}

function paths(uf, cargo) {
  const c = CARGOS[cargo];
  const u = uf.toLowerCase();
  return [
    `${TSE}/${c.ele}/dados/${u}/${u}-c${c.cod}-e0${c.ele}-u.json`,
    `${TSE}/${c.ele}/dados/${u}/${u}-c${c.cod}-e${c.ele}-u.json`
  ];
}

async function readUf(uf, cargo) {
  for (const url of paths(uf, cargo)) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) continue;
      return parse(await r.json());
    } catch (_) {}
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const cargo = String(req.query.cargo || 'presidente').toLowerCase();
  const uf = String(req.query.uf || '').toUpperCase();
  if (!CARGOS[cargo]) return res.status(400).json({ error: 'Cargo inválido' });

  if (uf && !UFS.includes(uf)) return res.status(400).json({ error: 'UF inválida' });

  const requested = uf ? [uf] : UFS;
  const results = {};
  for (let i = 0; i < requested.length; i += 4) {
    const batch = await Promise.all(requested.slice(i, i + 4).map(async u => [u, await readUf(u, cargo)]));
    for (const [u, data] of batch) if (data) results[u] = data;
  }

  if (!Object.keys(results).length) {
    return res.status(502).json({ error: 'O TSE não entregou arquivos de apuração para esta consulta.', source: 'TSE' });
  }

  const candidates = {};
  let total = 0, count = 0, valid = 0;
  for (const [state, d] of Object.entries(results)) {
    total += d.total; count += d.count; valid += d.valid;
    for (const c of d.candidates) {
      const key = c.number || `${c.name}|${c.party || ''}`;
      if (!candidates[key]) candidates[key] = { ...c, votes: 0, states: [] };
      candidates[key].votes += c.votes;
      if (!candidates[key].states.includes(state)) candidates[key].states.push(state);
    }
  }
  const list = Object.values(candidates).sort((a,b) => b.votes - a.votes).map(c => ({ ...c, percent: valid ? c.votes / valid * 100 : 0 }));

  return res.status(200).json({ source: 'TSE', cargo, uf: uf || 'BR', updatedAt: new Date().toISOString(), totalSections: total, countedSections: count, validVotes: valid, progress: total ? count / total * 100 : 0, candidates: list, states: results });
};
