// The menu's living backdrop: a hexagon field lit by a turning beam, pulsing with the song.
(function (P) {
  'use strict';

  const { hexPath } = P;
  const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const SQRT3 = Math.sqrt(3);

  class Art {
    constructor(canvas) {
      this.canvas = canvas;
      this.c = canvas.getContext('2d');
      this.accent = [216, 255, 62];
      this.target = [216, 255, 62];
      this.bpm = 120;
      this.beatZero = 0;
      this.image = null;
      this.prevImage = null;
      this.imageAt = 0;
      this.analyser = null;
      this.energy = 0;
      this.running = false;
      this.draw = this.draw.bind(this);
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }

    resize() {
      this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      this.W = window.innerWidth;
      this.H = window.innerHeight;
      this.canvas.width = Math.round(this.W * this.dpr);
      this.canvas.height = Math.round(this.H * this.dpr);
      this.cells = [];
      const r = 38, stepX = r * 1.5, stepY = r * SQRT3;
      for (let col = -1; col * stepX < this.W + r; col++) {
        for (let row = -1; row * stepY < this.H + r; row++) {
          this.cells.push({ x: col * stepX, y: row * stepY + (col % 2 ? stepY / 2 : 0) });
        }
      }
      this.r = r;
      if (!this.running) this.paint(performance.now());
    }

    set({ accent, bpm, beatZero, image }) {
      if (accent) this.target = accent;
      if (bpm) this.bpm = bpm;
      this.beatZero = beatZero || 0;
      if (image !== undefined && image !== this.image) {
        this.prevImage = this.image;
        this.image = image;
        this.imageAt = performance.now();
      }
      if (!this.running) this.paint(performance.now());
    }

    start() {
      if (reduced) { this.paint(performance.now()); return; }
      if (this.running) return;
      this.running = true;
      requestAnimationFrame(this.draw);
    }

    stop() { this.running = false; }

    draw(now) {
      if (!this.running) return;
      requestAnimationFrame(this.draw);
      // Thirty frames a second is plenty for a backdrop and spares the laptop.
      if (now - (this.last || 0) < 32) return;
      this.last = now;
      this.paint(now);
    }

    readEnergy() {
      if (!this.analyser) { this.energy *= 0.9; return; }
      const bins = this.bins || (this.bins = new Uint8Array(this.analyser.frequencyBinCount));
      this.analyser.getByteFrequencyData(bins);
      let sum = 0;
      for (let i = 1; i < 8; i++) sum += bins[i];
      const level = sum / 7 / 255;
      this.energy = Math.max(level, this.energy * 0.86);
    }

    drawCover(c, img, alpha) {
      if (!img || alpha <= 0) return;
      const { W, H } = this;
      const k = Math.max(W / img.width, H / img.height) * 1.03;
      c.globalAlpha = alpha;
      c.drawImage(img, (W - img.width * k) / 2, (H - img.height * k) / 2, img.width * k, img.height * k);
      c.globalAlpha = 1;
    }

    paint(now) {
      const { c, W, H } = this;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.accent = this.accent.map((v, i) => v + (this.target[i] - v) * 0.08);
      const [r, g, b] = this.accent.map(Math.round);
      this.readEnergy();

      c.fillStyle = '#09080d';
      c.fillRect(0, 0, W, H);
      const fade = Math.min(1, (now - this.imageAt) / 450);
      this.drawCover(c, this.prevImage, 0.5 * (1 - fade));
      this.drawCover(c, this.image, 0.5 * fade);

      const beat = 60000 / this.bpm;
      const phase = (((now - this.beatZero) / beat) % 1 + 1) % 1;
      const pulse = Math.pow(1 - phase, 2.5);
      const cx = W * 0.68, cy = H * 0.42;
      const beam = now / 9000;
      const reach = Math.hypot(W, H);
      const ring = phase * reach * 0.45;
      const lift = 1 + this.energy * 1.4;

      // Quantised alpha lets thousands of hexagons share a few draw calls.
      const buckets = [[], [], [], [], [], []];
      for (const cell of this.cells) {
        const dx = cell.x - cx, dy = cell.y - cy;
        const dist = Math.hypot(dx, dy);
        const ang = Math.atan2(dy, dx);
        const sweep = (Math.cos(ang * 2 - beam * 2) + 1) / 2;
        const lit = Math.pow(sweep, 7) * (1 - Math.min(1, dist / (reach * 0.72))) * 0.85;
        const wave = Math.max(0, 1 - Math.abs(dist - ring) / 120) * (0.25 + pulse * 0.5);
        const v = (lit + wave + 0.035) * lift;
        const at = Math.min(5, Math.floor(v * 6));
        if (at > 0 || v > 0.04) buckets[at].push(cell);
      }
      const inner = this.r * 0.93;
      buckets.forEach((list, i) => {
        if (!list.length) return;
        c.beginPath();
        for (const cell of list) {
          for (let s = 0; s < 6; s++) {
            const a = s * Math.PI / 3;
            const px = cell.x + Math.cos(a) * inner, py = cell.y + Math.sin(a) * inner;
            if (s === 0) c.moveTo(px, py); else c.lineTo(px, py);
          }
          c.closePath();
        }
        c.strokeStyle = `rgba(${r},${g},${b},${0.05 + i * 0.1})`;
        c.lineWidth = 1;
        c.stroke();
        if (i >= 2) {
          c.fillStyle = `rgba(${r},${g},${b},${(i - 1) * 0.022})`;
          c.fill();
        }
      });

      // The core: a small pulsing hexagon at the beam's source.
      const size = 34 + pulse * 10 + this.energy * 26;
      hexPath(c, cx, cy, size * 2.1, beam);
      c.strokeStyle = `rgba(${r},${g},${b},0.3)`;
      c.lineWidth = 1.5;
      c.stroke();
      hexPath(c, cx, cy, size, -beam * 1.6);
      c.fillStyle = `rgba(${r},${g},${b},${0.14 + pulse * 0.16 + this.energy * 0.25})`;
      c.fill();

      // Keeps the text readable whatever the art is doing.
      const side = c.createLinearGradient(0, 0, W, 0);
      side.addColorStop(0, 'rgba(9,8,13,0.96)');
      side.addColorStop(Math.min(0.5, 420 / Math.max(W, 1)), 'rgba(9,8,13,0.72)');
      side.addColorStop(0.75, 'rgba(9,8,13,0.1)');
      side.addColorStop(1, 'rgba(9,8,13,0)');
      c.fillStyle = side;
      c.fillRect(0, 0, W, H);
      const low = c.createLinearGradient(0, H * 0.3, 0, H);
      low.addColorStop(0, 'rgba(9,8,13,0)');
      low.addColorStop(1, 'rgba(9,8,13,0.94)');
      c.fillStyle = low;
      c.fillRect(0, 0, W, H);
    }
  }

  P.Art = Art;
})(globalThis.Pulsar = globalThis.Pulsar || {});
