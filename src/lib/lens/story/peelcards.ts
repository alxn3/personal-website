// ============================================================================
// THE PEEL AND THE CARD FIELD. The shell peels off like a sticker (ops/house
// stickerPeelOps, fanned around the barrel by meridian), the curl lies back
// down over the cards scene's opening, and the lens then COMES APART on the
// assemble channel — the sky chapter's reassembly played backwards
// (story/envelopes.ts CARDS_APART, which owns that half). Eight billboard cards
// take the turn over as the spread cast fades out, the pieces wink away behind
// that cover, and the scene ends on the bare mechanism.
//
// This module owns: the unroll channel and its release, the lens' own roll, the
// four edges of the body fade (the valley everything unseen is timed against),
// the wink's window, and the card field. The DEPARTURE is not here — it is one
// recipe on one channel, authored with the other envelopes.
//
// TWO CLOCKS. Scroll (frame(p)) owns the unroll channel, value AND target, so a
// scrub lands on the same pose in either direction; TIME (scene.onFrame) owns
// only the card shell's rotation, off an accumulated dt clamped to 100ms —
// never performance.now(), which would teleport the field across a pause.
//
// The unroll and the departure are two unwrap chains on one wedge and the host
// SUMS recipe deltas, so they are SEQUENCED: PEEL_RELEASE lands on exactly 0 at
// the departure's foot.
//
// THE 2D LAW: a card is a view-space billboard — its centre goes through
// modelViewMatrix and the corners are added in VIEW space, so the quad is
// always parallel to the film plane.
//
import * as THREE from "three/webgpu";
import {
  cameraProjectionMatrix,
  modelViewMatrix,
  positionGeometry,
  texture,
  uniform,
  vec4,
} from "three/tsl";
import type { SceneHandle } from "../core/scene";
import { clamp01, deg, smoothstep } from "../core/math";
import { isLightTheme, watchTheme } from "../core/theme";
import { accelCruiseAt } from "./reveal";
import { atFrac, rangeOf } from "./story";

const peR = rangeOf("peel");
const cdR = rangeOf("cards");

/** Scene-local fraction of `p`, clamped — every law below is written in it. */
const localOf = (r: { p0: number; p1: number }, p: number) =>
  clamp01((p - r.p0) / (r.p1 - r.p0));

// --- the choreography numbers ----------------------------------------------
// All windows are in the fraction of the scene named on the line.

/** peel: the unroll. Both edges saturate, so the channel is a hard 0 through the
 *  camera's transit into the scene and a hard 1 well before it leaves.
 *
 *  LESS PEEL (owner). The far edge used to sit at 0.72, which spent most of the
 *  scene on the curl; the scene's subject is now the SPIN and the growing
 *  expansion that follow it, so the curl is over by 0.45 and everything after
 *  that belongs to SPIN below. The gesture's shape is untouched — this only
 *  says how much of the scene it is given. */
const PEEL_ROLL: [number, number] = [0.02, 0.45];
/** cards: the unroll's RELEASE — the curl lies back down under the scene's
 *  camera transit, and the channel is EXACTLY 0 at cards-local 0.10, where
 *  story/envelopes.ts CARDS_APART opens. The two chains may not overlap.
 *  `RELEASE_SPAN` is the same window in absolute p. */
const PEEL_RELEASE: [number, number] = [0.0, 0.1];
// --- THE SPIN (owner: "the lens and its layers spin, with growing expansion,
// the layers spinning a bit faster than the body") ---------------------------
//
// One normalized shape with one consumer: the lens' own rigid roll about the
// bore (peelRollAt → hero-driver's single setModelOrientation writer). Rigid,
// so it turns the seat, the unroll and the departure together and no piece's
// radius moves.

/** peel: where the spin opens. It is NOT a beat boundary and the numbers say so
 *  — at 0.32 the curl is 78 % read (peelChannelAt(0.32) = 0.7811, its far edge
 *  0.45). What separates the curl from the turn is the RAMP, not the edge:
 *  accelCruiseAt leaves here at rate exactly 0 and spends
 *  SPIN_WIND_UP of the span winding up, so the curl has finished before the
 *  turn is legible. Opening it any later would put the
 *  wind-up under the crossfade instead of the cruise. */
