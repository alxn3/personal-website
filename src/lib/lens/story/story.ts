// THE STORY TABLE — the single source of pacing for the scroll-jacked lens
// story. Everything downstream (track height, each scene's normalized range
// `p`, camera path, mechanism curves, caption bands, stage tints, the HUD) is
// derived from STORY below, so a scene edit here is the whole edit.
//
// SCOPE: story STRUCTURE only — beat order, durations, camera poses,
// tints, rail flags, titles. Mechanism envelope tuning lives in
// story/envelopes.ts, cinematic implementation in story/cinematics.ts, overlay
// content in components/LensStory.astro. Don't consolidate those in here.

import { smoothstep } from "../core/math";
import { FLY } from "../optics/fly-core";

/** The story's ORBIT RADIUS, world units: every scene's `pos` is a direction in
 *  units of this, and the park shifts (`xs`, `ys`) are in the same unit. */
export const STORY_R = 11;

/** THE REVEAL ENDS HERE — a fraction through `rewrap`: the frame the lens' last
 *  leg home opens (story/fly.ts flySeatAt). It must sit past the shell's
 *  crossfade in (rewrap-local [0.06, 0.16]). */
export const REVEAL_END_F = 0.25;

/** Where the rewrap's camera move leaves, as a fraction of the scene. The
 *  camera must be dead still through the reveal crossfade (story/fly.ts
 *  flyRevealAt's far edge) and then creep off zero rate. */
export const CAM_RELEASE_F = 0.16;

/** Where the last of the sky is exactly gone — a fraction through `rewrap`:
 *  the far edge of the starfield's fade (story/fly.ts skyOutAt), the frame the
 *  fov hand-back may open (story/fly.ts FOV_BACK) and the frame the sky's turn
 *  may end (story/reveal.ts TURN_P1). It must sit past REVEAL_END_F. Here
 *  because fly.ts is lazy and reveal.ts homepage-safe: they cannot import each
 *  other. */
export const SKY_OUT_END_F = 0.32;

export interface Pose {
  pos: [number, number, number]; // camera direction (scaled by the scene radius)
  fov: number;
  up: [number, number, number];
  ortho: number; // 1 = flatten to an orthographic elevation on the HOLD (or over
  // the scene's own `orthoIn`/`orthoOut` window); 0 = perspective
  xs: number; // horizontal lens-park: >0 shoves the lens left (caption sits right)
  ys?: number; // vertical look-shift along camera-up: a 2D reframe on a detail
  target?: [number, number, number]; // orbit centre / look-at, WORLD units,
  // default [0,0,0] (lens centre is the origin; optical axis = world X, front
  // at +X). Shifts the whole orbit sphere. Unlike ys, it moves the 3D pivot.
  wide?: number; // the frame width this scene needs, in units of its own
  // on-axis half-height; the camera pulls back until it fits. Default 1 = never
  // pulls back. Applied in applyStoryFraming, so it scales the pose.
  near?: number; // portrait push-in: the orbit offset scales by
  // lerp(near, 1, parkScale), so it only exists on narrow frames. Default 1.
  lift?: number; // portrait lift, a fraction of the canvas height, + = up;
  // gated by (1 − parkScale) like `near`. Default 0.06.
}

