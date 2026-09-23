// The hero driver's envelopes, as pure functions of the story position `p`.
// Story mode evaluates them at the eased p, so at rest the frame is exactly
// what they say.
//
// HOMEPAGE-CHUNK LAW: the driver is in the initial chunk, so this may import
// only core/, story/story.ts and story/reveal.ts — never optics/ or a lazy
// story module (fly/trails/constellations).

import { clamp01, deg, smoothstep } from "../core/math";
import { MODEL_BORE_X_Z } from "../core/scene";
import {
  DIVE_P0,
  FLY_EXIT_END,
  RANGES,
  atFrac,
  pulseFn,
  rangeOf,
  span,
  windowEdges,
  type StoryWindow,
} from "./story";
import { ROLL_P1, revealRollAt } from "./reveal";

// scene ranges — all pacing derives from the STORY table durations
const heroR = RANGES[0];
const zR = rangeOf("zoom");
const peR = rangeOf("peel");
const caR = rangeOf("cards");
const inR = rangeOf("internals");
const fR = rangeOf("flythrough");
const rwR = rangeOf("rewrap");
const capR = rangeOf("capsOn");

// --- the mechanism channels --------------------------------------------------
// Each mechanism PULSES over its own scene — rises during the hold, resets
// during the NEXT scene's transit.

/** the zoom channel's window: up over the zoom scene, back down over the peel */
export const ZOOM_PULSE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["zoom", 0.15, 0.85],
  fall: ["peel", 0, 0.4],
};

/** The descent: the explode channel's fall, and the knob for the ending's
 *  pacing. The last pieces must land inside ROCK, before ROSE_PULSE's foot. */
export const CONSTRUCT: StoryWindow = ["capsOn", 0.03, 0.64];

export const EXPLODE_PULSE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["trails", 0.05, 0.5],
  fall: CONSTRUCT,
};

/** The DEPARTURE: the outer layers come apart on the assemble channel — the
 *  reassembly reversed (rising IS coming apart), scoped off the mechanism by
 *  `ASSEMBLE_KEEP_SCOPE`. The layer order is the recipe's gate stagger, not
 *  this window's. The rise fills the peel scene so every piece flies its whole
 *  flight in frame; the fall waits until every one of them has dissolved
 *  (WINK_SPAN's end). */
export const CARDS_APART: { rise: StoryWindow; fall: StoryWindow } = {
  rise: [
    ["zoom", 0.85],
    ["peel", 0.96],
  ],
  fall: ["cards", 0.16, 0.3],
};

/** The lens stands up for the internals scene: 0 = the bore lies along world
 *  +X, the pose every other scene is written against; 1 = it points at +Y. The
 *  fall must land INSIDE the flythrough transit — the dive is written along
 *  world +X and needs the bore exactly on that axis before its first frame. */
export const UPRIGHT: { rise: StoryWindow; fall: StoryWindow } = {
  rise: [
    ["cards", 0.8],
    ["internals", 0.3],
  ],
  fall: ["flythrough", 0, 0.2],
};

/** the tip, 0..1 — a pulse like the mechanism channels, and 0 at both ends of
 *  the track so no other span sees the model off its authored axis */
export const uprightAt = pulseFn(UPRIGHT, "upright");

/** THE NOSE DIP: the bore sits a little below horizontal across the cards
 *  scene, so peelcards' turn about world +Y sweeps a cone rather than a flat
 *  spin. It must stay inside the cards scene, disjoint from the peel's bore
 *  roll — the driver folds both into the same `z`, and a dipped bore under that
 *  roll precesses instead of rolling in place. */
export const DIP: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["cards", 0, 0.3],
  fall: UPRIGHT.rise,
};

/** THE HUDDLE: the bare core draws axially compact for the cards chapter. It
 *  may not start before the scene boundary — the peel's departing pieces fly
 *  from SEATED positions — and its release is UPRIGHT's own rise. */
export const HUDDLE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["cards", 0.02, 0.16],
  fall: UPRIGHT.rise,
};

/** the huddle at p, 0..1 — 0 at both ends of the track */
export const huddleAt = pulseFn(HUDDLE, "huddle");

/** how far the nose dips, radians */
export const DIP_MAX = deg(15);

const dipFracAt = pulseFn(DIP, "dip");