const SPIN_START = 0.32;
/** cards: where it is spent. Inside THE VALLEY (below) — the body fade is
 *  exactly 0 there — so the one place the angular rate steps, the far edge of an
 *  accelerate-then-cruise ramp, is behind a lens nobody can see. Pinned against
 *  `VALLEY` in __tests__/peelcards.test.ts rather than against its numbers. */
const SPIN_END = 0.6;
/** the share of the spin spent reaching cruising speed (story/reveal.ts
 *  accelCruiseAt). Deliberately NOT a smoothstep: a smoothstep decelerates into
 *  its far edge, and this one has to still be at cruise where the card shell
 *  takes the gesture over — the reveal's own lesson, in a second place. */
const SPIN_WIND_UP = 0.35;
/** WHOLE TURNS the lens body makes over the span, SIGNED — negative is the
 *  peel's own winding direction (ops/house WRAP_DIR = −1, which is why the
 *  seams depart in decreasing meridian order), so the spin carries on the way
 *  the sides came off.
 *
 *  A WHOLE NUMBER ON PURPOSE. peelRollAt drops to exactly 0 past SPIN_END —
 *  the roll may not leak into the reveal's own term, which shares the one
 *  setModelOrientation writer — and an integer number of turns makes that drop
 *  the IDENTITY rather than a snap. Nothing else in the file cares; it is the
 *  one knob here that must stay an integer. */
const SPIN_TURNS = -2;
// --- THE CROSSFADE, AND THE VALLEY IT OPENS ---------------------------------
//
// THE BODY FADE'S FOUR EDGES LIVE HERE, not in the module that writes them.
// hero-driver owns the setBodyFade CHANNEL (it is range-tiled against
// story/fly.ts — see story.ts DIVE_P0), but everything this file does that must
// happen UNSEEN is timed against these numbers: the unroll's release, the spin's
// hard stop, and hero-driver's own shell/interior wink. They were four literals
// copied into three modules and a test; one owner is what lets
// __tests__/peelcards.test.ts assert the containments instead of re-typing the
// numbers, so a retune of the fade cannot silently push a snap into view.

/** THE BODY FADE OUT, absolute story p: the spread cast leaves under the
 *  arriving card shell, once the departure has landed. The cards' own fade-in
 *  crosses it, so the handover is a cross-dissolve. */
export const BODY_FADE_OUT: [number, number] = [
  atFrac(cdR, 0.42),
  atFrac(cdR, 0.54),
];
/** …AND BACK IN, onto the BARE MECHANISM (the wink and the departure channel's
 *  fall both happened inside the valley). It lands before the scene's hold
 *  centre, cards-local 0.73, so a reader parks on the lens and not a fade. */
export const BODY_FADE_BACK: [number, number] = [
  atFrac(cdR, 0.66),
  atFrac(cdR, 0.74),
];
/** THE VALLEY — the absolute-p stretch where the envelope is exactly 0 (both
 *  smoothsteps saturate, so this is an identity, not an approximation) and the
 *  lens is out of core/scene's applyVisibility altogether. THE load-bearing
 *  structure of the whole peel→cards seam: every snap in the chapter is put
 *  inside it. */
export const VALLEY: [number, number] = [BODY_FADE_OUT[1], BODY_FADE_BACK[0]];
/** THE SHELL'S AND THE INTERIOR'S WINK — hero-driver writes both gates on this
 *  one window. It MUST stay inside the valley: it files the departed pieces out
 *  of applyVisibility where nothing is drawn, and they stay gone until
 *  SHELL_BACK / INTERIOR_BACK. */
export const WINK_SPAN: [number, number] = [
  atFrac(cdR, 0.56),
  atFrac(cdR, 0.64),
];
/** THE ENVELOPE ITSELF, at absolute story p: 1 = the lens is there, 0 = gone,
 *  ink and glass with it (materials/unified.ts inkLineOpacity / glassInkOpacity,
 *  core/scene bodyMaterials). hero-driver hands this straight to setBodyFade for
 *  every p below the dive's first frame; story/fly.ts owns the channel from
 *  there on. Pure, so the law tests can walk it. */