// Scene CONTENT is not in this table — overlay markup is authored in
// components/LensStory.astro via <LensSceneContent scene="…">, keyed by id.
export interface StoryScene {
  id: string;
  title: string; // display name — the HUD readout ("SCN 05 / LIGHT PATH") and the rail label
  rail?: boolean; // show this scene on the scene rail (bottom-right progress dots)
  hold: number; // duration weight, ≈ screenfuls of scroll
  transit: number; // 0..1 of the scene spent easing the camera IN from the previous pose
  cam: Pose; // settle pose (the parked "hold")
  bg: [number, number, number]; // stage tint on the hold (dark theme)
  bgLight: [number, number, number]; // stage tint on the hold (light theme — warm paper family)
  // The flatten's own window, scene-local fractions, when the flat frame is not
  // the park: either one present replaces story/camera.ts's default parked
  // schedule. An omitted side means the flatten arrives already open or never
  // closes inside the scene. Both need `cam.ortho` > 0.
  orthoIn?: [number, number];
  orthoOut?: [number, number];
  camHold?: number; // fraction of THIS scene's range the camera move waits
  // before starting — it opens the move late. Validated below: under `transit`.
  capEnd?: number; // scene-local fraction where the caption's band ends early,
  // instead of running CAPTION_PAD past the scene. Validated: within (transit, 1].
}

