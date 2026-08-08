// Demo compositions for the /lens test bench (2026-07 hero exploration). A demo
// is a FULL composition — camera choreography + model animation + page wipe +
// palette — under one progress scrub: the end-to-end examples the owner asked
// for, not isolated animation clips. The page injects setPageWipe (the wipe is
// page-owned DOM); everything else drives the scene through the SAME SceneState
// channels the animations use.
//
// LIFECYCLE CONTRACT: demos drive the scene through the scene-kit verbs
// (setShading, drive, setCameraPose, …), which RECORD every write; on deselect
// the kit auto-restores them in reverse, so selecting None returns the normal
// seated /lens view without a hand-written exit(). exit() is optional — kept
// only for truly custom teardown the kit does not record (disposing an object
// the demo created, clearing part offsets).
import { Color } from "three/webgpu";
import { lerp, smoothstep } from "../core/math";
import { createTimeline, stagger, springs } from "./motion";
import type { Timeline } from "./motion";
import { createPrismLight, type PrismLight } from "./prism-light";
import { createRayField, type RayField, type RayPoint } from "./ray-ribbons";
import type {
  CameraPose,
  SceneHandle,
  SceneState,
  ShadingMode,
  TransitionName,
} from "../core/scene";
import type { PageWipeCfg } from "./page-wipe";
import type { PageTextCfg } from "./page-text";
// The LIVE mask knobs the deform host folds. `recipeKnob` hands back the SAME
// box every call (ops/host builds them once), which is what the kit's set()
// needs: it keys its first-write undo snapshot on the object IDENTITY it is
// handed. They are plain mutable { value } boxes — exactly what set()'s
// clone/copy snapshot expects — so the kit's auto-restore keeps working and none
// of the four demos needs a hand-written exit().
import { recipeKnob } from "../ops/host";
// The warp's live knobs (optics/warp.ts). Module-level uniform boxes, like the
// recipe knobs above, so the kit's set() records and auto-restores them.
import { uSkyMix, uWormhole, uStreak } from "../optics/warp";
// The DRAWN sky's ramps (optics/starfield.ts) — uStarMix/uStarStreak are the
// sprite path's uSkyMix/uStreak, same shape, same recording, same auto-restore.
// Importing them costs the module's uniform boxes and its pure packing code;
// the equirect BAKE lives behind optics/warp.ts and only runs if `?tracesky`
// asks for it.
import { uStarMix, uStarRing, uStarStreak } from "../optics/starfield";
import { PRESCRIPTION } from "../optics/prescription";
import type { GlassSpanMm } from "../core/scene";
import {
  posePath,
  drive,
  spans,
  state,
  scene,
  set,
  setCameraPose,
  setIsolate,
  setModelOrientation,
  setOverlayPass,
  setShading,
  setPageText,
  setPageWipe,
  setTransparentBackground,
  type KitApi,
} from "./scene-kit";
// createDemoKit/withKit are re-exported for lens.astro (the kit wraps the base
// DemoApi into the recording KitApi; withKit brackets each demo callback so
// the free-function verbs above target that recorder — see scene-kit.ts).
export { createDemoKit, withKit } from "./scene-kit";
export type { KitApi } from "./scene-kit";

// The recipe mask knobs the demos below solo with (see the import note).
const kRolloutRankLo = recipeKnob("rollout", "rankLo");
const kRolloutRankHi = recipeKnob("rollout", "rankHi");
const kRolloutMaskCenter = recipeKnob("rollout", "maskCenter");
const kRolloutMaskWidth = recipeKnob("rollout", "maskWidth");
const kAssembleMaskCenter = recipeKnob("assemble", "maskCenter");
const kAssembleMaskWidth = recipeKnob("assemble", "maskWidth");

/** The base (un-recorded) api lens.astro builds; createDemoKit wraps it. */
export interface DemoApi {
  /** The live scene state the animations also mutate. */
  state: SceneState;
  scene: SceneHandle;
  /** The page-owned hard wipe backdrop (injected by lens.astro). */
  setPageWipe(cfg: PageWipeCfg | null): void;
  /** The page-owned display/caption text layers (injected by lens.astro). The
   *  page clears these on demo-switch/None, so demos need not undo them in exit(). */
  setPageText(cfg: PageTextCfg | null): void;
}

export interface LensDemo {
  id: string;
  label: string;
  hint?: string;
  /** autoplay length in ms (default 8000). */
  durationMs?: number;
  /** Demos declare NO parameter and use the scene-kit verbs (setShading,
   *  drive, …) — every callback runs inside withKit(), so the verbs hit the
   *  selection's recorder. */
  enter(): void;
  /** drive the whole composition from progress p (0..1). */
  apply(p: number): void;
  /** OPTIONAL: the kit auto-restores every recorded write on deselect. Keep
   *  exit() only for truly custom teardown (disposing an object the demo made,
   *  clearing part offsets — neither is recorded); it runs BEFORE auto-restore. */
  exit?(): void;
}

// The seated three-quarter pose (matches the /lens boot camera). `distance` is
// in world units; BASE_DIST ≈ the seated camera's distance from the origin.
// Model geometry (for the pose constants below): the lens axis lies along
// world x with the FRONT element at +x, so azimuth π/2 looks into the glass
// and −π/2 looks at the mount face.
const BASE_DIST = 7.7;
const SEATED = { azimuth: 0.61, elevation: 0.26 };

// Rise: reveal-from-detail. Open tight on the half-exploded mount/bayonet
// (rear crop — assemble opens at RISE_A0, not full scatter, so the ring still
// READS as a mount), crane out + up as the cream line rises, land higher and
// longer-lensed than the seated pose — deliberately NOT the boot framing.
const RISE_START = { azimuth: -1.35, elevation: 0.1, distScale: 0.45, fov: 30 };
const RISE_END = { azimuth: 0.85, elevation: 0.42, distScale: 1.95, fov: 24 };
const RISE_A0 = 0.18;
// smoothstep(0,1,·) as a pose-path segment ease (the demos' standard in/out).
const ss01 = (t: number) => smoothstep(0, 1, t);
// the whole crane eased 0→1 by smoothstep (was four hand-lerps in apply).
/* prettier-ignore */
const risePose = posePath([
  { p: 0, pose: { az: RISE_START.azimuth, el: RISE_START.elevation, fov: RISE_START.fov, dist: BASE_DIST * RISE_START.distScale } },
  { p: 1, pose: { az: RISE_END.azimuth, el: RISE_END.elevation, fov: RISE_END.fov, dist: BASE_DIST * RISE_END.distScale }, ease: ss01 },
]);

// Filmstrip camera path: open ON the front-ring engravings (the very text the
// strips display), then track sideways + pull back so the writing reads as
// leaving the barrel and laying itself flat (tuned visually).
const FILM_START = {
  azimuth: 1.52,
  elevation: -0.05,
  distScale: 0.5,
  fov: 28,
  targetY: 0.85,
};
const FILM_END = { azimuth: 1.05, elevation: 0.3, distScale: 1.4, fov: 45 };
// Sector solo: meridian the soloed 90° sector is centred on, the pulled-back
// framings, and the top-down open — the lens stands front-element-up
// (orientation z 0) so the glass reads as a full circle from overhead, then
// tumbles back seated while the camera swings down to the low side.
const SECTOR_CENTER = Math.PI;
const SECTOR_DIST = 1.4;
const SECTOR_TOP = { elevation: 1.25, distScale: 1.1 };
const SECTOR_END_EL = 0.07;
const SECTOR_ORBIT = 0.9;
// Ignition dolly-zoom endpoints: worm's-eye open (camera under the scattered
// parts, wide and close) rising + leveling into the seated landing; distance
// grows as fov narrows so the vertigo stretch survives the climb.
const IGNITE_START = {
  elevation: -0.5,
  distScale: 0.55,
  fov: 58,
  targetY: 0.6,
};
const IGNITE_DIST_HI = 0.95;
const IGNITE_FOV_HI = 44;

// warm cream (light --bg) below the line, near-black warm brown (dark --bg) above
const CREAM = "#f6f2e9";
const NEAR_BLACK = "#201c15";

const TAU = Math.PI * 2;
// Filmstrip: near-white below the roll line, warm near-black above.
const FILM_LIGHT = "#f6f2e9";
const FILM_DARK = "#1c120b";
// Ember palette page-wipe pair: deep brown-black stage, bold orange field.
const EMBER_BELOW = "#160d07";
const EMBER_ORANGE = "#ff5c1f";

// Lookbook: four looks under one scrub, cut at the quarter boundaries. Each
// boundary carries its cut through a DIFFERENT swap choreography ("punch" is
// out — a demo camera pose rewrites fov every frame, which would erase it).
// Per segment: the shading mode, the flat page ground behind the transparent
// canvas (hard-cut in sync with the material swap beat), and the caption ink
// that reads on that ground.
const LOOKS: ShadingMode[] = ["ink", "riso", "bronze", "ember"];
const LOOK_LABELS = ["Ink", "Riso", "Bronze", "Ember"];
const LOOK_CUTS: TransitionName[] = ["blink", "molt", "twist"];
const LOOK_BG = ["#201c15", "#f2e8cf", "#160d09", EMBER_ORANGE];
const LOOK_FG = ["#f2e8cf", "#201c15", "#f2e8cf", EMBER_BELOW];
// dist·tan(fov/2) framing constant: holds the lens size while the fov drifts
const LOOK_FRAME = 2.9;
const LOOK_FOV = { lo: 33, hi: 24 };
// Lookbook: the segment/ground/retarget bookkeeping (was five module lets)
// now lives inside one spans() controller — this handle is all that's left.
let lookSpans: ReturnType<KitApi["spans"]> | null = null;

// Poster: long-lens flattened hero composition. Low fov + proportionally far
// camera renders the lens near-orthographic — a graphic object on the type.
const POSTER_FOV = 14;
const POSTER_FRAME = 3.35;
const POSTER_SWAP_P = 0.55; // riso → bronze blink boundary
// the single riso→bronze boundary (blink both ways) is now a spans() controller.
let posterSpans: ReturnType<KitApi["spans"]> | null = null;

