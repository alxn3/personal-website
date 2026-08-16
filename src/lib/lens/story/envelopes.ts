// ============================================================================
// THE HERO DRIVER'S ENVELOPES, as pure functions of the scroll position `p`.
//
// Every expression here used to live inside `startHeroStory`'s closure
// (story/hero-driver.ts), which calls document.getElementById on its first line
// — so nothing in it could be imported by a test, by a second consumer, or by
// the introspection module, and the one place that needed a copy took one
// (`__tests__/reveal.test.ts` rebuilt the explode channel by hand, and
// story/internals.ts kept a textual twin of the pre-shut ramp). These are the
// same expressions, moved rather than rewritten: the driver CALLS them now, so
// the copies are gone and cannot come back.
//
// WHAT BELONGS HERE: driver-owned math that is a function of p (and, for the
// tint, of the theme) and of nothing else. What does NOT: anything that reads
// or writes the DOM — the --beat-* custom properties, the pin projection, the
// stage's background assignment, the HUD's textContent, the ?story panel. Those
// stay in the driver, which is where the element ids are the contract.
//
// HOMEPAGE-SAFE BY CONSTRUCTION, and it has to be: the driver is in the
// homepage's initial chunk. This file may import core/math.ts, story/story.ts,
// story/reveal.ts and story/peelcards.ts — all already in that chunk — and may
// NEVER import optics/ or a lazy story module (story/fly.ts, story/trails.ts,
// story/constellations.ts). story/reveal.ts's header states the same law for
// the same reason.
//
// The WINDOWS are named constants rather than literals inside the expressions
// so that a reader of the story — story/state.ts, the STORY-MAP — can report
// where each ramp sits without a second copy of its edges. The functions read
// the constants, so there is exactly one number per edge.
// ============================================================================

import { clamp01, smoothstep } from "../core/math";
import {
  RANGES,
  atFrac,
  pulse,
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
const tR = rangeOf("trails");
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

/** THE WRAP'S OWN RETURN — the assemble channel's fall, and NOT the pieces'
 *  radius (that is `CONSTRUCT` below, and it now outlives this by a third of
 *  the ending). The two used to land together on this edge, which is what made
 *  the finale open on a seated lens; they are separate quantities and the
 *  ending is the beat that separates them:
 *
 *    · ASSEMBLE is the pieces' SHAPE — unwrapped sheet at 1, seated curvature
 *      at 0. It has to be spent BEFORE the rose rises, because the rose folds
 *      the same wedge material and the fold host adds the two recipes' deltas
 *      (ops/host.ts sums each recipe's displacement off the SEATED point): a
 *      bloom over a half-unwrapped shell is two unwrap laws on one wedge.
 *    · EXPLODE is the pieces' RADIUS, which the rose does not touch at all —
 *      so it is free to still be running while the flower grows, and that
 *      overlap IS the ending now.
 *
 *  Everything is therefore SHAPED home by 25% into caps-on — before the
 *  camera's fast equatorial pass gets close (huge un-seated sheets would
 *  otherwise fill the frame mid-spin) — while the pieces themselves are still
 *  out on their radius, flying in. */
export const RETURN: StoryWindow = [
  ["rewrap", 0.05],
  ["capsOn", 0.25],
];

// BRIDGE (Phase 0 — Phase F replaces this with the trails→shell entrance):
// the ring story never fully explodes the lens, but the signed-off rewrap
// reassembly needs the model torn down before it can wrap back on. Until the
// trails scene hands real shell pieces to rewrap, tear down over the trails
// scene so the ending still plays. Assemble keeps the shared RETURN window —
// its staggered gate owns the visible layer-by-layer return.
//
// …AND THE EXPLODE CHANNEL IS THE PIECES' RADIUS — nothing else. The angle is
// the model's own roll (story/reveal.ts revealRollAt, written from the driver),
// which is what lets this hold at FULL through the whole crossfade
// (story/fly.ts flyRevealAt uncovers the shell over rewrap-local [0.06, 0.16]):
// the pieces are drawn onto the frame parked on their outer radius, turning in
// place.
//
// THE COLLAPSE IS THE ENDING NOW (owner: "the last scene would be the pieces
// flying in to construct the rose"). It used to be spent inside `rewrap`, at
// REVEAL_END — so the ending opened on a re-formed lens and the bloom grew out
// of a seated model. The radius now holds at FULL for the WHOLE of rewrap and
// falls over `CONSTRUCT`, inside caps-on, overlapping the bloom: the pieces
// arrive while the flower is already growing under them and land as petals
// rather than as a lens. Two consequences worth stating, both improvements on
// what the old edge bought:
//
//   · REVEAL_END is no longer this channel's last frame (story/story.ts's
//     constant carries the correction). The seat's own walk home
//     (story/fly.ts flySeatAt, [REVEAL_END, rewrap 0.34]) was placed after it
//     so the collapse would not "play on a moving range" — with the collapse
//     moved out of the scene entirely, that walk now happens under a RIGID
//     cloud at constant radius, which honours the same law by a wider margin.
//   · the pieces-turn-in-place beat the owner asked for ("it doesn't start
//     from the fully expanded state") grows from 0.13 of a scene to a scene
//     and a fifth: the channel is exactly 1 from the crossfade to CONSTRUCT's
//     foot.

/** THE CONSTRUCTION — where the pieces come in, as fractions of `capsOn`.
 *  THE knob for the ending's pacing, and each edge answers a question:
 *
 *  · 0.12 — the foot. Deliberately BEFORE the bloom's own (ROSE_PULSE, 0.25):
 *    the inward drift is already under way, sub-perceptibly, on the frame the
 *    flower starts to open, so the bloom is not an event that begins out of a
 *    still frame (story/story.ts CAM_RELEASE_F's law, applied to the pieces).
 *    Push it to 0.25 to start both together; push it into rewrap to give the
 *    fly-in more of the track than the bloom.
 *  · 0.62 — spent. Just inside the ending's camera settle (the capsOn row's
 *    `transit` is 0.70, and its last waypoint is the dolly-in swell), so every
 *    piece is home before the camera parks: the settle lands on a finished
 *    flower, which is the hand-off frame the page scrolls up over. The bloom
 *    runs on to 0.9 alone, so its last third is the flower opening on a seated
 *    cast rather than a cast still arriving.
 *
 *  At the bloom's foot this leaves the radius at 0.83 — the pieces are still
 *  83% of the way out when the first petal moves — which is the whole of what
 *  "they fly in AND become the flower" buys. */
export const CONSTRUCT: [number, number] = [0.12, 0.62];

export const EXPLODE_PULSE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["trails", 0.05, 0.5],
  fall: ["capsOn", CONSTRUCT[0], CONSTRUCT[1]],
};

