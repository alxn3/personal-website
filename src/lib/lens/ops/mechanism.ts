import * as THREE from "three/webgpu";
import { deg } from "../core/math";
import { opsSpinBox, tagOpsSpin } from "./host";

// ============================================================================
// THE MECHANISM — the measured, real-lens motions and nothing else: zoom,
// focus, aperture. Every constant follows lens_work/lens_mechanism.md (the
// animation contract written against the real Blender model), not an invented
// approximation. Object names are the API (do not rename); the group empties
// (Optics_G2..G4, Iris_Housing, Barrel_Inner) are the drive targets, and their
// child elements and iris blades ride along.
//
// WHAT LIVES HERE vs WHAT LIVES IN THE OP PIPELINE: this module owns only the
// motions a real lens performs — ring throws, the element slides they drive,
// the lead screw's spin, the iris sweep. The TEARDOWN (the explode ladder, the
// reassembly, the peel/curl deformations) is owned by the
// op recipes and runs IN-SHADER off derived per-piece frames (ops/frames.ts,
// ops/recipes.ts). Keeping the two apart is what stops the explode slider being
// driven twice — once in object space and once in the shader.
//
// The one seam: the focus lead screw is wrapped in a pivot at its own centre so
// it can spin about ITS OWN axis instead of orbiting the lens. That pivot is
// built here (it is focus's doing), but it no longer MOVES on explode — the
// screw's radial/axial teardown participation comes from its derived frame
// through the recipes, like every other piece.
//
// That seam has a shader half, `tagMechanismSpins` below: the screw's op delta
// is added INSIDE the pivot's rotation, so the deform host has to un-spin it or
// the exploded rod orbits its seated position instead of spinning in place. The
// screw is the ONLY node that needs it — every other rotation here (both rings,
// the cam barrel, the blades, the cam plate, the actuator gear) turns about the
// OPTICAL axis, which is the same axis the op frames are built about, so seat
// and displacement rotate together and the piece just turns as a whole.
// ============================================================================

/** The node whose ±FOCUS_MM slide IS the focus travel: L4 (Element_12) rides
 *  the Optics_G4_Focus empty, exactly as the Blender rig drives it. */
const FOCUS_NODE = "Optics_G4_Focus";
/** The off-axis rod the focus motor turns; wrapped in a pivot at load. */
const SCREW_NODE = "Focus_LeadScrew";

/**
 * Every measured number the mechanism runs on, in ONE table.
 *
 * `zoomRingRad` (§1): MEASURED by the owner from photo IMG_5368 — the zoom
 * marks sit at 0/16.2/30.8/44.9/76.6° from "18" (non-uniform cam; 35→50 is the
 * long stretch), so a full-zoom throw of -76.6° lands "50" on the index. This
 * supersedes the earlier -46° uniform-spacing estimate. Cam_Barrel is pinned
 * 1:1 to it.
 *
 * `focusMm` (§2): a flat ±1.5mm exactly as the Blender rig drives it
 * (rig_lens.py: '1.5*f'), NEVER amplified. (A web-only ×12 gain was tried to
 * make the slide read from a distance; the owner reverted it 2026-07-16 — it
 * overshot wildly at max focus. The subtle 1.5mm slide is authentic; the ring
 * turn and the lead screw's ~1.4 revs carry the visible motion.) `focusRingRad`
 * is by-wire, so any mapping is authentic. `screwDegPerMm` (§2) is the STM lead
 * screw's 327.3°/mm (= 360/1.1 pitch) of element travel — ~1.36 revs over the
 * real throw.
 *
 * `irisCloseDeg` (§3) is build_iris.py's calibrated blade sweep; never exceed
 * ~30. `camPlateDeg`/`actuatorGearDeg` (§3b) are the internals-v2 aperture
 * chain — pinion → toothed lug → cam plate → grooves → blade pins — both about
 * the optical axis on the same eased law as the blades, the actuator gear
 * turning opposite (its gear ratio to the plate lug) and further.
 */
export const MECHANISM: {
  zoomRingRad: number;
  zoomMm: Record<string, number>;
  focusRingRad: number;
  focusMm: number;
  screwDegPerMm: number;
  irisCloseDeg: number;
  camPlateDeg: number;
  actuatorGearDeg: number;
} = {
  zoomRingRad: deg(-76.6),
  zoomMm: {
    Barrel_Inner: 26, // MEASURED
    Optics_G2: 17,
    Optics_G3: 11,
    Iris_Housing: 14, // keeps the stop between G2/G3; blades ride as children
  },
  focusRingRad: deg(60),
  focusMm: 1.5,
  screwDegPerMm: 327.3,
  irisCloseDeg: 25.3,
  camPlateDeg: 12,
  actuatorGearDeg: -92,
};