// --- the story --------------------------------------------------------------
export const STORY: StoryScene[] = [
  {
    id: "hero",
    title: "HERO",
    hold: 0.9,
    transit: 0,
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    // dead-front elevation, lens right; on a phone pushed in and dropped under
    // the top-anchored intro type
    cam: {
      pos: [1.3, 0, 0],
      fov: 30,
      up: [0, 1, 0],
      ortho: 1,
      xs: -0.34,
      near: 0.6,
      lift: -0.1,
    },
  },
  {
    id: "zoom",
    title: "ZOOM",
    rail: true,
    hold: 1.35,
    // long, so scenes 1→3 read as one flow; the ortho flatten still reaches 1
    transit: 0.6,
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    cam: { pos: [0, 0, 1.3], fov: 32, up: [0, 1, 0], ortho: 1, xs: -0.24 }, // side profile (horizontal)
  },
  {
    id: "peel",
    title: "PEEL",
    rail: true,
    // long enough to play both the departure (story/envelopes.ts CARDS_APART)
    // and the wink behind it (story/peelcards.ts WINK_SPAN)
    hold: 1.5,
    // the camera is still swinging round while the sides come off, then holds
    // the rear-on pose the scene hands over on.
    transit: 0.66,
    bg: [26, 23, 17],
    bgLight: [240, 236, 226],
    // One arc, no waypoints, spending the chapter's whole azimuth: from the
    // zoom's side profile round to DEAD ASTERN (the dive's own azimuth), which
    // every scene from here to the dive's park holds. The story's furthest
    // pull-back, so the expansion's flower reads as one.
    cam: {
      pos: [-2.2774, 0.6328, 0],
      fov: 32,
      up: [0, 1, 0],
      ortho: 0,
      xs: -0.28,
      // a phone gets the core at a third of the width; the cloud's outer pieces
      // clip the sides
      near: 0.65,
    },
  },
  {
    id: "cards",
    title: "CARDS",
    rail: true,
    hold: 1.3,
    transit: 0.5,
    bg: [26, 23, 17],
    bgLight: [240, 236, 226],
    // The turn's hold: the push back in off the peel's pull-back, onto the bare
    // mechanism, on the peel's own rear azimuth. It must hold the card shell's
    // swell (story/peelcards.ts SHELL_R) for the whole scene, since a card
    // passes the camera on every revolution. xs POSITIVE = caption right.
    cam: {
      pos: [-1.4436, 0.3, 0],
      fov: 32,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0.2,
    },
  },
  {
    id: "internals",
    title: "INTERNALS",
    rail: true,
    hold: 1.4,
    transit: 0.3,
    bg: [30, 35, 24],
    bgLight: [238, 242, 229],
    // Side elevation of the STANDING lens (story/envelopes.ts uprightAt) on the
    // bare mechanism, at the chapter's own azimuth, looking slightly down —
    // the pitch the fly-through's approach gives back. `target` pivots the
    // orbit at the focus rig so the zoom lands on the mechanism. Don't pull
    // |pos| much below ~1.0: the depth fade shows the chassis through itself.
    cam: {
      pos: [-1.0024, 0.34, 0],
      fov: 26,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0.1,
      ys: 0.03,
      // the tip carries the focus rig round with the lens, from world x ≈ −1 to
      // y ≈ −1
      target: [0, -1.0, 0],
    },
  },
  {
    id: "flythrough",
    title: "FLY-THROUGH",
    rail: true,
    // the 0.5 approach below plus the 1.8 the DIVE itself scrubs over
    hold: 2.3,
    // The approach IS this scene's transit, and the dive starts when it ends
    // (DIVE_P0 below reads it). One tilt up into the bore, the lens meeting it
    // on UPRIGHT's fall; then the camera PARKS and the LENS travels
    // (SceneHandle.setLensDolly) from here to the sky's end.
    transit: 0.5 / 2.3,
    // the caption leaves before the throat, so the climax carries no type
    capEnd: 0.5,
    bg: [12, 11, 8],
    bgLight: [231, 227, 215],
    // THE DIVE'S PARK, exact: |pos| × STORY_R = FLY.distFar is the pose the
    // dive's own path (optics/fly-core flyPose) starts from, so the model's
    // dolly is 0 on the dive's first frame.
    cam: {
      pos: [-FLY.distFar / STORY_R, 0, 0],
      fov: FLY.fovFar,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0,
    },
  },
  {
    id: "constellations",
    title: "CONSTELLATIONS",
    rail: true,
    hold: 1.3,
    transit: 0,
    bg: [10, 9, 7],
    bgLight: [238, 234, 222],
    // Sky scene — holds the fly-through's parked pose exactly (transit 0 must
    // not snap). The lens is parked at its dolly's full reach, behind this
    // camera: there is nothing in frame but sky.
    cam: {
      pos: [-FLY.distFar / STORY_R, 0, 0],
      fov: FLY.fovFar,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0,
    },
  },
  {
    id: "trails",
    title: "TRAILS",
    rail: true,
    // long, because the sky turns a half revolution here
    // (optics/star-trails.ts TRAIL_SWEEP_MAX) ramped over most of the scene
    hold: 1.7,
    transit: 0,
    bg: [10, 9, 7],
    bgLight: [238, 234, 222],
    // still the same parked pose, and the pose the ending's first move leaves
    // from
    cam: {
      pos: [-FLY.distFar / STORY_R, 0, 0],
      fov: FLY.fovFar,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0,
    },
  },
  {
    id: "rewrap",
    title: "REWRAP",
    // the trails→reveal hand-over lives in this scene's early fractions and
    // needs room
    hold: 1.9,
    // the pull-back runs almost the whole scene and then parks, waiting out the
    // reveal's crossfade (CAM_RELEASE_F) before it creeps off zero rate
    transit: 0.92,
    camHold: CAM_RELEASE_F,
    // The ending goes flat, and stays flat across the boundary into the descent
    // (the capsOn row's `orthoOut` is the other half). It may not open before
    // the dive's fov hand-back is wholly released (story/fly.ts FOV_BACK) —
    // the flatten IS a fov change, and would scale what the other owner draws.
    orthoIn: [0.52, 0.8],
    bg: [22, 20, 14],
    bgLight: [238, 234, 222],
    // Still on the dive's axis — the sky's parked direction, pulled back and
    // nothing else: no azimuth, no up-vector turn, no waypoints. The reach
    // frames the unwrapped cloud at its widest.
    //
    // The target sits up the bore, and its distance is the FLATTEN'S MATCHING
    // PLANE: the flatten holds `dist · tan(fov/2)` constant (story/camera.ts
    // `back`), so content at the target plane keeps its screen size exactly.
    // Placed at the cloud's outermost pieces, so the projection change does not
    // read as a zoom. On this leg the shift is on-axis, hence invisible.
    //
    // `wide` pulls the camera back until the cloud fits a portrait frame, which
    // is the binding constraint here; landscape is untouched.
    cam: {
      pos: [-2.8, 0, 0],
      fov: 30,
      up: [0, 1, 0],
      ortho: 1,
      xs: 0,
      target: [6.5, 0, 0],
      wide: 1.35,
    },
  },
  {
    id: "capsOn",
    // The id stays `capsOn` though the beat is the BLOOM: the id is a contract
    // (REQUIRED_IDS below, the caption slot in components/LensStory.astro,
    // /lens's preview span). Only the display label differs.
    title: "BLOOM",
    // long enough for five beats: the first pieces leaving, the quarter-turn,
    // the fall, the rock (story/envelopes.ts ROCK), and the bloom (ROSE_PULSE)
    hold: 2.2,
    // Flat and still → turn → still. The camera holds the rewrap's face-on park
    // while the flatten drains, then makes ONE quarter-orbit onto the lens'
    // side — the ending's only camera move, rolling the up-vector +Y → +X. The
    // hold outlasts the flatten's blend, so the projection is wholly back
    // before the turn opens.
    camHold: 0.11,
    transit: 0.44,
    // the other half of the rewrap's `orthoIn`: the flat frame arrives already
    // open and the depth comes back over the descent's first pieces
    orthoOut: [0.02, 0.1],
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    // The frame the bloom plays in, and the page's hand-off frame: upright,
    // centred, far enough out to hold the whole column. No waypoints — one 90°
    // leg at a near-constant radius off the rewrap's park, swinging to the
    // lens' −Z side. The distance is portrait's: any nearer and the mid-fall
    // spread clips a phone's one-half-height-wide frame.
    // `near` is the portrait-only way in; `lift` 0 centres the bloom between
    // the nav and the caption
    cam: {
      pos: [0, 0, -2.0],
      fov: 30,
      up: [1, 0, 0],
      ortho: 1,
      xs: 0,
      near: 0.85,
      lift: 0,
    },
  },
];

