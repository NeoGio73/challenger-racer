// Drive mode: puts the GT3 on the Hochwald Ring with the sim physics.
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import * as TR from './trackdata.js';
import { Car, SPEC } from './physics.js';
import { buildTrack, minimapPath } from './track.js';

const $ = (id) => document.getElementById(id);
const STEP = 1 / 600;
let built = null, trackScene = null, sun = null, envTex = null;
let S = null; // active session state

// ---------------- audio: a synthesised flat-six ----------------
class EngineAudio {
  constructor() {
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC();
    const c = this.ctx;
    this.master = c.createGain(); this.master.gain.value = 0.8; this.master.connect(c.destination);
    const mix = c.createGain(); mix.gain.value = 1;
    this.o1 = c.createOscillator(); this.o1.type = 'sawtooth';
    this.o2 = c.createOscillator(); this.o2.type = 'square';
    this.o3 = c.createOscillator(); this.o3.type = 'sawtooth';
    const g1 = c.createGain(), g2 = c.createGain(), g3 = c.createGain(); g1.gain.value = 0.5; g2.gain.value = 0.25; g3.gain.value = 0.18;
    this.o1.connect(g1).connect(mix); this.o2.connect(g2).connect(mix); this.o3.connect(g3).connect(mix);
    const shaper = c.createWaveShaper(); const curve = new Float32Array(1024);
    for (let i = 0; i < 1024; i++) { const x = i / 512 - 1; curve[i] = Math.tanh(x * 2.4); } shaper.curve = curve;
    this.lp = c.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.Q.value = 2.5;
    this.eng = c.createGain(); this.eng.gain.value = 0;
    mix.connect(shaper).connect(this.lp).connect(this.eng).connect(this.master);
    // noise for tyres and wind
    const buf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate); const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const mkNoise = (type, f, q) => { const s = c.createBufferSource(); s.buffer = buf; s.loop = true; const fl = c.createBiquadFilter(); fl.type = type; fl.frequency.value = f; fl.Q.value = q; const g = c.createGain(); g.gain.value = 0; s.connect(fl).connect(g).connect(this.master); s.start(); return g; };
    this.squeal = mkNoise('bandpass', 1100, 6);
    this.wind = mkNoise('lowpass', 380, 0.7);
    this.thump = mkNoise('lowpass', 140, 1);
    for (const o of [this.o1, this.o2, this.o3]) o.start();
    this.muted = false;
  }
  update(car, throttle) {
    const t = this.ctx.currentTime, f = car.rpm / 60 * 3; // flat-six fires 3 times per revolution
    this.o1.frequency.setTargetAtTime(f, t, 0.012);
    this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.012);
    this.o3.frequency.setTargetAtTime(f * 1.5 + 3, t, 0.012);
    this.lp.frequency.setTargetAtTime(350 + throttle * 2600 + car.rpm / 9000 * 1800, t, 0.03);
    const m = this.muted ? 0 : 1;
    this.eng.gain.setTargetAtTime(m * (0.05 + 0.13 * throttle + 0.05 * car.rpm / 9000), t, 0.03);
    const slip = Math.max(...car.wheels.map(w => (w.contact && w.surface === 0) ? w.slip : 0));
    this.squeal.gain.setTargetAtTime(m * Math.min(0.22, Math.max(0, slip - 0.85) * 0.35) * Math.min(1, car.speed / 6), t, 0.05);
    this.wind.gain.setTargetAtTime(m * Math.min(0.35, (car.speed / 80) ** 2 * 0.35), t, 0.1);
    if (car.hitWall > 0.15) { this.thump.gain.setValueAtTime(m * Math.min(1, car.hitWall), t); this.thump.gain.setTargetAtTime(0, t, 0.08); }
  }
  setMuted(v) { this.muted = v; }
  suspend() { try { this.ctx.suspend(); } catch (e) { /* ignore */ } }
  resume() { try { this.ctx.resume(); } catch (e) { /* ignore */ } }
}

