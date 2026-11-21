// Kart Rush v1.5 — servidor multijogador
//  - serve o jogo (public/index.html) e o WebSocket em /ws
//  - salas: lista, criar, entrar (com senha opcional), sair, admin expulsa / configura / inicia
//  - corrida: grid com humanos + bots (completa até 8), largada sincronizada pelo relógio do servidor,
//    retransmissão do estado de cada kart (~20x/s), bandeirada, resultado final e volta para a sala
//  - campeonato multijogador (opção da sala): 2 a 5 pistas escolhidas ou sorteadas, pontos por corrida, pódio no fim
//  - itens (opção da sala): retransmite os efeitos (óleo na pista, escudo) para todos da corrida
//  - ranking online por pista: uma tabela com tempo total, melhor volta e nº de voltas de cada jogador (filtro por voltas),
//    separados por modo (solo / multijogador) e itens (com / sem);
//    guardado no Upstash Redis (UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN) ou, sem ele, em data/ranking.json
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const MAX_KARTS = 8, MAX_ROOMS = 60, CARS = 8;
const CAR_NAMES = ['Relâmpago', 'Faísca', 'Abelha', 'Ametista', 'Tornado', 'Akpetinha', 'Foguete', 'Cometa'];
const DIFF = [[0.8, 0.86], [0.88, 0.95], [0.96, 1.01]];
const LAPS = [1, 3, 5];
const CUP_PTS = [10, 8, 6, 5, 4, 3, 2, 1], CUP_MIN = 2, CUP_MAX = 5;   // campeonato multijogador: pontos por posição, 2 a 5 pistas
const trackOk = t => typeof t === 'string' && /^[a-z0-9-]{2,20}$/.test(t);
// ---------- ranking online ----------
// RANK[pista] = [{ cid, name, car, mode: 'solo'|'mp', items: bool, laps, total, lap, date }]
//   um registro por jogador+nome+modo+itens+nº de voltas da corrida:
//   total = melhor tempo de corrida completa com 'laps' voltas (null se ainda não completou), lap = melhor volta nessas corridas
//   laps 0 = voltas antigas (antes da v1.4) sem nº de voltas conhecido
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data'), RANK_FILE = path.join(DATA, 'ranking.json');   // DATA_DIR: disco persistente
const UP_URL = (process.env.UPSTASH_REDIS_REST_URL || '').replace(/\/$/, ''), UP_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
const UP_KEY = 'kartrush:rank:';
let RANK = {}, rankDirty = new Set(), rankSaveT = null;
const validTrack = t => typeof t === 'string' && /^[a-z0-9-]{2,20}$/.test(t);
const upstash = cmd => fetch(UP_URL, { method: 'POST', headers: { Authorization: 'Bearer ' + UP_TOKEN, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) })
  .then(r => r.json()).then(j => { if (j.error) throw new Error(j.error); return j.result; });