export const peelBodyFadeAt = (p: number): number =>
  1 -
  smoothstep(BODY_FADE_OUT[0], BODY_FADE_OUT[1], p) +
  smoothstep(BODY_FADE_BACK[0], BODY_FADE_BACK[1], p);

/** cards: card k's fade-in window, offset by k·CARD_STAGGER. The eight windows
 *  cross BODY_FADE_OUT, so the shell of cards is up as the spread cast goes. */
const CARD_FADE_START = 0.3;
const CARD_FADE_HELD = 0.52;
/** cards: the LAST card is fully out by here — what sets the stagger below */
const CARD_FADE_DONE = 0.6;

/** cards: the field's own fade-out, crossing BODY_FADE_BACK — it hands back to
 *  the bare lens the way it took over from the whole one. */
const CARDS_OUT: [number, number] = [0.7, 0.88];

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

/** THE SHELL'S RADIUS, in world units — and it is a SPHERE, not a ladder of
 *  hoops: every card sits at exactly this distance from the lens centre
 *  (cardOrbitAt below is an identity, not a bound), so the shell clears the
 *  model everywhere at once, which a run of hoops could only promise ring by
 *  ring. MEASURED clearance: the seated model's world bounding box is 4.07 wu
 *  along the axis by 3.08 across (accessories excluded), i.e. a bounding sphere
 *  of √(2.04² + 1.54²) = 2.56 wu. THE taste knob, with SHELL_RATE. */
const SHELL_R = 5.2;
/** ONE COHERENT RATE, rad/s, ONE direction, shared by all eight — the field is a
 *  rigid shell that turns, not eight independent orbits. The old law gave each
 *  card its own ω AND alternated the direction by parity, which is the single
 *  biggest reason it read as aimless drift; there is no per-card variation here
 *  on purpose, because any at all shears the shell apart over a long hold.
 *
 *  IT CANNOT LITERALLY MATCH THE LENS, and the arithmetic says so. The lens
 *  turns on the SCROLL: its cruise is |SPIN_TURNS|·2π over the spin's span,
 *  = 4π / (0.1071 · (1 − SPIN_WIND_UP/2)) ≈ 142 rad per unit of p, and one unit
 *  of p is (1430 svh − 100 svh) ≈ 11 970 px on a 900 px viewport — so 0.0119
 *  rad per pixel scrolled, or ≈ 1.2 rad/s at 100 px/s and ≈ 6 rad/s at 500.
 *  There is no single number that meets a rate the VIEWER sets, and it is 0 the
 *  moment they stop.
 *
 *  SO THIS IS CHOSEN FOR THE HOLD, at the bottom of that range: the cards carry
 *  titles and (eventually) real work, and a field that keeps turning at the
 *  handover's rate while the reader has stopped scrolling is unreadable. It
 *  still reads as the same gesture continued, which is the ask. What it
 *  replaces ran at 0.05–0.086 rad/s — 73 to 126 SECONDS a revolution — two
 *  orders slower than anything a spin could hand over to. */
const SHELL_RATE = 0.9;
/** how far up and down the axis the eight stations reach, as a fraction of the
 *  radius: ±this is the highest latitude a card sits at. Short of 1 so no card
 *  parks on a POLE, where a rotation about the axis would leave it dead still. */
const SHELL_LAT = 0.78;

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

/** THE SPIN'S SPAN in absolute story p, [open, spent]. Exported so the laws are
 *  pinned against the window itself: a retune of SPIN_START/SPIN_END is a taste
 *  change and must not fail a test, while the shape's laws (still at cruise at
 *  the handover, a whole number of turns at the far edge) must. */
