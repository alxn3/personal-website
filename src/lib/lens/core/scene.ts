import * as THREE from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  disposeLensModel,
  GLASS_SPECULAR,
  loadLensModel,
  setLensEnvironment,
} from "./model";
import { createShading, type ShadingMode } from "../materials/shading";
import {
  createUnified,
  cutInkEdges,
  uInteriorFade,
  uShellFade,
} from "../materials/unified";
import { deriveFrames } from "../ops/frames";
import {
  recipeChannel,
  recipeChannels,
  recipeKnobs,
  reportOpsFrames,
  setDeformBackend,
  RECIPE_NAMES,
} from "../ops/host";
import { writeFadeBands } from "../materials/depthfade";
import {
  sampleStory,
  applyStoryFraming,
  type DiveFraming,
} from "../story/camera";
import { createMechanism, tagMechanismSpins } from "../ops/mechanism";
import { createCinematics } from "../story/cinematics";
import { isAccessory, isOpticalGlass } from "./parts";
import { clamp01, smoothstep, lerp } from "./math";
import {
  stampWinkLanes,
  winkGone,
  type WinkThreshold,
  sweepVisibility,
  type VisibilityGates,
} from "./visibility";
import {
  TRANSITIONS,
  type TransitionContext,
  type TransitionName,
  type TransitionRun,
} from "./transitions";
// Type-only: erased at build, so the dev instruments stay out of every bundle
// until their dynamic imports run.
import type { PathViz } from "../dev/paths";
import type { Inspector } from "../dev/inspect";

export type { ShadingMode } from "../materials/shading";
export type { PathViz } from "../dev/paths";
export type { TransitionName } from "./transitions";

/** Options for SceneHandle.swapShading — see the method's doc comment. */
export interface SwapShadingOptions {
  /** which choreography carries the cut (default "blink") */
  transition?: TransitionName;
  /** total transition length; each transition has its own default */
  durationMs?: number;
  /** "twist" only: full integer turns per swap (default 1) */
  turns?: number;
  /** Per-frame raw progress (0..1), for page-side cooperation such as a flash
   *  synced to the swap beat. Not called when the swap collapses to instant. */
  onProgress?: (t: number) => void;
}

// Scene orchestration: renderer, camera, lights, model load, state easing and
// the per-frame tick. The parts that do things live in focused modules. This
// orchestrator wires the story camera and cinematics even for the free-orbit
// /lens viewer, so there is one assembly path.

/** One channel's registry entry: its rest/default value plus the per-channel
 *  flags every derived list keys off. */
interface ChannelSpec {
  /** rest value and markup default (also the ease target at boot) */
  default: number;
  /** Animation-owned: /lens rests this channel's target on animation
   *  switch/None. Slider channels are restored separately and are not flagged
   *  — except explode, which is both. */
  animReset?: boolean;
  /** Recipe channel the instrument's idle-identity check must zero before
   *  probing seated geometry: at 0 the deform graph is an exact identity. */
  idleZero?: boolean;
}

/**
 * The channel registry — one row per channel, and the one list every
 * per-channel site derives from. `default` is also the rest value (0
 * everywhere: a recipe channel at 0 is a bit-exact identity). CHANNEL_DEFAULTS
 * feeds SceneState typing, the state initializer and tick()'s ease loop; the
 * two flags derive ANIM_RESET_CHANNELS and IDLE_ZERO_CHANNELS. Every motion
 * channel below the mechanism trio is an op recipe channel driven through
 * ops/host's `recipeChannel`.
 */
const CHANNEL_REGISTRY = {
  /** 0 (18mm, retracted) .. 1 (50mm, extended) */
  zoom: { default: 0 },
  /** 0 (infinity) .. 1 (min focus, ~0.12m) */
  focus: { default: 0 },
  /** 0 (f/2.8, wide open) .. 1 (f/22, closed down) */
  aperture: { default: 0 },
  /** 0 (seated anatomy) .. 1 (the bare core drawn axially compact) — the
   *  story's cards chapter only; /lens never writes it */
  huddle: { default: 0 },
  /** explode ladder recipe: 0 (assembled) .. 1 (parts spread along the axis) */
  explode: { default: 0, animReset: true, idleZero: true },
  /** reassembly spread: 0 (seated) .. 1 (sheets unwrapped, off the ladder) */
  assemble: { default: 0, animReset: true, idleZero: true },
  /** the story's unroll recipe, scoped to the shell cast: 0 (seated) .. 1
   *  (rolled out flat). Driven by the peel scene, not by a /lens slider. */
  peel: { default: 0, animReset: true, idleZero: true },
  /** the origami-bloom recipe: 0 (seated) .. 1 (petals hinged open in ranked
   *  whorl waves). Driven by the story's ending and by the /lens bench. */
  rose: { default: 0, animReset: true, idleZero: true },
  /** 0..1 scroll-story progress; drives the scripted camera (hero) */
  story: { default: 0 },
} satisfies Record<string, ChannelSpec>;
type Channel = keyof typeof CHANNEL_REGISTRY;
const CHANNELS = Object.keys(CHANNEL_REGISTRY) as Channel[];
/** `${c}Target` per channel, spelled once — tick()'s ease loop reads it. */
const TARGET_KEYS = CHANNELS.map((c) => `${c}Target`) as `${Channel}Target`[];
// `satisfies` keeps each entry's literal type, so the optional flags are not
// visible on entries that omit them — read specs back through this view.
const specOf = (c: Channel): ChannelSpec => CHANNEL_REGISTRY[c];

/** Rest/default value per channel — the numeric view of the registry. */
export const CHANNEL_DEFAULTS = Object.fromEntries(
  CHANNELS.map((c) => [c, CHANNEL_REGISTRY[c].default]),
) as Record<Channel, number>;

/** Channels /lens rests to their default on animation switch/None. Derived,
 *  so a new animReset channel needs no edit in the page. */
export const ANIM_RESET_CHANNELS = CHANNELS.filter((c) => specOf(c).animReset);

/** Every deform channel the instrument's idle-identity check zeroes. Derived,
 *  so a new deform channel can't silently fall out of the contract. */
export const IDLE_ZERO_CHANNELS = CHANNELS.filter((c) => specOf(c).idleZero);

export type { Channel };

/** The one ease every channel runs on: the share of the remaining distance a
 *  60 Hz frame closes. `easeK` rescales it to the frame's real dt. */
export const CHANNEL_EASE = 0.22;
/** the frame CHANNEL_EASE is authored per, ms */
export const EASE_FRAME_MS = 1000 / 60;
/** the longest dt one tick may integrate, ms — a tab coming back glides */
export const EASE_DT_MAX_MS = 100;
/** a channel this close to its target snaps onto it and stops moving */
const STATE_EPS = 1e-4;

/** The ease for a frame of `dt` ms: the same settle time at any refresh rate,
 *  and exactly CHANNEL_EASE at a 60 Hz frame. */
export const easeK = (dt: number): number =>
  dt === EASE_FRAME_MS
    ? CHANNEL_EASE
    : 1 - Math.pow(1 - CHANNEL_EASE, dt / EASE_FRAME_MS);

/** One ease step of a channel toward its target over `dt` ms, snapping onto
 *  the target inside STATE_EPS so a settled channel is exactly at rest. */
export const easeStep = (value: number, target: number, dt: number): number => {
  const next = lerp(value, target, easeK(dt));
  return Math.abs(target - next) < STATE_EPS ? target : next;
};

/**
 * Scene state. Each *Target is set instantly; tick() eases the live value
 * toward it every frame. Channel semantics live on CHANNEL_REGISTRY above.
 */
export type SceneState = { [K in Channel]: number } & {
  [K in Channel as `${K}Target`]: number;
};

export type AccessoryGroup = "hood" | "filter" | "caps";

/** A spherical camera pose: `distance` from (targetX ?? 0, targetY ?? 0, 0) at
 *  `azimuth`/`elevation` (radians, azimuth from +z toward +x), looking at that
 *  target. Nothing writes one to the camera — the story parks its rig and
 *  dollies the lens, reading these only for the displacement and the fov. */
export interface CameraPose {
  azimuth: number;
  elevation: number;
  distance: number;
  fov?: number;
  targetX?: number;
  targetY?: number;
}

/** Screen-space position of a tracked model node, in CSS px over the canvas. */
export interface TrackedPoint {
  x: number;
  y: number;
}

/** One optical element's axial span in the gltf frame, in millimetres, keyed
 *  by node name; its length is that element's refraction thickness. The caller
 *  derives the table — importing optics/prescription.ts here would drag the
 *  whole optics tree into the shared homepage chunk. */
export interface GlassSpanMm {
  frontYmm: number;
  rearYmm: number;
}

/** Roughness on the transmissive clones. three drives the refraction blur off
 *  roughness, so a touch of it softens the internals seen through the glass. */
const GLASS_TRANSMISSIVE_ROUGHNESS = 0.05;

/** The clones' unscaled specular, restated from the shipped glass because
 *  `setGlassGlint` scales it. At three's default 1 each element mirrors
 *  `scene.environment` so brightly the glass reads as chrome.
 *  `envMapIntensity` cannot substitute — it is inert on a node material lit by
 *  a scene environment. */
const GLASS_TRANSMISSIVE_SPECULAR = GLASS_SPECULAR;

/** Every slot that can put a colour on the transmissive clones, set to
 *  neutral. Reflectivity is untouched: the Fresnel is IOR-driven, and zeroing
 *  it would make the elements read as holes. */
const GLASS_DETINT = {
  color: 0xffffff,
  specularColor: 0xffffff,
  attenuationColor: 0xffffff,
  attenuationDistance: Infinity,
  /** 0 = colourless coating; raise it to bring the coloured coating back. */
  iridescence: 0,
};

