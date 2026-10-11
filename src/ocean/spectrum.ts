/**
 * From sea states (what a wave model reports) to individual waves (what a shader can draw).
 *
 * A wave model like the one behind Open-Meteo Marine describes the sea statistically, per
 * "system": the local wind sea, the primary swell and a secondary swell, each with a significant
 * height Hs, a mean period T and a mean direction. Real water is the sum of many waves of nearby
 * frequencies and directions, so each system is expanded into a handful of sinusoids sampled from
 * a wave spectrum, with amplitudes chosen so their total energy matches the reported height:
 *
 *   Hs = 4·√m0, where m0 (the variance of the surface) = Σ aᵢ²/2   ⇒   Σ aᵢ² = Hs²/8
 *
 * Everything here is deep-water linear theory; the shore module scales waves down in shallow water.
 */

export const G = 9.81;
const TAU = Math.PI * 2;

/** Deep-water dispersion ω² = g·k: the wavenumber (rad/m) of a wave with this period. */
export const wavenumber = (period: number) => (TAU / period) ** 2 / G;
/** Deep-water wavelength L = g·T²/2π (m). A 10 s swell is 156 m long. */
export const wavelength = (period: number) => (G * period * period) / TAU;
/** Phase speed c = g·T/2π (m/s). A 10 s swell travels at 15.6 m/s (56 km/h). */
export const phaseSpeed = (period: number) => (G * period) / TAU;

/** Compass bearing (degrees clockwise from north) → unit vector in the scene (x east, z south). */
export function bearingToVec(deg: number): [number, number] {
  const r = (deg * Math.PI) / 180;
  return [Math.sin(r), -Math.cos(r)];
}

/** Unit vector (x east, z south) → compass bearing in [0, 360). */
export function vecToBearing(x: number, z: number): number {
  return ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
}

export interface SeaState {
  /** Significant wave height (m): the mean of the highest third of the waves. */
  height: number;
  /** Mean period (s). */
  period: number;
  /** Direction the waves come FROM, compass degrees (the oceanographic convention for waves). */
  from: number;
}

export interface Systems {
  wind: SeaState | null;
  swell: SeaState | null;
  secondary: SeaState | null;
}

export type SystemKind = keyof Systems;

/**
 * How each system is expanded. Wind seas are broad (many periods, ±50°); swell that has travelled
 * hundreds of km is sorted by dispersion into long, regular, nearly parallel crests.
 */
interface SystemSpec {
  slots: number;
  /** Half-width of the directional spread (degrees). */
  spread: number;
  /** Peak period / mean period. For a Pierson–Moskowitz spectrum Tm01 ≈ 0.77·Tp. */
  peakRatio: number;
  /** Sampled frequency range, as multiples of the peak frequency. */
  band: [number, number];
  /** JONSWAP peak enhancement: 1 = Pierson–Moskowitz (fully developed), 3.3 = young sea, 7 = swell. */
  gamma: number;
}

export const SPECS: Record<SystemKind, SystemSpec> = {
  wind: { slots: 12, spread: 55, peakRatio: 1.3, band: [0.75, 2.4], gamma: 3.3 },
  swell: { slots: 8, spread: 14, peakRatio: 1.1, band: [0.85, 1.45], gamma: 7 },
  secondary: { slots: 4, spread: 12, peakRatio: 1.1, band: [0.88, 1.35], gamma: 7 },
};

export const KINDS: SystemKind[] = ['wind', 'swell', 'secondary'];
export const MAX_WAVES = KINDS.reduce((n, k) => n + SPECS[k].slots, 0);

/** One Gerstner wave. Slots keep their index across updates, so changes can be tweened per slot. */
export interface Wave {
  kind: SystemKind;
  /** Propagation direction (unit, scene x/z). */
  dirX: number;
  dirZ: number;
  /** Wavenumber 2π/L (rad/m). */
  k: number;
  /** Amplitude (m): half the crest-to-trough height. */
  amp: number;
  /** Starting phase (rad), random but fixed per slot. */
  phase0: number;
}

/** JONSWAP spectral density shape S(ω) (unnormalised; only relative weights matter here). */
export function jonswap(omega: number, peak: number, gamma: number): number {
  const sigma = omega <= peak ? 0.07 : 0.09;
  const r = Math.exp(-((omega - peak) ** 2) / (2 * sigma * sigma * peak * peak));
  return omega ** -5 * Math.exp(-1.25 * (peak / omega) ** 4) * gamma ** r;
}

