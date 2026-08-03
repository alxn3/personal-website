import * as THREE from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import {
  disposeLensModel,
  loadLensModel,
  setLensEnvironment,
} from "./model";
import { createShading, type ShadingMode } from "../materials/shading";
import { deriveFrames } from "../ops/frames";
import {
  applyOps,
  recipeChannel,
  recipeChannels,
  recipeKnobs,
  reportOpsFrames,
  setActiveRecipes,
  RECIPE_NAMES,
  type RecipeName,
} from "../ops/host";
import {
  uFadeNear0,
  uFadeNear1,
  uFadeFar0,
  uFadeFar1,
} from "../materials/depthfade";
import { sampleStory, applyStoryFraming } from "../story/camera";
import { createMechanism, tagMechanismSpins } from "../ops/mechanism";
import { createCinematics, type StoryVisibility } from "../story/cinematics";
import {
  isAccessory,
  isGlassElement,
  isOpticsIsolate,
  isSilhouetteGreeble,
} from "./parts";
import { clamp01, smoothstep, lerp } from "./math";
import {
  TRANSITIONS,
  type TransitionContext,
  type TransitionName,
  type TransitionRun,
} from "./transitions";
// Type-only: erased at build, so the dev instruments stay out of every bundle
// until enablePathViz() / enableInspect() dynamically import them.
import type { PathViz } from "../dev/paths";
import type { Inspector } from "../dev/inspect";

export type { ShadingMode } from "../materials/shading";
export type { PathViz } from "../dev/paths";
export type { TransitionName } from "./transitions";

/** Options for SceneHandle.swapShading — see the method's doc comment. */
export interface SwapShadingOptions {
  /** which choreography carries the cut (default "blink") */
  transition?: TransitionName;
  /** total transition length; each transition has its own default (~300-450ms) */
  durationMs?: number;
  /** "twist" only: full integer turns per swap (default 1) */
  turns?: number;
  /** Per-frame raw progress (0..1) of the running transition, for page-side
   *  cooperation (e.g. a page flash synced to the swap beat). Not called when
   *  the swap collapses to instant (reduced motion / declined transition). */
  onProgress?: (t: number) => void;
}

// ============================================================================
// Scene orchestration: renderer, camera, lights, model load, state easing and
// the per-frame tick. The parts that DO things live in focused modules — see
// README.md's file index. Deliberate: this orchestrator owns the story camera
// and cinematics wiring even for the free-orbit /lens viewer (which bundles
// them unused) — ONE assembly path beats injecting story pieces per caller.
// ============================================================================

/** One channel's registry entry: its rest/default value plus the per-channel
 *  flags every derived list keys off. Add a channel = ONE row in
 *  CHANNEL_REGISTRY; the lists below (and the sites that import them) follow. */
interface ChannelSpec {
  /** rest value AND markup default (also the ease target at boot) */
  default: number;
  /** ANIMATION-owned: /lens hand-rests this channel's target on animation
   *  switch/None (lens.astro resetAnimChannels, via ANIM_RESET_CHANNELS) so no
   *  stale pose survives. Slider channels (lens.astro sliderChannels) are
   *  restored by applyManualSliders instead and are NOT flagged — EXCEPT
   *  explode, which is both (the slider default re-wins right after the reset). */
  animReset?: boolean;
  /** recipe channel that must read 0 for the instrument's idle-identity
   *  contract (dev/paths.ts idle check, via IDLE_ZERO_CHANNELS): at 0 the
   *  deform graph is an exact identity (ops/host's hard idle gate). A missing
   *  entry false-alarms (historically 43mm on a mid-scrub bend). */
  idleZero?: boolean;
}

/**
 * The scene channel REGISTRY — the ONE list every per-channel site derives
 * from. `default` is also each channel's rest value (0 everywhere: a recipe
 * channel at 0 is a bit-exact identity by construction, ops/host's hard idle
 * gate). SceneState typing, the state initializer, and tick()'s ease loop all
 * read the derived CHANNEL_DEFAULTS; the two boolean flags derive
 * ANIM_RESET_CHANNELS (page) and IDLE_ZERO_CHANNELS (instrument idle check).
 * Adding a channel is one row here plus, where the flags apply, nothing else —
 * the old four-list trap (defaults + rig + resetAnimChannels + idle-zero, each
 * hand-kept) is gone except for the mechanism, which stays bespoke mechanical
 * code (zoom/focus/iris curves are not a per-channel copy). See README.md's
 * "change X → touch Y" map.
 *
 * Every motion channel below the mechanism trio is an OP RECIPE channel
 * (ops/recipes.ts) driven straight through ops/host's `recipeChannel` — one
 * row here, one recipe there, nothing in between.
 */
const CHANNEL_REGISTRY = {
  /** 0 (18mm, retracted) .. 1 (50mm, extended) */
  zoom: { default: 0 },
  /** 0 (infinity) .. 1 (min focus, ~0.12m) */
  focus: { default: 0 },
  /** 0 (f/2.8, wide open) .. 1 (f/22, closed down) */
  aperture: { default: 0 },
  /** explode ladder recipe: 0 (assembled) .. 1 (parts spread along the axis).
   *  Both a slider AND animReset — see ChannelSpec.animReset. */
  explode: { default: 0, animReset: true, idleZero: true },
  /** reassembly recipe spread: 0 (seated, bit-exact default) .. 1 (fully
   *  disassembled — sheets unwrapped and flown off the ladder). */
  assemble: { default: 0, animReset: true, idleZero: true },
  /** helix formation recipe: 0 (seated, bit-exact default) .. 1 (fully
   *  spread). Independent of the explode/assemble channels — composes at 0. */
  helix: { default: 0, animReset: true, idleZero: true },
  /** rolling-contact unroll recipe: 0 (seated, bit-exact default) .. 1 (the
   *  shell rolled out flat). Independent formation preset; composes at 0. */
  rollout: { default: 0, animReset: true, idleZero: true },
  /** bendProfile lab recipe (EXPERIMENT): 0 (seated, bit-exact default) .. 1
   *  (full fold/accordion — its knobs shape the curvature profile). */
  bend: { default: 0, animReset: true, idleZero: true },
  /** the SCRATCH bench recipe (ops/recipes.ts — the owner edits its pipeline in
   *  TypeScript): 0 (seated, bit-exact default) .. 1 (fully played). */
  scratch: { default: 0, animReset: true, idleZero: true },
  /** 0..1 scroll-story progress; drives the scripted camera (hero) */
  story: { default: 0 },
} satisfies Record<string, ChannelSpec>;
type Channel = keyof typeof CHANNEL_REGISTRY;
const CHANNELS = Object.keys(CHANNEL_REGISTRY) as Channel[];
// `satisfies` above keeps each entry's LITERAL type (so the keys stay a precise
// union for `Channel`), which means the optional flags aren't visible on
// entries that omit them — read specs back through this widening view.
const specOf = (c: Channel): ChannelSpec => CHANNEL_REGISTRY[c];