/** the dip at p, radians ≥ 0 — hero-driver SUBTRACTS it from the tip's own
 *  `MODEL_BORE_X_Z * (1 − uprightAt(p))`; exactly 0 outside the window */
export const dipAt = (p: number): number => DIP_MAX * dipFracAt(p);

/** THE SPINNING-TOP ROCK: the standing lens nutates about the bore while the
 *  last pieces land, damping to dead still before the bloom opens. A cone, not
 *  a tilt — `rockZAt` goes on the model's tilt and `rockYAt` on its turn. Both
 *  are exactly 0 outside the window and C1 at both edges. */
export const ROCK: StoryWindow = ["capsOn", 0.42, 0.72];

/** how far the bore leans at the wobble's peak, radians */
export const ROCK_MAX = deg(12);

/** turns of precession across the window */
const ROCK_TURNS = 2.25;

const [ROCK_P0, ROCK_P1] = span("rock", windowEdges(ROCK));

const ROCK_SPAN = ROCK_P1 - ROCK_P0;
const ROCK_RATE = 2 * Math.PI * ROCK_TURNS;

/** the lean at p, radians ≥ 0 — up off zero rate, then damped out */
const rockLeanAt = (p: number): number => {
  const u = clamp01((p - ROCK_P0) / ROCK_SPAN);
  return ROCK_MAX * smoothstep(0, 0.15, u) * (1 - smoothstep(0.45, 1, u));
};

/** where the lean points at p, radians round the bore */
const rockPhaseAt = (p: number): number =>
  ROCK_RATE * clamp01((p - ROCK_P0) / ROCK_SPAN);

export const rockZAt = (p: number): number =>
  rockLeanAt(p) * Math.cos(rockPhaseAt(p));

export const rockYAt = (p: number): number =>
  rockLeanAt(p) * Math.sin(rockPhaseAt(p));

/** The bloom — the one channel with no fall; the story ends inside it. It may
 *  not overlap the assemble or explode channels (all fold the same wedge), so
 *  its foot sits past both falls — channel-ease.test.ts pins the order. */
export const ROSE_PULSE: { rise: StoryWindow } = {
  rise: ["capsOn", 0.72, 0.96],
};

export const zoomAt = pulseFn(ZOOM_PULSE, "zoom");
export const explodeAt = pulseFn(EXPLODE_PULSE, "explode");

/** The assemble channel runs ONCE on the track — the cards scene's departure,
 *  and nothing else. It may not run in the ending: the host SUMS each recipe's
 *  delta, so two saturated recipes cannot compose into a rigid pose. */
export const assembleAt = pulseFn(CARDS_APART, "cards.apart");
export const roseAt = pulseFn(ROSE_PULSE, "rose");

/** THE ENDING'S SPREAD (ops/recipes.ts `explode.bloom`): how far up its own
 *  meridian each piece slides at full channel, in its own seat radii. A story
 *  knob over the recipe's /lens default; a constant, since the spread's pacing
 *  is EXPLODE_PULSE's. */
export const ENDING_BLOOM = 4.5;

/** THE MID-FALL CURL (ops/recipes.ts `explode.curl`): how far off its seated
 *  radius a shell wedge opens on the way down, as a coil factor beyond 1. The
 *  recipe's window is the piece's own flight, so it is 0 at the park and 0 at
 *  the seat. A story knob over the recipe's 0 default. */
export const ENDING_CURL = 4.5;

/** THE RING PHASE (ops/recipes.ts `explode.ringPhase`): turns of parked azimuth
 *  per model-mm of a piece's ladder station, which offsets each ladder group's
 *  seams so the park reads as broken concentric rings rather than a pinwheel.
 *  A story knob over the recipe's 0 default. */
export const ENDING_RING_PHASE = 0.0325;

/** THE PARKED REBEND (ops/recipes.ts `explode.rebend`): 1 = each parked wedge
 *  is re-bent, at constant arc length, to the radius of the ring the spread has
 *  carried it to, relaxing to its own curvature as it flies home. A story knob
 *  over the recipe's 0 default. */
export const ENDING_REBEND = 1;

/** The departure's scope knob (ops/recipes.ts `assemble.keepScope`), 1 for the
 *  whole story. A constant: a step would move the keep-set mid-glide. */
export const ASSEMBLE_KEEP_SCOPE = 1;

