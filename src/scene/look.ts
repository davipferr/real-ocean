/**
 * From an hour of conditions + the sun and moon to everything the renderer needs: light colours,
 * sky haze, fog, foam, exposure. Pure functions, so they are testable and run every frame.
 */

import { moonPosition, sunPosition, toVector, type Moon } from '../astro/sky';
import { describeWeather, type Hour } from '../data/openmeteo';
import { sunIrradiance } from './atmosphere';

/** Koschmieder: visibility V is where contrast falls to 2%, so the extinction is −ln(0.02)/V. */
export function fogDensity(visibility: number): number {
  return 3.912 / Math.min(60_000, Math.max(150, visibility));
}

/** Preetham turbidity (2 = very clear, ~10 = hazy) from the reported visibility. */
export function turbidity(visibility: number): number {
  return Math.min(10, Math.max(2, 1.6 + 25_000 / Math.max(500, visibility)));
}

/**
 * Whitecap coverage as a fraction of the sea surface (Monahan & O'Muircheartaigh 1980):
 * W = 3.84·10⁻⁶·U¹⁰^3.41. About 0.3% at 7 m/s, 4% at 15 m/s.
 */
export function whitecapCoverage(windSpeed: number): number {
  return Math.min(0.2, 3.84e-6 * Math.max(0, windSpeed) ** 3.41);
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export interface Look {
  sunDir: [number, number, number];
  moonDir: [number, number, number];
  sunElevation: number;
  moon: Moon;
  /** Direct irradiance after clouds (sky units, r/g/b). */
  sunColor: [number, number, number];
  moonColor: [number, number, number];
  /** Sky disc brightness of the moon. */
  moonBrightness: number;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  cloudCoverage: number;
  cloudRain: number;
  nightSky: [number, number, number];
  stars: number;
  /** 0 day … 1 full night. */
  night: number;
  fogDensity: number;
  whitecaps: number;
  thunder: boolean;
}

export function lookAt(hour: Hour, lat: number, lon: number): Look {
  const sun = sunPosition(hour.t, lat, lon);
  const moon = moonPosition(hour.t, lat, lon);
  const sunDir = toVector(sun);
  const moonDir = toVector(moon);
  const weather = describeWeather(hour.code);
  const rain = Math.min(1, hour.precip / 4);
  const cloud = Math.max(hour.cloud, rain * 0.9, hour.code === 45 || hour.code === 48 ? 0.8 : 0);

  const turb = turbidity(hour.visibility);
  const atmosphere = { turbidity: turb, rayleigh: 1.4 - 0.5 * cloud, mieCoefficient: 0.004 + 0.006 * cloud };
  // Clouds block direct light: little below half cover (the sun is usually in a gap), most of it
  // under a full deck.
  const blocked = 0.9 * smoothstep(0.45, 1, cloud) + 0.08 * rain;
  const e = sunIrradiance(sunDir[1], atmosphere);
  const sunColor = e.map((v) => v * (1 - blocked)) as [number, number, number];

  const night = smoothstep(0.03, -0.17, sunDir[1]);
  const moonUp = smoothstep(-0.02, 0.06, moonDir[1]);
  // Moonlight is ~400 000× fainter than sunlight; like a film shot "day for night", it is scaled
  // up to stay visible, keeping its cool tint and its dependence on the phase.
  const moonLight = 0.55 * moon.illumination ** 1.5 * moonUp * (1 - 0.85 * smoothstep(0.5, 1, cloud));
  const moonColor: [number, number, number] = [0.62 * moonLight, 0.72 * moonLight, 0.95 * moonLight];
  // Night-sky glow. Even a moonless night isn't black: airglow and starlight light a clear sky, and
  // near a coast, towns light the underside of clouds (the sky shader warms that part). Scaled
  // like the moonlight, it is the floor that keeps a new-moon night readable; the moon adds to it.
  const glow = 0.014 + 0.006 * cloud + 0.008 * moon.illumination * moonUp;
  return {
    sunDir,
    moonDir,
    sunElevation: sun.elevation,
    moon,
    sunColor,
    moonColor,
    moonBrightness: (0.02 + 0.18 * night) * moonUp,
    ...atmosphere,
    cloudCoverage: cloud,
    cloudRain: rain,
    nightSky: [glow * 0.45 * night, glow * 0.7 * night, glow * 1.4 * night],
    stars: night * (1 - smoothstep(0.3, 0.9, cloud)) * (1 - 0.6 * moon.illumination * moonUp) * (1 - smoothstep(0.5, 0.9, rain)),
    night,
    fogDensity: fogDensity(hour.visibility),
    whitecaps: Math.min(1, Math.sqrt(whitecapCoverage(hour.windSpeed) / 0.03)),
    thunder: weather.thunder,
  };
}

/** Next sunrise and sunset after `t` (UTC ms), stepping 10 min and refining by bisection. */
export function sunEvents(t: number, lat: number, lon: number): { rise: number | null; set: number | null } {
  const el = (ms: number) => sunPosition(ms, lat, lon).elevation + 0.833; // refraction + disc radius
  const find = (rising: boolean) => {
    let a = t;
    let ea = el(a);
    for (let i = 0; i < 6 * 30; i++) {
      const b = a + 600_000;
      const eb = el(b);
      if (rising ? ea < 0 && eb >= 0 : ea >= 0 && eb < 0) {
        let lo = a;
        let hi = b;
        for (let k = 0; k < 20; k++) {
          const m = (lo + hi) / 2;
          if (el(m) < 0 === rising) lo = m;
          else hi = m;
        }
        return (lo + hi) / 2;
      }
      a = b;
      ea = eb;
    }
    return null;
  };
  return { rise: find(true), set: find(false) };
}

export function moonPhaseName(m: Moon): string {
  const i = m.illumination;
  if (i < 0.03) return 'New moon';
  if (i > 0.97) return 'Full moon';
  if (Math.abs(i - 0.5) < 0.06) return m.waxing ? 'First quarter' : 'Last quarter';
  if (i < 0.5) return m.waxing ? 'Waxing crescent' : 'Waning crescent';
  return m.waxing ? 'Waxing gibbous' : 'Waning gibbous';
}
