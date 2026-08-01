// Demo compositions for the /lens test bench (2026-07 hero exploration). A demo
// is a FULL composition — camera choreography + model animation + page wipe +
// palette — under one progress scrub: the end-to-end examples the owner asked
// for, not isolated animation clips. The page injects setPageWipe (the wipe is
// page-owned DOM); everything else drives the scene through the SAME SceneState
// channels the animations use.
//
// LIFECYCLE CONTRACT: exit() MUST restore EVERYTHING — camera pose null, page
// wipe null, transparent background off, every driven channel back to 0 — so
// selecting None returns the normal seated /lens view (same rule as
// animation-kit.ts's LensAnimation).
import {
  Color,
  Mesh,
  MeshBasicMaterial,
  Shape,
  ShapeGeometry,
  Vector3,
} from "three/webgpu";
import { lerp, smoothstep } from "../core/math";
import { createTimeline, stagger, springs, springEaseFn } from "./motion";
import type { Timeline } from "./motion";
import { uGenieTarget } from "../materials/genie";
import { createPrismLight, type PrismLight } from "./prism-light";
import { createRayField, type RayField, type RayPoint } from "./ray-ribbons";
import type {
  SceneHandle,
  SceneState,
  ShadingMode,
  TransitionName,
} from "../core/scene";
import type { PageWipeCfg } from "./page-wipe";
import type { PageTextCfg } from "./page-text";
import {
  uRolloutRankLo,
  uRolloutRankHi,
  uRolloutMaskCenter,
  uRolloutMaskWidth,
  uAssembleMaskCenter,
  uAssembleMaskWidth,
} from "../materials/formation";
import { uCardifyRankLo, uCardifyRankHi } from "../materials/bloom";

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
  enter(api: DemoApi): void;
  /** drive the whole composition from progress p (0..1). */
  apply(p: number, api: DemoApi): void;
  exit(api: DemoApi): void;
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
// Ember palette wipe pair (WIPE_BACKDROPS.ember in materials/shading.ts):
// deep brown-black stage, bold orange field.
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
// Lookbook swap bookkeeping (module lets — one demo instance, reset in enter):
// lookSeg = segment the scrub is in; lookBgSeg = segment the page ground shows
// (flips at the transition's hidden swap beat so bg and look cut TOGETHER);
// lookPendingBg = where a retargeted in-flight swap should land the ground.
let lookSaved: ShadingMode = "ink";
let lookSeg: number | null = null;
let lookBgSeg = 0;
let lookPendingBg = 0;
let lookReduced = false;

// Poster: long-lens flattened hero composition. Low fov + proportionally far
// camera renders the lens near-orthographic — a graphic object on the type.
const POSTER_FOV = 14;
const POSTER_FRAME = 3.35;
const POSTER_SWAP_P = 0.55; // riso → bronze blink boundary
let posterSaved: ShadingMode = "ink";
let posterLook: number | null = null;

// Lookbook camera: slow continuous FORWARD orbit — open dead on the mount
// face (azimuth −π/2, the one face no other scene shows), end on the front
// element three-quarter — with a gentle long-lens fov drift; distance rides
// the framing constant so the lens holds its size across the looks.
function lookPose(p: number) {
  const fov = lerp(LOOK_FOV.lo, LOOK_FOV.hi, p);
  return {
    azimuth: lerp(-Math.PI / 2, 1.05, p),
    elevation: lerp(0.1, 0.28, p),
    distance: LOOK_FRAME / Math.tan((fov * Math.PI) / 360),
    fov,
  };
}

