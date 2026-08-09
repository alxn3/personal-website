// ============================================================================
// THE PEEL AND THE CARD FIELD — the story's shell-into-cards handoff, one module
// because it is ONE gesture: the shell peels off like a sticker (each wedge's
// freed run curling back on itself, ops/house stickerPeelOps), the curled strips
// drift away sector by sector, the two closed tubes under them and then the
// internal baffles follow them out — so the light path is bare from the side and
// the bore is open end-on — and eight billboard cards fade in over the lot
// mid-flight. Nothing else may own half of it.
//
// TWO CLOCKS, ON PURPOSE.
//   • SCROLL (frame(p), called from hero-driver's scroll rAF): the unroll (the
//     `peel` channel), the per-wedge outward drift, and the card cross-fade
//     WINDOWS. Every one is a pure function of the story position, so a scrub in
//     either direction lands on exactly the same pose.
//   • TIME (scene.onFrame): the cards' orbit and their opacity uniforms. The
//     orbit reads an ACCUMULATED dt clamped to 100ms, never performance.now()
//     itself — the hero stops rendering when the canvas leaves the viewport
//     (SceneHandle.setPaused) and a law keyed to absolute time would teleport the
//     field across the gap (story/internals.ts's doctrine, same reason).
//
// ONE WRITER PER THING. This module is the only writer of the `peel` channel and
// the only caller of setPartOffset on the homepage, so the two clocks cannot
// fight: the scroll side owns the channel and the offsets, the time side owns
// only the overlay's own uniforms.
//
// THE 2D LAW (the house rule: only the lens model reads 3D). A card is a
// view-space billboard — its centre goes through modelViewMatrix and the corners
// are added in VIEW space before the projection, so the quad is always exactly
// parallel to the film plane and never tilts into perspective. It is the
// starfield's vertexNode (optics/starfield.ts starMark) reduced to one quad per
// mesh with the centre in a uniform instead of an attribute.
//
// PLAIN TRANSPARENCY, NOT THE STARFIELD'S BLEND CONTRACT. The transmissive glass
// is off in these scenes (story/fly.ts is the only thing that turns it on), so
// the cards are ordinary `transparent` meshes that DO write depth: that is what
// makes a card pass behind the lens and be hidden by it. Their rounded corners
// come from the face texture's alpha, discarded by alphaTest.
// ============================================================================

import * as THREE from "three/webgpu";
import {
  cameraProjectionMatrix,
  modelViewMatrix,
  positionGeometry,
  texture,
  uniform,
  vec4,
} from "three/tsl";
import type { PartOffset, SceneHandle } from "../core/scene";
import { clamp01, deg, smoothstep } from "../core/math";
import {
  isSegWedge,
  isPeelExtra,
  isPeelTube,
  isShellPart,
} from "../core/parts";
import { NUM } from "../ops/algebra";
import { peelOrder, WRAP_DIR } from "../ops/house";
import { isLightTheme, watchTheme } from "../core/theme";
import { atFrac, rangeOf } from "./story";

const peR = rangeOf("peel");
const cdR = rangeOf("cards");
const inR = rangeOf("internals");

/** Scene-local fraction of `p`, clamped — every law below is written in it. */
const localOf = (r: { p0: number; p1: number }, p: number) =>
  clamp01((p - r.p0) / (r.p1 - r.p0));

// --- the choreography numbers ----------------------------------------------
// All windows are in the fraction of the scene named on the line.

/** peel: the unroll. Both edges saturate, so the channel is a hard 0 through the
 *  camera's transit into the scene and a hard 1 well before it leaves. */
const PEEL_ROLL: [number, number] = [0.02, 0.72];
/** cards: the unroll's RELEASE. The strips are hidden by then (the shell gate
 *  winks them out over peel [0.6, 0.95]), so the channel can go home without
 *  being seen re-rolling — and it must, because a channel left at 1 would drive
 *  the recipe for the rest of the page. */
const PEEL_RELEASE: [number, number] = [0.05, 0.35];
/** peel: the outward drift, opening well after the unroll so a strip has CURLED
 *  before it travels. The two edges bound the whole flock — a single sector's
 *  own window is a slice of this span (driftWindowOf). */
const DRIFT: [number, number] = [0.35, 0.95];
/** ONE SECTOR's share of the span above. The five windows are fanned across the
 *  remaining 0.3 by driftOrderOf, so the flock departs one sector at a time
 *  instead of as one block and the last strip still lands before the scene's
 *  end. The five plates of a sector (barrel, band, both grips) share the window:
 *  they were one column of the shell and they read as one strip. */
const DRIFT_WINDOW = 0.3;
/** how far a strip travels radially, in world units */
const DRIFT_WU = 2.2;
/** and how far frontward (world +X), so the strips clear the barrel instead of
 *  sliding along it */
const DRIFT_FRONT_WU = 0.6;
/** ±this much on the drift MAGNITUDE, spread across a sector's index: sector 0
 *  travels 20% short and sector 4 20% long, so the strips do not come to rest on
 *  one circle. */
const DRIFT_STAGGER = 0.2;
/** peel: the INNER TUBES' departure span (core/parts isPeelTube), between the
 *  strips' and the baffles': it opens once the skin's own wink-out is under way
 *  and closes before the bore opens, so the three layers leave outside-in as
 *  three beats. It ends at 0.84 rather than at the drift's 0.95 deadline — the
 *  shell gate's tube band has winked every wedge away by ~0.85, and a tube that
 *  was still travelling then would vanish mid-flight. */
