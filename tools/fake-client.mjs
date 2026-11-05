/* 테스트용 접속자 — 계정 생성/로그인 → WS 접속 → 지정 좌표에서 걷기/채팅.
 * 사용: node tools/fake-client.mjs <email> <nickname> <prof> <x> <z> [seconds]
 */
import { createRequire } from 'node:module';
const { WebSocket } = createRequire(import.meta.url)('../server/node_modules/ws');

const [email = 'guest01@town.test', nickname = '访客', prof = 'student-u', x = '6', z = '-12', seconds = '20'] = process.argv.slice(2);
const API = process.env.TOWN_API || 'http://127.0.0.1:8787';
const pass = 'townpass1234';

async function call(path, body) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

let login = await call('/api/login', { email, password: pass });
if (login.status !== 200) login = await call('/api/register', { email, password: pass, nickname, prof, color: '#3f8f6a' });
if (!login.body.token) { console.error('login failed', login); process.exit(1); }

const ws = new WebSocket(`${API.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(login.body.token)}`);
const me = { x: Number(x), z: Number(z), h: 0 };
let t = 0;

ws.on('open', () => console.log('[fake] connected', login.body.user.nickname, login.body.user.prof));
ws.on('message', raw => {
  const msg = JSON.parse(raw.toString());
  if (msg.t === 'welcome') {
    me.x = Number(x); me.z = Number(z);
    console.log('[fake] welcome zone=', msg.zone && msg.zone.name, 'online=', msg.online);
    ws.send(JSON.stringify({ t: 'pos', x: me.x, z: me.z, h: 0, a: 'walk' }));
    setTimeout(() => ws.send(JSON.stringify({ t: 'chat', text: '안녕하세요, 같은 구역이네요' })), 1200);
    setTimeout(() => ws.send(JSON.stringify({ t: 'emote', kind: 'wave' })), 2000);
  } else if (msg.t === 'chat') {
    console.log('[fake] chat from', msg.nickname, ':', msg.text);
  }
});
const timer = setInterval(() => {
  t += 0.12;
  me.x += Math.sin(t) * 0.25;
  me.z += Math.cos(t * 0.7) * 0.25;
  if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'pos', x: me.x, z: me.z, h: t, a: 'walk' }));
}, 120);
setTimeout(() => { clearInterval(timer); ws.close(); console.log('[fake] done'); process.exit(0); }, Number(seconds) * 1000);
