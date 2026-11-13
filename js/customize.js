(function (P) {
  'use strict';

  function moddedMap(map, mods) {
    if (!mods.easy && !mods.hardRock) return map;
    const factor = mods.easy ? 0.5 : 1.4;
    const scale = (value, n = factor) => Math.min(10, value * n);
    const out = { ...map, ar: scale(map.ar), od: scale(map.od), hp: scale(map.hp) };
    if (map.mode !== 3) out.cs = scale(map.cs, mods.hardRock ? 1.3 : 0.5);
    if (mods.hardRock && !map.mode) {
      const flip = ([x, y]) => [x, 384 - y];
      out.objects = map.objects.map(o => ({ ...o, y: 384 - o.y,
        ...(o.path ? { path: { pts: o.path.pts.map(flip), cum: o.path.cum, length: o.path.length } } : {}),
      }));
    }
    return out;
  }

  function presetSkin(name) {
    const palettes = {
      original: ['#ed677b', '#65cbfa', '#95d56f', '#ffd26a'],
      classic: ['#ec78ab', '#71b9e8', '#9dd75f', '#f5bf5d'],
      neon: ['#fa69d8', '#60e7ff', '#a98bff', '#afff73'],
    };
    const colors = palettes[name] || palettes.original;
    const circles = colors.map(color => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 192;
      const c = canvas.getContext('2d');
      const fill = c.createRadialGradient(73, 58, 4, 96, 96, 96);
      fill.addColorStop(0, name === 'classic' ? '#fff9' : color);
      fill.addColorStop(0.48, color);
      fill.addColorStop(1, name === 'neon' ? '#20153c' : '#29243a');
      c.beginPath(); c.arc(96, 96, 90, 0, Math.PI * 2);
      c.fillStyle = fill; c.fill();
      c.lineWidth = 7; c.strokeStyle = name === 'neon' ? color : '#f8f6ff'; c.stroke();
      c.beginPath(); c.arc(96, 96, 83, 0, Math.PI * 2);
      c.lineWidth = 2; c.strokeStyle = '#ffffff52'; c.stroke();
      return canvas;
    });
    return { circles, colors, accent: name === 'neon' ? '#fb77ff' : '#fff0a8' };
  }

  async function importSkin(file) {
    const zip = await P.readZip(await file.arrayBuffer());
    const entries = new Map();
    for (const [key, entry] of zip) {
      const name = key.split(/[\\/]/).at(-1);
      if (!entries.has(name)) entries.set(name, entry);
    }
    const densities = new WeakMap();
    const load = async name => {
      for (const suffix of ['@2x.png', '.png']) {
        const entry = entries.get(name + suffix);
        if (!entry) continue;
        try {
          const bitmap = await createImageBitmap(new Blob([await entry.get()], { type: 'image/png' }));
          densities.set(bitmap, suffix === '@2x.png' ? 2 : 1);
          return bitmap;
        }
        catch { /* Try the standard-resolution image or the built-in fallback. */ }
      }
      return null;
    };
    const names = {
      hitcircle: 'hitcircle', overlay: 'hitcircleoverlay', cursor: 'cursor', approach: 'approachcircle',
      cursorTrail: 'cursortrail', cursorMiddle: 'cursormiddle',
      sliderStart: 'sliderstartcircle', sliderStartOverlay: 'sliderstartcircleoverlay',
      sliderEnd: 'sliderendcircle', sliderEndOverlay: 'sliderendcircleoverlay', reverseArrow: 'reversearrow',
    };
    const skin = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key, name]) => [key, await load(name)])));
    async function loadFrames(base, prefix) {
      const frames = [];
      for (let i = 0; i < 120; i++) {
        const frame = await load(prefix + i);
        if (!frame) break;
        frames.push(frame);
      }
      if (!frames.length) {
        const sprite = await load(base);
        if (sprite) frames.push(sprite);
      }
      return frames;
    }
    [skin.sliderBallFrames, skin.followCircleFrames] = await Promise.all([
      loadFrames('sliderb', 'sliderb'), loadFrames('sliderfollowcircle', 'sliderfollowcircle-'),
    ]);
    const ini = entries.get('skin.ini');
    let prefix = 'default';
    skin.overlayAboveNumber = true;
    if (ini) {
      const contents = new TextDecoder().decode(await ini.get());
      const fields = new Map();
      for (const line of contents.split(/\r?\n/)) {
        const match = line.match(/^\s*([\w]+)\s*:\s*(.*?)\s*(?:\/\/.*)?$/);
        if (match) fields.set(match[1].toLowerCase(), match[2]);
      }
      const rgb = value => {
        const parts = value?.split(',').map(part => part.trim());
        if (parts?.length === 3 && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255)) {
          return '#' + parts.map(part => Number(part).toString(16).padStart(2, '0')).join('');
        }
      };
      for (const [key, field] of [['SliderBorder', 'sliderBorder'], ['SliderTrackOverride', 'sliderTrack']]) {
        skin[field] = rgb(fields.get(key.toLowerCase()));
      }
      const colors = Array.from({ length: 8 }, (_, i) => rgb(fields.get('combo' + (i + 1)))).filter(Boolean);
      if (colors.length) skin.colors = colors;
      skin.animationFps = Math.max(0, Number(fields.get('animationframerate')) || 0);
      prefix = (fields.get('hitcircleprefix') || prefix).toLowerCase().split(/[\\/]/).at(-1);
      skin.digitOverlap = Number(fields.get('hitcircleoverlap')) || 0;
      skin.overlayAboveNumber = (fields.get('hitcircleoverlayabovenumber') ?? fields.get('hitcircleoverlayabovenumer')) !== '0';
      skin.cursorCentre = fields.get('cursorcentre') !== '0';
      skin.cursorRotate = fields.get('cursorrotate') !== '0';
      skin.cursorExpand = fields.get('cursorexpand') !== '0';
      skin.cursorTrailRotate = fields.get('cursortrailrotate') === '1';
    }
    skin.digits = await Promise.all(Array.from({ length: 10 }, (_, i) => load(prefix + '-' + i)));
    if (!Object.keys(names).some(key => skin[key]) && !skin.digits.some(Boolean) && !skin.colors
      && !skin.sliderBallFrames.length && !skin.followCircleFrames.length && !skin.sliderTrack && !skin.sliderBorder) {
      throw new Error('This skin has no supported Standard textures or slider colours.');
    }
    skin.densities = densities;
    skin.tintCache = new WeakMap();
    return skin;
  }

  Object.assign(P, { moddedMap, presetSkin, importSkin });
})(globalThis.Pulsar = globalThis.Pulsar || {});
