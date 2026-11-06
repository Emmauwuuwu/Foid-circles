// The beatmap editor. One timeline for every mode, plus a mode-shaped stage above it:
// a playfield for standard, a horizontal lane for taiko, and a vertical roll for catch and mania.
(function (P) {
  'use strict';

  const { hexPath, COLORS, clamp } = P;
  const $ = id => document.getElementById(id);
  const FONT = P.FONT, MONO = '"Cascadia Mono", ui-monospace, Consolas, monospace';
  const ACID = '#d8ff3e', SEL = '#ffffff', BONE = '#f3f0e7', MUTE = '#97939f', DON = '#ff7a66', KAT = '#5eead4', ROLL = '#ffd479', SWELL = '#a5b4fc';
  const SNAPS = [1, 2, 3, 4, 6, 8, 12, 16];
  const RATES = [1, 0.75, 0.5, 0.25];
  const MODE_NAMES = ['Standard', 'Taiko', 'Catch', 'Mania'];

  const SELECT = { id: 'select', label: 'Select', icon: 'select', hint: 'Click a note to select it, then drag to move it. Drag empty space to select several.' };
  const TOOLSETS = [
    [SELECT,
      { id: 'note', label: 'Note', icon: 'note', hint: 'Click to place a note at the playhead. The playhead then moves to the next beat for you.' },
      { id: 'slider', label: 'Slider', icon: 'slider', hint: 'Press and drag to draw a slider. Then drag its points to bend it, or click a + to add a bend.' },
      { id: 'spin', label: 'Spinner', icon: 'spin', hint: 'Click to add a spinner at the playhead. Drag its end on the timeline to change the length.' }],
    [SELECT,
      { id: 'don', label: 'Center', swatch: DON, hint: 'Click the lane to place a center hit. Click a note to turn it into a center hit.' },
      { id: 'kat', label: 'Rim', swatch: KAT, hint: 'Click the lane to place a rim hit. Click a note to turn it into a rim hit.' },
      { id: 'roll', label: 'Roll', swatch: ROLL, hint: 'Press and drag along the lane to draw a drum roll.' },
      { id: 'swell', label: 'Swell', swatch: SWELL, hint: 'Press and drag along the lane to set how long the swell lasts.' }],
    [SELECT,
      { id: 'note', label: 'Fruit', icon: 'note', hint: 'Click anywhere on the stage to drop a fruit on that beat.' },
      { id: 'slider', label: 'Juice', icon: 'slider', hint: 'Press on the stage and drag up and across to draw a juice stream.' },
      { id: 'spin', label: 'Bananas', icon: 'spin', hint: 'Press on the stage and drag up to set how long the banana shower lasts.' }],
    [SELECT,
      { id: 'note', label: 'Note', icon: 'note', hint: 'Click a column to place a note. Keep holding and drag up to make it a hold note.' }],
  ];

  const fmtTime = v => {
    const neg = v < 0;
    const a = Math.abs(Math.round(v));
    const m = Math.floor(a / 60000), s = Math.floor(a / 1000) % 60, ms = a % 1000;
    return `${neg ? '-' : ''}${m}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
  };
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

  // Small DOM builder, so map metadata is always inserted as text.
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const icon = name => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'i');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
  };

  // The colour of a grid line, chosen by how finely it divides the beat.
  function tickStyle(k, div, meter) {
    if (k % div === 0) {
      const beat = k / div;
      return ((beat % meter) + meter) % meter === 0
        ? { color: 'rgba(243,240,231,0.85)', level: 0 }
        : { color: 'rgba(243,240,231,0.45)', level: 1 };
    }
    const den = div / gcd(Math.abs(k), div);
    if (den === 2) return { color: 'rgba(255,122,102,0.6)', level: 2 };
    if (den === 3 || den === 6 || den === 12) return { color: 'rgba(165,180,252,0.55)', level: 3 };
    if (den === 4) return { color: 'rgba(94,234,212,0.5)', level: 3 };
    return { color: 'rgba(255,212,121,0.35)', level: 4 };
  }

  class Editor {
    constructor(opts) {
      this.hooks = opts;
      this.ctx = opts.audioCtx;
      this.audio = opts.audioBuffer;
      this.duration = this.audio.duration * 1000;
      this.bg = opts.bgImage || null;
      this.map = null;
      this.loadText(opts.osu);
      this.history = [P.serializeMap(this.map)];
      this.historyAt = 0;
      this.saved = this.history[0];

      this.t = 0;
      this.playing = false;
      this.rate = 1;
      this.selection = new Set();
      this.tool = 'note';
      this.snap = this.map.mode === 0 ? 2 : 4;
      this.opt = { grid: false, hits: true, metro: false, advance: true, big: false };
      this.record = false;
      this.recordDirty = false;
      this.recordHolds = new Map();
      this.cursor = { x: 256, y: 192, sx: 0, sy: 0, inside: false };
      this.zoom = 0.16;
      this.rollZoom = 0.28;
      this.laneZoom = 0.32;
      this.drag = null;
      this.clip = null;
      this.tab = 'note';
      this.taps = [];
      this.dirty = true;
      this.active = true;

      this.peaks = this.buildPeaks();
      this.density = null;
      this.tick = this.tick.bind(this);

      // Open at the first note, so a loaded map shows something straight away.
      if (this.map.objects.length) this.t = this.map.objects[0].t;
      else if (this.map.timing[0]) this.t = Math.max(0, this.map.timing[0].t);

      this.buildChrome();
      this.renderPanel();
      this.resize();
      requestAnimationFrame(this.tick);
    }

    // ---------- Map model ----------

    loadText(text) {
      const m = P.parseBeatmapText(text, { allowEmpty: true });
      if (!m.timing.some(p => p.uninherited)) {
        m.timing.unshift({ t: 0, beat: 500, uninherited: true, meter: 4, sampleSet: 2, sampleIndex: 0, volume: 70, effects: 0 });
      }
      // Repeated bezier points are one sharp corner, so they move as one.
      for (const o of m.objects) {
        if (o.type !== 'slider') continue;
        for (const seg of o.segments) {
          for (let i = 1; i < seg.points.length; i++) {
            const a = seg.points[i - 1], b = seg.points[i];
            if (a[0] === b[0] && a[1] === b[1]) seg.points[i] = a;
          }
        }
      }
      this.map = m;
    }

    reds() { return this.map.timing.filter(p => p.uninherited).sort((a, b) => a.t - b.t); }

    redAt(t) {
      const reds = this.reds();
      let cur = reds[0];
      for (const r of reds) { if (r.t <= t + 0.5) cur = r; else break; }
      return cur;
    }

    svAt(t) {
      let sv = 1;
      for (const p of this.map.timing.slice().sort((a, b) => a.t - b.t)) {
        if (p.t > t + 0.5) break;
        if (p.uninherited) sv = 1;
        else sv = p.beat < 0 ? clamp(-100 / p.beat, 0.1, 10) : 1;
      }
      return sv;
    }

    pxPerBeat(t) { return (this.map.multiplier || 1.4) * 100 * this.svAt(t); }

    snapT(t, div = this.snap) {
      const r = this.redAt(t), unit = r.beat / div;
      return Math.round(r.t + Math.round((t - r.t) / unit) * unit);
    }

    stepT(t, dir, div = this.snap) {
      const r = this.redAt(t + dir), unit = r.beat / div;
      return Math.round(r.t + (Math.round((t - r.t) / unit) + dir) * unit);
    }

    forTicks(t0, t1, div, cb) {
      const reds = this.reds();
      reds.forEach((r, i) => {
        const from = Math.max(t0, i === 0 ? -Infinity : r.t);
        const to = Math.min(t1, i + 1 < reds.length ? reds[i + 1].t : Infinity);
        if (from >= to) return;
        const unit = r.beat / div;
        for (let k = Math.ceil((from - r.t) / unit - 1e-6); ; k++) {
          const time = r.t + k * unit;
          if (time >= to) break;
          cb(time, k, r);
        }
      });
    }

    refresh(o) {
      if (o.type !== 'slider') return;
      const r = this.redAt(o.t);
      o.beat = r.beat;
      o.sv = this.svAt(o.t);
      o.path = P.makeSegmentedPath(o.segments, o.length);
      o.endT = o.t + o.length / this.pxPerBeat(o.t) * o.beat * o.slides;
    }

    refreshAll() { this.map.objects.forEach(o => this.refresh(o)); }

    // A slider's length always lands on the beat grid, so its end stays in rhythm.
    fitLength(o) {
      const natural = P.makeSegmentedPath(o.segments, null).length;
      const unit = this.pxPerBeat(o.t) / this.snap;
      o.length = Math.max(unit, Math.round(natural / unit) * unit);
      this.refresh(o);
    }

    handles(o) {
      const out = [];
      for (const seg of o.segments) for (const p of seg.points) if (!out.includes(p)) out.push(p);
      return out;
    }

    // Reshaping needs one bezier. Corners and segment joins survive as repeated points.
    toEditable(o) {
      if (o.segments.length === 1 && (o.segments[0].kind === 'B' || o.segments[0].kind === 'C')) return;
      const pts = [];
      o.segments.forEach(seg => {
        seg.points.forEach((p, i) => {
          if (pts[pts.length - 1] === p && i > 0) return;
          pts.push(p);
          if (seg.kind === 'L' && i > 0 && i < seg.points.length - 1) pts.push(p);
        });
      });
      o.segments = [{ kind: 'B', points: pts }];
    }

    colOf(o) { return clamp(Math.floor(o.x * this.map.keys / 512), 0, this.map.keys - 1); }
    colX(col) { return Math.floor((col + 0.5) * 512 / this.map.keys); }

    newTap(t, x, y) { return { type: 'tap', t, x, y, newCombo: false, comboSkip: 0, hitSound: 0, extras: '' }; }

    add(o) {
      this.map.objects.push(o);
      this.refresh(o);
      P.finalizeObjects(this.map.objects);
      this.density = null;
      this.touch();
      return o;
    }

    remove(list) {
      const gone = new Set(list);
      this.map.objects = this.map.objects.filter(o => !gone.has(o));
      gone.forEach(o => this.selection.delete(o));
      P.finalizeObjects(this.map.objects);
      this.density = null;
      this.touch();
    }

    // Records one undo step and queues an autosave.
    commit() {
      P.finalizeObjects(this.map.objects);
      this.density = null;
      const text = P.serializeMap(this.map);
      if (text !== this.history[this.historyAt]) {
        this.history.length = this.historyAt + 1;
        this.history.push(text);
        if (this.history.length > 80) this.history.shift();
        this.historyAt = this.history.length - 1;
        this.queueSave();
      }
      this.syncButtons();
      this.renderPanel();
      this.touch();
    }

    restore(step) {
      const at = this.historyAt + step;
      if (at < 0 || at >= this.history.length) return;
      this.historyAt = at;
      this.selection.clear();
      this.drag = null;
      this.loadText(this.history[at]);
      this.density = null;
      this.queueSave();
      this.syncButtons();
      this.renderPanel();
      this.touch();
    }

    queueSave() {
      $('ed-saved').textContent = 'Saving…';
      clearTimeout(this.saveTimer);
      this.saveTimer = setTimeout(() => this.flushSave(), 500);
    }

    async flushSave() {
      clearTimeout(this.saveTimer);
      const text = this.history[this.historyAt];
      if (text === this.saved) { $('ed-saved').textContent = 'All changes saved'; return; }
      try {
        await this.hooks.save(text);
        this.saved = text;
        if (this.history[this.historyAt] === text) $('ed-saved').textContent = 'All changes saved';
      } catch (e) {
        $('ed-saved').textContent = 'Could not save';
        this.toast(`Saving failed: ${e.message || e}`);
      }
    }

    // ---------- Sound ----------

    buildPeaks() {
      const perSec = 100;
      const L = this.audio.getChannelData(0);
      const R = this.audio.numberOfChannels > 1 ? this.audio.getChannelData(1) : L;
      const size = Math.max(1, Math.round(this.audio.sampleRate / perSec));
      const peaks = new Float32Array(Math.ceil(L.length / size));
      for (let i = 0; i < peaks.length; i++) {
        let top = 0;
        for (let j = i * size, end = Math.min(L.length, j + size); j < end; j += 8) {
          const v = Math.abs(L[j]) + Math.abs(R[j]);
          if (v > top) top = v;
        }
        peaks[i] = top / 2;
      }
      let max = 0.01;
      for (const p of peaks) if (p > max) max = p;
      for (let i = 0; i < peaks.length; i++) peaks[i] /= max;
      return { data: peaks, perSec };
    }

    now() {
      if (!this.playing) return this.t;
      return this.audioNow() - (this.ctx.outputLatency || this.ctx.baseLatency || 0) * 1000 * this.rate;
    }

    audioNow() { return this.startT + (this.ctx.currentTime - this.startCtx) * 1000 * this.rate; }

    play() {
      if (this.playing) return;
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (this.t >= this.duration - 50) this.t = 0;
      const src = this.ctx.createBufferSource();
      src.buffer = this.audio;
      src.playbackRate.value = this.rate;
      src.connect(this.hooks.musicOut);
      src.start(0, Math.max(0, this.t) / 1000);
      this.src = src;
      this.startCtx = this.ctx.currentTime;
      this.startT = this.t;
      this.schedFrom = this.t;
      this.playing = true;
      this.syncButtons();
    }

    pause(snap = true) {
      if (!this.playing) return;
      const at = this.now();
      this.src.stop();
      this.src.disconnect();
      this.src = null;
      this.playing = false;
      this.t = clamp(snap ? this.snapT(at) : at, 0, this.duration);
      this.endRecordHolds(at);
      if (this.recordDirty) { this.recordDirty = false; this.commit(); }
      this.syncButtons();
      this.touch();
    }

    toggle() { if (this.playing) this.pause(); else this.play(); }

    seek(t) {
      const to = clamp(t, 0, this.duration);
      if (this.playing) {
        this.pause(false);
        this.t = to;
        this.play();
      } else this.t = to;
      this.touch();
    }

    setRate(rate) {
      const was = this.playing;
      if (was) this.pause(false);
      this.rate = rate;
      if (was) this.play();
      this.syncButtons();
    }

    click(when, kind) {
      const c = this.ctx;
      const g = c.createGain(), o = c.createOscillator();
      const presets = {
        hit: ['triangle', 1250, 0.28, 0.05], don: ['sine', 190, 0.6, 0.11], kat: ['triangle', 1500, 0.3, 0.06],
        down: ['square', 1800, 0.12, 0.035], beat: ['square', 1100, 0.09, 0.03],
      };
      const [type, freq, vol, len] = presets[kind];
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + len);
      o.connect(g);
      g.connect(this.hooks.sfxOut);
      o.start(when);
      o.stop(when + len + 0.01);
    }

    soundFor(o) {
      if (this.map.mode !== 1) return 'hit';
      return o.hitSound & 10 ? 'kat' : 'don';
    }

    scheduleSounds() {
      const horizon = this.audioNow() + 140 * this.rate;
      const whenOf = t => Math.max(this.ctx.currentTime, this.startCtx + (t - this.startT) / 1000 / this.rate);
      if (this.opt.hits) {
        for (const o of this.map.objects) {
          if (o.t >= this.schedFrom && o.t < horizon) this.click(whenOf(o.t), this.soundFor(o));
        }
      }
      if (this.opt.metro) {
        this.forTicks(this.schedFrom, horizon, 1, (time, k, r) => {
          this.click(whenOf(time), ((k % r.meter) + r.meter) % r.meter === 0 ? 'down' : 'beat');
        });
      }
      this.schedFrom = horizon;
    }

    // ---------- Actions ----------

    setTool(id) {
      if (!this.tools().some(t => t.id === id)) return;
      this.tool = id;
      this.syncTools();
      this.touch();
    }

    tools() { return TOOLSETS[this.map.mode]; }

    toast(text) {
      const el = $('ed-toast');
      el.textContent = text;
      el.classList.remove('hidden');
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => el.classList.add('hidden'), 3200);
    }

    select(list, add = false) {
      if (!add) this.selection.clear();
      list.forEach(o => this.selection.add(o));
      if (this.selection.size) this.tab = 'note';
      this.renderPanel();
      this.syncTabs();
      this.touch();
    }

    deleteSelected() {
      if (!this.selection.size) return;
      this.remove([...this.selection]);
      this.commit();
    }

    copy() {
      if (!this.selection.size) return;
      this.clip = [...this.selection].map(o => this.cloneObject(o)).sort((a, b) => a.t - b.t);
      this.toast(`Copied ${this.clip.length} ${this.clip.length === 1 ? 'note' : 'notes'}`);
    }

    cloneObject(o) {
      const copy = { ...o, path: null };
      if (o.segments) {
        const seen = new Map();
        const one = p => { if (!seen.has(p)) seen.set(p, [p[0], p[1]]); return seen.get(p); };
        copy.segments = o.segments.map(seg => ({ kind: seg.kind, points: seg.points.map(one) }));
      }
      return copy;
    }

    paste() {
      if (!this.clip || !this.clip.length) return;
      const shift = this.snapT(this.now()) - this.clip[0].t;
      const made = this.clip.map(c => {
        const o = this.cloneObject(c);
        o.t += shift;
        if (o.endT) o.endT += shift;
        return this.add(o);
      });
      this.select(made);
      this.commit();
    }

    nudgeSelection(dir) {
      if (!this.selection.size) return;
      for (const o of this.selection) {
        const to = Math.max(0, this.stepT(o.t, dir));
        if (o.endT) o.endT += to - o.t;
        o.t = to;
        this.refresh(o);
      }
      this.commit();
    }

    toggleCombo() {
      if (!this.selection.size) return;
      const on = ![...this.selection].every(o => o.newCombo);
      this.selection.forEach(o => { o.newCombo = on; });
      this.commit();
    }

    setBig(on) {
      this.opt.big = on;
      this.selection.forEach(o => { if (o.type !== 'spin') o.hitSound = on ? o.hitSound | 4 : o.hitSound & ~4; });
      if (this.selection.size) this.commit();
      this.syncTools();
      this.renderPanel();
    }

    setKat(o, kat) {
      o.hitSound = kat ? (o.hitSound & ~2) | 8 : o.hitSound & ~10;
    }

    flip(horizontal) {
      for (const o of this.selection) {
        if (o.type === 'spin') continue;
        const map = p => { if (horizontal) p[0] = 512 - p[0]; else p[1] = 384 - p[1]; };
        if (horizontal) o.x = 512 - o.x; else o.y = 384 - o.y;
        if (o.type === 'slider') this.handles(o).forEach(map);
        this.refresh(o);
      }
      this.commit();
    }

    setRepeats(o, slides) {
      o.slides = clamp(slides, 1, 32);
      o.extras = [];
      this.refresh(o);
      this.commit();
    }

    snapAll() {
      let moved = 0;
      for (const o of this.map.objects) {
        const to = this.snapT(o.t);
        if (to !== o.t) moved++;
        if (o.endT && o.type !== 'slider') o.endT = Math.max(to + 1, this.snapT(o.endT));
        o.t = to;
        this.refresh(o);
      }
      this.toast(moved ? `Moved ${moved} ${moved === 1 ? 'note' : 'notes'} onto the 1/${this.snap} grid` : 'Every note is already on the grid');
      this.commit();
    }

    // ---------- Placing ----------

    placeTap(t, x, y, opts = {}) {
      if (t < 0 || t > this.duration) return null;
      const mode = this.map.mode;
      let same = null;
      if (mode === 0) same = this.map.objects.find(o => near(o.t, t));
      else if (mode === 1) same = this.map.objects.find(o => near(o.t, t));
      else if (mode === 2) same = this.map.objects.find(o => near(o.t, t) && Math.abs(o.x - x) < 8);
      else same = this.map.objects.find(o => near(o.t, t) && this.colOf(o) === this.colOf({ x }));
      if (same) {
        if (mode === 0 && same.type === 'tap') { same.x = x; same.y = y; }
        if (mode === 1 && same.type === 'tap') this.setKat(same, !!opts.kat);
        return same;
      }
      const o = this.newTap(t, x, y);
      if (mode === 1) {
        this.setKat(o, !!opts.kat);
        if (this.opt.big) o.hitSound |= 4;
      }
      return this.add(o);
    }

    addSpinner(t, end) {
      const o = { type: 'spin', t, endT: end, x: 256, y: 192, newCombo: true, comboSkip: 0, hitSound: 0, extras: '' };
      return this.add(o);
    }

    // Draws a juice stream to a point in time and space. Catch ignores the path's height,
    // so height absorbs whatever extra length the timing needs.
    setJuiceEnd(o, x1, tEnd) {
      const speed = this.pxPerBeat(o.t) / this.redAt(o.t).beat;
      const unit = this.redAt(o.t).beat / this.snap;
      const dur = Math.max(unit, tEnd - o.t);
      const len = speed * dur;
      const dx = clamp(x1 - o.x, -len, len);
      const dy = Math.sqrt(Math.max(0, len * len - dx * dx));
      o.segments = [{ kind: 'L', points: [[o.x, 192], [o.x + dx, 192 + dy]] }];
      o.y = 192;
      o.length = len;
      o.slides = 1;
      o.extras = [];
      this.refresh(o);
    }

    // Taiko rolls are straight lines whose length comes from their duration.
    setRollEnd(o, tEnd) {
      const speed = this.pxPerBeat(o.t) / this.redAt(o.t).beat;
      const unit = this.redAt(o.t).beat / this.snap;
      const len = speed * Math.max(unit, tEnd - o.t);
      o.segments = [{ kind: 'L', points: [[o.x, o.y], [o.x + len, o.y]] }];
      o.length = len;
      o.slides = 1;
      o.extras = [];
      this.refresh(o);
    }

    setEnd(o, tEnd, onTimeline = true) {
      const unit = this.redAt(o.t).beat / this.snap;
      if (o.type === 'hold' || o.type === 'spin') o.endT = Math.max(o.t + unit, tEnd);
      else if (o.type === 'slider') {
        if (this.map.mode === 1) this.setRollEnd(o, tEnd);
        else if (onTimeline) {
          const span = (o.endT - o.t) / o.slides;
          o.slides = clamp(Math.round((tEnd - o.t) / span), 1, 32);
          o.extras = [];
          this.refresh(o);
        }
      }
    }

    // ---------- Stage geometry ----------

    view() { return ['field', 'lane', 'roll', 'roll'][this.map.mode]; }

    fieldGeom() {
      const s = Math.min((this.W - 48) / 512, (this.H - 48) / 384);
      return { s, ox: (this.W - 512 * s) / 2, oy: (this.H - 384 * s) / 2 };
    }

    rollGeom() {
      const judge = this.H - 56;
      if (this.map.mode === 3) {
        const cw = Math.min(84, (this.W - 32) / this.map.keys);
        const tw = cw * this.map.keys;
        return { judge, cw, tw, x0: (this.W - tw) / 2, s: tw / 512 };
      }
      const s = Math.min((this.W - 56) / 512, 1.5);
      return { judge, tw: 512 * s, x0: (this.W - 512 * s) / 2, s };
    }

    laneGeom() {
      return { y: this.H / 2, h: Math.min(170, this.H * 0.5), px: Math.round(this.W * 0.2) };
    }

    yOf(time, t, g) { return g.judge - (time - t) * this.rollZoom; }
    timeOfY(y, t, g) { return t + (g.judge - y) / this.rollZoom; }
    laneX(time, t, g) { return g.px + (time - t) * this.laneZoom; }
    timeOfLaneX(x, t, g) { return t + (x - g.px) / this.laneZoom; }

    // Where an object sits on screen, for box selection.
    screenPos(o, t) {
      const view = this.view();
      if (view === 'field') {
        const g = this.fieldGeom();
        if (t < o.t - this.preempt() || t > (o.endT || o.t) + 700) return null;
        return [g.ox + o.x * g.s, g.oy + o.y * g.s];
      }
      if (view === 'lane') { const g = this.laneGeom(); return [this.laneX(o.t, t, g), g.y]; }
      const g = this.rollGeom();
      const x = this.map.mode === 3 ? g.x0 + (this.colOf(o) + 0.5) * g.cw : g.x0 + o.x * g.s;
      return [x, this.yOf(o.t, t, g)];
    }

    preempt() {
      const ar = this.map.ar;
      return ar < 5 ? 1200 + 600 * (5 - ar) / 5 : 1200 - 750 * (ar - 5) / 5;
    }

    radius() { return 54.4 - 4.48 * this.map.cs; }

    pos(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    gridded(v) { return this.opt.grid ? Math.round(v / 32) * 32 : Math.round(v); }

    // ---------- Stage hit testing ----------

    hitObject(x, y) {
      const t = this.now();
      const view = this.view();
      if (view === 'field') {
        const g = this.fieldGeom();
        const wx = (x - g.ox) / g.s, wy = (y - g.oy) / g.s, r = this.radius();
        const list = this.map.objects
          .filter(o => t >= o.t - this.preempt() && t <= (o.endT || o.t) + 700)
          .sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t));
        for (const o of list) {
          if (o.type === 'spin') continue;
          if (Math.hypot(wx - o.x, wy - o.y) <= r) return { o, part: 'body' };
          if (o.type === 'slider' && o.path.pts.some(p => Math.hypot(wx - p[0], wy - p[1]) <= r * 0.8)) return { o, part: 'body' };
        }
        for (const o of list) if (o.type === 'spin' && Math.hypot(wx - 256, wy - 192) <= 60) return { o, part: 'body' };
        return null;
      }
      if (view === 'lane') {
        const g = this.laneGeom();
        if (Math.abs(y - g.y) > g.h / 2) return null;
        for (const o of this.map.objects) {
          const hx = this.laneX(o.t, t, g);
          if (o.endT) {
            const ex = this.laneX(o.endT, t, g);
            if (Math.abs(x - ex) <= 9) return { o, part: 'tail' };
            if (x >= hx - 20 && x <= ex) return { o, part: 'body' };
          } else if (Math.abs(x - hx) <= (o.hitSound & 4 ? 34 : 26)) return { o, part: 'body' };
        }
        return null;
      }
      const g = this.rollGeom();
      if (this.map.mode === 3) {
        const col = Math.floor((x - g.x0) / g.cw);
        for (const o of this.map.objects) {
          if (this.colOf(o) !== col) continue;
          const hy = this.yOf(o.t, t, g);
          if (o.endT) {
            const ey = this.yOf(o.endT, t, g);
            if (Math.abs(y - ey) <= 8) return { o, part: 'tail' };
            if (y <= hy + 4 && y >= ey) return { o, part: 'body' };
          } else if (y <= hy + 4 && y >= hy - 16) return { o, part: 'body' };
        }
        return null;
      }
      for (const o of this.map.objects) {
        const hy = this.yOf(o.t, t, g);
        if (o.type === 'spin') {
          const ey = this.yOf(o.endT, t, g);
          if (x < g.x0 || x > g.x0 + g.tw) continue;
          if (Math.abs(y - ey) <= 8) return { o, part: 'tail' };
          if (y <= hy && y >= ey) return { o, part: 'body' };
          continue;
        }
        if (Math.hypot(x - (g.x0 + o.x * g.s), y - hy) <= 16) return { o, part: 'body' };
        if (o.type === 'slider') {
          const end = P.sliderPos(o, o.endT);
          if (Math.hypot(x - (g.x0 + end[0] * g.s), y - this.yOf(o.endT, t, g)) <= 12) return { o, part: 'tail' };
        }
      }
      return null;
    }

    // ---------- Stage pointer ----------

    stageDown(e) {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      const { x, y } = this.pos(e);
      const hit = this.hitObject(x, y);
      if (e.button === 2) {
        if (hit) { this.remove([hit.o]); this.commit(); }
        return;
      }
      if (e.button !== 0) return;
      const view = this.view();
      const t = this.now();

      if (view === 'field') {
        const handle = this.handleDown(x, y);
        if (handle) return;
      }
      if (hit) {
        if (view === 'field' && this.tool !== 'select' && !near(hit.o.t, t, 3) && !this.selection.has(hit.o)) {
          this.placeAt(x, y, e);
          return;
        }
        if (view === 'lane' && (this.tool === 'don' || this.tool === 'kat') && hit.o.type === 'tap') {
          this.setKat(hit.o, this.tool === 'kat');
          this.select([hit.o]);
          this.commit();
          return;
        }
        if (!this.selection.has(hit.o)) this.select([hit.o], e.shiftKey);
        else if (e.shiftKey) { this.selection.delete(hit.o); this.renderPanel(); this.touch(); return; }
        if (hit.part === 'tail') this.drag = { kind: 'tail', o: hit.o };
        else this.beginMove(x, y, hit.o);
        return;
      }
      if (this.tool === 'select') {
        if (!e.shiftKey) this.select([]);
        this.drag = { kind: 'box', x0: x, y0: y, x1: x, y1: y };
        return;
      }
      this.placeAt(x, y, e);
    }

    placeAt(x, y) {
      const view = this.view();
      const t = this.now();
      if (view === 'field') {
        const g = this.fieldGeom();
        const wx = clamp(this.gridded((x - g.ox) / g.s), 0, 512), wy = clamp(this.gridded((y - g.oy) / g.s), 0, 384);
        const at = this.snapT(t);
        if (this.tool === 'note') {
          const o = this.placeTap(at, wx, wy);
          if (o) this.select([o]);
          this.commit();
          if (this.opt.advance && !this.playing) this.seek(this.stepT(at, 1));
        } else if (this.tool === 'slider') {
          const o = this.add({ type: 'slider', t: at, x: wx, y: wy, slides: 1, segments: [{ kind: 'L', points: [[wx, wy], [wx, wy]] }], length: this.pxPerBeat(at) / this.snap, newCombo: false, comboSkip: 0, hitSound: 0, extras: [] });
          this.select([o]);
          this.drag = { kind: 'draft', o, sx: x, sy: y };
        } else if (this.tool === 'spin') {
          const end = at + this.redAt(at).beat * 4;
          const o = this.addSpinner(at, end);
          this.select([o]);
          this.commit();
          if (this.opt.advance && !this.playing) this.seek(this.snapT(end + this.redAt(end).beat));
        }
        return;
      }
      if (view === 'lane') {
        const g = this.laneGeom();
        if (Math.abs(y - g.y) > g.h / 2) return;
        const at = this.snapT(this.timeOfLaneX(x, t, g));
        if (at < 0) return;
        if (this.tool === 'don' || this.tool === 'kat') {
          const o = this.placeTap(at, 256, 192, { kat: this.tool === 'kat' });
          if (o) this.select([o]);
          this.commit();
        } else if (this.tool === 'roll') {
          const o = this.add({ type: 'slider', t: at, x: 256, y: 192, slides: 1, segments: [{ kind: 'L', points: [[256, 192], [356, 192]] }], length: 100, newCombo: false, comboSkip: 0, hitSound: this.opt.big ? 4 : 0, extras: [] });
          this.setRollEnd(o, at);
          this.select([o]);
          this.drag = { kind: 'tail', o };
        } else if (this.tool === 'swell') {
          const o = this.addSpinner(at, at + this.redAt(at).beat);
          this.select([o]);
          this.drag = { kind: 'tail', o };
        }
        return;
      }
      const g = this.rollGeom();
      if (x < g.x0 || x > g.x0 + g.tw) return;
      const at = this.snapT(this.timeOfY(y, t, g));
      if (at < 0) return;
      if (this.map.mode === 3) {
        const col = clamp(Math.floor((x - g.x0) / g.cw), 0, this.map.keys - 1);
        const o = this.placeTap(at, this.colX(col), 192);
        if (o) { this.select([o]); this.drag = { kind: 'drafthold', o, t0: o.t }; }
        return;
      }
      const wx = clamp(this.gridded((x - g.x0) / g.s), 0, 512);
      if (this.tool === 'note') {
        const o = this.placeTap(at, wx, 192);
        if (o) this.select([o]);
        this.commit();
      } else if (this.tool === 'slider') {
        const o = this.add({ type: 'slider', t: at, x: wx, y: 192, slides: 1, segments: [{ kind: 'L', points: [[wx, 192], [wx + 1, 192]] }], length: 1, newCombo: false, comboSkip: 0, hitSound: 0, extras: [] });
        this.setJuiceEnd(o, wx, at);
        this.select([o]);
        this.drag = { kind: 'juice', o };
      } else if (this.tool === 'spin') {
        const o = this.addSpinner(at, at + this.redAt(at).beat);
        this.select([o]);
        this.drag = { kind: 'tail', o };
      }
    }

    // Slider points and + markers on the one selected slider.
    handleDown(x, y) {
      const o = this.singleSlider();
      if (!o) return false;
      const g = this.fieldGeom();
      const wx = (x - g.ox) / g.s, wy = (y - g.oy) / g.s, reach = 11 / g.s;
      const list = this.handles(o);
      const at = list.findIndex(p => Math.hypot(wx - p[0], wy - p[1]) <= reach);
      if (at >= 0) {
        this.drag = { kind: 'handle', o, p: list[at], first: at === 0 };
        return true;
      }
      for (let i = 0; i + 1 < list.length; i++) {
        const mx = (list[i][0] + list[i + 1][0]) / 2, my = (list[i][1] + list[i + 1][1]) / 2;
        if (Math.hypot(wx - mx, wy - my) <= reach) {
          this.toEditable(o);
          const point = [Math.round(mx), Math.round(my)];
          const pts = o.segments[0].points;
          pts.splice(pts.lastIndexOf(list[i]) + 1, 0, point);
          this.drag = { kind: 'handle', o, p: point, first: false };
          o.extras = [];
          return true;
        }
      }
      return false;
    }

    singleSlider() {
      if (this.selection.size !== 1 || this.map.mode !== 0) return null;
      const [o] = this.selection;
      return o.type === 'slider' ? o : null;
    }

    stageDouble(e) {
      const o = this.singleSlider();
      if (!o) return;
      const { x, y } = this.pos(e);
      const g = this.fieldGeom();
      const wx = (x - g.ox) / g.s, wy = (y - g.oy) / g.s;
      const list = this.handles(o);
      const p = list.find(q => Math.hypot(wx - q[0], wy - q[1]) <= 11 / g.s);
      if (!p || list.length <= 2) return;
      this.toEditable(o);
      const seg = o.segments[0];
      seg.points = seg.points.filter(q => q !== p);
      o.x = seg.points[0][0];
      o.y = seg.points[0][1];
      this.fitLength(o);
      this.commit();
    }

    beginMove(x, y, primary) {
      const orig = new Map();
      for (const o of this.selection) {
        orig.set(o, { t: o.t, endT: o.endT, x: o.x, y: o.y, pts: o.segments ? this.handles(o).map(p => [p, p[0], p[1]]) : null });
      }
      this.drag = { kind: 'move', sx: x, sy: y, primary, orig };
    }

    applyMove(d, dt, dx, dy) {
      for (const [o, was] of d.orig) {
        o.t = Math.max(0, was.t + dt);
        if (was.endT != null) o.endT = was.endT + (o.t - was.t);
        o.x = was.x + dx;
        o.y = was.y + dy;
        if (was.pts) was.pts.forEach(([p, px, py]) => { p[0] = px + dx; p[1] = py + dy; });
        this.refresh(o);
      }
      this.touch();
    }

    stageMove(e) {
      const { x, y } = this.pos(e);
      this.cursor.sx = x;
      this.cursor.sy = y;
      this.cursor.inside = true;
      const t = this.now();
      if (this.view() === 'field') {
        const g = this.fieldGeom();
        this.cursor.x = clamp((x - g.ox) / g.s, 0, 512);
        this.cursor.y = clamp((y - g.oy) / g.s, 0, 384);
      } else if (this.map.mode === 2) {
        const g = this.rollGeom();
        this.cursor.x = clamp((x - g.x0) / g.s, 0, 512);
      }
      this.touch();
      const d = this.drag;
      if (!d) return;

      if (d.kind === 'box') { d.x1 = x; d.y1 = y; return; }
      if (d.kind === 'handle') {
        const g = this.fieldGeom();
        d.p[0] = this.gridded((x - g.ox) / g.s);
        d.p[1] = this.gridded((y - g.oy) / g.s);
        if (d.first) { d.o.x = d.p[0]; d.o.y = d.p[1]; }
        d.o.extras = [];
        this.fitLength(d.o);
        return;
      }
      if (d.kind === 'draft') {
        const g = this.fieldGeom();
        const seg = d.o.segments[0];
        seg.points[1] = [this.gridded((x - g.ox) / g.s), this.gridded((y - g.oy) / g.s)];
        this.fitLength(d.o);
        return;
      }
      if (d.kind === 'juice') {
        const g = this.rollGeom();
        this.setJuiceEnd(d.o, clamp((x - g.x0) / g.s, 0, 512), this.snapT(this.timeOfY(y, t, g)));
        return;
      }
      if (d.kind === 'drafthold') {
        const g = this.rollGeom();
        const end = this.snapT(this.timeOfY(y, t, g));
        if (end > d.t0) { d.o.type = 'hold'; d.o.endT = end; } else { d.o.type = 'tap'; delete d.o.endT; }
        return;
      }
      if (d.kind === 'tail') {
        if (this.view() === 'lane') {
          this.setEnd(d.o, this.snapT(this.timeOfLaneX(x, t, this.laneGeom())), false);
        } else if (this.view() === 'roll') {
          const g = this.rollGeom();
          const end = this.snapT(this.timeOfY(y, t, g));
          if (d.o.type === 'slider') this.setJuiceEnd(d.o, clamp((x - g.x0) / g.s, 0, 512), end);
          else this.setEnd(d.o, end);
        }
        return;
      }
      if (d.kind === 'move') {
        const was = d.orig.get(d.primary);
        const view = this.view();
        if (view === 'field') {
          const g = this.fieldGeom();
          const nx = this.gridded(was.x + (x - d.sx) / g.s), ny = this.gridded(was.y + (y - d.sy) / g.s);
          this.applyMove(d, 0, nx - was.x, ny - was.y);
        } else if (view === 'lane') {
          const g = this.laneGeom();
          this.applyMove(d, this.snapT(was.t + (x - d.sx) / this.laneZoom) - was.t, 0, 0);
          void g;
        } else {
          const g = this.rollGeom();
          const dt = this.snapT(was.t + (d.sy - y) / this.rollZoom) - was.t;
          if (this.map.mode === 3) {
            const dc = Math.round((x - d.sx) / g.cw);
            for (const [o, w] of d.orig) {
              o.x = this.colX(clamp(this.colOf({ x: w.x }) + dc, 0, this.map.keys - 1));
              o.t = Math.max(0, w.t + dt);
              if (w.endT != null) o.endT = w.endT + (o.t - w.t);
            }
            this.touch();
          } else {
            const dx = this.gridded(was.x + (x - d.sx) / g.s) - was.x;
            this.applyMove(d, dt, dx, 0);
          }
        }
      }
    }

    stageUp() {
      const d = this.drag;
      this.drag = null;
      if (!d) return;
      if (d.kind === 'box') {
        const t = this.now();
        const [x0, x1] = [Math.min(d.x0, d.x1), Math.max(d.x0, d.x1)];
        const [y0, y1] = [Math.min(d.y0, d.y1), Math.max(d.y0, d.y1)];
        if (x1 - x0 > 3 || y1 - y0 > 3) {
          this.select(this.map.objects.filter(o => {
            const p = this.screenPos(o, t);
            return p && p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
          }), true);
        }
        this.touch();
        return;
      }
      if (d.kind === 'draft') {
        const seg = d.o.segments[0];
        if (Math.hypot(seg.points[1][0] - seg.points[0][0], seg.points[1][1] - seg.points[0][1]) < 12) {
          this.remove([d.o]);
          this.toast('Press and drag to draw a slider');
          return;
        }
        this.commit();
        if (this.opt.advance && !this.playing) this.seek(this.stepT(this.snapT(d.o.endT), 1));
        return;
      }
      if (d.kind === 'move') {
        let changed = false;
        for (const [o, w] of d.orig) if (o.t !== w.t || o.x !== w.x || o.y !== w.y) changed = true;
        if (changed) this.commit();
        return;
      }
      this.commit();
    }

    wheel(e) {
      e.preventDefault();
      const dir = e.deltaY > 0 ? -1 : 1;
      if (e.ctrlKey || e.metaKey) {
        const f = dir > 0 ? 1.2 : 1 / 1.2;
        if (e.currentTarget === this.line) this.zoom = clamp(this.zoom * f, 0.015, 1.2);
        else if (this.view() === 'roll') this.rollZoom = clamp(this.rollZoom * f, 0.05, 1.5);
        else if (this.view() === 'lane') this.laneZoom = clamp(this.laneZoom * f, 0.05, 1.5);
        this.touch();
        return;
      }
      if (this.playing) { this.seek(this.now() + dir * this.redAt(this.now()).beat); return; }
      this.seek(this.stepT(this.t, dir, e.shiftKey ? 1 : this.snap));
    }

    // ---------- Timeline pointer ----------

    linePos(e) {
      const r = this.line.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    lineHit(x, y) {
      if (y > this.LH - 18) return null;
      const t = this.now(), z = this.zoom, cx = this.LW / 2;
      let best = null, bestD = 9;
      for (const o of this.map.objects) {
        const hx = cx + (o.t - t) * z;
        if (o.endT) {
          const ex = cx + (o.endT - t) * z;
          if (Math.abs(x - ex) <= 7) return { o, part: 'tail' };
          if (x >= hx && x <= ex) best = best || { o, part: 'body' };
        }
        const dist = Math.abs(x - hx);
        if (dist < bestD) { bestD = dist; best = { o, part: 'body' }; }
      }
      return best;
    }

    lineDown(e) {
      e.preventDefault();
      this.line.setPointerCapture(e.pointerId);
      const { x, y } = this.linePos(e);
      if (y > this.LH - 18) {
        this.seek(clamp(x / this.LW, 0, 1) * this.duration);
        this.lineDrag = { kind: 'overview' };
        return;
      }
      const hit = this.lineHit(x, y);
      if (e.button === 2) {
        if (hit) { this.remove([hit.o]); this.commit(); }
        return;
      }
      if (hit) {
        if (!this.selection.has(hit.o)) this.select([hit.o], e.shiftKey);
        if (hit.part === 'tail') this.lineDrag = { kind: 'tail', o: hit.o };
        else {
          this.beginMove(x, y, hit.o);
          this.lineDrag = { kind: 'move', d: this.drag, moved: false };
          this.drag = null;
        }
        return;
      }
      this.lineDrag = { kind: 'pan', sx: x, t0: this.now(), moved: false };
    }

    lineMove(e) {
      const { x, y } = this.linePos(e);
      const d = this.lineDrag;
      if (!d) {
        const hit = this.lineHit(x, y);
        this.line.style.cursor = y > this.LH - 18 ? 'pointer' : hit ? (hit.part === 'tail' ? 'ew-resize' : 'grab') : 'default';
        return;
      }
      if (d.kind === 'overview') { this.seek(clamp(x / this.LW, 0, 1) * this.duration); return; }
      if (d.kind === 'pan') {
        if (Math.abs(x - d.sx) > 3) d.moved = true;
        if (d.moved && !this.playing) this.seek(d.t0 - (x - d.sx) / this.zoom);
        return;
      }
      const at = this.now() + (x - this.LW / 2) / this.zoom;
      if (d.kind === 'tail') {
        this.setEnd(d.o, this.snapT(at));
        this.touch();
        return;
      }
      if (d.kind === 'move') {
        const was = d.d.orig.get(d.d.primary);
        const dt = this.snapT(was.t + (x - d.d.sx) / this.zoom) - was.t;
        this.applyMove(d.d, dt, 0, 0);
        d.moved = dt !== 0;
      }
    }

    lineUp(e) {
      const d = this.lineDrag;
      this.lineDrag = null;
      if (!d) return;
      if (d.kind === 'pan') {
        if (!d.moved) {
          const { x } = this.linePos(e);
          this.select([]);
          this.seek(this.snapT(d.t0 + (x - this.LW / 2) / this.zoom));
        } else if (!this.playing) this.t = this.snapT(this.t);
      } else if (d.kind === 'tail' || (d.kind === 'move' && d.moved)) this.commit();
      this.touch();
    }

    // ---------- Keyboard ----------

    keyDown(e) {
      if ($('ed-help') && !$('ed-help').classList.contains('hidden')) {
        if (e.key === 'Escape' || e.key === '?') { $('ed-help').classList.add('hidden'); e.preventDefault(); }
        return;
      }
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      const ctrl = e.ctrlKey || e.metaKey;

      if (this.record && this.playing && !ctrl && !e.repeat && this.recordKey(e.code)) {
        e.preventDefault();
        return;
      }
      if (ctrl) {
        const k = e.key.toLowerCase();
        if (k === 'z') { e.preventDefault(); this.restore(e.shiftKey ? 1 : -1); }
        else if (k === 'y') { e.preventDefault(); this.restore(1); }
        else if (k === 'c') { e.preventDefault(); this.copy(); }
        else if (k === 'x') { e.preventDefault(); this.copy(); this.deleteSelected(); }
        else if (k === 'v') { e.preventDefault(); this.paste(); }
        else if (k === 'a') { e.preventDefault(); this.select(this.map.objects); }
        else if (k === 's') { e.preventDefault(); this.flushSave(); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); this.nudgeSelection(-1); }
        else if (e.key === 'ArrowRight') { e.preventDefault(); this.nudgeSelection(1); }
        return;
      }
      const num = parseInt(e.key, 10);
      if (num >= 1 && num <= this.tools().length) { this.setTool(this.tools()[num - 1].id); return; }

      switch (e.key) {
        case ' ': e.preventDefault(); this.toggle(); return;
        case 'ArrowLeft': e.preventDefault(); this.seek(this.stepT(this.now(), -1)); return;
        case 'ArrowRight': e.preventDefault(); this.seek(this.stepT(this.now(), 1)); return;
        case 'ArrowUp': e.preventDefault(); this.seek(this.stepT(this.now(), 1, 1)); return;
        case 'ArrowDown': e.preventDefault(); this.seek(this.stepT(this.now(), -1, 1)); return;
        case 'Home': this.seek(0); return;
        case 'End': this.seek(this.duration); return;
        case 'Delete': case 'Backspace': e.preventDefault(); this.deleteSelected(); return;
        case 'Escape':
          if (this.record) this.setRecord(false);
          else this.select([]);
          return;
        case '[': this.changeSnap(-1); return;
        case ']': this.changeSnap(1); return;
        case '?': $('ed-help').classList.remove('hidden'); return;
        default:
      }
      switch (e.key.toLowerCase()) {
        case 'r': this.setRecord(!this.record); break;
        case 't': this.test(e.shiftKey); break;
        case 'n': this.toggleCombo(); break;
        case 'b': if (this.map.mode === 1) this.setBig(!this.opt.big); break;
        case 'g': this.setOpt('grid', !this.opt.grid); break;
        case 'h': this.setOpt('hits', !this.opt.hits); break;
        case 'm': this.setOpt('metro', !this.opt.metro); break;
        default:
      }
    }

    keyUp(e) { this.recordKeyUp(e.code); }

    changeSnap(dir) {
      const at = SNAPS.indexOf(this.snap);
      this.setSnap(SNAPS[clamp(at + dir, 0, SNAPS.length - 1)]);
    }

    setSnap(div) { this.snap = div; this.syncTools(); this.touch(); }

    setOpt(key, on) { this.opt[key] = on; this.syncTools(); this.touch(); }

    // ---------- Record mode: tap along with the song ----------

    setRecord(on) {
      this.record = on;
      if (on && !this.playing) this.play();
      if (!on) { this.endRecordHolds(this.now()); if (this.recordDirty && !this.playing) { this.recordDirty = false; this.commit(); } }
      this.syncButtons();
      this.touch();
    }

    recordKeys() {
      const mode = this.map.mode;
      if (mode === 1) return ['KeyD', 'KeyF', 'KeyJ', 'KeyK'];
      if (mode === 3) return P.maniaKeys(this.map.keys);
      return ['KeyZ', 'KeyX'];
    }

    recordKey(code) {
      if (!this.recordKeys().includes(code)) return false;
      const mode = this.map.mode;
      const at = this.snapT(this.now());
      if (at < 0) return true;
      this.recordDirty = true;
      if (mode === 1) {
        const o = this.placeTap(at, 256, 192, { kat: code === 'KeyD' || code === 'KeyK' });
        if (o) this.click(this.ctx.currentTime, this.soundFor(o));
      } else if (mode === 3) {
        const col = this.recordKeys().indexOf(code);
        const o = this.placeTap(at, this.colX(col), 192);
        if (o) { this.recordHolds.set(code, o); this.click(this.ctx.currentTime, 'hit'); }
      } else {
        this.placeTap(at, Math.round(this.cursor.x), mode === 2 ? 192 : Math.round(this.cursor.y));
        this.click(this.ctx.currentTime, 'hit');
      }
      return true;
    }

    recordKeyUp(code) {
      const o = this.recordHolds.get(code);
      if (!o) return;
      this.recordHolds.delete(code);
      this.finishHold(o, this.now());
    }

    finishHold(o, at) {
      const end = this.snapT(at);
      // A press shorter than half a beat is a tap, not a hold.
      if (end - o.t >= this.redAt(o.t).beat / 2) { o.type = 'hold'; o.endT = end; this.touch(); }
    }

    endRecordHolds(at) {
      this.recordHolds.forEach(o => this.finishHold(o, at));
      this.recordHolds.clear();
    }

    // ---------- Test play and export ----------

    playableMap() {
      const m = P.parseBeatmapText(P.serializeMap(this.map), { allowEmpty: true });
      return m;
    }

    test(auto) {
      if (!this.map.objects.length) { this.toast('Place some notes first, then test them.'); return; }
      const at = this.now();
      this.pause(false);
      const from = this.map.objects.some(o => o.t >= at - 1) ? at : 0;
      this.t = at;
      this.active = false;
      this.hooks.test(this.playableMap(), from, !!auto);
    }

    resumeFromTest(message) {
      this.active = true;
      if (message) this.toast(message);
      this.resize();
      this.touch();
      requestAnimationFrame(this.tick);
    }

    close() {
      this.active = false;
      this.pause(false);
      clearTimeout(this.toastTimer);
      return this.flushSave();
    }

    // ---------- Chrome ----------

    buildChrome() {
      this.canvas = $('ed-canvas');
      this.line = $('ed-line');
      this.c = this.canvas.getContext('2d');
      this.lc = this.line.getContext('2d');

      const mode = this.map.mode;
      const name = MODE_NAMES[mode] + (mode === 3 ? ` ${this.map.keys}K` : '');
      $('ed-mode').textContent = name;
      this.syncTitle();

      const tools = $('ed-tools');
      tools.textContent = '';
      this.tools().forEach((tool, i) => {
        const b = h('button', {
          class: 'tool', 'data-tool': tool.id, 'aria-pressed': 'false', title: tool.label,
          onclick: () => this.setTool(tool.id),
        },
        tool.swatch ? h('span', { class: 'swatch', style: `background:${tool.swatch}` }) : icon(tool.icon),
        h('span', { class: 'tool-name' }, tool.label),
        h('kbd', {}, String(i + 1)));
        tools.append(b);
      });

      const snaps = $('ed-snaps');
      snaps.textContent = '';
      SNAPS.forEach(div => {
        snaps.append(h('button', { class: 'snap', 'data-div': div, 'aria-pressed': 'false', onclick: () => this.setSnap(div) }, `1/${div}`));
      });

      const rate = $('ed-rate');
      rate.textContent = '';
      RATES.forEach(r => rate.append(h('button', { class: 'rate', 'data-rate': r, 'aria-pressed': 'false', onclick: () => this.setRate(r) }, `${r * 100}%`)));

      const opts = [
        ['advance', 'Next beat after placing', mode === 0],
        ['grid', 'Snap to grid', mode === 0 || mode === 2, 'G'],
        ['big', 'Big notes', mode === 1, 'B'],
        ['hits', 'Hit sounds', true, 'H'],
        ['metro', 'Metronome', true, 'M'],
      ];
      const box = $('ed-opts');
      box.textContent = '';
      opts.filter(o => o[2]).forEach(([key, label, , k]) => {
        const input = h('input', { type: 'checkbox', 'data-opt': key });
        input.addEventListener('change', () => { if (key === 'big') this.setBig(input.checked); else this.setOpt(key, input.checked); input.blur(); });
        box.append(h('label', { class: 'switch' }, input, h('span', { class: 'track' }), h('span', {}, label), k ? h('kbd', {}, k) : null));
      });

      $('ed-hint-keys').textContent = this.recordKeys().map(k => P.keyLabel(k)).join(' ');
      this.tool = this.tools()[1].id;
      this.syncTools();
      this.syncButtons();
      this.syncTabs();
      $('ed-toast').classList.add('hidden');
      $('ed-saved').textContent = 'All changes saved';
    }

    syncTitle() {
      $('ed-title').textContent = `${this.map.artist} – ${this.map.title}`;
      $('ed-version').textContent = this.map.version;
    }

    syncTools() {
      document.querySelectorAll('#ed-tools .tool').forEach(b => {
        b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool));
      });
      document.querySelectorAll('#ed-snaps .snap').forEach(b => {
        b.setAttribute('aria-pressed', String(Number(b.dataset.div) === this.snap));
      });
      document.querySelectorAll('#ed-opts input').forEach(i => { i.checked = !!this.opt[i.dataset.opt]; });
      const tool = this.tools().find(t => t.id === this.tool);
      $('ed-hint').textContent = tool ? tool.hint : '';
    }

    syncButtons() {
      $('ed-play').setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
      $('ed-play-icon').setAttribute('href', this.playing ? '#i-pause' : '#i-play');
      $('ed-undo').disabled = this.historyAt <= 0;
      $('ed-redo').disabled = this.historyAt >= this.history.length - 1;
      $('ed-record').setAttribute('aria-pressed', String(this.record));
      document.querySelectorAll('#ed-rate .rate').forEach(b => {
        b.setAttribute('aria-pressed', String(Number(b.dataset.rate) === this.rate));
      });
      $('ed-rec-banner').classList.toggle('hidden', !this.record);
    }

    syncTabs() {
      document.querySelectorAll('#ed-tabs button').forEach(b => {
        b.setAttribute('aria-selected', String(b.dataset.tab === this.tab));
      });
    }

    setTab(tab) {
      this.tab = tab;
      this.syncTabs();
      this.renderPanel();
    }

    // ---------- Side panel ----------

    renderPanel() {
      const panel = $('ed-panel-body');
      const active = document.activeElement;
      if (active && panel.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;
      panel.textContent = '';
      if (this.tab === 'note') this.panelNote(panel);
      else if (this.tab === 'timing') this.panelTiming(panel);
      else this.panelMap(panel);
    }

    panelNote(panel) {
      const list = [...this.selection].sort((a, b) => a.t - b.t);
      if (!list.length) {
        panel.append(
          h('p', { class: 'panel-empty' }, `${this.map.objects.length} ${this.map.objects.length === 1 ? 'note' : 'notes'} in this map. Select one to change it.`),
          h('button', { class: 'btn wide', onclick: () => this.snapAll() }, `Snap every note to 1/${this.snap}`),
        );
        return;
      }
      const o = list[0], mode = this.map.mode;
      const names = { tap: ['Note', 'Hit', 'Fruit', 'Note'][mode], slider: ['Slider', 'Roll', 'Juice', 'Slider'][mode], spin: ['Spinner', 'Swell', 'Bananas', 'Spinner'][mode], hold: 'Hold note' };
      panel.append(h('h3', { class: 'panel-head' }, list.length === 1 ? names[o.type] : `${list.length} selected`));

      const row = (label, value) => h('div', { class: 'kv' }, h('span', {}, label), h('b', {}, value));
      panel.append(row('Starts', fmtTime(o.t)));
      if (list.length === 1 && o.endT) {
        panel.append(row('Length', `${((o.endT - o.t) / this.redAt(o.t).beat).toFixed(2)} beats`));
      }

      panel.append(h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => this.nudgeSelection(-1), title: `Earlier by 1/${this.snap} beat` }, 'Earlier'),
        h('button', { class: 'btn', onclick: () => this.nudgeSelection(1), title: `Later by 1/${this.snap} beat` }, 'Later')));

      if (mode === 1) {
        const taps = list.filter(q => q.type === 'tap');
        if (taps.length) {
          panel.append(h('div', { class: 'btn-row' },
            h('button', { class: 'btn', 'aria-pressed': String(taps.every(q => !(q.hitSound & 10))), onclick: () => { taps.forEach(q => this.setKat(q, false)); this.commit(); } }, 'Center'),
            h('button', { class: 'btn', 'aria-pressed': String(taps.every(q => q.hitSound & 10)), onclick: () => { taps.forEach(q => this.setKat(q, true)); this.commit(); } }, 'Rim')));
        }
        panel.append(h('button', {
          class: 'btn wide', 'aria-pressed': String(list.every(q => q.hitSound & 4)),
          onclick: () => { const on = !list.every(q => q.hitSound & 4); list.forEach(q => { q.hitSound = on ? q.hitSound | 4 : q.hitSound & ~4; }); this.commit(); },
        }, 'Big note'));
      }
      if (mode === 0 || mode === 2) {
        panel.append(h('button', { class: 'btn wide', 'aria-pressed': String(list.every(q => q.newCombo)), onclick: () => this.toggleCombo() }, h('span', {}, 'New combo '), h('kbd', {}, 'N')));
      }
      if (list.length === 1 && o.type === 'slider' && mode !== 1) {
        panel.append(h('div', { class: 'stepper' },
          h('span', {}, 'Passes back and forth'),
          h('button', { class: 'btn', 'aria-label': 'Fewer passes', onclick: () => this.setRepeats(o, o.slides - 1) }, '−'),
          h('b', {}, String(o.slides)),
          h('button', { class: 'btn', 'aria-label': 'More passes', onclick: () => this.setRepeats(o, o.slides + 1) }, '+')));
      }
      if (mode === 0) {
        panel.append(h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => this.flip(true) }, 'Flip across'),
          h('button', { class: 'btn', onclick: () => this.flip(false) }, 'Flip down')));
      }
      panel.append(h('button', { class: 'btn wide danger', onclick: () => this.deleteSelected() }, 'Delete'));
    }

    panelTiming(panel) {
      const r = this.redAt(this.now());
      const bpm = Math.round(60000 / r.beat * 100) / 100;
      const bpmInput = h('input', { type: 'number', id: 'ed-bpm', min: 10, max: 1000, step: 0.01, value: bpm });
      bpmInput.addEventListener('change', () => {
        const v = parseFloat(bpmInput.value);
        bpmInput.blur();
        if (v >= 10 && v <= 1000) this.setBpm(r, v); else this.renderPanel();
      });
      const offInput = h('input', { type: 'number', id: 'ed-offset', step: 1, value: Math.round(r.t) });
      offInput.addEventListener('change', () => {
        const v = parseFloat(offInput.value);
        offInput.blur();
        if (Number.isFinite(v)) { r.t = v; this.refreshAll(); this.commit(); } else this.renderPanel();
      });
      const nudge = d => h('button', { class: 'btn small', onclick: () => { r.t += d; this.refreshAll(); this.commit(); } }, d > 0 ? `+${d}` : `−${-d}`);

      panel.append(
        h('h3', { class: 'panel-head' }, 'Tempo'),
        h('label', { class: 'bigfield' }, h('span', {}, 'BPM'), bpmInput),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: () => this.setBpm(r, bpm / 2) }, '÷ 2'),
          h('button', { class: 'btn', onclick: () => this.setBpm(r, bpm * 2) }, '× 2')),
        h('button', { class: 'btn wide', id: 'ed-tap', onclick: () => this.tapTempo(r) }, 'Tap along to set BPM'),
        h('button', { class: 'btn wide', onclick: () => this.detect() }, 'Find BPM from the song'),
        h('h3', { class: 'panel-head' }, 'Where the beat starts'),
        h('button', { class: 'btn wide primary-soft', onclick: () => this.setFirstBeat(r) }, 'A bar starts at the playhead'),
        h('label', { class: 'field-inline' }, h('span', {}, 'Offset (ms)'), offInput),
        h('div', { class: 'btn-row four' }, nudge(-5), nudge(-1), nudge(1), nudge(5)),
        h('p', { class: 'panel-note' }, 'Turn on the metronome and listen. The clicks should land on the song\'s beat.'),
      );
      const metro = h('input', { type: 'checkbox' });
      metro.checked = this.opt.metro;
      metro.addEventListener('change', () => { this.setOpt('metro', metro.checked); metro.blur(); });
      panel.append(h('label', { class: 'switch' }, metro, h('span', { class: 'track' }), h('span', {}, 'Metronome'), h('kbd', {}, 'M')));

      panel.append(h('h3', { class: 'panel-head' }, 'Changes in this song'));
      const list = h('ul', { class: 'points' });
      this.map.timing.slice().sort((a, b) => a.t - b.t).forEach(p => {
        const label = p.uninherited ? `${(60000 / p.beat).toFixed(2).replace(/\.00$/, '')} BPM` : `${(p.beat < 0 ? -100 / p.beat : 1).toFixed(2)}× speed`;
        const reds = this.reds();
        list.append(h('li', { class: p.uninherited ? 'red' : 'green' },
          h('button', { class: 'point-jump', onclick: () => this.seek(p.t), title: 'Jump here' }, h('span', {}, fmtTime(p.t)), p.uninherited ? h('b', {}, label) : null),
          p.uninherited ? null : this.speedInput(p),
          (p.uninherited && reds.length === 1) ? null : h('button', {
            class: 'point-x', 'aria-label': `Remove ${label}`,
            onclick: () => { this.map.timing = this.map.timing.filter(q => q !== p); this.refreshAll(); this.commit(); },
          }, '×')));
      });
      panel.append(list);
      panel.append(h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => this.addPoint(true) }, 'Tempo change here'),
        h('button', { class: 'btn', onclick: () => this.addPoint(false) }, 'Speed change here')));
    }

    speedInput(p) {
      const input = h('input', { class: 'point-speed', type: 'number', min: 0.1, max: 10, step: 0.05, value: (p.beat < 0 ? -100 / p.beat : 1).toFixed(2), 'aria-label': 'Slider speed multiplier', title: 'Slider speed. 1 is normal, 2 is twice as fast.' });
      input.addEventListener('change', () => {
        const v = parseFloat(input.value);
        input.blur();
        if (v > 0) { p.beat = -100 / v; this.refreshAll(); this.commit(); } else this.renderPanel();
      });
      return input;
    }

    addPoint(red) {
      const at = this.snapT(this.now());
      const cur = this.redAt(at);
      if (this.map.timing.some(p => near(p.t, at, 1) && p.uninherited === red)) { this.toast('There is already a change at this spot.'); return; }
      this.map.timing.push({ t: at, beat: red ? cur.beat : -100 / this.svAt(at), uninherited: red, meter: cur.meter || 4, sampleSet: cur.sampleSet || 0, sampleIndex: cur.sampleIndex || 0, volume: cur.volume == null ? 70 : cur.volume, effects: 0 });
      this.commit();
    }

    setBpm(r, bpm) {
      r.beat = 60000 / bpm;
      if (this.reds()[0] === r) { this.map.beatMs = r.beat; this.map.beatZero = r.t; }
      this.refreshAll();
      this.commit();
    }

    setFirstBeat(r) {
      const bar = r.beat * (r.meter || 4);
      let at = Math.round(this.now());
      // The first tempo reaches back to the start, so the grid covers any intro too.
      if (this.reds()[0] === r) while (at - bar >= 0) at -= bar;
      r.t = Math.round(at);
      this.refreshAll();
      this.commit();
      this.toast('Grid lined up with the playhead');
    }

    tapTempo(r) {
      const now = performance.now();
      if (this.taps.length && now - this.taps[this.taps.length - 1] > 2000) this.taps = [];
      this.taps.push(now);
      if (this.taps.length > 16) this.taps.shift();
      const btn = $('ed-tap');
      if (this.taps.length < 4) {
        if (btn) btn.textContent = `Keep tapping… ${this.taps.length}`;
        return;
      }
      const span = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
      const bpm = Math.round(60000 / span * 10) / 10;
      r.beat = 60000 / bpm;
      this.refreshAll();
      const count = this.taps.length;
      this.commit();
      const after = $('ed-tap');
      if (after) { after.textContent = `${bpm} BPM from ${count} taps`; after.focus(); }
    }

    detect() {
      this.toast('Listening to the song…');
      setTimeout(() => {
        const found = P.detectTempo(this.audio.getChannelData(0), this.audio.sampleRate);
        if (!found) { this.toast('Could not find a steady beat. Try tapping along instead.'); return; }
        const r = this.redAt(this.now());
        r.beat = 60000 / found.bpm;
        r.t = found.offset;
        this.refreshAll();
        this.commit();
        this.toast(`Found ${found.bpm} BPM. Turn on the metronome to check it.`);
      }, 30);
    }

    panelMap(panel) {
      const m = this.map;
      const text = (label, key) => {
        const input = h('input', { type: 'text', value: m[key] || '' });
        input.addEventListener('change', () => { m[key] = input.value.trim() || m[key]; input.blur(); this.syncTitle(); this.commit(); });
        return h('label', { class: 'field-stack' }, h('span', {}, label), input);
      };
      panel.append(
        h('h3', { class: 'panel-head' }, 'Song'),
        text('Title', 'title'), text('Artist', 'artist'), text('Mapped by', 'creator'), text('Difficulty name', 'version'),
        h('h3', { class: 'panel-head' }, 'Difficulty'),
      );
      const slide = (label, help, key, min = 0, max = 10, step = 0.1) => {
        const out = h('output', {}, String(m[key]));
        const input = h('input', { type: 'range', min, max, step, value: m[key] });
        input.addEventListener('input', () => { m[key] = parseFloat(input.value); out.textContent = input.value; if (key === 'multiplier') this.refreshAll(); this.touch(); });
        input.addEventListener('change', () => { input.blur(); this.commit(); });
        return h('label', { class: 'slide' }, h('span', { class: 'slide-top' }, h('span', {}, label), out), input, h('small', {}, help));
      };
      const mode = m.mode;
      if (mode === 3) {
        panel.append(h('div', { class: 'stepper' }, h('span', {}, 'Keys'),
          h('button', { class: 'btn', 'aria-label': 'Fewer keys', onclick: () => this.setKeys(m.keys - 1) }, '−'),
          h('b', {}, String(m.keys)),
          h('button', { class: 'btn', 'aria-label': 'More keys', onclick: () => this.setKeys(m.keys + 1) }, '+')));
      }
      if (mode === 0 || mode === 2) panel.append(slide('Note size', 'CS. Higher means smaller notes.', 'cs'));
      if (mode === 0 || mode === 2) panel.append(slide('Approach speed', 'AR. Higher means notes appear later.', 'ar'));
      panel.append(slide('Timing strictness', 'OD. Higher means tighter timing.', 'od'));
      panel.append(slide('Health drain', 'HP. Higher means misses cost more.', 'hp'));
      if (mode !== 3) panel.append(slide(mode === 2 ? 'Juice speed' : mode === 1 ? 'Scroll speed' : 'Slider speed', 'Slider velocity. Existing lengths stay the same.', 'multiplier', 0.4, 3.6, 0.1));

      panel.append(h('h3', { class: 'panel-head' }, 'Background'),
        h('p', { class: 'panel-note' }, m.bgFile || 'No image yet.'),
        h('button', { class: 'btn wide', onclick: () => $('ed-bg-file').click() }, m.bgFile ? 'Change image' : 'Choose image'));
    }

    setKeys(n) {
      const keys = clamp(n, 1, 18);
      if (keys === this.map.keys) return;
      this.map.keys = keys;
      this.map.cs = keys;
      this.buildChrome();
      this.commit();
    }

    async setBackground(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        this.bg = await createImageBitmap(new Blob([bytes]));
      } catch (e) {
        this.toast('That image could not be read.');
        return;
      }
      const raw = this.map.raw;
      const line = `0,0,"${file.name.replace(/"/g, '')}",0,0`;
      const at = raw.events.findIndex(l => /^0\s*,\s*0\s*,/.test(l.trim()));
      if (at >= 0) raw.events[at] = line; else raw.events.unshift(line);
      this.map.bgFile = file.name;
      await this.hooks.saveBackground(file.name, bytes);
      this.commit();
    }

    // ---------- Drawing ----------

    touch() { this.dirty = true; }

    resize() {
      const dpr = window.devicePixelRatio || 1;
      this.dpr = dpr;
      const a = this.canvas.parentElement.getBoundingClientRect();
      this.W = Math.max(50, a.width);
      this.H = Math.max(50, a.height);
      this.canvas.width = Math.round(this.W * dpr);
      this.canvas.height = Math.round(this.H * dpr);
      const b = this.line.parentElement.getBoundingClientRect();
      this.LW = Math.max(50, b.width);
      this.LH = Math.max(40, b.height);
      this.line.width = Math.round(this.LW * dpr);
      this.line.height = Math.round(this.LH * dpr);
      this.density = null;
      this.touch();
    }

    tick() {
      if (!this.active) return;
      requestAnimationFrame(this.tick);
      if (this.playing) {
        this.scheduleSounds();
        if (this.audioNow() >= this.duration) { this.pause(false); this.t = this.duration; this.record = false; this.syncButtons(); }
      }
      if (!this.playing && !this.dirty) return;
      this.dirty = false;
      const t = this.now();
      const c = this.c, d = this.dpr;
      c.setTransform(d, 0, 0, d, 0, 0);
      c.clearRect(0, 0, this.W, this.H);
      const view = this.view();
      if (view === 'field') this.drawField(c, t);
      else if (view === 'lane') this.drawLane(c, t);
      else this.drawRoll(c, t);
      if (this.drag && this.drag.kind === 'box') {
        const b = this.drag;
        c.fillStyle = 'rgba(216,255,62,0.1)';
        c.strokeStyle = ACID;
        c.lineWidth = 1;
        c.fillRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
        c.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
      }
      this.drawLine(this.lc, t);
      const label = fmtTime(t);
      if ($('ed-time').textContent !== label) $('ed-time').textContent = label;
      const r = this.redAt(t);
      const beatIdx = (t - r.t) / r.beat;
      const bar = Math.floor(beatIdx / (r.meter || 4)) + 1;
      const inBar = Math.floor(((beatIdx % (r.meter || 4)) + (r.meter || 4)) % (r.meter || 4)) + 1;
      const pos = `Bar ${bar}, beat ${inBar}  ·  ${(60000 / r.beat).toFixed(2).replace(/\.00$/, '')} BPM`;
      if ($('ed-pos').textContent !== pos) $('ed-pos').textContent = pos;
      $('ed-empty').classList.toggle('hidden', this.map.objects.length > 0 || this.playing);
    }

    drawBackdrop(c) {
      if (!this.bg) return;
      const k = Math.max(this.W / this.bg.width, this.H / this.bg.height);
      c.globalAlpha = 0.14;
      c.drawImage(this.bg, (this.W - this.bg.width * k) / 2, (this.H - this.bg.height * k) / 2, this.bg.width * k, this.bg.height * k);
      c.globalAlpha = 1;
    }

    label(c, text, x, y, color = MUTE, size = 12, align = 'left') {
      c.font = `500 ${size}px ${MONO}`;
      c.textAlign = align;
      c.textBaseline = 'middle';
      c.fillStyle = color;
      c.fillText(text, x, y);
    }

    // Standard: the true playfield, showing what a player sees at this moment.
    drawField(c, t) {
      this.drawBackdrop(c);
      const g = this.fieldGeom(), s = g.s;
      c.save();
      c.translate(g.ox, g.oy);
      c.scale(s, s);
      c.fillStyle = 'rgba(255,255,255,0.025)';
      c.fillRect(0, 0, 512, 384);
      c.strokeStyle = 'rgba(255,255,255,0.14)';
      c.lineWidth = 1 / s;
      c.strokeRect(0, 0, 512, 384);
      if (this.opt.grid) {
        c.strokeStyle = 'rgba(255,255,255,0.06)';
        c.beginPath();
        for (let x = 32; x < 512; x += 32) { c.moveTo(x, 0); c.lineTo(x, 384); }
        for (let y = 32; y < 384; y += 32) { c.moveTo(0, y); c.lineTo(512, y); }
        c.stroke();
      }
      const pre = this.preempt(), r = this.radius();
      const list = this.map.objects.filter(o => this.selection.has(o) || (t >= o.t - pre && t <= (o.endT || o.t) + 700));
      for (let i = list.length - 1; i >= 0; i--) this.drawFieldObject(c, list[i], t, pre, r, s);

      const single = this.singleSlider();
      if (single) this.drawHandles(c, single, s);

      if (this.cursor.inside && !this.drag && (this.tool === 'note' || this.tool === 'slider') && !this.record) {
        const gx = this.gridded(this.cursor.x), gy = this.gridded(this.cursor.y);
        hexPath(c, gx, gy, r, Math.PI / 6);
        c.strokeStyle = 'rgba(216,255,62,0.5)';
        c.lineWidth = 2;
        c.stroke();
      }
      if (this.record) {
        hexPath(c, this.cursor.x, this.cursor.y, 10, Math.PI / 6);
        c.strokeStyle = '#ff4d5e';
        c.lineWidth = 2;
        c.stroke();
      }
      c.restore();

      if (this.drag && this.drag.kind === 'draft') {
        const o = this.drag.o;
        const beats = (o.endT - o.t) / this.redAt(o.t).beat;
        this.label(c, `${beats.toFixed(2).replace(/\.?0+$/, '')} ${beats === 1 ? 'beat' : 'beats'}`, this.cursor.sx + 16, this.cursor.sy - 14, ACID, 13);
      }
    }

    drawFieldObject(c, o, t, pre, r, s) {
      const end = o.endT || o.t;
      const selected = this.selection.has(o);
      let a;
      if (t < o.t - pre) a = 0.18;
      else if (t < o.t) a = Math.min(1, (t - o.t + pre) / (pre * 0.4));
      else if (t <= end + 1) a = 1;
      else a = Math.max(0.18, 0.5 - (t - end) / 1500);
      if (selected) a = Math.max(a, 0.6);
      const color = COLORS[(o.color || 0) % 4];
      c.globalAlpha = a;

      if (o.type === 'spin') {
        const active = t >= o.t && t <= end;
        hexPath(c, 256, 192, 150, t / 900);
        c.strokeStyle = selected ? SEL : active ? ROLL : 'rgba(243,240,231,0.5)';
        c.lineWidth = selected ? 4 : 3;
        c.stroke();
        c.globalAlpha = 1;
        c.font = `600 16px ${FONT}`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillStyle = selected ? SEL : BONE;
        c.fillText(`Spinner · ${((end - o.t) / this.redAt(o.t).beat).toFixed(1)} beats`, 256, 192);
        return;
      }

      if (o.type === 'slider' && o.path && o.path.pts.length > 1) {
        const line = () => {
          c.beginPath();
          o.path.pts.forEach((p, i) => (i === 0 ? c.moveTo(p[0], p[1]) : c.lineTo(p[0], p[1])));
        };
        c.lineJoin = 'round';
        c.lineCap = 'round';
        line();
        c.strokeStyle = selected ? SEL : 'rgba(243,240,231,0.85)';
        c.lineWidth = r * 1.72;
        c.stroke();
        line();
        c.strokeStyle = '#17151e';
        c.lineWidth = r * 1.58;
        c.stroke();
        line();
        c.strokeStyle = color;
        c.globalAlpha = a * 0.32;
        c.stroke();
        c.globalAlpha = a;
        const tail = o.path.pts[o.path.pts.length - 1];
        hexPath(c, tail[0], tail[1], r * 0.72, Math.PI / 6);
        c.strokeStyle = 'rgba(243,240,231,0.6)';
        c.lineWidth = 2;
        c.stroke();
        if (o.slides > 1) {
          c.font = `700 ${r * 0.55}px ${FONT}`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillStyle = BONE;
          c.fillText(`×${o.slides}`, tail[0], tail[1]);
        }
        if (t >= o.t && t <= end) {
          const ball = P.sliderPos(o, t);
          hexPath(c, ball[0], ball[1], r * 0.8, t / 120);
          c.fillStyle = BONE;
          c.fill();
        }
      }

      if (selected) {
        hexPath(c, o.x, o.y, r + 7, Math.PI / 6);
        c.strokeStyle = SEL;
        c.lineWidth = 2;
        c.stroke();
      }
      hexPath(c, o.x, o.y, r, Math.PI / 6);
      c.fillStyle = '#17151e';
      c.fill();
      c.lineWidth = selected ? 5 : 3.5;
      c.strokeStyle = selected ? SEL : color;
      c.stroke();
      hexPath(c, o.x, o.y, r * 0.72, Math.PI / 6);
      c.fillStyle = color;
      c.globalAlpha = a * 0.28;
      c.fill();
      c.globalAlpha = a;
      c.font = `700 ${r * 0.72}px ${FONT}`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = BONE;
      c.fillText(String(o.num || ''), o.x, o.y + 1);

      if (t < o.t && t >= o.t - pre) {
        const k = (o.t - t) / pre;
        hexPath(c, o.x, o.y, r * (1 + k * 2.2), Math.PI / 6);
        c.lineWidth = 2;
        c.strokeStyle = color;
        c.stroke();
      }
      c.globalAlpha = 1;
    }

    drawHandles(c, o, s) {
      const list = this.handles(o);
      c.lineWidth = 1.2 / s;
      c.strokeStyle = 'rgba(216,255,62,0.6)';
      c.setLineDash([4 / s, 4 / s]);
      c.beginPath();
      list.forEach((p, i) => (i === 0 ? c.moveTo(p[0], p[1]) : c.lineTo(p[0], p[1])));
      c.stroke();
      c.setLineDash([]);
      const size = 6 / s;
      for (let i = 0; i + 1 < list.length; i++) {
        const mx = (list[i][0] + list[i + 1][0]) / 2, my = (list[i][1] + list[i + 1][1]) / 2;
        c.beginPath();
        c.arc(mx, my, size, 0, Math.PI * 2);
        c.fillStyle = '#17151e';
        c.fill();
        c.strokeStyle = ACID;
        c.lineWidth = 1.5 / s;
        c.stroke();
        c.beginPath();
        c.moveTo(mx - size * 0.55, my); c.lineTo(mx + size * 0.55, my);
        c.moveTo(mx, my - size * 0.55); c.lineTo(mx, my + size * 0.55);
        c.stroke();
      }
      list.forEach(p => {
        c.fillStyle = ACID;
        c.fillRect(p[0] - size, p[1] - size, size * 2, size * 2);
        c.strokeStyle = '#09080d';
        c.lineWidth = 1 / s;
        c.strokeRect(p[0] - size, p[1] - size, size * 2, size * 2);
      });
    }

    // Taiko: time runs left to right past a fixed playhead.
    drawLane(c, t) {
      this.drawBackdrop(c);
      const g = this.laneGeom(), W = this.W, top = g.y - g.h / 2;
      c.fillStyle = 'rgba(255,255,255,0.03)';
      c.fillRect(0, top, W, g.h);
      c.fillStyle = 'rgba(255,255,255,0.14)';
      c.fillRect(0, top, W, 1);
      c.fillRect(0, top + g.h, W, 1);

      const t0 = this.timeOfLaneX(-40, t, g), t1 = this.timeOfLaneX(W + 40, t, g);
      this.forTicks(t0, t1, this.snap, (time, k, r) => {
        const s = tickStyle(k, this.snap, r.meter || 4);
        c.fillStyle = s.color;
        const inset = s.level === 0 ? 0 : s.level === 1 ? g.h * 0.12 : g.h * 0.28;
        c.fillRect(Math.round(this.laneX(time, t, g)), top + inset, 1, g.h - inset * 2);
        if (s.level === 0) this.label(c, `Bar ${Math.floor(k / this.snap / (r.meter || 4)) + 1}`, this.laneX(time, t, g) + 5, top - 10);
      });

      const vis = this.map.objects.filter(o => (o.endT || o.t) >= t0 && o.t <= t1);
      for (let i = vis.length - 1; i >= 0; i--) {
        const o = vis[i];
        const x = this.laneX(o.t, t, g), big = !!(o.hitSound & 4), r = big ? 34 : 24;
        const selected = this.selection.has(o);
        if (o.endT) {
          const ex = this.laneX(o.endT, t, g), color = o.type === 'spin' ? SWELL : ROLL;
          c.fillStyle = color;
          c.globalAlpha = 0.85;
          c.beginPath();
          c.roundRect(x - r * 0.8, g.y - r * 0.8, Math.max(4, ex - x + r * 0.8), r * 1.6, 8);
          c.fill();
          c.globalAlpha = 1;
          c.fillStyle = '#17151e';
          c.fillRect(ex - 3, g.y - r * 0.5, 2, r);
          if (selected) {
            c.strokeStyle = SEL;
            c.lineWidth = 3;
            c.stroke();
          }
          c.font = `600 13px ${FONT}`;
          c.textAlign = 'left';
          c.textBaseline = 'middle';
          c.fillStyle = '#17151e';
          c.fillText(o.type === 'spin' ? 'Swell' : 'Roll', x + 4, g.y + 1);
          continue;
        }
        hexPath(c, x, g.y, r, 0);
        c.fillStyle = o.hitSound & 10 ? KAT : DON;
        c.fill();
        c.lineWidth = selected ? 4 : 2;
        c.strokeStyle = selected ? SEL : BONE;
        c.stroke();
      }

      c.fillStyle = ACID;
      c.fillRect(g.px - 1, top - 16, 2, g.h + 32);
      hexPath(c, g.px, g.y, 38, 0);
      c.strokeStyle = 'rgba(216,255,62,0.7)';
      c.lineWidth = 2;
      c.stroke();

      if (this.cursor.inside && !this.drag && this.tool !== 'select' && Math.abs(this.cursor.sy - g.y) <= g.h / 2 && !this.record) {
        const at = this.snapT(this.timeOfLaneX(this.cursor.sx, t, g));
        const x = this.laneX(at, t, g);
        const color = { don: DON, kat: KAT, roll: ROLL, swell: SWELL }[this.tool];
        hexPath(c, x, g.y, this.opt.big ? 34 : 24, 0);
        c.globalAlpha = 0.4;
        c.fillStyle = color;
        c.fill();
        c.globalAlpha = 1;
      }
      if (this.record) this.label(c, 'F J center   D K rim', W / 2, top + g.h + 28, BONE, 14, 'center');
    }

    // Catch and mania: time climbs up the screen toward nothing, past a fixed line at the bottom.
    drawRoll(c, t) {
      this.drawBackdrop(c);
      const g = this.rollGeom(), H = this.H;
      const mania = this.map.mode === 3;
      c.fillStyle = 'rgba(255,255,255,0.03)';
      c.fillRect(g.x0, 0, g.tw, H);

      if (mania) {
        for (let i = 0; i <= this.map.keys; i++) {
          c.fillStyle = 'rgba(255,255,255,0.1)';
          c.fillRect(Math.round(g.x0 + i * g.cw), 0, 1, H);
        }
      } else {
        c.fillStyle = 'rgba(255,255,255,0.14)';
        c.fillRect(g.x0, 0, 1, H);
        c.fillRect(g.x0 + g.tw, 0, 1, H);
      }

      const t0 = this.timeOfY(H + 40, t, g), t1 = this.timeOfY(-40, t, g);
      this.forTicks(t0, t1, this.snap, (time, k, r) => {
        const s = tickStyle(k, this.snap, r.meter || 4);
        const y = Math.round(this.yOf(time, t, g));
        c.fillStyle = s.color;
        c.fillRect(g.x0, y, g.tw, s.level === 0 ? 2 : 1);
        if (s.level === 0) this.label(c, String(Math.floor(k / this.snap / (r.meter || 4)) + 1), g.x0 - 8, y, MUTE, 11, 'right');
      });

      const noteH = 14;
      const vis = this.map.objects.filter(o => (o.endT || o.t) >= t0 && o.t <= t1);
      for (const o of vis) {
        const y = this.yOf(o.t, t, g), selected = this.selection.has(o);
        if (mania) {
          const col = this.colOf(o), x = g.x0 + col * g.cw + 2, w = g.cw - 4;
          const color = this.columnColor(col);
          if (o.endT) {
            const ey = this.yOf(o.endT, t, g);
            c.fillStyle = color;
            c.globalAlpha = 0.45;
            c.fillRect(x + w * 0.16, ey, w * 0.68, y - ey);
            c.globalAlpha = 1;
            c.fillRect(x, ey - 4, w, 6);
            if (selected) { c.strokeStyle = SEL; c.lineWidth = 2; c.strokeRect(x + w * 0.16, ey, w * 0.68, y - ey); }
          }
          c.fillStyle = color;
          c.fillRect(x, y - noteH, w, noteH);
          if (selected) { c.strokeStyle = SEL; c.lineWidth = 3; c.strokeRect(x, y - noteH, w, noteH); }
        } else if (o.type === 'spin') {
          const ey = this.yOf(o.endT, t, g);
          c.fillStyle = 'rgba(255,212,121,0.14)';
          c.fillRect(g.x0, ey, g.tw, y - ey);
          c.fillStyle = selected ? SEL : ROLL;
          c.fillRect(g.x0, y - 1, g.tw, 2);
          c.fillRect(g.x0, ey - 1, g.tw, 3);
          this.label(c, 'Bananas', g.x0 + g.tw / 2, (y + ey) / 2, ROLL, 13, 'center');
        } else {
          const color = COLORS[(o.color || 0) % 4];
          if (o.type === 'slider') {
            c.strokeStyle = selected ? SEL : color;
            c.lineWidth = 5;
            c.globalAlpha = 0.7;
            c.beginPath();
            const steps = Math.max(2, Math.ceil((o.endT - o.t) / 30));
            for (let i = 0; i <= steps; i++) {
              const at = o.t + (o.endT - o.t) * i / steps;
              const p = P.sliderPos(o, at);
              const px = g.x0 + p[0] * g.s, py = this.yOf(at, t, g);
              if (i === 0) c.moveTo(px, py); else c.lineTo(px, py);
            }
            c.stroke();
            c.globalAlpha = 1;
            const end = P.sliderPos(o, o.endT);
            hexPath(c, g.x0 + end[0] * g.s, this.yOf(o.endT, t, g), 11, Math.PI / 6);
            c.fillStyle = color;
            c.fill();
          }
          hexPath(c, g.x0 + o.x * g.s, y, 15, Math.PI / 6);
          c.fillStyle = color;
          c.fill();
          c.lineWidth = selected ? 3.5 : 2;
          c.strokeStyle = selected ? SEL : BONE;
          c.stroke();
        }
      }

      c.fillStyle = ACID;
      c.fillRect(g.x0 - 12, g.judge - 1, g.tw + 24, 2);

      if (mania) {
        const keys = this.recordKeys();
        for (let i = 0; i < this.map.keys; i++) {
          this.label(c, P.keyLabel(keys[i]), g.x0 + (i + 0.5) * g.cw, g.judge + 24, this.record ? BONE : MUTE, 13, 'center');
        }
      }

      if (this.cursor.inside && !this.drag && this.tool !== 'select' && !this.record) {
        const { sx, sy } = this.cursor;
        if (sx >= g.x0 && sx <= g.x0 + g.tw) {
          const at = this.snapT(this.timeOfY(sy, t, g));
          const y = this.yOf(at, t, g);
          c.globalAlpha = 0.4;
          if (mania) {
            const col = clamp(Math.floor((sx - g.x0) / g.cw), 0, this.map.keys - 1);
            c.fillStyle = this.columnColor(col);
            c.fillRect(g.x0 + col * g.cw + 2, y - noteH, g.cw - 4, noteH);
          } else {
            hexPath(c, g.x0 + this.gridded(this.cursor.x) * g.s, y, 15, Math.PI / 6);
            c.fillStyle = ACID;
            c.fill();
          }
          c.globalAlpha = 1;
        }
      }
    }

    columnColor(col) {
      const mid = (this.map.keys - 1) / 2;
      if (col === mid) return COLORS[1];
      return Math.floor(Math.abs(col - mid)) % 2 === 0 ? COLORS[0] : COLORS[2];
    }

    // Timeline: a zoomed view with a waveform, and a whole-song strip below it.
    drawLine(c, t) {
      const d = this.dpr, W = this.LW, H = this.LH, z = this.zoom, cx = W / 2;
      c.setTransform(d, 0, 0, d, 0, 0);
      c.clearRect(0, 0, W, H);
      const bandH = H - 18;
      const xOf = time => cx + (time - t) * z;
      const t0 = t - cx / z, t1 = t + cx / z;

      // Waveform
      const { data, perSec } = this.peaks;
      c.fillStyle = 'rgba(243,240,231,0.15)';
      const midY = bandH / 2;
      for (let px = 0; px < W; px += 2) {
        const a = Math.floor((t + (px - cx) / z) / 1000 * perSec), b = Math.ceil((t + (px + 2 - cx) / z) / 1000 * perSec);
        if (b < 0 || a >= data.length) continue;
        let top = 0;
        for (let i = Math.max(0, a); i < Math.min(data.length, Math.max(b, a + 1)); i++) if (data[i] > top) top = data[i];
        const hh = top * (bandH / 2 - 4);
        if (hh > 0.5) c.fillRect(px, midY - hh, 1.5, hh * 2);
      }

      // Grid: as fine as the zoom allows.
      const beat = this.redAt(t).beat;
      const div = beat / this.snap * z >= 6 ? this.snap : beat * z >= 6 ? 1 : 0;
      if (div) {
        this.forTicks(t0, t1, div, (time, k, r) => {
          const s = tickStyle(k, div, r.meter || 4);
          const inset = s.level === 0 ? 0 : s.level === 1 ? bandH * 0.2 : bandH * 0.36;
          c.fillStyle = s.color;
          c.fillRect(Math.round(xOf(time)), inset, 1, bandH - inset * 2);
        });
      } else {
        this.forTicks(t0, t1, 1, (time, k, r) => {
          if (((k % (r.meter || 4)) + (r.meter || 4)) % (r.meter || 4) !== 0) return;
          c.fillStyle = 'rgba(243,240,231,0.4)';
          c.fillRect(Math.round(xOf(time)), 0, 1, bandH);
        });
      }

      // Tempo and speed flags
      for (const p of this.map.timing) {
        const x = xOf(p.t);
        if (x < -10 || x > W + 10) continue;
        c.fillStyle = p.uninherited ? '#ff4d5e' : '#5eead4';
        c.beginPath();
        c.moveTo(x, 0); c.lineTo(x + 7, 0); c.lineTo(x, 8);
        c.closePath();
        c.fill();
        c.fillRect(x, 0, 1, bandH);
      }

      // Objects
      const y = midY;
      const mode = this.map.mode;
      for (const o of this.map.objects) {
        const end = o.endT || o.t;
        if (end < t0 || o.t > t1) continue;
        const x = xOf(o.t), selected = this.selection.has(o);
        let color = COLORS[(o.color || 0) % 4];
        if (mode === 1) color = o.type === 'spin' ? SWELL : o.type === 'slider' ? ROLL : o.hitSound & 10 ? KAT : DON;
        if (mode === 3) color = this.columnColor(this.colOf(o));
        const ly = mode === 3 ? 12 + (bandH - 24) * (this.colOf(o) + 0.5) / this.map.keys : y;
        const r = mode === 3 ? Math.max(3, Math.min(8, (bandH - 24) / this.map.keys / 2)) : (mode === 1 && o.hitSound & 4 ? 12 : 9);
        if (o.endT) {
          const ex = xOf(o.endT);
          c.fillStyle = color;
          c.globalAlpha = o.type === 'spin' ? 0.35 : 0.55;
          c.fillRect(x, ly - r * 0.7, ex - x, r * 1.4);
          c.globalAlpha = 1;
          c.fillRect(ex - 2, ly - r, 4, r * 2);
          if (selected) {
            c.strokeStyle = SEL;
            c.lineWidth = 2;
            c.strokeRect(x, ly - r * 0.7, ex - x, r * 1.4);
          }
        }
        hexPath(c, x, ly, r, Math.PI / 6);
        c.fillStyle = color;
        c.fill();
        if (selected) {
          c.strokeStyle = SEL;
          c.lineWidth = 2.5;
          c.stroke();
        }
      }

      // Playhead
      c.fillStyle = ACID;
      c.fillRect(Math.round(cx) - 1, 0, 2, bandH);
      c.beginPath();
      c.moveTo(cx - 6, 0); c.lineTo(cx + 6, 0); c.lineTo(cx, 8);
      c.closePath();
      c.fill();

      // Whole song
      const oy = H - 16;
      c.fillStyle = 'rgba(255,255,255,0.05)';
      c.fillRect(0, oy, W, 16);
      if (!this.density) {
        const n = Math.max(1, Math.floor(W / 2));
        const bins = new Float32Array(n);
        for (const o of this.map.objects) bins[clamp(Math.floor(o.t / this.duration * n), 0, n - 1)]++;
        let max = 1;
        for (const v of bins) if (v > max) max = v;
        this.density = { bins: bins.map(v => v / max), n };
      }
      c.fillStyle = 'rgba(216,255,62,0.45)';
      const bw = W / this.density.n;
      this.density.bins.forEach((v, i) => { if (v > 0) c.fillRect(i * bw, oy + 16 - Math.max(2, v * 14), Math.max(1, bw - 0.5), Math.max(2, v * 14)); });
      const vx0 = Math.max(0, t0 / this.duration * W), vx1 = Math.min(W, t1 / this.duration * W);
      c.strokeStyle = 'rgba(243,240,231,0.35)';
      c.lineWidth = 1;
      c.strokeRect(vx0 + 0.5, oy + 0.5, Math.max(2, vx1 - vx0 - 1), 15);
      c.fillStyle = ACID;
      c.fillRect(t / this.duration * W - 1, oy, 2, 16);
    }
  }

  // ---------- One editor at a time; listeners live for the page ----------

  let ed = null;
  let bound = false;

  function bind() {
    if (bound) return;
    bound = true;
    const canvas = $('ed-canvas'), line = $('ed-line');
    canvas.addEventListener('pointerdown', e => ed && ed.stageDown(e));
    canvas.addEventListener('pointermove', e => ed && ed.stageMove(e));
    canvas.addEventListener('pointerup', e => ed && ed.stageUp(e));
    canvas.addEventListener('pointercancel', e => ed && ed.stageUp(e));
    canvas.addEventListener('pointerleave', () => { if (ed) { ed.cursor.inside = false; ed.touch(); } });
    canvas.addEventListener('dblclick', e => ed && ed.stageDouble(e));
    canvas.addEventListener('wheel', e => ed && ed.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
    line.addEventListener('pointerdown', e => ed && ed.lineDown(e));
    line.addEventListener('pointermove', e => ed && ed.lineMove(e));
    line.addEventListener('pointerup', e => ed && ed.lineUp(e));
    line.addEventListener('pointercancel', e => ed && ed.lineUp(e));
    line.addEventListener('wheel', e => ed && ed.wheel(e), { passive: false });
    line.addEventListener('contextmenu', e => e.preventDefault());
    window.addEventListener('keydown', e => { if (ed && ed.active) ed.keyDown(e); });
    window.addEventListener('keyup', e => { if (ed && ed.active) ed.keyUp(e); });
    window.addEventListener('resize', () => { if (ed && ed.active) ed.resize(); });

    $('ed-play').addEventListener('click', () => ed && ed.toggle());
    $('ed-start').addEventListener('click', () => ed && ed.seek(0));
    $('ed-back-step').addEventListener('click', () => ed && ed.seek(ed.stepT(ed.now(), -1, 1)));
    $('ed-fwd-step').addEventListener('click', () => ed && ed.seek(ed.stepT(ed.now(), 1, 1)));
    $('ed-undo').addEventListener('click', () => ed && ed.restore(-1));
    $('ed-redo').addEventListener('click', () => ed && ed.restore(1));
    $('ed-record').addEventListener('click', () => ed && ed.setRecord(!ed.record));
    $('ed-test').addEventListener('click', () => ed && ed.test(false));
    $('ed-watch').addEventListener('click', () => ed && ed.test(true));
    $('ed-export').addEventListener('click', () => ed && ed.hooks.exportMap(P.serializeMap(ed.map)));
    $('ed-exit').addEventListener('click', () => ed && ed.hooks.exit());
    $('ed-help-btn').addEventListener('click', () => $('ed-help').classList.remove('hidden'));
    $('ed-help-close').addEventListener('click', () => $('ed-help').classList.add('hidden'));
    document.querySelectorAll('#ed-tabs button').forEach(b => b.addEventListener('click', () => ed && ed.setTab(b.dataset.tab)));
    $('ed-bg-file').addEventListener('change', e => {
      if (ed && e.target.files[0]) ed.setBackground(e.target.files[0]);
      e.target.value = '';
    });
  }

  P.openEditor = opts => {
    bind();
    ed = new Editor(opts);
    P.editor = ed;
    return ed;
  };
  P.closeEditor = async () => {
    if (!ed) return;
    const closing = ed;
    ed = null;
    P.editor = null;
    await closing.close();
  };
})(globalThis.Pulsar = globalThis.Pulsar || {});