// One audio engine for the whole page. It must be created and resumed inside the tap itself:
// iOS Safari keeps audio silent otherwise, and the ringer switch mutes Web Audio unless the
// page's audio session is set to "playback".
let sharedAudio = null;
export function unlockAudio() {
  try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) { /* older browsers */ }
  try {
    if (!sharedAudio) sharedAudio = new EngineAudio();
    sharedAudio.resume();
    // a short silent buffer played right now completes the unlock on older iOS
    const c = sharedAudio.ctx, b = c.createBuffer(1, 1, 22050), src = c.createBufferSource();
    src.buffer = b; src.connect(c.destination); src.start(0);
  } catch (e) { sharedAudio = null; }
  return sharedAudio;
}
addEventListener('pointerdown', () => { if (S && S.audio && S.audio.ctx.state !== 'running') S.audio.resume(); }, { passive: true });
document.addEventListener('visibilitychange', () => { if (!S || !S.audio) return; if (document.hidden) S.audio.suspend(); else S.audio.resume(); });

// ---------------- input ----------------
const keys = new Set();
const onKey = (e) => {
  if (!S) return;
  const k = e.key.toLowerCase();
  const handled = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd', ' ', 'e', 'q', 'c', 'r', 'm', 't', 'b', 'v', 'u', 'h', 'g', 'escape'];
  if (!handled.includes(k)) return;
  e.preventDefault();
  if (e.type === 'keydown') {
    if (!keys.has(k)) {
      if (k === 'e' || k === 'q') { if (S.car.auto) { S.car.auto = false; flash('Manual gearbox: Q / E to shift, M for auto'); } S.car.shift(k === 'e' ? +1 : -1); }
      if (k === 'c') cycleCamera();
      if (k === 'r') resetToTrack();
      if (k === 'm') { S.car.auto = !S.car.auto; flash(S.car.auto ? 'Automatic gearbox' : 'Manual gearbox: Q / E to shift'); }
      if (k === 't') { S.car.tc = !S.car.tc; flash('Traction control ' + (S.car.tc ? 'on' : 'off')); }
      if (k === 'b') { S.car.abs = !S.car.abs; flash('ABS ' + (S.car.abs ? 'on' : 'off')); }
      if (k === 'g') toggleHandling();
      if (k === 'v') { S.audio && S.audio.setMuted(!S.audio.muted); flash(S.audio && S.audio.muted ? 'Sound off' : 'Sound on'); }
      if (k === 'u') { S.metric = !S.metric; }
      if (k === 'h') { $('driveHelp').hidden = !$('driveHelp').hidden; }
      if (k === 'escape') S.onExit();
    }
    keys.add(k);
  } else keys.delete(k);
};
addEventListener('keydown', onKey, { passive: false });
addEventListener('keyup', onKey, { passive: false });
addEventListener('blur', () => keys.clear());

const touch = { l: false, r: false, gas: false, brake: false };
function bindTouch() {
  $('camName').addEventListener('click', () => cycleCamera());
  $('resetBtn').addEventListener('click', () => { if (S) resetToTrack(); });
  $('handlingBtn').addEventListener('click', () => toggleHandling());
  document.querySelectorAll('[data-touch]').forEach(b => {
    const k = b.dataset.touch;
    const on = (e) => { e.preventDefault(); touch[k] = true; b.classList.add('on'); };
    const off = (e) => { e.preventDefault(); touch[k] = false; b.classList.remove('on'); };
    b.addEventListener('pointerdown', on); b.addEventListener('pointerup', off); b.addEventListener('pointercancel', off); b.addEventListener('pointerleave', off);
  });
}

function readGamepad() {
  try {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const p of pads) {
      if (!p || !p.connected) continue;
      const dz = (v) => Math.abs(v) < 0.08 ? 0 : (v - Math.sign(v) * 0.08) / 0.92;
      const st = -dz(p.axes[0] || 0);
      const gas = p.buttons[7] ? p.buttons[7].value : 0, brk = p.buttons[6] ? p.buttons[6].value : 0;
      const prev = S.padPrev || {};
      const pressed = (i) => p.buttons[i] && p.buttons[i].pressed && !prev[i];
      if (pressed(5) || pressed(4)) { if (S.car.auto) { S.car.auto = false; flash('Manual gearbox'); } S.car.shift(pressed(5) ? +1 : -1); }
      if (pressed(3)) cycleCamera();
      if (pressed(9)) resetToTrack();
      S.padPrev = Object.fromEntries(p.buttons.map((b, i) => [i, b.pressed]));
      if (Math.abs(st) > 0 || gas > 0.02 || brk > 0.02) return { steer: Math.sign(st) * st * st * 0.6 + st * 0.4, throttle: gas, brake: brk, analog: true };
    }
  } catch (e) { /* gamepads unavailable in this frame */ }
  return null;
}

