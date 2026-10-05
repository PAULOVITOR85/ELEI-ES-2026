const TSE = 'https://resultados.tse.jus.br/oficial/ele2026';

const CARGOS = {
  presidente: { ele: '6257', cod: '0001' },
  governador: { ele: '6259', cod: '0003' },
  senador: { ele: '6259', cod: '0005' },
  depfed: { ele: '6259', cod: '0006' },
  depest: { ele: '6259', cod: '0007' }
};

const UFS = ['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG','PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO'];
let municipalityCache = null;

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v ?? '').trim();
  if (!s) return 0;
  s = s.replace(/\./g, '').replace(',', '.');
  return Number(s) || 0;
}
function text(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function pct(v) { const n = num(v); return n > 100 ? n / 100 : n; }

function parse(j, cargo, uf, mun='') {
  const s = j?.s || {}, v = j?.v || {}, e = j?.e || {};
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
          const photoUf = cargo === 'presidente' && !mun ? 'br' : uf.toLowerCase();
          candidates.push({
            name, number, party,
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
    total: num(s.ts), count: num(s.st), valid: num(v.vv ?? v.tvn),
    generatedAt: (text(j?.dg) + ' ' + text(j?.hg)).trim(),
    electorate: num(e.te), electorateCounted: num(e.est), candidates
  };
}

function codeFor(cargo, uf) {
  if (cargo === 'depest' && uf === 'DF') return '0008';
  return CARGOS[cargo].cod;
}

function urlFor(uf, cargo, mun='') {
  const c = CARGOS[cargo];
  const folder = uf.toLowerCase();
  const cod = codeFor(cargo, uf);
  const ele = String(c.ele).padStart(6, '0');
  const prefix = mun ? String(mun).padStart(5, '0') : '';
  return `${TSE}/${c.ele}/dados/${folder}/${folder}${prefix}-c${cod}-e${ele}-u.json`;
}

async function readOne(uf, cargo, mun='') {
  const url = urlFor(uf, cargo, mun);
  try {
    const r = await fetch(`${url}?nocache=${Date.now()}`, { cache:'no-store', headers:{accept:'application/json'} });
    if (!r.ok) return { uf, mun, data:null, status:r.status, url };
    return { uf, mun, data:parse(await r.json(), cargo, uf, mun), status:r.status, url };
  } catch (error) {
    return { uf, mun, data:null, status:0, url, error:String(error?.message || error) };
  }
}

// EA12: o TSE organiza o cadastro como UF (abr) -> municípios (mu).
// Alguns arquivos usam "cd" para o código da UF, por isso não devemos
// depender somente de campos chamados "uf"/"sigla".
function findMunicipalities(node, out=[], seen=new Set(), ufHint='') {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const x of node) findMunicipalities(x, out, seen, ufHint);
    return out;
  }

  const explicitUf = text(node.uf || node.sguf || node.sigla || node.cd_uf).toUpperCase();
  const nodeCd = text(node.cd || node.codigo || node.cod);
  const inheritedUf = explicitUf || (/^[A-Z]{2}$/.test(nodeCd) ? nodeCd : '') || ufHint;

  // Formato principal: objeto de município com código de 5 dígitos e nome.
  const code = text(node.cdmun || node.cd_mun || node.cmun || node.mun || node.codigo_municipio || nodeCd);
  const name = text(node.nm || node.nome || node.nmun || node.municipio || node.descricao);
  if (/^\d{5}$/.test(code) && name && /^[A-Z]{2}$/.test(inheritedUf)) {
    const key = `${inheritedUf}|${code}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ code, name, uf: inheritedUf });
    }
  }

  for (const [k, v] of Object.entries(node)) {
    if (k === 'uf' || k === 'sguf' || k === 'sigla' || k === 'cd_uf') continue;
    // Não usar campos de texto como nós recursivos; somente objetos/arrays.
    if (v && typeof v === 'object') findMunicipalities(v, out, seen, inheritedUf);
  }
  return out;
}

async function getMunicipalities() {
  if (municipalityCache) return municipalityCache;
  const url = `${TSE}/6259/config/mun-e006259-cm.json`;
  const r = await fetch(`${url}?nocache=${Date.now()}`, { cache:'no-store', headers:{accept:'application/json'} });
  if (!r.ok) throw Error(`Falha ao carregar municípios do TSE (HTTP ${r.status})`);
  const data = await r.json();
  const list = findMunicipalities(data);
  if (!list.length) throw Error('O TSE não retornou a lista de municípios no formato esperado.');
  municipalityCache = list.sort((a,b)=>a.uf.localeCompare(b.uf)||a.name.localeCompare(b.name,'pt-BR'));
  return municipalityCache;
}

async function aggregate(requested, cargo, mun='') {
  const results = {}, errors = [];
  for (let i=0;i<requested.length;i+=6) {
    const batch = await Promise.all(requested.slice(i,i+6).map(u=>readOne(u,cargo,mun)));
    for (const item of batch) {
      if (item.data) results[item.uf] = item.data;
      else errors.push({uf:item.uf,status:item.status,url:item.url});
    }
  }
  return {results,errors};
}

function responseFromResults(results, errors, cargo, uf, mun='') {
  if (!Object.keys(results).length) return null;
  const candidates = {}; let total=0,count=0,valid=0,latest='';
  for (const [state,d] of Object.entries(results)) {
    total += d.total; count += d.count; valid += d.valid;
    if (d.generatedAt > latest) latest=d.generatedAt;
    for (const c of d.candidates) {
      const key=c.number || `${c.name}|${c.party}`;
      if (!candidates[key]) candidates[key]={...c,votes:0,states:[]};
      candidates[key].votes += c.votes;
      if (!candidates[key].states.includes(state)) candidates[key].states.push(state);
      if (!candidates[key].photo && c.photo) candidates[key].photo=c.photo;
    }
  }
  const list=Object.values(candidates).sort((a,b)=>b.votes-a.votes).map(c=>({...c,percent:valid?(c.votes/valid)*100:c.percent}));
  return {source:'TSE',cargo,uf:uf||'BR',municipio:mun||null,updatedAt:new Date().toISOString(),generatedAt:latest,totalSections:total,countedSections:count,validVotes:valid,progress:total?(count/total)*100:0,candidates:list,states:results,errors};
}

module.exports = async (req,res) => {
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Access-Control-Allow-Methods','GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers','Content-Type');
  res.setHeader('Cache-Control','no-store, max-age=0');
  if (req.method==='OPTIONS') return res.status(204).end();
  if (req.method!=='GET') return res.status(405).json({error:'Método não permitido'});

  if (String(req.query.municipios || '') === '1') {
    try {
      const all=await getMunicipalities();
      const uf=String(req.query.uf||'').toUpperCase();
      if (uf && !UFS.includes(uf)) return res.status(400).json({error:'UF inválida'});
      const list=uf?all.filter(x=>x.uf===uf):all;
      return res.status(200).json({source:'TSE',count:list.length,municipios:list});
    } catch(e) { return res.status(502).json({error:e.message,source:'TSE'}); }
  }

  const cargo=String(req.query.cargo||'presidente').toLowerCase();
  const uf=String(req.query.uf||'').toUpperCase();
  const mun=String(req.query.mun||'').replace(/\D/g,'');
  if (!CARGOS[cargo]) return res.status(400).json({error:'Cargo inválido'});
  if (uf && !UFS.includes(uf)) return res.status(400).json({error:'UF inválida'});
  if (mun && !/^\d{5}$/.test(mun)) return res.status(400).json({error:'Código de município inválido'});
  if (mun && !uf) return res.status(400).json({error:'Informe a UF junto com o município'});

  const requested=uf?[uf]:UFS;
  const {results,errors}=await aggregate(requested,cargo,mun);
  const payload=responseFromResults(results,errors,cargo,uf,mun);
  if (!payload) return res.status(502).json({error:'O TSE não entregou arquivos de apuração para esta consulta.',source:'TSE',cargo,uf,municipio:mun||null,details:errors});
  return res.status(200).json(payload);
};
