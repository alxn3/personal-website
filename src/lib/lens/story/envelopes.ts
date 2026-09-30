// Every story envelope as a pure function of the story position p (0..1).
// The hero driver evaluates them at the eased p, so a resting frame is exactly
// what they say.
// This file is in the homepage's first chunk: import only core/, story.ts and
// reveal.ts here, never optics/ or a lazy story module.

import { clamp01, deg, smoothstep } from "../core/math";
import { MODEL_BORE_X_Z } from "../core/scene";
import type { RecipeName } from "../ops/recipes";
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

const heroScene = RANGES[0];
const zoomScene = rangeOf("zoom");
const peelScene = rangeOf("peel");
const cardsScene = rangeOf("cards");
const internalsScene = rangeOf("internals");
const flyScene = rangeOf("flythrough");
const rewrapScene = rangeOf("rewrap");
const bloomScene = rangeOf("capsOn");

// --- mechanism channels: each rises over one window and falls over a later one

/** The lens zooms in during the zoom scene and back out early in the peel. */
export const ZOOM_PULSE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["zoom", 0.15, 0.85],
  fall: ["peel", 0, 0.4],
};

/** The ending's descent: the exploded pieces fall back into place. The last
 *  pieces must land inside ROCK, before the bloom starts. */
export const CONSTRUCT: StoryWindow = ["capsOn", 0.03, 0.64];

/** The pieces fly apart during the trails scene and come home on CONSTRUCT. */
export const EXPLODE_PULSE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["trails", 0.05, 0.5],
  fall: CONSTRUCT,
};

/** The peel: the outer layers fly off the lens (rising = coming apart) and
 *  return only once every one of them has faded out (WINK_SPAN's end). */
export const CARDS_APART: { rise: StoryWindow; fall: StoryWindow } = {
  rise: [
    ["zoom", 0.85],
    ["peel", 0.96],
  ],
  fall: ["cards", 0.16, 0.3],
};

/** The lens stands up for the internals scene: 0 = bore along world +X (every
 *  other scene's pose), 1 = bore along +Y. It must lie back down before the dive. */
export const UPRIGHT: { rise: StoryWindow; fall: StoryWindow } = {
  rise: [
    ["cards", 0.8],
    ["internals", 0.3],
  ],
  fall: ["flythrough", 0, 0.2],
};

/** How far the lens stands up at p, 0..1. */
export const uprightAt = pulseFn(UPRIGHT, "upright");

/** The nose dips below horizontal in the cards scene, so the turn sweeps a
 *  cone. Must stay clear of the peel's bore roll, which shares the same `z`. */
export const DIP: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["cards", 0, 0.3],
  fall: UPRIGHT.rise,
};

/** The bare mechanism draws together along its axis for the cards scene. It
 *  may not start before the peel's pieces have left their seats. */
export const HUDDLE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["cards", 0.02, 0.16],
  fall: UPRIGHT.rise,
};

/** The huddle at p, 0..1. */
export const huddleAt = pulseFn(HUDDLE, "huddle");

/** How far the nose dips, radians. */
export const DIP_MAX = deg(15);

const dipFracAt = pulseFn(DIP, "dip");

/** The nose dip at p, radians ≥ 0; the driver subtracts it from the tilt. */
export const dipAt = (p: number): number => DIP_MAX * dipFracAt(p);

/** The standing lens wobbles like a spinning top while the last pieces land,
 *  then settles dead still before the bloom. Exactly 0 outside the window. */
export const ROCK: StoryWindow = ["capsOn", 0.42, 0.72];

/** The wobble's peak lean, radians. */
export const ROCK_MAX = deg(12);

/** Turns of wobble across the window. */
const ROCK_TURNS = 2.25;

const [ROCK_P0, ROCK_P1] = span("rock", windowEdges(ROCK));

const ROCK_SPAN = ROCK_P1 - ROCK_P0;
const ROCK_RATE = 2 * Math.PI * ROCK_TURNS;

