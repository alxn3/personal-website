import * as THREE from "three/webgpu";
import { rangeOf, atFrac } from "./story";
import { clamp01, smoothstep } from "../core/math";
import { displaceSeatedPoint } from "../ops/cpu";
import { isGlassElement } from "../core/parts";

// ============================================================================
// Cinematic extras (inspired by ./example) layered over the mechanism rig:
// refraction rays, ambient dust, the sketch-in ink entrance, and the caps-on
// finale. Everything here is presentation only — nothing in this module moves a
// mechanism part.
// ============================================================================

// Scroll position where the caps-on fly-in starts — derived from the story
// table rather than hardcoded (so a scene-duration change upstream can't
// silently break it): 0.54 through the capsOn scene reproduces the signed-off
// absolute p ≈ 0.93 under today's holds.
// ...and it finishes WITH that scene rather than at a hardcoded global 1 — the
// two coincide only for as long as capsOn is the story's last beat.
const CAP_P0 = atFrac(rangeOf("capsOn"), 0.54);
const CAP_P1 = rangeOf("capsOn").p1;

export interface LensCinematics {
  /** Drive the extras for one frame from the eased mechanism/story values. */
  update(explodeT: number, storyP: number, nowMs: number): void;
  /** Kick off the sketch-in entrance over the given ink edge lines (no-op if an
   *  entrance is already running). */
  startEntrance(lines: THREE.LineSegments[]): void;
  /** Re-tint the presentation extras (dust motes, refraction rays) for the site
   *  theme — the dark-stage cream dust vanishes on a light stage and vice versa. */
  setTheme(light: boolean): void;
  /** Show/hide the ambient dust motes. Always on by default (the story never
   *  calls this); the /lens fly-through demo clears the stage so the starfield
   *  behind the lens reads. Dispose-safe — the only thing it writes is the
   *  `.visible` flag of a node this module owns outright, exactly like the
   *  caps-on finale's two writes. */
  setDust(visible: boolean): void;
  /** DEV (/lens hero-camera preview): run the caps-on finale outside story
   *  mode. Turning it OFF reseats the caps at their rest positions; the caller
   *  re-applies its own cap visibility (the finale toggles it per-frame). */
  setStoryPreview(on: boolean): void;
  dispose(): void;
}