// --- authoring validation ----------------------------------------------------
// Table invariants, checked at module load so a bad edit fails at boot.

// Scene ids consumers resolve BY NAME — story/camera.ts, story/envelopes.ts,
// story/reveal.ts and pages/lens.astro's preview span.
const REQUIRED_IDS = [
  "hero",
  "zoom",
  "peel",
  "cards",
  "internals",
  "flythrough",
  "constellations",
  "trails",
  "rewrap",
  "capsOn",
];

export function validateStory(story: StoryScene[]): void {
  if (story.length === 0) throw new Error("lens story: STORY is empty");
  const ids = new Set<string>();
  for (let i = 0; i < story.length; i++) {
    const sc = story[i];
    if (ids.has(sc.id))
      throw new Error(`lens story: duplicate scene id "${sc.id}"`);
    ids.add(sc.id);
    if (!Number.isFinite(sc.hold) || sc.hold <= 0)
      throw new Error(
        `lens story: scene "${sc.id}" hold must be finite and > 0 (got ${sc.hold})`,
      );
    if (!Number.isFinite(sc.transit) || sc.transit < 0 || sc.transit > 1)
      throw new Error(
        `lens story: scene "${sc.id}" transit must be within [0,1] (got ${sc.transit})`,
      );
    if (sc.camHold !== undefined) {
      if (!Number.isFinite(sc.camHold) || sc.camHold < 0 || sc.camHold >= 1)
        throw new Error(
          `lens story: scene "${sc.id}" camHold must be within [0,1) (got ${sc.camHold})`,
        );
      // the hold eats the move's own window, so a hold at or past `transit`
      // leaves no move at all
      if (sc.camHold >= sc.transit)
        throw new Error(
          `lens story: scene "${sc.id}" camHold (${sc.camHold}) must be below its transit (${sc.transit}) — the hold opens the move late, it does not replace it`,
        );
    }
    if (sc.capEnd !== undefined) {
      // a caption may leave early, never before its own camera move has landed
      if (!(sc.capEnd > sc.transit && sc.capEnd <= 1))
        throw new Error(
          `lens story: scene "${sc.id}" capEnd (${sc.capEnd}) must lie within (transit ${sc.transit}, 1]`,
        );
    }
    for (const [name, w] of [
      ["orthoIn", sc.orthoIn],
      ["orthoOut", sc.orthoOut],
    ] as const) {
      if (!w) continue;
      if (sc.cam.ortho <= 0)
        throw new Error(
          `lens story: scene "${sc.id}" authors ${name} but its pose is not flattened (ortho ${sc.cam.ortho}) — the window scales the pose's own flatten`,
        );
      if (!(w[0] >= 0 && w[1] <= 1 && w[0] < w[1]))
        throw new Error(
          `lens story: scene "${sc.id}" ${name} ${JSON.stringify(w)} must be a forward window inside [0,1]`,
        );
    }
  }
  const missing = REQUIRED_IDS.filter((id) => !ids.has(id));
  if (missing.length)
    throw new Error(
      `lens story: missing required scene id(s) ${missing.map((id) => `"${id}"`).join(", ")} — consumers resolve these by name (see REQUIRED_IDS); rename the scene there too, or keep the id`,
    );
  // story/envelopes.ts takes RANGES[0] positionally for the scroll-cue fade.
  if (story[0].id !== "hero")
    throw new Error(
      `lens story: the first scene must be "hero" (got "${story[0].id}") — story/envelopes.ts reads RANGES[0] positionally`,
    );
}
validateStory(STORY);