/** The wobble's lean at p, radians: eases in, then damps out. */
const rockLeanAt = (p: number): number => {
  const u = clamp01((p - ROCK_P0) / ROCK_SPAN);
  return ROCK_MAX * smoothstep(0, 0.15, u) * (1 - smoothstep(0.45, 1, u));
};

/** Which way the lean points at p, radians around the bore. */
const rockPhaseAt = (p: number): number =>
  ROCK_RATE * clamp01((p - ROCK_P0) / ROCK_SPAN);

/** The wobble's tilt component (added to the model's z). */
export const rockZAt = (p: number): number =>
  rockLeanAt(p) * Math.cos(rockPhaseAt(p));

/** The wobble's turn component (added to the model's y). */
export const rockYAt = (p: number): number =>
  rockLeanAt(p) * Math.sin(rockPhaseAt(p));

/** The bloom: the ending's origami flower opens and stays open (no fall). It
 *  must start after the assemble and explode falls; channel-ease.test.ts pins it. */
export const ROSE_PULSE: { rise: StoryWindow } = {
  rise: ["capsOn", 0.72, 0.96],
};

export const zoomAt = pulseFn(ZOOM_PULSE, "zoom");
export const explodeAt = pulseFn(EXPLODE_PULSE, "explode");

/** The peel's departure. The only assemble pulse on the track: recipe deltas
 *  add up, so it may not also run during the ending's explode. */
export const assembleAt = pulseFn(CARDS_APART, "cards.apart");
export const roseAt = pulseFn(ROSE_PULSE, "rose");

// --- recipe knobs the story sets (defaults live in ops/recipes.ts)

/** explode.bloom: how far each piece slides outward in the ending, in seat radii. */
export const ENDING_BLOOM = 4.5;

/** explode.curl: how far a shell wedge curls open mid-fall (a coil factor beyond 1). */
export const ENDING_CURL = 4.5;

/** explode.ringPhase: offsets each ring's seams (turns per model-mm) so the
 *  parked pieces read as broken rings rather than a pinwheel. */
export const ENDING_RING_PHASE = 0.0325;

/** explode.rebend: 1 = a parked wedge bends to its new ring's radius and
 *  relaxes back on the way home. */
export const ENDING_REBEND = 1;

/** assemble.keepScope for the whole story. Constant: changing it mid-flight
 *  would move pieces. */
export const ASSEMBLE_KEEP_SCOPE = 1;

/** Every recipe knob the story sets, by recipe; the rest keep their defaults. */
export const STORY_KNOBS: Partial<Record<RecipeName, Record<string, number>>> =
  {
    assemble: { keepScope: ASSEMBLE_KEEP_SCOPE },
    explode: {
      bloom: ENDING_BLOOM,
      curl: ENDING_CURL,
      ringPhase: ENDING_RING_PHASE,
      rebend: ENDING_REBEND,
    },
  };

// --- iris hand-over between the driver and internals.ts

/** The aperture closes to f/22 late in the internals scene, ready for the dive. */
export const PRE_SHUT = span("preShut", [
  atFrac(internalsScene, 0.6),
  atFrac(internalsScene, 0.95),
]);

/** The aperture's pre-shut ramp at p. internals.ts adds its breathing on top
 *  inside its span; the driver writes it alone outside. */
export const preShutAt = (p: number): number =>
  smoothstep(PRE_SHUT[0], PRE_SHUT[1], p);

/** Where internals.ts takes over focus and aperture. Both writers agree across
 *  the small overlap, where both laws are 0. */
export const IRIS_HANDOVER = atFrac(cardsScene, 0.15) - 0.02;

/** Where the driver takes them back: the end of the internals scene. */
export const IRIS_HANDBACK = internalsScene.p1;
span("iris.handover", [IRIS_HANDOVER, IRIS_HANDBACK]);

