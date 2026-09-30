// Decorative extras over the lens: refraction rays through the glass and
// ambient dust. Nothing here moves or hides a lens part.

import * as THREE from "three/webgpu";
import { smoothstep } from "../core/math";
import { seatedPointDisplacer } from "../ops/cpu";
import { isGlassElement } from "../core/parts";

/** Sort front (+X) first. */
const byXDesc = (a: THREE.Vector3, b: THREE.Vector3) => b.x - a.x;

/** The dust field's seed, so it is the same on every load. */
export const DUST_SEED = 0x6c656e73;
/** Mote count and the half-extents of the box they fill, world units. */
export const DUST_N = 240;
export const DUST_BOX = [10, 7, 10] as const;

/** mulberry32: a small seeded generator over [0, 1). */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The mote positions, xyz-interleaved. */
export function dustField(n = DUST_N, seed = DUST_SEED): Float32Array {
  const rnd = seededRandom(seed);
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n * 3; i++) arr[i] = (rnd() * 2 - 1) * DUST_BOX[i % 3];
  return arr;
}

export interface LensCinematics {
  /** Update for one drawn frame from the eased explode value and dt (ms). */
  update(explodeT: number, dtMs: number): void;
  /** Re-tint the dust and rays for the site theme. */
  setTheme(light: boolean): void;
  /** Show/hide the ambient dust motes, on by default. */
  setDust(visible: boolean): void;
}

export function createCinematics(
  scene: THREE.Scene,
  gltfScene: THREE.Object3D,
): LensCinematics {
  // the glass elements the rays pass through
  const glassElements: THREE.Mesh[] = [];
  gltfScene.traverse((o) => {
    if (o instanceof THREE.Mesh && isGlassElement(o.name))
      glassElements.push(o);
  });

  // light theme = no `.dark` on <html>
  let light = !document.documentElement.classList.contains("dark");

  // Refraction rays: three warm lines through the glass, fading in only when
  // the lens is fully exploded. Each element's seated bbox centre in its local
  // frame (a node's origin is its group's, so it can't be used).
  const raySeated = glassElements.map((m) => {
    const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
    return m.worldToLocal(c);
  });
  // moves each seated centre through the deform (ops/cpu.ts); preallocated so
  // a frame allocates nothing
  const rayDisplacers = glassElements.map((m) => seatedPointDisplacer(m));
  const rayPts = glassElements.map(() => new THREE.Vector3());

  const rays: THREE.Line[] = [];
  for (let i = 0; i < 3; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute(
      "position",
      new THREE.BufferAttribute(
        new Float32Array((glassElements.length + 2) * 3),
        3,
      ),
    );
    const mat = new THREE.LineBasicNodeMaterial({
      transparent: true,
      depthWrite: false,
    });
    mat.color.setHex(0xdd8a4c);
    mat.opacity = 0;
    const line = new THREE.Line(geo, mat);
    line.frustumCulled = false;
    line.raycast = () => {};
    scene.add(line);
    rays.push(line);
  }

  // ambient dust motes drifting around the lens
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustField(), 3));
  const dustMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
  });
  dustMat.size = 2.2;
  dustMat.sizeAttenuation = false;
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  scene.add(dust);
  /** the dust's clock, ms; advances only while it is drawn */
  let dustT = 0;

  function applyTheme() {
    dustMat.color.setHex(light ? 0x6f695b : 0xcfc7ae);
    dustMat.opacity = light ? 0.3 : 0.42;
    const rayHex = light ? 0xb5671f : 0xdd8a4c;
    for (const ray of rays)
      (ray.material as THREE.LineBasicNodeMaterial).color.setHex(rayHex);
  }
  applyTheme();

  function update(explodeT: number, dtMs: number): void {
    // Rays: the explode runs in the shader, so each seated centre is moved
    // through the same deform on the CPU, then taken to world space.
    const rayOp = smoothstep(0.62, 0.96, explodeT);
    if (rayOp > 0.001 && glassElements.length) {
      for (let i = 0; i < glassElements.length; i++) {
        const m = glassElements[i];
        m.updateWorldMatrix(false, false);
        m.localToWorld(rayDisplacers[i].displace(rayPts[i].copy(raySeated[i])));
      }
      const pts = rayPts.sort(byXDesc);
      const n = pts.length;
      const frontX = pts[0].x;
      const rearX = pts[n - 1].x;
      for (let ri = 0; ri < rays.length; ri++) {
        const ray = rays[ri];
        const off = (ri - 1) * 0.5; // each ray's offset in Y
        const arr = ray.geometry.attributes.position.array as Float32Array;
        // converging rays along X, ignoring each element's wobble so the beam
        // stays a clean bundle
        arr[0] = frontX + 0.6;
        arr[1] = off;
        arr[2] = 0;
        for (let i = 0; i < n; i++) {
          const k = (i + 1) * 3;
          arr[k] = pts[i].x;
          arr[k + 1] = off * (1 - 0.85 * ((i + 1) / (n + 1)));
          arr[k + 2] = 0;
        }
        const k = (n + 1) * 3;
        arr[k] = rearX - 0.6;
        arr[k + 1] = off * 0.12;
        arr[k + 2] = 0;
        ray.geometry.attributes.position.needsUpdate = true;
        (ray.material as THREE.LineBasicNodeMaterial).opacity =
          rayOp * (ri === 1 ? 0.95 : 0.55);
        ray.visible = true;
      }
    } else {
      for (const ray of rays) ray.visible = false;
    }

    // dust: slow spin and gentle bob
    if (dust.visible) {
      dustT += dtMs;
      dust.rotation.y = dustT * 0.00002;
      dust.position.y = Math.sin(dustT * 0.0003) * 0.25;
    }
  }

  return {
    update,
    setTheme(l) {
      if (l === light) return;
      light = l;
      applyTheme();
    },
    setDust(visible) {
      dust.visible = visible;
    },
  };
}