export const SPIN_SPAN: [number, number] = [
  atFrac(peR, SPIN_START),
  atFrac(cdR, SPIN_END),
];
/** The unroll's RELEASE in absolute story p, for the same reason. */
export const RELEASE_SPAN: [number, number] = [
  atFrac(cdR, PEEL_RELEASE[0]),
  atFrac(cdR, PEEL_RELEASE[1]),
];
/** THE SPIN'S SHAPE at story position `p`, normalized 0 → 1: accelerate over
 *  SPIN_WIND_UP, then cruise (story/reveal.ts accelCruiseAt — the chapter turn's
 *  own grammar). Exactly 0 below SPIN_SPAN's open and exactly 1 from its close
 *  on, so every consumer below is free at both edges. */
export const peelSpinAt = (p: number): number =>
  accelCruiseAt(
    (p - SPIN_SPAN[0]) / (SPIN_SPAN[1] - SPIN_SPAN[0]),
    SPIN_WIND_UP,
  );

/** THE LENS' OWN ROLL over the peel, radians about the OPTICAL AXIS — added to
 *  story/reveal.ts's `revealRollAt` in hero-driver's ONE setModelOrientation
 *  call. The two terms are disjoint in p (the reveal's is scaled by the explode
 *  channel, which is 0 everywhere before the trails scene), so they compose
 *  without either owning the other.
 *
 *  EXACTLY 0 AT BOTH EDGES — literally below the window, and past it because
 *  SPIN_TURNS is a whole number: the ramp's far edge lands the lens on a whole
 *  revolution, which is the same orientation it drops to here. So the story
 *  after the cards scene sees the same constant 0 it always did, and the dive
 *  still renders bit-for-bit unchanged. */
export const peelRollAt = (p: number): number =>
  p >= SPIN_SPAN[1] ? 0 : SPIN_TURNS * 2 * Math.PI * peelSpinAt(p);

/** Card k's opacity from the cross-fade alone, in CARDS-local fraction. */
export const cardFadeAt = (k: number, local: number): number =>
  smoothstep(
    CARD_FADE_START + k * CARD_STAGGER,
    CARD_FADE_HELD + k * CARD_STAGGER,
    local,
  );

/** How far the field has faded OUT, in CARDS-local fraction: 1 = gone. */
export const cardsFadeOutAt = (local: number): number =>
  smoothstep(CARDS_OUT[0], CARDS_OUT[1], local);

/** Card k's size, as a multiple of CARD_SIZE. */
export const cardScaleAt = (k: number): number =>
  CARD_SCALE0 + CARD_DSCALE * (k % 3);

/** THE ROLL (owner: "when the cards come off let's have it roll on its side a
 *  little bit"). Screen-plane rotation only — a roll rotates the billboard's
 *  corner offsets about the view axis, so the card still faces the camera
 *  dead-on (the 2D law holds; this is the one rotation a billboard may have).
 *  Coming off the strip a card is tipped ROLL_ENTRY over, rights itself as its
 *  fade completes (the same window, so a scrub replays it), and settles at a
 *  small per-card residual — photos laid out by hand, not by a grid.
 *
 *  NO IDLE SWAY. There used to be a ±1.6° breathing on a 9 s period on top of
 *  this, from when the field's own motion was too slow to read as motion at all;
 *  with the shell turning coherently (SHELL_RATE) it was a second, unrelated
 *  wobble on every card — the "aimless" half of what the rewrite is for. The
 *  roll is therefore a pure function of the SCROLL now: no time argument. */
const ROLL_ENTRY = deg(15);
const ROLL_REST = deg(3.2);
export const cardRollAt = (k: number, cardsLocal: number): number => {
  const sign = k % 2 === 0 ? 1 : -1;
  const entry = ROLL_ENTRY * sign * (1 + 0.25 * ((k % 3) - 1));
  const rest = ROLL_REST * sign * (1 + 0.3 * ((k % 4) - 1.5));
  return entry + (rest - entry) * cardFadeAt(k, cardsLocal);
};

/** Card k's LONGITUDE on the shell, at rest. SEEDED FROM THE SHELL'S SEAMS — the
 *  first five cards start where the five strips left, the last three halfway
 *  between them (eight cards do not divide by five). Here that is a real
 *  direction and not just a matching number: a sector's radial direction
 *  (cos θ, ·, sin θ) in the gltf frame lands on world (−sin θ, −cos θ) in Y–Z
 *  under core/scene's two model rolls, and the shell is written
 *  y = r·cos φ, z = r·sin φ — so φ = −(θ + π/2) puts the card on the strip's own
 *  meridian. */
