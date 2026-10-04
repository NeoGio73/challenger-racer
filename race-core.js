(function (root) {
  'use strict';
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const wrap = (s, length) => ((s % length) + length) % length;
  class Track {
    constructor(points, halfWidth = 9) {
      this.points = points; this.halfWidth = halfWidth; this.segments = []; this.length = 0;
      for (let i = 0; i < points.length - 1; i++) {
        const a = points[i], b = points[i + 1], dx = b.x - a.x, dz = b.z - a.z, length = Math.hypot(dx, dz);
        if (!length) continue;
        this.segments.push({ a, b, dx, dz, length, s: this.length, tx: dx / length, tz: dz / length });
        this.length += length;
      }
    }
    at(distance) {
      const s = wrap(distance, this.length);
      const seg = this.segments.find(seg => s <= seg.s + seg.length) || this.segments[0];
      const t = clamp((s - seg.s) / seg.length, 0, 1);
      return { x: seg.a.x + seg.dx * t, z: seg.a.z + seg.dz * t, tx: seg.tx, tz: seg.tz, s };
    }
    nearest(x, z) {
      let best = Infinity, result;
      for (const seg of this.segments) {
        const t = clamp(((x - seg.a.x) * seg.dx + (z - seg.a.z) * seg.dz) / (seg.length * seg.length), 0, 1);
        const px = seg.a.x + seg.dx * t, pz = seg.a.z + seg.dz * t, d2 = (x - px) ** 2 + (z - pz) ** 2;
        if (d2 < best) { best = d2; result = { x: px, z: pz, s: seg.s + t * seg.length, tx: seg.tx, tz: seg.tz, distance: Math.sqrt(d2) }; }
      }
      return result;
    }
  }
  class Race {
    constructor(track) { this.track = track; this.totalLaps = 3; this.gateCount = 8; this.gates = Array.from({ length: 8 }, (_, i) => track.at(track.length * i / 8)); this.restart(); this.state = 'ready'; }
    restart() {
      this.state = 'countdown'; this.countdown = 3; this.elapsed = 0; this.lapStart = 0; this.lap = 1;
      this.nextGate = 1; this.lastGate = 0; this.lapTimes = []; this.penalty = 0; this.resets = 0;
      this.hitCooldown = 0; this.collision = 0; this.checkpointFlash = 0; this.wrongWay = false;
      this.spawn(6); this.pausedFrom = null;
    }
    spawn(distance) {
      const p = this.track.at(distance);
      this.x = p.x; this.z = p.z; this.yaw = Math.atan2(p.tx, p.tz);
      this.speed = 0; this.vx = 0; this.vz = 0; this.steer = 0; this.distance = p.s; this.sliding = false;
    }
    pause() { if (['racing', 'countdown'].includes(this.state)) { this.pausedFrom = this.state; this.state = 'paused'; } }
    resume() { if (this.state === 'paused') { this.state = this.pausedFrom || 'racing'; this.pausedFrom = null; } }
    resetCar() {
      if (this.state !== 'racing') return false;
      this.spawn(this.track.length * this.lastGate / this.gateCount + 6);
      this.elapsed += 3; this.penalty += 3; this.resets++; return true;
    }
    tick(dt, input = {}) {
      dt = clamp(dt, 0, 1 / 30);
      this.checkpointFlash = Math.max(0, this.checkpointFlash - dt);
      this.collision = Math.max(0, this.collision - dt);
      this.hitCooldown = Math.max(0, this.hitCooldown - dt);
      if (this.state === 'countdown') { this.countdown -= dt; if (this.countdown <= 0) this.state = 'racing'; return; }
      if (this.state !== 'racing') return;
      this.elapsed += dt;
      const prevX = this.x, prevZ = this.z;
      const steerTarget = (input.left ? 1 : 0) - (input.right ? 1 : 0);
      this.steer += (steerTarget - this.steer) * (1 - Math.exp(-7 * dt));
      let acceleration = input.gas ? 17 : 0;
      if (input.brake) acceleration = this.speed > 1 ? -34 : -12;
      if (input.gas && input.brake) acceleration = this.speed > 0 ? -34 : 20;
      if (!input.gas && !input.brake && Math.abs(this.speed) < 0.06) this.speed = 0;
      else acceleration -= Math.sign(this.speed) * (1.7 + this.speed * this.speed * .007);
      this.speed = clamp(this.speed + acceleration * dt, -8, 42);
      const drifting = !!input.drift && Math.abs(this.speed) > 7;
      const angle = .56 / (1 + Math.abs(this.speed) / 22);
      this.yaw += this.steer * this.speed / 2.95 * Math.tan(angle) * dt * (drifting ? 1.2 : 1);
      const grip = drifting ? 2.1 : 9, blend = 1 - Math.exp(-grip * dt);
      this.vx += (Math.sin(this.yaw) * this.speed - this.vx) * blend;
      this.vz += (Math.cos(this.yaw) * this.speed - this.vz) * blend;
      this.x += this.vx * dt; this.z += this.vz * dt;
      this.sliding = drifting || (Math.abs(this.steer) > .65 && this.speed > 28);
      let nearest = this.track.nearest(this.x, this.z);
      const edge = this.track.halfWidth - 1.1;
      if (nearest.distance > edge) {
        const nx = (this.x - nearest.x) / nearest.distance, nz = (this.z - nearest.z) / nearest.distance;
        this.x = nearest.x + nx * edge; this.z = nearest.z + nz * edge;
        const outward = this.vx * nx + this.vz * nz;
        if (outward > 0) { this.vx -= nx * outward * 1.1; this.vz -= nz * outward * 1.1; }
        if (this.hitCooldown <= 0 && Math.abs(this.speed) > 4) { this.speed *= .56; this.collision = .3; this.hitCooldown = .6; }
        this.speed *= Math.exp(-1.1 * dt);
        nearest = this.track.nearest(this.x, this.z);
      }
      this.distance = nearest.s;
      this.wrongWay = this.speed > 3 && Math.sin(this.yaw) * nearest.tx + Math.cos(this.yaw) * nearest.tz < -.3;
      const gate = this.gates[this.nextGate];
      const before = (prevX - gate.x) * gate.tx + (prevZ - gate.z) * gate.tz;
      const after = (this.x - gate.x) * gate.tx + (this.z - gate.z) * gate.tz;
      const lateral = Math.abs((this.x - gate.x) * gate.tz - (this.z - gate.z) * gate.tx);
      if (before < 0 && after >= 0 && lateral < this.track.halfWidth + 1 && !this.wrongWay) {
        this.lastGate = this.nextGate; this.checkpointFlash = 1.5;
        if (this.nextGate === 0) {
          this.lapTimes.push(this.elapsed - this.lapStart); this.lapStart = this.elapsed;
          if (this.lap === this.totalLaps) { this.state = 'finished'; this.speed = 0; return; }
          this.lap++;
        }
        this.nextGate = (this.nextGate + 1) % this.gateCount;
      }
    }
    snapshot() { return { state: this.state, lap: this.lap, laps: this.totalLaps, nextCheckpoint: this.nextGate, time: +this.elapsed.toFixed(2), speedMph: Math.round(Math.abs(this.speed) * 2.23694), lapTimes: [...this.lapTimes], resets: this.resets }; }
  }
  const api = { Track, Race, clamp, wrap };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Racing = api;
})(typeof window === 'undefined' ? globalThis : window);
