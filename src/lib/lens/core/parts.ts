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

/** THE PEEL'S CAST — what leaves with the shell and returns in the rewrap.
 *  The lens's OUTER SKIN: the barrel sections (`Barrel_Base`, `Barrel_Inner`),
 *  the exterior name band (`Band_Mid`), the two control grips (`Ring_Focus`,
 *  `Ring_Zoom`) and every printed marking, which is painted ON one of those and
 *  must leave with it.
 *
 *  Drawn from the SHIPPED GEOMETRY, not from intuition: those families are the
 *  only ones that reach the outer radius (r ≈ 30.2-30.8 mm, and between them
 *  they skin the whole length y ≈ 1-77). The next layer in — `Chassis_Fixed` at
 *  29.4, `Cam_Barrel` at 28.6 — is covered end to end and never sees daylight,
 *  so it is not SKIN; it leaves anyway, one beat later, as the peel's third cast
 *  (isPeelTube). Everything mechanical stays — glass, iris, focus, cams, mount,
 *  PCB, optics cells and the accessories.
 *
 *  `Shim_Ring_*` is NOT a control ring — the anchor is what keeps it (and
 *  `Mount_BrassRing`) out, so the `^` is load-bearing rather than decorative.
 *
 *  Matched on a piece's OWN name, `_SegN` wedges included: a wedge carries its
 *  part's name with a suffix, so the prefixes cover them without a parent walk. */
export const isShellPart = (name: string): boolean =>
  /^(Barrel_|Band_Mid|Ring_)/.test(name) || isDecal(name);

/** THE PEEL'S SECOND CAST — the internal light-trap baffles, which leave with
 *  the peel and return with it, but are NOT shell: `Baffle_Rear` (the rear
 *  aperture plate, y ≈ −1.6) and the two optics traps `Optics_Baffle_Front`
 *  (y ≈ 50.3) and `Optics_Baffle_G2` (y ≈ 54.8), each cut into the same five
 *  sectors as the shell.
 *
 *  WHY THEY GO. With the skin off, the card scene looks down a lens whose BORE
 *  is the subject — and these three plates are exactly what closes it: the rear
 *  one caps the tube end and the two front ones stop the sight-line short of the
 *  glass. They are structure, so nothing about them classes as shell; but they
 *  are also not part of the mechanism the internals scene is about, so they may
 *  leave once the skin has.
 *
 *  They cannot ride the sheet recipe with the shell — they sit at r ≈ 12-16mm,
 *  far below the peel's outer rank band, and their motion is a rigid staggered
 *  departure (story/peelcards.ts) rather than an unroll. What they SHARE with the
 *  shell is the visibility gate: core/scene.ts's shell fade takes this predicate
 *  as well, in its own late band, so they wink out after the skin and are
 *  restored by the same rewrap. Matched on the piece's OWN name, `_SegN` wedges
 *  included, exactly as isShellPart is. */
export const isPeelExtra = (name: string): boolean =>
  /^(Baffle_|Optics_Baffle_)/.test(name);

/** THE PEEL'S THIRD CAST — the two CLOSED INNER TUBES the skin was wrapped
 *  around: `Chassis_Fixed` (r ≈ 29.4, y ≈ 1.5-65) and `Cam_Barrel` (r ≈ 28.6,
 *  y ≈ 14-56). Between them they run nearly the whole barrel with no window in
 *  either, so with only the shell off the card scene still looks at a lens that
 *  is a solid cylinder from the side: the glass column, the iris and the focus
 *  mechanism are all sealed inside two more layers of tube.
 *
 *  So they leave too, in their OWN beat between the skin and the bore: shell
 *  wedges, then these, then the baffles (core/scene's four-band shell fade, and
 *  the drift windows in story/peelcards.ts that feed it). Outside-in — which is
 *  the order the layers are actually stacked in, and the only order in which
 *  each one uncovers the next.
 *
 *  Each is cut into wedges on its own seam count — five for `Chassis_Fixed`
 *  (the shell's own cut) and seven for `Cam_Barrel` — so they fly out radially
 *  like strips rather than sliding out of an end like a baffle plate. They
 *  cannot ride the peel RECIPE with the shell even so: the sticker unroll is
 *  scoped to the outer rank band (ops/recipes peel, rankLo 0.93) and these sit
 *  below it at rank ≈ 0.919, which is exactly what keeps the inner structure
 *  seated while the skin curls. Their departure is rigid, like the baffles'.
 *
 *  WHERE THIS STOPS, and why it is not one family further in. `Cam_OpticsCage`
 *  (r ≈ 22, y 17.5-55.7) is the next closed layer and was tried here: it takes
 *  the body away without buying the glass. The elements it covers are 03-06,
 *  and 07-13 are wrapped in their own `Optics_Cell_G3`/`Cam_LightTrap` at
 *  r ≈ 9-14 either way — so the column stays as hidden as before while the lens
 *  loses the cam slots that are the last thing making it read as a lens rather
 *  than as a mount ring with glass in front of it. The cage is mechanism, not
 *  cladding; it stays.
 *
 *  Matched on the piece's OWN name, `_SegN` wedges included, as both casts above
 *  are. `Chassis_Fixed` ADOPTS `Focus_Motor`/`Focus_GuideRods` as children
 *  (ops/frames.ts) — they carry their own names, so they are not matched here
 *  and stay behind with the rest of the mechanism. */
export const isPeelTube = (name: string): boolean =>
  /^(Chassis_Fixed|Cam_Barrel)/.test(name);

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
