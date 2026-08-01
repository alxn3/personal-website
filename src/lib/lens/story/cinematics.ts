import * as THREE from "three/webgpu";
import { clamp, float, mix, positionLocal } from "three/tsl";
import { rangeOf, atFrac } from "./story";
import { clamp01, smoothstep } from "../core/math";
import { uIsolateHide } from "../materials/bloom";
import {
  rawWipeMask,
  uWipeOn,
  uWipeBackdrop,
  uWipeBgBelow,
  uWipeBgTo,
} from "../materials/wipe";
import { isGlassElement, isAccessory } from "../core/parts";

// ============================================================================
// Cinematic extras (inspired by ./example) layered over the mechanism rig:
// the iris reveal, the light-path glass isolate, refraction rays, ambient
// dust, the sketch-in ink entrance, and the caps-on finale. Everything here is
// presentation only — nothing in this module moves a mechanism part.
// ============================================================================

// Scroll window over which the non-glass structure is dissolved to isolate the
// glass (the light-path scene) — derived from the story ranges so it tracks the
// scenes: from the tail of the explode scene until the REWRAP scene needs the
// structure back (it reappears as far-out flat sheets, mostly depth-faded, and
// flies in to wrap on layer by layer). On /lens (no story) `storyP` is
// permanently 0, so the window is never entered — the isolate is inert there.
const ISOLATE_P0 = atFrac(rangeOf("explode"), 0.85);
const ISOLATE_P1 = rangeOf("rewrap").p0;
const ISOLATE_FEATHER = 0.02; // scroll-p width of the fade at each end of the window

// Scroll position where the caps-on fly-in starts — derived from the story
// table like the isolate window above (so a scene-duration change upstream
// can't silently break it): 0.54 through the capsOn scene reproduces the
// signed-off absolute p ≈ 0.93 under today's holds.
const CAP_P0 = atFrac(rangeOf("capsOn"), 0.54);

export interface LensCinematics {
  /** Drive the extras for one frame from the eased mechanism/story values. */
  update(
    apertureT: number,
    explodeT: number,
    storyP: number,
    nowMs: number,
  ): void;
  /** Kick off the sketch-in entrance over the given ink edge lines (no-op if an
   *  entrance is already running). */
  startEntrance(lines: THREE.LineSegments[]): void;
  /** Re-tint the presentation extras (dust motes, refraction rays) for the site
   *  theme — the dark-stage cream dust vanishes on a light stage and vice versa. */
  setTheme(light: boolean): void;
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

  // Parts that block the iris from the REAR — hidden during the aperture beat so
  // the closing blades actually read (the rear glass/baffle/pcb otherwise cover them).
  const irisOccluders = [
    "Baffle_Rear",
    "PCB_Rear",
    "PCB_Components",
    "Mount_Contacts",
    "Mount_ContactShelf",
    "Optics_G5",
    "Optics_G4_Focus",
  ]
    .map((n) => node(n))
    .filter((o): o is THREE.Object3D => Boolean(o));
  let occludersHidden = false;

