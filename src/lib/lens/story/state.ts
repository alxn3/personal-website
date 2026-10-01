// storyStateAt(p): the whole story at one story position, as plain JSON, built
// only from other modules' exported functions. A field that isn't a function of
// p alone (phase clocks, latches) is `null`.
// Lazy: it imports fly/trails/constellations (and so optics/), so it is only
// reached by dynamic import from a dev block or a test.

import * as THREE from "three/webgpu";
import {
  CAPTION_BANDS,
  DIVE_P0,
  RANGES,
  REVEAL_END,
  storyWindows,
  type StoryWindowSpan,
  sceneIndexAt,
} from "./story";
import { sampleStory, applyStoryFraming } from "./camera";
import {
  assembleAt,
  bgAt,
  huddleAt,
  chromeAt,
  driverOwnsIris,
  dustAt,
  explodeAt,
  fStopOf,
  focalMmAt,
  inkFillAt,
  interiorFadeAt,
  orientationAt,
  preShutAt,
  roseAt,
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
  flyBodyFadeAt,
  flyCentreAt,
  flyDarkAt,
  flyDollyAt,
  flyFovBackAt,
  flyFovMixAt,
  flyFovOf,
  flyInkAt,
  flyPoseAt,
  flyRevealAt,
  flyReturnAt,
  flySeatAt,
  flySkyMixAt,
  flySpanApertureAt,
  flySpanFocusAt,
  flyStreakAt,
  flyWarpAt,
  skyOutAt,
} from "./fly";
import { trailEnvAt, trailSweepAt } from "./trails";
import { constellationEnvAt, labelEnvAt, quoteEnvAt } from "./constellations";
import { band, clamp01 } from "../core/math";

/** Every registered story window (complete, since this module imports every
 *  story module). */
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
    /** progress through the scene, 0..1 */
    local: number;
    hold: number;
    transit: number;
    rail: boolean;
    camHold: number | null;
  };
  camera: {
    /** orbit offset from `target`, world units (camera at target + pos) */
    pos: [number, number, number];
    up: [number, number, number];
    target: [number, number, number];
    /** after the ortho flatten */
    fov: number;
    /** horizontal / vertical park, units of STORY_R */
    xs: number;
    ys: number;
    /** |pos|, including the flatten's pull-back */
    radius: number;
    /** Pose.wide, Pose.near and Pose.lift, interpolated */
    wide: number;
    near: number;
    lift: number;
  };
  /** the park's view offset (lift included); needs opts.canvas */
  framing: { offsetX: number; offsetY: number } | null;
  model: {
    /** the lens' world X during the dive's dolly */
    dollyX: number;
    /** radians about the optical axis: peelRoll + revealRoll */
    rollX: number;
    peelRoll: number;
    revealRoll: number;
    /** radians about world +Y: the cards turn plus the wobble */
    turnY: number;
    /** radians about Z: the tip, less the nose dip, plus the wobble */
    tiltZ: number;
  };
  /** every channel's target at p; `null` where it runs on a clock */
  channels: {
    zoom: number;
    focus: number | null;
    aperture: number | null;
    explode: number;
    assemble: number;
    huddle: number;
    peel: number;
    rose: number;
    story: number;
  };
  /** who writes focus and aperture at this p */
  irisOwner: IrisOwner;
  look: {
    /** the ink drawing's fill level */
    inkFill: number;
    /** 1 = ink drawing, 0 = realistic */
    inkMix: number;
    /** how far the dive pulls the lens to the middle of the frame */
    storyCentre: number;
    bodyFade: number;
    bodyFadeOwner: "driver" | "fly";
    /** ambient dust on */
    dust: boolean;
    shellFade: number;
    interiorFade: number;
    /** stage tint for opts.light (default dark) */
    bg: Rgb;
    /** the dive's fov override; null outside the dive */
    storyFov: { fov: number; mix: number } | null;
    /** the sky's fade-in less the reveal's fade; 0 outside the dive */
    skyMix: number;
    warp: number;
    streak: number;
    /** the sky's fade-out, a factor on skyMix */
    skyOut: number;
    /** the darkness ramp (room light and glass glint follow it) */
    dark: number;
    /** the exploded lens fading back on screen */
    reveal: number;
    /** the fov hand-back and the lens' two legs home */
    fovBack: number;
    flyReturn: number;
    flySeat: number;
  };
  sky: {
    /** radians the star field has turned */
    trailSweep: number;
    /** the same turn, 0..1 */
    turn: number;
    trailEnv: number;
    constellationEnv: number;
    labelEnv: number;
    quoteEnv: number;
  };
  /** the internals scene's breath and rack amplitudes (the phase is a clock) */
  ambient: { breath: number; rack: number };
  /** the cards scene's turn, 0..1 */
  peelTurn: number;
  caption: {
    /** the band of the scene containing p */
    id: string;
    a: number;
    b: number;
    /** --beat-visibility at p */
    visibility: number;
  };
  hud: {
    scn: string;
    title: string;
    focalMm: number;
    /** from the target aperture (the live HUD reads the eased one); null
     *  where the aperture is */
    fStop: string | null;
    explodePct: number;
    chrome: number;
    scrollCue: number;
  };
  /** every window containing p, with the fraction through it */
  windows: { name: string; p0: number; p1: number; f: number }[];
}

export interface StoryStateOpts {
  /** light theme, for the stage tint only (default false) */
  light?: boolean;
  /** a viewport; without one `framing` is null */
  canvas?: { w: number; h: number; parkScale: number };
}

/** The whole story state at `p`. Pure, so it runs under node. */
export function storyStateAt(p: number, opts: StoryStateOpts = {}): StoryState {
  const light = opts.light ?? false;

  const index = sceneIndexAt(p);
  const r = RANGES[index];
  const sc = r.scene;

  // the camera, sampled as core/scene does each frame
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
    // the viewport's zoom, which the narrow-screen pull-back reads
    cam.zoom = frameZoom(opts.canvas.w, opts.canvas.h);
    // a copy: applyStoryFraming scales the offset, and `camera` below reports
    // the unscaled pose
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
  // the orientation, with its two roll terms also reported apart
  const orient = orientationAt(p);
  const revealRoll = revealRollAt(p, explode);
  const peelRoll = peelRollAt(p);

  // which of the three writers owns the iris; the dive writes last, so it wins
  // inside its span
  const flyActive = p >= DIVE_P0 && p <= EXIT_END;
  const irisOwner: IrisOwner = flyActive
    ? "fly"
    : driverOwnsIris(p)
      ? "driver"
      : "internals";
  // inside the internals span both run on a clock (see `ambient`)
  const focus =
    irisOwner === "driver" ? 0 : irisOwner === "fly" ? flySpanFocusAt(p) : null;
  const aperture =
    irisOwner === "driver"
      ? preShutAt(p)
      : irisOwner === "fly"
        ? flySpanApertureAt(p)
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
      // the sticker peel is only used on /lens
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
      dust: dustAt(p),
      shellFade: shellFadeAt(p),
      interiorFade: interiorFadeAt(p),
      bg: bgAt(p, light),
      storyFov: pose ? { fov: flyFovOf(pose), mix: flyFovMixAt(p) } : null,
      // each is exactly 0 outside the dive
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

/** Every p worth tabulating: all scene, caption band and window edges, plus
 *  DIVE_P0 and REVEAL_END. Sorted, deduped, within [0, 1]. */
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