// ---------------- cameras ----------------
const CAMS = ['chase', 'cockpit', 'bumper', 'tv'];
const CAM_NAMES = { chase: 'Chase', cockpit: 'Cockpit', bumper: 'Bumper', tv: 'TV' };
function cycleCamera() { if (!S) return; S.cam = CAMS[(CAMS.indexOf(S.cam) + 1) % CAMS.length]; $('camName').textContent = CAM_NAMES[S.cam] + ' cam'; S.camSnap = true; }

function toggleHandling() {
  if (!S) return;
  S.car.arcade = !S.car.arcade;
  try { localStorage.setItem('gt3-handling', S.car.arcade ? 'arcade' : 'sim'); } catch (e) { /* storage blocked */ }
  flash(S.car.arcade ? 'Arcade handling: extra grip and stability' : 'Sim handling: real GT3 grip, it will slide');
}
function flash(msg, ms = 1800) { const el = $('driveMsg'); el.textContent = msg; el.classList.add('show'); clearTimeout(S.msgT); S.msgT = setTimeout(() => el.classList.remove('show'), ms); }

function resetToTrack() {
  const n = TR.nearest(S.car.pos.x, S.car.pos.z, {}, S.car.hint);
  const i = n.i;
  S.car.reset({ x: TR.S.x[i], z: TR.S.z[i], heading: Math.atan2(TR.S.tx[i], TR.S.tz[i]), i });
  S.lapValid = false; flash('Back on track (lap invalidated)');
}

const fmt = (t) => { if (t == null || !isFinite(t)) return '–:––.–––'; const m = Math.floor(t / 60), s = t - m * 60; return `${m}:${s.toFixed(3).padStart(6, '0')}`; };

// ---------------- enter / exit ----------------
export function isActive() { return !!S; }

