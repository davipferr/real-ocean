/**
 * Sky dome and the environment map the water reflects.
 *
 * The shader is three's `Sky` (Preetham daylight model + procedural clouds, MIT), forked to add:
 * - stars, on a sphere rotated by the real sidereal time, so they rise and set like the real sky;
 * - the moon, with its phase computed per pixel from the actual sun direction;
 * - overcast skies that close down to the horizon, rain-darkened cloud bases and lightning;
 * - a night-sky glow (airglow + moonlit sky), since Preetham alone fades to black at night.
 *
 * Every few frames the dome (only) is rendered into a cube map by a CubeCamera; the water samples
 * it for reflections and fog, and the sand gets it as an environment map for ambient light.
 */

import * as THREE from 'three';

export const SKY_LAYER = 1;

const vertexShader = /* glsl */ `
uniform vec3 sunPosition;
uniform float rayleigh;
uniform float turbidity;
uniform float mieCoefficient;

varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

const float e = 2.718281828459045;
const vec3 totalRayleigh = vec3(5.804542996261093E-6, 1.3562911419845635E-5, 3.0265902468824876E-5);
const vec3 MieConst = vec3(1.8399918514433978E14, 2.7798023919660528E14, 4.0790479543861094E14);
const float cutoffAngle = 1.6110731556870734;
const float steepness = 1.5;
const float EE = 1000.0;

float sunIntensity(float zenithAngleCos) {
  zenithAngleCos = clamp(zenithAngleCos, -1.0, 1.0);
  return EE * max(0.0, 1.0 - pow(e, -((cutoffAngle - acos(zenithAngleCos)) / steepness)));
}

void main() {
  vec4 worldPosition = modelMatrix * vec4(position, 1.0);
  vWorldPosition = worldPosition.xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position.z = gl_Position.w; // at the far plane
  vSunDirection = normalize(sunPosition);
  vSunE = sunIntensity(vSunDirection.y);
  vBetaR = totalRayleigh * rayleigh;
  vBetaM = 0.434 * (0.2 * turbidity * 10E-18) * MieConst * mieCoefficient;
}
`;

