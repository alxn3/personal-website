// ============================================================================
// THE SKY CHAPTER'S INK — the ambient driver behind the `constellations` scene.
// The dive is over, the camera holds deep sky, and lines start drawing
// themselves between stars: a pen travels from one star to the next, holds, and
// fades while the next line is already on its way. "Everything connects."
//
// LAZY MODULE, exactly like story/fly.ts. It statically imports optics/ (the
// line engine and the sky catalog), which drag three/tsl node graphs into
// whatever chunk they land in, so this file is reachable ONLY through
// hero-driver's dynamic import() and must NEVER be re-exported from index.ts.
//
// TIME, NOT SCROLL — the second ambient in the story (story/internals.ts was
// the first) and it follows that file's rules: an ACCUMULATED dt clamped to
// 100 ms a frame, never performance.now() itself, because the hero stops its
// render loop whenever the canvas leaves the viewport (SceneHandle.setPaused)
// and a law keyed to absolute time would find every stroke long dead on return.
// The SCROLL position it gates on is `state.storyTarget` — the raw p
// hero-driver was handed, not the eased channel, for the reason internals.ts
// spells out.
//
// IT OWNS NOTHING THE STORY DRIVES. No channels, no camera, no materials: the
// only scene state this touches is one attached object and its own uniforms, so
// it cannot fight hero-driver or story/fly.ts whatever order the two rAFs run
// in. It rides the STARFIELD GROUP (SceneHandle.starfieldAttach) so the sky ink
// inherits that group's per-frame camera-centring for free — and unmounts with
// it when the fly exits, which the re-attach below is written for.
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
import type { SceneHandle } from "../core/scene";
import { smoothstep } from "../core/math";
import { rangeOf, atFrac } from "./story";
import { LABEL_TYPE } from "./peelcards";
import { isLightTheme, watchTheme } from "../core/theme";
import {
  SKY,
  SKY_INK,
  BRIGHT_COUNT,
  dirOf,
  type SkyPalette,
} from "../optics/sky";
import { STARFIELD_LOOK, starRho } from "../optics/starfield";
import {
  CONST_LINES_LOOK,
  createConstellationLines,
  lineDrawMs,
  type Dir3,
} from "../optics/constellation-lines";

const coR = rangeOf("constellations");
const tR = rangeOf("trails");

/** Slack past each edge of the whole sky chapter before the ink is detached, so
 *  a scrub parked on an edge cannot thrash attach/detach. Inside it the group
 *  simply hangs on the starfield at envelope 0.
 *
 *  EXPORTED for story/cost.ts, which counts the chapter's stroke draw and its
 *  sprite slots at p and may not spell this window a second time. */
const SPAN_PAD = 0.02;
export const SPAN_P0 = coR.p0 - SPAN_PAD;
export const SPAN_P1 = tR.p1 + SPAN_PAD;

/** THE LINES' (and, from Task 2, the labels') ENVELOPE. Rises once the sky
 *  scene has settled and falls early in `trails` — "Lines fade and the stars
 *  rotate" — so the strokes are gone well before the shell comes back. Zero
 *  everywhere outside, saturating at both edges. */
export const constellationEnvAt = (p: number): number =>
  smoothstep(atFrac(coR, 0.05), atFrac(coR, 0.2), p) *
  (1 - smoothstep(tR.p0, atFrac(tR, 0.25), p));

/** THE QUOTE'S ENVELOPE — later in, much later out: the typography arrives once
 *  the sky is already drawing itself and HOLDS through the trails while the
 *  lines go, which is what leaves the words alone on the stars at the end of the
 *  chapter. Exported now, used by the quote sprite in Task 2 (the phase plan
 *  keeps that build and this law cleanly separable — Phase G may replace the
 *  quote's entrance with trail-writing and will want exactly this seam). */
export const quoteEnvAt = (p: number): number =>
  smoothstep(atFrac(coR, 0.35), atFrac(coR, 0.55), p) *
  (1 - smoothstep(atFrac(tR, 0.85), tR.p1, p));

/** THE NAMES' ENVELOPE — the strokes', exactly. A name and the lines around it
 *  are the same gesture (a chart being drawn) and they must arrive and leave
 *  together; the alias exists so the coupling has a name a test can hold onto,
 *  and so giving the labels a life of their own has to be a deliberate edit
 *  rather than a copied law that quietly drifts. */
export const labelEnvAt = constellationEnvAt;

// ── PAIR PICKING ────────────────────────────────────────────────────────────
// EVERY STAR IS FAIR GAME, WITH PRIORITY IN THE MIDDLE (owner: "lines should be
// able to be drawn between all the stars with priority in the center"). The
// candidates are the whole catalog inside the cone the held fly pose looks at —
// authored shapes and generated background alike — minus optics/sky.ts's DIM
// TIER, which is backdrop and carries no ink of its own to end a stroke on. The
// bias is in the PICK, not in the pool: a free end is drawn from a
// centre-weighted distribution, so the middle of the frame is where the chart
// draws itself and the edges see the occasional line. Computed once at module
// load from the catalog: no table to drift.
//
// AND THE PICK GROWS WHAT IS ALREADY THERE (owner: "prioritize stars that
// already have a connection. Constellations are made from a group of stars so
// just individual random connections don't read as anything special"). Most
// spawns take one end from a star a VISIBLE stroke already touches, so the sky
// carries a few connected figures that chain and branch rather than a scatter of
// unrelated singles; the minority that do not are what starts the next figure
// while the last one fades. Two bounds keep it a chart: MAX_TOUCH per star, so a
// hub cannot become a starburst, and the no-clash rule, which a shared endpoint
// is exempt from by design (`arcsClash`).

/** half-angle of the visible cone about the view axis (world +X — the held fly
 *  pose looks down it), radians */
