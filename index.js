const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

const LEVELS = [
  {
    name: 'Seviye 1',
    spawn: { fire: [5.1, 9.1], water: [6.0, 9.1] },
    grid: [
      '####################',
      '#..................#',
      '#...............fw.#',
      '#..............#####',
      '#..................#',
      '#..........####....#',
      '#..................#',
      '#.....####.........#',
      '#..................#',
      '#####..............#',
      '#..................#',
      '#######LLL##WWW#GG##',
    ],
  },
];

const W = 0.7, H = 0.9;
const SPEED = 6, JUMP = 12, GRAV = 28, MAXFALL = 20;
const DT = 1 / 60;

const rooms = new Map();

function makeCode() {
  const abc = 'ABCDEFGHJKLMNPRSTUVYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => abc[Math.floor(Math.random() * abc.length)]).join(''); }
  while (rooms.has(c));
  return c;
}

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function tile(lv, c, r) {
  if (r < 0 || c < 0 || r >= lv.grid.length || c >= lv.grid[0].length) return '#';
  return lv.grid[r][c];
}

function hitSolid(lv, x, y) {
  for (let r = Math.floor(y); r <= Math.floor(y + H - 1e-6); r++)
    for (let c = Math.floor(x); c <= Math.floor(x + W - 1e-6); c++)
      if (tile(lv, c, r) === '#') return { c, r };
  return null;
}

function stepPlayer(lv, p, inp) {
  p.vx = ((inp.right ? 1 : 0) - (inp.left ? 1 : 0)) * SPEED;
  if (inp.jump && p.onGround) { p.vy = -JUMP; p.onGround = false; }
  p.vy = Math.min(p.vy + GRAV * DT, MAXFALL);

  p.x += p.vx * DT;
  let h = hitSolid(lv, p.x, p.y);
  if (h) p.x = p.vx > 0 ? h.c - W - 0.001 : h.c + 1 + 0.001;

  p.y += p.vy * DT;
  p.onGround = false;
  h = hitSolid(lv, p.x, p.y);
  if (h) {
    if (p.vy > 0) { p.y = h.r - H - 0.001; p.onGround = true; }
    else p.y = h.r + 1 + 0.001;
    p.vy = 0;
  }
}

function deadly(lv, p, role) {
  const bad = role === 'fire' ? 'WG' : 'LG';
  const m = 0.12;
  for (let r = Math.floor(p.y + m); r <= Math.floor(p.y + H - m); r++)
    for (let c = Math.floor(p.x + m); c <= Math.floor(p.x + W - m); c++)
      if (bad.includes(tile(lv, c, r))) return true;
  return false;
}

function atDoor(lv, p, role) {
  const ch = role === 'fire' ? 'f' : 'w';
  return tile(lv, Math.floor(p.x + W / 2), Math.floor(p.y + H / 2)) === ch;
}

function lobbyInfo(room) {
  const taken = { fire: false, water: false };
  room.players.forEach((pl) => { if (pl.role) taken[pl.role] = true; });
  room.players.forEach((pl) =>
    send(pl.ws, { t: 'lobby', code: room.code, taken, you: pl.role, count: room.players.length })
  );
}

function resetLevel(room) {
  const lv = LEVELS[room.level];
  room.phys = {};
  for (const role of ['fire', 'water']) {
    const [x, y] = lv.spawn[role];
    room.phys[role] = { x, y, vx: 0, vy: 0, onGround: false };
  }
  room.state = 'play';
  room.who = null;
}

function startGame(room) {
  resetLevel(room);
  const lv = LEVELS[room.level];
  room.players.forEach((pl) => send(pl.ws, { t: 'start', grid: lv.grid, name: lv.name, you: pl.role }));
}

function tick() {
  for (const room of rooms.values()) {
    if (room.state === 'lobby') continue;
    const lv = LEVELS[room.level];
    if (room.state === 'play') {
      const inputs = { fire: {}, water: {} };
      room.players.forEach((pl) => { inputs[pl.role] = pl.input; });
      for (const role of ['fire', 'water']) {
        stepPlayer(lv, room.phys[role], inputs[role]);
        if (deadly(lv, room.phys[role], role)) { room.state = 'dead'; room.who = role; room.timer = 90; }
      }
      if (room.state === 'play' && atDoor(lv, room.phys.fire, 'fire') && atDoor(lv, room.phys.water, 'water')) {
        room.state = 'won';
      }
    } else if (room.state === 'dead' && --room.timer <= 0) {
      resetLevel(room);
    }
    const f = room.phys.fire, w = room.phys.water;
    const msg = {
      t: 's',
      f: [+f.x.toFixed(3), +f.y.toFixed(3)],
      w: [+w.x.toFixed(3), +w.y.toFixed(3)],
      st: room.state,
      who: room.who,
    };
    room.players.forEach((pl) => send(pl.ws, msg));
  }
}
setInterval(tick, 1000 / 60);

function leave(ws) {
  const room = ws.room;
  if (!room) return;
  room.players = room.players.filter((p) => p.ws !== ws);
  ws.room = null;
  if (room.players.length === 0) { rooms.delete(room.code); return; }
  room.state = 'lobby';
  room.players.forEach((p) => { p.role = null; p.input = {}; });
  lobbyInfo(room);
}

const httpServer = http.createServer((req, res) => {
  try {
    const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  } catch {
    res.writeHead(500); res.end('index.html bulunamadı');
  }
});
const wss = new WebSocketServer({ server: httpServer });
httpServer.listen(PORT);

wss.on('connection', (ws) => {
  ws.room = null;
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }

    if (m.t === 'create') {
      leave(ws);
      const room = { code: makeCode(), players: [], state: 'lobby', level: 0, phys: null };
      rooms.set(room.code, room);
      room.players.push({ ws, role: null, input: {} });
      ws.room = room;
      lobbyInfo(room);
    } else if (m.t === 'join') {
      const room = rooms.get(String(m.code || '').toUpperCase().trim());
      if (!room) return send(ws, { t: 'err', msg: 'Oda bulunamadı.' });
      if (room.players.length >= 2) return send(ws, { t: 'err', msg: 'Oda dolu.' });
      leave(ws);
      room.players.push({ ws, role: null, input: {} });
      ws.room = room;
      lobbyInfo(room);
    } else if (m.t === 'pick' && ws.room) {
      const room = ws.room;
      if (room.state !== 'lobby' || !['fire', 'water'].includes(m.role)) return;
      const me = room.players.find((p) => p.ws === ws);
      const other = room.players.find((p) => p.ws !== ws);
      if (other && other.role === m.role) return send(ws, { t: 'err', msg: 'Bu seçeneği diğer oyuncu aldı.' });
      me.role = m.role;
      lobbyInfo(room);
      if (room.players.length === 2 && room.players.every((p) => p.role)) startGame(room);
    } else if (m.t === 'input' && ws.room) {
      const me = ws.room.players.find((p) => p.ws === ws);
      if (me) me.input = { left: !!m.left, right: !!m.right, jump: !!m.jump };
    } else if (m.t === 'next' && ws.room && ws.room.state === 'won') {
      ws.room.level = (ws.room.level + 1) % LEVELS.length;
      startGame(ws.room);
    } else if (m.t === 'leave') {
      leave(ws);
    }
  });
  ws.on('close', () => leave(ws));
});

console.log(`Su ve Ateş sunucusu ${PORT} portunda çalışıyor`);