export interface SceneHandle {
  state: SceneState;
  /** Show/hide a removable accessory group (all hidden by default). */
  setAccessory: (group: AccessoryGroup, visible: boolean) => void;
  /** Swap the render style (materials) for the whole model. */
  setShading: (mode: ShadingMode) => void;
  /** /lens only: load the shading bench, dynamically imported so the hero
   *  never fetches it. Await it before offering a bench look — setShading and
   *  swapShading stay synchronous, so a bench mode asked for before this
   *  resolves is refused. Idempotent; false if the chunk failed. */
  enableShadingBench: () => Promise<boolean>;
  /** Blend the story's pair rather than swapping: 0 = realistic, 1 = ink,
   *  between = both at once. The two share one material, so this is a uniform
   *  write; a bench look wears its own materials and ignores the blend. */
  setInkMix: (v: number) => void;
  /** Swap the render style through a choreographed transition: the rebuild
   *  fires at the choreography's hidden peak and everything driven is restored
   *  bit-exactly. A swap in flight is retargeted, not stacked;
   *  prefers-reduced-motion or a declining transition cuts instantly. */
  swapShading: (mode: ShadingMode, opts?: SwapShadingOptions) => void;
  /** Follow the site theme (light = no `.dark` on <html>): re-palettes the
   *  shading mode and re-tints the cinematic extras. The initial theme is
   *  self-detected at creation; the page calls this on toggle. */
  setTheme: (light: boolean) => void;
  /** Stop/restart the render loop entirely, e.g. when the hero scrolls out of
   *  view, where a live rider (cards, petals) would otherwise keep it awake. */
  setPaused: (paused: boolean) => void;
  /** Force one repaint. /lens only redraws while a channel eases or dirty is
   *  set, so a bare uniform tweak needs this to show. */
  invalidate: () => void;
  /** Story mode: run a callback before every drawn frame with the eased story
   *  p and the tick's dt (ms, clamped). Everything the 3D frame draws — channel
   *  values, orientation, fades, riders' phase clocks — is written here at
   *  `pE`. A callback returns true on a frame it moved something on its own
   *  clock, which draws the next frame; an idle scene otherwise sleeps. */
  onEvaluate: (cb: (pE: number, dt: number) => boolean | void) => void;
  /** Run a callback after every rendered frame with a projector from node name
   *  to screen position (CSS px, null if missing or behind the camera) and the
   *  tick's dt. The op deform runs in-shader, so an exploded piece's anchor is
   *  its seated position. Returning true draws the next frame. */
  onFrame: (
    cb: (
      project: (name: string, out: TrackedPoint) => TrackedPoint | null,
      dt: number,
    ) => boolean | void,
  ) => void;

  /** Dev: motion-path overlay for the canned animations. Dynamically
   *  imported; returns null if the visualizer can't start. */
  enablePathViz: (
    onStatus: (text: string, ok: boolean) => void,
  ) => Promise<PathViz | null>;
  /** Dev: piece-name inspector — hover a mesh to read its node name, click to
   *  copy. Dynamically imported; resolves false if it couldn't start. */
  enableInspect: (on: boolean) => Promise<boolean>;
  /** The dive's sky — drawn into the opaque pass so three's transmission copy
   *  picks it up and the glass refracts it. While mounted it also owns
   *  `scene.background`. Resolves false if it couldn't start. */
  enableStarfield: (on: boolean) => Promise<boolean>;
  /** Route the frame through the screen-space wormhole — scene → target →
   *  radial pinch about the exit axis → canvas. `false` restores the direct
   *  render; resolves false if it couldn't start. */
  enableWormholePost: (on: boolean) => Promise<boolean>;
  /** Build the pass without mounting it, so its render targets — the dive's
   *  largest single allocation — are paid for on their own frame rather than
   *  the mount's. Idempotent. */
  buildWormholePost: () => Promise<boolean>;
  /** Pay the fly-through's compile early: draw one frame of the dive's look
   *  into a 1×1 target, leaving no channel, latch or look changed. Must be a
   *  real frame through the real pass, not compileAsync — three keys a pipeline
   *  on the render context as well as the shader. Idempotent. */
  warmFly: (spans: Record<string, GlassSpanMm>) => Promise<boolean>;
  /** Pay an object's upload early: draw it once into a 1×1 target, so its
   *  vertex buffers, textures and pipeline are resident before the frame that
   *  first shows it. Unparented objects are mounted for that draw only, and
   *  frustum culling is off so the draw cannot be skipped. `viaPass` also draws
   *  it through the dive's post pass, whose format and sample count key a
   *  second pipeline. */
  warmDraw: (objects: THREE.Object3D[], viaPass?: boolean) => void;
  /** Dev: drive the camera from `state.story` through the same code path the
   *  hero runs instead of OrbitControls. Off restores the saved orbit pose;
   *  no-op in story mode, where the hero already owns the camera. */
  setStoryCamera: (on: boolean) => void;
  /** Story mode only: per-frame fov override for the fly-through, laid over
   *  the story's pose; `mix` blends against the story's own fov, null releases.
   *  The pose is never overridden — the dive translates the lens past a parked
   *  camera. */
  setStoryFov: (fov: number | null, mix?: number) => void;
  /** Story mode only: how much the dive owns the framing — 0 = the story's
   *  park/lift view offset, 1 = dead centre, which is what a bore shot down the
   *  optical axis wants. */
  setStoryCentre: (k: number) => void;
  /** Show/hide the ambient cinematics dust. The fly-through clears it so the
   *  starfield reads; everything else leaves it on. */
  setDust: (visible: boolean) => void;
  /** Leave every element drawn and transmissive, so three's transmission path
   *  refracts the internals and the starfield through it. `spans` supplies each
   *  element's thickness and is read only on the enabling call; `false`
   *  restores the materials captured at enable. */
  setGlassTransmissive: (
    on: boolean,
    spans?: Record<string, GlassSpanMm>,
  ) => void;
  /** Attach a presentation object to the LENS: parented under an anchor at the
   *  model's visual centre, in world units on the rest-world axes (bore along
   *  +X), that rides the model's live orientation and dolly. The caller owns
   *  disposal. */
  addModelOverlay: (obj: THREE.Object3D) => void;
  removeModelOverlay: (obj: THREE.Object3D) => void;
  /** The world-X extent of each named node, measured here because world X
   *  needs MODEL_SCALE and the recentring offset. A rest-pose snapshot — the
   *  in-shader deform is not in it, so call it with channels at rest. */
  worldAxialSpans: (
    ids: string[],
  ) => Record<string, { x0: number; x1: number }>;
  /** Fade the transmissive clones out together. At exactly 0 the meshes also
   *  drop out of applyVisibility, so no depth write or transmission ghost
   *  survives. A no-op unless the swap is on; cheap per frame. */
  setGlassFade: (opacity: number) => void;
  /** The passage fade — one opacity per element, multiplied by setGlassFade's
   *  stack-wide one; omitted ids hold their last value. Needed because three's
   *  transmission is screen-space: from inside an element the refraction offset
   *  smears the whole frame, so each element must be gone shortly before the
   *  near plane reaches it. */
  setGlassElementFade: (fades: Record<string, number>) => void;
  /** Scale the glints on the transmissive clones — setRoomLight's opposite
   *  number for the glass, separate because the room ramp leaves a floor bright
   *  enough to smudge glass meant to sit in a dark tube. Multiplies
   *  `specularIntensity`; resets to 1 when the swap goes off. */
  setGlassGlint: (level: number) => void;
  /** Fade the whole body — everything applyVisibility governs that is not
   *  optical glass. No clones, unlike the glass fade: model.ts's cache already
   *  collapses the body onto a handful of shared instances, so this writes
   *  `transparent`/`opacity` onto those and remembers what each wore. Both are
   *  restored at exactly 1, and at 0 the meshes also leave applyVisibility. */
  setBodyFade: (opacity: number) => void;
  /** Take the shell off the lens — the peel's cast, then the closed inner
   *  tubes, then the baffles last so the bore opens behind everything. Input is
   *  clamped: the story envelope may transiently leave [0,1].
   *
   *  The level goes to the materials as a uniform and each piece dissolves
   *  against its own `_opY.w` threshold (core/visibility.ts); a piece whose
   *  opacity has reached exactly 0 also leaves the visibility pass, so its draw
   *  drops. */
  setShellFade: (opacity: number) => void;
  /** The interior's own level, same mechanism on a second threshold set: the
   *  cladding and the rest-cast leave with the peel but come back over the
   *  internals tail, so the dive flies through the full interior while the
   *  shell and baffles stay off until the rewrap. */
  setInteriorFade: (opacity: number) => void;
  /** Scale the room — the PMREM'd environment and the studio lights together.
   *  The traced sky is not room light and does not dim with this. */
  setRoomLight: (level: number) => void;
  /** Snap the model GROUP to an absolute orientation (omitted axes keep their
   *  boot values), keeping the recentred visual centre on the origin. null
   *  restores the boot orientation. Composes with the twist transition, which
   *  rolls the inner gltf root. */
  setModelOrientation: (
    euler: { x?: number; y?: number; z?: number } | null,
  ) => void;
  /** Slide the model group along world X — how the fly-through dives. The
   *  camera parks and the lens travels past it, which needs no rig hand-off. */
  setLensDolly: (x: number) => void;
  /** Attach/detach a world-space presentation object at the scene root. The
   *  caller owns disposal. */
  addOverlay: (obj: THREE.Object3D) => void;
  removeOverlay: (obj: THREE.Object3D) => void;
  /** Attach an object as a child of the mounted starfield, so it rides that
   *  group's per-frame camera-centring. False while the starfield is unbuilt or
   *  unmounted — the mount is async, so ask again later. Idempotent. */
  starfieldAttach: (obj: THREE.Object3D) => boolean;
  /** Take an object back off the starfield (see starfieldAttach). */
  starfieldDetach: (obj: THREE.Object3D) => void;
  /** Blend the mounted starfield's backdrop `f` toward `rgb` (0-255 ints), so
   *  the background swap at the unmount cuts between near-identical frames. The
   *  caller must restore (`f = 0`) before unmounting — a no-op once
   *  unmounted. */
  setSkyDim: (f: number, rgb: [number, number, number]) => void;
  /** The live frame's vertical half-extent, in view-space units per unit of
   *  depth: `tan(fov/2) / zoom`. View-space overlays size themselves off this
   *  rather than re-deriving the zoom law below. */
  frameHalf: () => number;
  /** the frame's width in units of its own height — camera.aspect, live */
  frameAspect: () => number;
}

/** The zoom law: size the lens by the smaller viewport dimension, capped at
 *  the layout width. A perspective camera otherwise scales pixel size purely by
 *  viewport height, so zoom corrects with (capped min dimension) / height. */
