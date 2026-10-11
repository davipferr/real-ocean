/**
 * Open-Meteo: https://open-meteo.com — free for non-commercial use, keyless, and CORS-enabled
 * (`Access-Control-Allow-Origin: *`), so a static page can call it directly.
 *
 * Two APIs, one hourly timeline:
 * - Marine (marine-api.open-meteo.com): wave height/period/direction split into wind sea, primary
 *   and secondary swell, sea surface temperature, ocean current, and sea level including tides.
 * - Forecast (api.open-meteo.com): wind, clouds, rain, visibility, temperature, weather code.
 *
 * Quirks found by calling it (Oct 2026):
 * - `*_peak_period` fields come back null; only mean periods are populated.
 * - "No wind sea" is reported as noise (0.02 m at 0.4 s), see `cleanState`.
 * - A point a few km inland snaps to the nearest sea cell; far inland everything is null.
 * - `timezone=auto` returns local times without an offset plus `utc_offset_seconds`.
 */

import { cleanState, type SeaState } from '../ocean/spectrum';

const MARINE = 'https://marine-api.open-meteo.com/v1/marine';
const WEATHER = 'https://api.open-meteo.com/v1/forecast';

const MARINE_FIELDS = [
  'wave_height',
  'wave_direction',
  'wave_period',
  'wind_wave_height',
  'wind_wave_direction',
  'wind_wave_period',
  'swell_wave_height',
  'swell_wave_direction',
  'swell_wave_period',
  'secondary_swell_wave_height',
  'secondary_swell_wave_direction',
  'secondary_swell_wave_period',
  'sea_surface_temperature',
  'ocean_current_velocity',
  'ocean_current_direction',
  'sea_level_height_msl',
] as const;

const WEATHER_FIELDS = [
  'temperature_2m',
  'weather_code',
  'cloud_cover',
  'precipitation',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'visibility',
  'is_day',
] as const;

export type MarineField = (typeof MARINE_FIELDS)[number];
export type WeatherField = (typeof WEATHER_FIELDS)[number];

export interface Hourly<F extends string> {
  latitude: number;
  longitude: number;
  timezone: string;
  utc_offset_seconds: number;
  hourly: { time: string[] } & Record<F, (number | null)[]>;
}

export const PAST_DAYS = 1;
export const FORECAST_DAYS = 7;

export function marineUrl(lat: number, lon: number): string {
  return `${MARINE}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=${MARINE_FIELDS.join(',')}&timezone=auto&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}`;
}

export function weatherUrl(lat: number, lon: number): string {
  return `${WEATHER}?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=${WEATHER_FIELDS.join(',')}&timezone=auto&past_days=${PAST_DAYS}&forecast_days=${FORECAST_DAYS}&wind_speed_unit=ms`;
}

/** One hour of conditions. Wave systems are null when absent; other fields fall back to calm. */
export interface Hour {
  /** UTC milliseconds. */
  t: number;
  waveHeight: number | null;
  wind: SeaState | null;
  swell: SeaState | null;
  secondary: SeaState | null;
  /** Sea surface temperature (°C). */
  sst: number | null;
  /** Ocean current speed (km/h) and the direction it flows TOWARDS (degrees). */
  currentSpeed: number | null;
  currentDir: number | null;
  /** Sea level relative to mean sea level, tides included (m). */
  tide: number | null;
  airTemp: number | null;
  /** WMO weather code. */
  code: number;
  /** 0–1 */
  cloud: number;
  /** mm/h */
  precip: number;
  /** m/s, and the direction the wind blows FROM (degrees). */
  windSpeed: number;
  windDir: number;
  gust: number;
  /** Metres. */
  visibility: number;
}

export interface Forecast {
  /** The marine grid cell actually used (may be offshore of the requested point). */
  lat: number;
  lon: number;
  timezone: string;
  utcOffset: number;
  hours: Hour[];
}

/** "2026-10-10T19:00" in a zone `offset` seconds east of UTC → UTC ms. */
export function localToUtc(time: string, offset: number): number {
  return Date.parse(`${time}:00Z`) - offset * 1000;
}

/** Merges the two responses into one timeline (keyed by time, so a missing hour can't misalign them). */
export function combine(marine: Hourly<MarineField>, weather: Hourly<WeatherField>): Forecast {
  const m = marine.hourly;
  const w = weather.hourly;
  const wIndex = new Map(w.time.map((t, i) => [t, i]));
  const hours: Hour[] = [];
  m.time.forEach((time, i) => {
    const j = wIndex.get(time);
    const wv = <F extends WeatherField>(f: F) => (j === undefined ? null : w[f][j]);
    hours.push({
      t: localToUtc(time, marine.utc_offset_seconds),
      waveHeight: m.wave_height[i],
      wind: cleanState(m.wind_wave_height[i], m.wind_wave_period[i], m.wind_wave_direction[i]),
      swell: cleanState(m.swell_wave_height[i], m.swell_wave_period[i], m.swell_wave_direction[i]),
      secondary: cleanState(m.secondary_swell_wave_height[i], m.secondary_swell_wave_period[i], m.secondary_swell_wave_direction[i]),
      sst: m.sea_surface_temperature[i],
      currentSpeed: m.ocean_current_velocity[i],
      currentDir: m.ocean_current_direction[i],
      tide: m.sea_level_height_msl[i],
      airTemp: wv('temperature_2m'),
      code: wv('weather_code') ?? 0,
      cloud: (wv('cloud_cover') ?? 0) / 100,
      precip: wv('precipitation') ?? 0,
      windSpeed: wv('wind_speed_10m') ?? 0,
      windDir: wv('wind_direction_10m') ?? 0,
      gust: wv('wind_gusts_10m') ?? 0,
      visibility: wv('visibility') ?? 30_000,
    });
  });
  return { lat: marine.latitude, lon: marine.longitude, timezone: marine.timezone, utcOffset: marine.utc_offset_seconds, hours };
}

