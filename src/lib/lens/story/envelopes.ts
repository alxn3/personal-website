// The hero driver's envelopes, as pure functions of the scroll position `p`.
// Driver-owned math only — anything that touches the DOM stays in
// story/hero-driver.ts.
//
// HOMEPAGE-CHUNK LAW: the driver is in the initial chunk, so this may import
// core/math.ts, story/story.ts, story/reveal.ts and story/peelcards.ts, and may
// NEVER import optics/ or a lazy story module (fly/trails/constellations).
//
// Every window is a named constant so story/state.ts and the STORY-MAP can
// report its edges without a second copy of them.

import { clamp01, deg, smoothstep } from "../core/math";
import {
  DIVE_P0,
  RANGES,
  atFrac,
  pulseFn,
  rangeOf,
  windowEdges,
  type StoryWindow,
} from "./story";
import { WINK_SPAN } from "./peelcards";

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
// during the NEXT scene's transit. All breakpoints derive from the ranges.

/** the zoom channel's window: up over the zoom scene, back down over the peel */
export const ZOOM_PULSE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["zoom", 0.15, 0.62],
  fall: ["peel", 0, 0.4],
};

/** THE DESCENT — THE knob for the ending's pacing. It opens on the last
 *  scene's own foot (the explode channel is exactly 1 for every frame of the
 *  rewrap, so the reveal is pure rotation at a constant radius) and it is the
 *  ending's LONG beat: the middle pieces leave on the still face-on frame, the
 *  camera's quarter-turn runs over the middle of it, and the last pieces land
 *  inside the rock, a settle beat before ROSE_PULSE's foot. */
export const CONSTRUCT: StoryWindow = ["capsOn", 0, 0.64];

export const EXPLODE_PULSE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["trails", 0.05, 0.5],
  fall: CONSTRUCT,
};

/** The DEPARTURE: the outer layers come apart on the assemble channel — the
 *  sky chapter's reassembly reversed (rising IS coming apart), scoped off the
 *  mechanism by `ASSEMBLE_KEEP_SCOPE` so the internals are revealed in place.
 *  The layer order is the recipe's gate stagger, not this window's.
 *
 *  IT IS THE REASSEMBLY RUN BACKWARDS AND NOTHING ELSE: the same recipe, the
 *  same gate, the same per-piece flight the sky chapter flies home on, played
 *  from 0 to 1 instead of 1 to 0. No second chain rides along with it, and the
 *  sticker peel is not in the story at all.
 *
 *  IT IS THE PEEL SCENE AND IT FILLS IT: the rise opens under the camera's
 *  swing to the rear and runs to where the bore roll is spent, so every piece
 *  the departure moves flies its whole flight IN FRAME and the deepest ranks
 *  are still travelling where the wink's first casts go (peelcards WINK_SPAN)
 *  — the two overlap, they do not queue. No piece is taken before its OWN
 *  flight is over (story/__tests__/piece-flow.test.ts pins the per-piece
 *  margin). THE FALL waits until every piece the departure moves is gone,
 *  which is what makes it invisible now that the body fade no longer covers
 *  it. */
export const CARDS_APART: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["peel", 0.1, 0.92],
  fall: ["cards", 0.12, 0.26],
};

/** THE LENS STANDS UP for the internals scene: 0 = the bore lies along world
 *  +X, the pose every other scene is written against; 1 = it points at +Y.
 *
 *  IT TIPS ON THE CARDS' TAIL, under the field's own dissolve, so the scene
 *  hands over already turning, and it is upright well inside the internals
 *  camera transit — the camera's move and the lens' are one gesture.
 *
 *  AND IT COMES BACK DOWN OVER THE DIVE'S APPROACH, because the fly-through is
 *  written along world +X: the model dollies down its own bore, and the sky and
 *  the wormhole take their axis from it. The approach transit is where the
 *  camera swings onto that axis anyway, so the two moves are the same beat. It
 *  lands INSIDE that transit rather than on its edge, so the bore is exactly on
 *  the dive's axis before story/fly.ts's first frame rather than to a float. */
export const UPRIGHT: { rise: StoryWindow; fall: StoryWindow } = {
  rise: [
    ["cards", 0.8],
    ["internals", 0.3],
  ],
  fall: ["flythrough", 0, 0.2],
};