export function enter(ctx) {
  const { renderer, camera, carRoot, parts } = ctx;
  if (!built) {
    built = buildTrack(renderer);
    trackScene = new THREE.Scene();
    trackScene.add(built.group);
    trackScene.fog = new THREE.FogExp2(built.fogColor, 0.00026);
    sun = new THREE.DirectionalLight(0xfff1dc, 2.6);
    sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -38, right: 38, top: 38, bottom: -38, near: 10, far: 400 });
    sun.shadow.bias = -0.0003; sun.shadow.normalBias = 0.03;
    trackScene.add(sun, sun.target);
    trackScene.add(new THREE.HemisphereLight(0xcfe1ff, 0x4a5a32, 0.7));
    // reflections from the same sky
    const pm = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene(); const sky2 = new Sky(); sky2.scale.setScalar(50);
    for (const k in built.sky.material.uniforms) sky2.material.uniforms[k].value = built.sky.material.uniforms[k].value;
    envScene.add(sky2);
    envTex = pm.fromScene(envScene).texture;
    trackScene.environment = envTex;
    trackScene.background = envTex; // the sky, without a giant dome to clip
    built.group.remove(built.sky);
    // minimap background
    const mm = $('miniMap'); const g = mm.getContext('2d'); const size = mm.width;
    const path = minimapPath(size, 12);
    const bg = document.createElement('canvas'); bg.width = bg.height = size; const b = bg.getContext('2d');
    b.lineJoin = 'round'; b.lineCap = 'round';
    b.strokeStyle = 'rgba(255,255,255,0.18)'; b.lineWidth = 9; b.beginPath(); path.pts.forEach(([x, y], i) => i ? b.lineTo(x, y) : b.moveTo(x, y)); b.closePath(); b.stroke();
    b.strokeStyle = 'rgba(255,255,255,0.85)'; b.lineWidth = 3; b.stroke();
    const [sx, sy] = path.map(TR.S.x[0], TR.S.z[0]); b.fillStyle = '#fff'; b.fillRect(sx - 1, sy - 6, 2, 12);
    built.minimap = { g, bg, map: path.map, size };
    bindTouch();
  }
  // move the car into the circuit scene
  trackScene.add(carRoot);
  const base = {}; for (const id of ['FL', 'FR', 'RL', 'RR']) { base[id] = parts['wheel_' + id].position.clone(); }
  const steerBaseQ = parts.steering_wheel.quaternion.clone();
  const steerAxis = new THREE.Vector3().fromArray(parts.steering_wheel.userData.spin_axis_gltf || [0, -0.268, 0.963]).normalize();
  const tail = []; carRoot.traverse(o => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { if (m.name === 'taillight_emit' || m.name === 'taillight.002') tail.push(m); }); });

  const car = new Car(TR.world);
  car.reset(TR.gridPose(28));
  try { car.arcade = localStorage.getItem('gt3-handling') !== 'sim'; } catch (e) { car.arcade = true; }
  const audio = unlockAudio(); if (audio) audio.setMuted(false);
  S = {
    ...ctx, car, base, steerBaseQ, steerAxis, tail, audio, acc: 0, cam: 'chase', camSnap: true, metric: false,
    inp: { throttle: 0, brake: 0, steer: 0 }, lap: 0, lapStart: null, lapValid: true, last: null, best: null, halfway: false,
    prevS: car.trackS ?? 0.99, startT: performance.now(), released: false, hudT: 0, revHeld: 0,
    camPos: new THREE.Vector3(), camLook: new THREE.Vector3(), fov: 62, savedExposure: renderer.toneMappingExposure,
  };
  renderer.toneMappingExposure = 0.62;
  S.savedPR = renderer.getPixelRatio(); renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  camera.near = 0.05; camera.far = 12000; camera.fov = 62; camera.updateProjectionMatrix();
  $('camName').textContent = 'Chase cam';
  $('hud').hidden = false;
  document.body.classList.add('driving');
  flash('Lights out and away you go', 2500);
  $('driveHelp').hidden = false; clearTimeout(S.helpT); S.helpT = setTimeout(() => { if (S) $('driveHelp').hidden = true; }, 9000);
  syncCar(0);
}

export function exit() {
  if (!S) return;
  const { renderer, camera, carRoot, parts, studioScene } = S;
  if (S.audio) { S.audio.setMuted(true); S.audio.suspend(); }
  studioScene.add(carRoot);
  carRoot.position.set(0, 0, 0); carRoot.quaternion.identity();
  for (const id of ['FL', 'FR', 'RL', 'RR']) { const w = parts['wheel_' + id]; w.position.copy(S.base[id]); w.rotation.set(0, 0, 0); const c = parts['caliper_' + id]; if (c) { c.position.y = S.base[id].y; c.rotation.set(0, 0, 0); } }
  parts.steering_wheel.quaternion.copy(S.steerBaseQ);
  for (const m of S.tail) m.emissiveIntensity = 1.6;
  renderer.toneMappingExposure = S.savedExposure; renderer.setPixelRatio(S.savedPR);
  camera.near = 0.02; camera.far = 200; camera.updateProjectionMatrix();
  for (const m of built.group.userData.startLights) m.emissiveIntensity = 0;
  $('hud').hidden = true; document.body.classList.remove('driving');
  keys.clear();
  S = null;
}

