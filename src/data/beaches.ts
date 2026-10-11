/**
 * Where to stand. Presets are hand-picked beaches with their seaward bearing; anything else comes
 * from the Open-Meteo geocoder, with the orientation estimated from the coastline.
 */

export interface Beach {
  id: string;
  name: string;
  region: string;
  /** A point on the sand. */
  lat: number;
  lon: number;
  /** Seaward bearing (degrees): the way you face looking out to sea. */
  facing: number;
  /** Dean profile parameter (m^⅓): smaller = finer sand, gentler slope, wider surf zone. */
  deanA: number;
  group: 'Brasil' | 'World' | 'Search';
}

const b = (id: string, name: string, region: string, lat: number, lon: number, facing: number, deanA: number, group: Beach['group']): Beach => ({
  id,
  name,
  region,
  lat,
  lon,
  facing,
  deanA,
  group,
});

// Facings set by hand, cross-checked against `estimateFacing`. The estimate is good on straight
// coasts but headlands and bays pull it off (it says 196° for Mavericks, whose break faces west).
export const BEACHES: Beach[] = [
  b('praia-mole', 'Praia Mole', 'Florianópolis, SC', -27.604, -48.433, 100, 0.12, 'Brasil'),
  b('joaquina', 'Joaquina', 'Florianópolis, SC', -27.629, -48.449, 125, 0.11, 'Brasil'),
  b('copacabana', 'Copacabana', 'Rio de Janeiro, RJ', -22.9715, -43.184, 140, 0.1, 'Brasil'),
  b('ipanema', 'Ipanema', 'Rio de Janeiro, RJ', -22.987, -43.205, 178, 0.1, 'Brasil'),
  b('saquarema', 'Itaúna', 'Saquarema, RJ', -22.936, -42.488, 170, 0.13, 'Brasil'),
  b('maresias', 'Maresias', 'São Sebastião, SP', -23.793, -45.56, 190, 0.13, 'Brasil'),
  b('itacare', 'Tiririca', 'Itacaré, BA', -14.29, -38.989, 85, 0.12, 'Brasil'),
  b('porto-de-galinhas', 'Porto de Galinhas', 'Ipojuca, PE', -8.505, -35.0, 85, 0.08, 'Brasil'),
  b('noronha', 'Cacimba do Padre', 'Fernando de Noronha, PE', -3.845, -32.437, 328, 0.12, 'Brasil'),
  b('jericoacoara', 'Jericoacoara', 'Jijoca, CE', -2.794, -40.513, 345, 0.07, 'Brasil'),
  b('nazare', 'Praia do Norte', 'Nazaré, Portugal', 39.607, -9.085, 275, 0.14, 'World'),
  b('hossegor', 'La Gravière', 'Hossegor, France', 43.666, -1.445, 278, 0.13, 'World'),
  b('pipeline', 'Pipeline', "O'ahu, Hawai'i", 21.665, -158.053, 320, 0.14, 'World'),
  b('waikiki', 'Waikīkī', "O'ahu, Hawai'i", 21.276, -157.827, 200, 0.09, 'World'),
  b('mavericks', 'Mavericks', 'California, USA', 37.493, -122.499, 265, 0.12, 'World'),
  b('bondi', 'Bondi', 'Sydney, Australia', -33.891, 151.277, 115, 0.11, 'World'),
  b('jbay', 'Supertubes', 'Jeffreys Bay, South Africa', -34.031, 24.931, 105, 0.12, 'World'),
  b('uluwatu', 'Uluwatu', 'Bali, Indonesia', -8.815, 115.086, 255, 0.14, 'World'),
  b('teahupoo', "Teahupo'o", 'Tahiti, French Polynesia', -17.847, -149.267, 205, 0.14, 'World'),
];

export const DEFAULT_BEACH = BEACHES[0];

// ——— Search ———

export interface Place {
  name: string;
  region: string;
  lat: number;
  lon: number;
}

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

export function geocodeUrl(query: string, language = 'en'): string {
  return `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=8&language=${language}&format=json`;
}

