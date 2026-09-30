// What each model node name means. Spellings live in names.ts. Mesh names
// equal node names (one primitive per mesh in the web GLBs).

import { PART_CLASS } from "../ops/ops";
import {
  BAFFLE_KEEP,
  PEEL_BAFFLES,
  PEEL_SINGLES,
  PEEL_TUBES,
  prefixRe,
} from "./names";

const PEEL_TUBE_RE = prefixRe(PEEL_TUBES);
const PEEL_BAFFLE_RE = prefixRe(PEEL_BAFFLES);
const PEEL_SINGLE_RE = prefixRe(PEEL_SINGLES);

/** Lens elements and the UV filter glass. */
export const isOpticalGlass = (name: string): boolean =>
  /^Element_|^Acc_Filter_Glass$/.test(name);

/** Lens elements only (no filter glass). */
export const isGlassElement = (name: string): boolean => /^Element_/.test(name);

/** Removable accessories (hood, caps, UV filter). */
export const isAccessory = (name: string): boolean => name.startsWith("Acc_");

/** Printed markings (focal scale, name ring, badge); matches mid-name. */
export const isDecal = (name: string): boolean => /Decal/.test(name);

/** Iris parts moved by the aperture (not `Iris_Housing`). */
export const isIrisMechanism = (name: string): boolean =>
  /^Iris_(Blade_|CamPlate|ActuatorGear$)/.test(name);

/** A shell segment sub-mesh (`<Part>_SegN`); deformed in the shader only. */
export const isSegWedge = (name: string): boolean => /_Seg\d+$/.test(name);

/** An organising empty (`Grp_*`) with no transform or mesh. Ancestor walks
 *  that look for a part's name must skip these. */
export const isGraphGroup = (name: string): boolean => name.startsWith("Grp_");

/** Outer shell (first to leave in the peel): barrel, name band, grips and
 *  markings. Anchored so `Shim_Ring_*` and `Mount_BrassRing` don't match. */
export const isShellPart = (name: string): boolean =>
  /^(Barrel_|Band_Mid|Ring_)/.test(name) || isDecal(name);

/** The baffles that leave in the peel (not the rear plate). */
export const isPeelExtra = (name: string): boolean => PEEL_BAFFLE_RE.test(name);

/** Inner tubes that leave in the peel (PEEL_TUBES, which must match
 *  peelcards.ts's `TUBE_CUT` keys). */
export const isPeelTube = (name: string): boolean => PEEL_TUBE_RE.test(name);

/** Parts that stay through the peel: glass, iris and the rear mount block. */
export const isPeelKeep = (name: string): boolean =>
  /^(Element_|Iris_(Blade_|ActuatorGear)|Mount_|PCB_|Shim_Ring_|Focus_)/.test(
    name,
  ) || name.startsWith(BAFFLE_KEEP);

/** Single parts that leave in the peel (PEEL_SINGLES). */
export const isPeelRest = (name: string): boolean => PEEL_SINGLE_RE.test(name);

/** The ops `PART_CLASS` id for a node name; first match wins. */
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
