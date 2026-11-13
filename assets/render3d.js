/* «Стыковка» — 3D-слой скина «Игрушка» (three.js 0.185.1, vendor/three.js). Грузится только при выборе 3D.
   Принцип: игра рисует, как раньше, в виртуальных координатах canvas 2D; в 3D-режиме функции рисования фигур
   (модуль, ферма, ядро, обломок, отражатель, излучатели поля, шлюз) не рисуют, а записывают вызов сюда — с текущей
   матрицей холста (в ней DPR, масштаб, тряска и приближение победы). Конец кадра расставляет модели из пулов и рисует.
   Камера ортографическая с наклоном PHI; мир по Z растянут на 1/sin(PHI), поэтому плоскость y = 0 ложится на экран
   один в один с 2D-координатами: касания, превью, частицы и слова остаются в 2D поверх 3D без пересчёта.
   Модели собраны из примитивов (таблица ART3): деталь = геометрия + цвет + группа материала (body/metal/glass). */
(function(){
'use strict';
const T = window.THREE;
const PHI = 64 * Math.PI / 180;                 // наклон камеры от горизонта: 90° — строго сверху; 64° — видно переднюю грань
const SIN = Math.sin(PHI), COS = Math.cos(PHI);
// Цвета и материалы — одно место (скин «Игрушка», мокап направления A)
const C3 = {
  white: '#f4f1fb', whiteSh: '#cfc8e6', orange: '#ff8a2a', orange2: '#ffb02e', blue: '#2d6cff', blueDeep: '#2457e0',
  gold: '#ffbf2e', goldDeep: '#d98a12', chrome: '#e6ecff', teal: '#27e0d0', tealDeep: '#0f7f99', rock: '#a596cc', rockDeep: '#6f5f9e',
  navy: '#26205a', violet: '#a35cff', shadow: '#12062a', lamp: '#fff1a8', bad: '#ff4d6d',
  hemiSky: '#f1eeff', hemiGround: '#5a4a7a', key: '#fff6ea', rim: '#9a86ff',
};
const R3 = window.R3 = { ready: false, PHI, C3, stats: { calls: 0, items: 0 } };
let renderer = null, scene, cam, root, cw = 0, ch = 0, envTex = null;

// ---------- геометрия ----------
// Скруглённый брусок w×h×d (h — высота по Y), радиус фаски r: выдавливание скруглённого прямоугольника с фаской.
function rbox(w, h, d, r, seg){
  r = Math.min(r, w / 2 - 1e-3, d / 2 - 1e-3, h / 2 - 1e-3);
  const iw = w - 2 * r, id = d - 2 * r, rr = Math.min(iw, id) * 0.25, s = new T.Shape();
  s.moveTo(-iw / 2 + rr, -id / 2); s.lineTo(iw / 2 - rr, -id / 2); s.quadraticCurveTo(iw / 2, -id / 2, iw / 2, -id / 2 + rr);
  s.lineTo(iw / 2, id / 2 - rr); s.quadraticCurveTo(iw / 2, id / 2, iw / 2 - rr, id / 2); s.lineTo(-iw / 2 + rr, id / 2);
  s.quadraticCurveTo(-iw / 2, id / 2, -iw / 2, id / 2 - rr); s.lineTo(-iw / 2, -id / 2 + rr); s.quadraticCurveTo(-iw / 2, -id / 2, -iw / 2 + rr, -id / 2);
  const g = new T.ExtrudeGeometry(s, { depth: Math.max(1e-3, h - 2 * r), bevelEnabled: true, bevelThickness: r, bevelSize: r, bevelSegments: seg || 3, curveSegments: 4 });
  g.translate(0, 0, -(h - 2 * r) / 2); g.rotateX(-Math.PI / 2);          // выдавливание вдоль Y, центр в нуле
  return g;
}
const cyl = (r, h, n) => new T.CylinderGeometry(r, r, h, n || 20);
// Деталь: геометрия, цвет, позиция, поворот (эйлер), группа материала
function P(geo, col, pos, rot, grp){ return { geo, col, pos: pos || [0, 0, 0], rot: rot || [0, 0, 0], grp: grp || 'body' }; }
// Слить детали одной группы в одну геометрию с цветом вершин
function mergeParts(parts){
  const pos = [], nor = [], col = [], c = new T.Color(), m = new T.Matrix4(), e = new T.Euler(), q = new T.Quaternion(), one = new T.Vector3(1, 1, 1);
  for (const p of parts){
    const g = (p.geo.index ? p.geo.toNonIndexed() : p.geo.clone());
    m.compose(new T.Vector3(...p.pos), q.setFromEuler(e.set(...p.rot)), one); g.applyMatrix4(m);
    const a = g.attributes.position.array, n = g.attributes.normal.array; c.set(p.col);   // set() уже переводит sRGB → linear
    for (let k = 0; k < a.length; k++){ pos.push(a[k]); nor.push(n[k]); }
    for (let k = 0; k < a.length / 3; k++) col.push(c.r, c.g, c.b);
  }
  const out = new T.BufferGeometry();
  out.setAttribute('position', new T.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new T.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new T.Float32BufferAttribute(col, 3)); out.computeBoundingSphere();
  return out;
}

// ---------- модели (единица = размер фигуры, переданный игрой; +X — нос, Y — вверх) ----------
// Сопло — отдельная деталь: видно только у модуля в очереди и в полёте.
function nozzleParts(back){ return [P(new T.CylinderGeometry(0.1, 0.2, 0.2, 16), C3.chrome, [back - 0.07, 0.26, 0], [0, 0, Math.PI / 2], 'metal'),
  P(cyl(0.12, 0.05, 16), '#5a4a8a', [back - 0.18, 0.26, 0], [0, 0, Math.PI / 2], 'metal')]; }
function trussParts(L){
  const parts = [], h = L / 2, inner = h - 0.2, n = 6;
  for (const z of [-0.3, 0.3]){ parts.push(P(rbox(L - 0.36, 0.12, 0.12, 0.05), C3.orange, [0, 0.42, z]), P(rbox(L - 0.36, 0.1, 0.1, 0.04), C3.orange, [0, 0.12, z])); }
  for (let k = 0; k < n; k++){                                                    // раскосы зигзагом: верхняя грань и боковые
    const x0 = -inner + (2 * inner) * k / n, x1 = -inner + (2 * inner) * (k + 1) / n, z0 = k % 2 ? 0.3 : -0.3, z1 = -z0;
    const len = Math.hypot(x1 - x0, z1 - z0), ang = Math.atan2(z1 - z0, x1 - x0);
    parts.push(P(cyl(0.035, len, 8), C3.orange2, [(x0 + x1) / 2, 0.42, (z0 + z1) / 2], [0, -ang, Math.PI / 2]));
    for (const z of [-0.3, 0.3]) parts.push(P(cyl(0.03, Math.hypot(x1 - x0, 0.3), 8), C3.orange2, [(x0 + x1) / 2, 0.27, z], [0, 0, (k % 2 ? 1 : -1) * Math.atan2(x1 - x0, 0.3)]));
  }
  for (const s of [-1, 1]){
    parts.push(P(rbox(0.36, 0.5, 0.86, 0.1), C3.orange, [s * (h - 0.18), 0.25, 0]));
    parts.push(P(cyl(0.09, 0.06, 16), C3.lamp, [s * (h - 0.18), 0.52, 0], null, 'glass'));
    parts.push(P(new T.TorusGeometry(0.11, 0.025, 8, 20), C3.chrome, [s * (h - 0.18), 0.52, 0], [Math.PI / 2, 0, 0], 'metal'));
  }
  return parts;
}
const ART3 = {
  hull: () => [
    P(rbox(0.9, 0.56, 0.9, 0.2, 4), C3.white, [0, 0.28, 0]),
    P(rbox(0.92, 0.08, 0.92, 0.04), C3.whiteSh, [0, 0.1, 0]),                     // нижний пояс — тень корпуса
    ...[[0.47, 0], [-0.47, 0], [0, 0.47], [0, -0.47]].map(([x, z]) => P(cyl(0.13, 0.1, 18), C3.orange, [x, 0.3, z], [x ? 0 : Math.PI / 2, 0, x ? Math.PI / 2 : 0])),
    P(cyl(0.25, 0.07, 28), '#1636a8', [0, 0.58, 0], null, 'glass'),
    P(cyl(0.07, 0.02, 12), '#ffffff', [-0.09, 0.62, -0.09], null, 'glass'),             // блик на стекле
    P(new T.TorusGeometry(0.26, 0.045, 10, 28), C3.chrome, [0, 0.6, 0], [Math.PI / 2, 0, 0], 'metal'),
    ...[[0.3, 0.3], [-0.3, 0.3], [0.3, -0.3], [-0.3, -0.3]].map(([x, z]) => P(new T.SphereGeometry(0.035, 8, 6), C3.chrome, [x, 0.56, z], null, 'metal')),
  ],
  solar: () => [
    P(rbox(0.94, 0.26, 0.94, 0.1, 3), C3.gold, [0, 0.13, 0], null, 'metal'),
    ...[[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([a, b]) => P(rbox(0.36, 0.08, 0.36, 0.03), C3.blueDeep, [a * 0.205, 0.27, b * 0.205], null, 'glass')),
    ...[[0.48, 0], [-0.48, 0], [0, 0.48], [0, -0.48]].map(([x, z]) => P(cyl(0.1, 0.08, 16), C3.orange, [x, 0.14, z], [x ? 0 : Math.PI / 2, 0, x ? Math.PI / 2 : 0])),
  ],
  truss: () => trussParts(2.25),
  core: () => [
    P(cyl(0.6, 0.18, 6), C3.chrome, [0, 0.09, 0], [0, Math.PI / 6, 0], 'metal'),
    P(cyl(0.52, 0.5, 6), C3.tealDeep, [0, 0.3, 0], [0, Math.PI / 6, 0]),
    P(cyl(0.4, 0.08, 6), C3.teal, [0, 0.57, 0], [0, Math.PI / 6, 0], 'glass'),
    P(cyl(0.13, 0.12, 20), '#ffffff', [0, 0.62, 0], null, 'glass'),
  ],
  coreRing: () => [0, 1, 2].map(k => P(new T.TorusGeometry(0.29, 0.04, 8, 16, 1.5), '#ffffff', [0, 0.64, 0], [Math.PI / 2, 0, k * 2.094], 'glass')),
  rock: () => { const g = new T.IcosahedronGeometry(0.42, 1), a = g.attributes.position, v = new T.Vector3();
    for (let k = 0; k < a.count; k++){ v.fromBufferAttribute(a, k); const n = 0.78 + 0.22 * Math.abs(Math.sin(v.x * 9.1 + v.y * 7.3 + v.z * 5.7)); a.setXYZ(k, v.x * n, v.y * n * 0.8, v.z * n); }
    g.computeVertexNormals(); return [P(g, C3.rock, [0, 0.3, 0], null, 'rock'), P(new T.SphereGeometry(0.1, 8, 6), C3.rockDeep, [0.12, 0.55, -0.08], null, 'rock')]; },
  mirror: () => [
    P(cyl(0.44, 0.12, 32), C3.navy, [0, 0.06, 0]),
    P(new T.TorusGeometry(0.43, 0.04, 8, 32), C3.violet, [0, 0.12, 0], [Math.PI / 2, 0, 0]),
    P(rbox(0.96, 0.16, 0.22, 0.07), C3.chrome, [0, 0.24, 0], [0, Math.PI / 4, 0], 'metal'),          // планка '/' (поворот задаёт игра)
  ],
  emitter: () => [P(rbox(0.16, 0.5, 0.86, 0.06), '#6a3fc0', [0, 0.25, 0]), ...[-0.3, 0.3].map(z => P(new T.SphereGeometry(0.06, 10, 8), C3.violet, [0, 0.52, z], null, 'glass'))],
  tunnel: () => [P(cyl(0.1, 1, 16), '#cfcbe6', [0, 0.16, 0], [0, 0, Math.PI / 2], 'metal')],
  latch: () => [P(cyl(0.15, 0.09, 18), '#f1eefb', [0, 0.16, 0], [0, 0, Math.PI / 2], 'metal')],
};

// ---------- материалы ----------
function makeMats(){
  return {
    body: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.3, metalness: 0.0, envMapIntensity: 0.7 }),
    metal: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.22, metalness: 0.85, envMapIntensity: 1.2 }),
    glass: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.12, metalness: 0.0, emissive: '#000000', envMapIntensity: 0.55 }),
    rock: new T.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.0, flatShading: true }),
  };
}
const GEO = {};                                  // кэш слитых геометрий по модели: { body, metal, glass, rock }
function geoOf(name){
  if (GEO[name]) return GEO[name];
  const parts = ART3[name](), by = {};
  for (const p of parts) (by[p.grp] = by[p.grp] || []).push(p);
  const out = {}; for (const k in by) out[k] = mergeParts(by[k]);
  if (name === 'hull' || name === 'solar') out.nozzle = mergeParts(nozzleParts(-0.45));
  if (name === 'truss') out.nozzle = mergeParts(nozzleParts(-1.125));
  return (GEO[name] = out);
}
// Пятно тени под фигурой
let shadowTex = null;
function shadowTexture(){
  if (shadowTex) return shadowTex;
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'), gr = g.createRadialGradient(32, 32, 4, 32, 32, 31);
  gr.addColorStop(0, 'rgba(0,0,0,0.75)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  return (shadowTex = new T.CanvasTexture(c));
}

// ---------- пулы ----------
// Экземпляр: g1 (позиция, поворот по курсу) → g2 (сплющивание вдоль курса) → g3 (обратный поворот для «ровного» модуля) → меши.
const pools = {};
let SHADOW_GEO = null;
function makeItem(name){
  const geo = geoOf(name), mats = makeMats(), g1 = new T.Group(), g2 = new T.Group(), g3 = new T.Group(), meshes = {};
  g1.add(g2); g2.add(g3);
  for (const k in geo){ const mat = k === 'nozzle' ? mats.metal : mats[k]; const m = new T.Mesh(geo[k], mat); meshes[k] = m; g3.add(m); }
  const sh = new T.Mesh(SHADOW_GEO || (SHADOW_GEO = new T.PlaneGeometry(1, 1)), new T.MeshBasicMaterial({ map: shadowTexture(), color: C3.shadow, transparent: true, depthWrite: false, opacity: 0.55 }));
  sh.rotation.x = -Math.PI / 2; sh.position.y = 0.005; sh.renderOrder = -1; g1.add(sh);
  g1.visible = false; root.add(g1);
  return { name, g1, g2, g3, meshes, mats, sh, alpha: 1 };
}
function take(name){
  const p = pools[name] || (pools[name] = { items: [], used: 0 });
  if (p.used >= p.items.length) p.items.push(makeItem(name));
  const it = p.items[p.used++]; it.g1.visible = true; R3.stats.items++; return it;
}
function setAlpha(it, a){
  if (it.alpha === a) return; it.alpha = a;
  const tr = a < 0.999;
  for (const k in it.mats){ const m = it.mats[k]; m.opacity = a; if (m.transparent !== tr){ m.transparent = tr; m.needsUpdate = true; } m.depthWrite = !tr; }
  it.sh.material.opacity = 0.55 * a;
}
const tmpV = { x: 0, y: 0 };
// Матрица холста → пиксели устройства
function devXY(M, x, y){ tmpV.x = M.a * x + M.c * y + M.e; tmpV.y = M.b * x + M.d * y + M.f; return tmpV; }
// Поставить экземпляр: (x, y) — виртуальные координаты, size — размер фигуры, ang — курс, o — опции игры
function place(it, M, x, y, size, ang, o, alpha){
  const p = devXY(M, x, y), k = Math.hypot(M.a, M.b) * size;
  it.g1.position.set(p.x, 0, p.y); it.g1.rotation.y = -ang; it.g1.scale.set(k, k, k);
  it.g2.scale.set(o.sx || 1, 1, o.sy || 1); it.g3.rotation.y = o.unrot ? ang : 0;
  it.sh.position.set(0.07, 0.005, 0.1); it.sh.scale.set(1.1, 1.1, 1);
  setAlpha(it, alpha);
  return it;
}
function setGlow(it, col, k){ const g = it.mats.glass; g.emissive.set(col); g.emissiveIntensity = k; }

// ---------- запись вызовов игры ----------
R3.piece = function(c, x, y, size, kind, ang, o){       // kind: 1 жилой, 2 панель, 3 ферма
  o = o || {}; R3.stats.calls++;
  const name = kind === 3 ? 'truss' : kind === 2 ? 'solar' : 'hull', it = take(name);
  place(it, c.getTransform(), x, y, size, ang, o, c.globalAlpha * (o.alpha === undefined ? 1 : o.alpha));
  it.meshes.nozzle.visible = !!((o.queued || o.flame) && !o.unrot);
  if (name === 'truss'){ it.g3.rotation.y = 0; it.sh.scale.set(2.4, 1.1, 1); }
  const lit = o.lit || 0;
  if (name === 'hull') setGlow(it, lit ? C3.lamp : '#2a64ff', lit ? 0.85 * lit : 0.32);
  else if (name === 'solar') setGlow(it, lit ? '#7fb2ff' : '#1f4fd0', lit ? 0.9 * lit + (o.glint > 0 && o.glint < 1 ? 1.2 * Math.sin(o.glint * Math.PI) : 0) : (o.glint > 0 && o.glint < 1 ? 1.2 * Math.sin(o.glint * Math.PI) : 0.45));
  else setGlow(it, C3.lamp, lit ? 1.6 * lit : 0.5);
  const body = it.mats.body; body.emissive.set(o.tint ? C3.bad : '#000000'); body.emissiveIntensity = o.tint ? 0.55 : 0;
};
R3.core = function(c, x, y, size, now, blackout, win){
  R3.stats.calls++;
  const M = c.getTransform(), it = place(take('core'), M, x, y, size, 0, {}, c.globalAlpha);
  setGlow(it, blackout ? C3.bad : win ? C3.lamp : C3.teal, blackout ? 0.6 : win ? 1.0 : 0.9 + 0.2 * Math.sin(now * 0.004));
  const r = place(take('coreRing'), M, x, y, size, -now * 0.0016, {}, c.globalAlpha);
  setGlow(r, blackout ? C3.bad : '#ffffff', 1.1); r.sh.visible = false;
};
R3.rock = function(c, x, y, size, rot){ R3.stats.calls++; const it = place(take('rock'), c.getTransform(), x, y, size, rot, {}, c.globalAlpha); it.g1.rotation.x = 0; };
R3.mirror = function(c, x, y, size, typeA, flash){         // typeA: '/' — планка от нижнего левого к верхнему правому
  R3.stats.calls++;
  const it = place(take('mirror'), c.getTransform(), x, y, size, typeA ? 0 : Math.PI / 2, {}, c.globalAlpha);
  setGlow(it, C3.chrome, 0); it.mats.metal.emissive.set('#bfe9ff'); it.mats.metal.emissiveIntensity = 1.5 * flash;
};
R3.emitters = function(c, x, y, size, open){
  R3.stats.calls++;
  const M = c.getTransform();
  for (const s of [-1, 1]){ const it = place(take('emitter'), M, x + s * size * 0.43, y, size, 0, {}, c.globalAlpha); it.sh.scale.set(0.3, 1.1, 1);
    setGlow(it, open ? '#3a3466' : C3.violet, open ? 0.2 : 1.4); it.mats.body.color.set(open ? '#77739a' : '#ffffff'); }
};
R3.tunnel = function(c, ax, ay, bx, by, cell, flash, close){
  R3.stats.calls++;
  const M = c.getTransform(), horiz = Math.abs(ay - by) < 1, len = Math.hypot(bx - ax, by - ay) / cell;
  const t = place(take('tunnel'), M, (ax + bx) / 2, (ay + by) / 2, cell, horiz ? 0 : Math.PI / 2, { sx: Math.max(0.1, len - 0.62), sy: 1 }, c.globalAlpha);   // только зазор между корпусами
  t.sh.visible = false; setGlow(t, '#000000', 0);
  const l = place(take('latch'), M, (ax + bx) / 2, (ay + by) / 2, cell, horiz ? 0 : Math.PI / 2, { sx: 1, sy: 1 + 0.6 * (1 - close) }, c.globalAlpha);
  l.sh.visible = false; l.mats.metal.emissive.set(C3.lamp); l.mats.metal.emissiveIntensity = 1.6 * flash;
};

// ---------- сцена ----------
function envMap(){
  // Студийное окружение для бликов: градиентная сфера + два «софтбокса»
  const es = new T.Scene(), g = new T.SphereGeometry(10, 32, 16), col = [], a = g.attributes.position, c = new T.Color();
  for (let k = 0; k < a.count; k++){ const y = a.getY(k) / 10; c.set(y > 0 ? '#ffffff' : '#3a2a58').lerp(new T.Color('#a89ad0'), 1 - Math.abs(y)); col.push(c.r, c.g, c.b); }
  g.setAttribute('color', new T.Float32BufferAttribute(col, 3));
  es.add(new T.Mesh(g, new T.MeshBasicMaterial({ vertexColors: true, side: T.BackSide })));
  for (const [x, y, z, s] of [[-5, 6, 3, 4], [6, 3, -4, 2.5]]){ const b = new T.Mesh(new T.PlaneGeometry(s, s), new T.MeshBasicMaterial({ color: '#ffffff', side: T.DoubleSide })); b.position.set(x, y, z); b.lookAt(0, 0, 0); es.add(b); }
  const pm = new T.PMREMGenerator(renderer); const rt = pm.fromScene(es, 0.02); pm.dispose(); return rt.texture;
}
R3.init = function(canvas){
  renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1); renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = T.SRGBColorSpace; renderer.toneMapping = T.NeutralToneMapping; renderer.toneMappingExposure = 1.05;
  scene = new T.Scene(); root = new T.Group(); root.scale.set(1, 1, 1 / SIN); scene.add(root);   // растяжение по Z: плоскость y = 0 ложится на экран один в один
  envTex = envMap(); scene.environment = envTex;
  scene.add(new T.HemisphereLight(C3.hemiSky, C3.hemiGround, 1.25));
  const key = new T.DirectionalLight(C3.key, 2.9); key.position.set(-0.55, 1, -0.35); scene.add(key);   // свет сверху-слева (мир: −Z — верх экрана)
  const rim = new T.DirectionalLight(C3.rim, 0.9); rim.position.set(0.7, 0.35, 0.8); scene.add(rim);
  cam = new T.OrthographicCamera(-1, 1, 1, -1, -20000, 20000);
  R3.ready = true;
};
function fitCam(w, h){
  if (w === cw && h === ch) return; cw = w; ch = h;
  renderer.setSize(w, h, false);
  cam.left = -w / 2; cam.right = w / 2; cam.top = h / 2; cam.bottom = -h / 2;
  const tz = (h / 2) / SIN;
  cam.up.set(0, COS, -SIN); cam.position.set(w / 2, SIN * 5000, tz + COS * 5000); cam.lookAt(w / 2, 0, tz);
  cam.updateProjectionMatrix();
}
R3.debug = function(){                            // для проверки: экранные координаты видимых экземпляров
  const out = []; scene.updateMatrixWorld(true); cam.updateMatrixWorld();
  for (const k in pools) for (const it of pools[k].items) if (it.g1.visible){ const v = new T.Vector3(); it.g1.getWorldPosition(v); const w = v.clone(); v.project(cam);
    out.push([k, Math.round((v.x + 1) / 2 * cw), Math.round((1 - v.y) / 2 * ch), Math.round(w.x), Math.round(w.z)]); }
  return { cw, ch, cam: cam.position.toArray().map(Math.round), out: out.slice(0, 8) };
};
R3.begin = function(){ for (const k in pools) pools[k].used = 0; R3.stats.calls = 0; R3.stats.items = 0; };
R3.end = function(w, h){
  fitCam(w, h);
  for (const k in pools){ const p = pools[k]; for (let i = p.used; i < p.items.length; i++) p.items[i].g1.visible = false; }
  renderer.render(scene, cam); R3.stats.draws = renderer.info.render.calls;
};
R3.clear = function(w, h){ if (!renderer) return; R3.begin(); R3.end(w, h); };
// Прогрев (урок lesson-threejs-first-draw-warmup): создать пулы под уровень и один раз отрисовать все модели — шейдеры,
// буферы и состояния готовы до первого тапа. Позиции не сохраняются: кадр после прогрева ставит всё заново.
R3.warm = function(counts, w, h){
  R3.begin();
  const fake = { getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }), globalAlpha: 1 };
  for (const [name, n] of Object.entries(counts)) for (let k = 0; k < n; k++){   // в кадре, но крошечные: отрисовка грузит буферы, шейдеры обоих режимов прозрачности
    const it = place(take(name), fake.getTransform(), w / 2, h / 2, 0.01, 0, {}, k % 2 ? 0.5 : 1); if (it.meshes.nozzle) it.meshes.nozzle.visible = true; }
  R3.end(w, h); renderer.compile(scene, cam);
};