/** The eased-aperture law (lens_mechanism.md §3b): the blades' own sweep is
 *  linear in the channel, but the drive chain ahead of them (cam plate,
 *  actuator gear) runs on e = 0.4a + 0.6a². */
const apertureEase = (a: number) => 0.4 * a + 0.6 * a * a;

/** Every part name the mechanism drives, for the model-contract tripwire
 *  (dev/model-contract.ts): a lens_work re-export that renames or drops one
 *  should fail loudly at boot instead of silently no-op'ing here. */
export const MECHANISM_PARTS: readonly string[] = [
  "Ring_Zoom",
  "Ring_Focus",
  "Cam_Barrel",
  ...Object.keys(MECHANISM.zoomMm),
  FOCUS_NODE,
  SCREW_NODE,
  ...Array.from(
    { length: 7 },
    (_, i) => `Iris_Blade_${String(i + 1).padStart(2, "0")}`,
  ),
  "Iris_CamPlate",
  "Iris_ActuatorGear",
];

/** One frame's mechanism inputs — the EASED 0..1 channel values (core/scene
 *  owns the easing, and `zoom` additionally arrives pre-smoothstepped: the ONE
 *  shared zoom ease, never applied per-channel or the guts desynchronize). */
export interface MechanismDrive {
  /** 0 (18mm, retracted) .. 1 (50mm, extended) */
  zoom: number;
  /** 0 (infinity) .. 1 (min focus, ~0.12m) */
  focus: number;
  /** 0 (f/2.8, wide open) .. 1 (f/22, closed down) */
  aperture: number;
}

/**
 * Tag the meshes that ride an OFF-AXIS spin pivot with the uniform the deform
 * host un-spins their op delta by (ops/host.ts `tagOpsSpin` — the whole
 * argument is there). Only the focus lead screw qualifies; see the header.
 *
 * MUST RUN BEFORE THE MATERIALS ARE BUILT, which is why it is split out of
 * `createMechanism` (that one waits for the recentre): the counter-rotation is
 * baked into the node graph, so a tag arriving after the materials are built
 * (materials/unified.ts's createUnified) would do nothing. core/scene.ts's
 * `prepareModelMaterials` is the one caller.
 */
export function tagMechanismSpins(root: THREE.Object3D): void {
  const screw = root.getObjectByName(SCREW_NODE);
  if (screw) tagOpsSpin(screw);
}

/**
 * Resolve every driven node and build the per-frame mechanism drive. Call
 * AFTER the model is recentred — the lead-screw pivot math reads world
 * positions. Missing nodes (a part lens_work hasn't modeled) are simply not
 * driven; every use site guards.
 */
