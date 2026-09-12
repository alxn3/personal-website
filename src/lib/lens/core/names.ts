// Node-name vocabulary: the one place a model node name used more than once is
// spelled (`parts.ts` owns what a name means). Every `PART` key is the
// camelCase mirror of its value.

/** The node names this module owns, keyed by the camelCase mirror of the name.
 *  Change a name here and the predicates, tables and tests all follow. */
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
 *  cladding under them, outside-in by seated radius. The order is the
 *  animation, and `story/peelcards.ts`'s `TUBE_CUT` must keep the same order. */
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
 *  that leave with the peel (`BAFFLE_EXIT`'s key order). Not the whole
 *  `Baffle_` family: the rear plate is in the keep-set. */
export const PEEL_BAFFLES: readonly string[] = [
  PART.baffleFront,
  PART.baffleG2,
];

/** The rear aperture plate — the one baffle that stays, with the rest of the
 *  back (`parts.ts` `isPeelKeep`). */
export const BAFFLE_KEEP: string = PART.baffleRear;

/** The peel's fourth cast — the unsegmented singles that leave on their own
 *  windows (`parts.ts` `isPeelRest`, `SINGLE_EXIT`'s key order). */
export const PEEL_SINGLES: readonly string[] = [PART.camFollowers];

/** A `^`-anchored prefix test over a roster: matches a listed part and its
 *  `_SegN` wedges, and nothing else. The anchor is load-bearing — several node
 *  names are bare stems, so an unanchored test can match mid-name. */
export const prefixRe = (names: readonly string[]): RegExp =>
  new RegExp(`^(${names.join("|")})`);
