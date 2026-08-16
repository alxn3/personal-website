// ============================================================================
// Part-name classification: the ONE place that knows what a model node name
// MEANS. Object names are the API with the lens_work/ Blender pipeline (do not
// rename); these predicates give each name-pattern test a
// single, documented home so consumers can't drift into subtly different
// regexes. The sets below are DELIBERATELY different from each other — each
// doc comment states the semantic, so keep them distinct on purpose.
//
// How a name is SPELLED is `core/names.ts`'s business, not this file's: the
// rosters a predicate shares with a `story/peelcards.ts` departure table live
// there so a model-side rename touches one line. What a match MEANS still lives
// here, in the doc comments.
// ============================================================================

import { PART_CLASS } from "../ops/ops";
import {
  BAFFLE_KEEP,
  PEEL_BAFFLES,
  PEEL_SINGLES,
  PEEL_TUBES,
  prefixRe,
} from "./names";

// Built once, not per call: every predicate below runs per mesh, per load.
const PEEL_TUBE_RE = prefixRe(PEEL_TUBES);
const PEEL_BAFFLE_RE = prefixRe(PEEL_BAFFLES);
const PEEL_SINGLE_RE = prefixRe(PEEL_SINGLES);

/** True optical glass only — the 13 lens elements and the accessory UV filter.
 *  NOT the iris blades: they're metal, and an earlier `Iris_` prefix match
 *  mis-styled them as glass (the bug that motivated this module). */
export const isOpticalGlass = (name: string): boolean =>
  /^Element_|^Acc_Filter_Glass$/.test(name);

/** The optical elements alone (no filter glass) — the light path the
 *  refraction rays thread. */
export const isGlassElement = (name: string): boolean => /^Element_/.test(name);

/** Removable accessories (hood, caps, UV filter) — excluded from the bare-lens
 *  bounding box and the teardown. */
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

/** A PURE-IDENTITY GRAPH GROUP (`Grp_*`) — an empty that tidies the node graph
 *  and nothing else. lens_work MIGRATION STEP 5 added `Grp_FocusDrive` and
 *  `Grp_MountRear`: both export with no translation/rotation/scale key at all,
 *  and — unlike the five real re-parents that shipped with them — their members
 *  KEEP their own explode rungs. So every ancestor walk that reads a name as a
 *  part identity (ops/frames `nameChain` for the ladder group, dev/inspect's
 *  hover label) must step straight past them; without the skip, nine parts
 *  collapse onto two rungs. Naming, not geometry: a `Grp_` node carries no mesh,
 *  so nothing gated on class or visibility ever sees one. */
export const isGraphGroup = (name: string): boolean => name.startsWith("Grp_");

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

/** THE PEEL'S SECOND CAST — the two OPTICS light traps, which leave with the
 *  peel and return with it, but are NOT shell: `Baffle_Front` (y ≈ 50.3)
 *  and `Baffle_G2` (y ≈ 54.8), each cut into the same five sectors as
 *  the shell. (`Baffle_Rear`, the rear aperture plate at the mount face, is in
 *  the KEEP-set with the rest of the back — owner's call.)
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
 *  included, exactly as isShellPart is.
 *
 *  NAMED PAIR, NOT THE `Baffle_` PREFIX: lens_work MIGRATION STEP 4b unified the
 *  three plates under one prefix (`Optics_Baffle_Front` → `Baffle_Front`,
 *  `Optics_Baffle_G2` → `Baffle_G2`, `Baffle_Rear` unchanged), so a prefix test
 *  here would silently drag the rear plate out of the KEEP-set and undo the
 *  owner's "a bit too much is coming off of the back part" ruling. The two are
 *  spelled out for exactly that reason. */