export function createCinematics(
  scene: THREE.Scene,
  gltfScene: THREE.Object3D,
  storyMode: boolean,
  accessoriesReady?: Promise<void>,
): LensCinematics {
  const node = (name: string) => gltfScene.getObjectByName(name);
  const disposables: { dispose: () => void }[] = [];

  // Glass elements, sorted along the optical axis — threaded by the refraction rays.
  const glassElements: THREE.Mesh[] = [];
  gltfScene.traverse((o) => {
    if (o instanceof THREE.Mesh && isGlassElement(o.name))
      glassElements.push(o);
  });

  // Front/rear caps: in the story's "caps on" finale they slide down the optical
  // axis and seat onto the reassembled lens. Rest positions captured for the slide.
  // The caps live in the accessories GLB, which loads in the BACKGROUND (they are
  // undefined until it resolves), so these are re-resolved off accessoriesReady.
  // The finale runs LATE (storyP ≈ 0.93+) — long after even a slow load — but the
  // guards below keep it inert (caps stay null) until the refs land, and the await
  // guarantees they do. Rest Y is read at resolve time, before the finale moves it.
  let capFront = node("Acc_CapFront");
  let capRear = node("Acc_CapRear");
  let capFrontBaseY = capFront ? capFront.position.y : 0;
  let capRearBaseY = capRear ? capRear.position.y : 0;
  accessoriesReady?.then(() => {
    capFront = node("Acc_CapFront");
    capRear = node("Acc_CapRear");
    capFrontBaseY = capFront ? capFront.position.y : 0;
    capRearBaseY = capRear ? capRear.position.y : 0;
  });

  // site theme (light = no `.dark` on <html>): dust/ray tints per theme, applied
  // at creation and on setTheme
  let light = !document.documentElement.classList.contains("dark");

  // Refraction rays: 3 warm lines tracing the light path through the glass, fading
  // in only when the lens is fully exploded ("only the light path is left").
  // Each element's SEATED bounding-box centre, resolved ONCE into the element's
  // own local frame — pose-independent, so the per-frame walk is a displacement
  // plus a matrix instead of a Box3 sweep. Its node origin sits at its parent's
  // origin (lens_mechanism.md §4 — geometry is baked in place), so the bbox
  // centre is what threads the glass; getWorldPosition would thread the GROUP
  // empties and stop short of it.
  const raySeated = glassElements.map((m) => {
    const c = new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3());
    return m.worldToLocal(c); // the same matrix both ways ⇒ exact, pose or not
  });
  // Reused across frames by the rays update below (hoisted so a deep-explode
  // frame allocates nothing). rayPts is fully overwritten each frame before it
  // is sorted, so the previous frame's sort order never leaks in.
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

  // Sketch-in entrance: when the ink shading is first applied, the edge lines
  // stroke on staggered (like a technical drawing drawing itself).
  let entranceStart: number | null = null;
  let entranceLines: THREE.LineSegments[] = [];
  let entranceCounts: number[] = [];

  function startEntrance(lines: THREE.LineSegments[]) {
    if (entranceStart !== null || entranceLines.length > 0) return; // already running
    entranceLines = lines;
    entranceCounts = lines.map(
      (l) =>
        (l.geometry.getAttribute("position") as THREE.BufferAttribute).count,
    );
    entranceStart = performance.now();
  }

  function runEntrance(nowMs: number) {
    if (entranceStart === null) return;
    const entT = Math.min(1, (nowMs - entranceStart) / 2200);
    const N = Math.max(1, entranceLines.length);
    entranceLines.forEach((l, i) => {
      const ti = clamp01(entT * 1.75 - (i / N) * 0.75);
      const dc = Math.floor(ti * entranceCounts[i]);
      l.visible = dc > 0; // avoid a zero-vertex draw (WebGPU warns)
      l.geometry.setDrawRange(0, dc);
    });
    if (entT >= 1) {
      entranceLines.forEach((l) => {
        l.visible = true;
        l.geometry.setDrawRange(0, Infinity);
      });
      entranceStart = null;
      entranceLines = [];
    }
  }

  function update(explodeT: number, storyP: number, nowMs: number): void {
    // refraction rays — thread the optical axis through the (world-space) glass.
    // The explode deform runs IN-SHADER, so the seated centre above is where the
    // element USED to be: displace it through the same op field the render runs
    // (ops/cpu.ts, mesh-local like the shader's `positionLocal`), then take it to
    // world through the element's own live matrix, which carries the mechanism's
    // object motion exactly once. Skipping that threaded the SEATED column while
    // the render drew one stretched tens of mm along the axis — in the one beat
    // where the glass and these rays are all that is on screen. 13 points, NUM
    // backend, only while the explode is deep enough to show rays.
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

    // sketch-in entrance (runs once, kicked off by startEntrance)
    runEntrance(nowMs);

    // caps-on finale: the lens has reassembled — slide the caps down the axis to
    // seat. The ONE `.visible` write left in this module, and it stays here
    // because it owns its two nodes outright: the caps are ACCESSORIES, which
    // the visibility owner leaves to their own owners (the page's accessory
    // choice, and this finale while the story runs).
    if (storyMode || preview) {
      // caps fly in only after the rotate-to-camera has mostly settled (the
      // capsOn transit ends ≈0.95), so the beat reads: face the viewer → cap on
      const capT = smoothstep(CAP_P0, CAP_P1, storyP);
      const capOn = capT > 0.004;
      if (capFront) {
        capFront.visible = capOn;
        capFront.position.y = capFrontBaseY + (1 - capT) * 95;
      }
      if (capRear) {
        capRear.visible = capOn;
        capRear.position.y = capRearBaseY - (1 - capT) * 95;
      }
    }
  }

  function setDust(visible: boolean) {
    dust.visible = visible;
  }

  // hero-camera preview flag (see LensCinematics.setStoryPreview)
  let preview = false;
  function setStoryPreview(on: boolean) {
    preview = on;
    if (!on) {
      if (capFront) capFront.position.y = capFrontBaseY;
      if (capRear) capRear.position.y = capRearBaseY;
    }
  }

  function dispose() {
    for (const ray of rays) ray.removeFromParent();
    dust.removeFromParent();
    for (const d of disposables) d.dispose();
  }

  return {
    update,
    startEntrance,
    setTheme,
    setDust,
    setStoryPreview,
    dispose,
  };
}
