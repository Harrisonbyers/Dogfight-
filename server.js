'use strict';
/*
 * Dogfight multiplayer server. Zero dependencies (Node 18+).
 * - Serves index.html (the game) over HTTP.
 * - Speaks WebSocket (hand-rolled RFC 6455) on the same port.
 * - Rooms: players in the same room see each other. The server relays state,
 *   gunfire, hits and deaths; each client simulates its own aircraft.
 */
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8080', 10);
const MAX_PLAYERS = 12;
const MAX_FRAME = 16 * 1024;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const ENV_OK = {
  map: ['isles', 'dunes', 'alps', 'arctic', 'city', 'war', 'canyon'],
  year: [1940, 1942, 1944, 1945, 1950, 1960, 1970, 1980, 1990, 2000],
  time: ['dawn', 'noon', 'dusk', 'night'],
  weather: ['clear', 'overcast', 'fog', 'storm']
};
const rooms = new Map();
let nextId = 1;

/* ---------- http ---------- */
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/' || url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('index.html not found next to server.js'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found');
});

/* ---------- websocket ---------- */
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  socket.setNoDelay(true);
  const c = { socket, buf: Buffer.alloc(0), frag: [], fragOp: 0, player: null, alive: true, rate: { t: Date.now(), n: 0 } };
  socket.on('data', d => {
    c.buf = Buffer.concat([c.buf, d]);
    try { readFrames(c); } catch (e) { kill(c); }
  });
  socket.on('close', () => drop(c));
  socket.on('error', () => drop(c));
});

function sendFrame(socket, op, payload) {
  if (socket.destroyed) return;
  const len = payload.length;
  let head;
  if (len < 126) head = Buffer.from([0x80 | op, len]);
  else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  socket.write(Buffer.concat([head, payload]));
}
function sendJSON(c, obj) { sendFrame(c.socket, 1, Buffer.from(JSON.stringify(obj))); }
function kill(c) { try { c.socket.destroy(); } catch (e) {} drop(c); }

function readFrames(c) {
  for (;;) {
    const b = c.buf;
    if (b.length < 2) return;
    const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); off = 10; }
    if (!masked || len > MAX_FRAME) { kill(c); return; }
    if (b.length < off + 4 + len) return;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    c.buf = b.subarray(off + 4 + len);
    if (op === 8) { sendFrame(c.socket, 8, Buffer.alloc(0)); kill(c); return; }
    if (op === 9) { sendFrame(c.socket, 10, payload); continue; }
    if (op === 10) continue;
    if (op === 1 || op === 2 || op === 0) {
      if (op !== 0) { c.frag = []; c.fragOp = op; }
      c.frag.push(payload);
      if (c.frag.reduce((n, p) => n + p.length, 0) > MAX_FRAME) { kill(c); return; }
      if (fin) {
        const whole = Buffer.concat(c.frag); c.frag = [];
        if (c.fragOp === 1) onText(c, whole.toString('utf8'));
      }
    }
  }
}

/* ---------- rooms and relay ---------- */
const clean = (s, n) => String(s == null ? '' : s).replace(/[^A-Za-z0-9 _\-]/g, '').slice(0, n);
const num = v => (typeof v === 'number' && isFinite(v)) ? v : 0;

function sanitizeEnv(e) {
  e = e || {};
  const o = {};
  for (const k of Object.keys(ENV_OK)) o[k] = ENV_OK[k].indexOf(e[k]) >= 0 ? e[k] : ENV_OK[k][k === 'year' ? 2 : 0];
  return o;
}

