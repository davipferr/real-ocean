/**
 * The live wave field: per-slot parameters packed for the shader, tweened toward the latest sea
 * state, plus a CPU evaluation of exactly what the vertex shader computes (for the buoy and the
 * surfer camera).
 *
 * Gerstner (trochoidal) waves move each surface point in a circle instead of only up and down:
 *
 *   θᵢ = kᵢ·(Dᵢ·x₀) − φᵢ(t)
 *   x  = x₀ + Σ Q·aᵢ·Dᵢ·cos θᵢ
 *   y  =      Σ   aᵢ·sin θᵢ
 *
 * which sharpens crests and flattens troughs the way real waves look. The phase φᵢ is accumulated
 * (φ += ωᵢ·dt with ω = √(g·k)) instead of computed as ω·t, so when a wave's period changes the
 * surface changes smoothly instead of jumping by Δω·t.
 */

import { G, MAX_WAVES, steepness, type Wave } from './spectrum';

const TAU = Math.PI * 2;

export interface Sample {
  x: number;
  y: number;
  z: number;
  nx: number;
  ny: number;
  nz: number;
  /** Jacobian of the horizontal mapping: < 1 where the surface is compressed (crests), < ~0.4 → whitecaps. */
  jac: number;
}

export class WaveField {
  /** Per wave: dirX, dirZ, k, amp. Uploaded to `uWaveA`. */
  readonly a = new Float32Array(MAX_WAVES * 4);
  /** Per wave: Q, phase, 0, 0. Uploaded to `uWaveB`. */
  readonly b = new Float32Array(MAX_WAVES * 4);
  /** Significant height of the current (tweened) waves. */
  hs = 0;
  /** Seconds for a change of sea state to mostly settle. */
  tween = 1.2;
  private target: Wave[] = [];

  setTarget(waves: Wave[], immediate = false): void {
    if (waves.length > MAX_WAVES) throw new Error(`at most ${MAX_WAVES} waves`);
    const first = this.target.length === 0;
    this.target = waves;
    if (first || immediate) {
      waves.forEach((w, i) => {
        this.a.set([w.dirX, w.dirZ, w.k, w.amp], i * 4);
        if (first) this.b[i * 4 + 1] = w.phase0;
      });
      this.refresh();
    }
  }

  /** Advances phases by dt seconds and eases parameters toward the target. */
  update(dt: number): void {
    const t = this.tween > 0 ? 1 - Math.exp(-dt / (this.tween / 3)) : 1;
    const a = this.a;
    this.target.forEach((w, i) => {
      const o = i * 4;
      let dx = a[o] + (w.dirX - a[o]) * t;
      let dz = a[o + 1] + (w.dirZ - a[o + 1]) * t;
      const len = Math.hypot(dx, dz) || 1;
      dx /= len;
      dz /= len;
      a[o] = dx;
      a[o + 1] = dz;
      // Wavenumber eases in log space: halving a wavelength is the same "distance" at any size.
      a[o + 2] = Math.exp(Math.log(a[o + 2]) + (Math.log(w.k) - Math.log(a[o + 2])) * t);
      a[o + 3] += (w.amp - a[o + 3]) * t;
      const omega = Math.sqrt(G * a[o + 2]);
      this.b[o + 1] = (this.b[o + 1] + omega * dt) % TAU;
    });
    this.refresh();
  }

  get count(): number {
    return this.target.length;
  }

  private refresh(): void {
    const n = this.target.length;
    const waves = Array.from({ length: n }, (_, i) => ({ k: this.a[i * 4 + 2], amp: this.a[i * 4 + 3] }));
    const q = steepness(waves);
    let m0 = 0;
    for (let i = 0; i < n; i++) {
      this.b[i * 4] = q;
      m0 += (this.a[i * 4 + 3] ** 2) / 2;
    }
    this.hs = 4 * Math.sqrt(m0);
  }
}

/**
 * Hides waves too short for the mesh to sample at this distance (they would alias into shimmering
 * noise): full strength at ≥ 8 grid cells per wavelength, gone at ≤ 4. Same as the shader.
 */
export function spacingFade(wavelength: number, spacing: number): number {
  const t = Math.min(1, Math.max(0, (wavelength - 4 * spacing) / (4 * spacing)));
  return t * t * (3 - 2 * t);
}

/**
 * Evaluates the surface at rest position (x0, z0).
 * @param scale amplitude multiplier from the seabed (depthFactor), constant over the waves
 * @param spacing mesh spacing (m) at this point, for `spacingFade`
 */
export function evaluate(field: WaveField, x0: number, z0: number, scale = 1, spacing = 0): Sample {
  const { a, b } = field;
  let x = x0;
  let y = 0;
  let z = z0;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  let jxx = 0;
  let jzz = 0;
  let jxz = 0;
  for (let i = 0; i < field.count; i++) {
    const o = i * 4;
    const dx = a[o];
    const dz = a[o + 1];
    const k = a[o + 2];
    const amp = a[o + 3] * scale * (spacing > 0 ? spacingFade(TAU / k, spacing) : 1);
    const q = b[o];
    const th = k * (dx * x0 + dz * z0) - b[o + 1];
    const s = Math.sin(th);
    const c = Math.cos(th);
    x += q * amp * dx * c;
    z += q * amp * dz * c;
    y += amp * s;
    const wa = k * amp;
    nx += dx * wa * c;
    nz += dz * wa * c;
    ny += q * wa * s;
    jxx += q * wa * dx * dx * s;
    jzz += q * wa * dz * dz * s;
    jxz += q * wa * dx * dz * s;
  }
  const n = Math.hypot(nx, 1 - ny, nz);
  return { x, y, z, nx: -nx / n, ny: (1 - ny) / n, nz: -nz / n, jac: (1 - jxx) * (1 - jzz) - jxz * jxz };
}

/**
 * The surface above a fixed point (x, z). Gerstner waves move points sideways, so the rest
 * position that ends up over (x, z) is found by fixed-point iteration (converges because the
 * horizontal mapping is a contraction while Σ Q·k·a < 1).
 */
export function surfaceAt(
  field: WaveField,
  x: number,
  z: number,
  scaleAt: (x0: number, z0: number) => number = () => 1,
  iterations = 5,
): Sample {
  let x0 = x;
  let z0 = z;
  let s = evaluate(field, x0, z0, scaleAt(x0, z0));
  for (let i = 0; i < iterations; i++) {
    x0 -= s.x - x;
    z0 -= s.z - z;
    s = evaluate(field, x0, z0, scaleAt(x0, z0));
  }
  return s;
}
