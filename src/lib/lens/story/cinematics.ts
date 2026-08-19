import * as THREE from "three/webgpu";
import { smoothstep } from "../core/math";
import { displaceSeatedPoint } from "../ops/cpu";
import { isGlassElement } from "../core/parts";

// Cinematic extras layered over the mechanism rig: refraction rays and ambient
// dust. Presentation only — nothing here moves a mechanism part, and the only
// `.visible` flags it writes belong to nodes it builds itself. The story's
// ending carries no accessory; the caps stay a `/lens`-only accessory group.

export interface LensCinematics {
  /** Drive the extras for one frame from the eased mechanism value. */
  update(explodeT: number, nowMs: number): void;
  /** Re-tint the presentation extras (dust motes, refraction rays) for the site
   *  theme — the dark-stage cream dust vanishes on a light stage and vice versa. */
  setTheme(light: boolean): void;
  /** Show/hide the ambient dust motes, on by default. Dispose-safe — it writes
   *  only the `.visible` flag of a node this module owns outright. */
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
  // centre, resolved ONCE into its own local frame so the per-frame walk is a
  // displacement plus a matrix rather than a Box3 sweep. It must be the bbox
  // centre: an element's node origin sits at its parent's (geometry is baked in
  // place), so getWorldPosition would thread the GROUP empties instead.
  const raySeated = glassElements.map((m) => {
    const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
    return m.worldToLocal(c); // the same matrix both ways ⇒ exact, pose or not
  });
  // Hoisted so a deep-explode frame allocates nothing. Fully overwritten each
  // frame before it is sorted, so the previous sort order never leaks in.
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
    // refraction rays — thread the optical axis through the world-space glass.
    // The explode deform runs IN-SHADER, so the seated centre above is where the
    // element USED to be: displace it through the same op field the render runs
    // (ops/cpu.ts, mesh-local like the shader's `positionLocal`), then take it
    // to world through the element's own live matrix, which carries the
    // mechanism's object motion exactly once.
    const rayOp = smoothstep(0.62, 0.96, explodeT);
    if (rayOp > 0.001 && glassElements.length) {
      for (let i = 0; i < glassElements.length; i++) {
        const m = glassElements[i];
        m.updateWorldMatrix(false, false); // this frame's mechanism pose, as Box3 took it
        m.localToWorld(displaceSeatedPoint(m, rayPts[i].copy(raySeated[i])));
      }
      const pts = rayPts;
      pts.sort((a, b) => b.x - a.x); // front (+X) → rear, on the DISPLACED column
      const frontX = pts[0].x;
      const rearX = pts[pts.length - 1].x;
      const n = pts.length;
      rays.forEach((ray, ri) => {
        const off = (ri - 1) * 0.5; // radial offset per ray, in Y
        const arr = ray.geometry.attributes.position.array as Float32Array;
        let k = 0;
        const put = (x: number, y: number, z: number) => {
          arr[k++] = x;
          arr[k++] = y;
          arr[k++] = z;
        };
        // straight-ish converging rays down the optical axis (X); ignore each
        // element's tilt wobble so the beam stays a clean bundle, not a zigzag
        put(frontX + 0.6, off, 0);
        pts.forEach((pt, i) =>
          put(pt.x, off * (1 - 0.85 * ((i + 1) / (n + 1))), 0),
        );
        put(rearX - 0.6, off * 0.12, 0);
        ray.geometry.attributes.position.needsUpdate = true;
        (ray.material as THREE.LineBasicNodeMaterial).opacity =
          rayOp * (ri === 1 ? 0.95 : 0.55);
        ray.visible = true;
      });
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
