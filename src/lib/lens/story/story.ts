// THE STORY TABLE — the single source of pacing for the scroll-jacked lens
// story. Everything downstream (track height, each scene's normalized range
// `p`, camera path, mechanism curves, caption bands, stage tints, the HUD) is
// derived from STORY below, so a scene edit here is the whole edit.
//
// SCOPE: story STRUCTURE only — beat order, durations, camera poses/waypoints,
// tints, rail flags, titles. Mechanism envelope tuning lives in
// story/envelopes.ts, cinematic implementation in story/cinematics.ts, overlay
// content in components/LensStory.astro. Don't consolidate those in here.

import { smoothstep } from "../core/math";
import { FLY } from "../optics/fly-core";

/** The story's ORBIT RADIUS, world units: every scene's `pos` is a direction in
 *  units of this, and the park shifts (`xs`, `ys`) are in the same unit. */
export const STORY_R = 11;

/** The subset of a Pose a `via` waypoint contributes: story/camera.ts splines
 *  only these four. `ortho`, `ys` and `target` are endpoint-only — authoring
 *  them on a via is silently dead, hence the narrower type. */
export type Waypoint = Pick<Pose, "pos" | "fov" | "up" | "xs">;

/** THE REVEAL ENDS HERE — a fraction through `rewrap`: the frame the lens' last
 *  leg home opens (story/fly.ts flySeatAt). It must sit past the shell's
 *  crossfade in (rewrap-local [0.06, 0.16]); the camera-side movers downstream
 *  are staggered off it rather than all onsetting on it. */
export const REVEAL_END_F = 0.25;

/** Where the ending's camera move leaves — the fused rewrap→capsOn chain's
 *  `camHold`, as a fraction of the rewrap scene. The camera must be dead still
 *  through the reveal crossfade (story/fly.ts flyRevealAt's far edge; the
 *  coupling is pinned in story-fly.test.ts) and then creep off zero rate, so
 *  no frame is the one the camera's motion visibly begins on. */
export const CAM_RELEASE_F = 0.16;

/** Where the last of the sky is exactly gone — a fraction through `rewrap`:
 *  the far edge of the starfield's fade (story/fly.ts skyOutAt), the frame the
 *  fov hand-back may open (story/fly.ts FOV_BACK — the push-in scales the sky)
 *  and the frame the sky's turn may end (story/reveal.ts TURN_P1). It sits
 *  past REVEAL_END_F so the sweeping sky and the turning pieces share the
 *  frame for the whole exchange.
 *
 *  It lives in this table because fly.ts is lazy and reveal.ts is
 *  homepage-safe, so they may not import each other. */
export const SKY_OUT_END_F = 0.32;

