// ============================================================================
// NODE-NAME VOCABULARY: the ONE place that SPELLS a model node name the site
// refers to more than once. `parts.ts` is the one place that knows what a name
// MEANS; this is the one place that knows how it is SPELLED. Keeping the two
// apart is what makes a model-side rename a one-line edit here instead of a
// scavenger hunt through predicates, story tables and test fixtures.
//
// WHY IT EXISTS. Node names are the API with the lens_work/ Blender pipeline,
// and that pipeline renames things: `Optics_Baffle_Front` → `Baffle_Front`,
// `Mount_ScrewBores` → `Mount_ScrewCounterbores` (MIGRATION STEP 4b), then
// `Cam_OpticsCage` → `OpticsCage`, `Optics_Cell_G3` → `Cell_G3` and four more
// (MIGRATION "Misnomer renames"). Each drop the same six-or-seven names had to
// be chased through a `parts.ts` regex, a `peelcards.ts` table key and two test
// fixtures — four spellings of one fact, and a missed one fails SILENTLY
// (a table key that matches no node just does nothing). lens_work solved its
// own half of this with one `BARE_PARTS` table the routers derive from; this is
// the site's half.
//
// WHAT BELONGS HERE: a name the site spells in TWO OR MORE places — typically
// once in a `parts.ts` predicate and once as a key of a `story/peelcards.ts`
// departure table. A name used in exactly ONE place stays where it is used;
// hoisting it would only add a hop.
//
// GREPPABILITY. Every `PART` key is the camelCase mirror of its own value, so a
// case-insensitive grep for the node name still finds every site that uses it:
// `grep -ri opticscage src/` reaches this file, the tables that key on it and
// the tests that pin it.
// ============================================================================

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

/** THE PEEL'S THIRD CAST, IN DEPARTURE ORDER — the closed inner tubes and the
 *  cladding under them (`core/parts.ts` `isPeelTube`), which is also the key
 *  order of `story/peelcards.ts`'s `TUBE_CUT`: outside-in by seated radius, each
 *  layer uncovering the next. THE ORDER IS THE ANIMATION — re-sorting this list
 *  re-sorts the teardown. `story/__tests__/peelcards.test.ts` pins
 *  `TUBE_FAMILY_ORDER` against it, so a table that drifts out of step with this
 *  roster fails there rather than as a wedge leaving on the wrong beat. */
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

/** The three metal CELLS that hold the rear optics — a family in their own
 *  right since MIGRATION's misnomer drop gave them a shared stem (they were
 *  `Optics_Cell_G3` / `Optics_CellCollar` / `Optics_CellFlange`, which is why
 *  `/^Optics_Cell/` used to be a usable family test). All three are also
 *  PEEL_TUBES; this is the narrower slice the silhouette LOD hides. */
export const CELL_PARTS: readonly string[] = [
  PART.cellG3,
  PART.cellCollar,
  PART.cellFlange,
];

/** THE PEEL'S SECOND CAST, IN DEPARTURE ORDER — the two optics light traps that
 *  leave with the peel (`core/parts.ts` `isPeelExtra`, `BAFFLE_EXIT`'s key
 *  order). Deliberately NOT the whole `Baffle_` family: the rear plate is in the
 *  keep-set, and a prefix test here would drag it out with them. */
export const PEEL_BAFFLES: readonly string[] = [
  PART.baffleFront,
  PART.baffleG2,
];

/** The rear aperture plate — the baffle that STAYS, with the rest of the back
 *  (`core/parts.ts` `isPeelKeep`; owner: "a bit too much is coming off of the
 *  back part"). Named on its own precisely because it is the exception. */
export const BAFFLE_KEEP: string = PART.baffleRear;

/** THE PEEL'S FOURTH CAST — the unsegmented singles that leave on their own
 *  windows (`core/parts.ts` `isPeelRest`, `SINGLE_EXIT`'s key order). */
export const PEEL_SINGLES: readonly string[] = [PART.camFollowers];

/** A `^`-ANCHORED prefix test over a roster: matches a listed part AND its
 *  `_SegN` wedges (which carry the part's name with a suffix), and nothing else.
 *
 *  THE ANCHOR IS LOAD-BEARING. The misnomer drop turned prefixed names into BARE
 *  stems — `Cam_OpticsCage` → `OpticsCage`, `Cam_RearTube` → `RearTube` — and an
 *  unanchored test that was safe while every alternative carried a family prefix
 *  can match the middle of some unrelated name once they do not. Building the
 *  regex here means no caller can forget the `^`.
 *
 *  No escaping: model node names are `[A-Za-z0-9_]` by the pipeline's own
 *  convention, so there is nothing in a roster for a regex to misread. */
export const prefixRe = (names: readonly string[]): RegExp =>
  new RegExp(`^(${names.join("|")})`);