function onText(c, text) {
  const now = Date.now();
  if (now - c.rate.t > 1000) { c.rate.t = now; c.rate.n = 0; }
  if (++c.rate.n > 90) return;
  let m; try { m = JSON.parse(text); } catch (e) { return; }
  if (!m || typeof m.t !== 'string') return;
  const p = c.player;

  if (m.t === 'join') {
    if (p) return;
    const code = clean(m.room, 12).toUpperCase() || 'LOBBY';
    let room = rooms.get(code);
    if (!room) { room = { code, players: new Map(), env: sanitizeEnv(m.env) }; rooms.set(code, room); }
    if (room.players.size >= MAX_PLAYERS) { sendJSON(c, { t: 'err', m: 'Room ' + code + ' is full' }); return; }
    const used = new Set(); let blue = 0, red = 0;
    room.players.forEach(q => { used.add(q.slot); if (q.side === 'blue') blue++; else red++; });
    let slot = 0; while (used.has(slot)) slot++;
    const side = blue < red ? 'blue' : red < blue ? 'red' : (slot % 2 === 0 ? 'blue' : 'red');
    const pl = { id: nextId++, c, room, name: clean(m.name, 14) || 'Pilot' + slot, side, slot, k: clean(m.k, 12) || 'spit' };
    c.player = pl; room.players.set(pl.id, pl);
    const peers = [];
    room.players.forEach(q => { if (q !== pl) peers.push({ id: q.id, name: q.name, side: q.side, slot: q.slot, k: q.k }); });
    sendJSON(c, { t: 'welcome', id: pl.id, room: room.code, side, slot, env: room.env, peers });
    broadcast(room, pl, { t: 'join', id: pl.id, name: pl.name, side, slot, k: pl.k });
    log('join', room.code, pl.name, '(' + room.players.size + ')');
    return;
  }
  if (!p) return;

  if (m.t === 's') {
    if (!Array.isArray(m.p) || !Array.isArray(m.q) || !Array.isArray(m.v)) return;
    p.k = clean(m.k, 12) || p.k;
    broadcast(p.room, p, {
      t: 's', id: p.id, k: p.k,
      p: [num(m.p[0]), num(m.p[1]), num(m.p[2])],
      q: [num(m.q[0]), num(m.q[1]), num(m.q[2]), num(m.q[3])],
      v: [num(m.v[0]), num(m.v[1]), num(m.v[2])],
      sp: num(m.sp), th: num(m.th), hp: num(m.hp), g: m.g ? 1 : 0, nz: num(m.nz)
    });
  } else if (m.t === 'shot') {
    if (!Array.isArray(m.b)) return;
    const b = m.b.slice(0, 12).filter(a => Array.isArray(a) && a.length === 6).map(a => a.map(num));
    if (b.length) broadcast(p.room, p, { t: 'shot', id: p.id, b });
  } else if (m.t === 'hit') {
    const target = p.room.players.get(m.to);
    if (!target || target === p || target.side === p.side) return;
    sendJSON(target.c, { t: 'hit', from: p.id, d: Math.min(Math.max(num(m.d), 0), 120) });
  } else if (m.t === 'died') {
    broadcast(p.room, p, { t: 'died', id: p.id, by: p.room.players.has(m.by) ? m.by : null });
  } else if (m.t === 'p') {
    sendJSON(c, { t: 'p', ts: num(m.ts) });
  }
}

function broadcast(room, from, obj) {
  const frame = Buffer.from(JSON.stringify(obj));
  room.players.forEach(q => { if (q !== from) sendFrame(q.c.socket, 1, frame); });
}

function drop(c) {
  if (!c.alive) return;
  c.alive = false;
  const p = c.player;
  if (!p) return;
  const room = p.room;
  room.players.delete(p.id);
  broadcast(room, p, { t: 'leave', id: p.id });
  log('leave', room.code, p.name, '(' + room.players.size + ')');
  if (!room.players.size) rooms.delete(room.code);
}

function log() { console.log(new Date().toISOString(), ...arguments); }

setInterval(() => {
  rooms.forEach(r => r.players.forEach(q => sendFrame(q.c.socket, 9, Buffer.alloc(0))));
}, 20000);

if (require.main === module) {
  server.listen(PORT, () => log('dogfight server listening on', PORT));
}
module.exports = { server, rooms };