export interface Pose {
  pos: [number, number, number]; // camera direction (scaled by the scene radius)
  fov: number;
  up: [number, number, number];
  ortho: number; // 1 = flatten to an orthographic elevation on the HOLD; 0 = perspective
  xs: number; // horizontal lens-park: >0 shoves the lens left (caption sits right)
  ys?: number; // vertical look-shift along camera-up: a 2D reframe on a detail
  target?: [number, number, number]; // orbit centre / look-at, WORLD units,
  // default [0,0,0] (lens centre is the origin; optical axis = world X, front
  // at +X). Shifts the whole orbit sphere, so framing and transit arcs are
  // preserved. Unlike ys, this changes the 3D pivot.
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
  via?: Waypoint[]; // optional waypoints during the transit (multi-step orbits / up-vector routing)
  bg: [number, number, number]; // stage tint on the hold (dark theme)
  bgLight: [number, number, number]; // stage tint on the hold (light theme — warm paper family)
  linkNext?: boolean; // fuse this scene's camera move with the NEXT scene's into
  // ONE spline + ONE ease (this scene's start → the next's transit end), so the
  // boundary is not a dead stop. This scene's own `transit` is then ignored for
  // the camera; mechanism/caption ranges are unaffected.
  camHold?: number; // LINKED CHAINS ONLY: fraction of THIS scene's range the
  // fused move waits before starting — the only way to get a still camera in a
  // linked head, which is otherwise in motion for its whole range. Validated
  // below: dead without linkNext, so it may not be authored there.
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
    cam: { pos: [1.3, 0, 0], fov: 30, up: [0, 1, 0], ortho: 1, xs: -0.34 }, // dead-front elevation, lens right
  },
  {
    id: "zoom",
    title: "ZOOM",
    rail: true,
    hold: 1.35,
    // long, to keep the dead hold before the cards' transit short — scenes 1→3
    // should read as one flow. The ortho flatten still reaches a full 1.
    transit: 0.6,
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    cam: { pos: [0, 0, 1.3], fov: 32, up: [0, 1, 0], ortho: 1, xs: -0.24 }, // side profile (horizontal)
  },
  {
    id: "peel",
    title: "PEEL",
    rail: true,
    hold: 1.2,
    // the spiral gets most of the scene, so the camera is still arriving while
    // the sides come off. It cannot go much further: the settle pose below is
    // this scene's subject too, and linkNext is not an option here — a linked
    // head would pass THROUGH that pose and never hold it.
    transit: 0.72,
    bg: [26, 23, 17],
    bgLight: [240, 236, 226],
    // THE SPIRAL IN: from the zoom's side profile the camera corkscrews up over
    // the barrel and down the other side while the sides peel, ending nose-up
    // and tilted forward-right. The lens' own orientation belongs to the SPIN
    // (story/peelcards.ts peelRollAt), so the pose is expressed in the camera.
    //
    // AUTHORING THE UPS: each is a screen angle θ for the nose (world +X),
    // measured CCW from screen-right — 0° at zoom, 20°, 45°, 70° here, 50° at
    // cards, one continuous unwind. The up producing θ is sin θ·ê₁ + cos θ·ê₂,
    // where ê₁ is +X with its component along p̂ removed and normalized, and
    // ê₂ = p̂ × ê₁. To recover θ from an authored up, build three's lookAt
    // basis (x = up × p̂, y = p̂ × x) and take atan2(X·y, X·x). Only `pos`'s
    // DIRECTION enters, so a via may move in or out without changing its roll.
    //
    // The via radii (|pos|·STORY_R ≈ 15.9 and 15.6, against endpoints 14.3 and
    // 16.6) must not dip: a corkscrew that swoops IN puts a card of the 5.2 wu
    // shell within ~5 wu of the camera, filling the frame.
    via: [
      {
        pos: [0.679, 0.679, 1.086],
        fov: 33,
        up: [0.302, 0.712, -0.634],
        xs: 0,
      },
      {
        pos: [0.561, 0.962, -0.881],
        fov: 32,
        up: [0.65, -0.684, -0.332],
        xs: 0,
      },
    ],
    cam: {
      pos: [0.42, 0.16, -1.44],
      fov: 32,
      up: [0.903, -0.369, 0.222],
      ortho: 0,
      xs: -0.26,
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
    // Carries the peel's nose-up pose on and lets it back down — 62° at the
    // via, 50° at the settle (see the peel row for how the ups are authored),
    // so the roll keeps unwinding in ONE direction. The via bulges out along
    // +Z: a dolly-away in depth before settling.
    via: [
      {
        pos: [0.28, 0.14, -1.85],
        fov: 33,
        up: [0.873, -0.478, 0.096],
        xs: 0.1,
      },
    ],
    // The card field's hold, |pos|·STORY_R = 16.2 wu out. The card shell turns
    // about the optical axis at 5.2 wu (story/peelcards.ts SHELL_R) on a clock
    // of TIME alone, so a card passes within ~11 wu of the camera on every
    // revolution for as long as the field is lit — the pose has to hold that
    // swell for the whole scene. xs is POSITIVE (caption right, lens left).
    cam: {
      pos: [0.34, 0.2, -1.42],
      fov: 32,
      up: [0.745, -0.661, 0.085],
      ortho: 0,
      xs: 0.2,
    },
  },
  {
    id: "internals",
    title: "INTERNALS",
    rail: true,
    hold: 1.4,
    transit: 0.5,
    bg: [30, 35, 24],
    bgLight: [238, 242, 229],
    // FRONT three-quarter from the viewer's right, on the BARE MECHANISM (the
    // cards scene winks the shell and cladding out — story/peelcards.ts
    // WINK_SPAN). The +X/+Z quadrant puts the front element toward the viewer
    // with the nose screen-right; `target` pivots the orbit at the focus rig
    // (world x ≈ −1.5…−0.9) so the zoom lands on the mechanism. Perspective,
    // not the ortho flatten. Don't pull |pos| much below ~1.0 — closer, the
    // depth fade shows the chassis through itself.
    cam: {
      pos: [0.78, 0.2, 0.66],
      fov: 26,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0.1,
      ys: 0.03,
      target: [-1.0, 0, 0],
    },
  },
  {
    id: "flythrough",
    title: "FLY-THROUGH",
    rail: true,
    // 2.15 = the 0.35 approach below + the 1.8 the DIVE itself scrubs over.
    hold: 2.15,
    // THE APPROACH IS THIS SCENE'S TRANSIT, and the dive starts when it ends
    // (DIVE_P0 below reads it) — hence the 0.35 screenfuls over this hold. The
    // camera swings onto the optical axis and PARKS: from here to the sky's end
    // the LENS travels (SceneHandle.setLensDolly), not the camera.
    transit: 0.35 / 2.15,
    bg: [12, 11, 8],
    bgLight: [231, 227, 215],
    // THE DIVE'S PARK, exact: |pos| × STORY_R = FLY.distFar is the pose the
    // dive's own path (optics/fly-core flyPose) starts from, so the model's
    // dolly is 0 on the dive's first frame. Pinned in story-fly.test.ts.
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
    // A long hold, because the sky turns a half revolution here
    // (optics/star-trails.ts TRAIL_SWEEP_MAX) ramped over ~two thirds of the
    // scene: shorter and it reads as a spin rather than a long exposure.
    hold: 1.7,
    transit: 0,
    bg: [10, 9, 7],
    bgLight: [238, 234, 222],
    // Still the same parked pose — and the pose the fused rewrap→capsOn chain
    // leaves FROM, so the ending's first move starts where the sky ended.
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
    // The trails→reveal hand-over lives in this scene's early fractions and
    // needs room: at a fast scroll a short one compresses to a blink.
    hold: 1.7,
    transit: 0.95, // camera-ignored under linkNext — kept for caption pacing
    linkNext: true, // ONE continuous camera move across the 06→07 boundary
    // The ending waits for the reveal's crossfade, then creeps — see
    // CAM_RELEASE_F.
    camHold: CAM_RELEASE_F,
    bg: [22, 20, 14],
    bgLight: [238, 234, 222],
    // The camera sweeps half-around the lens and rolls it upright as the layers
    // wrap on. Under linkNext this pose is an interior waypoint of the fused
    // spline, so the lens is mid-spin here. The up-vector routes through +Y:
    // down → up is antipodal and a direct lerp would collapse to zero.
    cam: {
      pos: [0.1, -0.2, 1.26],
      fov: 30,
      up: [0.9, -0.32, 0],
      ortho: 0,
      xs: 0,
    },
    via: [
      {
        pos: [-1.1, 0.35, -0.7],
        fov: 30,
        up: [-0.55, 0.8, 0],
        xs: 0,
      },
      { pos: [-1.3, 0.5, 0.35], fov: 30, up: [0.4, 0.9, 0], xs: 0 },
      { pos: [-0.6, 0.3, 1.1], fov: 30, up: [1, 0.15, 0], xs: 0 },
    ],
  },
  {
    id: "capsOn",
    // The id stays `capsOn` though the beat is the BLOOM and no cap is shown:
    // the id is a contract (REQUIRED_IDS below, the caption slot in
    // components/LensStory.astro, /lens's preview span) and renaming it takes
    // /lens down. Only the display label differs.
    title: "BLOOM",
    // Long enough to end on a rest: the RETURN landing (story/envelopes.ts,
    // capsOn-local 0.25), the rose opening (ROSE_PULSE) and then a held frame
    // of the open flower before the page releases.
    hold: 1.7,
    transit: 0.7, // still perceptibly rotating at the settle — fluid, not parked
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    // SPINNING-CYLINDER SETTLE (tail of the fused chain): the lens stands
    // vertical and the camera orbits ~one revolution around its long axis, the
    // up-vector wobble decaying like a spun top righting itself. Constraints:
    // the fast first half must orbit WIDE (r ≈ 1.5) — unwrapped shells are
    // sheets up to ~11 wu long and an equatorial pass at the parked radius
    // flies straight through them; fov must stay FLAT across the vias, since
    // the spline follows per-via fov and alternating values read as a zoom
    // pump; xs must be 0 on every via, or the lens slides out and back.
    // ORTHO IS OFF: the flatten's pullback pushes the settle out to a long-lens
    // elevation where the opening flower reads as a flat disc.
    cam: { pos: [0, 0, 2.0], fov: 30, up: [1, 0, 0], ortho: 0, xs: 0 }, // upright, centred — the page hand-off frame
    via: [
      {
        pos: [0.11, -1.3, -0.75],
        fov: 30,
        up: [0.94, 0.22, 0],
        xs: 0,
      }, // wide, fast spin
      {
        pos: [0.45, 1.1, -0.62],
        fov: 30,
        up: [0.97, -0.12, 0],
        xs: 0,
      }, // tilts to camera — front element
      {
        pos: [0.28, 0.76, 0.76],
        fov: 30,
        up: [0.99, 0.06, 0],
        xs: 0,
      }, // dolly-in swell, once every layer has seated
    ],
  },
];

