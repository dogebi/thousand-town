/* 大连 랜드마크 — 星海广场 · 中山广场 · 友好广场 + 有轨/无轨电车 101·201·202
   마을 좌표계(1단위 ≈ 1m, y 위)에 실제 大连 지형지물의 내용을 옮겨 놓은 모듈.
   - 星海广场: 华表(19.97m) · 百年城雕(펼친 책) · 脚印(발자국 판) · 해안 난간
   - 中山广场: 원형 광장 + 10개 방사 도로 + 10동 근대 건축 링 + 중앙 분수
   - 友好广场: 水晶球(지름 5m) 기단
   - 201/202 유궤전차(兴工街 공유), 101 무궤전차(가선) */
(function (root, factory) {
  'use strict';
  var api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CityDalian = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  // ── 실제 大连 기준 값 ───────────────────────────────────────────────────
  var HUABIAO_HEIGHT = 19.97;      // 星海广场 华表 높이(m)
  var CRYSTAL_DIAMETER = 5;        // 友好广场 水晶球 지름(m)

  // 광장 3곳: 마을 안에서 비어 있는 지구에 실제 비율로 배치.
  var SQUARES = [
    {
      id: 'xinghai', name: '星海广场', kind: 'waterfront',
      x: 231, z: -160, w: 94, d: 94, radius: 0,
      note: '亚洲最大城市广场 · 华表 19.97m · 百年城雕'
    },
    {
      id: 'zhongshan', name: '中山广场', kind: 'radial',
      x: 240, z: 20, radius: 38, spokes: 10,
      note: '10条道路放射 · 10栋近代建筑环列'
    },
    {
      id: 'youhao', name: '友好广场', kind: 'radial',
      x: 231, z: 100, radius: 12, spokes: 5,
      note: '水晶球 5m · 五路交汇'
    }
  ];

  // P0 랜드마크: 星海湾大桥 · 大连观光塔 · 梭鱼湾足球场(大连英博 홈)
  // 실제 치수를 마을 스케일(건물 25m, 사람 1.7m)에 맞춰 옮겼습니다.
  var EXTRAS = [
    {
      id: 'xinghai-bridge', name: '星海湾大桥', kind: 'bridge',
      x: 0, z: 245, span: 280, mainSpan: 100, towerH: 30, deckY: 9,
      note: '跨海大桥 全长6.8km · 主跨460m · 主塔114.3m (축소 표현)'
    },
    {
      id: 'sightseeing-tower', name: '大连观光塔', kind: 'tower',
      x: 231, z: -70, bodyH: 190, mastH: 22,
      note: '塔体190m · 해발360m · 劳动公园 绿山'
    },
    {
      id: 'suoyuwan', name: '梭鱼湾足球场', kind: 'stadium',
      x: -248, z: -150, w: 96, d: 88, seats: 63000,
      note: '6.3万석 · 2023 개장 · 大连英博 홈'
    }
  ];

  // 전차 노선: 201/202 는 兴工街 를 공유하고, 101 은 무궤전차(가선 2줄).
  var LINES = [
    {
      id: '201', name: '201路有轨电车', kind: 'tram', color: '#a83a2c',
      axis: 'x', from: 18, to: 172, fixed: 0, vehicles: 2, speed: 8.5, dwell: 7,
      stops: ['兴工街', '人民广场', '青泥洼桥', '大连火车站', '港湾广场', '海之韵公园']
    },
    {
      id: '202', name: '202路有轨电车', kind: 'tram', color: '#2f6f8f',
      axis: 'x', from: -172, to: -18, fixed: 0, vehicles: 2, speed: 8.5, dwell: 7,
      stops: ['兴工街', '和平广场', '会展中心', '星海广场', '医大二院', '小平岛前']
    },
    {
      id: '101', name: '101路无轨电车', kind: 'trolley', color: '#3f7d4f',
      axis: 'z', from: -156, to: 156, fixed: 96, vehicles: 2, speed: 9.5, dwell: 8,
      stops: ['马栏广场', '人民广场', '青泥洼桥', '大连火车站']
    }
  ];

  function squares() { return SQUARES.map(function (s) { return Object.assign({}, s); }); }
  function lines() { return LINES.map(function (l) { return Object.assign({}, l, { stops: l.stops.slice() }); }); }
  function extras() { return EXTRAS.map(function (e) { return Object.assign({}, e); }); }

  // 노선 위 정류장 위치(0..1). 양 끝은 종점이라 살짝 안쪽.
  function stopFractions(line) {
    var n = line.stops.length, out = [];
    for (var i = 0; i < n; i++) out.push(n === 1 ? 0.5 : 0.06 + 0.88 * (i / (n - 1)));
    return out;
  }

  // 정류장 정차를 포함한 왕복 스케줄. 시간 → 노선 위 위치(0..1).
  function schedule(line, span) {
    var fr = stopFractions(line), legs = [], total = 0;
    for (var i = 0; i < fr.length - 1; i++) {
      var run = Math.abs(fr[i + 1] - fr[i]) * span / line.speed;
      legs.push({ run: run, from: fr[i], to: fr[i + 1] });
      total += run + line.dwell;
    }
    total += line.dwell;                     // 종점 회차 대기
    return { legs: legs, total: Math.max(1, total), dwell: line.dwell };
  }

  function positionAt(sched, t) {
    var cycle = sched.total * 2;             // 갔다가 돌아오기
    var u = ((t % cycle) + cycle) % cycle;
    var back = u > sched.total;
    if (back) u -= sched.total;
    var acc = 0;
    for (var i = 0; i < sched.legs.length; i++) {
      var leg = sched.legs[i];
      if (u < acc + leg.run) {
        var f = leg.from + (leg.to - leg.from) * ((u - acc) / leg.run);
        return back ? 1 - f : f;
      }
      acc += leg.run;
      if (u < acc + sched.dwell) return back ? 1 - leg.to : leg.to;
      acc += sched.dwell;
    }
    var last = sched.legs.length ? sched.legs[sched.legs.length - 1].to : 1;
    return back ? 1 - last : last;
  }

  // ── 3D ────────────────────────────────────────────────────────────────
  function create(T, kit, city) {
    if (!T) throw new Error('CityDalian.create needs THREE');
    var group = new T.Group();
    group.name = 'dalian-landmarks';
    var owned = [];
    var materials = {};
    var ringBlocks = [];
    function mat(name, color, opts) {
      if (materials[name]) return materials[name];
      var m = new T.MeshStandardMaterial(Object.assign({ color: color, roughness: 0.82, metalness: 0.04 }, opts || {}));
      m.name = 'dalian-' + name;
      materials[name] = m; owned.push(m);
      return m;
    }
    function box(w, h, d, material, x, y, z, ry) {
      var mesh = new T.Mesh(new T.BoxGeometry(w, h, d), material);
      mesh.position.set(x, y, z);
      if (ry) mesh.rotation.y = ry;
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    }
    function cyl(rt, rb, h, seg, material, x, y, z) {
      var mesh = new T.Mesh(new T.CylinderGeometry(rt, rb, h, seg), material);
      mesh.position.set(x, y, z);
      mesh.castShadow = true; mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    }
    function slab(r, h, material, x, y, z) {
      return cyl(r, r, h, 40, material, x, y, z);
    }

    // 중국어 간판/정류장 이름 — 캔버스 텍스처 한 장으로 처리합니다.
    var textures = [];
    function sign(text, x, y, z, w, h, ry, ink, bg) {
      if (!root.document || typeof root.document.createElement !== 'function') return null;
      var canvas = root.document.createElement('canvas');
      canvas.width = 512; canvas.height = 128;
      var c = canvas.getContext('2d');
      if (!c) return null;
      c.fillStyle = bg || '#33525c'; c.fillRect(0, 0, 512, 128);
      c.strokeStyle = 'rgba(245,240,226,.55)'; c.lineWidth = 6; c.strokeRect(8, 8, 496, 112);
      c.fillStyle = ink || '#f6f1e4'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.font = '600 72px "Microsoft YaHei","PingFang SC","Noto Sans CJK SC",sans-serif';
      c.fillText(text, 256, 68);
      var tex = new T.CanvasTexture(canvas);
      if (T.SRGBColorSpace) tex.colorSpace = T.SRGBColorSpace;
      tex.name = 'dalian-sign-' + text;
      textures.push(tex);
      var m = new T.MeshStandardMaterial({ map: tex, roughness: .78, metalness: .02, side: T.DoubleSide });
      m.name = tex.name; owned.push(m);
      var geo = new T.PlaneGeometry(w, h);
      var mesh = new T.Mesh(geo, m);
      mesh.position.set(x, y, z);
      if (ry) mesh.rotation.y = ry;
      group.add(mesh);
      return mesh;
    }

    var granite = mat('granite', '#b8b2a4');
    var graniteDark = mat('granite-dark', '#8d8779');
    var marble = mat('marble', '#e8e4d8');
    var paving = mat('paving', '#d9d3c4');
    var grass = mat('grass', '#7e9b62');
    var brass = mat('brass', '#c9a45a', { metalness: 0.55, roughness: 0.42 });
    var glass = mat('crystal', '#bfe6f2', { metalness: 0.15, roughness: 0.08, transparent: true, opacity: 0.62 });
    var waterMat = mat('water', '#6fb4c4', { roughness: 0.25, metalness: 0.1 });
    var stoneFacade = mat('stone-facade', '#cfc4ae');
    var stoneRoof = mat('stone-roof', '#9a6f57');
    var tramCream = mat('tram-cream', '#efe6cf');
    var tramDark = mat('tram-dark', '#3b4a50');
    var wireMat = mat('wire', '#4a5155', { metalness: 0.6, roughness: 0.5 });
    var steel = mat('steel', '#9aa0a3', { metalness: 0.7, roughness: 0.35 });
    var bridgeDeck = mat('bridge-deck', '#cfd3d2');
    var bridgeTower = mat('bridge-tower', '#e2e5e3');
    var cableMat = mat('bridge-cable', '#f0f2f0', { metalness: 0.5, roughness: 0.4 });
    var towerConcrete = mat('tower-concrete', '#dedbd0');
    var pitchMat = mat('pitch', '#5f8f4e');
    var seatBlue = mat('seat-blue', '#2a4f79');
    var seatPale = mat('seat-pale', '#cdd6db');
    var roofMat = mat('stadium-roof', '#e8ecee', { metalness: 0.25, roughness: 0.6 });

    // 星海广场 ─────────────────────────────────────────────────────────
    function buildXinghai(site) {
      box(site.w, 0.4, site.d, paving, site.x, 0.2, site.z);
      slab(17, 0.12, granite, site.x, 0.48, site.z);
      slab(17.6, 0.1, graniteDark, site.x, 0.44, site.z);
      sign('星海广场', site.x, 5.2, site.z + site.d / 2 - 6, 20, 4.6, 0, '#f6f1e4', '#33525c');
      box(21, 5.4, 0.8, granite, site.x, 2.6, site.z + site.d / 2 - 6.4);
      // 华表: 기단 → 주신 → 云板 → 상단 구
      var hx = site.x, hz = site.z;
      box(9, 1.6, 9, granite, hx, 0.8, hz);
      cyl(2.2, 2.6, 1.1, 24, graniteDark, hx, 2.15, hz);
      cyl(0.62, 0.78, HUABIAO_HEIGHT - 4.4, 18, marble, hx, 2.7 + (HUABIAO_HEIGHT - 4.4) / 2, hz);
      cyl(2.6, 2.6, 0.5, 24, marble, hx, HUABIAO_HEIGHT - 1.3, hz);   // 云板
      cyl(0.9, 0.9, 0.55, 16, marble, hx, HUABIAO_HEIGHT - 0.75, hz);  // 承露盘
      var top = new T.Mesh(new T.SphereGeometry(0.72, 14, 10), brass);
      top.position.set(hx, HUABIAO_HEIGHT + 0.1, hz);
      top.castShadow = true; group.add(top);
      // 百年城雕: 펼친 책 두 장
      var bx = site.x - 22, bz = site.z + 20;
      box(13, 0.9, 9, granite, bx, 0.65, bz);
      var left = box(6.2, 0.5, 7.4, marble, bx - 3.1, 1.85, bz, 0);
      left.rotation.z = -0.17;
      var right = box(6.2, 0.5, 7.4, marble, bx + 3.1, 1.85, bz, 0);
      right.rotation.z = 0.17;
      box(0.55, 0.7, 7.4, graniteDark, bx, 1.35, bz);
      // 脚印: 백년의 발자국 — 좌우 교대 판
      for (var i = 0; i < 26; i++) {
        var px = site.x - 30 + i * 2.4;
        var side = (i % 2 === 0 ? -1 : 1);
        box(1.5, 0.14, 0.85, graniteDark, px, 0.55, site.z - 26 + side * 0.62);
      }
      // 해안 난간(星海湾 방향 동쪽 끝)
      for (var p = 0; p < 16; p++) {
        box(0.42, 2.1, 0.42, marble, site.x + site.w / 2 - 2, 1.05, site.z - site.d / 2 + 4 + p * 5.4);
      }
      box(0.16, 0.22, site.d - 8, marble, site.x + site.w / 2 - 2, 2.05, site.z);
      // 잔디 화단 두 곳
      box(site.w * 0.32, 0.28, site.d * 0.22, grass, site.x + 20, 0.45, site.z + 26);
      box(site.w * 0.32, 0.28, site.d * 0.22, grass, site.x + 20, 0.45, site.z - 26);
    }

    // 中山广场 ─────────────────────────────────────────────────────────
    function buildZhongshan(site) {
      slab(site.radius + 4, 0.3, paving, site.x, 0.15, site.z);
      slab(site.radius * 0.72, 0.16, grass, site.x, 0.36, site.z);
      // 10개 방사 도로
      for (var i = 0; i < site.spokes; i++) {
        var a = (i / site.spokes) * Math.PI * 2;
        var len = (site.radius + 3) - site.radius * 0.78;
        var mid = site.radius * 0.78 + len / 2;
        box(2.4, 0.1, len, graniteDark, site.x + Math.cos(a) * mid, 0.42, site.z + Math.sin(a) * mid, -a);
      }
      sign('中山广场', site.x, 5.4, site.z + site.radius + 2, 18, 4.4, 0, '#f6f1e4', '#3d4a3a');
      // 중앙 분수(원형 수반)
      cyl(7, 7.4, 0.9, 28, granite, site.x, 0.55, site.z);
      slab(6.2, 0.12, waterMat, site.x, 0.95, site.z);
      cyl(0.5, 0.7, 2.4, 14, marble, site.x, 1.9, site.z);
      // 10동 근대 건축 링: 4~6층, 처마/코니스
      for (var b = 0; b < site.spokes; b++) {
        var ang = (b / site.spokes) * Math.PI * 2 + Math.PI / site.spokes;
        var rr = site.radius + 14;
        var h = 16 + (b % 3) * 4;
        var bw = 15, bd = 13;
        var bx = site.x + Math.cos(ang) * rr, bz = site.z + Math.sin(ang) * rr;
        box(bw, h, bd, stoneFacade, bx, h / 2, bz, -ang);
        ringBlocks.push({ x: +bx.toFixed(1), z: +bz.toFixed(1), w: bw, d: bd });
        box(bw + 1.6, 1.1, bd + 1.6, stoneRoof, bx, h + 0.55, bz, -ang);
        box(bw - 4, 0.9, bd + 1.9, brass, bx, h - 3.2, bz, -ang);
      }
    }

    // 友好广场 ─────────────────────────────────────────────────────────
    function buildYouhao(site) {
      slab(site.radius + 2, 0.3, paving, site.x, 0.15, site.z);
      slab(site.radius * 0.55, 0.14, granite, site.x, 0.36, site.z);
      for (var i = 0; i < site.spokes; i++) {
        var a = (i / site.spokes) * Math.PI * 2;
        var mid = site.radius * 0.72;
        box(2, 0.1, site.radius * 0.9, graniteDark, site.x + Math.cos(a) * mid, 0.4, site.z + Math.sin(a) * mid, -a);
      }
      sign('友好广场', site.x, 4.6, site.z + site.radius + 1, 15, 3.9, 0, '#f6f1e4', '#4a3f52');
      // 水晶球 기단
      cyl(3.4, 3.8, 0.5, 30, granite, site.x, 0.5, site.z);
      cyl(2.5, 2.9, 0.6, 30, graniteDark, site.x, 1.05, site.z);
      cyl(1.9, 2.2, 1.5, 26, granite, site.x, 2.05, site.z);
      var ball = new T.Mesh(new T.SphereGeometry(CRYSTAL_DIAMETER / 2, 32, 24), glass);
      ball.position.set(site.x, 4.7, site.z);
      ball.castShadow = true; group.add(ball);
      var ring = new T.Mesh(new T.TorusGeometry(2.9, 0.12, 8, 32), brass);
      ring.position.set(site.x, 3.05, site.z); ring.rotation.x = Math.PI / 2; group.add(ring);
    }

    SQUARES.forEach(function (site) {
      if (site.kind === 'waterfront') buildXinghai(site);
      else if (site.id === 'zhongshan') buildZhongshan(site);
      else buildYouhao(site);
    });

    // ── P0 랜드마크 ─────────────────────────────────────────────────────
    function strut(a, b, radius, material) {
      var dir = new T.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      var len = dir.length();
      if (len < 0.01) return null;
      var mesh = new T.Mesh(new T.CylinderGeometry(radius, radius, len, 6), material);
      mesh.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
      mesh.quaternion.setFromUnitVectors(new T.Vector3(0, 1, 0), dir.clone().normalize());
      group.add(mesh);
      return mesh;
    }
    function ringMesh(inner, outer, material, y, cx, cz, segments) {
      var mesh = new T.Mesh(new T.RingGeometry(inner, outer, segments || 48), material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set(cx, y, cz);
      mesh.receiveShadow = true;
      group.add(mesh);
      return mesh;
    }

    // 星海湾大桥 — 케이블 사장교(주탑 2기 + 케이블 + 교각)
    function buildBridge(site) {
      var x0 = site.x, z0 = site.z, deckY = site.deckY;
      box(site.span, 1.4, 15, bridgeDeck, x0, deckY, z0);
      [-7.2, 7.2].forEach(function (off) {
        box(site.span, 0.95, 0.4, steel, x0, deckY + 1.15, z0 + off);
      });
      for (var px = -site.span / 2 + 24; px <= site.span / 2 - 24; px += 28) {
        if (Math.abs(px) < site.mainSpan / 2 + 6) continue;
        cyl(1.5, 2.0, deckY, 10, granite, x0 + px, deckY / 2, z0);
      }
      [-site.mainSpan / 2, site.mainSpan / 2].forEach(function (tx) {
        [-6.2, 6.2].forEach(function (tz) {
          box(2.6, site.towerH, 2.2, bridgeTower, x0 + tx, site.towerH / 2, z0 + tz);
        });
        box(2.4, 1.7, 17, bridgeTower, x0 + tx, site.towerH * 0.60, z0);
        box(2.4, 1.7, 17, bridgeTower, x0 + tx, site.towerH * 0.90, z0);
        for (var c = 1; c <= 8; c++) {
          var dx = c * (site.mainSpan * 0.5) / 9;
          [-1, 1].forEach(function (sgn) {
            [-1, 1].forEach(function (side) {
              strut([x0 + tx, site.towerH - 1.4, z0 + side * 6.2],
                [x0 + tx + sgn * dx, deckY + 1.0, z0 + side * 7.0], 0.09, cableMat);
            });
          });
        }
      });
      sign('星海湾大桥', x0, deckY + 6.4, z0 + 9, 18, 4.2, 0, '#f6f1e4', '#35505c');
    }

    // 大连观光塔 — 기단 + 샤프트 + 전망대 + 안테나 (탑체 190m)
    function buildTower(site) {
      var h = site.bodyH, deckY = h * 0.79;
      cyl(13, 15, 7, 24, granite, site.x, 3.5, site.z);                 // 기단
      cyl(7.4, 9.0, 10, 22, towerConcrete, site.x, 12, site.z);         // 하부
      cyl(4.4, 7.4, deckY - 17, 20, towerConcrete, site.x, 17 + (deckY - 17) / 2, site.z);
      cyl(10.5, 8.0, 4.4, 28, glass, site.x, deckY + 2.2, site.z);      // 전망대
      cyl(10.9, 10.9, 1.0, 28, steel, site.x, deckY + 5.0, site.z);
      cyl(3.0, 4.4, 5.2, 16, towerConcrete, site.x, deckY + 7.6, site.z);
      cyl(2.4, 3.0, h - deckY - 10, 16, towerConcrete, site.x, deckY + 10 + (h - deckY - 10) / 2, site.z);
      cyl(1.2, 2.4, 6, 12, towerConcrete, site.x, h - 2.5, site.z);
      cyl(0.55, 1.2, site.mastH, 8, steel, site.x, h + site.mastH / 2, site.z);
      sign('大连观光塔', site.x, 9.5, site.z + 16, 16, 3.8, 0, '#f6f1e4', '#35505c');
    }

    // 梭鱼湾足球场 — 3단 관중석 링 + 지붕 링 + 조명 4기 + 잔디
    function buildStadium(site) {
      var cx = site.x, cz = site.z;
      box(site.w * 0.52, 0.5, site.d * 0.5, pitchMat, cx, 0.55, cz);
      box(site.w * 0.46, 0.06, 0.4, marble, cx, 0.82, cz);                    // 하프라인
      [-1, 1].forEach(function (s) {
        box(0.4, 0.06, site.d * 0.34, marble, cx + s * site.w * 0.17, 0.82, cz);
      });
      box(site.w * 0.30, 1.0, site.d * 0.22, marble, cx, 0.7, cz);            // 골 에어리어
      var tiers = [
        [34, 40, 3.0, seatBlue], [40, 46, 6.4, seatPale], [46, 53, 9.8, seatBlue]
      ];
      tiers.forEach(function (t) { ringMesh(t[0], t[1], t[3], t[2], cx, cz, 56); });
      // 외벽 + 수직 리브
      var wall = new T.Mesh(new T.CylinderGeometry(54, 55, 15, 56, 1, true), roofMat);
      wall.position.set(cx, 7.5, cz); group.add(wall);
      for (var i = 0; i < 28; i++) {
        var a = (i / 28) * Math.PI * 2;
        box(0.9, 15, 0.9, roofMat, cx + Math.cos(a) * 54.4, 7.5, cz + Math.sin(a) * 54.4);
      }
      // 지붕 링(관중석 위)
      ringMesh(30, 54, roofMat, 16.4, cx, cz, 56);
      // 조명 4기
      for (var k = 0; k < 4; k++) {
        var ang = Math.PI / 4 + (k / 4) * Math.PI * 2;
        var lx = cx + Math.cos(ang) * 60, lz = cz + Math.sin(ang) * 60;
        cyl(0.7, 1.0, 30, 8, steel, lx, 15, lz);
        box(5.2, 2.4, 1.4, mat('floodlight', '#e9edef', { emissive: '#fff3d0', emissiveIntensity: 0.35 }), lx, 30.4, lz, -ang);
      }
      sign('梭鱼湾足球场', cx, 20, cz + 57, 26, 5.4, 0, '#f6f1e4', '#274a6e');
      sign('大连英博', cx, 13.4, cz + 57, 15, 3.4, 0, '#ffe9b8', '#274a6e');
    }

    EXTRAS.forEach(function (site) {
      if (site.kind === 'bridge') buildBridge(site);
      else if (site.kind === 'tower') buildTower(site);
      else buildStadium(site);
    });

    // ── 전차 ────────────────────────────────────────────────────────────
    function linePoint(line, f) {
      var v = line.from + (line.to - line.from) * f;
      return line.axis === 'x' ? { x: v, z: line.fixed } : { x: line.fixed, z: v };
    }
    function railStrip(line) {
      var a = linePoint(line, 0), b = linePoint(line, 1);
      var len = Math.hypot(b.x - a.x, b.z - a.z);
      var cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
      var along = line.axis === 'x';
      // 침목 위 두 줄 레일 + 중앙 홈
      box(along ? len : 7.4, 0.12, along ? 7.4 : len, paving, cx, 0.3, cz);
      [-0.72, 0.72].forEach(function (off) {
        box(along ? len : 0.18, 0.16, along ? 0.18 : len, steel,
          cx + (along ? 0 : off), 0.4, cz + (along ? off : 0));
      });
      // 가선(전차 1줄 / 무궤전차 2줄) + 지지주
      var wireY = 6.6;
      var wireOffsets = line.kind === 'trolley' ? [-0.55, 0.55] : [0];
      var wireMatUse = line.kind === 'trolley' ? wireMat : wireMat;
      wireOffsets.forEach(function (off) {
        box(along ? len : 0.09, 0.09, along ? 0.09 : len, wireMatUse,
          cx + (along ? 0 : off), wireY, cz + (along ? off : 0));
      });
      var poles = Math.max(2, Math.round(len / 26));
      for (var i = 0; i <= poles; i++) {
        var f = i / poles;
        var p = linePoint(line, f);
        var side = 3.9 * (i % 2 === 0 ? 1 : -1);
        var px = along ? p.x : p.x + side;
        var pz = along ? p.z + side : p.z;
        cyl(0.13, 0.16, wireY, 8, wireMatUse, px, wireY / 2, pz);
        // 가선을 지지하는 붐
        box(along ? 0.12 : Math.abs(side), 0.12, along ? Math.abs(side) : 0.12, steel,
          along ? p.x : p.x + side / 2, wireY, along ? p.z + side / 2 : p.z);
      }
      // 정류장 표지: 노선 색 띠를 두른 기둥 + 승강장
      var fr = stopFractions(line);
      fr.forEach(function (f, si) {
        var p = linePoint(line, f);
        var alongOff = along ? 0 : 3.3, sideOff = along ? 3.3 : 0;
        box(along ? 12 : 2.6, 0.28, along ? 2.6 : 12, paving, p.x + sideOff, 0.34, p.z + alongOff);
        cyl(0.1, 0.1, 3.4, 8, steel, p.x + sideOff * 1.4, 2.0, p.z + alongOff * 1.4);
        box(along ? 3.4 : 0.12, 0.9, along ? 0.12 : 3.4, mat('line-' + line.id, line.color),
          p.x + sideOff * 1.4, 4.0, p.z + alongOff * 1.4);
        // 정류장 이름(노선 번호 + 역명)
        var name = line.stops[si] || '';
        if (name) sign(line.id + ' ' + name, p.x + sideOff * 1.6, 3.1, p.z + alongOff * 1.6,
          4.6, 1.2, along ? 0 : Math.PI / 2, '#f6f1e4', line.color);
      });
    }

    function tramBody(line) {
      var g = new T.Group();
      var along = line.axis === 'x';
      var bodyLen = 11.4, bodyW = 2.68;
      function part(w, h, d, m, x, y, z) {
        var mesh = new T.Mesh(new T.BoxGeometry(w, h, d), m);
        mesh.position.set(x, y, z); mesh.castShadow = true; g.add(mesh); return mesh;
      }
      var w = along ? bodyLen : bodyW, d = along ? bodyW : bodyLen;
      part(w, 1.1, d, tramCream, 0, 1.55, 0);              // 하부 차체
      part(w * 0.98, 1.5, d * 0.98, tramCream, 0, 2.9, 0); // 상부 차체
      part(w * 1.002, 0.42, d * 1.002, mat('livery-' + line.id, line.color), 0, 1.62, 0); // 띠
      part(along ? bodyLen * 0.86 : bodyW * 1.02, 0.72, along ? bodyW * 1.02 : bodyLen * 0.86, tramDark, 0, 3.05, 0); // 창
      part(along ? 4.2 : bodyW * 0.9, 0.3, along ? bodyW * 0.9 : 4.2, steel, 0, 3.72, 0);  // 지붕
      // 집전장치(팬터그래프)
      part(along ? 2.2 : 0.14, 0.12, along ? 0.14 : 2.2, steel, 0, 4.4, 0);
      part(along ? 1.4 : 0.1, 0.9, along ? 0.1 : 1.4, steel, 0, 4.85, 0);
      // 전조등
      [1, -1].forEach(function (s) {
        var lamp = new T.Mesh(new T.BoxGeometry(along ? 0.5 : 0.2, 0.3, along ? 0.2 : 0.5),
          new T.MeshBasicMaterial({ color: '#ffe9b8' }));
        lamp.position.set(along ? s * bodyLen / 2 * 0.98 : 0, 2.1, along ? 0 : s * bodyLen / 2 * 0.98);
        g.add(lamp);
      });
      return g;
    }

    var vehicles = [];
    LINES.forEach(function (line) {
      railStrip(line);
      var span = Math.abs(line.to - line.from);
      var sched = schedule(line, span);
      for (var v = 0; v < line.vehicles; v++) {
        var mesh = tramBody(line);
        group.add(mesh);
        vehicles.push({ line: line, mesh: mesh, sched: sched, offset: (v / line.vehicles) * sched.total * 2 });
      }
    });

    function placeVehicle(item, time) {
      var f = positionAt(item.sched, time + item.offset);
      var p = linePoint(item.line, f);
      var y = 0.55;
      item.mesh.position.set(p.x, y, p.z);
      // 진행 방향 판정
      var f2 = positionAt(item.sched, time + item.offset + 0.35);
      var p2 = linePoint(item.line, f2);
      var dx = p2.x - p.x, dz = p2.z - p.z;
      if (item.line.axis === 'x') item.mesh.rotation.y = dx >= 0 ? 0 : Math.PI;
      else item.mesh.rotation.y = dz >= 0 ? -Math.PI / 2 : Math.PI / 2;
      item.at = { x: p.x, z: p.z };
    }
    vehicles.forEach(function (v) { placeVehicle(v, 0); });

    function update(time) {
      var t = Number.isFinite(time) ? time : 0;
      for (var i = 0; i < vehicles.length; i++) placeVehicle(vehicles[i], t);
    }

    function getInfo() {
      return {
        squares: SQUARES.map(function (s) {
          return { id: s.id, name: s.name, x: s.x, z: s.z, kind: s.kind, note: s.note };
        }),
        lines: LINES.map(function (l) {
          return {
            id: l.id, name: l.name, kind: l.kind, stops: l.stops.slice(),
            vehicles: vehicles.filter(function (v) { return v.line === l; })
              .map(function (v) { return { x: +(v.at ? v.at.x : 0).toFixed(1), z: +(v.at ? v.at.z : 0).toFixed(1) }; })
          };
        }),
        ringBlocks: ringBlocks.slice(),
        extras: EXTRAS.map(function (e) { return { id: e.id, name: e.name, kind: e.kind, x: e.x, z: e.z, note: e.note }; }),
        count: SQUARES.length,
        vans: vehicles.length
      };
    }

    function dispose() {
      group.traverse(function (o) {
        if (o.isMesh) { if (o.geometry) o.geometry.dispose(); if (o.material && o.material.dispose && owned.indexOf(o.material) === -1 && !o.material.userData) o.material.dispose(); }
      });
      textures.forEach(function (t) { if (t.dispose) t.dispose(); });
      textures = [];
      owned.forEach(function (m) { m.dispose(); });
      owned = [];
      vehicles = [];
      if (group.parent) group.parent.remove(group);
    }

    return { group: group, update: update, getInfo: getInfo, dispose: dispose };
  }

  // ── 2D 캔버스 폴백용 ──────────────────────────────────────────────────
  function draw2D(api, time) {
    var point = api.point, plane = api.plane, cuboid = api.cuboid, line = api.line, polygon = api.polygon;
    SQUARES.forEach(function (s) {
      if (s.radius) {
        var pts = [];
        for (var i = 0; i < 28; i++) {
          var a = (i / 28) * Math.PI * 2;
          pts.push([s.x + Math.cos(a) * s.radius, s.z + Math.sin(a) * s.radius, 0.34]);
        }
        polygon(pts, '#d9d3c4');
        for (var k = 0; k < s.spokes; k++) {
          var ang = (k / s.spokes) * Math.PI * 2;
          line([[s.x + Math.cos(ang) * s.radius * 0.3, s.z + Math.sin(ang) * s.radius * 0.3, 0.42],
                [s.x + Math.cos(ang) * s.radius * 0.95, s.z + Math.sin(ang) * s.radius * 0.95, 0.42]],
               'rgba(120,113,98,.55)', 1);
        }
      } else {
        plane(s.x, s.z, s.w, s.d, 0.34, '#d9d3c4');
      }
    });
    // 星海广场 华表 · 百年城雕
    var xinghai = SQUARES[0];
    cuboid(xinghai.x, xinghai.z, 9, 9, 0.4, 1.4, '#b8b2a4');
    cuboid(xinghai.x, xinghai.z, 2.4, 2.4, 1.6, HUABIAO_HEIGHT - 2, '#e8e4d8');
    cuboid(xinghai.x - 22, xinghai.z + 20, 13, 9, 0.4, 1.6, '#e8e4d8');
    // 中山广场 중앙 분수
    var zhong = SQUARES[1];
    cuboid(zhong.x, zhong.z, 13, 13, 0.4, 1.1, '#b8b2a4');
    // 友好广场 水晶球
    var you = SQUARES[2];
    cuboid(you.x, you.z, 6, 6, 0.4, 2.2, '#8d8779');
    var c = point(you.x, you.z, 5.4);
    api.ctx.beginPath();
    api.ctx.fillStyle = 'rgba(191,230,242,.85)';
    api.ctx.arc(c[0], c[1], Math.max(1.4, api.view.scale * 2.6), 0, Math.PI * 2);
    api.ctx.fill();
    // P0 랜드마크 표시(2D 폴백)
    EXTRAS.forEach(function (e) {
      if (e.kind === 'bridge') {
        line([[e.x - e.span / 2, e.z, 0.5], [e.x + e.span / 2, e.z, 0.5]], 'rgba(226,229,227,.95)', 1.6);
        [-1, 1].forEach(function (s2) {
          cuboid(e.x + s2 * e.mainSpan / 2, e.z, 3, 16, 0.5, 30, '#e2e5e3');
        });
      } else if (e.kind === 'tower') {
        cuboid(e.x, e.z, 20, 20, 0.4, 6, '#dedbd0');
        var tp = point(e.x, e.z, e.bodyH * 0.55);
        api.ctx.beginPath();
        api.ctx.strokeStyle = '#dedbd0'; api.ctx.lineWidth = Math.max(2, api.view.scale * 1.6);
        api.ctx.moveTo(tp[0], tp[1]);
        var tp2 = point(e.x, e.z, 0.5);
        api.ctx.lineTo(tp2[0], tp2[1]); api.ctx.stroke();
        api.ctx.beginPath(); api.ctx.fillStyle = '#e8ecee';
        api.ctx.arc(tp[0], tp[1], Math.max(3, api.view.scale * 3.2), 0, Math.PI * 2); api.ctx.fill();
      } else {
        var pts = [];
        for (var i2 = 0; i2 < 24; i2++) {
          var a2 = (i2 / 24) * Math.PI * 2;
          pts.push([e.x + Math.cos(a2) * e.w / 2, e.z + Math.sin(a2) * e.d / 2, 0.6]);
        }
        polygon(pts, '#dfe4e6');
        plane(e.x, e.z, e.w * 0.5, e.d * 0.48, 0.7, '#5f8f4e');
      }
    });
    // 전차
    var t = Number.isFinite(time) ? time : 0;
    LINES.forEach(function (l) {
      var span = Math.abs(l.to - l.from), sched = schedule(l, span);
      if (l.axis === 'x') line([[l.from, l.fixed, 0.3], [l.to, l.fixed, 0.3]], 'rgba(74,81,85,.55)', 1.1);
      else line([[l.fixed, l.from, 0.3], [l.fixed, l.to, 0.3]], 'rgba(74,81,85,.55)', 1.1);
      for (var v = 0; v < l.vehicles; v++) {
        var f = positionAt(sched, t + (v / l.vehicles) * sched.total * 2);
        var val = l.from + (l.to - l.from) * f;
        var px = l.axis === 'x' ? val : l.fixed, pz = l.axis === 'x' ? l.fixed : val;
        var wide = l.axis === 'x';
        cuboid(px, pz, wide ? 11.4 : 2.7, wide ? 2.7 : 11.4, 0.4, 3.6, l.color);
      }
      stopFractions(l).forEach(function (fr) {
        var val = l.from + (l.to - l.from) * fr;
        var px = l.axis === 'x' ? val : l.fixed + 3.4, pz = l.axis === 'x' ? l.fixed + 3.4 : val;
        var p = point(px, pz, 0.4);
        api.ctx.beginPath();
        api.ctx.fillStyle = '#f4f0e2';
        api.ctx.arc(p[0], p[1], Math.max(1, api.view.scale * 1.2), 0, Math.PI * 2);
        api.ctx.fill();
      });
    });
  }

  function bounds() {
    var out = [];
    SQUARES.forEach(function (s) {
      var half = (s.radius || Math.max(s.w, s.d) / 2) + 18;
      out.push({ x: s.x, z: s.z, half: half, y: 26 });
    });
    EXTRAS.forEach(function (e) {
      var half = e.kind === 'bridge' ? e.span / 2 : (e.kind === 'stadium' ? 62 : 28);
      var y = e.kind === 'tower' ? e.bodyH + e.mastH : (e.kind === 'bridge' ? e.towerH : 32);
      out.push({ x: e.x, z: e.z, half: half, y: y });
    });
    return out;
  }

  return {
    squares: squares,
    extras: extras,
    bounds: bounds,
    lines: lines,
    stopFractions: stopFractions,
    positionAt: positionAt,
    schedule: schedule,
    create: create,
    draw2D: draw2D
  };
});