/** True when the marine model has nothing for this place (too far inland). */
export function hasOcean(f: Forecast): boolean {
  return f.hours.some((h) => h.waveHeight != null);
}

export class OpenMeteoError extends Error {}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new OpenMeteoError(body?.reason ?? `Open-Meteo answered ${res.status}`);
  return body as T;
}

export async function fetchForecast(lat: number, lon: number, signal?: AbortSignal): Promise<Forecast> {
  const [marine, weather] = await Promise.all([
    getJson<Hourly<MarineField>>(marineUrl(lat, lon), signal),
    getJson<Hourly<WeatherField>>(weatherUrl(lat, lon), signal),
  ]);
  return combine(marine, weather);
}

// ——— Sampling between hours ———

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function lerpNum(a: number | null, b: number | null, t: number): number | null {
  if (a == null) return b;
  if (b == null) return a;
  return lerp(a, b, t);
}

/** Interpolates a compass angle the short way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  const d = ((b - a + 540) % 360) - 180;
  return (a + d * t + 360) % 360;
}

function lerpState(a: SeaState | null, b: SeaState | null, t: number): SeaState | null {
  // A system appearing or vanishing grows from / fades to zero height at its other end's shape.
  if (!a && !b) return null;
  const from = a ?? { ...b!, height: 0 };
  const to = b ?? { ...a!, height: 0 };
  const height = lerp(from.height, to.height, t);
  if (height <= 0.03) return null;
  return { height, period: lerp(from.period, to.period, t), from: lerpAngle(from.from, to.from, t) };
}

/** Conditions at UTC time `t`, interpolated between the surrounding hours (clamped at the ends). */
export function sample(f: Forecast, t: number): Hour {
  const hs = f.hours;
  if (t <= hs[0].t) return { ...hs[0], t };
  if (t >= hs[hs.length - 1].t) return { ...hs[hs.length - 1], t };
  let i = Math.min(hs.length - 2, Math.floor((t - hs[0].t) / 3_600_000));
  while (i > 0 && hs[i].t > t) i--;
  while (i < hs.length - 2 && hs[i + 1].t <= t) i++;
  const a = hs[i];
  const b = hs[i + 1];
  const u = (t - a.t) / (b.t - a.t);
  return {
    t,
    waveHeight: lerpNum(a.waveHeight, b.waveHeight, u),
    wind: lerpState(a.wind, b.wind, u),
    swell: lerpState(a.swell, b.swell, u),
    secondary: lerpState(a.secondary, b.secondary, u),
    sst: lerpNum(a.sst, b.sst, u),
    currentSpeed: lerpNum(a.currentSpeed, b.currentSpeed, u),
    currentDir: a.currentDir != null && b.currentDir != null ? lerpAngle(a.currentDir, b.currentDir, u) : a.currentDir,
    tide: lerpNum(a.tide, b.tide, u),
    airTemp: lerpNum(a.airTemp, b.airTemp, u),
    code: u < 0.5 ? a.code : b.code,
    cloud: lerp(a.cloud, b.cloud, u),
    precip: lerp(a.precip, b.precip, u),
    windSpeed: lerp(a.windSpeed, b.windSpeed, u),
    windDir: lerpAngle(a.windDir, b.windDir, u),
    gust: lerp(a.gust, b.gust, u),
    visibility: lerp(a.visibility, b.visibility, u),
  };
}

/** Is the tide rising at `t`? Compares the sea level half an hour either side. */
export function tideTrend(f: Forecast, t: number): 'rising' | 'falling' | null {
  const a = sample(f, t - 1_800_000).tide;
  const b = sample(f, t + 1_800_000).tide;
  if (a == null || b == null) return null;
  return b >= a ? 'rising' : 'falling';
}

// ——— WMO weather codes ———

export interface WeatherInfo {
  label: string;
  icon: string;
  thunder: boolean;
  snow: boolean;
}

/** WMO 4677 codes as used by Open-Meteo. */
export function describeWeather(code: number): WeatherInfo {
  const w = (label: string, icon: string, thunder = false, snow = false) => ({ label, icon, thunder, snow });
  if (code === 0) return w('Clear sky', '☀️');
  if (code === 1) return w('Mainly clear', '🌤️');
  if (code === 2) return w('Partly cloudy', '⛅');
  if (code === 3) return w('Overcast', '☁️');
  if (code === 45 || code === 48) return w('Fog', '🌫️');
  if (code >= 51 && code <= 57) return w('Drizzle', '🌦️');
  if (code >= 61 && code <= 67) return w(code >= 65 ? 'Heavy rain' : 'Rain', '🌧️');
  if (code >= 71 && code <= 77) return w('Snow', '🌨️', false, true);
  if (code >= 80 && code <= 82) return w('Rain showers', '🌦️');
  if (code === 85 || code === 86) return w('Snow showers', '🌨️', false, true);
  if (code >= 95) return w(code === 95 ? 'Thunderstorm' : 'Thunderstorm with hail', '⛈️', true);
  return w('—', '🌡️');
}