const LAPS_OK = LAPS;
const rankKey = e => [e.cid, e.name, e.mode, e.items, e.laps].join('|');
function rankMerge(list, x) {   // junta x no registro do mesmo jogador+nome+modo+itens+voltas (guarda o melhor de cada tempo)
  const k = rankKey(x), e = list.find(y => rankKey(y) === k);
  if (!e) { list.push(x); return true; }
  let up = false;
  if (x.total && (!e.total || x.total < e.total)) { e.total = x.total; up = true; }
  if (x.lap && (!e.lap || x.lap < e.lap)) { e.lap = x.lap; up = true; }
  if (up) { e.car = x.car; e.date = Math.max(e.date || 0, x.date || 0); }
  return up;
}
function rankNormalize(obj) {   // aceita os formatos antigos (v1.0: só solo sem itens; v1.1–1.3: registros separados de volta e de corrida)
  const out = {};
  for (const [t, list] of Object.entries(obj || {})) if (validTrack(t) && Array.isArray(list)) {
    const L = out[t] = [];
    for (const e of list) {
      if (!e || !e.cid) continue;
      const base = { cid: e.cid, name: e.name || 'Piloto', car: e.car | 0, mode: e.mode === 'mp' ? 'mp' : 'solo', items: !!e.items, date: e.date || 0 };
      let laps, total = null, lap = null;
      if ('kind' in e || !('lap' in e || 'total' in e)) {   // formato antigo
        if (!(e.time > 0)) continue;
        if (e.kind === 'race') { laps = e.laps | 0; total = e.time; } else { laps = 0; lap = e.time; }
      } else { laps = e.laps | 0; total = e.total > 0 ? e.total : null; lap = e.lap > 0 ? e.lap : null; }
      if (laps && !LAPS_OK.includes(laps)) continue;
      if (!total && !lap) continue;
      rankMerge(L, { ...base, laps, total, lap });
    }
  }
  return out;
}
async function rankLoad() {
  if (UP_URL && UP_TOKEN) {
    try {
      const keys = await upstash(['KEYS', UP_KEY + '*']) || [];
      if (keys.length) { const vals = await upstash(['MGET', ...keys]); keys.forEach((k, i) => { try { RANK[k.slice(UP_KEY.length)] = JSON.parse(vals[i]); } catch (e) { } }); }
      RANK = rankNormalize(RANK); console.log(`ranking: Upstash (${keys.length} pistas)`); return;
    } catch (e) { console.error('ranking: Upstash indisponível, usando arquivo —', e.message); }
  }
  try { RANK = rankNormalize(JSON.parse(fs.readFileSync(RANK_FILE, 'utf8'))); } catch (e) { RANK = {}; }
  console.log('ranking: arquivo ' + RANK_FILE + (UP_URL ? '' : ' (no Render gratuito ele some quando o servidor reinicia — configure o Upstash)'));
}
function rankSave(track) {
  rankDirty.add(track); clearTimeout(rankSaveT);
  rankSaveT = setTimeout(() => {
    const dirty = [...rankDirty]; rankDirty.clear();
    if (UP_URL && UP_TOKEN) {
      const cmd = ['MSET']; for (const t of dirty) cmd.push(UP_KEY + t, JSON.stringify(RANK[t] || []));
      upstash(cmd).catch(e => { console.error('ranking (Upstash):', e.message); dirty.forEach(t => rankDirty.add(t)); });
    }
    try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(RANK_FILE, JSON.stringify(RANK)); } catch (e) { console.error('ranking:', e.message); }
  }, 1500);
}
// filtro: mode 'all'|'solo'|'mp', items 'all'|'with'|'without', laps 0 (todas) | 1 | 3 | 5, sort 'total' | 'lap'
// cada jogador (cid+nome) aparece uma vez: o registro dele que tem o melhor tempo na ordenação escolhida
// (com "todas as voltas" a ordem é sempre pela melhor volta: tempos de corrida com nº de voltas diferente não se comparam)
const rankVal = (e, sort) => (sort === 'total' ? e.total : e.lap) || Infinity;
function rankFiltered(track, f) {
  const best = new Map();
  for (const e of RANK[track] || []) {
    if (f.mode !== 'all' && e.mode !== f.mode) continue;
    if (f.items === 'with' && !e.items) continue;
    if (f.items === 'without' && e.items) continue;
    if (f.laps && e.laps !== f.laps) continue;
    if (rankVal(e, f.sort) === Infinity) continue;
    const k = e.cid + '|' + e.name, o = best.get(k);
    if (!o || rankVal(e, f.sort) < rankVal(o, f.sort)) best.set(k, e);
  }
  return [...best.values()].sort((a, b) => rankVal(a, f.sort) - rankVal(b, f.sort) || a.date - b.date);
}
const rankOut = (e, cid) => ({ name: e.name, car: e.car, mode: e.mode, items: e.items, laps: e.laps, total: e.total, lap: e.lap, date: e.date, me: !!cid && e.cid === cid });
function rankFilter(m) {
  const laps = LAPS_OK.includes(+m.laps) ? +m.laps : 0;
  return { mode: ['solo', 'mp'].includes(m.mode) ? m.mode : 'all', items: ['with', 'without'].includes(m.items) ? m.items : 'all', laps,
           sort: laps && m.sort !== 'lap' ? 'total' : 'lap' };
}
function rankView(track, cid, f = rankFilter({}), n = 10) {
  const all = rankFiltered(track, f), i = cid ? all.findIndex(e => e.cid === cid) : -1;
  return { track, laps: f.laps, sort: f.sort, list: all.slice(0, n).map(e => rankOut(e, cid)), total: all.length, pos: i >= 0 ? i + 1 : null, mine: i >= 0 ? rankVal(all[i], f.sort) : null };
}
function rankAll(cid, f) {   // recorde de cada pista (com o filtro)
  const out = {};
  for (const t of Object.keys(RANK)) { const all = rankFiltered(t, f); if (all.length) out[t] = { ...rankOut(all[0], cid), count: all.length }; }
  return out;
}
// kind 'lap': volta completada (time = tempo da volta); kind 'race': corrida completada (time = tempo total); laps = nº de voltas da corrida
function rankPut(track, cid, name, time, car, mode, items, kind, laps) {
  if (!validTrack(track) || !cid || !LAPS_OK.includes(laps) || !(time >= 20 && time <= (kind === 'race' ? 900 * laps : 900))) return false;
  const list = RANK[track] || (RANK[track] = []), t = +time.toFixed(3);
  const improved = rankMerge(list, { cid, name, car, mode, items, laps, total: kind === 'race' ? t : null, lap: kind === 'race' ? null : t, date: Date.now() });
  if (!improved) return false;
  // limite por pista: os 60 melhores de cada combinação modo+itens+voltas, por tempo total e por melhor volta
  if (list.length > 900) {
    const groups = new Map();
    for (const x of list) { const g = x.mode + x.items + x.laps; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(x); }
    const keep = new Set();
    for (const g of groups.values()) for (const s of ['total', 'lap']) g.slice().sort((a, b) => rankVal(a, s) - rankVal(b, s)).slice(0, 60).forEach(x => { if (rankVal(x, s) < Infinity) keep.add(x); });
    RANK[track] = list.filter(x => keep.has(x));
  }
  rankSave(track); return true;
}

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/api/ranking')) {   // também por HTTP: /api/ranking (recorde de cada pista) ou /api/ranking/<pista>?mode=solo|mp&items=with|without&laps=1|3|5&sort=total|lap
    const t = url.slice(13), q = Object.fromEntries(new URLSearchParams(req.url.split('?')[1] || '')), f = rankFilter(q), ok = !t || validTrack(t);
    res.writeHead(ok ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(!ok ? { error: 'pista inválida' } : t ? rankView(t, null, f) : rankAll(null, f)));
  }
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  if (url === '/') url = '/index.html';
  const file = path.join(PUBLIC, path.normalize(url));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('não encontrado'); }
    const ext = path.extname(file).toLowerCase();
    const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.glb': 'model/gltf-binary', '.webp': 'image/webp', '.png': 'image/png', '.ogg': 'audio/ogg', '.json': 'application/json' };
    // modelos, texturas e sons mudam só a cada versão: o navegador guarda por 1 dia (a página sempre é conferida)
    res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
    res.end(data);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });

const clients = new Set();
const rooms = new Map();
let nextClient = 1, nextRoom = 1;
const now = () => Date.now();
const rnd = (a, b) => a + Math.random() * (b - a);
const clean = (s, n) => String(s || '').replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, n);

function send(c, type, data = {}) { if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ type, ...data })); }
function roomPublic(r) {
  const host = r.players.find(p => p.id === r.admin);
  return { id: r.id, name: r.name, host: host ? host.name : '', track: r.settings.track, laps: r.settings.laps, fill: r.settings.fill, items: !!r.settings.items,
           count: r.players.length, max: r.settings.max, state: r.state, locked: !!r.password,
           cup: r.settings.cup.on ? { n: r.settings.cup.n, race: r.cup ? r.cup.race : 0, run: !!r.cup } : null };
}
function roomFull(r) {
  return { ...roomPublic(r), admin: r.admin, settings: r.settings,
           members: r.players.map(p => ({ id: p.id, name: p.name, car: p.car, livery: p.livery, ready: p.ready, ping: p.ping })),
           chat: r.chat.slice(-40),
           cupRun: r.cup ? { ids: r.cup.ids, race: r.cup.race, table: cupTable(r) } : null, lastCup: r.lastCup || null };
}
// classificação do campeonato: pontos, depois vitórias, depois melhor última corrida
function cupTable(r) {
  const C = r.cup || r.lastCupRaw; if (!C) return [];
  return Object.keys(C.info).map(id => ({ id, ...C.info[id], pts: C.pts[id] || 0, wins: C.wins[id] || 0, last: C.last[id] || 99 }))
    .sort((a, b) => b.pts - a.pts || b.wins - a.wins || a.last - b.last);
}
function broadcastRooms() { const list = [...rooms.values()].map(roomPublic); for (const c of clients) if (!c.room) send(c, 'rooms', { list }); }
function broadcastRoom(r) { const room = roomFull(r); for (const p of r.players) send(p, 'room', { room }); }
function sys(r, text) { r.chat.push({ sys: true, text, t: now() }); if (r.chat.length > 80) r.chat.splice(0, r.chat.length - 80); }
function toRoom(r, type, data, except) { const msg = JSON.stringify({ type, ...data }); for (const p of r.players) if (p !== except && p.ws.readyState === 1) p.ws.send(msg); }