const cardPhaseAt = (k: number): number =>
  -(segSectorAngle(k % SEG_COUNT) + Math.PI / 2) +
  (k >= SEG_COUNT ? Math.PI / SEG_COUNT : 0);

/** Card k's LATITUDE on the shell, as a fraction of the radius: eight stations
 *  evenly spread over [−SHELL_LAT, +SHELL_LAT], card 0 behind the mount and card
 *  7 out past the front element. The midpoint form ((2k+1)/n − 1) is what keeps
 *  both ends off the poles, where a card would sit still under the rotation. */
const cardLatAt = (k: number): number =>
  SHELL_LAT * ((2 * k + 1) / CARD_COUNT - 1);

/** Card k's centre at accumulated time `tMs`, in world units — a pure function
 *  of (k, t), so the field is reproducible frame to frame and in tests.
 *
 *  A SPHERICAL SHELL THAT TURNS AS ONE (owner: the lens "is replaced with the
 *  cards spinning"). Every card sits at exactly SHELL_R from the lens centre —
 *  |centre| is an identity here, not an inequality — on its own latitude and
 *  longitude, and the whole shell revolves about the OPTICAL AXIS (world X) at
 *  ONE rate, in ONE direction. A card therefore runs the latitude circle its
 *  station sits on: near the equator that is a wide sweep past the camera, near
 *  the ends a tighter one, and the axial station never moves, which is what
 *  makes the field read as one turning body instead of eight passers-by.
 *
 *  IT SUCCEEDS A RUN OF HOOPS at five radii, eight ω's and ALTERNATING
 *  directions, plus a vertical bob — every one of which was an independent
 *  motion, and together the reason the owner read the field as aimless. What is
 *  kept from it: the seeded longitudes (above), the per-card size ladder
 *  (cardScaleAt) and the entry tip (cardRollAt).
 *
 *  The occlusion still works for free: half the shell is behind the lens at any
 *  moment, and those cards are hidden by it (depthWrite, buildField). */
