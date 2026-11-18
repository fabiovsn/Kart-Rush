// Kart Rush v1.0 — servidor multijogador
//  - serve o jogo (public/index.html) e o WebSocket em /ws
//  - salas: lista, criar, entrar (com senha opcional), sair, admin expulsa / configura / inicia
//  - corrida: grid com humanos + bots (completa até 8), largada sincronizada pelo relógio do servidor,
//    retransmissão do estado de cada kart (~20x/s), bandeirada, resultado final e volta para a sala
//  - itens (opção da sala): retransmite os efeitos (óleo na pista, escudo) para todos da corrida
//  - ranking online por pista: melhor volta de cada jogador (corridas sem itens), salvo em data/ranking.json
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 8080;
const PUBLIC = path.join(__dirname, 'public');
const MAX_KARTS = 8, MAX_ROOMS = 60, CARS = 8;
const CAR_NAMES = ['Relâmpago', 'Faísca', 'Abelha', 'Ametista', 'Tornado', 'Akpetinha', 'Foguete', 'Cometa'];
const DIFF = [[0.8, 0.86], [0.88, 0.95], [0.96, 1.01]];
const LAPS = [1, 3, 5];
// ---------- ranking online (melhor volta por pista, um registro por jogador) ----------
const DATA = process.env.DATA_DIR || path.join(__dirname, 'data'), RANK_FILE = path.join(DATA, 'ranking.json');   // DATA_DIR: disco persistente (Render)
let RANK = {};
try { RANK = JSON.parse(fs.readFileSync(RANK_FILE, 'utf8')) || {}; } catch (e) { RANK = {}; }
let rankSaveT = null;
function rankSave() {
  clearTimeout(rankSaveT);
  rankSaveT = setTimeout(() => { try { fs.mkdirSync(DATA, { recursive: true }); fs.writeFileSync(RANK_FILE, JSON.stringify(RANK)); } catch (e) { console.error('ranking:', e.message); } }, 1500);
}
const validTrack = t => typeof t === 'string' && /^[a-z0-9-]{2,20}$/.test(t);
function rankView(track, cid) {
  const all = (RANK[track] || []).slice().sort((a, b) => a.time - b.time);
  const i = cid ? all.findIndex(e => e.cid === cid) : -1;
  return { track, list: all.slice(0, 10).map(e => ({ name: e.name, time: e.time, car: e.car, date: e.date })), total: all.length, pos: i >= 0 ? i + 1 : null, mine: i >= 0 ? all[i].time : null };
}
function rankPut(track, cid, name, time, car) {
  if (!validTrack(track) || !cid || !(time >= 20 && time <= 900)) return false;
  const list = RANK[track] || (RANK[track] = []);
  const e = list.find(x => x.cid === cid);
  let improved = false;
  if (!e) { list.push({ cid, name, time: +time.toFixed(3), car, date: Date.now() }); improved = true; }
  else { e.name = name; if (time < e.time) { e.time = +time.toFixed(3); e.car = car; e.date = Date.now(); improved = true; } }
  if (list.length > 500) { list.sort((a, b) => a.time - b.time); list.length = 500; }
  rankSave(); return improved;
}

const server = http.createServer((req, res) => {
  let url = decodeURIComponent(req.url.split('?')[0]);
  if (url.startsWith('/api/ranking/')) {   // também por HTTP: /api/ranking/<pista>
    const t = url.slice(13); res.writeHead(validTrack(t) ? 200 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
    return res.end(JSON.stringify(validTrack(t) ? rankView(t) : { error: 'pista inválida' }));
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
           count: r.players.length, max: r.settings.max, state: r.state, locked: !!r.password };
}
function roomFull(r) {
  return { ...roomPublic(r), admin: r.admin, settings: r.settings,
           members: r.players.map(p => ({ id: p.id, name: p.name, car: p.car, livery: p.livery, ready: p.ready, ping: p.ping })),
           chat: r.chat.slice(-40) };
}
function broadcastRooms() { const list = [...rooms.values()].map(roomPublic); for (const c of clients) if (!c.room) send(c, 'rooms', { list }); }
function broadcastRoom(r) { const room = roomFull(r); for (const p of r.players) send(p, 'room', { room }); }
function sys(r, text) { r.chat.push({ sys: true, text, t: now() }); if (r.chat.length > 80) r.chat.splice(0, r.chat.length - 80); }
function toRoom(r, type, data, except) { const msg = JSON.stringify({ type, ...data }); for (const p of r.players) if (p !== except && p.ws.readyState === 1) p.ws.send(msg); }

function validSettings(s, old) {
  const o = old || { track: 'random', laps: 3, diff: 1, fill: true, max: 8, items: false };
  const n = { ...o };
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
  if (track === 'random') track = typeof msg.track === 'string' && /^[a-z0-9-]{2,20}$/.test(msg.track) ? msg.track : 'kartpoint';
  const humans = r.players.map(p => ({ id: p.id, name: p.name, car: p.car, livery: p.livery, bot: false }));
  const nBots = r.settings.fill ? Math.max(0, MAX_KARTS - humans.length) : 0;
  const bots = [];
  // bots usam primeiro os carros que nenhum humano escolheu (8 carros = 8 vagas, sem repetir quando possível)
  const free = [...Array(CARS).keys()].filter(ci => !humans.some(h => h.car === ci)).sort(() => Math.random() - 0.5);
  for (let i = 0; i < nBots; i++) {
    const car = free.length ? free.shift() : Math.floor(Math.random() * CARS);
    bots.push({ id: 'b' + (i + 1), name: CAR_NAMES[car] + (bots.some(b => b.car === car) ? ' ' + (i + 1) : ''), car, livery: 'padrao', bot: true,
                skill: +rnd(...DIFF[r.settings.diff]).toFixed(3), pers: { aggr: +Math.random().toFixed(2), def: +Math.random().toFixed(2), err: +((0.25 + Math.random() * 0.75) * [1, 0.65, 0.35][r.settings.diff]).toFixed(2) } });
  }
  const grid = [...humans, ...bots].sort(() => Math.random() - 0.5);
  r.state = 'loading';
  r.race = { track, laps: r.settings.laps, diff: r.settings.diff, items: !!r.settings.items, grid, loaded: new Set(), left: new Set(), finish: {}, states: {}, flagAt: null, t0: null, goAt: 0 };
  for (const p of r.players) p.ready = false;
  sys(r, `Corrida iniciada: ${track}, ${r.settings.laps} volta(s)${r.settings.items ? ', com itens' : ''}`);
  toRoom(r, 'raceStart', { race: { track, laps: r.race.laps, diff: r.race.diff, items: r.race.items, grid } });
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
  toRoom(r, 'raceEnd', { results: res, track: R.track, laps: R.laps });
  const win = res[0]; if (win) sys(r, `Vitória de ${win.name}!`);
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
        r.settings = validSettings(m.settings || {}, r.settings);
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
    case 'rankGet': if (validTrack(m.track)) send(c, 'rank', rankView(m.track, clean(m.cid, 40))); break;
    case 'rankPut': {
      const cid = clean(m.cid, 40), name = clean(m.name, 16) || c.name || 'Piloto', car = Math.max(0, Math.min(CARS - 1, Math.floor(+m.car || 0)));
      const improved = rankPut(m.track, cid, name, +m.time, car);
      if (validTrack(m.track)) send(c, 'rank', { ...rankView(m.track, cid), improved, put: true });
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

server.listen(PORT, () => console.log(`Kart Rush: http://localhost:${PORT}  (WebSocket em /ws)`));
