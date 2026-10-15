// Hochwald Ring — a fictional mountain circuit.
// Pure data + math (no rendering) so the physics and the scenery share one ground.
import * as THREE from 'three';

export const ROAD_HALF = 6.5;        // 13 m wide tarmac
export const RUNOFF = 11;            // grass run-off beyond the edge line
export const WALL = ROAD_HALF + RUNOFF; // armco distance from centreline
export const FLAT = WALL + 3;        // ground stays at road height until here
export const BLEND = 70;             // distance over which hills rise back up

// control points: [x, elevation, z]
const CP = [
  [-160, 0, 0], [60, 0, 0], [250, 0, 0], [350, 3, 18], [430, 10, -40],
  [450, 20, -170], [380, 30, -265], [265, 36, -250], [185, 35, -320],
  [215, 30, -440], [335, 22, -505], [470, 14, -488], [575, 7, -560],
  [560, 1, -690], [410, -5, -735], [225, -8, -690], [70, -4, -610],
  [-60, 5, -650], [-205, 14, -610], [-290, 20, -490], [-230, 24, -385],
  [-330, 18, -300], [-430, 10, -205], [-415, 4, -85], [-310, 0, -8],
];
export const curve = new THREE.CatmullRomCurve3(CP.map(p => new THREE.Vector3(p[0], p[1], p[2])), true, 'centripetal');
export const LENGTH = curve.getLength();
export const N = Math.round(LENGTH / 1.25);

// samples along the centre line
export const S = { x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N),
  tx: new Float32Array(N), tz: new Float32Array(N), curv: new Float32Array(N), grade: new Float32Array(N) };
{
  const pts = curve.getSpacedPoints(N); // N+1 points, last == first
  for (let i = 0; i < N; i++) {
    const p = pts[i], q = pts[(i + 1) % N];
    S.x[i] = p.x; S.y[i] = p.y; S.z[i] = p.z;
    let tx = q.x - p.x, tz = q.z - p.z; const l = Math.hypot(tx, tz) || 1;
    S.tx[i] = tx / l; S.tz[i] = tz / l;
  }
  // smooth elevation a little so crests are drivable
  for (let pass = 0; pass < 6; pass++) {
    const y = Float32Array.from(S.y);
    for (let i = 0; i < N; i++) S.y[i] = (y[(i - 2 + N) % N] + y[(i - 1 + N) % N] + y[i] + y[(i + 1) % N] + y[(i + 2) % N]) / 5;
  }
  for (let i = 0; i < N; i++) {
    const a = (i - 4 + N) % N, b = (i + 4) % N;
    const h1 = Math.atan2(S.tz[i], S.tx[i]) - Math.atan2(S.tz[a], S.tx[a]);
    const h2 = Math.atan2(S.tz[b], S.tx[b]) - Math.atan2(S.tz[i], S.tx[i]);
    const wrap = (h) => Math.atan2(Math.sin(h), Math.cos(h));
    S.curv[i] = (wrap(h1) + wrap(h2)) / (8 * LENGTH / N); // signed 1/radius
    S.grade[i] = (S.y[b] - S.y[a]) / (8 * LENGTH / N);
  }
}

// vertex tangents (central difference) and segment lengths, used for smooth projection
const VTX = new Float32Array(N), VTZ = new Float32Array(N), SEGL = new Float32Array(N), SEG2 = new Float32Array(N);
for (let i = 0; i < N; i++) {
  const a = (i - 1 + N) % N, b = (i + 1) % N;
  let vx = S.x[b] - S.x[a], vz = S.z[b] - S.z[a]; const l = Math.hypot(vx, vz) || 1;
  VTX[i] = vx / l; VTZ[i] = vz / l;
  const sx = S.x[b] - S.x[i], sz = S.z[b] - S.z[i];
  SEG2[i] = sx * sx + sz * sz; SEGL[i] = Math.sqrt(SEG2[i]);
}

// spatial hash of samples for nearest-centreline lookups
const CELL = 25;
const grid = new Map();
const key = (cx, cz) => cx * 100003 + cz;
for (let i = 0; i < N; i++) {
  const k = key(Math.floor(S.x[i] / CELL), Math.floor(S.z[i] / CELL));
  let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(i);
}