/** the tip, 0..1 — a pulse like the mechanism channels, and 0 at both ends of
 *  the track so no other span sees the model off its authored axis */
export const uprightAt = pulseFn(UPRIGHT);

/** THE NOSE DIP: the bore sits a little BELOW horizontal across the cards
 *  scene, so story/peelcards.ts's turn about world +Y sweeps a cone rather than
 *  reading as a flat spin. Its fall IS the tip's rise, so the dip is spent
 *  exactly as the lens stands up and no span outside the pair sees it.
 *
 *  IT OPENS WITH THE TURN, not in the peel: the driver folds the dip into the
 *  same `z` the tip writes, and the peel's bore roll is applied on top of that
 *  `z` — a dipped bore under that roll would precess instead of rolling in
 *  place. Keeping the dip inside the cards scene keeps the two disjoint. */
export const DIP: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["cards", 0, 0.3],
  fall: UPRIGHT.rise,
};

/** THE HUDDLE: the bare core draws axially compact for the cards chapter —
 *  with the barrel gone the keep-set's seated anatomy has real air between the
 *  glass, the stop and the mount, and the turn would show a strung-out chain
 *  where the sketch shows a lens. It opens with the turn (the peel's departing
 *  pieces fly from SEATED positions, so it may not start before the scene
 *  boundary) and its release IS the stand-up: the fall is UPRIGHT's own rise,
 *  so stretching into the internals stack and tipping vertical read as one
 *  hand-over gesture, spent well before anything the dive returns. */
export const HUDDLE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["cards", 0.02, 0.16],
  fall: UPRIGHT.rise,
};

/** the huddle at p, 0..1 — 0 at both ends of the track */
export const huddleAt = pulseFn(HUDDLE);

/** how far the nose dips, radians */
export const DIP_MAX = deg(15);

const dipFracAt = pulseFn(DIP);

/** the dip at p, radians, ≥ 0 — hero-driver SUBTRACTS it from the tip's own
 *  `MODEL_BORE_X_Z * (1 − uprightAt(p))`, and it is exactly 0 outside the
 *  window, so every other span's tilt is untouched to the bit. */
export const dipAt = (p: number): number => DIP_MAX * dipFracAt(p);

/** THE SPINNING-TOP ROCK: the standing lens nutates about the bore while the
 *  last pieces land, and damps to dead still before the bloom opens. It is the
 *  ending's only model motion — the descent's own camera turn is the camera's.
 *
 *  A CONE, not a tilt: the driver adds `rockZAt` to the model's tilt and
 *  `rockYAt` to its turn, two axes square to the bore, so the bore itself walks
 *  a circle at the rate below. Both are EXACTLY 0 outside the window and C1 at
 *  both edges (the envelope's rise and its damping each leave at zero rate), so
 *  no other span sees the model off its authored axis and the bloom opens on a
 *  frame that is still to the bit. */
export const ROCK: StoryWindow = ["capsOn", 0.44, 0.7];

/** how far the bore leans at the wobble's peak, radians */
export const ROCK_MAX = deg(9);

/** turns of precession across the window */
const ROCK_TURNS = 1.75;

const [ROCK_P0, ROCK_P1] = windowEdges(ROCK);
const ROCK_SPAN = ROCK_P1 - ROCK_P0;
const ROCK_RATE = 2 * Math.PI * ROCK_TURNS;

/** the lean at p, radians ≥ 0 — up off zero rate, then damped out */
const rockLeanAt = (p: number): number => {
  const u = clamp01((p - ROCK_P0) / ROCK_SPAN);
  return ROCK_MAX * smoothstep(0, 0.18, u) * (1 - smoothstep(0.3, 1, u));
};

/** where the lean points at p, radians round the bore */
const rockPhaseAt = (p: number): number =>
  ROCK_RATE * clamp01((p - ROCK_P0) / ROCK_SPAN);

export const rockZAt = (p: number): number =>
  rockLeanAt(p) * Math.cos(rockPhaseAt(p));

export const rockYAt = (p: number): number =>
  rockLeanAt(p) * Math.sin(rockPhaseAt(p));

