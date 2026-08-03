// ============================================================================
// Part-name classification: the ONE place that knows what a model node name
// MEANS. Object names are the API with the lens_work/ Blender pipeline (do not
// rename); these predicates give each name-pattern test a
// single, documented home so consumers can't drift into subtly different
// regexes. The sets below are DELIBERATELY different from each other — each
// doc comment states the semantic, so keep them distinct on purpose.
// ============================================================================

import { PART_CLASS } from "../ops/ops";

/** True optical glass only — the 13 lens elements and the accessory UV filter.
 *  NOT the iris blades: they're metal, and an earlier `Iris_` prefix match
 *  mis-styled them as glass (the bug that motivated this module). */
export const isOpticalGlass = (name: string): boolean =>
  /^Element_|^Acc_Filter_Glass$/.test(name);

/** The OPTICS isolate group (`/lens` Demos → "optics"): the true glass PLUS the
 *  whole iris assembly — the light path and the mechanism that shapes it. Wider
 *  than isOpticalGlass on purpose. Nothing to do with materials any more: the
 *  web GLBs ship bare geometry (lens_work MIGRATION §1) and core/model.ts
 *  authors every look site-side, glass and blades included. */
export const isOpticsIsolate = (name: string): boolean =>
  /^(Element|Iris)_|^Acc_Filter_Glass$/.test(name);

/** The optical elements alone (no filter glass) — the light path the
 *  refraction rays thread and the isolate preserves. */
export const isGlassElement = (name: string): boolean => /^Element_/.test(name);

/** Removable accessories (hood, caps, UV filter) — excluded from the bare-lens
 *  bounding box, the teardown, and the isolate. */
export const isAccessory = (name: string): boolean => name.startsWith("Acc_");

/** Printed markings (focal scale, name ring, badge…). Unanchored on purpose:
 *  matches every `Decal*`/`DecalT_*` family name the same way the ink
 *  edge-line skip always has. */
export const isDecal = (name: string): boolean => /Decal/.test(name);

/** The iris MECHANISM: the moving parts ops/mechanism.ts drives by aperture (the
 *  seven blades, the cam plate, the actuator gear). Deliberately NOT
 *  `Iris_Housing` — the housing is a segmented shell that blooms and wraps like
 *  every other shell, and lumping it in here parked it out of the assemble
 *  wrap.
 *
 *  `CamPlate` is deliberately UNANCHORED while `ActuatorGear` is not: the cam
 *  plate is a segmented part, so it also owns `Iris_CamPlate_Seg0..6` wedges.
 *  Those wedges already class as `iris` — ops/frames.ts `classOf` walks up to
 *  the parent — so the old `CamPlate$` anchor was not keeping them out, it was
 *  only hiding from this module where the decision was really made. Matching
 *  them here changes no behaviour and restores the invariant that this file is
 *  the ONE place that knows what a name means. */
export const isIrisMechanism = (name: string): boolean =>
  /^Iris_(Blade_|CamPlate|ActuatorGear$)/.test(name);

/** A shell wedge sub-mesh (`<Part>_SegN`) — deforms in-shader through the op
 *  deform host, so object-space rigs must leave it alone. */
export const isSegWedge = (name: string): boolean => /_Seg\d+$/.test(name);

/** "Greeble" detail hidden at the SILHOUETTE detail level (LOD phase 1 —
 *  core/scene setIsolate("silhouette")): the small mechanical clutter that
 *  reads as noise at illustration scale — screws & mount hardware, electrical
 *  contacts/encoder, decals/plates, the iris MECHANISM (blades, cam plate,
 *  actuator gear — but NOT the iris HOUSING shell), the PCB,
 *  baffles, shim rings, the focus lead-screw/motor/guide-rods/carrier/arms, the
 *  optics element cells/collars/flanges, and stray cam followers. NOT hidden
 *  (they draw the lens silhouette): the barrel/cam SHELL wedges, the major
 *  rings, the iris housing shell, and the glass elements. Still checked up the
 *  ANCESTOR chain by the isolate, because a greeble's `_SegN` wedges carry the
 *  part's name with a suffix rather than classifying on their own.
 *  Accessories are left to the isolate's per-mesh snapshot, not matched here. */
export const isSilhouetteGreeble = (name: string): boolean =>
  isDecal(name) ||
  /^(Baffle_|Optics_Baffle_|PCB_|Shim_Ring_)/.test(name) ||
  /^Mount_(Screws|FlangeScrews|ScrewBores|Notch|Contacts|ContactShelf|EncoderStrip)/.test(
    name,
  ) ||
  /^Iris_(Blade_|CamPlate|ActuatorGear)/.test(name) ||
  /^Focus_(LeadScrew|Motor|GuideRods|Carrier|Arms)/.test(name) ||
  /^Optics_Cell/.test(name) ||
  name.startsWith("Cam_Followers");

/** The ops `PART_CLASS` id a node name belongs to — the ONE bridge from these
 *  name predicates to the integer `ops/ops.ts` selectors match on (`selClass`),
 *  written per piece into the packed frame attributes by `ops/frames.ts`. The order
 *  of the tests IS the classification: glass first (an `Element_` is never
 *  anything else), then the iris MECHANISM only (blades/cam plate/gear — metal,
 *  not glass, and driven by aperture rather than by the op pipeline). The class
 *  is deliberately NARROWER than the `Iris_` prefix: `Iris_Housing` and its
 *  `_SegN` wedges are a segmented shell like any other and fall through to
 *  STRUCTURE, so they wrap with the rest of the model — a wider `/^Iris_/` here
 *  silently parked the housing out of the assemble sheet. Then printed markings,
 *  then removable accessories (so `Acc_Filter_Glass` classes as an ACCESSORY: it
 *  comes off with the filter, and its glass shading is shading.ts's business,
 *  not a selector's). Everything else is structure. */
export const partClassOf = (name: string): number =>
  isGlassElement(name)
    ? PART_CLASS.glass
    : isIrisMechanism(name)
      ? PART_CLASS.iris
      : isDecal(name)
        ? PART_CLASS.decal
        : isAccessory(name)
          ? PART_CLASS.accessory
          : PART_CLASS.structure;

// RUNTIME NAME = NODE NAME. The web GLBs carry no materials, so the exporter
// emits exactly ONE primitive per mesh and GLTFLoader gives every node a single
// THREE.Mesh named after the node (lens_work MIGRATION §2). The old
// `authoredNameOf` / `hasPrimitiveSplitNames` pair — which resolved a
// multi-primitive node's `Cylinder012`, `Cylinder012_1` children back to
// `Focus_LeadScrew` — is gone with the split that produced it; every predicate
// above is handed `mesh.name` directly. Blender mesh DATABLOCKS are now
// `<node>_geo` (§3) and never surface at runtime.
