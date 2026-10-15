// Builds the Hochwald Ring scenery from the shared track data.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { Sky } from 'three/addons/objects/Sky.js';
import * as TR from './trackdata.js';

const { S, N, LENGTH, ROAD_HALF, WALL, FLAT } = TR;
const DS = LENGTH / N;
const CENTER = new THREE.Vector2(70, -360);

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function canvasTex(w, h, draw, repeat) {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; }
  return t;
}
const left = (i) => [S.tz[i], -S.tx[i]]; // left-of-travel unit vector (x, z)

export function buildTrack(renderer) {
  const group = new THREE.Group(); group.name = 'HochwaldRing';
  const R = rng(7);

  // ---------- sky, sun, fog ----------
  const sky = new Sky(); sky.scale.setScalar(20000);
  const su = sky.material.uniforms;
  su.turbidity.value = 4; su.rayleigh.value = 1.4; su.mieCoefficient.value = 0.004; su.mieDirectionalG.value = 0.82;
  const sunDir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 24), THREE.MathUtils.degToRad(215));
  su.sunPosition.value.copy(sunDir);
  group.add(sky);
  const fogColor = new THREE.Color(0xa9bccd);

  // ---------- terrain (polar grid, fine near the circuit, coarse to the horizon) ----------
  {
    const A = 720; const rings = [];
    for (let r = 0; r <= 880; r += 4) rings.push(r);
    let r = 880; while (r < 5200) { r *= 1.07; rings.push(r); }
    const nv = A * rings.length;
    const pos = new Float32Array(nv * 3), col = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
    const c = new THREE.Color(), cGrass = new THREE.Color(0x4f7a2c), cRunoff = new THREE.Color(0x5e8f32), cDry = new THREE.Color(0x7d8a4a),
      cRock = new THREE.Color(0x5d5a55), cSnow = new THREE.Color(0xf2f4f6), cForest = new THREE.Color(0x2f4a22);
    const near = { i: 0, t: 0, d: 0, y: 0, s: 0, dist: 0 };
    let k = 0;
    for (let ri = 0; ri < rings.length; ri++) {
      const rr = rings[ri];
      for (let a = 0; a < A; a++) {
        const th = a / A * Math.PI * 2;
        const x = CENTER.x + Math.cos(th) * rr, z = CENTER.y + Math.sin(th) * rr;
        let y; let dist = 1e9;
        if (rr < 1000) { TR.nearest(x, z, near); dist = near.dist; y = TR.ground(x, z); } else y = TR.hills(x, z);
        if (dist < ROAD_HALF + 1.5) y -= 0.35;      // tuck the terrain under the tarmac
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        uv[k * 2] = x / 18; uv[k * 2 + 1] = z / 18;
        // colour by zone, slope (estimated from noise gradient) and altitude
        const nz = TR.fbm(x / 40, z / 40, 3);
        if (dist < FLAT) c.copy(cRunoff).lerp(cGrass, nz * 0.5);
        else {
          c.copy(cGrass).lerp(cDry, Math.max(0, nz - 0.45) * 1.6);
          if (dist > WALL + 25 && dist < 400) c.lerp(cForest, 0.35 * TR.fbm(x / 120 + 3, z / 120, 2));
          const rock = THREE.MathUtils.smoothstep(y, 70, 190) * (0.55 + 0.45 * nz);
          c.lerp(cRock, rock);
          const snow = THREE.MathUtils.smoothstep(y + nz * 90, 420, 520);
          c.lerp(cSnow, snow);
        }
        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
        k++;
      }
    }
    const idx = [];
    for (let ri = 0; ri < rings.length - 1; ri++) for (let a = 0; a < A; a++) {
      const a1 = (a + 1) % A, i0 = ri * A + a, i1 = ri * A + a1, i2 = (ri + 1) * A + a, i3 = (ri + 1) * A + a1;
      idx.push(i0, i1, i2, i1, i3, i2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(nv > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    g.computeVertexNormals();
    const detail = canvasTex(256, 256, (x, w, h) => {
      const im = x.createImageData(w, h); const rr = rng(3);
      for (let i = 0; i < w * h; i++) { const v = 200 + rr() * 55; im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; }
      x.putImageData(im, 0, 0);
    }, true);
    detail.colorSpace = THREE.NoColorSpace;
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, map: detail, roughness: 0.97, metalness: 0 });
    const terrain = new THREE.Mesh(g, m); terrain.receiveShadow = true; terrain.name = 'terrain';
    group.add(terrain);
  }

  // ---------- tarmac ----------
  {
    const asphalt = canvasTex(512, 1024, (x, w, h) => {
      x.fillStyle = '#3a3b3d'; x.fillRect(0, 0, w, h);
      const im = x.getImageData(0, 0, w, h); const rr = rng(11);
      for (let i = 0; i < w * h; i++) { const n = (rr() - 0.5) * 34; for (let c = 0; c < 3; c++) im.data[i * 4 + c] += n; }
      x.putImageData(im, 0, 0);
      // rubbered-in racing line, darker toward the middle
      const g = x.createLinearGradient(0, 0, w, 0);
      g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(0.5, 'rgba(10,10,12,0.22)'); g.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(0, 0, w, h);
      x.fillStyle = '#e9e9e4'; x.fillRect(w * 0.012, 0, w * 0.022, h); x.fillRect(w * (1 - 0.034), 0, w * 0.022, h);
    }, true);
    const pos = [], uv = [], idx = [];
    for (let i = 0; i <= N; i++) {
      const j = i % N; const [lx, lz] = left(j); const y = S.y[j] + 0.02;
      pos.push(S.x[j] + lx * (ROAD_HALF + 0.4), y, S.z[j] + lz * (ROAD_HALF + 0.4));
      pos.push(S.x[j] - lx * (ROAD_HALF + 0.4), y, S.z[j] - lz * (ROAD_HALF + 0.4));
      const v = i * DS / 14; uv.push(0, v, 1, v);
      if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
    const road = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: asphalt, roughness: 0.88, metalness: 0 }));
    road.receiveShadow = true; road.name = 'road'; group.add(road);

    // start/finish line and grid boxes
    const sf = canvasTex(256, 32, (x, w, h) => { for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) { x.fillStyle = (i + j) % 2 ? '#111' : '#f4f4f0'; x.fillRect(i * 16, j * 16, 16, 16); } });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_HALF * 2, 1.6), new THREE.MeshStandardMaterial({ map: sf, roughness: 0.8 }));
    const i0 = TR.START_INDEX; line.position.set(S.x[i0], S.y[i0] + 0.035, S.z[i0]);
    line.rotation.set(-Math.PI / 2, 0, Math.atan2(S.tx[i0], S.tz[i0]));
    group.add(line);
  }

  // ---------- kerbs (red/white, on corners) ----------
  {
    const pos = [], col = [], idx = []; const red = new THREE.Color(0xc8102e), white = new THREE.Color(0xf2f2ee);
    let v = 0;
    for (let side of [1, -1]) {
      for (let i = 0; i < N; i++) {
        const kurv = Math.abs(S.curv[i]);
        const on = Math.max(...[-10, -5, 0, 5, 10].map(o => Math.abs(S.curv[(i + o + N) % N]))) > 1 / 115;
        if (!on) continue;
        const i1 = (i + 1) % N;
        const stripe = Math.floor(i * DS / 2.2) % 2 ? red : white;
        const pts = [];
        for (const j of [i, i1]) {
          const [lx, lz] = left(j); const y = S.y[j];
          pts.push([S.x[j] + lx * side * (ROAD_HALF + 0.35), y + 0.035, S.z[j] + lz * side * (ROAD_HALF + 0.35)]);
          pts.push([S.x[j] + lx * side * (ROAD_HALF + 1.65), y + 0.06, S.z[j] + lz * side * (ROAD_HALF + 1.65)]);
        }
        for (const p of pts) { pos.push(...p); col.push(stripe.r, stripe.g, stripe.b); }
        if (side > 0) idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3); else idx.push(v, v + 1, v + 2, v + 1, v + 3, v + 2);
        v += 4; void kurv;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx); g.computeVertexNormals();
    const kerbs = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6 }));
    kerbs.receiveShadow = true; group.add(kerbs);
  }

  // ---------- armco barriers + posts ----------
  {
    const pos = [], idx = [], uvs = []; let v = 0;
    const postGeo = new THREE.BoxGeometry(0.12, 0.8, 0.12); postGeo.translate(0, 0.4, 0);
    const posts = new THREE.InstancedMesh(postGeo, new THREE.MeshStandardMaterial({ color: 0x8a8d90, metalness: 0.6, roughness: 0.5 }), Math.ceil(N / Math.round(4 / DS)) * 2 + 8);
    const M = new THREE.Matrix4(); let pc = 0;
    for (const side of [1, -1]) {
      const off = WALL + 0.25;
      for (let i = 0; i <= N; i++) {
        const j = i % N; const [lx, lz] = left(j);
        const x = S.x[j] + lx * side * off, z = S.z[j] + lz * side * off, y = S.y[j];
        pos.push(x, y + 0.35, z, x, y + 0.78, z); uvs.push(i * DS / 4, 0, i * DS / 4, 1);
        if (i < N) idx.push(v, v + 2, v + 1, v + 1, v + 2, v + 3);
        v += 2;
        if (i < N && i % Math.round(4 / DS) === 0) { M.makeTranslation(x - lx * side * 0.12, y, z - lz * side * 0.12); posts.setMatrixAt(pc++, M); }
      }
    }
    posts.count = pc;
    const rail = canvasTex(64, 64, (x, w, h) => {
      const g = x.createLinearGradient(0, 0, 0, h);
      [[0, '#9da2a6'], [0.2, '#d9dde0'], [0.35, '#7f8488'], [0.5, '#c8ccd0'], [0.65, '#7f8488'], [0.8, '#d9dde0'], [1, '#9da2a6']].forEach(([o, c]) => g.addColorStop(o, c));
      x.fillStyle = g; x.fillRect(0, 0, w, h);
    }, true);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx); g.computeVertexNormals();
    const armco = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ map: rail, metalness: 0.55, roughness: 0.35, side: THREE.DoubleSide }));
    armco.castShadow = true; armco.receiveShadow = true;
    group.add(armco, posts);
  }

  // ---------- pine forest ----------
  {
    const parts = [];
    const cone = (r, h, y, color) => { const g = new THREE.ConeGeometry(r, h, 7, 1); g.translate(0, y, 0); const c = new THREE.Color(color); const n = g.attributes.position.count; const a = new Float32Array(n * 3); for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; } g.setAttribute('color', new THREE.BufferAttribute(a, 3)); return g; };
    const trunk = new THREE.CylinderGeometry(0.25, 0.35, 3, 5); trunk.translate(0, 1.5, 0);
    { const n = trunk.attributes.position.count; const a = new Float32Array(n * 3).fill(0); for (let i = 0; i < n; i++) { a[i * 3] = 0.32; a[i * 3 + 1] = 0.22; a[i * 3 + 2] = 0.14; } trunk.setAttribute('color', new THREE.BufferAttribute(a, 3)); }
    parts.push(trunk, cone(2.6, 6, 5, 0x24401f), cone(2.0, 5, 8, 0x2b4d24), cone(1.3, 4, 10.6, 0x335a2a));
    const geo = mergeGeometries(parts.map(p => p.toNonIndexed()));
    const COUNT = 7000;
    const trees = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true }), COUNT);
    const M = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(), p = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
    const near = { i: 0, t: 0, d: 0, y: 0, s: 0, dist: 0 };
    let placed = 0, tries = 0;
    const tint = new THREE.Color();
    while (placed < COUNT && tries < COUNT * 12) {
      tries++;
      const a = R() * Math.PI * 2, rr = 60 + Math.sqrt(R()) * 980;
      const x = CENTER.x + Math.cos(a) * rr, z = CENTER.y + Math.sin(a) * rr;
      TR.nearest(x, z, near); if (near.dist < WALL + 9) continue;
      // forest patches: clumped by noise
      if (TR.fbm(x / 90 + 11, z / 90 - 4, 3) < 0.47 - (near.dist > 120 ? 0.05 : 0)) continue;
      const y = rr < 1000 ? TR.ground(x, z) : TR.hills(x, z);
      if (y > 150) continue;
      const s = 0.75 + R() * 0.8;
      p.set(x, y - 0.3, z); q.setFromAxisAngle(up, R() * 6.28); sc.set(s, s * (0.9 + R() * 0.35), s);
      M.compose(p, q, sc); trees.setMatrixAt(placed, M);
      tint.setHSL(0.27 + R() * 0.06, 0.35 + R() * 0.2, 0.6 + R() * 0.4); trees.setColorAt(placed, tint);
      placed++;
    }
    trees.count = placed; trees.castShadow = false; trees.receiveShadow = true;
    group.add(trees);
  }

  // ---------- start straight: grandstand, pit building, gantry ----------
  const iS = TR.START_INDEX;
  const sx = S.x[iS], sy = S.y[iS], sz = S.z[iS];
  const heading = Math.atan2(S.tx[iS], S.tz[iS]);
  const [Lx, Lz] = left(iS);
  {
    // grandstand on the left of travel
    const gs = new THREE.Group();
    const concrete = new THREE.MeshStandardMaterial({ color: 0xbfc0bd, roughness: 0.9 });
    const tiers = 9, len = 150;
    for (let t = 0; t < tiers; t++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(len, 0.55 * (t + 1), 1.1), concrete);
      b.position.set(0, 0.275 * (t + 1), -(t * 1.1)); b.castShadow = b.receiveShadow = true; gs.add(b);
    }
    // crowd: little coloured blocks on each step
    const crowdGeo = new THREE.BoxGeometry(0.45, 0.8, 0.35); crowdGeo.translate(0, 0.4, 0);
    const per = 220; const crowd = new THREE.InstancedMesh(crowdGeo, new THREE.MeshStandardMaterial({ roughness: 0.8 }), tiers * per);
    const M = new THREE.Matrix4(); const c = new THREE.Color(); let n = 0;
    const shirt = ['#c8102e', '#f2f2ee', '#1f6fd9', '#ffd200', '#222', '#8cdb14', '#ff7a00', '#5b5f63'];
    for (let t = 0; t < tiers; t++) for (let k = 0; k < per; k++) {
      if (R() < 0.18) continue;
      M.makeTranslation(-len / 2 + 1 + k * (len - 2) / per + (R() - 0.5) * 0.2, 0.55 * (t + 1), -(t * 1.1) + 0.1);
      crowd.setMatrixAt(n, M); c.set(shirt[(R() * shirt.length) | 0]); crowd.setColorAt(n++, c);
    }
    crowd.count = n; gs.add(crowd);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 4, 0.3, 12), new THREE.MeshStandardMaterial({ color: 0x2b2f33, roughness: 0.6, metalness: 0.3 }));
    roof.position.set(0, 9.2, -4.6); roof.rotation.x = -0.08; roof.castShadow = true; gs.add(roof);
    for (let k = -3; k <= 3; k++) { const col = new THREE.Mesh(new THREE.BoxGeometry(0.4, 9.5, 0.4), concrete); col.position.set(k * len / 6.5, 4.6, -9.5); gs.add(col); }
    gs.position.set(sx + Lx * (WALL + 5), sy, sz + Lz * (WALL + 5));
    gs.position.addScaledVector(new THREE.Vector3(S.tx[iS], 0, S.tz[iS]), 20);
    // local -Z (the back of the stand) points away from the track, toward +left
    gs.rotation.y = Math.atan2(-Lx, -Lz);
    group.add(gs);

    // pit building on the right
    const pitTex = canvasTex(1024, 128, (x, w, h) => {
      x.fillStyle = '#eef0ee'; x.fillRect(0, 0, w, h);
      for (let i = 0; i < 16; i++) { x.fillStyle = '#2a2d31'; x.fillRect(i * 64 + 6, 38, 52, 90); x.fillStyle = '#8cdb14'; x.fillRect(i * 64 + 6, 30, 52, 5); }
      x.fillStyle = '#16181a'; x.font = 'bold 22px sans-serif'; x.fillText('HOCHWALD RING  ·  BOXEN', 20, 22);
    });
    const pit = new THREE.Mesh(new THREE.BoxGeometry(160, 9, 14), [
      new THREE.MeshStandardMaterial({ color: 0xe8eae8 }), new THREE.MeshStandardMaterial({ color: 0xe8eae8 }),
      new THREE.MeshStandardMaterial({ color: 0x6a6e72 }), new THREE.MeshStandardMaterial({ color: 0xe8eae8 }),
      new THREE.MeshStandardMaterial({ map: pitTex }), new THREE.MeshStandardMaterial({ color: 0xe8eae8 })]);
    pit.position.set(sx - Lx * (WALL + 14) + S.tx[iS] * 15, sy + 4.5, sz - Lz * (WALL + 14) + S.tz[iS] * 15);
    pit.rotation.y = Math.atan2(Lx, Lz); // +Z face (garages) looks toward the track
    pit.castShadow = pit.receiveShadow = true; group.add(pit);

    // start gantry with lights
    const gan = new THREE.Group(); const steel = new THREE.MeshStandardMaterial({ color: 0x2e3236, metalness: 0.5, roughness: 0.5 });
    for (const s of [1, -1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.6, 8, 0.6), steel); p.position.set(s * (ROAD_HALF + 2.5), 4, 0); p.castShadow = true; gan.add(p); }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(ROAD_HALF * 2 + 6, 1.4, 0.8), steel); beam.position.y = 7.6; beam.castShadow = true; gan.add(beam);
    const lights = [];
    for (let k = 0; k < 5; k++) {
      const m = new THREE.MeshStandardMaterial({ color: 0x220000, emissive: 0xff1a1a, emissiveIntensity: 0 });
      const l = new THREE.Mesh(new THREE.CircleGeometry(0.32, 20), m); l.position.set((k - 2) * 1.1, 7.6, -0.41); l.rotation.y = Math.PI; gan.add(l); lights.push(m);
    }
    gan.position.set(sx, sy, sz); gan.rotation.y = heading; group.add(gan);
    group.userData.startLights = lights;
  }

  // ---------- brake-marker boards before the slow corners ----------
  {
    const boardTex = {};
    for (const n of [150, 100, 50]) boardTex[n] = canvasTex(128, 96, (x, w, h) => { x.fillStyle = '#f4f4f0'; x.fillRect(0, 0, w, h); x.strokeStyle = '#16181a'; x.lineWidth = 6; x.strokeRect(3, 3, w - 6, h - 6); x.fillStyle = '#16181a'; x.font = 'bold 54px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(String(n), w / 2, h / 2 + 2); });
    const pole = new THREE.MeshStandardMaterial({ color: 0x5b5f63 });
    // find braking zones: apex of corners tighter than R70 preceded by a faster section
    let last = -1e9;
    for (let i = 0; i < N; i++) {
      const r = 1 / Math.max(1e-5, Math.abs(S.curv[i]));
      if (r > 70) continue;
      if (i - last < 160) continue;
      // walk back to corner entry
      let e = i; while (1 / Math.max(1e-5, Math.abs(S.curv[(e - 1 + N) % N])) < 110 && i - e < 120) e--;
      last = i;
      const outside = -Math.sign(S.curv[i]);
      for (const dist of [150, 100, 50]) {
        const j = (e - Math.round(dist / DS) + N * 2) % N; const [lx, lz] = left(j);
        const off = (ROAD_HALF + 4) * outside;
        const b = new THREE.Group();
        const face = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 0.9), new THREE.MeshStandardMaterial({ map: boardTex[dist], side: THREE.DoubleSide }));
        face.position.y = 1.6; b.add(face);
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.2, 0.08), pole); p.position.y = 0.6; b.add(p);
        b.position.set(S.x[j] + lx * off, S.y[j], S.z[j] + lz * off);
        b.rotation.y = Math.atan2(S.tx[j], S.tz[j]) + Math.PI; // face oncoming cars
        group.add(b);
      }
    }
  }

  // ---------- TV camera positions ----------
  const tvCams = [];
  for (let i = 0; i < N; i += Math.round(170 / DS)) {
    const side = (Math.floor(i / 300) % 2) ? 1 : -1;
    const [lx, lz] = left(i); const off = (WALL + 7) * side;
    const x = S.x[i] + lx * off, z = S.z[i] + lz * off;
    tvCams.push({ i, pos: new THREE.Vector3(x, Math.max(TR.ground(x, z), S.y[i]) + 6 + (i % 3) * 2, z) });
  }

  return { group, sunDir, fogColor, tvCams, sky };
}

// mini-map polyline in 2D (x, z) normalised to a box
export function minimapPath(size, pad = 10) {
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (let i = 0; i < N; i++) { minX = Math.min(minX, S.x[i]); maxX = Math.max(maxX, S.x[i]); minZ = Math.min(minZ, S.z[i]); maxZ = Math.max(maxZ, S.z[i]); }
  const sc = (size - pad * 2) / Math.max(maxX - minX, maxZ - minZ);
  const ox = pad + (size - pad * 2 - (maxX - minX) * sc) / 2, oz = pad + (size - pad * 2 - (maxZ - minZ) * sc) / 2;
  const map = (x, z) => [ox + (x - minX) * sc, oz + (z - minZ) * sc];
  const pts = []; for (let i = 0; i < N; i += 6) pts.push(map(S.x[i], S.z[i]));
  return { pts, map };
}