/** The bloom — the one channel with no fall; the story ends inside it. Its foot
 *  is the SPIRAL'S far edge plus a settle beat: the pieces are home and still
 *  before the first petal moves. It may not overlap the assemble channel (both
 *  fold the same wedge) — authored in p, ENFORCED on the eased channel by
 *  `wrapBloomWrite`. */
export const ROSE_PULSE: { rise: StoryWindow } = {
  rise: ["capsOn", 0.72, 0.96],
};

export const zoomAt = pulseFn(ZOOM_PULSE);
export const explodeAt = pulseFn(EXPLODE_PULSE);

/** THE ASSEMBLE CHANNEL RUNS ONCE ON THE TRACK — the cards scene's departure,
 *  and nothing else. IT IS NOT IN THE ENDING: the host SUMS each recipe's
 *  delta, so two saturated recipes cannot compose into a rigid pose, and the
 *  wrap's park terms are meridian TRANSLATIONS that carry a wedge off the ring
 *  it lands on. The ending's cloud and its descent are the EXPLODE recipe
 *  alone, which is what lets the flat opening frame sit every piece on its own
 *  arc, untilted and evenly spaced.
 *
 *  IT IS ALSO ON THE RAW CLOCK, all of it: that whole neighbourhood — the card
 *  windows, the wink, the peel's own roll — is written value-and-target off the
 *  raw scroll, so its sequencing holds on the values the shader reads. The
 *  channel that outlives the scroll in the ending is the SPREAD, and that one
 *  is core/scene's ease from end to end. */
export const assembleAt = pulseFn(CARDS_APART);
export const roseAt = pulseFn(ROSE_PULSE);

/** THE ENDING'S SPREAD (ops/recipes.ts `explode.bloom`): how far up its own
 *  meridian each piece slides at full channel, in its own seat radii. A knob
 *  rather than the recipe's default because the two readers frame the cloud from
 *  very different distances — the story's camera parks 30 world units out and
 *  wants the whole barrel opened into rings, /lens orbits the lens itself and
 *  wants an exploded view that stays on screen. The recipe's own default is
 *  /lens's; this is the story's.
 *
 *  A CONSTANT, not an envelope: the spread's PACING is the explode channel's
 *  (EXPLODE_PULSE), and a knob that moved with p would be a second clock on the
 *  same motion. */
export const ENDING_BLOOM = 4.5;

/** THE MID-FALL CURL (ops/recipes.ts `explode.curl`): how far off its seated
 *  radius a shell wedge opens on the way down, as a coil factor beyond 1. The
 *  wrap beat, back on the descent alone — the recipe's window is the piece's own
 *  flight, so the curl is exactly 0 at the park and exactly 0 at each piece's
 *  seat, and the only thing it changes is the shape in the air.
 *
 *  A STORY knob at the recipe's 0 default, like `ENDING_BLOOM`: /lens's exploded
 *  view is an inspection control and its parts stay at their authored shape. */
export const ENDING_CURL = 4.5;

/** THE RING PHASE (ops/recipes.ts `explode.ringPhase`): turns of parked azimuth
 *  per model-mm of a piece's ladder station. Every shell is cut on the SAME
 *  meridians, so a park pose that only slides each piece out along its own
 *  leaves all the seams on one set of radial lines and the cloud reads as a
 *  five-armed pinwheel. One turn per ladder GROUP breaks that: the ring keeps
 *  its even spacing (the station is per group) and its gaps land where no
 *  neighbour's do, so the figure reads as the trails' broken concentric circles.
 *
 *  A STORY knob at the recipe's 0 default, like `ENDING_BLOOM` and
 *  `ENDING_CURL`: /lens's exploded view is an inspection control and keeps each
 *  piece square to its own seat meridian. */
export const ENDING_RING_PHASE = 0.0325;

/** THE PARKED REBEND (ops/recipes.ts `explode.rebend`): 1 = each parked wedge
 *  is re-bent, at constant arc length, to the radius of the ring the spread
 *  has carried it to — the mandala's arcs ARE arcs of the circles they sit on
 *  — and it relaxes back to its own curvature as it flies home, matching its
 *  current ring the whole way down. Exactly the seat's shape at the seat.
 *
 *  A STORY knob at the recipe's 0 default, like the rest of the ENDING_*
 *  family: /lens's exploded view keeps every piece's authored shape. */