// nearest point on the centre line. Returns {i, t, d (signed lateral, + = left of travel), y, s (0..1)}
const _res = { i: 0, t: 0, d: 1e9, y: 0, s: 0, dist: 1e9 };
export function nearest(x, z, out = _res, hint = -1) {
  let best = -1, bd = Infinity;
  if (hint >= 0) { // local search around last index (fast path for the car)
    for (let k = -12; k <= 12; k++) {
      const i = (hint + k + N) % N; const dx = x - S.x[i], dz = z - S.z[i]; const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    if (bd > 30 * 30) best = -1;
  }
  if (best < 0) {
    const cx = Math.floor(x / CELL), cz = Math.floor(z / CELL);
    for (let r = 1; r <= 8 && best < 0; r *= 2) {
      for (let ix = cx - r; ix <= cx + r; ix++) for (let iz = cz - r; iz <= cz + r; iz++) {
        const a = grid.get(key(ix, iz)); if (!a) continue;
        for (const i of a) { const dx = x - S.x[i], dz = z - S.z[i]; const d = dx * dx + dz * dz; if (d < bd) { bd = d; best = i; } }
      }
    }
    if (best < 0) { // far away: brute force on a coarse stride
      for (let i = 0; i < N; i += 4) { const dx = x - S.x[i], dz = z - S.z[i]; const d = dx * dx + dz * dz; if (d < bd) { bd = d; best = i; } }
    }
  }
  // project onto the segment best..best+1 (or best-1..best)
  let i0 = best, i1 = (best + 1) % N;
  let t = ((x - S.x[i0]) * (S.x[i1] - S.x[i0]) + (z - S.z[i0]) * (S.z[i1] - S.z[i0])) / SEG2[i0];
  if (t < 0) { i0 = (best - 1 + N) % N; i1 = best; t = ((x - S.x[i0]) * (S.x[i1] - S.x[i0]) + (z - S.z[i0]) * (S.z[i1] - S.z[i0])) / SEG2[i0]; }
  const w = Math.min(1, Math.max(0, t));
  // Blend projections onto the vertex tangents at both ends of the segment. This keeps the
  // along-track position, lateral offset and height continuous across segment boundaries
  // (a plain per-segment projection steps by a few mm at every vertex, which the
  // suspension feels as a constant buzz at speed).
  const dx0 = x - S.x[i0], dz0 = z - S.z[i0], dx1 = x - S.x[i1], dz1 = z - S.z[i1];
  const s0 = (dx0 * VTX[i0] + dz0 * VTZ[i0]) / SEGL[i0];
  const s1 = 1 + (dx1 * VTX[i1] + dz1 * VTZ[i1]) / SEGL[i0];
  const frac = s0 * (1 - w) + s1 * w;
  const d0 = dx0 * VTZ[i0] - dz0 * VTX[i0], d1 = dx1 * VTZ[i1] - dz1 * VTX[i1];
  const d = d0 * (1 - w) + d1 * w;
  out.i = i0; out.t = w; out.d = d; out.dist = Math.abs(d);
  // Catmull-Rom height: smooth slope as well as smooth height
  const ym = S.y[(i0 - 1 + N) % N], ya = S.y[i0], yb = S.y[i1], yp = S.y[(i1 + 1) % N], u = frac;
  out.y = ya + 0.5 * u * ((yb - ym) + u * (2 * ym - 5 * ya + 4 * yb - yp + u * (3 * (ya - yb) + yp - ym)));
  out.s = (((i0 + frac) % N) + N) % N / N;
  return out;
}

// ---------- terrain noise ----------
function hash(ix, iz) { let h = ix * 374761393 + iz * 668265263; h = (h ^ (h >>> 13)) * 1274126177; return ((h ^ (h >>> 16)) >>> 0) / 4294967295; }
function vnoise(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz;
  const ux = fx * fx * (3 - 2 * fx), uz = fz * fz * (3 - 2 * fz);
  const a = hash(ix, iz), b = hash(ix + 1, iz), c = hash(ix, iz + 1), d = hash(ix + 1, iz + 1);
  return (a + (b - a) * ux) * (1 - uz) + (c + (d - c) * ux) * uz;
}
export function fbm(x, z, oct = 5) { let s = 0, a = 0.5, f = 1; for (let o = 0; o < oct; o++) { s += a * vnoise(x * f, z * f); f *= 2.03; a *= 0.5; } return s; }
const CX = 70, CZ = -360; // centre of the circuit
export function hills(x, z) {
  const base = (fbm(x / 260, z / 260, 5) - 0.45) * 70;
  const r = Math.hypot(x - CX, z - CZ);
  const ridge = 1 - Math.abs(fbm(x / 520 + 7, z / 520 - 3, 4) * 2 - 1);
  const mountain = Math.max(0, r - 650) * 0.32 * (0.55 + ridge) + Math.max(0, r - 1100) * 0.25;
  return base + mountain;
}

// ground height used by BOTH physics and terrain mesh
const _n = { i: 0, t: 0, d: 0, y: 0, s: 0, dist: 0 };
export function ground(x, z, hint = -1) {
  const n = nearest(x, z, _n, hint);
  if (n.dist <= FLAT) return n.y;
  const h = hills(x, z);
  const k = Math.min(1, (n.dist - FLAT) / BLEND); const sm = k * k * (3 - 2 * k);
  // keep the hills from burying the road side: valley walls rise, never sink below the road by much
  return n.y + (h - n.y) * sm;
}
export function surfaceAt(x, z, hint = -1) {
  const n = nearest(x, z, _n, hint);
  return n.dist <= ROAD_HALF + 0.3 ? 0 : (n.dist <= WALL ? 1 : 2); // 0 tarmac, 1 grass runoff, 2 off-world
}

// start/finish on the main straight
export const START_INDEX = Math.round(N * 0.0);
export function gridPose(back = 30) {
  const i = (START_INDEX - Math.round(back / (LENGTH / N)) + N) % N;
  return { x: S.x[i] - S.tz[i] * 2.5, y: S.y[i], z: S.z[i] + S.tx[i] * 2.5, heading: Math.atan2(S.tx[i], S.tz[i]), i };
}

// world adapter for the physics
const _gn = { x: 0, y: 0, z: 0 };
export const world = {
  ground, nearest, WALL, S,
  surface: surfaceAt,
  normal(x, z, out, hint = -1) {
    const e = 0.6;
    const hx = ground(x + e, z, hint) - ground(x - e, z, hint);
    const hz = ground(x, z + e, hint) - ground(x, z - e, hint);
    return out.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
  },
};
