import * as THREE from "three/webgpu";
import { createNdcOverlay, overlayMaterial, overlaySheet } from "./overlay";

// ============================================================================
// Prism light for the /lens demos, in the site's flat-poster language: ONE
// connected ribbon of solid color bands (Dark-Side-of-the-Moon style) — a
// narrow root at the front element, an opening wedge, then PARALLEL bands to
// the far end — plus a white entry band and a thin through-ribbon. Drawn as a
// TRUE ORTHOGRAPHIC OVERLAY: an own Scene + OrthographicCamera in NDC space,
// rendered as a second pass over the main frame (SceneHandle.setOverlayPass).
// The two ribbon anchors — the mount ENTRY point and the front-element
// DISPERSION point, both on the world y axis while the demo stands the lens on
// end — are projected world→NDC with the MAIN camera every rendered frame, so
// the ribbon TRACKS the 3D lens, but its edges are built vertical in screen
// space and stay ruler-parallel under every camera move: the "could this be a
// vector graphic pasted into the frame?" test passes by construction.
// Adjacent bands share bit-identical boundary vertices, so the fan is
// watertight — hard color edges, zero gaps.
// ============================================================================

// Anchor heights in world units, sized against the recentred lens (~3.8 long,
// centre at the origin — stood on end, the mount face sits at y ≈ +1.9 and the
// front element at y ≈ −1.9). The anchors tuck slightly INTO the model so the
// light visually enters/exits the glass instead of hovering at its silhouette.
const ENTRY_Y = 1.55;
const FAN_Y = -1.55;
/** world-unit run of the fan below the dispersion point */
const FAN_LEN = 5.4;
/** fraction of the run over which the ribbon opens; parallel after */
const OPEN_FRAC = 0.45;
/** ribbon root width ≈ the front-element aperture */
const ROOT_W = 1.3;
/** full ribbon width at spread 1 (the parallel stretch) */
const MAX_W = 3.6;
const ENTRY_W = 0.5;
/** total width of the thin through-ribbon inside the glass */
const THROUGH_W = 0.44;
const OP = 0.95;
/** through-ribbon peak opacity: the overlay has no per-element occlusion, so
 *  the band runs translucent — the glass rims ghost through it and the beam
 *  reads as threading the elements instead of pasted over them */
const THROUGH_OP = 0.6;
/** finite-difference step for the world→NDC scale probes */
const EPS = 0.5;

export interface PrismLight {
  /** Recolor the bands (band i takes colors[i % colors.length]) — called per
   *  frame by the demo, which does its own rainbow→palette crossfade. Fan and
   *  through-ribbon share the banding. */
  setColors(colors: readonly THREE.Color[]): void;
  /** Entry beam + fan opacity 0..1. The through-ribbon has its OWN knob
   *  (setThrough) so it can outlive the fan during the glass passage. */
  setIntensity(v: number): void;
  /** Fan opening 0 (parallel at root width) .. 1 (full ribbon width). */
  setSpread(v: number): void;
  /** Thin banded ribbon threading mount → dispersion point, 0..1 — shown while
   *  the glass is isolated so the light visibly travels THROUGH the elements. */
  setThrough(v: number): void;
  /** Slide the dispersion point down by dy world units — the demo keeps it
   *  glued to the front element while the assemble stretch carries the glass
   *  down the axis; the through-ribbon stretches to keep spanning the gap. */
  setDrop(dy: number): void;
  /** The overlay pass (SceneHandle.setOverlayPass): projects the anchors with
   *  the live main camera, lays the ribbon out in ortho NDC space, and renders
   *  the overlay scene over the finished main frame. Skips entirely while the
   *  ribbon is dark or an anchor is behind the camera (no NaN smears). */
  render(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera): void;
  dispose(): void;
}

// A vertical 2-quad strip: straight top/bottom edges, one interior row where
// the fan's opening wedge breaks into the parallel run. x positions come from
// shared boundary arrays so adjacent bands rasterize watertight.
function stripGeometry(): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(6 * 3), 3),
  );
  g.setIndex([0, 2, 1, 1, 2, 3, 2, 4, 3, 3, 4, 5]);
  return g;
}