function validSettings(s, old) {
  const o = old || { track: 'random', laps: 3, diff: 1, fill: true, max: 8, items: false, cup: { on: false, n: 4, random: true, tracks: [] } };
  const n = { ...o, cup: { ...o.cup } };
  if (s.cup && typeof s.cup === 'object') {
    if (typeof s.cup.on === 'boolean') n.cup.on = s.cup.on;
    if (+s.cup.n >= CUP_MIN && +s.cup.n <= CUP_MAX) n.cup.n = Math.floor(+s.cup.n);
    if (typeof s.cup.random === 'boolean') n.cup.random = s.cup.random;
    if (Array.isArray(s.cup.tracks)) n.cup.tracks = s.cup.tracks.slice(0, CUP_MAX).map(t => trackOk(t) ? t : 'kartpoint');
  }
  if (typeof s.track === 'string' && /^[a-z0-9-]{2,20}$/.test(s.track)) n.track = s.track;
  if (LAPS.includes(+s.laps)) n.laps = +s.laps;
  if ([0, 1, 2].includes(+s.diff)) n.diff = +s.diff;
  if (typeof s.fill === 'boolean') n.fill = s.fill;
  if (typeof s.items === 'boolean') n.items = s.items;
  if (+s.max >= 2 && +s.max <= MAX_KARTS) n.max = Math.floor(+s.max);
  return n;
}

function joinRoom(c, r) {
  if (c.room) leaveRoom(c, 'saiu');
  c.room = r; c.ready = false; r.players.push(c);
  sys(r, `${c.name} entrou na sala`);
  send(c, 'joined', { room: roomFull(r) });
  broadcastRoom(r); broadcastRooms();
}
function leaveRoom(c, why) {
  const r = c.room; if (!r) return;
  r.players = r.players.filter(p => p !== c); c.room = null; c.ready = false;
  if (!r.players.length) { clearTimeout(r.timer); clearTimeout(r.loadTimer); rooms.delete(r.id); broadcastRooms(); return; }
  if (r.admin === c.id) { r.admin = r.players[0].id; sys(r, `${r.players[0].name} agora é o admin`); }
  sys(r, `${c.name} ${why}`);
  if (r.race) {
    toRoom(r, 'left', { id: c.id, admin: r.admin });
    r.race.left.add(c.id);
    if (r.state === 'loading') maybeCountdown(r);
    if (r.state === 'race') maybeEnd(r);
  }
  broadcastRoom(r); broadcastRooms();
}

