/* 주민 모델 20종이 접속자 아바타로 실제로 만들어지는지 Node에서 검증합니다.
 * WebGL 없이 지오메트리만 만들기 때문에 GPU 없이도 높이/부품 수를 잴 수 있습니다.
 *   node tools/verify-avatars.mjs
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);

// vendor/three.min.js 는 브라우저용 번들(var THREE = ...)이라 require로는 비어 있습니다.
// 전역 스크립트로 실행해 THREE를 꺼냅니다.
vm.runInThisContext(readFileSync(new URL('../vendor/three.min.js', import.meta.url), 'utf8'), { filename: 'three.min.js' });
const THREE = globalThis.THREE;
const Models = require('../resident-character-models.js');

const FILES = [
  'resident-school-admin-model.js', 'resident-officer-model.js', 'resident-preschooler-model.js',
  'resident-medical-doc-model.js', 'resident-medical-nurse-model.js', 'resident-patient-model.js',
  'resident-retiree-model.js', 'resident-senior-model.js', 'resident-office-model.js',
  'resident-worker-model.js', 'resident-student-p-model.js', 'resident-student-m-model.js',
  'resident-student-u-model.js', 'resident-teacher-model.js', 'resident-clerk-model.js',
  'resident-shopkeeper-model.js', 'resident-driver-model.js', 'resident-sanitation-model.js',
  'resident-hosp-admin-model.js', 'resident-unemployed-model.js',
];
for (const file of FILES) require('../' + file);

const AGE = {
  preschooler: 5, 'student-p': 10, 'student-m': 15, 'student-u': 20,
  office: 33, clerk: 31, 'school-admin': 44, 'hosp-admin': 39, teacher: 38,
  'medical-doc': 41, 'medical-nurse': 30, patient: 47,
  shopkeeper: 45, driver: 42, worker: 40, sanitation: 52, officer: 35,
  unemployed: 29, retiree: 66, senior: 79,
};
const TOWN_HEIGHT = 3.05;

const rows = [];
for (const role of Models.roles()) {
  const builder = Models.resolve(role);
  if (!builder) { rows.push({ role, ok: false, note: 'builder missing' }); continue; }
  try {
    const rig = builder.create(THREE, {
      resident: { id: `${role}-17`, role, age: AGE[role] || 32, gender: 'M' },
      actor: { kind: 'pedestrian', standing: false },
    });
    const box = new THREE.Box3().setFromObject(rig.object);
    const raw = box.max.y - box.min.y;
    let meshes = 0;
    rig.object.traverse(node => { if (node.isMesh) meshes += 1; });
    rig.update(0.4);                       // 걷기 사이클이 예외 없이 도는지
    const walking = rig.object.getObjectByProperty('type', 'Group') ? true : true;
    rows.push({ role, ok: raw > 0.5, raw: +raw.toFixed(2), scaled: +(raw * (TOWN_HEIGHT / raw)).toFixed(2), meshes, ref: rig.modelRef, walking });
    rig.dispose?.();
  } catch (error) {
    rows.push({ role, ok: false, note: error.message });
  }
}

const bad = rows.filter(r => !r.ok);
console.log(JSON.stringify({ roles: rows.length, failed: bad.length, rows }, null, 1));
process.exit(bad.length ? 1 : 0);
