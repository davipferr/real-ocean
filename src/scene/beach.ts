/**
 * The sand: a terrain mesh in shore coordinates (fine at the waterline, coarse kilometres away),
 * built from the same `bedHeight` the water shader uses for depth, so where the water thins out
 * the sand rises through it exactly.
 *
 * Wet sand (below the reach of the waves at the current tide) is darker and glossier; the line
 * moves with the tide.
 */

import * as THREE from 'three';

import { bedHeight, fromShore, type Shore } from '../ocean/shore';

/** Samples from 0 outward to `extent`, starting at `first` m apart and growing by `growth`. */
function axis(first: number, growth: number, extent: number): number[] {
  const out = [0];
  let step = first;
  while (out[out.length - 1] < extent) {
    out.push(Math.min(extent, out[out.length - 1] + step));
    step *= growth;
  }
  return out;
}

function sandTexture(): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Grain plus faint wind ripples.
      const ripple = Math.sin((x + Math.sin(y * 0.09) * 6) * 0.35) * 0.04;
      const v = 0.9 + (Math.random() - 0.5) * 0.18 + ripple;
      const o = (y * size + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = Math.max(0, Math.min(255, v * 255));
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

export class Beach {
  readonly mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  private readonly wet = { uTide: { value: 0 }, uReach: { value: 1 }, uNight: { value: 0 } };

  constructor(env: THREE.Texture) {
    const material = new THREE.MeshStandardMaterial({
      map: sandTexture(),
      vertexColors: true,
      roughness: 0.92,
      envMap: env,
    });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.wet);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSandWorld;')
        .replace('#include <project_vertex>', '#include <project_vertex>\nvSandWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vSandWorld;\nuniform float uTide;\nuniform float uReach;\nuniform float uNight;')
        .replace(
          '#include <tonemapping_fragment>',
          // Night vision, as in the water shader: colour fades to a cool grey.
          `gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(dot(gl_FragColor.rgb, vec3(0.2, 0.6, 0.2))) * vec3(0.72, 0.88, 1.15), uNight * 0.8);
          #include <tonemapping_fragment>`,
        )
        .replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          float wet = 1.0 - smoothstep(uTide + uReach * 0.6, uTide + uReach, vSandWorld.y);
          diffuseColor.rgb *= mix(1.0, 0.58, wet);`,
        )
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.32, wet);');
    };
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), material);
    this.mesh.frustumCulled = false;
  }

  /** Rebuilds the terrain for a beach orientation and sand type. */
  build(shore: Shore): void {
    const seaward = axis(0.5, 1.07, 260);
    const landward = axis(0.5, 1.06, 3500).slice(1).map((v) => -v).reverse();
    const ds = [...landward, ...seaward];
    const half = axis(1, 1.06, 7000);
    const us = [...half.slice(1).map((v) => -v).reverse(), ...half];
    const nd = ds.length;
    const nu = us.length;
    const pos = new Float32Array(nd * nu * 3);
    const col = new Float32Array(nd * nu * 3);
    const uv = new Float32Array(nd * nu * 2);
    // Linear albedos: dry quartz sand reflects ~35–40%, dune scrub ~10%.
    const dry = new THREE.Color(0.5, 0.41, 0.28);
    const grass = new THREE.Color(0.07, 0.1, 0.035);
    const c = new THREE.Color();
    for (let i = 0; i < nd; i++) {
      for (let j = 0; j < nu; j++) {
        const d = ds[i];
        const u = us[j];
        const y = bedHeight(shore.deanA, d, u);
        const { x, z } = fromShore(shore, d, u);
        const k = i * nu + j;
        pos.set([x, y, z], k * 3);
        // Vegetation on the dunes, patchy along the shore.
        const veg = Math.min(1, Math.max(0, (-d - 140) / 80)) * (0.75 + 0.25 * Math.sin(u * 0.013 + d * 0.02));
        c.copy(dry).lerp(grass, veg);
        col.set([c.r, c.g, c.b], k * 3);
        uv.set([u / 3, d / 3], k * 2);
      }
    }
    const index: number[] = [];
    for (let i = 0; i < nd - 1; i++) {
      for (let j = 0; j < nu - 1; j++) {
        const a = i * nu + j;
        const b = a + 1;
        const cc = a + nu;
        const dd = cc + 1;
        index.push(a, b, cc, b, dd, cc);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setIndex(index);
    g.computeVertexNormals();
    // Winding depends on the orientation; make sure the normals point up.
    const n = g.getAttribute('normal') as THREE.BufferAttribute;
    if (n.getY(Math.floor(n.count / 2)) < 0) {
      g.setIndex(index.map((_, i) => index[i - (i % 3) + [0, 2, 1][i % 3]]));
      g.computeVertexNormals();
    }
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
  }

  /** @param reach how far above still water the waves run up (m) */
  update(tide: number, reach: number, night: number): void {
    this.wet.uNight.value = night;
    this.wet.uTide.value = tide;
    this.wet.uReach.value = Math.max(0.3, reach);
  }
}
