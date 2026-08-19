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

/** The assemble channel's fall — the pieces' SHAPE, spent inside the rewrap so
 *  the ending is left to the spiral alone. It must be spent before the rose
 *  rises (the host sums each recipe's delta, so a bloom over a half-unwrapped
 *  shell is two unwrap laws on one wedge); the pieces' RADIUS is `CONSTRUCT`,
 *  which now follows it rather than overlapping the bloom. */
export const RETURN: StoryWindow = [
  ["rewrap", 0.05],
  ["rewrap", 0.9],
];

/** THE SPIRAL, as fractions of `capsOn` — THE knob for the ending's pacing. The
 *  explode recipe's orbit turns each piece as its radius falls and its gate
 *  staggers the arrivals by layer and by phase, so the read is one piece home
 *  after another. It is SEQUENCED with the bloom, not overlapped: the tip lands
 *  a settle beat before ROSE_PULSE's foot. */
export const CONSTRUCT: [number, number] = [0.05, 0.55];

export const EXPLODE_PULSE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["trails", 0.05, 0.5],
  fall: ["capsOn", CONSTRUCT[0], CONSTRUCT[1]],
};

export const ASSEMBLE_PULSE: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["trails", 0.15, 0.8],
  fall: RETURN,
};

/** The cards scene takes the OUTER LAYERS apart on the assemble channel — the
 *  sky chapter's reassembly reversed (rising IS coming apart), scoped off the
 *  mechanism by `ASSEMBLE_KEEP_SCOPE` so the internals are revealed in place.
 *  The layer order is the recipe's gate stagger, not this window's.
 *
 *  THE RISE OPENS INSIDE THE CURL'S OWN RELEASE (peelcards PEEL_RELEASE): the
 *  two unwrap chains CROSSFADE rather than sequence, so no frame sits at rest
 *  between them and the curl reads as the departure's first moment. Their sum
 *  is what must stay bounded, not their product — pinned in
 *  __tests__/channel-ease.test.ts.
 *
 *  THE FALL waits until every piece the departure moves is winked away
 *  (peelcards WINK_SPAN), which is what makes it invisible now that the body
 *  fade no longer covers the scene. */
export const CARDS_APART: { rise: StoryWindow; fall: StoryWindow } = {
  rise: ["cards", 0.04, 0.4],
  fall: ["cards", 0.64, 0.74],
};

/** The bloom — the one channel with no fall; the story ends inside it. Its foot
 *  is the SPIRAL'S far edge plus a settle beat: the pieces are home and still
 *  before the first petal moves. It may not overlap the assemble channel (both
 *  fold the same wedge) — authored in p, ENFORCED on the eased channel by
 *  `wrapBloomWrite`. */
export const ROSE_PULSE: { rise: StoryWindow } = {
  rise: ["capsOn", 0.62, 0.95],
};

export const zoomAt = (p: number): number => pulse(p, ZOOM_PULSE);
export const explodeAt = (p: number): number => pulse(p, EXPLODE_PULSE);

/** The assemble channel runs TWICE, in opposite directions — the cards scene
 *  takes the lens apart on it, the sky chapter puts it back. The SUM is exact
 *  because the two pulses are disjoint in p and each saturates at its own
 *  edges; anything added here must keep that, since overlapping pulses would
 *  drive the channel past 1 and the gate reads a channel, not a clamp. */
export const assembleAt = (p: number): number =>
  pulse(p, CARDS_APART) + pulse(p, ASSEMBLE_PULSE);
export const roseAt = (p: number): number => pulse(p, ROSE_PULSE);

/** Where the channel's two clocks meet. Below it the wrap is RAW (value and
 *  target both written), so the cards chapter's sequencing holds on the values
 *  the shader reads; above it the ease is the point, so the sky chapter's
 *  reassembly outlives the scroll. The seam sits where both clocks read 0. */
export const WRAP_EASE_P0 = windowEdges(ASSEMBLE_PULSE.rise)[0];

/** The departure's scope knob (ops/recipes.ts `assemble.keepScope`): 1 across
 *  the cards chapter, so the wrap and the ladder leave the keep-set alone, and
 *  0 from the sky chapter's own rise on, where the whole model reassembles. It
 *  steps in the dead band between the two pulses, where the channel is 0 and
 *  the knob moves nothing. */
export const assembleKeepScopeAt = (p: number): number =>
  p < WRAP_EASE_P0 ? 1 : 0;

/** The eased wrap's floor, below which the driver writes an exact 0 so the
 *  bloom may open. Perceptual, not numerical: the assemble gate has every piece
 *  seated well above it, so this truncates no drawn motion. The wait it costs
 *  is bounded in __tests__/channel-ease.test.ts. */
export const WRAP_SPENT = 2e-3;

/** What the driver writes for the wrap and the bloom on one frame — the pair's
 *  whole law as a pure function, so the values the shader reads are testable
 *  without a DOM. `null` means "leave the ease alone". */
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

/** Ink fill: wireframe → half through zoom → full at the peel → back toward
 *  wireframe for the teardown → full again for the ending. The last two ramps
 *  are the same magnitude in opposite directions, so the level returns exactly
 *  to where the peel left it. */
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

/** The interior's return waits for the camera to park ON the bore. Earlier and
 *  the approach swing shows the arriving pieces in profile with no shell to
 *  hide them; from the park on, every one is masked behind the barrel. */
export const INTERIOR_BACK: [number, number] = [
  atFrac(fR, 0.13),
  atFrac(fR, 0.2),
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
