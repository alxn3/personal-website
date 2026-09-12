import * as THREE from "three/webgpu";
import { deg } from "../core/math";
import { opsSpinBox, tagOpsSpin } from "./host";

// THE MECHANISM — the real-lens motions only: zoom, focus, aperture, as object
// transforms (constants per lens_work/lens_mechanism.md). Object names are the
// API; the group empties (Optics_G2..G4, Iris_Housing, Barrel_Inner) are the
// drive targets. The teardown is the op recipes', in-shader. One seam: the
// focus lead screw spins about its own pivot, so its op delta lands inside that
// rotation and the deform host un-spins it (`tagMechanismSpins`).

/** The node whose ±FOCUS_MM slide IS the focus travel: L4 (Element_12) rides
 *  the Optics_G4_Focus empty, exactly as the Blender rig drives it. */
const FOCUS_NODE = "Optics_G4_Focus";
/** The off-axis rod the focus motor turns; wrapped in a pivot at load. */
const SCREW_NODE = "Focus_LeadScrew";

/**
 * Every number the mechanism runs on, in ONE table; they come from lens_work's
 * lens_mechanism.md. `focusMm` is what the Blender rig drives — never amplify
 * it. `irisCloseDeg` is the calibrated blade sweep; never exceed ~30.
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
  // axial air. NOT a real-lens motion — driven only by the story's huddle
  // channel, 0 everywhere else.
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

/** Every part name the mechanism drives, for dev/model-contract.ts's tripwire
 *  on a re-export that renames or drops one. */
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
 *  pre-smoothstepped: ONE shared ease, never applied per-channel. */
export interface MechanismDrive {
  /** 0 (18mm, retracted) .. 1 (50mm, extended) */
  zoom: number;
  /** 0 (infinity) .. 1 (min focus, ~0.12m) */
  focus: number;
  /** 0 (f/2.8, wide open) .. 1 (f/22, closed down) */
  aperture: number;
  /** 0 (seated anatomy) .. 1 (bare core drawn compact) — story-only */
  huddle: number;
}

/**
 * Tag the meshes that ride an OFF-AXIS spin pivot with the uniform the deform
 * host un-spins their op delta by; only the focus lead screw qualifies.
 * MUST RUN BEFORE THE MATERIALS ARE BUILT — the counter-rotation is a baked
 * node, so a later tag does nothing.
 */
export function tagMechanismSpins(root: THREE.Object3D): void {
  const screw = root.getObjectByName(SCREW_NODE);
  if (screw) tagOpsSpin(screw);
}

/**
 * Resolve every driven node and build the per-frame mechanism drive. Call AFTER
 * the model is recentred — the lead-screw pivot math reads world positions.
 * Missing nodes are simply not driven.
 */
export function createMechanism(root: THREE.Object3D): {
  update(d: MechanismDrive): void;
} {
  const node = (name: string) => root.getObjectByName(name);

  // A node this file turns about the optical axis. The driven angle is COMPOSED
  // onto the GLB's seat rotation, captured once here — additive, so a node
  // quaternion seat survives, and via QUATERNIONS because `Object3D.rotation`
  // is an XYZ Euler whose `y` flips sign past 90°.
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
    // Blade overlap/z-fight is a baked per-blade tilt in the model.
    if (blade) irisBlades.push(blade);
  }
  // Iris drive parts: children of Iris_Housing, so they ride its zoom slide
  // through the hierarchy — only their aperture rotation is driven here.
  const irisCamPlate = driven(node("Iris_CamPlate"));
  const irisActuatorGear = driven(node("Iris_ActuatorGear"));

  // Every node driven by a position channel, resolved once and summed each
  // frame ON TOP of the node's own seat, so a holder carrying a transform
  // keeps it.
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
  // The shader half of that pivot: update() writes the pivot angle here and the
  // deform host un-spins the op delta by it.
  const screwSpin = screw ? opsSpinBox(screw) : null;
  const screwPivot = (() => {
    if (!screw) return null;
    const worldC = new THREE.Vector3();
    new THREE.Box3().setFromObject(screw).getCenter(worldC);
    // The pivot is INSERTED between the screw and its holder, so the centre
    // must be measured in THAT parent's space, not the root's.
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
    // Axial slides along the optical axis (Y in the gltf frame), model mm,
    // summed onto the node's own seat.
    for (const r of posRiders)
      r.obj.position.set(
        r.base.x,
        r.base.y + zoom * r.zoom + focus * r.focus + huddle * r.huddle,
        r.base.z,
      );

    turn(ringZoom, zoom * MECHANISM.zoomRingRad);
    turn(camBarrel, zoom * MECHANISM.zoomRingRad);
    turn(ringFocus, focus * MECHANISM.focusRingRad);

    // The lead screw spins about its own axis with focus.
    if (screwPivot) {
      const spin = deg(MECHANISM.screwDegPerMm * focus * MECHANISM.focusMm);
      screwPivot.rotation.y = spin;
      // The SAME angle to the deform host.
      if (screwSpin) screwSpin.value = spin;
    }

    // The SAME angle for every blade — their fan spacing is the seat `turn`
    // preserves.
    const closeRad = deg(MECHANISM.irisCloseDeg * aperture);
    for (const blade of irisBlades) turn(blade, closeRad);
    const apEase = apertureEase(aperture);
    turn(irisCamPlate, deg(MECHANISM.camPlateDeg * apEase));
    turn(irisActuatorGear, deg(MECHANISM.actuatorGearDeg * apEase));
  }

  return { update };
}
