// The play session: audio clock, input judgement, scoring and canvas rendering.
(function (P) {
  'use strict';

  const COLORS = ['#d8ff3e', '#ff7a66', '#5eead4', '#a5b4fc'];
  const FRAME_INTERVAL = 1000 / 240;
  const REPLAY_LIMIT = 600000;
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
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const [x, y] of o.path.pts) {
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
      }
      o.path.bounds = { minX, minY, maxX, maxY };
      if (o.path.pts.length <= 4096) {
        o.path.pts.forEach((pt, i) => (i === 0 ? p.moveTo(pt[0], pt[1]) : p.lineTo(pt[0], pt[1])));
      } else {
        // Only the artwork is rounded to a quarter playfield pixel. Retraced
        // edges need drawing once; the original timing/movement path stays intact.
        const edges = new Set();
        let previous = null, connected = false;
        for (const pt of o.path.pts) {
          const x = Math.round(pt[0] * 4), y = Math.round(pt[1] * 4);
          const key = x + ',' + y;
          if (previous && previous.key !== key) {
            const edge = previous.key < key ? previous.key + ':' + key : key + ':' + previous.key;
            if (!edges.has(edge)) {
              edges.add(edge);
              if (!connected) p.moveTo(previous.x / 4, previous.y / 4);
              p.lineTo(x / 4, y / 4);
              connected = true;
            } else connected = false;
          }
          previous = { x, y, key };
        }
      }
      o.path.p2d = p;
    }
    return o.path.p2d;
  }

  function circlePath(c, x, y, radius) {
    c.beginPath();
    c.arc(x, y, radius, 0, Math.PI * 2);
  }

  function drawSprite(c, sprite, x, y, diameter) {
    const scale = diameter / Math.max(sprite.width, sprite.height);
    const width = sprite.width * scale, height = sprite.height * scale;
    c.drawImage(sprite, x - width / 2, y - height / 2, width, height);
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
      this.rate = this.mods.rate || 1;
      this.skin = opts.skin || {};
      this.offset = opts.offset || 0;
      this.sfx = opts.sfxGain;
      this.onEnd = opts.onEnd;

      this.opts = opts;
      this.replay = opts.replay || null;
      this.replayIndex = 0;
      this.recording = opts.recordReplay ? [] : null;
      if (opts.frameTime) {
        this.frameTimes = new Float32Array(120);
        this.frameTimeIndex = 0;
        this.frameTimeCount = 0;
      }
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
      this.paused = false;
      this.ended = false;

      this.resize();
      this.frame = this.frame.bind(this);
    }

    resize() {
      const dpr = Math.min(window.devicePixelRatio || 1, this.opts.renderScale || Infinity);
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

    async prepare() {}

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
      this.frame();
    }

    playFrom(when, offsetSec) {
      this.stopSource();
      this.gain = this.ctx.createGain();
      this.gain.connect(P.musicOut);
      this.src = this.ctx.createBufferSource();
      this.src.buffer = this.buffer;
      this.src.playbackRate.value = this.rate;
      this.src.connect(this.gain);
      this.src.start(when, offsetSec);
      this.startAt = when - offsetSec / this.rate;
    }

    stopSource() {
      if (!this.src) return;
      try { this.src.stop(); } catch (e) { /* already ended */ }
      this.src.disconnect();
      this.gain.disconnect();
      this.src = null;
    }

    time() {
      return this.inputTime ?? this.clockTime();
    }

    clockTime() {
      return ((this.ctx.currentTime - this.startAt) * 1000 - this.offset - (this.latency || 0)) * this.rate;
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
      this.stopFrameLoop();
      this.ctx.suspend();
    }

    resume() {
      if (!this.paused || this.ended) return;
      this.paused = false;
      if (!this.replay) this.prevT = null;
      this.fpsSampleStart = null;
      this.fpsLabel = null;
      this.nextFrameAt = null;
      this.previousFrameStart = null;
      this.frameTimeIndex = 0;
      this.frameTimeCount = 0;
      this.ctx.resume();
      this.frame();
    }

    destroy() {
      this.ended = true;
      this.stopFrameLoop();
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

    record(entry) {
      if (this.recording.length < REPLAY_LIMIT) this.recording.push(entry);
      else this.recording = null;
    }

    input(action, ...args) {
      if (this.replay || (this.paused && action !== 'clear' && action !== 'move')) return;
      if (this.mods.auto && action !== 'skip' && action !== 'clear') return;
      const time = this.time();
      if (this.recording) {
        let event = [time, action, ...args];
        if (action === 'move') {
          if (!this.map.mode || (this.map.mode === 2 && this.touchId != null)) {
            const [x, y] = args;
            event = [time, action, (x - this.ox) / this.s, (y - this.oy) / this.s];
            // Simulation and presses only observe the most recent consecutive move.
            if (this.recording.at(-1)?.[1] === 'move') this.recording.pop();
          } else event = null;
        } else if (action === 'pointer') {
          const [e, id] = args;
          const g = this.map.mode === 3 ? this.geom() : null;
          const x = g ? clamp(Math.floor((e.clientX - g.x0) / g.cw), 0, this.keys - 1) + 0.5
            : this.map.mode === 1 ? e.clientX / this.W : (e.clientX - this.ox) / this.s;
          event = [time, action, id, x, (e.clientY - this.oy) / this.s, e.button, e.pointerType];
        }
        if (event) this.record(event);
      }
      this.inputTime = time;
      try {
        if (action === 'move') this.setCursorScreen(...args);
        if (action === 'pointer') this.pointerPress(...args);
        if (action === 'press') this.press(...args);
        if (action === 'release') this.release(...args);
        if (action === 'clear') this.releaseAll();
        if (action === 'skip') this.skip();
      } finally {
        this.inputTime = null;
      }
    }

    replayStep() {
      const entries = this.replay.events;
      let now = this.clockTime();
      // Bound catch-up work after a stalled or backgrounded tab.
      const end = Math.min(entries.length, this.replayIndex + 600);
      while (!this.ended && this.replayIndex < end) {
        const entry = entries[this.replayIndex];
        const t = typeof entry === 'number' ? entry : entry[0];
        if (t > now) break;
        this.replayIndex++;
        this.inputTime = t;
        try {
          if (typeof entry === 'number') {
            this.simulateFrame(t);
            continue;
          }
          const [, action, a, b, y, button, pointerType] = entry;
          if (action === 'move') this.setCursorScreen(this.ox + a * this.s, this.oy + b * this.s);
          if (action === 'press') this.press(a);
          if (action === 'release') this.release(a);
          if (action === 'clear') { this.releaseAll(); this.prevT = null; }
          if (action === 'skip') { this.skip(); now = this.clockTime(); }
          if (action === 'pointer') {
            const g = this.map.mode === 3 ? this.geom() : null;
            const clientX = g ? g.x0 + b * g.cw : this.map.mode === 1 ? b * this.W : this.ox + b * this.s;
            this.pointerPress({ clientX, clientY: this.oy + y * this.s, button, pointerType }, a);
          }
        } finally {
          this.inputTime = null;
        }
      }
      if (!this.ended && this.replayIndex === entries.length) this.finish(this.replay.failed);
    }

    // ---------- Scoring ----------

    addCombo() {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
    }

    breakCombo() { this.combo = 0; }

    addFx(effect) {
      const limit = this.autoLowDetail ? 16 : 64;
      if (this.mods.auto && this.fx.length >= limit) return;
      this.fx.push(effect);
    }

    judge(o, kind, x, y) {
      const j = JUDGE[kind];
      const t = this.time();
      this.counts[kind]++;
      if ((this.mods.suddenDeath && kind === 'miss') || (this.mods.perfect && kind !== 'perfect')) this.modFailed = true;
      if (kind === 'miss') {
        this.breakCombo();
        this.health -= 0.05 + this.map.hp * 0.012;
      } else {
        this.addCombo();
        this.score += Math.round(j.value * (1 + Math.min(this.combo, 400) * 0.02));
        this.health = Math.min(1, this.health + j.heal);
        this.addFx({ kind: 'burst', x, y, t0: t, color: COLORS[(o.color || 0) % 4] });
        this.playHit(kind);
      }
      if (this.quietHits && kind !== 'miss') return;
      if (this.singleLabel) this.fx = this.fx.filter(f => f.kind !== 'label');
      this.addFx({ kind: 'label', x, y, t0: t, text: j.label, color: j.color });
    }

    accuracy() {
      const c = this.counts;
      const n = c.perfect + c.great + c.ok + c.miss;
      return n ? (c.perfect * 300 + c.great * 100 + c.ok * 50) / (n * 300) : 1;
    }

    playHit(kind) {
      if (!this.sfx) return;
      const now = this.ctx.currentTime;
      if (this.mods.auto && now - (this.lastHitSound ?? -Infinity) < 0.02) return;
      this.lastHitSound = now;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.35, now);
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = kind === 'perfect' ? 1320 : kind === 'great' ? 990 : 740;
      o.connect(g); g.connect(this.sfx);
      o.onended = () => { o.disconnect(); g.disconnect(); };
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

      if (this.modFailed || this.health <= 0) { this.finish(true); return; }
      if (this.first >= this.objects.length && t > this.lastT + 1200) this.finish(false);
    }

    finish(failed) {
      if (this.ended) return;
      this.ended = true;
      this.stopFrameLoop();
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

    stopFrameLoop() {
      clearTimeout(this.frameTimer);
      if (this.frameChannel) {
        this.frameChannel.port1.close();
        this.frameChannel.port2.close();
        this.frameChannel = null;
      }
    }

    scheduleFrame(delay) {
      if (!this.frameChannel) {
        this.frameChannel = new MessageChannel();
        this.frameChannel.port1.onmessage = this.frame;
      }
      const { port2 } = this.frameChannel;
      // Dispatch drawing as a message task so consecutive frames don't inherit
      // the browser's minimum delay for deeply nested timers.
      this.frameTimer = setTimeout(() => port2.postMessage(null), Math.max(0, Math.round(delay)));
    }

    step() {
      if (this.ended || this.paused) return;
      if (this.replay) { this.replayStep(); return; }
      const t = this.time();
      if (this.recording) this.record(t);
      this.simulateFrame(t);
    }

    simulateFrame(t) {
      const dt = this.prevT == null ? 0 : Math.max(0, Math.min(250, t - this.prevT));
      this.prevT = t;
      this.update(t, dt);
    }

    frame() {
      if (this.ended || this.paused) return;
      const now = performance.now();
      this.step();
      if (this.ended) return;
      if (this.frameTimes) {
        if (this.previousFrameStart != null) {
          this.frameTimes[this.frameTimeIndex] = now - this.previousFrameStart;
          this.frameTimeIndex = (this.frameTimeIndex + 1) % this.frameTimes.length;
          this.frameTimeCount = Math.min(this.frameTimeCount + 1, this.frameTimes.length);
        }
        this.previousFrameStart = now;
      }
      if (this.fpsSampleStart == null) {
        this.fpsSampleStart = now;
        this.fpsFrames = 0;
      } else {
        this.fpsFrames++;
        const elapsed = now - this.fpsSampleStart;
        if (elapsed >= 500) {
          this.fpsLabel = `${Math.round(this.fpsFrames * 1000 / elapsed)} FPS`;
          this.fpsSampleStart = now;
          this.fpsFrames = 0;
        }
      }
      this.draw(this.time());
      const afterDraw = performance.now();
      if (this.mods.auto) {
        this.frameCost = (this.frameCost ?? 0) * 0.9 + (afterDraw - now) * 0.1;
        if (this.frameCost > FRAME_INTERVAL * 0.85) {
          this.autoLowDetail = true;
          this.detailRecoveryAt = afterDraw + 1500;
        } else if (this.frameCost < FRAME_INTERVAL * 0.55 && afterDraw > (this.detailRecoveryAt || 0)) {
          this.autoLowDetail = false;
        }
      }
      let deadline = (this.nextFrameAt ?? now) + FRAME_INTERVAL;
      // Skip missed deadlines instead of trying to render a burst of old frames.
      if (deadline <= afterDraw) {
        deadline += (Math.floor((afterDraw - deadline) / FRAME_INTERVAL) + 1) * FRAME_INTERVAL;
      }
      this.nextFrameAt = deadline;
      this.scheduleFrame(deadline - afterDraw);
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
      if (this.autoLowDetail || this.opts.renderScale < 1) return;
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
      let remaining = 0;
      for (const effect of this.fx) {
        if (t - effect.t0 < 480) this.fx[remaining++] = effect;
      }
      this.fx.length = remaining;
      for (const f of this.fx) {
        const k = (t - f.t0) / 480;
        if (f.kind === 'burst') {
          circlePath(c, f.x, f.y, this.radius * (1 + k * 0.7));
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

    drawFrameTimes(c) {
      const samples = this.frameTimes;
      const count = this.frameTimeCount;
      const right = this.W - 20;
      const left = right - samples.length;
      const bottom = 144;
      const height = 34;
      const scale = height / 20;
      let peak = 0;

      c.fillStyle = 'rgba(10,12,18,0.8)';
      c.fillRect(left - 6, bottom - height - 20, samples.length + 12, height + 24);
      c.beginPath();
      for (let i = 0; i < count; i++) {
        const ms = samples[(this.frameTimeIndex - count + i + samples.length) % samples.length];
        const bar = Math.min(height, ms * scale);
        c.rect(right - count + i, bottom - bar, 1, bar);
        peak = Math.max(peak, ms);
      }
      c.fillStyle = '#5eead4';
      c.fill();
      c.fillStyle = '#ffd479';
      c.fillRect(left, bottom - FRAME_INTERVAL * scale, samples.length, 1);
      c.fillStyle = '#f5f7fb';
      c.fillText(count ? `Peak ${peak.toFixed(1)} ms` : 'Frame time', right, bottom - height - 15);
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
      c.font = font(500, 13);
      c.fillText(this.fpsLabel || '— FPS', W - 20, 76);
      if (this.frameTimes) this.drawFrameTimes(c);
      if (this.replay) {
        c.textAlign = 'left';
        c.fillText('Replay', 20, 34);
      }

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

      if (!this.replay && this.canSkip(t)) {
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.font = font(600, 20);
        c.fillStyle = 'rgba(245,247,251,0.8)';
        c.fillText('Space to skip intro', W / 2, H * 0.72);
      }
    }

  }

  class StandardGame extends Session {
    async prepare(isCurrent = () => true) {
      // Build dense slider geometry while the loading screen is still visible.
      let batchStart = performance.now();
      for (const o of this.objects) {
        if (o.type === 'slider') {
          pathOf(o);
          if (o.path.pts.length >= 256) {
            const colors = this.skin.colors || COLORS;
            this.drawSliderBody({ drawImage() {} }, o, colors[o.color % colors.length], this.radius);
          }
        }
        if (performance.now() - batchStart > 8) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (!isCurrent()) return;
          batchStart = performance.now();
        }
      }
    }

    resize() {
      super.resize();
      this.clearSliderCache();
      this.sliderCache = new Map();
      this.sliderCacheBytes = 0;
    }

    clearSliderCache() {
      if (!this.sliderCache) return;
      for (const { bitmap } of this.sliderCache.values()) bitmap.width = bitmap.height = 0;
      this.sliderCache.clear();
      this.sliderCacheBytes = 0;
    }

    destroy() {
      this.clearSliderCache();
      super.destroy();
    }

    finish(failed) {
      this.clearSliderCache();
      super.finish(failed);
    }

    setup() {
      const m = this.map;
      this.preempt = m.ar < 5 ? 1200 + 600 * (5 - m.ar) / 5 : 1200 - 750 * (m.ar - 5) / 5;
      this.radius = 54.4 - 4.48 * m.cs;
      this.win = { perfect: 80 - 6 * m.od, great: 140 - 8 * m.od, ok: 200 - 10 * m.od };
      this.objects = m.objects.map(o => ({ ...o, done: false, headDone: false, headHit: false, tracked: 0, rot: 0, tracking: false, offFor: 0, broke: false }));
      this.autoIndex = 0;
      this.autoActive = [];
    }

    usesKey(code) { return code === 'KeyZ' || code === 'KeyX'; }

    simulate(t, dt) {
      if (this.mods.auto) { this.autoplay(t, dt); return; }
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
      if (this.mods.flashlight) {
        const { x, y } = this.cursor;
        const radius = this.combo >= 200 ? 75 : this.combo >= 100 ? 95 : 120;
        const light = c.createRadialGradient(x, y, radius * 0.72, x, y, radius);
        light.addColorStop(0, 'transparent'); light.addColorStop(1, '#08070c');
        c.fillStyle = light;
        c.fillRect(-this.ox / this.s, -this.oy / this.s, this.W / this.s, this.H / this.s);
      }
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
      let inPattern = false, canResumeTracking = false;
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t - this.win.ok > t) {
          const previous = this.objects[i - 1];
          const end = previous?.endT ?? previous?.t;
          // A short gap within a pattern isn't a rest.
          inPattern ||= end != null && t >= end && o.t - end <= 500;
          break;
        }
        if (o.type === 'spin') {
          if (!o.done && t >= o.t && t <= o.endT) {
            inPattern = true;
            canResumeTracking ||= this.held.size === 1;
          }
          continue;
        }
        if (o.type === 'slider' && o.headDone && !o.done && t >= o.t && t <= o.endT) {
          inPattern = true;
          const [x, y] = P.sliderPos(o, t);
          canResumeTracking ||= this.held.size === 1 && Math.hypot(this.cursor.x - x, this.cursor.y - y) <= this.radius * 1.2;
        }
        if (o.type === 'tap' ? o.done : o.headDone) continue;
        if (t > o.t + this.win.ok) continue;
        inPattern = true;
        if (Math.hypot(this.cursor.x - o.x, this.cursor.y - o.y) > this.radius * 1.05) continue;
        this.hitHead(o, t);
        return;
      }
      if (!canResumeTracking && (inPattern || t < (this.lastHeadAt ?? -Infinity) + this.win.ok)) {
        this.judge({ color: 0 }, 'miss', this.cursor.x, this.cursor.y);
      }
    }

    hitHead(o, t) {
      const err = t - o.t, abs = Math.abs(err);
      if (abs > this.win.ok) return;
      this.lastHeadAt = t;
      this.errors.push({ err, at: t });
      if (this.mods.auto && this.errors.length > 24) this.errors.shift();
      if (o.type === 'tap') {
        this.judge(o, abs <= this.win.perfect ? 'perfect' : abs <= this.win.great ? 'great' : 'ok', o.x, o.y);
        o.done = true;
      } else {
        o.headDone = true;
        o.headHit = true;
        this.addCombo();
        this.score += 30;
        this.playHit('great');
        this.addFx({ kind: 'burst', x: o.x, y: o.y, t0: t, color: COLORS[o.color % 4] });
      }
    }

    updateSlider(o, t, dt, holding) {
      if (!o.headDone && t > o.t + this.win.ok) {
        o.headDone = true;
        this.breakCombo();
        this.health -= 0.03;
        this.addFx({ kind: 'label', x: o.x, y: o.y, t0: t, text: JUDGE.miss.label, color: JUDGE.miss.color });
      }
      if (this.mods.auto && t >= o.t) {
        // Autoplay follows every slider, including overlapping paths and skipped frames.
        o.tracked = Math.max(0, Math.min(t, o.endT) - o.t);
        o.tracking = t <= o.endT;
        o.offFor = 0;
      } else if (t >= o.t && t <= o.endT) {
        const elapsed = Math.min(dt, t - o.t);
        const p = P.sliderPos(o, t);
        const reach = this.radius * (o.tracking ? 2.3 : 1.2);
        o.tracking = holding && Math.hypot(this.cursor.x - p[0], this.cursor.y - p[1]) <= reach;
        if (o.tracking) { o.tracked += elapsed; o.offFor = 0; }
        else {
          o.offFor += elapsed;
          if (o.offFor > 200 && !o.broke && t > o.t + 200) { o.broke = true; this.breakCombo(); }
        }
      }
      if (t > o.endT) {
        if (!this.mods.auto && holding && o.tracking) {
          o.tracked += Math.max(0, o.endT - Math.max(o.t, t - dt));
        }
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
      if ((this.mods.auto || this.mods.spunOut) && t >= o.t) {
        // Derive rotation from map time, avoiding angle aliasing during stalls.
        const duration = o.endT - o.t;
        const progress = duration > 0 ? clamp((t - o.t) / duration, 0, 1) : 1;
        o.rot = Math.max(this.spinGoal(o), duration / 1000 * 4) * progress;
      } else if (t >= o.t && t <= o.endT && holding) {
        const a = Math.atan2(this.cursor.y - 192, this.cursor.x - 256);
        if (o.prevAngle != null) {
          let d = a - o.prevAngle;
          while (d > Math.PI) d -= Math.PI * 2;
          while (d < -Math.PI) d += Math.PI * 2;
          o.rot += Math.abs(d) / (Math.PI * 2);
        }
        o.prevAngle = a;
      } else {
        o.prevAngle = null;
      }
      if (t > o.endT) {
        const ratio = o.rot / this.spinGoal(o);
        const kind = ratio >= 1 ? 'perfect' : ratio >= 0.75 ? 'great' : ratio >= 0.4 ? 'ok' : 'miss';
        this.judge(o, kind, 256, 192);
        o.done = true;
        o.prevAngle = null;
      }
    }

    spinGoal(o) { return Math.max(1, (o.endT - o.t) / 1000 * 1.7); }

    autoplay(t, dt) {
      // Settle everything already due first, so a slow frame can't turn into misses.
      let active = null, next = null, hit = null;
      while (this.autoIndex < this.objects.length && this.objects[this.autoIndex].t <= t) {
        const o = this.objects[this.autoIndex++];
        if (o.type === 'tap' || (o.type === 'slider' && !o.headDone)) {
          this.hitHead(o, o.t);
          hit = o;
        }
        if (o.type !== 'tap') this.autoActive.push(o);
      }
      let remaining = 0;
      for (const o of this.autoActive) {
        if (o.type === 'slider') this.updateSlider(o, t, dt, true);
        else this.updateSpin(o, t, true);
        if (!o.done) {
          this.autoActive[remaining++] = o;
          if (!active) active = o;
        }
      }
      this.autoActive.length = remaining;
      next = this.objects[this.autoIndex];

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
      const visible = this.visibleObjects || (this.visibleObjects = []);
      visible.length = 0;
      const limit = this.mods.auto ? (this.autoLowDetail ? 32 : 128) : Infinity;
      if (this.mods.auto) {
        for (const o of this.autoActive) {
          if (visible.length >= limit) break;
          visible.push(o);
        }
      }
      const start = this.mods.auto ? this.autoIndex : this.first;
      for (let i = start; i < this.objects.length && visible.length < limit; i++) {
        const o = this.objects[i];
        if (o.t - this.preempt > t) break;
        if (!o.done) visible.push(o);
      }
      if (!this.autoLowDetail && !(this.opts.renderScale < 1)) this.drawConnectors(c, visible, t);
      for (let i = visible.length - 1; i >= 0; i--) {
        const o = visible[i];
        if (o.type === 'spin') this.drawSpin(c, o, t);
        else if (o.type === 'slider') this.drawSlider(c, o, t);
        else this.drawTarget(c, o, t);
      }
      // Approach rings go last so they are never hidden by later objects.
      for (let i = visible.length - 1; i >= 0; i--) {
        const o = visible[i];
        if (!this.mods.hidden && o.type !== 'spin' && t < o.t) this.drawApproach(c, o, t);
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
      const fade = clamp((t - (o.t - this.preempt)) / (this.preempt * 0.4), 0, 1);
      return this.mods.hidden ? fade * clamp((o.t - t) / (this.preempt * 0.3) - 0.5, 0, 1) : fade;
    }

    drawTarget(c, o, t) {
      const colors = this.skin.colors || COLORS;
      const index = o.color % colors.length, color = colors[index], r = this.radius;
      const sliderStart = o.type === 'slider' && this.skin.sliderStart;
      const sprite = sliderStart || this.skin.hitcircle || this.skin.circles?.[index];
      const overlay = sliderStart ? this.skin.sliderStartOverlay : this.skin.overlay;
      c.globalAlpha = this.alphaFor(o, t);
      if (sprite) {
        drawSprite(c, sprite, o.x, o.y, 2 * r);
      } else {
        circlePath(c, o.x, o.y, r * 0.94);
        c.fillStyle = color + '88';
        c.fill();
        c.strokeStyle = '#f5f7fb';
        c.lineWidth = r * 0.08;
        c.stroke();
      }
      if (overlay) drawSprite(c, overlay, o.x, o.y, 2 * r);
      c.fillStyle = '#f5f7fb';
      c.font = `700 ${r * 0.8}px "Bahnschrift", "DIN Alternate", "Segoe UI", system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.strokeStyle = '#161326';
      c.lineWidth = r * 0.06;
      c.lineJoin = 'round';
      c.strokeText(String(o.num), o.x, o.y + r * 0.04);
      c.fillText(String(o.num), o.x, o.y + r * 0.04);
      c.globalAlpha = 1;
    }

    drawApproach(c, o, t) {
      const f = (o.t - t) / this.preempt;
      const colors = this.skin.colors || COLORS;
      const radius = this.radius * (0.96 + 2.1 * f);
      c.globalAlpha = clamp(1.15 - f, 0, 1) * this.alphaFor(o, t);
      if (this.skin.approach) {
        drawSprite(c, this.skin.approach, o.x, o.y, 2 * radius);
      } else {
        circlePath(c, o.x, o.y, radius);
        c.strokeStyle = colors[o.color % colors.length];
        c.lineWidth = Math.max(1.5, this.radius * 0.065);
        c.stroke();
      }
      c.globalAlpha = 1;
    }

    drawSlider(c, o, t) {
      const colors = this.skin.colors || COLORS;
      const color = colors[o.color % colors.length], r = this.radius;
      c.globalAlpha = this.alphaFor(o, t) * 0.92;
      this.drawSliderBody(c, o, color, r);

      const span = (o.endT - o.t) / o.slides;
      const points = o.path.pts;
      const end = points[points.length - 1];
      const endSprite = this.skin.sliderEnd || this.skin.hitcircle;
      const endOverlay = this.skin.sliderEnd ? this.skin.sliderEndOverlay : this.skin.overlay;
      if (endSprite) drawSprite(c, endSprite, end[0], end[1], 2 * r);
      else {
        circlePath(c, end[0], end[1], r * 0.65);
        c.strokeStyle = color;
        c.lineWidth = r * 0.08;
        c.stroke();
      }
      if (endOverlay) drawSprite(c, endOverlay, end[0], end[1], 2 * r);
      if (!o.headDone) this.drawTarget(c, o, t);
      c.globalAlpha = this.alphaFor(o, t) * 0.92;
      if (o.slides > 1) {
        const leg = t < o.t ? 0 : Math.floor((t - o.t) / span);
        if (leg < o.slides - 1) {
          const forwards = leg % 2 === 0;
          const at = forwards ? end : points[0];
          const toward = (forwards ? points[points.length - 2] : points[1]) || at;
          c.save();
          c.translate(at[0], at[1]);
          c.rotate(Math.atan2(toward[1] - at[1], toward[0] - at[0]));
          if (this.skin.reverseArrow) drawSprite(c, this.skin.reverseArrow, 0, 0, r * 1.25);
          else {
            c.beginPath();
            c.moveTo(-r * 0.2, -r * 0.3); c.lineTo(r * 0.25, 0); c.lineTo(-r * 0.2, r * 0.3);
            c.strokeStyle = '#f5f7fb'; c.lineWidth = r * 0.11; c.lineJoin = 'round'; c.stroke();
          }
          c.restore();
        }
      }
      c.globalAlpha = 1;

      if (t >= o.t) {
        const p = P.sliderPos(o, t);
        const elapsed = (t - o.t) / 1000;
        const ballFrames = this.skin.sliderBallFrames;
        const ball = ballFrames?.length ? ballFrames[Math.floor(elapsed * 60) % ballFrames.length] : null;
        if (ball) drawSprite(c, ball, p[0], p[1], r * 1.75);
        else {
          circlePath(c, p[0], p[1], r * 0.58);
          c.fillStyle = color; c.fill();
          c.strokeStyle = '#f5f7fb'; c.lineWidth = r * 0.07; c.stroke();
        }
        const followFrames = this.skin.followCircleFrames;
        const follow = followFrames?.length
          ? followFrames[Math.floor(elapsed * (this.skin.animationFps || followFrames.length)) % followFrames.length]
          : null;
        if (o.tracking && follow) drawSprite(c, follow, p[0], p[1], r * 4);
        else if (o.tracking) {
          circlePath(c, p[0], p[1], r * 2);
          c.strokeStyle = '#f5f7fb9c'; c.lineWidth = 2; c.stroke();
        }
      }
    }

    drawSliderBody(c, o, color, r) {
      // During overload, retain the moving ball and endpoints without building
      // more expensive track bitmaps. Existing cached artwork remains usable.
      if (this.autoLowDetail && !this.sliderCache.has(o)) return;
      const stroke = target => {
        const path = pathOf(o);
        target.lineCap = 'round'; target.lineJoin = 'round';
        target.strokeStyle = this.skin.sliderBorder || color; target.lineWidth = r * 1.86; target.stroke(path);
        target.strokeStyle = '#121824'; target.lineWidth = r * 1.62; target.stroke(path);
        target.strokeStyle = this.skin.sliderTrack || color + '24'; target.stroke(path);
      };
      // Simple curves are cheap; complex slider bodies are static artwork.
      if (o.path.pts.length < 256) { stroke(c); return; }
      let entry = this.sliderCache.get(o);
      if (!entry) {
        const scale = Math.min(this.s * this.dpr, 2);
        pathOf(o);
        const bounds = o.path.bounds;
        const padding = r + 2;
        const x = Math.max(-this.ox / this.s, bounds.minX - padding);
        const y = Math.max(-this.oy / this.s, bounds.minY - padding);
        const right = Math.min((this.W - this.ox) / this.s, bounds.maxX + padding);
        const bottom = Math.min((this.H - this.oy) / this.s, bounds.maxY + padding);
        const w = right - x, h = bottom - y;
        if (w <= 0 || h <= 0) return;
        const bitmap = document.createElement('canvas');
        bitmap.width = Math.ceil(w * scale); bitmap.height = Math.ceil(h * scale);
        const bytes = bitmap.width * bitmap.height * 4;
        const limit = 32 * 1024 * 1024;
        while (this.sliderCacheBytes + bytes > limit && this.sliderCache.size) {
          const oldest = this.sliderCache.keys().next().value;
          const removed = this.sliderCache.get(oldest);
          this.sliderCacheBytes -= removed.bytes;
          removed.bitmap.width = removed.bitmap.height = 0;
          this.sliderCache.delete(oldest);
        }
        const target = bitmap.getContext('2d');
        target.setTransform(scale, 0, 0, scale, -x * scale, -y * scale);
        stroke(target);
        entry = { bitmap, bytes, x, y, w: bitmap.width / scale, h: bitmap.height / scale };
        this.sliderCache.set(o, entry);
        this.sliderCacheBytes += bytes;
      } else {
        // Touch the entry so memory pressure evicts the least recently drawn body.
        this.sliderCache.delete(o); this.sliderCache.set(o, entry);
      }
      c.drawImage(entry.bitmap, entry.x, entry.y, entry.w, entry.h);
    }

    drawSpin(c, o, t) {
      const prog = clamp((t - o.t) / (o.endT - o.t), 0, 1);
      const fill = clamp(o.rot / this.spinGoal(o), 0, 1);
      c.globalAlpha = clamp((t - (o.t - this.preempt)) / 300, 0, 1);
      circlePath(c, 256, 192, 172 * (1 - prog) + 18);
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
      circlePath(c, 256, 192, 26);
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
      const cursorSize = this.held.size || this.autoHeld ? 22 : 28;
      if (this.skin.cursor) {
        drawSprite(c, this.skin.cursor, sx, sy, cursorSize);
        return;
      }
      circlePath(c, sx, sy, cursorSize / 2);
      c.strokeStyle = '#f5f7fb';
      c.lineWidth = 2.5;
      c.stroke();
      c.fillStyle = this.skin.accent || '#ffd479';
      c.beginPath();
      c.arc(sx, sy, 3, 0, Math.PI * 2);
      c.fill();
    }
  }

  Object.assign(P, { Session, StandardGame, COLORS, hexPath, clamp });
})(globalThis.Pulsar = globalThis.Pulsar || {});
