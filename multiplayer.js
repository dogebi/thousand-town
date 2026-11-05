/* 大连town 접속자 — 자체 계정(JWT) + WebSocket 위치 동기화 + 유저 아바타.
 *
 * 서버는 "사람"만 압니다. NPC 1000명은 시드로 결정되므로 여기서 동기화하지 않습니다.
 * 아바타는 기존 마을 사람들과 같은 비율/재질을 쓰는 경량 절차 모델입니다.
 */
(function () {
  'use strict';

  // 정적 페이지(GitHub Pages)는 그대로 두고, 계정·동시접속만 이 서버로 붙습니다.
  // 로컬에서 열면 같은 주소(location.origin)의 서버를 씁니다.
  const REMOTE_API = 'https://town.cijyun.com';
  const API = (window.TOWN_API
    || (/(^|\.)github\.io$/.test(location.hostname) ? REMOTE_API : location.origin)
  ).replace(/\/+$/, '');
  const WS_URL = API.replace(/^http/, 'ws') + '/ws';
  const TOKEN_KEY = 'town.token';
  // 마을 주민 3D 모델 20종과 같은 키를 씁니다. server/server.mjs PROFESSIONS 와 일치.
  const ROLE_LABEL = {
    office: '职员', clerk: '银行办事', 'school-admin': '学校行政', 'hosp-admin': '医院行政', teacher: '教师',
    'medical-doc': '医生', 'medical-nurse': '护士', patient: '住院',
    shopkeeper: '店主', driver: '司机', worker: '工人', sanitation: '环卫', officer: '警员',
    preschooler: '学龄前儿童', 'student-p': '小学生', 'student-m': '中学生', 'student-u': '大学生',
    unemployed: '待业', retiree: '退休', senior: '高龄',
  };
  const ROLE_AGE = {
    preschooler: 5, 'student-p': 10, 'student-m': 15, 'student-u': 20,
    office: 33, clerk: 31, 'school-admin': 44, 'hosp-admin': 39, teacher: 38,
    'medical-doc': 41, 'medical-nurse': 30, patient: 47,
    shopkeeper: 45, driver: 42, worker: 40, sanitation: 52, officer: 35,
    unemployed: 29, retiree: 66, senior: 79,
  };
  const ROLE_GROUPS = [
    ['白领 · 行政', ['office', 'clerk', 'school-admin', 'hosp-admin', 'teacher']],
    ['医疗', ['medical-doc', 'medical-nurse', 'patient']],
    ['现场 · 服务', ['worker', 'shopkeeper', 'driver', 'sanitation', 'officer']],
    ['学生 · 儿童', ['preschooler', 'student-p', 'student-m', 'student-u']],
    ['居民', ['unemployed', 'retiree', 'senior']],
  ];
  const COLORS = ['#3f7fb0', '#c2554a', '#3f8f6a', '#8a6bb5', '#c98a2e', '#2f6f86', '#a8547a', '#4d6b3f'];
  const SEND_HZ = 12;
  const SPEED = 4.4;          // m/s — 마을 사람 보행보다 살짝 빠르게
  const TOWN_PERSON_HEIGHT = 3.05;   // 마을 주민 키(씬 단위)에 아바타를 맞춥니다
  const OFFLINE = location.protocol === 'file:' && !window.TOWN_API;

  const state = {
    token: null, user: null, socket: null, connected: false, online: 0,
    zone: null, zones: [],
    me: { x: 0, z: 0, h: 0, anim: 'idle', target: null, spawn: null },
    remotes: new Map(), retry: 0, ready: false,
  };
  let $panel, $hud, $log, $chat, $launch, $error, draft = { mode: 'login', prof: 'office', color: COLORS[0] };
  let scene = null, camera = null, selfGroup = null, selfTag = null, selfRing = null;
  let raycaster = null, groundPlane = null, clock = 0, lastSend = 0, lastTick = 0;

  // ── 작은 유틸 ─────────────────────────────────────────────────────────────
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const api = (path, options = {}) => fetch(API + path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(state.token ? { authorization: 'Bearer ' + state.token } : {}), ...(options.headers || {}) },
  }).then(async res => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `서버 오류 (${res.status})`);
    return body;
  });

  // ── 아바타 ────────────────────────────────────────────────────────────────
  function tagSprite(text, color) {
    const canvas = document.createElement('canvas');
    canvas.width = 384; canvas.height = 96;
    const ctx = canvas.getContext('2d');
    ctx.font = '700 40px "Noto Sans SC","PingFang SC","Microsoft YaHei",system-ui,sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = Math.min(360, ctx.measureText(text).width + 44);
    ctx.fillStyle = 'rgba(14,76,99,.82)';
    const r = 20, x = (384 - w) / 2, y = 22, h = 52;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y); ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r); ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r); ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.fill();
    // 옷 색을 이름표 하단 띠로 옮겨, 모델이 같아도 색으로 한 번 더 구분됩니다.
    ctx.fillStyle = color;
    ctx.fillRect(x + 8, y + h - 6, w - 16, 4);
    ctx.fillStyle = '#f6f1e2';
    ctx.fillText(text, 192, y + h / 2 + 2);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 2;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, depthWrite: false }));
    sprite.scale.set(2.4, 0.6, 1);
    sprite.renderOrder = 999;
    sprite.userData.color = color;
    return sprite;
  }

  function hash32(text) {
    let h = 2166136261;
    for (const ch of String(text)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  // 마을 주민 모델( resident-*-model.js )을 그대로 빌려 접속자 아바타로 씁니다.
  // 모듈이 없거나 실패하면 아래 경량 모델로 떨어집니다.
  function buildRealRig(prof, nickname, uid) {
    const registry = window.CityResidentCharacterModels;
    if (!registry || typeof registry.resolve !== 'function' || typeof THREE === 'undefined') return null;
    const builder = registry.resolve(prof);
    if (!builder) return null;
    try {
      const seed = hash32(`${uid || nickname}:${prof}`);
      const rig = builder.create(THREE, {
        resident: {
          id: `${prof}-${(seed % 97) + 1}`,
          role: prof,
          age: ROLE_AGE[prof] || 32,
          gender: (seed & 1) ? 'F' : 'M',
        },
        actor: { kind: 'pedestrian', standing: false },
      });
      if (!rig || !rig.object) return null;
      rig.object.rotation.y = 0;          // 키트 기본 회전(π/2)을 지우고 진행방향은 그룹이 맡습니다
      rig.object.position.set(0, 0, 0);
      const box = new THREE.Box3().setFromObject(rig.object);
      const measured = Math.max(0.4, box.max.y - box.min.y);
      const holder = new THREE.Group();
      holder.scale.setScalar(TOWN_PERSON_HEIGHT / measured);
      holder.add(rig.object);
      return { object: holder, rig, height: TOWN_PERSON_HEIGHT * 1.0 };
    } catch { return null; }
  }

  // 예비 모델 — 주민 모듈을 못 읽었을 때만 씁니다(같은 실루엣·같은 키).
  function buildFallbackRig(prof, colorHex) {
    const group = new THREE.Group();
    const cloth = new THREE.MeshStandardMaterial({ color: colorHex, roughness: .88, metalness: 0 });
    const skin = new THREE.MeshStandardMaterial({ color: '#efcdb4', roughness: .92, metalness: 0 });
    const dark = new THREE.MeshStandardMaterial({ color: '#2f3f4a', roughness: .9, metalness: 0 });
    const box = (w, h, d, mat, x, y, z) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      mesh.position.set(x, y, z);
      return mesh;
    };
    const limb = (x, y, w, h, d, mat) => {
      const pivot = new THREE.Group();
      pivot.position.set(x, y, 0);
      pivot.add(box(w, h, d, mat, 0, -h / 2, 0));
      return pivot;
    };
    const hips = new THREE.Group();
    hips.position.y = 0.92;
    hips.add(box(0.44, 0.56, 0.26, cloth, 0, 0.28, 0));
    const leftLeg = limb(-0.11, 0.92, 0.16, 0.9, 0.18, dark);
    const rightLeg = limb(0.11, 0.92, 0.16, 0.9, 0.18, dark);
    const leftArm = limb(-0.29, 1.44, 0.11, 0.62, 0.13, cloth);
    const rightArm = limb(0.29, 1.44, 0.11, 0.62, 0.13, cloth);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 18, 14), skin);
    head.position.y = 1.72;
    group.add(hips, leftLeg, rightLeg, leftArm, rightArm, head);
    const holder = new THREE.Group();
    holder.scale.setScalar(TOWN_PERSON_HEIGHT / 1.95);
    holder.add(group);
    return { object: holder, leftLeg, rightLeg, leftArm, rightArm, hips, height: TOWN_PERSON_HEIGHT };
  }

  function buildAvatar(prof, colorHex, nickname, uid) {
    const group = new THREE.Group();
    const real = buildRealRig(prof, nickname, uid);
    const fallback = real ? null : buildFallbackRig(prof, colorHex);
    const body = real || fallback;
    group.add(body.object);

    const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.56, 24),
      new THREE.MeshBasicMaterial({ color: colorHex, transparent: true, opacity: .5, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.03;
    group.add(ring);

    const tag = tagSprite(nickname, colorHex);
    tag.position.y = body.height + 0.5;
    group.add(tag);

    group.userData = {
      rig: real ? real.rig : null,
      leftLeg: fallback && fallback.leftLeg, rightLeg: fallback && fallback.rightLeg,
      leftArm: fallback && fallback.leftArm, rightArm: fallback && fallback.rightArm,
      hips: fallback && fallback.hips,
      tag, ring, height: body.height, walk: 0, phase: Math.random() * 6.28,
    };
    return group;
  }

  function animateAvatar(group, moving, dt) {
    const u = group.userData;
    if (u.rig) {
      if (moving) { u.walk += dt; u.rig.update(u.walk); }
      else if (u.walk) { u.walk = 0; u.rig.update(0); }
      return;
    }
    if (!u.leftLeg) return;
    u.phase += dt * (moving ? 9.2 : 2.2);
    const swing = Math.sin(u.phase) * (moving ? 0.55 : 0.06);
    u.leftLeg.rotation.x = swing;
    u.rightLeg.rotation.x = -swing;
    u.leftArm.rotation.x = -swing * 0.8;
    u.rightArm.rotation.x = swing * 0.8;
    u.hips.position.y = 0.92 + (moving ? Math.abs(Math.cos(u.phase)) * 0.035 : 0);
  }

  // ── 씬 연결 ───────────────────────────────────────────────────────────────
  function bindScene() {
    if (scene || !window.cityStudio || !window.cityStudio.scene) return !!scene;
    scene = window.cityStudio.scene();
    camera = window.cityStudio.camera && window.cityStudio.camera();
    if (!scene) return false;
    raycaster = new THREE.Raycaster();
    groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    return true;
  }

  function spawnPoint() {
    const plan = window.cityStudio && window.cityStudio.getPlan ? window.cityStudio.getPlan() : null;
    if (!plan || !plan.buildings || !plan.buildings.length) return { x: 0, z: 0 };
    let x = 0, z = 0;
    for (const b of plan.buildings) { x += b.x; z += b.z; }
    x /= plan.buildings.length; z /= plan.buildings.length;
    return freeSpot(x, z);
  }

  function footprints() {
    const plan = window.cityStudio && window.cityStudio.getPlan ? window.cityStudio.getPlan() : null;
    return (plan && plan.buildings) || [];
  }

  function inside(b, x, z, pad = 0.5) {
    return Math.abs(x - b.x) <= b.w * 0.5 + pad && Math.abs(z - b.z) <= b.d * 0.5 + pad;
  }

  function freeSpot(x, z) {
    for (const b of footprints()) {
      if (!inside(b, x, z, 1.2)) continue;
      const dx = b.w * 0.5 + 1.4, dz = b.d * 0.5 + 1.4;
      const ox = Math.abs(x - b.x) - b.w * 0.5, oz = Math.abs(z - b.z) - b.d * 0.5;
      if (ox > oz) x = b.x + Math.sign(x - b.x || 1) * dx;
      else z = b.z + Math.sign(z - b.z || 1) * dz;
    }
    return { x, z };
  }

  function blocked(x, z) {
    for (const b of footprints()) if (inside(b, x, z, 0.45)) return true;
    return false;
  }

  // ── 네트워크 ──────────────────────────────────────────────────────────────
  function connect() {
    if (state.socket || !state.token) return;
    let socket;
    try { socket = new WebSocket(`${WS_URL}?token=${encodeURIComponent(state.token)}`); }
    catch (error) { setStatus('서버 주소 오류', false); return; }
    state.socket = socket;

    socket.onopen = () => {
      state.connected = true; state.retry = 0;
      setStatus(`${state.user.nickname} · 접속됨`, true);
      sendPos(true);
    };
    socket.onmessage = event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      switch (msg.t) {
        case 'welcome':
          state.online = msg.online || 1;
          if (msg.spawn) {
            state.me.spawn = { x: msg.spawn.x, z: msg.spawn.z };
            // 아바타가 이미 서 있으면 서버가 배정한 구역으로 옮겨 줍니다(첫 프레임 경합 보정).
            if (!state.userMoved) {
              const spot = freeSpot(msg.spawn.x, msg.spawn.z);
              state.me.x = spot.x; state.me.z = spot.z; state.me.target = null;
              if (selfGroup) selfGroup.position.set(state.me.x, 0, state.me.z);
            }
          }
          if (msg.zone) state.zone = msg.zone;
          if (Array.isArray(msg.zones)) state.zones = msg.zones;
          for (const p of msg.players || []) upsertRemote(p);
          refreshHud();
          log(`마을에 들어왔습니다 · ${state.zone ? state.zone.name + ' · ' : ''}지금 ${state.online}명`, true);
          break;
        case 'zone':
          state.zone = { id: msg.id, name: msg.name, count: msg.count, capacity: msg.capacity };
          refreshHud();
          log(`${msg.name} 구역으로 이동했습니다 · 이 구역 ${msg.count}명`, true);
          break;
        case 'join':
          upsertRemote(msg);
          log(`${msg.nickname} 님이 들어왔습니다`, true);
          break;
        case 'leave': removeRemote(msg.id); break;
        case 'pos': updateRemote(msg); break;
        case 'who': {
          const remote = state.remotes.get(msg.id);
          if (remote) {
            remote.nickname = msg.nickname || remote.nickname;
            remote.prof = msg.prof || remote.prof;
            remote.color = msg.color || remote.color;
            rebuildRemote(remote);
          }
          break;
        }
        case 'chat': log(`<b>${escapeHtml(msg.nickname)}</b> ${escapeHtml(msg.text)}`); break;
        case 'emote': playEmote(msg.id, msg.kind); break;
        case 'online':
          state.online = msg.n;
          if (Array.isArray(msg.zones)) {
            state.zones = msg.zones;
            const mine = msg.zones.find(z => state.zone && z.id === state.zone.id);
            if (mine) state.zone = { ...state.zone, ...mine };
          }
          refreshHud();
          break;
      }
    };
    socket.onclose = () => {
      state.socket = null; state.connected = false;
      setStatus('연결 끊김 · 다시 시도 중', false);
      const delay = Math.min(15000, 1200 * Math.pow(1.8, state.retry++));
      setTimeout(() => { if (state.token) connect(); }, delay);
    };
    socket.onerror = () => {};
  }

  function send(payload) {
    if (state.socket && state.socket.readyState === 1) state.socket.send(JSON.stringify(payload));
  }
  function sendPos(force) {
    const now = performance.now();
    if (!force && now - lastSend < 1000 / SEND_HZ - 6) return;
    lastSend = now;
    send({ t: 'pos', x: state.me.x, z: state.me.z, h: state.me.h, a: state.me.anim });
  }

  function upsertRemote(p) {
    let remote = state.remotes.get(p.id);
    if (!remote) {
      remote = { id: p.id, nickname: p.nickname, prof: p.prof || 'office', color: p.color || COLORS[0], x: p.x || 0, z: p.z || 0, h: p.h || 0, anim: p.a || 'idle', tx: p.x || 0, tz: p.z || 0, group: null };
      state.remotes.set(p.id, remote);
      rebuildRemote(remote);
    } else {
      remote.tx = p.x; remote.tz = p.z;
    }
    if (remote.group) remote.group.visible = true;
    refreshHud();
  }

  function updateRemote(msg) {
    const remote = state.remotes.get(msg.id);
    if (!remote) return;
    remote.tx = msg.x; remote.tz = msg.z; remote.h = msg.h; remote.anim = msg.a || 'idle';
    remote.seen = performance.now();
  }

  function rebuildRemote(remote) {
    if (!scene) return;
    if (remote.group) { scene.remove(remote.group); disposeGroup(remote.group); }
    remote.group = buildAvatar(remote.prof, remote.color, remote.nickname, remote.id);
    remote.group.position.set(remote.tx || remote.x, 0, remote.tz || remote.z);
    scene.add(remote.group);
    remote.x = remote.tx || remote.x; remote.z = remote.tz || remote.z;
  }

  function removeRemote(id) {
    const remote = state.remotes.get(id);
    if (!remote) return;
    if (remote.group && scene) { scene.remove(remote.group); disposeGroup(remote.group); }
    state.remotes.delete(id);
    refreshHud();
  }

  function disposeGroup(group) {
    group.traverse(node => {
      if (node.geometry) node.geometry.dispose();
      if (node.material) {
        if (node.material.map) node.material.map.dispose();
        node.material.dispose();
      }
    });
  }

  function playEmote(id, kind) {
    const remote = state.remotes.get(id);
    const group = id === state.user?.id ? selfGroup : remote && remote.group;
    if (!group) return;
    group.userData.emote = { kind, t: 0 };
  }

  // ── 매 프레임 ─────────────────────────────────────────────────────────────
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - (lastTick || now)) / 1000);
    lastTick = now;
    if (!state.user) return;

    if (!selfGroup && bindScene()) {
      selfGroup = buildAvatar(state.user.prof, state.user.color, state.user.nickname, state.user.id);
      if (!state.spawned) {
        const spawn = state.me.spawn || spawnPoint();
        state.me.x = spawn.x; state.me.z = spawn.z;
        const spot = freeSpot(state.me.x, state.me.z);
        state.me.x = spot.x; state.me.z = spot.z;
        state.spawned = true;
      }
      selfGroup.position.set(state.me.x, 0, state.me.z);
      scene.add(selfGroup);
      state.ready = true;
    }
    if (!selfGroup) return;

    let moving = false;
    const goal = state.me.target;
    if (goal) {
      const dx = goal.x - state.me.x, dz = goal.z - state.me.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.35) {
        state.me.target = null;
        state.me.anim = 'idle';
      } else {
        const step = Math.min(dist, SPEED * dt);
        const nx = state.me.x + (dx / dist) * step;
        const nz = state.me.z + (dz / dist) * step;
        if (!blocked(nx, nz) || dist < 0.9) {
          state.me.x = nx; state.me.z = nz;
          moving = true;
          state.me.h = Math.atan2(dx, dz) + Math.PI;
          state.me.anim = 'walk';
        } else {
          state.me.target = null;
          state.me.anim = 'idle';
        }
      }
    }
    selfGroup.position.set(state.me.x, 0, state.me.z);
    selfGroup.rotation.y = state.me.h;
    animateAvatar(selfGroup, moving, dt);
    if (moving) sendPos(false);
    else if (now - lastSend > 3000) sendPos(true);

    for (const remote of state.remotes.values()) {
      if (!remote.group) continue;
      const k = Math.min(1, dt * 7.5);
      remote.x += (remote.tx - remote.x) * k;
      remote.z += (remote.tz - remote.z) * k;
      remote.group.position.set(remote.x, 0, remote.z);
      const want = Math.atan2(remote.tx - remote.x, remote.tz - remote.z);
      if (Math.hypot(remote.tx - remote.x, remote.tz - remote.z) > 0.05) {
        let diff = ((want + Math.PI - remote.group.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
        remote.group.rotation.y += diff * Math.min(1, dt * 6);
      }
      animateAvatar(remote.group, Math.hypot(remote.tx - remote.x, remote.tz - remote.z) > 0.25, dt);
      if (remote.seen && now - remote.seen > 20000) { removeRemote(remote.id); }
    }
    tickEmote(selfGroup, dt);
    for (const remote of state.remotes.values()) if (remote.group) tickEmote(remote.group, dt);
  }

  function tickEmote(group, dt) {
    const e = group.userData.emote;
    if (!e) return;
    e.t += dt;
    if (e.kind === 'wave') {
      if (group.userData.rightArm) group.userData.rightArm.rotation.z = Math.sin(e.t * 12) * 0.5 - 0.2;
      else group.rotation.z = Math.sin(e.t * 10) * 0.05;
    } else if (e.kind === 'jump') {
      group.position.y = Math.abs(Math.sin(e.t * 6)) * 0.6;
    } else if (e.kind === 'dance') {
      group.rotation.z = Math.sin(e.t * 8) * 0.09;
      if (group.userData.leftLeg) group.userData.leftLeg.rotation.x = Math.sin(e.t * 8) * 0.4;
      if (group.userData.rightLeg) group.userData.rightLeg.rotation.x = -Math.sin(e.t * 8) * 0.4;
    }
    if (e.t > 2.4) {
      group.position.y = 0;
      group.rotation.z = 0;
      if (group.userData.rightArm) group.userData.rightArm.rotation.z = 0;
      delete group.userData.emote;
    }
  }

  // ── 클릭 이동 ─────────────────────────────────────────────────────────────
  let pressAt = null;
  function onStagePointer(event) {
    if (!state.ready || !camera || !raycaster) return;
    const target = event.target;
    if (!target || target.tagName !== 'CANVAS') return;
    if (event.type === 'pointerdown') { pressAt = { x: event.clientX, y: event.clientY, t: performance.now() }; return; }
    if (!pressAt) return;
    const moved = Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y);
    const held = performance.now() - pressAt.t;
    pressAt = null;
    if (moved > 6 || held > 900) return;   // 카메라 드래그는 이동으로 보지 않습니다
    if (window.cityStudio.pickPersonAt && window.cityStudio.pickPersonAt(event.clientX, event.clientY)) return;
    const rect = window.cityStudio.stageRect();
    const ndc = new THREE.Vector2(((event.clientX - rect.x) / rect.width) * 2 - 1, -((event.clientY - rect.y) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(groundPlane, hit)) return;
    const spot = freeSpot(hit.x, hit.z);
    state.userMoved = true;
    state.me.target = { x: clamp(spot.x, -520, 520), z: clamp(spot.z, -520, 520) };
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }

  function buildUi() {
    $launch = el('div');
    $launch.id = 'mp';
    $launch.innerHTML = `<button class="mp-btn" id="mp-open"><span class="mp-dot"></span><span id="mp-launch-text">登录 · 多人</span></button>`;
    document.body.appendChild($launch);

    $hud = el('div');
    $hud.id = 'mp-hud';
    $hud.className = 'hidden';
    $hud.innerHTML = `
      <div class="mp-hud-top">
        <span class="mp-who" id="mp-nick">—</span>
        <button class="mp-zone" id="mp-zone" title="구역 이동">—</button>
      </div>
      <div class="mp-online" id="mp-count">—</div>
      <div class="mp-log" id="mp-log"></div>
      <div class="mp-row"><input id="mp-chat" maxlength="120" placeholder="근처 사람에게 말 걸기 (Enter)" autocomplete="off"></div>
      <div class="mp-emoji">
        <button data-emote="wave" title="손 흔들기">👋</button>
        <button data-emote="jump" title="점프">✨</button>
        <button data-emote="dance" title="춤">🎉</button>
      </div>
      <div class="mp-tools">
        <button class="mp-btn" id="mp-find">내 위치</button>
        <button class="mp-btn" id="mp-zones">구역</button>
        <button class="mp-btn" id="mp-profile">프로필</button>
        <button class="mp-btn" id="mp-out">나가기</button>
      </div>`;
    document.body.appendChild($hud);
    $log = $hud.querySelector('#mp-log');
    $chat = $hud.querySelector('#mp-chat');

    $panel = el('div');
    $panel.id = 'mp-panel';
    $panel.className = 'hidden';
    document.body.appendChild($panel);

    $launch.querySelector('#mp-open').addEventListener('click', () => {
      if (state.user) { $hud.classList.toggle('hidden'); }
      else openPanel('login');
    });
    $chat.addEventListener('keydown', event => {
      if (event.key === 'Enter') {
        const text = $chat.value.trim();
        if (text) { send({ t: 'chat', text }); $chat.value = ''; }
      } else if (event.key === 'Escape') $chat.blur();
    });
    $hud.querySelectorAll('[data-emote]').forEach(button => {
      button.addEventListener('click', () => {
        const kind = button.dataset.emote;
        send({ t: 'emote', kind });
        if (selfGroup) selfGroup.userData.emote = { kind, t: 0 };
      });
    });
    $hud.querySelector('#mp-find').addEventListener('click', () => {
      if (window.cityStudio && window.cityStudio.flyTo) window.cityStudio.flyTo(state.me.x, state.me.z, 2.4, 0.7, window.cityStudio.getState().yaw);
    });
    $hud.querySelector('#mp-profile').addEventListener('click', () => openPanel('profile'));
    $hud.querySelector('#mp-out').addEventListener('click', logout);
    $hud.querySelector('#mp-zone').addEventListener('click', openZones);
    $hud.querySelector('#mp-zones').addEventListener('click', openZones);
    window.addEventListener('pointerdown', onStagePointer, true);
    window.addEventListener('pointerup', onStagePointer, true);
  }

  // 존 이동 — 1,000명을 9개 구역으로 나눠 받는 구조를 화면에서도 보여줍니다.
  function openZones() {
    if (!state.user) return;
    const zones = state.zones.length ? state.zones : (state.zone ? [state.zone] : []);
    $panel.classList.remove('hidden');
    $panel.innerHTML = `
      <div class="mp-card">
        <h2>구역 이동</h2>
        <p class="sub">마을은 9개 구역으로 나뉘고, 위치·채팅은 같은 구역 안에서만 오갑니다.<br>
        구역당 정원 130명 · 전체 1,170명까지 접속할 수 있습니다.</p>
        <div class="mp-zone-grid">${zones.map(z =>
          `<button data-zone="${z.id}" class="${state.zone && state.zone.id === z.id ? 'on' : ''}">
            <b>${escapeHtml(z.name)}</b>${z.count}/${z.capacity ?? 130}</button>`).join('')}</div>
        <div class="mp-actions"><button class="mp-btn" id="mp-close">닫기</button></div>
      </div>`;
    $panel.querySelector('#mp-close').addEventListener('click', () => $panel.classList.add('hidden'));
    $panel.querySelectorAll('[data-zone]').forEach(button => {
      button.addEventListener('click', () => {
        const zone = zones.find(z => z.id === button.dataset.zone);
        if (!zone) return;
        const spot = freeSpot(zone.x, zone.z);
        state.userMoved = true;
        state.me.x = spot.x; state.me.z = spot.z; state.me.target = null;
        if (selfGroup) selfGroup.position.set(state.me.x, 0, state.me.z);
        sendPos(true);
        $panel.classList.add('hidden');
        if (window.cityStudio && window.cityStudio.flyTo) {
          window.cityStudio.flyTo(state.me.x, state.me.z, 2.2, 0.72, window.cityStudio.getState().yaw);
        }
      });
    });
  }

  function openPanel(mode) {
    if (OFFLINE) {
      $panel.classList.remove('hidden');
      $panel.innerHTML = `<div class="mp-card"><h2>서버가 아직 연결되지 않았습니다</h2>
        <p class="sub">이 페이지는 정적 파일로 배포되어 있고, 계정·동시접속 서버는 따로 실행해야 합니다.<br>
        로컬: <code>node server/server.mjs</code> → http://localhost:8787/index.html</p>
        <div class="mp-actions"><button class="mp-btn" id="mp-close">닫기</button></div></div>`;
      $panel.querySelector('#mp-close').addEventListener('click', () => $panel.classList.add('hidden'));
      return;
    }
    draft.mode = mode === 'profile' ? 'profile' : (mode || draft.mode);
    const isProfile = draft.mode === 'profile';
    const user = state.user;
    $panel.classList.remove('hidden');
    $panel.innerHTML = `
      <div class="mp-card">
        <h2>${isProfile ? '프로필 바꾸기' : '大连town 접속'}</h2>
        <p class="sub">${isProfile ? '아바타 직업과 색은 언제든 바꿀 수 있습니다.' : '계정 하나로 어느 기기에서든 같은 아바타로 마을에 들어옵니다.'}</p>
        ${isProfile ? '' : `<div class="mp-tabs">
          <button data-mode="login" class="${draft.mode === 'login' ? 'on' : ''}">로그인</button>
          <button data-mode="register" class="${draft.mode === 'register' ? 'on' : ''}">처음 오셨나요</button>
        </div>`}
        ${isProfile ? '' : `<div class="mp-field"><label>이메일</label><input id="mp-email" type="email" autocomplete="username" value="${user ? escapeHtml(user.email) : ''}"></div>`}
        ${isProfile ? '' : `<div class="mp-field"><label>비밀번호 (8자 이상)</label><input id="mp-pass" type="password" autocomplete="${draft.mode === 'register' ? 'new-password' : 'current-password'}"></div>`}
        <div class="mp-field"><label>닉네임</label><input id="mp-name" maxlength="12" value="${user ? escapeHtml(user.nickname) : ''}" placeholder="2~12자"></div>
        <div class="mp-label">직업 모델 (마을 주민 20종)</div>
        <div class="mp-roles">${ROLE_GROUPS.map(([group, roles]) => `
          <div class="mp-role-group"><h4>${group}</h4>
            <div class="mp-profs">${roles.map(key =>
              `<button data-prof="${key}" class="${draft.prof === key ? 'on' : ''}">${ROLE_LABEL[key] || key}</button>`).join('')}</div>
          </div>`).join('')}</div>
        <div class="mp-label">이름표 색</div>
        <div class="mp-colors">${COLORS.map(c =>
          `<button data-color="${c}" class="${draft.color === c ? 'on' : ''}" style="background:${c}"></button>`).join('')}</div>
        <div class="mp-error" id="mp-error"></div>
        <div class="mp-actions">
          ${isProfile
            ? `<button class="mp-btn" id="mp-cancel">취소</button><button class="mp-btn primary" id="mp-save">저장</button>`
            : `<button class="mp-btn" id="mp-cancel">닫기</button><button class="mp-btn primary" id="mp-submit">${draft.mode === 'register' ? '가입하고 들어가기' : '들어가기'}</button>`}
        </div>
        <div class="mp-foot">닉네임과 아바타는 마을 안에서 다른 접속자에게 보입니다.<br>비밀번호는 서버에 scrypt 해시로만 저장됩니다.</div>
      </div>`;

    const draftFromDom = () => {
      draft.prof = $panel.querySelector('.mp-profs .on')?.dataset.prof || draft.prof;
      draft.color = $panel.querySelector('.mp-colors .on')?.dataset.color || draft.color;
    };
    $panel.querySelectorAll('.mp-tabs button').forEach(button => button.addEventListener('click', () => {
      draft.mode = button.dataset.mode;
      const name = $panel.querySelector('#mp-name').value;
      const email = $panel.querySelector('#mp-email').value;
      openPanel(draft.mode);
      $panel.querySelector('#mp-name').value = name;
      $panel.querySelector('#mp-email').value = email;
    }));
    $panel.querySelectorAll('.mp-profs button').forEach(button => button.addEventListener('click', () => {
      $panel.querySelectorAll('.mp-profs button').forEach(b => b.classList.remove('on'));
      button.classList.add('on');
    }));
    $panel.querySelectorAll('.mp-colors button').forEach(button => button.addEventListener('click', () => {
      $panel.querySelectorAll('.mp-colors button').forEach(b => b.classList.remove('on'));
      button.classList.add('on');
    }));
    $panel.querySelector('#mp-cancel').addEventListener('click', () => $panel.classList.add('hidden'));
    const fail = message => { $error.textContent = message; };
    $error = $panel.querySelector('#mp-error');
    const submit = $panel.querySelector('#mp-submit');
    if (submit) {
      submit.addEventListener('click', async () => {
        draftFromDom();
        const email = $panel.querySelector('#mp-email').value.trim();
        const password = $panel.querySelector('#mp-pass').value;
        const nickname = $panel.querySelector('#mp-name').value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('이메일 형식을 확인해 주세요.');
        if (draft.mode === 'register' && password.length < 8) return fail('비밀번호는 8자 이상이어야 합니다.');
        submit.disabled = true;
        try {
          const body = draft.mode === 'register'
            ? await api('/api/register', { method: 'POST', body: JSON.stringify({ email, password, nickname, prof: draft.prof, color: draft.color }) })
            : await api('/api/login', { method: 'POST', body: JSON.stringify({ email, password }) });
          $panel.classList.add('hidden');
          enter(body);
        } catch (error) {
          fail(error.message);
        } finally {
          submit.disabled = false;
        }
      });
    }
    const save = $panel.querySelector('#mp-save');
    if (save) {
      save.addEventListener('click', async () => {
        draftFromDom();
        const nickname = $panel.querySelector('#mp-name').value.trim();
        save.disabled = true;
        try {
          const body = await api('/api/profile', { method: 'POST', body: JSON.stringify({ nickname, prof: draft.prof, color: draft.color }) });
          state.user = body.user;
          $panel.classList.add('hidden');
          applyProfile();
          log('프로필을 바꿨습니다', true);
        } catch (error) {
          fail(error.message);
        } finally {
          save.disabled = false;
        }
      });
    }
  }

  function applyProfile() {
    if (selfGroup && scene) {
      scene.remove(selfGroup);
      disposeGroup(selfGroup);
      selfGroup = null; selfRing = null;
    }
    if (window.cityStudio && window.cityStudio.refreshResidentNames) { /* noop */ }
    setStatus(`${state.user.nickname} · ${state.connected ? '접속됨' : '연결 중'}`, state.connected);
    refreshHud();
  }

  function enter(body) {
    state.token = body.token;
    state.user = body.user;
    try { localStorage.setItem(TOKEN_KEY, state.token); } catch {}
    draft.prof = body.user.prof;
    draft.color = body.user.color;
    applyProfile();
    $hud.classList.remove('hidden');
    log(`${body.user.nickname} 님으로 들어왔습니다`, true);
    connect();
  }

  function logout() {
    try { fetch(API + '/api/logout', { method: 'POST', headers: { authorization: 'Bearer ' + state.token } }); } catch {}
    try { localStorage.removeItem(TOKEN_KEY); } catch {}
    if (state.socket) { state.socket.close(); state.socket = null; }
    for (const remote of [...state.remotes.values()]) removeRemote(remote.id);
    if (selfGroup && scene) { scene.remove(selfGroup); disposeGroup(selfGroup); }
    selfGroup = null; selfRing = null;
    state.token = null; state.user = null; state.connected = false; state.online = 0;
    $hud.classList.add('hidden');
    setStatus('登录 · 多人', false);
    log('로그아웃했습니다', true);
  }

  function setStatus(text, online) {
    const label = document.getElementById('mp-launch-text');
    const dot = document.querySelector('#mp-open .mp-dot');
    if (label) label.textContent = text;
    if (dot) dot.classList.toggle('on', !!online);
  }

  function refreshHud() {
    const count = document.getElementById('mp-count');
    const nick = document.getElementById('mp-nick');
    const zone = document.getElementById('mp-zone');
    if (count) count.textContent = `${state.online}명 접속 · 근처 ${state.remotes.size}명`;
    if (zone) zone.textContent = state.zone ? `${state.zone.name} ${state.zone.count}/${state.zone.capacity || 130}` : '구역 —';
    if (nick) nick.textContent = state.user ? `${ROLE_LABEL[state.user.prof] || ''} ${state.user.nickname}` : '—';
  }

  function log(html, system) {
    if (!$log) return;
    const line = el('div', 'mp-line' + (system ? ' system' : ''));
    line.innerHTML = html;
    $log.appendChild(line);
    while ($log.children.length > 30) $log.removeChild($log.firstChild);
    $log.scrollTop = $log.scrollHeight;
  }

  // ── 시작 ──────────────────────────────────────────────────────────────────
  async function boot() {
    buildUi();
    window.addEventListener('resize', () => {});
    requestAnimationFrame(frame);
    try { state.token = localStorage.getItem(TOKEN_KEY); } catch {}
    if (!state.token) { setStatus(OFFLINE ? '서버 미연결' : '登录 · 多人', false); return; }
    try {
      const body = await api('/api/me');
      state.user = body.user;
      draft.prof = body.user.prof; draft.color = body.user.color;
      applyProfile();
      $hud.classList.remove('hidden');
      connect();
    } catch {
      try { localStorage.removeItem(TOKEN_KEY); } catch {}
      state.token = null;
      setStatus(OFFLINE ? '서버 미연결' : '登录 · 多人', false);
    }
  }

  window.CityMP = {
    state,
    me: () => ({ x: state.me.x, z: state.me.z, target: state.me.target, ready: state.ready }),
    teleport: (x, z) => { state.me.x = Number(x); state.me.z = Number(z); state.me.target = null; if (selfGroup) selfGroup.position.set(x, 0, z); sendPos(true); },
    walkTo: (x, z) => { state.me.target = { x: Number(x), z: Number(z) }; },
    emote: kind => { send({ t: 'emote', kind }); if (selfGroup) selfGroup.userData.emote = { kind, t: 0 }; },
    chat: text => send({ t: 'chat', text }),
    remotes: () => [...state.remotes.values()].map(r => ({ id: r.id, nickname: r.nickname, x: r.x, z: r.z, prof: r.prof, color: r.color })),
    // QA: 아바타 생성 경로를 직접 확인할 수 있게 열어 둡니다.
    buildAvatar: (prof, uid) => buildAvatar(prof, COLORS[0], 'test', uid || 'qa'),
    open: () => openPanel('login'),
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