function startRace(c, msg) {
  const r = c.room;
  if (!r || r.admin !== c.id || r.state !== 'lobby') return;
  const notReady = r.players.filter(p => p.id !== r.admin && !p.ready);
  if (notReady.length) return send(c, 'error', { msg: `Aguardando: ${notReady.map(p => p.name).join(', ')}` });
  let track = r.settings.track;
  if (track === 'random') track = trackOk(msg.track) ? msg.track : 'kartpoint';
  const humans = r.players.map(p => ({ id: p.id, name: p.name, car: p.car, livery: p.livery, bot: false }));
  const nBots = r.settings.fill ? Math.max(0, MAX_KARTS - humans.length) : 0;
  // campeonato: na 1ª corrida define as pistas (escolhidas pelo admin ou sorteadas pelo cliente dele) e os bots, que ficam os mesmos até o fim
  const cs = r.settings.cup;
  if (cs.on && !r.cup) {
    const sent = Array.isArray(msg.cupIds) ? msg.cupIds : [];
    let ids = cs.random || cs.tracks.length < cs.n ? sent : cs.tracks;
    ids = ids.slice(0, cs.n).filter(trackOk);
    if (ids.length < cs.n) return send(c, 'error', { msg: cs.random ? 'Não foi possível sortear as pistas.' : `Escolha as ${cs.n} pistas do campeonato.` });
    r.cup = { ids, race: 0, pts: {}, wins: {}, last: {}, info: {}, bots: null, laps: r.settings.laps };
    r.lastCup = null; r.lastCupRaw = null;
  }
  const makeBots = (n, taken) => {
    const out = [];
    // bots usam primeiro os carros que nenhum humano escolheu (8 carros = 8 vagas, sem repetir quando possível)
    const free = [...Array(CARS).keys()].filter(ci => !taken.some(h => h.car === ci)).sort(() => Math.random() - 0.5);
    for (let i = 0; i < n; i++) {
      const car = free.length ? free.shift() : Math.floor(Math.random() * CARS);
      out.push({ id: 'b' + (i + 1), name: CAR_NAMES[car] + (out.some(b => b.car === car) ? ' ' + (i + 1) : ''), car, livery: 'padrao', bot: true,
                 skill: +rnd(...DIFF[r.settings.diff]).toFixed(3), pers: { aggr: +Math.random().toFixed(2), def: +Math.random().toFixed(2), err: +((0.25 + Math.random() * 0.75) * [1, 0.65, 0.35][r.settings.diff]).toFixed(2) } });
    }
    return out;
  };
  let bots, grid;
  if (r.cup) {
    if (!r.cup.bots) r.cup.bots = makeBots(MAX_KARTS - 1, humans);
    bots = r.cup.bots.slice(0, nBots);
    track = r.cup.ids[r.cup.race];
    // da 2ª corrida em diante quem tem menos pontos larga na frente
    grid = [...humans, ...bots].sort(() => Math.random() - 0.5);
    if (r.cup.race > 0) grid.sort((a, b) => (r.cup.pts[a.id] || 0) - (r.cup.pts[b.id] || 0));
  } else {
    bots = makeBots(nBots, humans);
    grid = [...humans, ...bots].sort(() => Math.random() - 0.5);
  }
  r.state = 'loading';
  r.race = { track, laps: r.settings.laps, diff: r.settings.diff, items: !!r.settings.items, grid, loaded: new Set(), left: new Set(), finish: {}, states: {}, flagAt: null, t0: null, goAt: 0 };
  for (const p of r.players) p.ready = false;
  const cupMsg = r.cup ? { race: r.cup.race, total: r.cup.ids.length, ids: r.cup.ids } : null;
  sys(r, (cupMsg ? `Campeonato, corrida ${cupMsg.race + 1} de ${cupMsg.total}: ` : 'Corrida iniciada: ') + `${track}, ${r.settings.laps} volta(s)${r.settings.items ? ', com itens' : ''}`);
  toRoom(r, 'raceStart', { race: { track, laps: r.race.laps, diff: r.race.diff, items: r.race.items, grid, cup: cupMsg } });
  r.loadTimer = setTimeout(() => beginCountdown(r), 25000);   // quem não carregou em 25 s entra atrasado
  broadcastRooms();
}
function maybeCountdown(r) {
  if (r.state !== 'loading') return;
  if (r.players.every(p => r.race.loaded.has(p.id))) beginCountdown(r);
}
function beginCountdown(r) {
  if (!r.race || r.state !== 'loading') return;
  clearTimeout(r.loadTimer);
  r.state = 'race'; r.race.t0 = now() + 4500; r.race.goAt = +rnd(3.4, 4.0).toFixed(2);
  toRoom(r, 'countdown', { t0: r.race.t0, goAt: r.race.goAt });
  // limite de segurança: volta mais lenta ~ 2,2 min por volta
  r.timer = setTimeout(() => endRace(r), (r.race.laps * 130 + 60) * 1000);
  broadcastRooms();
}
function maybeEnd(r) {
  if (!r.race || r.state !== 'race') return;
  const grid = r.race.grid.filter(g => !r.race.left.has(g.id));
  if (grid.every(g => r.race.finish[g.id])) endRace(r);
}
function endRace(r) {
  if (!r.race || r.state !== 'race') return;
  clearTimeout(r.timer); clearTimeout(r.flagTimer);
  const R = r.race, res = R.grid.map(g => {
    const st = R.states[g.id], f = R.finish[g.id];
    return { id: g.id, name: g.name, car: g.car, bot: g.bot, left: R.left.has(g.id), time: f ? f.time : null, best: f ? f.best : (st ? st.best : null), progress: st ? st.progress : -1e9 };
  });
  res.sort((a, b) => (a.left - b.left) || ((a.time === null) - (b.time === null)) || (a.time !== null ? a.time - b.time : b.progress - a.progress));
  let cupInfo = null;
  if (r.cup) {   // soma os pontos (quem saiu da corrida não pontua nela)
    const C = r.cup;
    res.forEach((e, i) => {
      e.pts = e.left ? 0 : (CUP_PTS[i] || 0);
      C.pts[e.id] = (C.pts[e.id] || 0) + e.pts; C.last[e.id] = i + 1; if (i === 0 && !e.left) C.wins[e.id] = (C.wins[e.id] || 0) + 1;
      C.info[e.id] = { name: e.name, car: e.car, bot: !!e.bot };
    });
    C.race++;
    const done = C.race >= C.ids.length, table = cupTable(r);
    cupInfo = { race: C.race, total: C.ids.length, ids: C.ids, table, done };
    if (done) { r.lastCupRaw = C; r.lastCup = { ids: C.ids, table }; r.cup = null; }
  }
  toRoom(r, 'raceEnd', { results: res, track: R.track, laps: R.laps, cup: cupInfo });
  const win = res[0]; if (win) sys(r, `Vitória de ${win.name}!`);
  if (cupInfo && cupInfo.done && cupInfo.table[0]) sys(r, `🏆 ${cupInfo.table[0].name} é o campeão!`);
  r.lastRace = { track: R.track, items: R.items, laps: R.laps, until: now() + 90000 };   // a última volta pode chegar logo depois da bandeirada
  r.state = 'lobby'; r.race = null;
  broadcastRoom(r); broadcastRooms();
}

