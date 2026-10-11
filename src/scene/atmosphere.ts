/**
 * The Preetham sky model's sunlight, on the CPU.
 *
 * three's Sky shader (which scene/sky.ts forks) computes how much sunlight survives the trip
 * through the atmosphere to colour the sky. Lighting the water and the sand with the same numbers
 * keeps everything consistent: a red sunset sky gets red sunlight, in the same units.
 */

const TOTAL_RAYLEIGH = [5.804542996261093e-6, 1.3562911419845635e-5, 3.0265902468824876e-5];
const MIE_CONST = [1.8399918514433978e14, 2.7798023919660528e14, 4.0790479543861094e14];
const CUTOFF = 1.6110731556870734;
/** The sky shader's exposure-ish scale (`* 0.04` in its composition). */
export const SKY_SCALE = 0.04;

export interface AtmosphereParams {
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
}

/** Top-of-atmosphere sun intensity with the model's "earth shadow" fade below the horizon. */
export function sunIntensity(cosZenith: number): number {
  const z = Math.acos(Math.min(1, Math.max(-1, cosZenith)));
  return 1000 * Math.max(0, 1 - Math.exp(-(CUTOFF - z) / 1.5));
}

/** Fraction of light (r, g, b) that crosses the atmosphere along a direction with this elevation sine. */
export function extinction(y: number, p: AtmosphereParams): [number, number, number] {
  const zenith = Math.acos(Math.max(0, y));
  const zDeg = (zenith * 180) / Math.PI;
  const inv = 1 / (Math.cos(zenith) + 0.15 * Math.pow(93.885 - zDeg, -1.253));
  const sR = 8400 * inv;
  const sM = 1250 * inv;
  const mie = 0.434 * (0.2 * p.turbidity * 1e-17);
  return [0, 1, 2].map((i) => Math.exp(-(TOTAL_RAYLEIGH[i] * p.rayleigh * sR + mie * MIE_CONST[i] * p.mieCoefficient * sM))) as [
    number,
    number,
    number,
  ];
}

/**
 * Direct sun irradiance on a surface facing the sun, in sky-shader units (a white diffuse
 * surface lit by it has radiance E/π, like three's lights).
 */
export function sunIrradiance(sunY: number, p: AtmosphereParams): [number, number, number] {
  const e = sunIntensity(sunY) * SKY_SCALE;
  const f = extinction(sunY, p);
  // Below the horizon Fex keeps its horizon value; fade the disc out as it sets.
  const set = Math.min(1, Math.max(0, (sunY + 0.01) / 0.03));
  return [e * f[0] * set, e * f[1] * set, e * f[2] * set];
}