const TUBE_DRIFT: [number, number] = [0.48, 0.84];
/** ONE tube wedge's share of it, fanned across the remainder by
 *  tubeDriftWindowOf — twelve windows, so no two wedges leave together. */
const TUBE_WINDOW = 0.22;
/** how far a tube wedge travels radially, in world units. Longer than a strip's
 *  DRIFT_WU: it starts a layer further in and must still finish OUTSIDE the
 *  circle the strips came to rest on, or the two casts interleave. */
const TUBE_DRIFT_WU = 2.6;
/** peel: the BAFFLES' departure span. It opens after the strips are well clear
 *  (theirs is DRIFT, from 0.35) so the bore opens as a second beat rather than
 *  in the same movement as the skin, and it closes at the drift's own deadline —
 *  the shell gate has winked every baffle away by then (core/scene's late band,
 *  which bottoms out at the same peel-local 0.95). */
const BAFFLE_DRIFT: [number, number] = [0.6, 0.95];
/** ONE baffle wedge's share of it, fanned across the remainder by
 *  baffleDriftWindowOf — fifteen windows, so no two plates leave together. */
const BAFFLE_WINDOW = 0.2;
/** how far a baffle travels out of the lens along the axis, in world units */
const BAFFLE_EXIT_WU = 2.6;
/** and how far it fans radially on the way, so five wedges of one ring do not
 *  slide out as a re-formed disc */
const BAFFLE_FAN_WU = 0.9;

/** peel: card k's fade-in window, offset by k·CARD_STAGGER */
const CARD_FADE_START = 0.55;
const CARD_FADE_HELD = 0.9;
/** peel: the LAST card is fully out by here — what sets the stagger below */
const CARD_FADE_DONE = 0.98;
/** internals: the field's fade-out, over the top of the scene */
const CARDS_OUT: [number, number] = [0, 0.22];

export const CARD_COUNT = 8;
/** the stagger falls out of the deadline: eight windows fanned between
 *  CARD_FADE_HELD and CARD_FADE_DONE, so card 7 completes exactly at 0.98 */
const CARD_STAGGER = (CARD_FADE_DONE - CARD_FADE_HELD) / (CARD_COUNT - 1);

/** card size in world units, BEFORE the per-card scale below (the lens is ≈ 3 wu
 *  across, the story camera ≈ 15 wu out) */
const CARD_SIZE: [number, number] = [1.6, 2.0];
/** per-card size, as a multiple of CARD_SIZE: 0.85 / 1.025 / 1.2 by k mod 3. The
 *  ring already sizes a card by its depth; this is what keeps two cards passing
 *  at the SAME depth from reading as one card printed twice. */
const CARD_SCALE0 = 0.85;
const CARD_DSCALE = 0.175;

/** orbit radii: 3.6 … 6.0 wu by k mod 5. The floor is the number that matters —
 *  the model's silhouette is 2.8 wu, so no ring ever runs through the barrel. */
const ORBIT_R0 = 3.6;
const ORBIT_DR = 0.6;
/** angular speed, rad/s: 0.05 … 0.086 by k mod 4, direction by parity */
const ORBIT_W0 = 0.05;
const ORBIT_DW = 0.012;
/** the AXIAL ladder's half-spread, in world units: the rings are strung ALONG
 *  the lens axis, card 0 at the mount end and card 7 out past the front element,
 *  so the field is a run of hoops rather than one hoop. */
const ORBIT_X = 2.5;
/** and the vertical bob on top of it — small enough that the ring's clearance of
 *  the barrel survives it */
const BOB_WU = 0.2;
const BOB_RAD_S = 0.4;

/** model millimetres per world unit — the reciprocal of core/scene's
 *  MODEL_SCALE (0.05). Every number above is in WORLD units; setPartOffset
 *  writes into the part's own frame, which is the gltf frame in millimetres. */
const MM_PER_WU = 20;

/** wedges per segmented shell family in the shipped GLBs */
export const SEG_COUNT = 5;

/** The gltf-frame angle (atan2(z, x) in the radial plane) of `Seg0`'s seated
 *  sector centre. The wedge ring is cut into SEG_COUNT equal sectors and the
 *  index runs the OTHER WAY round the axis, hence the minus below.
 *
 *  MEASURED off the shipped `lens_web_segmented.glb` — every wedge's bounding-box
 *  centre direction, in degrees, which is the same quantity a runtime Box3 walk
 *  would give (SceneHandle exposes no per-part box, and the law is worth having
 *  as a pure function anyway):
 *
 *      seg          0       1       2       3       4
 *      Barrel_Inner −70.5  −142.0   152.9    84.8     7.9
 *      Band_Mid     −64.6  −136.6   150.9    77.2     5.9
 *      Barrel_Base  −62.9  −136.2   150.7    78.5     6.2
 *      Ring_Focus   −65.3  −135.9   152.1    80.6     6.1
 *      Ring_Zoom    −66.3  −139.0   148.7    75.9     4.1
 *
 *  Consecutive columns are 72° apart to within a couple of degrees; the residual
 *  is the bounding box's own asymmetry (Barrel_Inner, which carries interior
 *  geometry, is the outlier). __tests__/peelcards.test.ts re-measures the shipped
 *  GLB against this law, so a re-export that re-cuts the seams fails there rather
 *  than in a scroll nobody re-checks. */
const SEG0_ANGLE = deg(-65.9);

