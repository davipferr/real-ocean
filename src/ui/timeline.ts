/**
 * The forecast strip: wave height (area), swell (line), tide (dashed, own scale), night bands,
 * day ticks in the beach's local time, "now", and a draggable playhead.
 */

import { sunPosition } from '../astro/sky';
import type { Forecast } from '../data/openmeteo';

const HOUR = 3_600_000;

export interface TimelineOptions {
  onScrub: (t: number) => void;
  onLive: () => void;
}

export class Timeline {
  private forecast: Forecast | null = null;
  private playhead = Date.now();
  private now = Date.now();
  private dragging = false;
  private nightBands: [number, number][] = [];
  private readonly ctx: CanvasRenderingContext2D;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly opts: TimelineOptions,
  ) {
    this.ctx = canvas.getContext('2d')!;
    new ResizeObserver(() => this.draw()).observe(canvas);
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      canvas.setPointerCapture(e.pointerId);
      this.scrubTo(e.offsetX);
    });
    canvas.addEventListener('pointermove', (e) => this.dragging && this.scrubTo(e.offsetX));
    canvas.addEventListener('pointerup', () => (this.dragging = false));
    canvas.addEventListener('dblclick', () => this.opts.onLive());
  }

  setForecast(f: Forecast, lat: number, lon: number): void {
    this.forecast = f;
    // Night bands, from the sun's elevation every 15 minutes.
    this.nightBands = [];
    const [t0, t1] = this.range();
    let start: number | null = null;
    for (let t = t0; t <= t1; t += HOUR / 4) {
      const dark = sunPosition(t, lat, lon).elevation < -0.833;
      if (dark && start === null) start = t;
      if (!dark && start !== null) {
        this.nightBands.push([start, t]);
        start = null;
      }
    }
    if (start !== null) this.nightBands.push([start, t1]);
    this.draw();
  }

  /** Moves the playhead (and "now") without emitting events. */
  set(playhead: number, now: number): void {
    this.playhead = playhead;
    this.now = now;
    this.draw();
  }

  private range(): [number, number] {
    const h = this.forecast!.hours;
    return [h[0].t, h[h.length - 1].t];
  }

  private scrubTo(px: number): void {
    if (!this.forecast) return;
    const [t0, t1] = this.range();
    const t = t0 + (Math.min(Math.max(px, 0), this.canvas.clientWidth) / this.canvas.clientWidth) * (t1 - t0);
    // Snap to "now" when close, so going back to live by dragging is easy.
    const snap = (t1 - t0) * 0.006;
    this.opts.onScrub(Math.abs(t - this.now) < snap ? this.now : t);
  }

  draw(): void {
    const c = this.canvas;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const f = this.forecast;
    if (!f) return;

    const [t0, t1] = this.range();
    const x = (t: number) => ((t - t0) / (t1 - t0)) * w;
    const top = 4;
    const bottom = h - 14;
    const hours = f.hours;
    const maxH = Math.max(0.5, ...hours.map((x) => x.waveHeight ?? 0)) * 1.15;
    const y = (v: number) => bottom - (v / maxH) * (bottom - top);

    for (const [a, b] of this.nightBands) {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.28)';
      ctx.fillRect(x(a), 0, x(b) - x(a), bottom);
    }

    // Days, at local midnight in the beach's time zone.
    ctx.font = '11px system-ui, sans-serif';
    ctx.textBaseline = 'alphabetic';
    const off = f.utcOffset * 1000;
    const firstMidnight = Math.ceil((t0 + off) / (24 * HOUR)) * 24 * HOUR - off;
    for (let t = firstMidnight; t <= t1; t += 24 * HOUR) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
      ctx.fillRect(x(t), 0, 1, bottom);
      const label = new Date(t + off + 12 * HOUR).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', timeZone: 'UTC' });
      ctx.fillStyle = 'rgba(200, 220, 230, 0.75)';
      ctx.fillText(label, x(t) + 4, h - 2);
    }

    // Total wave height (area) and the primary swell (line).
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, 'rgba(79, 209, 197, 0.65)');
    grad.addColorStop(1, 'rgba(79, 209, 197, 0.08)');
    ctx.beginPath();
    ctx.moveTo(x(hours[0].t), bottom);
    for (const hr of hours) ctx.lineTo(x(hr.t), y(hr.waveHeight ?? 0));
    ctx.lineTo(x(hours[hours.length - 1].t), bottom);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    hours.forEach((hr, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, x(hr.t), y(hr.swell?.height ?? 0)));
    ctx.strokeStyle = 'rgba(90, 169, 255, 0.95)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Tide on its own scale, in the lower part of the strip.
    const tides = hours.map((hr) => hr.tide).filter((v): v is number => v != null);
    if (tides.length) {
      const lo = Math.min(...tides);
      const hi = Math.max(...tides);
      const ty = (v: number) => bottom - 4 - ((v - lo) / Math.max(0.1, hi - lo)) * (bottom - top) * 0.45;
      ctx.beginPath();
      let started = false;
      for (const hr of hours) {
        if (hr.tide == null) continue;
        (started ? ctx.lineTo : ctx.moveTo).call(ctx, x(hr.t), ty(hr.tide));
        started = true;
      }
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(255, 214, 120, 0.8)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Scale and legend.
    ctx.fillStyle = 'rgba(200, 220, 230, 0.6)';
    ctx.textAlign = 'right';
    ctx.fillText(`${maxH.toFixed(1)} m`, w - 2, top + 9);
    ctx.textAlign = 'left';

    // Now.
    if (this.now >= t0 && this.now <= t1) {
      ctx.fillStyle = 'rgba(255, 90, 90, 0.9)';
      ctx.fillRect(x(this.now) - 0.5, 0, 1.5, bottom);
    }
    // Playhead.
    const px = x(Math.min(t1, Math.max(t0, this.playhead)));
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px - 1, 0, 2, bottom);
    ctx.beginPath();
    ctx.moveTo(px - 5, 0);
    ctx.lineTo(px + 5, 0);
    ctx.lineTo(px, 6);
    ctx.fill();
  }
}