export const ENDING_REBEND = 1;

/** The departure's scope knob (ops/recipes.ts `assemble.keepScope`), 1 for the
 *  whole story: the wrap runs over the cards chapter and nowhere else now, and
 *  there it must reveal the mechanism in place, so there is no second scope to
 *  step to. A CONSTANT rather than a step, because the eased channel outlives
 *  its target — a step anywhere on the track would move the keep-set under a
 *  tail that is still live. /lens keeps the recipe's own 0 default. */
export const ASSEMBLE_KEEP_SCOPE = 1;

/** The eased fold's floor, below which the bloom may open. Perceptual, not
 *  numerical: the gate has every piece within a fifth of a percent of its seat
 *  above it, so this truncates no drawn motion. The wait it costs is bounded in
 *  __tests__/channel-ease.test.ts. */
export const WRAP_SPENT = 2e-3;

/** What the driver writes for the fold and the bloom on one frame — the pair's
 *  whole law as a pure function, so the values the shader reads are testable
 *  without a DOM. `null` means "leave the ease alone". */
export interface WrapBloomWrite {
  /** the wrap channel's target, always written */
  assembleTarget: number;
  /** the wrap channel's value, or null to leave core/scene's ease alone */
  assemble: number | null;
  /** the spread channel's target, always written */
  explodeTarget: number;
  /** the spread channel's value, or null */
  explode: number | null;
  /** the bloom's target, always written */
  roseTarget: number;
  /** the bloom's value, or null */
  rose: number | null;
}
export const wrapBloomWrite = (
  p: number,
  /** the LIVE eased channels the deform host is about to read. BOTH fold the
   *  same wedge, so the bloom waits on whichever is still moving: the wrap in
   *  the cards chapter, the spread through the whole ending. */
  fold: { assemble: number; explode: number },
): WrapBloomWrite => {
  const wrapTarget = assembleAt(p);
  const spreadTarget = explodeAt(p);
  // THE SPREAD IS SPENT HARD once it is under the floor, because the ease never
  // reaches 0 on its own and the bloom's exclusion has to be exact rather than
  // asymptotic. It is the ending's own coming-together, so it is the one the
  // flower actually waits on.
  const explode = spreadTarget === 0 && fold.explode < WRAP_SPENT ? 0 : null;
  const rose = roseAt(p);
  const live = Math.max(wrapTarget, explode ?? fold.explode);
  return {
    assembleTarget: wrapTarget,
    // RAW, on the cards chapter's own clock — see the note above assembleAt
    assemble: wrapTarget,
    explodeTarget: spreadTarget,
    explode,
    // the bloom waits for the fold to be SPENT, not for p to pass its foot…
    roseTarget: live > 0 ? 0 : rose,
    // …and is held shut below that foot, so the exclusion is symmetric
    rose: rose === 0 ? 0 : null,
  };
};

// --- the iris hand-over ------------------------------------------------------

/** The aperture ramps shut over the tail of the internals scene and stays
 *  there, so the dive's own opening ramp starts from f/22 with no jump. */
export const PRE_SHUT: [number, number] = [atFrac(inR, 0.6), atFrac(inR, 0.95)];

/** The pre-shut ramp — ONE law across both edges of the scene.
 *  story/internals.ts calls it inside the span and adds its breath on top; the
 *  driver writes it outside the span. */
export const preShutAt = (p: number): number =>
  smoothstep(PRE_SHUT[0], PRE_SHUT[1], p);

/** Where the driver hands focus and aperture to story/internals.ts: the
 *  ambient's own wake fraction, less slack. The two writers overlap across that
 *  slack — harmlessly, because both laws are exactly 0 over all of it. */
export const IRIS_HANDOVER = atFrac(caR, 0.15) - 0.02;

/** …and where it takes them back: the internals scene's end. */
export const IRIS_HANDBACK = inR.p1;

/** story/internals.ts owns focus and aperture across the cards + internals
 *  span. It writes from scene.onFrame — a different rAF with no ordering
 *  guarantee — so the two writers are separated by RANGE, not order. True
 *  inside the fly span: the dive writes from fly.frame(), after the driver's
 *  own lines in the same call. */