// The lookbook's page side of a segment — flat ground + caption — driven from
// lookBgSeg so it cuts at the swap BEAT, not at the scrub crossing.
function lookStage(api: DemoApi): void {
  const bg = LOOK_BG[lookBgSeg];
  api.setPageWipe({ p: 1, skewDeg: 0, below: bg, above: bg });
  api.setPageText({
    // specimen label, mid-left — clear of the model in every segment (the
    // bottom-centre default collides with the lens rim at the later poses)
    front: {
      text: LOOK_LABELS[lookBgSeg],
      sub: `0${lookBgSeg + 1} / 04`,
      color: LOOK_FG[lookBgSeg],
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
const prismDist = (fov: number) =>
  PRISM_FRAME / Math.tan((fov * Math.PI) / 360);
let prism: PrismLight | null = null;
let prismSaved: ShadingMode = "realistic";
// beat-keyed look: "flat" for the 2D diagram, "ink" once the dive has taken
// the viewer into the glass (dimensionality returns with the cel bands). The
// cut rides the ISO_ON snap — only the (identical) glass is on screen.
let prismLook: ShadingMode = "flat";

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
let ribbonsSaved: ShadingMode = "ink";

// Card gallery: the filmstrip payoff — the big outer shells roll out into flat
// sheets (rollout, rank-banded like the filmstrip), CARDIFY squares the sheets
// into uniform photo cards whose faces develop into pictures, and the finished
// pentagon of cards turns past the camera as a carousel (model roll about the
// optical axis — the same rig-safe move the filmstrip uses) while the cream
// poster ground rises. The inner core stays a whole seated lens throughout.
// GALLERY_BAND drives BOTH the rollout and the cardify rank masks — only what
// unrolls becomes a card.
const GALLERY_BAND = { lo: 0.62, hi: 1 };
const GALLERY_START = {
  azimuth: 1.45,
  elevation: 0.08,
  distScale: 0.55,
  fov: 30,
  targetY: 0.7,
};
const GALLERY_MID = { azimuth: 1.0, elevation: 0.26, distScale: 1.5, fov: 40 };
const GALLERY_END = { azimuth: 0.7, elevation: 0.18, distScale: 1.95, fov: 32 };
/** carousel roll (rad) across the arrange beat — cards parade past the camera */
const GALLERY_ROLL = -1.15;
let gallerySaved: ShadingMode = "ink";

// Genie: the macOS dock-minimize gesture on the whole lens (materials/genie
// uGenie — the funnel warp composes after cardify). One scrub: suck the seated
// lens down the curved taper into a flat 2D "dock" bar at the lower right,
// hold, then release with a springy restore (springEaseFn — anime.js, demo
// layer only) whose overshoot lands as a little nod of the whole model.
// GENIE_T is the funnel target in MODEL mm; the dock bar is placed at its
// world-space image via MODEL_TO_WORLD (the boot transform: model (x,y,z) →
// world 0.05·(y, −z, −x) + the recentring offset, read off the live scene).
const GENIE_T: [number, number, number] = [0, 88, 48];
const MODEL_TO_WORLD = (m: [number, number, number]) =>
  new Vector3(
    0.05 * m[1] - 1.78875,
    -0.05 * m[2] + 0.00225,
    -0.05 * m[0] - 0.0032,
  );
const GENIE_POSE = {
  azimuth: SEATED.azimuth,
  elevation: 0.24,
  distance: BASE_DIST * 1.3,
};
const GENIE_SUCK_END = 0.55; // scrub: fully docked here …
const GENIE_RELEASE = 0.62; // … held until here, then the spring restore
const genieSpring = springEaseFn(90, 6); // visible bounce on the restore
let genieDock: Mesh | null = null;
let genieSaved: ShadingMode = "ink";

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
let clockSaved: ShadingMode = "ink";

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
function applyClockOffsets(api: DemoApi): void {
  const s = api.scene;
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
  api.state.apertureTarget = CLOCK.iris.a;
}

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
    enter(api) {
      api.scene.setTransparentBackground(true);
      // engage the pose at the start framing so nothing pops before the scrub
      api.scene.setCameraPose({
        azimuth: RISE_START.azimuth,
        elevation: RISE_START.elevation,
        distance: BASE_DIST * RISE_START.distScale,
        fov: RISE_START.fov,
      });
    },
    apply(p, api) {
      const s = smoothstep(0, 1, p);
      // hard cream-below / black-above line rising with a slight left tilt;
      // already low in frame at p 0 so the detail open carries the identity
      api.setPageWipe({
        p: lerp(0.06, 1, p),
        skewDeg: -6,
        below: CREAM,
        above: NEAR_BLACK,
      });
      // the lens reassembles as the line rises (assemble channel RISE_A0 → 0)
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      api.state.assembleTarget = RISE_A0 * (1 - s);
      // crane from the mount-detail crop out and up to the high long-lens land
      api.scene.setCameraPose({
        azimuth: lerp(RISE_START.azimuth, RISE_END.azimuth, s),
        elevation: lerp(RISE_START.elevation, RISE_END.elevation, s),
        distance: BASE_DIST * lerp(RISE_START.distScale, RISE_END.distScale, s),
        fov: lerp(RISE_START.fov, RISE_END.fov, s),
      });
    },
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.setPageWipe(null);
      api.state.assembleTarget = 0;
    },
  },

  {
    id: "d-filmstrip",
    label: "Filmstrip",
    hint: "the outer shells unroll into flat strips as the light rises",
    enter(api) {
      api.scene.setTransparentBackground(true);
      // Only the OUTER shells roll (rank ≥ ~0.45) — the inner core stays a whole
      // lens for the flat strips to peel away from. Sector fully open.
      uRolloutRankLo.value = 0.45;
      uRolloutRankHi.value = 1;
      uRolloutMaskCenter.value = 0;
      uRolloutMaskWidth.value = TAU;
      // Roll the lens 180° about its own axis (front stays +x): the front-ring
      // engravings are authored to read upright in THIS roll phase, and the
      // demo opens right on them. Rolling about the optical axis only
      // re-phases the shell theta, so the rollout itself is unaffected.
      api.scene.setModelOrientation({ x: Math.PI });
      // open ON the front-ring engravings — a text-filled detail crop
      api.scene.setCameraPose({
        azimuth: FILM_START.azimuth,
        elevation: FILM_START.elevation,
        distance: BASE_DIST * FILM_START.distScale,
        fov: FILM_START.fov,
        targetY: FILM_START.targetY,
      });
    },
    apply(p, api) {
      // camera runs AHEAD of the roll: parked at the side pull-out by p≈0.55,
      // while the strips are still short — the unroll then plays out inside a
      // steady frame instead of down the axis
      const s = smoothstep(0, 0.55, p);
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      // unroll as the scrub advances — the traveling roll front is the subject
      api.state.rolloutTarget = p;
      // track sideways off the engravings and pull back so the growing flat
      // strips stay in frame; the roll front sits mid-frame around p 0.4–0.7
      api.scene.setCameraPose({
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
      api.setPageWipe({
        p: lerp(0.12, 0.82, p),
        skewDeg: 7,
        below: FILM_LIGHT,
        above: FILM_DARK,
      });
      // front kicker only — the strips are the star. Fades in after the wipe
      // line has passed the caption's anchor, so the dark ink lands on light.
      api.setPageText({
        front: {
          text: "Every part, laid flat.",
          color: FILM_DARK,
          y: 0.84,
          opacity: smoothstep(0.35, 0.7, p),
        },
      });
    },
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.scene.setModelOrientation(null);
      api.setPageWipe(null);
      api.state.rolloutTarget = 0;
      uRolloutRankLo.value = 0;
      uRolloutRankHi.value = 1;
      uRolloutMaskCenter.value = 0;
      uRolloutMaskWidth.value = TAU;
    },
  },

  {
    id: "d-gallery",
    label: "Card gallery",
    hint: "the outer shells unroll, square into photo cards, and parade past",
    durationMs: 12000,
    enter(api) {
      // ink is the validated look for the photo crossfade; instant land +
      // retarget-only follow-up, as in the lookbook
      gallerySaved = api.scene.getShading();
      api.scene.setShading("ink");
      api.scene.swapShading("ink");
      api.scene.setTransparentBackground(true);
      // ONE band drives both masks: what unrolls is exactly what cardifies
      uRolloutRankLo.value = GALLERY_BAND.lo;
      uRolloutRankHi.value = GALLERY_BAND.hi;
      uRolloutMaskCenter.value = 0;
      uRolloutMaskWidth.value = TAU;
      uCardifyRankLo.value = GALLERY_BAND.lo;
      uCardifyRankHi.value = GALLERY_BAND.hi;
      // filmstrip's roll phase: the front-ring engravings read upright at the
      // detail open; the carousel beat then adds to this same axis
      api.scene.setModelOrientation({ x: Math.PI });
      api.scene.setCameraPose({
        azimuth: GALLERY_START.azimuth,
        elevation: GALLERY_START.elevation,
        distance: BASE_DIST * GALLERY_START.distScale,
        fov: GALLERY_START.fov,
        targetY: GALLERY_START.targetY,
      });
    },
    apply(p, api) {
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      // beat 1 — the outer shells roll out into flat sheets (staggered inside)
      api.state.rolloutTarget = smoothstep(0.04, 0.42, p);
      // beat 2 — cardify squares the sheets; the photo faces develop over the
      // last stretch of the channel (cardPhotoMix rides uCardify 0.55..0.95)
      api.state.cardifyTarget = smoothstep(0.4, 0.7, p);
      // beat 3 — the finished pentagon of cards parades past the camera
      const roll = GALLERY_ROLL * smoothstep(0.58, 0.98, p);
      api.scene.setModelOrientation({ x: Math.PI + roll });
      // camera: detail open on the engravings → pull out for the unroll →
      // settle on a steady three-quarter while the carousel does the moving
      const s1 = smoothstep(0, 0.5, p);
      const s2 = smoothstep(0.55, 0.95, p);
      const az = lerp(
        lerp(GALLERY_START.azimuth, GALLERY_MID.azimuth, s1),
        GALLERY_END.azimuth,
        s2,
      );
      const el = lerp(
        lerp(GALLERY_START.elevation, GALLERY_MID.elevation, s1),
        GALLERY_END.elevation,
        s2,
      );
      const dist =
        BASE_DIST *
        lerp(
          lerp(GALLERY_START.distScale, GALLERY_MID.distScale, s1),
          GALLERY_END.distScale,
          s2,
        );
      const fov = lerp(
        lerp(GALLERY_START.fov, GALLERY_MID.fov, s1),
        GALLERY_END.fov,
        s2,
      );
      api.scene.setCameraPose({
        azimuth: az,
        elevation: el,
        distance: dist,
        fov,
        targetY: lerp(GALLERY_START.targetY, 0, s1),
      });
      // poster ground: near-white rising under the cards, warm black above
      api.setPageWipe({
        p: lerp(0.1, 0.88, smoothstep(0.18, 0.8, p)),
        skewDeg: 6,
        below: FILM_LIGHT,
        above: FILM_DARK,
      });
      // kicker lands once the pictures have developed
      api.setPageText({
        front: {
          text: "Pictures, not parts.",
          color: FILM_DARK,
          y: 0.86,
          opacity: smoothstep(0.62, 0.82, p),
        },
      });
    },
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.scene.setModelOrientation(null);
      api.setPageWipe(null);
      api.state.rolloutTarget = 0;
      api.state.cardifyTarget = 0;
      uRolloutRankLo.value = 0;
      uRolloutRankHi.value = 1;
      uRolloutMaskCenter.value = 0;
      uRolloutMaskWidth.value = TAU;
      uCardifyRankLo.value = 0;
      uCardifyRankHi.value = 1;
      api.scene.setShading(gallerySaved);
      api.scene.swapShading(gallerySaved);
    },
  },

  {
    id: "d-sector",
    label: "Sector solo",
    hint: "one 90° sector tears out, orbits, and reseats — the rest stays whole",
    enter(api) {
      api.scene.setTransparentBackground(true);
      // Solo a ~90° sector; the rest of the lens stays bit-exact seated
      // (assemble mask). The lens stands front-element-UP so the overhead open
      // reads the glass as a full circle.
      uAssembleMaskWidth.value = Math.PI / 2;
      uAssembleMaskCenter.value = SECTOR_CENTER;
      api.scene.setModelOrientation({ z: 0 });
      api.scene.setCameraPose({
        azimuth: SEATED.azimuth + SECTOR_ORBIT,
        elevation: SECTOR_TOP.elevation,
        distance: BASE_DIST * SECTOR_TOP.distScale,
      });
    },
    apply(p, api) {
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      // one-scrub pulse: tears out to ~0.85 by p≈0.45, reels back in by p=1
      const up = smoothstep(0, 0.45, p);
      const down = smoothstep(0.45, 1, p);
      const pulse = up * (1 - down); // 0 → 1 (at p≈0.45) → 0
      api.state.assembleTarget = 0.85 * pulse;
      // the sector tears out toward the overhead camera, then the lens tumbles
      // back seated (orientation z 0 → boot −π/2) while the camera swings down
      // and orbits to a LOW three-quarter for the reseat
      const swing = smoothstep(0.25, 0.75, p);
      api.scene.setModelOrientation({ z: (-swing * Math.PI) / 2 });
      api.scene.setCameraPose({
        azimuth: SEATED.azimuth + SECTOR_ORBIT * (1 - swing),
        elevation: lerp(SECTOR_TOP.elevation, SECTOR_END_EL, swing),
        distance: BASE_DIST * lerp(SECTOR_TOP.distScale, SECTOR_DIST, swing),
      });
      // ember wipe, steep left-dipped line following the pulse
      api.setPageWipe({
        p: 0.6 * pulse,
        skewDeg: -12,
        below: EMBER_BELOW,
        above: EMBER_ORANGE,
      });
    },
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.scene.setModelOrientation(null);
      api.setPageWipe(null);
      api.state.assembleTarget = 0;
      uAssembleMaskWidth.value = TAU;
      uAssembleMaskCenter.value = 0;
    },
  },

  {
    id: "d-ignition",
    label: "Ignition",
    hint: "a bold orange field wipes up and the scattered parts snap home",
    enter(api) {
      api.scene.setTransparentBackground(true);
      // full assembly — mask open (self-contained, in case a solo demo ran)
      uAssembleMaskWidth.value = TAU;
      uAssembleMaskCenter.value = 0;
      // fully disassembled at the start; worm's-eye open — camera under the
      // scattered parts, close and wide, looking up into them
      api.state.assembleTarget = 1;
      api.scene.setCameraPose({
        azimuth: SEATED.azimuth,
        elevation: IGNITE_START.elevation,
        distance: BASE_DIST * IGNITE_START.distScale,
        fov: IGNITE_START.fov,
        targetY: IGNITE_START.targetY,
      });
    },
    apply(p, api) {
      const s = smoothstep(0, 1, p);
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      // compressed ease: held disassembled, then a fast snap home over 0.25..0.8
      api.state.assembleTarget = 1 - smoothstep(0.25, 0.8, p);
      // the camera rises and levels as the orange field climbs; distance grows
      // while fov narrows — the dolly-zoom stretch rides the whole climb
      api.scene.setCameraPose({
        azimuth: SEATED.azimuth,
        elevation: lerp(IGNITE_START.elevation, SEATED.elevation, s),
        distance: BASE_DIST * lerp(IGNITE_START.distScale, IGNITE_DIST_HI, s),
        fov: lerp(IGNITE_START.fov, IGNITE_FOV_HI, s),
        targetY: lerp(IGNITE_START.targetY, 0, s),
      });
      // bold orange rising from below with a steep right-dipped line, near-black above
      api.setPageWipe({
        p,
        skewDeg: 14,
        below: EMBER_ORANGE,
        above: EMBER_BELOW,
      });
      // landing punctuation: absent until the wipe has taken the frame, then
      // the back word SLAMS in behind the seated lens (opacity + scale snap)
      const snap = smoothstep(0.78, 0.83, p);
      if (snap > 0) {
        api.setPageText({
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
        api.setPageText(null);
      }
    },
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.setPageWipe(null);
      api.state.assembleTarget = 0;
    },
  },

  {
    id: "d-lookbook",
    label: "Lookbook",
    hint: "four looks, four grounds — each cut carried by a different gesture",
    durationMs: 12000,
    enter(api) {
      lookSaved = api.scene.getShading();
      lookSeg = null;
      lookReduced = window.matchMedia(
        "(prefers-reduced-motion: reduce)",
      ).matches;
      api.scene.setTransparentBackground(true);
      // channels parked ONCE here, not per apply — blink/molt drive aperture/
      // unwrap/curl during the cuts and a per-frame rewrite would fight them
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      api.scene.setCameraPose(lookPose(0));
    },
    apply(p, api) {
      const seg = p < 0.25 ? 0 : p < 0.5 ? 1 : p < 0.75 ? 2 : 3;
      if (seg !== lookSeg) {
        if (lookSeg == null || lookReduced) {
          // entry / reduced motion: land the look and its ground instantly
          // (the trailing swapShading only RETARGETS a swap still in flight,
          // so its beat can't re-apply a stale mode afterwards)
          api.scene.setShading(LOOKS[seg]);
          api.scene.swapShading(LOOKS[seg]);
          lookBgSeg = lookPendingBg = seg;
        } else {
          // boundary crossed (either direction; a jump lands on p's segment):
          // the cut rides the boundary's choreography and the page ground
          // flips at the hidden swap beat (t=0.5 for every registry
          // transition) via onProgress. Module lets, not captures — a
          // retargeted in-flight swap keeps its ORIGINAL onProgress, so the
          // closure must read the live pending segment.
          lookPendingBg = seg;
          api.scene.swapShading(LOOKS[seg], {
            transition: LOOK_CUTS[seg > lookSeg ? seg - 1 : seg],
            onProgress: (t) => {
              if (t >= 0.5 && lookBgSeg !== lookPendingBg) {
                lookBgSeg = lookPendingBg;
                lookStage(api);
              }
            },
          });
        }
        lookSeg = seg;
      }
      lookStage(api);
      api.scene.setCameraPose(lookPose(p));
    },
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.setPageWipe(null);
      // instant restore of the bench look; the follow-up swapShading only
      // retargets a swap still in flight (see the enter/apply note)
      api.scene.setShading(lookSaved);
      api.scene.swapShading(lookSaved);
    },
  },

  {
    id: "d-poster",
    label: "Poster",
    hint: "long-lens flat graphic — the lens sits ON the type",
    durationMs: 10000,
    enter(api) {
      posterSaved = api.scene.getShading();
      posterLook = null;
      api.scene.setTransparentBackground(true);
      // parked once — blink drives aperture during the mid-scrub cut
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      api.scene.setCameraPose(posterPose(0));
    },
    apply(p, api) {
      const s = smoothstep(0, 1, p);
      // riso below the boundary, bronze above — blink carries the cut both ways
      const look = p < POSTER_SWAP_P ? 0 : 1;
      if (look !== posterLook) {
        if (posterLook == null) {
          api.scene.setShading("riso");
          api.scene.swapShading("riso"); // retarget-only, as in the lookbook
        } else {
          api.scene.swapShading(look ? "bronze" : "riso", {
            transition: "blink",
          });
        }
        posterLook = look;
      }
      // gentle explode breath — the silhouette swells over the letterforms.
      // KEEP TINY: the near-orthographic projection magnifies the axial spread
      // across the frame (0.25 buried the type entirely).
      const breath = smoothstep(0, 1, 1 - Math.abs(2 * p - 1));
      api.state.explodeTarget = 0.08 * breath;
      // slow hard line climbing the poster: cream ground gives way to
      // near-black, recoloring the text-ground relationship mid-scrub
      api.setPageWipe({
        p: lerp(0.3, 0.72, s),
        skewDeg: -7,
        below: CREAM,
        above: NEAR_BLACK,
      });
      api.setPageText({
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
      api.scene.setCameraPose(posterPose(p));
    },
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.setPageWipe(null);
      api.state.explodeTarget = 0;
      api.scene.setShading(posterSaved);
      api.scene.swapShading(posterSaved);
    },
  },

  {
    id: "d-prism",
    label: "Prism",
    hint: "a flat rainbow fans from the glass — then down through the elements, and the shell wraps home",
    durationMs: 12000,
    enter(api) {
      // Beat 1 is a printed 2D diagram, so the lens wears the flat vector look
      // (owner: "It's a 2D image at that point in time"); the dive swaps it to
      // ink — the cel bands returning WITH the dimensionality — via the
      // beat-keyed cut in apply(). Instant land + retarget-only follow-up, as
      // in the lookbook.
      prismSaved = api.scene.getShading();
      prismLook = "flat";
      api.scene.setShading("flat");
      api.scene.swapShading("flat");
      api.scene.setTransparentBackground(true);
      // stand the lens on end: boot z (−π/2) points the front at world +x, so
      // z = π turns the front element to −y (straight down)
      api.scene.setModelOrientation({ z: Math.PI });
      prism = createPrismLight(PRISM_RAINBOW.length);
      prism.setColors(PRISM_RAINBOW);
      prism.setIntensity(0);
      prism.setSpread(0);
      // the ribbon is a screen-space ortho overlay (see prism-light.ts): a
      // second render pass after the main frame, anchored to the projected
      // mount-entry / dispersion points so it tracks the lens while its edges
      // stay ruler-parallel on screen
      api.scene.setOverlayPass((renderer, camera) =>
        prism?.render(renderer, camera),
      );
      // channels parked once; assemble is the demo's only mechanism drive
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      api.scene.setCameraPose({
        azimuth: SEATED.azimuth,
        elevation: PRISM_EL,
        distance: prismDist(PRISM_ORTHO_FOV),
        fov: PRISM_ORTHO_FOV,
      });
    },
    apply(p, api) {
      // beat 2 window: barrel cut away, the camera travels through the glass
      // assembly alone. "glass", not "optics" — the authored iris metal reads
      // as a stark white puck on the dark stage; the through-ribbon bridges
      // the assembly's real mid air gap instead.
      api.scene.setIsolate(
        p >= PRISM_ISO_ON && p < PRISM_ISO_OFF ? "glass" : null,
      );
      // flat→ink cut hidden in the ISO_ON snap (both directions): at the
      // boundary only the glass survives on screen, and glass is built
      // identically in both looks, so the swap itself is invisible — the cel
      // bands are simply back when the body returns at ISO_OFF.
      const look: ShadingMode = p < PRISM_ISO_ON ? "flat" : "ink";
      if (look !== prismLook) {
        api.scene.setShading(look);
        api.scene.swapShading(look); // retarget-only, as in the lookbook
        prismLook = look;
      }
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
        prism.setDrop(api.state.assemble * 2.1);
        // the passage recolors the light: rainbow → the site palette as the
        // glass "takes in" the scheme
        const k = smoothstep(0.4, 0.6, p);
        for (let i = 0; i < prismColors.length; i++)
          prismColors[i].copy(PRISM_RAINBOW[i]).lerp(PRISM_PALETTE[i], k);
        prism.setColors(prismColors);
      }
      // the stack spreads apart down the light path as the camera enters it,
      // then (structure back at ISO_OFF) wraps home around the glass
      api.state.assembleTarget =
        smoothstep(0.36, 0.5, p) * (1 - smoothstep(0.72, 0.95, p));
      // lay-back tumble DURING the pull-back (glass-only on screen): z π →
      // 3π/2 (≡ the boot −π/2), done before the ISO_OFF reveal so the wrap
      // plays out horizontal — the composition the Rise wrap was tuned on
      const stand = smoothstep(0.72, PRISM_ISO_OFF, p);
      api.scene.setModelOrientation({ z: Math.PI + (stand * Math.PI) / 2 });
      // camera: hold the diagram framing, dive to the mount, descend the
      // stack (the model stays put — the camera does the traveling), then
      // pull back out into the seated pose. The three moves are sequential,
      // so chained lerps compose cleanly.
      const dive = smoothstep(0.3, 0.38, p);
      const descend = smoothstep(0.38, 0.66, p);
      // perspective returns across the dive: ortho diagram fov → the boot fov
      // the descent was tuned at, with the framing-locked pullback collapsing
      // in step so the lens holds its size until the plunge takes over
      const fov = lerp(PRISM_ORTHO_FOV, PRISM_DIVE_FOV, dive);
      // pull-back begins the moment the descent lands and overshoots past the
      // seated distance, so the ISO_OFF reveal fires wide — the wrap sheets
      // read as a composition, not giant planes filling a close-up; the final
      // seat brings the camera home
      const out = smoothstep(0.64, 0.74, p);
      const seat = smoothstep(0.84, 0.98, p);
      let targetY = lerp(0, PRISM_DIVE_Y, dive);
      targetY = lerp(targetY, PRISM_EXIT_Y, descend);
      // recenter FASTER than the distance pull, so the spread glass column is
      // centered full-frame BEFORE the lay-back tumble starts
      targetY = lerp(targetY, 0, smoothstep(0.64, 0.72, p));
      let dist = lerp(prismDist(fov), PRISM_NEAR_DIST, dive);
      dist = lerp(dist, BASE_DIST * 1.45, out);
      dist = lerp(dist, BASE_DIST, seat);
      api.scene.setCameraPose({
        azimuth: SEATED.azimuth,
        elevation: lerp(PRISM_EL, SEATED.elevation, seat),
        distance: dist,
        fov,
        targetY,
      });
      // near-black stage for the diagram; the cream site ground rises with
      // the wrap
      api.setPageWipe({
        p: lerp(0, 0.85, smoothstep(PRISM_ISO_OFF, 0.97, p)),
        skewDeg: -6,
        below: CREAM,
        above: NEAR_BLACK,
      });
    },
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.setPageWipe(null);
      api.scene.setIsolate(null);
      api.scene.setModelOrientation(null);
      api.scene.setOverlayPass(null);
      if (prism) {
        prism.dispose();
        prism = null;
      }
      api.state.assembleTarget = 0;
      api.scene.setShading(prismSaved);
      api.scene.swapShading(prismSaved);
    },
  },

  {
    id: "d-ribbons",
    label: "Ribbon field",
    hint: "solid ribbons snake around the lens on independent paths, then settle into one rainbow band",
    durationMs: 14000,
    enter(api) {
      // ink on the dark stage (the lookbook-validated pairing); instant land
      // + retarget-only follow-up, as in the lookbook
      ribbonsSaved = api.scene.getShading();
      api.scene.setShading("ink");
      api.scene.swapShading("ink");
      api.scene.setTransparentBackground(true);
      ribbons = createRayField(7, () => api.scene.invalidate());
      api.scene.setOverlayPass((renderer, camera) =>
        ribbons?.render(renderer, camera),
      );
      // channels parked once; the model just sits seated — the rays are the show
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      api.scene.setCameraPose({
        azimuth: SEATED.azimuth,
        elevation: SEATED.elevation,
        distance: RIB_FRAME / Math.tan((RIB_FOV * Math.PI) / 360),
        fov: RIB_FOV,
      });
    },
    apply(p, api) {
      if (!ribbons) return;
      // full-frame dark stage behind the transparent canvas
      api.setPageWipe({
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
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.setPageWipe(null);
      api.scene.setOverlayPass(null);
      if (ribbons) {
        ribbons.dispose();
        ribbons = null;
      }
      api.scene.setShading(ribbonsSaved);
      api.scene.swapShading(ribbonsSaved);
    },
  },

  {
    id: "d-genie",
    label: "Genie",
    hint: "the lens funnels macOS-style into a dock bar, then springs back",
    durationMs: 9000,
    enter(api) {
      // ink on the cream poster ground; instant land + retarget-only follow-up
      genieSaved = api.scene.getShading();
      api.scene.setShading("ink");
      api.scene.swapShading("ink");
      api.scene.setTransparentBackground(true);
      uGenieTarget.value.set(...GENIE_T);
      // the flat 2D dock bar (design law: only the lens reads 3D) — an unlit
      // rounded slab at the funnel target's world point, facing the camera
      const w = 1.7;
      const h = 0.2;
      const r = 0.1;
      const shape = new Shape();
      shape.moveTo(-w / 2 + r, -h / 2);
      shape.lineTo(w / 2 - r, -h / 2);
      shape.absarc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2, false);
      shape.lineTo(-w / 2 + r, h / 2);
      shape.absarc(-w / 2 + r, 0, r, Math.PI / 2, (3 * Math.PI) / 2, false);
      genieDock = new Mesh(
        new ShapeGeometry(shape),
        new MeshBasicMaterial({
          color: new Color(NEAR_BLACK),
          transparent: true,
          opacity: 0,
        }),
      );
      genieDock.position.copy(MODEL_TO_WORLD(GENIE_T));
      // face the fixed demo pose (applyCameraPose's spherical convention)
      const { azimuth: az, elevation: el, distance: d } = GENIE_POSE;
      genieDock.lookAt(
        d * Math.cos(el) * Math.sin(az),
        d * Math.sin(el),
        d * Math.cos(el) * Math.cos(az),
      );
      genieDock.raycast = () => {};
      api.scene.addOverlay(genieDock);
      // channels parked once; genie is the only mechanism drive
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      api.scene.setCameraPose(GENIE_POSE);
    },
    apply(p, api) {
      // cream poster ground with the ink caption
      api.setPageWipe({ p: 1, skewDeg: 0, below: CREAM, above: CREAM });
      // one scrub: suck → hold docked → springy restore. All pure functions of
      // p (the spring is a sampled easing, not playback), so the scrub stays
      // deterministic and bidirectional; Play just sweeps p.
      let g = smoothstep(0.03, GENIE_SUCK_END, p);
      let nod = 0;
      if (p > GENIE_RELEASE) {
        const u = (p - GENIE_RELEASE) / (1 - GENIE_RELEASE);
        const sv = genieSpring(u); // 0 → 1 with overshoot past 1
        g = Math.max(0, 1 - sv);
        nod = Math.max(0, sv - 1); // the overshoot lands as a little nod
      }
      api.state.genieTarget = g;
      api.scene.setModelOrientation(
        nod > 1e-4 ? { z: -Math.PI / 2 + nod * 5 } : null,
      );
      // dock bar: fades in as the suck begins, swells as the lens lands in it
      if (genieDock) {
        const mat = genieDock.material as MeshBasicMaterial;
        mat.opacity = smoothstep(0.02, 0.1, p);
        const pulse =
          smoothstep(GENIE_SUCK_END - 0.12, GENIE_SUCK_END, p) *
          (1 - smoothstep(GENIE_RELEASE, GENIE_RELEASE + 0.12, p));
        genieDock.scale.setScalar(1 + 0.18 * pulse);
      }
      api.setPageText({
        front: {
          text: "",
          sub: "MINIMIZE — AND BRING IT BACK",
          color: NEAR_BLACK,
          y: 0.9,
          opacity: smoothstep(0.05, 0.2, p),
        },
      });
    },
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.scene.setModelOrientation(null);
      api.setPageWipe(null);
      api.state.genieTarget = 0;
      if (genieDock) {
        api.scene.removeOverlay(genieDock);
        genieDock.geometry.dispose();
        (genieDock.material as MeshBasicMaterial).dispose();
        genieDock = null;
      }
      api.scene.setShading(genieSaved);
      api.scene.swapShading(genieSaved);
    },
  },

  {
    id: "d-clockparts",
    label: "Piece by piece",
    hint: "rings, screws, glass and iris each answer alone — a staggered mechanical ballet",
    durationMs: 11000,
    enter(api) {
      // ink on the dark stage (the lookbook-validated pairing)
      clockSaved = api.scene.getShading();
      api.scene.setShading("ink");
      api.scene.swapShading("ink");
      api.scene.setTransparentBackground(true);
      clockTl = buildClockTimeline();
      // channels parked once; the timeline drives aperture (the iris wink)
      api.state.zoomTarget = 0;
      api.state.focusTarget = 0;
      api.state.apertureTarget = 0;
      api.scene.setCameraPose({
        azimuth: 1.05,
        elevation: 0.22,
        distance: BASE_DIST,
      });
    },
    apply(p, api) {
      if (!clockTl) return;
      api.setPageWipe({
        p: 1,
        skewDeg: 0,
        below: NEAR_BLACK,
        above: NEAR_BLACK,
      });
      // the scrub drives the anime timeline via seek() (scrub-safe, both
      // directions); the resolved values flow into setPartOffset each frame
      clockTl.seek(p * clockTl.duration);
      applyClockOffsets(api);
      // camera follows the beat groups: front three-quarter for the ring/
      // glass/iris beats, one swing to the mount side for the hardware beats,
      // settling toward a near-frontal mount view for the finale
      const swing = smoothstep(0.36, 0.55, p);
      const settle = smoothstep(0.8, 1, p);
      const azFront = lerp(1.05, 0.85, smoothstep(0, 0.3, p));
      const azRear = lerp(-0.62, -0.25, settle);
      api.scene.setCameraPose({
        azimuth: lerp(azFront, azRear, swing),
        elevation: lerp(0.22, 0.14, p),
        distance: BASE_DIST * lerp(1, 1.08, swing),
      });
      api.setPageText({
        front: {
          text: "",
          sub: "EVERY PART, ON ITS OWN BEAT",
          color: CREAM,
          y: 0.9,
          opacity: smoothstep(0.04, 0.16, p),
        },
      });
    },
    exit(api) {
      api.scene.setCameraPose(null);
      api.scene.setTransparentBackground(false);
      api.setPageWipe(null);
      api.scene.clearPartOffsets();
      api.state.apertureTarget = 0;
      clockTl = null;
      api.scene.setShading(clockSaved);
      api.scene.swapShading(clockSaved);
    },
  },
];
