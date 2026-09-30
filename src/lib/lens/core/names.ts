// Model node names used in more than one place. parts.ts says what they mean.

/** Node names, keyed by their camelCase form. */
export const PART = {
  // inner tubes
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
  // baffles
  baffleFront: "Baffle_Front",
  baffleG2: "Baffle_G2",
  baffleRear: "Baffle_Rear",
  camFollowers: "Cam_Followers",
} as const;

/** Inner tubes, in the order they leave during the peel (outside in). Must
 *  match the key order of `TUBE_CUT` in story/peelcards.ts. */
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

/** The three metal cells that hold the rear optics (a subset of PEEL_TUBES). */
export const CELL_PARTS: readonly string[] = [
  PART.cellG3,
  PART.cellCollar,
  PART.cellFlange,
];

/** Baffles that leave during the peel, in order (`BAFFLE_EXIT`'s key order). */
export const PEEL_BAFFLES: readonly string[] = [
  PART.baffleFront,
  PART.baffleG2,
];

/** The rear aperture plate: the one baffle that stays through the peel. */
export const BAFFLE_KEEP: string = PART.baffleRear;

/** Single parts that leave during the peel (`SINGLE_EXIT`'s key order). */
export const PEEL_SINGLES: readonly string[] = [PART.camFollowers];

/** Regex matching any name that starts with one of `names` (so `_SegN`
 *  sub-meshes match too). Anchored so a stem can't match mid-name. */
export const prefixRe = (names: readonly string[]): RegExp =>
  new RegExp(`^(${names.join("|")})`);
