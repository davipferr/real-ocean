/**
 * The beach: a seabed shape and what it does to the waves.
 *
 * The scene origin is the mean-sea-level waterline. `facing` is the compass bearing you look
 * along when you stand on the sand looking out to sea; d is the distance seaward from the
 * waterline (negative on land) and u the distance along the shore.
 *
 * Underwater the bed follows Dean's equilibrium profile h = A·d^(2/3), the shape sandy beaches
 * settle into under wave action (A ≈ 0.1 m^⅓ for medium sand), plus a sandbar where the bigger
 * waves break first. Above water there is a beach face, a flat berm and dunes.
 *
 * `BED_GLSL` must stay in step with `bedHeight`; the tests pin a few values of the TS version.
 */

import { bearingToVec } from './spectrum';

export interface Shore {
  /** Seaward bearing (degrees). */
  facing: number;
  /** Dean profile parameter (m^⅓). Finer sand → smaller A → gentler, wider surf zone. */
  deanA: number;
}

export const BEACH_SLOPE = 0.075;
export const BERM = 2.4;
export const MAX_DEPTH = 40;

/** Unit vectors: seaward and along-shore (seaward rotated 90° counter-clockwise from above). */
export function shoreAxes(facing: number) {
  const [sx, sz] = bearingToVec(facing);
  return { sx, sz, ax: -sz, az: sx };
}

/** Scene x/z → (d seaward, u along-shore). */
export function toShore(shore: Shore, x: number, z: number): { d: number; u: number } {
  const { sx, sz, ax, az } = shoreAxes(shore.facing);
  return { d: x * sx + z * sz, u: x * ax + z * az };
}

/** (d, u) → scene x/z. */
export function fromShore(shore: Shore, d: number, u: number): { x: number; z: number } {
  const { sx, sz, ax, az } = shoreAxes(shore.facing);
  return { x: d * sx + u * ax, z: d * sz + u * az };
}

/** Bed height relative to mean sea level (m) at seaward distance d, along-shore u. */
export function bedHeight(deanA: number, d: number, u: number): number {
  if (d >= 0) {
    // Dean profile, shifted 1 m so the slope at the waterline is finite (≈ ⅔A, close to the beach face).
    const dean = -deanA * (Math.pow(d + 1, 2 / 3) - 1);
    // A sandbar ~90 m out, wavering along the shore like real bars (rip channels form in the gaps).
    const along = 1 + 0.35 * Math.sin(u * 0.011) + 0.15 * Math.sin(u * 0.031 + 1.3);
    const bar = 0.7 * Math.exp(-(((d - 90) / 28) ** 2)) * along * (deanA / 0.1);
    return Math.max(dean + bar, -MAX_DEPTH);
  }
  const x = -d;
  const face = x * BEACH_SLOPE;
  const bermStart = BERM / BEACH_SLOPE;
  let y = face < BERM ? face : BERM + (x - bermStart) * 0.012;
  // Dunes behind the berm.
  const t = Math.min(1, Math.max(0, (x - 110) / 90));
  y += t * t * (3 - 2 * t) * (3 + 1.5 * Math.sin(u * 0.02) + 0.8 * Math.sin(u * 0.057 + 2));
  return y;
}

/**
 * Depth-limited waves. A wave breaks when its height reaches ~0.78 of the depth (McCowan), so in
 * the surf zone the height is capped by the depth. This soft clamp is ≈ x for small x and → 1 for
 * large: x = 0.78·depth / Hs. A floor right at the waterline (fading out by 1.5 m depth) keeps a
 * little swash running up the sand.
 */
export function depthFactor(depth: number, hs: number): number {
  const x = Math.max(0, (0.78 * depth) / Math.max(hs, 0.05));
  const soft = x / Math.pow(1 + x ** 4, 0.25);
  const swash = 0.25 * smoothstep(-3, 0, depth) * (1 - smoothstep(0.3, 1.5, depth));
  return Math.max(soft, swash);
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** The same functions in GLSL. Expects `uniform vec2 uSeaward; uniform float uDeanA;`. */
export const BED_GLSL = /* glsl */ `
float bedHeight(vec2 p) {
  float d = dot(p, uSeaward);
  float u = dot(p, vec2(-uSeaward.y, uSeaward.x));
  if (d >= 0.0) {
    float dean = -uDeanA * (pow(d + 1.0, 2.0 / 3.0) - 1.0);
    float along = 1.0 + 0.35 * sin(u * 0.011) + 0.15 * sin(u * 0.031 + 1.3);
    float bar = 0.7 * exp(-pow((d - 90.0) / 28.0, 2.0)) * along * (uDeanA / 0.1);
    return max(dean + bar, -${MAX_DEPTH.toFixed(1)});
  }
  float x = -d;
  float face = x * ${BEACH_SLOPE};
  float bermStart = ${(BERM / BEACH_SLOPE).toFixed(4)};
  float y = face < ${BERM.toFixed(2)} ? face : ${BERM.toFixed(2)} + (x - bermStart) * 0.012;
  float t = clamp((x - 110.0) / 90.0, 0.0, 1.0);
  y += t * t * (3.0 - 2.0 * t) * (3.0 + 1.5 * sin(u * 0.02) + 0.8 * sin(u * 0.057 + 2.0));
  return y;
}

float depthFactor(float depth, float hs) {
  float x = max(0.0, 0.78 * depth / max(hs, 0.05));
  float soft = x / pow(1.0 + x * x * x * x, 0.25);
  return max(soft, 0.25 * smoothstep(-3.0, 0.0, depth) * (1.0 - smoothstep(0.3, 1.5, depth)));
}
`;
