import { describe, expect, it } from 'vitest';

import { daysSinceJ2000, moonPosition, sunPosition, toVector } from './astro/sky';
import {
  BEACHES,
  beachFromHash,
  beachToHash,
  distanceKm,
  estimateFacing,
  probePoints,
  type Probe,
} from './data/beaches';
import { combine, describeWeather, lerpAngle, localToUtc, sample, tideTrend, type Forecast, type Hourly, type MarineField, type WeatherField } from './data/openmeteo';
import { WaveField, evaluate, spacingFade, surfaceAt } from './ocean/gerstner';
import { BEACH_SLOPE, bedHeight, depthFactor, fromShore, toShore } from './ocean/shore';
import {
  G,
  MAX_WAVES,
  bearingToVec,
  buildRipples,
  buildWaves,
  cleanState,
  expandSystem,
  phaseSpeed,
  significantHeight,
  steepness,
  vecToBearing,
  wavelength,
  wavenumber,
  windSeaFromWind,
} from './ocean/spectrum';
import { extinction, sunIrradiance } from './scene/atmosphere';
import { fogDensity, lookAt, moonPhaseName, sunEvents, whitecapCoverage } from './scene/look';
import type { Hour } from './data/openmeteo';
import { compassPoint, wavePower } from './ui/hud';

const UTC = (s: string) => Date.parse(s);

describe('deep-water dispersion', () => {
  it('gives the textbook numbers for a 10 s swell', () => {
    expect(wavelength(10)).toBeCloseTo(156.1, 0);
    expect(phaseSpeed(10)).toBeCloseTo(15.6, 1);
    expect(wavenumber(10)).toBeCloseTo((2 * Math.PI) / wavelength(10), 6);
  });

  it('satisfies ω² = g·k', () => {
    const T = 7.3;
    expect(((2 * Math.PI) / T) ** 2).toBeCloseTo(G * wavenumber(T), 9);
  });
});

describe('bearings', () => {
  it('maps compass bearings onto the scene (x east, z south)', () => {
    const [ex, ez] = bearingToVec(90);
    expect(ex).toBeCloseTo(1);
    expect(ez).toBeCloseTo(0);
    const [nx, nz] = bearingToVec(0);
    expect(nx).toBeCloseTo(0);
    expect(nz).toBeCloseTo(-1);
  });

  it('round-trips', () => {
    for (const b of [0, 37, 102, 180, 271, 359]) expect(vecToBearing(...bearingToVec(b))).toBeCloseTo(b, 6);
  });

  it('names compass points', () => {
    expect(compassPoint(102)).toBe('ESE');
    expect(compassPoint(359)).toBe('N');
    expect(compassPoint(-90)).toBe('W');
  });
});

describe('spectrum → waves', () => {
  it('preserves the significant height of each system', () => {
    for (const hs of [0.3, 1.2, 4.5]) {
      const waves = expandSystem('swell', { height: hs, period: 11, from: 140 });
      expect(significantHeight(waves)).toBeCloseTo(hs, 6);
    }
  });

  it('combines systems like the wave model (heights add in quadrature)', () => {
    const waves = buildWaves({
      wind: null,
      swell: { height: 0.63, period: 6.2, from: 102 },
      secondary: { height: 0.12, period: 10.9, from: 152 },
    });
    // Open-Meteo reported wave_height 0.64 for exactly these components.
    expect(significantHeight(waves)).toBeCloseTo(Math.hypot(0.63, 0.12), 6);
    expect(significantHeight(waves)).toBeCloseTo(0.64, 2);
  });

  it('keeps a fixed slot layout, absent systems as zero amplitude', () => {
    const waves = buildWaves({ wind: null, swell: null, secondary: null });
    expect(waves).toHaveLength(MAX_WAVES);
    expect(waves.every((w) => w.amp === 0)).toBe(true);
  });

  it('sends the waves away from where they come from', () => {
    const waves = expandSystem('swell', { height: 1, period: 10, from: 90 });
    const mean = waves.reduce((s, w) => s + w.dirX * w.amp, 0) / waves.reduce((s, w) => s + w.amp, 0);
    expect(mean).toBeLessThan(-0.9); // from the east → travelling west (−x)
  });

  it('is deterministic per seed', () => {
    const a = expandSystem('wind', { height: 1, period: 5, from: 0 }, 7);
    const b = expandSystem('wind', { height: 1, period: 5, from: 0 }, 7);
    expect(a).toEqual(b);
  });

  it('centres the energy near the peak period', () => {
    const waves = expandSystem('swell', { height: 2, period: 12, from: 0 });
    const strongest = waves.reduce((a, b) => (b.amp > a.amp ? b : a));
    const T = (2 * Math.PI) / Math.sqrt(G * strongest.k);
    expect(T).toBeGreaterThan(10);
    expect(T).toBeLessThan(16);
  });

  it('limits steepness so crests never loop', () => {
    expect(steepness([{ k: 0.1, amp: 0.5 }])).toBe(1); // Σka = 0.05: true trochoids
    const q = steepness([
      { k: 1, amp: 0.6 },
      { k: 1, amp: 0.6 },
    ]);
    expect(q * 1.2).toBeCloseTo(0.85);
  });
});