/** The seated sector direction of shell wedge `seg`, as an angle in the gltf
 *  radial plane (x = cos, z = sin). */
export const segSectorAngle = (seg: number): number =>
  SEG0_ANGLE - (seg * 2 * Math.PI) / SEG_COUNT;

/** WHICH SECTOR EACH PRINTED MARKING RIDES. The decals are the other half of the
 *  peel's cast (core/parts isShellPart) and they are NOT wedges — each is a
 *  child of a FAMILY node (`DecalT_MIJ` under `Ring_Zoom`), so there is no
 *  `_SegN` suffix to read a sector off. Left un-offset they stay behind while
 *  their host strip flies, up to the drift's full 2.64 wu — a name ring floating
 *  where the barrel used to be.
 *
 *  So each marking is assigned the sector it SITS ON, measured the same way as
 *  the wedge table above (bounding-box centre direction in the gltf radial
 *  plane) and pinned by the same test. Measured angle → assigned sector, with the
 *  residual from that sector's centre:
 *
 *      Decal_HoodDash     90.0 → 3 (11.9)   DecalT_Serial      16.4 → 4 (10.3)
 *      DecalT_Bezel       89.9 → 3 (11.8)   Decal_Dot2        173.0 → 2 (22.9)
 *      DecalT_BezelMIJ   −90.0 → 0 (24.1)   DecalT_Edition   −114.8 → 1 (23.1)
 *      DecalT_BadgeC     136.9 → 2 (13.2)   DecalT_MIJ        174.4 → 2 (24.3)
 *      DecalT_BadgeDisc  137.0 → 2 (13.1)   DecalT_MinF      −145.2 → 1  (7.3)
 *      DecalT_Brand       19.8 → 4 (13.7)   DecalT_Zoom_18     90.4 → 3 (12.3)
 *      DecalT_Index       90.0 → 3 (11.9)   DecalT_Zoom_24     73.7 → 3  (4.4)
 *      DecalT_Label       90.0 → 3 (11.9)   DecalT_Zoom_28     59.2 → 3 (18.9)
 *      DecalT_Zoom_50     13.3 → 4  (7.2)   DecalT_Zoom_35     45.1 → 3 (33.0)
 *
 *  A sector is 72° wide, so a residual under 36° means the marking really is on
 *  that sector. `DecalT_Zoom_35` at 33° is the one that STRADDLES A SEAM (the
 *  zoom scale is printed across the whole ring): it rides sector 3 because that
 *  is the nearer half, and if it visibly tears away from its strip the fix is to
 *  wink it out early rather than to split the marking. */
const DECAL_SECTOR: Record<string, number> = {
  Decal_Dot2: 2,
  Decal_HoodDash: 3,
  DecalT_BadgeC: 2,
  DecalT_BadgeDisc: 2,
  DecalT_Bezel: 3,
  DecalT_BezelMIJ: 0,
  DecalT_Brand: 4,
  DecalT_Edition: 1,
  DecalT_Index: 3,
  DecalT_Label: 3,
  DecalT_MIJ: 2,
  DecalT_MinF: 1,
  DecalT_Serial: 4,
  DecalT_Zoom_18: 3,
  DecalT_Zoom_24: 3,
  DecalT_Zoom_28: 3,
  DecalT_Zoom_35: 3,
  DecalT_Zoom_50: 4,
};

/** The sector a piece of the shell's cast rides: off its `_SegN` suffix for a
 *  wedge, off the table above for a printed marking, and undefined for the
 *  family GROUP nodes the cast also matches — offsetting one of those would move
 *  its whole ring rigidly, wedges and all. */
export const shellPartSector = (name: string): number | undefined =>
  isSegWedge(name)
    ? Number(/_Seg(\d+)$/.exec(name)![1])
    : DECAL_SECTOR[name /* undefined for a family group node */];

/** THE INNER TUBES' SEAM CUT (core/parts isPeelTube). Both are wedge-segmented
 *  like the shell, but only one of them on the SHELL's five: `Chassis_Fixed` is
 *  cut into the same five sectors, `Cam_Barrel` into seven (the cut the optics
 *  cage and the iris housing share). So a tube wedge cannot take segSectorAngle
 *  — it needs its own family's count and seg-0 meridian.
 *
 *  MEASURED off the shipped `lens_web_segmented.glb`, the same way the wedge
 *  table above is (bounding-box centre direction in the gltf radial plane, in
 *  degrees):
 *
 *      seg              0       1       2       3       4       5       6
 *      Chassis_Fixed  −65.1  −138.5   150.1    79.7     6.0
 *      Cam_Barrel     −26.8   −78.6  −129.3   179.5   128.1    76.8    25.1
 *
 *  Consecutive columns are 72° / 51.4° apart to within a degree — each family is
 *  an even cut about the axis, so only its seg-0 meridian has to be recorded,
 *  and `Chassis_Fixed` really is on the shell's own seams (SEG0_ANGLE, which it
 *  therefore reuses rather than restating). __tests__/peelcards.ts re-measures
 *  both families against this law, so a re-export that re-cuts either one fails
 *  there rather than as a tube wedge flying off somebody else's meridian.
 *
 *  The KEY ORDER is the departure order: the outer tube first, then the one
 *  inside it (tubeDriftWindowOf). */
const TUBE_CUT: Record<string, { segs: number; seg0: number }> = {
  Chassis_Fixed: { segs: 5, seg0: SEG0_ANGLE },
  Cam_Barrel: { segs: 7, seg0: deg(-26.4) },
};

