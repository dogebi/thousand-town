# thousand-town 개선점 코드라인 분석 (v1)

> ## 적용 완료 (2026-11-05)
> 위 실행 순서 1~4 전부 반영, 그리고 "사람 + 인터랙션" 추가. 실측(localhost, 같은 조건):
>
> | 항목 | 전 | 후 |
> |---|---|---|
> | 요청 / 전송 | 48건 / 7,249 KB | 47건 / **3,491 KB** |
> | JS 합계 | 4,072 KB | **3,175 KB** |
> | 최대 자산 | eso-milky-way.jpg 3,106 KB | sky-2k.webp **280 KB** (원본은 webp→jpg→원본 순 폴백) |
> | blender 데이터 1.15 MB | 파싱 차단 | **첫 프레임 이후** idle 로드 → 도착 시 디테일 패스 교체 |
> | 프레임 blit | 매 프레임 full-frame drawImage | WebGL 캔버스 직결, **blit 제거** |
> | p5 | 954 KB 런타임 | **삭제** — `createCanvasApp` (canvas + rAF ~40줄) |
>
> - ③ p5 제거는 **WebGL 차단 상태에서도 검증**: `engine:"Canvas 2D fallback"`, 2.1초에 `data-ready`, 콘솔 에러 0.
> - 첫 프레임 셰이더 폴링(#8)에 24프레임/420 ms 상한 추가 — `isReady()`가 영원히 안 바뀌는 드라이버에서 로딩 화면이 고착되던 문제 제거.
> - 스크립트는 전부 `defer`, 45개 로드. `assets/blender-*.js` 6종은 `sketch.js`가 첫 프레임 후 주입.
>
> ### 사람 + 인터랙션 (`sketch.js`, `city-scene.js`, `style.css`)
> | 동작 | 결과 |
> |---|---|
> | 마우스 오버 | 발밑에 옅은 링 + 커서 옆 이름표("散步的居民") |
> | 클릭 | 하단 카드: 이름/종류, `前往 西岸公园 · 散步中`, 번호(person-36 · walker) |
> | 카드 `跟随这个人` / 더블클릭 / `F` | 1인칭 높이(줌 1.8, 피치 0.46)로 따라가며 이동 추적, 나가면 원래 줌 복귀 |
> | 머리 위 말풍선 | 종류·시각 버킷별 대사(난수 없음 → 재현 가능) |
> | `‹ ›` / `[` `]` | 화면 중심에서 가까운 순으로 사람 넘기기 |
> | `Esc` / `停止跟随` | 카드·링·추적 해제 |
> | 디버그 API | `cityStudio.streetPeople() · pickPersonAt(x,y) · selectPersonAt · nextPerson · prevPerson · followPerson(id) · stopFollowing()` |
>
> 피킹은 레이캐스트가 아니라 **화면 투영 + 최근접(16~34 px)** — 1콜 인스턴스 배치라 instanceId 픽이 불가능하고, 150명 투영이 레이캐스트보다 싸다.

대상: `D:\dev\thousand-town` (main `7b0f423`, 정적 데모 · 19,190줄)
측정 환경: localhost:8099, Chromium headless(GPU=SwiftShader 소프트웨어) — **FPS는 인용하지 않음**. 전송량·자산·드로우콜·삼각형·DOM 수치는 실측.

## 실측 기준선
| 항목 | 값 | 근거 |
|---|---|---|
| `<script src>` 개수 | **46** (index.html) | DOM |
| 요청/전송 | 48건 / **7,249 KB** | Resource Timing |
| JS 합계 | **4,072 KB** | 파일 크기 합 |
| 최대 자산 | `eso-milky-way.jpg` **3,106 KB, 6000×3000** | PIL + timing |
| DOMContentLoaded / load | 281 ms / **925 ms** (localhost, RTT 0) | Navigation Timing |
| draw calls / triangles | **298 / 1,594,272** | `cityStudio.getState().renderer` |
| shadow map | **4096×4096** (PCF) | 동일 |
| 캔버스 | 484×580, WebGL 1장 | DOM |
| DOM 노드 | 654 | DOM |

---

## P0 — 30분 안에, 효과 큰 것

### 1. 매 프레임 "보이지 않는 캔버스"로 복사하고 있다 — city-scene.js:1200
```js
context.save();context.fillStyle='#e9f0f5';context.fillRect(0,0,w,h);
context.drawImage(renderer.domElement,0,0,w,h);context.restore();lastSignature='';
```
`attach()`(city-scene.js:1203)가 p5 캔버스를 **WebGL 캔버스로 교체**한다:
```js
stage.replaceChild(renderer.domElement, previous);
```
실측 확인: `#stage` 안의 canvas는 **1장**(WebGL)뿐 — 즉 위 `drawImage`의 대상인 p5 2D 캔버스는 DOM에서 분리돼 화면에 나오지 않는다. 렌더 결과는 이미 WebGL 캔버스에 있고, 매 프레임 전체 화면 크기만큼 2D 캔버스로 한 번 더 복사하는 순수 낭비(DPR2·1440×900이면 2880×1800 blit).
수정: `physicalScene` 경로에서는 blit 생략(렌더 후 `return`). 2D 폴백에서만 그린다.
효과: 프레임당 full-frame copy 1회 제거 + WebGL 캔버스 readback 유발 드라이버 부담 제거.
리스크: 낮음(폴백 경로 보존).

### 2. 하늘 텍스처가 6000×3000 · 3.1 MB · VRAM ~96 MB — city-materials.js:415
```js
image.src = 'assets/eso-milky-way.jpg';
...
var galaxyMap = new T.Texture();          // colorSpace SRGB, mipmap 생성
```
실측: 파일 3,106 KB / 6000×3000 → 디코드 72 MB + mipmap ≈ **96 MB VRAM**. 전체 전송량의 **43%**가 이 한 장. 하늘 돔 배경이라 2K로 줄여도 화면 차이 없음.
수정: 2048×1024 WebP(q80) ≈ 150~250 KB로 교체 + `requestIdleCallback`에서 로드(첫 프레임 이후). 원본은 보관.
효과: 전송 -2.9 MB, VRAM -85 MB, 모바일에서 텍스처 업로드 히치 제거.

### 3. p5는 954 KB짜리 캔버스 생성기로만 쓰인다 — index.html:242 · sketch.js:2288-2345
실측 p5 API 사용처: `createCanvas · parent · pixelDensity · frameRate · draw · resizeCanvas · noLoop/loop · width/height · deltaTime · drawingContext` — **10개**. 그런데 `vendor/p5.min.js`는 **954 KB(전체 JS의 23%)**이고, WebGL 경로에서는 그 캔버스가 교체돼 사라진다(1번 항목).
수정: `new p5(...)` → `<canvas id="stage-canvas">` + `requestAnimationFrame` 루프 ~40줄. 2D 폴백이 필요하면 그때만 p5를 동적 로드(`import()` 또는 `<script defer>` 주입).
효과: 초기 JS 4.07 MB → 3.12 MB, 프레임 루프 한 겹 제거(p5 내부 clear/스타일 처리 없음).

### 4. 46개 스크립트가 파서를 순차 차단 — index.html:242-288
```html
<script src="./vendor/p5.min.js"></script>
<script src="./vendor/three.min.js"></script>
... 44개 더 (defer 없음)
```
localhost(RTT 0)에서도 load 925 ms. 4G(RTT 100 ms)에서 46개 순차 요청이면 체감 수 초. 또한 `assets/blender-*.js` **합계 1.15 MB는 첫 화면에 필요 없는데** 파싱 시점에 받는다(landscape 460 + district 304 + civic 170 + hospital 130 + amusement 82).
수정: ① 모든 `<script>`에 `defer`(순서 보존됨, 파싱은 병렬) ② blender 데이터 5종은 `Promise`/idle 시점 로드로 이동(이미 `CityDistrict.load()`가 있으니 태그만 제거) ③ `three.min.js`·`city-scene.js`에 `<link rel="preload" as="script">`.
효과: 초기 요청 46 → ~40, 초기 바이트 -1.15 MB, 파싱 병렬화.

---

## P1 — 이번 주

### 5. 물 반사가 매번 씬 전체를 한 번 더 그린다 — city-scene.js:620-637
```js
function renderReflectionFrame(time,key,tick,cameraKey,direct){
  const waterDue=tick!==lastReflection||cameraKey!==lastWaterCamera||!direct;
  ...
  renderer.render(scene,camera);          // 본 패스(298 calls / 1.59M tris)
```
`reflect` 패스가 같은 씬을 한 번 더 렌더한다(초당 12회 + 카메라 이동 시). 즉 실효 삼각형은 프레임당 최대 **~3.2M**.
수정(택1): ① 반사 전용으로 residents/actors/작은 소품 레이어를 끄기 ② `reflectionTick` 12→6 Hz ③ 물이 화면 밖이면 패스 스킵(현재 스킵 없음).
효과: GPU 부하 30~45% 절감 예상(반사는 화면 하단 일부에만 기여).

### 6. 4096² 그림자 맵은 뷰포트(484×580)에 과하다 — city-scene.js:423
```js
renderer.shadowMap.enabled=true;renderer.shadowMap.type=T.PCFShadowMap;renderer.shadowMap.autoUpdate=false;
```
`autoUpdate=false` + `needsUpdate` 조건부 갱신은 잘 돼 있다(좋은 설계). 다만 4096² depth = **64 MB VRAM**, PCF 샘플 비용도 해상도 비례.
수정: 2048²(또는 화면 폭 기준 1024~2048 동적) → 16 MB. 그림자 경계는 카메라 프러스텀이 좁아 육안 차이 미미.
효과: VRAM -48 MB, 섀도 패스 -50% 시간.

### 7. 일시정지·무변경 프레임에도 항상 다시 그린다 — city-scene.js:1024
```js
if(direct&&signature===lastSignature&&!zoomAnchor&&!facadePending&&!waterPending)return;
```
`direct`(스냅샷 내보내기)일 때만 조기 반환. 인터랙티브 경로는 `state.paused`로 시간이 멈춘 상태에서도 매 프레임 렌더+blit.
수정: `paused` && 카메라 서명 동일 && 애니메이션 정지 항목 없음 → `renderTo` 스킵. `p.draw`(sketch.js:2343)에서 판단.
효과: 정지 상태 GPU 사용률 대폭 감소(노트북 팬/배터리).

### 8. 첫 프레임이 셰이더 링크 완료를 폴링으로 기다린다 — city-scene.js:1185-1195
```js
renderer.compile(scene,camera);
if(!renderer.info.programs.every(p=>!p.program||!renderer.getContext().isProgram(p.program)||p.isReady()))return false;
```
매 프레임 전 프로그램에 `getContext().isProgram()` 호출 + 렌더 보류. r180에는 `renderer.compileAsync(scene,camera)`가 있으므로 Promise로 받고 그동안 로딩 UI를 유지하는 편이 낫다. `#loading`은 `renderTo!==false`일 때만 숨겨지므로(sketch.js:2343) 이 구간이 길면 화면이 그대로 멈춘다.
효과: 첫 프레임 지연 감소 + 메인스레드 블로킹 완화.

### 9. 캐시 버스팅이 2개 파일에만 적용 — index.html:278, 288
```html
<script src="./city-life-ext/resident-name.js?v=20261006-rosters3"></script>
<script src="./sketch.js?v=20261009-deco1"></script>
```
나머지 44개는 버전 없는 URL → 배포 후 브라우저가 구/신 파일을 섞어 실행(전역 의존이라 즉시 TypeError).
수정: 전 파일에 `?v=<build>` 일괄 적용 또는 서버에서 `Cache-Control: no-cache` + ETag. (Netlify면 `_headers`로 해시 파일만 장기 캐시)

### 10. 스크립트 하나만 실패해도 "正在铺开城市图纸…"에서 영구 정지 — index.html:143 · sketch.js:2343
```js
if(renderTo(...)!==false){$('loading').hidden=true;document.documentElement.dataset.ready='true';renderCount++;}
```
전역 에러 핸들러가 없다(`window.onerror`/`unhandledrejection` grep 0건). 46개 스크립트 중 하나가 404/구문오류면 `sketch.js`가 즉시 예외 → 로딩 문구가 영원히 남고 사용자는 원인을 모른다.
수정: `<head>`에 인라인 `window.addEventListener('error'|'unhandledrejection')` → `#loading`에 실패 문구 + `data-error` 표시. `#loading`에 8초 타임아웃 폴백도 함께.

---

## P2 — 정리

### 11. 한 줄이 3,000~5,300자인 함수들 — city-scene.js:619 · 10347 · 11255 · 11508 …
실측 최장: `city-scene.js:11255` **5,313자**, `:10347` 3,255자, `:11508` 2,931자. 특히 facade 반사 함수(:619)는 try/finally와 12개 상태 저장이 한 줄에 있어 리뷰·디프·스택트레이스가 불가능.
수정: Prettier 1회 적용(동작 변화 0). 그 다음에야 5·6번 같은 구조 변경을 안전하게 할 수 있다.

### 12. `updateUI`가 120 ms마다 DOM 20여 개를 무조건 다시 쓴다 — sketch.js:1800-1840
```js
if(!force&&performance.now()-lastUI<120)return;
...
$('build-count').textContent=...; $('tower-count').textContent=...; ... (20여 회)
```
`$()`는 매번 `getElementById`(파일 내 149회 사용). 값이 그대로여도 textContent/style을 다시 쓴다.
수정: 노드 참조를 1회 캐시 + 이전 값 비교 후 변경 시만 기록. `fleet.filter` 4회도 1회 루프로.
효과: 초당 ~8회의 스타일 재계산 후보 제거(작지만 공짜).

### 13. 매 프레임 배열 3개를 합쳐 156개를 훑는다 — city-scene.js:1180
```js
const walkingFade=actorsData&&[...actorsData.pedestrians,...actorsData.shoppers,...actorsData.riders].some(p=>p.visibility>0&&p.visibility<1);
```
실측 peds 60 + shoppers 90 + riders 6 = 156 → 프레임당 배열 3개 + 156회 순회. GPU에 비하면 미미하지만 공짜로 없앨 수 있다: `for` 루프 3개 또는 배치에서 플래그 갱신.

### 14. 전역 네임스페이스 46개 — index.html 전체
`CityScene/CityDistrict/CityModel/...` 이 전부 `window`에 붙고 로드 순서가 곧 의존성 그래프다(주석에 "The app owns cached resident plans…" 같은 순서 규약이 있음). 빌드 없이도 `<script type="module">`로 바꾸면 순서 의존과 전역 오염이 사라진다(전환 비용 큼, 장기 항목).

### 15. `href="../../"` 뒤로가기 링크는 배치 위치 가정 — index.html:18
`/demos/thousand-town/` 아래에 있을 때만 작동. 루트 배포나 `file://`로 열면 404. README가 "더블클릭으로 열기"를 안내하므로 실제로 깨진다. → `javascript:history.back()` 대신 절대 URL 또는 조건부 숨김.

---

## 잘 되어 있는 것 (건드리지 말 것)
- 인스턴싱: frontage 5,994 parts / 13 calls, residents 144 capacity / **1 call**, helipad 43 instances / 4 calls.
- `shadowMap.autoUpdate=false` + 조건부 `needsUpdate`, 물 반사는 카메라 이동/시계 기준으로만 갱신.
- 결정적 시뮬레이션: 렌더 경로에 `Math.random()` 0건(재현 가능).
- `prefers-reduced-motion` 대응(style.css:231), `:focus-visible` 스타일, 캔버스 `role="img"`+`aria-label`.
- WebGL 실패 시 2D 폴백 경로 유지(sketch.js:2298).

## 실행 순서 (비용 대비)
1. **#2 하늘 텍스처 축소** — 파일 교체만, 전송 43% 절감 (10분)
2. **#1 죽은 blit 제거** — 3줄, 프레임당 복사 1회 제거 (5분)
3. **#4 defer + blender 데이터 분리** — 태그 속성/이동, 초기 바이트 -1.15 MB (20분)
4. **#3 p5 제거** — 954 KB, 하루 작업(폴백 경로 검증 필요)
5. **#11 Prettier → #5/#6 반사·그림자 조정** — 이 순서라야 안전
