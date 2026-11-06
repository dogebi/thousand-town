# 다중접속(thousand-town) 코드 리뷰 — 2026-11-06

대상: `server/server.mjs`(562줄), `multiplayer.js`(826줄), `multiplayer.css`(184줄),
`index.html`(멀티 관련 24줄), `tools/*`
기준 커밋: 9593183
실측 환경: WSL2 / Node v22.22.2 / 로컬 부하테스트(tools/loadtest-zones.mjs)

실측 수치 요약
- 1,000 동시접속: welcomed 1000/1000, 실패 0, 1.67초, 존당 111~112명, 서버 RSS ~71MB
- 100명 이동(존당 11명): 클라당 50.4 msg/s, 서버 5,038 msg/s 수신
- 아바타 1명당 메시 30~39개(tools/verify-avatars.mjs)
- 20개 동시 로그인 중 /api/health 최대 지연 637ms(평상시 2ms)
- 로그아웃 후에도 같은 토큰으로 /api/me 200
- 같은 계정 2번 접속 시 서버 online=0, 실제 소켓은 살아 있음

---

## P0 — 지금 고쳐야 하는 버그 (근거: 재현됨)

### 1. 중복 접속 시 새 접속자가 서버 맵에서 삭제됨 (고스트 플레이어)
`server/server.mjs:495-502`, `528-534`

```js
if (players.has(row.id)) {
  const old = players.get(row.id);
  try { old.ws.close(4000, 'same account'); } catch {}
  leaveZone(old); dropCell(old); players.delete(row.id);   // 500-501
}
...
ws.on('close', () => {
  const peers = zonePeers(p);
  players.delete(p.id);            // 530 ← 옛 소켓의 close가 나중에 실행됨
```

옛 소켓의 `close` 이벤트는 비동기로 나중에 도착한다. 그 시점의 `players` 에는 **새** 플레이어가
들어 있으므로, `players.delete(p.id)` 가 새 접속자를 지운다. 재현 결과:

```
aClosed: {code: 4000, reason: 'same account'}
serverOnline: 0          ← 소켓은 살아 있는데 online 0
serverZones: [{id:'z4', count:1}]   ← 존 카운터만 남음
```

영향: 새로고침 1번이면 그 사람은 `players` 에 없으므로 ①`/api/health` online 이 틀리고
②30초 스위퍼(`539-545`)가 ping 하지 않아 죽은 소켓이 회수되지 않고 ③`zonePeers()` 기반
존 이동 알림에서 빠져 다른 사람에게 나타나지 않는다.

수정(1줄):
```js
ws.on('close', () => { if (players.get(p.id) !== p) return; ... });
```

### 2. 로그아웃이 토큰을 무효화하지 않음
`server/server.mjs:95-107`(verify), `74`(hasSession 미사용), `255-258`(logout)

`/api/logout` 은 sessions 행만 지우고, `verify()` 는 서명+exp 만 본다. 그래서 토큰은
30일간 그대로 유효하다. 실측: `logout 200 → /api/me 200`.

수정: `verify()` 에서 jti 를 세션 테이블과 대조(요청마다 SQLite 조회는 1만 접속에서 부담이므로
메모리 LRU 캐시 + 로그아웃 시 즉시 무효 집합 추가), 만료 세션 주기 삭제.

### 3. close 코드를 무시하는 재접속 루프
`multiplayer.js:329-334`

```js
socket.onclose = () => {
  const delay = Math.min(15000, 1200 * Math.pow(1.8, state.retry++));
  setTimeout(() => { if (state.token) connect(); }, delay);
};
```
- code 4000(중복 로그인) → 두 탭이 서로를 무한히 끊는 전쟁
- code 1008/401(토큰 만료·폐기) → 죽은 토큰으로 영원히 재시도

수정: `event.code === 4000` → "다른 곳에서 접속했습니다" 안내 후 중단,
`4000/1008` → 토큰 삭제 + 로그인 패널.

