import * as THREE from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  disposeLensModel,
  GLASS_SPECULAR,
  loadLensModel,
  setLensEnvironment,
} from "./model";
import { createShading, type ShadingMode } from "../materials/shading";
import { createUnified } from "../materials/unified";
import { deriveFrames } from "../ops/frames";
import {
  recipeChannel,
  recipeChannels,
  recipeKnobs,
  reportOpsFrames,
  setDeformBackend,
  RECIPE_NAMES,
} from "../ops/host";
import {
  uFadeNear0,
  uFadeNear1,
  uFadeFar0,
  uFadeFar1,
} from "../materials/depthfade";
import { sampleStory, applyStoryFraming } from "../story/camera";
import { createMechanism, tagMechanismSpins } from "../ops/mechanism";
import { createCinematics } from "../story/cinematics";
import { displaceSeatedPoint } from "../ops/cpu";
import { isAccessory, isOpticalGlass } from "./parts";
import { clamp01, smoothstep, lerp } from "./math";
import {
  makeWinkScatter,
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
// the per-frame tick. The parts that DO things live in focused modules — see
// README.md's file index. This orchestrator wires the story camera and
// cinematics even for the free-orbit /lens viewer: ONE assembly path.

/** One channel's registry entry: its rest/default value plus the per-channel
 *  flags every derived list keys off. Add a channel = ONE row in
 *  CHANNEL_REGISTRY; the lists below, and their importers, follow. */
interface ChannelSpec {
  /** rest value AND markup default (also the ease target at boot) */
  default: number;
  /** ANIMATION-owned: /lens rests this channel's target on animation
   *  switch/None so no stale pose survives. Slider channels are restored
   *  separately and are NOT flagged — except explode, which is both. */
  animReset?: boolean;
  /** Recipe channel the instrument's idle-identity check must zero before
   *  probing seated geometry: at 0 the deform graph is an exact identity. A
   *  missing entry false-alarms. */
  idleZero?: boolean;
}

/**
 * THE CHANNEL REGISTRY — one row per channel, and the ONE list every
 * per-channel site derives from. `default` is also the rest value (0
 * everywhere: a recipe channel at 0 is a bit-exact identity). CHANNEL_DEFAULTS
 * feeds SceneState typing, the state initializer and tick()'s ease loop; the
 * two flags derive ANIM_RESET_CHANNELS and IDLE_ZERO_CHANNELS. So adding a
 * channel is ONE row here and no edit anywhere else — except the mechanism
 * trio, which stays bespoke mechanical code.
 *
 * Every motion channel below that trio is an OP RECIPE channel driven straight
 * through ops/host's `recipeChannel` — one row here, one recipe there.
 */
const CHANNEL_REGISTRY = {
  /** 0 (18mm, retracted) .. 1 (50mm, extended) */
  zoom: { default: 0 },
  /** 0 (infinity) .. 1 (min focus, ~0.12m) */
  focus: { default: 0 },
  /** 0 (f/2.8, wide open) .. 1 (f/22, closed down) */
  aperture: { default: 0 },
  /** explode ladder recipe: 0 (assembled) .. 1 (parts spread along the axis) */
  explode: { default: 0, animReset: true, idleZero: true },
  /** reassembly spread: 0 (seated) .. 1 (sheets unwrapped, off the ladder) */
  assemble: { default: 0, animReset: true, idleZero: true },
  /** the STORY's unroll recipe, scoped to the shell cast: 0 (seated) .. 1
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

/** THE ONE EASE EVERY CHANNEL RUNS ON — tick()'s per-frame
 *  `value += EASE·(target − value)`. Exported so laws that must hold on DRAWN
 *  values import it rather than respelling it. */
export const CHANNEL_EASE = 0.22;

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
 *  dollies the LENS, reading these only for the displacement and the fov. */
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

/** Where a model node is DRAWN: the centre and radius of the disc it covers,
 *  in FRAME HEIGHTS from the frame's centre — +x right, +y DOWN. Not pixels,
 *  because the consumers draw INTO the canvas at any size or DPR. */
export interface TrackedCircle {
  x: number;
  y: number;
  r: number;
}

/** An ADDITIVE per-part transform offset: position in the part's local frame
 *  (model mm), rotation in radians per euler component, scale a multiplier. */
export interface PartOffset {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}

/** One optical element's axial span in the GLTF frame, in millimetres, keyed
 *  by node name; its LENGTH is that element's refraction thickness. THE CALLER
 *  derives the table — importing optics/prescription.ts here would drag the
 *  whole optics tree into the shared homepage chunk. */
export interface GlassSpanMm {
  frontYmm: number;
  rearYmm: number;
}

/** Roughness on the transmissive clones. three drives the refraction blur off
 *  roughness, so a touch of it softens the internals seen through the glass. */
const GLASS_TRANSMISSIVE_ROUGHNESS = 0.05;

/** The clones' UNSCALED specular, restated from the shipped glass because
 *  `setGlassGlint` scales it. At three's default 1 each element mirrors
 *  `scene.environment` so brightly the glass reads as chrome; low but not
 *  zero, so it still catches a highlight. `envMapIntensity` cannot substitute
 *  — it is inert on a node material lit by a SCENE environment. */
const GLASS_TRANSMISSIVE_SPECULAR = GLASS_SPECULAR;

/** THE DETINT — every slot that can put a COLOUR on the transmissive clones,
 *  set to neutral. The attenuation pair is never authored but is written
 *  anyway, so the whole tint story is in ONE table. Reflectivity is
 *  deliberately untouched: the Fresnel is IOR-driven, and zeroing it would
 *  make the elements read as holes. */
const GLASS_DETINT = {
  color: 0xffffff,
  specularColor: 0xffffff,
  attenuationColor: 0xffffff,
  attenuationDistance: Infinity,
  /** 0 = colourless coating. The multicoat sheen is a look knob, not physics —
   *  raise it to bring the coloured coating back. */
  iridescence: 0,
};

export interface SceneHandle {
  state: SceneState;
  /** Show/hide a removable accessory group (all hidden by default). */
  setAccessory: (group: AccessoryGroup, visible: boolean) => void;
  /** Swap the render style (materials) for the whole model. */
  setShading: (mode: ShadingMode) => void;
  /** /lens ONLY: load the shading BENCH, dynamically imported so the hero
   *  never fetches it. AWAIT IT BEFORE OFFERING A BENCH LOOK — setShading and
   *  swapShading stay SYNCHRONOUS, so a bench mode asked for before this
   *  resolves is refused. Idempotent; false if the chunk failed. */
  enableShadingBench: () => Promise<boolean>;
  /** BLEND the story's pair rather than swapping: 0 = realistic, 1 = ink,
   *  between = both at once. The two share one material, so this is a uniform
   *  write. 0 and 1 leave the scene exactly where setShading would; a bench
   *  look wears its own materials and ignores the blend. */
  setInkMix: (v: number) => void;
  /** The current shading mode — the PENDING one while a swap is in flight.
   *  Demos snapshot it on enter() to restore the bench's look on exit(). */
  getShading: () => ShadingMode;
  /** Swap the render style through a choreographed transition: the rebuild
   *  fires at the choreography's hidden peak and everything driven is restored
   *  bit-exactly. A swap in flight is RETARGETED, not stacked;
   *  prefers-reduced-motion or a declining transition cuts instantly. */
  swapShading: (mode: ShadingMode, opts?: SwapShadingOptions) => void;
  /** Follow the site theme (light = no `.dark` on <html>): re-palettes the
   *  shading mode and re-tints the cinematic extras. The initial theme is
   *  self-detected at creation; the page calls this on toggle. */
  setTheme: (light: boolean) => void;
  /** Stop/restart the render loop entirely, e.g. when the hero scrolls out of
   *  view. Story mode draws even when nothing is dirty (ambient dust/rays), so
   *  an off-screen hero would otherwise burn frames forever. */
  setPaused: (paused: boolean) => void;
  /** Force one repaint. /lens only redraws while a channel eases or dirty is
   *  set, so a bare uniform tweak needs this to show. */
  invalidate: () => void;
  /** Run a callback after every rendered frame with a projector from node NAME
   *  to screen position (CSS px, null if missing or behind the camera). The op
   *  deform runs purely IN-SHADER, so an exploded piece's anchor is its SEATED
   *  position — anchor labels to parts the MECHANISM moves to track exactly. */
  onFrame: (
    cb: (
      project: (name: string, out: TrackedPoint) => TrackedPoint | null,
    ) => void,
  ) => void;
  /** …and where a part is actually DRAWN, in FRAME HEIGHTS. Same projection
   *  with the op deform folded in on the CPU, so it follows a piece the deform
   *  has thrown clear of its seat. Ink drawn ONTO a part wants this; a DOM
   *  label wants `project` and its seated anchor. */
  projectDrawn: (name: string) => TrackedCircle | null;
  /** DEV: motion-path overlay for the canned animations. Dynamically
   *  imported; returns null if the visualizer can't start. */
  enablePathViz: (
    onStatus: (text: string, ok: boolean) => void,
  ) => Promise<PathViz | null>;
  /** DEV: piece-name inspector — hover a mesh to read its node name, click to
   *  copy. Dynamically imported; resolves false if it couldn't start. */
  enableInspect: (on: boolean) => Promise<boolean>;
  /** THE DIVE'S SKY — drawn into the OPAQUE pass on purpose, so three's
   *  transmission copy picks it up and the glass refracts it (see the glass
   *  contract in optics/starfield.ts). While mounted it also OWNS
   *  `scene.background`. Resolves false if it couldn't start. */
  enableStarfield: (on: boolean) => Promise<boolean>;
  /** Route the frame through the SCREEN-SPACE wormhole — scene → target →
   *  radial pinch about the exit axis → canvas. `false` restores the direct
   *  render; resolves false if it couldn't start (undistorted, not broken). */
  enableWormholePost: (on: boolean) => Promise<boolean>;
  /** BUILD THE PASS WITHOUT MOUNTING IT: its render targets are the dive's
   *  largest single allocation (full-res colour + depth, MSAA), and they cost
   *  the same frame whenever they land. Paying them on their own frame keeps
   *  them off the mount's. Idempotent. */
  buildWormholePost: () => Promise<boolean>;
  /** PAY THE FLY-THROUGH'S COMPILE EARLY: draw ONE frame of the dive's look
   *  into a 1×1 target, leaving no channel, latch or look changed. Must be a
   *  REAL frame through the REAL pass, not compileAsync — three keys a pipeline
   *  on the render CONTEXT as well as the shader. Costs a full frame plus every
   *  compile. Idempotent; resolves false if it declined. */
  warmFly: (spans: Record<string, GlassSpanMm>) => Promise<boolean>;
  /** PAY AN OBJECT'S UPLOAD EARLY: draw it once into a 1×1 target, so its
   *  vertex buffers, textures and pipeline are resident before the frame that
   *  first shows it. Unparented objects are mounted for that draw only, and
   *  frustum culling is off so the draw cannot be skipped. `viaPass` draws it
   *  through the dive's post pass as well — that target's format and sample
   *  count key a SECOND pipeline, which anything first worn over the dive's
   *  span pays for on the frame it arrives. */
  warmDraw: (objects: THREE.Object3D[], viaPass?: boolean) => void;
  /** DEV: drive the camera from `state.story` through the SAME code path the
   *  hero runs instead of OrbitControls. OFF restores the saved orbit pose;
   *  no-op in story mode, where the hero already owns the camera. */
  setStoryCamera: (on: boolean) => void;
  /** STORY MODE ONLY: per-frame FOV override for the fly-through, laid over
   *  the story's pose; `mix` blends against the story's own fov, null releases.
   *  The POSE is never overridden — the dive translates the LENS past a parked
   *  camera. No restore bookkeeping: the story sample re-asserts itself. */
  setStoryFov: (fov: number | null, mix?: number) => void;
  /** STORY MODE ONLY: how much the DIVE owns the framing — 0 = the story's
   *  park/lift view offset, 1 = dead centre, which is what a bore shot down the
   *  optical axis wants. Landscape rows park at 0, where every value is the
   *  same projection. */
  setStoryCentre: (k: number) => void;
  /** Show/hide the ambient cinematics dust. The fly-through clears it so the
   *  starfield reads; everything else leaves it on. */
  setDust: (visible: boolean) => void;
  /** Leave every element DRAWN and TRANSMISSIVE, so three's transmission path
   *  refracts the internals and the starfield through it. `spans` supplies each
   *  element's THICKNESS and is read only on the ENABLING call; `false`
   *  restores the materials captured at enable. Getting the glass out of the
   *  flying camera's way is the two fades' job, not this one's. */
  setGlassTransmissive: (
    on: boolean,
    spans?: Record<string, GlassSpanMm>,
  ) => void;
  /** THE FLY-THROUGH'S RULER: the WORLD-X extent of each named node. Measured
   *  HERE because world X needs MODEL_SCALE and the recentring offset, both
   *  private to this module. REST POSE and a snapshot — the in-shader deform is
   *  not in it and nothing re-measures, so call it with channels at rest. */
  worldAxialSpans: (
    ids: string[],
  ) => Record<string, { x0: number; x1: number }>;
  /** Fade the transmissive clones out together. At exactly 0 the meshes also
   *  drop out of applyVisibility, so no depth write or transmission ghost
   *  survives. A no-op unless the swap is on; cheap per frame. */
  setGlassFade: (opacity: number) => void;
  /** THE PASSAGE FADE — one opacity PER ELEMENT, MULTIPLIED by setGlassFade's
   *  stack-wide one; omitted ids hold their last value. It exists because
   *  three's transmission is SCREEN-SPACE, and from INSIDE an element the
   *  refraction offset smears the frame into an axis-aligned cross — so each
   *  element must be gone shortly BEFORE the near plane reaches it. A no-op
   *  unless the swap is on; cheap per frame. */
  setGlassElementFade: (fades: Record<string, number>) => void;
  /** Scale the GLINTS on the transmissive clones — setRoomLight's opposite
   *  number for the glass, and separate from it because the room ramp leaves a
   *  floor bright enough to smudge glass meant to sit in a dark tube.
   *  Multiplies `specularIntensity`, the only live knob for this. Survives a
   *  theme flip; resets to 1 when the swap goes off. */
  setGlassGlint: (level: number) => void;
  /** Fade the WHOLE BODY — everything applyVisibility governs that is NOT
   *  optical glass. setGlassFade's opposite number.
   *
   *  NO CLONES, unlike the glass fade: this is ONE opacity for every mesh and
   *  model.ts's cache already collapses the body onto a handful of shared
   *  instances, so it writes `transparent`/`opacity` onto those and remembers
   *  what each wore. `transparent` flips on the first sub-1 call, recompiling
   *  those pipelines once; both are restored at exactly 1, and at 0 the meshes
   *  also leave applyVisibility. */
  setBodyFade: (opacity: number) => void;
  /** STORY: take the SHELL off the lens — the peel's cast, then the closed
   *  inner tubes, then the baffles LAST so the bore opens behind everything.
   *  Input is CLAMPED: the story envelope may transiently leave [0,1].
   *
   *  VISIBILITY, NOT OPACITY, unlike setBodyFade: the signature cache means a
   *  shell mesh shares its material with the internals, and the story's ink
   *  fills carry an `opacityNode`, which REPLACES `material.opacity`. So each
   *  mesh hides HARD at its own THRESHOLD in the level; being a `.visible` gate
   *  it composes with every other gate and survives shading swaps. */
  setShellFade: (opacity: number) => void;
  /** The INTERIOR's own level, same mechanism on a second threshold set: the
   *  cladding and the rest-cast leave with the peel but come BACK over the
   *  internals tail, so the dive flies through the full interior while the
   *  shell and baffles stay off until the rewrap. */
  setInteriorFade: (opacity: number) => void;
  /** Scale the ROOM — the PMREM'd environment and the three studio lights
   *  together. The traced sky is NOT room light and does not dim with this. Not
   *  a recorded kit verb, so a demo restores it in exit(). */
  setRoomLight: (level: number) => void;
  /** Snap the model GROUP to an absolute orientation (omitted axes keep their
   *  boot values), keeping the recentred visual centre on the origin. null
   *  restores the boot orientation. Composes with the twist transition, which
   *  rolls the INNER gltf root. */
  setModelOrientation: (
    euler: { x?: number; y?: number; z?: number } | null,
  ) => void;
  /** STORY: slide the model GROUP along world X — how the fly-through dives.
   *  The camera parks and the LENS travels past it, which is equivalent to
   *  flying a camera through a parked lens and needs no rig hand-off. */
  setLensDolly: (x: number) => void;
  /** ADDITIVE transform offset on one named part (any entry of partNames()),
   *  composed ON TOP of whatever the mechanism wrote each frame — the base is
   *  snapshotted and restored around the render, so repeated calls never
   *  accumulate. Shell pieces deform in-shader but their transforms are real,
   *  so this still moves them as rigid bodies. null clears the part. */
  setPartOffset: (name: string, offset: PartOffset | null) => void;
  /** The addressable part registry for setPartOffset: every NAMED node of the
   *  model, group empties and meshes alike. Sorted, deduped. */
  partNames: () => string[];
  /** Attach/detach a world-space presentation object at the scene root. The
   *  caller owns disposal. */
  addOverlay: (obj: THREE.Object3D) => void;
  removeOverlay: (obj: THREE.Object3D) => void;
  /** Attach an object as a CHILD OF THE MOUNTED STARFIELD, so it rides that
   *  group's per-frame camera-centring. False while the starfield is unbuilt or
   *  unmounted — the mount is async, so ask again later. Idempotent. */
  starfieldAttach: (obj: THREE.Object3D) => boolean;
  /** Take an object back off the starfield (see starfieldAttach). */
  starfieldDetach: (obj: THREE.Object3D) => void;
  /** THE REVEAL'S COLOR-MATCHED CUT: blend the mounted starfield's backdrop
   *  `f` toward `rgb` (0-255 ints), so the background swap at the unmount cuts
   *  between near-identical frames instead of flashing. The caller MUST restore
   *  (`f = 0`) BEFORE unmounting — this is a silent no-op once unmounted. */
  setSkyDim: (f: number, rgb: [number, number, number]) => void;
  destroy: () => void;
}

// The GLB is exported in real-world millimetres, and glTF export converts
// Blender's Z-up to Y-up — so a Blender local z on these identity-rotated
// nodes is a local y here, and +z(front) ↦ +y. This scales mm to world units.
const MODEL_SCALE = 0.05;

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
 * Load-time model prep. THE ORDER IS A DEPENDENCY CHAIN — do not reorder:
 *   1. deriveFrames      stamps the `_op*` attributes every graph reads
 *   2. tagMechanismSpins tags off-axis pivots as BAKED nodes, not branches
 *   3. createUnified     builds the model's one deform material
 *   4. createShading     layers the bench swapper over it
 */
function prepareModelMaterials(gltfScene: THREE.Object3D) {
  const frames = deriveFrames(gltfScene);
  // createMechanism owns the pivot itself but must wait for the recentre, which
  // is why the TAG pass is split out and runs up here.
  tagMechanismSpins(gltfScene);
  const unified = createUnified(gltfScene);
  const shading = createShading(gltfScene, unified);
  return { unified, shading, frames };
}

/**
 * Boot the lens viewer onto `canvas`. ONE SCENE PER DOCUMENT: the deform
 * channels, the recipe knobs, the active-recipe selection and the shading
 * uniforms are all MODULE state, so two live scenes would scrub the same
 * numbers and fight. Destroy one before booting another.
 */
export async function initScene(
  canvas: HTMLCanvasElement,
  opts: SceneOptions = {},
): Promise<SceneHandle> {
  performance.mark("lens:init-start");
  const storyMode = opts.story ?? false;
  // Kick the model fetch off FIRST — it needs no renderer, and serializing it
  // behind the WebGPU adapter request is pure added latency. The BODY GLB alone
  // gates the first frame; accessories stream in behind it.
  const withAccessories = opts.accessories ?? !storyMode;
  const modelPromise = loadLensModel({ accessories: withAccessories });
  // WebGPU (auto-falls back to WebGL2) — required for the TSL deform graph.
  // high-performance: this is a full-viewport hero, not a widget worth
  // throttling to a dual-GPU machine's integrated chip.
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
    // MOBILE-FALLBACK REPRO SWITCH: phones without WebGPU silently take
    // three's WebGL2 backend, which compiles the TSL graphs to GLSL instead of
    // WGSL. `?webgl` forces that backend on the desktop so it is reproducible.
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
  // THE DEFORM'S DIALECT, the moment the backend choice is final and well
  // before prepareModelMaterials bakes it into a graph: the chain ships as
  // generated source (ops/emit) and WGSL and GLSL are different files.
  setDeformBackend(
    (renderer as unknown as { backend?: { isWebGLBackend?: true } }).backend
      ?.isWebGLBackend
      ? "glsl"
      : "wgsl",
  );

  // DEV (`?diag`): a fixed status card readable off a phone — backend,
  // wormhole-post status, three revision. Must come after `renderer.init()`,
  // when the backend choice is final; the overlay is imported lazily.
  const diag: import("../dev/diag").LensDiag | null =
    import.meta.env.DEV && new URLSearchParams(location.search).has("diag")
      ? { post: "unmounted" }
      : null;
  if (diag)
    void import("../dev/diag").then((m) => m.mountLensDiag(renderer, diag));

  // DEV (`?mtrace`): one row per rendered frame, so the story's movement can
  // be reviewed as curves instead of stills. Written from tick().
  let motionTrace: import("../dev/motion-trace").MotionTrace | null = null;
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mtrace"))
    void import("../dev/motion-trace").then((m) => {
      motionTrace = m.mountMotionTrace();
    });

  const scene = new THREE.Scene();
  // far=400: the story's ortho holds pull the camera back far enough that a
  // 100 far plane would clip the lens away.
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
  const camDist = opts.cameraDistance ?? 1;
  camera.position.set(3.5 * camDist, 1.6 * camDist, 5 * camDist);

  const environment = setLensEnvironment(renderer, scene);

  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(3, 5, 6);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 1.3);
  rim.position.set(-4, -1, -3);
  const hemi = new THREE.HemisphereLight(0xf1f5f9, 0x8090a0, 0.9);
  scene.add(key, rim, hemi);

  // ── Room light (setRoomLight) ──────────────────────────────────────────────
  // THE ROOM IS FOUR NUMBERS: the IBL and the three lights above, which a dive
  // into the barrel puts out TOGETHER — dimming only the IBL leaves the key
  // light painting an interior wall with no window. Boot values captured so the
  // ramp is a pure scale. Never `scene.backgroundIntensity`, the traced sky's.
  const roomLightBoot = {
    env: scene.environmentIntensity,
    key: key.intensity,
    rim: rim.intensity,
    hemi: hemi.intensity,
  };
  let roomLight = 1;

  // --- real lens model (Blender exterior + optics, GLB) --------------------
  const modelGroup = new THREE.Group();
  modelGroup.rotation.z = -Math.PI / 2;
  modelGroup.scale.setScalar(MODEL_SCALE);
  scene.add(modelGroup);

  const { scene: gltfScene, accessoriesReady: accessoriesLoad } =
    await modelPromise;
  // A never-rejecting handle to the accessories load, so every consumer below
  // can `.then` without its own catch: on failure they simply never appear.
  const accessoriesReady = accessoriesLoad.catch((err) => {
    console.warn("lens: accessories failed to load (hood/caps/filter)", err);
  });
  performance.mark("lens:model-loaded");
  modelGroup.add(gltfScene);
  // DEV (`?probe`): the raw model root on window, so a part can be addressed
  // by NAME from the console or Playwright.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("probe"))
    (window as unknown as Record<string, unknown>).__lensModel = gltfScene;

  // Roll the lens upright about its own optical axis (gltf-local +Y). RIG-SAFE
  // because every mechanism and every recipe's theta is defined along or about
  // that axis, so this only re-phases the start angle.
  gltfScene.rotation.y = Math.PI / 2;

  const { unified, shading, frames } = prepareModelMaterials(gltfScene);
  performance.mark("lens:materials-ready");
  if (import.meta.env.DEV) {
    reportOpsFrames(gltfScene, frames);
    // Model-contract tripwire: a re-export that drifts from the code's
    // structural assumptions fails loudly HERE rather than as a silent no-op.
    // After deriveFrames on purpose — half the contract is about its frames.
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

  // Removable accessories, hidden by default. They load in the BACKGROUND, so
  // these groups start EMPTY and are populated once that settles.
  const accessories: Record<AccessoryGroup, THREE.Object3D[]> = {
    hood: [],
    filter: [],
    caps: [],
  };
  // The page's live accessory choice, so the background load applies the
  // LATEST desired visibility on arrival and a toggle-off during the load
  // still wins. `setAccessory` is the only writer.
  const accessoryOn: Record<AccessoryGroup, boolean> = {
    hood: false,
    filter: false,
    caps: false,
  };

  // Recentre the model's visual centre on the world origin, which is what
  // OrbitControls orbits. Measured over the BARE lens only — Box3 ignores
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

  /** The dive's dolly along world X (setLensDolly). */
  let dollyX = 0;

  /** THE ONLY WRITER of modelGroup.position: the recentring offset re-derived
   *  under the CURRENT rotation, plus the dolly. Both setters compose through
   *  here because the recentre is a whole-vector write, so a dolly written
   *  beside it would be erased by the next reorient and vice versa. */
  function applyModelPlacement() {
    modelGroup.position
      .copy(bootPosition)
      .applyQuaternion(bootQuatInv)
      .applyQuaternion(modelGroup.quaternion);
    modelGroup.position.x += dollyX;
    dirty = true;
  }

  // Both resolve nodes AFTER the recentre: the lead-screw pivot math reads
  // world positions.
  const mechanism = createMechanism(gltfScene);
  const cinematics = createCinematics(scene, gltfScene);

  // Torn down before a deferred load resolved? Every continuation below must
  // then no-op instead of touching a disposed controller.
  let destroyed = false;

  let dirty = true;

  /** Accessory-ness by ANCESTRY: accessories merge into the body's graph and
   *  their sub-meshes carry generic names, so only the walk up tells them
   *  apart. */
  function underAccessory(o: THREE.Object3D): boolean {
    for (let a: THREE.Object3D | null = o; a; a = a.parent)
      if (isAccessory(a.name)) return true;
    return false;
  }

  // ── Transmissive glass (setGlassTransmissive) ──────────────────────────────
  //
  // A SWAP AND NOT A FLAG: the shipped glass already has transmission and IOR,
  // but `thickness` is 0, and three scales the refraction ray by it — so the
  // elements read as flat windows. Thickness is PER ELEMENT while all of them
  // share one material instance, so each needs its own CLONE.
  //
  // CLONE, never a fresh material: the elements wear ops/host's deform graph
  // and a fresh material would drop it. NodeMaterial.copy carries every node
  // slot across, so the clone still deforms.
  //
  // OWNERSHIP HAZARD. The look swapper re-materials EVERY mesh and knows
  // nothing about these clones, so a shading swap while this is on silently
  // stomps them — and a naive restore would stomp the new look right back.
  // Hence the restore only ever touches meshes STILL WEARING the clone it made.
  // A site THEME FLIP on a bench look is the one path no ordering can fix (the
  // flip is the user's, not a demo's), so setTheme RE-SEATS instead: the theme
  // work lands, then the swap is re-made on top of it from the spans kept
  // below, carrying the fades across.
  let glassTransmissive = false;
  /** the spans last enabled with, so a theme flip can re-make the swap
   *  without the caller being involved */
  let glassSpans: Record<string, GlassSpanMm> = {};
  /** what each swapped mesh wore before, and the clones we own. */
  const glassSavedMaterial = new Map<THREE.Mesh, THREE.Material>();
  const glassClones = new Set<THREE.Material>();
  /** THE CLONES OUTLIVE THE SWAP. A fresh material is a fresh PIPELINE, and
   *  three compiles one on the frame that first DRAWS it — the dive's first
   *  frame — so each clone is kept here and handed back on the next crossing.
   *  An entry is dropped only when the mesh's own material changed under it (a
   *  clone of the old palette must not come back); freed at destroy(). */
  const glassCloneCache = new Map<
    THREE.Mesh,
    { src: THREE.Material; clone: THREE.MeshPhysicalNodeMaterial }
  >();
  /** the same clones and meshes GROUPED BY ELEMENT — what the passage fade
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
  /** every mesh whose EFFECTIVE opacity (the product of the two fades) has
   *  reached 0 — the set applyVisibility reads. An element at alpha 0 still
   *  costs a transmission draw and still writes depth. */
  const glassGone = new Set<THREE.Mesh>();

  /** Push `glassFade × glassElementFade[id]` onto every clone and keep
   *  `glassGone` in step. Returns true if the gone-set MOVED, i.e. the caller
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
    // …times the GLINT LEVEL, applied HERE like the detint below: this is the
    // one place a clone is made, so a theme re-seat mid-dive comes back at the
    // darkness the dive had reached.
    clone.specularIntensity = GLASS_TRANSMISSIVE_SPECULAR * glassGlint;
    clone.thickness = thickness;
    // COLOURLESS (see GLASS_DETINT), applied here so a theme re-seat detints
    // too. Whole Color objects, not `.setHex`: these slots exist only on a
    // physical material, so a mutation would throw where an assignment is
    // inert.
    clone.color = new THREE.Color(GLASS_DETINT.color);
    clone.specularColor = new THREE.Color(GLASS_DETINT.specularColor);
    clone.attenuationColor = new THREE.Color(GLASS_DETINT.attenuationColor);
    clone.attenuationDistance = GLASS_DETINT.attenuationDistance;
    clone.iridescence = GLASS_DETINT.iridescence;
    // Marked transparent once HERE and not when the fade first moves:
    // `transparent` picks the render list, so flipping it mid-dive would
    // re-sort and recompile the whole stack. At opacity 1 it costs nothing.
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
      // Thickness is LOCAL and three multiplies by the model scale itself, so
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
    // The opacities LAST, in one pass, so a re-seat resumes at exactly the
    // fade levels reached rather than at 1.
    writeGlassOpacity();
  }

  /** Hand every mesh STILL WEARING one of our clones back its saved material.
   *  Touches neither fade LEVEL, and DISPOSES NOTHING — the clones belong to
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
   * Re-make the transmissive swap over whatever the meshes wear NOW — the theme
   * flip's answer to the ownership hazard above. ORDER MATTERS: the release
   * restores only meshes still holding a clone, so once shading has stomped
   * them it restores nothing and the NEW theme's materials stay put for the
   * re-clone to source from. The re-enable re-applies both fade levels, so a
   * flip at any point of the dive resumes at the same opacities.
   */
  function reseatGlassTransmissive() {
    releaseGlassClones();
    enableGlassTransmissive(glassSpans);
    visibilityDirty = true;
  }

  // ── Body fade (setBodyFade) ────────────────────────────────────────────────
  // The glass fade's opposite number, writing shared material PROPERTIES where
  // the glass had to clone (see the handle method). `bodySaved` is what each
  // touched material wore, so the restore is exact.
  let bodyFade = 1;
  let bodyFadedOut = false;
  const bodySaved = new Map<
    THREE.Material,
    { transparent: boolean; opacity: number }
  >();

  /** Every DISTINCT material worn by a piece the body fade owns — the shapes
   *  applyVisibility walks, PLUS the child passes riding a host mesh (outline
   *  hulls, line-work), since a body that fades while its outline stays reads
   *  as a wireframe ghost.
   *
   *  THE GLASS IS IN IT, EXCEPT WHILE THE DIVE OWNS IT: inside the fly-through
   *  the elements wear transmissive clones whose opacity is the passage fades',
   *  and two owners on one opacity is exactly the hazard the glass swap
   *  documents. The capture is lazy and re-taken after every restore, so
   *  excluding the glass while the swap is on is precisely the dive's span. */
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

  /** setGlassGlint: a pure scale off the shipped specular. The LEVEL is kept
   *  whether or not the swap is on — every clone made picks it up, which is
   *  what carries it through a theme re-seat. */
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
    // THE MERGED PAIR'S `transparent` HAS ONE OWNER (materials/unified.ts),
    // because setInk's 0-edge flips the very instances this fades — so the fade
    // only DECLARES itself and unified resolves `inkOn || fadeActive`. The
    // materials unified does not own are handled below.
    //
    // FIRST, AHEAD OF THE CAPTURE, because declaring also takes the ink twin
    // off: this function owns `opacity` on whatever the meshes wear when it
    // captures them, and a swap after the capture would strand the level on a
    // material nothing wears. The restore is the same story in reverse.
    unified.bodyFadeActive(o < 1);
    if (o >= 1) {
      // back to the shipped state exactly: opacity, plus the transparent flag
      // on everything whose flag is this function's
      for (const [m, was] of bodySaved) {
        m.opacity = was.opacity;
        if (unified.ownsTransparent(m)) continue; // …but not that flag (below)
        // …and only when it actually MOVES: three keys a pipeline on
        // `transparent`, so a needsUpdate here is a program rebuild, and
        // materials already built transparent would pay one at every crossfade
        // edge for a flag that never changed value.
        if (m.transparent === was.transparent) continue;
        m.transparent = was.transparent;
        m.needsUpdate = true;
      }
      bodySaved.clear();
    } else {
      // Captured LAZILY and re-captured after every restore: a shading switch
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

  // ── Shell gate (setShellFade) ──────────────────────────────────────────────
  // A VISIBILITY gate, not a material one (the handle method says why): the
  // level is a per-mesh THRESHOLD, so the shell leaves piece by piece across
  // the fade and nothing here can be stomped by a shading swap.
  let shellFade = 1;
  /** the shell meshes hidden RIGHT NOW — the set applyVisibility reads. */
  const shellGone = new Set<THREE.Mesh>();
  /** each shell mesh's own hide threshold, captured on the first call that
   *  actually moves the level. */
  const shellThreshold = new Map<THREE.Mesh, number>();
  let shellCaptured = false;
  /** THE INTERIOR — its own fade CHANNEL, not a band: the cladding and the
   *  rest-cast leave with the peel but RETURN over the internals tail, so the
   *  dive passes through the full interior while the shell and baffles stay off
   *  until the rewrap. Two levels, one mechanism. */
  let interiorFade = 1;
  const interiorGone = new Set<THREE.Mesh>();
  const interiorThreshold = new Map<THREE.Mesh, number>();

  /** Hand every top-level mesh, IN TRAVERSAL ORDER, to the shared
   *  threshold-wink law (core/visibility.ts) and file the result on its
   *  channel. The bands and the scatter live there so a second caller can
   *  reproduce these gone-sets off the shipped GLB. */
  function captureShellThresholds() {
    const wink = makeWinkScatter();
    gltfScene.traverse((o) => {
      // the same shapes applyVisibility walks: top-level meshes only, since
      // the child line/hull passes ride their host's flag
      if (!(o instanceof THREE.Mesh) || o.parent instanceof THREE.Mesh) return;
      const w = wink(o.name);
      if (!w) return;
      (w.channel === "shell" ? shellThreshold : interiorThreshold).set(
        o,
        w.threshold,
      );
    });
  }

  /** The interior channel's own level — same clamp, same lazy capture, same
   *  moved-only visibility pass as applyShellFade below. */
  function applyInteriorFade(opacity: number) {
    const o = Math.min(1, Math.max(0, opacity));
    if (o === interiorFade) return;
    interiorFade = o;
    if (!shellCaptured) {
      shellCaptured = true;
      captureShellThresholds();
    }
    let moved = false;
    for (const [m, t] of interiorThreshold) {
      const gone = o <= t;
      if (gone === interiorGone.has(m)) continue;
      moved = true;
      if (gone) interiorGone.add(m);
      else interiorGone.delete(m);
    }
    if (moved) {
      visibilityDirty = true;
      dirty = true;
    }
  }

  function applyShellFade(opacity: number) {
    // The story envelope is a SUM of two overlapping ramps and can transiently
    // leave [0,1] — clamped here, not at the caller.
    const o = Math.min(1, Math.max(0, opacity));
    if (o === shellFade) return;
    shellFade = o;
    // Captured lazily but ONCE: the set is meshes, not materials, so — unlike
    // applyBodyFade's — a shading switch or theme flip cannot invalidate it.
    if (!shellCaptured) {
      shellCaptured = true;
      captureShellThresholds();
    }
    let moved = false;
    for (const [m, t] of shellThreshold) {
      const gone = o <= t;
      if (gone === shellGone.has(m)) continue;
      moved = true;
      if (gone) shellGone.add(m);
      else shellGone.delete(m);
    }
    // the sweep is owed only when the hidden set MOVED — this runs from the
    // scroll driver on every frame of the story
    if (moved) {
      visibilityDirty = true;
      dirty = true;
    }
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
   * THE ONE OWNER of the model's `.visible` flags. Four gates can hide a piece:
   * the glass fades' tail, the body fade's tail, the shell gate and the
   * interior gate. Composed in ONE pass — a piece is visible iff EVERY active
   * gate allows it, so no gate's restore can stomp another still engaged.
   * ACCESSORIES have their own owner and are skipped entirely.
   *
   * DIRTY-FLAGGED: the sweep is a pure function of current gate state, so gate
   * writers raise `visibilityDirty` and tick() composes ONCE before the render
   * — N gate moves in a frame cost one traversal, no moves cost none.
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
    if (destroyed) return;
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
    // Accessories arrive AFTER the body's frame pass, so each root gets its
    // OWN scoped pass and is measured against itself alone. Folding them into
    // the body pass would shift the body ladder.
    for (const group of Object.keys(accessories) as AccessoryGroup[])
      for (const obj of accessories[group]) deriveFrames(obj);
    // …then the merged material over the WHOLE scene, so a mesh that was
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
  /** the drawing buffer's CSS-pixel size — held GROW-ONLY in height (below) */
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
    // THE URL-BAR LAW: mobile browsers resize the dvh viewport on every scroll
    // direction change, and a buffer realloc on each is a felt stutter. So the
    // buffer only reallocates on a WIDTH change or a height GROWTH; a
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
    parkScale = Math.max(0, Math.min(1, (w / h - 0.8) / 0.7));
    // Size the lens by the SMALLER viewport dimension, capped at the layout
    // width. A perspective camera otherwise scales pixel size purely by
    // viewport height, so zoom corrects with (capped min dimension) / height.
    const rem =
      parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const MAX_PX = 112 * rem; // matches --container-layout
    camera.zoom = Math.min(w, h, MAX_PX) / h;
    camera.updateProjectionMatrix();
    dirty = true;
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  const storyPos = new THREE.Vector3();
  const storyUp = new THREE.Vector3();
  const storyTarget = new THREE.Vector3();

  // --- node tracking (DOM annotations that follow model parts) ---------------
  // Every part's geometry is baked in place, so a node's VISUAL centre is its
  // bbox centre — resolved once into the node's pose-independent LOCAL frame
  // and then followed through the live transform.
  const frameCbs: ((
    project: (name: string, out: TrackedPoint) => TrackedPoint | null,
  ) => void)[] = [];
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

  // …and the DRAWN disc (projectDrawn): the same cached seated centre plus the
  // world bounding radius, put through the CPU op field before projection —
  // which is the whole difference from `project` above.
  const drawCache = new Map<
    string,
    { mesh: THREE.Mesh; local: THREE.Vector3; radius: number } | null
  >();
  const drawC = new THREE.Vector3();
  const drawE = new THREE.Vector3();
  const drawRight = new THREE.Vector3();
  function projectDrawn(name: string): TrackedCircle | null {
    let t = drawCache.get(name);
    if (t === undefined) {
      const obj = gltfScene.getObjectByName(name);
      // the op field is a MESH's, so a group node is followed by its first
      // mesh
      let mesh: THREE.Mesh | null = null;
      obj?.traverse((o) => {
        if (!mesh && o instanceof THREE.Mesh) mesh = o;
      });
      if (!obj || !mesh) {
        console.warn(`lens scene: no model mesh named "${name}" to draw on`);
        t = null;
      } else {
        const box = new THREE.Box3().setFromObject(obj);
        const half = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
        t = {
          mesh,
          local: (mesh as THREE.Mesh).worldToLocal(
            box.getCenter(new THREE.Vector3()),
          ),
          // the LARGEST HALF-EXTENT, not the bounding sphere: a lens element
          // is a disc, and the sphere around its box is √2 too wide
          radius: Math.max(half.x, half.y, half.z),
        };
      }
      drawCache.set(name, t);
    }
    if (!t) return null;
    t.mesh.updateWorldMatrix(true, false);
    drawC.copy(t.local);
    displaceSeatedPoint(t.mesh, drawC);
    t.mesh.localToWorld(drawC);
    // the radius measured ACROSS the screen: one camera-right world offset of
    // the seated bounding radius, projected alongside the centre
    drawRight
      .setFromMatrixColumn(camera.matrixWorld, 0)
      .multiplyScalar(t.radius);
    drawE.copy(drawC).add(drawRight);
    drawC.project(camera);
    drawE.project(camera);
    if (drawC.z > 1) return null; // behind the camera
    // NDC → frame heights from the centre: y is a straight half, x carries the
    // aspect (see TrackedCircle)
    const aspect = cssW / cssH;
    const x = (drawC.x * aspect) / 2;
    return {
      x,
      y: -drawC.y / 2,
      r: Math.abs((drawE.x * aspect) / 2 - x),
    };
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

  // DEV hero-camera preview: while true, tick() takes the story-mode camera
  // branch and OrbitControls is bypassed. orbitPose is the free-orbit state
  // saved on engage and restored on exit.
  let storyCam = false;
  const orbitPose = {
    pos: new THREE.Vector3(),
    up: new THREE.Vector3(),
    fov: camera.fov,
  };

  // STORY fly-through fov override, laid over the story sample in tick(). The
  // POSE stays the story's — the dive moves the lens, not the camera.
  let storyFov: number | null = null;
  let storyFovMix = 1;
  /** setStoryCentre: how much of the story's view offset the dive drops. */
  let storyCentre = 0;

  // --- per-part additive offsets (SceneHandle.setPartOffset) -----------------
  // Applied around each RENDERED frame: the post-mechanism transform is
  // snapshotted, base⊕offset is written, and the base is restored after the
  // frame's callbacks — so repeated calls can never accumulate.
  const partOffsets = new Map<
    string,
    {
      obj: THREE.Object3D;
      off: PartOffset;
      base: { pos: THREE.Vector3; rot: THREE.Euler; scl: THREE.Vector3 };
    }
  >();
  let partOffsetsApplied = false;
  function applyPartOffsets() {
    if (partOffsets.size === 0) return;
    for (const e of partOffsets.values()) {
      const { obj, off, base } = e;
      base.pos.copy(obj.position);
      base.rot.copy(obj.rotation);
      base.scl.copy(obj.scale);
      if (off.position)
        obj.position.set(
          base.pos.x + off.position[0],
          base.pos.y + off.position[1],
          base.pos.z + off.position[2],
        );
      if (off.rotation)
        obj.rotation.set(
          base.rot.x + off.rotation[0],
          base.rot.y + off.rotation[1],
          base.rot.z + off.rotation[2],
        );
      if (off.scale !== undefined) obj.scale.multiplyScalar(off.scale);
    }
    partOffsetsApplied = true;
  }
  function revertPartOffsets() {
    if (!partOffsetsApplied) return;
    for (const e of partOffsets.values()) {
      e.obj.position.copy(e.base.pos);
      e.obj.rotation.copy(e.base.rot);
      e.obj.scale.copy(e.base.scl);
    }
    partOffsetsApplied = false;
  }

  // value and Target both start at the channel's registry default
  const state = Object.fromEntries(
    CHANNELS.flatMap((c) => [
      [c, CHANNEL_DEFAULTS[c]],
      [`${c}Target`, CHANNEL_DEFAULTS[c]],
    ]),
  ) as SceneState;

  const EASE = CHANNEL_EASE;
  const STATE_EPS = 1e-4;

  // applyShading is the ONE instant-swap path — the setShading method and the
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
      if (!activeSwap) return; // destroyed mid-flight
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
   * Push the CURRENT channel values into the mechanism and the shader channels.
   * Split out of tick() so the dev path visualizer can re-drive everything at
   * arbitrary values — ONE drive path, so a walked pose is built exactly the
   * way a rendered frame is.
   */
  function driveChannels(): { apertureT: number; explodeT: number } {
    // Real cams are non-linear. ONE shared ease across every zoom channel —
    // per-channel eases visibly desynchronize the guts.
    const zoomT = smoothstep(0, 1, clamp01(state.zoom));
    const focusT = clamp01(state.focus);
    const apertureT = clamp01(state.aperture);
    const explodeT = clamp01(state.explode);

    // The MEASURED motions only: ring throws, the element slides they drive,
    // the lead screw's spin, the iris sweep. Everything else is a recipe and
    // runs in-shader off the channels below.
    mechanism.update({
      zoom: zoomT, // the shared-smoothstep value, NOT the raw eased channel
      focus: focusT,
      aperture: apertureT,
    });

    // The op recipe channels: these ARE the deform, one registry channel per
    // recipe uniform. DERIVED from the recipe list, so a new recipe plus its
    // registry row is the whole edit; the mechanism trio above stays
    // hand-written because its three reads share one ease.
    for (const name of RECIPE_NAMES)
      recipeChannel(name).value = clamp01(state[name]);

    return { apertureT, explodeT };
  }

  function tick() {
    // skipped, not just disabled, under the hero-camera preview: update()
    // would re-aim the camera from the controls' own state every frame
    if (controls && !storyCam) controls.update();

    if (
      postStaleAt !== 0 &&
      performance.now() - postStaleAt > POST_RESIZE_SETTLE_MS
    )
      rebuildPost();

    // ease every channel toward its target; `easing` keeps redraws running
    // until everything settles
    let easing = false;
    for (let i = 0; i < CHANNELS.length; i++) {
      const c = CHANNELS[i];
      const before = state[c];
      state[c] = lerp(before, state[TARGET_KEYS[i]], EASE);
      if (Math.abs(state[c] - before) > STATE_EPS) easing = true;
    }

    // NO IDLE EARLY-OUT IN STORY MODE: the ambient dust, the internals phase
    // clock and the card orbit are time-based onFrame riders that write no
    // channel and mark nothing dirty, so gating them here would FREEZE them.
    // Everything below only affects the frame about to be rendered, so a fully
    // idle /lens tick does near-zero work.
    if (!storyMode && !dirty && !easing) return;
    dirty = false;

    if (storyMode || storyCam) {
      // sample the scripted pose, then hand the framing (pose copy, park,
      // portrait lift) to story/camera
      const storyP = clamp01(state.story);
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
        storyP,
      );
      // THE DIVE'S FRAMING over the pose the story just placed: its own fov
      // ramp and its claim on the frame's CENTRE. The offset is scaled toward
      // zero rather than cleared, so the two owners cross on a ramp instead of
      // at an edge; at 1 the optical axis sits dead centre, which is the dive's
      // whole geometry. Landscape rows park at xs 0 and have nothing to scale.
      if (storyCentre > 0) {
        const v = camera.view;
        if (v)
          camera.setViewOffset(
            v.fullWidth,
            v.fullHeight,
            v.offsetX * (1 - storyCentre),
            v.offsetY * (1 - storyCentre),
            v.width,
            v.height,
          );
      }
      if (storyFov !== null && storyFovMix > 0) {
        camera.fov = lerp(camera.fov, storyFov, storyFovMix);
        camera.updateProjectionMatrix();
      }
    }

    // Depth-fade planes track the live camera distance so the body stays in
    // the full-opacity middle and only exploded pieces cross one. Widths are in
    // model radii, so this scales with the scene's shooting distance.
    {
      // Distance to the SUBJECT, which is the lens at x = dollyX, not the
      // origin. TRACKING THE DOLLY IS THE INK'S LICENCE: the ink look folds
      // this fade into its opacity, and its return ramp opens while the reveal
      // is still seating — planes centred on the origin would put the parked
      // lens deep into its own far fade and dissolve its tail.
      const camDist =
        storyMode || storyCam
          ? Math.sqrt(
              (storyPos.x - dollyX) * (storyPos.x - dollyX) +
                storyPos.y * storyPos.y +
                storyPos.z * storyPos.z,
            )
          : camera.position.length();
      uFadeNear1.value = camDist - modelRadius * 1.05;
      uFadeNear0.value = camDist - modelRadius * 2.3;
      uFadeFar0.value = camDist + modelRadius * 1.05;
      uFadeFar1.value = camDist + modelRadius * 2.6;
    }

    // The drawn sky rides ON the camera: parking it on this frame's eye
    // position is what makes near geometry behave like an infinitely distant
    // sky (no parallax as the dive travels).
    starfield?.sync(camera);
    // The wormhole reads the SAME frame the starfield just synced, so the
    // funnel's centre and the sky it swallows can never be a frame apart.
    if (postMounted) wormholePost?.sync(camera);

    const { explodeT } = driveChannels();
    // composed on top of what the mechanism just wrote; reverted after the
    // frame's callbacks
    applyPartOffsets();
    cinematics.update(explodeT, performance.now());
    // ONE owner writes every `.visible` flag, and only when a gate writer
    // marked the composition stale (see applyVisibility)
    if (visibilityDirty) {
      visibilityDirty = false;
      applyVisibility();
    }

    // TWO RENDER PATHS: mounted, the frame goes through the wormhole pass;
    // unmounted, it is the direct render. The warm-up's off-screen frame is
    // taken HERE, ahead of this tick's own render, because the pass renders
    // once per frame and a render from outside the loop compiles nothing.
    // the pose for THIS frame is final here — record it before the render
    motionTrace?.record(camera, state, modelRadius);
    // THE BODY'S WARM-UP, FROM THE FRAME AFTER THE FIRST: the ink twin's
    // pipeline, drawn once on the CANVAS ahead of the look resolution below.
    // Asked per frame rather than armed once, since integrate() mints new body
    // materials when the accessories land.
    if (firstFrameDone && unified.needsWarm("canvas"))
      unified.warmBodyLooks("canvas", () =>
        drewScene(() => renderer.render(scene, camera)),
      );
    // ONE WARM STEP PER TICK, and never on a tick the pass will draw for real:
    // the pass draws its SCENE once per tick, so a second step sharing the tick
    // — or a step sharing it with the render below — gets an output quad alone.
    if (warmQueue.length && !postMounted) {
      warmQueue.shift()!();
      if (warmQueue.length) dirty = true;
    }
    // WHICH CONTEXT THIS FRAME DRAWS IN — ONE reading, since three keys a
    // pipeline on the render context and it decides whether the twin may be
    // worn at all. The resolution and the render must not disagree.
    const viaPass = postMounted && wormholePost !== null ? wormholePost : null;
    unified.syncBody(viaPass ? "pass" : "canvas");
    if (viaPass) viaPass.render();
    else renderer.render(scene, camera);
    // after the render, so annotations see this frame's final transforms
    for (const cb of frameCbs) cb(project);
    revertPartOffsets();
    if (!firstFrameDone) {
      firstFrameDone = true;
      performance.mark("lens:first-frame"); // model visible (pipelines compiled)
    }
  }
  /** The ink twin's compile goes on the frame AFTER the first, never on it:
   *  the first frame is what time-to-first-frame is measured on, and the twin
   *  is an optimization for the frames after it. Until a warm frame is paid the
   *  body wears the blend material. */
  let firstFrameDone = false;
  renderer.setAnimationLoop(tick);
  let paused = false;
  let pathViz: PathViz | null = null;
  let inspector: Inspector | null = null;
  // The dive's DRAWN starfield, dynamically imported. The page's live choice
  // is tracked separately because the import is awaited, so an on→off during
  // the fetch must resolve OFF. While mounted it owns scene.background.
  let starfield: import("../optics/starfield").Starfield | null = null;
  let starsWanted = false;
  let starsBgSaved: THREE.Scene["background"] = null;
  // The fly-through's SCREEN-SPACE wormhole — same lazy-import shape and
  // latest-state rule as the starfield: `postMounted` is what tick() renders
  // through and is only ever set from `postWanted` AFTER the await, so an exit
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
      if (destroyed) return false; // torn down mid-import
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
      if (ok && !destroyed) postMounted = postWanted;
      if (diag) diag.post = postMounted ? "mounted" : "unmounted";
      dirty = true;
    });
  }

  /** warmFly runs once per page — see the handle method. */
  let warmedFly = false;
  /**
   * THE WARM QUEUE — every dry frame the scene owes, one per tick.
   *
   * The wormhole pass draws its SCENE once per tick (three's own frame guard on
   * `PassNode`): a second `render()` inside one tick re-runs the output quad
   * alone, so two pass warms sharing a tick leave the second compiling nothing.
   * Every step therefore gets a tick of its own, stages and restores inside it
   * ahead of that tick's render, and chains the next through `dirty`.
   */
  const warmQueue: (() => void)[] = [];
  function queueWarm(...steps: (() => void)[]) {
    warmQueue.push(...steps);
    dirty = true;
  }

  /** Did `body` reach the SCENE, or only the pass's output quad (one draw)? The
   *  renderer's own count is the probe, and it is what lets a warm refuse to
   *  mark a context it never drew in. */
  function drewScene(body: () => void): boolean {
    const before = renderer.info.render.drawCalls;
    body();
    return renderer.info.render.drawCalls - before > 1;
  }

  /** ONE FRAME THROUGH THE DIVE'S PASS, into a 1×1 target — the scene compiles
   *  against the pass's own target format and sample count, which is a
   *  different pipeline from the canvas's for every material drawn. No-op until
   *  the pass exists (warmFly builds it). */
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

  /** ONE DRAW OF `objects`, SHOWN NOWHERE — their buffers and textures upload
   *  here instead of on the frame their scene arrives. The canvas draw covers
   *  the canvas context; `viaPass` adds a pass-context draw because three keys
   *  a pipeline on the render context, and the queue gives it the tick to
   *  itself that its scene render needs. tick() renders again below in this
   *  same frame, so nothing reaches the screen. Culling is off for the draw: a
   *  sky object sits where the story camera is not yet looking, and a culled
   *  object uploads nothing. */
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

  /** ONE FRAME OF THE DIVE, DRAWN NOWHERE. The dive's look goes on, a frame is
   *  drawn through the wormhole pass into a 1×1 target, and everything comes
   *  back off — all inside ONE tick, so no rendered frame sees the half-state.
   *  What it buys is the pipeline cache the crossing would otherwise stall
   *  on. THE FIRST of the fly warm's three steps (see `warmQueue`). */
  function warmFlyFrame(spans: Record<string, GlassSpanMm>) {
    if (!starfield || !wormholePost) return;
    // THE CANVAS'S OWN HALF OF THE WARM-UP, first. `transparent` is the one
    // thing the realistic/ink blend cannot blend and three keys a pipeline on
    // it, so every shared material's realistic variant would otherwise compile
    // on the frame the ramp reaches 0. tick() repaints below in this same
    // frame, so nothing is shown. A canvas render spends no pass frame, so it
    // rides the same tick as the crossing's below.
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
          // the CLONES stay in the cache — half the point of the exercise
          disableGlassTransmissive();
        }
      });
    });
    dry.dispose();
    dirty = true;
  }

  /** THE INK TWIN THROUGH THE PASS: the ink returns while the span is still
   *  active, so the twin is drawn through the wormhole pass for the last of the
   *  rewrap. Its own tick, and its own context flag — the canvas warm unlocks
   *  the twin for canvas frames only, and the flag here is only granted if the
   *  draw reached the scene. */
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

  /** …AND THE HAND-BACK'S OWN FRAME. Below GLASS_HANDOVER `current` gives the
   *  elements their own material back, and the rewrap crosses that edge while
   *  the pass is still up. WEAR-FOR-WARMING: the blend is forced under the edge
   *  for the draw and put straight back; `current` still owns what a real frame
   *  wears. */
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

  // Dev-only perf probe: renderer.info plus live scene internals for
  // measurement scripts. Never present in prod builds.
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
      // the two model dissolves, reachable from the console for look passes
      // (the handle itself is not on window)
      setBodyFade: applyBodyFade,
      setGlassFade: applyGlassFade,
      // the dive's two darkness ramps: the room, and the glass's reflections
      setRoomLight: applyRoomLight,
      setGlassGlint: applyGlassGlint,
      // where a node is DRAWN, in frame heights — so an authored landing
      // circle can be re-measured against the live scene, not a screenshot
      projectDrawn,
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
      // meshes exist. Applied once loaded, re-reading the LATEST desired state
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
        // SNAP the story channel home: easing it down would sweep storyP back
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
      storyFov = fov;
      storyFovMix = fov === null ? 0 : clamp01(mix);
    },
    setStoryCentre(k) {
      if (!storyMode) return;
      storyCentre = clamp01(k);
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
        // Ancestors AND descendants: the model group's matrix carries the
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
      modelGroup.rotation.set(
        euler?.x ?? bootRotation.x,
        euler?.y ?? bootRotation.y,
        euler?.z ?? bootRotation.z,
      );
      applyModelPlacement();
    },
    setLensDolly(x) {
      if (x === dollyX) return;
      dollyX = x;
      applyModelPlacement();
    },
    setPartOffset(name, offset) {
      if (!offset) {
        if (partOffsets.delete(name)) dirty = true;
        return;
      }
      let e = partOffsets.get(name);
      if (!e) {
        const obj = gltfScene.getObjectByName(name);
        if (!obj) {
          console.warn(`lens scene: no part named "${name}" to offset`);
          return;
        }
        e = {
          obj,
          off: offset,
          base: {
            pos: new THREE.Vector3(),
            rot: new THREE.Euler(),
            scl: new THREE.Vector3(),
          },
        };
        partOffsets.set(name, e);
      } else {
        e.off = offset;
      }
      dirty = true;
    },
    partNames() {
      const names = new Set<string>();
      gltfScene.traverse((o) => {
        if (o !== gltfScene && o.name) names.add(o.name);
      });
      return [...names].sort();
    },
    addOverlay(obj) {
      scene.add(obj);
      dirty = true;
    },
    removeOverlay(obj) {
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
    projectDrawn,
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
            // the ONE channel registry, so analysis walks start from the
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
          if (destroyed) return false; // torn down mid-import
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
      // The LATEST desired state, not the captured `on`: an exit during the
      // import must not let this continuation strand a mount. The BACKDROP
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
      if (destroyed) return false;
      return wormholePost ? true : startPost();
    },
    async enableWormholePost(on) {
      postWanted = on;
      if (!wormholePost) {
        if (!on) return true; // never started, nothing to turn off
        if (!(await startPost())) return false;
      }
      // the LATEST desired state, not the captured `on`: an exit during the
      // import must not let this continuation strand a mount
      postMounted = postWanted;
      if (diag) diag.post = postMounted ? "mounted" : "unmounted";
      dirty = true;
      return true;
    },
    async warmFly(spans) {
      // never over a live dive, and never twice
      if (destroyed || warmedFly || glassTransmissive || postMounted)
        return false;
      warmedFly = true;
      // BUILD, then DROP: each pair mounts and unmounts inside one microtask
      // chain, so no frame renders with the sky or the pass up, and AWAITING
      // means two calls can never both build the module.
      await handle.enableStarfield(true);
      await handle.enableStarfield(false);
      await handle.enableWormholePost(true);
      await handle.enableWormholePost(false);
      if (destroyed || !starfield || !wormholePost) return false;
      // THREE STEPS, THREE TICKS (see `warmQueue`): the crossing's clones, the
      // ink twin, and the hand-back's own material each need the pass's one
      // scene render of a tick, and none may run from outside the loop.
      queueWarm(() => warmFlyFrame(spans), warmFlyTwinFrame, warmFlyGlassFrame);
      return true;
    },
    warmDraw(objects, viaPass = false) {
      // TAKEN BY tick(), like the dive's own dry frames: the renderer is not
      // re-entered from the idle callback that asked, and a `viaPass` job needs
      // a tick to itself.
      if (destroyed || objects.length === 0) return;
      const job = objects.slice();
      queueWarm(() => warmDrawFrame(job, viaPass));
    },
    setInkMix(v) {
      unified.setInk(v);
      // THE ENDPOINTS ARE THE TWO MODES, and `currentShading` must say so:
      // swapShading early-returns on it, and getShading() is what demos
      // snapshot to restore later. Mid-ramp the two diverge deliberately — a
      // ramp only runs on the STORY page, where nothing calls swapShading.
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
        if (destroyed) return false; // torn down mid-import
        shading.installBench(createShadingBench);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`lens shading: the bench failed to load — ${msg}`, err);
        return false;
      }
      return true;
    },
    getShading: () => activeSwap?.pending ?? currentShading,
    swapShading,
    setTheme(l) {
      shading.setTheme(l);
      cinematics.setTheme(l);
      starfield?.setTheme(l); // the drawn sky just re-tints (no re-bake)
      // AFTER shading, never instead of it: on a bench look shading.setTheme
      // re-materials every mesh and stomps the clones (the ownership hazard at
      // enableGlassTransmissive). Let the theme work land, then re-seat on top
      // of it — the fade rides along, so a flip mid-melt is invisible.
      if (glassTransmissive) reseatGlassTransmissive();
      dirty = true;
    },
    destroy() {
      destroyed = true;
      postMounted = false;
      if (activeSwap) {
        cancelAnimationFrame(activeSwap.raf);
        activeSwap.run.finish(); // restore whatever it was driving
        activeSwap = null;
      }
      renderer.setAnimationLoop(null);
      // put the shipped glass materials back BEFORE the model teardown walks
      // them, so the clones are the only thing freed here
      disableGlassTransmissive();
      // …and the cache the swap hands its clones back to, which outlives it
      for (const e of glassCloneCache.values()) e.clone.dispose();
      glassCloneCache.clear();
      applyBodyFade(1);
      pathViz?.dispose();
      inspector?.dispose();
      starfield?.dispose();
      wormholePost?.dispose();
      ro.disconnect();
      controls?.dispose();
      cinematics.dispose();
      renderer.dispose();
      environment.dispose();
      shading.dispose();
      unified.dispose();
      disposeLensModel(gltfScene);
      // The accessories may still be in flight — dispose again once they
      // merge. disposeLensModel dedupes per call, so re-running is safe.
      accessoriesReady.then(() => disposeLensModel(gltfScene));
    },
  };
  return handle;
}