export async function searchPlaces(query: string, language = 'en', signal?: AbortSignal): Promise<Place[]> {
  const res = await fetch(geocodeUrl(query, language), { signal });
  if (!res.ok) throw new Error(`Geocoder answered ${res.status}`);
  const body = (await res.json()) as { results?: GeoResult[] };
  return (body.results ?? []).map((r) => ({
    name: r.name,
    region: [r.admin1, r.country].filter(Boolean).join(', '),
    lat: r.latitude,
    lon: r.longitude,
  }));
}

// ——— Which way does the coast face? ———

/** Probe grid: GRID×GRID points within RADIUS metres (the corners, outside the disc, are skipped). */
export const PROBE_GRID = 7;
export const PROBE_RADIUS = 2500;

export interface Probe {
  lat: number;
  lon: number;
  /** Offset from the beach, metres east and north. */
  east: number;
  north: number;
}

/**
 * Elevation probes around a point. 37 points: the elevation API takes up to 100 per request, but
 * Open-Meteo counts each point against the free per-minute quota, so the grid stays small.
 */
export function probePoints(lat: number, lon: number): Probe[] {
  const out: Probe[] = [];
  const n = PROBE_GRID;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const east = ((i / (n - 1)) * 2 - 1) * PROBE_RADIUS;
      const north = ((j / (n - 1)) * 2 - 1) * PROBE_RADIUS;
      const r = Math.hypot(east, north);
      if (r > PROBE_RADIUS * 1.001 || r < 1) continue;
      out.push({ lat: lat + north / 111_320, lon: lon + east / 111_320 / Math.cos((lat * Math.PI) / 180), east, north });
    }
  }
  return out;
}

/**
 * Seaward bearing from probe elevations: the direction from the centroid of the land probes to the
 * centroid of the sea probes (elevation ≤ 0 in the Copernicus DEM), each weighted by 1/distance so
 * the coast right at the beach counts most. Good on straight coasts; a headland or a bay nearby
 * pulls it off, which is why the facing can be adjusted by hand. Null if it is all land or all sea.
 */
export function estimateFacing(probes: Probe[], elevations: number[]): number | null {
  let sx = 0;
  let sz = 0;
  let sw = 0;
  let lx = 0;
  let lz = 0;
  let lw = 0;
  probes.forEach((p, k) => {
    const w = 1 / Math.hypot(p.east, p.north);
    if (elevations[k] <= 0) {
      sx += p.east * w;
      sz += p.north * w;
      sw += w;
    } else {
      lx += p.east * w;
      lz += p.north * w;
      lw += w;
    }
  });
  if (sw === 0 || lw === 0) return null;
  const e = sx / sw - lx / lw;
  const n = sz / sw - lz / lw;
  if (Math.hypot(e, n) < 1) return null;
  return ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
}

export async function probeFacing(lat: number, lon: number, signal?: AbortSignal): Promise<number | null> {
  const probes = probePoints(lat, lon);
  const lats = probes.map((p) => p.lat.toFixed(5)).join(',');
  const lons = probes.map((p) => p.lon.toFixed(5)).join(',');
  const res = await fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`, { signal });
  if (!res.ok) throw new Error(`Elevation API answered ${res.status}`);
  const { elevation } = (await res.json()) as { elevation: number[] };
  return estimateFacing(probes, elevation);
}

/** Great-circle distance (km). */
export function distanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

// ——— URL hash: #praia-mole or #@-27.6,-48.4,95,Name ———

export function beachToHash(beach: Beach): string {
  if (beach.group !== 'Search') return `#${beach.id}`;
  return `#@${beach.lat.toFixed(4)},${beach.lon.toFixed(4)},${Math.round(beach.facing)},${encodeURIComponent(beach.name)}`;
}

export function beachFromHash(hash: string): Beach | null {
  const h = hash.replace(/^#/, '');
  if (!h) return null;
  const preset = BEACHES.find((x) => x.id === h);
  if (preset) return preset;
  const m = /^@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)(?:,(.*))?$/.exec(h);
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = m[4] ? decodeURIComponent(m[4]) : `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
  return b(`@${lat},${lon}`, name, '', lat, lon, Number(m[3]) % 360, 0.1, 'Search');
}
