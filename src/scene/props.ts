/**
 * A marker buoy riding the waves, and rain.
 *
 * The buoy reads the surface from `surfaceAt`, the CPU copy of the vertex shader's maths, so it
 * floats on exactly the water that is drawn. Rain is a GPU-only particle field that follows the
 * camera: each streak falls and wraps around a box, slanted by the real wind.
 */

import * as THREE from 'three';

import type { Sample } from '../ocean/gerstner';

export class Buoy {
  readonly group = new THREE.Group();
  private readonly lamp: THREE.Mesh<THREE.SphereGeometry, THREE.MeshStandardMaterial>;
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly tilt = new THREE.Quaternion();
  private readonly normal = new THREE.Vector3(0, 1, 0);

  constructor() {
    const red = new THREE.MeshStandardMaterial({ color: 0xd8341e, roughness: 0.5 });
    const white = new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.5 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.7, metalness: 0.3 });
    const float = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.75, 1.0, 24), red);
    float.position.y = 0.1;
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 0.5, 24), white);
    band.position.y = 0.85;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 1.6, 10), dark);
    mast.position.y = 1.7;
    const top = new THREE.Mesh(new THREE.ConeGeometry(0.42, 0.7, 20), red);
    top.position.y = 2.4;
    this.lamp = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0x222222, emissive: 0xffcc66, emissiveIntensity: 0 }),
    );
    this.lamp.position.y = 2.85;
    this.group.add(float, band, mast, top, this.lamp);
  }

  /** Puts the buoy on the surface sample (+ tide); the lamp flashes every 4 s at night. */
  update(s: Sample, tide: number, dt: number, time: number, night: number): void {
    this.group.position.set(s.x, tide + s.y - 0.35, s.z);
    // A buoy doesn't follow every ripple: ease its tilt toward the (softened) surface normal.
    this.normal.lerp(new THREE.Vector3(s.nx * 0.6, s.ny, s.nz * 0.6).normalize(), 1 - Math.exp(-dt * 3));
    this.tilt.setFromUnitVectors(this.up, this.normal.clone().normalize());
    this.group.quaternion.copy(this.tilt);
    const on = night > 0.3 && time % 4 < 0.5;
    this.lamp.material.emissiveIntensity = on ? 40 : 0;
  }
}

const rainVertex = /* glsl */ `
attribute float aEnd;
uniform float uTime;
uniform vec3 uCenter;
uniform vec3 uBox;
uniform vec2 uWind;
uniform float uSpeed;
uniform float uLength;
varying float vAlpha;

void main() {
  vec3 p = position;
  // Fall and wrap vertically.
  float y = mod(p.y - uTime * uSpeed, uBox.y);
  float fallTime = (uBox.y - y) / uSpeed;
  vec3 world = vec3(p.x + uWind.x * fallTime, y, p.z + uWind.y * fallTime);
  // Wrap horizontally around the camera.
  world.xz = uCenter.xz + mod(world.xz - uCenter.xz + uBox.xz * 0.5, uBox.xz) - uBox.xz * 0.5;
  world.y += uCenter.y - uBox.y * 0.5;
  // The streak: the top end trails along the velocity.
  vec3 vel = normalize(vec3(uWind.x, -uSpeed, uWind.y));
  world -= vel * uLength * aEnd;
  vAlpha = 1.0 - aEnd * 0.7;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
`;

const rainFragment = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vAlpha;
void main() {
  gl_FragColor = vec4(uColor, uOpacity * vAlpha);
}
`;

export class Rain {
  readonly lines: THREE.LineSegments<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly max = 12_000;

  constructor() {
    const box = new THREE.Vector3(70, 30, 70);
    const pos = new Float32Array(this.max * 2 * 3);
    const end = new Float32Array(this.max * 2);
    for (let i = 0; i < this.max; i++) {
      const x = Math.random() * box.x;
      const y = Math.random() * box.y;
      const z = Math.random() * box.z;
      pos.set([x, y, z, x, y, z], i * 6);
      end[i * 2 + 1] = 1;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aEnd', new THREE.BufferAttribute(end, 1));
    const material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uCenter: { value: new THREE.Vector3() },
        uBox: { value: box },
        uWind: { value: new THREE.Vector2() },
        uSpeed: { value: 9 },
        uLength: { value: 0.5 },
        uColor: { value: new THREE.Color(0.7, 0.75, 0.8) },
        uOpacity: { value: 0.35 },
      },
      vertexShader: rainVertex,
      fragmentShader: rainFragment,
      transparent: true,
      depthWrite: false,
    });
    this.lines = new THREE.LineSegments(g, material);
    this.lines.frustumCulled = false;
    this.lines.visible = false;
  }

  /**
   * @param rate precipitation (mm/h)
   * @param brightness light level for the streak colour (sky units)
   */
  update(camera: THREE.Camera, time: number, rate: number, windX: number, windZ: number, brightness: THREE.Color): void {
    // Drop count grows with rate but saturates: a downpour is about visibility, not more lines.
    const share = rate <= 0.05 ? 0 : Math.min(1, 0.12 + Math.sqrt(rate / 12));
    this.lines.visible = share > 0;
    if (!this.lines.visible) return;
    this.lines.geometry.setDrawRange(0, Math.floor(this.max * share) * 2);
    const u = this.lines.material.uniforms;
    u.uTime.value = time;
    u.uCenter.value.copy(camera.position);
    u.uWind.value.set(windX, windZ);
    u.uColor.value.copy(brightness);
  }
}
