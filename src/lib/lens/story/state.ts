// storyStateAt(p): the whole story at one story position, as plain JSON.
// It adds no laws — every number comes from a function another module exports;
// nothing is re-derived here, and a field with no p-only law is `null`.
// Story mode draws exactly this at the eased p: phase clocks, latches,
// warm-up, viewport, theme and the frame itself are the residual.
// LAZY: imports story/fly, trails and constellations (optics/ node graphs), so
// reached only by `await import("./state")` from a DEV block or a test.

import * as THREE from "three/webgpu";
import {
  CAPTION_BANDS,
  DIVE_P0,
  RANGES,
  REVEAL_END,
  rangeOf,
  storyWindows,
  type StoryWindowSpan,
} from "./story";
import { sampleStory, applyStoryFraming } from "./camera";
import {
  assembleAt,
  bgAt,
  huddleAt,
  chromeAt,
  driverOwnsIris,
  explodeAt,
  fStopOf,
  focalMmAt,
  inkFillAt,
  interiorFadeAt,
  orientationAt,
  preShutAt,
  roseAt,
  sceneIndexAt,
  scrollCueAt,
  peelRollAt,
  peelTurnFracAt,
  shellFadeAt,
  zoomAt,
  type Rgb,
} from "./envelopes";
import { revealRollAt, turnAt } from "./reveal";
import { internalsEnvAt } from "./internals";
import { frameZoom } from "../core/scene";
import {
  EXIT_END,
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
import { trailEnvAt, trailSweepAt } from "./trails";
import {
  constellationEnvAt,
  labelEnvAt,
  quoteEnvAt,
} from "./constellations";
import { band, clamp01 } from "../core/math";

const flyR = rangeOf("flythrough");

export type { StoryWindowSpan };

/** Every window the story modules registered (story/story.ts `span`), read
 *  once every one of them has loaded — this module imports them all. */
export const STORY_WINDOWS: StoryWindowSpan[] = storyWindows();

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
    /** the frame width the scene needs, in its own half-heights (Pose.wide):
     *  above the viewport's own `aspect/zoom` it pulls the camera back */
    wide: number;
    /** the portrait push-in (Pose.near): lerp(near, 1, parkScale) scales the
     *  orbit offset */
    near: number;
    /** the portrait lift (Pose.lift), in canvas heights */
    lift: number;
  };
  /** only with opts.canvas: the view offset story/camera.ts writes for the
   *  park. The portrait lift is folded into offsetY. */
  framing: { offsetX: number; offsetY: number } | null;
  model: {
    /** world X of the lens under the parked camera (story/fly.ts flyDollyAt) */
    dollyX: number;
    /** roll about the optical axis, radians: the peel's bore roll
     *  (story/peelcards.ts) plus the reveal's own, disjoint in p */
    rollX: number;
    peelRoll: number;
    revealRoll: number;
    /** the cards scene's turn about world +Y, radians (story/peelcards.ts),
     *  plus the ending's rock (story/envelopes.ts rockYAt) */
    turnY: number;
    /** the tip about Z, radians: the boot roll going to 0 as the lens stands up
     *  (story/envelopes.ts uprightAt), less the nose dip, plus the rock */
    tiltZ: number;
  };
  /** every channel's AUTHORED target at p. `null` where the value is not a
   *  function of p alone (see `irisOwner`). */
  channels: {
    zoom: number;
    focus: number | null;
    aperture: number | null;
    explode: number;
    assemble: number;
    /** the cards chapter's compact core (ops/mechanism.ts huddleMm) */
    huddle: number;
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
     *  ramp less the reveal's fade, 0 outside the span */
    skyMix: number;
    warp: number;
    streak: number;
    /** the sky's own way OUT (story/fly.ts skyOutAt), a factor on skyMix above */
    skyOut: number;
    /** the darkness ramp (story/fly.ts flyDarkAt) — the room light and glass
     *  glint levels are one lerp off it */
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
    constellationEnv: number;
    labelEnv: number;
    quoteEnv: number;
  };
  /** the internals ambient's two AMPLITUDE envelopes (the phase is a clock) */
  ambient: { breath: number; rack: number };
  /** the cards scene's normalized turn, 0 → 1 across TURN_SPAN */
  peelTurn: number;
  caption: {
    /** the band whose scene owns p (story/story.ts CAPTION_BANDS) */
    id: string;
    a: number;
    b: number;
    /** --beat-visibility: the band's fade at p. --beat-progress is not here —
     *  it is authored per block in the markup, a property of the DOM. */
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

/** The whole declarative state at `p`. Pure: no globals read and nothing in the
 *  live scene touched, so it is safe from node. */
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
    // the viewport's own zoom, or the narrow-viewport reach below would read a
    // frame no canvas ever has
    cam.zoom = frameZoom(opts.canvas.w, opts.canvas.h);
    // a COPY: applyStoryFraming scales the offset by that reach, and `camera`
    // below reports the pose the table authored
    applyStoryFraming(
      cam,
      sample,
      pos.clone(),
      up,
      target,
      opts.canvas.w,
      opts.canvas.h,
      opts.canvas.parkScale,
    );
    framing = cam.view
      ? { offsetX: cam.view.offsetX, offsetY: cam.view.offsetY }
      : null;
  }

  const explode = explodeAt(p);
  const zoom = zoomAt(p);
  // the one orientation formula, and its two roll terms reported apart
  const orient = orientationAt(p);
  const revealRoll = revealRollAt(p, explode);
  const peelRoll = peelRollAt(p);

  // the iris' three writers, tiled by range. The fly is checked FIRST: its
  // writes land last in the driver's frame(), so inside its span it wins.
  const flyActive = p >= DIVE_P0 && p <= EXIT_END;
  const irisOwner: IrisOwner = flyActive
    ? "fly"
    : driverOwnsIris(p)
      ? "driver"
      : "internals";
  const pFly = flyDiveP(p);
  // inside the internals span both channels ride a phase clock, so there is no
  // value at p — only the envelopes, reported in `ambient`
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
      wide: sample.wide,
      near: sample.near,
      lift: sample.lift,
    },
    framing,
    model: {
      dollyX: flyDollyAt(p),
      rollX: orient.x,
      peelRoll,
      revealRoll,
      turnY: orient.y,
      tiltZ: orient.z,
    },
    channels: {
      zoom,
      focus,
      aperture,
      explode,
      assemble: assembleAt(p),
      huddle: huddleAt(p),
      // the sticker peel is /lens's alone — the story never drives it
      peel: 0,
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
      // the span uniforms are reported everywhere rather than zeroed outside
      // the span, since each function is itself exactly 0 there
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
      constellationEnv: constellationEnvAt(p),
      labelEnv: labelEnvAt(p),
      quoteEnv: quoteEnvAt(p),
    },
    ambient: internalsEnvAt(p),
    peelTurn: peelTurnFracAt(p),
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
 *  clamped to [0, 1]. */
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
