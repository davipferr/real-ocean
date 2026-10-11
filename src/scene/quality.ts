/**
 * Dynamic resolution. Bloom, trails and the lens pass are fill-rate bound (on an Intel Iris Xe,
 * GPU time roughly doubles from pixel ratio 1.25 to 1.5), so the right pixel ratio depends on the
 * GPU and the window size. This measures real frame times and adjusts:
 *
 * - average frame slower than 1/50 s → drop the ratio by 15%, and remember the ratio that failed
 *   as a ceiling, so it never climbs back into the same stutter (no oscillation);
 * - three windows in a row at ~60 fps or better → raise it 10%, up to min(ceiling, max);
 * - if two drops in a row (about half the pixels) didn't make frames at least 15% faster, pixels
 *   aren't the bottleneck (the CPU is, or the browser caps the frame rate, as embedded webviews
 *   and power-saving modes do), so both are undone and that ratio becomes a floor: cutting
 *   resolution would only blur the picture. One step isn't enough to tell, because vsync snaps
 *   frame times to 16.7 or 33.3 ms: a 15% drop that doesn't quite fit 16.7 looks like no change.
 *
 * Windows containing a long frame (tab hidden, a GC pause, a shader compile) are thrown away.
 */
export class AdaptiveResolution {
  ratio: number;
  private ceiling: number;
  private sum = 0;
  private frames = 0;
  private elapsed = 0;
  private spoiled = false;
  private goodWindows = 0;
  private floor: number;
  /** Drops since the last good window: the ratio before them, the frame time then, how many. */
  private trial: { from: number; avg: number; steps: number } | null = null;

  constructor(
    readonly max: number,
    readonly min = 0.6,
    start = Math.min(max, 1.25),
    readonly window = 1.5,
  ) {
    this.ratio = start;
    this.ceiling = max;
    this.floor = min;
  }

  /** Feed every frame's dt (seconds). Returns the new ratio when it changes, else null. */
  update(dt: number): number | null {
    if (dt > 0.25) this.spoiled = true;
    this.sum += dt;
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed < this.window) return null;

    const avg = this.sum / this.frames;
    const spoiled = this.spoiled;
    this.sum = this.frames = this.elapsed = 0;
    this.spoiled = false;
    if (spoiled) return null;

    const trial = this.trial;
    if (trial && avg <= trial.avg * 0.85) this.trial = null; // the drops helped: keep them
    if (trial && this.trial && trial.steps >= 2) {
      this.trial = null;
      this.floor = trial.from;
      this.ceiling = Math.max(this.ceiling, trial.from);
      return this.set(trial.from);
    }

    if (avg > 1 / 50 && this.ratio > this.floor) {
      this.ceiling = Math.min(this.ceiling, this.ratio * 0.95);
      this.goodWindows = 0;
      this.trial = this.trial
        ? { ...this.trial, steps: this.trial.steps + 1 }
        : { from: this.ratio, avg, steps: 1 };
      return this.set(Math.max(this.floor, this.ratio * 0.85));
    }
    if (avg < 1 / 57) {
      if (++this.goodWindows >= 3 && this.ratio < Math.min(this.ceiling, this.max)) {
        this.goodWindows = 0;
        return this.set(Math.min(this.ceiling, this.max, this.ratio * 1.1));
      }
    } else {
      this.goodWindows = 0;
    }
    return null;
  }

  private set(r: number): number | null {
    r = Math.round(r * 100) / 100;
    if (r === this.ratio) return null;
    this.ratio = r;
    return r;
  }
}
