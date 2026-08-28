import * as THREE from "three/webgpu";
import { deg } from "../core/math";
import { opsSpinBox, tagOpsSpin } from "./host";

// THE MECHANISM — the real-lens motions and nothing else: zoom, focus,
// aperture. Constants follow lens_work/lens_mechanism.md. Object names are the
// API (do not rename); the group empties (Optics_G2..G4, Iris_Housing,
// Barrel_Inner) are the drive targets and their children ride along.
//
// The TEARDOWN (explode ladder, reassembly, peel/curl) is owned by the op
// recipes and runs IN-SHADER off derived per-piece frames. Keeping the two
// apart is what stops a channel being driven twice — once in object space and
// once in the shader.
//
// The one seam: the focus lead screw is wrapped in a pivot at its own centre so
// it can spin about ITS OWN axis instead of orbiting the lens. Its shader half
// is `tagMechanismSpins` below — the screw's op delta is added INSIDE the
// pivot's rotation, so the deform host has to un-spin it. The screw is the ONLY
// node that needs it: every other rotation here turns about the OPTICAL axis,
// the same axis the op frames are built about, so seat and displacement rotate
// together.

/** The node whose ±FOCUS_MM slide IS the focus travel: L4 (Element_12) rides
 *  the Optics_G4_Focus empty, exactly as the Blender rig drives it. */
const FOCUS_NODE = "Optics_G4_Focus";
/** The off-axis rod the focus motor turns; wrapped in a pivot at load. */
const SCREW_NODE = "Focus_LeadScrew";

/**
 * Every number the mechanism runs on, in ONE table; lens_work's
 * lens_mechanism.md is where each one comes from. `focusMm` is exactly what the
 * Blender rig drives and is NEVER amplified — the ring turn and the lead
 * screw's revolutions carry the visible motion. `irisCloseDeg` is the
 * calibrated blade sweep; never exceed ~30. `camPlateDeg`/`actuatorGearDeg`
 * drive the aperture chain about the optical axis on the same eased law as the
 * blades, the gear turning opposite the plate and further.
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
  huddleMm: Record<string, number>;
} = {
  zoomRingRad: deg(-76.6),
  zoomMm: {
    Barrel_Inner: 26,
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
  // THE HUDDLE, mm at channel 1 (+ = frontward): the bare core closes its own
  // axial air — the mount block and the focus drive step toward the stop, the
  // rear glass follows, the front pair drops back — so the cards scene turns a
  // compact lens rather than the strung-out anatomy the departed barrel used
  // to bridge. NOT a real-lens motion: driven only by the story's huddle
  // channel, 0 everywhere else, so /lens never sees it.
  huddleMm: {
    Grp_MountRear: 26,
    Grp_FocusDrive: 16,
    Optics_G4_Focus: 8,
    Barrel_Inner: -10,
  },
};

/** The blades' sweep is linear in the channel, but the drive chain ahead of
 *  them (cam plate, actuator gear) runs on this ease. */
const apertureEase = (a: number) => 0.4 * a + 0.6 * a * a;

/** Every part name the mechanism drives, for dev/model-contract.ts's tripwire:
 *  a re-export that renames or drops one must fail loudly, not silently
 *  no-op. */
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

/** One frame's mechanism inputs — the EASED 0..1 channel values. `zoom` arrives
 *  pre-smoothstepped: ONE shared zoom ease, never applied per-channel or the
 *  guts desynchronize. */
export interface MechanismDrive {
  /** 0 (18mm, retracted) .. 1 (50mm, extended) */
  zoom: number;
  /** 0 (infinity) .. 1 (min focus, ~0.12m) */
  focus: number;
  /** 0 (f/2.8, wide open) .. 1 (f/22, closed down) */
  aperture: number;
  /** 0 (seated anatomy) .. 1 (the bare core drawn compact) — the story's
   *  cards-chapter channel, not a real-lens motion */
  huddle: number;
}

