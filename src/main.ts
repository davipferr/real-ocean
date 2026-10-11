import * as THREE from 'three';

import { gmst } from './astro/sky';
import {
  BEACHES,
  DEFAULT_BEACH,
  beachFromHash,
  beachToHash,
  distanceKm,
  probeFacing,
  searchPlaces,
  type Beach as BeachInfo,
  type Place,
} from './data/beaches';
import { fetchForecast, hasOcean, sample, tideTrend, type Forecast, type Hour } from './data/openmeteo';
import { WaveField, surfaceAt, type Sample } from './ocean/gerstner';
import { bedHeight, depthFactor, fromShore, toShore, type Shore } from './ocean/shore';
import { G, RIPPLES, bearingToVec, buildRipples, buildWaves, windSeaFromWind, type SeaState } from './ocean/spectrum';
import { Beach } from './scene/beach';
import { CameraRig, groundHeight, type View } from './scene/camera';
import { lookAt, sunEvents, type Look } from './scene/look';
import { Buoy, Rain } from './scene/props';
import { AdaptiveResolution } from './scene/quality';
import { SKY_LAYER, SkySystem } from './scene/sky';
import { Water } from './scene/water';
import { compassPoint, renderHud } from './ui/hud';
import { Timeline } from './ui/timeline';
import { createToast } from './ui/toast';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const toast = createToast($('toast'));

// ——— Renderer & scene ———

const canvas = $<HTMLCanvasElement>('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const quality = new AdaptiveResolution(Math.min(window.devicePixelRatio || 1, 2));
renderer.setPixelRatio(quality.ratio);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x9fb4c4, 0.0001);
const camera = new THREE.PerspectiveCamera(55, 1, 0.3, 60_000);
camera.layers.enable(SKY_LAYER);

const ENV_SIZE = 128;
const sky = new SkySystem(ENV_SIZE);
sky.mesh.renderOrder = -1;
const field = new WaveField();
const water = new Water(field, sky.envTarget.texture, ENV_SIZE);
const sand = new Beach(sky.envTarget.texture);
const buoy = new Buoy();
const rain = new Rain();
const sunLight = new THREE.DirectionalLight();
const moonLight = new THREE.DirectionalLight();
scene.add(sky.mesh, water.mesh, sand.mesh, buoy.group, rain.lines, sunLight, moonLight);

const rig = new CameraRig(camera, canvas);

