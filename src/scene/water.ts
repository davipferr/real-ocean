/**
 * The sea surface: a camera-centred radial grid displaced by the Gerstner waves in the vertex
 * shader, shaded in the fragment shader with:
 *
 * - wind ripples that only bend normals (filtered per pixel so they never sparkle into noise);
 * - Fresnel reflection of the sky cube map, blurred by the roughness the filtered detail left;
 * - GGX glitter from the sun and the moon;
 * - light scattered back out of the water, and in shallow water the seabed seen through it with
 *   Beer–Lambert absorption (water eats red first: hence turquoise over sand, navy over depth);
 * - backlit crests (light passing through thin wave tops);
 * - foam from three sources: whitecaps where the surface is compressed (Jacobian < 1), breakers in
 *   the surf zone, and the swash line where the water meets the sand;
 * - fog toward the sky's own horizon colour, with density from the reported visibility.
 */

import * as THREE from 'three';

import { MAX_WAVES, RIPPLES } from '../ocean/spectrum';
import { BED_GLSL, type Shore } from '../ocean/shore';
import { spacingFade, type WaveField } from '../ocean/gerstner';
import { bearingToVec } from '../ocean/spectrum';

export { spacingFade };

/**
 * Rings whose radius grows geometrically from `first` metres to `outer`: fine where the camera is,
 * coarse at the horizon. Returns the geometry and the spacing law (spacing ≈ base + r·factor).
 */
export function radialGrid(rings = 220, segments = 192, first = 0.3, outer = 40_000) {
  // Solve first·(gᴺ − 1)/(g − 1) = outer for the growth factor g.
  let lo = 1.000001;
  let hi = 2;
  for (let i = 0; i < 80; i++) {
    const g = (lo + hi) / 2;
    if ((first * (g ** rings - 1)) / (g - 1) > outer) hi = g;
    else lo = g;
  }
  const g = (lo + hi) / 2;
  const positions = new Float32Array((rings + 1) * segments * 3);
  for (let i = 0; i <= rings; i++) {
    const r = i === 0 ? 0 : (first * (g ** i - 1)) / (g - 1);
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      positions.set([Math.cos(a) * r, 0, Math.sin(a) * r], (i * segments + j) * 3);
    }
  }
  const index: number[] = [];
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = i * segments + j;
      const b = i * segments + ((j + 1) % segments);
      const c = a + segments;
      const d = b + segments;
      // Counter-clockwise seen from above, so the faces point up (back faces are culled).
      index.push(a, b, c, b, d, c);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(index);
  return { geometry, base: first, factor: Math.max(g - 1, (Math.PI * 2) / segments) };
}

const vertexShader = /* glsl */ `
#define MAX_WAVES ${MAX_WAVES}
uniform vec4 uWaveA[MAX_WAVES]; // dir.x, dir.z, k, amplitude
uniform vec4 uWaveB[MAX_WAVES]; // Q, phase
uniform int uCount;
uniform float uHs;
uniform vec2 uSpacing;
uniform vec2 uSeaward;
uniform float uDeanA;
uniform float uTide;

varying vec3 vWorld;
varying vec3 vNormalW;
varying float vJac;
varying float vDepth;
varying float vLift;
varying float vSurf;

${BED_GLSL}

void main() {
  vec3 p0 = (modelMatrix * vec4(position, 1.0)).xyz;
  vec2 xz = p0.xz;
  float spacing = uSpacing.x + length(position.xz) * uSpacing.y;
  float depth = uTide - bedHeight(xz);
  float shore = depthFactor(depth, uHs);

  vec3 disp = vec3(0.0);
  float nx = 0.0, ny = 0.0, nz = 0.0, jxx = 0.0, jzz = 0.0, jxz = 0.0;
  for (int i = 0; i < MAX_WAVES; i++) {
    if (i >= uCount) break;
    vec4 a = uWaveA[i];
    vec4 b = uWaveB[i];
    float L = 6.2831853 / a.z;
    float amp = a.w * shore * smoothstep(4.0 * spacing, 8.0 * spacing, L);
    float th = a.z * dot(a.xy, xz) - b.y;
    float s = sin(th);
    float c = cos(th);
    float qa = b.x * amp;
    disp.x += qa * a.x * c;
    disp.z += qa * a.y * c;
    disp.y += amp * s;
    float wa = a.z * amp;
    nx += a.x * wa * c;
    nz += a.y * wa * c;
    ny += b.x * wa * s;
    jxx += b.x * wa * a.x * a.x * s;
    jzz += b.x * wa * a.y * a.y * s;
    jxz += b.x * wa * a.x * a.y * s;
  }

  vec3 pos = vec3(xz.x + disp.x, uTide + disp.y, xz.y + disp.z);
  vWorld = pos;
  vNormalW = normalize(vec3(-nx, 1.0 - ny, -nz));
  vJac = (1.0 - jxx) * (1.0 - jzz) - jxz * jxz;
  vDepth = depth;
  vLift = disp.y / max(uHs * 0.5 * shore, 0.03);
  vSurf = 1.0 - smoothstep(0.85, 1.5, 0.78 * depth / max(uHs, 0.05));
  gl_Position = projectionMatrix * viewMatrix * vec4(pos, 1.0);
}
`;