/** Small deterministic PRNG (mulberry32), so the same sea state always draws the same sea. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Expands one system into `spec.slots` waves (amp 0 when the system is absent). */
export function expandSystem(kind: SystemKind, state: SeaState | null, seed = 1): Wave[] {
  const spec = SPECS[kind];
  const rand = rng(seed * 7919 + KINDS.indexOf(kind) * 104729);
  const n = spec.slots;

  // Fixed per-slot randomness, drawn before anything depends on the state, so a slot keeps its
  // jitter and phase however the state changes.
  const jitter = Array.from({ length: n }, () => rand() - 0.5);
  const phase = Array.from({ length: n }, () => rand() * TAU);
  // Directions are stratified across the spread, then shuffled so neighbouring frequencies don't
  // also share neighbouring directions (that would make the sea look combed).
  const dirSlots = Array.from({ length: n }, (_, i) => -0.9 + (1.8 * (i + 0.5)) / n);
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [dirSlots[i], dirSlots[j]] = [dirSlots[j], dirSlots[i]];
  }

  const valid = state && state.height > 0.01 && state.period > 0;
  const period = valid ? state.period : 8;
  const peak = TAU / (period * spec.peakRatio);
  const towards = ((valid ? state.from : 0) + 180) % 360;

  // Geometric frequency bins across the band; each wave sits inside its bin with a little jitter.
  const [lo, hi] = spec.band;
  const ratio = (hi / lo) ** (1 / n);
  const waves: Wave[] = [];
  const weights: number[] = [];
  for (let i = 0; i < n; i++) {
    const w0 = peak * lo * ratio ** i;
    const w1 = w0 * ratio;
    const omega = w0 * ratio ** (0.5 + jitter[i] * 0.6);
    const d = dirSlots[i];
    const bearing = towards + d * spec.spread;
    const [dirX, dirZ] = bearingToVec(bearing);
    // Energy in this bin: spectrum × bin width × directional spreading (cos², 0 at the edges).
    weights.push(jonswap(omega, peak, spec.gamma) * (w1 - w0) * Math.cos((d * Math.PI) / 2) ** 2);
    waves.push({ kind, dirX, dirZ, k: (omega * omega) / G, amp: 0, phase0: phase[i] });
  }

  if (valid) {
    const total = weights.reduce((a, b) => a + b, 0);
    // Σ aᵢ²/2 = (Hs/4)²  ⇒  aᵢ = (Hs/4)·√(2·wᵢ/Σw)
    for (let i = 0; i < n; i++) waves[i].amp = (state.height / 4) * Math.sqrt((2 * weights[i]) / total);
  }
  return waves;
}

/** All systems, in slot order: wind sea, swell, secondary swell. */
export function buildWaves(systems: Systems, seed = 1): Wave[] {
  return KINDS.flatMap((k) => expandSystem(k, systems[k], seed));
}

/** Significant height implied by a set of waves: 4·√(Σa²/2). */
export function significantHeight(waves: { amp: number }[]): number {
  return 4 * Math.sqrt(waves.reduce((s, w) => s + (w.amp * w.amp) / 2, 0));
}

/**
 * Gerstner steepness. With Q = 1 every wave is a true trochoid (water particles move in circles
 * of radius a). The crests pinch into loops once Σ Q·k·a > 1, so when the waves are steep enough
 * to get there, Q is scaled down uniformly to keep the sum at `limit`.
 */
export function steepness(waves: { k: number; amp: number }[], limit = 0.85): number {
  const sum = waves.reduce((s, w) => s + w.k * w.amp, 0);
  return sum > limit ? limit / sum : 1;
}

/**
 * A wind sea grown from the local wind, for when the model's wind-sea fields are missing or are
 * noise (Open-Meteo reports e.g. 0.02 m at 0.4 s in calm weather). Takes the smaller of a fully
 * developed Pierson–Moskowitz sea and a JONSWAP fetch-limited one: near a coast the wind rarely
 * has more than a few tens of km of open water to build waves over.
 */
export function windSeaFromWind(speed: number, from: number, fetch = 30_000): SeaState | null {
  if (speed < 1) return null;
  // Fully developed (Pierson–Moskowitz, wind at 19.5 m ≈ 1.07·U10)
  const u = speed * 1.07;
  const hsPM = (0.21 * u * u) / G;
  const tpPM = (TAU * u) / (0.877 * G);
  // Fetch-limited (JONSWAP)
  const x = (G * fetch) / (speed * speed);
  const hsF = (0.0016 * Math.sqrt(x) * speed * speed) / G;
  const tpF = (0.286 * Math.cbrt(x) * speed * TAU) / G;
  const hs = Math.min(hsPM, hsF);
  const tp = Math.min(tpPM, tpF);
  if (hs < 0.02) return null;
  return { height: hs, period: tp / SPECS.wind.peakRatio, from };
}

/** Reads a model sea state, discarding the noise values reported for "no such system". */
export function cleanState(height: number | null, period: number | null, from: number | null): SeaState | null {
  if (height == null || period == null || from == null) return null;
  if (!(height > 0.03) || !(period >= 1.5)) return null;
  return { height, period: Math.min(period, 25), from };
}

/**
 * The fine ripples that only perturb shading (never geometry): capillary and short gravity waves
 * raised by the local wind. Without wind they vanish and the sea turns to glass.
 */
export interface Ripple {
  dirX: number;
  dirZ: number;
  k: number;
  /** Peak slope k·a. */
  slope: number;
  phase0: number;
}

export const RIPPLES = 16;

export function buildRipples(windSpeed: number, windFrom: number, seed = 3): Ripple[] {
  const rand = rng(seed);
  const towards = windFrom + 180;
  // Slope grows with wind, then saturates (Cox–Munk: mean-square slope ≈ 0.003 + 0.00512·U).
  const mss = 0.003 + 0.00512 * Math.min(windSpeed, 20);
  const out: Ripple[] = [];
  for (let i = 0; i < RIPPLES; i++) {
    const L = 0.12 * (40 / 0.12) ** (i / (RIPPLES - 1)); // 12 cm … 40 m
    const spread = 70 * (1 - i / RIPPLES) + 20; // the shortest ripples point every which way
    const [dirX, dirZ] = bearingToVec(towards + (rand() * 2 - 1) * spread);
    out.push({ dirX, dirZ, k: TAU / L, slope: Math.sqrt((2 * mss) / RIPPLES), phase0: rand() * TAU });
  }
  return out;
}
