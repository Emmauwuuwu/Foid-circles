// The other three map types: drum lane (taiko), falling catch, and column keys (mania).
(function (P) {
  'use strict';

  const { Session, StandardGame, COLORS, hexPath, clamp } = P;
  const FONT = P.FONT;

  // ---------- Taiko: notes scroll into a fixed zone; hit them with the right drum ----------

  const DON = '#ff7a66', KAT = '#5eead4', ROLL = '#ffd479', SWELL = '#a5b4fc';

  class TaikoGame extends Session {
    setup() {
      const m = this.map, od = m.od;
      const good = od <= 5 ? 120 - 8 * od : 80 - 6 * (od - 5);
      this.win = { perfect: 50 - 3 * od, great: good, ok: good };
      this.earlyMiss = od <= 5 ? 135 - 8 * od : 95 - 5 * (od - 5);
      this.refBeat = m.beatMs > 0 ? m.beatMs : 500;
      this.baseTime = clamp(this.refBeat * 4, 700, 2600);
      this.preempt = this.baseTime;
      this.radius = 34;
      this.singleLabel = true;
      this.hint = 'F J center · D K rim';
      this.flash = { don: -1e9, kat: -1e9 };
      this.objects = m.objects.map(o => {
        const factor = clamp((o.sv || 1) * this.refBeat / (o.beat || this.refBeat), 0.3, 3);
        const base = { t: o.t, endT: o.endT, factor, done: false, big: !!(o.hitSound & 4), color: 0 };
        if (o.type === 'tap') return { ...base, kind: 'hit', kat: (o.hitSound & 10) !== 0 };
        if (o.type === 'spin') {
          return { ...base, kind: 'swell', count: 0, need: Math.max(1, Math.round((o.endT - o.t) / 1000 * 5)) };
        }
        return { ...base, kind: 'roll', nextTick: o.t };
      });
    }

    usesKey(code) { return ['KeyD', 'KeyF', 'KeyJ', 'KeyK'].includes(code); }

    press(id) {
      if (this.mods.auto || this.paused || this.ended || this.held.has(id)) return;
      this.held.add(id);
      this.drum(id === 'KeyD' || id === 'KeyK', this.time());
    }

    pointerPress(e, id) {
      if (this.mods.auto || this.paused || this.ended || this.held.has(id)) return;
      this.held.add(id);
      // Right click is the rim; on touch screens the right half of the screen is.
      const rim = e.pointerType === 'touch' ? e.clientX > this.W / 2 : e.button === 2;
      this.drum(rim, this.time());
    }

    drum(kat, t) {
      this.flash[kat ? 'kat' : 'don'] = t;
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.done) continue;
        if (o.kind === 'hit') {
          const err = t - o.t;
          if (err < -this.earlyMiss) return;
          this.resolve(o, kat, err, t);
          return;
        }
        if (t < o.t || t > o.endT) return;
        if (o.kind === 'roll') this.score += 30;
        else { o.count++; this.score += 20; }
        return;
      }
    }

    resolve(o, kat, err, t) {
      const abs = Math.abs(err);
      o.done = true;
      const { x, y } = this.zone();
      if (abs > this.win.ok || kat !== o.kat) { this.judge(o, 'miss', x, y); return; }
      this.errors.push({ err, at: t });
      this.judge(o, abs <= this.win.perfect ? 'perfect' : 'great', x, y);
    }

    simulate(t) {
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t - 300 > t) break;
        if (o.done) continue;
        if (o.kind === 'hit') {
          if (this.mods.auto && t >= o.t) { this.flash[o.kat ? 'kat' : 'don'] = t; this.resolve(o, o.kat, 0, t); }
          else if (t > o.t + this.win.ok) {
            o.done = true;
            const { x, y } = this.zone();
            this.judge(o, 'miss', x, y);
          }
        } else if (o.kind === 'roll') {
          if (this.mods.auto && t >= o.nextTick && t <= o.endT) {
            o.nextTick = t + this.refBeat / 4;
            this.flash.don = t;
            this.score += 30;
          }
          if (t > o.endT) o.done = true;
        } else if (t > o.endT) {
          if (this.mods.auto) o.count = o.need;
          const ratio = o.count / o.need;
          const { x, y } = this.zone();
          this.judge(o, ratio >= 1 ? 'perfect' : ratio >= 0.5 ? 'ok' : 'miss', x, y);
          o.done = true;
        }
      }
    }

    zone() {
      return { x: clamp(this.W * 0.18, 80, 260), y: this.H * 0.36 };
    }

    laneX(o, time, t) {
      const { x } = this.zone();
      return x + (time - t) * (this.W - x) / this.baseTime * o.factor;
    }

    drawPlay(c, t) {
      const { W } = this;
      const { x: hitX, y } = this.zone();
      const h = 124;
      c.fillStyle = 'rgba(16,15,22,0.92)';
      c.fillRect(0, y - h / 2, W, h);
      c.fillStyle = 'rgba(165,180,252,0.25)';
      c.fillRect(0, y - h / 2 - 2, W, 2);
      c.fillRect(0, y + h / 2, W, 2);

      const glow = (color, since) => {
        const k = 1 - (t - since) / 140;
        if (k <= 0) return;
        c.globalAlpha = k * 0.75;
        hexPath(c, hitX, y, this.radius * 1.2, 0);
        c.fillStyle = color;
        c.fill();
        c.globalAlpha = 1;
      };
      glow(DON, this.flash.don);
      glow(KAT, this.flash.kat);
      hexPath(c, hitX, y, this.radius * 1.2, 0);
      c.strokeStyle = '#f5f7fb';
      c.lineWidth = 3;
      c.stroke();

      const list = [];
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t - t > this.baseTime * 3.5) break;
        if (!o.done) list.push(o);
      }
      for (let i = list.length - 1; i >= 0; i--) this.drawNote(c, list[i], t, y);
      this.drawFx(c, t);
    }

    drawNote(c, o, t, y) {
      const x = this.laneX(o, o.t, t);
      if (o.kind !== 'hit' && o.kind !== 'roll') {
        // A swell pins itself to the zone while active and shows the hits remaining.
        const { x: hitX } = this.zone();
        const at = t >= o.t ? hitX : x;
        if (at > this.W + 60) return;
        hexPath(c, at, y, this.radius * 1.25, t >= o.t ? t / 180 : 0);
        c.fillStyle = SWELL;
        c.fill();
        c.fillStyle = '#09080d';
        c.font = `700 24px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(Math.max(0, o.need - o.count)), at, y + 1);
        return;
      }
      const r = this.radius * (o.big ? 1.3 : 0.92);
      if (o.kind === 'roll') {
        const endX = this.laneX(o, o.endT, t);
        if (x > this.W + r) return;
        c.lineCap = 'round';
        c.strokeStyle = ROLL;
        c.lineWidth = r * 1.5;
        c.beginPath();
        c.moveTo(Math.max(x, this.zone().x), y);
        c.lineTo(Math.max(endX, this.zone().x), y);
        c.stroke();
        c.lineCap = 'butt';
        return;
      }
      if (x > this.W + r) return;
      hexPath(c, x, y, r, 0);
      c.fillStyle = o.kat ? KAT : DON;
      c.fill();
      c.strokeStyle = '#f5f7fb';
      c.lineWidth = o.big ? 4 : 2.5;
      c.stroke();
    }
  }

  // ---------- Catch: slide a tray along the bottom to catch what falls ----------

  const WALK = 0.5, DASH = 1;
  const PLATE_Y = 348;

  class CatchGame extends Session {
    setup() {
      const m = this.map;
      this.preempt = m.ar < 5 ? 1200 + 600 * (5 - m.ar) / 5 : 1200 - 750 * (m.ar - 5) / 5;
      const scale = 1 - 0.7 * (m.cs - 5) / 5;
      this.half = 42.7 * scale;
      this.radius = 30 * scale;
      this.win = { perfect: 1, great: 1, ok: 1 };
      this.noMeter = true;
      this.quietHits = true;
      this.hint = 'Arrow keys move · Shift dashes';
      this.x = 256;
      this.hyper = null;
      this.touchX = null;
      this.touchId = null;
      this.dashing = false;
      this.objects = this.convert(m);
      this.markHyper();
    }

    // Sliders become a fruit at each end joined by droplets; spinners become a banana shower.
    convert(m) {
      const out = [];
      const edge = x => clamp(x, 0, 512);
      let seed = 1337;
      const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (const o of m.objects) {
        const base = { color: o.color || 0, done: false };
        if (o.type === 'spin' || o.type === 'hold') {
          for (let at = o.t; at <= o.endT; at += 90) out.push({ ...base, kind: 'banana', t: at, x: rand() * 512 });
        } else if (o.type === 'slider') {
          out.push({ ...base, kind: 'fruit', t: o.t, x: edge(o.x) });
          const span = (o.endT - o.t) / o.slides;
          const tick = Math.max(30, (o.beat || 500) / ((o.sv || 1) * (m.tickRate || 1)));
          for (let s = 0; s < o.slides; s++) {
            const from = o.t + s * span;
            for (let at = from + tick; at < from + span - 10; at += tick) {
              out.push({ ...base, kind: 'drop', t: at, x: edge(P.sliderPos(o, at)[0]) });
            }
            const end = from + span;
            out.push({ ...base, kind: 'fruit', t: end, x: edge(P.sliderPos(o, end)[0]) });
          }
        } else {
          out.push({ ...base, kind: 'fruit', t: o.t, x: edge(o.x) });
        }
      }
      return out.sort((a, b) => a.t - b.t);
    }

    // Marks jumps too far to reach even dashing. Catching one speeds up the tray to make it.
    markHyper() {
      const list = this.objects.filter(o => o.kind !== 'banana');
      let lastDir = 0, excess = this.half;
      for (let i = 0; i + 1 < list.length; i++) {
        const a = list[i], b = list[i + 1];
        const dir = b.x > a.x ? 1 : -1;
        const time = b.t - a.t - 1000 / 240;
        const dist = Math.abs(b.x - a.x) - (lastDir === dir ? excess : this.half);
        const spare = time * DASH - dist;
        if (spare < 0) { a.hyperTo = b; excess = this.half; }
        else excess = clamp(spare, 0, this.half);
        lastDir = dir;
      }
    }

    usesKey(code) {
      return ['ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'KeyA', 'KeyD'].includes(code);
    }

    press(id) {
      if (!this.mods.auto && !this.paused && !this.ended) this.held.add(id);
    }

    release(id) {
      this.held.delete(id);
      if (id === this.touchId) { this.touchId = null; this.touchX = null; }
    }

    releaseAll() {
      this.held.clear();
      this.touchId = null;
      this.touchX = null;
    }

    pointerPress(e, id) {
      if (this.mods.auto) return;
      this.touchId = id;
      this.setCursorScreen(e.clientX, e.clientY);
    }

    setCursorScreen(x) {
      if (this.touchId != null) this.touchX = (x - this.ox) / this.s;
    }

    move(t, dt) {
      if (this.hyper && t >= this.hyper.until) this.hyper = null;
      const h = this.held;
      let dir = (h.has('ArrowRight') || h.has('KeyD') ? 1 : 0) - (h.has('ArrowLeft') || h.has('KeyA') ? 1 : 0);
      let dash = h.has('ShiftLeft') || h.has('ShiftRight');
      if (this.touchX != null) {
        const gap = this.touchX - this.x;
        dir = Math.abs(gap) < 2 ? 0 : Math.sign(gap);
        dash = true;
      }
      let speed = dash ? DASH : WALK;
      if (this.hyper && dir === this.hyper.dir) speed = Math.max(speed, this.hyper.speed);
      this.dashing = dir !== 0 && (dash || !!this.hyper);
      let step = dir * speed * dt;
      if (this.touchX != null && Math.abs(step) > Math.abs(this.touchX - this.x)) step = this.touchX - this.x;
      this.x = clamp(this.x + step, 0, 512);
    }

    simulate(t, dt) {
      if (this.mods.auto) {
        const next = this.objects[this.first];
        if (next) {
          const f = next.t <= t ? 1 : Math.min(1, dt / Math.max(dt, next.t - t));
          this.x += (next.x - this.x) * f;
        }
      } else {
        this.move(t, dt);
      }

      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t > t) break;
        if (o.done) continue;
        if (this.mods.auto) this.x = o.x;
        this.settle(o, t);
      }
    }

    settle(o, t) {
      o.done = true;
      const caught = Math.abs(o.x - this.x) <= this.half;
      if (o.kind === 'banana') {
        if (caught) { this.score += 100; this.health = Math.min(1, this.health + 0.005); }
      } else if (o.kind === 'drop') {
        if (caught) {
          this.addCombo();
          this.score += 30;
          this.health = Math.min(1, this.health + 0.005);
        } else {
          this.breakCombo();
          this.health -= 0.01;
        }
      } else {
        this.judge(o, caught ? 'perfect' : 'miss', o.x, PLATE_Y - 34);
      }
      if (caught && o.hyperTo) {
        const gap = o.hyperTo.x - this.x;
        this.hyper = { until: o.hyperTo.t, dir: Math.sign(gap), speed: Math.abs(gap) / Math.max(1, o.hyperTo.t - t) };
      }
    }

    drawPlay(c, t) {
      c.save();
      c.translate(this.ox, this.oy);
      c.scale(this.s, this.s);

      c.strokeStyle = 'rgba(165,180,252,0.2)';
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(0, -24); c.lineTo(0, PLATE_Y + 24);
      c.moveTo(512, -24); c.lineTo(512, PLATE_Y + 24);
      c.stroke();

      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t - this.preempt > t) break;
        if (o.done) continue;
        const y = PLATE_Y - (o.t - t) / this.preempt * (PLATE_Y + 40);
        this.drawFalling(c, o, y);
      }
      this.drawTray(c);
      this.drawFx(c, t);
      c.restore();
    }

    drawFalling(c, o, y) {
      const color = COLORS[o.color % 4];
      if (o.kind === 'drop') {
        c.beginPath();
        c.arc(o.x, y, this.radius * 0.32, 0, Math.PI * 2);
        c.fillStyle = color;
        c.fill();
        return;
      }
      if (o.kind === 'banana') {
        hexPath(c, o.x, y, this.radius * 0.55, 0);
        c.fillStyle = ROLL;
        c.fill();
        return;
      }
      hexPath(c, o.x, y, this.radius * 0.72, Math.PI / 6);
      c.fillStyle = color;
      c.fill();
      c.lineWidth = o.hyperTo ? 4 : 2;
      c.strokeStyle = o.hyperTo ? '#ff4d5e' : '#f5f7fb';
      c.stroke();
    }

    drawTray(c) {
      const w = this.half * 2;
      c.fillStyle = this.hyper ? '#ff4d5e' : this.dashing ? '#ffd479' : '#f5f7fb';
      c.beginPath();
      c.roundRect(this.x - w / 2, PLATE_Y, w, 12, 6);
      c.fill();
      c.fillStyle = 'rgba(245,247,251,0.25)';
      c.fillRect(this.x - w / 2, PLATE_Y + 16, w, 3);
    }
  }

  // ---------- Mania: notes fall down columns, each with its own key ----------

  const ROWS = {
    1: ['Space'],
    2: ['KeyF', 'KeyJ'],
    3: ['KeyF', 'Space', 'KeyJ'],
    4: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'],
    5: ['KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK'],
    6: ['KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL'],
    7: ['KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL'],
    8: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
    9: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'Space', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
    10: ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyV', 'KeyN', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon'],
  };
  const WIDE_ROW = ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK'];
  const keyLabel = code => (code === 'Space' ? '␣' : code === 'Semicolon' ? ';' : code.replace('Key', ''));

  class ManiaGame extends Session {
    setup() {
      const m = this.map, od = m.od;
      this.win = { perfect: 64 - 3 * od, great: 97 - 3 * od, ok: 151 - 3 * od };
      this.earlyMiss = 188 - 3 * od;
      this.keys = m.keys;
      this.codes = ROWS[this.keys] || WIDE_ROW.slice(0, this.keys);
      this.preempt = this.opts.scrollMs || 650;
      this.radius = 24;
      this.singleLabel = true;
      this.hint = this.codes.map(keyLabel).join('  ');
      this.down = new Array(this.keys).fill(false);
      this.pointerCols = new Map();
      this.objects = m.objects.map(o => ({
        t: o.t,
        endT: o.type === 'tap' ? undefined : o.endT,
        hold: o.type !== 'tap',
        col: clamp(Math.floor(o.x * this.keys / 512), 0, this.keys - 1),
        color: 0,
        done: false, headDone: false, holding: false,
      }));
    }

    usesKey(code) { return this.codes.includes(code); }

    press(id) {
      if (this.mods.auto || this.paused || this.ended || this.held.has(id)) return;
      this.held.add(id);
      this.pressCol(this.codes.indexOf(id), this.time());
    }

    release(id) {
      if (this.pointerCols.has(id)) {
        this.releaseCol(this.pointerCols.get(id), this.time());
        this.pointerCols.delete(id);
        return;
      }
      if (!this.held.delete(id)) return;
      const col = this.codes.indexOf(id);
      if (col >= 0) this.releaseCol(col, this.time());
    }

    releaseAll() {
      const t = this.time();
      for (let col = 0; col < this.keys; col++) if (this.down[col]) this.releaseCol(col, t);
      this.held.clear();
      this.pointerCols.clear();
    }

    pointerPress(e, id) {
      if (this.mods.auto || this.paused || this.ended) return;
      const g = this.geom();
      const col = clamp(Math.floor((e.clientX - g.x0) / g.cw), 0, this.keys - 1);
      this.pointerCols.set(id, col);
      this.pressCol(col, this.time());
    }

    geom() {
      const cw = Math.min(64, (this.W - 40) / this.keys);
      const tw = cw * this.keys;
      return { cw, tw, x0: (this.W - tw) / 2, judgeY: this.H - 96 };
    }

    grade(abs) {
      return abs <= this.win.perfect ? 'perfect' : abs <= this.win.great ? 'great' : abs <= this.win.ok ? 'ok' : 'miss';
    }

    mark(o, kind) {
      const g = this.geom();
      this.judge(o, kind, g.x0 + (o.col + 0.5) * g.cw, g.judgeY - 46);
    }

    pressCol(col, t) {
      this.down[col] = true;
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t - t > this.earlyMiss) return;
        if (o.col !== col || o.done || (o.hold && o.headDone)) continue;
        const err = t - o.t, kind = this.grade(Math.abs(err));
        if (kind !== 'miss') this.errors.push({ err, at: t });
        this.mark(o, kind);
        if (!o.hold) o.done = true;
        else { o.headDone = true; o.holding = kind !== 'miss'; }
        return;
      }
    }

    releaseCol(col, t) {
      this.down[col] = false;
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t > t) return;
        if (o.col !== col || !o.holding) continue;
        o.holding = false;
        const abs = Math.abs(t - o.endT);
        // An early release leaves the note to be scored as a miss when its end arrives.
        if (abs <= this.win.ok * 1.5) { this.mark(o, this.grade(abs / 1.5)); o.done = true; }
        return;
      }
    }

    simulate(t) {
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t - this.preempt > t) break;
        if (o.done) continue;

        if (this.mods.auto && t >= o.t && !(o.hold && o.headDone)) {
          this.mark(o, 'perfect');
          if (o.hold) { o.headDone = true; o.holding = true; this.down[o.col] = true; }
          else { o.done = true; o.pulse = t; this.flashCol(o.col, t); }
          continue;
        }

        if (!o.hold) {
          if (t > o.t + this.win.ok) { this.mark(o, 'miss'); o.done = true; }
          continue;
        }
        if (!o.headDone && t > o.t + this.win.ok) { this.mark(o, 'miss'); o.headDone = true; }
        if (o.holding && t >= o.endT) {
          this.mark(o, 'perfect');
          o.done = true; o.holding = false;
          if (this.mods.auto) this.down[o.col] = false;
        } else if (!o.holding && o.headDone && t > o.endT + this.win.ok) {
          this.mark(o, 'miss');
          o.done = true;
        }
      }
    }

    flashCol(col, t) {
      this.flashes = this.flashes || {};
      this.flashes[col] = t;
    }

    drawPlay(c, t) {
      const g = this.geom();
      const { cw, tw, x0, judgeY } = g;
      c.fillStyle = 'rgba(16,15,22,0.94)';
      c.fillRect(x0, 0, tw, this.H);

      const flashes = this.flashes || {};
      for (let i = 0; i < this.keys; i++) {
        const x = x0 + i * cw;
        const lit = this.down[i] || t - (flashes[i] ?? -1e9) < 90;
        if (lit) {
          const grad = c.createLinearGradient(0, judgeY, 0, judgeY - 220);
          grad.addColorStop(0, 'rgba(255,212,121,0.28)');
          grad.addColorStop(1, 'rgba(255,212,121,0)');
          c.fillStyle = grad;
          c.fillRect(x, judgeY - 220, cw, 220);
        }
        c.fillStyle = 'rgba(165,180,252,0.14)';
        c.fillRect(x, 0, 1, this.H);
        c.fillStyle = lit ? '#ffd479' : '#2a3446';
        c.fillRect(x + 3, judgeY + 2, cw - 6, 10);
        c.fillStyle = lit ? '#f5f7fb' : '#a3adbf';
        c.font = `600 15px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(keyLabel(this.codes[i]), x + cw / 2, judgeY + 30);
      }
      c.fillStyle = 'rgba(165,180,252,0.14)';
      c.fillRect(x0 + tw, 0, 1, this.H);
      c.fillStyle = '#f5f7fb';
      c.fillRect(x0, judgeY, tw, 2);

      const yAt = time => judgeY - (time - t) / this.preempt * judgeY;
      const noteH = Math.max(12, Math.min(20, cw * 0.32));
      for (let i = this.first; i < this.objects.length; i++) {
        const o = this.objects[i];
        if (o.t - this.preempt > t) break;
        if (o.done) continue;
        const x = x0 + o.col * cw + 2, w = cw - 4;
        const color = this.colColor(o.col);
        if (o.hold) {
          const headY = o.holding ? judgeY : yAt(o.t);
          const tailY = yAt(o.endT);
          const failed = o.headDone && !o.holding;
          c.globalAlpha = failed ? 0.32 : 0.55;
          c.fillStyle = color;
          c.fillRect(x + w * 0.14, tailY, w * 0.72, Math.max(0, headY - tailY));
          c.globalAlpha = failed ? 0.45 : 1;
          c.fillRect(x, headY - noteH, w, noteH);
          c.fillRect(x, tailY - 4, w, 4);
          c.globalAlpha = 1;
        } else {
          c.fillStyle = color;
          c.fillRect(x, yAt(o.t) - noteH, w, noteH);
        }
      }
      this.drawFx(c, t);
    }

    // Colours mirror around the centre, so hands can read columns by shape.
    colColor(col) {
      const mid = (this.keys - 1) / 2;
      if (col === mid) return COLORS[1];
      return Math.floor(Math.abs(col - mid)) % 2 === 0 ? COLORS[0] : COLORS[2];
    }
  }

  // The keys for each column, shared with the editor's record mode.
  P.maniaKeys = keys => ROWS[keys] || WIDE_ROW.slice(0, keys);
  P.keyLabel = keyLabel;

  P.createSession = (canvas, opts) => {
    const Mode = [StandardGame, TaikoGame, CatchGame, ManiaGame][opts.map.mode || 0];
    return new Mode(canvas, opts);
  };
})(globalThis.Pulsar = globalThis.Pulsar || {});
