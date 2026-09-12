import * as THREE from "three/webgpu";
import { smoothstep } from "../core/math";
import { seatedPointDisplacer } from "../ops/cpu";
import { isGlassElement } from "../core/parts";

// Cinematic extras layered over the mechanism rig: refraction rays and ambient
// dust. Presentation only — nothing here moves a mechanism part, and the only
// `.visible` flags it writes belong to nodes it builds itself.

/** Front (+X) first — the rays thread the DISPLACED column in that order. */
const byXDesc = (a: THREE.Vector3, b: THREE.Vector3) => b.x - a.x;

export interface LensCinematics {
  /** Drive the extras for one frame from the eased mechanism value. */
  update(explodeT: number, nowMs: number): void;
  /** Re-tint the extras (dust motes, refraction rays) for the site theme. */
  setTheme(light: boolean): void;
  /** Show/hide the ambient dust motes, on by default. */
  setDust(visible: boolean): void;
  dispose(): void;
}

export function createCinematics(
  scene: THREE.Scene,
  gltfScene: THREE.Object3D,
): LensCinematics {
  const disposables: { dispose: () => void }[] = [];

  // Glass elements, sorted along the optical axis — threaded by the refraction rays.
  const glassElements: THREE.Mesh[] = [];
  gltfScene.traverse((o) => {
    if (o instanceof THREE.Mesh && isGlassElement(o.name))
      glassElements.push(o);
  });

  // site theme (light = no `.dark` on <html>): dust/ray tints per theme, applied
  // at creation and on setTheme
  let light = !document.documentElement.classList.contains("dark");

  // Refraction rays: 3 warm lines tracing the light path through the glass,
  // fading in only when the lens is fully exploded. Each element's SEATED bbox
  // centre, resolved once into its own local frame. It must be the bbox centre —
  // an element's node origin sits at its parent's, so getWorldPosition would
  // thread the GROUP empties instead.
  const raySeated = glassElements.map((m) => {
    const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
    return m.worldToLocal(c); // the same matrix both ways ⇒ exact, pose or not
  });
  // Each element's seated centre moved through the op field (ops/cpu.ts), one
  // displacer per element; both hoisted so a deep-explode frame allocates nothing.
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
    disposables.push(geo, mat);
  }

  // Ambient dust motes drifting in the volume — subtle life, always on.
  const DUST_N = 240;
  const dustGeo = new THREE.BufferGeometry();
  {
    const arr = new Float32Array(DUST_N * 3);
    for (let i = 0; i < DUST_N; i++) {
      arr[i * 3] = (Math.random() * 2 - 1) * 10;
      arr[i * 3 + 1] = (Math.random() * 2 - 1) * 7;
      arr[i * 3 + 2] = (Math.random() * 2 - 1) * 10;
    }
    dustGeo.setAttribute("position", new THREE.BufferAttribute(arr, 3));
  }
  const dustMat = new THREE.PointsNodeMaterial({
    transparent: true,
    depthWrite: false,
  });
  dustMat.size = 2.2;
  dustMat.sizeAttenuation = false;
  const dust = new THREE.Points(dustGeo, dustMat);
  dust.frustumCulled = false;
  scene.add(dust);
  disposables.push(dustGeo, dustMat);

  function applyTheme() {
    dustMat.color.setHex(light ? 0x6f695b : 0xcfc7ae); // dark motes on paper, cream on the stage
    dustMat.opacity = light ? 0.3 : 0.42;
    const rayHex = light ? 0xb5671f : 0xdd8a4c; // amber holds, just deepened for paper
    for (const ray of rays)
      (ray.material as THREE.LineBasicNodeMaterial).color.setHex(rayHex);
  }
  applyTheme();

  function setTheme(l: boolean) {
    if (l === light) return;
    light = l;
    applyTheme();
  }

  function update(explodeT: number, nowMs: number): void {
    // Refraction rays — thread the optical axis through the world-space glass.
    // The explode deform runs IN-SHADER, so the seated centre is displaced
    // through the same op field (ops/cpu.ts, mesh-local) and then taken to world
    // through the element's own live matrix.
    const rayOp = smoothstep(0.62, 0.96, explodeT);
    if (rayOp > 0.001 && glassElements.length) {
      for (let i = 0; i < glassElements.length; i++) {
        const m = glassElements[i];
        m.updateWorldMatrix(false, false); // this frame's mechanism pose, as Box3 took it
        m.localToWorld(rayDisplacers[i].displace(rayPts[i].copy(raySeated[i])));
      }
      const pts = rayPts;
      pts.sort(byXDesc);
      const n = pts.length;
      const frontX = pts[0].x;
      const rearX = pts[n - 1].x;
      for (let ri = 0; ri < rays.length; ri++) {
        const ray = rays[ri];
        const off = (ri - 1) * 0.5; // radial offset per ray, in Y
        const arr = ray.geometry.attributes.position.array as Float32Array;
        // straight-ish converging rays down the optical axis (X); ignore each
        // element's tilt wobble so the beam stays a clean bundle, not a zigzag
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

    // ambient dust: slow drift + gentle bob
    dust.rotation.y = nowMs * 0.00002;
    dust.position.y = Math.sin(nowMs * 0.0003) * 0.25;
  }

  function setDust(visible: boolean) {
    dust.visible = visible;
  }

  function dispose() {
    for (const ray of rays) ray.removeFromParent();
    dust.removeFromParent();
    for (const d of disposables) d.dispose();
  }

  return {
    update,
    setTheme,
    setDust,
    dispose,
  };
}
