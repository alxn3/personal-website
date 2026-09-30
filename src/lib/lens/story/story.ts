// The story table: the single source of pacing for the scroll-driven lens
// story. Track height, each scene's scroll range, the camera path, caption
// bands, stage tints and the HUD all derive from STORY below.
// Structure only: envelopes live in envelopes.ts, cinematic extras in
// cinematics.ts, caption content in components/LensStory.astro.

import { smoothstep } from "../core/math";
import { FLY } from "../optics/fly-core";

/** The camera's orbit radius, world units. Pose `pos`, `xs` and `ys` are in
 *  units of this. */
export const STORY_R = 11;

/** Rewrap fraction where the reveal ends and the lens' last leg home starts
 *  (fly.ts flySeatAt). Must sit past the shell's crossfade (rewrap 0.06–0.16). */
const REVEAL_END_F = 0.25;

/** Rewrap fraction where the camera starts pulling back, after holding still
 *  through the reveal crossfade. */
export const CAM_RELEASE_F = 0.16;

/** Rewrap fraction of the dive's last frame. Lives here because the dust law
 *  in envelopes.ts needs it and fly.ts is lazy. */
const FLY_EXIT_F = 0.58;

/** Rewrap fraction where the sky has fully faded: the fov hand-back may start
 *  (fly.ts FOV_BACK) and the sky's turn must end (reveal.ts TURN_P1). Must sit
 *  past REVEAL_END_F. */
const SKY_OUT_END_F = 0.32;

export interface Pose {
  /** camera direction, in units of STORY_R */
  pos: [number, number, number];
  fov: number;
  up: [number, number, number];
  /** 1 = flatten to an orthographic elevation on the hold (or over the
   *  scene's `orthoIn`/`orthoOut`); 0 = perspective */
  ortho: number;
  /** horizontal park: > 0 shoves the lens left (caption on the right) */
  xs: number;
  /** vertical shift along camera-up: a 2D reframe on a detail */
  ys?: number;
  /** orbit centre / look-at, world units; default the origin (lens centre,
   *  optical axis = world X, front at +X). Unlike `ys` it moves the 3D pivot. */
  target?: [number, number, number];
  /** frame width the scene needs, in its own half-heights; narrower
   *  viewports pull the camera back to fit. Default 1. */
  wide?: number;
  /** portrait push-in: the orbit offset scales by lerp(near, 1, parkScale).
   *  Default 1. */
  near?: number;
  /** portrait lift, a fraction of canvas height (+ = up), gated like `near`.
   *  Default 0.06. */
  lift?: number;
}

// Caption markup is not here: it lives in components/LensStory.astro via
// <LensSceneContent scene="…">, keyed by id.
export interface StoryScene {
  id: string;
  /** HUD readout and scene-rail label */
  title: string;
  /** show a dot on the scene rail */
  rail?: boolean;
  /** duration weight, ≈ screenfuls of scroll */
  hold: number;
  /** fraction of the scene spent easing the camera in from the previous pose */
  transit: number;
  /** the pose the camera settles into */
  cam: Pose;
  /** stage tint, dark theme */
  bg: [number, number, number];
  /** stage tint, light theme */
  bgLight: [number, number, number];
  /** The flatten's own window, scene-local fractions, replacing camera.ts's
   *  default. An omitted side is already open / never closes. Needs `cam.ortho`. */
  orthoIn?: [number, number];
  orthoOut?: [number, number];
  /** scene fraction the camera waits before moving; must be below `transit` */
  camHold?: number;
  /** scene fraction where the caption band ends early; within (transit, 1] */
  capEnd?: number;
}

