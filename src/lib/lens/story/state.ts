// storyStateAt(p) — the whole story at one scroll position, as plain JSON.
//
// IT ADDS NO LAWS. Every number comes from a function another module already
// exports and the drivers already call. NOTHING MAY BE RE-DERIVED HERE — not a
// window edge, and not a one-line composition either: a value a driver composes
// inline gets a name in the module that owns it, and both call that, so the two
// cannot drift. A field with no p-only law left to read is reported as `null`.
//
// LAZY — NEVER STATICALLY REACHABLE FROM THE HOMEPAGE. It imports story/fly.ts,
// story/trails.ts and story/constellations.ts, which statically import optics/
// (three/tsl node graphs) that must stay out of the homepage's initial chunk.
// So it is reached ONLY by `await import("./state")` from a DEV-gated block
// or by a test in node: NEVER added to index.ts, never imported statically by
// anything on the hero's path.
//
// WHAT IT REPORTS is the AUTHORED state at p — what the drivers would write on
// a frame handed exactly this p in a settled session, deliberately NOT what is
// on screen. The difference is the honest residual: EASE LAG (core/scene eases
// `state.story` toward `storyTarget`, though `peel` and `assemble` below
// WRAP_EASE_P0 are written value-and-target off the raw scroll, so for those
// this IS the drawn value — which is what the two chapters' illegal-pair laws
// rest on); PHASE CLOCKS (the internals rack/breath and the card orbit run on
// accumulated dt, so only their envelopes are knowable); LATCHES AND WARM-UP;
// the VIEWPORT and THEME (`framing` needs `opts.canvas`, the tint is for the
// `opts.light` you ask for); and THE FRAME ITSELF — occlusion, depth fade,
// glass. Nothing replaces looking.
//
// And what it cannot report at all, by the no-second-law rule: focus and
// aperture inside the internals span (a phase clock, so only their envelopes),
// the per-element glass passage fades (measured off the live GLB), and the room
// light and glass glint as LEVELS (one lerp off the reported `dark` ramp).

import * as THREE from "three/webgpu";
import {
  CAPTION_BANDS,
  DIVE_P0,
  RANGES,
  REVEAL_END,
  rangeOf,
  windowEdges,
} from "./story";
import { sampleStory, applyStoryFraming } from "./camera";
import {
  ASSEMBLE_PULSE,
  CARDS_APART,
  CHROME_FADE,
  EXPLODE_PULSE,
  INK_DROP,
  INK_FULL,
  INK_HALF,
  INK_RESTORE,
  INTERIOR_BACK,
  IRIS_HANDBACK,
  IRIS_HANDOVER,
  PRE_SHUT,
  ROSE_PULSE,
  SCROLL_CUE,
  SHELL_BACK,
  ZOOM_PULSE,
  assembleAt,
  bgAt,
  chromeAt,
  driverOwnsIris,
  explodeAt,
  fStopOf,
  focalMmAt,
  inkFillAt,
  interiorFadeAt,
  preShutAt,
  roseAt,
  sceneIndexAt,
  scrollCueAt,
  shellFadeAt,
  zoomAt,
  type Rgb,
} from "./envelopes";
import { ROLL_P1, TURN_P0, TURN_P1, revealRollAt, turnAt } from "./reveal";
import {
  RELEASE_SPAN,
  SPIN_SPAN,
  WINK_SPAN,
  peelRollAt,
  peelSpinAt,
  peelValueAt,
} from "./peelcards";
import { internalsEnvAt } from "./internals";
import {
  CAM_IN,
  EXIT_END,
  FOV_BACK,
  GLASS_OUT,
  HYST,
  INK_RETURN,
  flyApertureAt,
  flyBodyFadeAt,
  flyCentreAt,
  flyDarkAt,
  flyDiveP,
  flyDollyAt,
  flyFocusAt,
  flyFovBackAt,
  flyFovMixAt,
  flyFovOf,
  flyInkAt,
  flyPoseAt,
  flyRevealAt,
  flyReturnAt,
  flySeatAt,
  flySkyMixAt,
  flyStreakAt,
  flyWarpAt,
  skyOutAt,
} from "./fly";
import {
  crownEnvAt,
  crownLiveAt,
  crownResolveAt,
  trailEnvAt,
  trailSweepAt,
} from "./trails";
import {
  constellationEnvAt,
  labelEnvAt,
  quoteEnvAt,
} from "./constellations";
import { band, clamp01 } from "../core/math";