// Lookbook camera: slow continuous FORWARD orbit — open dead on the mount face
// (azimuth −π/2, the one face no other scene shows), end on the front-element
// three-quarter — with a gentle long-lens fov drift; distance rides the framing
// constant (frame field) so the lens holds its size across the looks.
const lookPath = posePath([
  {
    p: 0,
    pose: { az: -Math.PI / 2, el: 0.1, fov: LOOK_FOV.lo, frame: LOOK_FRAME },
  },
  { p: 1, pose: { az: 1.05, el: 0.28, fov: LOOK_FOV.hi, frame: LOOK_FRAME } },
]);

// The lookbook's page side of one segment — flat ground + caption. spans() calls
// this at the swap BEAT (so bg and look cut together), not at the scrub crossing.
function lookStage(seg: number): void {
  const bg = LOOK_BG[seg];
  setPageWipe({ p: 1, skewDeg: 0, below: bg, above: bg });
  setPageText({
    // specimen label, mid-left — clear of the model in every segment (the
    // bottom-centre default collides with the lens rim at the later poses)
    front: {
      text: LOOK_LABELS[seg],
      sub: `0${seg + 1} / 04`,
      color: LOOK_FG[seg],
      x: 0.07,
      y: 0.5,
      align: "left",
      size: 0.75,
    },
  });
}

// Prism: three scroll beats mirroring the planned hero. (1) The ray diagram —
// lens stood on end (front element down), a solid white band into the mount,
// a flat connected rainbow ribbon out the front; the rays exist only here.
// (2) The camera dives to the mount and travels DOWN THROUGH the isolated
// glass stack (the model stays put — the stack spreads apart on the assemble
// channel and the camera does the moving) while the thin through-ribbon
// recolors rainbow → site palette. (3) The camera pulls back out and the
// shell wraps home around the glass, easing into the seated three-quarter.
const PRISM_EL = 0.04;
const PRISM_DIST = 1.7;
/** beat-2 close-up dolly distance (skims the glass, no near-plane clipping) */
const PRISM_NEAR_DIST = 2.6;
/** targetY sweep of the through-passage: mount top → past the dropped front */
const PRISM_DIVE_Y = 1.5;
const PRISM_EXIT_Y = -3.4;
// classic six-hue dispersion fan, solid print colors
const PRISM_RAINBOW = [
  "#ff4b3e",
  "#ff9d23",
  "#ffe14d",
  "#5fd98a",
  "#3fa7ff",
  "#8f5bff",
].map((c) => new Color(c));
// the site palette (global.css tokens) across the same six beams: terracotta
// --highlight #d18a5d/#d99a63, cream --bg/--text #f6f2e9/#f1ecde, sage
// --accent #5f6f52/#a3a677 — bright variants interleaved so no beam goes dark
const PRISM_PALETTE = [
  "#d18a5d",
  "#f1ecde",
  "#a3a677",
  "#d99a63",
  "#f6f2e9",
  "#5f6f52",
].map((c) => new Color(c));
const prismColors = PRISM_RAINBOW.map(() => new Color());
// Beat boundaries. Isolate window = the through-the-glass passage: the fan is
// gone by ISO_ON (the dive hides the barrel-cut snap off-frame), the stack
// spreads apart (assemble rise) as the camera descends it, and the wrap flies
// home after ISO_OFF while the camera pulls back out to the seated pose.
const PRISM_ISO_ON = 0.35;
const PRISM_ISO_OFF = 0.8;
// Beat-1 ortho: the house ORTHO_FOV (story/camera.ts) with the matched
// pullback that holds the beat's previous 45° framing — dist = FRAME/tan(fov/2)
// ≈ 207 units (core/scene's far=400 is sized for exactly this convention). The
// lens reads as part of the 2D diagram: no foreshortening, parallel barrel
// sides. Perspective ramps back across the dive (the diagram becomes 3D as the
// viewer enters the glass).
const PRISM_ORTHO_FOV = 3;
/** the boot fov every later beat always ran at (setCameraPose default) */
const PRISM_DIVE_FOV = 45;
const PRISM_FRAME =
  BASE_DIST * PRISM_DIST * Math.tan((PRISM_DIVE_FOV * Math.PI) / 360);
let prism: PrismLight | null = null;
// beat-keyed look (flat 2D diagram → ink once the dive is inside the glass) is
// now sequenced by spans(); this handle is the controller.
let prismShade: ReturnType<KitApi["spans"]> | null = null;
// Camera: ortho 2D-diagram framing → dive through the mount into the glass
// (perspective returns as dist collapses off the frame field onto the near
// dolly) → pull back out and seat. Every field but targetY is keyframed here;
// targetY keeps its overlapping descend/recenter in apply() (one ease per
// segment can't fold that overlap). Replaces the six hand-stacked pose lerps.
// carry-forward keys: az holds throughout; each key lists only the changing
// field, and a bare { p } holds the pose flat across that segment. dive =
// ortho→perspective with the frame-locked dist collapsing onto the near dolly.
/* prettier-ignore */
const prismPose = posePath([
  { p: 0.0, pose: { az: SEATED.azimuth, el: PRISM_EL, fov: PRISM_ORTHO_FOV, frame: PRISM_FRAME } },
  { p: 0.3 },                                                                    // hold the ortho diagram framing
  { p: 0.38, pose: { fov: PRISM_DIVE_FOV, dist: PRISM_NEAR_DIST }, ease: ss01 }, // dive into the glass
  { p: 0.64 },                                                                   // hold near while descending the stack
  { p: 0.74, pose: { dist: BASE_DIST * 1.45 }, ease: ss01 },                     // pull back out, overshooting the seat
  { p: 0.84 },                                                                   // hold wide for the ISO_OFF wrap reveal
  { p: 0.98, pose: { el: SEATED.elevation, dist: BASE_DIST }, ease: ss01 },      // seat home
  { p: 1.0 },
]);

// Ribbon field: the snaking-rays primitive (ray-ribbons.ts) demonstrated
// end-to-end — six site-palette ribbons emanate from the seated lens (ink on
// the dark stage), snake around it on independent curving paths, then settle
// into one butted parallel rainbow band exiting frame right. Camera static:
// the rays are the show. Paths are keyframe SETS of free control points
// (point 0 is always the world-anchored front element) lerped A → B (the
// independent snaking) → CONV (the shared exit band, laddered offsets).
type XY = readonly [number, number];
const RIB_FOV = 26;
const RIB_FRAME = 4.9;
const RIB_ANCHOR: RayPoint = { world: [1.55, 0, 0] };
// Path numbers are tuned against the framed silhouette: the seated lens spans
// NDC x −0.28..0.28, y −0.35..0.33, and the front-element anchor projects to
// ≈ (0.15, −0.05). Free control points per ray, keyframe A (grow-out shapes):
const RIB_A: XY[][] = [
  // terracotta: S-curve up over the top, sweeping out the left edge
  [
    [0.3, 0.12],
    [0.05, 0.42],
    [-0.45, 0.45],
    [-0.75, 0.2],
    [-1.1, -0.05],
  ],
  // cream: full loop above the lens — the tail crosses its own ascent
  [
    [0.55, 0.2],
    [0.3, 0.62],
    [-0.15, 0.62],
    [-0.1, 0.32],
    [0.5, 0.02],
  ],
  // terracotta-light + cream: braiding pair, weaving under the lens leftward
  [
    [0.1, -0.32],
    [-0.15, -0.6],
    [-0.45, -0.38],
    [-0.75, -0.62],
    [-1.1, -0.42],
  ],
  [
    [0.1, -0.6],
    [-0.15, -0.36],
    [-0.45, -0.66],
    [-0.75, -0.4],
    [-1.1, -0.6],
  ],
  // sage-light: wrap-behind HEAD — rises off the glass, arcs over the barrel,
  // and plunges to a hard stop AT the top silhouette edge (its tail, ray 6,
  // re-emerges from the bottom-left silhouette: the around-the-back gag)
  [
    [0.3, 0.12],
    [0.26, 0.32],
    [0.12, 0.42],
    [-0.02, 0.4],
    [-0.08, 0.31],
  ],
  // sage: hugs the underside, then climbs the left edge past the mount
  [
    [0.15, -0.42],
    [-0.2, -0.62],
    [-0.6, -0.55],
    [-0.8, -0.15],
    [-0.88, 0.4],
  ],
];
// keyframe B — where each ray snakes TO mid-scrub. The braid pair trades
// waypoints (each lerps toward the other's A shape), which slides their
// crossings along the pair: the braiding motion.
const RIB_B: XY[][] = [
  [
    [0.35, 0.18],
    [0.0, 0.52],
    [-0.5, 0.32],
    [-0.72, -0.05],
    [-1.1, -0.3],
  ],
  [
    [0.6, 0.28],
    [0.15, 0.7],
    [-0.25, 0.5],
    [-0.05, 0.28],
    [0.52, 0.1],
  ],
  [
    [0.1, -0.6],
    [-0.15, -0.36],
    [-0.45, -0.66],
    [-0.75, -0.4],
    [-1.1, -0.42],
  ],
  [
    [0.1, -0.32],
    [-0.15, -0.6],
    [-0.45, -0.38],
    [-0.75, -0.62],
    [-1.1, -0.6],
  ],
  [
    [0.32, 0.14],
    [0.27, 0.34],
    [0.1, 0.44],
    [-0.04, 0.42],
    [-0.08, 0.31],
  ],
  [
    [0.2, -0.48],
    [-0.1, -0.68],
    [-0.62, -0.62],
    [-0.82, -0.25],
    [-0.9, 0.3],
  ],
];
// shared convergence path: gentle arc exiting frame right — every ray lerps
// onto THIS path with a laddered offset, becoming one butted rainbow band
const RIB_CONV: XY[] = [
  [0.5, -0.08],
  [0.68, -0.11],
  [0.85, -0.14],
  [1.0, -0.16],
  [1.2, -0.18],
];
// wrap tail (ray 6): re-emerges at the bottom-left silhouette, exits left
const TAIL_A: XY[] = [
  [-0.15, -0.36],
  [-0.3, -0.48],
  [-0.5, -0.54],
  [-0.7, -0.5],
  [-0.9, -0.4],
  [-1.12, -0.33],
];
const TAIL_B: XY[] = [
  [-0.15, -0.36],
  [-0.32, -0.5],
  [-0.52, -0.56],
  [-0.72, -0.53],
  [-0.92, -0.44],
  [-1.12, -0.39],
];
const RIB_W = [0.06, 0.05, 0.045, 0.045, 0.05, 0.055];
const RIB_CONV_W = 0.075;
/** per-ray grow-out stagger start (trim runs 0→1 over 0.3 of the scrub) */
const RIB_START = [0.02, 0.05, 0.07, 0.09, 0.04, 0.12];
const RIB_PHASE = [0, 0.3, 0.55, 0.8, 0.15, 0.45];
// site palette on the dark stage — assigned per ROLE, not token order: the
// two creams go to paths that stay off the cream barrel (loop + lower braid),
// the wrap ray gets terracotta-light so it reads across barrel AND ground
const RIB_COLORS = [
  "#d18a5d",
  "#f1ecde",
  "#d99a63",
  "#f6f2e9",
  "#a3a677",
  "#5f6f52",
].map((c) => new Color(c));
let ribbons: RayField | null = null;