// ---------------- per-frame ----------------
function gatherInput(dt) {
  const car = S.car, v = car.speed || 0;
  const pad = readGamepad();
  const kL = keys.has('arrowleft') || keys.has('a') || touch.l, kR = keys.has('arrowright') || keys.has('d') || touch.r;
  const kG = keys.has('arrowup') || keys.has('w') || touch.gas, kB = keys.has('arrowdown') || keys.has('s') || touch.brake;
  const inp = S.inp;
  if (pad) {
    const cap = car.arcade ? Math.min(1, 0.35 + 10 / (v + 10)) : Math.min(1, 0.22 + 7 / (v + 7));
    inp.steer = pad.steer * cap; inp.throttle = pad.throttle; inp.brake = pad.brake;
  } else {
    // keyboard: ramped inputs, speed-sensitive steering lock so a tap doesn't spin the car
    const cap = car.arcade ? Math.min(1, 0.16 + 7 / (v + 7)) : Math.min(1, 0.075 + 3.6 / (v + 3.6));
    const target = ((kL ? 1 : 0) - (kR ? 1 : 0)) * cap;
    const rate = (Math.sign(target) !== Math.sign(inp.steer) && inp.steer !== 0 ? 6 : (car.arcade ? 4.2 : 2.6)) * Math.max(cap, 0.25);
    inp.steer += Math.max(-rate * dt, Math.min(rate * dt, target - inp.steer));
    inp.throttle += Math.max(-8 * dt, Math.min(5 * dt, (kG ? 1 : 0) - inp.throttle));
    inp.brake += Math.max(-10 * dt, Math.min(7 * dt, (kB ? 1 : 0) - inp.brake));
  }
  inp.handbrake = keys.has(' ');
  // holding brake at a standstill engages reverse (automatic)
  if (inp.brake > 0.5 && Math.abs(car.speedFwd()) < 0.6 && inp.throttle < 0.05) S.revHeld += dt; else S.revHeld = 0;
  inp.reverseIntent = S.revHeld > 0.45;
  return inp;
}

const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();
function syncCar() {
  const { car, carRoot, parts, base } = S;
  carRoot.quaternion.copy(car.q);
  carRoot.position.copy(car.pos).sub(_v.copy(SPEC.cgModel).applyQuaternion(car.q));
  for (const wh of car.wheels) {
    const id = wh.spec.id, node = parts['wheel_' + id];
    const dy = SPEC.topMount - wh.L;
    node.position.set(base[id].x, base[id].y + dy, base[id].z);
    node.rotation.set(wh.angle % (Math.PI * 2), wh.steer, 0, 'YXZ');
    const c = parts['caliper_' + id]; if (c) { c.position.y = base[id].y + dy; c.rotation.set(0, wh.steer, 0); }
  }
  _q.setFromAxisAngle(S.steerAxis, -S.inp.steer * SPEC.maxSteer * 9);
  parts.steering_wheel.quaternion.copy(_q).multiply(S.steerBaseQ);
  const brakeOn = S.inp.brake > 0.05 || S.inp.handbrake;
  for (const m of S.tail) m.emissiveIntensity = brakeOn ? 5 : 1.4;
}