// Эмблема меню: снимок модели ядра (data URL), один раз
let emblemURL = '';
R3.emblem = function(){
  if (emblemURL) return emblemURL;
  const px = 192, sc = new T.Scene(), cm = new T.OrthographicCamera(-0.75, 0.75, 0.75, -0.75, -10, 10);
  cm.up.set(0, COS, -SIN); cm.position.set(0, SIN * 5, COS * 5); cm.lookAt(0, 0.3, 0);
  sc.environment = envTex; sc.add(new T.HemisphereLight(C3.hemiSky, C3.hemiGround, 1.25)); const k = new T.DirectionalLight(C3.key, 2.9); k.position.set(-0.55, 1, -0.35); sc.add(k);
  const mats = makeMats();
  for (const name of ['core', 'coreRing']){ const g = geoOf(name); for (const key in g){ const m = new T.Mesh(g[key], mats[key]); sc.add(m); } }
  mats.glass.emissive.set(C3.teal); mats.glass.emissiveIntensity = 0.9;
  const rt = new T.WebGLRenderTarget(px, px, { colorSpace: T.SRGBColorSpace });
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(sc, cm); renderer.setRenderTarget(null);
  const buf = new Uint8Array(px * px * 4); renderer.readRenderTargetPixels(rt, 0, 0, px, px, buf); rt.dispose();
  const c = document.createElement('canvas'); c.width = c.height = px; const g2 = c.getContext('2d'), img = g2.createImageData(px, px);
  for (let y = 0; y < px; y++) img.data.set(buf.subarray((px - 1 - y) * px * 4, (px - y) * px * 4), y * px * 4);
  g2.putImageData(img, 0, 0); for (const m of Object.values(mats)) m.dispose();
  return (emblemURL = c.toDataURL());
};