const fragmentShader = /* glsl */ `
#define RIPPLES ${RIPPLES}
uniform samplerCube uEnv;
uniform float uEnvMaxLod;
uniform float uEnvTexel;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uTime;
uniform vec4 uRipple[RIPPLES];
uniform float uRipplePhase[RIPPLES];
uniform float uFogDensity;
uniform float uWhitecaps;
uniform vec3 uAbsorb;
uniform vec3 uScatter;
uniform vec3 uSand;
uniform float uHs;
uniform float uTide;
uniform vec2 uFlow;
uniform float uRain;
uniform int uDebug;
uniform float uNight;

varying vec3 vWorld;
varying vec3 vNormalW;
varying float vJac;
varying float vDepth;
varying float vLift;
varying float vSurf;

const float PI = 3.141592653589793;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}

float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * vnoise(p);
    p = p * 2.07 + 17.3;
    a *= 0.5;
  }
  return s;
}

/** Sun (or moon) glitter: GGX distribution × Fresnel, for a light of irradiance E. */
vec3 glitter(vec3 N, vec3 V, vec3 L, vec3 E, float alpha) {
  if (L.y <= -0.02 || dot(E, E) == 0.0) return vec3(0.0);
  vec3 H = normalize(L + V);
  float a2 = alpha * alpha;
  float nh = max(dot(N, H), 0.0);
  float d = nh * nh * (a2 - 1.0) + 1.0;
  float D = a2 / (PI * d * d);
  float F = 0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0);
  float nl = max(dot(N, L), 0.0);
  return E * D * F * step(0.0, nl) / (4.0 * max(dot(N, V), 0.1));
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 N = normalize(vNormalW);

  // Wind ripples: slopes only, faded out where a pixel covers more than ~a quarter wavelength.
  // What they would have added becomes roughness instead (blurrier reflection, wider glitter).
  float footprint = length(fwidth(vWorld.xz));
  vec2 slope = vec2(0.0);
  float lost = 0.0;
  for (int i = 0; i < RIPPLES; i++) {
    vec4 r = uRipple[i];
    float L = 6.2831853 / r.z;
    float fade = 1.0 - smoothstep(L * 0.12, L * 0.45, footprint);
    float c = cos(r.z * dot(r.xy, vWorld.xz) - uRipplePhase[i]);
    slope += r.xy * (r.w * c * fade);
    lost += r.w * r.w * 0.5 * (1.0 - fade);
  }
  // Rain roughens the surface everywhere.
  lost += uRain * 0.01;
  N = normalize(N + vec3(-slope.x, 0.0, -slope.y) * N.y);
  float alpha = sqrt(0.0004 + 2.0 * lost) + 0.015 * smoothstep(300.0, 4000.0, dist) * min(uHs, 3.0);

  float NdV = max(dot(N, V), 0.0);
  float F = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  // Slopes too fine to see still tilt facets toward the viewer at grazing angles, so a rough sea
  // reflects higher (bluer, darker) sky and less of it (masking) than a mirror would.
  float grazing = 1.0 - smoothstep(0.0, 0.35, V.y);
  F *= 1.0 - 0.45 * grazing * smoothstep(0.0, 0.06, alpha);

  // Reflection: mirror below-horizon directions back up (the sea "reflecting itself" would need a
  // second pass; the sky right above the horizon is a fine stand-in).
  vec3 R = reflect(-V, N);
  R = normalize(vec3(R.x, abs(R.y) + 0.01 + alpha * 1.6 * grazing, R.z));
  float lod = clamp(log2(max(alpha / uEnvTexel, 1.0)), 0.0, uEnvMaxLod);
  vec3 sky = textureLod(uEnv, R, lod).rgb;

  // Light arriving at the water: direct sun/moon (as E·cosθ/π) plus the sky dome.
  vec3 skyAvg = textureLod(uEnv, vec3(0.0, 1.0, 0.0), uEnvMaxLod).rgb;
  vec3 direct = (uSunColor * max(uSunDir.y, 0.0) + uMoonColor * max(uMoonDir.y, 0.0)) / PI;
  vec3 light = direct + skyAvg;

  // Water body: scattering from the depths, plus the seabed through shallow water.
  float column = max(vDepth + (vWorld.y - uTide), 0.0);
  vec3 trans = exp(-uAbsorb * column * (1.0 + 1.0 / max(NdV, 0.25)));
  float caustic = 0.75 + 0.7 * pow(abs(sin(vnoise(vWorld.xz * 0.9 + uTime * 0.35) * 6.0 + uTime * 0.6)), 6.0);
  vec3 bed = uSand * (direct * mix(1.0, caustic, step(0.0, uSunDir.y)) + skyAvg);
  vec3 body = bed * trans + uScatter * light * (1.0 - trans);

  // Light shining through the thin tops of waves seen against the sun.
  vec2 vh = normalize(-V.xz + 1e-5);
  vec2 sh = normalize(uSunDir.xz + 1e-5);
  float back = pow(max(dot(vh, sh), 0.0), 4.0) * smoothstep(-0.05, 0.25, uSunDir.y) * (1.0 - smoothstep(0.4, 0.9, uSunDir.y));
  body += vec3(0.05, 0.42, 0.36) * uSunColor * 0.012 * (back + 0.15) * clamp(vLift, 0.0, 1.6);

  vec3 color = mix(body, sky, F);
  color += glitter(N, V, uSunDir, uSunColor, max(alpha, 0.012));
  color += glitter(N, V, uMoonDir, uMoonColor, max(alpha, 0.012));

  // Foam
  vec2 fp = vWorld.xz * 0.45 + uFlow * uTime;
  float n1 = fbm(fp);
  float n2 = fbm(vWorld.xz * 1.7 - uFlow * uTime * 1.3);
  float caps = smoothstep(0.6, 0.15, vJac) * uWhitecaps;
  float breakers = vSurf * smoothstep(0.0, 0.8, vLift);
  float churn = vSurf * 0.2;
  float cover = clamp(caps + breakers + churn, 0.0, 1.0);
  // Lacy rather than solid: a sharp threshold on the noise, then thinned by a finer octave.
  float pattern = n1 * 0.65 + n2 * 0.35;
  float foam = smoothstep(1.0 - cover * 0.8, 1.0 - cover * 0.8 + 0.12, pattern + cover * 0.2) * (0.55 + 0.45 * smoothstep(0.3, 0.7, n2));
  float swash = 1.0 - smoothstep(0.0, 0.18 + 0.12 * n2, column);
  foam = max(foam, swash * smoothstep(0.25, 0.6, n1 + 0.2));
  // Foam fades with distance into an average brightness instead of a sparkly pattern.
  foam = mix(foam, cover * 0.5, smoothstep(150.0, 1200.0, dist));
  vec3 foamColor = vec3(0.82, 0.86, 0.88) * (direct * max(dot(N, uSunDir), 0.0) * 2.0 + skyAvg * 1.1);
  color = mix(color, foamColor, foam);

  // Fog, toward the sky's colour at the horizon in this direction.
  vec3 fogDir = normalize(vec3(-V.x, 0.015, -V.z));
  vec3 fogColor = textureLod(uEnv, fogDir, 2.0).rgb;
  float fog = 1.0 - exp(-dist * uFogDensity);
  color = mix(color, fogColor, fog);

  // Night vision: rods see no colour, and are most sensitive to blue-green (Purkinje shift).
  color = mix(color, vec3(dot(color, vec3(0.2, 0.6, 0.2))) * vec3(0.72, 0.88, 1.15), uNight * 0.8);

  if (uDebug == 1) color = body;
  else if (uDebug == 2) color = sky * F;
  else if (uDebug == 3) color = vec3(foam);
  else if (uDebug == 4) color = N * 0.5 + 0.5;
  else if (uDebug == 5) color = vec3(fog);
  gl_FragColor = vec4(color, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface WaterFrame {
  time: number;
  tide: number;
  sunDir: THREE.Vector3;
  sunColor: THREE.Vector3;
  moonDir: THREE.Vector3;
  moonColor: THREE.Vector3;
  fogDensity: number;
  /** 0–1, from the wind speed. */
  whitecaps: number;
  rain: number;
  /** 0 day … 1 night, for the night-vision tint. */
  night: number;
  /** Foam drift (m/s, x/z). */
  flowX: number;
  flowZ: number;
}

export class Water {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  /** Mesh spacing ≈ base + distance·factor (m). */
  readonly spacing: { base: number; factor: number };

  constructor(
    private readonly field: WaveField,
    env: THREE.CubeTexture,
    envSize: number,
  ) {
    const grid = radialGrid();
    this.spacing = { base: grid.base, factor: grid.factor };
    const material = new THREE.ShaderMaterial({
      name: 'RealOceanWater',
      uniforms: {
        uWaveA: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
        uWaveB: { value: Array.from({ length: MAX_WAVES }, () => new THREE.Vector4()) },
        uCount: { value: 0 },
        uHs: { value: 0 },
        uSpacing: { value: new THREE.Vector2(grid.base, grid.factor) },
        uSeaward: { value: new THREE.Vector2(1, 0) },
        uDeanA: { value: 0.1 },
        uTide: { value: 0 },
        uEnv: { value: env },
        uEnvMaxLod: { value: Math.log2(envSize) },
        // Angle covered by one texel of the cube's top mip (a face spans 90°).
        uEnvTexel: { value: Math.PI / 2 / envSize },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColor: { value: new THREE.Vector3() },
        uMoonDir: { value: new THREE.Vector3(0, -1, 0) },
        uMoonColor: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uRipple: { value: Array.from({ length: RIPPLES }, () => new THREE.Vector4()) },
        uRipplePhase: { value: new Float32Array(RIPPLES) },
        uFogDensity: { value: 0.00005 },
        uWhitecaps: { value: 0 },
        // Absorption per metre (r, g, b) of clear coastal water, and the reflectance of what it
        // scatters back up: together they make deep water navy and shallow water over sand teal.
        uAbsorb: { value: new THREE.Vector3(0.42, 0.075, 0.055) },
        uScatter: { value: new THREE.Vector3(0.004, 0.022, 0.03) },
        uSand: { value: new THREE.Vector3(0.45, 0.37, 0.25) },
        uFlow: { value: new THREE.Vector2() },
        uRain: { value: 0 },
        uDebug: { value: 0 },
        uNight: { value: 0 },
      },
      vertexShader,
      fragmentShader,
    });
    this.mesh = new THREE.Mesh(grid.geometry, material);
    this.mesh.frustumCulled = false;
  }

  get uniforms() {
    return this.mesh.material.uniforms;
  }

  setShore(shore: Shore): void {
    const [sx, sz] = bearingToVec(shore.facing);
    this.uniforms.uSeaward.value.set(sx, sz);
    this.uniforms.uDeanA.value = shore.deanA;
  }

  setRipples(dirs: Float32Array, phases: Float32Array): void {
    const r = this.uniforms.uRipple.value as THREE.Vector4[];
    r.forEach((v, i) => v.fromArray(dirs, i * 4));
    (this.uniforms.uRipplePhase.value as Float32Array).set(phases);
  }

  update(camera: THREE.Camera, f: WaterFrame): void {
    const u = this.uniforms;
    // Follow the camera horizontally; the shader works in world coordinates, so the waves stay put.
    this.mesh.position.set(camera.position.x, 0, camera.position.z);
    const a = u.uWaveA.value as THREE.Vector4[];
    const b = u.uWaveB.value as THREE.Vector4[];
    for (let i = 0; i < MAX_WAVES; i++) {
      a[i].fromArray(this.field.a, i * 4);
      b[i].fromArray(this.field.b, i * 4);
    }
    u.uCount.value = this.field.count;
    u.uHs.value = this.field.hs;
    u.uTide.value = f.tide;
    u.uTime.value = f.time;
    u.uSunDir.value.copy(f.sunDir);
    u.uSunColor.value.copy(f.sunColor);
    u.uMoonDir.value.copy(f.moonDir);
    u.uMoonColor.value.copy(f.moonColor);
    u.uFogDensity.value = f.fogDensity;
    u.uWhitecaps.value = f.whitecaps;
    u.uRain.value = f.rain;
    u.uNight.value = f.night;
    u.uFlow.value.set(f.flowX, f.flowZ);
  }
}