export const TUBE_FAMILY_ORDER = Object.keys(TUBE_CUT);

/** The seated sector direction of tube wedge `seg` of `family`, as an angle in
 *  the gltf radial plane — segSectorAngle's law on that family's own cut. */
export const tubeSectorAngle = (family: string, seg: number): number => {
  const cut = TUBE_CUT[family];
  return cut.seg0 - (seg * 2 * Math.PI) / cut.segs;
};

/** The family a tube wedge belongs to, and the sector it sits on. undefined for
 *  anything that is not a `<family>_SegN` — the two family GROUP nodes (offsetting
 *  one would move its whole tube rigidly) and the focus hardware `Chassis_Fixed`
 *  ADOPTS as children, which carries its own names and stays behind. */
export const tubePiece = (
  name: string,
): { family: string; seg: number } | undefined => {
  const m = /^(.*)_Seg(\d+)$/.exec(name);
  if (!m || !(m[1] in TUBE_CUT)) return undefined;
  return { family: m[1], seg: Number(m[2]) };
};

/** THE BAFFLES' DEPARTURE (core/parts isPeelExtra). Each light trap leaves by
 *  the END OF THE LENS IT IS NEAREST — there is no path out through the middle,
 *  and a plate that tried would slide the length of the optical column through
 *  the cells and the glass. The sign is the gltf +Y (front) direction:
 *
 *      Baffle_Rear          y ≈ −1.6   the rear cap, out the mount end
 *      Optics_Baffle_Front  y ≈ 50.3   out the front, past the last element
 *      Optics_Baffle_G2     y ≈ 54.8   out the front, behind it
 *
 *  MEASURED off `lens_web_segmented.glb` and pinned by __tests__/peelcards, the
 *  same way the wedge table above is: a re-export that moves one of these past
 *  the mid-plane must fail there, because the exit it should take changes with
 *  it. The ORDER of the keys is also the departure order (baffleDriftWindowOf). */
const BAFFLE_EXIT: Record<string, number> = {
  Baffle_Rear: -1,
  Optics_Baffle_Front: 1,
  Optics_Baffle_G2: 1,
};

/** the departure order: rear ring first, then the two optics traps */
export const BAFFLE_FAMILY_ORDER = Object.keys(BAFFLE_EXIT);

/** The family a baffle wedge belongs to, and the sector it sits on. The wedges
 *  are cut on the SHELL's seams (measured: `Baffle_Rear_Seg0` sits at −64°, the
 *  shell's sector 0 at −66°), so a baffle takes segSectorAngle like a strip.
 *  undefined for anything that is not a `<family>_SegN` — the three family GROUP
 *  nodes included, since offsetting one would move its whole ring rigidly. */
export const bafflePiece = (
  name: string,
): { family: string; seg: number } | undefined => {
  const m = /^(.*)_Seg(\d+)$/.exec(name);
  if (!m || !(m[1] in BAFFLE_EXIT)) return undefined;
  return { family: m[1], seg: Number(m[2]) };
};

// --- the laws ---------------------------------------------------------------

/** The `peel` channel's UNROLL, in peel-local fraction. */
export const peelChannelAt = (local: number): number =>
  smoothstep(PEEL_ROLL[0], PEEL_ROLL[1], local);

/** The unroll's release, in CARDS-local fraction: 1 = fully released. */
const peelReleaseAt = (local: number): number =>
  smoothstep(PEEL_RELEASE[0], PEEL_RELEASE[1], local);

/** THE WHOLE `peel` CHANNEL at story position `p` — the unroll, released again
 *  over the cards scene. Zero everywhere outside those two scenes, so no other
 *  span on the page ever sees the recipe driven. */
export const peelValueAt = (p: number): number =>
  peelChannelAt(localOf(peR, p)) * (1 - peelReleaseAt(localOf(cdR, p)));

/** Where a seated MERIDIAN sits in the DEPARTURE ORDER, 0..1 — ops/house
 *  `peelOrder`, the very function the `peel` recipe fans its unroll on,
 *  evaluated at that meridian (wrapped into atan2's range first, since that is
 *  what a measured t0 always is). Keeping the two on ONE law is what makes a
 *  strip drift on the heels of its OWN unroll instead of on some other sector's;
 *  the sequence, either side, is the order the seams come round rather than the
 *  order the exporter numbered them. Every cast below fans on this — the tubes
 *  on their own families' cuts, which is why it takes an angle and not a seg. */
const meridianOrder = (theta: number): number =>
  peelOrder(NUM, Math.atan2(Math.sin(theta), Math.cos(theta)), WRAP_DIR);

/** Where shell sector `seg` sits in that order. */
export const driftOrderOf = (seg: number): number =>
  meridianOrder(segSectorAngle(seg));

/** Sector `seg`'s own drift window, in peel-local fraction: a DRIFT_WINDOW-wide
 *  slice of DRIFT, fanned across the span by that order. */
export const driftWindowOf = (seg: number): [number, number] => {
  const lead = (DRIFT[1] - DRIFT[0] - DRIFT_WINDOW) * driftOrderOf(seg);
  return [DRIFT[0] + lead, DRIFT[0] + lead + DRIFT_WINDOW];
};

/** How far along sector `seg`'s drift is, 0..1 — shared by the radial and the
 *  frontward component so a strip travels in one straight line. */
