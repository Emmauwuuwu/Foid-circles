// Beatmap handling: slider path geometry, .osu text parsing, .osz (zip) reading.
(function (P) {
  'use strict';

  // ---------- Path geometry ----------

  function bezier(pts, steps) {
    const out = [];
    for (let s = 0; s <= steps; s++) {
      const u = s / steps;
      const q = pts.map(p => [p[0], p[1]]);
      for (let k = q.length - 1; k > 0; k--) {
        for (let i = 0; i < k; i++) {
          q[i][0] += (q[i + 1][0] - q[i][0]) * u;
          q[i][1] += (q[i + 1][1] - q[i][1]) * u;
        }
      }
      out.push(q[0]);
    }
    return out;
  }

  function circleArc(a, b, c) {
    const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
    if (Math.abs(d) < 1e-6) return null; // collinear
    const sq = p => p[0] * p[0] + p[1] * p[1];
    const ux = (sq(a) * (b[1] - c[1]) + sq(b) * (c[1] - a[1]) + sq(c) * (a[1] - b[1])) / d;
    const uy = (sq(a) * (c[0] - b[0]) + sq(b) * (a[0] - c[0]) + sq(c) * (b[0] - a[0])) / d;
    const r = Math.hypot(a[0] - ux, a[1] - uy);
    const start = Math.atan2(a[1] - uy, a[0] - ux);
    let end = Math.atan2(c[1] - uy, c[0] - ux);
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    const TAU = Math.PI * 2;
    if (cross > 0) { while (end < start) end += TAU; } else { while (end > start) end -= TAU; }
    const steps = Math.max(8, Math.ceil(Math.abs(end - start) * r / 4));
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const ang = start + (end - start) * i / steps;
      out.push([ux + Math.cos(ang) * r, uy + Math.sin(ang) * r]);
    }
    return out;
  }

  function catmull(pts) {
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (let s = 0; s < 20; s++) {
        const t = s / 20, t2 = t * t, t3 = t2 * t;
        const f = k => 0.5 * (2 * p1[k] + (p2[k] - p0[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (3 * p1[k] - p0[k] - 3 * p2[k] + p3[k]) * t3);
        out.push([f(0), f(1)]);
      }
    }
    out.push(pts[pts.length - 1]);
    return out;
  }

  function samplePoints(kind, control) {
    let raw = [];
    if (kind === 'P' && control.length === 3) raw = circleArc(control[0], control[1], control[2]) || control.slice();
    else if (kind === 'C') raw = catmull(control);
    else if (kind === 'L') raw = control.slice();
    else {
      // Bezier: a repeated control point marks the boundary between segments.
      let seg = [control[0]];
      for (let i = 1; i < control.length; i++) {
        const p = control[i], prev = control[i - 1];
        if (p[0] === prev[0] && p[1] === prev[1]) {
          if (seg.length > 1) raw.push(...bezier(seg, Math.min(100, 12 * seg.length)));
          seg = [p];
        } else seg.push(p);
      }
      if (seg.length > 1) raw.push(...bezier(seg, Math.min(100, 12 * seg.length)));
      if (!raw.length) raw = control.slice();
    }

    return raw;
  }

  // Builds {pts, cum, length} and fits it to `length` (when given): trimmed if the
  // curve is long, extended straight if it is short.
  function fitPath(raw, length) {
    const pts = [raw[0]], cum = [0];
    let total = 0;
    for (let i = 1; i < raw.length; i++) {
      const d = Math.hypot(raw[i][0] - pts[pts.length - 1][0], raw[i][1] - pts[pts.length - 1][1]);
      if (d < 1e-4) continue;
      if (length != null && total + d >= length) {
        const f = (length - total) / d, last = pts[pts.length - 1];
        pts.push([last[0] + (raw[i][0] - last[0]) * f, last[1] + (raw[i][1] - last[1]) * f]);
        total = length;
        cum.push(total);
        return { pts, cum, length: total };
      }
      pts.push(raw[i]);
      total += d;
      cum.push(total);
    }
    if (length != null && total < length && pts.length > 1) {
      const a = pts[pts.length - 2], b = pts[pts.length - 1];
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const extra = length - total;
      pts.push([b[0] + (b[0] - a[0]) / d * extra, b[1] + (b[1] - a[1]) / d * extra]);
      total = length;
      cum.push(total);
    }
    return { pts, cum, length: total };
  }

  function makePath(kind, control, length) {
    return fitPath(samplePoints(kind, control), length);
  }

  function makeSegmentedPath(segments, length) {
    const raw = [];
    for (const seg of segments) {
      if (seg.points.length < 2) continue;
      raw.push(...samplePoints(seg.kind, seg.points));
    }
    return fitPath(raw.length ? raw : segments[0].points, length);
  }

  function pointOnPath(path, dist) {
    const { pts, cum } = path;
    if (pts.length === 1 || dist <= 0) return pts[0];
    if (dist >= path.length) return pts[pts.length - 1];
    let lo = 0, hi = cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= dist) lo = mid; else hi = mid;
    }
    const f = (dist - cum[lo]) / ((cum[hi] - cum[lo]) || 1);
    return [pts[lo][0] + (pts[hi][0] - pts[lo][0]) * f, pts[lo][1] + (pts[hi][1] - pts[lo][1]) * f];
  }

  // Position of the slider ball at song time t, accounting for repeats.
  function sliderPos(o, t) {
    const span = (o.endT - o.t) / o.slides;
    const prog = Math.max(0, Math.min(o.slides, (t - o.t) / span));
    let leg = Math.floor(prog), frac = prog - leg;
    if (leg >= o.slides) { leg = o.slides - 1; frac = 1; }
    if (leg % 2 === 1) frac = 1 - frac;
    return pointOnPath(o.path, frac * o.path.length);
  }

  // Assigns combo numbers and colour indices. Objects with `newCombo` start a new run.
  function finalizeObjects(objects) {
    objects.sort((a, b) => a.t - b.t);
    let num = 0, col = 0;
    objects.forEach((o, i) => {
      if (i === 0 || o.newCombo || o.type === 'spin') {
        if (i !== 0) col += 1 + (o.comboSkip || 0);
        num = 0;
      }
      o.num = ++num;
      o.color = col;
    });
    return objects;
  }

  // ---------- .osu parsing ----------

  function parseBeatmapText(text, opts = {}) {
    const sections = {};
    let cur = null;
    for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;
      const m = line.match(/^\[(\w+)\]$/);
      if (m) { cur = m[1]; sections[cur] = []; continue; }
      // Storyboard commands use leading spaces, so events keep their indentation.
      if (cur) sections[cur].push(cur === 'Events' ? rawLine.trimEnd() : line);
    }
    if (!sections.HitObjects && !opts.allowEmpty) throw new Error('No hit objects in this file');
    sections.HitObjects = sections.HitObjects || [];

    const kv = name => {
      const out = {};
      for (const l of sections[name] || []) {
        const i = l.indexOf(':');
        if (i > 0) out[l.slice(0, i).trim()] = l.slice(i + 1).trim();
      }
      return out;
    };
    const general = kv('General'), meta = kv('Metadata'), diff = kv('Difficulty');
    const mode = general.Mode === undefined ? 0 : parseInt(general.Mode, 10);
    if (![0, 1, 2, 3].includes(mode)) throw new Error(`unknown game mode ${general.Mode}`);

    const num = (v, d) => { const n = parseFloat(v); return Number.isFinite(n) ? n : d; };
    const od = num(diff.OverallDifficulty, 5);
    const map = {
      mode,
      title: meta.TitleUnicode || meta.Title || 'Unknown',
      artist: meta.ArtistUnicode || meta.Artist || 'Unknown',
      version: meta.Version || 'Normal',
      creator: meta.Creator || '',
      audioFile: general.AudioFilename || '',
      bgFile: null,
      od,
      ar: num(diff.ApproachRate, od),
      cs: num(diff.CircleSize, 4),
      hp: num(diff.HPDrainRate, 5),
      previewTime: num(general.PreviewTime, -1),
      // Everything the game ignores, kept so a saved or exported map loses nothing.
      raw: { general, metadata: meta, difficulty: diff, editor: sections.Editor || [], events: sections.Events || [], colours: sections.Colours || [] },
    };

    for (const l of sections.Events || []) {
      const m = l.trim().match(/^0\s*,\s*0\s*,\s*"?([^",]+)"?/);
      if (m) { map.bgFile = m[1]; break; }
    }

    const timing = (sections.TimingPoints || []).map(l => {
      const f = l.split(',');
      const beat = parseFloat(f[1]);
      const uninherited = f.length > 6 ? f[6].trim() === '1' : beat > 0;
      return {
        t: parseFloat(f[0]), beat, uninherited,
        meter: parseInt(f[2], 10) || 4, sampleSet: parseInt(f[3], 10) || 0, sampleIndex: parseInt(f[4], 10) || 0,
        volume: Number.isFinite(parseInt(f[5], 10)) ? parseInt(f[5], 10) : 100, effects: parseInt(f[7], 10) || 0,
      };
    }).filter(p => Number.isFinite(p.t) && Number.isFinite(p.beat)).sort((a, b) => a.t - b.t);

    const firstRed = timing.find(p => p.uninherited);
    map.beatMs = firstRed ? firstRed.beat : 500;
    map.beatZero = firstRed ? firstRed.t : 0;
    map.timing = timing;

    const multiplier = num(diff.SliderMultiplier, 1.4);
    map.multiplier = multiplier;
    map.tickRate = num(diff.SliderTickRate, 1) || 1;
    map.keys = Math.max(1, Math.min(18, Math.round(map.cs)));
    const objects = [];
    let tp = 0, beat = map.beatMs, sv = 1;

    const lines = sections.HitObjects
      .map(l => l.split(','))
      .filter(f => f.length >= 4)
      .sort((a, b) => parseFloat(a[2]) - parseFloat(b[2]));

    for (const f of lines) {
      const x = parseFloat(f[0]), y = parseFloat(f[1]), t = parseFloat(f[2]), type = parseInt(f[3], 10);
      if (![x, y, t, type].every(Number.isFinite)) continue;

      while (tp < timing.length && timing[tp].t <= t) {
        const p = timing[tp++];
        if (p.uninherited) { beat = p.beat; sv = 1; }
        else sv = p.beat < 0 ? Math.max(0.1, Math.min(10, -100 / p.beat)) : 1;
      }

      const o = { t, x, y, newCombo: !!(type & 4), comboSkip: (type >> 4) & 7, hitSound: parseInt(f[4], 10) || 0, sv, beat };
      if (type & 128) {
        // Held note: the end time is the first colon-separated field.
        o.endT = parseFloat(f[5]);
        o.type = o.endT > t ? 'hold' : 'tap';
        o.extras = String(f[5] || '').split(':').slice(1).join(':');
      } else if (type & 1) {
        o.type = 'tap';
        o.extras = f[5] || '';
      } else if (type & 2) {
        if (f.length < 7) continue;
        const parts = f[5].split('|');
        // A letter partway through the points starts a new curve segment at the previous point.
        const segments = [{ kind: parts[0][0], points: [[x, y]] }];
        for (const c of parts.slice(1)) {
          const seg = segments[segments.length - 1];
          if (/^[A-Za-z]/.test(c)) {
            segments.push({ kind: c[0], points: [seg.points[seg.points.length - 1]] });
            continue;
          }
          const xy = c.split(':').map(Number);
          if (xy.length === 2 && xy.every(Number.isFinite)) seg.points.push(xy);
        }
        const given = parseFloat(f[7]);
        const slides = Math.max(1, parseInt(f[6], 10) || 1);
        const path = segments.some(g => g.points.length > 1) ? makeSegmentedPath(segments, given > 0 ? given : null) : null;
        if (!path || !(path.length > 0) || !(beat > 0)) { o.type = 'tap'; objects.push(o); continue; }
        o.type = 'slider';
        o.slides = slides;
        o.path = path;
        o.segments = segments;
        o.length = path.length;
        o.extras = f.slice(8);
        o.endT = t + path.length / (multiplier * 100 * sv) * beat * slides;
      } else if (type & 8) {
        o.type = 'spin';
        o.x = 256; o.y = 192;
        o.endT = parseFloat(f[5]);
        if (!(o.endT > t)) continue;
        o.extras = f[6] || '';
      } else continue;
      objects.push(o);
    }
    if (!objects.length && !opts.allowEmpty) throw new Error('No playable objects in this file');
    map.objects = finalizeObjects(objects);
    return map;
  }

  // ---------- .osz reading (a plain zip archive) ----------

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readZip(buffer) {
    const bytes = new Uint8Array(buffer);
    const view = new DataView(buffer);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 66000); i--) {
      if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .osz archive');
    const count = view.getUint16(eocd + 10, true);
    let p = view.getUint32(eocd + 16, true);
    const decoder = new TextDecoder();
    const files = new Map();
    for (let i = 0; i < count; i++) {
      if (view.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt .osz archive');
      const method = view.getUint16(p + 10, true);
      const compSize = view.getUint32(p + 20, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      const local = view.getUint32(p + 42, true);
      const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
      p += 46 + nameLen + extraLen + commentLen;
      if (name.endsWith('/')) continue;
      if (method !== 0 && method !== 8) continue;
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + compSize);
      // Inflated lazily: audio and images are large and most files are never needed.
      files.set(name.toLowerCase(), { name, get: () => method === 0 ? Promise.resolve(data) : inflateRaw(data) });
    }
    return files;
  }

  // Turns an uploaded file into a list of maps. Each map can load its own audio/background.
  async function loadMapFile(name, buffer) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.osu')) {
      const map = parseBeatmapText(new TextDecoder().decode(buffer));
      map.needsAudio = true;
      return [map];
    }
    const files = await readZip(buffer);
    const maps = [];
    const errors = [];
    const asset = fname => files.get(String(fname).replace(/\\/g, '/').toLowerCase());
    const audioFiles = [...files.entries()].filter(([k]) => /\.(mp3|ogg|wav|flac|m4a|aac|opus)$/.test(k)).map(e => e[1]);
    for (const [key, entry] of files) {
      if (!key.endsWith('.osu')) continue;
      try {
        const map = parseBeatmapText(new TextDecoder().decode(await entry.get()));
        const audio = asset(map.audioFile) || (audioFiles.length === 1 ? audioFiles[0] : null);
        const bg = map.bgFile && asset(map.bgFile);
        map.loadAudioBytes = audio ? () => audio.get() : null;
        map.silent = !audio;
        map.loadBgBytes = bg ? () => bg.get() : null;
        maps.push(map);
      } catch (e) { errors.push(e.message); }
    }
    if (!maps.length) throw new Error(errors[0] || 'No beatmaps found in this archive');
    return maps;
  }

  Object.assign(P, { makePath, makeSegmentedPath, pointOnPath, sliderPos, finalizeObjects, parseBeatmapText, readZip, loadMapFile });
})(globalThis.Pulsar = globalThis.Pulsar || {});
