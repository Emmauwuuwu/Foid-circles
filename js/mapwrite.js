// Writing maps back out: .osu text, .osz archives and WAV audio, plus tempo detection.
(function (P) {
  'use strict';

  const ms = v => Math.round(v);

  function objectLine(o) {
    const flags = (o.newCombo ? 4 : 0) | (((o.comboSkip || 0) & 7) << 4);
    const hs = o.hitSound || 0;
    if (o.type === 'spin') return `256,192,${ms(o.t)},${8 | flags},${hs},${ms(o.endT)},${o.extras || '0:0:0:0:'}`;
    if (o.type === 'hold') return `${ms(o.x)},192,${ms(o.t)},128,${hs},${ms(o.endT)}:${o.extras || '0:0:0:0:'}`;
    if (o.type === 'slider') {
      const parts = [];
      (o.segments || []).forEach(seg => {
        parts.push(seg.kind);
        seg.points.slice(1).forEach(p => parts.push(`${ms(p[0])}:${ms(p[1])}`));
      });
      const head = [ms(o.x), ms(o.y), ms(o.t), 2 | flags, hs, parts.join('|'), o.slides, +(o.length || o.path.length).toFixed(4)];
      return head.concat(o.extras && o.extras.length ? o.extras : []).join(',');
    }
    return `${ms(o.x)},${ms(o.y)},${ms(o.t)},${1 | flags},${hs},${o.extras || '0:0:0:0:'}`;
  }

  // Turns a parsed or generated map into .osu text that parseBeatmapText reads back identically.
  function serializeMap(m) {
    const raw = m.raw || {};
    const general = {
      AudioLeadIn: 0, PreviewTime: -1, Countdown: 0, SampleSet: 'Soft', StackLeniency: 0.7,
      LetterboxInBreaks: 0, WidescreenStoryboard: 0,
      ...raw.general,
      AudioFilename: m.audioFile || 'audio.wav',
      Mode: m.mode || 0,
    };
    if (m.previewTime != null) general.PreviewTime = ms(m.previewTime);

    const meta = { Source: '', Tags: '', BeatmapID: 0, BeatmapSetID: -1, ...raw.metadata };
    // A title typed in the editor replaces both spellings; an untouched one keeps them.
    if (m.title !== (meta.TitleUnicode || meta.Title)) { meta.Title = m.title; meta.TitleUnicode = m.title; }
    if (m.artist !== (meta.ArtistUnicode || meta.Artist)) { meta.Artist = m.artist; meta.ArtistUnicode = m.artist; }
    meta.Creator = m.creator || '';
    meta.Version = m.version || 'Normal';

    const diff = {
      ...raw.difficulty,
      HPDrainRate: m.hp, CircleSize: m.mode === 3 ? m.keys : m.cs, OverallDifficulty: m.od, ApproachRate: m.ar,
      SliderMultiplier: m.multiplier || 1.4, SliderTickRate: m.tickRate || 1,
    };

    const timing = (m.timing && m.timing.length ? m.timing : [{ t: m.beatZero || 0, beat: m.beatMs || 500, uninherited: true }])
      .slice().sort((a, b) => a.t - b.t)
      .map(p => [p.t, p.beat, p.meter || 4, p.sampleSet || 0, p.sampleIndex || 0, p.volume == null ? 100 : p.volume, p.uninherited ? 1 : 0, p.effects || 0].join(','));

    const pairs = (obj, sep) => Object.entries(obj).map(([k, v]) => `${k}${sep}${v}`);
    const events = raw.events && raw.events.length ? raw.events : m.bgFile ? [`0,0,"${m.bgFile}",0,0`] : [];
    const lines = [
      'osu file format v14', '',
      '[General]', ...pairs(general, ': '), '',
      '[Editor]', ...(raw.editor && raw.editor.length ? raw.editor : ['BeatDivisor: 4', 'GridSize: 32']), '',
      '[Metadata]', ...pairs(meta, ':'), '',
      '[Difficulty]', ...pairs(diff, ':'), '',
      '[Events]', ...events, '',
      '[TimingPoints]', ...timing, '',
    ];
    if (raw.colours && raw.colours.length) lines.push('[Colours]', ...raw.colours, '');
    lines.push('[HitObjects]', ...m.objects.slice().sort((a, b) => a.t - b.t).map(objectLine), '');
    return lines.join('\r\n');
  }

  // ---------- .osz writing: a zip with stored (uncompressed) entries ----------

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function writeZip(entries) {
    const enc = new TextEncoder();
    const parts = [], central = [];
    let offset = 0;
    for (const entry of entries) {
      const name = enc.encode(entry.name);
      const data = typeof entry.data === 'string' ? enc.encode(entry.data) : new Uint8Array(entry.data);
      const crc = crc32(data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // names are UTF-8
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      parts.push(new Uint8Array(local.buffer), name, data);

      const dir = new DataView(new ArrayBuffer(46));
      dir.setUint32(0, 0x02014b50, true);
      dir.setUint16(4, 20, true);
      dir.setUint16(6, 20, true);
      dir.setUint16(8, 0x0800, true);
      dir.setUint32(16, crc, true);
      dir.setUint32(20, data.length, true);
      dir.setUint32(24, data.length, true);
      dir.setUint16(28, name.length, true);
      dir.setUint32(42, offset, true);
      central.push(new Uint8Array(dir.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((v, b) => v + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, entries.length, true);
    end.setUint16(10, entries.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const out = new Uint8Array(all.reduce((v, b) => v + b.length, 0));
    let at = 0;
    for (const b of all) { out.set(b, at); at += b.length; }
    return out;
  }

  // 16-bit PCM, for songs that only exist as a rendered buffer.
  function encodeWav(channels, rate) {
    const count = channels.length, frames = channels[0].length;
    const view = new DataView(new ArrayBuffer(44 + frames * count * 2));
    const text = (at, s) => { for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i)); };
    text(0, 'RIFF'); view.setUint32(4, 36 + frames * count * 2, true); text(8, 'WAVEfmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, count, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * count * 2, true);
    view.setUint16(32, count * 2, true); view.setUint16(34, 16, true);
    text(36, 'data'); view.setUint32(40, frames * count * 2, true);
    let at = 44;
    for (let i = 0; i < frames; i++) {
      for (let ch = 0; ch < count; ch++) {
        view.setInt16(at, Math.max(-1, Math.min(1, channels[ch][i])) * 32767, true);
        at += 2;
      }
    }
    return new Uint8Array(view.buffer);
  }

  // ---------- Tempo detection ----------

  // Estimates BPM and the time of a beat from how the song's energy rises.
  // Returns { bpm, offset } in ms, or null when the audio has no usable pulse.
  function detectTempo(samples, rate) {
    const hop = Math.round(rate * 0.01), hopMs = hop / rate * 1000;
    const total = Math.min(Math.floor(samples.length / hop), 18000);
    if (total < 400) return null;
    const energy = new Float32Array(total);
    for (let i = 0; i < total; i++) {
      let sum = 0;
      for (let j = i * hop, end = j + hop; j < end; j++) sum += samples[j] * samples[j];
      energy[i] = Math.log1p(sum * 200);
    }
    const flux = new Float32Array(total);
    for (let i = 1; i < total; i++) flux[i] = Math.max(0, energy[i] - energy[i - 1]);
    let mean = 0;
    for (let i = 0; i < total; i++) mean += flux[i];
    mean /= total;
    if (mean < 1e-4) return null;
    for (let i = 0; i < total; i++) flux[i] = Math.max(0, flux[i] - mean);

    // Coarse search: autocorrelation at the beat and its multiples, leaning toward common tempos.
    const minLag = Math.floor(60000 / 210 / hopMs), maxLag = Math.ceil(60000 / 65 / hopMs);
    // The envelope is blurred so a beat that falls between two whole lags still registers.
    const soft = new Float32Array(total);
    for (let i = 1; i < total - 1; i++) soft[i] = flux[i] + (flux[i - 1] + flux[i + 1]) * 0.6;
    const ac = new Float64Array(maxLag * 4 + 2);
    for (let lag = minLag; lag < ac.length; lag++) {
      let s = 0;
      for (let i = 0, n = total - lag; i < n; i++) s += soft[i] * soft[i + lag];
      ac[lag] = s;
    }
    let bestLag = minLag, bestScore = -1;
    for (let lag = minLag; lag <= maxLag; lag += 0.25) {
      const bpm = 60000 / (lag * hopMs);
      const prior = Math.exp(-Math.pow(Math.log2(bpm / 135), 2) / (2 * 0.8 * 0.8));
      const at = m => ac[Math.round(lag * m)];
      const score = (at(1) + at(2) * 0.7 + at(3) * 0.5 + at(4) * 0.5) * prior;
      if (score > bestScore) { bestScore = score; bestLag = lag; }
    }

    // Fine search: fold the whole song at each candidate period. Only the true one stays sharp.
    const fold = period => {
      const size = Math.max(8, Math.round(period));
      const bins = new Float64Array(size);
      for (let i = 0; i < total; i++) {
        if (flux[i] > 0) bins[Math.floor((i % period) / period * size) % size] += flux[i];
      }
      const at = i => bins[i] + bins[(i + 1) % size] * 0.5 + bins[(i + size - 1) % size] * 0.5;
      let top = 0, sum = 0;
      for (let i = 0; i < size; i++) {
        sum += bins[i];
        if (at(i) > at(top)) top = i;
      }
      return { score: at(top) / (sum || 1), phase: (top + 0.5) / size * period };
    };
    const coarse = 60000 / (bestLag * hopMs);
    let bpm = coarse, top = -1;
    for (let b = coarse * 0.96; b <= coarse * 1.04; b += 0.02) {
      const { score } = fold(60000 / b / hopMs);
      if (score > top) { top = score; bpm = b; }
    }
    if (Math.abs(bpm - Math.round(bpm)) < 0.12) bpm = Math.round(bpm);
    else bpm = Math.round(bpm * 100) / 100;
    const beat = 60000 / bpm;
    const { phase } = fold(beat / hopMs);
    return { bpm, offset: Math.round(((phase * hopMs) % beat + beat) % beat) };
  }

  Object.assign(P, { serializeMap, writeZip, encodeWav, detectTempo, crc32 });
})(globalThis.Pulsar = globalThis.Pulsar || {});