// --- authoring validation ----------------------------------------------------
// Table invariants, checked at module load so a bad edit fails loudly at boot
// rather than as subtly wrong motion.

// Scene ids consumers resolve BY NAME — story/camera.ts, story/envelopes.ts,
// story/reveal.ts and pages/lens.astro's preview span. Renaming one without
// updating them takes /lens down too.
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
    if (sc.linkNext && i === story.length - 1)
      throw new Error(
        `lens story: final scene "${sc.id}" must not set linkNext — there is no next scene to fuse with`,
      );
    // camHold is read only by camera.ts's linked branch, so on an unlinked
    // scene it is silently dead; a hold of the whole scene is zero-wide.
    if (sc.camHold !== undefined) {
      if (!sc.linkNext)
        throw new Error(
          `lens story: scene "${sc.id}" sets camHold without linkNext — only a fused chain's ease reads it (story/camera.ts), so it would do nothing`,
        );
      if (!Number.isFinite(sc.camHold) || sc.camHold < 0 || sc.camHold >= 1)
        throw new Error(
          `lens story: scene "${sc.id}" camHold must be within [0,1) (got ${sc.camHold})`,
        );
    }
    // camera.ts looks back exactly ONE scene for a chain's head, so a chain
    // spans two scenes; a second consecutive linkNext never fuses.
    if (sc.linkNext && story[i + 1]?.linkNext)
      throw new Error(
        `lens story: scenes "${sc.id}" and "${story[i + 1].id}" are consecutive linkNext scenes — camera.ts only looks back one scene, so chains longer than two never fuse`,
      );
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
// Track length is the total duration in screenfuls → svh, clamped so a short
// viewport isn't rushed and a huge one isn't a marathon.
//
// THE UNIT LAW: svh for all story GEOMETRY (this file, the caption bands, the
// sticky slots in LensSceneContent.astro). dvh moves by ~10% when a mobile
// toolbar collapses, which would re-lay-out the whole track mid-scroll. The
// two deliberate dvh survivors are the pinned stage (LensStory.astro's `h-dvh`
// — 100dvh IS window.innerHeight, which is what hero-driver.ts subtracts to
// form p's denominator, so the stage unpins at exactly p = 1) and the caption
// fade-IN anchors, which time against the live viewport edge.
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
// element in the scroll track (components/LensSceneContent.astro) with a
// sticky caption inside, so captions appear, pin and leave by DOCUMENT
// POSITION — no runtime system raises them.
//
// The geometry is SCROLL space, NOT a percentage of track. p = scrollY /
// (track − 100svh), since the last pinned viewport buys no progress, so a band
// for [a, b] starts a·(100% − 100svh) down and is (b − a) of that plus one
// viewport. The extra viewport is the sticky caption's pin room, and it is
// what puts the band's edges at the viewport edges exactly at p = a and p = b.
// Sizing as a plain percentage of the track puts every band p·100svh late.