// Piece by piece: the per-part showcase — SceneHandle.setPartOffset driven by
// ONE anime.js timeline (explore/motion.ts; autoplay OFF, scrubbed via
// seek()). Every tween is an explicit [from, to] pair so seeking is
// deterministic in both directions. The offsets are ADDITIVE on the rig, so
// the same parts still answer the zoom/focus/aperture channels underneath.
const CLOCK = {
  ringZoom: { ry: 0 },
  ringFocus: { ry: 0 },
  camBarrel: { ry: 0 },
  screws: { py: 0 },
  flange: { py: 0 },
  brass: { py: 0 },
  contacts: { py: 0 },
  e01: { py: 0 },
  e02: { py: 0 },
  barrel: { py: 0 },
  pcb: { py: 0, rz: 0 },
  iris: { a: 0 },
};
let clockTl: Timeline | null = null;

// The mechanical-ballet beat map (ms), grouped by which SIDE the camera shows:
// FRONT — rings counter-rotate, the front glass fans, an iris wink, glass
// reels home; the camera then swings to the MOUNT side — the tail hardware
// pops with a stagger, the PCB tips out, everything reels home springy,
// reverse-staggered — and the rings unwind as the finale. Springs derive
// their own settling durations (see motion.ts), so the timeline's total
// length is read, not set.
function buildClockTimeline(): Timeline {
  for (const o of Object.values(CLOCK))
    for (const k of Object.keys(o)) (o as Record<string, number>)[k] = 0;
  const tl = createTimeline({ autoplay: false });
  // beat 1 — the rings wake: zoom/focus counter-rotate (the engraved scale
  // numbers carry the read), the cam barrel drags along
  tl.add(
    CLOCK.ringZoom,
    { ry: [0, 0.9], duration: 800, ease: "inOutCubic" },
    150,
  );
  tl.add(
    CLOCK.ringFocus,
    { ry: [0, -0.85], duration: 800, ease: "inOutCubic" },
    420,
  );
  tl.add(
    CLOCK.camBarrel,
    { ry: [0, -0.4], duration: 800, ease: "inOutCubic" },
    600,
  );
  // beat 2 — the front glass fans out of the barrel head
  tl.add(CLOCK.barrel, { py: [0, 7], ease: springs.snappy() }, 1200);
  tl.add(CLOCK.e02, { py: [0, 14], ease: springs.snappy() }, 1380);
  tl.add(CLOCK.e01, { py: [0, 24], ease: springs.snappy() }, 1560);
  // beat 3 — iris wink behind the fanned glass (the existing aperture channel)
  tl.add(CLOCK.iris, { a: [0, 1], duration: 500, ease: "outCubic" }, 2200);
  tl.add(CLOCK.iris, { a: [1, 0], duration: 650, ease: "inOutQuad" }, 2850);
  // beat 4 — the glass reels home, staggered springs
  tl.add(CLOCK.e01, { py: [24, 0], ease: springs.snappy() }, 3300);
  tl.add(CLOCK.e02, { py: [14, 0], ease: springs.snappy() }, 3450);
  tl.add(CLOCK.barrel, { py: [7, 0], ease: springs.snappy() }, 3600);
  // (the camera swings to the mount side across p ≈ 0.36–0.55)
  // beat 5 — mount hardware pops off the tail, staggered, springy
  tl.add(
    [CLOCK.screws, CLOCK.flange, CLOCK.brass, CLOCK.contacts],
    { py: [0, -14], ease: springs.bouncy(), delay: stagger(160) },
    4700,
  );
  // beat 6 — the rear PCB tips out and hangs
  tl.add(
    CLOCK.pcb,
    { py: [0, -16], rz: [0, 0.16], ease: springs.snappy() },
    5400,
  );
  // beat 7 — home again: PCB first, hardware reverse-staggered behind it
  tl.add(
    CLOCK.pcb,
    { py: [-16, 0], rz: [0.16, 0], ease: springs.snappy() },
    6400,
  );
  tl.add(
    [CLOCK.contacts, CLOCK.brass, CLOCK.flange, CLOCK.screws],
    { py: [-14, 0], ease: springs.bouncy(), delay: stagger(140) },
    6700,
  );
  // beat 8 — finale: the rings unwind with a springy snap
  tl.add(CLOCK.ringZoom, { ry: [0.9, 0], ease: springs.bouncy() }, 7800);
  tl.add(CLOCK.ringFocus, { ry: [-0.85, 0], ease: springs.bouncy() }, 8000);
  tl.add(CLOCK.camBarrel, { ry: [-0.4, 0], ease: springs.bouncy() }, 8100);
  return tl;
}

// Flush the timeline's current values into the scene as part offsets. PCB
// components ride the board's tween so the pair stays one body (they are
// sibling nodes, not children — the explode tier travels them together too).
function applyClockOffsets(): void {
  const s = scene();
  s.setPartOffset("Ring_Zoom", { rotation: [0, CLOCK.ringZoom.ry, 0] });
  s.setPartOffset("Ring_Focus", { rotation: [0, CLOCK.ringFocus.ry, 0] });
  s.setPartOffset("Cam_Barrel", { rotation: [0, CLOCK.camBarrel.ry, 0] });
  s.setPartOffset("Mount_Screws", { position: [0, CLOCK.screws.py, 0] });
  s.setPartOffset("Mount_FlangeScrews", { position: [0, CLOCK.flange.py, 0] });
  s.setPartOffset("Mount_BrassRing", { position: [0, CLOCK.brass.py, 0] });
  s.setPartOffset("Mount_Contacts", { position: [0, CLOCK.contacts.py, 0] });
  s.setPartOffset("Element_01", { position: [0, CLOCK.e01.py, 0] });
  s.setPartOffset("Element_02", { position: [0, CLOCK.e02.py, 0] });
  s.setPartOffset("Barrel_Inner", { position: [0, CLOCK.barrel.py, 0] });
  const pcb = {
    position: [0, CLOCK.pcb.py, 0] as [number, number, number],
    rotation: [0, 0, CLOCK.pcb.rz] as [number, number, number],
  };
  s.setPartOffset("PCB_Rear", pcb);
  s.setPartOffset("PCB_Components", pcb);
  drive("aperture", CLOCK.iris.a);
}

// Fly-through: the dive runs SENSOR TO SKY, and KEEPS GOING. It starts parked
// off the bayonet mount, flies forward up the optical axis THROUGH the open
// aperture and the whole glass stack, out past the engraved front trim ring,
// and on into the lens-warped starfield until the lens is gone from the frame —
// travelling AGAINST the light path.
//
// ONE HEADING, START TO FINISH. The camera faces its direction of travel (world
// +X) for the entire demo: there is no pivot, no azimuth sweep, nothing that
// turns to look back. SceneHandle.setCameraPose is a SPHERICAL rig — position is
// (tx + d·cos el·sin az, ty + d·sin el, d·cos el·cos az) looking at (tx, ty, 0)
// — so the only way to TRANSLATE is to move the target: `az` is pinned at
// azRear (camera on the −X side of its own target, gazing +X), `el` eases to 0
// and stays there, `dist` collapses to a small constant, and `targetX` alone
// carries the flight from behind the mount to deep sky. Every number is a knob.
/**
 * `?tracesky` — THE A/B SWITCH BACK TO THE TRACED SKY, in the `?webgl` / `?diag`
 * mould (core/scene.ts, dev/diag.ts).
 *
 * DEFAULT (absent) the dive's sky is DRAWN: optics/starfield.ts puts the
 * authored catalog on screen as two draw calls of billboarded quads, and
 * `scene.backgroundNode` is never assigned — so optics/warp.ts's 21-surface
 * refraction, which ran for every pixel of a full-screen sphere and is the
 * single most expensive thing the demo did, does not run at all.
 *
 * PRESENT, the demo mounts the old path instead — enableLensWarp + the two
 * equirect bakes — for side-by-side look comparisons. The bakes are inside
 * `createLensWarp`, which only this branch reaches, so the default mount pays
 * nothing for them.
 *
 * Read ONCE at module scope: explore/ is lazy-loaded on /lens, so `location`
 * exists by the time this file does, and a demo must not re-read the URL per
 * frame.
 */
const TRACE_SKY =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).has("tracesky");

/** Exported for the fly-through's knob tripwires (__tests__/flythrough.test.ts),
 *  which hold the two laws the numbers below have to obey: the passage fade must
 *  finish outside the camera's near plane, and the interior remap's window must
 *  lie inside the barrel run. */