describe('sea-state cleaning and wind seas', () => {
  it('drops the model noise for "no wind sea"', () => {
    expect(cleanState(0.02, 0.4, 3)).toBeNull();
    expect(cleanState(0.5, 4, 10)).toEqual({ height: 0.5, period: 4, from: 10 });
    expect(cleanState(null, 4, 10)).toBeNull();
  });

  it('grows a wind sea from the wind, capped by the fetch', () => {
    expect(windSeaFromWind(0.5, 0)).toBeNull();
    const ten = windSeaFromWind(10, 200)!;
    expect(ten.from).toBe(200);
    // Fetch-limited at 30 km: well below the fully developed 2.4 m.
    expect(ten.height).toBeGreaterThan(0.8);
    expect(ten.height).toBeLessThan(1.6);
    expect(windSeaFromWind(10, 0, 1e7)!.height).toBeCloseTo((0.21 * (10.7 * 10.7)) / G, 1);
  });

  it('sizes wind ripples by Cox–Munk slope statistics', () => {
    const calm = buildRipples(0, 0);
    const windy = buildRipples(12, 0);
    const mss = (r: typeof calm) => r.reduce((s, x) => s + (x.slope * x.slope) / 2, 0);
    expect(mss(calm)).toBeCloseTo(0.003, 6);
    expect(mss(windy)).toBeCloseTo(0.003 + 0.00512 * 12, 6);
  });
});

describe('Gerstner field', () => {
  const field = new WaveField();
  field.setTarget(buildWaves({ wind: { height: 0.8, period: 4, from: 200 }, swell: { height: 1.5, period: 11, from: 120 }, secondary: null }));

  it('reports the significant height of what it draws', () => {
    expect(field.hs).toBeCloseTo(Math.hypot(0.8, 1.5), 6);
  });

  it('has normals matching the finite-difference surface slope', () => {
    // Height as a function of the displaced position: sample neighbours via surfaceAt.
    const x = 13;
    const z = -7;
    const h = 0.05;
    const s = surfaceAt(field, x, z, undefined, 30);
    const sx = surfaceAt(field, x + h, z, undefined, 30);
    const sz = surfaceAt(field, x, z + h, undefined, 30);
    const dydx = (sx.y - s.y) / h;
    const dydz = (sz.y - s.y) / h;
    expect(-s.nx / s.ny).toBeCloseTo(dydx, 1);
    expect(-s.nz / s.ny).toBeCloseTo(dydz, 1);
  });

  it('finds the surface above a fixed point', () => {
    const s = surfaceAt(field, 40, 25);
    expect(s.x).toBeCloseTo(40, 3);
    expect(s.z).toBeCloseTo(25, 3);
  });

  it('compresses the surface at crests (Jacobian < 1) and stretches it in troughs', () => {
    const samples = Array.from({ length: 400 }, (_, i) => evaluate(field, i * 0.7, i * 0.3));
    const crest = samples.reduce((a, b) => (b.y > a.y ? b : a));
    const trough = samples.reduce((a, b) => (b.y < a.y ? b : a));
    expect(crest.jac).toBeLessThan(1);
    expect(trough.jac).toBeGreaterThan(1);
    expect(Math.min(...samples.map((s) => s.jac))).toBeGreaterThan(0); // no loops
  });

  it('eases toward a new sea state without jumping', () => {
    const f = new WaveField();
    f.setTarget(buildWaves({ wind: null, swell: { height: 1, period: 10, from: 90 }, secondary: null }));
    const before = evaluate(f, 5, 5).y;
    f.setTarget(buildWaves({ wind: null, swell: { height: 1, period: 14, from: 90 }, secondary: null }));
    f.update(1 / 60);
    expect(Math.abs(evaluate(f, 5, 5).y - before)).toBeLessThan(0.1);
    for (let i = 0; i < 600; i++) f.update(1 / 60);
    expect(f.a[2]).toBeCloseTo(buildWaves({ wind: null, swell: { height: 1, period: 14, from: 90 }, secondary: null })[0].k, 3);
  });

  it('hides waves the mesh is too coarse to draw', () => {
    expect(spacingFade(10, 1)).toBe(1);
    expect(spacingFade(3, 1)).toBe(0);
    expect(spacingFade(6, 1)).toBeCloseTo(0.5);
  });
});