  // Glass elements, sorted along the optical axis — threaded by the refraction rays.
  const glassElements: THREE.Mesh[] = [];
  // Everything that ISN'T glass — hidden at the deep-explode dwell so the finale
  // isolates the light path (just the glass elements + rays on the dark stage).
  const nonGlassMeshes: THREE.Mesh[] = [];
  gltfScene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (isGlassElement(o.name)) glassElements.push(o);
    else if (!isAccessory(o.name)) nonGlassMeshes.push(o);
  });
  let isolated = false;

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
  // Reused across frames by the rays update below (hoisted so a deep-explode
  // frame allocates NO Box3/Vector3): one scratch box + one centre vector per
  // glass element. rayPts is fully overwritten each frame before it is sorted,
  // so the previous frame's sort order never leaks in.
  const rayBox = new THREE.Box3();
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

  // WIPE BACKDROP: a large plane behind the model, split by the SAME feathered
  // line the wipe mask sweeps through the model (materials/wipe.ts owns every
  // uniform), so a hero wipe can recolor the stage in lock-step with the
  // model's state change. A CHILD of the model node, so its vertices live in
  // the mask's own model frame (mm) by construction — no world→model matrix
  // plumbing. The transform below spans the plane over model (y, z) facing the
  // default camera; the mask is evaluated at model x = 0 (the axis plane), so
  // the backdrop line sits where the model's own front reads mid-depth.
  // Constructed INERT like the other extras: visible only while BOTH uWipeOn
  // and uWipeBackdrop are 1 (JS-side, checked each update — animations only
  // flip uniforms), so the homepage never sees it.
  const backdropMat = new THREE.MeshBasicNodeMaterial({
    side: THREE.DoubleSide,
  });
  {
    // geometry x → model z, geometry y → model y (see the mesh transform).
    // Both swept coordinates are CLAMPED to the model's extent: the plane is
    // far larger than the model, and the sweep range only covers the model —
    // unclamped, the extremes (p = 0 / p = 1) would park the line at the
    // model's edge with the plane's far side still the other color, instead
    // of saturating the whole backdrop to one color.
    const p = positionLocal as any;
    const my = clamp(p.y.add(38.25), 0.0, 76.5);
    const mz = clamp(p.x, -40.0, 40.0);
    backdropMat.colorNode = mix(
      uWipeBgBelow,
      uWipeBgTo,
      rawWipeMask(float(0), my, mz),
    );
  }
  // 8000mm ≈ 400 world units — fills the frustum behind the model
  const backdropGeo = new THREE.PlaneGeometry(8000, 8000);
  const backdrop = new THREE.Mesh(backdropGeo, backdropMat);
  // model +x reads world −z (behind the model from the default framing);
  // rotation.y −90° turns the plane's +z normal onto model −x (toward camera)
  // and maps geometry (x, y) onto model (z, y). position centers it mid-model.
  backdrop.position.set(400, 38.25, 0);
  backdrop.rotation.y = -Math.PI / 2;
  backdrop.visible = false;
  backdrop.raycast = () => {};
  gltfScene.add(backdrop);
  disposables.push(backdropGeo, backdropMat);

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

  function update(
    apertureT: number,
    explodeT: number,
    storyP: number,
    nowMs: number,
  ) {
    // iris reveal: hide the rear occluders once the aperture beat is engaged.
    // isolate the glass: dissolve everything non-glass ONLY for the light-path
    // scene (tied to scroll position, not the explode amount — so the teardown
    // scene still shows the fanned-out structure, and caps-on brings it back).
    // The two overlap on the rear meshes (PCB/baffle/contacts), so ONE recompute
    // owns every visible flag: either flag changing re-derives both passes, and
    // an occluder restore can never stomp an active isolate (or vice versa).
    const wantHidden = apertureT > 0.35;
    // The isolate is a FADE (uIsolateHide multiplies the non-glass ink opacity),
    // feathered at both ends — a hard visibility toggle made every structural
    // piece vanish in a single frame ("pieces just disappear" — owner). The
    // visibility flags below only cull meshes once FULLY faded (fill-rate).
    const isolateT =
      smoothstep(ISOLATE_P0, ISOLATE_P0 + ISOLATE_FEATHER, storyP) *
      (1 - smoothstep(ISOLATE_P1 - ISOLATE_FEATHER, ISOLATE_P1, storyP));
    uIsolateHide.value = isolateT;
    const wantIsolate = isolateT > 0.995;
    if (wantHidden !== occludersHidden || wantIsolate !== isolated) {
      occludersHidden = wantHidden;
      isolated = wantIsolate;
      for (const m of nonGlassMeshes) m.visible = !wantIsolate;
      // occluders include GROUP empties (Optics_G4/G5) whose glass children must
      // survive an isolate — so an empty un-hides fully, a mesh defers to isolate
      for (const o of irisOccluders)
        o.visible = !wantHidden && (!(o instanceof THREE.Mesh) || !wantIsolate);
    }

    // refraction rays — thread the optical axis through the (world-space) glass.
    // Use each element's bounding-box CENTRE: every part's node origin sits at its
    // parent's origin (lens_mechanism.md §4 — geometry is baked in place), so
    // getWorldPosition would thread the GROUP empties and stop short of the glass
    // (visible once the ladder spread the column out). Box3 walks are fine here —
    // 13 small meshes, and only while the explode is deep enough to show rays.
    const rayOp = smoothstep(0.62, 0.96, explodeT);
    if (rayOp > 0.001 && glassElements.length) {
      for (let i = 0; i < glassElements.length; i++)
        rayBox.setFromObject(glassElements[i]).getCenter(rayPts[i]);
      const pts = rayPts;
      pts.sort((a, b) => b.x - a.x); // front (+X) → rear
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

    // wipe backdrop: visibility from the two flags
    backdrop.visible = uWipeOn.value >= 0.5 && uWipeBackdrop.value >= 0.5;

    // sketch-in entrance (runs once, kicked off by startEntrance)
    runEntrance(nowMs);

    // caps-on finale: the lens has reassembled — slide the caps down the axis to seat
    if (storyMode || preview) {
      // caps fly in only after the rotate-to-camera has mostly settled (the
      // capsOn transit ends ≈0.95), so the beat reads: face the viewer → cap on
      const capT = smoothstep(CAP_P0, 1.0, storyP);
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
    backdrop.removeFromParent();
    for (const d of disposables) d.dispose();
  }

  return { update, startEntrance, setTheme, setStoryPreview, dispose };
}