export const isPeelExtra = (name: string): boolean => PEEL_BAFFLE_RE.test(name);

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
 *  scoped to the outer rank band (ops/recipes peel, rankLo 0.97) and these sit
 *  below it — `Chassis_Fixed` at rank 0.9377 and `Cam_Barrel` at 0.8927-0.9190,
 *  MEASURED off the shipped model's baked `_opA.w` — which is exactly what keeps
 *  the inner structure seated while the skin curls. Their departure is rigid,
 *  like the baffles'. (`Cam_Barrel`'s band INTERLEAVES with `Barrel_Inner`'s
 *  0.8827-0.8997, a shell family whose median radius sits inside the cladding —
 *  ops/recipes carries the whole measured table and what follows from it.)
 *
 *  AND THE INNER CLADDING GOES WITH THEM — `OpticsCage` (r ≈ 22,
 *  y 17.5-55.7, covers elements 03-06) and the sleeves around 07-13:
 *  `Cell_G3`, `Cell_Collar`, `Cell_Flange` and
 *  `LightTrap` (r ≈ 9-14). An earlier pass kept the cage as "mechanism,
 *  not cladding"; the owner overruled it twice — the card scene's subject is
 *  the BARE GLASS COLUMN, and these were the last layers hiding it. All are
 *  wedge-cut (5 or 7 segs) and take the same rigid radial departure. What
 *  STAYS is the working mechanism itself: the iris assembly, the focus train
 *  (`Optics_G4_Focus` carries a moving element), the mount and the PCB.
 *
 *  Matched on the piece's OWN name, `_SegN` wedges included, as both casts above
 *  are. `Chassis_Fixed` ADOPTS `Focus_Motor`/`Focus_GuideRods` as children
 *  (ops/frames.ts) — they carry their own names, so they are not matched here
 *  and stay behind with the rest of the mechanism.
 *
 *  THE ROSTER IS `core/names.ts` `PEEL_TUBES`, which is also `peelcards.ts`'s
 *  `TUBE_CUT` key set: this cast is the one place where the predicate and a
 *  departure table have to agree piece for piece, since a part that matches here
 *  but has no `TUBE_CUT` row would fade with the tubes and never drift out. The
 *  cells used to be matched by an `Optics_Cell` STEM rather than by name, which
 *  left exactly that gap open. */
export const isPeelTube = (name: string): boolean => PEEL_TUBE_RE.test(name);

/** THE PEEL'S KEEP-SET — the card scene's subject, stated as a WHITELIST
 *  (owner: "maybe we should whitelist instead of blacklist? We want to keep
 *  the parts that make up the back like the connector and the glass elements
 *  and aperture assembly"): the glass, the iris assembly, and the whole rear
 *  connector block (mount, contacts, PCB, the rear tube and the shim rings —
 *  the back keeps its rings; owner: "a bit too much is coming off of the back
 *  part"). Everything else that is not an
 *  accessory leaves during the cards/internals span — the fourth cast below
 *  sweeps up whatever the named casts miss, and the partition test asserts
 *  the five casts + this keep-set cover the model exactly. */
export const isPeelKeep = (name: string): boolean =>
  /^(Element_|Iris_(Blade_|ActuatorGear)|Mount_|PCB_|Shim_Ring_|Focus_)/.test(
    name,
  ) || name.startsWith(BAFFLE_KEEP);

/** THE PEEL'S FOURTH CAST — the REST: every mesh the whitelist leaves out that
 *  no other cast names. Successive owner rulings have moved almost all of it
 *  into the keep-set or onto the tube roster, and the roster this reads
 *  (`core/names.ts` PEEL_SINGLES) is now a single name — `Cam_Followers`, the
 *  followers riding the cam barrel's slots, which have nothing left to ride once
 *  the barrel goes. It hides with the interior (the tubes' fade channel) and
 *  RETURNS over the fly-through's approach with it — the dive flies through the
 *  full interior (owner: "don't remove the back elements that are part of the
 *  fly-through transition"); only the shell and the baffles stay off until the
 *  rewrap. */
export const isPeelRest = (name: string): boolean => PEEL_SINGLE_RE.test(name);

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