// --- the iris hand-over ------------------------------------------------------

/** The aperture ramps shut over the tail of the internals scene and stays
 *  there, so the dive's own opening ramp starts from f/22 with no jump. */
export const PRE_SHUT = span("preShut", [atFrac(inR, 0.6), atFrac(inR, 0.95)]);

/** The pre-shut ramp — ONE law across both edges of the scene.
 *  story/internals.ts calls it inside the span and adds its breath on top; the
 *  driver writes it outside the span. */
export const preShutAt = (p: number): number =>
  smoothstep(PRE_SHUT[0], PRE_SHUT[1], p);

/** Where the driver hands focus and aperture to story/internals.ts. The two
 *  writers overlap across the slack, where both laws are exactly 0. */
export const IRIS_HANDOVER = atFrac(caR, 0.15) - 0.02;

/** …and where it takes them back: the internals scene's end. */
export const IRIS_HANDBACK = inR.p1;
span("iris.handover", [IRIS_HANDOVER, IRIS_HANDBACK]);

/** story/internals.ts owns focus and aperture across the cards + internals
 *  span; the two writers are separated by RANGE, not order. */
export const driverOwnsIris = (p: number): boolean =>
  p < IRIS_HANDOVER || p > IRIS_HANDBACK;

// --- the look ----------------------------------------------------------------

/** Ink fill: wireframe → half through zoom → full at the peel, and full for the
 *  rest of the story. The fills may not dip below the edge lines' flat alpha
 *  (materials/unified.ts `inkLineOpacity`) or pieces draw as hollow outlines. */
export const INK_HALF = span("ink.half", [atFrac(zR, 0.0), atFrac(zR, 0.5)]);
export const INK_FULL = span("ink.full", [peR.p0, atFrac(peR, 0.35)]);

export const inkFillAt = (p: number): number =>
  0.5 * smoothstep(INK_HALF[0], INK_HALF[1], p) +
  0.5 * smoothstep(INK_FULL[0], INK_FULL[1], p);

/** The shell's way back, at the rewrap's first frames — behind the opaque sky
 *  backdrop story/fly.ts still holds, so the pop is unseen. */
export const SHELL_BACK = span("shell.back", [rwR.p0, atFrac(rwR, 0.05)]);

// --- THE WINK ---------------------------------------------------------------
// How the sides disappear: once carried off the lens the outer casts dissolve,
// piece by piece, outside-in (core/visibility.ts's bands and scatter), and the
// cards are born on them (story/peelcards.ts). The mechanism under them is
// never hidden and never moves (ops/recipes.ts `keepScope`).

/** THE SHELL'S AND THE INTERIOR'S WINK — hero-driver writes both gates on this
 *  one window. It overlaps the departure's tail rather than queueing after it,
 *  but no piece may begin to dissolve before its own flight is over. It runs
 *  into the cards scene, under the turn, and must be spent before
 *  CARDS_APART's fall walks the departed pieces home. */
export const WINK_SPAN = span("wink", [atFrac(peR, 0.57), atFrac(caR, 0.15)]);

/** The wink LEVEL at p: 1 above the span, 0 past it — what every governed piece
 *  compares its threshold against on the way out. */
export const winkLevelAt = (p: number): number =>
  1 - smoothstep(WINK_SPAN[0], WINK_SPAN[1], p);

/** The p at which the wink level reaches `level` — winkLevelAt's inverse on
 *  the span, by bisection (a smoothstep has no closed inverse). */
export const winkPAt = (level: number): number => {
  let lo = WINK_SPAN[0];
  let hi = WINK_SPAN[1];
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (winkLevelAt(mid) > level) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
};

/** The shell's wink-out and its way back. One envelope for all three casts —
 *  the per-piece thresholds order them outside-in. */
export const shellFadeAt = (p: number): number =>
  winkLevelAt(p) + smoothstep(SHELL_BACK[0], SHELL_BACK[1], p);

/** The interior's return, UNDER THE INK: a wink only dissolves while the body
 *  is transparent (materials/unified.ts `bodyTransparent`), and the dive draws
 *  the body opaque from DIVE_P0 − HYST on, so the window sits inside the
 *  approach's ink-out (story/fly.ts flyInkAt), where the pieces arrive as ink
 *  the way they left. envelopes.test.ts pins every wink window to that cover. */
