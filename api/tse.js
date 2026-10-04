const TSE = 'https://resultados.tse.jus.br/oficial/ele2026';

const CARGOS = {
  presidente: { ele: '6257', cod: '0001', federal: true },
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
  s = s.replace(/\./g, '').replace(',', '.');
  return Number(s) || 0;
}

function text(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function pct(v) {
  const n = num(v);
  return n > 100 ? n / 100 : n;
}

function parse(j, cargo, uf) {
  const s = j?.s || {};
  const v = j?.v || {};
  const e = j?.e || {};

  const total = num(s.ts);
  const count = num(s.st);
  const valid = num(v.vv);
  const generatedDate = text(j?.dg);
  const generatedTime = text(j?.hg);

  const candidates = [];
  for (const cg of (Array.isArray(j?.carg) ? j.carg : [])) {
    for (const ag of (Array.isArray(cg?.agr) ? cg.agr : [])) {
      for (const pa of (Array.isArray(ag?.par) ? ag.par : [])) {
        for (const cd of (Array.isArray(pa?.cand) ? pa.cand : [])) {
          const name = text(cd?.nmu || cd?.nm);
          if (!name) continue;
          const number = text(cd?.n);
          const party = text(pa?.sg || pa?.nm);
          const sqcand = text(cd?.sqcand);
          const photoUf = cargo === 'presidente' ? 'br' : uf.toLowerCase();
          candidates.push({
            name,
            number,
            party,
            votes: num(cd?.vap),
            percent: pct(cd?.pvap),
            status: text(cd?.st || cd?.e),
            sqcand,
            photo: sqcand ? `${TSE}/${CARGOS[cargo].ele}/fotos/${photoUf}/${sqcand}.jpeg` : ''
          });
        }
      }
    }
  }

  return {
    total,
    count,
    valid,
    generatedAt: generatedDate || generatedTime ? `${generatedDate} ${generatedTime}`.trim() : '',
    electorate: num(e.te),
    electorateCounted: num(e.est),
    candidates
  };
}

function codeFor(cargo, uf) {
  if (cargo === 'depest' && uf === 'DF') return '0008';
  return CARGOS[cargo].cod;
}

function urlFor(uf, cargo) {
  const c = CARGOS[cargo];
  const folder = cargo === 'presidente' ? 'br' : uf.toLowerCase();
  const cod = codeFor(cargo, uf);
  const ele = String(c.ele).padStart(6, '0');
  return `${TSE}/${c.ele}/dados/${folder}/${folder}-c${cod}-e${ele}-u.json`;
}

async function readOne(uf, cargo) {
  const url = urlFor(uf, cargo);
  try {
    const r = await fetch(`${url}?nocache=${Date.now()}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' }
    });
    if (!r.ok) return { uf, data: null, status: r.status, url };
    return { uf, data: parse(await r.json(), cargo, uf), status: r.status, url };
  } catch (error) {
    return { uf, data: null, status: 0, url, error: String(error?.message || error) };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Método não permitido' });

  const cargo = String(req.query.cargo || 'presidente').toLowerCase();
  const uf = String(req.query.uf || '').toUpperCase();

  if (!CARGOS[cargo]) return res.status(400).json({ error: 'Cargo inválido' });
  if (uf && !UFS.includes(uf)) return res.status(400).json({ error: 'UF inválida' });

  // Presidente é publicado em um único arquivo nacional (BR).
  // Os demais cargos têm um arquivo por UF.
  const requested = cargo === 'presidente' ? ['BR'] : (uf ? [uf] : UFS);
  const results = {};
  const errors = [];

  for (let i = 0; i < requested.length; i += 6) {
    const batch = await Promise.all(requested.slice(i, i + 6).map(async u => {
      const realUf = u === 'BR' ? 'BR' : u;
      return readOne(realUf, cargo);
    }));
    for (const item of batch) {
      if (item.data) results[item.uf] = item.data;
      else errors.push({ uf: item.uf, status: item.status, url: item.url });
    }
  }

  if (!Object.keys(results).length) {
    return res.status(502).json({
      error: 'O TSE não entregou arquivos de apuração para esta consulta.',
      source: 'TSE',
      cargo,
      details: errors
    });
  }

  const candidates = {};
  let total = 0;
  let count = 0;
  let valid = 0;
  let latest = '';

  for (const [state, d] of Object.entries(results)) {
    total += d.total;
    count += d.count;
    valid += d.valid;
    if (d.generatedAt > latest) latest = d.generatedAt;

    for (const c of d.candidates) {
      const key = c.number || `${c.name}|${c.party}`;
      if (!candidates[key]) {
        candidates[key] = { ...c, votes: 0, states: [] };
      }
      candidates[key].votes += c.votes;
      if (!candidates[key].states.includes(state)) candidates[key].states.push(state);
      if (!candidates[key].photo && c.photo) candidates[key].photo = c.photo;
    }
  }

  const list = Object.values(candidates)
    .sort((a, b) => b.votes - a.votes)
    .map(c => ({
      ...c,
      percent: valid ? (c.votes / valid) * 100 : c.percent
    }));

  return res.status(200).json({
    source: 'TSE',
    cargo,
    uf: uf || 'BR',
    updatedAt: new Date().toISOString(),
    generatedAt: latest,
    totalSections: total,
    countedSections: count,
    validVotes: valid,
    progress: total ? (count / total) * 100 : 0,
    candidates: list,
    states: results,
    errors
  });
};