### 4. 배포 주소 하드코딩이 죽어 있음
`multiplayer.js:12`, `262-267`

```js
const REMOTE_API = 'https://town.cijyun.com';
```
`town.cijyun.com` 은 DNS 조회 자체가 안 된다(실측 `getent hosts` 없음, curl 000).
GitHub Pages 에 올리면 로그인 버튼은 영구히 "연결 끊김 · 다시 시도 중"만 반복한다.
`OFFLINE` 판정(`47`)이 `file:` 에만 반응해서 안내도 뜨지 않는다.

수정: `window.TOWN_API` 우선, 없으면 접속 실패 시 로그인 패널에 "서버 미연결" 상태를
명시하고 재시도 간격을 15s→60s 로 늘림.

---

## P1 — 확장성·성능 (실측 근거 있음)

### 5. 존 정원 130 × 시야 120m = 브로드캐스트 폭발
`server/server.mjs:286-293`(SEE=120, ZONE_CAP=130), `366-382`(neighbours), `442-455`

존 하나에 130명이 차면 시야 안에 최대 129명, 서버 상한 8Hz → 클라당 초당 1,032 패킷,
서버는 130×129×8 ≈ 134,000 pkt/s. 실측은 존당 11명(클라당 50 msg/s)이므로 인원에
거의 선형으로 늘어난다. 130명이면 클라당 ~590 msg/s.

수정(가장 효과 큰 3개, 택1 또는 조합):
- `SEE` 120 → 45~55m (존 정원 130 유지 시)
- 클라당 "가까운 N명(예: 24명)"만 전송
- 존을 9 → 25칸으로 늘려 정원 45 수준으로

### 6. 존 만원 검사가 없음
`server/server.mjs:432-440`, 클라 텔레포트 `multiplayer.js:814`

`enterZone()` 은 카운트만 올린다. 좌표만 옮기면 정원 130을 넘겨도 들어간다
(콘솔에서 `CityMP.teleport(x,z)` 한 줄로 우회). `capacity` 는 배정 힌트일 뿐이다.

수정: 이동 처리에서 `zone.count >= zone.capacity` 면 진입 거부 + 이전 좌표로 되돌림(스폰만 차단하는
현 상태로는 정원이 지켜지지 않는다).

### 7. scryptSync 로그인이 이벤트 루프를 막음
`server/server.mjs:87`

```js
const hash = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');
```
실측: 20개 동시 로그인에서 `/api/health` 지연이 2ms → 637ms. 그동안 모든 WS 패킷이 멈춘다
(로그인 1회 ≈ 25~30ms 블로킹). 로그인 폭주 = 전원 프리즈.

수정: `crypto.scrypt` 비동기(+ `util.promisify`)로 전환. libuv 스레드풀 4개가 병렬 처리.

### 8. 원격 아바타 1명당 메시 30~39개, 컬링 없음
`multiplayer.js:371`(buildAvatar), `453-468`(매 프레임 rig.update)

주민 모델을 그대로 쓰므로 1명이 30~39 draw call. 100명 시야면 +3,000~3,900 draw call
(마을 자체 draw call 위에 얹힘). 거리 컬링·LOD 없음.

수정: ①25m 밖은 경량 폴백(`buildFallbackRig`, 이미 있음) ②40m 밖 `animateAvatar` 생략
③화면 밖(프러스텀) 스킵. 실측은 GPU 있는 브라우저에서 `cityStudio.getInfo().calls` 로 확인할 것.

### 9. WebSocket 프레임 크기 제한 없음
`server/server.mjs:301`

`new WebSocketServer({ noServer: true })` — ws 기본 `maxPayload` 100MB. 한 클라이언트가
100MB 프레임을 던지면 그대로 메모리에 올라간다.

수정: `{ noServer: true, maxPayload: 1024 }` (현재 최대 메시지 ~200B).

### 10. 이모트/위치 레이트리밋 없음
`server/server.mjs:470-476`(emote), `420-456`(pos)

