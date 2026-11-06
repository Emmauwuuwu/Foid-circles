// Built-in content: original songs synthesised on the fly, and charts derived from them.
(function (P) {
  'use strict';

  function rng(seed) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const SCALES = {
    minor: [0, 2, 3, 5, 7, 8, 10],
    major: [0, 2, 4, 5, 7, 9, 11],
    dorian: [0, 2, 3, 5, 7, 9, 10],
  };

  // Two-bar lead rhythms as [startBeat, lengthInBeats].
  const HOOKS = [
    [[0, 1.5], [1.5, 0.5], [2, 1], [3, 0.5], [3.5, 0.5], [4, 2], [6, 0.5], [6.5, 0.5], [7, 1]],
    [[0, 0.5], [0.5, 0.5], [1, 1], [2.5, 0.5], [3, 1], [4, 1.5], [5.5, 0.5], [6, 2]],
    [[0, 1], [1, 0.5], [1.5, 1], [2.5, 1.5], [4, 0.5], [4.5, 0.5], [5, 0.5], [5.5, 0.5], [6, 1], [7, 1]],
    [[0, 2], [2, 0.5], [2.5, 0.5], [3, 1], [4, 1], [5, 1], [6, 0.5], [6.5, 1.5]],
  ];

  // Redline is short on purpose: its song has its own structure and a single hand-built chart.
  const REDLINE_SECTIONS = [
    { name: 'intro', bars: 2, pad: 1, hat: 1 },
    { name: 'verse', bars: 4, hat: 1, kick: 1, bass: 1, arp: 1 },
    { name: 'verse', bars: 4, pad: 1, hat: 1, kick: 1, bass: 1, snare: 1, arp: 1 },
    { name: 'hook', bars: 4, hat: 1, kick: 1, bass: 1, snare: 1, lead: 1, arp: 1 },
    { name: 'break', bars: 2, pad: 1, arp: 1 },
    { name: 'hook', bars: 6, pad: 1, hat: 1, kick: 1, bass: 1, snare: 1, lead: 2, arp: 1 },
    { name: 'outro', bars: 2, pad: 1, hat: 1, kick: 1 },
  ];

  const TRACKS = [
    { id: 'redline', title: 'Redline', mood: 'Challenge · Hard', bpm: 170, root: 52, scale: 'minor', prog: [0, 5, 6, 4], seed: 137, hook: 2, kick: [0, 0.75, 1.5, 2, 2.75, 3.5], sections: REDLINE_SECTIONS, versions: ['Challenge'] },
    { id: 'glasshouse', title: 'Glasshouse', mood: 'Bright house', bpm: 124, root: 57, scale: 'dorian', prog: [0, 5, 3, 4], seed: 11, hook: 0, kick: [0, 1, 2, 3] },
    { id: 'night-ferry', title: 'Night Ferry', mood: 'Slow synthwave', bpm: 102, root: 52, scale: 'minor', prog: [0, 5, 2, 6], seed: 29, hook: 3, kick: [0, 1.5, 2, 3.5] },
    { id: 'copper-sun', title: 'Copper Sun', mood: 'Warm breakbeat', bpm: 138, root: 55, scale: 'major', prog: [0, 4, 5, 3], seed: 53, hook: 1, kick: [0, 1.5, 2.5, 3] },
    { id: 'static-bloom', title: 'Static Bloom', mood: 'Fast and restless', bpm: 164, root: 50, scale: 'minor', prog: [0, 6, 5, 4], seed: 97, hook: 2, kick: [0, 1, 2, 2.5, 3] },
  ];

  const SECTIONS = [
    { name: 'intro', bars: 4, pad: 1, hat: 1 },
    { name: 'verse', bars: 8, pad: 1, hat: 1, kick: 1, bass: 1, arp: 1 },
    { name: 'hook', bars: 8, hat: 1, kick: 1, bass: 1, snare: 1, lead: 1, arp: 1 },
    { name: 'break', bars: 4, pad: 1, arp: 1 },
    { name: 'hook', bars: 8, pad: 1, hat: 1, kick: 1, bass: 1, snare: 1, lead: 1, arp: 1 },
    { name: 'hook', bars: 8, pad: 1, hat: 1, kick: 1, bass: 1, snare: 1, lead: 2, arp: 1 },
    { name: 'outro', bars: 4, pad: 1 },
  ];

  function buildScore(track) {
    const r = rng(track.seed);
    const scale = SCALES[track.scale];
    const note = deg => {
      const n = scale.length;
      const oct = Math.floor(deg / n);
      return track.root + scale[((deg % n) + n) % n] + oct * 12;
    };
    const hook = HOOKS[track.hook];

    // A melody fixed once per track, so the hook repeats and stays recognisable.
    const melody = [];
    let walk = 7;
    for (let i = 0; i < hook.length * 2; i++) {
      walk += Math.floor(r() * 5) - 2;
      walk = Math.max(4, Math.min(13, walk));
      melody.push(walk);
    }

    const ev = { kick: [], snare: [], hat: [], bass: [], lead: [], arp: [], pad: [] };
    const sections = [];
    let bar = 0;
    for (const s of track.sections || SECTIONS) {
      sections.push({ ...s, startBar: bar });
      for (let b = 0; b < s.bars; b++, bar++) {
        const beat0 = bar * 4;
        const deg = track.prog[bar % track.prog.length];
        if (s.pad) ev.pad.push({ b: beat0, d: 4, notes: [note(deg + 7), note(deg + 9), note(deg + 11)] });
        if (s.kick) track.kick.forEach(k => ev.kick.push(beat0 + k));
        if (s.snare) { ev.snare.push(beat0 + 1, beat0 + 3); }
        if (s.hat) for (let i = 0; i < 8; i++) ev.hat.push({ b: beat0 + i / 2, open: i % 2 === 1 });
        if (s.bass) {
          [0, 1.5, 2, 3, 3.5].forEach((o, i) => ev.bass.push({ b: beat0 + o, d: i === 0 ? 1.2 : 0.45, m: note(deg) - 12 }));
        }
        if (s.arp) {
          const shape = [0, 2, 4, 7, 4, 2, 7, 4];
          for (let i = 0; i < 16; i++) ev.arp.push({ b: beat0 + i / 4, m: note(deg + 7 + shape[(i + bar) % 8]) });
        }
        if (s.lead && bar % 2 === (sections[sections.length - 1].startBar % 2)) {
          hook.forEach(([st, len], i) => {
            const idx = (i + (bar % 4 === 0 ? 0 : hook.length)) % melody.length;
            ev.lead.push({ b: beat0 + st, d: len, m: note(melody[idx]) + (s.lead === 2 ? 12 : 0) });
          });
        }
      }
    }
    return { track, ev, sections, totalBeats: bar * 4 };
  }

  const midi = m => 440 * Math.pow(2, (m - 69) / 12);

  // Mixes the score directly into sample arrays. A Web Audio graph with thousands of
  // scheduled nodes costs nodes x time to render (tens of seconds); this costs only
  // the length of the notes themselves, so a whole song takes a few seconds at most.
  function synthesize(score, rate) {
    const spb = 60 / score.track.bpm;
    const total = Math.ceil((score.totalBeats * spb + 3) * rate);
    const L = new Float32Array(total), R = new Float32Array(total), send = new Float32Array(total);
    const TAU = Math.PI * 2;

    const noise = new Float32Array(rate);
    const nr = rng(score.track.seed + 1);
    for (let i = 0; i < noise.length; i++) noise[i] = nr() * 2 - 1;

    const blep = (ph, dp) => {
      if (ph < dp) { const x = ph / dp; return x + x - x * x - 1; }
      if (ph > 1 - dp) { const x = (ph - 1) / dp; return x * x + x + x + 1; }
      return 0;
    };
    const saw = (ph, dp) => 2 * ph - 1 - blep(ph, dp);
    const square = (ph, dp) => (ph < 0.5 ? 1 : -1) + blep(ph, dp) - blep((ph + 0.5) % 1, dp);
    const tri = ph => 4 * Math.abs(ph - 0.5) - 1;

    // Resonant low-pass (state variable, trapezoidal form); one instance per note.
    const makeLowpass = (fc, q) => {
      const g = Math.tan(Math.PI * Math.min(fc, rate * 0.45) / rate), k = 1 / q;
      const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
      let s1 = 0, s2 = 0;
      return x => {
        const v3 = x - s2, v1 = a1 * s1 + a2 * v3, v2 = s2 + a2 * s1 + a3 * v3;
        s1 = 2 * v1 - s1; s2 = 2 * v2 - s2;
        return v2;
      };
    };

    // Writes a mono voice with constant-power-ish panning and an optional delay send.
    const write = (startSec, lenSec, pan, sendAmt, sampleAt) => {
      const start = Math.round(startSec * rate);
      const n = Math.min(Math.ceil(lenSec * rate), total - start);
      const gl = Math.min(1, 1 - pan), gr = Math.min(1, 1 + pan);
      for (let i = 0; i < n; i++) {
        const v = sampleAt(i, i / rate);
        L[start + i] += v * gl;
        R[start + i] += v * gr;
        if (sendAmt) send[start + i] += v * sendAmt;
      }
    };
    // Percussive envelope: quick attack, exponential fall, forced to zero at the end.
    const perc = (t, attack, len) => {
      if (t < attack) return t / attack;
      const x = (t - attack) / Math.max(1e-4, len - attack);
      return x >= 1 ? 0 : Math.exp(-5 * x) * (1 - x * x * x * x);
    };

    for (const b of score.ev.kick) {
      let ph = 0;
      write(b * spb, 0.3, 0, 0, (i, t) => {
        ph += (44 + 106 * Math.exp(-t / 0.03)) / rate;
        return Math.sin(ph * TAU) * perc(t, 0.002, 0.28) * 0.9;
      });
    }
    for (const b of score.ev.snare) {
      let lp = 0, ph = 0;
      const seed = Math.floor(b * 977) % rate;
      write(b * spb, 0.2, 0, 0.1, (i, t) => {
        const x = noise[(seed + i) % rate];
        lp += 0.2 * (x - lp);
        ph = (ph + 190 / rate) % 1;
        return (x - lp) * perc(t, 0.002, 0.2) * 0.4 + tri(ph) * perc(t, 0.002, 0.12) * 0.25;
      });
    }
    for (const h of score.ev.hat) {
      const len = h.open ? 0.11 : 0.04, peak = h.open ? 0.1 : 0.07;
      let lp = 0;
      const seed = Math.floor(h.b * 613) % rate;
      const pan = h.open ? 0.2 : -0.2;
      write(h.b * spb, len, pan, 0, (i, t) => {
        const x = noise[(seed + i) % rate];
        lp += 0.72 * (x - lp);
        return (x - lp) * perc(t, 0.001, len) * peak;
      });
    }
    for (const n of score.ev.bass) {
      const f = midi(n.m), dp = f / rate, len = n.d * spb + 0.04;
      const flt = makeLowpass(520, 2.2);
      let ph = 0;
      write(n.b * spb, len, 0, 0, (i, t) => {
        ph = (ph + dp) % 1;
        return flt(saw(ph, dp)) * perc(t, 0.005, len) * 0.42;
      });
    }
    for (const n of score.ev.lead) {
      const f = midi(n.m), len = Math.max(0.14, n.d * spb) + 0.05;
      const d1 = f * Math.pow(2, -6 / 1200) / rate, d2 = f * Math.pow(2, 7 / 1200) / rate;
      const flt = makeLowpass(2800, 1.2);
      let p1 = 0, p2 = 0;
      write(n.b * spb, len, 0, 0.5, (i, t) => {
        p1 = (p1 + d1) % 1; p2 = (p2 + d2) % 1;
        return flt(square(p1, d1) * 0.5 + saw(p2, d2) * 0.5) * perc(t, 0.008, len) * 0.2;
      });
    }
    score.ev.arp.forEach((n, idx) => {
      const dp = midi(n.m) / rate, len = spb * 0.4;
      let ph = 0;
      write(n.b * spb, len, idx % 2 ? 0.35 : -0.35, 0.5, (i, t) => {
        ph = (ph + dp) % 1;
        return tri(ph) * perc(t, 0.003, len) * 0.06;
      });
    });
    for (const p of score.ev.pad) {
      const len = p.d * spb * 1.03;
      p.notes.forEach((m, k) => {
        const dp = midi(m) * Math.pow(2, (k % 2 ? 8 : -8) / 1200) / rate;
        const flt = makeLowpass(900, 0.8);
        let ph = k / 3;
        write(p.b * spb, len, (k - 1) * 0.3, 0, (i, t) => {
          ph = (ph + dp) % 1;
          const x = t / len;
          const amp = x < 0.3 ? x / 0.3 : (1 - x) / 0.7;
          return flt(saw(ph, dp)) * amp * 0.09;
        });
      });
    }

    // Feedback delay on the send bus, offset between channels for width.
    const D = Math.round(spb * 0.75 * rate), half = D >> 1;
    for (let i = D; i < total; i++) send[i] += send[i - D] * 0.33;
    for (let i = 0; i < total; i++) {
      L[i] += send[i] * 0.3;
      if (i >= half) R[i] += send[i - half] * 0.3;
    }
    // Soft limiter, plus a short fade so the song cannot end on a click.
    const fade = Math.floor(rate * 0.05);
    for (let i = 0; i < total; i++) {
      const edge = i > total - fade ? (total - i) / fade : 1;
      L[i] = Math.tanh(L[i] * 1.05) * 0.92 * edge;
      R[i] = Math.tanh(R[i] * 1.05) * 0.92 * edge;
    }
    return { L, R, rate };
  }

  function toBuffer({ L, R, rate }) {
    const buffer = new AudioBuffer({ numberOfChannels: 2, length: L.length, sampleRate: rate });
    buffer.copyToChannel(L, 0);
    buffer.copyToChannel(R, 1);
    return buffer;
  }

  // Rendering takes a few seconds, so it runs in a worker to keep the menu moving.
  // Where workers are unavailable (a page opened straight from disk) it runs here instead.
  function renderScore(score, track) {
    const local = () => toBuffer(synthesize(score, 44100));
    return new Promise(resolve => {
      let worker;
      try { worker = new Worker('js/synth-worker.js'); } catch (e) { resolve(local()); return; }
      worker.onmessage = e => { worker.terminate(); resolve(toBuffer(e.data)); };
      worker.onerror = e => { e.preventDefault(); worker.terminate(); resolve(local()); };
      worker.postMessage(track.id);
    });
  }

  const DIFFS = {
    Easy: { ar: 4, od: 3, cs: 3, hp: 3, gap: 2, spacing: 110, vel: 100, slide: 1 },
    Normal: { ar: 6.5, od: 5, cs: 3.8, hp: 5, gap: 1, spacing: 115, vel: 130, slide: 1 },
    Hard: { ar: 8.8, od: 7.5, cs: 4.4, hp: 6, gap: 0.5, spacing: 165, vel: 180, slide: 1 },
  };

  const BOUNDS = { x0: 36, y0: 36, x1: 476, y1: 348 };
  const inBounds = (x, y) => x >= BOUNDS.x0 && x <= BOUNDS.x1 && y >= BOUNDS.y0 && y <= BOUNDS.y1;

  // Picks the rhythm for one bar, following the lead when there is one.
  function barOnsets(score, sec, barIdx, d) {
    const beat0 = barIdx * 4;
    const cand = new Map();
    const inBar = b => b >= beat0 && b < beat0 + 4;
    if (sec.name === 'intro') {
      if (barIdx > 0) { cand.set(beat0, 0); cand.set(beat0 + 2, 0); }
      if (barIdx > 0 && d.gap <= 1) cand.set(beat0 + 3, 0);
      return cand;
    }
    if (sec.kick) score.ev.kick.filter(inBar).forEach(b => cand.set(b, 0));
    score.ev.lead.filter(n => inBar(n.b)).forEach(n => cand.set(n.b, n.d));
    if (sec.name === 'verse' && barIdx % 2 === 1) {
      // Verses have no lead, so sustained rails give them their shape.
      cand.set(beat0 + 2, 2);
    }
    return cand;
  }

  // A short, hand-shaped gauntlet. Every part teaches nothing and forgives little:
  // star jumps, kick sliders, a figure-eight stream, then rotating triangles with bursts.
  function challengeChart(score) {
    const track = score.track, beatMs = 60000 / track.bpm;
    const objects = [];
    const PX_PER_BEAT = 200;
    const at = (cx, cy, rx, ry, deg) => [
      Math.round(cx + rx * Math.cos(deg * Math.PI / 180)),
      Math.round(cy + ry * Math.sin(deg * Math.PI / 180)),
    ];
    const ring = (r, deg) => at(256, 192, r * 1.25, r, deg);
    const toward = (a, b, f) => [Math.round(a[0] + (b[0] - a[0]) * f), Math.round(a[1] + (b[1] - a[1]) * f)];
    const tap = (beat, p, newCombo = false) => objects.push({ type: 'tap', t: beat * beatMs, x: p[0], y: p[1], newCombo });
    const spin = (beat, end) => objects.push({ type: 'spin', t: beat * beatMs, endT: end * beatMs, x: 256, y: 192 });
    const slide = (beat, from, to, slides = 1, newCombo = false, bend = 0) => {
      const dx = to[0] - from[0], dy = to[1] - from[1], len = Math.hypot(dx, dy) || 1;
      const mid = [Math.round((from[0] + to[0]) / 2 - dy / len * bend), Math.round((from[1] + to[1]) / 2 + dx / len * bend)];
      const control = [from, mid, to];
      // Lengths land on quarter beats so each slider ends on the grid.
      const pixel = Math.max(PX_PER_BEAT / 4, Math.round(P.makePath('B', control, null).length / (PX_PER_BEAT / 4)) * (PX_PER_BEAT / 4));
      objects.push({
        type: 'slider', t: beat * beatMs, endT: (beat + pixel / PX_PER_BEAT * slides) * beatMs,
        x: from[0], y: from[1], slides, newCombo,
        path: P.makePath('B', control, pixel), segments: [{ kind: 'B', points: control }], length: pixel,
      });
    };

    // Bars 2-5: a five-point star of full-beat jumps, with a double on every fourth.
    const star = i => ring(120, -90 + i * 144);
    for (let i = 0; i < 16; i++) {
      tap(8 + i, star(i), i % 4 === 0);
      if (i % 4 === 3 && i < 15) tap(8 + i + 0.5, toward(star(i), star(i + 1), 0.4));
    }

    // Bars 6-9: a short slider that kicks inward, then two jumps that throw you back out.
    for (let k = 0; k < 8; k++) {
      const b = 24 + k * 2, a = -90 + k * 67.5;
      const start = ring(112, a);
      slide(b, start, toward(start, [256, 192], 0.62), 1, k % 2 === 0, k % 2 ? 16 : -16);
      tap(b + 1, ring(92, a + 95));
      tap(b + 1.5, ring(92, a + 140));
    }

    // Bars 10-13: one unbroken half-beat stream around a figure eight.
    for (let s = 0; s < 4; s++) {
      const b = 40 + s * 4, left = s % 2 === 0, r = s < 2 ? 86 : 100;
      const cx = left ? 256 - r : 256 + r, from = left ? 0 : 180, dir = left ? 1 : -1;
      for (let i = 0; i < 8; i++) tap(b + i / 2, at(cx, 192, r, r, from + dir * i * 45), i === 0);
    }
    tap(55.75, at(256 + 100, 192, 100, 100, 180 - 7 * 45 - 22));

    // Bars 14-15: the only rest in the song, and you have to spin through it.
    spin(56, 62);

    // Bars 16-21: triangles that turn and drift, joined by reverse sliders and quarter bursts.
    const cycles = 6;
    const centre = c => [256 + (c % 2 ? 60 : -60), 192 + (c % 3 === 1 ? 30 : -30)];
    const vertex = (c, i) => {
      const [cx, cy] = centre(c);
      const r = c < 3 ? 86 : 98;
      return at(cx, cy, r, r, c * 40 + 20 + i * 120);
    };
    for (let c = 0; c < cycles; c++) {
      const b = 64 + c * 4;
      for (let i = 0; i < 6; i++) tap(b + i / 2, vertex(c, i), i === 0);
      const next = c + 1 < cycles ? vertex(c + 1, 0) : ring(112, 45);
      if (c % 2 === 0) {
        const start = vertex(c, 6);
        slide(b + 3, start, toward(start, next, 50 / Math.max(50, Math.hypot(next[0] - start[0], next[1] - start[1]))), 2);
      } else {
        // The burst runs straight into the next triangle, so the hands lead the eyes.
        const last = vertex(c, 5), reach = Math.hypot(last[0] - next[0], last[1] - next[1]) || 1;
        tap(b + 3, toward(next, last, Math.min(0.8, 110 / reach)));
        tap(b + 3.5, toward(next, last, Math.min(0.5, 66 / reach)));
        tap(b + 3.75, toward(next, last, Math.min(0.25, 33 / reach)));
      }
    }

    // Bar 22: four last full-width jumps. Bar 23: spin it out.
    [45, 225, 135, 315].forEach((deg, i) => tap(88 + i, ring(112, deg), i === 0));
    spin(92, 95.5);

    return {
      title: track.title,
      artist: 'Pulsar Synth',
      version: 'Challenge',
      mode: 0,
      creator: 'Pulsar',
      audioFile: `${track.id}.wav`,
      ar: 9.2, od: 7.5, cs: 4.5, hp: 6.5,
      multiplier: PX_PER_BEAT / 100,
      tickRate: 1,
      previewTime: Math.round(64 * beatMs),
      builtin: track.id,
      timing: [{ t: 0, beat: beatMs, uninherited: true, meter: 4, sampleSet: 2, sampleIndex: 0, volume: 70, effects: 0 }],
      beatMs, beatZero: 0,
      objects: P.finalizeObjects(objects),
    };
  }

  function buildChart(score, version) {
    if (version === 'Challenge') return challengeChart(score);
    const d = DIFFS[version];
    const { track } = score;
    const beatMs = 60000 / track.bpm;
    const r = rng(track.seed * 31 + version.length);
    const objects = [];

    let x = 256, y = 192, heading = r() * Math.PI * 2;
    let lastEnd = -Infinity;

    const step = (dist, turn) => {
      for (let i = 0; i < 12; i++) {
        const a = heading + (i === 0 ? turn : (r() - 0.5) * Math.PI * 2);
        const nx = x + Math.cos(a) * dist, ny = y + Math.sin(a) * dist;
        if (inBounds(nx, ny)) { heading = a; return [nx, ny]; }
      }
      const a = Math.atan2(192 - y, 256 - x);
      heading = a;
      return [
        Math.max(BOUNDS.x0, Math.min(BOUNDS.x1, x + Math.cos(a) * dist)),
        Math.max(BOUNDS.y0, Math.min(BOUNDS.y1, y + Math.sin(a) * dist)),
      ];
    };

    const turnAmount = () => (r() < 0.5 ? -1 : 1) * (0.35 + r() * 1.25);

    for (const sec of score.sections) {
      for (let b = 0; b < sec.bars; b++) {
        const barIdx = sec.startBar + b;
        const beat0 = barIdx * 4;

        // Rest points: a spinner closes the break and the song.
        if ((sec.name === 'break' && b === 2) || (sec.name === 'outro' && b === 0)) {
          objects.push({ type: 'spin', t: beat0 * beatMs, endT: (beat0 + 6) * beatMs, x: 256, y: 192 });
          lastEnd = beat0 + 6;
          x = 256; y = 192;
        }
        if (sec.name === 'break' || sec.name === 'outro') {
          if (sec.name === 'break' && b < 2 && d.gap <= 1) {
            [0, 2].forEach(off => {
              if (beat0 + off - lastEnd < d.gap) return;
              const [nx, ny] = step(d.spacing, turnAmount());
              objects.push({ type: 'tap', t: (beat0 + off) * beatMs, x: nx, y: ny, newCombo: off === 0 && b === 0 });
              x = nx; y = ny; lastEnd = beat0 + off;
            });
          }
          continue;
        }

        const cand = [...barOnsets(score, sec, barIdx, d).entries()].sort((p, q) => p[0] - q[0]);
        let firstInBar = true;
        for (let i = 0; i < cand.length; i++) {
          const beat = cand[i][0];
          const len = cand[i][1];
          if (d.gap >= 2 && beat % 1 !== 0) continue;
          if (beat - lastEnd < d.gap) continue;

          const gap = beat - lastEnd;
          const dist = Math.min(d.spacing * 1.25, d.spacing * Math.sqrt(Math.min(gap, 2)));
          const [nx, ny] = objects.length ? step(dist, turnAmount()) : [x, y];
          const newCombo = firstInBar && barIdx % 2 === 0;
          firstInBar = false;

          if (len >= d.slide) {
            const pixel = len * d.vel;
            let chosen = null;
            for (let tries = 0; tries < 10 && !chosen; tries++) {
              const a = r() * Math.PI * 2;
              const bend = (r() - 0.5) * pixel * 0.9;
              const ex = nx + Math.cos(a) * pixel, ey = ny + Math.sin(a) * pixel;
              if (!inBounds(ex, ey)) continue;
              const mx = (nx + ex) / 2 - Math.sin(a) * bend, my = (ny + ey) / 2 + Math.cos(a) * bend;
              if (inBounds(mx, my)) chosen = { path: P.makePath('B', [[nx, ny], [mx, my], [ex, ey]], pixel), a, control: [[nx, ny], [mx, my], [ex, ey]], pixel };
            }
            if (chosen) {
              const end = chosen.path.pts[chosen.path.pts.length - 1];
              objects.push({ type: 'slider', t: beat * beatMs, endT: (beat + len) * beatMs, x: nx, y: ny, slides: 1, path: chosen.path, newCombo, segments: [{ kind: 'B', points: chosen.control }], length: chosen.pixel });
              x = end[0]; y = end[1]; heading = chosen.a; lastEnd = beat + len;
              continue;
            }
          }
          objects.push({ type: 'tap', t: beat * beatMs, x: nx, y: ny, newCombo });
          x = nx; y = ny; lastEnd = beat;
        }
      }
    }

    return {
      title: track.title,
      artist: 'Pulsar Synth',
      version,
      mode: 0,
      creator: 'Pulsar',
      audioFile: `${track.id}.wav`,
      ar: d.ar, od: d.od, cs: d.cs, hp: d.hp,
      multiplier: d.vel / 100,
      tickRate: 1,
      previewTime: Math.round(48 * beatMs),
      builtin: track.id,
      timing: [{ t: 0, beat: beatMs, uninherited: true, meter: 4, sampleSet: 2, sampleIndex: 0, volume: 70, effects: 0 }],
      beatMs, beatZero: 0,
      objects: P.finalizeObjects(objects),
    };
  }

  // Song buffers take a moment to render, so keep them for the session.
  const audioCache = new Map();
  function builtinMap(track, version) {
    const score = buildScore(track);
    const map = buildChart(score, version);
    map.key = `builtin:${track.id}:${version}`;
    map.loadAudioBuffer = () => {
      if (!audioCache.has(track.id)) audioCache.set(track.id, renderScore(score, track));
      return audioCache.get(track.id);
    };
    return map;
  }

  Object.assign(P, { TRACKS, DIFFS, buildScore, buildChart, builtinMap, synthesize });
})(globalThis.Pulsar = globalThis.Pulsar || {});
