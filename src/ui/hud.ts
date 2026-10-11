/** The conditions panel: headline numbers, direction compass, detail rows and the physics table. */

import { describeWeather, type Hour } from '../data/openmeteo';
import { moonPhaseName, whitecapCoverage, type Look } from '../scene/look';
import { G, phaseSpeed, wavelength, type SeaState } from '../ocean/spectrum';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const POINTS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

/** 102 → "ESE". */
export function compassPoint(deg: number): string {
  return POINTS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

/** Energy flux per metre of wave crest in deep water: P = ρ·g²·Hs²·T / (64π) (W/m). */
export function wavePower(hs: number, period: number): number {
  return (1025 * G * G * hs * hs * period) / (64 * Math.PI);
}

/** Energy per square metre of sea surface: E = ρ·g·Hs²/16 (J/m²). */
export function waveEnergy(hs: number): number {
  return (1025 * G * hs * hs) / 16;
}

const fmt = (v: number | null | undefined, digits = 1, unit = '') => (v == null ? '—' : `${v.toFixed(digits)}${unit}`);

export interface HudInput {
  hour: Hour;
  look: Look;
  live: boolean;
  /** Playhead minus now (ms). */
  offset: number;
  utcOffset: number;
  facing: number;
  tideTrend: 'rising' | 'falling' | null;
  sunrise: number | null;
  sunset: number | null;
  /** Wind sea grown from the local wind because the model reported none. */
  windSeaFromWind: SeaState | null;
  simulatedWaves: number;
}

function localTime(t: number, offset: number, withDate = false): string {
  return new Date(t + offset * 1000).toLocaleString(undefined, {
    timeZone: 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    ...(withDate ? { weekday: 'short', day: 'numeric', month: 'short' } : {}),
  });
}

function relative(ms: number): string {
  const h = Math.round(ms / 3_600_000);
  if (h === 0) return 'now';
  const d = Math.trunc(h / 24);
  const r = Math.abs(h % 24);
  const sign = h > 0 ? '+' : '−';
  return d ? `${sign}${Math.abs(d)}d ${r}h` : `${sign}${Math.abs(h)}h`;
}

/** An arrow across the compass, travelling the way the waves/wind go (drawn from where they come from). */
function arrow(from: number, color: string, len: number, width: number, dashed = false): string {
  const r = (from * Math.PI) / 180;
  const sx = Math.sin(r) * len;
  const sy = -Math.cos(r) * len;
  const head = 7;
  const ex = -sx * 0.55;
  const ey = -sy * 0.55;
  const ux = -sx / len;
  const uy = -sy / len;
  const hx1 = ex - ux * head + uy * head * 0.55;
  const hy1 = ey - uy * head - ux * head * 0.55;
  const hx2 = ex - ux * head - uy * head * 0.55;
  const hy2 = ey - uy * head + ux * head * 0.55;
  return `<g stroke="${color}" fill="${color}" stroke-width="${width}" stroke-linecap="round">
    <line x1="${sx}" y1="${sy}" x2="${ex}" y2="${ey}" ${dashed ? 'stroke-dasharray="4 3"' : ''}/>
    <path d="M${ex},${ey} L${hx1},${hy1} L${hx2},${hy2} Z" stroke-width="1"/>
  </g>`;
}

export function renderCompass(svg: SVGSVGElement, i: HudInput): void {
  const R = 52;
  const f = (i.facing * Math.PI) / 180;
  // Sea half: a semicircle centred on the facing direction.
  const a0 = f - Math.PI / 2;
  const a1 = f + Math.PI / 2;
  const p = (a: number, r = R) => `${(Math.sin(a) * r).toFixed(1)},${(-Math.cos(a) * r).toFixed(1)}`;
  const ticks = Array.from({ length: 16 }, (_, k) => {
    const a = (k * Math.PI) / 8;
    const r0 = k % 4 === 0 ? R - 6 : R - 3;
    return `<line x1="${p(a, r0).split(',')[0]}" y1="${p(a, r0).split(',')[1]}" x2="${p(a).split(',')[0]}" y2="${p(a).split(',')[1]}"/>`;
  }).join('');
  const labels = ['N', 'E', 'S', 'W']
    .map((l, k) => {
      const [x, y] = p((k * Math.PI) / 2, R + 0.5 - 13).split(',');
      return `<text x="${x}" y="${y}" dy="3.5" text-anchor="middle">${l}</text>`;
    })
    .join('');
  const { hour } = i;
  const wind = i.windSeaFromWind ?? hour.wind;
  svg.innerHTML = `
    <path d="M${p(a0)} A${R},${R} 0 0 1 ${p(a1)} Z" fill="rgba(90,169,255,0.16)"/>
    <line x1="${p(a0).split(',')[0]}" y1="${p(a0).split(',')[1]}" x2="${p(a1).split(',')[0]}" y2="${p(a1).split(',')[1]}" stroke="rgba(240,220,170,0.6)" stroke-width="2"/>
    <circle r="${R}" fill="none" stroke="rgba(255,255,255,0.25)"/>
    <g stroke="rgba(255,255,255,0.35)">${ticks}</g>
    <g fill="rgba(220,235,240,0.75)" font-size="9" font-family="system-ui">${labels}</g>
    ${hour.secondary ? arrow(hour.secondary.from, 'var(--secondary)', R - 4, 2) : ''}
    ${wind ? arrow(wind.from, 'var(--windsea)', R - 4, 2) : ''}
    ${hour.swell ? arrow(hour.swell.from, 'var(--swell)', R - 4, 3.2) : ''}
    ${hour.windSpeed >= 0.5 ? arrow(hour.windDir, 'var(--wind)', R - 14, 1.6, true) : ''}
  `;
}

function stateCell(s: SeaState | null, note = ''): string {
  if (!s) return '<span class="muted">none</span>';
  return `${s.height.toFixed(2)} m · ${s.period.toFixed(1)} s · from ${compassPoint(s.from)} <span class="muted">(${Math.round(s.from)}°)</span>${note}`;
}

export function renderHud(i: HudInput): void {
  const { hour, look } = i;
  const badge = $('mode-badge');
  badge.textContent = i.live ? 'LIVE' : `FORECAST ${relative(i.offset)}`;
  badge.classList.toggle('forecast', !i.live);
  $('local-time').textContent = `${localTime(hour.t, i.utcOffset, true)} local time`;
  $('hs').textContent = fmt(hour.waveHeight, 1, ' m');
  $('sst').textContent = fmt(hour.sst, 0, '°C');
  $('wind').textContent = `${hour.windSpeed.toFixed(0)} m/s`;
  $('wind-dir').textContent = `wind from ${compassPoint(hour.windDir)}`;
  renderCompass($('compass') as unknown as SVGSVGElement, i);

  const w = describeWeather(hour.code);
  const tide =
    hour.tide == null ? '—' : `${hour.tide >= 0 ? '+' : ''}${hour.tide.toFixed(2)} m${i.tideTrend ? ` · ${i.tideTrend === 'rising' ? '↑ rising' : '↓ falling'}` : ''}`;
  const current =
    hour.currentSpeed == null ? '—' : `${hour.currentSpeed.toFixed(1)} km/h → ${hour.currentDir == null ? '' : compassPoint(hour.currentDir)}`;
  const sun = [i.sunrise && `↑ ${localTime(i.sunrise, i.utcOffset)}`, i.sunset && `↓ ${localTime(i.sunset, i.utcOffset)}`].filter(Boolean).join('  ');
  const windSea = i.windSeaFromWind ? stateCell(i.windSeaFromWind, ' <span class="muted">(from local wind)</span>') : stateCell(hour.wind);
  const rows: [string, string][] = [
    ['Swell', stateCell(hour.swell)],
    ['Secondary', stateCell(hour.secondary)],
    ['Wind sea', windSea],
    ['Tide', tide],
    ['Current', current],
    ['Weather', `${w.icon} ${w.label} · ${fmt(hour.airTemp, 0, '°C')} · ${(hour.visibility / 1000).toFixed(hour.visibility < 10_000 ? 1 : 0)} km visibility`],
    ['Wind', `${hour.windSpeed.toFixed(1)} m/s, gusts ${hour.gust.toFixed(0)} · from ${compassPoint(hour.windDir)}`],
    ['Sun', `${look.sunElevation.toFixed(0)}° up${sun ? ` · ${sun}` : ''}`],
    ['Moon', `${moonPhaseName(look.moon)} · ${(look.moon.illumination * 100).toFixed(0)}% · ${look.moon.elevation.toFixed(0)}° up`],
  ];
  $('rows').innerHTML = rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');

  const physics = $('physics') as HTMLDetailsElement;
  if (physics.open) $('physics-body').innerHTML = physicsTable(i);
}

function physicsTable(i: HudInput): string {
  const systems: [string, SeaState | null][] = [
    ['Swell', i.hour.swell],
    ['Secondary', i.hour.secondary],
    ['Wind sea', i.windSeaFromWind ?? i.hour.wind],
  ];
  const rows = systems
    .filter(([, s]) => s)
    .map(([name, s]) => {
      const L = wavelength(s!.period);
      const c = phaseSpeed(s!.period);
      return `<tr><td>${name}</td><td>${L.toFixed(0)} m</td><td>${(c * 3.6).toFixed(0)} km/h</td><td>${(c * 1.8).toFixed(0)} km/h</td><td>${(s!.height / 0.78).toFixed(1)} m</td><td>${(wavePower(s!.height, s!.period) / 1000).toFixed(1)} kW/m</td></tr>`;
    })
    .join('');
  const hs = i.hour.waveHeight ?? 0;
  const caps = whitecapCoverage(i.hour.windSpeed) * 100;
  return `
    <table>
      <tr class="muted"><th></th><th>length</th><th>crests</th><th>energy</th><th>breaks at</th><th>power</th></tr>
      ${rows || '<tr><td colspan="6" class="muted">Flat calm</td></tr>'}
    </table>
    <p><b>Length</b> L = gT²/2π and <b>crest speed</b> c = gT/2π come from deep-water dispersion (ω² = gk):
    long-period swell is longer and faster. The <b>energy</b> travels at half that speed (group velocity),
    which is why sets of waves arrive in groups.</p>
    <p>Waves <b>break</b> when their height reaches ~0.78 of the water depth. <b>Power</b> is the energy
    flowing toward the coast per metre of beach, ρg²H²T/64π.</p>
    <p>Total sea: ${hs.toFixed(2)} m significant height, ${(waveEnergy(hs) / 1000).toFixed(1)} kJ per m² of sea.
    Wind ${i.hour.windSpeed.toFixed(1)} m/s → whitecaps on ≈ ${caps < 0.1 ? caps.toFixed(2) : caps.toFixed(1)}% of the surface (Monahan).</p>
    <p class="muted">Drawn with ${i.simulatedWaves} Gerstner waves sampled from JONSWAP spectra, plus 16 wind ripples for shading.</p>
  `;
}