/**
 * Tag the meshes that ride an OFF-AXIS spin pivot with the uniform the deform
 * host un-spins their op delta by (ops/host.ts `tagOpsSpin`); only the focus
 * lead screw qualifies. MUST RUN BEFORE THE MATERIALS ARE BUILT — the
 * counter-rotation is a baked node, so a later tag would do nothing.
 * core/scene.ts's `prepareModelMaterials` is the one caller.
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
  //  • ADDITIVE, not absolute: `rotation.y = drive` would ERASE any seat a node
  //    carries as a node quaternion rather than baked into its vertices, and
  //    which side of the export a seat lands on is not this file's to assume.
  //  • QUATERNIONS, not `rotation.y`: `Object3D.rotation` is an XYZ Euler, and
  //    a pure-Y rotation past 90° decomposes as x = z = π with y = π − θ, so
  //    adding a drive to THAT `y` turns the part the wrong way.
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
  // The helical cam barrel is pinned 1:1 to the zoom ring.
  const camBarrel = driven(node("Cam_Barrel"));

  const irisBlades: Driven[] = [];
  for (let i = 1; i <= 7; i++) {
    const blade = driven(node(`Iris_Blade_${String(i).padStart(2, "0")}`));
    // Blade overlap/z-fight is solved IN THE MODEL (a baked per-blade tilt
    // about its pivot's radial axis), so there is nothing to do here.
    if (blade) irisBlades.push(blade);
  }
  // Iris drive parts: children of Iris_Housing, so they ride its zoom slide
  // through the hierarchy — only their aperture rotation is driven here.
  const irisCamPlate = driven(node("Iris_CamPlate"));
  const irisActuatorGear = driven(node("Iris_ActuatorGear"));

  // Every node driven by a position channel, resolved once and summed each
  // frame ON TOP of the node's own seat: the shipped group empties are
  // identity, but a holder that carries a transform must keep it (the
  // shipped-glb guard drives this through a translated empty).
  const posNames = new Set([
    ...Object.keys(MECHANISM.zoomMm),
    ...Object.keys(MECHANISM.huddleMm),
    FOCUS_NODE,
  ]);
  const posRiders = [...posNames]
    .map((name) => ({ obj: node(name), name }))
    .filter((e): e is { obj: THREE.Object3D; name: string } => Boolean(e.obj))
    .map(({ obj, name }) => ({
      obj,
      base: obj.position.clone(),
      zoom: MECHANISM.zoomMm[name] ?? 0,
      focus: name === FOCUS_NODE ? MECHANISM.focusMm : 0,
      huddle: MECHANISM.huddleMm[name] ?? 0,
    }));

  // Focus lead screw: an off-axis rod. Wrap it in a pivot at its own centre so
  // it can spin about ITS OWN axis with focus rather than orbiting the lens.
  const screw = node(SCREW_NODE);
  // The shader half of that pivot: update() writes the pivot's angle into the
  // box `tagMechanismSpins` stamped on the screw's meshes, and the deform host
  // un-spins the op delta by it.
  const screwSpin = screw ? opsSpinBox(screw) : null;
  const screwPivot = (() => {
    if (!screw) return null;
    const worldC = new THREE.Vector3();
    new THREE.Box3().setFromObject(screw).getCenter(worldC);
    // The pivot is INSERTED between the screw and whatever already held it, so
    // the axis must be measured in THAT parent's space, not the root's — which
    // stays correct if a group empty ever carries a transform.
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

  function update({ zoom, focus, aperture, huddle }: MechanismDrive) {
    // Axial slides: zoom extends the barrel/optics groups along the optical
    // axis (Y in the gltf frame), focus slides L4's empty, the huddle draws the
    // bare core compact. All model mm, summed onto the node's own seat.
    for (const r of posRiders)
      r.obj.position.set(
        r.base.x,
        r.base.y + zoom * r.zoom + focus * r.focus + huddle * r.huddle,
        r.base.z,
      );

    turn(ringZoom, zoom * MECHANISM.zoomRingRad);
    // Cam barrel is pinned 1:1 to the zoom ring — same angle, same sign.
    turn(camBarrel, zoom * MECHANISM.zoomRingRad);
    turn(ringFocus, focus * MECHANISM.focusRingRad);

    // The lead screw spins about its own axis with focus, several revolutions
    // over the full throw — the visible half of a subtle element slide.
    if (screwPivot) {
      const spin = deg(MECHANISM.screwDegPerMm * focus * MECHANISM.focusMm);
      screwPivot.rotation.y = spin;
      // The SAME angle to the deform host — see screwSpin above.
      if (screwSpin) screwSpin.value = spin;
    }

    // The sweep is the SAME angle for every blade — their fan spacing is the
    // seat `turn` preserves, not something this drive re-derives.
    const closeRad = deg(MECHANISM.irisCloseDeg * aperture);
    for (const blade of irisBlades) turn(blade, closeRad);
    const apEase = apertureEase(aperture);
    turn(irisCamPlate, deg(MECHANISM.camPlateDeg * apEase));
    turn(irisActuatorGear, deg(MECHANISM.actuatorGearDeg * apEase));
  }

  return { update };
}
