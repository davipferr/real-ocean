# Real Ocean

The sea at a real beach, right now. Wave, tide and weather data from [Open-Meteo](https://open-meteo.com) become a 3D sea in Three.js: the real swell from the right direction with the right period, the tide moving the waterline up and down the sand, and the sky, sun, moon, clouds, rain and fog of that place and hour.

TypeScript + Vite + Three.js, no backend: every API is free, keyless and CORS-enabled, so it runs as a static site on GitHub Pages.

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # vitest
npm run build    # type-checks, then builds to dist/
```

## What you can do

- Pick one of 19 preset beaches (Praia Mole, Copacabana, Noronha, Nazaré, Pipeline, Teahupo'o…) or **search any coastal place**. For a searched place, the orientation of the coast is estimated from elevation data, and you can correct it with the slider.
- Scrub the **8-day timeline** (yesterday plus 7 days of forecast), or play it as a time-lapse. The chart shows wave height, primary swell, tide and night.
- Four views: **Beach** (standing on the sand), **Aerial**, **Surfer** (floating just outside the break), **Buoy** (riding a marker buoy). Keys `1`–`4`, `Space` play/pause, `L` back to live.
- Open **Wave physics** in the conditions panel to see wavelength, crest and energy speed, breaking depth and wave power, worked out from the live numbers.
- Links are shareable: `#praia-mole`, or `#@lat,lon,facing,name` for any place.

## How it works

### From sea states to waves (`src/ocean/spectrum.ts`)

A wave model doesn't describe individual waves; it describes the sea statistically, per *system*: the local **wind sea**, the **primary swell** and a **secondary swell**. Each has a significant height Hs, a mean period T and a direction. Each system is expanded into several sinusoids (24 in total) sampled from a **JONSWAP spectrum** (broad for wind seas, narrow for swell) and spread in direction. Their amplitudes are chosen so the energy matches the reported height exactly:

```
Hs = 4·√m₀,  m₀ = Σ aᵢ²/2      (heights of separate systems add in quadrature)
```

For Praia Mole, a 0.63 m swell plus a 0.12 m secondary swell gives 0.64 m, which is exactly the model's `wave_height`. Wavelengths come from deep-water dispersion, ω² = g·k, so a 10 s swell is 156 m long and its crests travel at 56 km/h.

### Gerstner waves (`src/ocean/gerstner.ts`, `src/scene/water.ts`)

Each surface point moves in a circle instead of just up and down. This sharpens the crests and flattens the troughs. Steepness is scaled down only when Σ Q·k·a would exceed 1, the point where crests start to fold into loops. The phase is **accumulated** (φ += ω·dt), so a change in period never makes the sea jump. The same maths runs on the CPU, so the buoy and the surfer camera float on exactly the surface the GPU draws.

The mesh is a radial grid centred on the camera, with fine rings nearby and coarse ones at the horizon. Waves shorter than about 8 grid cells are faded out so they don't alias into shimmer.

### Shading

- **Wind ripples** only bend normals. Their strength follows the Cox–Munk slope statistics (mean-square slope ≈ 0.003 + 0.00512·U), so calm days turn the sea to glass. Ripples smaller than a pixel become roughness instead of sparkles.
- **Fresnel reflection** of a sky cube map that is re-rendered as the sky changes. A rough sea at grazing angles reflects higher (bluer) sky than a mirror would.
- **GGX glitter** from the sun and the moon.
- **Water colour**: light scattered back from the depths, plus the seabed seen through shallow water with Beer–Lambert absorption. Water absorbs red first, which is why it looks turquoise over sand and navy over deep water. Backlit wave crests glow green.
- **Foam** from three sources: whitecaps where the surface is compressed (the Jacobian of the Gerstner mapping drops below 1), breakers in the surf zone, and the swash line where the water meets the sand.
- **Fog** using Koschmieder's law (extinction = 3.912 / visibility) toward the sky's own horizon colour.

### The beach (`src/ocean/shore.ts`, `src/scene/beach.ts`)

Underwater the seabed follows **Dean's equilibrium profile** h = A·d^⅔, the shape sandy beaches settle into, with a sandbar where the big waves break first. Waves are capped by depth (they break at H ≈ 0.78·h). The sea level is Open-Meteo's `sea_level_height_msl`, so the real **tide** moves the waterline and the wet-sand band.

### Sky (`src/scene/sky.ts`, `src/astro/sky.ts`)

The sky is a fork of three's Preetham `Sky` shader, extended with:
- stars that rotate with the real sidereal time;
- a moon whose phase is shaded per pixel from the actual sun direction;
- overcast decks using the CIE overcast sky model (zenith three times brighter than the horizon);
- rain darkening and lightning during thunderstorms.

Sun and moon positions come from low-precision Almanac/Meeus formulas: sunrise is within a few minutes and the moon within about 0.3°. Exposure adapts like an eye, metered from the sky map. Night vision is desaturated toward blue (the Purkinje shift). Moonlight is scaled up to stay visible, the way films shoot "day for night".

## Data notes (found by calling the APIs, Oct 2026)

- **Marine** (`marine-api.open-meteo.com`):
  - `*_peak_period` fields come back null; only mean periods are populated.
  - "No wind sea" is reported as noise, e.g. 0.02 m at 0.4 s. Such values are discarded, and a wind sea is grown from the local wind instead, using the fetch-limited JONSWAP growth law.
  - A point near the coast snaps to the nearest sea cell (up to ~15 km away); far inland, everything is null.
- **Elevation** (`api.open-meteo.com/v1/elevation`): each coordinate counts against the free per-minute quota, so the coast probe uses 37 points.
- **Geocoding** (`geocoding-api.open-meteo.com`): returns places, not beaches. The coastline estimate (land centroid → sea centroid) is good on straight coasts, but headlands and bays pull it off. It gives 196° for Mavericks, whose break faces west.

Open-Meteo is free for non-commercial use. Weather data by Open-Meteo.com (CC BY 4.0).

## Debugging

In dev builds, `window.__dbg` exposes:
- `tick(dt, n)` to step frames by hand (useful when the tab is hidden and requestAnimationFrame is paused);
- `setTime(utcMs)` to jump to any moment;
- `override` to force fields, e.g. `{ cloud: 1, precip: 3 }`;
- `env()` to read the sky map's radiance;
- `water.mesh.material.uniforms.uDebug` to show individual water terms (1 body, 2 reflection, 3 foam, 4 normals, 5 fog).
