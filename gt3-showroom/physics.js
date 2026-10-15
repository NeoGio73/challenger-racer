// 911 GT3 (992) vehicle model: 6-DOF chassis, four raycast suspensions,
// combined-slip tyre model with relaxation lengths, RWD with LSD, 7-speed PDK, aero.
import * as THREE from 'three';

const V = () => new THREE.Vector3();
const G = 9.81, RHO = 1.225;

export const SPEC = {
  mass: 1435,                               // kg, with driver and fuel
  inertia: new THREE.Vector3(2650, 2850, 640), // pitch(x), yaw(y), roll(z) — local axes
  // local axes: +Z forward, +Y up, +X left. Origin = centre of gravity.
  // model space CG sits at (0, 0.46, -0.262): 39/61 weight split on a 2.461 m wheelbase
  cgModel: new THREE.Vector3(0, 0.46, -0.262),
  wheels: [ // hub position relative to CG, radius, spring, damping bump/rebound, max brake torque
    { id: 'FL', pos: [ 0.794, -0.09,  1.501], r: 0.367, k: 78000,  cb: 3300, cr: 4600, brake: 4300, front: true },
    { id: 'FR', pos: [-0.794, -0.09,  1.501], r: 0.367, k: 78000,  cb: 3300, cr: 4600, brake: 4300, front: true },
    { id: 'RL', pos: [ 0.815, -0.075, -0.960], r: 0.383, k: 104000, cb: 4700, cr: 6600, brake: 2600, front: false },
    { id: 'RR', pos: [-0.815, -0.075, -0.960], r: 0.383, k: 104000, cb: 4700, cr: 6600, brake: 2600, front: false },
  ],
  topMount: 0.20,         // suspension travel above the hub at static ride height
  arbFront: 32000, arbRear: 21000,
  mu: 1.28, muGrass: 0.55, loadSens: 0.08, fz0: 3500,
  slipPeakLong: 0.10, slipPeakLat: 0.115,
  relaxLong: 0.25, relaxLat: 0.45,
  torque: [[800, 230], [1500, 300], [2500, 360], [3500, 405], [4500, 440], [5500, 462], [6100, 470], [7000, 466], [8000, 446], [8400, 426], [9000, 392], [9300, 0]],
  idle: 950, redline: 9000,
  gears: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84], reverse: 3.4, final: 3.97, efficiency: 0.9,
  shiftTime: 0.09,
  CdA: 0.74, ClA: 1.55, aeroFront: 0.42,
  maxSteer: 0.56,
};