/** Rest/default value per channel — the numeric view of the registry, kept for
 *  SceneState init, tick()'s ease targets, and the analysis-walk neutral base
 *  handed to dev/paths.ts. */
export const CHANNEL_DEFAULTS = Object.fromEntries(
  CHANNELS.map((c) => [c, CHANNEL_REGISTRY[c].default]),
) as Record<Channel, number>;

/** Channels an animation may drive that /lens rests to their registry default
 *  on animation switch/None (see ChannelSpec.animReset). Derived, so a new
 *  animReset channel needs no edit in lens.astro. */
export const ANIM_RESET_CHANNELS = CHANNELS.filter((c) => specOf(c).animReset);

/** Every deform channel the instrument's idle-identity check zeroes
 *  before probing the seated geometry (see ChannelSpec.idleZero). Derived, so a
 *  new deform channel can't silently fall out of the idle contract. */
export const IDLE_ZERO_CHANNELS = CHANNELS.filter((c) => specOf(c).idleZero);

export type { Channel };

/**
 * Scene state, driven by the sliders in lens.astro. Each *Target is set
 * instantly on input; tick() eases the live value toward it every frame so
 * dragging a slider feels smooth instead of snapping. Channel semantics are
 * documented on CHANNEL_REGISTRY above.
 */
export type SceneState = { [K in Channel]: number } & {
  [K in Channel as `${K}Target`]: number;
};

export type AccessoryGroup = "hood" | "filter" | "caps";

/** A spherical camera pose for the /lens demo compositions (SceneHandle.setCameraPose):
 *  the camera sits `distance` from (0, targetY ?? 0, 0) at `azimuth`/`elevation`
 *  (radians — azimuth measured from +z toward +x) and looks at that target,
 *  bypassing OrbitControls. `fov` defaults to the camera's boot fov. */
export interface CameraPose {
  azimuth: number;
  elevation: number;
  distance: number;
  fov?: number;
  targetY?: number;
}

/** Screen-space position of a tracked model node, in CSS px over the canvas. */
export interface TrackedPoint {
  x: number;
  y: number;
}

/** An ADDITIVE per-part transform offset (SceneHandle.setPartOffset): position
 *  in the part's local frame (model mm — the gltf geometry units), rotation in
 *  radians (euler, added per component), scale a uniform multiplier. */
export interface PartOffset {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}