export function createMechanism(root: THREE.Object3D): {
  update(d: MechanismDrive): void;
} {
  const node = (name: string) => root.getObjectByName(name);

  // A node this file turns about the optical axis. The driven angle is COMPOSED
  // onto the SEAT rotation the GLB authored on the node, captured once here.
  //
  // Neither half of that is ceremony, and both are scars:
  //
  //  • ADDITIVE, not absolute. Parts usually arrive at identity — their seat is
  //    baked into their vertices — which makes `rotation.y = drive` look
  //    equivalent. It is not: when the seven iris blades briefly shipped as one
  //    shared datablock carrying their 51.4° fan as node quaternions, an
  //    absolute write ERASED the fan on the first frame and stacked all seven
  //    on blade 1's meridian. (N.12 baked the fan back into the vertices, so
  //    every seat is identity again today and this is numerically the absolute
  //    write — see lens_work MIGRATION §9.)
  //  • QUATERNIONS, not `rotation.y`. `Object3D.rotation` is an XYZ Euler, and a
  //    pure-Y rotation past 90° decomposes as x = z = π with y = π − θ. Adding
  //    a drive to THAT `y` turns the part the wrong way — which is exactly how
  //    four of the seven blades swept mirrored while the fan lived on the nodes.
  //    Composing quaternions never decomposes anything, so the whole class is
  //    gone regardless of which side of the export a seat lands on next.
  const AXIS = new THREE.Vector3(0, 1, 0);
  const drive = new THREE.Quaternion();
  interface Driven {
    obj: THREE.Object3D;
    rest: THREE.Quaternion;
  }
  const driven = (obj: THREE.Object3D | undefined): Driven | null =>
    obj ? { obj, rest: obj.quaternion.clone() } : null;
  const turn = (d: Driven | null, rad: number): void => {
    if (d)
      d.obj.quaternion.multiplyQuaternions(
        d.rest,
        drive.setFromAxisAngle(AXIS, rad),
      );
  };

  const ringZoom = driven(node("Ring_Zoom"));
  const ringFocus = driven(node("Ring_Focus"));
  // The helical cam barrel is pinned 1:1 to the zoom ring (rotates with it); it
  // reads as the internal mechanism turning as the teardown fans the shells apart.
  const camBarrel = driven(node("Cam_Barrel"));

  const irisBlades: Driven[] = [];
  for (let i = 1; i <= 7; i++) {
    const blade = driven(node(`Iris_Blade_${String(i).padStart(2, "0")}`));
    // Blade overlap/z-fight is solved IN THE MODEL: each blade is baked with a
    // 0.5° tilt about its pivot's radial axis (build_iris.py B.4 — a JS z-ladder
    // was tried and rejected; it reads wrong from the back). Nothing to do here.
    if (blade) irisBlades.push(blade);
  }
  // Iris drive parts (internals-v2): children of Iris_Housing, so they ride its
  // zoom slide through the hierarchy — only their aperture rotation is driven
  // here, exactly like the blades.
  const irisCamPlate = driven(node("Iris_CamPlate"));
  const irisActuatorGear = driven(node("Iris_ActuatorGear"));

  // Every node driven by a position channel, with its contribution from each
  // source. Resolved once here; summed each frame. The group empties sit at the
  // origin of their parent (geometry is baked in place), so the sum IS the
  // node's position — no base to add.
  const posNames = new Set([...Object.keys(MECHANISM.zoomMm), FOCUS_NODE]);
  const posRiders = [...posNames]
    .map((name) => ({ obj: node(name), name }))
    .filter((e): e is { obj: THREE.Object3D; name: string } => Boolean(e.obj))
    .map(({ obj, name }) => ({
      obj,
      zoom: MECHANISM.zoomMm[name] ?? 0,
      focus: name === FOCUS_NODE ? MECHANISM.focusMm : 0,
    }));

  // Focus lead screw: an off-axis rod. Wrap it in a pivot at its own centre so
  // it can spin about ITS OWN axis with focus rather than orbiting the lens.
  const screw = node(SCREW_NODE);
  // The shader half of that pivot: the box `tagMechanismSpins` stamped on the
  // screw's meshes before their materials were built. update() writes the
  // pivot's angle into it and the deform host un-spins the op delta by it, so an
  // EXPLODED screw spins about its displaced axis instead of orbiting its seat.
  const screwSpin = screw ? opsSpinBox(screw) : null;
  const screwPivot = (() => {
    if (!screw) return null;
    const worldC = new THREE.Vector3();
    new THREE.Box3().setFromObject(screw).getCenter(worldC);
    // The pivot is INSERTED between the screw and whatever already held it, so
    // the axis is measured in THAT parent's space — the space both the pivot's
    // position and the screw's own then live in. Since lens_work MIGRATION
    // STEP 5 the parent is really `Grp_FocusDrive` rather than the model root
    // (identity, so the two agree today); reading the holder rather than the
    // root is what keeps that true if a group empty ever carries a transform.
    const holder = screw.parent ?? root;
    holder.updateWorldMatrix(true, false);
    const c = holder.worldToLocal(worldC.clone());
    const pivot = new THREE.Group();
    pivot.name = "Focus_LeadScrew_Pivot";
    pivot.position.copy(c);
    holder.add(pivot);
    pivot.add(screw);
    screw.position.sub(c); // keep the screw geometry where it was
    return pivot;
  })();

  function update({ zoom, focus, aperture }: MechanismDrive) {
    // Axial slides: zoom extends the barrel/optics groups along the optical
    // axis (Y in the gltf frame), focus slides L4's empty. Both are model mm.
    for (const r of posRiders)
      r.obj.position.set(0, zoom * r.zoom + focus * r.focus, 0);

    turn(ringZoom, zoom * MECHANISM.zoomRingRad);
    // Cam barrel is pinned 1:1 to the zoom ring — same angle, same sign.
    turn(camBarrel, zoom * MECHANISM.zoomRingRad);
    turn(ringFocus, focus * MECHANISM.focusRingRad);

    // Lead screw spins about its own axis with focus — 327.3°/mm of the
    // authentic element travel, ~1.4 revolutions over the full throw (plainly
    // visible even though the element's own 1.5mm slide is subtle).
    if (screwPivot) {
      const spin = deg(MECHANISM.screwDegPerMm * focus * MECHANISM.focusMm);
      screwPivot.rotation.y = spin;
      // The SAME angle to the deform host — see screwSpin above.
      if (screwSpin) screwSpin.value = spin;
    }

    // The sweep is the SAME angle for every blade — their 51.4° spacing is the
    // seat `turn` preserves, not something this drive re-derives.
    const closeRad = deg(MECHANISM.irisCloseDeg * aperture);
    for (const blade of irisBlades) turn(blade, closeRad);
    const apEase = apertureEase(aperture);
    turn(irisCamPlate, deg(MECHANISM.camPlateDeg * apEase));
    turn(irisActuatorGear, deg(MECHANISM.actuatorGearDeg * apEase));
  }

  return { update };
}
