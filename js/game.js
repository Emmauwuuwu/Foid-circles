// The play session: audio clock, input judgement, scoring and canvas rendering.
(function (P) {
  'use strict';

  const COLORS = ['#d8ff3e', '#ff7a66', '#5eead4', '#a5b4fc'];
  const JUDGE = {
    perfect: { value: 300, label: 'Perfect', color: '#d8ff3e', heal: 0.035 },
    great: { value: 100, label: 'Great', color: '#ffd479', heal: 0.015 },
    ok: { value: 50, label: 'OK', color: '#ff9e7a', heal: 0.004 },
    miss: { value: 0, label: 'Miss', color: '#ff4d5e', heal: 0 },
  };

  P.FONT = '"Bahnschrift", "DIN Alternate", "Segoe UI", system-ui, sans-serif';

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function hexPath(c, x, y, r, rot) {
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = rot + i * Math.PI / 3;
      const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
      if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
    }
    c.closePath();
  }

  function pathOf(o) {
    if (!o.path.p2d) {
      const p = new Path2D();
      o.path.pts.forEach((pt, i) => (i === 0 ? p.moveTo(pt[0], pt[1]) : p.lineTo(pt[0], pt[1])));
      o.path.p2d = p;
    }
    return o.path.p2d;
  }

  function gradeFor(acc, failed) {
    if (failed) return 'F';
    if (acc >= 0.999) return 'X';
    if (acc >= 0.95) return 'S';
    if (acc >= 0.9) return 'A';
    if (acc >= 0.8) return 'B';
    if (acc >= 0.7) return 'C';
    return 'D';
  }

  // Everything the four modes share: clock, audio, scoring, health, background and HUD.
  // A mode provides setup(), simulate(), drawPlay() and its input handling.
  class Session {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.c = canvas.getContext('2d');
      this.map = opts.map;
      this.ctx = opts.audioCtx;
      this.buffer = opts.audioBuffer;
      this.bg = opts.bgImage || null;
      this.mods = opts.mods || {};
      this.offset = opts.offset || 0;
      this.sfx = opts.sfxGain;
      this.onEnd = opts.onEnd;

      this.opts = opts;
      this.setup();
      this.lastT = this.objects.reduce((v, o) => Math.max(v, o.endT || o.t), 0);

      this.first = 0;
      this.score = 0; this.combo = 0; this.maxCombo = 0;
      this.counts = { perfect: 0, great: 0, ok: 0, miss: 0 };
      this.health = 1;
      this.errors = [];
      this.fx = [];
      this.trail = [];
      this.cursor = { x: 256, y: 192 };
      this.held = new Set();
      this.prevT = null;
      this.prevAngle = null;
      this.paused = false;
      this.ended = false;

      this.resize();
      this.frame = this.frame.bind(this);
    }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      this.dpr = dpr;
      this.W = window.innerWidth;
      this.H = window.innerHeight;
      this.canvas.width = Math.round(this.W * dpr);
      this.canvas.height = Math.round(this.H * dpr);
      this.s = Math.min(this.W / 612, this.H / 484);
      this.ox = (this.W - 512 * this.s) / 2;
      this.oy = (this.H - 384 * this.s) / 2 + 8;
    }

    // ---------- Clock ----------

    start() {
      const first = this.objects[0].t;
      if (this.opts.from != null) {
        // Testing from the editor: a short run-up into the chosen point.
        const runUp = Math.max(1500, this.preempt + 300);
        const begin = this.opts.from - runUp;
        this.playFrom(this.ctx.currentTime + 0.05 + Math.max(0, -begin) / 1000, Math.max(0, begin) / 1000);
      } else {
        const lead = Math.max(1500, this.preempt + 500 - first) / 1000;
        this.playFrom(this.ctx.currentTime + lead, 0);
      }
      this.latency = ((this.ctx.outputLatency || this.ctx.baseLatency || 0) * 1000);
      // Scoring runs on its own clock, so a slow or missing frame can never cost a hit.
      this.stepper = setInterval(() => this.step(), 10);
      this.frame();
    }

    playFrom(when, offsetSec) {
      this.stopSource();
      this.gain = this.ctx.createGain();
      this.gain.connect(P.musicOut);
      this.src = this.ctx.createBufferSource();
      this.src.buffer = this.buffer;
      this.src.connect(this.gain);
      this.src.start(when, offsetSec);
      this.startAt = when - offsetSec;
    }

    stopSource() {
      if (!this.src) return;
      try { this.src.stop(); } catch (e) { /* already ended */ }
      this.src.disconnect();
      this.gain.disconnect();
      this.src = null;
    }

    time() {
      return (this.ctx.currentTime - this.startAt) * 1000 - this.offset - (this.latency || 0);
    }

    canSkip(t) {
      return this.first === 0 && this.objects[0].t - t > this.preempt + 2000;
    }

    skip() {
      const t = this.time();
      if (!this.canSkip(t)) return;
      const to = Math.max(0, this.objects[0].t - this.preempt - 1000) / 1000;
      this.playFrom(this.ctx.currentTime, to);
    }

    pause() {
      if (this.paused || this.ended) return;
      this.paused = true;
      this.ctx.suspend();
    }

    resume() {
      if (!this.paused) return;
      this.paused = false;
      this.prevT = null;
      this.ctx.resume();
    }

    destroy() {
      this.ended = true;
      cancelAnimationFrame(this.raf);
      clearInterval(this.stepper);
      this.stopSource();
      if (this.ctx.state === 'suspended') this.ctx.resume();
    }

    // ---------- Input ----------

    usesKey() { return false; }
    setCursorScreen() {}
    press() {}
    release(id) { this.held.delete(id); }
    releaseAll() { this.held.clear(); }
    pointerPress(e, id) {
      this.setCursorScreen(e.clientX, e.clientY);
      this.press(id);
    }

    // ---------- Scoring ----------

    addCombo() {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    }

    breakCombo() { this.combo = 0; }

    judge(o, kind, x, y) {
      const j = JUDGE[kind];
      const t = this.time();
      this.counts[kind]++;
      if (kind === 'miss') {
        this.breakCombo();
        this.health -= 0.05 + this.map.hp * 0.012;
      } else {
        this.addCombo();
        this.score += Math.round(j.value * (1 + Math.min(this.combo, 400) * 0.02));
        this.health = Math.min(1, this.health + j.heal);
        this.fx.push({ kind: 'burst', x, y, t0: t, color: COLORS[(o.color || 0) % 4] });
        this.playHit(kind);
      }
      if (this.quietHits && kind !== 'miss') return;
      if (this.singleLabel) this.fx = this.fx.filter(f => f.kind !== 'label');
      this.fx.push({ kind: 'label', x, y, t0: t, text: j.label, color: j.color });
    }

    accuracy() {
      const c = this.counts;
      const n = c.perfect + c.great + c.ok + c.miss;
      return n ? (c.perfect * 300 + c.great * 100 + c.ok * 50) / (n * 300) : 1;
    }

    playHit(kind) {
      if (!this.sfx) return;
      const now = this.ctx.currentTime;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.35, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = kind === 'perfect' ? 1320 : kind === 'great' ? 990 : 740;
      o.connect(g); g.connect(this.sfx);
      o.start(now); o.stop(now + 0.09);
    }

    // ---------- Simulation ----------

    update(t, dt) {
      this.simulate(t, dt);
      while (this.first < this.objects.length && this.objects[this.first].done) this.first++;

      // Passive drain runs only while objects are close, so rests are safe.
      const next = this.objects[this.first];
      if (next && next.t - t < 2000 && t > this.objects[0].t - 500 && !this.mods.auto) {
        this.health -= (0.008 + this.map.hp * 0.004) * dt / 1000;
      }
      if (this.mods.auto || this.mods.nofail) this.health = Math.max(this.health, 0.05);

      if (this.health <= 0) { this.finish(true); return; }
      if (this.first >= this.objects.length && t > this.lastT + 1200) this.finish(false);
    }

    finish(failed) {
      if (this.ended) return;
      this.ended = true;
      clearInterval(this.stepper);
      if (failed) {
        const now = this.ctx.currentTime;
        this.gain.gain.setValueAtTime(this.gain.gain.value, now);
        this.gain.gain.linearRampToValueAtTime(0.0001, now + 0.6);
        this.src.stop(now + 0.65);
      } else {
        this.stopSource();
      }
      const accuracy = this.accuracy();
      const errs = this.errors.map(e => e.err);
      this.onEnd({
        failed,
        auto: !!this.mods.auto,
        score: this.score,
        accuracy,
        maxCombo: this.maxCombo,
        counts: { ...this.counts },
        grade: gradeFor(accuracy, failed),
        meanError: errs.length ? errs.reduce((a, b) => a + b, 0) / errs.length : 0,
      });
    }

    // ---------- Rendering ----------

    step() {
      if (this.ended || this.paused) return;
      const t = this.time();
      const dt = this.prevT == null ? 0 : Math.max(0, Math.min(250, t - this.prevT));
      this.prevT = t;
      this.update(t, dt);
    }

    frame() {
      if (this.ended) return;
      this.raf = requestAnimationFrame(this.frame);
      if (this.paused) return;
      this.step();
      if (!this.ended) this.draw(this.time());
    }

    draw(t) {
      const c = this.c, d = this.dpr;
      c.setTransform(d, 0, 0, d, 0, 0);
      this.drawBackground(c, t);
      this.drawPlay(c, t);
      this.drawHud(c, t);
      this.drawOverlay(c);
    }

    drawOverlay() {}

    drawBackground(c, t) {
      const { W, H } = this;
      c.fillStyle = '#09080d';
      c.fillRect(0, 0, W, H);
      if (this.bg) {
        const k = Math.max(W / this.bg.width, H / this.bg.height);
        c.globalAlpha = 0.22;
        c.drawImage(this.bg, (W - this.bg.width * k) / 2, (H - this.bg.height * k) / 2, this.bg.width * k, this.bg.height * k);
        c.globalAlpha = 1;
      }
      const phase = (((t - (this.map.beatZero || 0)) / (this.map.beatMs || 500)) % 1 + 1) % 1;
      const pulse = Math.pow(1 - phase, 3);
      const cx = W / 2, cy = H / 2, base = Math.min(W, H);
      for (let i = 0; i < 4; i++) {
        hexPath(c, cx, cy, base * (0.28 + i * 0.2) * (1 + pulse * 0.012), t / 26000 * (i % 2 ? -1 : 1));
        c.strokeStyle = `rgba(165, 180, 252, ${0.035 + pulse * 0.03})`;
        c.lineWidth = 1.5;
        c.stroke();
      }
    }

    drawFx(c, t) {
      this.fx = this.fx.filter(f => t - f.t0 < 480);
      for (const f of this.fx) {
        const k = (t - f.t0) / 480;
        if (f.kind === 'burst') {
          hexPath(c, f.x, f.y, this.radius * (1 + k * 0.7), Math.PI / 6 + k * 0.5);
          c.globalAlpha = (1 - k) * (1 - k);
          c.strokeStyle = f.color;
          c.lineWidth = 5 * (1 - k) + 1;
          c.stroke();
        } else {
          c.globalAlpha = 1 - k * k;
          c.fillStyle = f.color;
          c.font = '700 19px "Bahnschrift", "DIN Alternate", "Segoe UI", system-ui, sans-serif';
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText(f.text, f.x, f.y - this.radius - 6 - k * 14);
        }
        c.globalAlpha = 1;
      }
    }

    drawHud(c, t) {
      const { W, H } = this;
      const font = (w, px) => `${w} ${px}px "Bahnschrift", "DIN Alternate", "Segoe UI", system-ui, sans-serif`;

      c.fillStyle = 'rgba(255,255,255,0.1)';
      c.fillRect(20, 20, 260, 8);
      const hp = clamp(this.health, 0, 1);
      c.fillStyle = hp < 0.25 ? '#ff4d5e' : '#d8ff3e';
      c.fillRect(20, 20, 260 * hp, 8);

      c.textBaseline = 'top';
      c.textAlign = 'right';
      c.fillStyle = '#f5f7fb';
      c.font = font(600, 32);
      c.fillText(String(this.score).padStart(7, '0'), W - 20, 14);
      c.font = font(500, 18);
      c.fillStyle = '#b8c0d0';
      c.fillText(`${(this.accuracy() * 100).toFixed(2)}%`, W - 20, 52);

      c.textAlign = 'left';
      c.textBaseline = 'bottom';
      c.font = font(700, 44);
      c.fillStyle = '#f5f7fb';
      if (this.combo > 0) c.fillText(`${this.combo}x`, 20, H - 14);

      if (this.hint && t < this.objects[0].t - 200) {
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = font(600, 20);
        c.fillStyle = 'rgba(245,247,251,0.85)';
        c.fillText(this.hint, W / 2, H * 0.62);
      }

      // Timing meter: early hits left of centre, late hits right.
      const mw = 220, mx = W / 2, my = H - 22;
      if (!this.noMeter) {
      c.fillStyle = 'rgba(255,255,255,0.1)';
      c.fillRect(mx - mw / 2, my, mw, 3);
      c.fillStyle = 'rgba(94,234,212,0.5)';
      const pw = mw * this.win.perfect / this.win.ok;
      c.fillRect(mx - pw / 2, my, pw, 3);
      c.fillStyle = '#f5f7fb';
      c.fillRect(mx - 1, my - 7, 2, 17);
      for (let i = this.errors.length - 1; i >= 0 && i >= this.errors.length - 24; i--) {
        const e = this.errors[i], age = t - e.at;
        if (age > 3000) break;
        c.globalAlpha = 1 - age / 3000;
        c.fillStyle = '#ffd479';
        c.fillRect(mx + clamp(e.err / this.win.ok, -1, 1) * mw / 2 - 1, my - 5, 2, 13);
      }
      c.globalAlpha = 1;
      }

      const songEnd = this.lastT || 1;
      c.fillStyle = 'rgba(216,255,62,0.7)';
      c.fillRect(0, H - 3, W * clamp(t / songEnd, 0, 1), 3);

      if (this.canSkip(t)) {
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = font(600, 20);
        c.fillStyle = 'rgba(245,247,251,0.8)';
        c.fillText('Space to skip intro', W / 2, H * 0.72);
      }
    }

  }

  class StandardGame extends Session {
    setup() {
      const m = this.map;
      this.preempt = m.ar < 5 ? 1200 + 600 * (5 - m.ar) / 5 : 1200 - 750 * (m.ar - 5) / 5;
      this.radius = 54.4 - 4.48 * m.cs;
      this.win = { perfect: 80 - 6 * m.od, great: 140 - 8 * m.od, ok: 200 - 10 * m.od };
      this.objects = m.objects.map(o => ({ ...o, done: false, headDone: false, headHit: false, tracked: 0, rot: 0, tracking: false, offFor: 0, broke: false }));
    }

    usesKey(code) { return code === 'KeyZ' || code === 'KeyX'; }

    simulate(t, dt) {
      if (this.mods.auto) this.autoplay(t, dt);
      const holding = this.mods.auto ? this.autoHeld : this.held.size > 0;
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t - this.preempt > t) break;
        if (o.done) continue;
        if (o.type === 'tap') {
          if (t > o.t + this.win.ok) { this.judge(o, 'miss', o.x, o.y); o.done = true; }
        } else if (o.type === 'slider') {
          this.updateSlider(o, t, dt, holding);
        } else {
          this.updateSpin(o, t, holding);
        }
      }
    }

    drawPlay(c, t) {
      c.save();
      c.translate(this.ox, this.oy);
      c.scale(this.s, this.s);
      this.drawObjects(c, t);
      this.drawFx(c, t);
      c.restore();
    }

    drawOverlay(c) { this.drawCursor(c); }

    setCursorScreen(x, y) {
      if (this.mods.auto) return;
      this.cursor.x = (x - this.ox) / this.s;
      this.cursor.y = (y - this.oy) / this.s;
    }

    press(id) {
      if (this.mods.auto || this.paused || this.ended || this.held.has(id)) return;
      this.held.add(id);
      const t = this.time();
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t - this.win.ok > t) break;
        if (o.type === 'spin') continue;
        if (o.type === 'tap' ? o.done : o.headDone) continue;
        if (Math.hypot(this.cursor.x - o.x, this.cursor.y - o.y) > this.radius * 1.05) continue;
        this.hitHead(o, t);
        return;
      }
    }

    hitHead(o, t) {
      const err = t - o.t, abs = Math.abs(err);
      if (abs > this.win.ok) return;
      this.errors.push({ err, at: t });
      if (o.type === 'tap') {
        this.judge(o, abs <= this.win.perfect ? 'perfect' : abs <= this.win.great ? 'great' : 'ok', o.x, o.y);
        o.done = true;
      } else {
        o.headDone = true;
        o.headHit = true;
        this.addCombo();
        this.score += 30;
        this.playHit('great');
        this.fx.push({ kind: 'burst', x: o.x, y: o.y, t0: t, color: COLORS[o.color % 4] });
      }
    }

    updateSlider(o, t, dt, holding) {
      if (!o.headDone && t > o.t + this.win.ok) {
        o.headDone = true;
        this.breakCombo();
        this.health -= 0.03;
        this.fx.push({ kind: 'label', x: o.x, y: o.y, t0: t, text: JUDGE.miss.label, color: JUDGE.miss.color });
      }
      if (this.mods.auto && t >= o.t) {
        // Autoplay follows every slider, including overlapping paths and skipped frames.
        o.tracked = Math.max(0, Math.min(t, o.endT) - o.t);
        o.tracking = t <= o.endT;
        o.offFor = 0;
      } else if (t >= o.t && t <= o.endT) {
        const p = P.sliderPos(o, t);
        const reach = this.radius * (o.tracking ? 2.3 : 1.2);
        o.tracking = holding && Math.hypot(this.cursor.x - p[0], this.cursor.y - p[1]) <= reach;
        if (o.tracking) { o.tracked += dt; o.offFor = 0; }
        else {
          o.offFor += dt;
          if (o.offFor > 200 && !o.broke && t > o.t + 200) { o.broke = true; this.breakCombo(); }
        }
      }
      if (t > o.endT) {
        const span = o.endT - o.t;
        let ratio = span > 0 ? o.tracked / span : 1;
        if (!o.headHit) ratio *= 0.7;
        const kind = ratio >= 0.88 ? 'perfect' : ratio >= 0.6 ? 'great' : ratio >= 0.25 ? 'ok' : 'miss';
        const end = P.sliderPos(o, o.endT);
        this.judge(o, kind, end[0], end[1]);
        o.done = true;
        o.tracking = false;
      }
    }

    updateSpin(o, t, holding) {
      if (this.mods.auto && t >= o.t) {
        // Derive rotation from map time, avoiding angle aliasing during stalls.
        const duration = o.endT - o.t;
        const progress = duration > 0 ? clamp((t - o.t) / duration, 0, 1) : 1;
        o.rot = Math.max(this.spinGoal(o), duration / 1000 * 4) * progress;
      } else if (t >= o.t && t <= o.endT && holding) {
        const a = Math.atan2(this.cursor.y - 192, this.cursor.x - 256);
        if (this.prevAngle != null) {
          let d = a - this.prevAngle;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          o.rot += Math.abs(d) / (Math.PI * 2);
        }
        this.prevAngle = a;
      } else {
        this.prevAngle = null;
      }
      if (t > o.endT) {
        const ratio = o.rot / this.spinGoal(o);
        const kind = ratio >= 1 ? 'perfect' : ratio >= 0.75 ? 'great' : ratio >= 0.4 ? 'ok' : 'miss';
        this.judge(o, kind, 256, 192);
        o.done = true;
        this.prevAngle = null;
      }
    }

    spinGoal(o) { return Math.max(1, (o.endT - o.t) / 1000 * 1.7); }

    autoplay(t, dt) {
      // Settle everything already due first, so a slow frame can't turn into misses.
      let active = null, next = null, hit = null;
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.done) continue;
        if (o.t > t) { next = o; break; }
        if (o.type === 'tap' || (o.type === 'slider' && !o.headDone)) {
          this.hitHead(o, o.t);
          hit = o;
        }
        if (o.type !== 'tap' && t <= o.endT && !active) active = o;
      }

      this.autoHeld = !!(active || hit);
      // The visible cursor is a preview; scoring tracks overlapping objects separately.
      if (hit) {
        this.cursor.x = hit.x; this.cursor.y = hit.y;
        return;
      }
      const o = active;
      if (o) {
        if (o.type === 'spin') {
          const a = t / 1000 * Math.PI * 2 * 4;
          this.cursor.x = 256 + Math.cos(a) * 70;
          this.cursor.y = 192 + Math.sin(a) * 70;
        } else {
          const p = P.sliderPos(o, t);
          this.cursor.x = p[0]; this.cursor.y = p[1];
        }
        return;
      }
      if (!next) return;
      const left = next.t - t;
      if (left > 0 && left < 900) {
        const f = Math.min(1, dt / Math.max(dt, left));
        this.cursor.x += (next.x - this.cursor.x) * f;
        this.cursor.y += (next.y - this.cursor.y) * f;
      }
    }

    drawObjects(c, t) {
      const visible = [];
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t - this.preempt > t) break;
        if (!o.done) visible.push(o);
      }
      this.drawConnectors(c, visible, t);
      for (let i = visible.length - 1; i >= 0; i--) {
        const o = visible[i];
        if (o.type === 'spin') this.drawSpin(c, o, t);
        else if (o.type === 'slider') this.drawSlider(c, o, t);
        else this.drawTarget(c, o, t);
      }
      // Approach rings go last so they are never hidden by later objects.
      for (let i = visible.length - 1; i >= 0; i--) {
        const o = visible[i];
        if (o.type !== 'spin' && t < o.t) this.drawApproach(c, o, t);
      }
    }

    drawConnectors(c, list, t) {
      c.setLineDash([3, 7]);
      c.lineWidth = 2;
      c.strokeStyle = 'rgba(255,255,255,0.22)';
      for (let i = 0; i + 1 < list.length; i++) {
        const a = list[i], b = list[i + 1];
        if (a.color !== b.color || a.type === 'spin' || b.type === 'spin') continue;
        const from = a.type === 'slider' ? P.sliderPos(a, a.endT) : [a.x, a.y];
        const dist = Math.hypot(b.x - from[0], b.y - from[1]);
        if (dist < this.radius * 2.1) continue;
        const ux = (b.x - from[0]) / dist, uy = (b.y - from[1]) / dist, r = this.radius * 1.05;
        c.beginPath();
        c.moveTo(from[0] + ux * r, from[1] + uy * r);
        c.lineTo(b.x - ux * r, b.y - uy * r);
        c.stroke();
      }
      c.setLineDash([]);
    }

    alphaFor(o, t) {
      return clamp((t - (o.t - this.preempt)) / (this.preempt * 0.4), 0, 1);
    }

    drawTarget(c, o, t) {
      const color = COLORS[o.color % 4], r = this.radius;
      c.globalAlpha = this.alphaFor(o, t);
      hexPath(c, o.x, o.y, r, Math.PI / 6);
      c.fillStyle = '#121824';
      c.fill();
      c.strokeStyle = color;
      c.lineWidth = r * 0.14;
      c.lineJoin = 'round';
      c.stroke();
      hexPath(c, o.x, o.y, r * 0.72, Math.PI / 6);
      c.fillStyle = color + '2e';
      c.fill();
      c.fillStyle = '#f5f7fb';
      c.font = `700 ${r * 0.8}px "Bahnschrift", "DIN Alternate", "Segoe UI", system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(String(o.num), o.x, o.y + r * 0.04);
      c.globalAlpha = 1;
    }

    drawApproach(c, o, t) {
      const f = (o.t - t) / this.preempt;
      const color = COLORS[o.color % 4];
      c.globalAlpha = clamp(1.15 - f, 0, 1) * this.alphaFor(o, t);
      // The ring untwists as it closes, landing square with the target on the beat.
      hexPath(c, o.x, o.y, this.radius * (1 + 2.1 * f), Math.PI / 6 + f * Math.PI / 3);
      c.strokeStyle = color;
      c.lineWidth = 3;
      c.lineJoin = 'round';
      c.stroke();
      c.globalAlpha = 1;
    }

    drawSlider(c, o, t) {
      const color = COLORS[o.color % 4], r = this.radius;
      const p2d = pathOf(o);
      c.globalAlpha = this.alphaFor(o, t) * 0.92;
      c.lineCap = 'round'; c.lineJoin = 'round';
      c.strokeStyle = color;
      c.lineWidth = r * 1.86;
      c.stroke(p2d);
      c.strokeStyle = '#121824';
      c.lineWidth = r * 1.62;
      c.stroke(p2d);
      c.strokeStyle = color + '24';
      c.stroke(p2d);

      const span = (o.endT - o.t) / o.slides;
      const end = o.path.pts[o.path.pts.length - 1];
      if (o.slides > 1) {
        const leg = t < o.t ? 0 : Math.floor((t - o.t) / span);
        if (leg < o.slides - 1) {
          const at = leg % 2 === 0 ? end : o.path.pts[0];
          const pop = 1 + 0.12 * Math.sin(t / 90);
          hexPath(c, at[0], at[1], r * 0.42 * pop, 0);
          c.fillStyle = '#f5f7fb';
          c.fill();
        }
      }
      hexPath(c, end[0], end[1], r * 0.62, Math.PI / 6);
      c.strokeStyle = color;
      c.lineWidth = r * 0.08;
      c.stroke();
      c.globalAlpha = 1;

      if (!o.headDone) this.drawTarget(c, o, t);
      if (t >= o.t) {
        const p = P.sliderPos(o, t);
        hexPath(c, p[0], p[1], r * 0.62, t / 200);
        c.fillStyle = color;
        c.fill();
        hexPath(c, p[0], p[1], r * (o.tracking ? 2 : 1.1), t / 300);
        c.strokeStyle = o.tracking ? '#f5f7fb' : 'rgba(245,247,251,0.35)';
        c.lineWidth = 2.5;
        c.stroke();
      }
    }

    drawSpin(c, o, t) {
      const prog = clamp((t - o.t) / (o.endT - o.t), 0, 1);
      const fill = clamp(o.rot / this.spinGoal(o), 0, 1);
      c.globalAlpha = clamp((t - (o.t - this.preempt)) / 300, 0, 1);
      hexPath(c, 256, 192, 172 * (1 - prog) + 18, o.rot * Math.PI * 2);
      c.strokeStyle = '#a5b4fc';
      c.lineWidth = 3;
      c.lineJoin = 'round';
      c.stroke();
      c.beginPath();
      c.arc(256, 192, 186, -Math.PI / 2, -Math.PI / 2 + fill * Math.PI * 2);
      c.strokeStyle = fill >= 1 ? '#5eead4' : '#ffb454';
      c.lineWidth = 7;
      c.lineCap = 'round';
      c.stroke();
      hexPath(c, 256, 192, 26, o.rot * Math.PI * 2);
      c.fillStyle = fill >= 1 ? '#5eead4' : '#ffb454';
      c.fill();
      c.fillStyle = '#f5f7fb';
      c.font = '700 20px "Bahnschrift", "DIN Alternate", "Segoe UI", system-ui, sans-serif';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      if (t < o.t + 1500) c.fillText('Hold and spin', 256, 245);
      c.globalAlpha = 1;
    }

    drawCursor(c) {
      const sx = this.cursor.x * this.s + this.ox, sy = this.cursor.y * this.s + this.oy;
      this.trail.push([sx, sy]);
      if (this.trail.length > 16) this.trail.shift();
      this.trail.forEach((p, i) => {
        const k = i / this.trail.length;
        c.globalAlpha = k * 0.35;
        c.fillStyle = '#ffd479';
        c.beginPath();
        c.arc(p[0], p[1], 2 + k * 5, 0, Math.PI * 2);
        c.fill();
      });
      c.globalAlpha = 1;
      hexPath(c, sx, sy, this.held.size || this.autoHeld ? 11 : 14, Math.PI / 6);
      c.strokeStyle = '#f5f7fb';
      c.lineWidth = 2.5;
      c.stroke();
      c.fillStyle = '#ffd479';
      c.beginPath();
      c.arc(sx, sy, 3, 0, Math.PI * 2);
      c.fill();
    }
  }

  Object.assign(P, { Session, StandardGame, COLORS, hexPath, clamp });
})(globalThis.Pulsar = globalThis.Pulsar || {});