채팅만 1200ms 제한(`459-463`). emote 는 무제한으로 시야 내 전원에게 방송되고,
pos 는 매 메시지마다 셀 재계산 + `neighbours()` 스캔을 수행한다.

수정: emote 500ms, pos 는 접속당 초당 15개 상한(초과 시 프레임 폐기).

### 11. "정지 시 무전송" 설계가 클라에서 무력화됨
`server/server.mjs:443-447` ↔ `multiplayer.js:450-451`

```js
if (moving) sendPos(false);
else if (now - lastSend > 3000) sendPos(true);   // 3초마다 강제 전송
```
서버 주석은 "서 있는 사람은 아무에게도 패킷을 보내지 않습니다"인데, 클라가 3초마다 pos 를 쏜다.
이 keepalive 는 `multiplayer.js:465`(20초 무소식 제거) 때문에 존재한다. 존재 확인은 하트비트
(`server.mjs:546-549`)로 옮기고 pos keepalive 는 없애야 한다.

### 12. 시야에 걸어 들어온 사람이 클라에 나타나지 않음
`multiplayer.js:361-366`, 서버 `437-438`·`524-525`

서버는 `join` 을 접속 시점과 **존 이동** 시점에만 보낸다. 시야(120m)는 존(373m)보다 작으므로
"같은 존, 시야 밖 → 시야 안"으로 걸어 들어오면 `join` 이 오지 않고 `pos` 만 온다.
클라는 모르는 id 의 pos 를 버린다(`362-363`) → 그 사람은 보이지 않는다.

수정: 서버가 시야 진입을 감지해 `join` 을 보내거나(셀 단위 diff), `pos` 첫 패킷에
`nickname/prof/color` 를 실어 보낸다(패킷 +40B, 구현 30분).

### 13. 존재 판정이 렌더 루프에 묶여 있음
`multiplayer.js:403-407`, `465`, `794`

rAF 는 백그라운드 탭에서 멈춘다 → pos keepalive 도 멈춤 → 20초 뒤 다른 사람 화면에서 사라진다
(접속은 유지). 서버는 그 사람을 계속 접속자로 센다. 불일치.

수정: 제거는 서버의 `leave`/존 이탈로만. 클라 20초 타이머는 "탭 숨김" 상태에서만 유예.

### 14. 아바타 모델 190KB를 로그인 전에 항상 로드
`index.html:309-328`

주민 모델 22개 파일(계정 1,017명 중 실제 로그인 사용자만 필요)을 `defer` 로 전부 읽는다.
모바일 첫 로드에서 190KB + 22 요청이 그대로 낭비.

수정: 로그인 성공 시점에 동적 `<script>` 주입(또는 역할별 1개 파일로 번들).

### 15. 정적 파일 압축·캐시 검증 없음
`server/server.mjs:274-279`

`no-cache` + ETag/Last-Modified 없음 + gzip 없음. `index.html`(27KB) + `sketch.js`(158KB)
+ `city-scene.js`(141KB) ≈ 326KB 를 매 방문 풀로 전송(모바일 회선에서 체감 큼).

수정: `createReadStream().pipe(zlib.createGzip())` + `content-encoding`, 파일 mtime 기반 ETag 로 304.

### 16. 30일 토큰 + localStorage
`server/server.mjs:196`(exp 30일), `multiplayer.js:743`(localStorage)

XSS 한 번이면 30일짜리 세션 탈취. 로그아웃 무효화도 안 되므로(2번) 사실상 회수 불가.

수정: 액세스 1시간 + 리프레시 30일(회전), 또는 최소한 jti 검증 + 로그아웃 일괄 폐기.

---

## P2 — 정합성·운영·UX

17. `server/server.mjs:45-55` — `nickname` 에 UNIQUE 제약 없음. 중복 검사는 앱 레벨(`187`)뿐이라
    동시 가입 시 중복 가능. `CREATE UNIQUE INDEX ... COLLATE NOCASE` 필요.