function resize(): void {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

// ——— State ———

let beach: BeachInfo = beachFromHash(location.hash) ?? DEFAULT_BEACH;
let shore: Shore = { facing: beach.facing, deanA: beach.deanA };
let forecast: Forecast | null = null;
let live = true;
let playing = false;
let playhead = Date.now();
let simTime = 0;
let hour: Hour | null = null;
let look: Look | null = null;
let windSeaFallback: SeaState | null = null;
let flash = 0;
let nextFlash = 0;
let loadAbort: AbortController | null = null;

const ripplesNow = new Float32Array(RIPPLES * 4);
const ripplesTarget = new Float32Array(RIPPLES * 4);
const ripplePhase = new Float32Array(RIPPLES);
let ripplesReady = false;

// ——— Loading ———

const loading = $('loading');

function setLoading(text: string | null): void {
  loading.textContent = text ?? '';
  loading.classList.toggle('hidden', !text);
}

async function loadBeach(next: BeachInfo, opts: { quiet?: boolean; guessFacing?: boolean } = {}): Promise<void> {
  loadAbort?.abort();
  const abort = (loadAbort = new AbortController());
  if (!opts.quiet) setLoading(`Fetching the sea at ${next.name}…`);
  try {
    const f = await fetchForecast(next.lat, next.lon, abort.signal);
    if (abort.signal.aborted) return;
    if (!hasOcean(f)) {
      toast(`No ocean data near ${next.name}: the wave model only covers the sea and the coast.`, 'error');
      setLoading(null);
      return;
    }
    const changed = next !== beach || !forecast;
    if (opts.guessFacing) {
      // Unknown coastline: assume the beach faces the swell (waves arrive from the open sea).
      const h = sample(f, Date.now());
      next = { ...next, facing: Math.round(h.swell?.from ?? h.wind?.from ?? 180) };
      toast(`Couldn't read the coastline around ${next.name}; facing the swell. Adjust it with the slider.`);
    }
    forecast = f;
    if (changed) {
      beach = next;
      shore = { facing: beach.facing, deanA: beach.deanA };
      applyShore();
      history.replaceState(null, '', beachToHash(beach));
    }
    timeline.setForecast(f, beach.lat, beach.lon);
    const km = distanceKm(beach.lat, beach.lon, f.lat, f.lon);
    $('cell-note').textContent = `Waves from the model cell at ${f.lat.toFixed(2)}, ${f.lon.toFixed(2)} (${km.toFixed(0)} km away). Data: Open-Meteo.`;
    $('place-name').textContent = beach.name;
    $('place-region').textContent = beach.region;
    syncPlaceUi();
    updateConditions(true);
    if (changed) rig.setView(rig.view, shore, hour?.tide ?? 0, false);
    sky.renderEnv(renderer, scene, 1, true);
    setLoading(null);
  } catch (err) {
    if (abort.signal.aborted) return;
    setLoading(null);
    toast(`Couldn't load the forecast: ${(err as Error).message}`, 'error');
  }
}

function applyShore(): void {
  sand.build(shore);
  water.setShore(shore);
}

// Refresh live data every 30 minutes (the model updates hourly).
setInterval(() => live && loadBeach(beach, { quiet: true }), 30 * 60_000);

// ——— Conditions → sea ———

let lastSeaUpdate = -Infinity;
/** Dev only: fields forced onto every sampled hour (e.g. { cloud: 0 }). */
const debugOverride: Partial<Hour> = {};

/** Re-reads the conditions at the playhead and retargets the waves. */
function updateConditions(snap = false): void {
  if (!forecast) return;
  hour = { ...sample(forecast, playhead), ...debugOverride };
  look = lookAt(hour, beach.lat, beach.lon);
  windSeaFallback = hour.wind ? null : windSeaFromWind(hour.windSpeed, hour.windDir);
  field.setTarget(buildWaves({ wind: hour.wind ?? windSeaFallback, swell: hour.swell, secondary: hour.secondary }), snap);

  const ripples = buildRipples(hour.windSpeed, hour.windDir);
  ripples.forEach((r, i) => ripplesTarget.set([r.dirX, r.dirZ, r.k, r.slope], i * 4));
  if (!ripplesReady || snap) {
    ripplesNow.set(ripplesTarget);
    ripples.forEach((r, i) => (ripplePhase[i] = r.phase0));
    ripplesReady = true;
  }
}

/** Where a surfer waits: just outside the outermost breakers. */
function surferSpot(): { x: number; z: number } {
  const hs = Math.max(field.hs, 0.3);
  const tide = hour?.tide ?? 0;
  let d = 30;
  while (d < 800 && (0.78 * (tide - bedHeight(shore.deanA, d, 12))) / hs < 1.9) d += 5;
  return fromShore(shore, d + 15, 12);
}

function buoySpot(): { x: number; z: number } {
  const s = surferSpot();
  const { d } = toShore(shore, s.x, s.z);
  return fromShore(shore, Math.max(d + 45, 130), -40);
}

const scaleAt = (x0: number, z0: number) => {
  const { d, u } = toShore(shore, x0, z0);
  return depthFactor((hour?.tide ?? 0) - bedHeight(shore.deanA, d, u), field.hs);
};

// ——— Metering the sky: fog colour and exposure ———

const halfPixel = new Uint16Array(4);
const fogColor = new THREE.Color(0x9fb4c4);
/** Luminance of the sky straight up (sky units), for auto exposure. */
let zenithLum = 1;

function readPixel(face: number, x: number, y: number): [number, number, number] {
  renderer.readRenderTargetPixels(sky.envTarget, x, y, 1, 1, halfPixel, face);
  return [0, 1, 2].map((i) => THREE.DataUtils.fromHalfFloat(halfPixel[i])) as [number, number, number];
}

/**
 * Reads the cube map: the four side faces just above the horizon (row 0 is the top of a face)
 * for the fog colour, and the zenith for exposure.
 */
function meterSky(): void {
  try {
    const row = ENV_SIZE / 2 - 3;
    const c = [0, 0, 0];
    for (const face of [0, 1, 4, 5]) readPixel(face, ENV_SIZE / 2, row).forEach((v, i) => (c[i] += v / 4));
    fogColor.setRGB(c[0], c[1], c[2], THREE.LinearSRGBColorSpace);
    const z = readPixel(2, ENV_SIZE / 2, ENV_SIZE / 2);
    zenithLum = 0.2126 * z[0] + 0.7152 * z[1] + 0.0722 * z[2];
  } catch {
    // Half-float read-back unsupported: keep the defaults.
  }
}

/**
 * Auto exposure, like an eye or a camera adapting: aim the scene's key brightness (the sky
 * overhead plus the direct sun or moon on a horizontal surface) at a target, within limits, so
 * noon isn't blown out and a night is dim but readable. Night is keyed lower than day, as film
 * does: a moonlit beach should look like night, not like a grey afternoon.
 */
function targetExposure(l: Look): number {
  const sunLum = (0.2126 * l.sunColor[0] + 0.7152 * l.sunColor[1] + 0.0722 * l.sunColor[2]) * Math.max(0, l.sunDir[1]);
  const moonLum = 0.7152 * l.moonColor[1] * Math.max(0, l.moonDir[1]);
  const key = zenithLum * 0.6 + ((sunLum + moonLum) / Math.PI) * 0.5;
  const target = 0.32 + (0.12 - 0.32) * l.night;
  return Math.min(10, Math.max(0.08, target / Math.max(key, 1e-4)));
}

// ——— Frame ———

const tmpSun = new THREE.Vector3();
const tmpMoon = new THREE.Vector3();
const sunColor = new THREE.Vector3();
const moonColor = new THREE.Vector3();
const nightSky = new THREE.Color();
const rainColor = new THREE.Color();
let frames = 0;
let hudTimer = 0;
let eventsCache = { at: 0, rise: null as number | null, set: null as number | null };
let exposure = 0.3;
let buoySample: Sample | null = null;

function step(dt: number): void {
  simTime += dt;
  frames++;
  const now = Date.now();
  if (forecast) {
    const end = forecast.hours[forecast.hours.length - 1].t;
    if (live) playhead = now;
    else if (playing) {
      playhead += dt * 1.5 * 3_600_000; // 1.5 forecast hours per second
      if (playhead >= end) {
        playhead = end;
        setPlaying(false);
      }
    }
    lastSeaUpdate += dt;
    if (lastSeaUpdate > (playing ? 0.1 : 1)) {
      lastSeaUpdate = 0;
      updateConditions();
    }
  }

  field.update(dt);
  if (hour && look) {
    // Ripples: ease toward the wind, advance with the capillary–gravity dispersion ω² = gk + (σ/ρ)k³.
    const t = 1 - Math.exp(-dt * 1.5);
    for (let i = 0; i < RIPPLES * 4; i++) ripplesNow[i] += (ripplesTarget[i] - ripplesNow[i]) * t;
    for (let i = 0; i < RIPPLES; i++) {
      const k = ripplesNow[i * 4 + 2];
      ripplePhase[i] = (ripplePhase[i] + Math.sqrt(G * k + 7.28e-5 * k ** 3) * dt) % (Math.PI * 2);
    }
    water.setRipples(ripplesNow, ripplePhase);

    // Lightning, every few seconds during thunderstorms.
    if (look.thunder && simTime > nextFlash) {
      flash = 1.4 + Math.random() * 1.6;
      nextFlash = simTime + 3 + Math.random() * 9;
    }
    flash *= Math.exp(-dt * (flash > 0.8 ? 9 : 4));

    tmpSun.fromArray(look.sunDir);
    tmpMoon.fromArray(look.moonDir);
    sunColor.fromArray(look.sunColor);
    moonColor.fromArray(look.moonColor);
    nightSky.setRGB(...look.nightSky);
    const [wx, wz] = bearingToVec(hour.windDir + 180);

    sky.update(
      {
        sunDir: tmpSun,
        moonDir: tmpMoon,
        moonBrightness: look.moonBrightness,
        turbidity: look.turbidity,
        rayleigh: look.rayleigh,
        mieCoefficient: look.mieCoefficient,
        cloudCoverage: look.cloudCoverage,
        cloudRain: look.cloudRain,
        nightSky,
        stars: look.stars,
        flash: flash * 0.08,
      },
      simTime,
      dt,
      wx * hour.windSpeed * 3,
      wz * hour.windSpeed * 3,
    );
    sky.setStarRotation(beach.lat, gmst(playhead) + beach.lon);

    const tide = hour.tide ?? 0;
    // Foam drifts with the wind, and a little with the current.
    water.update(camera, {
      time: simTime,
      tide,
      sunDir: tmpSun,
      sunColor: sunColor.clone().addScalar(flash * 2),
      moonDir: tmpMoon,
      moonColor,
      fogDensity: look.fogDensity,
      whitecaps: look.whitecaps,
      rain: look.cloudRain,
      night: look.night,
      flowX: wx * Math.min(hour.windSpeed, 10) * 0.03,
      flowZ: wz * Math.min(hour.windSpeed, 10) * 0.03,
    });
    // Run-up on the sand scales with wave height (~ Hs on a gentle beach).
    sand.update(tide, 0.25 + field.hs * 0.9, look.night);

    const sunMax = Math.max(...look.sunColor, 1e-6);
    sunLight.color.setRGB(look.sunColor[0] / sunMax, look.sunColor[1] / sunMax, look.sunColor[2] / sunMax, THREE.LinearSRGBColorSpace);
    sunLight.intensity = sunMax + flash * 2;
    sunLight.position.copy(tmpSun).multiplyScalar(100);
    const moonMax = Math.max(...look.moonColor, 1e-6);
    moonLight.color.setRGB(look.moonColor[0] / moonMax, look.moonColor[1] / moonMax, look.moonColor[2] / moonMax, THREE.LinearSRGBColorSpace);
    moonLight.intensity = moonMax;
    moonLight.position.copy(tmpMoon).multiplyScalar(100);

    exposure += (targetExposure(look) - exposure) * (1 - Math.exp(-dt * (playing ? 4 : 1.5)));
    renderer.toneMappingExposure = exposure;
    const fog = scene.fog as THREE.FogExp2;
    fog.density = look.fogDensity;
    if (frames % 20 === 1) meterSky();
    fog.color.copy(fogColor);

    const light = (look.sunColor[1] + look.moonColor[1]) * 0.012 + 0.03;
    rainColor.setRGB(light * 0.9, light, light * 1.1);
    rain.update(camera, simTime, hour.precip, wx * hour.windSpeed * 0.6, wz * hour.windSpeed * 0.6, rainColor);

    const bs = buoySpot();
    buoySample = surfaceAt(field, bs.x, bs.z, scaleAt);
    buoy.update(buoySample, tide, dt, simTime, look.night);
  }

  let floatAt: { x: number; y: number; z: number; up: THREE.Vector3 } | null = null;
  if (rig.view === 'surfer') {
    const s = surferSpot();
    const sm = surfaceAt(field, s.x, s.z, scaleAt);
    floatAt = { x: s.x, y: sm.y + (hour?.tide ?? 0), z: s.z, up: new THREE.Vector3(sm.nx, sm.ny, sm.nz) };
  } else if (rig.view === 'buoy' && buoySample) {
    const p = buoy.group.position;
    floatAt = { x: p.x, y: p.y, z: p.z, up: new THREE.Vector3(0, 1, 0).applyQuaternion(buoy.group.quaternion) };
  }
  rig.update(dt, floatAt, (x, z) => groundHeight(shore, hour?.tide ?? 0, x, z));
  camera.near = rig.floating ? 0.1 : 0.3;
  camera.updateProjectionMatrix();

  // Every frame during a lightning flash, so the reflection flashes with the sky.
  sky.renderEnv(renderer, scene, flash > 0.05 ? 1 : playing ? 3 : 8);
  renderer.render(scene, camera);

  const r = quality.update(dt);
  if (r) renderer.setPixelRatio(r);

  hudTimer -= dt;
  if (hudTimer <= 0 && hour && look && forecast) {
    hudTimer = 0.25;
    if (Math.abs(playhead - eventsCache.at) > 600_000) {
      const ev = sunEvents(playhead, beach.lat, beach.lon);
      eventsCache = { at: playhead, ...ev };
    }
    renderHud({
      hour,
      look,
      live,
      offset: playhead - now,
      utcOffset: forecast.utcOffset,
      facing: shore.facing,
      tideTrend: tideTrend(forecast, playhead),
      sunrise: eventsCache.rise,
      sunset: eventsCache.set,
      windSeaFromWind: windSeaFallback,
      simulatedWaves: field.count,
    });
    timeline.set(playhead, now);
    $('tl-label').textContent = live ? 'Now' : new Date(playhead + forecast.utcOffset * 1000).toLocaleString(undefined, { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
}

let last = performance.now();
function loop(t: number): void {
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  step(dt);
  requestAnimationFrame(loop);
}

// ——— Timeline & time controls ———

const timeline = new Timeline($<HTMLCanvasElement>('timeline'), {
  onScrub: (t) => {
    setPlaying(false);
    playhead = t;
    setLive(Math.abs(t - Date.now()) < 60_000);
    updateConditions();
  },
  onLive: () => goLive(),
});

function setLive(on: boolean): void {
  live = on;
  $('live').classList.toggle('active', on);
}

function goLive(): void {
  setPlaying(false);
  setLive(true);
  playhead = Date.now();
  updateConditions();
}

function setPlaying(on: boolean): void {
  playing = on;
  $('play').textContent = on ? '❚❚' : '▶';
  $('play').classList.toggle('active', on);
  if (on) {
    setLive(false);
    if (forecast && playhead >= forecast.hours[forecast.hours.length - 1].t - 3_600_000) playhead = forecast.hours[0].t;
  }
}

$('live').addEventListener('click', goLive);
$('play').addEventListener('click', () => setPlaying(!playing));

// ——— Views ———

function setView(view: View): void {
  rig.setView(view, shore, hour?.tide ?? 0);
  document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
}
document.querySelectorAll<HTMLButtonElement>('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view as View)));

// ——— Place panel ———

const select = $<HTMLSelectElement>('beach-select');
const facing = $<HTMLInputElement>('facing');

function syncPlaceUi(): void {
  const groups = ['Brasil', 'World'] as const;
  const custom = beach.group === 'Search' ? `<optgroup label="Search"><option value="${beach.id}">${beach.name}</option></optgroup>` : '';
  select.innerHTML =
    custom +
    groups
      .map((g) => `<optgroup label="${g}">${BEACHES.filter((b) => b.group === g).map((b) => `<option value="${b.id}">${b.name} — ${b.region}</option>`).join('')}</optgroup>`)
      .join('');
  select.value = beach.id;
  facing.value = String(Math.round(shore.facing));
  $('facing-label').textContent = `${Math.round(shore.facing)}° ${compassPoint(shore.facing)}`;
}

select.addEventListener('change', () => {
  const b = BEACHES.find((x) => x.id === select.value);
  if (b) loadBeach(b);
});

let shoreQueued = false;
facing.addEventListener('input', () => {
  shore = { ...shore, facing: Number(facing.value) };
  beach = { ...beach, facing: shore.facing };
  $('facing-label').textContent = `${shore.facing}° ${compassPoint(shore.facing)}`;
  if (shoreQueued) return;
  shoreQueued = true;
  requestAnimationFrame(() => {
    shoreQueued = false;
    applyShore();
    if (!rig.floating) rig.setView(rig.view, shore, hour?.tide ?? 0, false);
  });
});
facing.addEventListener('change', () => {
  // Presets keep their id in the URL; a re-aimed preset is shared as coordinates.
  const custom: BeachInfo = { ...beach, group: 'Search', id: `@${beach.lat},${beach.lon}` };
  history.replaceState(null, '', beachToHash(custom));
});

const results = $<HTMLUListElement>('results');
const status = $('search-status');
let searchAbort: AbortController | null = null;

$('search-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $<HTMLInputElement>('search').value.trim();
  if (q.length < 2) return;
  searchAbort?.abort();
  const abort = (searchAbort = new AbortController());
  status.textContent = 'Searching…';
  results.innerHTML = '';
  try {
    const places = await searchPlaces(q, navigator.language.slice(0, 2), abort.signal);
    status.textContent = places.length ? '' : 'No places found.';
    results.innerHTML = '';
    for (const p of places) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.innerHTML = `${p.name}<small>${p.region}</small>`;
      btn.addEventListener('click', () => choosePlace(p));
      li.append(btn);
      results.append(li);
    }
  } catch (err) {
    if (!abort.signal.aborted) status.textContent = `Search failed: ${(err as Error).message}`;
  }
});

async function choosePlace(p: Place): Promise<void> {
  results.innerHTML = '';
  status.textContent = 'Reading the coastline…';
  let estimate: number | null = null;
  try {
    estimate = await probeFacing(p.lat, p.lon);
  } catch {
    // Rate limited or offline: fall back to the swell direction.
  }
  status.textContent = estimate == null ? '' : `Coast faces ≈ ${Math.round(estimate)}° ${compassPoint(estimate)}`;
  const next: BeachInfo = {
    id: `@${p.lat.toFixed(4)},${p.lon.toFixed(4)}`,
    name: p.name,
    region: p.region,
    lat: p.lat,
    lon: p.lon,
    facing: estimate ?? 180,
    deanA: 0.1,
    group: 'Search',
  };
  await loadBeach(next, { guessFacing: estimate == null });
}

$('collapse-place').addEventListener('click', () => {
  const panel = $('place-panel');
  panel.classList.toggle('collapsed');
  $('collapse-place').textContent = panel.classList.contains('collapsed') ? '+' : '–';
});

window.addEventListener('hashchange', () => {
  const b = beachFromHash(location.hash);
  if (b && (b.id !== beach.id || b.facing !== beach.facing)) loadBeach(b);
});

// ——— Keyboard ———

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  const views: Record<string, View> = { '1': 'beach', '2': 'aerial', '3': 'surfer', '4': 'buoy' };
  if (views[e.key]) setView(views[e.key]);
  else if (e.key === 'l' || e.key === 'L') goLive();
  else if (e.key === ' ') {
    e.preventDefault();
    setPlaying(!playing);
  }
});

// ——— Start ———

applyShore();
syncPlaceUi();
rig.setView('beach', shore, 0, false);
loadBeach(beach);
requestAnimationFrame(loop);

if (import.meta.env.DEV) {
  // The Browser pane pauses rAF when hidden; this steps frames by hand for debugging.
  Object.assign(window, { __dbg: { tick: (dt = 1 / 60, n = 1) => { for (let i = 0; i < n; i++) step(dt); }, field, look: () => look, hour: () => hour, rig, camera, setView, override: debugOverride, renderer, sky, scene, water, env: () => { const px = new Uint16Array(4); const out: Record<string, number[]> = {}; [['top', 2, ENV_SIZE / 2], ['horizon+X', 0, ENV_SIZE / 2 + 2], ['horizon-Z', 5, ENV_SIZE / 2 + 2]].forEach(([n, f, y]) => { renderer.readRenderTargetPixels(sky.envTarget, ENV_SIZE / 2, y as number, 1, 1, px, f as number); out[n as string] = [...px].slice(0, 3).map((v) => +THREE.DataUtils.fromHalfFloat(v).toFixed(3)); }); return out; }, setTime: (t: number) => { setLive(false); playhead = t; updateConditions(true); } } });
}