// ---------- планета (снимок в 2D-задник): освещённая сфера с атмосферой, кольцо в главе 1 ----------
function planetTexture(ch){
  const c = document.createElement('canvas'); c.width = 512; c.height = 256; const g = c.getContext('2d');
  const r = (s => () => (s = (s * 16807) % 2147483647) / 2147483647)(ch * 7 + 3);
  if (ch === 2){
    g.fillStyle = '#d4552e'; g.fillRect(0, 0, 512, 256);
    for (let k = 0; k < 9; k++){ g.fillStyle = k % 2 ? 'rgba(255,150,90,0.35)' : 'rgba(140,40,30,0.35)'; g.fillRect(0, r() * 256, 512, 6 + r() * 26); }
    for (let k = 0; k < 40; k++){ const x = r() * 512, y = 30 + r() * 196, rr = 3 + r() * 16; g.fillStyle = 'rgba(110,30,25,0.55)'; g.beginPath(); g.arc(x, y, rr, 0, 7); g.fill();
      g.fillStyle = 'rgba(255,170,120,0.35)'; g.beginPath(); g.arc(x - rr * 0.25, y - rr * 0.25, rr * 0.7, 0, 7); g.fill(); }
    g.fillStyle = 'rgba(255,235,220,0.8)'; g.fillRect(0, 0, 512, 10);
  } else {
    const bands = ['#4b3fd6', '#6f5cff', '#3a2fa8', '#8a7bff', '#5a46e0', '#2f2690', '#7d6cf2', '#4b3fd6'];
    for (let y = 0; y < 256; y += 8){ g.fillStyle = bands[Math.floor(r() * bands.length)]; g.fillRect(0, y, 512, 8 + r() * 10); }
    g.globalAlpha = 0.35; for (let k = 0; k < 14; k++){ g.fillStyle = r() < 0.5 ? '#c9b8ff' : '#1d1670'; g.beginPath(); g.ellipse(r() * 512, r() * 256, 30 + r() * 80, 3 + r() * 6, 0, 0, 7); g.fill(); }
    g.globalAlpha = 1;
  }
  const t = new T.CanvasTexture(c); t.colorSpace = T.SRGBColorSpace; return t;
}
R3.planet = function(ch, px){
  if (!renderer) return null;
  const sc = new T.Scene(), cm = new T.PerspectiveCamera(30, 1, 0.1, 100); cm.position.set(0, 0, 9); cm.lookAt(0, 0, 0);   // кадр ±2,4 радиуса: кольцо целиком
  const sun = new T.DirectionalLight('#fff1dc', 3.2); sun.position.set(-3, 2.2, 2.5); sc.add(sun); sc.add(new T.AmbientLight(ch === 2 ? '#40141c' : '#1c1450', 1.2));
  const sp = new T.Mesh(new T.SphereGeometry(1, 64, 48), new T.MeshStandardMaterial({ map: planetTexture(ch), roughness: 0.9 }));
  sp.rotation.set(0.35, -0.6, 0.25); sc.add(sp);
  const atm = new T.Mesh(new T.SphereGeometry(1.06, 48, 32), new T.ShaderMaterial({ transparent: true, side: T.BackSide, depthWrite: false, blending: T.AdditiveBlending,
    uniforms: { col: { value: new T.Color(ch === 2 ? '#ffb08a' : '#9db4ff') } },
    vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }',
    fragmentShader: 'uniform vec3 col; varying vec3 vN; varying vec3 vV; void main(){ float f = pow(1.0 - abs(dot(vN, vV)), 2.5); gl_FragColor = vec4(col * f * 1.6, f); }' }));
  sc.add(atm);
  if (ch !== 2){
    const rc = document.createElement('canvas'); rc.width = rc.height = 256; const rg = rc.getContext('2d');     // кольцо: концентрические полосы
    for (let r = 128; r > 84; r -= 2){ const a = 0.25 + 0.6 * Math.abs(Math.sin(r * 0.37)) * (r > 96 ? 1 : 0.5); rg.fillStyle = 'rgba(225,215,255,' + a.toFixed(2) + ')'; rg.beginPath(); rg.arc(128, 128, r, 0, 7); rg.arc(128, 128, r - 2, 0, 7, true); rg.fill(); }
    const rt0 = new T.CanvasTexture(rc); rt0.colorSpace = T.SRGBColorSpace;
    const ring = new T.Mesh(new T.RingGeometry(1.32, 2.05, 128), new T.MeshStandardMaterial({ map: rt0, roughness: 0.7, side: T.DoubleSide, transparent: true, depthWrite: false }));
    ring.rotation.set(-1.32, 0.18, 0.42); sc.add(ring);
  }
  const rt = new T.WebGLRenderTarget(px, px, { colorSpace: T.SRGBColorSpace });
  renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(sc, cm); renderer.setRenderTarget(null);
  const buf = new Uint8Array(px * px * 4); renderer.readRenderTargetPixels(rt, 0, 0, px, px, buf); rt.dispose();
  const c = document.createElement('canvas'); c.width = c.height = px; const g = c.getContext('2d'), img = g.createImageData(px, px);
  for (let y = 0; y < px; y++) img.data.set(buf.subarray((px - 1 - y) * px * 4, (px - y) * px * 4), y * px * 4);   // WebGL снизу вверх
  g.putImageData(img, 0, 0);
  sc.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material){ if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  return c;
};
})();