export const ASSEMBLE_PULSE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["trails", 0.15, 0.8],
  fall: RETURN,
};

/** THE CARDS SCENE TAKES THE LENS APART — the sky chapter's reassembly played
 *  backwards on the same channel: rising IS coming apart (0 seated, 1 every
 *  sheet unwrapped and flown off the ladder).
 *
 *  THE LAYER ORDER IS THE RECIPE'S. The gate offsets each piece by its shell
 *  rank (ops/gate.ts, the assemble recipe's `stagger` knob), and on a RISING
 *  channel the outermost rank goes first — skin, then cladding and tubes, then
 *  the baffles opening the bore. Nothing here staggers anything.
 *
 *  THE RISE OPENS WHERE THE UNROLL IS SPENT (story/peelcards.ts PEEL_RELEASE):
 *  two unwrap chains on one wedge, sequenced rather than covered, so
 *  `min(peel, assemble) === 0` is an identity in p.
 *
 *  THE FALL IS UNSEEN, and must be — the recipe's ladder is unscoped and moves
 *  the mechanism the wink KEEPS, so the channel is home before anything is
 *  drawn again. It falls inside the body fade's valley.
 *
 *  KNOBS: the rise's foot is how long the curl lies flat first; its tip is how
 *  much of the scene the departure gets and how long the spread cast holds
 *  before the fade. */
export const CARDS_APART: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["cards", 0.1, 0.42],
  fall: ["cards", 0.54, 0.64],
};

/** THE BLOOM IS THE LAST THING THAT HAPPENS, so it is the one channel with no
 *  fall: the story ends inside it.
 *
 *  ITS FOOT IS THE WRAP'S EDGE, NOT THE RADIUS'S — RETURN's far edge,
 *  capsOn-local 0.25, unchanged from when the two were the same frame. The
 *  rose's channel-0 identity is the SEATED-SHAPED wedge, so what it may not
 *  overlap is the assemble channel (RETURN's note has the arithmetic: the host
 *  SUMS the recipes' deltas, so a bloom over a half-unwrapped shell folds
 *  material that is already being unfolded). It may overlap the explode
 *  channel freely — a piece's radius is not its shape, and the flower's own
 *  fold pattern is computed off the seat either way — and under CONSTRUCT it
 *  does, for the first 0.37 of this window: the petals grow while the pieces
 *  carrying them are still flying in.
 *
 *  IT IS AUTHORED IN p AND WRITTEN OFF THE CHANNEL. The disjointness above is a
 *  statement about two functions of p; what the host sums is two EASED values,
 *  and the wrap's tail crosses this foot at any real scroll speed (measured:
 *  0.125 of wrap still live under a rose at 0.145 on a fling through the seam).
 *  So story/hero-driver.ts gates the target on the LIVE eased wrap — the bloom
 *  WAITS for the channel to be spent rather than for p to pass this edge, and
 *  holds at exactly 0 below it — which is the same correction the model's roll
 *  took (hero-driver's onFrame writer) for the same reason.
 *
 *  It runs to capsOn-local 0.9 rather than 1.0 so the flower is fully open for
 *  the settle beat the scene's hold was lengthened to buy. */