const CONE_RAD = (55 * Math.PI) / 180;
/** the angular separation a pair must fall inside, radians. The lower bound is
 *  also the degenerate guard on the endpoint gaps: a stroke is inset by
 *  optics/constellation-lines.ts's GAP_RAD (0.009) at BOTH ends, so anything
 *  under 0.018 rad would have nothing left to draw — 0.08 leaves 0.062 rad of
 *  ink, ~40 px at the finale's framing. The upper bound keeps a stroke a mark
 *  rather than something that crosses the frame. */
const MIN_SEP = 0.08;
const MAX_SEP = 0.3;
/** the clear sky a new stroke must leave around every stroke already on it,
 *  radians — `arcsClash`'s threshold, and the half of "no overlaps" that
 *  crossing alone does not cover. ~13 px at the finale's framing, a bit over
 *  twice the endpoint gap: at 0.012 a pair of near-parallel strokes still came
 *  out as railroad tracks. The pool is dense enough that even three times this
 *  costs no spawns, so it is set by the eye rather than by starvation. Shared
 *  stars are exempt (see `arcsClash`). */
const CLEAR_RAD = 0.02;
/** how many pairs back the driver refuses to repeat */
const RECENT = 6;
/** draws before `pickPair` gives up for this tick. Higher than the pool alone
 *  needs, because the no-overlap test (`arcsClash`) rejects against every live
 *  stroke as well: coming back null is a SKIPPED SPAWN, which is the right
 *  answer — a quiet tick beats a stroke laid across a stroke. */
const PICK_ATTEMPTS = 64;
/** how sharply a pick favours the middle of the frame: a candidate's weight is
 *  exp(−½(γ/this)²) with γ its angle off the view axis. At 0.3 the weight is
 *  half by γ ≈ 0.35 rad and ~14% at 0.6 — over the shipped pool that puts 41% of
 *  all draws inside 0.3 rad of the axis where a uniform draw would put 15%, and
 *  still reaches the edge now and then. Priority, not exclusivity. */
const CENTRE_SIGMA_RAD = 0.3;
/** how often an attempt takes its FIRST end from a star a visible stroke
 *  already touches, rather than from the pool at large. High: at the driver's
 *  cadence a figure has only a dozen strokes' worth of life to grow in. The
 *  remainder is what seeds the NEXT figure while this one is fading — and the
 *  branch is only taken when there is something to grow from, so an empty sky
 *  always starts fresh. */
const GROW_CHANCE = 0.9;
/** the anchor is drawn from the live strokes' stars NEWEST FIRST, at index
 *  ⌊u^this × count⌋ — so a figure grows from its growing end rather than from a
 *  stroke that is about to fade and take the join with it. It is most of what
 *  makes a FIGURE: measured over the driver's own loop, a flat draw over the
 *  same stars leaves ~5 groups on the sky with the largest holding 5 of the 12
 *  live strokes, and this leaves ~3.7 with the largest holding 6.7. */
const GROW_RECENCY_POW = 3;
/** how many VISIBLE strokes may end on one star. Three lets a figure chain and
 *  branch once; at four and up a bright star in the middle of the frame
 *  collects every new stroke and reads as a starburst rather than as a shape.
 *  Counted over the live strokes only, so a star is free again once the strokes
 *  that touched it have faded. */
export const MAX_TOUCH = 3;

/** The candidate directions: everything in the cone that is not backdrop — and,
 *  index for index, the UNFLOORED `starRho` of each.
 *
 *  NOT the radius the field is drawn at: optics/starfield.ts floors every disc
 *  at `minRhoRad`, which catches everything under mag ≈ 0.51 — a large minority
 *  of this pool, all of it drawn at one and the same size. This array is a
 *  MONOTONE BRIGHTNESS KEY and nothing else: the name picks below order by it,
 *  and the endpoint-gap test measures against it. Both want the honest
 *  magnitude, which the floor flattens away. */
export const CANDIDATE_DIRS: Dir3[] = [];
export const CANDIDATE_RHO: number[] = [];
{
  const cos = Math.cos(CONE_RAD);
  for (let i = 0; i < BRIGHT_COUNT; i++) {
    const s = SKY.stars[i];
    const d = dirOf(s.az, s.alt);
    if (d[0] < cos) continue; // dot with +X
    CANDIDATE_DIRS.push(d);
    CANDIDATE_RHO.push(starRho(s.mag));
  }
}

/** The angle between two unit directions, radians. */
export const sepOf = (a: Dir3, b: Dir3): number =>
  Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

const cross3 = (a: Dir3, b: Dir3): Dir3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot3 = (a: Dir3, b: Dir3): number =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * DO TWO STROKES CROSS? — half of the test that keeps the sky from turning into
 * a mesh (owner: "let's make sure it's not possible to draw lines across
 * currently shown lines; we shouldn't see lines overlapping"); `arcsClash` is
 * the whole of it.
 *
 * Both strokes are great-circle arcs shorter than π. Their two great circles
 * meet at exactly one antipodal PAIR, ±(nAB × nCD) with n the plane normals; the
 * arcs cross iff one of those two points lies strictly inside BOTH arcs. A point
 * p is inside the arc a→b when it is past a toward b — dot(nAB × a, p) > 0, that
 * cross product being the great circle's tangent at a — and still short of b —
 * dot(b × nAB, p) > 0.
 *
 * STRICTLY, WHICH IS WHAT MAKES SHARED ENDPOINTS LEGAL: two strokes that MEET at
 * a common star are the chart doing its job, not an overlap. Their intersection
 * is that star itself, where both dot products are exactly 0, so this comes back
 * false without a special case. Coincident great circles (a stroke against
 * itself, or two collinear ones) give a degenerate ±m and come back false too —
 * pickPair's on-sky refusal is what keeps a repeat off the sky (`recent` alone
 * cannot: it remembers fewer spawns than a stroke stays visible for).
 */