export interface SceneHandle {
  state: SceneState;
  /** Show/hide a removable accessory group (all hidden by default). */
  setAccessory: (group: AccessoryGroup, visible: boolean) => void;
  /** Swap the render style (materials) for the whole model. */
  setShading: (mode: ShadingMode) => void;
  /** The current shading mode — the PENDING one while a choreographed swap is
   *  in flight (the mode the scene is heading to). Demos snapshot this on
   *  enter() so exit() can restore the bench's look. */
  getShading: () => ShadingMode;
  /** Swap the render style through a short choreographed transition (core/
   *  transitions.ts): the model whips, blinks, molts or the fov punches, and
   *  the instant material rebuild fires at the choreography's hidden peak —
   *  the change reads as one sharp gesture. Everything driven is restored
   *  bit-exactly afterward. A swap already in flight is RETARGETED to the new
   *  mode (no stacked motion); `prefers-reduced-motion` (and a transition that
   *  declines, e.g. "punch" in story mode) collapses to instant setShading. */
  swapShading: (mode: ShadingMode, opts?: SwapShadingOptions) => void;
  /** Follow the site theme (light = no `.dark` on <html>): re-palettes the current
   *  shading mode and re-tints the cinematic extras (dust, rays). The initial
   *  theme is self-detected at creation; the page calls this on toggle. */
  setTheme: (light: boolean) => void;
  /** Stop/restart the render loop entirely — e.g. when the hero canvas scrolls
   *  out of view. Story mode renders every frame (ambient dust/rays), so an
   *  off-screen hero would otherwise burn full GPU frames forever. */
  setPaused: (paused: boolean) => void;
  /** Force one repaint. /lens only redraws while a channel eases or dirty is
   *  set, so a bare uniform tweak (animation param slider) needs this to show. */
  invalidate: () => void;
  /** Register a callback run after every rendered frame with a projector that
   *  maps a model NODE NAME to its current screen position (CSS px, or null if
   *  the node doesn't exist / is behind the camera). This is how DOM annotations
   *  point at and TRACK parts of the 3D model through every scene — the centre
   *  follows the node's live object transform (zoom slides, ring turns, the
   *  screw pivot…). The op deform runs purely IN-SHADER and leaves object
   *  transforms alone, so an exploded piece's anchor is its SEATED position —
   *  anchor labels to parts the mechanism moves for exact tracking. */
  onFrame: (
    cb: (project: (name: string) => TrackedPoint | null) => void,
  ) => void;
  /** DEV: motion-path overlay for the canned animations, behind the /lens
   *  "Motion paths" toggle. Dynamically imported, so nothing of it reaches the
   *  homepage bundle — the hero never calls this. Returns null if the
   *  visualizer can't start. */
  enablePathViz: (
    onStatus: (text: string, ok: boolean) => void,
  ) => Promise<PathViz | null>;
  /** DEV: piece-name inspector behind the /lens "Inspect" toggle — hover a mesh
   *  to read its GLB node name (object names are the API), click to copy it.
   *  Dynamically imported on the first tick like the path viz, so the homepage
   *  never fetches it. Resolves false if it couldn't start. */
  enableInspect: (on: boolean) => Promise<boolean>;
  /** DEV (/lens "Hero camera" toggle): drive the camera from the hero's
   *  scripted story path — `state.story` through the SAME sampleStory /
   *  applyStoryFraming code path the hero runs — instead of OrbitControls, so
   *  the canned animations can be previewed under the story choreography (the
   *  caps-on finale cinematic runs too). OFF restores the saved orbit pose.
   *  No-op in story mode, where the hero already owns the camera. */
  setStoryCamera: (on: boolean) => void;
  /** DEV (/lens Demos): pin the camera to an explicit spherical pose about
   *  (0, targetY ?? 0, 0), bypassing OrbitControls — the demo eases the numbers
   *  itself and re-sets the pose each frame (snap, no internal easing). null
   *  releases, restoring the saved orbit pose. Precedence: story mode > hero
   *  camera > this > OrbitControls. No-op in story mode. */
  setCameraPose: (pose: CameraPose | null) => void;
  /** DEV (/lens Demos): drop the scene background to null so a page-owned wipe
   *  shows through the (alpha) canvas; false restores the theme background. The
   *  drop survives a setTheme flip while on. */
  setTransparentBackground: (on: boolean) => void;
  /** DEV (/lens Demos): snap the model GROUP to an absolute orientation
   *  (radians; omitted axes keep their boot values), keeping the recentred
   *  visual centre pinned at the origin. null restores the exact boot
   *  orientation. Composes with the twist transition — twist rolls the INNER
   *  gltf root about the optical axis, so both can run at once. Snap per call;
   *  demos ease their own numbers per frame. */
  setModelOrientation: (
    euler: { x?: number; y?: number; z?: number } | null,
  ) => void;
  /** DEV (/lens Demos): visibility gate — "glass" shows only the optical
   *  elements, "optics" adds the iris blades (+ filter glass); "silhouette" is
   *  the geometry-LOD level — it KEEPS the big drawn-lens shapes (barrel/cam
   *  shell wedges, the major rings, the iris housing shell, the glass) and
   *  hides the greeble detail (screws, contacts, decals, iris mechanism, PCB,
   *  baffles, shims, focus motor/screw, optics cells — parts.isSilhouetteGreeble,
   *  matched up each mesh's ancestor chain). Everything not kept is hidden.
   *  Per-mesh visibility is snapshotted at engage and restored exactly on null
   *  (accessories keep their hidden-by-default state; meshes that stream in
   *  mid-isolate are folded in). The gate COMPOSES with the story's own
   *  isolate/occluder passes (applyVisibility): whatever else is engaged, a
   *  piece this group excludes stays hidden. */
  setIsolate: (group: "glass" | "optics" | "silhouette" | null) => void;
  /** DEV (/lens Demos): ADDITIVE transform offset on one named part — any
   *  entry of partNames(): the mechanism's group empties (Ring_Zoom, Optics_G2…,
   *  Barrel_Inner, Iris_Housing…) or individual meshes (Element_01, screws,
   *  wedge sub-meshes). The offset composes ON TOP of whatever the mechanism
   *  wrote this frame: each rendered frame the part's post-mechanism transform
   *  is snapshotted as the base, base⊕offset is written for the render, and the
   *  base is restored afterwards — so repeated calls never accumulate, mechanism
   *  motion (zoom slide, ring turns) stays underneath, and parts the mechanism
   *  doesn't touch offset from their rest transform. Shell pieces deform
   *  in-shader (ops/host) but their mesh transforms are real, so an offset still
   *  moves them as rigid bodies — the shader deformation composes on top. null
   *  clears the one part; demos MUST clearPartOffsets() in exit(). */
  setPartOffset: (name: string, offset: PartOffset | null) => void;
  /** The addressable part registry for setPartOffset: every NAMED node of the
   *  model — the mechanism's driven group empties AND every mesh (including
   *  `_SegN` wedges and the Focus_LeadScrew_Pivot it creates). Sorted, deduped. */
  partNames: () => string[];
  /** Drop every part offset at once (the demo-exit reset). */
  clearPartOffsets: () => void;
  /** DEV (/lens Demos): attach/detach a world-space presentation object at the
   *  scene root. The caller owns disposal. */
  addOverlay: (obj: THREE.Object3D) => void;
  removeOverlay: (obj: THREE.Object3D) => void;
  /** DEV (/lens Demos): an extra render pass run after the main render, only on
   *  frames that actually render — e.g. the prism ribbon's screen-space ortho
   *  overlay. The callback gets the renderer and the live main camera (for
   *  world→NDC anchor projection) and must restore any renderer state it
   *  touches. null removes the pass. */
  setOverlayPass: (
    pass:
      | ((
          renderer: THREE.WebGPURenderer,
          camera: THREE.PerspectiveCamera,
        ) => void)
      | null,
  ) => void;
  destroy: () => void;
}

// The GLB is exported from lens_work/lens.blend in real-world millimeters
// (confirmed: Element_01's baked geometry spans y≈65..73, i.e. its real
// zc≈72.5mm position — the export is NOT meter-converted). glTF export
// converts Blender's Z-up to Y-up, so a Blender local `position.z` /
// `rotation.z` on these identity-rotated nodes becomes local `position.y` /
// `rotation.y` here, and +z(front) ↦ +y. Scale converts real millimeters
// down to a scene-friendly size.
const MODEL_SCALE = 0.05;

export interface SceneOptions {
  /** Multiplier on the default camera distance (>1 pulls back to frame the whole
   *  teardown — used by the scroll hero; the /lens page keeps 1). */
  cameraDistance?: number;
  /** Scroll-story mode: scripts the camera from the scroll story (story/story.ts)
   *  via `state.story` (0..1) and bypasses OrbitControls. Omit for the free-orbit
   *  /lens viewer. */
  story?: boolean;
  /** Which OP RECIPES (ops/recipes.ts) the deform folds in — baked at material
   *  build. Omit = all recipes (the /lens bench, which can scrub any of them).
   *  The hero passes the two its scroll story actually plays
   *  (`["assemble", "explode"]`, LensStory.astro): a recipe left out is not
   *  folded at all, so the homepage's graphs carry only the motion it uses. */
  recipes?: RecipeName[];
}

