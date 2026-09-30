import * as THREE from "three/webgpu";
import { deg } from "../core/math";
import { opsSpinBox, tagOpsSpin } from "./host";

// The lens mechanism: zoom, focus and aperture (plus the story's huddle) as
// object transforms on named nodes. Constants come from
// lens_work/lens_mechanism.md.

/** The node that slides for focus. */
const FOCUS_NODE = "Optics_G4_Focus";
/** The off-axis rod the focus motor turns; given its own pivot at load. */
const SCREW_NODE = "Focus_LeadScrew";

/** Mechanism constants. `focusMm` matches the Blender rig; `irisCloseDeg`
 *  must stay under ~30. */
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
    Iris_Housing: 14, // keeps the stop between G2 and G3
  },
  focusRingRad: deg(60),
  focusMm: 1.5,
  screwDegPerMm: 327.3,
  irisCloseDeg: 25.3,
  camPlateDeg: 12,
  actuatorGearDeg: -92,
  // Story-only: mm each part moves at huddle = 1 (+ = forward), closing the
  // gaps in the bare core.
  huddleMm: {
    Grp_MountRear: 26,
    Grp_FocusDrive: 16,
    Optics_G4_Focus: 8,
    Barrel_Inner: -10,
  },
};

/** Ease for the cam plate and actuator gear (the blades themselves are linear). */
const apertureEase = (a: number) => 0.4 * a + 0.6 * a * a;

/** Every part the mechanism drives (checked by dev/model-contract.ts). */
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

/** One frame's eased 0..1 mechanism inputs. */
export interface MechanismDrive {
  /** 0 (18mm, retracted) .. 1 (50mm, extended) */
  zoom: number;
  /** 0 (infinity) .. 1 (min focus, ~0.12m) */
  focus: number;
  /** 0 (f/2.8, wide open) .. 1 (f/22, closed down) */
  aperture: number;
  /** 0 (seated) .. 1 (bare core drawn together); story only */
  huddle: number;
}

/** Tag the focus lead screw as a spin pivot for the deform (host.ts
 *  `tagOpsSpin`). Must run before materials are built. */
export function tagMechanismSpins(root: THREE.Object3D): void {
  const screw = root.getObjectByName(SCREW_NODE);
  if (screw) tagOpsSpin(screw);
}

/** Find the driven nodes and return the per-frame `update`. Call after the
 *  model is recentred (the screw pivot uses world positions). Missing nodes are
 *  skipped. */
export function createMechanism(root: THREE.Object3D): {
  update(d: MechanismDrive): void;
} {
  const node = (name: string) => root.getObjectByName(name);

  // Turn a node about the optical axis on top of its rest rotation. Uses
  // quaternions, since Euler `rotation.y` flips sign past 90°.
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
  // The cam barrel turns with the zoom ring.
  const camBarrel = driven(node("Cam_Barrel"));

  const irisBlades: Driven[] = [];
  for (let i = 1; i <= 7; i++) {
    const blade = driven(node(`Iris_Blade_${String(i).padStart(2, "0")}`));
    if (blade) irisBlades.push(blade);
  }
  // Children of Iris_Housing, so they follow its zoom slide automatically.
  const irisCamPlate = driven(node("Iris_CamPlate"));
  const irisActuatorGear = driven(node("Iris_ActuatorGear"));

  // Nodes that slide along the axis, offset from their rest position.
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

  // Wrap the off-axis lead screw in a pivot at its own centre so it spins in
  // place rather than orbiting the lens.
  const screw = node(SCREW_NODE);
  // The deform undoes the same spin on the screw's op delta.
  const screwSpin = screw ? opsSpinBox(screw) : null;
  const screwPivot = (() => {
    if (!screw) return null;
    const worldC = new THREE.Vector3();
    new THREE.Box3().setFromObject(screw).getCenter(worldC);
    // The pivot goes between the screw and its parent, so use the parent's space.
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
    for (const r of posRiders)
      r.obj.position.set(
        r.base.x,
        r.base.y + zoom * r.zoom + focus * r.focus + huddle * r.huddle,
        r.base.z,
      );

    turn(ringZoom, zoom * MECHANISM.zoomRingRad);
    turn(camBarrel, zoom * MECHANISM.zoomRingRad);
    turn(ringFocus, focus * MECHANISM.focusRingRad);

    if (screwPivot) {
      const spin = deg(MECHANISM.screwDegPerMm * focus * MECHANISM.focusMm);
      screwPivot.rotation.y = spin;
      if (screwSpin) screwSpin.value = spin;
    }

    // Every blade turns by the same angle from its own rest.
    const closeRad = deg(MECHANISM.irisCloseDeg * aperture);
    for (const blade of irisBlades) turn(blade, closeRad);
    const apEase = apertureEase(aperture);
    turn(irisCamPlate, deg(MECHANISM.camPlateDeg * apEase));
    turn(irisActuatorGear, deg(MECHANISM.actuatorGearDeg * apEase));
  }

  return { update };
}
