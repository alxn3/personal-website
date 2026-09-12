// Part-name classification: the one place that knows what a model node name
// means. How a name is spelled is `core/names.ts`'s business.

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

/** True optical glass only — the lens elements and the accessory UV filter.
 *  Not the iris blades: they are metal. */
export const isOpticalGlass = (name: string): boolean =>
  /^Element_|^Acc_Filter_Glass$/.test(name);

/** The optical elements alone (no filter glass) — the light path the
 *  refraction rays thread. */
export const isGlassElement = (name: string): boolean => /^Element_/.test(name);

/** Removable accessories (hood, caps, UV filter) — excluded from the bare-lens
 *  bounding box and the teardown. */
export const isAccessory = (name: string): boolean => name.startsWith("Acc_");

/** Printed markings (focal scale, name ring, badge…). Unanchored so it matches
 *  every `Decal*`/`DecalT_*` family name. */
export const isDecal = (name: string): boolean => /Decal/.test(name);

/** The iris mechanism: the parts ops/mechanism.ts drives by aperture. Excludes
 *  `Iris_Housing`, which is a segmented shell that blooms and wraps. */
export const isIrisMechanism = (name: string): boolean =>
  /^Iris_(Blade_|CamPlate|ActuatorGear$)/.test(name);

/** A shell wedge sub-mesh (`<Part>_SegN`) — deforms in-shader through the op
 *  deform host, so object-space rigs must leave it alone. */
export const isSegWedge = (name: string): boolean => /_Seg\d+$/.test(name);

/** A pure-identity graph group (`Grp_*`): an empty carrying no transform and no
 *  mesh. Skip law: every ancestor walk that reads a name as a part identity
 *  must step past them, or their members collapse onto one explode rung. */
export const isGraphGroup = (name: string): boolean => name.startsWith("Grp_");

/** The peel's first cast — the lens's outer skin: barrel sections, exterior
 *  name band, control grips and printed markings.
 *
 *  The `^` anchors are load-bearing: they keep `Shim_Ring_*` and
 *  `Mount_BrassRing` out. Matched on a piece's own name, `_SegN` wedges
 *  included, so no parent walk is needed. */
export const isShellPart = (name: string): boolean =>
  /^(Barrel_|Band_Mid|Ring_)/.test(name) || isDecal(name);

/** The peel's second cast — the two optics light traps that leave with the
 *  peel but are not shell. A named pair, not the `Baffle_` prefix: the rear
 *  aperture plate shares that prefix and belongs to the keep-set. */
export const isPeelExtra = (name: string): boolean => PEEL_BAFFLE_RE.test(name);

/** The peel's third cast — the closed inner tubes and the cladding under them.
 *
 *  The roster is `names.ts` PEEL_TUBES, which is also `peelcards.ts`'s
 *  `TUBE_CUT` key set: the predicate and the departure table must agree piece
 *  for piece, or a part matching here with no `TUBE_CUT` row would fade and
 *  never drift out. Matched on the piece's own name, `_SegN` wedges included. */
export const isPeelTube = (name: string): boolean => PEEL_TUBE_RE.test(name);

/** The peel's keep-set — the card scene's subject as a whitelist: the glass,
 *  the iris assembly and the rear connector block. Everything else that is not
 *  an accessory leaves over the cards/internals span. */
export const isPeelKeep = (name: string): boolean =>
  /^(Element_|Iris_(Blade_|ActuatorGear)|Mount_|PCB_|Shim_Ring_|Focus_)/.test(
    name,
  ) || name.startsWith(BAFFLE_KEEP);

/** The peel's fourth cast — the unsegmented singles no other cast names. They
 *  hide on the tubes' fade channel and return with it over the fly-through's
 *  approach; only the shell and the baffles stay off until the rewrap. */
export const isPeelRest = (name: string): boolean => PEEL_SINGLE_RE.test(name);

/** The ops `PART_CLASS` id a node name belongs to — the bridge from these
 *  predicates to the integer selectors, baked per piece by `ops/frames.ts`.
 *  The order of the tests is the classification; everything unmatched is
 *  structure. */
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

// Runtime name = node name: the web GLBs carry no materials, so one primitive
// per mesh and GLTFLoader names every mesh after its node.