// --- derived pacing ---------------------------------------------------------
// Track length is the total duration in screenfuls → svh, clamped at both ends.
//
// THE UNIT LAW: svh for all story GEOMETRY (this file, the caption bands, the
// sticky slots in LensSceneContent.astro), since dvh re-lays-out the track when
// a mobile toolbar collapses. The two deliberate dvh survivors are the pinned
// stage (LensStory.astro's `h-dvh`, which is what hero-driver subtracts to form
// p's denominator) and the caption fade-IN anchors.
export const TOTAL_HOLD = STORY.reduce((s, sc) => s + sc.hold, 0);
const PER_SCREENFUL_MIN_PX = 460;
const PER_SCREENFUL_MAX_PX = 1000;
export const TRACK_MIN_PX = Math.round(TOTAL_HOLD * PER_SCREENFUL_MIN_PX);
export const TRACK_MAX_PX = Math.round(TOTAL_HOLD * PER_SCREENFUL_MAX_PX);
export const TRACK_SVH = Math.round(TOTAL_HOLD * 100);
export const TRACK_HEIGHT_CSS = `clamp(${TRACK_MIN_PX}px, ${TRACK_SVH}svh, ${TRACK_MAX_PX}px)`;

export interface SceneRange {
  scene: StoryScene;
  p0: number;
  p1: number;
}

/** Each scene's normalized scroll range [p0, p1), cumulative over durations. */
export const RANGES: SceneRange[] = (() => {
  const out: SceneRange[] = [];
  let acc = 0;
  for (const scene of STORY) {
    const p0 = acc / TOTAL_HOLD;
    acc += scene.hold;
    out.push({ scene, p0, p1: acc / TOTAL_HOLD });
  }
  return out;
})();

export const rangeOf = (id: string): SceneRange => {
  const r = RANGES.find((r) => r.scene.id === id);
  if (!r) throw new Error(`Unknown lens story scene: "${id}"`);
  return r;
};

// --- caption bands ----------------------------------------------------------
// The HTML layout of the hero's captions: each captioned scene gets a band
// element in the scroll track (components/LensSceneContent.astro) with a sticky
// caption inside, so captions appear, pin and leave by DOCUMENT POSITION.
//
// The geometry is SCROLL space, NOT a percentage of track: p = scrollY /
// (track − 100svh), so a band for [a, b] starts a·(100% − 100svh) down and is
// (b − a) of that plus one viewport of pin room. Sizing as a plain percentage
// of the track puts every band p·100svh late.