export const FLY = {
  /** shading with NO depth fade. The technical looks (ink/blueprint/flat) fold
   *  depthFadeFactor into their fills and lines (materials/shading.ts:505,529)
   *  and core/scene rewrites the uFade* planes from the camera distance every
   *  rendered frame (core/scene.ts:1031), so a demo cannot park them — an
   *  interior camera would dissolve the barrel it is flying through. "realistic"
   *  (and outline/ember/paper/riso/bronze) carry no fade at all. */
  shading: "realistic" as ShadingMode,
  /** world units; the parked framing, with the whole lens ahead of the camera */
  distFar: 9.0,
  /** world units; how far AHEAD of the camera the look-at point rides once the
   *  flight is under way. STRICTLY > 0 — a zero radius NaNs the lookAt. 0.34
   *  world = 6.8mm, comfortably outside the 0.1 near plane (= 2mm). Small
   *  enough that camera X ≈ targetX − distIn: the target is a steering handle,
   *  not a subject. */
  distIn: 0.34,
  /** The flight ENTERS THE REAR and leaves by the front, on ONE heading.
   *  azimuth −π/2 puts the camera at (targetX − d, 0, 0) — with targetX = 0 at
   *  world (−d, 0, 0), off the BAYONET MOUNT — looking down +X into the mount,
   *  and it never leaves that heading. VERIFIED VISUALLY, not inferred: at
   *  p = 0 the frame is the mount face (flange screws, brass contacts, rear
   *  baffle) with the barrel behind it; the internals stream past mid-dive; by
   *  p ≈ 0.85 the lens is behind the camera and out of frame; p = 1 is open
   *  starfield with "The Keyhole" (optics/sky.ts, az ≈ 0) on axis. */
  azRear: -Math.PI / 2,
  /** THE PARK IS DEAD-ON: elevation 0, so the flight is a pure axial shot from
   *  frame one — the camera on the optical axis, the mount face square to it,
   *  no tilt to level out. It was 0.1 (a slight high angle at the park, levelled
   *  off before the barrel), and the owner read that opening as "the lens is
   *  slightly tilted, or the camera is slightly above the lens — it's not dead
   *  looking at the lens". The knob stays: raise it for the old high-angle
   *  opening, and the pose path's pEnter key still levels it back to 0 before
   *  the barrel (a no-op at 0 → 0). */
  elFar: 0,
  fovFar: 42,
  fovIn: 70,
  /** THE FINALE'S HELD FRAMING — and it is HELD, which is the whole point of it
   *  being its own number. It used to be 38, reached on the LAST keyframe, so
   *  the fly-through spent everything after the lens left the frame narrowing
   *  70° → 38°: a ~2× telephoto push into a starfield with nothing else in it.
   *  The owner's note is exactly that ("we still continue zooming in after we go
   *  through"), and it was the other half of "the end state is too zoomed in on
   *  the stars" — the discs were oversized AND the frame was closing on them.
   *
   *  Equal to fovIn, so the exit carries NO zoom at all: the camera keeps
   *  flying (targetX still runs to xEnd) and the field opens by parallax alone,
   *  which is the calm the finale wanted. The knob stays, and it is now safe to
   *  tune — the fov ramp finishes at pClear (see the pose path), so a settle set
   *  here is over before the last stretch rather than running into p = 1.
   *
   *  NOTE FOR SIZE TUNING: optics/starfield.ts's disc sizes are calibrated
   *  against THIS fov. Judge them at 70, not at the old 38. */
  fovOut: 70,
  /** CAMERA world X at each beat (targetX = x + distIn; at the park the camera
   *  sits distFar behind targetX = 0). The lens occupies x ≈ −1.95…+1.95 —
   *  20 mm per world unit about the model's recentred axial midpoint — so
   *  xEnter/xOut clear the glass stack at both ends by ~17mm/~9mm and the
   *  passage dissolve fires on every element in between. */
  xEnter: -2.8,
  xOut: 2.2,
  xClear: 8.0,
  xEnd: 16.0,
  /** p at which the camera reaches the mount, clears the front element, and has
   *  left the lens far enough behind that no part of it can be in frame. */
  pEnter: 0.22,
  pOut: 0.72,
  pClear: 0.85,
  /** WHEN THE STARS ARRIVE: [start, end], and NOT at the park. The traced sky
   *  mounts the moment the demo is selected, so a window opening at 0 hung a
   *  full starfield around the lens silhouette before anything had moved — the
   *  dive then had nothing to arrive at. It opens as the camera reaches the
   *  mount (pEnter) and is up by the time the rear element is on the near plane,
   *  so the stars come UP THROUGH the glass rather than being the backdrop the
   *  lens was always sitting on. Either way the window fades the STARS ONLY,
   *  never the ground behind them: on the drawn path it is an opacity ramp over
   *  the flat backdrop the starfield mounts, and on `?tracesky` it is uSkyMix
   *  fading the opaque sky sphere toward black — the right colour for the
   *  inside of a barrel in both. */
  pSkyIn: [0.18, 0.36] as [number, number],
  /** THE IRIS OPENS ON THE APPROACH: [start, end] over which the aperture
   *  channel runs from `apertureShut` to 0 (f/2.8, wide open). The lens is not a
   *  dead prop being flown past — it stops down and opens up while the camera is
   *  still closing on the mount, which is the only mechanism the dive shows.
   *
   *  IT MUST BE FULLY OPEN BEFORE THE CAMERA REACHES THE GLASS, and that is a
   *  hard ordering, not a taste: pEnter (0.22) is where the camera arrives at the
   *  mount and the passage through the stack begins, and a stop still closing in
   *  there is a shut door in the frame the dive flies through. It should also be
   *  open before the sky is fully up (pSkyIn[1]) — the trace clips every ray
   *  outside the iris clear radius (optics/trace.ts, the LIVE channel value), so
   *  on `?tracesky` a shut stop meters the stars. Tripwired in
   *  __tests__/flythrough.test.ts. Owner-tuned LATE ("it's opening way too
   *  early"): the open lands just before glass entry, when the iris fills the
   *  frame and the blades actually read. */
  pAperture: [0.1, 0.2] as [number, number],
  /** where the iris STARTS: 1 = f/22, the channel's own closed end. Not a shut
   *  door — the blades' sweep leaves the minimum clear hole (optics/prescription
   *  IRIS.irisMinMm), so the park reads as a stopped-down lens rather than as a
   *  black disc. */
  apertureShut: 1,
  /** THE DIVE GOES DARK: [start, end] over which the room light ramps from the
   *  shipped lighting down to `darkFloor`. Everything the room contributes
   *  (IBL + the three studio lights) goes together — SceneHandle.setRoomLight.
   *  Runs AHEAD of the sky window above so the frame is already a dark tube
   *  when the stars come up in it. */
  pDark: [0.04, 0.3] as [number, number],
  /** what the room ramps DOWN to — not 0, so a rim of the barrel interior still
   *  catches something and the body does not read as a flat silhouette. */
  darkFloor: 0.08,
  /** …and what the GLASS's reflections ramp down to, on the SAME pDark window —
   *  SceneHandle.setGlassGlint, a multiplier on the transmissive clones' shipped
   *  specular. 0, unlike darkFloor: the barrel wants its rim, the glass does not.
   *  At the room's 8% the studio lights were still laying white smudges across
   *  elements that are inside a dark tube with nothing but stars in front of them
   *  ("where is the reflection on the lens coming from? It doesn't feel like it's
   *  from the stars" — it wasn't). At 0 the only thing left in the glass is what
   *  shines THROUGH it, which is the starfield. */
  glintFloor: 0,
  pFocus: [0.72, 1] as [number, number],
  /** THE WORMHOLE RAMP: [start, peak, end]. uWormhole rises start→peak and
   *  unwinds peak→end, and is EXACTLY 0 outside — smoothstep is exactly 0 below
   *  its first edge and exactly 1 above its second, so the product of the rise
   *  and the falling complement leaves no residue at p = 0 or p = 1. The peak
   *  sits mid-barrel, where the camera is deepest inside the stack and there is
   *  nothing left to look at but sky.
   *
   *  STARTS AT THE MOUTH, not at 0.16. It used to open only once the camera was
   *  already INSIDE the mount — and from there the only sky on screen is the
   *  disc through the aperture, because the barrel's own meshes cover the rest.
   *  So the wormhole could not be seen until it was framed by a keyhole, and it
   *  read as arriving late. The whole opening approach — the lens hanging in
   *  open sky, a full frame of stars around it — was spent at pinch 0.
   *
   *  THE 0-AT-p-0 IDENTITY IS UNAFFECTED: smoothstep(0, 0.5, 0) is exactly 0,
   *  so the parked frame is still exactly the undistorted starfield. The pinch
   *  is not visible AT p = 0; it is visible from the first scrub off it, which
   *  is when the dive starts. */
  pWormhole: [0, 0.44, 0.84] as [number, number, number],
  /** the streak window: still a touch behind the pinch at the top (the smear
   *  wants a throat to smear into) and gone before it closes, but now measured
   *  in hundredths, not in the quarter-dive it used to wait. */
  pStreak: [0.03, 0.42, 0.78] as [number, number, number],
  /** THE PASSAGE FADE, world units (20 mm to the unit — the model is at
   *  MODEL_SCALE 0.05). Each element goes down ON ITS OWN as the camera arrives
   *  at it, and the two numbers say when:
   *
   *    lead — how far BEFORE the element's rearmost point the fade has finished.
   *           Strictly greater than the camera's near plane (0.1 world = 2 mm)
   *           or the element would still be drawn when the near plane starts
   *           cutting it open. 0.3 = 6 mm.
   *    fade — the length of the ramp, so the fade RUNS from `lead + fade` before
   *           the element to `lead` before it. At 0.55 world (11 mm) the element
   *           is already filling the frame for the whole dissolve, which is what
   *           makes it read as passing THROUGH rather than as a part vanishing.
   *
   *  WHY AT ALL: three's transmission is screen-space, and from inside an
   *  element the refraction offset is enormous and its separable dual blur
   *  smears the frame into an axis-aligned cross. The camera must never be
   *  inside visible glass. See SceneHandle.setGlassElementFade.
   *
   *  THIS IS NOT THE OLD PER-ELEMENT DISSOLVE that was pulled as jarring: that
   *  one popped elements while they were still distant objects AHEAD of the
   *  camera. Nothing here touches an element until it is one frame-width away. */
  passageLead: 0.3,
  passageFade: 0.55,
  /** THE INTERIOR REMAP: [start, end] of the stretch the camera spends INSIDE
   *  the element stack, measured in POSE p (the output of `travel` below, i.e.
   *  where the beat sits on the flight itself). Measured against the pose path:
   *  the barrel run is linear from x = −2.8 at pEnter to x = +2.2 at pOut, and
   *  the glass occupies world x ≈ −1.97 … +1.79. */
  pInside: [0.3, 0.68] as [number, number],
  /** HOW MUCH FASTER the stack is crossed. The interior takes 1/insideRate of
   *  the p it used to, and the time saved is handed to the approach and the
   *  exit, which slow down by the same amount of p between them. 1 = the old
   *  linear dive, EXACTLY (the remap is the identity there); 2 halves the
   *  interior — the owner's note is that it "is a bit long", and the wormhole
   *  ramps above now cover the crossing rather than following it. */
  insideRate: 2,
};

