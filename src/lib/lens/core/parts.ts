// Part-name classification: the ONE place that knows what a model node name
// MEANS. Node names are the API with the lens_work/ Blender pipeline (do not
// rename). The sets below are DELIBERATELY different from each other — each
// doc comment states its semantic, so keep them distinct on purpose.
//
// How a name is SPELLED is `core/names.ts`'s business, not this file's.

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
 *  NOT the iris blades: they are metal. */
export const isOpticalGlass = (name: string): boolean =>
  /^Element_|^Acc_Filter_Glass$/.test(name);

/** The optical elements alone (no filter glass) — the light path the
 *  refraction rays thread. */
export const isGlassElement = (name: string): boolean => /^Element_/.test(name);

/** Removable accessories (hood, caps, UV filter) — excluded from the bare-lens
 *  bounding box and the teardown. */
export const isAccessory = (name: string): boolean => name.startsWith("Acc_");

/** Printed markings (focal scale, name ring, badge…). Unanchored on purpose,
 *  so it matches every `Decal*`/`DecalT_*` family name. */
export const isDecal = (name: string): boolean => /Decal/.test(name);

/** The iris MECHANISM: the moving parts ops/mechanism.ts drives by aperture
 *  (blades, cam plate, actuator gear). Deliberately NOT `Iris_Housing` — that
 *  is a segmented shell that blooms and wraps like any other. `CamPlate` is
 *  unanchored so its `_SegN` wedges match here too; `ActuatorGear` is anchored
 *  because it has none. */
export const isIrisMechanism = (name: string): boolean =>
  /^Iris_(Blade_|CamPlate|ActuatorGear$)/.test(name);

/** A shell wedge sub-mesh (`<Part>_SegN`) — deforms in-shader through the op
 *  deform host, so object-space rigs must leave it alone. */
export const isSegWedge = (name: string): boolean => /_Seg\d+$/.test(name);

/** A PURE-IDENTITY GRAPH GROUP (`Grp_*`) — an empty that tidies the node graph
 *  and nothing else, carrying no transform and no mesh. SKIP LAW: every
 *  ancestor walk that reads a name as a part identity (ops/frames `nameChain`,
 *  dev/inspect's hover label) must step past them, or their members collapse
 *  onto one explode rung. */
export const isGraphGroup = (name: string): boolean => name.startsWith("Grp_");

/** THE PEEL'S FIRST CAST — the lens's OUTER SKIN, which leaves with the peel
 *  and returns in the rewrap: the barrel sections, the exterior name band, the
 *  two control grips and every printed marking painted on one of them.
 *
 *  The `^` anchors are load-bearing: they keep `Shim_Ring_*` and
 *  `Mount_BrassRing` out. Matched on a piece's OWN name, `_SegN` wedges
 *  included, so no parent walk is needed. */
export const isShellPart = (name: string): boolean =>
  /^(Barrel_|Band_Mid|Ring_)/.test(name) || isDecal(name);

/** THE PEEL'S SECOND CAST — the two optics light traps that leave with the
 *  peel but are NOT shell. Their motion is a rigid staggered departure
 *  (story/peelcards.ts), not the shell's unroll; what they share with the shell
 *  is the visibility gate, on their own late band of scene.ts's shell fade.
 *
 *  A NAMED PAIR, not the `Baffle_` prefix: the rear aperture plate shares that
 *  prefix and belongs to the keep-set, so a prefix test would drag it out. */
export const isPeelExtra = (name: string): boolean => PEEL_BAFFLE_RE.test(name);

/** THE PEEL'S THIRD CAST — the closed inner tubes the skin was wrapped around
 *  and the cladding under them, leaving on their own beat between the skin and
 *  the bore. Their departure is rigid, not an unroll: the peel recipe is scoped
 *  to the outer rank band and these sit below it, which is what keeps the inner
 *  structure seated while the skin curls.
 *
 *  THE ROSTER IS `names.ts` PEEL_TUBES, which is also `peelcards.ts`'s
 *  `TUBE_CUT` key set — the predicate and the departure table must agree piece
 *  for piece, since a part matching here with no `TUBE_CUT` row would fade and
 *  never drift out. Matched on the piece's OWN name, `_SegN` wedges included;
 *  `Chassis_Fixed`'s adopted `Focus_*` children carry their own names and so
 *  stay behind. */
export const isPeelTube = (name: string): boolean => PEEL_TUBE_RE.test(name);

/** THE PEEL'S KEEP-SET — the card scene's subject, stated as a WHITELIST: the
 *  glass, the iris assembly and the whole rear connector block. Everything
 *  else that is not an accessory leaves over the cards/internals span; the
 *  partition test asserts the casts plus this keep-set cover the model
 *  exactly. */
export const isPeelKeep = (name: string): boolean =>
  /^(Element_|Iris_(Blade_|ActuatorGear)|Mount_|PCB_|Shim_Ring_|Focus_)/.test(
    name,
  ) || name.startsWith(BAFFLE_KEEP);

/** THE PEEL'S FOURTH CAST — the unsegmented singles no other cast names
 *  (`names.ts` PEEL_SINGLES). They hide on the tubes' fade channel and RETURN
 *  over the fly-through's approach with it, since the dive passes through the
 *  full interior; only the shell and the baffles stay off until the rewrap. */
export const isPeelRest = (name: string): boolean => PEEL_SINGLE_RE.test(name);

/** The ops `PART_CLASS` id a node name belongs to — the ONE bridge from these
 *  predicates to the integer `ops/ops.ts` selectors match on, baked per piece
 *  into the frame attributes by `ops/frames.ts`. THE ORDER OF THE TESTS IS THE
 *  CLASSIFICATION: glass, then the iris mechanism (narrower than `/^Iris_/` on
 *  purpose, so the housing falls through to STRUCTURE and wraps with the rest),
 *  then decals, then accessories (so `Acc_Filter_Glass` is an ACCESSORY and its
 *  glass look is shading.ts's business), then the KEEP-set — the mechanism the
 *  cards scene reveals in place, which recipes scope themselves off. Everything
 *  else is structure. */
export const partClassOf = (name: string): number =>
  isGlassElement(name)
    ? PART_CLASS.glass
    : isIrisMechanism(name)
      ? PART_CLASS.iris
      : isDecal(name)
        ? PART_CLASS.decal
        : isAccessory(name)
          ? PART_CLASS.accessory
          : isPeelKeep(name)
            ? PART_CLASS.kept
            : PART_CLASS.structure;

// RUNTIME NAME = NODE NAME: the web GLBs carry no materials, so the exporter
// emits one primitive per mesh and GLTFLoader names every mesh after its node.
// Every predicate above is handed `mesh.name` directly.