export function arcsCross(a: Dir3, b: Dir3, c: Dir3, d: Dir3): boolean {
  const n1 = cross3(a, b);
  const n2 = cross3(c, d);
  const m = cross3(n1, n2);
  const len = Math.hypot(m[0], m[1], m[2]);
  if (len < 1e-9) return false;
  const inside = (p: Dir3, s: Dir3, e: Dir3, n: Dir3) =>
    dot3(cross3(n, s), p) > 0 && dot3(cross3(e, n), p) > 0;
  const p: Dir3 = [m[0] / len, m[1] / len, m[2] / len];
  const q: Dir3 = [-p[0], -p[1], -p[2]];
  return (
    (inside(p, a, b, n1) && inside(p, c, d, n2)) ||
    (inside(q, a, b, n1) && inside(q, c, d, n2))
  );
}

/** The angle from a point to a great-circle ARC, radians: its distance to the
 *  circle when its foot lands inside the arc, and to the nearer end otherwise. */
function arcDist(p: Dir3, s: Dir3, e: Dir3): number {
  const n = cross3(s, e);
  const nl = Math.hypot(n[0], n[1], n[2]);
  if (nl > 1e-9) {
    const nu: Dir3 = [n[0] / nl, n[1] / nl, n[2] / nl];
    const h = dot3(p, nu); // the out-of-plane part, i.e. sin(distance)
    const f: Dir3 = [p[0] - nu[0] * h, p[1] - nu[1] * h, p[2] - nu[2] * h];
    const fl = Math.hypot(f[0], f[1], f[2]);
    if (fl > 1e-9) {
      const foot: Dir3 = [f[0] / fl, f[1] / fl, f[2] / fl];
      if (dot3(cross3(nu, s), foot) > 0 && dot3(cross3(e, nu), foot) > 0)
        return Math.asin(Math.min(1, Math.abs(h)));
    }
  }
  return Math.min(sepOf(p, s), sepOf(p, e));
}

/**
 * DO TWO STROKES CLASH? — cross, or run so close together that they read as one
 * doubled line. The second half matters as much as the first: two near-parallel
 * strokes a couple of pixels apart never intersect and still land on the page as
 * an overlap, which is the thing the owner asked not to see.
 *
 * FOUR POINT-TO-ARC DISTANCES ARE THE WHOLE CLEARANCE TEST, because two segments
 * that do not cross are closest at an endpoint of one of them.
 *
 * A SHARED STAR IS NOT A CLASH: strokes are meant to meet at stars, so an
 * endpoint sitting on one of the other stroke's endpoints is skipped rather than
 * measured. Two strokes leaving the same star at a shallow angle are still
 * refused — the FAR endpoint of the short arm measures the wedge, and a wedge
 * that thin reads as a doubled line too.
 */
export function arcsClash(
  a: Dir3,
  b: Dir3,
  c: Dir3,
  d: Dir3,
  clearRad: number,
): boolean {
  if (arcsCross(a, b, c, d)) return true;
  const same = (p: Dir3, q: Dir3) => dot3(p, q) > 1 - 1e-9;
  const near = (p: Dir3, s: Dir3, e: Dir3) =>
    !same(p, s) && !same(p, e) && arcDist(p, s, e) < clearRad;
  return near(a, c, d) || near(b, c, d) || near(c, a, b) || near(d, a, b);
}

/** The recent-set's key for a pair — order-free, so A→B blocks B→A too. */
export const pairKey = (i: number, j: number): string =>
  i < j ? `${i}-${j}` : `${j}-${i}`;

/** The centre-weighted pick's CUMULATIVE weights over a pool, index for index —
 *  built once per pool, so a draw is one `rng()` and a binary search. */
export function centreCdf(dirs: readonly Dir3[]): number[] {
  const cdf: number[] = [];
  let sum = 0;
  for (const d of dirs) {
    const g = Math.acos(Math.min(1, Math.max(-1, d[0]))); // angle off +X
    sum += Math.exp((-0.5 * g * g) / (CENTRE_SIGMA_RAD * CENTRE_SIGMA_RAD));
    cdf.push(sum);
  }
  return cdf;
}

/** The cumulative weights of the shipped pool. */
export const CANDIDATE_CDF: number[] = centreCdf(CANDIDATE_DIRS);