const flyR = rangeOf("flythrough");

/** A named window and where it sits in absolute story p — a smoothstep RAMP or
 *  a SPAN with one owner. Both answer: is p inside it, and how far.
 *
 *  ONLY windows whose EDGES their owning module exports are listed. A window
 *  authored as literals inside its own expression is deliberately absent, as is
 *  one on the DIVE's clock rather than the story's — its VALUE is still
 *  reported in `look`/`sky`, and spelling its edges here would copy numbers
 *  this module has no right to own. */
export interface StoryWindowSpan {
  name: string;
  p0: number;
  p1: number;
}

export const STORY_WINDOWS: StoryWindowSpan[] = (
  [
    ["zoom.rise", windowEdges(ZOOM_PULSE.rise)],
    ["zoom.fall", windowEdges(ZOOM_PULSE.fall)],
    ["explode.rise", windowEdges(EXPLODE_PULSE.rise)],
    ["explode.fall", windowEdges(EXPLODE_PULSE.fall)],
    ["assemble.rise", windowEdges(ASSEMBLE_PULSE.rise)],
    ["assemble.fall", windowEdges(ASSEMBLE_PULSE.fall)],
    ["rose.rise", windowEdges(ROSE_PULSE.rise)],
    ["iris.handover", [IRIS_HANDOVER, IRIS_HANDBACK]],
    ["preShut", PRE_SHUT],
    ["ink.half", INK_HALF],
    ["ink.full", INK_FULL],
    ["ink.drop", INK_DROP],
    ["ink.restore", INK_RESTORE],
    ["shell.back", SHELL_BACK],
    ["interior.back", INTERIOR_BACK],
    ["scrollCue", SCROLL_CUE],
    ["chrome", CHROME_FADE],
    ["wink", WINK_SPAN],
    ["peel.spin", SPIN_SPAN],
    ["peel.release", RELEASE_SPAN],
    ["cards.apart.rise", windowEdges(CARDS_APART.rise)],
    ["cards.apart.fall", windowEdges(CARDS_APART.fall)],
    ["turn", [TURN_P0, TURN_P1]],
    // the roll's true support: nonzero from the assemble RISE's foot (invisible
    // — the body cover is 0 there), not from TURN_P0 where the cruise begins.
    ["roll", [windowEdges(ASSEMBLE_PULSE.rise)[0], ROLL_P1]],
    ["fly.span", [DIVE_P0, EXIT_END]],
    ["fly.dive", [DIVE_P0, flyR.p1]],
    ["fly.glass", [DIVE_P0, GLASS_OUT]],
    ["fly.inkOut", [CAM_IN, DIVE_P0 - HYST]],
    ["fly.inkBack", INK_RETURN],
    ["fly.fovBack", FOV_BACK],
  ] as [string, [number, number]][]
).map(([name, [p0, p1]]) => ({ name, p0, p1 }));

export type IrisOwner = "driver" | "internals" | "fly";