export const ROSE_PULSE: { rise: StoryWindow } = {
  rise: ["capsOn", 0.25, 0.9],
};

export const zoomAt = (p: number): number => pulse(p, ZOOM_PULSE);
export const explodeAt = (p: number): number => pulse(p, EXPLODE_PULSE);

/** THE ASSEMBLE CHANNEL runs TWICE, in opposite directions: the cards scene
 *  takes the lens APART on it (CARDS_APART — the reassembly reversed) and the
 *  sky chapter puts it back together (ASSEMBLE_PULSE). A plain SUM is exact
 *  rather than approximate — the two pulses are disjoint in p and each
 *  SATURATES at its own edges (CARDS_APART is exactly 0 from cards-local 0.64,
 *  ASSEMBLE_PULSE exactly 0 until trails-local 0.15), so no p sees both and
 *  neither leaks a residue into the other's chapter. Anything added here must
 *  keep that: overlapping pulses would drive the channel past 1 and the gate
 *  reads a channel, not a clamp.
 *
 *  This is the AUTHORED envelope. What the shader reads is `wrapBloomWrite`
 *  below, which is this on two clocks. */
export const assembleAt = (p: number): number =>
  pulse(p, CARDS_APART) + pulse(p, ASSEMBLE_PULSE);
export const roseAt = (p: number): number => pulse(p, ROSE_PULSE);

/** THE CHANNEL'S TWO CLOCKS meet here, at the tail pulse's foot. BELOW it the
 *  wrap is RAW — hero-driver writes value and target, like `peel`, so the cards
 *  chapter's sequencing holds on the values the shader reads. ABOVE it the ease
 *  is the point: the sky chapter's reassembly must outlive the scroll. The seam
 *  sits in the dead stretch between the pulses, where both clocks read 0. */
export const WRAP_EASE_P0 = windowEdges(ASSEMBLE_PULSE.rise)[0];

/** WHERE THE WRAP COUNTS AS SPENT — the eased channel's floor, below which the
 *  driver writes an exact 0 so the bloom may open.
 *
 *  PERCEPTUAL, NOT NUMERICAL. The assemble gate saturates every piece to its
 *  seat below channel ≈ 0.02, so cutting at 2e-3 truncates no drawn motion with
 *  10× headroom — headroom that belongs to that gateSpec, so a gate retune is
 *  what would eat it. ops/host's IDLE_EPS (1e-6) is ~90 frames of lerp away and
 *  held the bloom back by more than a second. The wait it costs is BOUNDED in
 *  __tests__/channel-ease.test.ts. */
export const WRAP_SPENT = 2e-3;

/** WHAT THE DRIVER WRITES FOR THE WRAP AND THE BLOOM ON ONE FRAME — the pair's
 *  whole law as a pure function, so the values the shader reads can be tested
 *  without a DOM. `null` means "leave the ease alone"; a number means the driver
 *  writes the VALUE too. Called from both of the driver's clocks with that
 *  clock's p, and idempotent in the target it computes. */
export interface WrapBloomWrite {
  /** the wrap channel's target, always written */
  assembleTarget: number;
  /** the wrap channel's value, or null to leave core/scene's ease alone */
  assemble: number | null;
  /** the bloom's target, always written */
  roseTarget: number;
  /** the bloom's value, or null */
  rose: number | null;
}
export const wrapBloomWrite = (
  p: number,
  /** the LIVE eased wrap channel, as the deform host is about to read it */
  wrapNow: number,
): WrapBloomWrite => {
  const target = assembleAt(p);
  const assemble =
    p < WRAP_EASE_P0
      ? // the cards chapter: raw, on the peel's own clock
        target
      : // the sky chapter: eased, but spent HARD once it is under the floor
        target === 0 && wrapNow < WRAP_SPENT
        ? 0
        : null;
  const wrap = assemble ?? wrapNow;
  const rose = roseAt(p);
  return {
    assembleTarget: target,
    assemble,
    // the bloom waits for the WRAP to be spent, not for p to pass its foot…
    roseTarget: wrap > 0 ? 0 : rose,
    // …and is held shut below that foot, so the exclusion is symmetric
    rose: rose === 0 ? 0 : null,
  };
};

