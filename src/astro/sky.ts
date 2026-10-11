/**
 * Where the sun and moon are in the sky at a given instant and place.
 *
 * Low-precision formulas from the Astronomical Almanac / Meeus: about 0.01° for the sun and
 * ~0.3° for the moon (lunar parallax, up to 1°, is ignored). Plenty to light a scene and put the
 * glitter path of the sun or moon on the water in the right place.
 */

const RAD = Math.PI / 180;
const wrap = (deg: number) => ((deg % 360) + 360) % 360;

/** Days since J2000.0 (2000-01-01 12:00 TT, ignoring the ~70 s TT−UT difference). */
export const daysSinceJ2000 = (ms: number) => ms / 86_400_000 - 10_957.5;

export interface Horizontal {
  /** Degrees above the horizon (geometric, no refraction). */
  elevation: number;
  /** Compass degrees, clockwise from north. */
  azimuth: number;
}

/** Greenwich mean sidereal time (degrees). */
export function gmst(ms: number): number {
  return wrap(280.46061837 + 360.98564736629 * daysSinceJ2000(ms));
}

/** Right ascension / declination (degrees) → elevation / azimuth for an observer. */
export function toHorizontal(ra: number, dec: number, ms: number, lat: number, lon: number): Horizontal {
  const h = (gmst(ms) + lon - ra) * RAD;
  const d = dec * RAD;
  const p = lat * RAD;
  const elevation = Math.asin(Math.sin(p) * Math.sin(d) + Math.cos(p) * Math.cos(d) * Math.cos(h)) / RAD;
  const azimuth = Math.atan2(-Math.cos(d) * Math.sin(h), Math.sin(d) * Math.cos(p) - Math.cos(d) * Math.cos(h) * Math.sin(p)) / RAD;
  return { elevation, azimuth: wrap(azimuth) };
}

/** Ecliptic longitude/latitude (degrees) → right ascension / declination (degrees). */
function eclipticToEquatorial(lambda: number, beta: number, n: number): { ra: number; dec: number } {
  const e = (23.439 - 0.0000004 * n) * RAD;
  const l = lambda * RAD;
  const b = beta * RAD;
  const ra = Math.atan2(Math.sin(l) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(l)) / RAD;
  const dec = Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(l)) / RAD;
  return { ra: wrap(ra), dec };
}

/** Apparent ecliptic longitude of the sun (degrees). */
export function sunLongitude(ms: number): number {
  const n = daysSinceJ2000(ms);
  const L = 280.46 + 0.9856474 * n;
  const g = (357.528 + 0.9856003 * n) * RAD;
  return wrap(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
}

export function sunPosition(ms: number, lat: number, lon: number): Horizontal {
  const n = daysSinceJ2000(ms);
  const { ra, dec } = eclipticToEquatorial(sunLongitude(ms), 0, n);
  return toHorizontal(ra, dec, ms, lat, lon);
}

/** Geocentric ecliptic longitude/latitude of the moon (degrees), main periodic terms only. */
export function moonEcliptic(ms: number): { lambda: number; beta: number } {
  const n = daysSinceJ2000(ms);
  const L = 218.316 + 13.176396 * n; // mean longitude
  const M = (134.963 + 13.064993 * n) * RAD; // moon's mean anomaly
  const F = (93.272 + 13.22935 * n) * RAD; // argument of latitude
  const D = (297.85 + 12.190749 * n) * RAD; // mean elongation from the sun
  const Ms = (357.528 + 0.9856003 * n) * RAD; // sun's mean anomaly
  const lambda =
    L +
    6.289 * Math.sin(M) + // equation of the centre
    1.274 * Math.sin(2 * D - M) + // evection
    0.658 * Math.sin(2 * D) + // variation
    0.214 * Math.sin(2 * M) -
    0.186 * Math.sin(Ms) - // annual equation
    0.114 * Math.sin(2 * F);
  const beta = 5.128 * Math.sin(F) + 0.281 * Math.sin(M + F) + 0.278 * Math.sin(M - F) + 0.173 * Math.sin(2 * D - F);
  return { lambda: wrap(lambda), beta };
}

export interface Moon extends Horizontal {
  /** Fraction of the disc lit, 0 (new) … 1 (full). */
  illumination: number;
  /** True while the lit fraction grows (new → full). */
  waxing: boolean;
}

export function moonPosition(ms: number, lat: number, lon: number): Moon {
  const n = daysSinceJ2000(ms);
  const { lambda, beta } = moonEcliptic(ms);
  const { ra, dec } = eclipticToEquatorial(lambda, beta, n);
  const sunLon = sunLongitude(ms);
  // Elongation ψ from the sun; the lit fraction is (1 − cos ψ)/2 (phase angle ≈ 180° − ψ).
  const cosPsi = Math.cos(beta * RAD) * Math.cos((lambda - sunLon) * RAD);
  return {
    ...toHorizontal(ra, dec, ms, lat, lon),
    illumination: (1 - cosPsi) / 2,
    waxing: wrap(lambda - sunLon) < 180,
  };
}

/** Elevation/azimuth → unit vector in the scene (x east, y up, z south). */
export function toVector(h: Horizontal): [number, number, number] {
  const e = h.elevation * RAD;
  const a = h.azimuth * RAD;
  return [Math.cos(e) * Math.sin(a), Math.sin(e), -Math.cos(e) * Math.cos(a)];
}