const driftRampAt = (local: number, seg: number): number => {
  const [a, b] = driftWindowOf(seg);
  return smoothstep(a, b, local);
};

/** A strip's radial travel in WORLD units, in peel-local fraction (before the
 *  per-sector magnitude stagger). */
export const stripDriftAt = (local: number, seg: number): number =>
  DRIFT_WU * driftRampAt(local, seg);

/** One tube wedge's own departure window, in peel-local fraction. Family-major
 *  (the outer tube first, then the one inside it, so the tubes come off in the
 *  same outside-in order the layers do) and, inside a tube, the meridian order
 *  the strips left in. Twelve windows, so no two wedges go together. */
export const tubeDriftWindowOf = (
  family: string,
  seg: number,
): [number, number] => {
  const rank =
    (TUBE_FAMILY_ORDER.indexOf(family) +
      meridianOrder(tubeSectorAngle(family, seg))) /
    TUBE_FAMILY_ORDER.length;
  const lead = (TUBE_DRIFT[1] - TUBE_DRIFT[0] - TUBE_WINDOW) * rank;
  return [TUBE_DRIFT[0] + lead, TUBE_DRIFT[0] + lead + TUBE_WINDOW];
};

/** One baffle wedge's own departure window, in peel-local fraction. Family-major
 *  (the rear ring first, then the two optics traps, so the bore opens from the
 *  back forward) and, inside a ring, the same meridian order the strips left in.
 *  Fifteen windows, so no two plates go together. */
export const baffleDriftWindowOf = (
  family: string,
  seg: number,
): [number, number] => {
  const rank =
    (BAFFLE_FAMILY_ORDER.indexOf(family) + driftOrderOf(seg)) /
    BAFFLE_FAMILY_ORDER.length;
  const lead = (BAFFLE_DRIFT[1] - BAFFLE_DRIFT[0] - BAFFLE_WINDOW) * rank;
  return [BAFFLE_DRIFT[0] + lead, BAFFLE_DRIFT[0] + lead + BAFFLE_WINDOW];
};

/** Card k's opacity from the cross-fade alone, in peel-local fraction. */
export const cardFadeAt = (k: number, local: number): number =>
  smoothstep(
    CARD_FADE_START + k * CARD_STAGGER,
    CARD_FADE_HELD + k * CARD_STAGGER,
    local,
  );

/** How far the field has faded OUT, in INTERNALS-local fraction: 1 = gone. */
export const cardsFadeOutAt = (local: number): number =>
  smoothstep(CARDS_OUT[0], CARDS_OUT[1], local);

/** Card k's size, as a multiple of CARD_SIZE. */
export const cardScaleAt = (k: number): number =>
  CARD_SCALE0 + CARD_DSCALE * (k % 3);

/** Card k's phase on its ring. SEEDED FROM THE SHELL'S SEAMS — the first five
 *  cards start where the five strips left, the last three halfway between them
 *  (eight cards do not divide by five). Here that is a real direction and not
 *  just a matching number: a sector's radial direction (cos θ, ·, sin θ) in the
 *  gltf frame lands on world (−sin θ, −cos θ) in Y–Z under core/scene's two
 *  model rolls (drift() below), and this ring is written y = r·cos φ,
 *  z = r·sin φ — so φ = −(θ + π/2) puts the card on the strip's own meridian. */
const cardPhaseAt = (k: number): number =>
  -(segSectorAngle(k % SEG_COUNT) + Math.PI / 2) +
  (k >= SEG_COUNT ? Math.PI / SEG_COUNT : 0);

/** Card k's centre at accumulated time `tMs`, in world units — a pure function
 *  of (k, t), so the field is reproducible frame to frame and in tests.
 *
 *  THE RING IS ABOUT THE OPTICAL AXIS (world X), not about the vertical: each
 *  card runs a hoop in the Y–Z plane, and the hoops are strung along the axis at
 *  different radii. The story cameras all sit side-on-ish to the lens, so a hoop
 *  carries its card from far behind the axis to near in front of the camera and
 *  back — perspective does the rest, and the field arrives at eight visibly
 *  different sizes instead of eight copies at one depth. It is also still what
 *  makes a card pass BEHIND the barrel and be occluded by it. */
export const cardOrbitAt = (
  k: number,
  tMs: number,
): { x: number; y: number; z: number } => {
  const t = tMs / 1000;
  const r = ORBIT_R0 + ORBIT_DR * (k % SEG_COUNT);
  const w = ORBIT_W0 + ORBIT_DW * (k % 4);
  const dir = k % 2 === 0 ? 1 : -1;
  const phi = cardPhaseAt(k) + dir * w * t;
  return {
    // the ladder, now ALONG the axis: card 0 at −ORBIT_X, card 7 at +ORBIT_X
    x: ORBIT_X * ((2 * k) / (CARD_COUNT - 1) - 1),
    y: r * Math.cos(phi) + BOB_WU * Math.sin(t * BOB_RAD_S + k),
    z: r * Math.sin(phi),
  };
};

// --- the card faces ---------------------------------------------------------

/** Face palette, from LensStory.astro's stage vars (`#lens-hero`): the cards are
 *  paper on the paper stage and ink on the dark one, so they read as part of the
 *  same drawing rather than as pasted-on photographs. */
