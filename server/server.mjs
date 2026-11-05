/* 大连town 서버 — 정적 파일 + 자체 계정(JWT) + WebSocket 접속자 동기화.
 *
 *   node server/server.mjs
 *
 * 의존성: ws (npm i). Node 22 내장 node:sqlite 사용.
 * 환경변수: PORT(8787) / JWT_SECRET / DB_PATH / TOWN_ROOT
 * 설계 원칙: 서버는 "사람"만 압니다. NPC 1000명·건물·연출은 전부 클라이언트에서
 * 시드로 결정되므로 동기화할 필요가 없습니다.
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.TOWN_ROOT || path.resolve(HERE, '..');

// ── .env (선택) ─────────────────────────────────────────────────────────────
const envFile = path.join(HERE, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || path.join(HERE, 'data', 'town.db');
const JWT_SECRET = process.env.JWT_SECRET || '';
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[fatal] JWT_SECRET 이 없거나 짧습니다. server/.env 에 32자 이상으로 넣어 주세요.');
  console.error('        예: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  process.exit(1);
}

// ── DB ──────────────────────────────────────────────────────────────────────
mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS users (
    id         TEXT PRIMARY KEY,
    email      TEXT UNIQUE NOT NULL,
    pass_hash  TEXT NOT NULL,
    salt       TEXT NOT NULL,
    nickname   TEXT NOT NULL,
    prof       TEXT NOT NULL DEFAULT 'office',
    color      TEXT NOT NULL DEFAULT '#3f7fb0',
    created_at INTEGER NOT NULL,
    seen_at    INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    jti     TEXT PRIMARY KEY,
    uid     TEXT NOT NULL,
    created INTEGER NOT NULL,
    ua      TEXT
  );
`);
const q = {
  byEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  nickTaken: db.prepare('SELECT 1 FROM users WHERE nickname = ? AND id <> ?'),
  insert: db.prepare(`INSERT INTO users (id,email,pass_hash,salt,nickname,prof,color,created_at,seen_at)
                      VALUES (?,?,?,?,?,?,?,?,?)`),
  update: db.prepare('UPDATE users SET nickname = ?, prof = ?, color = ?, seen_at = ? WHERE id = ?'),
  seen: db.prepare('UPDATE users SET seen_at = ? WHERE id = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM users'),
  addSession: db.prepare('INSERT INTO sessions (jti,uid,created,ua) VALUES (?,?,?,?)'),
  dropSession: db.prepare('DELETE FROM sessions WHERE jti = ?'),
  hasSession: db.prepare('SELECT 1 FROM sessions WHERE jti = ?'),
};

// ── 인증 ────────────────────────────────────────────────────────────────────
// 마을 주민 모델 20종과 같은 직업 키를 씁니다(클라이언트 resident-*-model.js 와 일치).
const PROFESSIONS = new Set([
  'office', 'worker', 'shopkeeper', 'driver', 'teacher', 'clerk', 'officer',
  'school-admin', 'medical-doc', 'medical-nurse', 'hosp-admin', 'sanitation',
  'student-p', 'student-m', 'student-u', 'preschooler', 'unemployed',
  'retiree', 'senior', 'patient',
]);
const PALETTE = new Set(['#3f7fb0', '#c2554a', '#3f8f6a', '#8a6bb5', '#c98a2e', '#2f6f86', '#a8547a', '#4d6b3f']);
const b64u = buf => Buffer.from(buf).toString('base64url');
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

function sign(payload) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}
function verify(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const want = crypto.createHmac('sha256', JWT_SECRET).update(`${parts[0]}.${parts[1]}`).digest('base64url');
  const a = Buffer.from(parts[2]);
  const b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch { return null; }
  if (!claims || claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}
function publicUser(row) {
  return { id: row.id, email: row.email, nickname: row.nickname, prof: row.prof, color: row.color };
}

// ── 입력 검증 ───────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{2,}\.[^\s@]{2,}$/;
const NICK_RE = /^[\p{Script=Han}\p{Script=Hangul}A-Za-z0-9_·-]{2,12}$/u;
function cleanNick(value) {
  const nick = String(value || '').trim().replace(/\s+/g, '');
  if (!NICK_RE.test(nick)) throw new Error('닉네임은 2~12자(한글·한자·영문·숫자·_·-)만 됩니다.');
  if (/^(관리자|admin|운영자|system)$/i.test(nick)) throw new Error('사용할 수 없는 닉네임입니다.');
  return nick;
}

// ── HTTP ────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
};
const attempts = new Map();
function limited(ip, max = 20, windowMs = 60_000) {
  const now = Date.now();
  const rec = attempts.get(ip) || { n: 0, t: now };
  if (now - rec.t > windowMs) { rec.n = 0; rec.t = now; }
  rec.n += 1;
  attempts.set(ip, rec);
  return rec.n > max;
}
function send(res, code, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // 정적 페이지는 GitHub Pages 에서, 계정·WebSocket 만 이 서버에서 쓰기 때문에
    // 브라우저가 다른 출처에서 API 를 부를 수 있어야 합니다(토큰은 헤더로만 오갑니다).
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-max-age': '600',
    ...headers,
  });
  res.end(data);
}
async function readJson(req, limit = 8 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('JSON 형식이 아닙니다.'); }
}
function clientIp(req) {
  const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
  return (Array.isArray(fwd) ? fwd[0] : String(fwd || '').split(',')[0]).trim() || req.socket.remoteAddress || '?';
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = clientIp(req);

  try {
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return send(res, 204, '');
      if (req.method === 'POST' && url.pathname === '/api/register') {
        if (limited(ip)) return send(res, 429, { error: '잠시 후 다시 시도해 주세요.' });
        const b = await readJson(req);
        const email = String(b.email || '').trim().toLowerCase();
        const password = String(b.password || '');
        if (!EMAIL_RE.test(email)) return send(res, 400, { error: '이메일 형식이 아닙니다.' });
        if (password.length < 8) return send(res, 400, { error: '비밀번호는 8자 이상이어야 합니다.' });
        if (q.byEmail.get(email)) return send(res, 409, { error: '이미 가입된 이메일입니다.' });
        const nickname = cleanNick(b.nickname);
        if (q.nickTaken.get(nickname, '-')) return send(res, 409, { error: '이미 사용 중인 닉네임입니다.' });
        const prof = PROFESSIONS.has(b.prof) ? b.prof : 'office';
        const color = PALETTE.has(b.color) ? b.color : '#3f7fb0';
        const salt = crypto.randomBytes(16).toString('hex');
        const id = crypto.randomUUID();
        const now = Date.now();
        q.insert.run(id, email, hash(password, salt), salt, nickname, prof, color, now, now);
        const jti = crypto.randomUUID();
        q.addSession.run(jti, id, now, String(req.headers['user-agent'] || '').slice(0, 120));
        const token = sign({ uid: id, jti, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 60 * 60 * 24 * 30 });
        const row = q.byId.get(id);
        return send(res, 201, { token, user: publicUser(row) });
      }

      if (req.method === 'POST' && url.pathname === '/api/login') {
        if (limited(ip)) return send(res, 429, { error: '잠시 후 다시 시도해 주세요.' });
        const b = await readJson(req);
        const email = String(b.email || '').trim().toLowerCase();
        const row = q.byEmail.get(email);
        if (!row) return send(res, 401, { error: '이메일 또는 비밀번호가 맞지 않습니다.' });
        const given = Buffer.from(hash(String(b.password || ''), row.salt), 'hex');
        const saved = Buffer.from(row.pass_hash, 'hex');
        if (given.length !== saved.length || !crypto.timingSafeEqual(given, saved)) {
          return send(res, 401, { error: '이메일 또는 비밀번호가 맞지 않습니다.' });
        }
        q.seen.run(Date.now(), row.id);
        const jti = crypto.randomUUID();
        const nowSec = Math.floor(Date.now() / 1000);
        q.addSession.run(jti, row.id, Date.now(), String(req.headers['user-agent'] || '').slice(0, 120));
        const token = sign({ uid: row.id, jti, iat: nowSec, exp: nowSec + 60 * 60 * 24 * 30 });
        return send(res, 200, { token, user: publicUser(row) });
      }

      if (url.pathname === '/api/health') {
        return send(res, 200, {
          ok: true, users: q.count.get().n, online: players.size, rooms: cells.size,
          zones: ZONES.map(z => ({ id: z.id, count: z.count })),
          capacity: ZONES.reduce((sum, z) => sum + z.capacity, 0),
        });
      }

      if (url.pathname === '/api/zones') {
        return send(res, 200, { zones: zoneSummary(), online: players.size });
      }

      const claims = verify((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
      if (!claims) return send(res, 401, { error: '로그인이 필요합니다.' });

      if (url.pathname === '/api/me' && req.method === 'GET') {
        const row = q.byId.get(claims.uid);
        if (!row) return send(res, 404, { error: '계정이 없습니다.' });
        q.seen.run(Date.now(), row.id);
        return send(res, 200, { user: publicUser(row) });
      }

      if (url.pathname === '/api/profile' && req.method === 'POST') {
        const b = await readJson(req);
        const row = q.byId.get(claims.uid);
        if (!row) return send(res, 404, { error: '계정이 없습니다.' });
        const nickname = b.nickname === undefined ? row.nickname : cleanNick(b.nickname);
        if (q.nickTaken.get(nickname, row.id)) return send(res, 409, { error: '이미 사용 중인 닉네임입니다.' });
        const prof = PROFESSIONS.has(b.prof) ? b.prof : row.prof;
        const color = PALETTE.has(b.color) ? b.color : row.color;
        q.update.run(nickname, prof, color, Date.now(), row.id);
        broadcastProfile(row.id, { nickname, prof, color });
        return send(res, 200, { user: publicUser(q.byId.get(row.id)) });
      }

      if (url.pathname === '/api/logout' && req.method === 'POST') {
        q.dropSession.run(claims.jti);
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: '없는 API입니다.' });
    }

    // 정적 파일 — 서버 코드·DB·비밀값은 절대 내보내지 않습니다.
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.resolve(ROOT, '.' + rel);
    if (!file.startsWith(ROOT + path.sep)) return send(res, 403, { error: 'forbidden' });
    if (/(^|[\\/])(server|\.git|node_modules)([\\/]|$)/.test(path.relative(ROOT, file)) || /(^|[\\/])\.env/.test(file)) {
      return send(res, 404, { error: 'not found' });
    }
    if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { error: 'not found' });
    const ext = path.extname(file).toLowerCase();
    const longCache = /\.(png|jpg|webp|ico|svg|woff2|glb)$/.test(ext);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': longCache ? 'public, max-age=86400' : 'no-cache',
      'cross-origin-opener-policy': 'same-origin',
    });
    createReadStream(file).pipe(res);
  } catch (error) {
    send(res, 400, { error: error.message || '요청 처리 실패' });
  }
});

// ── 접속자 동기화 ───────────────────────────────────────────────────────────
const WORLD = 560;            // 마을 반경(플랜 좌표 기준 여유값)
const CELL = 100;             // 공간 해시 셀
const SEE = 120;              // 이 거리 안의 사람만 서로 보입니다(같은 존 안에서만)
const HEAR = 120;             // 채팅 반경
const SEND_HZ = 8;            // 서버 브로드캐스트 상한(클라이언트는 보간으로 부드럽게 그림)
const STILL_EPS = 0.01;       // 이보다 덜 움직였으면 위치 패킷을 보내지 않습니다
const ZONE_SPAN = (WORLD * 2) / 3;   // 3x3 존 한 칸의 폭
const ZONE_CAP = 130;         // 존 정원 — 9존 × 130 = 1,170 (목표 1,000명 + 여유)
const ZONE_NAMES = [
  ['西北', '西北 · 住宅'], ['北 · 学园', '北 · 学园'], ['东北', '东北 · 河岸'],
  ['西 · 市场', '西 · 市场'], ['中央广场', '中央广场'], ['东 · 写字楼', '东 · 写字楼'],
  ['西南', '西南 · 公园'], ['南 · 车站', '南 · 车站'], ['东南', '东南 · 港区'],
];
const cells = new Map();      // "cx,cz" -> Set<player>
const players = new Map();    // id -> player
const wss = new WebSocketServer({ noServer: true });

// ── 존(구역) ────────────────────────────────────────────────────────────────
// 접속자는 좌표로 존이 정해지고, 위치·채팅 브로드캐스트는 같은 존 안에서만
// 일어납니다. 존 하나의 상한이 있어 1,000명이 몰려도 방송량이 선형으로 늘지 않습니다.
const ZONES = ZONE_NAMES.map(([name], i) => {
  const cx = i % 3, cz = Math.floor(i / 3);
  return {
    id: `z${i}`,
    index: i,
    name,
    x0: -WORLD + cx * ZONE_SPAN,
    z0: -WORLD + cz * ZONE_SPAN,
    x1: -WORLD + (cx + 1) * ZONE_SPAN,
    z1: -WORLD + (cz + 1) * ZONE_SPAN,
    capacity: ZONE_CAP,
    count: 0,
  };
});
const zoneById = new Map(ZONES.map(z => [z.id, z]));
function zoneAt(x, z) {
  const cx = Math.min(2, Math.max(0, Math.floor((x + WORLD) / ZONE_SPAN)));
  const cz = Math.min(2, Math.max(0, Math.floor((z + WORLD) / ZONE_SPAN)));
  return ZONES[cz * 3 + cx];
}
const zoneCenter = zone => ({ x: (zone.x0 + zone.x1) / 2, z: (zone.z0 + zone.z1) / 2 });
// 같은 존에 동시에 들어와도 한 점에 겹치지 않도록 중심 둘레에 흩어 놓습니다.
// (겹치면 서로가 서로의 시야 안에 들어와 위치 패킷이 인원수의 제곱으로 늘어납니다)
function spawnPoint(zone) {
  const center = zoneCenter(zone);
  const angle = Math.random() * Math.PI * 2;
  const radius = 14 + Math.random() * 52;
  return {
    x: Math.max(zone.x0 + 6, Math.min(zone.x1 - 6, center.x + Math.cos(angle) * radius)),
    z: Math.max(zone.z0 + 6, Math.min(zone.z1 - 6, center.z + Math.sin(angle) * radius)),
  };
}
function zoneSummary() {
  return ZONES.map(z => ({ id: z.id, name: z.name, count: z.count, capacity: z.capacity, x: (z.x0 + z.x1) / 2, z: (z.z0 + z.z1) / 2 }));
}
// 가운데(中央广场) → 상하좌우 → 모서리 순으로 채웁니다. 첫 접속자가 구석에서
// 시작하지 않도록 하는 것뿐이고, 이후에는 인원이 적은 존이 우선입니다.
const ZONE_ORDER = [4, 1, 3, 5, 7, 0, 2, 6, 8];
function leastFullZone() {
  let best = ZONES[ZONE_ORDER[0]];
  for (const index of ZONE_ORDER) {
    const z = ZONES[index];
    if (z.count < best.count) best = z;
  }
  return best;
}

const cellKey = (x, z) => `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`;
function addCell(p) {
  const k = cellKey(p.x, p.z);
  let set = cells.get(k);
  if (!set) cells.set(k, (set = new Set()));
  set.add(p);
  p.cell = k;
}
function dropCell(p) {
  const set = cells.get(p.cell);
  if (set) { set.delete(p); if (!set.size) cells.delete(p.cell); }
  p.cell = null;
}
function neighbours(p, radius) {
  const out = [];
  const cx = Math.floor(p.x / CELL), cz = Math.floor(p.z / CELL);
  const span = Math.ceil(radius / CELL);
  for (let dx = -span; dx <= span; dx++) {
    for (let dz = -span; dz <= span; dz++) {
      const set = cells.get(`${cx + dx},${cz + dz}`);
      if (!set) continue;
      for (const other of set) {
        if (other === p || other.zoneId !== p.zoneId) continue;
        const ddx = other.x - p.x, ddz = other.z - p.z;
        if (ddx * ddx + ddz * ddz <= radius * radius) out.push(other);
      }
    }
  }
  return out;
}
function zoneInfo(p) {
  const zone = zoneById.get(p.zoneId);
  return zone ? { t: 'zone', id: zone.id, name: zone.name, count: zone.count, capacity: zone.capacity } : null;
}
function enterZone(p, zone) {
  p.zoneId = zone.id;
  zone.count += 1;
}
function leaveZone(p) {
  const zone = zoneById.get(p.zoneId);
  if (zone) zone.count = Math.max(0, zone.count - 1);
  p.zoneId = null;
}
function zonePeers(p) {
  const out = [];
  for (const other of players.values()) {
    if (other !== p && other.zoneId === p.zoneId) out.push(other);
  }
  return out;
}
function tell(target, msg) {
  if (target.ws.readyState === 1) {
    target.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
}
function broadcastProfile(uid, patch) {
  const p = players.get(uid);
  if (!p) return;
  Object.assign(p, patch);
  for (const other of neighbours(p, SEE)) tell(other, { t: 'who', id: p.id, ...patch });
}

function onMessage(p, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (!msg || typeof msg.t !== 'string') return;

  if (msg.t === 'pos') {
    const x = Number(msg.x), z = Number(msg.z), h = Number(msg.h);
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    p.x = Math.max(-WORLD, Math.min(WORLD, x));
    p.z = Math.max(-WORLD, Math.min(WORLD, z));
    p.h = Number.isFinite(h) ? h : p.h;
    p.anim = typeof msg.a === 'string' ? msg.a.slice(0, 12) : p.anim;
    const k = cellKey(p.x, p.z);
    if (k !== p.cell) { dropCell(p); addCell(p); }

    // 존 경계를 넘으면 이전 존 사람들에게서 사라지고 새 존 사람들에게 나타납니다.
    const zone = zoneAt(p.x, p.z);
    if (zone.id !== p.zoneId) {
      const oldPeers = zonePeers(p);
      if (p.zoneId) for (const other of oldPeers) tell(other, { t: 'leave', id: p.id });
      leaveZone(p);
      enterZone(p, zone);
      const hello = { t: 'join', id: p.id, nickname: p.nickname, prof: p.prof, color: p.color, x: p.x, z: p.z, h: p.h };
      for (const other of zonePeers(p)) tell(other, hello);
      tell(p, zoneInfo(p));
    }

    // 서 있는 사람은 아무에게도 패킷을 보내지 않습니다(마을에 1,000명이 있어도
    // 실제로 걷는 사람 수만큼만 트래픽이 발생).
    const moved = p.sentX === undefined
      || (p.x - p.sentX) ** 2 + (p.z - p.sentZ) ** 2 > STILL_EPS * STILL_EPS
      || p.anim !== p.sentAnim;
    if (!moved) return;
    const now = Date.now();
    if (now - p.lastSend < 1000 / SEND_HZ - 8) return;
    p.lastSend = now;
    p.sentX = p.x; p.sentZ = p.z; p.sentAnim = p.anim;
    // 한 번만 직렬화해 여러 명에게 그대로 보냅니다(수신자 수만큼 stringify 하지 않음).
    const packet = JSON.stringify({ t: 'pos', id: p.id, x: +p.x.toFixed(2), z: +p.z.toFixed(2), h: +p.h.toFixed(2), a: p.anim });
    for (const other of neighbours(p, SEE)) tell(other, packet);
    return;
  }

  if (msg.t === 'chat') {
    const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!text) return;
    const now = Date.now();
    if (now - (p.lastChat || 0) < 1200) return;
    p.lastChat = now;
    const packet = JSON.stringify({ t: 'chat', id: p.id, nickname: p.nickname, text });
    tell(p, packet);
    for (const other of neighbours(p, HEAR)) tell(other, packet);
    return;
  }

  if (msg.t === 'emote') {
    const kind = String(msg.kind || '').slice(0, 12);
    if (!['wave', 'jump', 'dance'].includes(kind)) return;
    const packet = { t: 'emote', id: p.id, kind };
    tell(p, packet);
    for (const other of neighbours(p, SEE)) tell(other, packet);
  }
}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname !== '/ws') return socket.destroy();
  const claims = verify(url.searchParams.get('token') || '');
  if (!claims) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  const row = q.byId.get(claims.uid);
  if (!row) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, row));
});

wss.on('connection', (ws, req, row) => {
  if (players.has(row.id)) {
    const old = players.get(row.id);
    try { old.ws.close(4000, 'same account'); } catch {}
    leaveZone(old);
    dropCell(old);
    players.delete(row.id);
  }
  // 빈 존부터 채워 넣습니다 — 1,000명이 한 점에 몰려도 존마다 상한이 지켜집니다.
  const zone = leastFullZone();
  const spot = spawnPoint(zone);
  const p = {
    id: row.id, nickname: row.nickname, prof: row.prof, color: row.color,
    ws, x: spot.x, z: spot.z, h: 0, anim: 'idle', cell: null,
    zoneId: null, lastSend: 0, lastChat: 0,
    ip: clientIp(req), joined: Date.now(),
  };
  enterZone(p, zone);
  addCell(p);
  players.set(p.id, p);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const nearby = neighbours(p, SEE).map(o => ({ id: o.id, nickname: o.nickname, prof: o.prof, color: o.color, x: o.x, z: o.z, h: o.h, a: o.anim }));
  tell(p, {
    t: 'welcome', id: p.id, nickname: p.nickname, x: p.x, z: p.z, h: p.h, now: Date.now(),
    online: players.size, players: nearby,
    spawn: { x: p.x, z: p.z }, zone: zoneInfo(p), zones: zoneSummary(),
  });
  const hello = { t: 'join', id: p.id, nickname: p.nickname, prof: p.prof, color: p.color, x: p.x, z: p.z, h: p.h };
  for (const other of neighbours(p, SEE)) tell(other, hello);

  ws.on('message', raw => onMessage(p, raw.toString()));
  ws.on('close', () => {
    const peers = zonePeers(p);
    players.delete(p.id);
    leaveZone(p);
    dropCell(p);
    for (const other of peers) tell(other, { t: 'leave', id: p.id });
  });
  ws.on('error', () => {});
});

// 죽은 소켓 청소 + 접속자 수 주기 알림
const sweeper = setInterval(() => {
  for (const p of players.values()) {
    if (!p.ws.isAlive) { p.ws.terminate(); continue; }
    p.ws.isAlive = false;
    try { p.ws.ping(); } catch {}
  }
}, 30_000);
const heartbeat = setInterval(() => {
  const summary = zoneSummary();
  for (const p of players.values()) tell(p, { t: 'online', n: players.size, zones: summary });
}, 15_000);

server.listen(PORT, () => {
  console.log(`[大连town] http://localhost:${PORT}  (static: ${ROOT})`);
  console.log(`[大连town] ws://localhost:${PORT}/ws  · DB ${DB_PATH}`);
});
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    clearInterval(sweeper); clearInterval(heartbeat);
    for (const p of players.values()) { try { p.ws.close(1001, 'server stop'); } catch {} }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