/**
 * THE TRAVEL REMAP, p → pose p: three linear segments through (0, 0),
 * (a′, a), (b′, b), (1, 1), where [a, b] = `inside` is the interior in POSE p
 * and [a′, b′] is the shorter stretch of INPUT p that now covers it (same
 * midpoint, `rate` times narrower).
 *
 * Monotone, continuous and fixed at both ends. At rate = 1 it is the identity —
 * a′ = a and b′ = b, so every segment has slope 1 — and returns `p` itself, so
 * the knob restores the old linear dive to the bit rather than to 1e-17.
 */
export function travelRemap(
  p: number,
  [a, b]: [number, number],
  rate: number,
): number {
  if (rate === 1) return p;
  const half = (b - a) / 2;
  const mid = (a + b) / 2;
  const r = Math.max(rate, 1e-3);
  const a2 = mid - half / r;
  const b2 = mid + half / r;
  if (p <= a2) return a2 > 0 ? (p / a2) * a : p;
  if (p >= b2) return b2 < 1 ? b + ((p - b2) / (1 - b2)) * (1 - b) : p;
  return a + ((p - a2) / (b2 - a2)) * (b - a);
}

/**
 * One element's passage fade: 1 while it is ahead of the camera, ramping to 0
 * over `fade` world units and reaching 0 `lead` units before the camera's own X
 * meets the element's rearmost point `x0`. Stays 0 once past — the ramp is a
 * pure function of camera X, so a backwards scrub brings the element back.
 */
export function passageFade(
  camX: number,
  x0: number,
  lead: number,
  fade: number,
): number {
  return 1 - smoothstep(x0 - lead - fade, x0 - lead, camX);
}

/** World X of the camera under a spherical pose — the same expression
 *  core/scene's applyCameraPose writes into camera.position.x, and the only way
 *  the dive knows where it is. */
export function poseCamX(pose: CameraPose): number {
  return (
    (pose.targetX ?? 0) +
    pose.distance * Math.cos(pose.elevation) * Math.sin(pose.azimuth)
  );
}

/** The elements ordered REAR TO FRONT (ascending world X), which is the order
 *  the dive meets them in — `worldAxialSpans` hands back an unordered record. */
export function passageOrder(
  spansWorld: Record<string, { x0: number; x1: number }>,
): { id: string; x0: number }[] {
  return Object.entries(spansWorld)
    .map(([id, s]) => ({ id, x0: s.x0 }))
    .sort((p, q) => p.x0 - q.x0);
}

/** [start, peak, end] → a 0-at-both-ends ramp. Both halves are smoothsteps, so
 *  the value is exactly 0 outside [start, end] and exactly 1 at the peak. */
const arc = ([a, peak, b]: [number, number, number], p: number) =>
  smoothstep(a, peak, p) * (1 - smoothstep(peak, b, p));

/** The elements' axial spans, gltf mm, for SceneHandle.setGlassTransmissive —
 *  which needs the prescription but must not IMPORT it (core/scene.ts is in the
 *  homepage chunk; see GlassSpanMm). Derived here because demos.ts is already an
 *  optics/ consumer, and it is a pure function of the authored table, so it is
 *  built once at module scope rather than per enter(). */
const GLASS_SPANS: Record<string, GlassSpanMm> = Object.fromEntries(
  PRESCRIPTION.map((e) => [
    e.id,
    { frontYmm: e.front.yMm, rearYmm: e.rear.yMm },
  ]),
);

/** The dive's own ruler: every element's rearmost world X, rear to front,
 *  measured off the model in enter() (SceneHandle.worldAxialSpans) and read by
 *  apply() to decide which element the camera is arriving at. Empty until the
 *  demo is selected. */
let flyPassage: { id: string; x0: number }[] = [];
/** …and the record apply() fills for setGlassElementFade. Reused rather than
 *  rebuilt: this is written every frame of the dive. */
const flyFades: Record<string, number> = {};

/** az is written once and carried by every later key: ONE heading for the whole
 *  flight. Only targetX (and, on the approach, dist/el/fov) ever changes.
 *  The barrel run is deliberately LINEAR — an ease at each interior key would
 *  stall the camera mid-glass, and the interior's PACE is FLY.insideRate's job
 *  (see travelRemap), which reshapes p before it ever reaches this path.
 *
 *  THE FOV SETTLES BY pClear AND IS HELD. `fovOut` sits on the pClear key, not
 *  on the last one, so whatever it is set to is REACHED as the lens leaves the
 *  frame and then carried, unchanged, to p = 1 (posePath carries every field a
 *  key does not restate). The finale is a hold, never a push — see FLY.fovOut. */
/* prettier-ignore */
export const flyPose = posePath([
  { p: 0,           pose: { az: FLY.azRear, el: FLY.elFar, fov: FLY.fovFar, dist: FLY.distFar, targetX: 0                     } },
  { p: FLY.pEnter,  pose: {                 el: 0,         fov: FLY.fovIn,  dist: FLY.distIn,  targetX: FLY.xEnter + FLY.distIn }, ease: ss01 },
  { p: FLY.pOut,    pose: {                                                                    targetX: FLY.xOut   + FLY.distIn } },
  { p: FLY.pClear,  pose: {                                 fov: FLY.fovOut,                   targetX: FLY.xClear + FLY.distIn } },
  { p: 1,           pose: {                                                                    targetX: FLY.xEnd   + FLY.distIn }, ease: ss01 },
]);

function posterPose(p: number) {
  return {
    azimuth: lerp(0.5, 0.72, smoothstep(0, 1, p)),
    elevation: 0.12,
    distance: POSTER_FRAME / Math.tan((POSTER_FOV * Math.PI) / 360),
    fov: POSTER_FOV,
  };
}