describe('shore', () => {
  const shore = { facing: 100, deanA: 0.1 };

  it('converts between scene and shore coordinates', () => {
    const p = fromShore(shore, 80, -30);
    const back = toShore(shore, p.x, p.z);
    expect(back.d).toBeCloseTo(80);
    expect(back.u).toBeCloseTo(-30);
    // Seaward is the facing bearing.
    const sea = fromShore(shore, 1, 0);
    expect(vecToBearing(sea.x, sea.z)).toBeCloseTo(100);
  });

  it('follows the Dean profile underwater and the beach face above', () => {
    expect(bedHeight(0.1, 0, 0)).toBeCloseTo(0, 3); // the sandbar's tail adds a few µm
    expect(bedHeight(0.1, 500, 0)).toBeCloseTo(-0.1 * (501 ** (2 / 3) - 1), 6);
    expect(bedHeight(0.1, -10, 0)).toBeCloseTo(10 * BEACH_SLOPE);
    expect(bedHeight(0.1, 1e6, 0)).toBe(-40);
  });

  it('has a sandbar shallower than the plain profile', () => {
    const plain = -0.1 * (91 ** (2 / 3) - 1);
    expect(bedHeight(0.1, 90, 0)).toBeGreaterThan(plain + 0.3);
  });

  it('caps waves by depth (break at H ≈ 0.78·h)', () => {
    expect(depthFactor(50, 1)).toBeCloseTo(1, 3);
    expect(depthFactor(2, 4)).toBeCloseTo(0.39, 2);
    expect(depthFactor(-10, 1)).toBe(0);
    expect(depthFactor(0, 1)).toBeGreaterThan(0); // swash
  });
});

describe('sun and moon', () => {
  it('counts days from J2000', () => {
    expect(daysSinceJ2000(UTC('2000-01-01T12:00:00Z'))).toBe(0);
  });

  it('puts the equinox noon sun overhead at the equator', () => {
    // 2024 March equinox; local solar noon at 0° longitude ≈ 12:07 UTC (equation of time).
    const s = sunPosition(UTC('2024-03-20T12:07:00Z'), 0, 0);
    expect(s.elevation).toBeGreaterThan(89);
  });

  it('rises in the east and sets in the west', () => {
    const lat = -27.6;
    const lon = -48.4;
    const morning = sunPosition(UTC('2026-10-11T09:30:00Z'), lat, lon); // 06:30 local
    const evening = sunPosition(UTC('2026-10-11T20:30:00Z'), lat, lon); // 17:30 local
    expect(morning.azimuth).toBeGreaterThan(60);
    expect(morning.azimuth).toBeLessThan(120);
    expect(evening.azimuth).toBeGreaterThan(240);
    expect(evening.azimuth).toBeLessThan(300);
  });

  it('finds sunrise and sunset in Florianópolis', () => {
    // Timeanddate: 11 Oct 2026, sunrise 05:40, sunset 18:19 (UTC−3).
    const { rise, set } = sunEvents(UTC('2026-10-11T03:00:00Z'), -27.6, -48.4);
    expect(Math.abs(rise! - UTC('2026-10-11T08:40:00Z'))).toBeLessThan(4 * 60_000);
    expect(Math.abs(set! - UTC('2026-10-11T21:19:00Z'))).toBeLessThan(4 * 60_000);
  });

  it('gets the moon phase right', () => {
    const full = moonPosition(UTC('2024-01-25T17:54:00Z'), 0, 0);
    const fresh = moonPosition(UTC('2024-02-09T22:59:00Z'), 0, 0);
    const quarter = moonPosition(UTC('2024-01-18T03:53:00Z'), 0, 0);
    expect(full.illumination).toBeGreaterThan(0.99);
    expect(fresh.illumination).toBeLessThan(0.01);
    expect(quarter.illumination).toBeCloseTo(0.5, 1);
    expect(quarter.waxing).toBe(true);
    expect(moonPhaseName(full)).toBe('Full moon');
  });

  it('builds unit direction vectors', () => {
    const v = toVector({ elevation: 30, azimuth: 90 });
    expect(Math.hypot(...v)).toBeCloseTo(1);
    expect(v[1]).toBeCloseTo(0.5);
    expect(v[0]).toBeGreaterThan(0.8);
  });
});