/** Sample an index from a cumulative-weight table, `u` ∈ [0, 1). */
export function sampleCdf(cdf: readonly number[], u: number): number {
  const x = u * cdf[cdf.length - 1];
  let lo = 0;
  let hi = cdf.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cdf[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Pick the next pair to draw: two distinct candidates whose separation is in the
 * window, not already a stroke on the sky, whose key is not in `recent`, whose
 * stroke `clashes` with nothing
 * already on the sky and neither of whose ends is already carrying MAX_TOUCH
 * strokes. Returns null when no legal pair turned up inside PICK_ATTEMPTS — the
 * caller draws nothing.
 *
 * `live` is the strokes ALREADY ON THE SKY, oldest first, as index pairs into
 * `dirs` — the driver's own list, handed over whole rather than pre-digested,
 * because both things this needs fall out of it: how many strokes each star
 * carries (the MAX_TOUCH cap) and which stars are worth growing from, newest
 * first. It is what makes the picks GROW: an attempt's first end is usually one
 * of those stars, so the new stroke extends a figure instead of landing
 * somewhere unrelated. The second end is always a centre-weighted draw from the
 * whole pool, which is what lets a figure reach into fresh sky.
 *
 * DETERMINISTIC IN `rng` — a seeded stream, never Math.random (the repo's rule
 * anywhere a frame can see it, and optics/sky.ts's own LCG precedent). EXACTLY
 * THREE draws are consumed on every attempt, including the rejected ones and
 * whichever branch it took, so where the stream lands afterwards depends on the
 * attempt COUNT alone.
 */
export function pickPair(
  rng: () => number,
  dirs: readonly Dir3[],
  cdf: readonly number[],
  recent: readonly string[],
  clashes: (i: number, j: number) => boolean = () => false,
  live: readonly (readonly [number, number])[] = [],
): [number, number] | null {
  const n = dirs.length;
  if (n < 2) return null;
  // A pair already on the sky is refused OUTRIGHT: `recent` only remembers the
  // last RECENT spawns, which is SHORTER than a stroke's ~11-spawn lifetime, and
  // the clash test exempts shared endpoints — so an exact duplicate of a live
  // stroke passes both and lands as one doubled line. This set is the guard.
  const onSkyKeys = new Set(live.map(([a, b]) => pairKey(a, b)));
  const touch = new Map<number, number>();
  for (const s of live)
    for (const k of s) touch.set(k, (touch.get(k) ?? 0) + 1);
  // THE STARS A FIGURE CAN STILL GROW FROM: on the sky, not yet a hub, and in
  // NEWEST-FIRST order, which the draw below leans on hard.
  const open: number[] = [];
  for (let m = live.length - 1; m >= 0; m--)
    for (const k of live[m])
      if (touch.get(k)! < MAX_TOUCH && !open.includes(k)) open.push(k);
  const full = (k: number) => (touch.get(k) ?? 0) >= MAX_TOUCH;
  for (let attempt = 0; attempt < PICK_ATTEMPTS; attempt++) {
    const grow = rng() < GROW_CHANCE && open.length > 0;
    const u = rng();
    const i = grow
      ? open[Math.floor(Math.pow(u, GROW_RECENCY_POW) * open.length)]
      : sampleCdf(cdf, u);
    const j = sampleCdf(cdf, rng());
    if (i === j) continue;
    if (full(i) || full(j)) continue;
    const sep = sepOf(dirs[i], dirs[j]);
    if (sep < MIN_SEP || sep > MAX_SEP) continue;
    if (onSkyKeys.has(pairKey(i, j))) continue;
    if (recent.includes(pairKey(i, j))) continue;
    if (clashes(i, j)) continue;
    return [i, j];
  }
  return null;
}

/** optics/sky.ts's generator, which is private there: the 32-bit LCG from
 *  Numerical Recipes as a `() => [0, 1)` stream. `Math.imul` keeps the multiply
 *  exact in 32 bits, which is what makes the sequence identical in every JS
 *  engine — and the picks reproducible in a test. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** the pair stream's seed — the knob for "same sky, different strokes" */
const SEED = 20260808;
/** how often a new stroke starts, ms. With the line engine's ~14 s lifetime
 *  this settles at a dozen or so strokes on the sky: alive, not busy. Exported
 *  because it is half of the ring buffer's one invariant — SLOT_COUNT × this
 *  must outlast a stroke, or a spawn would blank a line mid-life. */
export const SPAWN_MS = 1200;

// ── THE NAMES AND THE WORDS ─────────────────────────────────────────────────
// Type on the sky: a handful of star names in the margin of the chart, and one
// quotation. Both are canvas-painted textures on camera-facing quads in the
// same attached group as the strokes, so they ride the starfield's centring and
// come and go with the chapter.
//
// FLAT, LIKE EVERYTHING ELSE UP HERE (the 2D/3D law: only the lens model reads
// 3D). A sprite's centre goes through modelViewMatrix and its corners are added
// in VIEW space before the projection — story/peelcards.ts's billboard, whose
// header has the full argument — so the type is always exactly parallel to the
// film plane and can never tilt into perspective. The corner offset carries an
// extra view-space SHIFT, which is how a name sits right-and-below its star: an
// offset in screen space, the way an atlas sets it, with no camera basis to
// derive and nothing to re-derive if the pose changes.

/** PLACEHOLDER CONTENT, exactly like the catalog these sit on: classic
 *  star-atlas names, uppercase because the sprite's look is letterspaced caps.
 *  The owner replaces the strings; nothing else here reads them. */
export const LABELS: readonly string[] = [
  "VEGA",
  "ALTAIR",
  "DENEB",
  "MIRA",
  "LYRA",
  "ATLAS",
];

/** THE QUOTATION, set as two lines of type: the sentence in italic serif and
 *  the attribution under it in letterspaced mono. Typographic quotes and an em
 *  dash — this is the one place on the sky with real typography in it. */
export const QUOTE_TEXT =
  "“Boredom always precedes a period of great creativity.”";
export const QUOTE_ATTR = "— ROBERT PIRSIG";

/** THE ATTRIBUTION'S INK, per theme — SKY_INK's pattern, because this line does
 *  NOT take the same value on both stages. It USED to be `SKY_INK.<theme>.line`
 *  (the words and the lines were the same chapter); the strokes have since gone
 *  to the stars' own ink (SKY_INK), and the attribution kept the terracotta
 *  rather than following, because it is now the sky's ONE warm accent and it
 *  answers the page's `--highlight` under it. Authored, then, not derived.
 *  On PAPER that orange is a light-on-light mark: at the attribution's 15px mono
 *  weight it measured ~1.4:1 against the stage, i.e. illegible. The light value
 *  is that same orange taken down until it clears 3:1 with room to spare (~5.9:1
 *  nominal on the sky backdrop, ~5.2:1 after the sprite's own alpha), so the
 *  minified type survives its coverage loss. */
export const QUOTE_ATTR_INK = { dark: 0xdd8a4c, light: 0x8a4a12 };

/** How far apart two labelled stars must be, radians. Wide: a name is a much
 *  bigger mark than the star it belongs to, and two of them inside a quarter
 *  radian read as one smudge — the greedy pick below simply refuses the fainter
 *  of any such pair. */
export const LABEL_SEP = 0.25;

/** THE WINDOW A NAME MAY SIT IN, as half-angles about the view axis: up (+Y)
 *  and right (+Z) on the screen. NOT the strokes' cone — a stroke at the edge
 *  of the 55° pool still reads, while a name there is a word half off the
 *  screen. The finale holds fov 70, i.e. ±35° vertically and ±48° horizontally
 *  on a 16:10 canvas; the numbers below leave a margin on the top and bottom
 *  and, on the right, room for the label itself, which is set OUTWARD from its
 *  star and runs ~9° wide. */
const LABEL_UP_RAD = (26 * Math.PI) / 180;
const LABEL_RIGHT_RAD = (38 * Math.PI) / 180;

/** Whether a direction is inside that window — the eligibility test the picks
 *  below are run with, exported because it is half of what "well placed" means
 *  and a test should be able to hold it. */
export const inLabelFrame = (d: Dir3): boolean =>
  d[0] > 0 &&
  Math.abs(Math.atan2(d[1], d[0])) <= LABEL_UP_RAD &&
  Math.abs(Math.atan2(d[2], d[0])) <= LABEL_RIGHT_RAD;

/**
 * WHICH STARS GET NAMED — the brightest first, each accepted only if it clears
 * every star already taken (and every `reserved` direction) by `LABEL_SEP`.
 *
 * DETERMINISTIC AND PURE: the brightness order breaks ties by index, so the
 * answer is a function of the catalog alone — no rng, no build-order luck. It
 * is computed once at module load rather than authored as a table, so a re-cut
 * of the star catalog re-picks instead of leaving names pointing at nothing.
 *
 * `bright` is any strictly increasing function of magnitude, index for index
 * with `dirs` — the driver passes CANDIDATE_RHO (the drawn disc radius), which
 * saves carrying a third parallel array of magnitudes.
 */
export function pickLabelStars(
  dirs: readonly Dir3[],
  bright: readonly number[],
  opts: {
    /** which directions may carry a name at all — `inLabelFrame` in the driver */
    eligible: (d: Dir3) => boolean;
    /** directions already spoken for, which a pick must also clear */
    reserved: readonly Dir3[];
    max: number;
  },
): number[] {
  const order = dirs
    .map((_, i) => i)
    .filter((i) => opts.eligible(dirs[i]))
    .sort((a, b) => bright[b] - bright[a] || a - b);
  const taken: Dir3[] = [...opts.reserved];
  const out: number[] = [];
  for (const i of order) {
    if (out.length >= opts.max) break;
    if (taken.some((d) => sepOf(dirs[i], d) <= LABEL_SEP)) continue;
    taken.push(dirs[i]);
    out.push(i);
  }
  return out;
}

/** THE QUOTE'S HEADING: 25° off the view axis into the upper left — far enough
 *  off centre that the strokes' centre-weighted picks mostly draw themselves
 *  below and right of it, and the far corner from the caption band, which is set
 *  bottom-left in HTML.
 *  The held fly pose looks down world +X with +Y up, so screen right is +Z
 *  (right = forward × up) and up-and-left is +Y, −Z. Unit by construction:
 *  the tilt's two weights are a unit vector themselves. */
const QUOTE_TILT_RAD = (25 * Math.PI) / 180;
const QUOTE_UP = 0.8;
const QUOTE_LEFT = 0.6;
export const QUOTE_DIR: Dir3 = [
  Math.cos(QUOTE_TILT_RAD),
  Math.sin(QUOTE_TILT_RAD) * QUOTE_UP,
  -Math.sin(QUOTE_TILT_RAD) * QUOTE_LEFT,
];

/** The named stars, as indices into CANDIDATE_DIRS. ONE HEADING IS RESERVED
 *  before the first pick: the quote's — the words are a block of type a quarter
 *  radian across and a name under them would be read as part of the sentence.
 *
 *  `LABELS.length` IS THE BINDING CONSTRAINT, NOT THE SKY: the frame window
 *  holds ~100 candidates, ten of which clear each other by LABEL_SEP, so `max`
 *  stops the greedy pick before the sky does and every name in the pool is
 *  placed.
 *
 *  FEWER IS STILL LEGAL, and nothing downstream may assume otherwise: LABELS is
 *  a POOL taken in order, not a table that has to be used up, so a wider
 *  LABEL_SEP, a tighter window or a re-cut catalog shortens this list instead of
 *  leaving a name pointing at nothing. */
export const LABEL_STARS: number[] = pickLabelStars(
  CANDIDATE_DIRS,
  CANDIDATE_RHO,
  { eligible: inLabelFrame, reserved: [QUOTE_DIR], max: LABELS.length },
);

/** Look knobs for the type — the owner's to tune in one pass (Task 3). */
export const SKY_TYPE_LOOK = {
  /** the sphere the type sits on: inside the strokes' sphere, which is inside
   *  the starfield's. Nothing optical depends on it (none of the three tests
   *  depth); it is what orders the three in the transparent pass. */
  radius: STARFIELD_LOOK.radius * 0.98,
  /** canvas pixels per DESIGN pixel. Everything below is in design pixels and
   *  every draw is scaled by this, so the textures are painted at 2× and stay
   *  crisp when the framing puts a label near 1:1. */
  ss: 2,
  /** DESIGN PIXELS TO RADIANS. The finale holds fov 70, i.e. 1.22 rad over the
   *  canvas height, so an ~800px-tall canvas runs ~655 px/rad and this is
   *  ≈ 1 screen pixel per design pixel there. It is the whole scale story for
   *  the labels: turn it and every name resizes together. */
  pxRad: 0.0016,
  label: {
    /** 10, down from 12 (owner: "the star labels should be lighter and
     *  smaller") — ~7 screen px of cap height at the finale's framing, which is
     *  a chart's margin note rather than a caption. */
    fontPx: 10,
    /** letterspacing, em — the star-atlas tell, and what keeps small caps from
     *  reading as a UI chip. SHARED RECIPE: the value is LABEL_TYPE's
     *  (story/peelcards.ts) — the card titles and the star names wear the same
     *  uppercase tracked mono, per the owner ("same text style for
     *  consistency"). */
    tracking: LABEL_TYPE.trackingEm,
    /** …but NOT its weight. A card title is set at 27 px and can carry
     *  LABEL_TYPE's 500; a name on the sky is a third of that and the same
     *  weight reads as a bold chip, so the names take the regular cut. */
    weight: 400,
    /** the sprite's full height in design px (the type is centred in it) */
    boxPx: 14,
    padPx: 3,
    /** where the name sits relative to its star, in radians of screen: clear to
     *  the right and a little below, so the disc keeps its own space. */
    rightRad: 0.022,
    downRad: 0.022,
    /** SUBTLE. The names are the chart's margin notes, not its subject — they
     *  sit under the star ink they are painted in.
     *
     *  PER THEME, and not as a matter of taste: the renderer composites in
     *  LINEAR space, so one alpha buys very different contrast depending on
     *  which side of the backdrop the ink is on. Cream ink over a near-black sky
     *  lands ABOVE its nominal alpha — a linear blend is dominated by the bright
     *  source — while dark ink over paper lands far below it. Measured off the
     *  shipped page at a single 0.55: ~0.63 of full contrast on the dark stage
     *  against ~0.26 on the light one. The light numbers below are the alphas
     *  that put the two at the same perceived weight; they read as absurdly high
     *  next to the dark ones and are not.
     *
     *  DOWN A THIRD from 0.55/0.85 — the other half of "lighter and smaller",
     *  and the half that does most of the work: a name now sits UNDER the star
     *  ink it is painted in rather than beside it. */
    ink: { dark: 0.37, light: 0.62 },
  },
  quote: {
    /** power-of-two, and 2:1 — the sentence wraps to two lines with the
     *  attribution under it, all centred in the box */
    canvasW: 1024,
    canvasH: 512,
    padPx: 14,
    fontPx: 34,
    leadingPx: 46,
    // Design px in a canvas the sprite minifies ~2.3× — at 15px the tracked
    // mono strokes landed ~7 screen px tall and mipmapped to ~1.5:1 contrast
    // on paper. 24px keeps the line clearly subordinate to the quote while
    // surviving the minification.
    attrPx: 24,
    attrTracking: 0.22,
    attrGapPx: 30,
    /** the sprite's angular WIDTH, radians — i.e. a quad of radius × this
     *  across. At fov 70 that is a bit over a third of the frame's width: it
     *  reads as a passage of type on the sky rather than as a caption. */
    widthRad: 0.5,
    /** stronger than the labels in either theme: this one is meant to be read.
     *  Per theme for the reason the labels' ink is. */
    ink: { dark: 0.92, light: 0.97 },
  },
};

/** The alpha a piece of type is written at on the current stage. */
export const inkOf = (
  ink: { dark: number; light: number },
  light: boolean,
): number => (light ? ink.light : ink.dark);

// ── WHERE EACH NAME GOES ────────────────────────────────────────────────────

/** One name on the sky: what it says and what it points at. Every name sits at
 *  the same screen offset from its star (SKY_TYPE_LOOK.label) — they all hang
 *  off a POINT, so one offset is the whole placement story. */
export interface LabelEntry {
  text: string;
  dir: Dir3;
}

/** EVERY NAME THE SKY CARRIES: the picked stars, taking names from the pool in
 *  order. */
export const LABEL_ENTRIES: readonly LabelEntry[] = LABEL_STARS.map((i, n) => ({
  text: LABELS[n],
  dir: CANDIDATE_DIRS[i],
}));

/** The site's families, by name, with the same fallbacks global.css declares —
 *  a canvas font string takes no CSS variable. */
const MONO =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
const SERIF = '"Bitter", Georgia, "Times New Roman", serif';

const paletteOf = (light: boolean): SkyPalette =>
  light ? SKY_INK.light : SKY_INK.dark;

const cssHex = (n: number) => `#${n.toString(16).padStart(6, "0")}`;

/** the next power of two at or above `n` — texture dimensions stay pow2 so the
 *  sprites keep their mipmaps */
const pow2 = (n: number) => 1 << (32 - Math.clz32(Math.max(1, n - 1)));

function labelFont(ctx: CanvasRenderingContext2D): void {
  const L = SKY_TYPE_LOOK.label;
  ctx.font = `${L.weight} ${L.fontPx * SKY_TYPE_LOOK.ss}px ${MONO}`;
  ctx.letterSpacing = `${L.tracking}em`;
}

/** A label's canvas, sized to its own text: measured at the painting font, then
 *  rounded up to a power of two. The extra width lands on the RIGHT and stays
 *  transparent, which is why the sprite is anchored by its left edge. */
function labelCanvas(text: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  const ctx = c.getContext("2d")!;
  labelFont(ctx);
  const L = SKY_TYPE_LOOK.label;
  const w = ctx.measureText(text).width + 2 * L.padPx * SKY_TYPE_LOOK.ss;
  // setting either dimension resets the context, so nothing is painted here
  c.width = pow2(Math.ceil(w));
  c.height = L.boxPx * SKY_TYPE_LOOK.ss;
  return c;
}

function paintLabel(
  canvas: HTMLCanvasElement,
  text: string,
  light: boolean,
): void {
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  labelFont(ctx);
  ctx.fillStyle = cssHex(paletteOf(light).star);
  ctx.textBaseline = "middle";
  ctx.fillText(
    text,
    SKY_TYPE_LOOK.label.padPx * SKY_TYPE_LOOK.ss,
    canvas.height / 2,
  );
}

/** Greedy word wrap at `maxW` canvas pixels, in whatever font the context is
 *  already set to. */
function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > maxW) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

function paintQuote(canvas: HTMLCanvasElement, light: boolean): void {
  const Q = SKY_TYPE_LOOK.quote;
  const ss = SKY_TYPE_LOOK.ss;
  const pal = paletteOf(light);
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.letterSpacing = "0px";
  ctx.font = `italic ${Q.fontPx * ss}px ${SERIF}`;
  const lines = wrapLines(ctx, QUOTE_TEXT, canvas.width - 2 * Q.padPx * ss);
  // the block is CENTRED in the box, so a wrap that comes out at a different
  // line count moves the type rather than pushing it off the bottom
  const blockH = (lines.length * Q.leadingPx + Q.attrGapPx + Q.attrPx) * ss;
  const x = canvas.width / 2;
  let y = (canvas.height - blockH) / 2 + Q.fontPx * ss;
  ctx.fillStyle = cssHex(pal.star);
  for (const line of lines) {
    ctx.fillText(line, x, y);
    y += Q.leadingPx * ss;
  }
  const lastBaseline = y - Q.leadingPx * ss;
  // the attribution in its own pinned terracotta (QUOTE_ATTR_INK), not the
  // strokes' ink — it is the sky's one warm accent, and the light stage takes
  // that orange darker, or it does not read on paper
  ctx.font = `${Q.attrPx * ss}px ${MONO}`;
  ctx.letterSpacing = `${Q.attrTracking}em`;
  ctx.fillStyle = cssHex(light ? QUOTE_ATTR_INK.light : QUOTE_ATTR_INK.dark);
  ctx.fillText(QUOTE_ATTR, x, lastBaseline + (Q.attrGapPx + Q.attrPx) * ss);
}

interface Sprite {
  mesh: THREE.Mesh;
  tex: THREE.CanvasTexture;
  uOpacity: { value: number };
}

/**
 * One text quad. `half` is the quad's world half-size and `offset` a view-space
 * (screen) shift of the whole thing, both in world units at `radius`.
 */
function buildSprite(
  geo: THREE.PlaneGeometry,
  canvas: HTMLCanvasElement,
  centre: Dir3,
  half: [number, number],
  offset: [number, number],
  name: string,
): Sprite {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;

  const r = SKY_TYPE_LOOK.radius;
  const uCentre = uniform(
    new THREE.Vector3(centre[0] * r, centre[1] * r, centre[2] * r),
  );
  // one uniform for the quad's whole placement: half-size in xy, screen shift
  // in zw. Constant for the life of the sprite — nothing here is animated.
  const uBox = uniform(
    new THREE.Vector4(half[0], half[1], offset[0], offset[1]),
  );
  const uOpacity = uniform(0);

  const mat = new THREE.MeshBasicNodeMaterial();
  const view = modelViewMatrix.mul(vec4(uCentre, 1));
  mat.vertexNode = cameraProjectionMatrix.mul(
    vec4(
      view.x.add(positionGeometry.x.mul(uBox.x)).add(uBox.z),
      view.y.add(positionGeometry.y.mul(uBox.y)).add(uBox.w),
      view.z,
      view.w,
    ),
  );
  const face = texture(tex);
  // rgb and alpha SEPARATELY (story/peelcards.ts's note): a vec4 colorNode would
  // land the glyph alpha in diffuseColor.a as well and square every edge.
  mat.colorNode = face.rgb;
  mat.opacityNode = face.a.mul(uOpacity);
  mat.transparent = true;
  mat.depthWrite = false;
  mat.depthTest = false; // sky ink — optics/constellation-lines.ts's contract
  mat.side = THREE.DoubleSide; // a view-space billboard's winding flips
  mat.toneMapped = false; // flat ink, not a lit surface

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  // the geometry is a unit quad and the real placement lives in uniforms, so
  // three's bounding sphere means nothing here
  mesh.frustumCulled = false;
  return { mesh, tex, uOpacity };
}

/**
 * Start the sky chapter's ink. Registers a scene.onFrame callback for the life
 * of the page — like story/internals.ts there is no teardown, because the
 * hero's scene is never disposed.
 */
export function createStoryConstellations(scene: SceneHandle): void {
  const lines = createConstellationLines({ light: isLightTheme() });
  // ONE attached group for the whole chapter's ink — the labels and the quote
  // join the lines in here, so the attach/detach bookkeeping below is written
  // once.
  const group = new THREE.Group();
  group.name = "Lens_SkyInk";
  group.add(lines.object);

  // ── the type ───────────────────────────────────────────────────────────────
  // Built once, here, because this is the first line of code in the module that
  // knows there is a document: everything above is pure and is imported by the
  // test suite.
  const geo = new THREE.PlaneGeometry(2, 2); // ±1 corners: the offset IS the half-size
  const labels: Sprite[] = [];
  /** repaint closures, one per sprite — a theme flip redraws the SAME canvas and
   *  re-uploads it (story/peelcards.ts's precedent), so no material has to be
   *  re-bound to a new texture object */
  const repaints: ((light: boolean) => void)[] = [];

  const addLabel = (entry: LabelEntry) => {
    const L = SKY_TYPE_LOOK.label;
    const canvas = labelCanvas(entry.text);
    const r = SKY_TYPE_LOOK.radius;
    const k = (r * SKY_TYPE_LOOK.pxRad) / SKY_TYPE_LOOK.ss; // canvas px → world
    const halfW = (canvas.width * k) / 2;
    const halfH = (canvas.height * k) / 2;
    const sprite = buildSprite(
      geo,
      canvas,
      entry.dir,
      [halfW, halfH],
      // LEFT-anchored (the pow2 padding trails off the right), so the offset is
      // a gap to the first glyph whatever the name is
      [r * L.rightRad + halfW, -r * L.downRad],
      `Lens_SkyLabel_${entry.text.replace(/\s+/g, "_")}`,
    );
    labels.push(sprite);
    repaints.push((l) => {
      paintLabel(canvas, entry.text, l);
      sprite.tex.needsUpdate = true;
    });
    group.add(sprite.mesh);
  };

  for (const entry of LABEL_ENTRIES) addLabel(entry);

  const quote = (() => {
    const Q = SKY_TYPE_LOOK.quote;
    const canvas = document.createElement("canvas");
    canvas.width = Q.canvasW;
    canvas.height = Q.canvasH;
    const halfW = (SKY_TYPE_LOOK.radius * Q.widthRad) / 2;
    const sprite = buildSprite(
      geo,
      canvas,
      QUOTE_DIR,
      [halfW, (halfW * Q.canvasH) / Q.canvasW],
      [0, 0], // centred on its own heading, unlike a label
      "Lens_SkyQuote",
    );
    repaints.push((l) => {
      paintQuote(canvas, l);
      sprite.tex.needsUpdate = true;
    });
    group.add(sprite.mesh);
    return sprite;
  })();

  // THE TYPE'S ALPHAS, per stage — see SKY_TYPE_LOOK.label.ink. Held as plain
  // numbers rather than looked up in the frame loop, which writes them every
  // frame and must not branch on a theme that changes once an hour at most.
  let labelInk = inkOf(SKY_TYPE_LOOK.label.ink, isLightTheme());
  let quoteInk = inkOf(SKY_TYPE_LOOK.quote.ink, isLightTheme());

  for (const repaint of repaints) repaint(isLightTheme());

  // THE FAMILIES ARE WEBFONTS (HtmlShell.astro loads Bitter and JetBrains Mono
  // from a stylesheet). A canvas painted before they arrive keeps its fallback
  // forever, so repaint once when the document says they are in. By the time the
  // dive prefetches this module they normally already are; this is the cheap
  // guarantee rather than the plan. Only the QUOTE can actually change shape —
  // its wrap is recomputed on every paint inside a fixed canvas, while a label's
  // canvas was sized against a monospace metric the fallback stack shares.
  void document.fonts.ready.then(() => {
    for (const repaint of repaints) repaint(isLightTheme());
    scene.invalidate();
  });

  watchTheme((l) => {
    lines.setTheme(l);
    labelInk = inkOf(SKY_TYPE_LOOK.label.ink, l);
    quoteInk = inkOf(SKY_TYPE_LOOK.quote.ink, l);
    for (const repaint of repaints) repaint(l);
    scene.invalidate();
  });

  const rng = lcg(SEED);
  const recent: string[] = [];
  /** THE STROKES CURRENTLY ON THE SKY, oldest first, as the CANDIDATE INDICES
   *  they join (not the inset endpoints the engine drew) — both halves of the
   *  pick policy read this: a candidate is refused if it would clash with any of
   *  them, and it is preferred if it shares one of their stars. A slot's alpha
   *  is exactly 0 from `deadAt` on (optics/constellation-lines.ts `lineAlphaAt`),
   *  which is when a stroke stops counting; the list is pruned on the spawn tick
   *  and never holds more than the ring buffer does. */
  const live: { pair: [number, number]; deadAt: number }[] = [];
  let tAcc = 0;
  let last = performance.now();
  let nextSpawn = 0;

  scene.onFrame(() => {
    const now = performance.now();
    const dt = Math.min(100, now - last);
    last = now;

    const p = scene.state.storyTarget;
    const env = constellationEnvAt(p);
    const qEnv = quoteEnvAt(p);

    // ZERO FIRST, ALWAYS, and for every piece of ink: a fast flick across a
    // fall window can take p from inside the chapter to outside it between two
    // frames, and without an unconditional write the last opacity the shader
    // was handed would hold — freezing a half-drawn stroke, or a name, on the
    // sky at whatever it had.
    lines.setEnvelope(env);
    // THE NAMES ARE THE STROKES' — one law, `labelEnvAt`, so they can never
    // arrive or leave on their own.
    const labelO = labelEnvAt(p) * labelInk;
    for (const l of labels) l.uOpacity.value = labelO;
    // the words outlive both, which is the whole point of their own envelope
    quote.uOpacity.value = qEnv * quoteInk;

    if (env <= 0 && qEnv <= 0) {
      // The clock stops here — nothing ages invisibly. Past the chapter's edges
      // the group comes off the starfield entirely; inside them it stays
      // attached at zero, which costs a few draws of fully transparent quads
      // and saves the re-attach on a small scrub.
      if (group.parent && (p < SPAN_P0 || p > SPAN_P1))
        scene.starfieldDetach(group);
      return;
    }

    tAcc += dt;
    lines.setTime(tAcc);

    // THE STARFIELD CAN GO OUT FROM UNDER US. story/fly.ts unmounts it on the
    // way out of the span (and mounts it asynchronously on the way in, so the
    // first frames of this envelope can find nothing to attach to). Ask every
    // active frame: the call is two null checks and a no-op once attached, and
    // it is the whole re-attach story — a deep link into the sky chapter fails
    // here for a few frames and then succeeds.
    if (!scene.starfieldAttach(group)) return;

    // the strokes are done spawning while the quote holds through the trails
    if (env <= 0) return;
    if (tAcc < nextSpawn) return;
    nextSpawn = tAcc + SPAWN_MS;
    for (let k = live.length - 1; k >= 0; k--)
      if (live[k].deadAt <= tAcc) live.splice(k, 1);
    // the pruned list, as the pick wants it: both the no-clash test and the
    // growth policy read the same strokes, in the same order.
    const onSky = live.map((s) => s.pair);
    const pair = pickPair(
      rng,
      CANDIDATE_DIRS,
      CANDIDATE_CDF,
      recent,
      (i, j) =>
        onSky.some(([a, b]) =>
          arcsClash(
            CANDIDATE_DIRS[i],
            CANDIDATE_DIRS[j],
            CANDIDATE_DIRS[a],
            CANDIDATE_DIRS[b],
            CLEAR_RAD,
          ),
        ),
      onSky,
    );
    if (!pair) return; // a starved tick is silence, not a looser test
    recent.push(pairKey(pair[0], pair[1]));
    if (recent.length > RECENT) recent.shift();
    const a = CANDIDATE_DIRS[pair[0]];
    const b = CANDIDATE_DIRS[pair[1]];
    live.push({
      pair,
      deadAt:
        tAcc +
        lineDrawMs(sepOf(a, b)) +
        CONST_LINES_LOOK.lifeMs +
        CONST_LINES_LOOK.fadeMs,
    });
    lines.spawn(a, b, tAcc);
  });
}