export const cardOrbitAt = (
  k: number,
  tMs: number,
): { x: number; y: number; z: number } => {
  const lat = cardLatAt(k);
  const ring = SHELL_R * Math.sqrt(1 - lat * lat);
  const phi = cardPhaseAt(k) + SHELL_RATE * (tMs / 1000);
  return {
    x: SHELL_R * lat,
    y: ring * Math.cos(phi),
    z: ring * Math.sin(phi),
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
/** the frame's matte — the even border around the photo, in face pixels.
 *  SQUARE corners (owner: "rectangles with square corners… like a picture
 *  frame"); the matte color is THEME paper, so the frame is paper-on-paper in
 *  light and ink-dark in dark rather than a fixed white. */
const FACE_BORDER = 20;
/** the strip under the photo that carries the title */
const FACE_TITLE_STRIP = 86;
const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
/** THE LABEL TYPE — one recipe for every small caption in the scene family:
 *  the card titles here and the star-atlas names (story/constellations.ts)
 *  wear the same uppercase tracked mono, per the owner ("same text style for
 *  consistency"). Weight/tracking here; each painter picks its own size. */
export const LABEL_TYPE = { weight: 500, trackingEm: 0.18 } as const;

/** the photo well's box, shared by the painter and the loader */
const WELL_W = FACE_W - FACE_BORDER * 2;
const WELL_H = FACE_H - FACE_BORDER * 2 - FACE_TITLE_STRIP;

/** One placeholder photo per card, seeded so every visit shows the same eight.
 *  Loaded ONCE per page and kept — a theme repaint reuses the pixels (only the
 *  matte and the title re-ink). null = failed (offline dev), the painter keeps
 *  the hatched well. */
const faceImages: (HTMLImageElement | null | undefined)[] = [];
function loadFaceImage(k: number, onReady: () => void): void {
  if (faceImages[k] !== undefined) return;
  // null = "in flight or failed" — either way the painter hatches the well,
  // and the guard above keeps a re-mount from fetching twice
  faceImages[k] = null;
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    faceImages[k] = img;
    onReady();
  };
  img.src = `https://picsum.photos/seed/lens-card-${k + 1}/${WELL_W}/${WELL_H}`;
}

/** Draw card `k`'s face: a PICTURE FRAME — an even theme-paper matte, square
 *  corners, the photo filling the well, and an uppercase mono title on the
 *  strip below, left-aligned. The photo is a seeded picsum placeholder until
 *  the owner supplies real content; the title likewise. */
function paintFace(canvas: HTMLCanvasElement, k: number, light: boolean): void {
  const c = light ? FACE_PALETTE.light : FACE_PALETTE.dark;
  const ctx = canvas.getContext("2d")!;

  // the matte — the whole face, edge to edge, square-cornered
  ctx.clearRect(0, 0, FACE_W, FACE_H);
  ctx.fillStyle = c.paper;
  ctx.fillRect(0, 0, FACE_W, FACE_H);

  // the photo well
  const img = faceImages[k];
  if (img) {
    ctx.drawImage(img, FACE_BORDER, FACE_BORDER, WELL_W, WELL_H);
  } else {
    // not loaded (yet, or offline): the hatched "image goes here" well
    ctx.save();
    ctx.beginPath();
    ctx.rect(FACE_BORDER, FACE_BORDER, WELL_W, WELL_H);
    ctx.clip();
    ctx.strokeStyle = c.rule;
    ctx.lineWidth = 2;
    for (let x = -WELL_H; x < WELL_W; x += 16) {
      ctx.beginPath();
      ctx.moveTo(FACE_BORDER + x, FACE_BORDER + WELL_H);
      ctx.lineTo(FACE_BORDER + x + WELL_H, FACE_BORDER);
      ctx.stroke();
    }
    ctx.restore();
  }
  // a hairline seat between photo and matte, so the well reads set-in
  ctx.strokeStyle = c.rule;
  ctx.lineWidth = 2;
  ctx.strokeRect(FACE_BORDER, FACE_BORDER, WELL_W, WELL_H);

  // the title: uppercase tracked mono under the image, LEFT-ALIGNED on the
  // well's own left edge (LABEL_TYPE — the star names wear the same recipe)
  const titlePx = 27;
  ctx.fillStyle = c.ink;
  ctx.font = `${LABEL_TYPE.weight} ${titlePx}px ${MONO}`;
  ctx.letterSpacing = `${titlePx * LABEL_TYPE.trackingEm}px`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(
    `PLACEHOLDER ${String(k + 1).padStart(2, "0")}`,
    FACE_BORDER,
    FACE_BORDER + WELL_H + 54,
  );
  ctx.letterSpacing = "0px";

  // the frame's outer edge, faint
  ctx.strokeStyle = c.rule;
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, FACE_W - 2, FACE_H - 2);
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
  /** (cos roll, sin roll) — the screen-plane roll, written per frame */
  uRollCS: { value: THREE.Vector2 };
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
    const uRollCS = uniform(new THREE.Vector2(1, 0));
    const mat = new THREE.MeshBasicNodeMaterial();
    // THE BILLBOARD (optics/starfield.ts starMark, one quad per mesh): the
    // centre goes to VIEW space through modelViewMatrix — the group carries no
    // transform, so that is just the world centre in the camera's frame — the
    // corner is added there in view-space world units, and only then does the
    // projection run. The quad therefore has no orientation of its own to get
    // wrong and stays exactly parallel to the film plane at any camera angle.
    // The ROLL rotates the corner offsets in that same view plane (cardRollAt)
    // — the one rotation that keeps a billboard a billboard.
    const centre = modelViewMatrix.mul(vec4(uCentre, 1));
    const px = positionGeometry.x.mul(uHalf.x);
    const py = positionGeometry.y.mul(uHalf.y);
    mat.vertexNode = cameraProjectionMatrix.mul(
      vec4(
        centre.x.add(px.mul(uRollCS.x).sub(py.mul(uRollCS.y))),
        centre.y.add(px.mul(uRollCS.y).add(py.mul(uRollCS.x))),
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
    cards.push({ mat, canvas, tex, uCentre, uOpacity, uRollCS });
  }
  return { group, geo, cards };
}

// --- the module -------------------------------------------------------------

/** dt clamp, ms — story/internals.ts's number, for its reason */
const DT_CLAMP_MS = 100;
/** THE MOUNT WINDOW, in absolute story p. The field mounts a whole scene EARLY
 *  — at the zoom — so its eight texture uploads (the cold mount's one real cost,
 *  ~80ms) land in a quiet beat instead of on the peel's first frames. The quads
 *  draw at opacity 0 until the fade windows open; alphaTest discards every
 *  pixel, so the early mount costs draw-call bookkeeping and nothing visible.
 *
 *  The TAIL is the CARDS SCENE'S OWN END, and it moved there when the field
 *  stopped outliving the scene: it used to fade out over the top of the
 *  internals scene, so the mount had to reach into it (0.26 of it, past that
 *  fade's 0.22). The field is now spent at cards-local 0.68 — CARDS_OUT's tip,
 *  the dissolve it hands the lens back on — so the last third of the scene
 *  draws eight fully transparent quads and nothing at all is carried into the
 *  scene that hands to the fly-through, the one place on the page with no frame
 *  budget to spare. The edge is the scene boundary rather than the dissolve's
 *  own tip because a mount window wants slack on both sides of what it covers.
 *  (The hysteresis below still holds the mount a little way past it, which is
 *  what keeps a scrub parked on the boundary from thrashing the build.)
 *
 *  EXPORTED for the same reason story/fly.ts's span edges are: story/cost.ts
 *  counts the field's eight draws at p and may not spell this window a second
 *  time, and story/__tests__/peelcards.test.ts pins it. */
export const MOUNT_LO = rangeOf("zoom").p0;
export const MOUNT_HI = cdR.p1;
/** scroll-p slack past each mount edge, so a scrub parked exactly on one cannot
 *  thrash build/dispose (story/fly.ts's HYST, one order coarser because what
 *  thrashes here is a build, not a look) */
export const MOUNT_HYST = 0.02;

export function createPeelCards(scene: SceneHandle): {
  frame(p: number): void;
} {
  let field: Field | null = null;
  let light = isLightTheme();
  let tAcc = 0;
  let last = performance.now();

  // The photos load AT BOOT, not at mount: a decode + texture upload landing
  // mid-peel is a visible hitch in the story's busiest animation (owner felt
  // it). By the time the field mounts the images are almost always cached and
  // the first draw carries them; a straggler repaints its face on arrival.
  for (let k = 0; k < CARD_COUNT; k++) {
    loadFaceImage(k, () => {
      if (!field) return;
      paintFace(field.cards[k].canvas, k, light);
      field.cards[k].tex.needsUpdate = true;
      scene.invalidate();
    });
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
    const cardsLocal = localOf(cdR, p);
    // the field hands BACK to the bare lens fading up under it (CARDS_OUT
    // against BODY_FADE_BACK) exactly as it took over from the whole one
    const alive = 1 - cardsFadeOutAt(cardsLocal);
    for (let k = 0; k < CARD_COUNT; k++) {
      const c = field.cards[k];
      const o = cardOrbitAt(k, tAcc);
      c.uCentre.value.set(o.x, o.y, o.z);
      c.uOpacity.value = cardFadeAt(k, cardsLocal) * alive;
      const roll = cardRollAt(k, cardsLocal);
      c.uRollCS.value.set(Math.cos(roll), Math.sin(roll));
    }
  });

  return {
    frame(p) {
      // THE UNROLL CHANNEL, value AND target: a pure function of the scroll, so
      // a scrub in either direction lands on the same pose and tick()'s ease can
      // never chase a stale target.
      const peel = peelValueAt(p);
      scene.state.peel = peel;
      scene.state.peelTarget = peel;

      const want = p >= MOUNT_LO && p <= MOUNT_HI;
      if (want && !field) mount();
      else if (
        field &&
        (p < MOUNT_LO - MOUNT_HYST || p > MOUNT_HI + MOUNT_HYST)
      )
        unmount();
    },
  };
}