describe('atmosphere and look', () => {
  const air = { turbidity: 2.5, rayleigh: 1, mieCoefficient: 0.005 };

  it('reddens and dims the low sun', () => {
    const noon = sunIrradiance(0.9, air);
    const low = sunIrradiance(0.05, air);
    expect(low[1]).toBeLessThan(noon[1]);
    expect(low[2] / low[0]).toBeLessThan(noon[2] / noon[0]);
    expect(sunIrradiance(-0.2, air)).toEqual([0, 0, 0]);
    expect(extinction(1, air)[0]).toBeGreaterThan(extinction(1, air)[2]); // blue scatters most
  });

  it('turns visibility into fog density (Koschmieder)', () => {
    expect(Math.exp(-fogDensity(10_000) * 10_000)).toBeCloseTo(0.02, 3);
  });

  it('estimates whitecap coverage (Monahan)', () => {
    expect(whitecapCoverage(7)).toBeCloseTo(0.0029, 3);
    expect(whitecapCoverage(15)).toBeGreaterThan(0.03);
    expect(whitecapCoverage(0)).toBe(0);
  });

  it('keeps a moonless night readable', () => {
    // 11 Oct 2026, 00:40 UTC: Praia Mole, sun −41°, new moon below the horizon.
    const hour: Hour = {
      t: UTC('2026-10-11T00:40:00Z'), waveHeight: 0.7, wind: null, swell: null, secondary: null, sst: 21,
      currentSpeed: null, currentDir: null, tide: 0, airTemp: 19, code: 0, cloud: 0, precip: 0,
      windSpeed: 5, windDir: 180, gust: 8, visibility: 20_000,
    };
    const l = lookAt(hour, -27.6, -48.4);
    expect(l.night).toBe(1);
    expect(l.moonColor).toEqual([0, 0, 0]);
    // Airglow/starlight floor: the night sky must not drop to black.
    expect(l.nightSky[1]).toBeGreaterThan(0.005);
    expect(l.stars).toBeGreaterThan(0.9);
  });

  it('computes deep-water wave power', () => {
    // 1 m, 10 s: ≈ 4.9 kW per metre of crest.
    expect(wavePower(1, 10) / 1000).toBeCloseTo(4.9, 1);
  });
});