// --- the iris hand-over ------------------------------------------------------

/** THE DOOR CLOSES BEFORE THE DIVE: the aperture ramps to shut over the tail of
 *  the internals scene and stays there, so the fly-through's own opening ramp
 *  (story/fly.ts, FLY.pAperture) starts from f/22 with no jump. The stop-down is
 *  invisible — it happens inside the reassembling lens. */
export const PRE_SHUT: [number, number] = [atFrac(inR, 0.6), atFrac(inR, 0.95)];

/** The pre-shut ramp. story/internals.ts calls this INSIDE the internals span
 *  and adds the ambient breath on top; the driver writes it outside the span.
 *  ONE law across both edges of the scene — it used to be two expressions kept
 *  textually identical by a comment. */
export const preShutAt = (p: number): number =>
  smoothstep(PRE_SHUT[0], PRE_SHUT[1], p);

/** Where the driver hands focus and aperture to story/internals.ts: 15% into the
 *  cards scene — where the ambient's own wake ramp opens (story/internals.ts
 *  `wake`, authored on the same fraction) — less 0.02 of slack.
 *
 *  THE SLACK OVERSHOOTS THE SCENE, and by design: 15% of the cards scene is p
 *  0.2549, so this lands at 0.2349, which is BEFORE the cards range opens
 *  (0.2413) — inside the peel's last 8%. The driver is done with the iris a
 *  fraction of a scene before the module that takes it over needs it.
 *
 *  THE TWO WRITERS DO OVERLAP THERE. story/internals.ts opens its gate at its
 *  own lead-in, `caR.p0 − LEAD_IN` = 0.2213, which is 0.0136 BEFORE this edge,
 *  so across that stretch the ambient writes on its rAF while the driver still
 *  resets on its own. It is harmless because both laws are 0 across all of it:
 *  the ambient's wake is exactly 0 until 0.2549 (so its focus and its breath
 *  are), and `preShutAt` is exactly 0 until the internals scene's own 0.6 — the
 *  two write the same two numbers in either order. */
export const IRIS_HANDOVER = atFrac(caR, 0.15) - 0.02;

/** …and where it takes them back: the internals scene's end. */
export const IRIS_HANDBACK = inR.p1;

/** THE CARDS + INTERNALS SPAN IS NOT THE DRIVER'S. story/internals.ts owns focus
 *  and aperture (value AND target) from a fifth into the cards scene through the
 *  internals scene's end, writing from scene.onFrame: a different rAF with no
 *  ordering guarantee against the driver's, so the two writers are separated by
 *  RANGE, not order.
 *
 *  THE HAND-OVER IS INVISIBLE, which is why it may start that early: the cards
 *  scene is taking the lens apart and then hiding it, so nothing of the
 *  mechanism is legible until the internals scene. The ambient's wake ramp is
 *  what keeps its own clock at 0 until then.
 *
 *  The fly span writes focus (value AND target) too, and it does so from
 *  fly.frame() at the END of the driver's frame() — after these lines, in the
 *  same call — so those two never fight either: the reset only reaches the
 *  channel on the frames the fly is not driving it. That is why this predicate
 *  is TRUE inside the fly span. */
export const driverOwnsIris = (p: number): boolean =>
  p < IRIS_HANDOVER || p > IRIS_HANDBACK;

// --- the look ----------------------------------------------------------------

/** ink fill: wireframe → HALF fill through zoom → FULL ink once the peel starts
 *  → drops toward wireframe for the bridge teardown → back to full ink for the
 *  caps-on product shot. Four ramps, and the last two are the same 0.84 in
 *  opposite directions, so the level returns to exactly where the peel left it. */
export const INK_HALF: [number, number] = [atFrac(zR, 0.0), atFrac(zR, 0.5)];
export const INK_FULL: [number, number] = [peR.p0, atFrac(peR, 0.35)];
export const INK_DROP: [number, number] = [atFrac(tR, 0.1), atFrac(tR, 0.6)];
export const INK_RESTORE: [number, number] = [
  atFrac(rwR, 0.1),
  atFrac(rwR, 0.8),
];