export const DEMOS: LensDemo[] = [
  {
    id: "d-rise",
    label: "Rise",
    hint: "cream line rises — the lens reassembles behind it",
    enter() {
      setTransparentBackground(true);
      // engage the pose at the start framing so nothing pops before the scrub
      setCameraPose(risePose(0));
    },
    apply(p) {
      // hard cream-below / black-above line rising with a slight left tilt;
      // already low in frame at p 0 so the detail open carries the identity
      setPageWipe({
        p: lerp(0.06, 1, p),
        skewDeg: -6,
        below: CREAM,
        above: NEAR_BLACK,
      });
      // the lens reassembles as the line rises (assemble channel RISE_A0 → 0)
      drive("zoom", 0);
      drive("focus", 0);
      drive("aperture", 0);
      drive("assemble", RISE_A0 * (1 - ss01(p)));
      // crane from the mount-detail crop out and up to the high long-lens land
      setCameraPose(risePose(p));
    },
    // no exit() — auto-restore returns the bench (pose, bg, wipe, assemble).
  },

  {
    id: "d-filmstrip",
    label: "Filmstrip",
    hint: "the outer shells unroll into flat strips as the light rises",
    enter() {
      setTransparentBackground(true);
      // Only the OUTER shells roll (rank ≥ ~0.45) — the inner core stays a whole
      // lens for the flat strips to peel away from. Sector fully open.
      set(kRolloutRankLo, 0.45);
      set(kRolloutRankHi, 1);
      set(kRolloutMaskCenter, 0);
      set(kRolloutMaskWidth, TAU);
      // channels parked once (d-rise idiom); rollout is the demo's only drive
      drive("zoom", 0);
      drive("focus", 0);
      drive("aperture", 0);
      // Roll the lens 180° about its own axis (front stays +x): the front-ring
      // engravings are authored to read upright in THIS roll phase, and the
      // demo opens right on them. Rolling about the optical axis only
      // re-phases the shell theta, so the rollout itself is unaffected.
      setModelOrientation({ x: Math.PI });
      // open ON the front-ring engravings — a text-filled detail crop
      setCameraPose({
        azimuth: FILM_START.azimuth,
        elevation: FILM_START.elevation,
        distance: BASE_DIST * FILM_START.distScale,
        fov: FILM_START.fov,
        targetY: FILM_START.targetY,
      });
    },
    apply(p) {
      // camera runs AHEAD of the roll: parked at the side pull-out by p≈0.55,
      // while the strips are still short — the unroll then plays out inside a
      // steady frame instead of down the axis
      const s = smoothstep(0, 0.55, p);
      // unroll as the scrub advances — the traveling roll front is the subject
      drive("rollout", p);
      // track sideways off the engravings and pull back so the growing flat
      // strips stay in frame; the roll front sits mid-frame around p 0.4–0.7
      setCameraPose({
        azimuth: lerp(FILM_START.azimuth, FILM_END.azimuth, s),
        elevation: lerp(FILM_START.elevation, FILM_END.elevation, s),
        distance: lerp(
          BASE_DIST * FILM_START.distScale,
          BASE_DIST * FILM_END.distScale,
          s,
        ),
        fov: lerp(FILM_START.fov, FILM_END.fov, s),
        targetY: lerp(FILM_START.targetY, 0, s),
      });
      // near-white below rising with the roll, warm near-black above, right-dipped
      setPageWipe({
        p: lerp(0.12, 0.82, p),
        skewDeg: 7,
        below: FILM_LIGHT,
        above: FILM_DARK,
      });
      // front kicker only — the strips are the star. Fades in after the wipe
      // line has passed the caption's anchor, so the dark ink lands on light.
      setPageText({
        front: {
          text: "Every part, laid flat.",
          color: FILM_DARK,
          y: 0.84,
          opacity: smoothstep(0.35, 0.7, p),
        },
      });
    },
    // no exit() — auto-restore returns the bench (pose, bg, orientation, wipe,
    // the rollout channel, and the four rollout-mask uniforms).
  },

  {
    id: "d-sector",
    label: "Sector solo",
    hint: "one 90° sector tears out, orbits, and reseats — the rest stays whole",
    enter() {
      setTransparentBackground(true);
      // Solo a ~90° sector; the rest of the lens stays bit-exact seated
      // (assemble mask). The lens stands front-element-UP so the overhead open
      // reads the glass as a full circle.
      set(kAssembleMaskWidth, Math.PI / 2);
      set(kAssembleMaskCenter, SECTOR_CENTER);
      // channels parked once (d-rise idiom); assemble is the demo's only drive
      drive("zoom", 0);
      drive("focus", 0);
      drive("aperture", 0);
      setModelOrientation({ z: 0 });
      setCameraPose({
        azimuth: SEATED.azimuth + SECTOR_ORBIT,
        elevation: SECTOR_TOP.elevation,
        distance: BASE_DIST * SECTOR_TOP.distScale,
      });
    },
    apply(p) {
      // one-scrub pulse: tears out to ~0.85 by p≈0.45, reels back in by p=1
      const up = smoothstep(0, 0.45, p);
      const down = smoothstep(0.45, 1, p);
      const pulse = up * (1 - down); // 0 → 1 (at p≈0.45) → 0
      drive("assemble", 0.85 * pulse);
      // the sector tears out toward the overhead camera, then the lens tumbles
      // back seated (orientation z 0 → boot −π/2) while the camera swings down
      // and orbits to a LOW three-quarter for the reseat
      const swing = smoothstep(0.25, 0.75, p);
      setModelOrientation({ z: (-swing * Math.PI) / 2 });
      setCameraPose({
        azimuth: SEATED.azimuth + SECTOR_ORBIT * (1 - swing),
        elevation: lerp(SECTOR_TOP.elevation, SECTOR_END_EL, swing),
        distance: BASE_DIST * lerp(SECTOR_TOP.distScale, SECTOR_DIST, swing),
      });
      // ember wipe, steep left-dipped line following the pulse
      setPageWipe({
        p: 0.6 * pulse,
        skewDeg: -12,
        below: EMBER_BELOW,
        above: EMBER_ORANGE,
      });
    },
    // no exit() — auto-restore returns the bench (pose, bg, orientation, wipe,
    // the assemble channel, and the assemble-mask width/center uniforms).
  },

  {
    id: "d-ignition",
    label: "Ignition",
    hint: "a bold orange field wipes up and the scattered parts snap home",
    enter() {
      setTransparentBackground(true);
      // full assembly — mask open (self-contained, in case a solo demo ran)
      set(kAssembleMaskWidth, TAU);
      set(kAssembleMaskCenter, 0);
      // channels parked once (d-rise idiom); assemble is the demo's only drive.
      // fully disassembled at the start; worm's-eye open — camera under the
      // scattered parts, close and wide, looking up into them
      drive("zoom", 0);
      drive("focus", 0);
      drive("aperture", 0);
      drive("assemble", 1);
      setCameraPose({
        azimuth: SEATED.azimuth,
        elevation: IGNITE_START.elevation,
        distance: BASE_DIST * IGNITE_START.distScale,
        fov: IGNITE_START.fov,
        targetY: IGNITE_START.targetY,
      });
    },
    apply(p) {
      const s = smoothstep(0, 1, p);
      // compressed ease: held disassembled, then a fast snap home over 0.25..0.8
      drive("assemble", 1 - smoothstep(0.25, 0.8, p));
      // the camera rises and levels as the orange field climbs; distance grows
      // while fov narrows — the dolly-zoom stretch rides the whole climb
      setCameraPose({
        azimuth: SEATED.azimuth,
        elevation: lerp(IGNITE_START.elevation, SEATED.elevation, s),
        distance: BASE_DIST * lerp(IGNITE_START.distScale, IGNITE_DIST_HI, s),
        fov: lerp(IGNITE_START.fov, IGNITE_FOV_HI, s),
        targetY: lerp(IGNITE_START.targetY, 0, s),
      });
      // bold orange rising from below with a steep right-dipped line, near-black above
      setPageWipe({
        p,
        skewDeg: 14,
        below: EMBER_ORANGE,
        above: EMBER_BELOW,
      });
      // landing punctuation: absent until the wipe has taken the frame, then
      // the back word SLAMS in behind the seated lens (opacity + scale snap)
      const snap = smoothstep(0.78, 0.83, p);
      if (snap > 0) {
        setPageText({
          back: {
            text: "ALEX LIN",
            color: EMBER_BELOW,
            opacity: snap,
            size: lerp(1.16, 1, snap),
          },
          front: {
            text: "",
            sub: "PUT BACK TOGETHER.",
            color: EMBER_BELOW,
            y: 0.87,
            opacity: snap,
          },
        });
      } else {
        setPageText(null);
      }
    },
    // no exit() — auto-restore returns the bench (pose, bg, wipe, the assemble
    // channel, and the assemble-mask uniforms).
  },

  {
    id: "d-lookbook",
    label: "Lookbook",
    hint: "four looks, four grounds — each cut carried by a different gesture",
    durationMs: 12000,
    enter() {
      setTransparentBackground(true);
      // channels parked ONCE here, not per apply — blink/molt drive aperture/
      // unwrap/curl during the cuts and a per-frame rewrite would fight them
      drive("zoom", 0);
      drive("focus", 0);
      drive("aperture", 0);
      setCameraPose(lookPath(0));
      // four looks across three boundaries; each single crossing carries the
      // boundary-keyed cut; the page ground flips at the swap beat (present).
      lookSpans = spans({
        at: [0.25, 0.5, 0.75],
        looks: LOOKS,
        cut: (b) => LOOK_CUTS[b],
        present: lookStage,
      });
    },
    apply(p) {
      lookSpans?.apply(p);
      setCameraPose(lookPath(p));
    },
    // no exit() — spans records the bench look; auto-restore handles the rest.
  },

  {
    id: "d-poster",
    label: "Poster",
    hint: "long-lens flat graphic — the lens sits ON the type",
    durationMs: 10000,
    enter() {
      setTransparentBackground(true);
      // The whole poster is a flat graphic on the type — hold the silhouette
      // LOD for its entire run so the lens reads as a clean drawn shape (no
      // greeble clutter) at this near-orthographic long-lens size.
      setIsolate("silhouette");
      // parked once — blink drives aperture during the mid-scrub cut
      drive("zoom", 0);
      drive("focus", 0);
      drive("aperture", 0);
      // riso below the boundary, bronze above — blink carries the single cut
      // both ways (instant land on entry/jump; spans records the bench look).
      posterSpans = spans({
        at: [POSTER_SWAP_P],
        looks: ["riso", "bronze"],
        cut: () => "blink",
      });
      setCameraPose(posterPose(0));
    },
    apply(p) {
      const s = smoothstep(0, 1, p);
      posterSpans?.apply(p);
      // gentle explode breath — the silhouette swells over the letterforms.
      // KEEP TINY: the near-orthographic projection magnifies the axial spread
      // across the frame (0.25 buried the type entirely).
      const breath = smoothstep(0, 1, 1 - Math.abs(2 * p - 1));
      drive("explode", 0.08 * breath);
      // slow hard line climbing the poster: cream ground gives way to
      // near-black, recoloring the text-ground relationship mid-scrub
      setPageWipe({
        p: lerp(0.3, 0.72, s),
        skewDeg: -7,
        below: CREAM,
        above: NEAR_BLACK,
      });
      setPageText({
        // giant back type the lens sits ON; its slight counter-drift against
        // the azimuth sweep is the model/text parallax
        back: {
          text: "HELLO\nTHERE.",
          color: EMBER_ORANGE,
          y: lerp(0.53, 0.47, s),
        },
        front: {
          text: "",
          sub: "SIGMA 18–50MM F2.8 — TAKEN APART, PIECE BY PIECE",
          color: NEAR_BLACK,
          x: 0.06,
          y: 0.92,
          align: "left",
        },
      });
      setCameraPose(posterPose(p));
    },
    // no exit() — auto-restore returns the bench (pose, bg, wipe, isolate, the
    // explode channel, and the look spans records).
  },

  {
    id: "d-prism",
    label: "Prism",
    hint: "a flat rainbow fans from the glass — then down through the elements, and the shell wraps home",
    durationMs: 12000,
    enter() {
      setTransparentBackground(true);
      // stand the lens on end: boot z (−π/2) points the front at world +x, so
      // z = π turns the front element to −y (straight down)
      setModelOrientation({ z: Math.PI });
      prism = createPrismLight(PRISM_RAINBOW.length);
      prism.setColors(PRISM_RAINBOW);
      prism.setIntensity(0);
      prism.setSpread(0);
      // the ribbon is a screen-space ortho overlay (see prism-light.ts): a
      // second render pass after the main frame, anchored to the projected
      // mount-entry / dispersion points so it tracks the lens while its edges
      // stay ruler-parallel on screen
      setOverlayPass((renderer, camera) => prism?.render(renderer, camera));
      // channels parked once; assemble is the demo's only mechanism drive
      drive("zoom", 0);
      drive("focus", 0);
      drive("aperture", 0);
      // Beat 1 is a printed 2D diagram, so the lens wears the flat vector look
      // (owner: "It's a 2D image at that point in time"); the dive swaps it to
      // ink — the cel bands returning WITH the dimensionality. The cut is
      // instant (no gesture): it hides in the ISO_ON snap, where only the
      // (identically-built) glass is on screen. spans handles change detection
      // AND records the bench look for auto-restore.
      prismShade = spans({ at: [PRISM_ISO_ON], looks: ["flat", "ink"] });
      setCameraPose(prismPose(0));
    },
    apply(p) {
      // Isolate choreography, in one handoff (no fighting):
      //  • beat 1 (p < ISO_ON): "silhouette" LOD — the 2D ortho diagram drops
      //    the greebles (screws/decals/iris mechanism/PCB…) so the barrel reads
      //    as a clean drawn illustration, not a mechanical render.
      //  • beat 2 window (ISO_ON..ISO_OFF): "glass" — barrel cut away, the
      //    camera travels through the glass assembly alone. "glass", not
      //    "optics" — the authored iris metal reads as a stark white puck on
      //    the dark stage; the through-ribbon bridges the mid-air gap instead.
      // The silhouette→glass swap lands exactly at ISO_ON, where the dive has
      // already carried the barrel cut off-frame (same beat the flat→ink cut
      // hides in), so the shells simply never reappear between the two levels.
      setIsolate(
        p < PRISM_ISO_ON ? "silhouette" : p < PRISM_ISO_OFF ? "glass" : null,
      );
      // flat→ink cut, hidden in the ISO_ON snap (both directions)
      prismShade?.apply(p);
      // the stack spreads apart down the light path as the camera enters it,
      // then (structure back at ISO_OFF) wraps home around the glass. driven
      // (value+target) so setDrop below is a pure function of p.
      drive(
        "assemble",
        smoothstep(0.36, 0.5, p) * (1 - smoothstep(0.72, 0.95, p)),
      );
      if (prism) {
        // beat 1 only: the ray diagram fans open, holds, and is gone as the
        // dive begins — the rays never return
        prism.setIntensity(
          smoothstep(0.02, 0.1, p) * (1 - smoothstep(0.26, 0.34, p)),
        );
        prism.setSpread(smoothstep(0.05, 0.22, p));
        // through the passage the thin banded ribbon threads the glass —
        // the only light left once the fan is gone
        prism.setThrough(
          smoothstep(PRISM_ISO_ON, PRISM_ISO_ON + 0.05, p) *
            (1 - smoothstep(0.64, 0.7, p)),
        );
        // keep the dispersion point glued to the front element while the
        // assemble stretch carries the stack down the axis (linear
        // approximation of Barrel_Inner's ladder flight); the through-ribbon
        // stretches with it
        prism.setDrop(state().assemble * 2.1);
        // the passage recolors the light: rainbow → the site palette as the
        // glass "takes in" the scheme
        const k = smoothstep(0.4, 0.6, p);
        for (let i = 0; i < prismColors.length; i++)
          prismColors[i].copy(PRISM_RAINBOW[i]).lerp(PRISM_PALETTE[i], k);
        prism.setColors(prismColors);
      }
      // lay-back tumble DURING the pull-back (glass-only on screen): z π →
      // 3π/2 (≡ the boot −π/2), done before the ISO_OFF reveal so the wrap
      // plays out horizontal — the composition the Rise wrap was tuned on
      const stand = smoothstep(0.72, PRISM_ISO_OFF, p);
      setModelOrientation({ z: Math.PI + (stand * Math.PI) / 2 });
      // camera: ortho diagram → dive → descend → pull out → seat, keyframed in
      // prismPose. targetY alone stays hand-lerped: its recenter (0.64–0.72)
      // overlaps the descend (0.38–0.66), and one ease per posePath segment
      // can't fold two overlapping windows.
      const pose = prismPose(p);
      let targetY = lerp(0, PRISM_DIVE_Y, smoothstep(0.3, 0.38, p));
      targetY = lerp(targetY, PRISM_EXIT_Y, smoothstep(0.38, 0.66, p));
      // recenter FASTER than the distance pull, so the spread glass column is
      // centered full-frame BEFORE the lay-back tumble starts
      targetY = lerp(targetY, 0, smoothstep(0.64, 0.72, p));
      pose.targetY = targetY;
      setCameraPose(pose);
      // near-black stage for the diagram; the cream site ground rises with
      // the wrap
      setPageWipe({
        p: lerp(0, 0.85, smoothstep(PRISM_ISO_OFF, 0.97, p)),
        skewDeg: -6,
        below: CREAM,
        above: NEAR_BLACK,
      });
    },
    exit() {
      // custom teardown only: dispose the prism light this demo created.
      // auto-restore handles pose, bg, wipe, isolate, orientation, overlay
      // pass, the flat/ink look (spans), and the assemble channel.
      if (prism) {
        prism.dispose();
        prism = null;
      }
    },
  },

  {
    id: "d-ribbons",
    label: "Ribbon field",
    hint: "solid ribbons snake around the lens on independent paths, then settle into one rainbow band",
    durationMs: 14000,
    enter() {
      // ink on the dark stage (the lookbook-validated pairing); instant land
      // + retarget-only follow-up, as in the lookbook
      setShading("ink");
      scene().swapShading("ink");
      setTransparentBackground(true);
      // capture the raw scene handle: the ray field's invalidate callback and
      // the overlay-pass render both fire async (outside any withKit bracket),
      // so they must NOT reach through a verb — the captured handle does the
      // un-recorded work directly.
      const sc = scene();
      ribbons = createRayField(7, () => sc.invalidate());
      setOverlayPass((renderer, camera) => ribbons?.render(renderer, camera));
      // channels parked once; the model just sits seated — the rays are the show
      drive("zoom", 0);
      drive("focus", 0);
      drive("aperture", 0);
      setCameraPose({
        azimuth: SEATED.azimuth,
        elevation: SEATED.elevation,
        distance: RIB_FRAME / Math.tan((RIB_FOV * Math.PI) / 360),
        fov: RIB_FOV,
      });
    },
    apply(p) {
      if (!ribbons) return;
      // full-frame dark stage behind the transparent canvas
      setPageWipe({
        p: 1,
        skewDeg: 0,
        below: NEAR_BLACK,
        above: NEAR_BLACK,
      });
      const k1 = smoothstep(0.34, 0.55, p); // snake A → B (independent motion)
      const k2 = smoothstep(0.56, 0.8, p); // → the converged rainbow band
      // traveling-wave undulation on the free points, dying as they converge
      const wobAmp = 0.028 * (1 - k2);
      const wob = (i: number, k: number) =>
        wobAmp * Math.sin(TAU * (1.6 * p + RIB_PHASE[i] + 0.16 * k));
      for (let i = 0; i < 6; i++) {
        const grow = smoothstep(RIB_START[i], RIB_START[i] + 0.3, p);
        const path: RayPoint[] = [RIB_ANCHOR];
        for (let k = 0; k < 5; k++) {
          const a = RIB_A[i][k];
          const b = RIB_B[i][k];
          path.push({
            x: lerp(lerp(a[0], b[0], k1), RIB_CONV[k][0], k2),
            y: lerp(lerp(a[1], b[1], k1), RIB_CONV[k][1], k2) + wob(i, k),
          });
        }
        ribbons.setRay(i, {
          path,
          width: lerp(RIB_W[i], RIB_CONV_W, k2),
          // laddered offsets fan the shared path into butted bands (top→bottom)
          offset: (2.5 - i) * RIB_CONV_W * k2,
          color: RIB_COLORS[i],
          opacity: smoothstep(0, 0.12, grow),
          trim: [0, Math.max(grow, k2)],
        });
      }
      // wrap tail: emerges lower-left once the head has reached the barrel,
      // and fades away as its head ray peels off into the rainbow
      const tGrow = smoothstep(0.28, 0.45, p);
      const tail: RayPoint[] = TAIL_A.map((a, k) => ({
        x: lerp(a[0], TAIL_B[k][0], k1),
        y: lerp(a[1], TAIL_B[k][1], k1) + wob(4, k),
      }));
      ribbons.setRay(6, {
        path: tail,
        width: RIB_W[4],
        color: RIB_COLORS[4],
        opacity: smoothstep(0, 0.12, tGrow) * (1 - k2),
        trim: [0, tGrow],
      });
    },
    exit() {
      // custom teardown only: dispose the ray field this demo created. auto-
      // restore handles pose, bg, wipe, the overlay pass, and the ink look.
      if (ribbons) {
        ribbons.dispose();
        ribbons = null;
      }
    },
  },

  {
    id: "d-clockparts",
    label: "Piece by piece",
    hint: "rings, screws, glass and iris each answer alone — a staggered mechanical ballet",
    durationMs: 11000,
    enter() {
      // ink on the dark stage (the lookbook-validated pairing)
      setShading("ink");
      scene().swapShading("ink");
      setTransparentBackground(true);
      clockTl = buildClockTimeline();
      // channels parked once; the timeline drives aperture (the iris wink)
      drive("zoom", 0);
      drive("focus", 0);
      drive("aperture", 0);
      setCameraPose({
        azimuth: 1.05,
        elevation: 0.22,
        distance: BASE_DIST,
      });
    },
    apply(p) {
      if (!clockTl) return;
      setPageWipe({
        p: 1,
        skewDeg: 0,
        below: NEAR_BLACK,
        above: NEAR_BLACK,
      });
      // the scrub drives the anime timeline via seek() (scrub-safe, both
      // directions); the resolved values flow into setPartOffset each frame
      clockTl.seek(p * clockTl.duration);
      applyClockOffsets();
      // camera follows the beat groups: front three-quarter for the ring/
      // glass/iris beats, one swing to the mount side for the hardware beats,
      // settling toward a near-frontal mount view for the finale
      const swing = smoothstep(0.36, 0.55, p);
      const settle = smoothstep(0.8, 1, p);
      const azFront = lerp(1.05, 0.85, smoothstep(0, 0.3, p));
      const azRear = lerp(-0.62, -0.25, settle);
      setCameraPose({
        azimuth: lerp(azFront, azRear, swing),
        elevation: lerp(0.22, 0.14, p),
        distance: BASE_DIST * lerp(1, 1.08, swing),
      });
      setPageText({
        front: {
          text: "",
          sub: "EVERY PART, ON ITS OWN BEAT",
          color: CREAM,
          y: 0.9,
          opacity: smoothstep(0.04, 0.16, p),
        },
      });
    },
    exit() {
      // custom teardown only: clear the part offsets (setPartOffset is NOT
      // recorded) and drop the timeline. auto-restore handles pose, bg, wipe,
      // the aperture channel, and the ink look.
      scene().clearPartOffsets();
      clockTl = null;
    },
  },
  {
    id: "d-flythrough",
    label: "Fly-through",
    hint: "in the mount, through the aperture, out the front and away",
    durationMs: 14000,
    enter() {
      setShading(FLY.shading);
      // The door, PARKED SHUT — apply(0)'s own value, so selecting the demo and
      // scrubbing to 0 are the same frame and the kit's restore has one state to
      // put back. The aperture channel is 0 = f/2.8 WIDE OPEN and 1 = f/22 closed
      // down (ops/mechanism.ts MechanismDrive), and the trace kills every ray
      // outside the iris clear radius, so this is also what lets the sky through
      // at all — hence the opening ramp in apply() finishes before either
      // matters (FLY.pAperture).
      drive("aperture", FLY.apertureShut);
      drive("zoom", 0);
      drive("focus", 0);
      drive("explode", 0);
      drive("assemble", 0);
      // BOTH sky paths' ramps are snapshotted here whichever one mounts: they
      // are four independent uniform boxes, and recording all of them costs
      // nothing while guaranteeing none is left dirty for the next demo (the
      // measured-prior leak scene-kit.ts's header warns about).
      set(uSkyMix, 0);
      set(uStarMix, 0);
      // Snapshotted at 0 so the kit's auto-restore parks them there on
      // deselect — the wormhole must not survive the demo (see apply).
      set(uWormhole, 0);
      set(uStreak, 0);
      set(uStarStreak, 0);
      set(uStarRing, 0);
      // The always-on dust would float in front of the sky.
      scene().setDust(false);
      // THE GLASS STAYS, until the wormhole takes over. Every element is drawn
      // wearing a per-element-thickness transmissive material, so the blades,
      // the barrel internals and the warped starfield are all seen THROUGH the
      // optics rather than instead of them — right up to the frame each one is
      // passed through (the passage fade in apply()).
      // AFTER setShading above, which re-materials every mesh and would stomp
      // the swap (core/scene setGlassTransmissive documents the hazard).
      scene().setGlassTransmissive(true, GLASS_SPANS);
      scene().setGlassFade(1);
      // THE RULER FOR THE PASSAGE FADE, measured once here with every channel at
      // rest: where each element actually sits on the world X axis the camera is
      // about to fly down. The prescription's millimetres cannot answer that
      // without core/scene's recentre offset, so the scene is asked instead.
      flyPassage = passageOrder(
        scene().worldAxialSpans(Object.keys(GLASS_SPANS)),
      );
      // THE SKY, one of two ways (see TRACE_SKY). Async, fire-and-forget: the
      // scene-kit verbs are synchronous-only, so nothing may be driven from
      // these promises' continuations. The boolean is the ONLY signal that the
      // sky is missing — a mount that never lands leaves a demo that otherwise
      // runs perfectly, minus the stars, which is the exact shape of the
      // reported mobile bug. Say so out loud.
      if (TRACE_SKY) {
        // REVERSED: this dive runs rear→front, so the warp's trace has to be
        // built for a ray travelling that way (optics/trace.ts
        // AXIAL_ORDER_REVERSED) or every interface refracts backwards.
        void scene()
          .enableLensWarp(true, true)
          .then((ok) => {
            if (!ok)
              console.warn(
                "[lens] fly-through: warp failed to start — sky will be absent",
              );
          });
      } else {
        void scene()
          .enableStarfield(true)
          .then((ok) => {
            if (!ok)
              console.warn(
                "[lens] fly-through: starfield failed to start — sky will be absent",
              );
          });
      }
      // THE WORMHOLE IS THE FRAME, not the sky: this routes every rendered
      // frame through the screen-space pinch (optics/wormhole-post.ts) so the
      // barrel, the internals and the glass bend into the funnel alongside the
      // stars. Same fire-and-forget shape and the same say-so-out-loud rule as
      // the warp above — a failed pipeline leaves the dive undistorted, which
      // is a look regression, not a broken demo.
      //
      // MOUNTED FROM THE FIRST FRAME, AT IDENTITY, and it must stay that way:
      // uWormhole is snapshotted at 0 above and the pass is an exact pixel
      // passthrough there, so the whole demo renders through ONE path and only
      // the STRENGTH is animated. Mounting it later — when the ramp first leaves
      // 0 — would swap render paths and compile a pipeline mid-dive, which is
      // the filter popping on after the motion has settled. (optics/
      // wormhole-post.ts compiles at construction so even this mount is free.)
      void scene()
        .enableWormholePost(true)
        .then((ok) => {
          if (!ok)
            console.warn(
              "[lens] fly-through: wormhole post pass failed to start — the dive will not warp",
            );
        });
      setCameraPose(flyPose(0));
    },
    apply(p) {
      // THE IRIS OPENS AS THE CAMERA CLOSES IN: stopped down at the park, wide
      // open by the end of the approach and held there for the rest of the
      // flight (the ramp is exactly 1 below pAperture[0] and exactly 0 above
      // pAperture[1] — a smoothstep saturates at both edges). Fully open BEFORE
      // the glass, which is the ordering law the knob's comment carries.
      drive(
        "aperture",
        lerp(
          FLY.apertureShut,
          0,
          smoothstep(FLY.pAperture[0], FLY.pAperture[1], p),
        ),
      );
      // the dial focusing the new world: the rack runs once the front element
      // is behind us, so the star world resolves while the camera is already
      // facing nothing but open sky — the world coming into focus, not the lens
      drive("focus", smoothstep(FLY.pFocus[0], FLY.pFocus[1], p));
      // NO STARS BEFORE THE DIVE: the sky is black at the park and comes up as
      // the camera reaches the mount (see pSkyIn). ONE window, written to both
      // sky paths' fade uniforms — only the mounted one has anything to fade,
      // and branching here would put the URL switch in the per-frame path.
      const skyIn = smoothstep(FLY.pSkyIn[0], FLY.pSkyIn[1], p);
      set(uSkyMix, skyIn);
      set(uStarMix, skyIn);
      // AND THE ROOM GOES OUT WITH IT. A lens barrel is a dark tube; from the
      // mount inward the stars are supposed to be the only light in the frame,
      // so the IBL and the three studio lights ramp down together toward
      // darkFloor — and the GLASS's own reflections ramp down with them, on the
      // same window, all the way to glintFloor. Two channels because they want
      // different floors: the barrel keeps a rim to read as a tube, the elements
      // keep nothing, so the only light left in them comes through from the
      // stars. Both restored in exit() — neither is a recorded verb.
      const dark = smoothstep(FLY.pDark[0], FLY.pDark[1], p);
      scene().setRoomLight(lerp(1, FLY.darkFloor, dark));
      scene().setGlassGlint(lerp(1, FLY.glintFloor, dark));
      // THE DIVE FALLS THROUGH A WORMHOLE, FROM THE MOUTH. The whole FRAME
      // pinches toward the exit axis (world +X — where the camera is already
      // pointed and already going), so the barrel, the internals and the glass
      // bend into the throat with the stars rather than standing straight while
      // the sky streams behind them; the streak ramp draws the stars themselves
      // out into lines. Then it all unwinds: at p = 1 the frame is exactly the
      // frame, both ramps at 0. Both windows open at the entrance, where the
      // lens is still a distant object — from the mount inward the barrel IS
      // the frame, and now the barrel warps too.
      set(uWormhole, arc(FLY.pWormhole, p));
      // ONE streak window, both paths: it crossfades the traced sky onto its
      // streaked bake, and ELONGATES each drawn sprite along the great circle
      // toward the throat (optics/starfield.ts).
      const streak = arc(FLY.pStreak, p);
      set(uStreak, streak);
      set(uStarStreak, streak);
      // AND THE RING RIDES THE WORMHOLE'S OWN RAMP, not the streak's: inside a
      // band of angles about the exit axis the sprites' streaks swing from
      // radial to TANGENTIAL, drawing little arcs on rings around the throat
      // (optics/starfield.ts STARFIELD_LOOK.ring*). That is half of the Einstein
      // ring; the post pass's fold and smear (optics/wormhole-post.ts RING_LOOK,
      // gated by uWormhole) are the other half, so both halves come and go with
      // the pinch that justifies them.
      set(uStarRing, arc(FLY.pWormhole, p));
      // THE POSE, through the interior remap: the camera crosses the glass stack
      // in half the p it used to, so the wormhole covers the crossing instead of
      // following it (FLY.insideRate — at 1 this is the old linear dive).
      const pose = flyPose(travelRemap(p, FLY.pInside, FLY.insideRate));
      // AND EACH ELEMENT GOES DOWN AS THE CAMERA ARRIVES AT IT. Not the old
      // whole-stack melt: from inside an element three's screen-space
      // transmission blows up (huge refraction offsets + a separable dual blur =
      // an axis-aligned cross), so the camera must never be inside visible
      // glass. Elements still ahead are untouched and fully transmissive — the
      // dive is still looking THROUGH the stack, one element fewer at a time.
      const camX = poseCamX(pose);
      for (const e of flyPassage)
        flyFades[e.id] = passageFade(
          camX,
          e.x0,
          FLY.passageLead,
          FLY.passageFade,
        );
      scene().setGlassElementFade(flyFades);
      setCameraPose(pose);
    },
    exit() {
      // Un-recorded writes the kit cannot undo for us. Everything else (pose,
      // shading, the five channels, uSkyMix and the two wormhole ramps)
      // auto-restores.
      // Both sky paths unconditionally: only one ever mounted, and turning off
      // the one that never started is a no-op that resolves true.
      void scene().enableLensWarp(false);
      // …which also puts back whatever background was showing before the dive.
      void scene().enableStarfield(false);
      // Back to the direct render path — the shipped site never routes a frame
      // through the post pipeline.
      void scene().enableWormholePost(false);
      scene().setDust(true);
      // BEFORE the kit's shading restore, which selectDemo runs after this —
      // the original element materials must be back on the meshes before the
      // bench look is re-applied over them.
      scene().setGlassTransmissive(false);
      scene().setGlassHidden(false); // belt and braces: nothing sets it now
      // setBodyFade is not a recorded kit verb, so its restore is the demo's:
      // the shipped choreography does not drive it, but a look pass driven live
      // through __lensPerf must not survive the deselect.
      scene().setBodyFade(1);
      // Same rule for the dive's two darkness ramps: not recorded verbs, so the
      // room lights and the IBL come back up here, and so does the glass's own
      // reflection level. The swap above already reset the glint (the level dies
      // with the clones it was written on) — this is belt and braces on the
      // channel, like setGlassHidden.
      scene().setRoomLight(1);
      scene().setGlassGlint(1);
    },
  },
];