export interface StoryState {
  /** the scroll position this state was sampled at */
  p: number;
  scene: {
    index: number;
    id: string;
    title: string;
    p0: number;
    p1: number;
    /** progress through the scene's own range, 0..1 */
    local: number;
    hold: number;
    transit: number;
    rail: boolean;
    linkNext: boolean;
    camHold: number | null;
  };
  camera: {
    /** orbit OFFSET from `target`, world units — the camera sits at target+pos */
    pos: [number, number, number];
    up: [number, number, number];
    target: [number, number, number];
    /** after the ortho flatten (story/camera.ts lerps toward ORTHO_FOV) */
    fov: number;
    /** horizontal / vertical park, in units of STORY_R */
    xs: number;
    ys: number;
    /** |pos| — the orbit radius the flatten's pullback has already been applied to */
    radius: number;
  };
  /** only with opts.canvas: the view offset story/camera.ts writes for the
   *  park. The portrait lift is folded INTO offsetY, since applyStoryFraming
   *  composes them into one setViewOffset call. */
  framing: { offsetX: number; offsetY: number } | null;
  model: {
    /** world X of the lens under the parked camera (story/fly.ts flyDollyAt) */
    dollyX: number;
    /** total roll about the optical axis, radians — the ONE value the driver
     *  hands SceneHandle.setModelOrientation, and its two disjoint terms */
    rollX: number;
    revealRoll: number;
    peelRoll: number;
  };
  /** every channel's AUTHORED target at p. `null` where the value is not a
   *  function of p alone (see `irisOwner`) — only the internals span, whose
   *  rack and breath run on a phase clock. */
  channels: {
    zoom: number;
    focus: number | null;
    aperture: number | null;
    explode: number;
    assemble: number;
    peel: number;
    /** the ending's origami bloom — rise-only over the final scene */
    rose: number;
    story: number;
    /** channels the STORY never drives — they rest at their registry default */
  };
  /** who writes focus and aperture at this p — the three writers tile p rather
   *  than ordering their rAFs (story/envelopes.ts driverOwnsIris) */
  irisOwner: IrisOwner;
  look: {
    /** materials/unified.ts uInkFill — the drawing's fill level */
    inkFill: number;
    /** materials/unified.ts uInk via SceneHandle.setInkMix: 1 = ink, 0 = realistic */
    inkMix: number;
    /** SceneHandle.setStoryCentre — the dive's claim on the middle of the frame */
    storyCentre: number;
    bodyFade: number;
    /** which module owns setBodyFade at this p (the range-tiled writer map) */
    bodyFadeOwner: "driver" | "fly";
    shellFade: number;
    interiorFade: number;
    /** the stage tint for opts.light (default: the dark palette) */
    bg: Rgb;
    /** the fly's fov override, or null where the span has released it — exit()
     *  writes `null`, so there is no value to report there */
    storyFov: { fov: number; mix: number } | null;
    /** what both sky fade uniforms get (story/fly.ts flySkyMixAt): the arrival
     *  ramp less the reveal's fade. 0 outside the span, by its own law. */
    skyMix: number;
    warp: number;
    streak: number;
    /** the sky's own way OUT (story/fly.ts skyOutAt), a factor on skyMix above */
    skyOut: number;
    /** the darkness ramp (story/fly.ts flyDarkAt) — the room light and glass
     *  glint LEVELS are one lerp off it, composed inline in fly.ts's frame() */
    dark: number;
    /** the reveal's crossfade — the exploded lens coming back on screen */
    reveal: number;
    /** the fov hand-back and the lens' two legs home */
    fovBack: number;
    flyReturn: number;
    flySeat: number;
  };
  sky: {
    /** radians the star field has turned (story/trails.ts) */
    trailSweep: number;
    /** the same turn, normalized — story/reveal.ts's ONE law */
    turn: number;
    trailEnv: number;
    crownEnv: number;
    crownResolve: number;
    crownLive: number;
    constellationEnv: number;
    labelEnv: number;
    quoteEnv: number;
  };
  /** the internals ambient's two AMPLITUDE envelopes (the phase is a clock) */
  ambient: { breath: number; rack: number };
  /** the peel's own normalized spin, 0 → 1 across SPIN_SPAN */
  peelSpin: number;
  caption: {
    /** the band whose scene owns p (story/story.ts CAPTION_BANDS) */
    id: string;
    a: number;
    b: number;
    /** --beat-visibility: the band's fade at p. --beat-progress is NOT here —
     *  its window is authored per BLOCK in the markup, so it is a property of
     *  the DOM, not of the story. */
    visibility: number;
  };
  hud: {
    scn: string;
    title: string;
    focalMm: number;
    /** from the AUTHORED aperture; the shipped HUD reads the eased live
     *  channel. `null` where the aperture itself is (the internals span). */
    fStop: string | null;
    explodePct: number;
    chrome: number;
    scrollCue: number;
  };
  /** every window from STORY_WINDOWS that CONTAINS p, with the fraction through
   *  it — the "which ramp is mid-flight here" question, answered directly */
  windows: { name: string; p0: number; p1: number; f: number }[];
}