export const inkFillAt = (p: number): number =>
  0.5 * smoothstep(INK_HALF[0], INK_HALF[1], p) +
  0.5 * smoothstep(INK_FULL[0], INK_FULL[1], p) -
  0.84 * smoothstep(INK_DROP[0], INK_DROP[1], p) +
  0.84 * smoothstep(INK_RESTORE[0], INK_RESTORE[1], p);

/** The shell's way BACK: at the rewrap's first frames, behind the opaque sky
 *  backdrop (story/fly.ts holds scene.background until its span unmounts at
 *  EXIT_END, rewrap-local 0.58 — and the sky is still at full ink over these
 *  frames, its own fade only starting at 0.02), so the pop is unseen and the
 *  reassembly flies the shell home as before. */
export const SHELL_BACK: [number, number] = [rwR.p0, atFrac(rwR, 0.05)];

/** THE SHELL'S WINK: the strips, the cladding and the baffles stay on screen
 *  for the unroll and the whole departure, and are filed out inside the body
 *  fade's valley once the cards have taken over. The window is
 *  story/peelcards.ts's WINK_SPAN, authored alongside the fade's own edges so
 *  the containment is one file's business.
 *
 *  ONE envelope for all three casts — ordered outside-in by their own bands of
 *  the level (core/scene captureShellThresholds), which is what makes the strip
 *  read as the lens opening layer by layer rather than as a dissolve. */
export const shellFadeAt = (p: number): number =>
  1 -
  smoothstep(WINK_SPAN[0], WINK_SPAN[1], p) +
  smoothstep(SHELL_BACK[0], SHELL_BACK[1], p);

/** THE INTERIOR'S RETURN WAITS FOR THE BORE-ON PARK (owner directive). It is a
 *  per-mesh wink-back, ordered inside-out, and the flythrough scene's approach
 *  swing shows the lens from the side — with no shell to hide the arrivals —
 *  until it lands dead on the dive axis at flythrough-local ~0.13 (measured on
 *  the current internals front-three-quarter pose; the transit ends at 0.163).
 *  Any earlier window puts returning pieces in profile: the owner caught that
 *  twice, first against the still frame of a [0, 0.1] authoring, then again
 *  mid-swing at [0.045, 0.13]. From the park on, the camera looks straight down
 *  the bore and every arriving piece is masked behind the barrel; the window's
 *  tail rides the early dolly (the dive starts at the transit end), whose growing
 *  frame covers the last winks. */
export const INTERIOR_BACK: [number, number] = [
  atFrac(fR, 0.13),
  atFrac(fR, 0.2),
];

/** THE INTERIOR'S OWN CHANNEL: cladding + rest-cast leave on the same window as
 *  the shell but RETURN over the flythrough scene's APPROACH, so the dive flies
 *  through the full interior. The whitelist (glass, iris, mount/PCB) is what is
 *  left standing at the cards scene's end. */
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
 *  table rather than the theme so the per-frame path allocates nothing. */
export const bgTintAt = (stops: BgStop[], p: number): Rgb => {
  let i = 0;
  while (i < stops.length - 2 && p > stops[i + 1][0]) i++;
  const [pa, a] = stops[i];
  const [pb, b] = stops[i + 1];
  const t = clamp01((p - pa) / Math.max(1e-3, pb - pa));
  return a.map((v, k) => Math.round(v + (b[k] - v) * t)) as Rgb;
};

/** The tint at p for a theme, for readers that do not hold a table. */
export const bgAt = (p: number, light: boolean): Rgb =>
  bgTintAt(bgStopsFor(light), p);

// --- the instrument chrome ---------------------------------------------------

/** The scene whose range contains p — the HUD's "SCN nn" index into RANGES /
 *  STORY, and the rail's lit dot. Past the last range (p ≥ 1) it is the last
 *  scene: the story is over, not absent. */
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

/** Instrument chrome (HUD + scene rail) fades out over the tail of the FINAL
 *  scene — derived from the capsOn range rather than absolute p, so a duration
 *  change upstream can't leave it fading mid-story. Under today's holds (14.3
 *  screenfuls, capsOn from 12.8) 0.77 through capsOn is absolute p 0.9759 — the
 *  comment here used to claim 0.965, which was true of an older hold table and
 *  is exactly the drift authoring the fraction rather than the position avoids. */
export const CHROME_FADE: [number, number] = [atFrac(capR, 0.77), capR.p1];

export const chromeAt = (p: number): number =>
  1 - smoothstep(CHROME_FADE[0], CHROME_FADE[1], p);