export const frameZoom = (w: number, h: number, maxPx = Infinity): number =>
  Math.min(w, h, maxPx) / h;

/** …and how much of the story's horizontal lens-park a viewport gets: full on a
 *  wide screen, off on a phone, where the caption sits under the lens instead
 *  (story/camera.ts applies the portrait lift in its place). */
export const parkScaleFor = (w: number, h: number): number =>
  Math.max(0, Math.min(1, (w / h - 0.8) / 0.7));

// The GLB is exported in real-world millimetres, and glTF export converts
// Blender's Z-up to Y-up — so a Blender local z on these identity-rotated
// nodes is a local y here, and +z(front) ↦ +y. This scales mm to world units.
const MODEL_SCALE = 0.05;

/** The camera's far plane at rest — a floor, see `farFor`. */
const CAM_FAR = 400;

/** The far plane for one frame. The story's ortho flatten parks the camera far
 *  enough that a fixed plane would clip the whole model away. Only ever raised
 *  above the resting one, so nothing drawn on the camera can fall outside. */
export const farFor = (dist: number, radius: number): number =>
  Math.max(CAM_FAR, dist + radius * 8);

export interface SceneOptions {
  /** Multiplier on the default camera distance (>1 pulls back to frame the
   *  whole teardown; the /lens page keeps 1). */
  cameraDistance?: number;
  /** Scroll-story mode: scripts the camera from `state.story` and bypasses
   *  OrbitControls. Omit for the free-orbit /lens viewer. */
  story?: boolean;
  /** Load the removable accessories GLB. Defaults to `!story` — only /lens can
   *  show them. With it off, `setAccessory` is a no-op. */
  accessories?: boolean;
}

/**
 * Load-time model prep. The order is a dependency chain — do not reorder:
 *   1. deriveFrames      stamps the `_op*` attributes every graph reads
 *   2. stampWinkLanes    writes each piece's wink threshold onto `_opY.w`
 *   3. tagMechanismSpins tags off-axis pivots as baked nodes, not branches
 *   4. cutInkEdges       cuts the line-work off those attributes
 *   5. createUnified     builds the model's one deform material
 *   6. createShading     layers the bench swapper over it
 *
 * 1-4 are pure CPU passes and run in `prepModel` on the load chain, ahead of
 * this call; 5-6 build TSL graphs and cannot start before `setDeformBackend()`.
 */
function prepareModelMaterials(
  gltfScene: THREE.Object3D,
  inkEdges: Map<number, THREE.BufferGeometry>,
) {
  const unified = createUnified(gltfScene, inkEdges);
  const shading = createShading(gltfScene, unified);
  return { unified, shading };
}

/**
 * Steps 1-4 above, chained onto the model load so they overlap the WebGPU
 * adapter request instead of queueing behind it. `createMechanism` owns the
 * lead-screw pivot itself but must wait for the recentre, which is why the tag
 * pass is split out and runs here.
 */
async function prepModel(gltfScene: THREE.Object3D) {
  // One yield first: `renderer.init()` is a chain of GPU round trips, and an
  // unbroken CPU block starves the callback that issues the next one.
  await new Promise((r) => setTimeout(r, 0));
  const frames = deriveFrames(gltfScene);
  const winks = stampWinkLanes(gltfScene);
  tagMechanismSpins(gltfScene);
  performance.mark("lens:frames-derived");
  const inkEdges = cutInkEdges(gltfScene);
  performance.mark("lens:lines-cut");
  return { frames, winks, inkEdges };
}

/**
 * Boot the lens viewer onto `canvas`. One scene per document: the deform
 * channels, the recipe knobs, the active-recipe selection and the shading
 * uniforms are all module state, so two live scenes would fight. Destroy one
 * before booting another.
 */
/** The model group's boot roll about Z: it lays the gltf's optical axis (+Y)
 *  onto world +X, which every span that travels the bore is written against. At
 *  z = 0 the bore stands up instead, which is what the story tips it to for the
 *  internals scene. */
export const MODEL_BORE_X_Z = -Math.PI / 2;

/** The model overlay anchor (SceneHandle.addModelOverlay): the boot placement
 *  inverted under the model group, so its world matrix is the identity at boot
 *  and the model's live rotation about its visual centre thereafter. `center`
 *  is the model's world bounding-box centre under the boot placement,
 *  `bootQuatInv` the boot rotation's inverse. */
export function modelAnchorFor(
  center: THREE.Vector3,
  bootQuatInv: THREE.Quaternion,
): THREE.Group {
  const anchor = new THREE.Group();
  anchor.name = "Lens_ModelAnchor";
  anchor.position
    .copy(center)
    .applyQuaternion(bootQuatInv)
    .divideScalar(MODEL_SCALE);
  anchor.quaternion.copy(bootQuatInv);
  anchor.scale.setScalar(1 / MODEL_SCALE);
  return anchor;
}