/** Overlap pad on each side of a scene's range, in normalized story p — the
 *  slight lead-in/lead-out that makes neighbouring captions cross-fade. */
export const CAPTION_PAD = 0.01;

/** The track's SCROLLABLE length, as CSS: everything but the viewport the stage
 *  is pinned to. p = scrollY / this. */
export const TRACK_SCROLL_CSS = `calc(${TRACK_HEIGHT_CSS} - 100svh)`;

/** How long a caption crossfade runs, in scroll pixels — the bands' overlap.
 *  LensStory.astro publishes it as --cap-fade on #lens-track. */
export const CAPTION_FADE_CSS = `calc(${2 * CAPTION_PAD} * ${TRACK_SCROLL_CSS})`;

export interface CaptionBand {
  id: string;
  /** band edges in normalized story p (the scene's range, padded) */
  a: number;
  b: number;
  /** the band as a CSS box on the track — see the scroll-space note above */
  top: string;
  height: string;
  /** this band ends AT the track end: nothing follows it to hand over to */
  final: boolean;
  /** `final` as an Astro attribute value: Astro stringifies a `false` on a
   *  data-* attribute rather than dropping it, so call sites read this. */
  finalAttr: true | undefined;
}

/** `f` of the track's scrollable length, as a CSS length — TRACK_SCROLL_CSS
 *  expressed against the band's absolutely-positioned containing block. */
const scroll = (f: number) => `${f.toFixed(6)} * (100% - 100svh)`;

export const CAPTION_BANDS: CaptionBand[] = RANGES.map(({ scene, p0, p1 }) => {
  const a = Math.max(0, p0 - CAPTION_PAD);
  // the final scene's band runs to the END of the track — nothing follows it
  const final = p1 >= 0.999;
  const b = final
    ? 1
    : scene.capEnd !== undefined
      ? p0 + (p1 - p0) * scene.capEnd
      : p1 + CAPTION_PAD;
  return {
    id: scene.id,
    a,
    b,
    top: `calc(${scroll(a)})`,
    height: `calc(${scroll(b - a)} + 100svh)`,
    final,
    finalAttr: final || undefined,
  };
});

/** The band a scene id owns. Throws, so an overlay block naming a missing
 *  scene is a BUILD error (the Astro template calls this in frontmatter). */
export const bandOf = (id: string): CaptionBand => {
  const b = CAPTION_BANDS.find((band) => band.id === id);
  if (!b)
    throw new Error(
      `lens story: no scene named "${id}" — a caption band must name a scene in STORY`,
    );
  return b;
};

/** Absolute p at fraction `f` through a scene's range. */
export const atFrac = (r: SceneRange, f: number): number => {
  if (!Number.isFinite(f) || f < 0 || f > 1)
    throw new Error(
      `lens story: fraction ${f} through scene "${r.scene.id}" is outside [0,1]`,
    );
  return r.p0 + (r.p1 - r.p0) * f;
};

/** A scene's HOLD CENTRE — the settle region's midpoint, past the camera
 *  transit: where a reader parked in the scene rests. */
export const holdCentreOf = (r: SceneRange): number =>
  atFrac(r, (r.scene.transit + 1) / 2);

/** REVEAL_END_F as an absolute story p — the form story/fly.ts's windows use.
 *  Declared after `atFrac` because it calls it at module load. */
export const REVEAL_END = atFrac(rangeOf("rewrap"), REVEAL_END_F);

/** SKY_OUT_END_F as an absolute story p. */
export const SKY_OUT_END = atFrac(rangeOf("rewrap"), SKY_OUT_END_F);

/** THE DIVE'S FIRST FRAME as an absolute story p: the end of the `flythrough`
 *  scene's camera approach, where the camera parks and the LENS starts moving.
 *  Also the body-fade channel's writer seam — hero-driver below, story/fly.ts
 *  above, and the two tiles must meet EXACTLY. */