function updateCamera(dt) {
  const { car, camera, carRoot } = S;
  const fwd = _v.set(0, 0, 1).applyQuaternion(car.q);
  const k = S.camSnap ? 1 : 1 - Math.exp(-dt * 7);
  let fov = 62;
  if (S.cam === 'chase') {
    // Fixed distance behind the car; only the camera's heading and height are smoothed,
    // so it never falls back at speed or lurches when the car pitches over crests.
    const yaw = Math.atan2(fwd.x, fwd.z);
    if (S.camSnap || S.camYaw === undefined) { S.camYaw = yaw; S.camY = car.pos.y; }
    let dy = Math.atan2(Math.sin(yaw - S.camYaw), Math.cos(yaw - S.camYaw));
    S.camYaw += dy * (1 - Math.exp(-dt * 5));
    S.camY += (car.pos.y - S.camY) * (1 - Math.exp(-dt * 6));
    const bx = Math.sin(S.camYaw), bz = Math.cos(S.camYaw);
    const cx = car.pos.x - bx * 6.2, cz = car.pos.z - bz * 6.2;
    let cy = S.camY + 1.85; const gy = TR.ground(cx, cz, car.hint); if (cy < gy + 1.2) cy = gy + 1.2;
    camera.position.set(cx, cy, cz);
    camera.lookAt(car.pos.x + bx * 3, S.camY + 0.6, car.pos.z + bz * 3);
    fov = 60 + Math.min(14, car.speed * 0.12);
  } else if (S.cam === 'cockpit' || S.cam === 'bumper') {
    const eye = S.cam === 'cockpit' ? new THREE.Vector3(0.37 + car.gLat * -0.012, 1.0 - car.gLong * 0.006, -0.22 - car.gLong * 0.015) : new THREE.Vector3(0, 0.62, 2.38);
    camera.position.copy(eye).applyMatrix4(carRoot.matrixWorld);
    const tgt = new THREE.Vector3(eye.x, eye.y - (S.cam === 'cockpit' ? 0.07 : 0.02), eye.z + 1).applyMatrix4(carRoot.matrixWorld);
    camera.up.set(0, 1, 0).applyQuaternion(car.q);
    camera.lookAt(tgt);
    camera.up.set(0, 1, 0);
    fov = S.cam === 'cockpit' ? 72 : 66;
  } else {
    // nearest trackside camera ahead of or just behind the car
    let best = null, bd = 1e9;
    for (const c of built.tvCams) {
      let di = c.i - car.hint; if (di < -TR.N / 2) di += TR.N; if (di > TR.N / 2) di -= TR.N;
      const score = Math.abs(di - 40);
      if (score < bd) { bd = score; best = c; }
    }
    camera.position.copy(best.pos);
    S.camLook.lerp(new THREE.Vector3().copy(car.pos).add(new THREE.Vector3(0, 0.6, 0)), S.camSnap ? 1 : 1 - Math.exp(-dt * 10));
    camera.lookAt(S.camLook);
    const d = camera.position.distanceTo(car.pos);
    fov = THREE.MathUtils.clamp(THREE.MathUtils.radToDeg(2 * Math.atan(5.5 / d)), 4, 55);
  }
  if (window.__dbgCam) { const d = window.__dbgCam; camera.position.set(...d.pos); camera.lookAt(...d.look); fov = d.fov || 50; }
  if (Math.abs(camera.fov - fov) > 0.05) { camera.fov += (fov - camera.fov) * (S.camSnap ? 1 : Math.min(1, dt * 4)); camera.updateProjectionMatrix(); }
  S.camSnap = false;
  sun.position.copy(car.pos).addScaledVector(built.sunDir, 160); sun.target.position.copy(car.pos); sun.target.updateMatrixWorld();
}

function updateLap() {
  const s = S.car.trackS, now = S.car.time;
  if (s > 0.45 && s < 0.6) S.halfway = true;
  if (S.prevS > 0.9 && s < 0.1) {
    if (S.lapStart !== null && S.halfway) {
      const t = now - S.lapStart;
      if (S.lapValid) { S.last = t; const pb = S.best == null || t < S.best; if (pb) S.best = t; flash(`Lap ${S.lap}: ${fmt(t)}${pb ? ' · best lap' : ''}`, 3500); }
      else { S.last = t; flash(`Lap ${S.lap}: ${fmt(t)} (invalid)`, 3000); }
    }
    S.lap += 1; S.lapStart = now; S.lapValid = true; S.halfway = false;
  }
  if (S.car.offTrack && S.lapStart !== null && S.lapValid && Math.abs(S.car.trackD) > TR.ROAD_HALF + 3.5) { S.lapValid = false; flash('Track limits: lap invalidated'); }
  S.prevS = s;
}

