// Screens, settings, library storage, song preview and input routing.
(function (P) {
  'use strict';

  const $ = id => document.getElementById(id);
  const screens = ['menu', 'loading', 'pause', 'results', 'editor'];
  const show = name => {
    screens.forEach(s => $(s).classList.toggle('hidden', s !== name));
    const artOn = name === 'menu' || name === 'results' || name === 'loading';
    $('art').classList.toggle('hidden', !artOn);
    if (art) { if (artOn) art.start(); else art.stop(); }
  };
  let art = null;

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('pulsar.' + key); return v == null ? fallback : JSON.parse(v); }
      catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('pulsar.' + key, JSON.stringify(value)); } catch (e) { /* private mode */ }
    },
  };

  const settings = Object.assign({ music: 0.8, sfx: 0.6, offset: 0, scroll: 650, auto: false, nofail: false }, store.get('settings', {}));
  const best = store.get('best', {});

  // ---------- Audio graph ----------

  let audioCtx = null, musicGain = null, sfxGain = null, analyser = null;
  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      musicGain = audioCtx.createGain();
      sfxGain = audioCtx.createGain();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.6;
      musicGain.connect(audioCtx.destination);
      sfxGain.connect(audioCtx.destination);
      P.musicOut = musicGain;
    }
    musicGain.gain.value = settings.music;
    sfxGain.gain.value = settings.sfx;
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  // ---------- Storage: imported archives, plus maps made here ----------

  const DB = {
    open() {
      return new Promise((res, rej) => {
        const r = indexedDB.open('pulsar', 2);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('sets')) db.createObjectStore('sets', { keyPath: 'name' });
          if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
        };
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    },
    async run(store, mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => {
        const tx = db.transaction(store, mode);
        const req = fn(tx.objectStore(store));
        tx.oncomplete = () => { db.close(); res(req.result); };
        tx.onerror = () => { db.close(); rej(tx.error); };
        tx.onabort = () => { db.close(); rej(tx.error); };
      });
    },
    put(store, value) { return this.run(store, 'readwrite', s => s.put(value)); },
    remove(store, key) { return this.run(store, 'readwrite', s => s.delete(key)); },
    get(store, key) { return this.run(store, 'readonly', s => s.get(key)); },
    all(store) { return this.run(store, 'readonly', s => s.getAll()); },
  };

  // ---------- Library ----------

  // Rows: { id, kind, title, artist, sub, accent, versions: [{ label, key, get(), modeTag }], setName?, project? }
  const library = [];
  const PALETTE = [[216, 255, 62], [94, 234, 212], [165, 180, 252], [255, 122, 102], [255, 212, 121]];
  const accentFor = text => {
    let h = 7;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  };
  const modeTagOf = m => ['Standard', 'Taiko', 'Catch', `Mania ${m.keys}K`][m.mode || 0];

  function addBuiltins() {
    const accents = { redline: [255, 77, 94], glasshouse: PALETTE[1], 'night-ferry': PALETTE[2], 'copper-sun': PALETTE[4], 'static-bloom': PALETTE[3] };
    for (const track of P.TRACKS) {
      const versions = (track.versions || Object.keys(P.DIFFS)).map(label => {
        let map = null;
        return { label, key: `builtin:${track.id}:${label}`, modeTag: 'Standard', get: () => (map = map || P.builtinMap(track, label)) };
      });
      library.push({ id: 'builtin:' + track.id, kind: 'builtin', title: track.title, artist: 'Pulsar Synth', sub: track.mood, bpm: track.bpm, accent: accents[track.id], versions });
    }
  }

  async function addImported(fileName, buffer) {
    const maps = await P.loadMapFile(fileName, buffer);
    const groups = new Map();
    for (const m of maps) {
      const id = `import:${fileName}:${m.title}`;
      if (!groups.has(id)) groups.set(id, { id, kind: 'import', title: m.title, artist: m.artist, sub: m.creator ? `Mapped by ${m.creator}` : 'Imported', setName: fileName, accent: accentFor(m.title), versions: [] });
      m.key = `${id}:${m.version}`;
      groups.get(id).versions.push({ label: m.version, key: m.key, get: () => m, count: m.objects.length, modeTag: modeTagOf(m) });
    }
    for (const g of groups.values()) {
      g.versions.sort((a, b) => a.count - b.count);
      const at = library.findIndex(r => r.id === g.id);
      if (at >= 0) library[at] = g; else library.push(g);
    }
    return [...groups.values()];
  }

  // A saved editor map as something the menu and game can load.
  function projectMap(rec) {
    const m = P.parseBeatmapText(rec.osu, { allowEmpty: true });
    m.key = `project:${rec.id}`;
    m.projectId = rec.id;
    if (rec.builtin) {
      const track = P.TRACKS.find(t => t.id === rec.builtin);
      if (track) m.loadAudioBuffer = P.builtinMap(track, 'Easy').loadAudioBuffer;
    } else {
      m.loadAudioBytes = async () => {
        const assets = await DB.get('assets', rec.id);
        if (!assets || !assets.audio) throw new Error('This map has lost its song file.');
        return new Uint8Array(assets.audio);
      };
    }
    m.silent = !rec.builtin && !rec.hasAudio;
    if (m.silent) m.loadAudioBytes = null;
    m.loadBgBytes = async () => {
      const assets = await DB.get('assets', rec.id);
      if (!assets || !assets.bg) throw new Error('no background');
      return new Uint8Array(assets.bg);
    };
    return m;
  }

  function projectRow(rec) {
    const m = projectMap(rec);
    return {
      id: `project:${rec.id}`,
      kind: 'project',
      project: rec,
      title: m.title,
      artist: m.artist,
      sub: m.creator ? `Your map · by ${m.creator}` : 'Your map',
      accent: accentFor(rec.id),
      versions: [{ label: m.version, key: m.key, modeTag: modeTagOf(m), get: () => m }],
    };
  }

  function upsertProject(rec) {
    const row = projectRow(rec);
    const at = library.findIndex(r => r.id === row.id);
    if (at >= 0) library[at] = row; else library.push(row);
    return row;
  }

  async function importFiles(fileList) {
    const files = [...fileList];
    const failures = [];
    let first = null;
    for (const f of files) {
      if (!/\.(osz|olz|osu)$/i.test(f.name)) { failures.push(`${f.name}: not a beatmap file`); continue; }
      try {
        const buf = await f.arrayBuffer();
        const rows = await addImported(f.name, buf);
        first = first || rows[0];
        // A bare .osu has no audio to play, so only full archives are worth keeping.
        if (!/\.osu$/i.test(f.name)) await DB.put('sets', { name: f.name, data: buf }).catch(() => {});
      } catch (e) { failures.push(`${f.name}: ${e.message}`); }
    }
    if (first) { state.filter = 'all'; state.search = ''; $('search').value = ''; state.rowId = first.id; state.versionAt = 0; }
    renderLibrary();
    selectCurrent();
    setNotice(failures.join(' · '));
  }

  function setNotice(text) {
    $('notice').textContent = text;
    $('notice').classList.toggle('hidden', !text);
  }

  // ---------- Menu ----------

  const state = { rowId: null, versionAt: 0, filter: 'all', search: '' };
  const fmtScore = n => n.toLocaleString('en-US');
  const fmtLen = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
  const FILTERS = [['all', 'All'], ['Standard', 'Standard'], ['Taiko', 'Taiko'], ['Catch', 'Catch'], ['Mania', 'Mania'], ['mine', 'Yours']];

  function rowMatches(row) {
    const q = state.search.trim().toLowerCase();
    if (q && !`${row.title} ${row.artist} ${row.versions.map(v => v.label).join(' ')}`.toLowerCase().includes(q)) return false;
    if (state.filter === 'all') return true;
    if (state.filter === 'mine') return row.kind === 'project';
    return row.versions.some(v => v.modeTag.startsWith(state.filter));
  }

  const visibleRows = () => library.filter(rowMatches);

  function renderFilters() {
    const root = $('filters');
    root.textContent = '';
    for (const [id, label] of FILTERS) {
      const b = document.createElement('button');
      b.className = 'chip';
      b.textContent = label;
      b.setAttribute('aria-pressed', String(state.filter === id));
      b.addEventListener('click', () => {
        state.filter = id;
        renderFilters();
        renderLibrary();
        const rows = visibleRows();
        if (rows.length && !rows.some(r => r.id === state.rowId)) selectRow(rows[0]);
      });
      root.append(b);
    }
  }

  function renderLibrary() {
    const root = $('library');
    root.textContent = '';
    const rows = visibleRows();
    if (!rows.length) {
      const li = document.createElement('li');
      li.className = 'none';
      li.textContent = state.filter === 'mine' && !state.search ? 'Nothing here yet. Press New map to make one.' : 'No songs match that.';
      root.append(li);
      return;
    }
    rows.forEach((row, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'song';
      btn.dataset.row = row.id;
      btn.setAttribute('aria-current', String(row.id === state.rowId));
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = String(i + 1).padStart(2, '0');
      const title = document.createElement('span');
      title.className = 'song-title';
      title.textContent = row.title;
      const sub = document.createElement('span');
      sub.className = 'song-sub';
      const modes = [...new Set(row.versions.map(v => v.modeTag))].join(' · ');
      sub.textContent = `${row.artist}  /  ${modes}`;
      btn.append(num, title, sub);
      btn.addEventListener('click', () => selectRow(row));
      li.append(btn);
      root.append(li);
    });
  }

  const currentRow = () => library.find(r => r.id === state.rowId) || null;
  const currentVersion = () => { const r = currentRow(); return r ? r.versions[state.versionAt] || r.versions[0] : null; };

  function selectRow(row, versionAt = 0) {
    state.rowId = row.id;
    state.versionAt = versionAt;
    document.querySelectorAll('.song').forEach(b => b.setAttribute('aria-current', String(b.dataset.row === row.id)));
    const el = document.querySelector('.song[aria-current="true"]');
    if (el) el.scrollIntoView({ block: 'nearest' });
    selectCurrent();
  }

  function mapFacts(m) {
    const objs = m.objects;
    if (!objs.length) return { notes: 0, length: 0, density: 0, bpm: m.beatMs ? 60000 / m.beatMs : 0 };
    const first = objs[0].t;
    const last = objs.reduce((v, o) => Math.max(v, o.endT || o.t), 0);
    return { notes: objs.length, length: last, density: objs.length / Math.max(1, (last - first) / 1000), bpm: 60000 / m.beatMs };
  }

  function selectCurrent() {
    const row = currentRow();
    const hero = $('hero');
    hero.classList.toggle('blank', !row);
    if (!row) return;
    const v = currentVersion();
    const m = v.get();
    const facts = mapFacts(m);

    $('hero-kicker').textContent = row.sub;
    const title = $('hero-title');
    title.textContent = row.title;
    title.style.setProperty('--len', String(Math.max(6, row.title.length)));
    $('hero-artist').textContent = row.artist;

    const diffs = $('hero-diffs');
    diffs.textContent = '';
    const densest = Math.max(...row.versions.map(x => mapFacts(x.get()).density), 1);
    row.versions.forEach((x, i) => {
      const b = document.createElement('button');
      b.className = 'diff';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(i === state.versionAt));
      const name = document.createElement('span');
      name.className = 'diff-name';
      name.textContent = x.label;
      const sub = document.createElement('span');
      sub.className = 'diff-sub';
      const f = mapFacts(x.get());
      sub.textContent = `${x.modeTag} · ${f.density.toFixed(1)}/s`;
      const bar = document.createElement('span');
      bar.className = 'diff-bar';
      bar.style.setProperty('--fill', `${Math.round(f.density / densest * 100)}%`);
      b.append(name, sub, bar);
      b.addEventListener('click', () => { state.versionAt = i; selectCurrent(); });
      diffs.append(b);
    });

    const b = best[v.key];
    const list = [
      ['Length', facts.length ? fmtLen(facts.length) : '–'],
      ['BPM', facts.bpm ? String(Math.round(facts.bpm)) : '–'],
      ['Notes', fmtScore(facts.notes)],
      ['Best', b ? `${b.grade === 'X' ? 'SS' : b.grade} · ${(b.accuracy * 100).toFixed(1)}%` : '–'],
    ];
    const dl = $('hero-facts');
    dl.textContent = '';
    for (const [k, val] of list) {
      const wrap = document.createElement('div');
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = val;
      wrap.append(dt, dd);
      dl.append(wrap);
    }

    $('btn-play').disabled = !facts.notes;
    $('hero-keys').textContent = keyLine(m);
    $('btn-edit-label').textContent = row.kind === 'project' ? 'Edit' : 'Edit a copy';
    $('btn-remove').classList.toggle('hidden', row.kind === 'builtin');
    armRemove(false);

    art.set({ accent: row.accent, bpm: facts.bpm || 120, beatZero: m.beatZero || 0, image: bgCache.get(row.id) || null });
    loadRowBackground(row, m);
    queuePreview(row, m);
  }

  function keyLine(m) {
    if (!m.objects.length) return 'No notes yet. Open it in the editor to place some.';
    switch (m.mode || 0) {
      case 1: return 'F J center   ·   D K rim';
      case 2: return '← → move   ·   Shift dash';
      case 3: return `Keys  ${P.maniaKeys(m.keys).map(P.keyLabel).join(' ')}`;
      default: return 'Mouse to aim   ·   Z X or click to hit';
    }
  }

  // ---------- Backgrounds and song previews ----------

  const bgCache = new Map();
  async function loadRowBackground(row, m) {
    if (bgCache.has(row.id) || !m.loadBgBytes) return;
    bgCache.set(row.id, null);
    try {
      const bmp = await createImageBitmap(new Blob([await m.loadBgBytes()]));
      bgCache.set(row.id, bmp);
      if (state.rowId === row.id) art.set({ image: bmp });
    } catch (e) { /* no art is fine */ }
  }

  let previewToken = 0, previewSrc = null, previewGain = null, previewTimer = 0;
  const previewBuffers = new Map();
  let gestured = false;

  function stopPreview(fade = 0.25) {
    previewToken++;
    clearTimeout(previewTimer);
    if (!previewSrc) return;
    const src = previewSrc, gain = previewGain;
    previewSrc = null;
    previewGain = null;
    const now = audioCtx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fade);
    try { src.stop(now + fade + 0.02); } catch (e) { /* already stopped */ }
    art.analyser = null;
  }

  function queuePreview(row, m) {
    stopPreview();
    if (!gestured) return;
    const token = previewToken;
    previewTimer = setTimeout(async () => {
      const cacheKey = `${row.id}|${m.audioFile || ''}`;
      try {
        let buffer = previewBuffers.get(cacheKey);
        if (!buffer) {
          if (m.loadAudioBuffer) buffer = await m.loadAudioBuffer();
          else if (m.loadAudioBytes) buffer = await audioCtx.decodeAudioData((await m.loadAudioBytes()).slice().buffer);
          else return;
          if (previewBuffers.size > 4) previewBuffers.delete(previewBuffers.keys().next().value);
          previewBuffers.set(cacheKey, buffer);
        }
        if (token !== previewToken || game || P.editor) return;
        const dur = buffer.duration;
        let start = m.previewTime > 0 ? m.previewTime / 1000 : dur * 0.35;
        if (start >= dur - 4) start = Math.max(0, dur * 0.35);
        const src = audioCtx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        src.loopStart = start;
        src.loopEnd = dur;
        const gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0, audioCtx.currentTime);
        gain.gain.linearRampToValueAtTime(1, audioCtx.currentTime + 0.5);
        src.connect(gain);
        gain.connect(analyser);
        gain.connect(musicGain);
        src.start(0, start);
        previewSrc = src;
        previewGain = gain;
        art.analyser = analyser;
        // Lock the visual pulse to what is actually playing.
        const beatMs = m.beatMs || 500;
        art.set({ bpm: 60000 / beatMs, beatZero: performance.now() - (start * 1000 - (m.beatZero || 0)) });
      } catch (e) { /* the menu stays usable without a preview */ }
    }, 280);
  }

  // ---------- Settings ----------

  function bindSettings() {
    const bindRange = (id, key, fmt) => {
      const el = $(id), out = $(id + '-val');
      el.value = settings[key];
      out.textContent = fmt(settings[key]);
      el.addEventListener('input', () => {
        settings[key] = parseFloat(el.value);
        out.textContent = fmt(settings[key]);
        store.set('settings', settings);
        if (audioCtx) { musicGain.gain.value = settings.music; sfxGain.gain.value = settings.sfx; }
      });
    };
    const pct = v => `${Math.round(v * 100)}%`;
    bindRange('set-music', 'music', pct);
    bindRange('set-sfx', 'sfx', pct);
    bindRange('set-offset', 'offset', v => `${v > 0 ? '+' : ''}${v} ms`);
    bindRange('set-scroll', 'scroll', v => `${v} ms`);

    const bindCheck = (id, key) => {
      const el = $(id);
      el.checked = settings[key];
      el.addEventListener('change', () => { settings[key] = el.checked; store.set('settings', settings); });
    };
    bindCheck('mod-auto', 'auto');
    bindCheck('mod-nofail', 'nofail');
  }

  const drawer = open => {
    $('settings').classList.toggle('open', open);
    $('settings').setAttribute('aria-hidden', String(!open));
    $('settings').inert = !open;
    if (open) $('settings-close').focus();
  };

  // ---------- Play session ----------

  let game = null, currentMap = null, testRun = null;
  const canvas = $('stage');

  function failLoad(message) {
    show('menu');
    canvas.classList.remove('live');
    setNotice(message);
  }

  async function loadAudioFor(map) {
    if (map.loadAudioBuffer) return map.loadAudioBuffer();
    if (map.loadAudioBytes) return audioCtx.decodeAudioData((await map.loadAudioBytes()).slice().buffer);
    if (map.silent) {
      // The archive ships no audio at all, so the chart plays against silence.
      const end = map.objects.reduce((v, o) => Math.max(v, o.endT || o.t), 0);
      return audioCtx.createBuffer(1, Math.ceil(audioCtx.sampleRate * Math.max(end / 1000 + 60, 180)), audioCtx.sampleRate);
    }
    throw new Error(`"${map.title}" has no audio. Import the full .osz to play it.`);
  }

  async function loadBackground(map) {
    if (!map.loadBgBytes) return null;
    try {
      return await createImageBitmap(new Blob([await map.loadBgBytes()]));
    } catch (e) { return null; /* a missing background should never block play */ }
  }

  async function loadAssets(map) {
    return { audioBuffer: await loadAudioFor(map), bgImage: await loadBackground(map) };
  }

  const loading = text => { $('loading-text').textContent = text; show('loading'); };

  async function play(map) {
    setNotice('');
    ensureAudio();
    stopPreview();
    currentMap = map;
    testRun = null;
    loading(map.loadAudioBuffer ? `Composing ${map.title}` : `Loading ${map.title}`);
    let assets;
    try {
      await new Promise(r => setTimeout(r, 30));
      assets = await loadAssets(map);
    } catch (e) {
      failLoad(e.message || 'This song could not be loaded.');
      return;
    }
    if (currentMap !== map) return;
    startGame(map, assets);
  }

  function startGame(map, assets, extra = {}) {
    if (game) game.destroy();
    show(null);
    canvas.classList.add('live');
    game = P.createSession(canvas, {
      map,
      audioCtx,
      sfxGain,
      audioBuffer: assets.audioBuffer,
      bgImage: assets.bgImage,
      mods: extra.mods || { auto: settings.auto, nofail: settings.nofail },
      offset: settings.offset,
      scrollMs: settings.scroll,
      from: extra.from,
      onEnd: result => (testRun ? endTest(result) : showResults(map, result, assets)),
    });
    P.current = game;
    game.start();
  }

  function leaveGame() {
    if (testRun) { endTest(null); return; }
    if (game) game.destroy();
    game = null;
    P.current = null;
    currentMap = null;
    canvas.classList.remove('live');
    show('menu');
    selectCurrent();
  }

  function showResults(map, r, assets) {
    canvas.classList.remove('live');
    game = null;
    const isBest = !r.auto && !r.failed && !(best[map.key] && best[map.key].score >= r.score);
    if (isBest) {
      best[map.key] = { score: r.score, grade: r.grade, accuracy: r.accuracy };
      store.set('best', best);
    }
    const grade = r.grade === 'X' ? 'SS' : r.grade;
    $('res-grade').textContent = grade;
    $('res-grade-wrap').dataset.grade = r.grade;
    $('res-title').textContent = r.failed ? 'Out of health' : map.title;
    $('res-sub').textContent = `${map.artist} · ${map.title} · ${map.version}${r.auto ? ' · Auto' : ''}`;
    $('res-acc').textContent = `${(r.accuracy * 100).toFixed(2)}%`;
    $('res-combo').textContent = `${r.maxCombo}x`;
    $('res-perfect').textContent = r.counts.perfect;
    $('res-great').textContent = r.counts.great;
    $('res-ok').textContent = r.counts.ok;
    $('res-miss').textContent = r.counts.miss;
    const total = Math.max(1, r.counts.perfect + r.counts.great + r.counts.ok + r.counts.miss);
    ['perfect', 'great', 'ok', 'miss'].forEach(k => $(`res-bar-${k}`).style.setProperty('--share', `${r.counts[k] / total * 100}%`));
    const off = Math.round(Math.abs(r.meanError));
    $('res-timing').textContent = r.auto ? "Played by Auto, so this score isn't saved." : off < 1 ? 'Your timing was dead on.' : `On average you hit ${off} ms ${r.meanError > 0 ? 'late' : 'early'}.`;
    $('res-best').classList.toggle('hidden', !isBest);
    $('res-retry').onclick = () => startGame(map, assets);
    show('results');

    // Count the score up: a little ceremony for the one number people look at.
    const el = $('res-score'), start = performance.now(), target = r.score;
    const run = now => {
      const k = Math.min(1, (now - start) / 700);
      el.textContent = fmtScore(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1 && !$('results').classList.contains('hidden')) requestAnimationFrame(run);
    };
    requestAnimationFrame(run);
  }

  // ---------- Input ----------

  function menuOpen() {
    return !$('menu').classList.contains('hidden') && $('newmap').classList.contains('hidden') && !$('settings').classList.contains('open');
  }

  function menuKey(e) {
    const tag = e.target.tagName;
    if (e.key === 'Escape') {
      if ($('settings').classList.contains('open')) { drawer(false); return; }
      if (!$('newmap').classList.contains('hidden')) { closeNewMap(); return; }
      if (tag === 'INPUT') { e.target.value = ''; state.search = ''; renderLibrary(); e.target.blur(); }
      return;
    }
    if (!menuOpen()) return;
    if (tag === 'INPUT' && e.target.id !== 'search') return;
    const typing = tag === 'INPUT';
    if (e.key === '/' && !typing) { e.preventDefault(); $('search').focus(); return; }
    const rows = visibleRows();
    const at = rows.findIndex(r => r.id === state.rowId);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) selectRow(rows[(at + (e.key === 'ArrowDown' ? 1 : rows.length - 1) + rows.length) % rows.length]);
      return;
    }
    const row = currentRow();
    if (!row) return;
    if (!typing && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault();
      const n = row.versions.length;
      state.versionAt = (state.versionAt + (e.key === 'ArrowRight' ? 1 : n - 1)) % n;
      selectCurrent();
      return;
    }
    if (e.key === 'Enter' && (typing || !['BUTTON', 'A'].includes(tag))) {
      e.preventDefault();
      if (!$('btn-play').disabled) play(currentVersion().get());
      return;
    }
    if (!typing && e.key.toLowerCase() === 'e') editCurrent();
  }

  function bindInput() {
    const firstGesture = () => {
      if (gestured) return;
      gestured = true;
      ensureAudio();
      const row = currentRow();
      if (row && !$('menu').classList.contains('hidden')) queuePreview(row, currentVersion().get());
    };
    window.addEventListener('pointerdown', firstGesture, true);
    window.addEventListener('keydown', firstGesture, true);

    window.addEventListener('pointermove', e => {
      if (!game) return;
      const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      const last = events.length ? events[events.length - 1] : e;
      game.setCursorScreen(last.clientX, last.clientY);
    });
    canvas.addEventListener('pointerdown', e => {
      if (!game) return;
      e.preventDefault();
      game.pointerPress(e, 'p' + e.pointerId + ':' + e.button);
    });
    window.addEventListener('pointerup', e => { if (game) game.release('p' + e.pointerId + ':' + e.button); });
    window.addEventListener('pointercancel', e => { if (game) game.release('p' + e.pointerId + ':' + e.button); });
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    window.addEventListener('keydown', e => {
      if (!game) {
        if (P.editor) return;
        if (!$('results').classList.contains('hidden')) {
          if (e.key === 'Enter') { e.preventDefault(); $('res-retry').click(); }
          else if (e.key === 'Escape') { e.preventDefault(); leaveGame(); }
          return;
        }
        menuKey(e);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (testRun) { endTest(null); return; }
        if (game.paused) resumeGame(); else pauseGame();
        return;
      }
      if (e.repeat || game.paused) return;
      // Space skips a long intro first; mania layouts may also use it as a column key.
      if (e.code === 'Space' && game.canSkip(game.time())) { e.preventDefault(); game.skip(); return; }
      if (game.usesKey(e.code)) { e.preventDefault(); game.press(e.code); }
    });
    window.addEventListener('keyup', e => { if (game) game.release(e.code); });
    window.addEventListener('resize', () => { if (game) game.resize(); });
    // Losing focus mid-song would otherwise cost a run while the player is away.
    window.addEventListener('blur', () => { if (game && !game.mods.auto) pauseGame(); });

    $('btn-resume').addEventListener('click', resumeGame);
    $('btn-retry').addEventListener('click', () => {
      if (testRun) { const run = testRun; startTest(run.map, run.from, run.auto, run.assets); return; }
      const map = currentMap;
      if (game) game.destroy();
      game = null;
      play(map);
    });
    $('btn-quit').addEventListener('click', leaveGame);
    $('res-back').addEventListener('click', leaveGame);

    $('btn-play').addEventListener('click', () => { const v = currentVersion(); if (v) play(v.get()); });
    $('btn-edit').addEventListener('click', editCurrent);
    $('btn-remove').addEventListener('click', removeCurrent);
    $('btn-settings').addEventListener('click', () => drawer(true));
    $('settings-close').addEventListener('click', () => drawer(false));
    $('search').addEventListener('input', () => {
      state.search = $('search').value;
      renderLibrary();
      const rows = visibleRows();
      if (rows.length && !rows.some(r => r.id === state.rowId)) selectRow(rows[0]);
    });

    const picker = $('file');
    $('btn-import').addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => { importFiles(picker.files); picker.value = ''; });
    window.addEventListener('dragover', e => { e.preventDefault(); if (!game && !P.editor) document.body.classList.add('dropping'); });
    window.addEventListener('dragleave', e => { if (!e.relatedTarget) document.body.classList.remove('dropping'); });
    window.addEventListener('drop', e => {
      e.preventDefault();
      document.body.classList.remove('dropping');
      if (!game && !P.editor && e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
    });

    bindNewMap();
  }

  function pauseGame() {
    if (!game || game.paused) return;
    game.pause();
    game.releaseAll();
    canvas.classList.remove('live');
    $('pause-song').textContent = currentMap ? `${currentMap.title} · ${currentMap.version}` : '';
    $('btn-quit').textContent = testRun ? 'Back to editor' : 'Quit to songs';
    show('pause');
  }

  function resumeGame() {
    if (!game) return;
    show(null);
    canvas.classList.add('live');
    game.resume();
  }

  // ---------- Removing songs, with one step of confirmation ----------

  let removeArmed = false, removeTimer = 0;
  function armRemove(on) {
    removeArmed = on;
    clearTimeout(removeTimer);
    const row = currentRow();
    $('btn-remove').textContent = on ? 'Press again to remove' : row && row.kind === 'project' ? 'Delete map' : 'Remove';
    $('btn-remove').classList.toggle('armed', on);
    if (on) removeTimer = setTimeout(() => armRemove(false), 3000);
  }

  async function removeCurrent() {
    const row = currentRow();
    if (!row || row.kind === 'builtin') return;
    if (!removeArmed) { armRemove(true); return; }
    armRemove(false);
    stopPreview();
    if (row.kind === 'project') {
      library.splice(library.indexOf(row), 1);
      await DB.remove('projects', row.project.id).catch(() => {});
      await DB.remove('assets', row.project.id).catch(() => {});
    } else {
      for (let i = library.length - 1; i >= 0; i--) if (library[i].setName === row.setName) library.splice(i, 1);
      await DB.remove('sets', row.setName).catch(() => {});
    }
    bgCache.delete(row.id);
    const rows = visibleRows();
    state.rowId = (rows[0] || library[0]).id;
    state.versionAt = 0;
    renderLibrary();
    selectCurrent();
  }

  // ---------- Editor wiring ----------

  const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `m${Date.now()}${Math.floor(Math.random() * 1e6)}`);

  // Opening a song you did not make edits a private copy; the original is never touched.
  async function editCurrent() {
    const row = currentRow();
    if (!row) return;
    const v = currentVersion();
    const m = v.get();
    if (row.kind === 'project') { openProject(row.project); return; }

    const existing = library.find(r => r.kind === 'project' && r.project.sourceKey === v.key);
    if (existing) { openProject(existing.project); return; }

    ensureAudio();
    stopPreview();
    loading(`Copying ${m.title}`);
    try {
      const id = newId();
      const copy = P.parseBeatmapText(P.serializeMap({ ...m, keys: m.keys || 4 }), { allowEmpty: true });
      copy.raw.metadata.BeatmapID = 0;
      copy.raw.metadata.BeatmapSetID = -1;
      const rec = { id, osu: P.serializeMap(copy), sourceKey: v.key, updated: Date.now(), builtin: m.builtin || null, hasAudio: !!m.loadAudioBytes, audioName: m.audioFile, bgName: m.bgFile || null };
      if (m.loadAudioBytes) {
        const audio = await m.loadAudioBytes();
        let bg = null;
        if (m.loadBgBytes) { try { bg = await m.loadBgBytes(); } catch (e) { /* optional */ } }
        await DB.put('assets', { id, audio: audio.slice().buffer, bg: bg ? bg.slice().buffer : null });
      }
      await DB.put('projects', rec);
      upsertProject(rec);
      await openProject(rec);
    } catch (e) {
      failLoad(e.message || 'This map could not be opened.');
    }
  }

  let editing = null;

  async function openProject(rec, { detect } = {}) {
    ensureAudio();
    stopPreview();
    setNotice('');
    const map = projectMap(rec);
    loading(`Opening ${map.title}`);
    let assets;
    try {
      assets = await loadAssets(map);
    } catch (e) {
      failLoad(e.message || 'This map could not be opened.');
      return;
    }
    state.rowId = `project:${rec.id}`;
    state.versionAt = 0;
    editing = { rec, assets };
    show('editor');
    const ed = P.openEditor({
      osu: rec.osu,
      audioCtx,
      audioBuffer: assets.audioBuffer,
      bgImage: assets.bgImage,
      musicOut: musicGain,
      sfxOut: sfxGain,
      save: async text => {
        rec.osu = text;
        rec.updated = Date.now();
        await DB.put('projects', rec);
      },
      saveBackground: async (name, bytes) => {
        const a = (await DB.get('assets', rec.id)) || { id: rec.id, audio: null, bg: null };
        a.bg = bytes.slice().buffer;
        await DB.put('assets', a);
        rec.bgName = name;
        assets.bgImage = await createImageBitmap(new Blob([bytes])).catch(() => assets.bgImage);
      },
      test: (m, from, auto) => startTest(m, from, auto, assets),
      exportMap: text => exportProject(rec, text, assets),
      exit: exitEditor,
    });
    if (detect) ed.detect();
  }

  async function exitEditor() {
    const rec = editing && editing.rec;
    await P.closeEditor();
    editing = null;
    canvas.classList.remove('live');
    if (rec) {
      const fresh = (await DB.get('projects', rec.id).catch(() => null)) || rec;
      upsertProject(fresh);
      bgCache.delete(`project:${rec.id}`);
    }
    renderLibrary();
    show('menu');
    selectCurrent();
  }

  function startTest(map, from, auto, assets) {
    const objects = map.objects.filter(o => o.t >= from - 1);
    testRun = { map, from, auto, assets };
    currentMap = map;
    const run = { ...map, objects };
    startGame(run, assets, { from, mods: { auto, nofail: true } });
  }

  function endTest(result) {
    const r = testRun;
    testRun = null;
    if (game) game.destroy();
    game = null;
    P.current = null;
    currentMap = null;
    canvas.classList.remove('live');
    if (!r || !P.editor) { show('menu'); return; }
    show('editor');
    P.editor.resumeFromTest(result && !result.auto ? `Test: ${(result.accuracy * 100).toFixed(1)}%, ${result.counts.miss} missed` : '');
  }

  const safeName = s => String(s).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim() || 'map';

  async function exportProject(rec, text, assets) {
    const m = P.parseBeatmapText(text, { allowEmpty: true });
    if (!m.objects.length) { P.editor.toast('Place some notes before exporting.'); return; }
    P.editor.toast('Packing your map…');
    await new Promise(r => setTimeout(r, 30));
    try {
      const files = [{ name: `${safeName(m.artist)} - ${safeName(m.title)} (${safeName(m.creator || 'Pulsar')}) [${safeName(m.version)}].osu`, data: text }];
      const stored = await DB.get('assets', rec.id);
      if (stored && stored.audio) files.push({ name: m.audioFile, data: stored.audio });
      else if (rec.builtin) {
        const buf = assets.audioBuffer;
        files.push({ name: m.audioFile, data: P.encodeWav([buf.getChannelData(0), buf.getChannelData(buf.numberOfChannels > 1 ? 1 : 0)], buf.sampleRate) });
      }
      if (stored && stored.bg && m.bgFile) files.push({ name: m.bgFile, data: stored.bg });
      const blob = new Blob([P.writeZip(files)], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName(m.artist)} - ${safeName(m.title)}.osz`;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      P.editor.toast('Exported. Check your downloads.');
    } catch (e) {
      P.editor.toast(`Export failed: ${e.message || e}`);
    }
  }

  // ---------- New map ----------

  const draft = { source: null, file: null, mode: 0, keys: 4 };

  function closeNewMap() { $('newmap').classList.add('hidden'); }

  function renderSources() {
    const box = $('nm-sources');
    box.textContent = '';
    for (const track of P.TRACKS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'chip';
      b.textContent = track.title;
      b.setAttribute('aria-pressed', String(draft.source === track.id));
      b.addEventListener('click', () => {
        draft.source = track.id;
        draft.file = null;
        $('nm-title').value = track.title;
        $('nm-artist').value = 'Pulsar Synth';
        $('nm-file-name').textContent = 'Choose an audio file';
        renderSources();
        syncNewMap();
      });
      box.append(b);
    }
  }

  function syncNewMap() {
    document.querySelectorAll('#nm-modes button').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.mode) === draft.mode)));
    $('nm-keys-row').classList.toggle('hidden', draft.mode !== 3);
    $('nm-keys').textContent = String(draft.keys);
    $('nm-create').disabled = !(draft.source || draft.file) || !$('nm-title').value.trim();
    $('nm-need').classList.toggle('hidden', !!(draft.source || draft.file));
  }

  function bindNewMap() {
    $('btn-new').addEventListener('click', () => {
      draft.source = null;
      draft.file = null;
      draft.mode = 0;
      $('nm-title').value = '';
      $('nm-artist').value = '';
      $('nm-creator').value = store.get('creator', '');
      $('nm-file-name').textContent = 'Choose an audio file';
      $('nm-error').classList.add('hidden');
      renderSources();
      syncNewMap();
      $('newmap').classList.remove('hidden');
      $('nm-pick').focus();
    });
    $('nm-cancel').addEventListener('click', closeNewMap);
    $('nm-pick').addEventListener('click', () => $('nm-file').click());
    $('nm-file').addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (!f) return;
      draft.file = f;
      draft.source = null;
      $('nm-file-name').textContent = f.name;
      // "Artist - Title.mp3" is common enough to be worth filling in.
      const base = f.name.replace(/\.[^.]+$/, '');
      const parts = base.split(' - ');
      if (parts.length >= 2) { $('nm-artist').value = parts[0].trim(); $('nm-title').value = parts.slice(1).join(' - ').trim(); }
      else $('nm-title').value = base.trim();
      renderSources();
      syncNewMap();
    });
    $('nm-title').addEventListener('input', syncNewMap);
    document.querySelectorAll('#nm-modes button').forEach(b => b.addEventListener('click', () => { draft.mode = Number(b.dataset.mode); syncNewMap(); }));
    $('nm-keys-down').addEventListener('click', () => { draft.keys = Math.max(1, draft.keys - 1); syncNewMap(); });
    $('nm-keys-up').addEventListener('click', () => { draft.keys = Math.min(18, draft.keys + 1); syncNewMap(); });
    $('newmap-form').addEventListener('submit', async e => {
      e.preventDefault();
      if ($('nm-create').disabled) return;
      $('nm-create').disabled = true;
      try { await createFromDraft(); }
      catch (err) {
        $('nm-error').textContent = err.message || 'That file could not be used.';
        $('nm-error').classList.remove('hidden');
        syncNewMap();
      }
    });
  }

  async function createFromDraft() {
    ensureAudio();
    const title = $('nm-title').value.trim();
    const artist = $('nm-artist').value.trim() || 'Unknown';
    const creator = $('nm-creator').value.trim();
    store.set('creator', creator);
    const id = newId();
    let beat = 500, audioName, offset = 0, assets = null;
    if (draft.file) {
      const bytes = await draft.file.arrayBuffer();
      // Decoding first means a file the browser cannot play fails here, not in the editor.
      await audioCtx.decodeAudioData(bytes.slice(0)).catch(() => { throw new Error(`Your browser can't read "${draft.file.name}". MP3, OGG and WAV are the safest.`); });
      audioName = draft.file.name;
      assets = { id, audio: bytes, bg: null };
    } else {
      const track = P.TRACKS.find(t => t.id === draft.source);
      beat = 60000 / track.bpm;
      audioName = `${track.id}.wav`;
    }
    const mode = draft.mode;
    const map = {
      mode, title, artist, creator, version: 'Normal', audioFile: audioName, keys: draft.keys,
      od: 5, ar: 6, cs: mode === 3 ? draft.keys : 4, hp: 5, multiplier: 1.4, tickRate: 1, previewTime: -1,
      timing: [{ t: offset, beat, uninherited: true, meter: 4, sampleSet: 2, sampleIndex: 0, volume: 70, effects: 0 }],
      objects: [],
    };
    const rec = { id, osu: P.serializeMap(map), updated: Date.now(), builtin: draft.source, hasAudio: !!draft.file, audioName, bgName: null };
    if (assets) await DB.put('assets', assets);
    await DB.put('projects', rec);
    upsertProject(rec);
    closeNewMap();
    await openProject(rec, { detect: !!draft.file });
  }

  // ---------- Boot ----------

  async function boot() {
    art = new P.Art($('art'));
    bindSettings();
    bindInput();
    drawer(false);
    addBuiltins();
    state.rowId = library[0].id;
    renderFilters();
    renderLibrary();
    show('menu');
    selectCurrent();
    try {
      for (const rec of await DB.all('sets')) await addImported(rec.name, rec.data).catch(() => {});
      for (const rec of await DB.all('projects')) { try { upsertProject(rec); } catch (e) { /* a damaged save stays out of the list */ } }
      renderLibrary();
      selectCurrent();
    } catch (e) { /* storage unavailable: imports just last for this visit */ }
  }

  boot();
})(globalThis.Pulsar = globalThis.Pulsar || {});
