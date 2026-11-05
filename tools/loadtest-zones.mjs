/* 1,000명 동시 접속 + 존 분할 검증.
 *
 *   node tools/loadtest-zones.mjs [count]
 *
 * 서버가 켜져 있어야 합니다. 부하용 계정은 DB에 직접 넣고(비밀번호 해시 없이)
 * 서버와 같은 JWT_SECRET 으로 토큰만 서명합니다. 비밀값은 출력하지 않습니다.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const require = createRequire(import.meta.url);
const { WebSocket } = require('../server/node_modules/ws');

const COUNT = Number(process.argv[2] || 1000);
const WALK = process.argv[3] === 'walk';
const API = process.env.TOWN_API || 'http://127.0.0.1:8787';
const HERE = path.resolve(new URL('.', import.meta.url).pathname, '..');

// ── 비밀값: server/.env 에서 읽기만 하고 절대 출력하지 않습니다 ──────────────
const env = {};
for (const line of readFileSync(path.join(HERE, 'server/.env'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
const SECRET = env.JWT_SECRET;
const DB_PATH = env.DB_PATH || path.join(HERE, 'server', 'data', 'town.db');
if (!SECRET) { console.error('JWT_SECRET 없음'); process.exit(1); }

const b64u = buf => Buffer.from(buf).toString('base64url');
function sign(payload) {
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

// ── 부하 계정 준비 ──────────────────────────────────────────────────────────
const db = new DatabaseSync(DB_PATH);
const insert = db.prepare(`INSERT OR IGNORE INTO users (id,email,pass_hash,salt,nickname,prof,color,created_at,seen_at)
                           VALUES (?,?,?,?,?,?,?,?,?)`);
const PROF = ['office', 'worker', 'shopkeeper', 'driver', 'teacher', 'clerk', 'officer',
  'school-admin', 'medical-doc', 'medical-nurse', 'hosp-admin', 'sanitation',
  'student-p', 'student-m', 'student-u', 'preschooler', 'unemployed', 'retiree', 'senior', 'patient'];
const COLOR = ['#3f7fb0', '#c2554a', '#3f8f6a', '#8a6bb5', '#c98a2e', '#2f6f86', '#a8547a', '#4d6b3f'];
const now = Date.now();
const users = [];
const pickId = db.prepare('SELECT id FROM users WHERE email = ?');
for (let i = 0; i < COUNT; i++) {
  const email = `load${i}@town.test`;
  const nick = `L${String(i).padStart(4, '0')}`;
  insert.run(crypto.randomUUID(), email, '00'.repeat(64), '00'.repeat(16), nick, PROF[i % PROF.length], COLOR[i % COLOR.length], now, now);
  const { id } = pickId.get(email);          // 재실행 시 기존 행의 id를 그대로 씁니다
  const jti = crypto.randomUUID();
  users.push({ id, nick, token: sign({ uid: id, jti, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 3600 }) });
}
db.close();

// ── 접속 ────────────────────────────────────────────────────────────────────
const stats = { open: 0, failed: 0, welcomes: 0, zones: {}, msgs: 0, sent: 0, errors: [] };
const sockets = [];
const t0 = Date.now();

function startWalk(ws, spawn) {
  let x = spawn.x, z = spawn.z, t = Math.random() * 6.28;
  const timer = setInterval(() => {
    if (ws.readyState !== 1) return clearInterval(timer);
    t += 0.15;
    x += Math.sin(t) * 0.6;                 // 초당 ~1.2m 산책
    z += Math.cos(t * 0.7) * 0.6;
    stats.sent++;
    ws.send(JSON.stringify({ t: 'pos', x: +x.toFixed(2), z: +z.toFixed(2), h: t, a: 'walk' }));
  }, 100);                                   // 10Hz
  walkers.add(timer);
}
const walkers = new Set();

function connect(u) {
  return new Promise(resolve => {
    const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(u.token)}`);
    let settled = false;
    const done = ok => { if (!settled) { settled = true; resolve(ok); } };
    ws.on('open', () => { stats.open++; });
    ws.on('message', raw => {
      stats.msgs++;
      let m; try { m = JSON.parse(raw.toString()); } catch { return; }
      if (m.t === 'welcome') {
        stats.welcomes++;
        const key = m.zone ? m.zone.name : '(none)';
        stats.zones[key] = (stats.zones[key] || 0) + 1;
        if (WALK) startWalk(ws, m.spawn || { x: m.x, z: m.z });
        done(true);
      }
    });
    ws.on('error', err => { stats.failed++; if (stats.errors.length < 5) stats.errors.push(err.message); done(false); });
    ws.on('close', code => { if (!settled && code !== 1000) { stats.failed++; done(false); } });
    sockets.push(ws);
  });
}

(async () => {
  for (let i = 0; i < users.length; i += 100) {
    const batch = users.slice(i, i + 100);
    await Promise.all(batch.map(connect));
    // 서버가 몰려든 접속을 소화할 시간
    await new Promise(r => setTimeout(r, 60));
    process.stdout.write(`  · ${Math.min(i + 100, users.length)}/${users.length} 접속\n`);
  }
  const connectMs = Date.now() - t0;

  // 8초 관찰 — 하트비트/온라인 알림 포함 실제 수신량
  const before = stats.msgs;
  const sentBefore = stats.sent;
  await new Promise(r => setTimeout(r, 8000));
  const msgsInWatch = stats.msgs - before;
  const sentInWatch = stats.sent - sentBefore;

  let health = {};
  try { health = await (await fetch(`${API}/api/health`)).json(); } catch {}

  console.log(JSON.stringify({
    requested: COUNT,
    opened: stats.open,
    welcomed: stats.welcomes,
    failed: stats.failed,
    errors: stats.errors,
    connectMs,
    zoneDistribution: stats.zones,
    serverHealth: { online: health.online, capacity: health.capacity, zones: health.zones },
    receiveRate: {
      totalMsgsPerSec: +(msgsInWatch / 8).toFixed(1),
      perClientPerSec: +(msgsInWatch / 8 / Math.max(1, stats.welcomes)).toFixed(3),
      sentPerSec: +(sentInWatch / 8).toFixed(1),
      walk: WALK,
    },
    rssMb: +(process.memoryUsage().rss / 1048576).toFixed(0),
  }, null, 1));

  for (const timer of walkers) clearInterval(timer);
  for (const ws of sockets) { try { ws.close(1000, 'done'); } catch {} }
  setTimeout(() => process.exit(stats.failed ? 1 : 0), 600);
})();