export const driverOwnsIris = (p: number): boolean =>
  p < IRIS_HANDOVER || p > IRIS_HANDBACK;

// --- the look ----------------------------------------------------------------

/** Ink fill: wireframe → half through zoom → full at the peel, and full for the
 *  rest of the story. THE FILLS MAY NOT DIP BELOW THE EDGE LINES: the lines are
 *  drawn at a flat alpha (materials/unified.ts `inkLineOpacity`) and only the
 *  fills ride this level, so any dip draws the pieces as hollow outlines. */
export const INK_HALF: [number, number] = [atFrac(zR, 0.0), atFrac(zR, 0.5)];
export const INK_FULL: [number, number] = [peR.p0, atFrac(peR, 0.35)];

export const inkFillAt = (p: number): number =>
  0.5 * smoothstep(INK_HALF[0], INK_HALF[1], p) +
  0.5 * smoothstep(INK_FULL[0], INK_FULL[1], p);

/** The shell's way back, at the rewrap's first frames — behind the opaque sky
 *  backdrop story/fly.ts still holds, so the pop is unseen. */
export const SHELL_BACK: [number, number] = [rwR.p0, atFrac(rwR, 0.05)];

/** The shell's wink-out, in plain sight (peelcards WINK_SPAN), trailing the
 *  departure that carried the pieces away. ONE envelope for all three casts —
 *  core/scene's per-mesh thresholds order them outside-in, which is what makes
 *  it read as the lens opening layer by layer rather than as a dissolve. */
export const shellFadeAt = (p: number): number =>
  1 -
  smoothstep(WINK_SPAN[0], WINK_SPAN[1], p) +
  smoothstep(SHELL_BACK[0], SHELL_BACK[1], p);

/** The interior's return waits for the camera to park ON the bore: it opens AT
 *  DIVE_P0 and completes just inside the dive. Earlier and the approach swing
 *  shows the arriving pieces in profile with no shell to hide them; from the
 *  park on, every one is masked behind the barrel. Both edges ride the
 *  flythrough's transit — the number DIVE_P0 itself is built from — so a hold
 *  retune moves the return with the park. */
export const INTERIOR_BACK: [number, number] = [
  DIVE_P0,
  atFrac(fR, fR.scene.transit + 0.07),
];

/** Cladding + rest-cast leave on the shell's window but return over the
 *  flythrough approach, so the dive flies through the full interior. */
export const interiorFadeAt = (p: number): number =>
  1 -
  smoothstep(WINK_SPAN[0], WINK_SPAN[1], p) +
  smoothstep(INTERIOR_BACK[0], INTERIOR_BACK[1], p);

// --- the stage tint ----------------------------------------------------------

/** An 8-bit RGB triple, the form the STORY table authors a stage tint in. */
export type Rgb = [number, number, number];
/** One tint stop: the story p it is authored at, and the colour there. */
export type BgStop = [number, Rgb];

/** The tint stop table for a theme: each scene's authored tint at its
 *  hold-centre. Built once per THEME rather than per frame — the driver holds
 *  the table across frames and rebuilds it on a theme flip. */
export const bgStopsFor = (light: boolean): BgStop[] =>
  RANGES.map((r) => [(r.p0 + r.p1) / 2, light ? r.scene.bgLight : r.scene.bg]);

/** The tint at p, interpolated between the two bracketing stops and rounded to
 *  whole channel values (the driver writes it as an `rgb()` string). Takes the
 *  table rather than the theme, and writes into `out`, so the per-frame path
 *  allocates nothing. */
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
export const SCROLL_CUE: [number, number] = [
  atFrac(heroR, 0.1),
  atFrac(heroR, 0.9),
];

export const scrollCueAt = (p: number): number =>
  1 - smoothstep(SCROLL_CUE[0], SCROLL_CUE[1], p);

/** Instrument chrome fades over the tail of the final scene — derived from the
 *  capsOn range, not absolute p, so a duration change upstream can't leave it
 *  fading mid-story. */
export const CHROME_FADE: [number, number] = [atFrac(capR, 0.77), capR.p1];

export const chromeAt = (p: number): number =>
  1 - smoothstep(CHROME_FADE[0], CHROME_FADE[1], p);