export interface StoryStateOpts {
  /** light theme, for the stage tint only. Default false (the dark palette). */
  light?: boolean;
  /** a viewport, for the view-offset park: story/camera.ts's applyStoryFraming
   *  needs a real camera and canvas size, so `framing` is null without one. */
  canvas?: { w: number; h: number; parkScale: number };
}

/** The whole declarative state at `p`. Pure: same p, same output, no globals
 *  read and nothing in the live scene touched. Safe from node. */
export function storyStateAt(p: number, opts: StoryStateOpts = {}): StoryState {
  const light = opts.light ?? false;

  const index = sceneIndexAt(p);
  const r = RANGES[index];
  const sc = r.scene;

  // the camera, exactly as core/scene samples it each frame
  const pos = new THREE.Vector3();
  const up = new THREE.Vector3();
  const target = new THREE.Vector3();
  const sample = sampleStory(p, pos, up, target);

  let framing: StoryState["framing"] = null;
  if (opts.canvas) {
    const cam = new THREE.PerspectiveCamera(
      sample.fov,
      opts.canvas.w / opts.canvas.h,
    );
    applyStoryFraming(
      cam,
      sample,
      pos,
      up,
      target,
      opts.canvas.w,
      opts.canvas.h,
      opts.canvas.parkScale,
      p,
    );
    framing = cam.view
      ? { offsetX: cam.view.offsetX, offsetY: cam.view.offsetY }
      : null;
  }

  const explode = explodeAt(p);
  const zoom = zoomAt(p);
  // the roll's gate is the ASSEMBLE channel (story/reveal.ts ROLL_P1).
  // hero-driver's writer passes the LIVE eased channel; this is what that write
  // settles to at p — the header's ease-lag residual.
  const revealRoll = revealRollAt(p, assembleAt(p));
  // The PEEL's half is not eased — the writer takes it at the raw p — so this
  // is not a settled approximation of that write but exactly it.
  const peelRoll = peelRollAt(p);

  // THE IRIS' THREE WRITERS, tiled by range. The fly is checked FIRST because
  // its writes land last in the driver's frame(), so inside its span it wins
  // whatever driverOwnsIris said.
  const flyActive = p >= DIVE_P0 && p <= EXIT_END;
  const irisOwner: IrisOwner = flyActive
    ? "fly"
    : driverOwnsIris(p)
      ? "driver"
      : "internals";
  const pFly = flyDiveP(p);
  // Inside the internals span both channels ride a phase clock, so there is no
  // value at p — only the envelopes, reported in `ambient`. Everywhere else a
  // p-only law owns them: the driver's reset, or the fly's two ramps.
  const focus =
    irisOwner === "driver" ? 0 : irisOwner === "fly" ? flyFocusAt(pFly) : null;
  const aperture =
    irisOwner === "driver"
      ? preShutAt(p)
      : irisOwner === "fly"
        ? flyApertureAt(pFly)
        : null;

  const bandSpec = CAPTION_BANDS[index];
  const inkMix = flyInkAt(p);
  const pose = flyActive ? flyPoseAt(p) : null;

  return {
    p,
    scene: {
      index,
      id: sc.id,
      title: sc.title,
      p0: r.p0,
      p1: r.p1,
      local: clamp01((p - r.p0) / (r.p1 - r.p0)),
      hold: sc.hold,
      transit: sc.transit,
      rail: Boolean(sc.rail),
      linkNext: Boolean(sc.linkNext),
      camHold: sc.camHold ?? null,
    },
    camera: {
      pos: pos.toArray() as [number, number, number],
      up: up.toArray() as [number, number, number],
      target: target.toArray() as [number, number, number],
      fov: sample.fov,
      xs: sample.xs,
      ys: sample.ys,
      radius: pos.length(),
    },
    framing,
    model: {
      dollyX: flyDollyAt(p),
      rollX: revealRoll + peelRoll,
      revealRoll,
      peelRoll,
    },
    channels: {
      zoom,
      focus,
      aperture,
      explode,
      assemble: assembleAt(p),
      peel: peelValueAt(p),
      rose: roseAt(p),
      story: p,
    },
    irisOwner,
    look: {
      inkFill: inkFillAt(p),
      inkMix,
      storyCentre: flyCentreAt(p),
      bodyFade: p < DIVE_P0 ? 1 : flyBodyFadeAt(p),
      bodyFadeOwner: p < DIVE_P0 ? "driver" : "fly",
      shellFade: shellFadeAt(p),
      interiorFade: interiorFadeAt(p),
      bg: bgAt(p, light),
      storyFov: pose ? { fov: flyFovOf(pose), mix: flyFovMixAt(p) } : null,
      // The span uniforms are reported EVERYWHERE rather than zeroed outside
      // the span, because each function is itself exactly 0 there — which is
      // what exit() leaves on screen. A read of the owner's ramp, not a copy
      // of the teardown.
      skyMix: flySkyMixAt(p),
      skyOut: skyOutAt(p),
      warp: flyWarpAt(p),
      streak: flyStreakAt(p),
      dark: flyDarkAt(p),
      reveal: flyRevealAt(p),
      fovBack: flyFovBackAt(p),
      flyReturn: flyReturnAt(p),
      flySeat: flySeatAt(p),
    },
    sky: {
      trailSweep: trailSweepAt(p),
      turn: turnAt(p),
      trailEnv: trailEnvAt(p),
      crownEnv: crownEnvAt(p),
      crownResolve: crownResolveAt(p),
      crownLive: crownLiveAt(p),
      constellationEnv: constellationEnvAt(p),
      labelEnv: labelEnvAt(p),
      quoteEnv: quoteEnvAt(p),
    },
    ambient: internalsEnvAt(p),
    peelSpin: peelSpinAt(p),
    caption: {
      id: bandSpec.id,
      a: bandSpec.a,
      b: bandSpec.b,
      visibility: band(p, bandSpec.a, bandSpec.b),
    },
    hud: {
      scn: String(index).padStart(2, "0"),
      title: sc.title,
      focalMm: focalMmAt(zoom),
      fStop: aperture === null ? null : fStopOf(aperture),
      explodePct: Math.round(explode * 100),
      chrome: chromeAt(p),
      scrollCue: scrollCueAt(p),
    },
    windows: STORY_WINDOWS.filter((w) => p >= w.p0 && p <= w.p1).map((w) => ({
      ...w,
      f: clamp01((p - w.p0) / (w.p1 - w.p0)),
    })),
  };
}

/** Every p worth tabulating: each scene's, caption band's and window's edges,
 *  plus the two constants the hand-over is built on. Sorted, deduped and
 *  clamped to [0, 1] — the STORY-MAP's row set, and a sample grid for a law
 *  test that wants the interesting frames rather than a blind lattice. */
export const STORY_SAMPLE_PS: number[] = (() => {
  const out = new Set<number>([0, 1, DIVE_P0, REVEAL_END]);
  for (const r of RANGES) {
    out.add(r.p0);
    out.add(r.p1);
  }
  for (const b of CAPTION_BANDS) {
    out.add(b.a);
    out.add(b.b);
  }
  for (const w of STORY_WINDOWS) {
    out.add(w.p0);
    out.add(w.p1);
  }
  return [...out].filter((v) => v >= 0 && v <= 1).sort((a, b) => a - b);
})();