export async function initScene(
  canvas: HTMLCanvasElement,
  opts: SceneOptions = {},
): Promise<SceneHandle> {
  performance.mark("lens:init-start");
  const storyMode = opts.story ?? false;
  // Kick the model fetch off first — it needs no renderer, and serializing it
  // behind the WebGPU adapter request is added latency. The body GLB alone
  // gates the first frame; accessories stream in behind it.
  const withAccessories = opts.accessories ?? !storyMode;
  const modelPromise = loadLensModel({ accessories: withAccessories }).then(
    async (loaded) => ({ ...loaded, ...(await prepModel(loaded.scene)) }),
  );
  // WebGPU (auto-falls back to WebGL2) — required for the TSL deform graph.
  // high-performance: this is a full-viewport hero.
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
    // Phones without WebGPU silently take three's WebGL2 backend, which
    // compiles the TSL graphs to GLSL. `?webgl` forces it on the desktop.
    forceWebGL: new URLSearchParams(location.search).has("webgl"),
  });
  // Story mode renders forever at full viewport, so cap its pixel ratio: far
  // fewer fragments per frame with no visible loss at hero scale. The /lens
  // bench only paints on interaction and keeps the full ratio.
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, storyMode ? 1.5 : 2),
  );
  renderer.setClearColor(0x000000, 0);
  await renderer.init();
  performance.mark("lens:renderer-ready");
  // The deform's dialect, set the moment the backend choice is final and before
  // prepareModelMaterials bakes it into a graph: the chain ships as generated
  // source and WGSL and GLSL are different files.
  setDeformBackend(
    (renderer as unknown as { backend?: { isWebGLBackend?: true } }).backend
      ?.isWebGLBackend
      ? "glsl"
      : "wgsl",
  );

  // Dev (`?diag`): a fixed status card readable off a phone. Must come after
  // `renderer.init()`, when the backend choice is final.
  const diag: import("../dev/diag").LensDiag | null =
    import.meta.env.DEV && new URLSearchParams(location.search).has("diag")
      ? { post: "unmounted" }
      : null;
  if (diag)
    void import("../dev/diag").then((m) => m.mountLensDiag(renderer, diag));

  // Dev (`?mtrace`): one row per rendered frame, written from tick().
  let motionTrace: import("../dev/motion-trace").MotionTrace | null = null;
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mtrace"))
    void import("../dev/motion-trace").then((m) => {
      motionTrace = m.mountMotionTrace();
    });

  const scene = new THREE.Scene();
  // far=400: the story's ortho holds pull the camera back far enough that a
  // 100 far plane would clip the lens away. A floor — the story-mode block
  // below raises it to follow the deepest pull-backs.
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, CAM_FAR);
  const camDist = opts.cameraDistance ?? 1;
  camera.position.set(3.5 * camDist, 1.6 * camDist, 5 * camDist);

  const environment = setLensEnvironment(renderer, scene);

  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(3, 5, 6);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 1.3);
  rim.position.set(-4, -1, -3);
  const hemi = new THREE.HemisphereLight(0xf1f5f9, 0x8090a0, 0.9);
  scene.add(key, rim, hemi);

  // Room light (setRoomLight): the IBL and the three lights above, which a dive
  // into the barrel puts out together. Boot values captured so the ramp is a
  // pure scale. Never `scene.backgroundIntensity`, which is the sky's.
  const roomLightBoot = {
    env: scene.environmentIntensity,
    key: key.intensity,
    rim: rim.intensity,
    hemi: hemi.intensity,
  };
  let roomLight = 1;

  // --- real lens model (Blender exterior + optics, GLB) --------------------
  const modelGroup = new THREE.Group();
  modelGroup.rotation.z = MODEL_BORE_X_Z;
  modelGroup.scale.setScalar(MODEL_SCALE);
  scene.add(modelGroup);

  const {
    scene: gltfScene,
    accessoriesReady: accessoriesLoad,
    frames,
    winks,
    inkEdges,
  } = await modelPromise;
  // A never-rejecting handle to the accessories load, so every consumer below
  // can `.then` without its own catch: on failure they simply never appear.
  const accessoriesReady = accessoriesLoad.catch((err) => {
    console.warn("lens: accessories failed to load (hood/caps/filter)", err);
  });
  performance.mark("lens:model-loaded");
  modelGroup.add(gltfScene);
  // Dev (`?probe`): the raw model root on window, so a part can be addressed by
  // name from the console.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("probe"))
    (window as unknown as Record<string, unknown>).__lensModel = gltfScene;

  // Roll the lens upright about its own optical axis (gltf-local +Y). Rig-safe
  // because every mechanism and recipe theta is defined along or about that
  // axis, so this only re-phases the start angle.
  gltfScene.rotation.y = Math.PI / 2;

  const { unified, shading } = prepareModelMaterials(gltfScene, inkEdges);
  performance.mark("lens:materials-ready");
  if (import.meta.env.DEV) {
    reportOpsFrames(gltfScene, frames);
    // Model-contract tripwire, after deriveFrames — half the contract is about
    // its frames.
    void import("../dev/model-contract").then(({ reportModelContract }) =>
      reportModelContract(
        {
          scene: gltfScene,
          hasAccessories: withAccessories,
          accessoriesReady,
        },
        frames,
      ),
    );
    // `window.__lensPrescriptionProbe()` measures the optical elements and
    // prints a paste-ready table for optics/prescription.ts.
    void import("../dev/prescription-probe").then(
      ({ installPrescriptionProbe }) => installPrescriptionProbe(gltfScene),
    );
    (window as unknown as Record<string, unknown>).__lensOps = {
      frames,
      channels: recipeChannels(),
      knobs: recipeKnobs(),
    };
  }

  const node = (name: string) => gltfScene.getObjectByName(name);

  // Removable accessories, hidden by default. They load in the background, so
  // these groups start empty and are populated once that settles.
  const accessories: Record<AccessoryGroup, THREE.Object3D[]> = {
    hood: [],
    filter: [],
    caps: [],
  };
  // The page's live accessory choice, so the background load applies the latest
  // desired visibility on arrival. `setAccessory` is the only writer.
  const accessoryOn: Record<AccessoryGroup, boolean> = {
    hood: false,
    filter: false,
    caps: false,
  };

  // Recentre the model's visual centre on the world origin, which is what
  // OrbitControls orbits. Measured over the bare lens only — Box3 ignores
  // `.visible`, so accessories would otherwise skew the centre.
  modelGroup.updateWorldMatrix(true, true);
  const bbox = new THREE.Box3();
  const meshBox = new THREE.Box3();
  gltfScene.traverse((o) => {
    if (o instanceof THREE.Mesh && !isAccessory(o.name)) {
      bbox.union(meshBox.setFromObject(o));
    }
  });
  const center = bbox.getCenter(new THREE.Vector3());
  modelGroup.position.sub(center);
  // World radius of the assembled lens. The depth-fade planes are placed
  // relative to it each frame, so the body sits in the full-opacity middle and
  // only exploded pieces cross a plane and dissolve.
  const modelRadius = bbox.getBoundingSphere(new THREE.Sphere()).radius;

  // Boot pose, for setModelOrientation: the recentring offset is only correct
  // under the boot rotation, so a reorient re-derives it as
  // p = R_new · R0⁻¹ · p_boot to keep the visual centre on the origin.
  const bootRotation = modelGroup.rotation.clone();
  const bootPosition = modelGroup.position.clone();
  const bootQuatInv = modelGroup.quaternion.clone().invert();

  const modelAnchor = modelAnchorFor(center, bootQuatInv);
  modelGroup.add(modelAnchor);
  modelAnchor.updateWorldMatrix(true, false);

  /** The dive's dolly along world X (setLensDolly). */
  let dollyX = 0;

  /** The only writer of modelGroup.position: the recentring offset re-derived
   *  under the current rotation, plus the dolly. Both setters compose through
   *  here because the recentre is a whole-vector write. */
  function applyModelPlacement() {
    modelGroup.position
      .copy(bootPosition)
      .applyQuaternion(bootQuatInv)
      .applyQuaternion(modelGroup.quaternion);
    modelGroup.position.x += dollyX;
    dirty = true;
  }

  // Both resolve nodes after the recentre: the lead-screw pivot math reads
  // world positions.
  const mechanism = createMechanism(gltfScene);
  const cinematics = createCinematics(scene, gltfScene);

  let dirty = true;

  /** Accessory-ness by ancestry: accessories merge into the body's graph and
   *  their sub-meshes carry generic names, so only the walk up tells them
   *  apart. */
  function underAccessory(o: THREE.Object3D): boolean {
    for (let a: THREE.Object3D | null = o; a; a = a.parent)
      if (isAccessory(a.name)) return true;
    return false;
  }

  // Transmissive glass (setGlassTransmissive): a swap, not a flag. The shipped
  // glass already has transmission and IOR but `thickness` is 0, and three
  // scales the refraction ray by it. Thickness is per element while all of them
  // share one material instance, so each needs its own clone — cloned, never
  // fresh, so ops/host's deform graph comes across.
  //
  // The look swapper re-materials every mesh and knows nothing about these
  // clones, so the restore only ever touches meshes still wearing the clone it
  // made. A site theme flip on a bench look is the one path no ordering can
  // fix, so setTheme re-seats: the theme work lands, then the swap is re-made
  // on top of it from the spans kept below, carrying the fades across.
  let glassTransmissive = false;
  /** the spans last enabled with, so a theme flip can re-make the swap
   *  without the caller being involved */
  let glassSpans: Record<string, GlassSpanMm> = {};
  /** what each swapped mesh wore before, and the clones we own. */
  const glassSavedMaterial = new Map<THREE.Mesh, THREE.Material>();
  const glassClones = new Set<THREE.Material>();
  /** The clones outlive the swap: a fresh material is a fresh pipeline, and
   *  three compiles one on the frame that first draws it, so each clone is kept
   *  here and handed back on the next crossing. An entry is dropped only when
   *  the mesh's own material changed under it. */
  const glassCloneCache = new Map<
    THREE.Mesh,
    { src: THREE.Material; clone: THREE.MeshPhysicalNodeMaterial }
  >();
  /** the same clones and meshes grouped by element — what the passage fade
   *  writes through. Rebuilt with the clones; the fade levels survive it. */
  const glassElementClones = new Map<string, THREE.Material[]>();
  const glassElementMeshes = new Map<string, THREE.Mesh[]>();
  /** setGlassFade: the stack-wide opacity. */
  let glassFade = 1;
  /** setGlassElementFade: the per-element multiplier, absent = 1. */
  const glassElementFade = new Map<string, number>();
  /** setGlassGlint: the multiplier on GLASS_TRANSMISSIVE_SPECULAR. Held here
   *  and not on the clones, which are re-made on every theme flip. */
  let glassGlint = 1;
  /** every mesh whose effective opacity (the product of the two fades) has
   *  reached 0 — the set applyVisibility reads. An element at alpha 0 still
   *  costs a transmission draw and still writes depth. */
  const glassGone = new Set<THREE.Mesh>();

  /** Push `glassFade × glassElementFade[id]` onto every clone and keep
   *  `glassGone` in step. Returns true if the gone-set moved, i.e. the caller
   *  owes a visibilityDirty mark. */
  function writeGlassOpacity(): boolean {
    let goneMoved = false;
    for (const [id, clones] of glassElementClones) {
      const o = glassFade * (glassElementFade.get(id) ?? 1);
      for (const c of clones) c.opacity = o;
      const gone = o <= 0;
      for (const m of glassElementMeshes.get(id) ?? []) {
        if (gone === glassGone.has(m)) continue;
        goneMoved = true;
        if (gone) glassGone.add(m);
        else glassGone.delete(m);
      }
    }
    return goneMoved;
  }

  /** The clone `m` wears while the swap is on — cached if the mesh still wears
   *  the material it was cloned from, fresh otherwise. The two values that are
   *  not the source's (thickness, glint) are re-applied on every hand-back;
   *  both are plain scalars, so neither recompiles. */
  function glassCloneFor(
    m: THREE.Mesh,
    src: THREE.Material,
    thickness: number,
  ): THREE.MeshPhysicalNodeMaterial {
    const hit = glassCloneCache.get(m);
    if (hit && hit.src === src) {
      hit.clone.thickness = thickness;
      hit.clone.specularIntensity = GLASS_TRANSMISSIVE_SPECULAR * glassGlint;
      return hit.clone;
    }
    hit?.clone.dispose(); // stale: the mesh wears a different material now
    const clone = src.clone() as THREE.MeshPhysicalNodeMaterial;
    clone.transmission = 1;
    clone.ior = 1.52;
    clone.roughness = GLASS_TRANSMISSIVE_ROUGHNESS;
    // …times the glint level, applied here like the detint below, so a theme
    // re-seat mid-dive comes back at the darkness the dive had reached.
    clone.specularIntensity = GLASS_TRANSMISSIVE_SPECULAR * glassGlint;
    clone.thickness = thickness;
    // Colourless (GLASS_DETINT), applied here so a theme re-seat detints too.
    // Whole Color objects, not `.setHex`: these slots exist only on a physical
    // material, so a mutation would throw where an assignment is inert.
    clone.color = new THREE.Color(GLASS_DETINT.color);
    clone.specularColor = new THREE.Color(GLASS_DETINT.specularColor);
    clone.attenuationColor = new THREE.Color(GLASS_DETINT.attenuationColor);
    clone.attenuationDistance = GLASS_DETINT.attenuationDistance;
    clone.iridescence = GLASS_DETINT.iridescence;
    // Marked transparent once here and not when the fade first moves:
    // `transparent` picks the render list, so flipping it mid-dive would
    // re-sort and recompile the whole stack.
    clone.transparent = true;
    glassCloneCache.set(m, { src, clone });
    return clone;
  }

  function enableGlassTransmissive(spans: Record<string, GlassSpanMm>) {
    glassSpans = spans;
    for (const [id, span] of Object.entries(spans)) {
      const root = node(id);
      if (!root) continue;
      const meshes: THREE.Mesh[] = [];
      root.traverse((o) => {
        // the inverted-hull pass parents under the mesh it outlines — not
        // glass, and it rides its host (same rule as applyVisibility)
        if (o instanceof THREE.Mesh && !(o.parent instanceof THREE.Mesh))
          meshes.push(o);
      });
      if (!meshes.length) continue;
      // Thickness is local and three multiplies by the model scale itself, so
      // the prescription's millimetres go in raw.
      const thickness = Math.abs(span.frontYmm - span.rearYmm);
      const elementClones: THREE.Material[] = [];
      const elementMeshes: THREE.Mesh[] = [];
      for (const m of meshes) {
        const src = m.material;
        if (Array.isArray(src)) continue; // multi-material: leave it alone
        const clone = glassCloneFor(m, src, thickness);
        glassSavedMaterial.set(m, src);
        glassClones.add(clone);
        elementClones.push(clone);
        elementMeshes.push(m);
        m.material = clone;
      }
      if (elementClones.length) {
        glassElementClones.set(id, elementClones);
        glassElementMeshes.set(id, elementMeshes);
      }
    }
    // The opacities last, in one pass, so a re-seat resumes at the fade levels
    // reached rather than at 1.
    writeGlassOpacity();
  }

  /** Hand every mesh still wearing one of these clones back its saved material.
   *  Touches neither fade level and disposes nothing — the clones belong to
   *  `glassCloneCache`, which is what makes the next crossing free. */
  function releaseGlassClones() {
    for (const [m, saved] of glassSavedMaterial)
      if (glassClones.has(m.material as THREE.Material)) m.material = saved;
    glassSavedMaterial.clear();
    glassClones.clear();
    glassElementClones.clear();
    glassElementMeshes.clear();
    glassGone.clear();
  }

  function disableGlassTransmissive() {
    releaseGlassClones();
    glassSpans = {};
    glassFade = 1;
    glassElementFade.clear();
    glassGlint = 1;
  }

  /**
   * Re-make the transmissive swap over whatever the meshes wear now. Order
   * matters: the release restores only meshes still holding a clone, so once
   * shading has stomped them it restores nothing and the new theme's materials
   * stay put for the re-clone to source from. The re-enable re-applies both
   * fade levels.
   */
  function reseatGlassTransmissive() {
    releaseGlassClones();
    enableGlassTransmissive(glassSpans);
    visibilityDirty = true;
  }

  // Body fade (setBodyFade): the glass fade's opposite number, writing shared
  // material properties where the glass had to clone. `bodySaved` is what each
  // touched material wore, so the restore is exact.
  let bodyFade = 1;
  let bodyFadedOut = false;
  const bodySaved = new Map<
    THREE.Material,
    { transparent: boolean; opacity: number }
  >();

  /** Every distinct material worn by a piece the body fade owns — the shapes
   *  applyVisibility walks, plus the child passes riding a host mesh (outline
   *  hulls, line-work). The glass is in it except while the dive owns it, where
   *  the passage fades own the clones' opacity; the capture is lazy and
   *  re-taken after every restore, so that exclusion is exactly the dive's
   *  span. */
  function bodyMaterials(): Set<THREE.Material> {
    const out = new Set<THREE.Material>();
    gltfScene.traverse((o) => {
      const host = o instanceof THREE.Mesh ? o : o.parent;
      if (!(host instanceof THREE.Mesh)) return;
      if (glassTransmissive && isOpticalGlass(host.name)) return;
      const mat = (o as THREE.Mesh).material;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) out.add(m);
    });
    return out;
  }

  function applyGlassFade(opacity: number) {
    // guarded: the dive calls this every frame and writeGlassOpacity walks
    // every clone
    const o = Math.min(1, Math.max(0, opacity));
    if (!glassTransmissive || o === glassFade) return;
    glassFade = o;
    if (writeGlassOpacity()) visibilityDirty = true;
    dirty = true;
  }

  /** The passage fade. Same guard, applied per element: nothing is written
   *  unless a level actually moved. */
  function applyGlassElementFade(fades: Record<string, number>) {
    if (!glassTransmissive) return;
    let moved = false;
    for (const [id, v] of Object.entries(fades)) {
      const o = Math.min(1, Math.max(0, v));
      if ((glassElementFade.get(id) ?? 1) === o) continue;
      glassElementFade.set(id, o);
      moved = true;
    }
    if (!moved) return;
    if (writeGlassOpacity()) visibilityDirty = true;
    dirty = true;
  }

  /** setGlassGlint: a pure scale off the shipped specular. The level is kept
   *  whether or not the swap is on — every clone made picks it up, which
   *  carries it through a theme re-seat. */
  function applyGlassGlint(level: number) {
    const k = Math.min(1, Math.max(0, level));
    if (k === glassGlint) return;
    glassGlint = k;
    for (const c of glassClones)
      (c as THREE.MeshPhysicalNodeMaterial).specularIntensity =
        GLASS_TRANSMISSIVE_SPECULAR * k;
    dirty = true;
  }

  function applyBodyFade(opacity: number) {
    const o = Math.min(1, Math.max(0, opacity));
    if (o === bodyFade) return;
    bodyFade = o;
    // The merged pair's `transparent` has one owner (materials/unified.ts), so
    // the fade only declares itself and unified resolves `inkOn || fadeActive`.
    // Declared ahead of the capture, because declaring also takes the ink twin
    // off: this function owns `opacity` on whatever the meshes wear when it
    // captures them.
    unified.bodyFadeActive(o < 1);
    if (o >= 1) {
      // back to the shipped state exactly: opacity, plus the transparent flag
      // on everything whose flag is this function's
      for (const [m, was] of bodySaved) {
        m.opacity = was.opacity;
        if (unified.ownsTransparent(m)) continue; // …but not that flag (below)
        // …and only when it actually moves: three keys a pipeline on
        // `transparent`, so a needsUpdate here is a program rebuild.
        if (m.transparent === was.transparent) continue;
        m.transparent = was.transparent;
        m.needsUpdate = true;
      }
      bodySaved.clear();
    } else {
      // Captured lazily and re-captured after every restore: a shading switch
      // or a theme flip re-materials every mesh, so a set captured at boot
      // would write opacity onto materials nothing wears.
      if (!bodySaved.size)
        for (const m of bodyMaterials()) {
          bodySaved.set(m, { transparent: m.transparent, opacity: m.opacity });
          if (unified.ownsTransparent(m)) continue;
          if (m.transparent) continue; // already there — see the restore above
          m.transparent = true;
          m.needsUpdate = true;
        }
      for (const m of bodySaved.keys()) m.opacity = o;
    }
    const out = o <= 0;
    if (out !== bodyFadedOut) {
      bodyFadedOut = out;
      visibilityDirty = true;
    }
    dirty = true;
  }

  // Shell gate (setShellFade): the level is a material uniform every framed
  // piece dissolves against (materials/unified.ts winkFactor), and a piece
  // whose opacity has reached 0 also leaves the visibility pass.
  let shellFade = 1;
  /** the shell meshes hidden right now — the set applyVisibility reads. */
  const shellGone = new Set<THREE.Mesh>();
  /** The interior's own fade channel, not a band: the cladding and the
   *  rest-cast leave with the peel but return over the internals tail, so the
   *  dive passes through the full interior while the shell and baffles stay off
   *  until the rewrap. */
  let interiorFade = 1;
  const interiorGone = new Set<THREE.Mesh>();
  /** each governed mesh's threshold, on its channel (stampWinkLanes) */
  const shellThreshold = new Map<THREE.Mesh, number>();
  const interiorThreshold = new Map<THREE.Mesh, number>();
  for (const [m, w] of winks as Map<THREE.Mesh, WinkThreshold>)
    (w.channel === "shell" ? shellThreshold : interiorThreshold).set(
      m,
      w.threshold,
    );

  /** One channel's level write: the uniform, then the gone set. */
  function applyWink(
    level: number,
    uniform: { value: number },
    thresholds: Map<THREE.Mesh, number>,
    gone: Set<THREE.Mesh>,
  ) {
    uniform.value = level;
    for (const [m, t] of thresholds) {
      const out = winkGone(t, level);
      if (out === gone.has(m)) continue;
      if (out) gone.add(m);
      else gone.delete(m);
      visibilityDirty = true;
    }
    dirty = true;
  }

  function applyInteriorFade(opacity: number) {
    const o = Math.min(1, Math.max(0, opacity));
    if (o === interiorFade) return;
    interiorFade = o;
    applyWink(o, uInteriorFade, interiorThreshold, interiorGone);
  }

  function applyShellFade(opacity: number) {
    // The story envelope is a sum of two overlapping ramps and can transiently
    // leave [0,1] — clamped here, not at the caller.
    const o = Math.min(1, Math.max(0, opacity));
    if (o === shellFade) return;
    shellFade = o;
    applyWink(o, uShellFade, shellThreshold, shellGone);
  }

  /** setRoomLight: every room-light contribution scaled off its boot value.
   *  Cheap to call every frame — an unchanged level returns immediately. */
  function applyRoomLight(level: number) {
    const k = Math.min(1, Math.max(0, level));
    if (k === roomLight) return;
    roomLight = k;
    scene.environmentIntensity = roomLightBoot.env * k;
    key.intensity = roomLightBoot.key * k;
    rim.intensity = roomLightBoot.rim * k;
    hemi.intensity = roomLightBoot.hemi * k;
    dirty = true;
  }

  /**
   * The one owner of the model's `.visible` flags. Four gates can hide a piece:
   * the glass fades' tail, the body fade's tail, the shell gate and the
   * interior gate. Composed in one pass — a piece is visible iff every active
   * gate allows it. Accessories have their own owner and are skipped.
   *
   * Dirty-flagged: the sweep is a pure function of current gate state, so gate
   * writers raise `visibilityDirty` and tick() composes once before the render.
   */
  let visibilityDirty = true; // compose the boot state on the first frame
  const visibilityGates: VisibilityGates = {
    underAccessory,
    glassGone,
    get bodyFadedOut() {
      return bodyFadedOut;
    },
    shellGone,
    interiorGone,
  };
  function applyVisibility() {
    sweepVisibility(gltfScene, visibilityGates);
  }

  // Fold the accessories into the live scene once they load: resolve the group
  // node lists, apply the current visibility choice, and register the new
  // meshes with the material builders.
  accessoriesReady.then(() => {
    accessories.hood = [node("Acc_Hood")].filter((o): o is THREE.Object3D =>
      Boolean(o),
    );
    accessories.filter = [
      node("Acc_Filter_Glass"),
      node("Acc_Filter_Ring"),
    ].filter((o): o is THREE.Object3D => Boolean(o));
    accessories.caps = [node("Acc_CapFront"), node("Acc_CapRear")].filter(
      (o): o is THREE.Object3D => Boolean(o),
    );
    for (const group of Object.keys(accessories) as AccessoryGroup[])
      for (const obj of accessories[group]) obj.visible = accessoryOn[group];
    // Accessories arrive after the body's frame pass, so each root gets its own
    // scoped pass. Folding them into the body pass would shift the ladder.
    for (const group of Object.keys(accessories) as AccessoryGroup[])
      for (const obj of accessories[group]) deriveFrames(obj);
    // …then the merged material over the whole scene, so a mesh that was
    // present at build time but only got its frame just now is re-keyed onto
    // the deforming variant.
    unified.integrate(gltfScene);
    shading.integrate(gltfScene); // …and the bench swapper learns the new meshes
    visibilityDirty = true; // fold the just-arrived meshes into every active gate
    dirty = true;
  });
  // Horizontal lens-parking only works on landscape screens — on portrait it
  // would shove the lens off-frame, so it fades out below ~1.5:1.
  let parkScale = 1;
  /** the drawing buffer's CSS-pixel size — held grow-only in height (below) */
  let bufW = 0;
  let bufH = 0;
  /** when the drawing buffer last changed — tick() rebuilds the post pass once
   *  the run of resize events has settled (0 = nothing owed) */
  let postStaleAt = 0;
  /** the canvas's CSS size, re-read here rather than per frame: every read is a
   *  forced layout, and the frame path needs it several times */
  let cssW = 1;
  let cssH = 1;
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    cssW = w;
    cssH = h;
    // Mobile browsers resize the dvh viewport on every scroll direction change,
    // so the buffer only reallocates on a width change or a height growth; a
    // height-only shrink keeps the taller buffer, and the NDC mapping and the
    // browser's squash back to the CSS height cancel exactly.
    if (w !== bufW || h > bufH) {
      renderer.setSize(w, h, false);
      bufW = w;
      bufH = h;
      // three r185 keys the transmission backdrop texture on the render target
      // and drops the one resize it marks, so every later copy writes the new
      // buffer into the old texture. Only a target it has not cached clears it.
      postStaleAt = performance.now();
    }
    camera.aspect = w / h;
    parkScale = parkScaleFor(w, h);
    const rem =
      parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    camera.zoom = frameZoom(w, h, 112 * rem); // 112rem matches --container-layout
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const storyPos = new THREE.Vector3();
  const storyUp = new THREE.Vector3();
  const storyTarget = new THREE.Vector3();

  // Node tracking (DOM annotations that follow model parts). Every part's
  // geometry is baked in place, so a node's visual centre is its bbox centre —
  // resolved once into the node's pose-independent local frame and then
  // followed through the live transform.
  const frameCbs: ((
    project: (name: string, out: TrackedPoint) => TrackedPoint | null,
    dt: number,
  ) => boolean | void)[] = [];
  const evaluateCbs: ((pE: number, dt: number) => boolean | void)[] = [];

  const trackCache = new Map<
    string,
    { obj: THREE.Object3D; local: THREE.Vector3 } | null
  >();
  const trackVec = new THREE.Vector3();
  function project(name: string, out: TrackedPoint): TrackedPoint | null {
    let t = trackCache.get(name);
    if (t === undefined) {
      const obj = gltfScene.getObjectByName(name);
      if (!obj) {
        console.warn(`lens scene: no model node named "${name}" to track`);
        t = null;
      } else {
        const center = new THREE.Box3()
          .setFromObject(obj)
          .getCenter(new THREE.Vector3());
        t = { obj, local: obj.worldToLocal(center) };
      }
      trackCache.set(name, t);
    }
    if (!t) return null;
    trackVec.copy(t.local);
    t.obj.localToWorld(trackVec).project(camera); // projection includes the view-offset park
    if (trackVec.z > 1) return null; // behind the camera
    out.x = ((trackVec.x + 1) / 2) * cssW;
    out.y = ((1 - trackVec.y) / 2) * cssH;
    return out;
  }

  // Story mode scripts the camera and the hero canvas is pointer-events:none,
  // so OrbitControls there would be dead listeners.
  const controls = storyMode ? null : new OrbitControls(camera, canvas);
  if (controls) {
    controls.enableDamping = true;
    controls.minDistance = 2;
    controls.maxDistance = 20;
    controls.target.set(0, 0, 0);
    // middle-drag orbits like left-drag; the wheel already owns dolly
    controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    controls.addEventListener("change", () => {
      dirty = true;
    });
    controls.update();
  }

  // Dev hero-camera preview: while true, tick() takes the story-mode camera
  // branch and OrbitControls is bypassed. orbitPose is the free-orbit state
  // saved on engage and restored on exit.
  let storyCam = false;
  const orbitPose = {
    pos: new THREE.Vector3(),
    up: new THREE.Vector3(),
    fov: camera.fov,
  };

  // The dive's framing over the story sample (story/camera applyStoryFraming):
  // its fov ramp, its claim on the frame's centre, the far plane's follow.
  const dive: DiveFraming = {
    centre: 0,
    fov: null,
    fovMix: 1,
    far: (dist) => farFor(dist, modelRadius),
  };

  // value and Target both start at the channel's registry default
  const state = Object.fromEntries(
    CHANNELS.flatMap((c) => [
      [c, CHANNEL_DEFAULTS[c]],
      [`${c}Target`, CHANNEL_DEFAULTS[c]],
    ]),
  ) as SceneState;

  // applyShading is the one instant-swap path — the setShading method and the
  // transition runner below both land here.
  let currentShading: ShadingMode = "realistic";
  function applyShading(mode: ShadingMode) {
    currentShading = mode;
    shading.set(mode);
    dirty = true;
  }

  // Choreographed look swap (core/transitions.ts holds the registry and the
  // snapshot/restore contract). One run at a time: a second call mid-flight
  // retargets the pending mode instead of stacking motion.
  const transitionCtx: TransitionContext = {
    state,
    camera,
    model: gltfScene,
    storyMode,
  };
  let activeSwap: {
    run: TransitionRun;
    start: number;
    pending: ShadingMode;
    swapped: boolean;
    raf: number;
    onProgress?: (t: number) => void;
  } | null = null;
  function swapShading(mode: ShadingMode, opts: SwapShadingOptions = {}) {
    if (activeSwap) {
      activeSwap.pending = mode;
      // past the swap beat the cut already landed — recut now, inside the
      // residual motion, rather than spinning again
      if (activeSwap.swapped && mode !== currentShading) applyShading(mode);
      return;
    }
    if (mode === currentShading) return;
    const run = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? null
      : TRANSITIONS[opts.transition ?? "blink"](transitionCtx, opts);
    if (!run) {
      applyShading(mode);
      return;
    }
    activeSwap = {
      run,
      start: performance.now(),
      pending: mode,
      swapped: false,
      raf: 0,
      onProgress: opts.onProgress,
    };
    const step = (now: number) => {
      if (!activeSwap) return; // retargeted mid-flight
      const t = clamp01((now - activeSwap.start) / run.duration);
      run.update(t);
      activeSwap.onProgress?.(t);
      if (!activeSwap.swapped && t >= run.swapAt) {
        activeSwap.swapped = true;
        if (activeSwap.pending !== currentShading)
          applyShading(activeSwap.pending);
      }
      dirty = true;
      if (t >= 1) {
        run.finish();
        activeSwap = null;
      } else {
        activeSwap.raf = requestAnimationFrame(step);
      }
    };
    activeSwap.raf = requestAnimationFrame(step);
  }

  /**
   * Push the current channel values into the mechanism and the shader channels.
   * Split out of tick() so the dev path visualizer can re-drive everything at
   * arbitrary values through one drive path.
   */
  const lastDrive = { zoom: NaN, focus: NaN, aperture: NaN, huddle: NaN };
  function driveChannels(): number {
    // One shared ease across every zoom channel — per-channel eases visibly
    // desynchronize the guts.
    const zoomT = smoothstep(0, 1, clamp01(state.zoom));
    const focusT = clamp01(state.focus);
    const apertureT = clamp01(state.aperture);
    const explodeT = clamp01(state.explode);
    const huddleT = clamp01(state.huddle);

    // The measured motions only: ring throws, the element slides they drive,
    // the lead screw's spin, the iris sweep. Everything else is a recipe and
    // runs in-shader off the channels below. Rewritten only when an input moved.
    if (
      zoomT !== lastDrive.zoom ||
      focusT !== lastDrive.focus ||
      apertureT !== lastDrive.aperture ||
      huddleT !== lastDrive.huddle
    ) {
      lastDrive.zoom = zoomT;
      lastDrive.focus = focusT;
      lastDrive.aperture = apertureT;
      lastDrive.huddle = huddleT;
      mechanism.update({
        zoom: zoomT, // the shared-smoothstep value, not the raw eased channel
        focus: focusT,
        aperture: apertureT,
        huddle: huddleT,
      });
    }

    // The op recipe channels: these are the deform, one registry channel per
    // recipe uniform, derived from the recipe list. The mechanism trio above
    // stays hand-written because its three reads share one ease.
    for (const name of RECIPE_NAMES)
      recipeChannel(name).value = clamp01(state[name]);

    return explodeT;
  }

  /** the last tick's clock reading, for the one dt every consumer gets */
  let lastTickAt = performance.now();
  function tick() {
    // skipped, not just disabled, under the hero-camera preview: update()
    // would re-aim the camera from the controls' own state every frame
    if (controls && !storyCam) controls.update();

    const now = performance.now();
    const dt = Math.min(EASE_DT_MAX_MS, now - lastTickAt);
    lastTickAt = now;

    if (postStaleAt !== 0 && now - postStaleAt > POST_RESIZE_SETTLE_MS)
      rebuildPost();

    // ease every channel toward its target; `easing` keeps redraws running
    // until every one has snapped onto it
    let easing = false;
    for (let i = 0; i < CHANNELS.length; i++) {
      const c = CHANNELS[i];
      const before = state[c];
      state[c] = easeStep(before, state[TARGET_KEYS[i]], dt);
      if (state[c] !== before) easing = true;
    }

    // idle: nothing dirty, no channel easing, no rider reported motion
    if (!dirty && !easing) return;

    // THE EVALUATE STEP: story mode draws every 3D value at the eased story p,
    // so the consumers write this frame's values here, before the camera and
    // the channels are read. A callback returning true asks for the next frame.
    const storyP = clamp01(state.story);
    let live = false;
    if (storyMode)
      for (const cb of evaluateCbs) if (cb(storyP, dt)) live = true;
    dirty = live;

    if (storyMode || storyCam) {
      // sample the scripted pose, then hand the framing (pose copy, park,
      // portrait lift) to story/camera
      const sample = sampleStory(storyP, storyPos, storyUp, storyTarget);

      applyStoryFraming(
        camera,
        sample,
        storyPos,
        storyUp,
        storyTarget,
        cssW,
        cssH,
        parkScale,
        dive,
      );
    }

    // Depth-fade planes, from the live camera and the live spread
    // (materials/depthfade.ts owns the placement). They track the dolly because
    // the ink look folds this fade into its opacity, so planes centred on the
    // origin would put the parked lens deep into its own far fade.
    writeFadeBands(
      camera.position,
      dollyX,
      modelRadius,
      Math.max(state.explode, state.assemble),
    );

    // The drawn sky rides ON the camera: parking it on this frame's eye
    // position is what makes near geometry behave like an infinitely distant
    // sky (no parallax as the dive travels).
    starfield?.sync(camera);
    // The wormhole reads the same frame the starfield just synced, so the
    // funnel's centre and the sky it swallows cannot be a frame apart.
    if (postMounted) wormholePost?.sync(camera);

    const explodeT = driveChannels();
    cinematics.update(explodeT, now);

    // one owner writes every `.visible` flag, and only when a gate writer
    // marked the composition stale (see applyVisibility)
    if (visibilityDirty) {
      visibilityDirty = false;
      applyVisibility();
    }

    // Two render paths: mounted, the frame goes through the wormhole pass;
    // unmounted, it is the direct render. Warm-up frames are taken here, ahead
    // of this tick's own render, because the pass renders once per frame.
    // the pose for this frame is final here — record it before the render
    motionTrace?.record(camera, state, modelRadius);
    // The body's warm-up, from the frame after the first: the ink twin's
    // pipeline, drawn once on the canvas ahead of the look resolution below.
    // Asked per frame rather than armed once, since integrate() mints new body
    // materials when the accessories land.
    if (firstFrameDone && unified.needsWarm("canvas"))
      unified.warmBodyLooks("canvas", () =>
        drewScene(() => renderer.render(scene, camera)),
      );
    // One warm step per tick, and never on a tick the pass will draw for real:
    // the pass draws its scene once per tick, so a second step sharing the tick
    // would get an output quad alone.
    if (warmQueue.length && !postMounted) {
      warmQueue.shift()!();
      if (warmQueue.length) dirty = true;
    }
    // Which context this frame draws in — one reading, since three keys a
    // pipeline on the render context and it decides whether the twin may be
    // worn. The resolution and the render must not disagree.
    const viaPass = postMounted && wormholePost !== null ? wormholePost : null;
    unified.syncBody(viaPass ? "pass" : "canvas");
    if (viaPass) viaPass.render();
    else renderer.render(scene, camera);
    // after the render, so annotations see this frame's final transforms
    for (const cb of frameCbs) if (cb(project, dt)) dirty = true;

    if (!firstFrameDone) {
      firstFrameDone = true;
      performance.mark("lens:first-frame"); // model visible (pipelines compiled)
    }
  }
  /** The ink twin's compile goes on the frame after the first, never on it.
   *  Until a warm frame is paid the body wears the blend material. */
  let firstFrameDone = false;
  renderer.setAnimationLoop(tick);
  let paused = false;
  let pathViz: PathViz | null = null;
  let inspector: Inspector | null = null;
  // The dive's drawn starfield, dynamically imported. The page's live choice is
  // tracked separately because the import is awaited, so an on→off during the
  // fetch must resolve off. While mounted it owns scene.background.
  let starfield: import("../optics/starfield").Starfield | null = null;
  let starsWanted = false;
  let starsBgSaved: THREE.Scene["background"] = null;
  // The fly-through's screen-space wormhole — same lazy-import shape and
  // latest-state rule as the starfield: `postMounted` is what tick() renders
  // through and is only ever set from `postWanted` after the await, so an exit
  // during the import cannot strand the pipeline.
  let wormholePost: import("../optics/wormhole-post").WormholePost | null =
    null;
  let postWanted = false;
  let postMounted = false;
  /** Build the pass if it is not up. The caller owns `postMounted`. */
  async function startPost(): Promise<boolean> {
    if (wormholePost) return true;
    try {
      const { createWormholePost } = await import("../optics/wormhole-post");
      wormholePost = createWormholePost(renderer, scene, camera, () => {
        dirty = true;
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `lens optics: the wormhole post pass failed to start — ${msg}`,
        err,
      );
      if (diag) diag.post = `FAILED: ${msg}`;
      return false;
    }
    return true;
  }

  /** How long the buffer must hold still before the pass is rebuilt, so a
   *  window drag pays one rebuild rather than one per resize event. */
  const POST_RESIZE_SETTLE_MS = 250;

  /** Drop the resized-out pass and put the wanted one back up. */
  function rebuildPost() {
    postStaleAt = 0;
    if (!wormholePost) return;
    wormholePost.dispose();
    wormholePost = null;
    postMounted = false; // the direct render carries the frames until it lands
    void startPost().then((ok) => {
      if (ok) postMounted = postWanted;
      if (diag) diag.post = postMounted ? "mounted" : "unmounted";
      dirty = true;
    });
  }

  /** warmFly runs once per page — see the handle method. */
  let warmedFly = false;
  /**
   * Every dry frame the scene owes, one per tick. The wormhole pass draws its
   * scene once per tick (three's own frame guard on `PassNode`), so two pass
   * warms sharing a tick leave the second compiling nothing. Every step gets a
   * tick of its own and chains the next through `dirty`.
   */
  const warmQueue: (() => void)[] = [];
  function queueWarm(...steps: (() => void)[]) {
    warmQueue.push(...steps);
    dirty = true;
  }

  /** Did `body` reach the scene, or only the pass's output quad (one draw)?
   *  The renderer's draw count is the probe, which lets a warm refuse to mark a
   *  context it never drew in. */
  function drewScene(body: () => void): boolean {
    const before = renderer.info.render.drawCalls;
    body();
    return renderer.info.render.drawCalls - before > 1;
  }

  /** One frame through the dive's pass, into a 1×1 target — the scene compiles
   *  against the pass's own target format and sample count, a different
   *  pipeline from the canvas's for every material drawn. */
  function warmPassFrame() {
    if (!wormholePost) return;
    const dry = new THREE.RenderTarget(1, 1);
    try {
      renderer.setRenderTarget(dry);
      wormholePost.render();
    } finally {
      renderer.setRenderTarget(null);
      dry.dispose();
    }
  }

  /** One draw of `objects`, shown nowhere — their buffers and textures upload
   *  here instead of on the frame their scene arrives. `viaPass` adds a
   *  pass-context draw because three keys a pipeline on the render context.
   *  Culling is off for the draw: a culled object uploads nothing. */
  function warmDrawFrame(objects: THREE.Object3D[], viaPass: boolean) {
    const parked = objects.filter((o) => !o.parent);
    const culled: THREE.Object3D[] = [];
    for (const o of objects)
      o.traverse((c) => {
        if (c.frustumCulled) {
          c.frustumCulled = false;
          culled.push(c);
        }
      });
    for (const o of parked) scene.add(o);
    try {
      renderer.render(scene, camera);
      if (viaPass) warmPassFrame();
    } finally {
      for (const o of parked) scene.remove(o);
      for (const c of culled) c.frustumCulled = true;
    }
    dirty = true;
  }

  /** The dive's sky, up for the duration of one dry frame: a warm frame must
   *  draw what the crossing draws, and the backdrop is part of it. */
  function withDiveSky(sky: NonNullable<typeof starfield>, body: () => void) {
    const bgSaved = scene.background ?? null;
    scene.background = sky.backdrop;
    scene.add(sky.object);
    try {
      body();
    } finally {
      scene.remove(sky.object);
      scene.background = bgSaved;
    }
  }

  /** One frame of the dive, drawn nowhere: the dive's look goes on, a frame is
   *  drawn through the wormhole pass into a 1×1 target, and everything comes
   *  back off inside one tick, so no rendered frame sees the half-state. The
   *  first of the fly warm's three steps. */
  function warmFlyFrame(spans: Record<string, GlassSpanMm>) {
    if (!starfield || !wormholePost) return;
    // The canvas's own half of the warm-up, first: `transparent` is the one
    // thing the realistic/ink blend cannot blend and three keys a pipeline on
    // it, so every shared material's realistic variant would otherwise compile
    // on the frame the ramp reaches 0. A canvas render spends no pass frame, so
    // it rides the same tick as the crossing's below.
    shading.withOriginals(() => renderer.render(scene, camera));
    const dry = new THREE.RenderTarget(1, 1);
    withDiveSky(starfield, () => {
      // withOriginals, not setShading: a mode switch re-materials every mesh and
      // would stomp the clones enabled just below (the ownership hazard above)
      shading.withOriginals(() => {
        enableGlassTransmissive(spans);
        try {
          renderer.setRenderTarget(dry);
          wormholePost?.render();
        } finally {
          renderer.setRenderTarget(null);
          // the clones stay in the cache — half the point of the exercise
          disableGlassTransmissive();
        }
      });
    });
    dry.dispose();
    dirty = true;
  }

  /** The ink twin through the pass: the ink returns while the span is still
   *  active, so the twin is drawn through the wormhole pass for the last of the
   *  rewrap. Its own tick and its own context flag, granted only if the draw
   *  reached the scene. */
  function warmFlyTwinFrame() {
    if (!starfield || !wormholePost) return;
    const dry = new THREE.RenderTarget(1, 1);
    withDiveSky(starfield, () => {
      try {
        renderer.setRenderTarget(dry);
        unified.warmBodyLooks("pass", () =>
          drewScene(() => wormholePost?.render()),
        );
      } finally {
        renderer.setRenderTarget(null);
      }
    });
    dry.dispose();
    dirty = true;
  }

  /** …and the hand-back's own frame: below GLASS_HANDOVER `current` gives the
   *  elements their own material back, and the rewrap crosses that edge while
   *  the pass is still up. The blend is forced under the edge for the draw and
   *  put straight back. */
  function warmFlyGlassFrame() {
    if (!starfield || !wormholePost) return;
    const dry = new THREE.RenderTarget(1, 1);
    withDiveSky(starfield, () => {
      try {
        renderer.setRenderTarget(dry);
        shading.withOriginals(() => wormholePost?.render());
      } finally {
        renderer.setRenderTarget(null);
      }
    });
    dry.dispose();
    dirty = true;
  }

  // Dev-only perf probe: renderer.info plus live scene internals.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__lensPerf = {
      renderer,
      scene,
      camera,
      state,
      model: gltfScene,
      invalidate: () => {
        dirty = true;
      },
      // the two model dissolves, reachable from the console (the handle itself
      // is not on window)
      setBodyFade: applyBodyFade,
      setGlassFade: applyGlassFade,
      // the dive's two darkness ramps: the room, and the glass's reflections
      setRoomLight: applyRoomLight,
      setGlassGlint: applyGlassGlint,
    };
  }

  // Named, because warmFly drives the two optics latches through the same
  // public path the dive does.
  const handle: SceneHandle = {
    state,
    setPaused(p) {
      if (p === paused) return; // IO callbacks can repeat the same state
      paused = p;
      if (p) {
        renderer.setAnimationLoop(null);
      } else {
        dirty = true; // scroll may have moved targets while paused
        renderer.setAnimationLoop(tick);
      }
    },
    setAccessory(group, visible) {
      accessoryOn[group] = visible;
      // Accessories stream in behind the body, so a toggle may land before its
      // meshes exist. Applied once loaded, re-reading the latest desired state
      // so a rapid on→off during the load resolves off.
      accessoriesReady.then(() => {
        for (const obj of accessories[group]) obj.visible = accessoryOn[group];
        visibilityDirty = true;
        dirty = true;
      });
      dirty = true;
    },
    setStoryCamera(on) {
      if (storyMode || on === storyCam) return;
      storyCam = on;
      if (on) {
        orbitPose.pos.copy(camera.position);
        orbitPose.up.copy(camera.up);
        orbitPose.fov = camera.fov;
        if (controls) controls.enabled = false;
      } else {
        // Snap the story channel home: easing it down would sweep storyP back
        // through the isolate window and flash the structure out.
        state.story = 0;
        state.storyTarget = 0;
        camera.position.copy(orbitPose.pos);
        camera.up.copy(orbitPose.up);
        camera.fov = orbitPose.fov;
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
        if (controls) {
          controls.enabled = true;
          controls.update(); // re-aims at the controls target from the restored pose
        }
      }
      dirty = true;
    },
    setStoryFov(fov, mix = 1) {
      if (!storyMode) return;
      const m = fov === null ? 0 : clamp01(mix);
      if (fov === dive.fov && m === dive.fovMix) return;
      dive.fov = fov;
      dive.fovMix = m;
      dirty = true;
    },
    setStoryCentre(k) {
      if (!storyMode) return;
      k = clamp01(k);
      if (k === dive.centre) return;
      dive.centre = k;
      dirty = true;
    },
    setDust(visible) {
      cinematics.setDust(visible);
      dirty = true;
    },
    setGlassTransmissive(on, spans) {
      if (on === glassTransmissive) return;
      glassTransmissive = on;
      if (on) enableGlassTransmissive(spans ?? {});
      else disableGlassTransmissive();
      visibilityDirty = true;
      dirty = true;
    },
    setGlassFade(opacity) {
      applyGlassFade(opacity);
    },
    setGlassElementFade(fades) {
      applyGlassElementFade(fades);
    },
    setGlassGlint(level) {
      applyGlassGlint(level);
    },
    worldAxialSpans(ids) {
      const out: Record<string, { x0: number; x1: number }> = {};
      for (const id of ids) {
        const root = node(id);
        if (!root) continue;
        // Ancestors and descendants: the model group's matrix carries the
        // recentre and MODEL_SCALE, and this need not follow a render.
        root.updateWorldMatrix(true, true);
        const box = new THREE.Box3().setFromObject(root);
        if (box.isEmpty()) continue;
        out[id] = { x0: box.min.x, x1: box.max.x };
      }
      return out;
    },
    setBodyFade(opacity) {
      applyBodyFade(opacity);
    },
    setShellFade(opacity) {
      applyShellFade(opacity);
    },
    setInteriorFade(opacity) {
      applyInteriorFade(opacity);
    },
    setRoomLight(level) {
      applyRoomLight(level);
    },
    setModelOrientation(euler) {
      // null (and every omitted axis) is the boot rotation, which makes the
      // re-derivation below the identity — one path, no reset branch
      const x = euler?.x ?? bootRotation.x;
      const y = euler?.y ?? bootRotation.y;
      const z = euler?.z ?? bootRotation.z;
      const r = modelGroup.rotation;
      if (r.x === x && r.y === y && r.z === z) return;
      r.set(x, y, z);
      applyModelPlacement();
    },
    setLensDolly(x) {
      if (x === dollyX) return;
      dollyX = x;
      applyModelPlacement();
    },
    addOverlay(obj) {
      scene.add(obj);
      dirty = true;
    },
    removeOverlay(obj) {
      obj.removeFromParent();
      dirty = true;
    },
    addModelOverlay(obj) {
      modelAnchor.add(obj);
      dirty = true;
    },
    removeModelOverlay(obj) {
      obj.removeFromParent();
      dirty = true;
    },

    starfieldAttach(obj) {
      // `.parent` is the mount test: the group is added/removed and never
      // disposed in between, so a built-but-unmounted starfield reads false
      if (!starfield || !starfield.object.parent) return false;
      if (obj.parent !== starfield.object) {
        starfield.object.add(obj);
        dirty = true;
      }
      return true;
    },
    starfieldDetach(obj) {
      obj.removeFromParent();
      dirty = true;
    },
    setSkyDim(f, rgb) {
      // `.parent` is the mount test (see starfieldAttach): an unmounted
      // backdrop is off screen, so dimming it would only leak state forward
      if (!starfield || !starfield.object.parent) return;
      starfield.setBackdropDim(f, rgb[0], rgb[1], rgb[2]);
    },
    invalidate() {
      dirty = true;
    },
    onFrame(cb) {
      frameCbs.push(cb);
    },
    onEvaluate(cb) {
      evaluateCbs.push(cb);
    },

    async enablePathViz(onStatus) {
      if (pathViz) return pathViz;
      try {
        const { createPathViz } = await import("../dev/paths");
        pathViz = createPathViz(
          {
            renderer,
            scene,
            model: gltfScene,
            state,
            driveChannels,
            invalidate: () => {
              dirty = true;
            },
            // the one channel registry, so analysis walks start from the
            // neutral pose without re-listing channels anywhere
            channelDefaults: CHANNEL_DEFAULTS,
          },
          onStatus,
        );
      } catch (err) {
        console.warn("lens paths: visualizer failed to start", err);
        onStatus("path visualizer failed to start — see console", false);
        return null;
      }
      return pathViz;
    },
    async enableInspect(on) {
      if (!inspector) {
        if (!on) return true; // never started, nothing to turn off
        try {
          const { createInspector } = await import("../dev/inspect");
          inspector = createInspector({
            model: gltfScene,
            camera,
            canvas,
            scene,
            invalidate: () => {
              dirty = true;
            },
          });
        } catch (err) {
          console.warn("lens inspect: inspector failed to start", err);
          return false;
        }
      }
      inspector.setEnabled(on);
      return true;
    },
    async enableStarfield(on) {
      starsWanted = on;
      if (!starfield) {
        if (!on) return true; // never started, nothing to turn off
        try {
          const { createStarfield } = await import("../optics/starfield");
          starfield = createStarfield(
            !document.documentElement.classList.contains("dark"),
            () => {
              dirty = true;
            },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `lens optics: the drawn starfield failed to start — ${msg}`,
            err,
          );
          return false;
        }
      }
      // The latest desired state, not the captured `on`: an exit during the
      // import must not let this continuation strand a mount. The backdrop
      // travels with the mount — `backdrop` is one live Color the starfield
      // re-tints on a theme flip, so assigning it once is enough.
      if (starsWanted && !starfield.object.parent) {
        starsBgSaved = scene.background ?? null;
        scene.background = starfield.backdrop;
        scene.add(starfield.object);
      } else if (!starsWanted && starfield.object.parent) {
        scene.remove(starfield.object);
        scene.background = starsBgSaved;
      }
      dirty = true;
      return true;
    },
    async buildWormholePost() {
      return wormholePost ? true : startPost();
    },
    async enableWormholePost(on) {
      postWanted = on;
      if (!wormholePost) {
        if (!on) return true; // never started, nothing to turn off
        if (!(await startPost())) return false;
      }
      // the latest desired state, not the captured `on`: an exit during the
      // import must not let this continuation strand a mount
      postMounted = postWanted;
      if (diag) diag.post = postMounted ? "mounted" : "unmounted";
      dirty = true;
      return true;
    },
    async warmFly(spans) {
      // never over a live dive, and never twice
      if (warmedFly || glassTransmissive || postMounted) return false;
      warmedFly = true;
      // Build, then drop: each pair mounts and unmounts inside one microtask
      // chain, so no frame renders with the sky or the pass up, and awaiting
      // means two calls can never both build the module.
      await handle.enableStarfield(true);
      await handle.enableStarfield(false);
      await handle.enableWormholePost(true);
      await handle.enableWormholePost(false);
      if (!starfield || !wormholePost) return false;
      // Three steps, three ticks (see `warmQueue`): the crossing's clones, the
      // ink twin, and the hand-back's own material each need the pass's one
      // scene render of a tick.
      queueWarm(() => warmFlyFrame(spans), warmFlyTwinFrame, warmFlyGlassFrame);
      return true;
    },
    warmDraw(objects, viaPass = false) {
      // Taken by tick(), like the dive's own dry frames: the renderer is not
      // re-entered from the idle callback that asked, and a `viaPass` job needs
      // a tick to itself.
      if (objects.length === 0) return;
      const job = objects.slice();
      queueWarm(() => warmDrawFrame(job, viaPass));
    },
    setInkMix(v) {
      unified.setInk(v);
      // the endpoints are the two modes, and `currentShading` must say so:
      // swapShading early-returns on it. Mid-ramp the two diverge.
      if (v <= 0) currentShading = "realistic";
      else if (v >= 1) currentShading = "ink";
      dirty = true;
    },
    setShading(mode) {
      applyShading(mode);
    },
    async enableShadingBench() {
      if (shading.hasBench()) return true;
      try {
        const { createShadingBench } =
          await import("../materials/shading-bench");
        shading.installBench(createShadingBench);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`lens shading: the bench failed to load — ${msg}`, err);
        return false;
      }
      return true;
    },
    swapShading,
    setTheme(l) {
      shading.setTheme(l);
      cinematics.setTheme(l);
      starfield?.setTheme(l); // the drawn sky just re-tints (no re-bake)
      // After shading, never instead of it: on a bench look shading.setTheme
      // re-materials every mesh and stomps the clones. Let the theme work land,
      // then re-seat on top of it — the fade rides along.
      if (glassTransmissive) reseatGlassTransmissive();
      dirty = true;
    },
    frameHalf() {
      return Math.tan((camera.fov * Math.PI) / 360) / camera.zoom;
    },
    frameAspect() {
      return camera.aspect;
    },
  };
  return handle;
}