18. `server/server.mjs:131-139` — `attempts` Map 이 IP별로 무한 증가, 계정 단위 제한 없음.
    IP 분산 봇에는 무력. TTL 정리 + 이메일/계정 버킷 추가.
19. `server/server.mjs:220-226` — `/api/health` 의 `rooms: cells.size` 는 공간 셀 수다(이름 오해).
    실제 "방" 개념은 아직 없다(존만 있음).
20. `server/server.mjs:546-549` — 15초마다 전 접속자에게 존 요약 직렬화·전송. 변화가 없을 때도
    보낸다. 존 카운트가 바뀔 때만 보내면 무부하 구간 트래픽 0.
21. `server/server.mjs:329-337` — 스폰이 존 중심 반경 14~52m 랜덤. 정원이 차면 겹친다.
    존 내 그리드/푸아송 분산 권장.
22. `server/server.mjs:264-271` — 경로 차단은 `resolve` 결과의 prefix 검사라 루트 내부 심볼릭 링크가
    루트 밖을 가리키면 통과한다. `fs.realpath` 검증 추가.
23. `server/server.mjs:479-486` + `multiplayer.js:265` — JWT 를 쿼리스트링으로 전달.
    Cloudflare/nginx 액세스 로그·Referer 에 남는다. `Sec-WebSocket-Protocol` 또는 첫 프레임 인증 권장.
24. `server/server.mjs:201-211` — 없는 이메일이면 즉시 401(해시 계산 생략) → 타이밍으로
    계정 존재 여부 추정 가능. 더미 해시로 동일 시간 소요시키기.
25. 이메일 인증·비밀번호 재설정 없음 → 오타/분실 시 복구 불가. `users.email` 만 있고 토큰 발송 경로 없음.
26. 모더레이션 없음 — 욕설 필터·신고·차단·채팅 로그 저장 모두 없음(`458-468`).
27. 새로고침하면 위치·존이 초기화(랜덤 스폰). 마지막 좌표를 세션/DB에 저장하면 UX 개선.
28. `multiplayer.js:513` clamp ±520 vs 서버 `WORLD` 560 — 경계 불일치(존 판정과 어긋남).
29. `multiplayer.js:781-788` — `log()` 가 innerHTML 을 받는 구조. 현재 호출부는 escape 되어 있으나
    서버 문자열을 직접 넣는 곳(`293`, `298`)이 있어 서버 오염 시 XSS 경로가 열린다. textContent 권장.
30. 접근성: 채팅 로그 `aria-live` 없음(`536`), 이모지 버튼 `aria-label` 없음(`539-541`),
    로그인 패널 포커스 트랩·`<label for>` 없음(`641-643`).
31. `multiplayer.js:683`, `701-702` — 서버 오류 문구를 그대로 노출. 내부 예외 메시지가 사용자에게 보인다.
32. `multiplayer.js:47` — `OFFLINE` 이 `file:` 에서만 true. HTTPS 배포 후 서버가 죽으면
    "서버 미연결" 안내 대신 일반 오류만 반복된다.
33. `multiplayer.js:811-822` — QA용 `teleport`/`buildAvatar` 가 프로덕션에 노출. 좌표 순간이동으로
    존 정원(6번)을 우회할 수 있다. `?qa=1` 일 때만 노출.

재현/검증 스크립트(임시, 저장소 밖):
- `/home/nttcom/.hermes/cache/scratch/town-dupe.mjs` — 중복 접속 고스트 재현
- `/home/nttcom/.hermes/cache/scratch/town-auth.mjs` — 로그아웃 무효화 + scrypt 지연 측정
- `/home/nttcom/.hermes/cache/scratch/town-stand.mjs` — 지정 좌표에 N명 세우기(렌더 부하 측정용)

---

## 우선순위 표