export const INTERIOR_BACK = span("interior.back", [fR.p0, atFrac(fR, 0.12)]);

/** Cladding + rest-cast leave on the shell's window but return over the
 *  flythrough approach, so the dive flies through the full interior. */
export const interiorFadeAt = (p: number): number =>
  winkLevelAt(p) + smoothstep(INTERIOR_BACK[0], INTERIOR_BACK[1], p);

// --- the dust ----------------------------------------------------------------

/** Where the bloom's petals mount (story/petals.ts SPAN_P0): a pad below the
 *  rose's foot, so a scrub parked on the edge cannot thrash the mount. */
export const PETALS_P0 = windowEdges(ROSE_PULSE.rise)[0] - 0.01;

/** THE DUST: the ambient motes (story/cinematics.ts) are off through the dive,
 *  where they would float in front of the sky, and from the petals' mount on,
 *  where the petals replace them. ONE writer — the driver — so the two spans
 *  cannot race on a resume. */
export const dustAt = (p: number): boolean =>
  !(p >= DIVE_P0 && p <= FLY_EXIT_END) && p < PETALS_P0;

// --- the stage tint ----------------------------------------------------------

/** An 8-bit RGB triple, the form the STORY table authors a stage tint in. */
export type Rgb = [number, number, number];
/** One tint stop: the story p it is authored at, and the colour there. */
export type BgStop = [number, Rgb];

/** The tint stop table for a theme: each scene's authored tint at its
 *  hold-centre. Built once per theme, not per frame. */
export const bgStopsFor = (light: boolean): BgStop[] =>
  RANGES.map((r) => [(r.p0 + r.p1) / 2, light ? r.scene.bgLight : r.scene.bg]);

/** The tint at p, interpolated between the two bracketing stops and rounded to
 *  whole channel values. Writes into `out`: the per-frame path allocates
 *  nothing. */
export const bgTintAt = (
  stops: BgStop[],
  p: number,
  out: Rgb = [0, 0, 0],
): Rgb => {
  let i = 0;
  while (i < stops.length - 2 && p > stops[i + 1][0]) i++;
  const [pa, a] = stops[i];
  const [pb, b] = stops[i + 1];
  const t = clamp01((p - pa) / Math.max(1e-3, pb - pa));
  out[0] = Math.round(a[0] + (b[0] - a[0]) * t);
  out[1] = Math.round(a[1] + (b[1] - a[1]) * t);
  out[2] = Math.round(a[2] + (b[2] - a[2]) * t);
  return out;
};

/** The tint at p for a theme, for readers that do not hold a table. */
export const bgAt = (p: number, light: boolean): Rgb =>
  bgTintAt(bgStopsFor(light), p);

// --- the instrument chrome ---------------------------------------------------

/** The scene whose range contains p — the HUD index and the rail's lit dot.
 *  Past the last range it is the last scene: the story is over, not absent. */
export const sceneIndexAt = (p: number): number => {
  for (let k = 0; k < RANGES.length; k++) if (p < RANGES[k].p1) return k;
  return RANGES.length - 1;
};

/** The HUD's f-stop table — the aperture channel quantized onto real stops. */
export const F_STOPS = ["2.8", "4", "5.6", "8", "11", "16", "22"];

/** The HUD's focal length, mm: the zoom channel across the lens' own range. */
export const focalMmAt = (zoom: number): number => Math.round(18 + zoom * 32);

/** The HUD's f-stop for an aperture channel value. */
export const fStopOf = (aperture: number): string =>
  F_STOPS[Math.round(clamp01(aperture) * (F_STOPS.length - 1))];

/** the scroll cue lives only in the hero */
export const SCROLL_CUE = span("scrollCue", [
  atFrac(heroR, 0.1),
  atFrac(heroR, 0.9),
]);

export const scrollCueAt = (p: number): number =>
  1 - smoothstep(SCROLL_CUE[0], SCROLL_CUE[1], p);

/** Instrument chrome fades over the tail of the final scene, derived from the
 *  capsOn range rather than absolute p. */
export const CHROME_FADE = span("chrome", [atFrac(capR, 0.77), capR.p1]);

export const chromeAt = (p: number): number =>
  1 - smoothstep(CHROME_FADE[0], CHROME_FADE[1], p);

// --- the model's orientation ------------------------------------------------