/**
 * Load-time model prep. The ORDER here is a real dependency chain — each step's
 * comment says why it must run before the next; do not reorder.
 */
function prepareModelMaterials(gltfScene: THREE.Object3D, recipes?: string[]) {
  // MEASURE every piece's frame (`_op*` attributes) + the derived ladder/layer
  // tables: nothing about a piece is authored upstream any more.
  // Must run BEFORE any material build — the deform graph reads the attributes.
  const frames = deriveFrames(gltfScene);
  // Choose which recipes the deform folds in (per scene) BEFORE applyOps bakes
  // them into the material graphs. Undefined = all recipes.
  setActiveRecipes(recipes ?? null);
  // TAG the meshes that ride an off-axis mechanism spin pivot (the focus lead
  // screw) BEFORE any material is built: the counter-rotation their op delta
  // needs is a baked node, not a runtime branch, so a tag arriving later would
  // do nothing. `createMechanism`, which owns the pivot itself, has to wait for
  // the recentre and runs far below — hence the split.
  tagMechanismSpins(gltfScene);
  // Swap every frame-carrying mesh to the op node material BEFORE the shading
  // swapper captures materials, so "realistic" keeps the deform.
  const disposeOps = applyOps(gltfScene);
  // Render-style swapper (captures the freshly-applied materials).
  const shading = createShading(gltfScene);
  return { disposeOps, shading, frames };
}

/**
 * Boot the lens viewer onto `canvas`. ONE SCENE PER DOCUMENT: the deform
 * channels, the recipe knobs, the active-recipe selection (ops/host.ts) and the
 * shading uniforms are all MODULE state, so a second live scene would scrub the
 * same numbers as the first and the two would fight. Destroy one before booting
 * another.
 */