/** Overlap pad on each side of a scene's range, in normalized story p — the
 *  slight lead-in/lead-out that makes neighbouring captions cross-fade. */
export const CAPTION_PAD = 0.02;

/** The track's SCROLLABLE length, as CSS: everything but the viewport the stage
 *  is pinned to. p = scrollY / this, so it is the unit the bands are laid out
 *  in and the unit the fades are timed in. */
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
  /** `final` as an Astro attribute value. Astro stringifies a `false` on a
   *  data-* attribute rather than dropping it, so `data-final={band.final}`
   *  would mark every band final — both call sites read this instead. */
  finalAttr: true | undefined;
}

/** `f` of the track's scrollable length, as a CSS length — TRACK_SCROLL_CSS
 *  expressed against the band's absolutely-positioned containing block. */
const scroll = (f: number) => `${f.toFixed(6)} * (100% - 100svh)`;

export const CAPTION_BANDS: CaptionBand[] = RANGES.map(({ scene, p0, p1 }) => {
  const a = Math.max(0, p0 - CAPTION_PAD);
  // the final scene's band runs to the END of the track — nothing follows it
  const final = p1 >= 0.999;
  const b = final ? 1 : p1 + CAPTION_PAD;
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
 *  transit: where a reader parked in the scene rests. One formula for both the
 *  `?story` scrubber's jump targets and story/cost.ts's hold rows, which must
 *  sample the same positions. */
export const holdCentreOf = (r: SceneRange): number =>
  atFrac(r, (r.scene.transit + 1) / 2);

/** REVEAL_END_F as an absolute story p — the form story/fly.ts's windows use.
 *  Declared after `atFrac` because it calls it at module load. */
export const REVEAL_END = atFrac(rangeOf("rewrap"), REVEAL_END_F);

/** SKY_OUT_END_F as an absolute story p. */
export const SKY_OUT_END = atFrac(rangeOf("rewrap"), SKY_OUT_END_F);

/** THE DIVE'S FIRST FRAME as an absolute story p: the end of the `flythrough`
 *  scene's camera approach, where the camera parks and the LENS starts moving.
 *
 *  Also the seam in the range-tiled writer map for the body-fade channel —
 *  hero-driver owns it below this p, story/fly.ts above, and the two tiles must
 *  meet EXACTLY or the channel holds whatever it had. It lives here because
 *  fly.ts is lazy and hero-driver may not import it. */
const FLY_RANGE = rangeOf("flythrough");
export const DIVE_P0 = atFrac(FLY_RANGE, FLY_RANGE.scene.transit);

/** A point on the story timeline: fraction `f` through the named scene. */
export type StoryPoint = [id: string, f: number];
/** A smoothstep window: both edges in ONE scene (`[id, f0, f1]`), or each edge
 *  in its OWN scene (`[[idA, f0], [idB, f1]]` — e.g. a scrub that runs from one
 *  scene into the next). */
export type StoryWindow =
  [id: string, f0: number, f1: number] | [StoryPoint, StoryPoint];

/** A window's absolute story p edges. Exported so readers that need to know
 *  where a window SITS (story/state.ts, the STORY-MAP) resolve it here rather
 *  than keeping a second copy of the resolution. */
export const windowEdges = (w: StoryWindow): [number, number] => {
  if (typeof w[0] === "string") {
    const [id, f0, f1] = w as [string, number, number];
    const r = rangeOf(id);
    return [atFrac(r, f0), atFrac(r, f1)];
  }
  const [a, b] = w as [StoryPoint, StoryPoint];
  return [atFrac(rangeOf(a[0]), a[1]), atFrac(rangeOf(b[0]), b[1])];
};

/** Mechanism envelope: smoothstep RISE over one window × optional smoothstep
 *  FALL over another (omit `fall` for a one-way ramp). Windows name their
 *  scenes — see StoryWindow for the two edge forms. */
export const pulse = (
  p: number,
  w: { rise: StoryWindow; fall?: StoryWindow },
): number => {
  const [r0, r1] = windowEdges(w.rise);
  if (r0 >= r1)
    throw new Error(
      `lens story: pulse rise window ${JSON.stringify(w.rise)} resolves reversed or zero-width (p0 ${r0} >= p1 ${r1})`,
    );
  const rise = smoothstep(r0, r1, p);
  if (!w.fall) return rise;
  const [f0, f1] = windowEdges(w.fall);
  if (f0 >= f1)
    throw new Error(
      `lens story: pulse fall window ${JSON.stringify(w.fall)} resolves reversed or zero-width (p0 ${f0} >= p1 ${f1})`,
    );
  return rise * (1 - smoothstep(f0, f1, p));
};