/** True where the driver, not internals.ts, writes focus and aperture. */
export const driverOwnsIris = (p: number): boolean =>
  p < IRIS_HANDOVER || p > IRIS_HANDBACK;

// --- the ink look

/** The ink drawing fills in: half over the zoom, full early in the peel, then
 *  stays full. Never below the edge lines' alpha, or pieces draw hollow. */
export const INK_HALF = span("ink.half", [
  atFrac(zoomScene, 0.0),
  atFrac(zoomScene, 0.5),
]);
export const INK_FULL = span("ink.full", [
  peelScene.p0,
  atFrac(peelScene, 0.35),
]);

export const inkFillAt = (p: number): number =>
  0.5 * smoothstep(INK_HALF[0], INK_HALF[1], p) +
  0.5 * smoothstep(INK_FULL[0], INK_FULL[1], p);

/** The shell reappears in the rewrap's first frames, hidden behind the sky. */
export const SHELL_BACK = span("shell.back", [
  rewrapScene.p0,
  atFrac(rewrapScene, 0.05),
]);

// --- the outer layers' fade-out ("wink")
// Once off the lens, the outer pieces dissolve one by one, outside-in
// (core/visibility.ts), and the cards (peelcards.ts) appear on them. The
// mechanism underneath never hides or moves.

/** The shell and interior pieces dissolve. No piece may start before its own
 *  flight ends, and all must be gone before CARDS_APART brings them home. */
export const WINK_SPAN = span("wink", [
  atFrac(peelScene, 0.57),
  atFrac(cardsScene, 0.15),
]);

/** The fade level at p: 1 before WINK_SPAN, 0 after. Each piece compares its
 *  own threshold against it. */
export const winkLevelAt = (p: number): number =>
  1 - smoothstep(WINK_SPAN[0], WINK_SPAN[1], p);

/** The p where the fade level reaches `level` (winkLevelAt's inverse, by bisection). */
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

/** The shell's fade level: out on WINK_SPAN, back on SHELL_BACK. */
export const shellFadeAt = (p: number): number =>
  winkLevelAt(p) + smoothstep(SHELL_BACK[0], SHELL_BACK[1], p);

/** The interior pieces return during the flythrough approach, while the body is
 *  still drawn as transparent ink (a piece can only dissolve while it is). */
export const INTERIOR_BACK = span("interior.back", [
  flyScene.p0,
  atFrac(flyScene, 0.12),
]);

/** The interior's fade level: out with the shell, back on INTERIOR_BACK. */
export const interiorFadeAt = (p: number): number =>
  winkLevelAt(p) + smoothstep(INTERIOR_BACK[0], INTERIOR_BACK[1], p);

// --- dust

/** Where the bloom's petals mount: just before the bloom starts. */
export const PETALS_P0 = windowEdges(ROSE_PULSE.rise)[0] - 0.01;

/** The ambient dust is on except during the dive and once the petals mount. */
export const dustAt = (p: number): boolean =>
  !(p >= DIVE_P0 && p <= FLY_EXIT_END) && p < PETALS_P0;

// --- stage tint

/** An 8-bit RGB triple. */
export type Rgb = [number, number, number];
/** A tint stop: a story p and the colour there. */
export type BgStop = [number, Rgb];

/** Each scene's tint at its range midpoint, for one theme. */
export const bgStopsFor = (light: boolean): BgStop[] =>
  RANGES.map((r) => [(r.p0 + r.p1) / 2, light ? r.scene.bgLight : r.scene.bg]);

/** The tint at p, interpolated between stops and rounded. Writes into `out`. */
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

/** The tint at p for a theme. */
export const bgAt = (p: number, light: boolean): Rgb =>
  bgTintAt(bgStopsFor(light), p);

// --- HUD and chrome

/** The HUD's f-stops, from wide open to shut. */
export const F_STOPS = ["2.8", "4", "5.6", "8", "11", "16", "22"];