describe('Open-Meteo timeline', () => {
  const marine: Hourly<MarineField> = {
    latitude: -27.625,
    longitude: -48.458,
    timezone: 'America/Sao_Paulo',
    utc_offset_seconds: -10_800,
    hourly: {
      time: ['2026-10-10T19:00', '2026-10-10T20:00'],
      wave_height: [0.64, 0.8],
      wave_direction: [104, 110],
      wave_period: [7.6, 7.8],
      wind_wave_height: [0.02, 0.5],
      wind_wave_direction: [3, 200],
      wind_wave_period: [0.4, 3.5],
      swell_wave_height: [0.64, 0.7],
      swell_wave_direction: [350, 10],
      swell_wave_period: [6.2, 6.4],
      secondary_swell_wave_height: [0.12, null],
      secondary_swell_wave_direction: [152, null],
      secondary_swell_wave_period: [10.9, null],
      sea_surface_temperature: [21, 21],
      ocean_current_velocity: [0.5, 0.5],
      ocean_current_direction: [90, 90],
      sea_level_height_msl: [-0.17, 0.03],
    },
  };
  const weather: Hourly<WeatherField> = {
    ...marine,
    hourly: {
      time: ['2026-10-10T20:00', '2026-10-10T19:00'], // out of order on purpose
      temperature_2m: [18, 19.3],
      weather_code: [61, 3],
      cloud_cover: [100, 50],
      precipitation: [1.2, 0],
      wind_speed_10m: [4, 0.5],
      wind_direction_10m: [350, 17],
      wind_gusts_10m: [8, 2],
      visibility: [9000, 14320],
      is_day: [0, 0],
    },
  };
  const f: Forecast = combine(marine, weather);

  it('converts local times to UTC', () => {
    expect(localToUtc('2026-10-10T19:00', -10_800)).toBe(UTC('2026-10-10T22:00:00Z'));
    expect(f.hours[0].t).toBe(UTC('2026-10-10T22:00:00Z'));
  });

  it('joins the two APIs by time, not by index', () => {
    expect(f.hours[0].cloud).toBe(0.5);
    expect(f.hours[1].code).toBe(61);
  });

  it('cleans each hour', () => {
    expect(f.hours[0].wind).toBeNull(); // 0.02 m at 0.4 s
    expect(f.hours[1].wind).toEqual({ height: 0.5, period: 3.5, from: 200 });
    expect(f.hours[1].secondary).toBeNull();
  });

  it('interpolates, angles the short way round', () => {
    const mid = sample(f, UTC('2026-10-10T22:30:00Z'));
    expect(mid.tide).toBeCloseTo(-0.07);
    expect(mid.swell!.from).toBeCloseTo(0, 6); // 350° → 10°, not through 180°
    expect(lerpAngle(350, 10, 0.25)).toBeCloseTo(355);
    expect(sample(f, 0).t).toBe(0); // clamped data, requested time kept
  });

  it('fades a system in from zero instead of popping', () => {
    const early = sample(f, UTC('2026-10-10T22:03:00Z')); // wind sea absent → present
    expect(early.wind).toBeNull(); // 5% of 0.5 m is below the 3 cm floor
    const later = sample(f, UTC('2026-10-10T22:45:00Z'));
    expect(later.wind!.height).toBeCloseTo(0.375);
  });

  it('knows whether the tide is rising', () => {
    expect(tideTrend(f, UTC('2026-10-10T22:30:00Z'))).toBe('rising');
  });

  it('describes WMO weather codes', () => {
    expect(describeWeather(3).label).toBe('Overcast');
    expect(describeWeather(95).thunder).toBe(true);
    expect(describeWeather(73).snow).toBe(true);
  });
});

describe('beaches', () => {
  it('estimates which way a straight coast faces', () => {
    const probes = probePoints(0, 0);
    // Sea to the east of a north–south coastline.
    const elev = probes.map((p: Probe) => (p.east > 0 ? 0 : 20));
    expect(estimateFacing(probes, elev)).toBeCloseTo(90, 0);
    const south = probes.map((p: Probe) => (p.north < 0 ? -3 : 5));
    expect(estimateFacing(probes, south)).toBeCloseTo(180, 0);
    expect(estimateFacing(probes, probes.map(() => 10))).toBeNull();
    expect(estimateFacing(probes, probes.map(() => 0))).toBeNull();
  });

  it('keeps probes inside the disc and under the API limit', () => {
    const probes = probePoints(-27.6, -48.4);
    expect(probes.length).toBeLessThanOrEqual(100);
    for (const p of probes) expect(Math.hypot(p.east, p.north)).toBeLessThanOrEqual(2501);
    // Offsets really are metres on the ground.
    const far = probes.reduce((a, b) => (b.east > a.east ? b : a));
    expect(distanceKm(-27.6, -48.4, far.lat, far.lon)).toBeCloseTo(far.east / 1000, 1);
  });

  it('round-trips beaches through the URL hash', () => {
    expect(beachFromHash(beachToHash(BEACHES[2]))).toBe(BEACHES[2]);
    const custom = beachFromHash('#@-23.4339,-45.0711,96,Ubatuba')!;
    expect(custom).toMatchObject({ lat: -23.4339, lon: -45.0711, facing: 96, name: 'Ubatuba', group: 'Search' });
    expect(beachFromHash(beachToHash(custom))).toMatchObject({ lat: -23.4339, facing: 96, name: 'Ubatuba' });
    expect(beachFromHash('#nowhere')).toBeNull();
    expect(beachFromHash('#@99,0,10')).toBeNull();
  });

  it('has unique preset ids and sane facings', () => {
    expect(new Set(BEACHES.map((b) => b.id)).size).toBe(BEACHES.length);
    for (const b of BEACHES) {
      expect(b.facing).toBeGreaterThanOrEqual(0);
      expect(b.facing).toBeLessThan(360);
    }
  });
});