export function createPrismLight(beamCount = 6): PrismLight {
  // Overlay scene in NDC space (shared plumbing, see overlay.ts): anchor
  // positions projected with the main camera drop straight in as coordinates.
  const overlay = createNdcOverlay();
  const oScene = overlay.scene;
  const disposables: { dispose: () => void }[] = [];

  const solidMat = (color: number | THREE.Color = 0xffffff) => {
    const m = overlayMaterial(color);
    disposables.push(m);
    return m;
  };
  const sheet = overlaySheet;

  // --- white entry beam (screen top → mount entry): parallel-edged band -----
  // Unit-height plane, origin at its bottom edge: scale.y stretches it from the
  // projected entry anchor up past the top of the frame.
  const entryMat = solidMat();
  const entry = (() => {
    const geo = new THREE.PlaneGeometry(ENTRY_W, 1);
    geo.translate(0, 0.5, 0);
    disposables.push(geo);
    const mesh = sheet(geo, entryMat);
    oScene.add(mesh);
    return mesh;
  })();

  // --- dispersion fan: butted solid bands off one moving root ---------------
  // Built in WORLD units about a local origin at the dispersion point; the
  // per-frame layout positions the root at the projected anchor and scales by
  // the local world→NDC factors, so the bands keep their diagram proportions
  // while their edges stay screen-vertical.
  const fanRoot = new THREE.Group();
  oScene.add(fanRoot);
  const fanMats: THREE.MeshBasicMaterial[] = [];
  const fanGeos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < beamCount; i++) {
    const mat = solidMat();
    const geo = stripGeometry();
    disposables.push(geo);
    fanMats.push(mat);
    fanGeos.push(geo);
    fanRoot.add(sheet(geo, mat));
  }

  const setFanShape = (spread: number) => {
    const w = ROOT_W + (MAX_W - ROOT_W) * spread;
    const yOpen = -FAN_LEN * OPEN_FRAC;
    for (let i = 0; i < beamCount; i++) {
      // band boundaries at fractions i/N and (i+1)/N of the ribbon width —
      // the same expressions produce the same floats for adjacent bands
      const f0 = i / beamCount - 0.5;
      const f1 = (i + 1) / beamCount - 0.5;
      const pos = fanGeos[i].getAttribute("position") as THREE.BufferAttribute;
      pos.setXYZ(0, ROOT_W * f0, 0, 0);
      pos.setXYZ(1, ROOT_W * f1, 0, 0);
      pos.setXYZ(2, w * f0, yOpen, 0);
      pos.setXYZ(3, w * f1, yOpen, 0);
      pos.setXYZ(4, w * f0, -FAN_LEN, 0);
      pos.setXYZ(5, w * f1, -FAN_LEN, 0);
      pos.needsUpdate = true;
    }
  };
  setFanShape(0);

  // --- through-ribbon (mount → dispersion point): the fan compressed --------
  // Same bands at pencil width. Unit height (y 0 → −1), top at the projected
  // entry anchor; scale.y = the NDC gap down to the (dropped) dispersion point.
  const throughRoot = new THREE.Group();
  oScene.add(throughRoot);
  const throughMats: THREE.MeshBasicMaterial[] = [];
  for (let i = 0; i < beamCount; i++) {
    const mat = solidMat();
    const geo = stripGeometry();
    disposables.push(geo);
    const f0 = i / beamCount - 0.5;
    const f1 = (i + 1) / beamCount - 0.5;
    const pos = geo.getAttribute("position") as THREE.BufferAttribute;
    pos.setXYZ(0, THROUGH_W * f0, 0, 0);
    pos.setXYZ(1, THROUGH_W * f1, 0, 0);
    pos.setXYZ(2, THROUGH_W * f0, -0.5, 0);
    pos.setXYZ(3, THROUGH_W * f1, -0.5, 0);
    pos.setXYZ(4, THROUGH_W * f0, -1, 0);
    pos.setXYZ(5, THROUGH_W * f1, -1, 0);
    throughMats.push(mat);
    throughRoot.add(sheet(geo, mat));
  }

  let intensity = 0;
  let through = 0;
  let drop = 0;
  const lit = () => intensity > 0.001 || through > 0.001;

  // per-frame projection scratch (render is called every rendered frame)
  const wF = new THREE.Vector3();
  const vE = new THREE.Vector3();
  const vF = new THREE.Vector3();
  const probe = new THREE.Vector3();

  return {
    setColors(colors) {
      if (!colors.length) return;
      for (let i = 0; i < beamCount; i++) {
        fanMats[i].color.copy(colors[i % colors.length]);
        throughMats[i].color.copy(colors[i % colors.length]);
      }
    },
    setIntensity(v) {
      intensity = v;
      entryMat.opacity = OP * v;
      for (const m of fanMats) m.opacity = OP * v;
    },
    setSpread(v) {
      setFanShape(v);
    },
    setThrough(v) {
      through = v;
      for (const m of throughMats) m.opacity = THROUGH_OP * v;
    },
    setDrop(dy) {
      drop = dy;
    },
    render(renderer, camera) {
      if (!lit()) return;
      // anchors: mount entry + (dropped) dispersion point, world → NDC
      wF.set(0, FAN_Y - drop, 0);
      vE.set(0, ENTRY_Y, 0).project(camera);
      vF.copy(wF).project(camera);
      // world→NDC scale factors AT the dispersion point: finite differences
      // along the camera's right (band widths) and world-down (run lengths)
      probe.setFromMatrixColumn(camera.matrixWorld, 0);
      probe.multiplyScalar(EPS).add(wF).project(camera);
      const sx = Math.abs(probe.x - vF.x) / EPS;
      probe.set(wF.x, wF.y - EPS, wF.z).project(camera);
      const sy = Math.abs(vF.y - probe.y) / EPS;
      // behind-camera / degenerate anchors: skip the pass (no NaN smears)
      if (
        !(Math.abs(vE.z) < 1 && Math.abs(vF.z) < 1) ||
        !isFinite(sx + sy) ||
        sx < 1e-6 ||
        sy < 1e-6
      )
        return;
      entry.position.set(vE.x, vE.y, 0);
      entry.scale.set(sx, Math.max(1e-4, 1.1 - vE.y), 1);
      fanRoot.position.set(vF.x, vF.y, 0);
      fanRoot.scale.set(sx, sy, 1);
      throughRoot.position.set(vE.x, vE.y, 0);
      throughRoot.scale.set(sx, Math.max(1e-4, vE.y - vF.y), 1);
      overlay.render(renderer);
    },
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