const FACE_PALETTE = {
  light: {
    paper: "#f2eee4",
    ink: "#2c2822",
    faint: "rgba(44, 40, 34, 0.45)",
    rule: "rgba(44, 40, 34, 0.18)",
    accent: "#b06a3c",
  },
  dark: {
    paper: "#1d1a14",
    ink: "#ece7da",
    faint: "rgba(236, 231, 218, 0.4)",
    rule: "rgba(236, 231, 218, 0.15)",
    accent: "#d18a5d",
  },
} as const;

const FACE_W = 512;
const FACE_H = 640;
/** corner radius, in face pixels — the card's rounded corner is TEXTURE ALPHA
 *  (nothing is drawn outside this path), discarded by the material's alphaTest */
const FACE_RADIUS = 26;
const FACE_PAD = 30;
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";

/** Draw card `k`'s placeholder face. DELIBERATELY a placeholder — a hatched
 *  photo well and a "CARD 0k" slug — so nobody mistakes the field for finished
 *  content while the real cards are being chosen. */
function paintFace(canvas: HTMLCanvasElement, k: number, light: boolean): void {
  const c = light ? FACE_PALETTE.light : FACE_PALETTE.dark;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, FACE_W, FACE_H);

  // the card body — one rounded path, filled and stroked; everything else is
  // clipped to it so no ink lands in the transparent corners
  ctx.beginPath();
  ctx.roundRect(2, 2, FACE_W - 4, FACE_H - 4, FACE_RADIUS);
  ctx.fillStyle = c.paper;
  ctx.fill();
  ctx.save();
  ctx.clip();

  // the photo well: a hatched rectangle, the universal "image goes here"
  const wellY = FACE_PAD;
  const wellH = 372;
  const wellW = FACE_W - FACE_PAD * 2;
  ctx.save();
  ctx.beginPath();
  ctx.rect(FACE_PAD, wellY, wellW, wellH);
  ctx.clip();
  ctx.strokeStyle = c.rule;
  ctx.lineWidth = 2;
  for (let x = -wellH; x < wellW; x += 16) {
    ctx.beginPath();
    ctx.moveTo(FACE_PAD + x, wellY + wellH);
    ctx.lineTo(FACE_PAD + x + wellH, wellY);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = c.faint;
  ctx.lineWidth = 2;
  ctx.strokeRect(FACE_PAD, wellY, wellW, wellH);

  // the slug: index, thin rule, title, placeholder line
  const textY = wellY + wellH + 56;
  ctx.fillStyle = c.accent;
  ctx.font = `600 30px ${MONO}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(`CARD ${String(k + 1).padStart(2, "0")}`, FACE_PAD, textY);
  ctx.fillStyle = c.rule;
  ctx.fillRect(FACE_PAD, textY + 22, wellW, 2);
  ctx.fillStyle = c.ink;
  ctx.font = `500 26px ${MONO}`;
  ctx.fillText("PLACEHOLDER", FACE_PAD, textY + 64);
  ctx.fillStyle = c.faint;
  ctx.font = `400 22px ${MONO}`;
  ctx.fillText("photo + text to come", FACE_PAD, textY + 98);

  ctx.restore();
  // the card's edge, drawn last so the hatching cannot cross it
  ctx.beginPath();
  ctx.roundRect(2, 2, FACE_W - 4, FACE_H - 4, FACE_RADIUS);
  ctx.strokeStyle = c.faint;
  ctx.lineWidth = 3;
  ctx.stroke();
}

/** One card's face texture — the canvas is KEPT so a theme flip can repaint it
 *  in place (a fresh CanvasTexture would mean re-binding the material's texture
 *  node; `needsUpdate` re-uploads the same one). */
function buildFace(k: number, light: boolean) {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_W;
  canvas.height = FACE_H;
  paintFace(canvas, k, light);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return { canvas, tex };
}

interface Card {
  mat: THREE.MeshBasicNodeMaterial;
  canvas: HTMLCanvasElement;
  tex: THREE.CanvasTexture;
  uCentre: { value: THREE.Vector3 };
  uOpacity: { value: number };
}

interface Field {
  group: THREE.Group;
  geo: THREE.PlaneGeometry;
  cards: Card[];
}

/** Build the eight quads. Cheap and synchronous: one shared geometry, one
 *  material and one 512×640 canvas per card, no GPU work until the first draw. */
function buildField(light: boolean): Field {
  // ±1 corners, so the vertexNode's corner offset IS the half-size
  const geo = new THREE.PlaneGeometry(2, 2);
  const group = new THREE.Group();
  group.name = "Lens_CardField";
  const cards: Card[] = [];
  for (let k = 0; k < CARD_COUNT; k++) {
    const { canvas, tex } = buildFace(k, light);
    // each card carries its own half-size (cardScaleAt) — a constant per graph,
    // so it costs a uniform and nothing per frame
    const s = cardScaleAt(k);
    const uHalf = uniform(
      new THREE.Vector2((CARD_SIZE[0] * s) / 2, (CARD_SIZE[1] * s) / 2),
    );
    const uCentre = uniform(new THREE.Vector3());
    const uOpacity = uniform(0);
    const mat = new THREE.MeshBasicNodeMaterial();
    // THE BILLBOARD (optics/starfield.ts starMark, one quad per mesh): the
    // centre goes to VIEW space through modelViewMatrix — the group carries no
    // transform, so that is just the world centre in the camera's frame — the
    // corner is added there in view-space world units, and only then does the
    // projection run. The quad therefore has no orientation of its own to get
    // wrong and stays exactly parallel to the film plane at any camera angle.
    const centre = modelViewMatrix.mul(vec4(uCentre, 1));
    mat.vertexNode = cameraProjectionMatrix.mul(
      vec4(
        centre.x.add(positionGeometry.x.mul(uHalf.x)),
        centre.y.add(positionGeometry.y.mul(uHalf.y)),
        centre.z,
        centre.w,
      ),
    );
    const face = texture(tex);
    // rgb and alpha SEPARATELY: a vec4 colorNode would land the face's own alpha
    // in diffuseColor.a as well, which three then multiplies by the opacity node
    // — the corners would be squared for nothing.
    mat.colorNode = face.rgb;
    mat.opacityNode = face.a.mul(uOpacity);
    mat.transparent = true;
    // DEPTH IS THE POINT: a card behind the lens must be hidden by it, and one
    // in front must cover it. The face's alpha is 1 inside the rounded corner
    // and 0 outside, so alphaTest keeps the corners (and a fully faded card)
    // from writing depth over anything.
    mat.depthWrite = true;
    mat.alphaTest = 0.02;
    // A billboard's winding is fixed by the construction above, but the field is
    // built to be looked at from anywhere in the story; culling a back face
    // would only ever cost a card.
    mat.side = THREE.DoubleSide;
    // Flat ink, not a lit surface (the 2D/3D design law).
    mat.toneMapped = false;
    const mesh = new THREE.Mesh(geo, mat);
    // The geometry sits at the origin and the real position lives in a uniform,
    // so three's bounding sphere means nothing here.
    mesh.frustumCulled = false;
    group.add(mesh);
    cards.push({ mat, canvas, tex, uCentre, uOpacity });
  }
  return { group, geo, cards };
}

// --- the module -------------------------------------------------------------

/** dt clamp, ms — story/internals.ts's number, for its reason */
const DT_CLAMP_MS = 100;
/** Lead-in before the peel and tail past the cards' fade-out: the window the
 *  overlay is MOUNTED over, in absolute story p. The tail is read off the
 *  internals scene (0.26 of it, just past the fade-out's 0.22) rather than as
 *  absolute p, which at these durations would strand eight invisible cards in
 *  the scene through the whole fly-through — the one place on the page with no
 *  frame budget to spare. */
const MOUNT_PAD = 0.02;
const MOUNT_LO = peR.p0 - MOUNT_PAD;
const MOUNT_HI = atFrac(inR, 0.26);
/** scroll-p slack past each mount edge, so a scrub parked exactly on one cannot
 *  thrash build/dispose (story/fly.ts's HYST, one order coarser because what
 *  thrashes here is a build, not a look) */
const HYST = 0.02;

/** One piece that flies off during the peel — a shell strip or a baffle wedge.
 *  Both are the same thing to the drift: a fixed travel vector and the window it
 *  is spent over, so the two casts share one loop instead of two. */
interface Flyer {
  name: string;
  /** where it ends up, relative to its seat, in the gltf frame and in MILLIMETRES */
  to: [number, number, number];
  /** this piece's own drift window, in peel-local fraction */
  win: [number, number];
  /** the live offset object, MUTATED in place — core/scene keeps the reference
   *  and reads it on every rendered frame, so there is nothing to allocate per
   *  frame and nothing can go stale */
  off: PartOffset;
}

export function createPeelCards(scene: SceneHandle): {
  frame(p: number): void;
} {
  let cast: Flyer[] | null = null;
  let driftOn = false;
  let field: Field | null = null;
  let light = isLightTheme();
  let tAcc = 0;
  let last = performance.now();

  /** THE DRIFTING CAST, enumerated once off the live model. Two groups:
   *
   *   • THE STRIPS — every piece of the shell's cast (core/parts isShellPart)
   *     that sits on a known sector: the 25 `_SegN` wedges and the 18 printed
   *     markings, each taking its sector's direction, its window AND its share of
   *     the magnitude stagger, so a marking travels with the strip it is printed
   *     on. They go radially out and frontward.
   *   • THE INNER TUBES (core/parts isPeelTube) — the 12 wedges of the two closed
   *     tubes the skin was wrapped around, out along their OWN families' meridians
   *     (five sectors and seven) on windows between the strips' and the baffles'.
   *     Without them the card scene still looks at a solid cylinder from the side:
   *     the glass column and the mechanism are sealed inside two more layers.
   *   • THE BAFFLES (core/parts isPeelExtra) — the 15 light-trap wedges, each out
   *     of the end of the lens it is nearest (BAFFLE_EXIT) with a radial fan on
   *     top, on their own later windows. This is what opens the bore END-ON;
   *     without it the rear plate caps the tube and the two optics traps stop the
   *     sight-line short of the glass.
   *
   *  Off the live registry rather than off the tables alone, so a name the shipped
   *  model no longer carries is silently skipped instead of warning from
   *  setPartOffset every frame. */
  function flyers(): Flyer[] {
    if (cast) return cast;
    cast = scene.partNames().flatMap((name): Flyer[] => {
      const off = { position: [0, 0, 0] as [number, number, number] };
      if (isShellPart(name)) {
        const seg = shellPartSector(name);
        if (seg === undefined) return [];
        const theta = segSectorAngle(seg);
        const m =
          DRIFT_WU *
          MM_PER_WU *
          (1 + DRIFT_STAGGER * ((2 * seg) / (SEG_COUNT - 1) - 1));
        return [
          {
            name,
            to: [
              Math.cos(theta) * m,
              DRIFT_FRONT_WU * MM_PER_WU,
              Math.sin(theta) * m,
            ],
            win: driftWindowOf(seg),
            off,
          },
        ];
      }
      if (isPeelTube(name)) {
        const piece = tubePiece(name);
        if (piece === undefined) return [];
        const theta = tubeSectorAngle(piece.family, piece.seg);
        const m = TUBE_DRIFT_WU * MM_PER_WU;
        return [
          {
            name,
            to: [
              Math.cos(theta) * m,
              DRIFT_FRONT_WU * MM_PER_WU,
              Math.sin(theta) * m,
            ],
            win: tubeDriftWindowOf(piece.family, piece.seg),
            off,
          },
        ];
      }
      if (!isPeelExtra(name)) return [];
      const piece = bafflePiece(name);
      if (piece === undefined) return [];
      const theta = segSectorAngle(piece.seg);
      const fan = BAFFLE_FAN_WU * MM_PER_WU;
      return [
        {
          name,
          to: [
            Math.cos(theta) * fan,
            BAFFLE_EXIT[piece.family] * BAFFLE_EXIT_WU * MM_PER_WU,
            Math.sin(theta) * fan,
          ],
          win: baffleDriftWindowOf(piece.family, piece.seg),
          off,
        },
      ];
    });
    return cast;
  }

  /** THE FRAME setPartOffset WRITES IN is the part's own local frame, i.e. the
   *  gltf frame: +Y is the optical axis (front) and the radial plane is X–Z, in
   *  MILLIMETRES. The two rolls above it (core/scene's `modelGroup.rotation.z =
   *  −π/2` and `gltfScene.rotation.y = π/2`) carry that to the world frame where
   *  +X is the optical axis and Y–Z is radial. Both are rotations, so a radial
   *  offset here is a radial offset there of the same length in world units, and
   *  the frontward +Y lands on world +X — which is what "the strips clear the
   *  barrel" means. */
  function drift(peelLocal: number) {
    for (const f of flyers()) {
      const r = smoothstep(f.win[0], f.win[1], peelLocal);
      const pos = f.off.position!;
      pos[0] = f.to[0] * r;
      pos[1] = f.to[1] * r;
      pos[2] = f.to[2] * r;
      scene.setPartOffset(f.name, f.off);
    }
    driftOn = true;
  }

  /** Per NAME, not clearPartOffsets(): the registry is shared with the /lens
   *  bench's demos and this module only ever owns its own rows. */
  function clearDrift() {
    for (const f of flyers()) scene.setPartOffset(f.name, null);
    driftOn = false;
  }

  function mount() {
    field = buildField(light);
    scene.addOverlay(field.group);
  }

  function unmount() {
    if (!field) return;
    scene.removeOverlay(field.group);
    for (const c of field.cards) {
      c.tex.dispose();
      c.mat.dispose();
    }
    field.geo.dispose();
    field = null;
  }

  // Theme flips repaint the faces IN PLACE (same canvas, same texture object, a
  // fresh upload). Nothing to do while the field is unmounted — it is rebuilt at
  // the current theme on the next entry.
  watchTheme((l) => {
    light = l;
    if (!field) return;
    for (let k = 0; k < CARD_COUNT; k++) {
      paintFace(field.cards[k].canvas, k, light);
      field.cards[k].tex.needsUpdate = true;
    }
    scene.invalidate();
  });

  // THE ORBIT AND THE OPACITIES, on time. Registered for the life of the page —
  // the hero's scene is never disposed, and until the field mounts this costs
  // one clamp and one compare.
  scene.onFrame(() => {
    const now = performance.now();
    tAcc += Math.min(DT_CLAMP_MS, now - last);
    last = now;
    if (!field) return;
    // THE SCROLL p, NOT THE EASED CHANNEL — story/internals.ts's reasoning
    // verbatim: `storyTarget` is exactly what hero-driver's frame() was handed,
    // so the scroll side of this module and this callback gate on ONE p. The
    // eased `state.story` lags it by several frames, and hero-driver only runs
    // on scroll EVENTS: a fling that ends just past a scene would leave the
    // eased value crawling with no scroll left to correct it.
    const p = scene.state.storyTarget;
    const alive = 1 - cardsFadeOutAt(localOf(inR, p));
    const peelLocal = localOf(peR, p);
    for (let k = 0; k < CARD_COUNT; k++) {
      const c = field.cards[k];
      const o = cardOrbitAt(k, tAcc);
      c.uCentre.value.set(o.x, o.y, o.z);
      c.uOpacity.value = cardFadeAt(k, peelLocal) * alive;
    }
  });

  return {
    frame(p) {
      const peelLocal = localOf(peR, p);
      // THE UNROLL CHANNEL, value AND target: a pure function of the scroll, so
      // a scrub in either direction lands on the same pose and tick()'s ease can
      // never chase a stale target.
      const peel = peelValueAt(p);
      scene.state.peel = peel;
      scene.state.peelTarget = peel;

      // The drift lives ONLY in the peel span: outside it the offsets are
      // cleared, so the rewrap's reassembly flies the shell home from its own
      // seated transforms with nothing of ours composed on top.
      if (p >= peR.p0 && p <= peR.p1) drift(peelLocal);
      else if (driftOn) clearDrift();

      const want = p >= MOUNT_LO && p <= MOUNT_HI;
      if (want && !field) mount();
      else if (field && (p < MOUNT_LO - HYST || p > MOUNT_HI + HYST)) unmount();
    },
  };
}