const fragmentShader = /* glsl */ `
varying vec3 vWorldPosition;
varying vec3 vSunDirection;
varying vec3 vBetaR;
varying vec3 vBetaM;
varying float vSunE;

uniform float mieDirectionalG;
uniform float showSunDisc;
uniform float time;
uniform float cloudCoverage;
uniform float cloudDensity;
uniform vec2 cloudOffset;
uniform float cloudRain;
uniform float flash;
uniform vec3 nightSky;
uniform float stars;
uniform mat3 skyRotation;
uniform vec3 moonDirection;
uniform float moonBrightness;
uniform float moonRadius;

vec2 gradient(vec2 i) {
  vec3 p = fract(i.xyx * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yzx + 33.33);
  return fract((p.xx + p.yz) * p.zy) * 2.0 - 1.0;
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  float a = dot(gradient(i), f);
  float b = dot(gradient(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0));
  float c = dot(gradient(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0));
  float d = dot(gradient(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 1.6;
}

float fbm(vec2 p, float drift) {
  float result = 0.0;
  float amplitude = 1.0;
  for (int i = 0; i < 5; i++) {
    result += amplitude * noise(p);
    amplitude *= 0.5;
    p = p * 2.03 + drift;
  }
  return result;
}

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

/** A procedural star field: at most one star per cell of a 3D grid over the unit sphere. */
vec3 starField(vec3 d) {
  vec3 p = d * 260.0;
  vec3 c = floor(p);
  float h = hash13(c);
  if (h < 0.982) return vec3(0.0);
  vec3 offset = vec3(hash13(c + 1.7), hash13(c + 3.1), hash13(c + 5.3)) - 0.5;
  vec3 f = fract(p) - 0.5 - offset * 0.6;
  // Size at least a pixel, energy kept constant, so stars don't flicker as the view moves.
  float px = length(fwidth(p));
  float sigma = max(0.06, px * 0.6);
  float core = exp(-dot(f, f) / (2.0 * sigma * sigma)) * (0.06 * 0.06) / (sigma * sigma);
  float mag = pow((h - 0.982) / 0.018, 5.0) * 2.5 + 0.08;
  vec3 tint = mix(vec3(1.0, 0.82, 0.66), vec3(0.72, 0.84, 1.0), hash13(c + 9.1));
  return tint * core * mag;
}

const float pi = 3.141592653589793;
const float rayleighZenithLength = 8.4E3;
const float mieZenithLength = 1.25E3;
const float sunAngularDiameterCos = 0.999956676946448;
const float THREE_OVER_SIXTEENPI = 0.05968310365946075;
const float ONE_OVER_FOURPI = 0.07957747154594767;

float rayleighPhase(float cosTheta) {
  return THREE_OVER_SIXTEENPI * (1.0 + pow(cosTheta, 2.0));
}

float hgPhase(float cosTheta, float g) {
  float g2 = pow(g, 2.0);
  float inverse = 1.0 / pow(1.0 - 2.0 * g * cosTheta + g2, 1.5);
  return ONE_OVER_FOURPI * ((1.0 - g2) * inverse);
}

void main() {
  vec3 direction = normalize(vWorldPosition - cameraPosition);

  float zenithAngle = acos(max(0.0, direction.y));
  float inverse = 1.0 / (cos(zenithAngle) + 0.15 * pow(93.885 - ((zenithAngle * 180.0) / pi), -1.253));
  float sR = rayleighZenithLength * inverse;
  float sM = mieZenithLength * inverse;
  vec3 Fex = exp(-(vBetaR * sR + vBetaM * sM));

  float cosTheta = dot(direction, vSunDirection);
  float rPhase = rayleighPhase(cosTheta * 0.5 + 0.5);
  vec3 betaRTheta = vBetaR * rPhase;
  float mPhase = hgPhase(cosTheta, mieDirectionalG);
  vec3 betaMTheta = vBetaM * mPhase;

  vec3 Lin = pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * (1.0 - Fex), vec3(1.5));
  Lin *= mix(vec3(1.0), pow(vSunE * ((betaRTheta + betaMTheta) / (vBetaR + vBetaM)) * Fex, vec3(0.5)), clamp(pow(1.0 - vSunDirection.y, 5.0), 0.0, 1.0));

  vec3 L0 = vec3(0.1) * Fex;
  float sundisc = clamp((cosTheta - sunAngularDiameterCos) * 50000.0, 0.0, 1.0) * showSunDisc;
  vec3 sundiscColor = (760.0 * sundisc) * min(vSunE * Fex, 80.0);

  vec3 texColor = (Lin + L0) * 0.04 + sundiscColor + vec3(0.0, 0.0003, 0.00075);

  // Night: airglow and moonlit sky, brighter toward the horizon (more air to look through).
  float horizonGlow = 1.0 - 0.6 * clamp(direction.y, 0.0, 1.0);
  texColor += nightSky * horizonGlow;

  // Stars, dimmed by extinction near the horizon.
  float above = smoothstep(-0.01, 0.12, direction.y);
  if (stars > 0.001) texColor += starField(direction * skyRotation) * stars * above;

  // Moon: shade each pixel of the disc as a sphere lit from the sun's direction.
  float cm = dot(direction, moonDirection);
  float sinR = sin(moonRadius);
  if (moonBrightness > 0.0 && cm > 0.0) {
    vec3 q = (direction - moonDirection * cm) / sinR;
    float r = length(q);
    if (r < 1.0) {
      vec3 n = q - moonDirection * sqrt(1.0 - r * r);
      float lit = smoothstep(-0.04, 0.06, dot(n, vSunDirection));
      float maria = 0.82 + 0.18 * smoothstep(-0.3, 0.6, noise(q.xy * 3.0 + q.z * 2.0 + 7.0));
      float edge = 1.0 - smoothstep(0.92, 1.0, r);
      texColor += vec3(1.0, 0.96, 0.88) * moonBrightness * (lit * maria + 0.015) * edge * above;
    }
    // Halo from scattering in the air around a bright moon.
    texColor += vec3(0.6, 0.7, 0.9) * moonBrightness * 0.004 * pow(max(cm, 0.0), 800.0) * above;
  }

  // Clouds
  if (direction.y > -0.05 && cloudCoverage > 0.0) {
    vec2 cloudUV = direction.xz / max(direction.y + 0.04, 0.02) * 0.00022 + cloudOffset;
    float evolve = time * 0.004;
    float cloudNoise = clamp(fbm(cloudUV * 1000.0, evolve) * 0.7 + 0.5, 0.0, 1.0);
    float region = noise(cloudUV * 300.0) * 0.37 + 0.5;
    float cov = clamp(cloudCoverage + (region - 0.5) * 0.6 * (1.0 - cloudCoverage), 0.0, 1.0);
    float threshold = 1.0 - cov;
    float cloudMask = smoothstep(threshold - 0.05, threshold + 0.3, cloudNoise);

    // Distant clouds merge into a band; an overcast deck closes all the way to the horizon.
    float horizonFade = smoothstep(-0.02, 0.08, direction.y);
    float deck = smoothstep(0.55, 0.95, cloudCoverage);
    cloudMask = mix(cloudMask * horizonFade, mix(cov, 1.0, deck) * smoothstep(-0.05, 0.0, direction.y), 1.0 - smoothstep(0.0, 0.25, direction.y) * (1.0 - deck * 0.6));

    float dayFactor = smoothstep(-0.08, 0.3, vSunDirection.y);
    // Sunlight reaching the clouds is dimmed along the sun's path (aerial perspective toward the
    // viewer is applied below), not along the view ray, which would black out the horizon.
    float sunZenith = acos(max(0.0, vSunDirection.y));
    float sunAir = 1.0 / (cos(sunZenith) + 0.15 * pow(93.885 - ((sunZenith * 180.0) / pi), -1.253));
    vec3 sunFex = exp(-(vBetaR * rayleighZenithLength + vBetaM * mieZenithLength) * sunAir);
    vec3 sunColor = vSunE * sunFex * 0.22 * 0.04;
    vec3 skyAmbient = Lin * 0.04 + vec3(0.0, 0.0003, 0.00075);

    float depth = max(0.0, cloudNoise - threshold) + deck * 0.5;
    float beer = exp(depth * -4.0);
    float powder = 1.0 - beer * beer;
    float shade = mix(0.45, 1.0, clamp(beer * powder * 2.6, 0.0, 1.0));
    float silver = clamp(0.51 / pow(1.49 - cosTheta * 1.4, 1.5), 0.0, 3.0);
    float edge = cloudMask * (1.0 - cloudMask) * 4.0;

    // Broken clouds: sunlit tops with silver linings. A thick deck lets no direct sun through, so
    // its underside is a grey lit by what diffuses through it, brightest overhead: the CIE standard
    // overcast sky has luminance ∝ (1 + 2·sin h)/3, the zenith three times the horizon.
    vec3 broken = skyAmbient + sunColor * shade + sunColor * silver * edge * 0.6;
    float sunLum = dot(sunColor, vec3(0.2126, 0.7152, 0.0722));
    float cie = (1.0 + 2.0 * max(direction.y, 0.0)) / 3.0;
    vec3 deckColor = vec3(0.93, 0.97, 1.04) * sunLum * 0.36 * cie * mix(1.0, 0.75, clamp(depth - deck * 0.5, 0.0, 1.0));
    vec3 cloudColor = mix(broken, deckColor, deck);
    cloudColor *= max(dayFactor, 0.03);
    cloudColor *= mix(1.0, 0.38, cloudRain);
    // At night cloud bases glow with the (sodium-warm) light of the towns below them.
    cloudColor += dot(nightSky, vec3(0.333)) * vec3(1.12, 1.0, 0.86) * 1.1 * (0.7 + 0.3 * shade) + moonBrightness * 0.00025 * shade;
    cloudColor += flash * vec3(0.75, 0.8, 1.0) * (0.4 + 0.6 * shade);

    float alpha = clamp((1.0 - exp(depth * cloudDensity * -12.0)) * 1.4, 0.0, 1.0) * cloudMask;
    alpha = max(alpha, deck * cloudMask);
    texColor -= L0 * 0.04 * alpha;
    vec3 cloudAerial = mix(texColor, cloudColor, mix(Fex, vec3(1.0), deck));
    texColor = mix(texColor, cloudAerial, alpha);
  }

  texColor += flash * vec3(0.05, 0.055, 0.07);
  gl_FragColor = vec4(max(texColor, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface SkyParams {
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  moonBrightness: number;
  turbidity: number;
  rayleigh: number;
  mieCoefficient: number;
  cloudCoverage: number;
  cloudRain: number;
  nightSky: THREE.Color;
  stars: number;
  flash: number;
}

export class SkySystem {
  readonly mesh: THREE.Mesh<THREE.BoxGeometry, THREE.ShaderMaterial>;
  readonly envTarget: THREE.WebGLCubeRenderTarget;
  private readonly cubeCamera: THREE.CubeCamera;
  private readonly cloudOffset = new THREE.Vector2();
  private framesSinceEnv = Infinity;
  private envRenders = 0;

  constructor(envSize = 128) {
    const material = new THREE.ShaderMaterial({
      name: 'RealOceanSky',
      uniforms: {
        turbidity: { value: 2 },
        rayleigh: { value: 1 },
        mieCoefficient: { value: 0.005 },
        mieDirectionalG: { value: 0.8 },
        sunPosition: { value: new THREE.Vector3(0, 1, 0) },
        showSunDisc: { value: 1 },
        time: { value: 0 },
        cloudCoverage: { value: 0.3 },
        cloudDensity: { value: 0.5 },
        cloudOffset: { value: this.cloudOffset },
        cloudRain: { value: 0 },
        flash: { value: 0 },
        nightSky: { value: new THREE.Color(0, 0, 0) },
        stars: { value: 0 },
        skyRotation: { value: new THREE.Matrix3() },
        moonDirection: { value: new THREE.Vector3(0, -1, 0) },
        moonBrightness: { value: 0 },
        // The real moon is 0.26° in radius; drawn 1.6× larger, as it looks to the eye near the horizon.
        moonRadius: { value: THREE.MathUtils.degToRad(0.26 * 1.6) },
      },
      vertexShader,
      fragmentShader,
      side: THREE.BackSide,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
    this.mesh.scale.setScalar(40_000);
    this.mesh.frustumCulled = false;
    this.mesh.layers.set(SKY_LAYER);

    this.envTarget = new THREE.WebGLCubeRenderTarget(envSize, {
      type: THREE.HalfFloatType,
      generateMipmaps: true,
      minFilter: THREE.LinearMipmapLinearFilter,
    });
    this.cubeCamera = new THREE.CubeCamera(1, 100_000, this.envTarget);
    this.cubeCamera.position.set(0, 2, 0);
    this.cubeCamera.children.forEach((c) => c.layers.set(SKY_LAYER));
  }

  get uniforms() {
    return this.mesh.material.uniforms;
  }

  /** Sets the sky's state; `windDrift` is the cloud drift in metres per second (x, z). */
  update(p: SkyParams, time: number, dt: number, windDriftX: number, windDriftZ: number): void {
    const u = this.uniforms;
    u.sunPosition.value.copy(p.sunDir);
    u.moonDirection.value.copy(p.moonDir);
    u.moonBrightness.value = p.moonBrightness;
    u.turbidity.value = p.turbidity;
    u.rayleigh.value = p.rayleigh;
    u.mieCoefficient.value = p.mieCoefficient;
    u.cloudCoverage.value = p.cloudCoverage;
    u.cloudRain.value = p.cloudRain;
    u.nightSky.value.copy(p.nightSky);
    u.stars.value = p.stars;
    u.flash.value = p.flash;
    u.time.value = time;
    // Cloud UVs are ~0.00022 per metre at the cloud base (direction / y with y ≈ 1).
    this.cloudOffset.x += windDriftX * dt * 0.00022 * 0.001;
    this.cloudOffset.y += windDriftZ * dt * 0.00022 * 0.001;
  }

  /**
   * Star sphere orientation: the celestial pole stands `lat` degrees above the north horizon and
   * the sky turns around it once per sidereal day (`lst`, local sidereal time in degrees).
   */
  setStarRotation(lat: number, lst: number): void {
    const phi = THREE.MathUtils.degToRad(lat);
    const pole = new THREE.Vector3(0, Math.sin(phi), -Math.cos(phi));
    const east = new THREE.Vector3(1, 0, 0);
    // Where a star on the celestial equator culminates (hour angle 0): due south (north of the equator), up.
    const meridian = new THREE.Vector3(0, Math.cos(phi), Math.sin(phi));
    // A star at right ascension α, declination δ sits at hour angle H = LST − α:
    //   d = cos δ·(cos H·meridian − sin H·east) + sin δ·pole
    // so its equatorial (x, y) = (cos δ cos α, cos δ sin α) = (d·A, d·B) with:
    const a = THREE.MathUtils.degToRad(lst);
    const A = meridian.clone().multiplyScalar(Math.cos(a)).addScaledVector(east, -Math.sin(a));
    const B = meridian.clone().multiplyScalar(Math.sin(a)).addScaledVector(east, Math.cos(a));
    // GLSL: direction * M = (dot(d, A), dot(d, B), dot(d, pole))
    this.uniforms.skyRotation.value.set(A.x, B.x, pole.x, A.y, B.y, pole.y, A.z, B.z, pole.z);
  }

  /**
   * Re-renders the cube map every `every` frames (or now, with force). Returns true if it did.
   * The sand's prefiltered (PMREM) copy only changes its ambient light, so it is rebuilt on every
   * fourth refresh: it costs about as much as the cube render itself.
   */
  renderEnv(renderer: THREE.WebGLRenderer, scene: THREE.Scene, every = 8, force = false): boolean {
    if (!force && ++this.framesSinceEnv < every) return false;
    this.framesSinceEnv = 0;
    const u = this.uniforms;
    // No sun disc in the reflection: the water draws its own sun glitter from the real sun direction.
    u.showSunDisc.value = 0;
    this.cubeCamera.update(renderer, scene);
    u.showSunDisc.value = 1;
    if (force || this.envRenders++ % 4 === 0) this.envTarget.texture.needsPMREMUpdate = true;
    return true;
  }
}