/** The HUD's focal length in mm for a zoom channel value. */
export const focalMmAt = (zoom: number): number => Math.round(18 + zoom * 32);

/** The HUD's f-stop for an aperture channel value. */
export const fStopOf = (aperture: number): string =>
  F_STOPS[Math.round(clamp01(aperture) * (F_STOPS.length - 1))];

/** The scroll cue fades out across the hero scene. */
export const SCROLL_CUE = span("scrollCue", [
  atFrac(heroScene, 0.1),
  atFrac(heroScene, 0.9),
]);

export const scrollCueAt = (p: number): number =>
  1 - smoothstep(SCROLL_CUE[0], SCROLL_CUE[1], p);

/** The HUD and scene rail fade out at the end of the final scene. */
export const CHROME_FADE = span("chrome", [
  atFrac(bloomScene, 0.77),
  bloomScene.p1,
]);

export const chromeAt = (p: number): number =>
  1 - smoothstep(CHROME_FADE[0], CHROME_FADE[1], p);

// --- model orientation

// Peel: the lens spins once about its own optical axis while the layers come
// off. This is the model's x euler, a pure bore roll only while y and z are 0.
const ROLL_START = 0.06;
const ROLL_END = 0.92;
/** Whole turns, signed (negative = the peel's winding direction). Must stay an
 *  integer so dropping back to 0 afterwards is seamless. */
const ROLL_TURNS = -1;

/** The peel's spin about the bore. */
export const PEEL_ROLL_SPAN = span("peel.roll", [
  atFrac(peelScene, ROLL_START),
  atFrac(peelScene, ROLL_END),
]);

/** The spin's progress at p, 0..1. */
export const peelRollFracAt = (p: number): number =>
  smoothstep(PEEL_ROLL_SPAN[0], PEEL_ROLL_SPAN[1], p);

/** The spin at p, radians about the bore; 0 before and after the span. */
export const peelRollAt = (p: number): number =>
  p >= PEEL_ROLL_SPAN[1] ? 0 : ROLL_TURNS * 2 * Math.PI * peelRollFracAt(p);

// Cards: the lens circles about world +Y with its nose dipped, sweeping a
// cone. It finishes as the lens stands upright, where a +Y turn no longer
// moves the bore.
const TURN_START = 0; // cards-scene fraction
const TURN_END = 0.3; // internals-scene fraction
/** Whole turns, signed (negative = clockwise from above). Must stay an integer,
 *  as ROLL_TURNS. */
const TURN_TURNS = -2;

/** The cards scene's turn about world +Y. */
export const TURN_SPAN = span("peel.turn", [
  atFrac(cardsScene, TURN_START),
  atFrac(internalsScene, TURN_END),
]);

/** The turn's progress at p, 0..1. */
export const peelTurnFracAt = (p: number): number =>
  smoothstep(TURN_SPAN[0], TURN_SPAN[1], p);

/** The turn at p, radians about world +Y; 0 before and after the span. */
export const peelTurnAt = (p: number): number =>
  p >= TURN_SPAN[1] ? 0 : TURN_TURNS * 2 * Math.PI * peelTurnFracAt(p);

// The reveal's roll (reveal.ts) runs from the explode's rise to ROLL_P1.
span("roll", [windowEdges(EXPLODE_PULSE.rise)[0], ROLL_P1]);

/** The model's euler at p, radians. x: the peel spin plus the reveal roll;
 *  y: the cards turn plus the wobble; z: the tip (bore on +X, up for the
 *  internals) less the nose dip, plus the wobble. */
export const orientationAt = (
  p: number,
  out = { x: 0, y: 0, z: 0 },
): { x: number; y: number; z: number } => {
  out.x = peelRollAt(p) + revealRollAt(p, explodeAt(p));
  out.y = peelTurnAt(p) + rockYAt(p);
  out.z = MODEL_BORE_X_Z * (1 - uprightAt(p)) - dipAt(p) + rockZAt(p);
  return out;
};