const FLY_RANGE = rangeOf("flythrough");
export const DIVE_P0 = atFrac(FLY_RANGE, FLY_RANGE.scene.transit);

/** A point on the story timeline: fraction `f` through the named scene. */
export type StoryPoint = [id: string, f: number];
/** A smoothstep window: both edges in ONE scene (`[id, f0, f1]`), or each edge
 *  in its OWN scene (`[[idA, f0], [idB, f1]]` — e.g. a scrub that runs from one
 *  scene into the next). */
export type StoryWindow =
  [id: string, f0: number, f1: number] | [StoryPoint, StoryPoint];

/** A window's absolute story p edges. */
export const windowEdges = (w: StoryWindow): [number, number] => {
  if (typeof w[0] === "string") {
    const [id, f0, f1] = w as [string, number, number];
    const r = rangeOf(id);
    return [atFrac(r, f0), atFrac(r, f1)];
  }
  const [a, b] = w as [StoryPoint, StoryPoint];
  return [atFrac(rangeOf(a[0]), a[1]), atFrac(rangeOf(b[0]), b[1])];
};

/** A pulse edge pair, resolved and checked. */
const pulseEdges = (
  w: StoryWindow,
  side: "rise" | "fall",
): [number, number] => {
  const [a, b] = windowEdges(w);
  if (a >= b)
    throw new Error(
      `lens story: pulse ${side} window ${JSON.stringify(w)} resolves reversed or zero-width (p0 ${a} >= p1 ${b})`,
    );
  return [a, b];
};

/** Mechanism envelope: smoothstep RISE over one window × optional smoothstep
 *  FALL over another (omit `fall` for a one-way ramp). Windows name their
 *  scenes — see StoryWindow for the two edge forms. */
export const pulse = (
  p: number,
  w: { rise: StoryWindow; fall?: StoryWindow },
): number => {
  const [r0, r1] = pulseEdges(w.rise, "rise");
  const rise = smoothstep(r0, r1, p);
  if (!w.fall) return rise;
  const [f0, f1] = pulseEdges(w.fall, "fall");
  return rise * (1 - smoothstep(f0, f1, p));
};

/** The same envelope with its windows resolved ONCE, as a scalar function of p
 *  — `pulse` re-resolves both windows on every call. Registers `name.rise` and
 *  `name.fall` in the window registry. */
export const pulseFn = (
  w: { rise: StoryWindow; fall?: StoryWindow },
  name: string,
): ((p: number) => number) => {
  const [r0, r1] = span(`${name}.rise`, pulseEdges(w.rise, "rise"));
  if (!w.fall) return (p: number) => smoothstep(r0, r1, p);
  const [f0, f1] = span(`${name}.fall`, pulseEdges(w.fall, "fall"));
  return (p: number) => smoothstep(r0, r1, p) * (1 - smoothstep(f0, f1, p));
};

// --- the window registry -----------------------------------------------------

/** A named window in absolute story p, recorded where it is authored. */
export interface StoryWindowSpan {
  name: string;
  p0: number;
  p1: number;
}

const WINDOWS = new Map<string, StoryWindowSpan>();

/** Record a named window and hand its edges back, so every window is
 *  reportable by construction. A name registers once; re-registering (HMR)
 *  replaces it. */
export const span = (
  name: string,
  edges: [number, number],
): [number, number] => {
  WINDOWS.set(name, { name, p0: edges[0], p1: edges[1] });
  return edges;
};

/** Every window registered so far, sorted by (p0, p1, name). Complete once
 *  every story module has loaded — story/state.ts imports them all. */
export const storyWindows = (): StoryWindowSpan[] =>
  [...WINDOWS.values()].sort(
    (a, b) => a.p0 - b.p0 || a.p1 - b.p1 || a.name.localeCompare(b.name, "en"),
  );
