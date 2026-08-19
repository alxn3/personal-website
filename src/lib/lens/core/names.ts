// NODE-NAME VOCABULARY: the ONE place a model node name the site refers to
// more than once is SPELLED. `parts.ts` is the one place a name's MEANING
// lives; keeping the two apart makes a Blender-side rename a one-line edit
// here. A name used in exactly ONE place stays where it is used.
//
// Every `PART` key is the camelCase mirror of its value, so a case-insensitive
// grep for a node name still reaches this file and every user of it.

/** The node names this module owns, keyed by the camelCase mirror of the name.
 *  Change a name HERE and the predicates, tables and tests all follow. */
export const PART = {
  // the peel's third cast: the closed tubes and the cladding inside them
  chassisFixed: "Chassis_Fixed",
  camBarrel: "Cam_Barrel",
  opticsCage: "OpticsCage",
  lightTrap: "LightTrap",
  cellFlange: "Cell_Flange",
  cellCollar: "Cell_Collar",
  cellG3: "Cell_G3",
  rearTube: "RearTube",
  irisHousing: "Iris_Housing",
  irisCamPlate: "Iris_CamPlate",
  // the baffle family
  baffleFront: "Baffle_Front",
  baffleG2: "Baffle_G2",
  baffleRear: "Baffle_Rear",
  // the peel's fourth cast
  camFollowers: "Cam_Followers",
} as const;

/** The peel's third cast, in DEPARTURE ORDER — the closed inner tubes and the
 *  cladding under them (`parts.ts` `isPeelTube`), outside-in by seated radius.
 *  THE ORDER IS THE ANIMATION: re-sorting this list re-sorts the teardown, and
 *  `story/peelcards.ts`'s `TUBE_CUT` must keep the same key order. */
export const PEEL_TUBES: readonly string[] = [
  PART.chassisFixed,
  PART.camBarrel,
  PART.opticsCage,
  PART.lightTrap,
  PART.cellFlange,
  PART.cellCollar,
  PART.cellG3,
  PART.rearTube,
  PART.irisHousing,
  PART.irisCamPlate,
];

/** The three metal cells that hold the rear optics. All three are also
 *  PEEL_TUBES; this is the narrower slice the silhouette LOD hides. */
export const CELL_PARTS: readonly string[] = [
  PART.cellG3,
  PART.cellCollar,
  PART.cellFlange,
];

/** The peel's second cast, in departure order — the two optics light traps
 *  that leave with the peel (`parts.ts` `isPeelExtra`, `BAFFLE_EXIT`'s key
 *  order). Deliberately NOT the whole `Baffle_` family: the rear plate is in
 *  the keep-set, and a prefix test here would drag it out with them. */
export const PEEL_BAFFLES: readonly string[] = [
  PART.baffleFront,
  PART.baffleG2,
];

/** The rear aperture plate — the one baffle that STAYS, with the rest of the
 *  back (`parts.ts` `isPeelKeep`). Named on its own as the exception. */
export const BAFFLE_KEEP: string = PART.baffleRear;

/** The peel's fourth cast — the unsegmented singles that leave on their own
 *  windows (`parts.ts` `isPeelRest`, `SINGLE_EXIT`'s key order). */
export const PEEL_SINGLES: readonly string[] = [PART.camFollowers];

/** A `^`-ANCHORED prefix test over a roster: matches a listed part and its
 *  `_SegN` wedges, and nothing else. The anchor is load-bearing — several node
 *  names are bare stems, so an unanchored test can match mid-name. Building
 *  the regex here means no caller can forget it. No escaping needed: node
 *  names are `[A-Za-z0-9_]` by pipeline convention. */
export const prefixRe = (names: readonly string[]): RegExp =>
  new RegExp(`^(${names.join("|")})`);