// THE BORE ROLL: the peel scene's own lens motion — the body turns rigidly
// about its optical axis while the layers unwrap off it. It rides the model's
// `x` euler, which is a bore roll only while the turn (`y`) and the dip (`z`)
// are exactly 0: `orientationAt` composes Rx·Ry·Rz.

/** peel: the roll's span, spent before the scene ends */
const ROLL_START = 0.06;
const ROLL_END = 0.92;
/** WHOLE turns about the bore, SIGNED — negative is the departure's own winding
 *  direction (ops/house WRAP_DIR). It MUST stay an integer: peelRollAt drops to
 *  exactly 0 past the window, and a whole revolution makes that an identity. */
const ROLL_TURNS = -1;

/** THE BORE ROLL'S SPAN in absolute story p, [open, spent]. */
export const PEEL_ROLL_SPAN = span("peel.roll", [
  atFrac(peR, ROLL_START),
  atFrac(peR, ROLL_END),
]);

/** THE BORE ROLL'S SHAPE at p, normalized 0 → 1 — a smoothstep, so the body
 *  winds up and settles in plain sight. */
export const peelRollFracAt = (p: number): number =>
  smoothstep(PEEL_ROLL_SPAN[0], PEEL_ROLL_SPAN[1], p);

/** THE LENS' ROLL, radians about its OWN BORE — `orientationAt`'s `x` where the
 *  reveal's roll is 0. Exactly 0 at both edges: below the window literally,
 *  past it because ROLL_TURNS makes the drop an identity. */
export const peelRollAt = (p: number): number =>
  p >= PEEL_ROLL_SPAN[1] ? 0 : ROLL_TURNS * 2 * Math.PI * peelRollFracAt(p);

// THE TURN: the cards scene's one motion — the lens turns clockwise about world
// +Y with its bore dipped below horizontal, so the nose sweeps a cone. It is
// spent exactly where the lens reaches vertical (UPRIGHT), where a rotation
// about +Y no longer moves the bore.

/** cards: where the turn opens — the frame the peel hands over on. The ramp
 *  leaves at rate exactly 0, so no frame reads as its first. */
const TURN_START = 0;
/** internals: where it is spent, and where the lens is fully upright */
const TURN_END = 0.3;
/** WHOLE revolutions about world +Y, SIGNED — negative sweeps the nose from
 *  world +X toward +Z, clockwise from above. It MUST stay an integer, for the
 *  same reason as ROLL_TURNS. */
const TURN_TURNS = -2;

/** THE TURN'S SPAN in absolute story p, [open, spent]. */
export const TURN_SPAN = span("peel.turn", [
  atFrac(caR, TURN_START),
  atFrac(inR, TURN_END),
]);

/** THE TURN'S SHAPE at p, normalized 0 → 1 over TURN_SPAN — a smoothstep, so
 *  the rate is 0 at BOTH edges. */
export const peelTurnFracAt = (p: number): number =>
  smoothstep(TURN_SPAN[0], TURN_SPAN[1], p);

/** THE LENS' TURN, radians about WORLD +Y — `orientationAt`'s `y` where the
 *  rock is 0. Exactly 0 at both edges, as peelRollAt is. */
export const peelTurnAt = (p: number): number =>
  p >= TURN_SPAN[1] ? 0 : TURN_TURNS * 2 * Math.PI * peelTurnFracAt(p);

/** The reveal's roll is live from the explode rise's foot (it scales by the
 *  channel) to ROLL_P1 — registered here, where both edges are known. */
span("roll", [windowEdges(EXPLODE_PULSE.rise)[0], ROLL_P1]);

/** The model's euler at p, radians — the one formula behind
 *  setModelOrientation. x: the peel's bore roll, then the reveal's own; y: the
 *  cards' turn about world +Y plus the rock; z: the tip (bore on world +X, up
 *  for the internals) less the nose dip, plus the rock's other half. */
export const orientationAt = (
  p: number,
  out = { x: 0, y: 0, z: 0 },
): { x: number; y: number; z: number } => {
  out.x = peelRollAt(p) + revealRollAt(p, explodeAt(p));
  out.y = peelTurnAt(p) + rockYAt(p);
  out.z = MODEL_BORE_X_Z * (1 - uprightAt(p)) - dipAt(p) + rockZAt(p);
  return out;
};