const LEDS = 15;
function updateHud(dt) {
  S.hudT += dt; if (S.hudT < 1 / 30) return; S.hudT = 0;
  const c = S.car;
  const sp = S.metric ? c.speed * 3.6 : c.speed * 2.23694;
  $('hudSpeed').textContent = Math.round(Math.abs(c.speedFwd()) * (S.metric ? 3.6 : 2.23694));
  $('hudUnit').textContent = S.metric ? 'km/h' : 'mph';
  $('hudGear').textContent = c.gear === -1 ? 'R' : (c.gear === 0 ? 'N' : String(c.gear));
  $('hudRpm').textContent = Math.round(c.rpm / 10) * 10;
  const lit = Math.max(0, Math.min(LEDS, Math.round((c.rpm - 6000) / (8800 - 6000) * LEDS)));
  const flashAll = c.rpm > 8750 && (performance.now() / 70 | 0) % 2;
  const leds = $('hudLeds').children;
  for (let i = 0; i < LEDS; i++) leds[i].className = flashAll ? 'led b' : (i < lit ? (i < 6 ? 'led g' : i < 11 ? 'led y' : 'led r') : 'led');
  $('hudRpmBar').style.width = Math.min(100, c.rpm / 9000 * 100) + '%';
  $('hudTc').classList.toggle('on', c.tc); $('hudTc').classList.toggle('act', c.tcActive);
  $('hudAbs').classList.toggle('on', c.abs); $('hudAbs').classList.toggle('act', c.absActive);
  $('hudMode').textContent = c.auto ? 'AUTO' : 'MAN';
  $('handlingBtn').textContent = c.arcade ? 'Arcade' : 'Sim';
  const cur = S.lapStart == null ? null : c.time - S.lapStart;
  $('lapNow').textContent = S.lapStart == null ? 'Out lap' : fmt(cur);
  $('lapNow').classList.toggle('invalid', !S.lapValid && S.lapStart != null);
  $('lapNum').textContent = S.lapStart == null ? '' : 'Lap ' + S.lap;
  $('lapLast').textContent = fmt(S.last); $('lapBest').textContent = fmt(S.best);
  $('hudG').textContent = `${Math.abs(c.gLat).toFixed(2)} g`;
  void sp;
  // minimap
  const mm = built.minimap, g = mm.g;
  g.clearRect(0, 0, mm.size, mm.size); g.drawImage(mm.bg, 0, 0);
  const [x, y] = mm.map(c.pos.x, c.pos.z);
  if (!S.accent) S.accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent') || '#8cdb14').trim();
  g.fillStyle = S.accent;
  g.strokeStyle = '#111'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); g.stroke();
}

function startLights() {
  const t = (performance.now() - S.startT) / 1000;
  const L = built.group.userData.startLights;
  const n = Math.min(5, Math.floor(t / 0.7));
  if (!S.released) {
    for (let i = 0; i < 5; i++) L[i].emissiveIntensity = i < n ? 6 : 0;
    if (t > 0.7 * 5 + 0.6) { S.released = true; for (const m of L) m.emissiveIntensity = 0; flash('Go!', 1200); }
  }
}

export function frame(dt) {
  if (!S) return false;
  startLights();
  if (window.__dbgPlace) { const d = window.__dbgPlace; window.__dbgPlace = null; const i = d.i; S.car.reset({ x: TR.S.x[i], z: TR.S.z[i], heading: Math.atan2(TR.S.tx[i], TR.S.tz[i]), i }); S.car.vel.set(TR.S.tx[i] * d.v, 0, TR.S.tz[i] * d.v); for (const w of S.car.wheels) w.omega = d.v / w.spec.r; S.car.gear = d.g || 3; S.released = true; S.camSnap = true; }
  const inp = gatherInput(dt);
  const phys = { ...inp };
  if (!S.released) { phys.handbrake = true; phys.brake = Math.max(phys.brake, 1); }
  S.acc += Math.min(dt, 0.1);
  let n = 0;
  while (S.acc >= STEP && n < 120) { S.car.step(STEP, phys); S.acc -= STEP; n++; }
  if (!isFinite(S.car.pos.x) || S.car.pos.y < -200) resetToTrack();
  // auto-recover when the car is on its side/roof or beached against the barrier
  const upY = _v.set(0, 1, 0).applyQuaternion(S.car.q).y;
  const stuck = upY < 0.35 || (S.car.speed < 1.2 && Math.abs(S.car.trackD) > TR.WALL - 2.5 && S.released);
  S.stuckT = stuck ? (S.stuckT || 0) + dt : 0;
  if (S.stuckT > 2.5) { S.stuckT = 0; resetToTrack(); }
  syncCar();
  S.carRoot.updateMatrixWorld(true);
  updateCamera(dt);
  updateLap();
  updateHud(dt);
  if (S.audio) S.audio.update(S.car, S.car.throttleOut);
  S.car.hitWall = 0;
  S.renderer.render(trackScene, S.camera);
  return true;
}