function torqueAt(rpm) {
  const t = SPEC.torque;
  if (rpm <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (rpm <= t[i][0]) {
    const a = t[i - 1], b = t[i], k = (rpm - a[0]) / (b[0] - a[0]); return a[1] + (b[1] - a[1]) * k;
  }
  return 0;
}
// normalised "magic formula": peak 1 at s = 1, ~0.8 when fully sliding
function mf(s) { const B = 1.255, C = 1.75, E = 0.3; const x = B * s; return Math.sin(C * Math.atan(x - E * (x - Math.atan(x)))); }

export class Car {
  constructor(world) {
    this.world = world; // { ground(x,z,hint), normal(x,z,out,hint), surface(x,z,hint), nearest(x,z,out,hint), WALL }
    this.pos = V(); this.vel = V(); this.q = new THREE.Quaternion(); this.w = V();
    this.wheels = SPEC.wheels.map(s => ({
      spec: s, local: new THREE.Vector3(...s.pos), omega: 0, angle: 0, sigma: 0, tanA: 0,
      L: SPEC.topMount, Lprev: SPEC.topMount, Fz: 0, contact: false, slip: 0, surface: 0, steer: 0,
      restL: SPEC.topMount + (s.front ? 0.0366 : 0.0425),
    }));
    this.gear = 1; this.rpm = SPEC.idle; this.shiftTimer = 0; this.auto = true;
    this.abs = true; this.tc = true; this.absActive = false; this.tcActive = false;
    this.hint = -1; this.time = 0; this.gLat = 0; this.gLong = 0; this.offTrack = false;
    this.throttleOut = 0;
    // temporaries
    this._t = { a: V(), b: V(), c: V(), d: V(), e: V(), f: V(), g: V(), n: V(), up: V(), fwd: V(), left: V(), F: V(), T: V(), q: new THREE.Quaternion() };
    this._near = { i: 0, t: 0, d: 0, y: 0, s: 0, dist: 0 };
    this.chassisPts = [];
    for (const x of [0.92, -0.92]) for (const z of [2.25, 0.4, -2.05]) for (const y of [-0.28, 0.75]) this.chassisPts.push(new THREE.Vector3(x, y, z));
  }

  reset(pose) {
    this.pos.set(pose.x, this.world.ground(pose.x, pose.z) + SPEC.cgModel.y + 0.02, pose.z);
    this.q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pose.heading);
    this.vel.set(0, 0, 0); this.w.set(0, 0, 0);
    for (const wh of this.wheels) { wh.omega = 0; wh.sigma = 0; wh.tanA = 0; wh.L = wh.Lprev = SPEC.topMount; }
    this.gear = 1; this.rpm = SPEC.idle; this.shiftTimer = 0; this.hint = pose.i ?? -1;
  }

  ratio() { return this.gear === -1 ? -SPEC.reverse * SPEC.final : (this.gear === 0 ? 0 : SPEC.gears[this.gear - 1] * SPEC.final); }

  shift(dir) {
    if (this.shiftTimer > 0) return;
    const g = Math.max(-1, Math.min(7, this.gear + dir));
    if (g === 0) { this.gear = dir > 0 ? 1 : -1; } else this.gear = g;
    if (this.gear === -1 && this.speedFwd() > 2) { this.gear = 1; return; }
    this.shiftTimer = SPEC.shiftTime;
  }
  speedFwd() { const f = this._t.fwd.set(0, 0, 1).applyQuaternion(this.q); return this.vel.dot(f); }

  step(dt, inp) {
    const t = this._t, W = this.world;
    this.time += dt;
    const up = t.up.set(0, 1, 0).applyQuaternion(this.q);
    const fwd = t.fwd.set(0, 0, 1).applyQuaternion(this.q);
    const left = t.left.set(1, 0, 0).applyQuaternion(this.q);
    const F = t.F.set(0, -G * SPEC.mass, 0);    // world force accumulator
    const T = t.T.set(0, 0, 0);                  // world torque accumulator about CG
    const addForceAt = (force, pointWorld) => { F.add(force); t.g.subVectors(pointWorld, this.pos).cross(force); T.add(t.g); };

    // ---- drivetrain bookkeeping ----
    if (this.shiftTimer > 0) this.shiftTimer -= dt;
    const fwdSpeed = this.vel.dot(fwd);
    let throttle = inp.throttle, brake = inp.brake;
    // automatic: brake at a standstill selects reverse, throttle selects drive
    if (this.auto) {
      if (this.gear >= 1 && brake > 0.5 && throttle < 0.05 && Math.abs(fwdSpeed) < 0.6 && inp.reverseIntent) this.gear = -1;
      if (this.gear === -1) { const tmp = throttle; throttle = brake; brake = tmp; if (inp.throttle > 0.1 && fwdSpeed > -0.6) this.gear = 1; }
    }
    const rearOmega = (this.wheels[2].omega + this.wheels[3].omega) / 2;
    const ratio = this.ratio();
    let wheelRpm = Math.abs(rearOmega * ratio) * 60 / (2 * Math.PI);
    const clutchSlip = wheelRpm < 1800 && throttle > 0.02;
    let engRpm = clutchSlip ? Math.max(wheelRpm, SPEC.idle + throttle * 3200) : Math.max(SPEC.idle, wheelRpm);
    if (this.shiftTimer > 0) throttle *= 0.15;
    if (engRpm >= SPEC.redline) throttle = (this.time * 40 % 1 < 0.5) ? 0 : throttle * 0.3; // limiter bounce
    // traction control trims throttle when the rears spin up
    this.tcActive = false;
    if (this.tc) {
      const vr = Math.max(Math.abs(fwdSpeed), 0.1);
      const ex = Math.max(...[2, 3].map(k => this.wheels[k].omega * this.wheels[k].spec.r)) - Math.abs(fwdSpeed);
      const lim = Math.max(1.2, 0.11 * vr);
      if (ex > lim) { throttle *= Math.max(0, 1 - (ex - lim) / lim * 1.5); this.tcActive = true; }
      const rs = Math.max(this.wheels[2].slip, this.wheels[3].slip);
      if (rs > 0.95 && Math.abs(fwdSpeed) > 4) { throttle *= Math.max(0.05, 1 - (rs - 0.95) * 4); this.tcActive = true; }
    }
    this.throttleOut = throttle;
    let engT = throttle * torqueAt(engRpm) - (1 - throttle) * (28 + engRpm * 0.0065) * Math.min(1, wheelRpm / 1500);
    if (this.gear === 0) engT = 0;
    const driveT = engT * ratio * SPEC.efficiency; // total at the rear axle
    this.rpm += (engRpm - this.rpm) * Math.min(1, dt * 30);

    // ---- auto shift ----
    if (this.auto && this.shiftTimer <= 0 && this.gear >= 1) {
      if (this.rpm > 8750 && this.gear < 7 && inp.throttle > 0.3) this.shift(+1);
      else if (this.gear > 1) {
        const down = SPEC.gears[this.gear - 2] * SPEC.final * Math.abs(rearOmega) * 60 / (2 * Math.PI);
        if (down < (brake > 0.2 ? 7400 : 5600) && this.rpm < (brake > 0.2 ? 6200 : 3800)) this.shift(-1);
      }
    }

    // ---- steering (simple Ackermann) ----
    const steer = inp.steer * SPEC.maxSteer;
    this.absActive = false;
    const speed = this.vel.length();
    const aero = 0.5 * RHO * SPEC.ClA * fwdSpeed * fwdSpeed;

    // ---- suspensions & tyres ----
    const comp = [0, 0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const wh = this.wheels[k], s = wh.spec;
      const ack = s.front ? (steer * (1 + 0.12 * Math.sign(steer) * (s.pos[0] > 0 ? 1 : -1))) : 0;
      wh.steer = ack;
      // suspension top mount in world
      const top = t.a.copy(wh.local).addScaledVector(t.b.set(0, 1, 0), SPEC.topMount).applyQuaternion(this.q).add(this.pos);
      const gy = W.ground(top.x, top.z, this.hint);
      const upY = Math.max(0.2, up.y);
      const dist = (top.y - gy) / upY;          // along car-up to the ground
      const L = dist - s.r;
      wh.Lprev = wh.L;
      wh.contact = L < SPEC.topMount + 0.12;
      wh.L = Math.min(SPEC.topMount + 0.12, Math.max(0.07, L));
      wh.surface = W.surface(top.x, top.z, this.hint);
      if (!wh.contact) { wh.Fz = 0; wh.sigma *= 0.9; wh.tanA *= 0.9; comp[k] = 0; continue; }
      comp[k] = wh.restL - wh.L;
      const Lvel = Math.max(-2.5, Math.min(2.5, (wh.L - wh.Lprev) / dt));
      let Fs = s.k * (wh.restL - wh.L) - (Lvel < 0 ? s.cb : s.cr) * Lvel;
      if (L < 0.07) Fs += (0.07 - L) * 600000;    // bump stop
      wh.FzSpring = Math.max(0, Fs);
    }
    // anti-roll bars
    const arbF = (comp[0] - comp[1]) * SPEC.arbFront, arbR = (comp[2] - comp[3]) * SPEC.arbRear;
    if (this.wheels[0].contact && this.wheels[1].contact) { this.wheels[0].FzSpring += arbF; this.wheels[1].FzSpring -= arbF; }
    if (this.wheels[2].contact && this.wheels[3].contact) { this.wheels[2].FzSpring += arbR; this.wheels[3].FzSpring -= arbR; }

    let lsdT = (this.wheels[2].omega - this.wheels[3].omega) * 260;
    lsdT = Math.max(-900, Math.min(900, lsdT));

    for (let k = 0; k < 4; k++) {
      const wh = this.wheels[k], s = wh.spec;
      const r = s.r;
      // drive / brake torques on this wheel
      let Td = 0;
      if (!s.front) Td = driveT * 0.5 + (k === 2 ? -lsdT : lsdT);
      let Tb = brake * s.brake + (inp.handbrake && !s.front ? 3000 : 0);
      if (!wh.contact) {
        wh.omega += (Td / (s.front ? 1.2 : 1.6)) * dt;
        const dec = Tb / 1.4 * dt; wh.omega = Math.abs(wh.omega) <= dec ? 0 : wh.omega - Math.sign(wh.omega) * dec;
        wh.angle += wh.omega * dt; continue;
      }
      const Fz = Math.max(0, wh.FzSpring) + aero * (s.front ? SPEC.aeroFront : 1 - SPEC.aeroFront) / 2;
      wh.Fz = Fz;
      // contact frame
      const hub = t.a.copy(wh.local).addScaledVector(t.b.set(0, 1, 0), SPEC.topMount - wh.L).applyQuaternion(this.q).add(this.pos);
      const n = W.normal(hub.x, hub.z, t.n, this.hint);
      const cp = t.c.copy(hub).addScaledVector(n, -r);
      const wf = t.d.copy(fwd).applyAxisAngle(up, wh.steer); // wheel heading
      wf.addScaledVector(n, -wf.dot(n)).normalize();
      const wl = t.f.crossVectors(n, wf).normalize();         // wheel left
      // contact point velocity
      const vc = t.b.subVectors(cp, this.pos).cross(this.w).negate().add(this.vel); // v + w x r
      const vx = vc.dot(wf), vy = vc.dot(wl);
      // slip states with relaxation (implicit, stable at all speeds)
      const ax = Math.abs(vx);
      wh.sigma = (wh.sigma + dt * (wh.omega * r - vx) / SPEC.relaxLong) / (1 + dt * ax / SPEC.relaxLong);
      wh.tanA = (wh.tanA + dt * vy / SPEC.relaxLat) / (1 + dt * ax / SPEC.relaxLat);
      const mu = (wh.surface === 0 ? SPEC.mu : SPEC.muGrass) * (1 - SPEC.loadSens * (Fz / SPEC.fz0 - 1));
      const sx = wh.sigma / SPEC.slipPeakLong, sy = wh.tanA / SPEC.slipPeakLat;
      const sMag = Math.hypot(sx, sy);
      let Fx = 0, Fy = 0;
      if (sMag > 1e-6) { const Fm = mu * Fz * mf(sMag); Fx = Fm * sx / sMag; Fy = -Fm * sy / sMag; }
      // low-speed damping so a parked car settles instead of creeping
      const lowK = Math.max(0, 1 - speed / 2.5);
      if (lowK > 0) { Fy += -vy * Fz * 0.25 * lowK; }
      // rolling resistance
      Fx -= Math.sign(vx) * Math.min(Math.abs(vx) * 50, 0.013 * Fz) * (wh.surface === 0 ? 1 : 4);
      wh.slip = sMag;
      // ABS
      if (this.abs && brake > 0.05 && wh.sigma < -0.11 && ax > 3) { Tb *= 0.25; this.absActive = true; }
      // wheel spin: drive torque minus tyre reaction, then brake
      const Iw = s.front ? 1.2 : 1.6;
      wh.omega += (Td - Fx * r) / Iw * dt;
      const dec = Tb / Iw * dt;
      wh.omega = Math.abs(wh.omega) <= dec ? 0 : wh.omega - Math.sign(wh.omega) * dec;
      wh.angle += wh.omega * dt;
      // apply suspension (along car up, at the hub) and tyre force (at the contact patch)
      addForceAt(t.e.copy(up).multiplyScalar(Math.max(0, wh.FzSpring)), hub);
      const tire = t.e.copy(wf).multiplyScalar(Fx).addScaledVector(wl, Fy);
      F.add(tire); T.add(t.b.subVectors(cp, this.pos).cross(tire));
    }

    // ---- aero: drag at CG, downforce at the axles ----
    if (speed > 0.1) F.addScaledVector(this.vel, -0.5 * RHO * SPEC.CdA * speed);
    if (aero > 0) {
      addForceAt(t.e.copy(up).multiplyScalar(-aero * SPEC.aeroFront), t.c.copy(fwd).multiplyScalar(1.5).add(this.pos));
      addForceAt(t.e.copy(up).multiplyScalar(-aero * (1 - SPEC.aeroFront)), t.c.copy(fwd).multiplyScalar(-0.96).add(this.pos));
    }

    // ---- chassis contacts: ground (rollover) and armco ----
    const near = this._near;
    this.offTrack = false;
    for (const p of this.chassisPts) {
      const pw = t.a.copy(p).applyQuaternion(this.q).add(this.pos);
      const vp = t.b.subVectors(pw, this.pos).cross(this.w).negate().add(this.vel);
      const gy = W.ground(pw.x, pw.z, this.hint);
      if (pw.y < gy) {
        const pen = gy - pw.y;
        const fn = Math.max(0, pen * 260000 - vp.y * 9000);
        const fr = t.c.set(-vp.x, 0, -vp.z); const l = fr.length(); if (l > 0.01) fr.multiplyScalar(Math.min(fn * 0.55, l * 3000) / l);
        fr.y = fn; addForceAt(fr, pw);
      }
      W.nearest(pw.x, pw.z, near, this.hint);
      const lim = W.WALL - 0.15;
      if (near.dist > lim) {
        const pen = near.dist - lim;
        // outward normal (horizontal) = sign(d) * left-of-travel
        const i = near.i; const tx = W.S.tx[i], tz = W.S.tz[i];
        const sgn = Math.sign(near.d);
        const nx = -sgn * tz, nz = sgn * tx;          // points back toward the track
        const vn = vp.x * nx + vp.z * nz;
        const fn = Math.max(0, pen * 420000 - vn * 14000);
        const tvx = vp.x - vn * nx, tvz = vp.z - vn * nz; const tl = Math.hypot(tvx, tvz);
        const ff = tl > 0.01 ? Math.min(fn * 0.35, tl * 4000) / tl : 0;
        addForceAt(t.c.set(nx * fn - tvx * ff, 0, nz * fn - tvz * ff), pw);
        this.hitWall = Math.max(this.hitWall || 0, Math.min(1, fn / 60000));
      }
    }

    // ---- integrate ----
    this.vel.addScaledVector(F, dt / SPEC.mass);
    this.pos.addScaledVector(this.vel, dt);
    // angular: work in local space with a diagonal inertia
    const qi = t.q.copy(this.q).invert();
    const Tl = t.a.copy(T).applyQuaternion(qi);
    const wl = t.b.copy(this.w).applyQuaternion(qi);
    const I = SPEC.inertia;
    const Iw = t.c.set(wl.x * I.x, wl.y * I.y, wl.z * I.z);
    const gyro = t.d.crossVectors(wl, Iw);
    wl.x += (Tl.x - gyro.x) / I.x * dt; wl.y += (Tl.y - gyro.y) / I.y * dt; wl.z += (Tl.z - gyro.z) / I.z * dt;
    this.w.copy(wl).applyQuaternion(this.q);
    const wq = t.q.set(this.w.x, this.w.y, this.w.z, 0).multiply(this.q);
    this.q.x += 0.5 * wq.x * dt; this.q.y += 0.5 * wq.y * dt; this.q.z += 0.5 * wq.z * dt; this.q.w += 0.5 * wq.w * dt;
    this.q.normalize();

    // ---- telemetry ----
    W.nearest(this.pos.x, this.pos.z, near, this.hint);
    this.hint = near.i; this.trackS = near.s; this.trackD = near.d;
    this.offTrack = near.dist > 7.2;
    const accel = t.a.copy(F).divideScalar(SPEC.mass); accel.y += G;
    this.gLat += (accel.dot(left) / G - this.gLat) * Math.min(1, dt * 8);
    this.gLong += (accel.dot(fwd) / G - this.gLong) * Math.min(1, dt * 8);
    this.speed = speed;
  }
}