| 순위 | 항목 | 위치 | 근거 | 비용 |
|---|---|---|---|---|
| 1 | 중복 접속 고스트 | server.mjs:528-534 | 재현됨(online=0) | 10분 |
| 2 | 로그아웃 무효 | server.mjs:95-107, 74 | 재현됨(200) | 40분 |
| 3 | 재접속 루프 | multiplayer.js:329-334 | 코드 | 15분 |
| 4 | 배포 주소 죽음 | multiplayer.js:12 | DNS 없음 | 20분 |
| 5 | 시야/정원 브로드캐스트 | server.mjs:286-293 | 50 msg/s@11명 | 1~2h |
| 6 | 존 만원 무검사 | server.mjs:432-440 | 코드 | 30분 |
| 7 | scryptSync 블로킹 | server.mjs:87 | 637ms 실측 | 30분 |
| 8 | 아바타 draw call | multiplayer.js:371 | 30~39메시/명 | 2h |
| 9 | maxPayload | server.mjs:301 | 코드 | 5분 |
| 10 | 압축/ETag | server.mjs:274 | 326KB 매 방문 | 40분 |

## 하지 말 것
- 존 정원 상향(130→200+): 5번이 그대로 커져 서버·클라 모두 죽는다.
- 아바타 모델을 원격마다 새로 빌드하는 구조 유지한 채 인원만 늘리기: draw call 이 선형 증가.
- 클라 재접속 백오프만 늘리기: 3번(코드 분기)을 안 고치면 두 탭 전쟁은 그대로다.

## 요약
지금 구조는 "프로토타입"으로는 정상 동작하고 1,000명 접속 자체는 서지만, ①중복 접속 고스트와
②로그아웃 무효라는 실제 결함이 있고 ③시야 120m·존 정원 130 조합이 최대 부하에서 클라당 수백
패킷을 만들며 ④scryptSync 가 로그인 순간 서버 전체를 세운다. 이 4개만 고쳐도 "며칠짜리 정식"
수준의 안정성에 근접하고, 그 위에 방(초대코드)·아바타 커스터마이징·모더레이션을 얹는 순서가 맞다.

---

## 조치 결과 (같은 날 반영, 커밋 대상)

| 항목 | 수정 위치 | 검증(재실행) | 전 → 후 |
|---|---|---|---|
| 1 중복 접속 고스트 | server.mjs `ws.on('close')` identity guard | town-dupe.mjs | online 0 → **1** (존 카운터 1, 유령 없음) |
| 2 로그아웃 무효 | server.mjs `authed()` (jti↔sessions) + 만료 세션 정리 | town-auth.mjs | `/api/me` 200 → **401** |
| 3 재접속 루프 | multiplayer.js `onclose` 코드 분기 | 코드 | 4000=중복접속 중단, 4001=정원 60초 재시도, 1008=로그인 패널, 1006 3회↑ → `/api/me` 재검증 |
| 4 maxPayload | server.mjs `WebSocketServer` | big.mjs(2KB 프레임) | 연결 유지 → **close 1009** |
| 5 시야/인원 | SEE 120→**50**, HEAR 120→**60**, 최근접 **24명** 컷 | loadtest | 100명 이동 클라당 **50.4 → 21.3 msg/s**, 1000명 이동 124.5 msg/s(상한 192), 접속 1.9s 실패 0 |
| 6 존 만원 무검사 | server.mjs pos 핸들러 `zonefull` + 접속 시 4001 | town-capacity.mjs (ZONE_CAP=1) | 11명 추가 중 **7 입장 / 4 거부**, 만원 존 이동 시 zonefull 수신 + 좌표 유지 |
| 7 scryptSync | server.mjs `promisify(crypto.scrypt)` | town-auth.mjs | 20 동시 로그인 벽시계 646 → **218ms**, health 최대 637 → **108ms** |
| 보너스 | welcome 전 pos 전송 제거, emote 500ms 제한, `ZONE_CAP` env | — | — |

남은 항목: 8(아바타 LOD)·10(pos 상한)·11(pos keepalive 제거)·12(시야 진입 join/프로필 포함 pos)·14(모델 지연 로드)·15(gzip/ETag)·16(짧은 토큰) 및 P2 17~33.