export async function initScene(
  canvas: HTMLCanvasElement,
  opts: SceneOptions = {},
): Promise<SceneHandle> {
  // performance.mark checkpoints (see the "lens:*" marks) — near-free, and they
  // make "why is the model slow to appear" measurable in devtools / by tooling.
  performance.mark("lens:init-start");
  // Scroll-story hero vs the free-orbit /lens bench — needed up here to size the
  // renderer's pixel ratio (below), so declared before both.
  const storyMode = opts.story ?? false;
  // Kick the model fetch + Draco decode off FIRST — it needs no renderer, and
  // serializing it behind the (~100ms+) WebGPU adapter/device request was pure
  // added latency before the lens could appear. The BODY GLB alone gates the
  // first frame now; accessories stream in behind it (model.ts accessoriesReady).
  const modelPromise = loadLensModel();
  // WebGPU (auto-falls back to WebGL2) — required for the TSL deform node graph.
  // high-performance: prefer the discrete GPU on dual-GPU machines — this is a
  // full-viewport 3D hero, not a widget worth throttling to the integrated chip.
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
  });
  // Story mode is the always-rendering, full-viewport hero (highest-traffic
  // surface): cap its pixel ratio at 1.5 — on a 2× display that is ~44% fewer
  // fragments per frame for the ambient dust/rays it repaints forever, with no
  // visible sharpness loss at hero scale. The /lens dev bench (which only paints
  // on interaction) keeps the full min(dpr, 2).
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, storyMode ? 1.5 : 2),
  );
  renderer.setClearColor(0x000000, 0);
  await renderer.init();
  performance.mark("lens:renderer-ready");

  const scene = new THREE.Scene();
  // far=400: the ortho holds pull the camera back to ~150 units (ORTHO_FOV 3° with
  // matching pullback, story/camera.ts) — a 100 far plane would clip the lens away.
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
  const camDist = opts.cameraDistance ?? 1;
  camera.position.set(3.5 * camDist, 1.6 * camDist, 5 * camDist);
  const bootFov = camera.fov; // default fov for CameraPose (setCameraPose)

  const environment = setLensEnvironment(renderer, scene);

  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(3, 5, 6);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 1.3);
  rim.position.set(-4, -1, -3);
  scene.add(key, rim, new THREE.HemisphereLight(0xf1f5f9, 0x8090a0, 0.9));

  // --- real lens model (Blender exterior + optics, GLB) --------------------
  const modelGroup = new THREE.Group();
  modelGroup.rotation.z = -Math.PI / 2;
  modelGroup.scale.setScalar(MODEL_SCALE);
  scene.add(modelGroup);

  const { scene: gltfScene, accessoriesReady: accessoriesLoad } =
    await modelPromise;
  // A never-rejecting handle to the background accessories load: on a failed
  // fetch the lens still works (accessories just never appear), and every
  // consumer below can `.then` without its own catch. Resolves after the
  // accessories are merged + stylized into gltfScene (or immediately on failure).
  const accessoriesReady = accessoriesLoad.catch((err) => {
    console.warn("lens: accessories failed to load (hood/caps/filter)", err);
  });
  performance.mark("lens:model-loaded");
  modelGroup.add(gltfScene);
  // Roll the lens upright about its own optical axis (gltf-local +Y). The model
  // loads with the gear train off to one side; this rotates it to the intended
  // "up". Rolling about the optical axis is rig-safe: every mechanism (zoom/focus
  // ring turns, iris, every recipe's theta) is defined along/about this axis,
  // so a roll about it just re-phases the start angle without breaking anything.
  gltfScene.rotation.y = Math.PI / 2;

  const { disposeOps, shading, frames } = prepareModelMaterials(
    gltfScene,
    opts.recipes,
  );
  // Every applyOps pass's disposer (the body's, plus one per accessory root).
  const opsDisposers: (() => void)[] = [disposeOps];
  performance.mark("lens:materials-ready");
  if (import.meta.env.DEV) {
    reportOpsFrames(gltfScene, frames);
    // Model-contract tripwire: a lens_work re-export that drifts from the
    // code's structural assumptions (part names, glass count) — or a derivation
    // that leaves a mesh unframed — fails loudly HERE, not weeks later as a
    // silent no-op or a NaN. Runs AFTER deriveFrames on purpose: half the
    // contract is about the frames it stamps.
    void import("../dev/model-contract").then(({ reportModelContract }) =>
      reportModelContract({ scene: gltfScene, accessoriesReady }, frames),
    );
    (window as unknown as Record<string, unknown>).__lensOps = {
      frames,
      channels: recipeChannels(),
      knobs: recipeKnobs(),
    };
  }

  const node = (name: string) => gltfScene.getObjectByName(name);

  // Removable accessories: hidden by default so /lens shows the bare rigged
  // lens; the front group (cap/filter/hood) is parented to Barrel_Inner so it
  // rides the zoom extension when shown, the rear cap sits on the mount. They
  // load in the BACKGROUND (model.ts accessoriesReady), so these groups start
  // EMPTY and are populated once that settles (below, after cinematics exists).
  const accessories: Record<AccessoryGroup, THREE.Object3D[]> = {
    hood: [],
    filter: [],
    caps: [],
  };
  // The page's live accessory choice (default all off), tracked so: the
  // background load applies the latest desired visibility on arrival, a
  // setAccessory toggle-off before load completes still wins (no stranded
  // mesh), and the hero-camera preview (whose caps-on finale commandeers the
  // caps) can restore it on exit.
  const accessoryOn: Record<AccessoryGroup, boolean> = {
    hood: false,
    filter: false,
    caps: false,
  };

  // Recenter so the model's own visual center sits at the world origin —
  // OrbitControls orbits around (0,0,0) by default, and the model's real
  // coordinates (mount face at z=0, filter face at z=76.5) aren't symmetric.
  // Measured over the bare lens only (Box3 ignores .visible, and accessories
  // like the hood/rear cap would otherwise skew the center).
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
  // World-space radius of the assembled lens (bounding sphere). The depth-fade
  // near/far planes are placed relative to this each frame so the body sits in the
  // full-opacity middle and only exploded pieces cross a plane and dissolve.
  const modelRadius = bbox.getBoundingSphere(new THREE.Sphere()).radius;

  // Boot pose of the model GROUP, snapshotted for setModelOrientation: the
  // recentring offset above is only correct under the boot rotation, so a
  // reorient must re-derive it (p = R_new · R0⁻¹ · p_boot) to keep the model's
  // visual centre pinned at the origin — and null restores these exact values.
  const bootRotation = modelGroup.rotation.clone();
  const bootPosition = modelGroup.position.clone();
  const bootQuatInv = modelGroup.quaternion.clone().invert();

  // Mechanism (zoom/focus/aperture) + cinematic extras — both resolve nodes
  // AFTER the recentre, since the lead-screw pivot math reads world positions.
  const mechanism = createMechanism(gltfScene);
  const cinematics = createCinematics(
    scene,
    gltfScene,
    storyMode,
    accessoriesReady,
  );

  // Was the scene torn down before the background accessories load resolved? The
  // deferred integration below (and a late-arriving merge) must then no-op /
  // clean up instead of touching a disposed controller. See destroy().
  let destroyed = false;

  let dirty = true;

  // Demo overlay pass (setOverlayPass) — run in tick() after the main render.
  let overlayPass:
    | ((
        renderer: THREE.WebGPURenderer,
        camera: THREE.PerspectiveCamera,
      ) => void)
    | null = null;

  // Demo isolate gate (setIsolate). The snapshot is keyed per mesh so null
  // restores EXACTLY what each mesh showed at engage (a hidden accessory stays
  // hidden); meshes it hasn't seen yet (the background accessories merging
  // mid-isolate) are snapshotted on first touch.
  let isolateOn: "glass" | "optics" | "silhouette" | null = null;
  const isolateSnapshot = new Map<THREE.Mesh, boolean>();
  // Which meshes STAY shown for the active group (at their snapshot value);
  // everything else is hidden. glass/optics test the mesh's own name; the
  // geometry-LOD "silhouette" hides greeble detail anywhere up the ancestor
  // chain (a greeble's `_SegN` wedges classify through the part they belong
  // to, not on their own name).
  function isolateKeeps(o: THREE.Mesh): boolean {
    if (isolateOn === "glass") return isGlassElement(o.name);
    if (isolateOn === "optics") return isOpticsIsolate(o.name);
    for (let a: THREE.Object3D | null = o; a; a = a.parent)
      if (isSilhouetteGreeble(a.name)) return false;
    return true;
  }
  /** Accessory-ness by ANCESTRY: the accessories merge into the body's graph and
   *  their sub-meshes carry generic names, so only the walk up to the `Acc_*`
   *  root tells them apart. */
  function underAccessory(o: THREE.Object3D): boolean {
    for (let a: THREE.Object3D | null = o; a; a = a.parent)
      if (isAccessory(a.name)) return true;
    return false;
  }

  /** Does the DEMO isolate gate allow this mesh? */
  function isolateAllows(o: THREE.Mesh): boolean {
    if (!isolateOn) return true;
    if (!isolateSnapshot.has(o)) isolateSnapshot.set(o, o.visible);
    return isolateKeeps(o) ? (isolateSnapshot.get(o) ?? true) : false;
  }

  // The story's visibility INTENT, as cinematics.update last reported it.
  let storyVis: StoryVisibility = { isolate: false, occluders: false };
  // The iris beat's occluders that are MESHES; the empties in that list gate
  // their whole branch instead and are written at the end of applyVisibility.
  const occluderMeshes = new Set<THREE.Object3D>(
    cinematics.irisOccluders.filter((o) => o instanceof THREE.Mesh),
  );

  /**
   * THE ONE OWNER of the model's `.visible` flags. Three gates can hide a
   * piece — the demo isolate (setIsolate), the story's light-path glass isolate
   * and its iris-occluder reveal (story/cinematics REPORTS both as intent and
   * writes no flag itself) — and they overlap on the rear meshes. Composed in
   * ONE pass: a piece is visible iff EVERY active gate allows it, so no gate's
   * restore can stomp another that is still engaged.
   *
   * ACCESSORIES have their own owners — `setAccessory` drives their group ROOT,
   * the caps-on finale drives the two caps — so the story isolate skips their
   * whole branch and the sweep writes them only while a demo isolate is engaged
   * (which `setIsolate(null)` undoes from the snapshot).
   */
  function applyVisibility() {
    gltfScene.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      // materials/shading parents its inverted-hull pass UNDER the mesh it
      // outlines — not a piece of the lens, and it rides its host's flag.
      if (o.parent instanceof THREE.Mesh) return;
      const allowed = isolateAllows(o);
      if (underAccessory(o)) {
        if (isolateOn) o.visible = allowed;
        return;
      }
      o.visible =
        allowed &&
        !(storyVis.isolate && !isGlassElement(o.name)) &&
        !(storyVis.occluders && occluderMeshes.has(o));
    });
    // The occluder list also carries GROUP empties (Optics_G4/G5), whose glass
    // children must survive the isolate — so an empty un-hides fully.
    for (const o of cinematics.irisOccluders)
      if (!occluderMeshes.has(o)) o.visible = !storyVis.occluders;
  }

  // Fold the accessories into the live scene once they finish loading: resolve
  // the group node lists, apply the user's current visibility choice, and
  // register the new meshes with the shading swapper so a mode switch (and the
  // hero's ink caps-on finale) styles them too. Cinematics resolves its own cap
  // refs off the same promise.
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
    // The accessories arrive AFTER the body's frame pass, so each accessory root
    // gets its OWN scoped deriveFrames + applyOps. Deliberate limitation: an
    // accessory is measured against itself alone — it joins neither the body's
    // rank pool nor its ladder (it has no group under its own root, so its rung
    // is 0). Folding them into the body pass instead would drag the hood/caps
    // into Barrel_Inner's group centroid and shift the body ladder; selections
    // (class `accessory`) are how a recipe addresses them.
    for (const group of Object.keys(accessories) as AccessoryGroup[])
      for (const obj of accessories[group]) {
        deriveFrames(obj);
        opsDisposers.push(applyOps(obj));
      }
    shading.integrate(gltfScene); // capture + style the new accessory meshes
    applyVisibility(); // fold the just-arrived meshes into every active gate
    dirty = true;
  });
  // Horizontal lens-parking is only sensible on landscape screens; on portrait /
  // phone viewports it would shove the lens off-frame, so fade it out below ~1.5:1.
  let parkScale = 1;
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    parkScale = Math.max(0, Math.min(1, (w / h - 0.8) / 0.7));
    // Size the lens by the SMALLER viewport dimension (so a wide-but-short or a
    // narrow-but-tall window both frame it sensibly), capped at the layout width
    // so it stops growing on very large displays. A perspective camera otherwise
    // scales an object's pixel size purely by viewport height, so we correct with
    // camera.zoom = (capped min dimension) / height.
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
  // Every part's geometry is baked in place (origins sit at the parent — doc §4),
  // so a node's VISUAL centre is its bbox centre, resolved once into the node's
  // LOCAL frame (pose-independent) and then followed through the live transform.
  const frameCbs: ((project: (name: string) => TrackedPoint | null) => void)[] =
    [];
  const trackCache = new Map<
    string,
    { obj: THREE.Object3D; local: THREE.Vector3 } | null
  >();
  const trackVec = new THREE.Vector3();
  function project(name: string): TrackedPoint | null {
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
    return {
      x: ((trackVec.x + 1) / 2) * (canvas.clientWidth || 1),
      y: ((1 - trackVec.y) / 2) * (canvas.clientHeight || 1),
    };
  }

  // Story mode scripts the camera (and the hero canvas is pointer-events:none),
  // so OrbitControls there would only be dead pointer/wheel listeners — it's
  // created for the interactive viewer alone.
  const controls = storyMode ? null : new OrbitControls(camera, canvas);
  if (controls) {
    controls.enableDamping = true;
    controls.minDistance = 2;
    controls.maxDistance = 20;
    controls.target.set(0, 0, 0);
    // Middle-drag orbits like left-drag (owner request) — the wheel already
    // owns dolly, so MIDDLE's default DOLLY was redundant.
    controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    controls.addEventListener("change", () => {
      dirty = true;
    });
    controls.update();
  }

  // DEV hero-camera preview (/lens): while true, tick() takes the story-mode
  // camera branch and OrbitControls is bypassed — see SceneHandle.setStoryCamera.
  // orbitPose is the free-orbit camera state saved on engage, restored on exit.
  let storyCam = false;
  const orbitPose = {
    pos: new THREE.Vector3(),
    up: new THREE.Vector3(),
    fov: camera.fov,
  };

  // DEV demo camera (/lens Demos): while set, tick() pins the camera to this
  // spherical pose and OrbitControls is bypassed (see setCameraPose).
  // camPoseOrbit saves the free-orbit pose on engage, restored on release.
  let cameraPose: CameraPose | null = null;
  const camPoseOrbit = {
    pos: new THREE.Vector3(),
    up: new THREE.Vector3(),
    fov: camera.fov,
  };
  const camPoseTarget = new THREE.Vector3();
  function applyCameraPose(pose: CameraPose) {
    const ty = pose.targetY ?? 0;
    const { azimuth: az, elevation: el, distance: d } = pose;
    camera.position.set(
      d * Math.cos(el) * Math.sin(az),
      ty + d * Math.sin(el),
      d * Math.cos(el) * Math.cos(az),
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(camPoseTarget.set(0, ty, 0));
    camera.fov = pose.fov ?? bootFov;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }

  // DEV demo backdrop (/lens Demos): the scene never sets an opaque background
  // (the renderer clears with alpha 0), so transparency here means holding
  // scene.background at null and re-applying that after a setTheme flip. savedBg
  // captures whatever was showing so OFF restores it exactly.
  let transparentBg = false;
  let savedBg: THREE.Scene["background"] = scene.background ?? null;

  // --- per-part additive offsets (SceneHandle.setPartOffset) -----------------
  // Applied around each RENDERED frame: after mechanism.update has written this
  // frame's transforms, every offset part's CURRENT transform is snapshotted as
  // the base and base⊕offset is written; after the frame's callbacks the base is
  // restored. Between frames every part therefore holds its un-offset transform
  // — mechanism-driven parts get a fresh base each frame, untouched parts keep
  // their rest transform, and repeated setPartOffset calls can never accumulate.
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

  const EASE = 0.12;
  const STATE_EPS = 1e-4;

  // --- shading swaps (instant + choreographed) -------------------------------
  // applyShading is the ONE instant-swap path — the plain setShading method and
  // the transition runner below both land here, so the hero's ink entrance
  // kick-off stays in a single place.
  let currentShading: ShadingMode = "realistic";
  function applyShading(mode: ShadingMode) {
    currentShading = mode;
    shading.set(mode);
    // kick off the sketch-in entrance the first time we enter ink mode (hero)
    if (storyMode && mode === "ink")
      cinematics.startEntrance(shading.getInkLines());
    dirty = true;
  }

  // Choreographed look swap (see core/transitions.ts for the registry and the
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
      // past the swap beat, the cut already landed — recut to the new mode now
      // (still inside the residual motion) rather than spinning again
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
   * arbitrary channel values while it walks an animation — one drive path, so a
   * walked pose is built exactly the way a rendered frame is. Returns the
   * derived values tick() also needs.
   */
  function driveChannels(): { apertureT: number; explodeT: number } {
    // Real cams are non-linear; apply one shared ease across every zoom
    // channel (never per-channel, or the guts visibly desynchronize).
    const zoomT = smoothstep(0, 1, clamp01(state.zoom));
    const focusT = clamp01(state.focus);
    const apertureT = clamp01(state.aperture);
    const explodeT = clamp01(state.explode);

    // The MEASURED motions only (ops/mechanism.ts): ring throws, the element
    // slides they drive, the lead screw's spin, the iris sweep. Everything
    // else — the explode ladder, the reassembly formations, the peel — is a
    // recipe and runs in-shader off the channels below.
    mechanism.update({
      zoom: zoomT, // the shared-smoothstep value, NOT the raw eased channel
      focus: focusT,
      aperture: apertureT,
    });

    // The op recipe channels: these ARE the deform. Each registry motion
    // channel is its recipe's channel uniform, one-for-one — no shim, and no
    // object-space ladder underneath to double-drive explode. DERIVED from the
    // recipe list, so a new recipe + its registry row is the whole edit; the
    // mechanism trio above stays hand-written because its three reads share one
    // ease, which a loop would hide.
    for (const name of RECIPE_NAMES)
      recipeChannel(name).value = clamp01(state[name]);

    return { apertureT, explodeT };
  }

  function tick() {
    // skipped (not just disabled) under the hero-camera preview or a demo pose:
    // update() would re-aim the camera from the controls' own state every frame
    if (controls && !storyCam && !cameraPose) controls.update();

    // ease every channel toward its target; `easing` = any channel still moving
    // (past STATE_EPS), which keeps redraws running until everything settles
    let easing = false;
    for (const c of CHANNELS) {
      const before = state[c];
      state[c] = lerp(before, state[`${c}Target`], EASE);
      if (Math.abs(state[c] - before) > STATE_EPS) easing = true;
    }

    // In story mode we render every frame so the ambient dust + refraction rays
    // keep animating even when the scroll is parked; elsewhere we skip idle redraws.
    // Everything below only affects the frame we're about to render, so it sits
    // behind this gate — a fully idle /lens tick does near-zero work (only the
    // controls-damping update + the cheap ease loop above run). controls.update()
    // above still marks dirty while a glide damps, so those frames DO render here
    // and pick up the fresh camera transform before renderer.render.
    if (!storyMode && !dirty && !easing) return;
    dirty = false;

    if (storyMode || storyCam) {
      // sample the scripted pose, then hand the framing (pose copy, view-offset
      // park, portrait lift) to story/camera — it lives next to sampleStory
      const storyP = clamp01(state.story);
      const sample = sampleStory(storyP, storyPos, storyUp, storyTarget);
      applyStoryFraming(
        camera,
        sample,
        storyPos,
        storyUp,
        storyTarget,
        canvas.clientWidth || 1,
        canvas.clientHeight || 1,
        parkScale,
        storyP,
      );
    } else if (cameraPose) {
      applyCameraPose(cameraPose);
    }

    // Depth-fade planes track the live camera distance so the lens body stays in the
    // full-opacity middle; pieces exploding toward the camera cross the near plane
    // (and pieces receding cross the far plane) and dissolve. Widths are in model
    // radii, so it scales with whatever distance the current scene is shot from.
    // Runs on every RENDERED frame (before the render below) with the pose just
    // applied above, so a scrub/orbit/animation-select repaints with correct fade.
    {
      // distance to the SUBJECT: the story's orbit target (≡ storyPos length by
      // construction), or the origin the free-orbit /lens camera circles.
      const camDist =
        storyMode || storyCam ? storyPos.length() : camera.position.length();
      uFadeNear1.value = camDist - modelRadius * 1.05;
      uFadeNear0.value = camDist - modelRadius * 2.3;
      uFadeFar0.value = camDist + modelRadius * 1.05;
      uFadeFar1.value = camDist + modelRadius * 2.6;
    }

    const { apertureT, explodeT } = driveChannels();
    // Per-part offsets compose ON TOP of what the mechanism just wrote (and are
    // reverted after the frame's callbacks — see the block above tick()).
    applyPartOffsets();
    storyVis = cinematics.update(
      apertureT,
      explodeT,
      clamp01(state.story),
      performance.now(),
    );
    // ONE owner writes every `.visible` flag, composing the story's intent with
    // the demo isolate and the accessory choice (see applyVisibility).
    applyVisibility();

    renderer.render(scene, camera);
    // screen-space overlay pass (demos) — composites over the finished frame
    overlayPass?.(renderer, camera);
    // after the render, so tracked annotations see this frame's final transforms
    for (const cb of frameCbs) cb(project);
    revertPartOffsets();
    if (!firstFrameDone) {
      firstFrameDone = true;
      performance.mark("lens:first-frame"); // model visible (pipelines compiled)
    }
  }
  let firstFrameDone = false;
  renderer.setAnimationLoop(tick);
  let paused = false;
  let pathViz: PathViz | null = null;
  let inspector: Inspector | null = null;

  // Dev-only perf probe: renderer.info (draw calls/triangles) + live scene
  // internals for measurement scripts. Never present in prod builds.
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
    };
  }

  return {
    state,
    setPaused(p) {
      if (p === paused) return; // guard: IO callbacks can repeat the same state
      paused = p;
      if (p) {
        renderer.setAnimationLoop(null);
      } else {
        dirty = true; // scroll may have moved targets while paused — force a redraw
        renderer.setAnimationLoop(tick);
      }
    },
    setAccessory(group, visible) {
      accessoryOn[group] = visible;
      // Accessories stream in behind the body, so a toggle may land before its
      // meshes exist: apply once loaded, re-reading the LATEST desired state
      // (accessoryOn) so a rapid on→off during load resolves off and never
      // strands a visible mesh. Resolves instantly once the load is done.
      accessoriesReady.then(() => {
        for (const obj of accessories[group]) obj.visible = accessoryOn[group];
        // a toggle mid-isolate updates the RESTORE state; the gate stays in
        // force (applyIsolate re-hides whatever the isolate excludes)
        if (isolateOn)
          for (const obj of accessories[group])
            obj.traverse((o) => {
              if (o instanceof THREE.Mesh)
                isolateSnapshot.set(o, accessoryOn[group]);
            });
        applyVisibility();
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
        cinematics.setStoryPreview(true);
      } else {
        // SNAP the story channel home — easing it down would sweep storyP back
        // through the light-path isolate window and flash the structure out.
        state.story = 0;
        state.storyTarget = 0;
        cinematics.setStoryPreview(false); // reseats the caps…
        for (const obj of accessories.caps) obj.visible = accessoryOn.caps; // …we restore their visibility
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
    setCameraPose(pose) {
      if (storyMode) return; // the hero owns the camera in story mode
      if (pose) {
        if (!cameraPose) {
          // engage: save the orbit pose and bypass controls (mirrors storyCam)
          camPoseOrbit.pos.copy(camera.position);
          camPoseOrbit.up.copy(camera.up);
          camPoseOrbit.fov = camera.fov;
          if (controls) controls.enabled = false;
        }
        cameraPose = pose;
      } else if (cameraPose) {
        cameraPose = null;
        camera.position.copy(camPoseOrbit.pos);
        camera.up.copy(camPoseOrbit.up);
        camera.fov = camPoseOrbit.fov;
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
        if (controls) {
          controls.enabled = true;
          controls.update(); // re-aims at the controls target from the restored pose
        }
      }
      dirty = true;
    },
    setTransparentBackground(on) {
      if (on === transparentBg) return;
      transparentBg = on;
      if (on) {
        savedBg = scene.background ?? null;
        scene.background = null;
      } else {
        scene.background = savedBg;
      }
      dirty = true;
    },
    setModelOrientation(euler) {
      if (euler) {
        modelGroup.rotation.set(
          euler.x ?? bootRotation.x,
          euler.y ?? bootRotation.y,
          euler.z ?? bootRotation.z,
        );
        // re-derive the recentring offset under the new rotation so the
        // model's visual centre stays pinned at the origin (see bootRotation)
        modelGroup.position
          .copy(bootPosition)
          .applyQuaternion(bootQuatInv)
          .applyQuaternion(modelGroup.quaternion);
      } else {
        modelGroup.rotation.copy(bootRotation);
        modelGroup.position.copy(bootPosition);
      }
      dirty = true;
    },
    setIsolate(group) {
      if (group === isolateOn) return;
      isolateOn = group;
      if (!group) {
        // restore what each mesh showed at engage, then recompose: the story's
        // own gates may have moved on while the demo held the flags
        for (const [m, v] of isolateSnapshot) m.visible = v;
        isolateSnapshot.clear();
      }
      applyVisibility();
      dirty = true;
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
    clearPartOffsets() {
      if (partOffsets.size === 0) return;
      partOffsets.clear();
      dirty = true;
    },
    addOverlay(obj) {
      scene.add(obj);
      dirty = true;
    },
    removeOverlay(obj) {
      obj.removeFromParent();
      dirty = true;
    },
    setOverlayPass(pass) {
      overlayPass = pass;
      dirty = true;
    },
    invalidate() {
      dirty = true;
    },
    onFrame(cb) {
      frameCbs.push(cb);
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
            // the ONE channel registry, handed over so analysis walks can start
            // from the neutral pose without re-listing channels anywhere
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
    setShading(mode) {
      applyShading(mode);
    },
    getShading: () => activeSwap?.pending ?? currentShading,
    swapShading,
    setTheme(l) {
      shading.setTheme(l);
      cinematics.setTheme(l);
      // a theme flip must not reintroduce a background while a demo backdrop is
      // showing through the canvas (setTransparentBackground)
      if (transparentBg) scene.background = null;
      dirty = true;
    },
    destroy() {
      destroyed = true;
      overlayPass = null;
      if (activeSwap) {
        cancelAnimationFrame(activeSwap.raf);
        activeSwap.run.finish(); // restore whatever the transition was driving
        activeSwap = null;
      }
      renderer.setAnimationLoop(null);
      pathViz?.dispose();
      inspector?.dispose();
      ro.disconnect();
      controls?.dispose();
      cinematics.dispose();
      renderer.dispose();
      environment.dispose();
      shading.dispose();
      for (const d of opsDisposers) d();
      disposeLensModel(gltfScene);
      // The accessories may still be in flight — dispose again once (if) they
      // merge, so their deferred geometries/materials are freed too. disposeLensModel
      // dedupes per call, so re-running over the (already-disposed) body is safe.
      accessoriesReady.then(() => disposeLensModel(gltfScene));
    },
  };
}
