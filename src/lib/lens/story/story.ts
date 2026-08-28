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

/** Where the rewrap's camera move leaves, as a fraction of the scene. The
 *  camera must be dead still through the reveal crossfade (story/fly.ts
 *  flyRevealAt's far edge; the coupling is pinned in story-fly.test.ts) and
 *  then creep off zero rate, so no frame is the one the motion begins on. */
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
  ortho: number; // 1 = flatten to an orthographic elevation on the HOLD (or over
  // the scene's own `orthoIn`/`orthoOut` window); 0 = perspective
  xs: number; // horizontal lens-park: >0 shoves the lens left (caption sits right)
  ys?: number; // vertical look-shift along camera-up: a 2D reframe on a detail
  target?: [number, number, number]; // orbit centre / look-at, WORLD units,
  // default [0,0,0] (lens centre is the origin; optical axis = world X, front
  // at +X). Shifts the whole orbit sphere, so framing and transit arcs are
  // preserved. Unlike ys, this changes the 3D pivot.
  wide?: number; // THE FRAME WIDTH THIS SCENE NEEDS, in units of its own
  // on-axis half-height. A viewport's frame is `aspect/zoom` of those wide,
  // which is the aspect on a landscape screen but bottoms out at exactly 1 on
  // every portrait one (core/scene's zoom law), so a subject wider than the
  // lens is clipped left and right on a phone whatever its aspect. A scene
  // that fills the frame sideways says so here and the camera pulls back until
  // it fits; default 1 = never pulls back. Applied in applyStoryFraming, so it
  // scales the pose rather than being part of it.
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
  // THE FLATTEN'S OWN WINDOW, scene-local fractions, when the flat frame is not
  // the park: `orthoIn` eases the flatten on, `orthoOut` eases it off, and
  // either one present replaces story/camera.ts's default parked schedule for
  // this scene. An omitted side means the flatten arrives already open (no
  // `orthoIn`) or never closes inside the scene (no `orthoOut`), which is how
  // one flat frame spans a scene boundary. Both need `cam.ortho` > 0.
  orthoIn?: [number, number];
  orthoOut?: [number, number];
  camHold?: number; // fraction of THIS scene's range the camera move waits
  // before starting. On a linkNext HEAD it delays the fused chain; on a plain
  // transit it opens the scene's own move late, so the scene reads still →
  // move → still. Validated below: under `transit` on an unlinked scene.
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
    // The chapter's showpiece: the departure plays across most of the scene
    // (story/envelopes.ts CARDS_APART) and the wink walks out behind it
    // (story/peelcards.ts WINK_SPAN), so the scene needs the screenfuls to play
    // both in.
    hold: 1.5,
    // two thirds, so the camera is still swinging round while the sides come
    // off and then holds the rear-on pose the scene hands over on. linkNext is
    // not an option here — a linked head would pass THROUGH that pose and never
    // hold it.
    transit: 0.66,
    bg: [26, 23, 17],
    bgLight: [240, 236, 226],
    // ONE ARC, NO WAYPOINTS, AND IT SPENDS THE CHAPTER'S WHOLE AZIMUTH. The
    // camera swings from the zoom's side profile (90°) round to DEAD ASTERN
    // (180°, the dive's own azimuth) while the sides come off, and every scene
    // from this settle to the dive's park holds that azimuth — so the scene
    // ENDS WITH THE LENS' BACK (the mount) FACING THE READER, which is the pose
    // the cards scene's turn picks up from. The chapter's remaining MOVEMENT is
    // the lens' own: the bore roll under the departure
    // (story/peelcards.ts peelRollAt), then the turntable turn (peelTurnAt),
    // then the stand-up and the tilt into the bore.
    // |pos|·STORY_R = 26 wu, the story's furthest pull-back: the expansion
    // throws a piece 4.8 wu off its seat and from dead astern that throw is
    // radial ON SCREEN, so the flower it opens into is ~12 wu across — nearly
    // the frame's whole height even from here. Closer and the outer casts sweep
    // past the camera instead of reading as one.
    cam: {
      pos: [-2.2774, 0.6328, 0],
      fov: 32,
      up: [0, 1, 0],
      ortho: 0,
      xs: -0.28,
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
    // The turn's hold, |pos|·STORY_R = 16.2 wu — the push back IN off the
    // peel's pull-back, onto the bare mechanism the wink left, on the peel's own
    // rear azimuth so the turntable starts from the mount. The card shell
    // turns about world X at 5.2 wu (story/peelcards.ts SHELL_R) on a clock of
    // TIME alone, so a card passes within ~11 wu of the camera on every
    // revolution for as long as the field is lit — the pose has to hold that
    // swell for the whole scene. xs is POSITIVE (caption right, lens left).
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
    transit: 0.5,
    bg: [30, 35, 24],
    bgLight: [238, 242, 229],
    // Side elevation of the STANDING lens (story/envelopes.ts uprightAt), on
    // the BARE MECHANISM the peel's wink left behind — the azimuth is the
    // chapter's own 180°, already spent in the peel, so the only thing left
    // between here and the dive's park is a tilt. The camera looks slightly
    // DOWN at it, which is the pitch the fly-through's approach gives back.
    // `target` pivots the orbit at the focus rig (world x ≈ −1.5…−0.9) so the
    // zoom lands on the mechanism. Perspective, not the ortho flatten. Don't
    // pull |pos| much below ~1.0 — closer, the depth fade shows the chassis
    // through itself.
    cam: {
      pos: [-1.0024, 0.34, 0],
      fov: 26,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0.1,
      ys: 0.03,
      // the tip carries the focus rig round with the lens: the rear third was
      // world x ≈ −1, and the tip about Z lands it at y ≈ −1.
      target: [0, -1.0, 0],
    },
  },
  {
    id: "flythrough",
    title: "FLY-THROUGH",
    rail: true,
    // 2.3 = the 0.5 approach below + the 1.8 the DIVE itself scrubs over.
    hold: 2.3,
    // THE APPROACH IS THIS SCENE'S TRANSIT, and the dive starts when it ends
    // (DIVE_P0 below reads it) — hence the 0.5 screenfuls over this hold. It is
    // ONE TILT UP INTO THE BORE and nothing else: no azimuth left to run,
    // the camera settling from its down-look to the lens' own level while the
    // orbit target rises off the focus rig, and the LENS tipping its nose down
    // out of the internals scene to meet it (story/envelopes.ts UPRIGHT's
    // fall). Then the camera PARKS: from here to the sky's end the LENS travels
    // (SceneHandle.setLensDolly), not the camera.
    transit: 0.5 / 2.3,
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
    // THE PULL-BACK RUNS ALMOST THE WHOLE SCENE and then parks. The camera
    // waits out the reveal's crossfade (CAM_RELEASE_F) and creeps off zero
    // rate, and it is still again well before the ending's own move opens.
    transit: 0.95,
    camHold: CAM_RELEASE_F,
    // THE ENDING GOES FLAT, and stays flat across the boundary into the descent
    // (the capsOn row's `orthoOut` is the other half): the face-on cloud reads
    // as the concentric 2D figure the star trails handed over, and the depth
    // comes back before the descent's turn. It may not open before rewrap 0.52
    // — the flatten IS a fov change, and the dive's fov hand-back
    // (story/fly.ts FOV_BACK) is only wholly released there; a fov moved under
    // the sky or under that mix scales what the other owner is drawing.
    orthoIn: [0.52, 0.8],
    bg: [22, 20, 14],
    bgLight: [238, 234, 222],
    // STILL ON THE DIVE'S AXIS — the sky's parked direction to the last digit,
    // pulled back and nothing else: no azimuth, no up-vector turn, no
    // waypoints. The reader stays face-on down the bore while the shell wraps
    // home, so the cloud reads as the concentric rings it is, and the ONE
    // gesture that takes the camera round to the side is the next scene's.
    // The reach frames the cloud at its WIDEST — nothing wraps here any more,
    // so the whole unwrapped spread is what the pose has to hold.
    //
    // THE TARGET SITS UP THE BORE, and its distance is the FLATTEN'S MATCHING
    // PLANE, not a taste: the flatten holds `dist · tan(fov/2)` constant
    // (story/camera.ts `back`), so content at the target plane keeps its screen
    // size exactly and everything else moves by its own depth ratio. Placed
    // where the cloud's outermost pieces are, the whole figure's screen RADIUS
    // is the same before and after the blend, which is what keeps a projection
    // change from reading as a zoom. The next scene's move then slides it back
    // to the lens — which is how the ending's frame comes DOWN with the pieces.
    // It is invisible on THIS leg: dead ahead, an on-axis target shift is only
    // distance.
    // …AND ON A PHONE THE FRAME IS ONLY AS WIDE AS IT IS DEEP. The held spread
    // is as wide as it is tall, so the portrait frame — not the pose — is what
    // binds: `wide` pulls the camera back until the cloud fits, eased in with
    // the pull-back itself and handed back over the descent's turn (the capsOn
    // row leaves it at the default 1). Landscape is untouched.
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
    // The id stays `capsOn` though the beat is the BLOOM and no cap is shown:
    // the id is a contract (REQUIRED_IDS below, the caption slot in
    // components/LensStory.astro, /lens's preview span) and renaming it takes
    // /lens down. Only the display label differs.
    title: "BLOOM",
    // Long enough to hold five beats in order: the first pieces leaving on a
    // still face-on frame, the quarter-turn to the side view, the fall, the
    // rock (story/envelopes.ts ROCK) with the last pieces landing, and the
    // bloom (ROSE_PULSE) with a held frame of the open flower.
    hold: 2.2,
    // FLAT AND STILL → TURN → STILL. The camera holds the rewrap's face-on park
    // while the middle pieces start down (story/envelopes.ts CONSTRUCT opens at
    // this scene's foot) and the flatten drains out of it, then makes ONE
    // quarter-orbit onto the lens' side, landing on the frame the rock starts
    // on. It is the only camera move in the ending, and the lens' own turn from
    // disc to standing column is that move's doing — the up-vector rolls
    // +Y → +X as the azimuth swings. The hold outlasts the flatten's blend by
    // ONE BREATH (0.01 of the scene): the projection is wholly back before the
    // turn opens, and nothing is held still after it is.
    camHold: 0.11,
    transit: 0.44,
    // the other half of the rewrap's `orthoIn`: the flat frame arrives already
    // open and the depth comes back over the descent's first pieces
    orthoOut: [0.02, 0.1],
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    // THE FRAME THE BLOOM PLAYS IN, and the page's hand-off frame: far enough
    // out to hold the whole column and centred on the stack the pieces build.
    // NO WAYPOINTS — one 90° leg at a near-constant radius off the rewrap's
    // park, which is the whole ending's camera. It swings to the lens' −Z side,
    // so the descent turns the opposite way round the standing column and the
    // reader follows the pieces down from there; distance, fov, up and target
    // are the frame the bloom has always played in.
    // upright, centred, a notch closer so the rain fills the frame — the page
    // hand-off frame. The distance is portrait's: any nearer and the mid-fall
    // spread clips a phone's one-half-height-wide frame.
    cam: { pos: [0, 0, -2.0], fov: 30, up: [1, 0, 0], ortho: 1, xs: 0 },
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
    if (sc.camHold !== undefined) {
      if (!Number.isFinite(sc.camHold) || sc.camHold < 0 || sc.camHold >= 1)
        throw new Error(
          `lens story: scene "${sc.id}" camHold must be within [0,1) (got ${sc.camHold})`,
        );
      // On a plain transit the hold eats the move's own window, so a hold at or
      // past `transit` would leave no move at all.
      if (!sc.linkNext && sc.camHold >= sc.transit)
        throw new Error(
          `lens story: scene "${sc.id}" camHold (${sc.camHold}) must be below its transit (${sc.transit}) — the hold opens the move late, it does not replace it`,
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

/** The same envelope with its windows resolved ONCE, as a scalar function of p.
 *  The render loop reads these channels every frame, and `pulse` re-resolves
 *  both windows per call — an array and a `RANGES` scan per edge. */
export const pulseFn = (w: {
  rise: StoryWindow;
  fall?: StoryWindow;
}): ((p: number) => number) => {
  const [r0, r1] = pulseEdges(w.rise, "rise");
  if (!w.fall) return (p: number) => smoothstep(r0, r1, p);
  const [f0, f1] = pulseEdges(w.fall, "fall");
  return (p: number) => smoothstep(r0, r1, p) * (1 - smoothstep(f0, f1, p));
};