// --- the story ---------------------------------------------------------------
export const STORY: StoryScene[] = [
  {
    id: "hero",
    title: "HERO",
    hold: 0.9,
    transit: 0,
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    // flat front view, lens on the right; on a phone pushed in and dropped
    // below the intro text
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
    // long, so the first three scenes read as one flow
    transit: 0.6,
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    // flat side profile
    cam: { pos: [0, 0, 1.3], fov: 32, up: [0, 1, 0], ortho: 1, xs: -0.24 },
  },
  {
    id: "peel",
    title: "PEEL",
    rail: true,
    // room for the layers flying off and fading out
    hold: 1.5,
    // the camera is still swinging round while the sides come off
    transit: 0.66,
    bg: [26, 23, 17],
    bgLight: [240, 236, 226],
    // one arc from the side profile round to directly behind the lens, where
    // every scene up to the dive stays; the story's widest shot
    cam: {
      pos: [-2.2774, 0.6328, 0],
      fov: 32,
      up: [0, 1, 0],
      ortho: 0,
      xs: -0.28,
      // on a phone the core fills a third of the width; outer pieces clip
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
    // pushes back in on the bare mechanism from behind, caption on the right;
    // must keep the orbiting cards (peelcards.ts SHELL_R) in frame
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
    // side view of the standing lens, looking slightly down, orbiting the focus
    // rig. Much closer than |pos| ~1.0 and the depth fade shows the chassis
    // through itself.
    cam: {
      pos: [-1.0024, 0.34, 0],
      fov: 26,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0.1,
      ys: 0.03,
      // the focus rig, which the tip carries from x ≈ −1 to y ≈ −1
      target: [0, -1.0, 0],
    },
  },
  {
    id: "flythrough",
    title: "FLY-THROUGH",
    rail: true,
    // a 0.5 approach, then 1.8 for the dive itself
    hold: 2.3,
    // the approach tilts up into the bore; then the camera parks and the lens
    // moves (SceneHandle.setLensDolly). DIVE_P0 is where it ends.
    transit: 0.5 / 2.3,
    // the caption leaves before the dive
    capEnd: 0.5,
    bg: [12, 11, 8],
    bgLight: [231, 227, 215],
    // the dive's starting pose exactly (|pos| × STORY_R = FLY.distFar), so the
    // lens dolly is 0 on the dive's first frame
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
    // holds the dive's parked pose; the lens is behind the camera, so the frame
    // is all sky
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
    // long, because the sky turns half a revolution here
    hold: 1.7,
    transit: 0,
    bg: [10, 9, 7],
    bgLight: [238, 234, 222],
    // same parked pose; the ending's first move leaves from here
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
    // the hand-over from the sky back to the lens needs room
    hold: 1.9,
    // a long pull-back that waits out the reveal crossfade first
    transit: 0.92,
    camHold: CAM_RELEASE_F,
    // the frame goes flat and stays flat into the next scene (see its
    // `orthoOut`); may not start before the dive's fov hand-back has finished
    orthoIn: [0.52, 0.8],
    bg: [22, 20, 14],
    bgLight: [238, 234, 222],
    // pulls straight back along the dive's axis to frame the exploded pieces at
    // their widest. `target` sits at the outermost pieces, so going flat keeps
    // them the same size on screen; `wide` fits them on a portrait screen.
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
    // the id stays `capsOn` for the markup and /lens; the beat is the bloom
    id: "capsOn",
    title: "BLOOM",
    // pieces leaving, the quarter-turn, the fall, the wobble and the bloom
    hold: 2.2,
    // holds still while the flatten fades, then one quarter-orbit onto the
    // lens' side, rolling camera-up from +Y to +X
    camHold: 0.11,
    transit: 0.44,
    // the rewrap's flatten arrives open and fades over the first falling pieces
    orthoOut: [0.02, 0.1],
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    // the final frame: the upright lens centred, far enough out that the
    // falling pieces fit a phone; `lift` 0 centres the bloom
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

// --- validation, run at module load so a bad edit fails at boot --------------

// Scene ids other modules look up by name.
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
      if (sc.camHold >= sc.transit)
        throw new Error(
          `lens story: scene "${sc.id}" camHold (${sc.camHold}) must be below its transit (${sc.transit}) — the hold opens the move late, it does not replace it`,
        );
    }
    if (sc.capEnd !== undefined) {
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
  // envelopes.ts reads RANGES[0] as the hero
  if (story[0].id !== "hero")
    throw new Error(
      `lens story: the first scene must be "hero" (got "${story[0].id}") — story/envelopes.ts reads RANGES[0] positionally`,
    );
}
validateStory(STORY);

// --- track length --------------------------------------------------------------
// Total hold in screenfuls → svh, clamped in px. Story geometry uses svh, not
// dvh, so a collapsing mobile toolbar does not re-lay-out the track.
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

/** Each scene's scroll range [p0, p1), in proportion to its hold. */
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

/** The index of the scene containing p; the last scene past the end. */
export const sceneIndexAt = (p: number): number => {
  for (let k = 0; k < RANGES.length; k++) if (p < RANGES[k].p1) return k;
  return RANGES.length - 1;
};

// --- caption bands -------------------------------------------------------------
// Each captioned scene gets a band element in the scroll track
// (LensSceneContent.astro) with a sticky caption inside. Band geometry is in
// scroll space, p = scrollY / (track − 100svh), not a percentage of the track.

/** Overlap on each side of a scene's range, in p, so neighbouring captions
 *  cross-fade. */
export const CAPTION_PAD = 0.01;

/** The track's scrollable length as CSS (p = scrollY / this). */
export const TRACK_SCROLL_CSS = `calc(${TRACK_HEIGHT_CSS} - 100svh)`;

/** A caption crossfade's length in scroll px; published as --cap-fade. */
export const CAPTION_FADE_CSS = `calc(${2 * CAPTION_PAD} * ${TRACK_SCROLL_CSS})`;

export interface CaptionBand {
  id: string;
  /** band edges in p */
  a: number;
  b: number;
  /** the band as a CSS box on the track */
  top: string;
  height: string;
  /** the band runs to the end of the track */
  final: boolean;
  /** `final` for an Astro attribute (Astro renders `false` rather than
   *  dropping it) */
  finalAttr: true | undefined;
}

/** Fraction `f` of the track's scrollable length, against the band's
 *  containing block. */
const scroll = (f: number) => `${f.toFixed(6)} * (100% - 100svh)`;

export const CAPTION_BANDS: CaptionBand[] = RANGES.map(({ scene, p0, p1 }) => {
  const a = Math.max(0, p0 - CAPTION_PAD);
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

/** The band for a scene id. Throws, so a caption naming a missing scene fails
 *  the build. */
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

/** The middle of a scene's settled part (after the camera transit): where a
 *  reader parked in the scene rests. */
export const holdCentreOf = (r: SceneRange): number =>
  atFrac(r, (r.scene.transit + 1) / 2);

/** Where the reveal ends, as absolute p. */
export const REVEAL_END = atFrac(rangeOf("rewrap"), REVEAL_END_F);

/** Where the sky has fully faded, as absolute p. */
export const SKY_OUT_END = atFrac(rangeOf("rewrap"), SKY_OUT_END_F);

/** The dive's last frame, as absolute p. */
export const FLY_EXIT_END = atFrac(rangeOf("rewrap"), FLY_EXIT_F);

/** The dive's first frame: the end of the flythrough's camera approach, where
 *  the camera parks and the lens starts moving. The body fade passes from the
 *  driver to fly.ts exactly here. */
const FLY_RANGE = rangeOf("flythrough");
export const DIVE_P0 = atFrac(FLY_RANGE, FLY_RANGE.scene.transit);

/** A point on the timeline: fraction `f` through the named scene. */
export type StoryPoint = [id: string, f: number];
/** A smoothstep window: both edges in one scene (`[id, f0, f1]`), or each edge
 *  in its own scene (`[[idA, f0], [idB, f1]]`). */
export type StoryWindow =
  [id: string, f0: number, f1: number] | [StoryPoint, StoryPoint];

/** A window's edges in absolute p. */
export const windowEdges = (w: StoryWindow): [number, number] => {
  if (typeof w[0] === "string") {
    const [id, f0, f1] = w as [string, number, number];
    const r = rangeOf(id);
    return [atFrac(r, f0), atFrac(r, f1)];
  }
  const [a, b] = w as [StoryPoint, StoryPoint];
  return [atFrac(rangeOf(a[0]), a[1]), atFrac(rangeOf(b[0]), b[1])];
};

/** A pulse window's edges, checked to run forward. */
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

/** An envelope that rises over `rise` and, if given, falls over `fall`, as a
 *  function of p. Registers `name.rise` and `name.fall` as windows. */
export const pulseFn = (
  w: { rise: StoryWindow; fall?: StoryWindow },
  name: string,
): ((p: number) => number) => {
  const [r0, r1] = span(`${name}.rise`, pulseEdges(w.rise, "rise"));
  if (!w.fall) return (p: number) => smoothstep(r0, r1, p);
  const [f0, f1] = span(`${name}.fall`, pulseEdges(w.fall, "fall"));
  if (f0 < r1)
    throw new Error(
      `lens story: pulse "${name}" fall opens (p ${f0}) before its rise is spent (p ${r1})`,
    );
  return (p: number) => smoothstep(r0, r1, p) * (1 - smoothstep(f0, f1, p));
};

// --- the window registry -----------------------------------------------------

/** A named window in absolute p. */
export interface StoryWindowSpan {
  name: string;
  p0: number;
  p1: number;
}

const WINDOWS = new Map<string, StoryWindowSpan>();

/** Register a named window and return its edges. Registering a name again with
 *  different edges throws, except under HMR. */
export const span = (
  name: string,
  edges: [number, number],
): [number, number] => {
  const prev = WINDOWS.get(name);
  if (
    prev &&
    !import.meta.hot &&
    (prev.p0 !== edges[0] || prev.p1 !== edges[1])
  )
    throw new Error(
      `lens story: window "${name}" is already registered at [${prev.p0}, ${prev.p1}]`,
    );
  WINDOWS.set(name, { name, p0: edges[0], p1: edges[1] });
  return edges;
};

/** Every registered window, sorted by (p0, p1, name). Complete only once every
 *  story module has loaded (state.ts imports them all). */
export const storyWindows = (): StoryWindowSpan[] =>
  [...WINDOWS.values()].sort(
    (a, b) => a.p0 - b.p0 || a.p1 - b.p1 || a.name.localeCompare(b.name, "en"),
  );
