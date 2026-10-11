/**
 * Camera views. Beach and aerial orbit with OrbitControls; surfer and buoy float on the water
 * (their height comes from the CPU wave evaluation) and look around with a drag.
 * Switching views glides between poses.
 */

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

import { bedHeight, fromShore, toShore, type Shore } from '../ocean/shore';
import { bearingToVec } from '../ocean/spectrum';

export type View = 'beach' | 'aerial' | 'surfer' | 'buoy';

export interface Pose {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export class CameraRig {
  view: View = 'beach';
  readonly controls: OrbitControls;
  private yaw = 0;
  private pitch = -0.04;
  private glide: { from: Pose; t: number } | null = null;
  private dragging = false;
  private last = { x: 0, y: 0 };
  /** Smoothed floating eye height, so the view bobs instead of jittering. */
  private floatY: number | null = null;
  /** Destination of a glide into an orbit view. */
  private dest: Pose | null = null;

  constructor(
    readonly camera: THREE.PerspectiveCamera,
    dom: HTMLElement,
  ) {
    this.controls = new OrbitControls(camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = THREE.MathUtils.degToRad(92);
    this.controls.minDistance = 2;
    this.controls.maxDistance = 3000;
    this.controls.zoomSpeed = 0.8;

    // Drag-to-look for the floating views.
    dom.addEventListener('pointerdown', (e) => {
      if (this.floating) {
        this.dragging = true;
        this.last = { x: e.clientX, y: e.clientY };
      }
    });
    window.addEventListener('pointerup', () => (this.dragging = false));
    window.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.floating) return;
      this.yaw -= (e.clientX - this.last.x) * 0.004;
      this.pitch = THREE.MathUtils.clamp(this.pitch - (e.clientY - this.last.y) * 0.004, -1.2, 1.2);
      this.last = { x: e.clientX, y: e.clientY };
    });
  }

  get floating(): boolean {
    return this.view === 'surfer' || this.view === 'buoy';
  }

  /** The fixed pose of an orbit view. */
  posePlan(view: 'beach' | 'aerial', shore: Shore, tide: number): Pose {
    const at = (d: number, u: number, y: number) => {
      const p = fromShore(shore, d, u);
      return new THREE.Vector3(p.x, y, p.z);
    };
    if (view === 'aerial') return { position: at(-150, -300, 160), target: at(90, 20, 0) };
    const d = -24;
    return { position: at(d, 0, bedHeight(shore.deanA, d, 0) + 1.7), target: at(80, 0, Math.max(0.5, tide + 0.5)) };
  }

  setView(view: View, shore: Shore, tide: number, animate = true): void {
    const from: Pose = { position: this.camera.position.clone(), target: this.lookTarget() };
    this.view = view;
    this.controls.enabled = !this.floating;
    this.floatY = null;
    this.dest = null;
    if (this.floating) {
      // Look out to sea, the way a surfer waits for the next set.
      const [sx, sz] = bearingToVec(shore.facing);
      this.yaw = Math.atan2(sx, sz);
      this.pitch = -0.03;
    } else {
      this.dest = this.posePlan(view as 'beach' | 'aerial', shore, tide);
      if (!animate) this.finishOrbit();
    }
    this.glide = animate ? { from, t: 0 } : null;
  }

  /** Where the camera currently looks (a point 10 m ahead). */
  private lookTarget(): THREE.Vector3 {
    if (!this.floating && !this.glide) return this.controls.target.clone();
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return this.camera.position.clone().addScaledVector(dir, 10);
  }

  private finishOrbit(): void {
    if (!this.dest) return;
    this.camera.position.copy(this.dest.position);
    this.controls.target.copy(this.dest.target);
    this.camera.lookAt(this.dest.target);
    this.controls.update();
    this.dest = null;
  }

  /**
   * @param floatAt for the floating views: the eye's surface point and its normal
   * @param groundAt ground/water height under a point, to keep orbit cameras above it
   */
  update(
    dt: number,
    floatAt: { x: number; y: number; z: number; up: THREE.Vector3 } | null,
    groundAt: (x: number, z: number) => number,
  ): void {
    let pose: Pose;
    if (this.floating && floatAt) {
      const eye = this.view === 'buoy' ? 3.3 : 0.9;
      const targetY = floatAt.y + eye;
      this.floatY = this.floatY == null ? targetY : this.floatY + (targetY - this.floatY) * (1 - Math.exp(-dt * 10));
      const position = new THREE.Vector3(floatAt.x, this.floatY, floatAt.z);
      const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
      if (this.view === 'buoy') {
        // Ride the buoy's tilt.
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), floatAt.up);
        dir.applyQuaternion(q);
        this.camera.up.copy(floatAt.up);
      } else {
        this.camera.up.set(0, 1, 0);
      }
      pose = { position, target: position.clone().add(dir) };
    } else if (this.dest) {
      pose = this.dest;
    } else {
      this.camera.up.set(0, 1, 0);
      this.controls.update();
      // Keep the camera above the sand and the sea.
      const floor = groundAt(this.camera.position.x, this.camera.position.z) + 1.0;
      if (this.camera.position.y < floor) this.camera.position.y = floor;
      return;
    }

    if (this.glide) {
      this.glide.t = Math.min(1, this.glide.t + dt / 1.4);
      const k = ease(this.glide.t);
      this.camera.position.copy(this.glide.from.position).lerp(pose.position, k);
      this.camera.lookAt(this.glide.from.target.clone().lerp(pose.target, k));
      if (this.glide.t >= 1) {
        this.glide = null;
        this.finishOrbit();
      }
      return;
    }
    this.camera.position.copy(pose.position);
    this.camera.lookAt(pose.target);
  }
}

/** Ground or still-water height under a scene point, for camera clamping. */
export function groundHeight(shore: Shore, tide: number, x: number, z: number): number {
  const { d, u } = toShore(shore, x, z);
  return Math.max(bedHeight(shore.deanA, d, u), tide + 0.6);
}