function onMessage(c, m) {
  const r = c.room;
  switch (m.type) {
    case 'hello':
      c.name = clean(m.name, 16) || 'Piloto'; c.cid = clean(m.cid, 40);
      send(c, 'welcome', { id: c.id, time: now() });
      send(c, 'rooms', { list: [...rooms.values()].map(roomPublic) });
      break;
    case 'name': c.name = clean(m.name, 16) || c.name; if (r) broadcastRoom(r); break;
    case 'list': send(c, 'rooms', { list: [...rooms.values()].map(roomPublic) }); break;
    case 'ping': send(c, 'pong', { t: m.t, s: now() }); break;
    case 'rtt': c.ping = Math.max(0, Math.min(9999, Math.round(+m.ms || 0))); break;
    case 'create': {
      if (rooms.size >= MAX_ROOMS) return send(c, 'error', { msg: 'Limite de salas atingido. Tente mais tarde.' });
      const id = String(nextRoom++);
      const room = { id, name: clean(m.name, 28) || `Sala de ${c.name}`, password: clean(m.password, 20), admin: c.id, players: [], chat: [],
                     settings: validSettings(m.settings || {}), state: 'lobby', banned: new Set(), race: null };
      rooms.set(id, room);
      if (Number.isInteger(+m.car)) c.car = Math.max(0, Math.min(CARS - 1, +m.car));
      if (typeof m.livery === 'string') c.livery = clean(m.livery, 16);
      joinRoom(c, room);
      break;
    }
    case 'join': {
      const room = rooms.get(String(m.id));
      if (!room) return send(c, 'error', { msg: 'Essa sala não existe mais.' });
      if (room.state !== 'lobby') return send(c, 'error', { msg: 'A corrida já começou nessa sala. Aguarde terminar.' });
      if (room.players.length >= room.settings.max) return send(c, 'error', { msg: 'Sala cheia.' });
      if (room.banned.has(c.cid)) return send(c, 'error', { msg: 'Você foi removido dessa sala pelo admin.' });
      if (room.password && clean(m.password, 20) !== room.password) return send(c, 'error', { msg: 'Senha incorreta.', pw: true, id: room.id });
      if (Number.isInteger(+m.car)) c.car = Math.max(0, Math.min(CARS - 1, +m.car));
      if (typeof m.livery === 'string') c.livery = clean(m.livery, 16);
      joinRoom(c, room);
      break;
    }
    case 'leave': if (r) { leaveRoom(c, 'saiu da sala'); send(c, 'left-ok'); send(c, 'rooms', { list: [...rooms.values()].map(roomPublic) }); } break;
    case 'car':
      if (!r) return;
      if (Number.isInteger(+m.car)) c.car = Math.max(0, Math.min(CARS - 1, +m.car));
      if (typeof m.livery === 'string') c.livery = clean(m.livery, 16);
      broadcastRoom(r); break;
    case 'ready': if (r && r.state === 'lobby') { c.ready = !!m.v; broadcastRoom(r); } break;
    case 'settings':
      if (r && r.admin === c.id && r.state === 'lobby') {
        const old = r.settings;
        r.settings = validSettings(m.settings || {}, r.settings);
        if (r.cup) for (const k of ['track', 'laps', 'diff', 'fill', 'items', 'cup']) r.settings[k] = old[k];   // campeonato em andamento: regras travadas
        if (typeof m.name === 'string' && clean(m.name, 28)) r.name = clean(m.name, 28);
        broadcastRoom(r); broadcastRooms();
      }
      break;
    case 'kick': {
      if (!r || r.admin !== c.id) return;
      const t = r.players.find(p => p.id === m.id);
      if (!t || t === c) return;
      if (t.cid) r.banned.add(t.cid);
      send(t, 'kicked', { room: r.name });
      leaveRoom(t, 'foi removido pelo admin');
      send(t, 'rooms', { list: [...rooms.values()].map(roomPublic) });
      break;
    }
    case 'chat': if (r) { const text = clean(m.text, 120); if (text) { r.chat.push({ name: c.name, text, t: now() }); broadcastRoom(r); } } break;
    case 'start': startRace(c, m); break;
    case 'cupCancel':
      if (r && r.admin === c.id && r.state === 'lobby' && r.cup) { r.cup = null; sys(r, 'O admin cancelou o campeonato'); broadcastRoom(r); broadcastRooms(); }
      break;
    case 'loaded': if (r && r.race) { r.race.loaded.add(c.id); maybeCountdown(r); } break;
    case 'st':   // estado do próprio kart
      if (r && r.race && Array.isArray(m.k) && m.k.length <= 20) {
        r.race.states[c.id] = { progress: +m.k[12] || 0, best: m.b || null };
        toRoom(r, 'st', { id: c.id, ts: now(), k: m.k }, c);
      }
      break;
    case 'bots':  // estado dos bots (simulados pelo admin)
      if (r && r.race && r.admin === c.id && Array.isArray(m.list) && m.list.length <= MAX_KARTS) {
        for (const e of m.list) if (Array.isArray(e) && typeof e[0] === 'string') r.race.states[e[0]] = { progress: +e[13] || 0, best: null };
        toRoom(r, 'bots', { ts: now(), list: m.list }, c);
      }
      break;
    case 'fx':   // efeito de item (óleo na pista, escudo): repassa para os outros da corrida
      if (r && r.race && r.race.items && m.fx && typeof m.fx === 'object' && JSON.stringify(m.fx).length < 300) toRoom(r, 'fx', { from: c.id, fx: m.fx }, c);
      break;
    case 'rankGet': {   // track: id da pista (top 10) ou 'all' (recorde de cada pista)
      const cid = clean(m.cid, 40), f = rankFilter(m), rid = m.rid | 0;
      if (m.track === 'all') send(c, 'rank', { rid, track: 'all', all: rankAll(cid, f) });
      else if (validTrack(m.track)) send(c, 'rank', { rid, ...rankView(m.track, cid, f, Math.max(1, Math.min(10, m.n | 0 || 10))) });
      break;
    }
    case 'rankPut': {   // volta ou corrida completada pelo jogador (bots nunca enviam); no multijogador o servidor confere a corrida
      const cid = clean(m.cid, 40), name = clean(m.name, 16) || c.name || 'Piloto', car = Math.max(0, Math.min(CARS - 1, Math.floor(+m.car || 0)));
      const kind = m.kind === 'race' ? 'race' : 'lap';
      let mode = 'solo', items = !!m.items, laps = +m.laps | 0;   // laps: nº de voltas da corrida (também para as voltas)
      const R = r && r.race && r.state === 'race' ? r.race : r && r.lastRace && r.lastRace.until > now() ? r.lastRace : null;
      if (R) { if (R.track !== m.track) return; mode = 'mp'; items = !!R.items; laps = R.laps; }
      const improved = rankPut(m.track, cid, name, +m.time, car, mode, items, kind, laps);
      if (validTrack(m.track)) send(c, 'rank', { rid: m.rid | 0, ...rankView(m.track, cid, kind === 'race' ? rankFilter({ laps, sort: 'total' }) : rankFilter({})), improved, put: true, mode, items, kind, laps, name });
      break;
    }
    case 'finish': {
      if (!r || !r.race || r.state !== 'race') return;
      const g = r.race.grid.find(x => x.id === m.id);
      if (!g || (m.id !== c.id && !(g.bot && r.admin === c.id)) || r.race.finish[m.id]) return;
      r.race.finish[m.id] = { time: +m.time || 0, best: +m.best || null };
      if (!r.race.flagAt) {
        r.race.flagAt = now();
        toRoom(r, 'flag', { id: m.id, name: g.name, time: +m.time || 0 });
        r.flagTimer = setTimeout(() => endRace(r), 40000);   // 40 s depois da bandeirada a corrida termina
      }
      maybeEnd(r);
      break;
    }
  }
}

wss.on('connection', ws => {
  const c = { ws, id: 'p' + (nextClient++), name: 'Piloto', cid: '', room: null, car: 0, livery: 'padrao', ready: false, ping: 0, alive: true };
  clients.add(c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', data => { let m; try { m = JSON.parse(data); } catch (e) { return; } if (m && typeof m.type === 'string') onMessage(c, m); });
  ws.on('close', () => { clients.delete(c); if (c.room) leaveRoom(c, 'desconectou'); });
});
setInterval(() => { for (const c of clients) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch (e) { } } }, 15000);
setInterval(() => { for (const r of rooms.values()) if (r.state === 'lobby') broadcastRoom(r); }, 4000);   // atualiza o ping na sala

rankLoad().finally(() => server.listen(PORT, () => console.log(`Kart Rush: http://localhost:${PORT}  (WebSocket em /ws)`)));
