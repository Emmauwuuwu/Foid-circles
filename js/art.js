// Beatmap artwork and beat-synced hexagons behind the menus.
(function (P) {
  'use strict';

  const FADE_MS = 240;
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

  class Art {
    constructor(canvas) {
      this.canvas = canvas;
      this.c = canvas.getContext('2d');
      this.image = null;
      this.previous = null;
      this.changedAt = 0;
      this.beatMs = 500;
      this.beatOrigin = 0;
      this.running = false;
      this.frame = null;
      this.timer = null;
      this.paint = this.paint.bind(this);
      this.resize();
      window.addEventListener('resize', () => this.resize());
    }

    resize() {
      this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      this.width = window.innerWidth;
      this.height = window.innerHeight;
      this.canvas.width = Math.round(this.width * this.dpr);
      this.canvas.height = Math.round(this.height * this.dpr);
      this.grid = new Path2D();
      const radius = 35;
      const rowHeight = Math.sqrt(3) * radius;
      for (let col = 0; col * radius * 1.5 < this.width + radius; col++) {
        for (let row = 0; row * rowHeight < this.height + radius; row++) {
          const x = col * radius * 1.5;
          const y = (row + (col % 2) * 0.5) * rowHeight;
          for (let side = 0; side < 6; side++) {
            const angle = side * Math.PI / 3;
            const px = x + Math.cos(angle) * radius * 0.93;
            const py = y + Math.sin(angle) * radius * 0.93;
            if (side === 0) this.grid.moveTo(px, py); else this.grid.lineTo(px, py);
          }
          this.grid.closePath();
        }
      }
      this.paint(performance.now());
    }

    set({ image = this.image, beatMs, beatOrigin }) {
      if (beatMs > 0 && Number.isFinite(beatMs)) this.beatMs = beatMs;
      if (Number.isFinite(beatOrigin)) this.beatOrigin = beatOrigin;
      if (image === this.image) return;
      this.previous = this.image;
      this.image = image;
      this.changedAt = performance.now();
      if (this.running) this.paint(this.changedAt);
    }

    start() {
      if (this.running) return;
      this.running = true;
      this.paint(performance.now());
    }

    stop() {
      this.running = false;
      cancelAnimationFrame(this.frame);
      clearTimeout(this.timer);
      this.frame = null;
      this.timer = null;
      this.previous = null;
    }

    drawCover(image, opacity) {
      if (!image || opacity <= 0) return;
      const { c, width, height } = this;
      const scale = Math.max(width / image.width, height / image.height);
      const w = image.width * scale, h = image.height * scale;
      c.globalAlpha = opacity;
      c.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
      c.globalAlpha = 1;
    }

    paint(now) {
      cancelAnimationFrame(this.frame);
      clearTimeout(this.timer);
      this.frame = null;
      this.timer = null;
      const { c, width, height, dpr } = this;
      const wallpaper = document.documentElement.classList.contains('wallpaper');
      const interval = wallpaper ? 65 : 30;
      if (this.running && !reducedMotion.matches && now - (this.lastPaint ?? -Infinity) < interval) {
        this.schedulePaint(wallpaper, interval - (now - this.lastPaint));
        return;
      }
      this.lastPaint = now;
      const progress = reducedMotion.matches ? 1 : Math.min(1, (now - this.changedAt) / FADE_MS);
      const theme = document.documentElement.dataset.theme;
      const oled = theme === 'oled';
      const dark = oled || theme === 'dark';
      const base = oled ? '#000000' : dark ? '#161317' : '#fffaf8';
      const artOpacity = oled ? 0.42 : 0.72;
      c.setTransform(dpr, 0, 0, dpr, 0, 0);
      c.fillStyle = base;
      c.fillRect(0, 0, width, height);
      this.drawCover(this.previous, artOpacity * (1 - progress));
      this.drawCover(this.image, artOpacity * progress);

      const wash = c.createLinearGradient(0, height, width, 0);
      wash.addColorStop(0.25, base);
      wash.addColorStop(0.62, base + (dark ? 'e0' : 'b8'));
      wash.addColorStop(1, base + (dark ? '65' : '24'));
      c.fillStyle = wash;
      c.fillRect(0, 0, width, height);

      const phase = ((now - this.beatOrigin) % this.beatMs + this.beatMs) % this.beatMs / this.beatMs;
      const pulse = reducedMotion.matches ? 0 : Math.pow(1 - phase, 3);
      c.lineWidth = 1;
      const pulseColor = dark ? '255, 119, 112' : '205, 32, 35';
      c.strokeStyle = `rgba(${pulseColor}, ${0.08 + pulse * 0.15})`;
      c.stroke(this.grid);
      for (let i = 0; i < 3; i++) {
        const radius = (44 + i * 36) * (1 + 0.1 * pulse);
        P.hexPath(c, width * 0.81, height * 0.3, radius, Math.PI / 6);
        c.strokeStyle = `rgba(${pulseColor}, ${0.21 + pulse * 0.34 - i * 0.035})`;
        c.stroke();
      }
      if (progress >= 1) this.previous = null;
      if (this.running && !reducedMotion.matches) this.schedulePaint(wallpaper, interval);
    }

    schedulePaint(wallpaper, delay) {
      if (wallpaper) this.timer = setTimeout(() => this.paint(performance.now()), delay);
      else this.frame = requestAnimationFrame(this.paint);
    }
  }

  P.Art = Art;
})(globalThis.Pulsar = globalThis.Pulsar || {});
