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
import { createCinematics } from "../story/cinematics";
import { displaceSeatedPoint } from "../ops/cpu";
import {
  isAccessory,
  isDecal,
  isGlassElement,
  isOpticalGlass,
  isOpticsIsolate,
  isPeelExtra,
  isPeelTube,
  isShellPart,
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
  /** the STORY's scoped unroll recipe (rollout's chain, admitted only to the
   *  shell cast): 0 (seated, bit-exact default) .. 1 (the shells rolled out
   *  flat). Driven by the peel scene, not by any /lens slider. */
  peel: { default: 0, animReset: true, idleZero: true },
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
 *  the camera sits `distance` from (targetX ?? 0, targetY ?? 0, 0) at
 *  `azimuth`/`elevation` (radians — azimuth measured from +z toward +x) and
 *  looks at that target, bypassing OrbitControls. `fov` defaults to the
 *  camera's boot fov.
 *
 *  The TARGET is what travels. Holding az/el and sliding `targetX` flies the
 *  camera in a straight line along world X with a FIXED heading (the
 *  fly-through's dive) — the rig cannot otherwise translate, since position is
 *  purely spherical about the target. */
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

/** Where a model node is actually DRAWN (SceneHandle.projectDrawn): the centre
 *  and radius of the disc it covers, in FRAME HEIGHTS from the frame's centre —
 *  +x right, +y DOWN, so it reads like the screen. Frame heights and not pixels
 *  because the only consumers are drawing INTO the canvas, where a fixed camera
 *  puts a fixed point at an offset proportional to the canvas height whatever
 *  the canvas size or DPR; multiply by the canvas height for CSS px. */
export interface TrackedCircle {
  x: number;
  y: number;
  r: number;
}

/** An ADDITIVE per-part transform offset (SceneHandle.setPartOffset): position
 *  in the part's local frame (model mm — the gltf geometry units), rotation in
 *  radians (euler, added per component), scale a uniform multiplier. */
export interface PartOffset {
  position?: [number, number, number];
  rotation?: [number, number, number];
  scale?: number;
}

/** One optical element's axial span in the GLTF frame, in millimetres — the
 *  front and rear surface vertices, i.e. exactly `front.yMm` / `rear.yMm` of an
 *  optics/prescription.ts entry, keyed by the element's node name.
 *
 *  The CALLER derives this table and passes it to setGlassTransmissive, which
 *  uses each span's LENGTH as that element's refraction thickness; this
 *  module deliberately does NOT import optics/prescription.js, which would drag
 *  the 13-entry table (and the optics tree it heads) into the shared homepage
 *  chunk for the sake of one /lens demo. */
export interface GlassSpanMm {
  frontYmm: number;
  rearYmm: number;
}

/** Roughness written onto the transmissive clones. three drives the refraction
 *  blur from roughness (a mip level over the viewport copy), so a touch of it
 *  softens the internals seen through the glass instead of resolving every
 *  barrel screw razor-sharp through a perfect window. */
const GLASS_TRANSMISSIVE_ROUGHNESS = 0.05;

/** THE KNOB THAT MAKES THE FEATURE VISIBLE AT ALL. The shipped glass sits at
 *  the default specularIntensity 1, and at roughness ~0 that turns each element
 *  into a MIRROR of `scene.environment` (core/model.ts's RoomEnvironment): the
 *  reflected room is so much brighter than the transmitted view that the glass
 *  reads as chrome and nothing behind it can be seen. MEASURED on the bench —
 *  with the specular at 1 the dome is invisibly indifferent to what is behind
 *  it (blanking the sky with `__lensOptics.set({skyMix:0})` does not change one
 *  pixel of it); dropped to this, the barrel rings, the iris and the far
 *  elements come through. Low, not zero, so an element still catches a highlight
 *  and reads as GLASS rather than as a hole — the iridescent multicoat (which
 *  the clone inherits) carries the coloured coating sheen on top.
 *
 *  NOTE for anyone tempted by `envMapIntensity` instead: it is inert on a node
 *  material lit by a SCENE environment in three r185 — verified live at 0 and
 *  at 12, both indistinguishable from 1. */
const GLASS_TRANSMISSIVE_SPECULAR = 0.15;

/** THE DETINT — every slot that can put a COLOUR on the transmissive clones,
 *  set to neutral. Optical glass is colourless; the shipped elements are not,
 *  and the tint comes from core/model.ts's `buildLensMaterial`, which is what
 *  these clones are cloned from ("realistic" restores exactly those materials):
 *
 *    • `color: 0xfafdfc`      — a cool near-white base, i.e. a faint cyan cast
 *    • `specularColor: 0xb9e0c6` — the "faint green specular tint" its own
 *      comment names; this is what greened the reflections
 *    • `iridescence: 0.55` (iridescenceIOR 1.3, thickness 140–400nm) — the
 *      thin-film multicoat, the strongest colour of the three: it paints the
 *      Fresnel reflection green/amber/purple across the angle of incidence
 *
 *  `attenuationColor` / `attenuationDistance` are never authored, so they sit at
 *  three's defaults (white, Infinity) — written anyway so the whole tint story
 *  is in ONE table and a future GLB material with a volume tint cannot leak in.
 *
 *  WHAT IS NOT TOUCHED: reflectivity. The Fresnel is IOR-driven (1.52) and has
 *  nothing to do with surface colour — zeroing it would make the elements read
 *  as holes rather than as glass. `GLASS_TRANSMISSIVE_SPECULAR` above stays the
 *  look knob for how strong those reflections are; this table only says they are
 *  WHITE. */
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
  /** …and the OTHER question about a part: where is it actually DRAWN, and how
   *  big. Same projection, but the op deform is folded in on the CPU
   *  (`ops/cpu.ts` — story/cinematics.ts already threads its rays through the
   *  same evaluator), so this follows a piece that the mechanism has thrown
   *  metres from its seat. Returns the node's bounding disc in FRAME HEIGHTS
   *  (see TrackedCircle), or null when the node does not exist or is behind the
   *  camera. Ink drawn ONTO a part wants this; a DOM label wants `project`,
   *  whose seated anchor is the point of it. */
  projectDrawn: (name: string) => TrackedCircle | null;
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
  /** DEV (/lens Demos): mount the fly-through starfield warp on
   *  `scene.backgroundNode` (optics/warp.ts — currently the ONLY user of that
   *  slot). Dynamically imported on first enable like the path viz and the
   *  inspector, so the homepage never fetches it. `false` unmounts and
   *  restores the transparent clear; resolves false if it couldn't start.
   *
   *  `reverse` picks the DIRECTION OF TRAVEL the warp's trace is built for —
   *  true for a rear→front dive (the fly-through), false for the light path.
   *  It only takes effect when the warp is BUILT: the TSL graph unrolls one
   *  surface table, so asking for the other order while a warp is mounted
   *  disposes and rebuilds it (a fresh sky bake and a pipeline compile), which
   *  is fine for a demo that chooses once at enter(). */
  enableLensWarp: (on: boolean, reverse?: boolean) => Promise<boolean>;
  /** DEV (/lens Demos): the fly-through's DEFAULT sky — the same authored
   *  starfield drawn as real billboarded quads (optics/starfield.ts) instead of
   *  traced per pixel out of a baked equirect. Mounting it costs two draw calls
   *  and leaves `scene.backgroundNode` NULL, so none of enableLensWarp's 21
   *  surface refractions per pixel run at all; that saving is the reason the
   *  mode exists. The stars are drawn into the OPAQUE pass on purpose so three's
   *  transmission copy picks them up and the glass refracts them — see the glass
   *  contract in optics/starfield.ts before touching those materials.
   *
   *  While mounted this also owns `scene.background`, holding the sky palette's
   *  flat backdrop behind the stars (near-black on the dark stage) and putting
   *  back whatever was there on `false`. Dynamically imported on first enable,
   *  like the warp; resolves false if it couldn't start. */
  enableStarfield: (on: boolean) => Promise<boolean>;
  /** DEV (/lens Demos): route the frame through the SCREEN-SPACE wormhole
   *  (optics/wormhole-post.ts) instead of rendering it straight to the canvas.
   *  While mounted, every rendered frame goes scene → render target → radial
   *  pinch about the exit axis → canvas, so the barrel, the internals, the
   *  glass and the sky all bend into the same funnel. `false` unmounts and
   *  restores the direct `renderer.render` the whole site ships with; resolves
   *  false if it couldn't start (the demo then runs undistorted, not broken).
   *  Dynamically imported on first enable, like the warp. */
  enableWormholePost: (on: boolean) => Promise<boolean>;
  /** PAY THE FLY-THROUGH'S COMPILE EARLY. Builds the two optics modules above
   *  and then draws ONE frame of the dive's look — realistic shading, the
   *  transmissive glass clones for `spans`, the starfield, through the wormhole
   *  pass — with the OUTPUT redirected into a 1×1 target, so nothing reaches
   *  the canvas and no channel, latch or look is left changed. The realistic
   *  look comes from the shading controller's ORIGINALS rather than from a mode
   *  switch: a switch frees the mode it leaves and rebuilds it coming back,
   *  which would cost more than the warm-up saves.
   *
   *  WHY A REAL FRAME AND NOT compileAsync: three keys a render pipeline on the
   *  render context as well as the shader (WebGPUBackend.getRenderCacheKey —
   *  colour format, depth format, sample count), and the dive draws into the
   *  wormhole pass's own target rather than onto the canvas. So every material
   *  in the model needs a SECOND pipeline the first time the pass renders it,
   *  which is what made the first crossing cost ~180ms of one frame. Drawing
   *  the real thing through the real pass is the only warm-up that compiles the
   *  pipelines the dive will actually look up; the scene pass renders full-size
   *  into its own target either way (PassNode saves and restores the render
   *  target), so redirecting the final quad is enough to keep it off screen.
   *
   *  Call it when the page has a moment — the work is a full frame plus every
   *  compile, ~200ms, and it is only worth doing off the crossing. Resolves
   *  false if it declined (already warm, or an optics module failed to load).
   *  Idempotent: the second call is a no-op. */
  warmFly: (spans: Record<string, GlassSpanMm>) => Promise<boolean>;
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
  /** STORY MODE ONLY (inverse of setCameraPose's gate): per-frame camera
   *  override for the fly-through span. Blends the story rig toward `pose`
   *  by `mix`; null (or mix 0) hands the camera back to the story sample.
   *  No restore bookkeeping — the story sample re-asserts itself the next
   *  frame the override is off. */
  setStoryFlyPose: (pose: CameraPose | null, mix?: number) => void;
  /** DEV (/lens Demos): drop the scene background to null so a page-owned wipe
   *  shows through the (alpha) canvas; false restores the theme background. The
   *  drop survives a setTheme flip while on. */
  setTransparentBackground: (on: boolean) => void;
  /** DEV (/lens Demos): show/hide the ambient cinematics dust. The fly-through
   *  clears it so the starfield reads; everything else leaves it on. */
  setDust: (visible: boolean) => void;
  /** DEV (/lens Demos): hide the OPTICAL GLASS (parts.isOpticalGlass — the
   *  `Element_*` stack) so the ray-traced background warp is what the viewer
   *  sees through the barrel. The warp IS the glass: the traced (non-bypass)
   *  ray cone coincides with the front element's silhouette, so the drawn glass
   *  occludes exactly the pixels the trace bends. Barrel/blades/rings/mount keep
   *  drawing — their occlusion is correct. A GATE, not a one-shot write: the
   *  per-frame applyVisibility pass owns every `.visible` flag, so this composes
   *  with the demo isolate and the glass fades and restores on false.
   *  SCOPE FOOTNOTE: the predicate also names `Acc_Filter_Glass`, but accessory
   *  subtrees early-return out of applyVisibility before this gate is reached,
   *  so in practice only the `Element_*` stack hides — a mounted UV filter keeps
   *  drawing. No demo mounts one, so nothing depends on it today. */
  setGlassHidden: (hidden: boolean) => void;
  /** DEV (/lens Demos): the fly-through's alternative to hiding the glass
   *  outright — leave every element DRAWN and TRANSMISSIVE so three's
   *  transmission path refracts the blades, the barrel internals and the warped
   *  starfield through it.
   *
   *  `spans` is the per-element axial table the per-element THICKNESS is derived
   *  from — see GlassSpanMm for why the caller owns it. Keyed by node name; ids
   *  the model doesn't have are skipped. Only read on the enabling call (a
   *  re-enable with a different table is a no-op). `false` restores the
   *  materials captured at enable and resets the fade.
   *
   *  THE CAMERA FLIES THROUGH THIS GLASS, and getting it out of the way is the
   *  two fades' job, not this one's — setGlassFade for the whole stack at once,
   *  setGlassElementFade for the passage. */
  setGlassTransmissive: (
    on: boolean,
    spans?: Record<string, GlassSpanMm>,
  ) => void;
  /** DEV (/lens Demos): the WORLD-X extent of each named node, from the meshes
   *  it actually carries — `{ x0, x1 }` with x0 ≤ x1, and ids the model does not
   *  have (or that carry no mesh) simply absent from the result.
   *
   *  THE FLY-THROUGH'S RULER. The dive needs to know where each element sits on
   *  the axis it is flying down, and the prescription's millimetres are in the
   *  GLTF frame: turning them into world X means knowing MODEL_SCALE *and* the
   *  recentring offset, both of which are this module's private business. So the
   *  measurement is taken here, where the matrices are, rather than reproduced
   *  from a constant on the far side of the barrel.
   *
   *  REST POSE, and a snapshot: the bounds come off the CPU-side geometry, so
   *  ops/host's vertex-shader deform is not in them, and nothing re-measures
   *  when a channel moves. Call it once with every channel at rest (which is
   *  what a demo's enter() is) and keep the numbers. */
  worldAxialSpans: (
    ids: string[],
  ) => Record<string, { x0: number; x1: number }>;
  /** DEV (/lens Demos): fade the transmissive clones out together — 1 = the
   *  glass as setGlassTransmissive left it, 0 = gone. Drives `opacity` on every
   *  clone (they are cloned from the shipped physical glass and are marked
   *  `transparent` at enable, so alpha reaches the framebuffer), and at exactly
   *  0 also drops the meshes out of the one-owner applyVisibility pass so no
   *  highlight or transmission ghost survives.
   *
   *  A no-op unless setGlassTransmissive is on, and reset to 1 when it goes off.
   *  Cheap to call every frame: an unchanged value returns immediately. */
  setGlassFade: (opacity: number) => void;
  /** DEV (/lens Demos): THE PASSAGE FADE — one opacity PER ELEMENT, keyed by
   *  node name, MULTIPLIED by setGlassFade's stack-wide one. Ids the table omits
   *  hold whatever they were last given (1 until told otherwise), so a caller
   *  may drive the whole stack every frame or a single element once.
   *
   *  WHY IT EXISTS. three's transmission is a SCREEN-SPACE effect: the fragment
   *  reads a copy of the framebuffer, offset by the refraction ray. From INSIDE
   *  an element that offset is enormous and the separable dual blur behind it
   *  smears the frame into an axis-aligned cross — the shot breaks down exactly
   *  when the camera is in the glass. So the fly-through takes each element down
   *  as it arrives: fully gone a short distance BEFORE the near plane reaches
   *  its rearmost surface, over a ramp short enough that the element is already
   *  filling the whole frame while it dissolves.
   *
   *  NOT the old per-element dissolve this file used to carry, which hid an
   *  element outright for the frames the camera was inside it — thirteen
   *  single-frame visibility jumps, and the reason it was pulled. This is an
   *  OPACITY ramp, and it fires at passage rather than while the element is
   *  still a distant object ahead.
   *
   *  A no-op unless setGlassTransmissive is on, and cleared when it goes off.
   *  Cheap to call every frame: values equal to what is already there return
   *  without a write, and the visibility pass only re-runs when an element
   *  crosses 0. */
  setGlassElementFade: (fades: Record<string, number>) => void;
  /** DEV (/lens Demos): scale the GLINTS on the transmissive clones —
   *  setRoomLight's opposite number for the glass. 1 = the reflections
   *  setGlassTransmissive shipped (GLASS_TRANSMISSIVE_SPECULAR), 0 = no reflected
   *  light on the elements at all, so nothing but what shines THROUGH them is
   *  left. Multiplies `specularIntensity`, which is the only live knob for this:
   *  it scales the dielectric Fresnel at BOTH ends (three r185
   *  MeshPhysicalNodeMaterial.setupSpecular — specularColor is F0 × it and
   *  specularF90 IS it at metalness 0), so the IBL reflection and the studio
   *  lights' highlights go out together. `envMapIntensity` cannot do it: three
   *  reads it only when the MATERIAL carries an envMap, and these are lit by the
   *  SCENE environment (MaterialProperties.js:23).
   *
   *  WHY, SEPARATELY FROM setRoomLight: the room ramp leaves a floor so the
   *  barrel interior keeps a rim, and at that floor the studio lights were still
   *  painting white smudges across glass that is supposed to be inside a dark
   *  tube under starlight. The dive drives this to 0 on the same window.
   *
   *  Survives a theme flip: the level is re-applied wherever a clone is made
   *  (enableGlassTransmissive), exactly as GLASS_DETINT is. Reset to 1 when
   *  setGlassTransmissive goes off. Cheap to call every frame: an unchanged
   *  level returns immediately. */
  setGlassGlint: (level: number) => void;
  /** DEV (/lens Demos): fade the WHOLE BODY — everything applyVisibility governs
   *  that is NOT optical glass: the mount, the barrel, the rings, the blades,
   *  the greeble. 1 = the lens as shipped, 0 = gone. setGlassFade's opposite
   *  number, and the two together dissolve the entire model.
   *
   *  NO CLONES. The glass fade has to clone because thickness is per-element;
   *  a body fade is ONE opacity for every mesh, and core/model.ts's signature
   *  cache already collapses ~180 body meshes onto ~10 shared material
   *  instances (plus ops/host's per-source deform variants). So this writes
   *  `transparent`/`opacity` straight onto those shared instances and remembers
   *  what each wore, which is a dozen property writes instead of 180 clones and
   *  180 pipeline compiles.
   *
   *  WHY NOT a shader-side fade uniform: only the TECHNICAL palettes
   *  (ink/blueprint/flat) build an `opacityNode` at all. The fly-through runs
   *  "realistic" (demos.ts FLY.shading — the technical looks fold in a depth
   *  fade an interior camera would dissolve), whose materials are the shipped
   *  MeshStandardMaterials with no opacity graph. A uniform would mean giving
   *  every mesh on the whole site a transparent material and an opacity graph to
   *  serve one demo.
   *
   *  ONE HITCH, AT THE START: `transparent` flips on the first sub-1 call, which
   *  re-sorts and re-compiles those ~10 pipelines (the same cost the glass swap
   *  pays at enable, and for the same reason it is taken once). It is restored —
   *  with the original opacity — the moment the fade returns to exactly 1.
   *
   *  At exactly 0 the meshes also leave applyVisibility, so nothing survives as
   *  a depth write or a transmission ghost. Cheap to call every frame: an
   *  unchanged value returns immediately. */
  setBodyFade: (opacity: number) => void;
  /** STORY: take the SHELL off the lens — the peel's cast (core/parts
   *  `isShellPart`: the barrel sections, the name band, the two control grips
   *  and the printed markings), then its third cast (`isPeelTube`: the two
   *  closed inner tubes the skin was wrapped around) and finally its second
   *  (`isPeelExtra`: the three internal baffle rings, which leave LAST so the
   *  bore is open behind everything). 1 = the lens as shipped (the default),
   *  0 = the shell gone, the tubes gone, the bore open and the light path and
   *  the mechanism bare from the side. The hero drives it as one scroll
   *  envelope: out over the peel, absent while the cards orbit and the internals
   *  work and the sky runs, back at the rewrap so the reassembly flies the shell
   *  home as before. Input is CLAMPED to [0,1] — the envelope is a sum of two
   *  overlapping ramps and may transiently exceed 1.
   *
   *  VISIBILITY, NOT OPACITY — the one place this parts company with
   *  setBodyFade, which writes `opacity` on shared materials. Neither half of
   *  that works here: model.ts's signature cache collapses the body onto ~10
   *  material instances, so `Barrel_Base` wears the same near-black instance as
   *  the baffles and the chassis (fading it would fade the internals with it),
   *  and the story runs "ink", whose fills carry an `opacityNode` — which
   *  REPLACES `material.opacity` in a NodeMaterial, so the write would not even
   *  reach the frame. Per-mesh clones would buy a real cross-fade at ~100
   *  pipeline compiles, and story/fly.ts re-materials every mesh twice inside
   *  this very span (setShading on enter and on exit), which would stomp them.
   *
   *  So each shell mesh hides HARD, at its own point in the fade — the
   *  cinematics sketch-in's feather, run in reverse: the level is a threshold
   *  and the pieces wink out scattered across it instead of as one block. Being
   *  a `.visible` gate it composes in applyVisibility with every other gate and
   *  survives shading swaps and theme flips untouched. */
  setShellFade: (opacity: number) => void;
  /** DEV (/lens Demos): scale the ROOM — the PMREM'd scene environment and the
   *  three studio lights together. 1 = the lighting the site ships with, 0 =
   *  nothing but what the scene emits for itself. The fly-through ramps it down
   *  as the camera enters the barrel: a lens barrel is a dark tube, and from the
   *  mount inward the starfield is supposed to be the only light in the frame.
   *
   *  The traced sky is NOT room light and does not dim with this — it reaches
   *  the frame through `scene.backgroundNode`, which three multiplies by
   *  `backgroundIntensity`, not by `environmentIntensity`.
   *
   *  NOT a recorded kit verb, so a demo restores it in exit() (as it does
   *  setBodyFade). Cheap to call every frame: an unchanged level returns. */
  setRoomLight: (level: number) => void;
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
   *  mid-isolate are folded in). The gate COMPOSES with the other visibility
   *  gates (applyVisibility): whatever else is engaged, a piece this group
   *  excludes stays hidden. */
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
  /** Attach an object as a CHILD OF THE MOUNTED STARFIELD (enableStarfield),
   *  which is how the sky chapter's ink — the constellation lines, the star
   *  labels, the quote — rides that group's per-frame camera-centring for free
   *  instead of re-deriving it. Returns false when the starfield has not been
   *  built yet or is not mounted; the caller is expected to ask again on a later
   *  frame (the mount is asynchronous, and it goes away again when the fly span
   *  exits, taking any attached child with it). Idempotent: re-attaching an
   *  object that is already there does nothing. The caller owns disposal, and
   *  must only attach for spans where the starfield is mounted. */
  starfieldAttach: (obj: THREE.Object3D) => boolean;
  /** Take an object back off the starfield (see starfieldAttach). */
  starfieldDetach: (obj: THREE.Object3D) => void;
  /** THE REVEAL'S COLOR-MATCHED CUT: blend the mounted starfield's backdrop `f`
   *  of the way toward `rgb` (0-255 ints — a story scene's stage tint). The sky
   *  is dimmed to the color of the stage it is about to be replaced by, so the
   *  background swap at the unmount (enableStarfield(false), which hands the
   *  frame back to the page's own CSS tint) cuts between near-identical frames
   *  instead of flashing. `f = 0` restores the palette backdrop exactly — the
   *  caller must restore BEFORE unmounting, since this is a silent no-op while
   *  the starfield is unbuilt or unmounted. */
  setSkyDim: (f: number, rgb: [number, number, number]) => void;
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
   *  The hero passes the three its scroll story actually plays
   *  (`["assemble", "explode", "peel"]`, LensStory.astro): a recipe left out is
   *  not folded at all, so the homepage's graphs carry only the motion it uses. */
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
    // MOBILE-FALLBACK REPRO SWITCH (`?webgl`, the `?story` dev-param mould):
    // phones without WebGPU silently take three's WebGL2 backend
    // (WebGPURenderer.js:57 getFallback), which compiles the TSL graphs to GLSL
    // instead of WGSL. This param forces that same backend on the desktop so
    // the fallback is reproducible. Read `renderer.backend.isWebGLBackend` to
    // see which one is live (WebGLBackend.js:57 / WebGPUBackend.js:88).
    forceWebGL: new URLSearchParams(location.search).has("webgl"),
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

  // DEV (`?diag`, same param mould as `?webgl` above): a fixed status card the
  // owner can read off a PHONE — backend, warp status, trace channels, three
  // revision. Only `warp` is live, written by enableLensWarp below; the overlay
  // module is imported lazily so it drags optics/warp.ts into its own chunk
  // rather than the eager bundle. After `renderer.init()`, which is when the
  // backend choice (WebGPU vs the WebGL2 fallback) is final.
  const diag: import("../dev/diag").LensDiag | null =
    import.meta.env.DEV && new URLSearchParams(location.search).has("diag")
      ? { warp: "unmounted", post: "unmounted" }
      : null;
  if (diag)
    void import("../dev/diag").then((m) => m.mountLensDiag(renderer, diag));

  // DEV (`?mtrace`, same param mould): the motion trace — one row per rendered
  // frame so the story's movement can be reviewed as CURVES instead of stills.
  // Written from tick() below; see dev/motion-trace.ts.
  let motionTrace: import("../dev/motion-trace").MotionTrace | null = null;
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("mtrace"))
    void import("../dev/motion-trace").then((m) => {
      motionTrace = m.mountMotionTrace();
    });

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
  const hemi = new THREE.HemisphereLight(0xf1f5f9, 0x8090a0, 0.9);
  scene.add(key, rim, hemi);

  // ── Room light (setRoomLight) ──────────────────────────────────────────────
  //
  // THE ROOM IS FOUR NUMBERS: the PMREM'd IBL above and the three lights just
  // added. A dive INTO the barrel has to put all four out together — a lens
  // barrel is a dark tube, and dimming only the IBL leaves the key light still
  // painting an interior wall that has no window. Boot values are captured here
  // so the ramp is a pure scale off the shipped look and the restore is exact.
  //
  // NOT scene.backgroundIntensity, which is what multiplies the traced sky
  // (three r185 Background.js:91) — the stars are meant to be the only thing
  // left, so nothing here may touch them.
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
    // Prescription probe (dev/prescription-probe.ts): `window.__lensPrescriptionProbe()`
    // measures the 13 optical elements and prints a paste-ready table for
    // optics/prescription.ts. Dynamically imported like the contract tripwire,
    // so nothing of it reaches a production bundle.
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

  // The fly-through's glass gate (setGlassHidden): the traced background warp
  // replaces the elements' optics, so the meshes that would occlude it stand
  // down for the dive.
  let glassHidden = false;

  // ── Transmissive glass (setGlassTransmissive) ──────────────────────────────
  //
  // WHY A MATERIAL SWAP AND NOT A FLAG. core/model.ts already ships the glass
  // with `transmission: 1, ior: 1.52`, but its `thickness` is 0 — and with zero
  // thickness three offsets the refraction sample by nothing
  // (getVolumeTransmissionRay, three/src/nodes/functions/PhysicalLightingModel.js:42
  // — the ray is scaled by `thickness * modelScale`), so the elements read as
  // flat tinted windows rather than as lenses. Thickness is per-element, and
  // all thirteen elements SHARE ONE material instance (model.ts's signature
  // cache builds one glass material for the whole stack), so it cannot be
  // written onto the shipped material without giving every element the front
  // element's span. Each element therefore gets its own CLONE.
  //
  // CLONE, never a fresh MeshPhysicalNodeMaterial: the elements are FRAMED
  // meshes wearing ops/host's deform graph, and a fresh material would drop it
  // — Element_12 would stop riding focus and every element would render at rest
  // pose. NodeMaterial.copy carries every node slot across (three r185
  // src/materials/nodes/NodeMaterial.js:1315-1360), so the clone still deforms.
  //
  // OWNERSHIP HAZARD. materials/shading.ts's setShading re-materials EVERY mesh
  // from its own `original` map, captured at load — which never sees these
  // clones. So a shading switch while this is on silently stomps them (harmless:
  // that mode's look simply wins), and a naive restore would stomp the new mode
  // right back. Hence the restore only touches meshes still wearing the clone it
  // made. The demo's own ordering is safe by construction and must stay that
  // way: d-flythrough's enter() calls setShading BEFORE enabling this, and
  // lens.astro's selectDemo runs the demo's exit() — which disables this —
  // BEFORE kit.restore() puts the bench look back.
  //
  // THE ONE PATH THAT IS NOT ORDERED: a SITE THEME FLIP mid-demo. shading's
  // setTheme re-runs the active mode over every mesh (materials/shading.ts
  // setTheme → set(currentMode)), which stomps the clones out from under a
  // running fly-through — the melt then writes opacity onto materials nothing is
  // wearing and the glass draws opaque for the rest of the dive. There is no
  // ordering that fixes it, because the flip is the USER's, not a demo's. So
  // setTheme RE-SEATS instead: the theme work is allowed to land, and the swap
  // is re-made on top of it from the spans this remembers, carrying `glassFade`
  // across (see reseatGlassTransmissive).
  let glassTransmissive = false;
  /** the spans setGlassTransmissive was last enabled with — kept so a theme
   *  flip can re-make the swap without the caller being involved. */
  let glassSpans: Record<string, GlassSpanMm> = {};
  /** what each swapped mesh wore before, and the clones we own. */
  const glassSavedMaterial = new Map<THREE.Mesh, THREE.Material>();
  const glassClones = new Set<THREE.Material>();
  /** THE CLONES OUTLIVE THE SWAP. A fresh material is a fresh PIPELINE, and
   *  three compiles a pipeline on the frame that first DRAWS it — which is the
   *  first frame of the dive, so re-cloning on every crossing cost a ~55ms
   *  stall every time (measured, dev build). So each mesh's clone is kept here
   *  and handed back on the next crossing: nothing new compiles. An entry is
   *  dropped only when the mesh's own material changed under it — a theme flip
   *  re-materials every mesh, and a clone of the old palette must not come
   *  back — and the whole cache is freed at destroy(). */
  const glassCloneCache = new Map<
    THREE.Mesh,
    { src: THREE.Material; clone: THREE.MeshPhysicalNodeMaterial }
  >();
  /** the same clones and their meshes, GROUPED BY ELEMENT — what the passage
   *  fade writes through. Rebuilt with the clones (so a theme re-seat re-groups
   *  the fresh ones), and the fade LEVELS below survive it. */
  const glassElementClones = new Map<string, THREE.Material[]>();
  const glassElementMeshes = new Map<string, THREE.Mesh[]>();
  /** setGlassFade: the stack-wide opacity. */
  let glassFade = 1;
  /** setGlassElementFade: the per-element multiplier, absent = 1. */
  const glassElementFade = new Map<string, number>();
  /** setGlassGlint: the multiplier on GLASS_TRANSMISSIVE_SPECULAR. Held here
   *  rather than on the clones because the clones are thrown away and re-made on
   *  every theme flip — enableGlassTransmissive reads this back. */
  let glassGlint = 1;
  /** every mesh whose EFFECTIVE opacity (the product of the two) has reached 0 —
   *  the set applyVisibility reads. An element at alpha 0 still costs a
   *  transmission-pass draw and still writes depth, and "fully gone" is a
   *  promise the fly-through's timing depends on. */
  const glassGone = new Set<THREE.Mesh>();

  /** Push `glassFade × glassElementFade[id]` onto every clone, and keep
   *  `glassGone` in step. Returns true if the gone-set MOVED, i.e. if the caller
   *  owes an applyVisibility pass — the expensive half, so it is not run from in
   *  here (this is called every frame of the dive). */
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

  /** The clone `m` wears while the swap is on — the cached one when the mesh is
   *  still wearing the material it was cloned from, a fresh one otherwise. The
   *  two values that are NOT the source material's (the element's thickness and
   *  the live glint level) are re-applied on every hand-back: both are plain
   *  scalars, so neither costs a recompile. */
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
    // …times the GLINT LEVEL, for the same reason the detint below is
    // applied here: this is the one place a clone is made, so a theme flip's
    // re-seat mid-dive comes back at the darkness the dive had reached
    // instead of handing the studio lights back to the glass.
    clone.specularIntensity = GLASS_TRANSMISSIVE_SPECULAR * glassGlint;
    clone.thickness = thickness;
    // COLOURLESS (see GLASS_DETINT). Applied HERE, in the one function that
    // makes a clone, so the theme flip's re-seat (reseatGlassTransmissive)
    // detints too — a flip mid-dive must not hand the tint back.
    // Whole Color objects rather than `.setHex`: `attenuationColor` and
    // `specularColor` exist only on a physical material, and a non-physical
    // source (a shading mode that re-materialled the glass before the flip)
    // would make a mutation throw where an assignment is inert.
    clone.color = new THREE.Color(GLASS_DETINT.color);
    clone.specularColor = new THREE.Color(GLASS_DETINT.specularColor);
    clone.attenuationColor = new THREE.Color(GLASS_DETINT.attenuationColor);
    clone.attenuationDistance = GLASS_DETINT.attenuationDistance;
    clone.iridescence = GLASS_DETINT.iridescence;
    // Marked transparent HERE, once, rather than when the fade first moves:
    // `transparent` picks the render list a mesh lands in, and flipping it
    // mid-demo would re-sort (and recompile) the whole glass stack in the
    // middle of the dive. At opacity 1 it costs nothing — a transmissive
    // material is already drawn in the transmission pass.
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
        // shading's inverted-hull pass parents under the mesh it outlines — not
        // glass, and it rides its host (same rule as applyVisibility).
        if (o instanceof THREE.Mesh && !(o.parent instanceof THREE.Mesh))
          meshes.push(o);
      });
      if (!meshes.length) continue;
      // Thickness is in the mesh's LOCAL space and three multiplies it by the
      // model scale itself, so the prescription's millimetres go in raw: the
      // gltf frame IS millimetres (MODEL_SCALE is what makes it world units).
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
    // The opacities LAST, in one pass, so a re-seat resumes at exactly the fade
    // levels the demo had reached (both of them) rather than at 1.
    writeGlassOpacity();
  }

  /** Hand every mesh STILL WEARING one of our clones back its saved material.
   *  Touches neither fade LEVEL — the re-seat below carries both across, and
   *  only the real disable resets them — and it DISPOSES NOTHING: the clones
   *  belong to `glassCloneCache`, which is what makes the next crossing free
   *  (see the cache's note). A theme flip's re-seat frees the stale ones as it
   *  re-clones; destroy() frees whatever is left. */
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
   * Re-make the transmissive swap over whatever the meshes are wearing NOW —
   * the theme flip's answer to the ownership hazard above.
   *
   * Order matters. `releaseGlassClones` restores only meshes still holding a
   * clone, so after shading has already stomped them it restores nothing and the
   * NEW theme's materials stay put; the re-clone then sources from those, which
   * is the whole point (a clone of the old theme's material would carry the old
   * palette straight back). `enableGlassTransmissive` ends by re-applying BOTH
   * fade levels (the stack-wide one and the per-element passage) to the fresh
   * clones, so a flip at any point of the dive resumes at the same opacities;
   * the visibility pass then re-composes the gone-set the release emptied.
   */
  function reseatGlassTransmissive() {
    releaseGlassClones();
    enableGlassTransmissive(glassSpans);
    applyVisibility();
  }

  // ── Body fade (setBodyFade) ────────────────────────────────────────────────
  //
  // The glass fade's opposite number, and a much cheaper mechanism — see the
  // handle method for why this writes shared material PROPERTIES where the
  // glass had to clone. What each touched material wore before, so the restore
  // is exact and a mesh that never faded is never written at all.
  let bodyFade = 1;
  let bodyFadedOut = false;
  const bodySaved = new Map<
    THREE.Material,
    { transparent: boolean; opacity: number }
  >();

  /** Every DISTINCT material currently worn by a non-glass piece of the model.
   *  Walks the same shapes applyVisibility does, plus the child passes that ride
   *  a host mesh (shading's inverted hulls and its LineSegments) — those are
   *  separate materials, and a body that fades while its outline stays put would
   *  read as a wireframe ghost rather than as a body going away. */
  function bodyMaterials(): Set<THREE.Material> {
    const out = new Set<THREE.Material>();
    gltfScene.traverse((o) => {
      const host = o instanceof THREE.Mesh ? o : o.parent;
      if (!(host instanceof THREE.Mesh) || isOpticalGlass(host.name)) return;
      const mat = (o as THREE.Mesh).material;
      if (!mat) return;
      for (const m of Array.isArray(mat) ? mat : [mat]) out.add(m);
    });
    return out;
  }

  function applyGlassFade(opacity: number) {
    // Guarded like setGlassHidden: the fly-through calls this from apply(p)
    // every frame, and the visibility pass below costs a full traversal on top
    // of tick()'s.
    const o = Math.min(1, Math.max(0, opacity));
    if (!glassTransmissive || o === glassFade) return;
    glassFade = o;
    if (writeGlassOpacity()) applyVisibility();
    dirty = true;
  }

  /** The passage fade. Same guard, applied per element: nothing is written and
   *  no traversal is paid unless a level actually moved. */
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
    if (writeGlassOpacity()) applyVisibility();
    dirty = true;
  }

  /** setGlassGlint: the reflection ramp, a pure scale off the shipped specular.
   *  The LEVEL is kept whether or not the swap is on (enableGlassTransmissive
   *  applies it to every clone it makes, which is what carries it through a theme
   *  re-seat); with no clones the write below is simply an empty loop. */
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
    if (o >= 1) {
      // Back to the shipped state, exactly: opacity AND the transparent flag, so
      // the body returns to the opaque render list it normally lives in.
      for (const [m, was] of bodySaved) {
        m.transparent = was.transparent;
        m.opacity = was.opacity;
        m.needsUpdate = true;
      }
      bodySaved.clear();
    } else {
      // Captured LAZILY, on the first sub-1 call, and re-captured after every
      // restore: a shading switch or a theme flip re-materials every mesh, so a
      // set captured at boot would be writing opacity onto materials nothing
      // wears (the ownership hazard the glass swap documents, in its cheaper
      // form). Late capture always sees what is actually on the meshes NOW.
      if (!bodySaved.size)
        for (const m of bodyMaterials()) {
          bodySaved.set(m, { transparent: m.transparent, opacity: m.opacity });
          m.transparent = true;
          m.needsUpdate = true;
        }
      for (const m of bodySaved.keys()) m.opacity = o;
    }
    const out = o <= 0;
    if (out !== bodyFadedOut) {
      bodyFadedOut = out;
      applyVisibility();
    }
    dirty = true;
  }

  // ── Shell gate (setShellFade) ──────────────────────────────────────────────
  //
  // A VISIBILITY gate, not a material one — the handle method states why, and
  // why that is not a downgrade here: the level is a per-mesh THRESHOLD, so the
  // shell leaves piece by piece across the story's fade rather than in one
  // frame, and nothing this owns can be stomped by a shading swap.
  let shellFade = 1;
  /** the shell meshes hidden RIGHT NOW — the set applyVisibility reads. */
  const shellGone = new Set<THREE.Mesh>();
  /** each shell mesh's own hide threshold, captured on the first call that
   *  actually moves the level. */
  const shellThreshold = new Map<THREE.Mesh, number>();
  let shellCaptured = false;
  /** the slice of the fade level, measured UP FROM 0, that the wink-outs are
   *  spread over. The remainder is the tail at the TOP of the level (0.85 → 1),
   *  where every threshold is already below the level and the shell is
   *  therefore still wholly PRESENT — slack before the first piece leaves. */
  const SHELL_FEATHER = 0.85;
  /** THE FOUR BANDS inside the feather, measured up from 0. A higher threshold
   *  means a piece leaves EARLIER (it is gone once the level has fallen to it),
   *  so the bands read top-down as the departure order — which is the lens read
   *  OUTSIDE-IN, each layer uncovering the next:
   *
   *      decals   [0.62, 0.85)   the printed markings, first
   *      wedges   [0.38, 0.62)   the shell itself
   *      tubes    [0.17, 0.38)   the two closed inner tubes under it
   *      baffles  [0,    0.17)   the internal light traps, last
   *
   *  see captureShellThresholds for why each split is there. */
  const DECAL_BAND = 0.62;
  const TUBE_BAND = 0.38;
  const EXTRA_BAND = 0.17;

  function captureShellThresholds() {
    let i = 0;
    let d = 0;
    let e = 0;
    let t = 0;
    // Golden-ratio scatter over the capture order, WITHIN a band: deterministic
    // (so a scrub back and forth is stable), near-uniform, and consecutive
    // pieces — which are a part's own neighbouring wedges — never leave
    // together. The half-step offset keeps the first mesh off the band's floor
    // exactly, where `gone = o <= t` would strand it visible until the level hit
    // that value dead on.
    const inBand = (n: number, lo: number, hi: number) =>
      lo + (((n + 0.5) * 0.618034) % 1) * (hi - lo);
    gltfScene.traverse((o) => {
      // the same shapes applyVisibility walks: top-level meshes only, since
      // shading's child line/hull passes ride their host's flag
      if (!(o instanceof THREE.Mesh) || o.parent instanceof THREE.Mesh) return;
      const extra = isPeelExtra(o.name);
      const tube = isPeelTube(o.name);
      if (!isShellPart(o.name) && !extra && !tube) return;
      // Decals band ABOVE the wedges: a marking is printed ON a wedge, but the
      // scatter is sector-blind, so a decal drawn after its host wedge would
      // float alone once the wedge winks. Markings in the top band guarantees
      // every one is gone before the first wedge leaves.
      //
      // Tubes and baffles band BELOW them, for the mirror reason: each is what
      // the layer above it uncovers, so it must still be there while that layer
      // comes off and may only leave once it has. The skin, the tubes under it
      // and the bore behind them are three beats, not one. Their own drifts
      // (story/peelcards.ts) are windowed to the matching stretches of the
      // peel's tail, so a piece is well clear of the lens before its threshold
      // catches it.
      shellThreshold.set(
        o,
        extra
          ? inBand(e++, 0, EXTRA_BAND)
          : tube
            ? inBand(t++, EXTRA_BAND, TUBE_BAND)
            : isDecal(o.name)
              ? inBand(d++, DECAL_BAND, SHELL_FEATHER)
              : inBand(i++, TUBE_BAND, DECAL_BAND),
      );
    });
  }

  function applyShellFade(opacity: number) {
    // The story envelope is a SUM of two overlapping ramps, so it can transiently
    // exceed 1 (and, scrubbed backwards, fall below 0) — clamped here rather than
    // at the caller, which would only be a second place to get it wrong.
    const o = Math.min(1, Math.max(0, opacity));
    if (o === shellFade) return;
    shellFade = o;
    // Captured lazily (nothing before the first move needs it) but ONCE: the
    // set is meshes, not materials, so — unlike applyBodyFade's — a shading
    // switch or a theme flip cannot invalidate it.
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
    // The expensive half, paid only when the hidden set actually MOVED — this
    // runs from the scroll driver on every frame of the story.
    if (moved) {
      applyVisibility();
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
   * THE ONE OWNER of the model's `.visible` flags. Five gates can hide a
   * piece — the demo isolate (setIsolate), the fly-through's glass gate
   * (setGlassHidden), the tail of its glass fades (setGlassFade /
   * setGlassElementFade, once a transmissive clone reaches opacity 0), the body
   * fade's tail (setBodyFade at 0) and the shell gate (setShellFade) — plus the
   * accessory branch below. Composed in ONE pass: a piece is visible iff EVERY
   * active gate allows it, so no gate's restore can stomp another that is still
   * engaged.
   *
   * ACCESSORIES have their own owners — `setAccessory` drives their group ROOT,
   * the caps-on finale drives the two caps — so the sweep writes them only while
   * a demo isolate is engaged (which `setIsolate(null)` undoes from the
   * snapshot).
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
        // the full hide wins over the fade-out if both are somehow on
        !(glassHidden && isOpticalGlass(o.name)) &&
        // the two glass fades' tail, scoped by the set writeGlassOpacity keeps:
        // exactly the meshes this scene swapped a clone onto whose effective
        // opacity has reached 0 (stack-wide fade × passage fade)
        !glassGone.has(o) &&
        // the body fade's tail: everything that is NOT glass, once it hits 0
        !(bodyFadedOut && !isOpticalGlass(o.name)) &&
        // the shell gate (setShellFade): the peel's cast, the inner tubes and
        // the baffles that follow it, each from its own point in the story's fade
        !shellGone.has(o);
    });
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

  // …and the DRAWN disc (projectDrawn). Same cached seated centre, plus the
  // node's world bounding radius, put through the CPU op field before it is
  // projected — which is the whole difference from `project` above.
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
      // The op field is a MESH's (its lanes come off the geometry), so a group
      // node is followed by the first mesh under it.
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
          // the LARGEST HALF-EXTENT, not the box's bounding sphere: a lens
          // element is a disc, and the sphere around its box is a factor of √2
          // wider than the circle it actually draws.
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
    // the radius, measured ACROSS the screen: one camera-right world offset of
    // the seated bounding radius, projected alongside the centre
    drawRight
      .setFromMatrixColumn(camera.matrixWorld, 0)
      .multiplyScalar(t.radius);
    drawE.copy(drawC).add(drawRight);
    drawC.project(camera);
    drawE.project(camera);
    if (drawC.z > 1) return null; // behind the camera
    // NDC → frame heights from the frame's centre: y is a straight half, and x
    // carries the aspect (see TrackedCircle).
    const aspect = (canvas.clientWidth || 1) / (canvas.clientHeight || 1);
    const x = (drawC.x * aspect) / 2;
    return {
      x,
      y: -drawC.y / 2,
      r: Math.abs((drawE.x * aspect) / 2 - x),
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
    const tx = pose.targetX ?? 0;
    const ty = pose.targetY ?? 0;
    const { azimuth: az, elevation: el, distance: d } = pose;
    camera.position.set(
      tx + d * Math.cos(el) * Math.sin(az),
      ty + d * Math.sin(el),
      d * Math.cos(el) * Math.cos(az),
    );
    camera.up.set(0, 1, 0);
    camera.lookAt(camPoseTarget.set(tx, ty, 0));
    camera.fov = pose.fov ?? bootFov;
    camera.clearViewOffset();
    camera.updateProjectionMatrix();
  }

  // STORY fly-through camera override (see setStoryFlyPose): blended over the
  // story sample in tick() rather than replacing it, so mix drives the handoff.
  let storyFlyPose: CameraPose | null = null;
  let storyFlyMix = 0;
  const flySnapPos = new THREE.Vector3();
  const flySnapQuat = new THREE.Quaternion();
  const flyQuat = new THREE.Quaternion();
  const flyDirA = new THREE.Vector3();
  const flyDirB = new THREE.Vector3();
  const flyAxis = new THREE.Vector3();
  const flyOrbit = new THREE.Quaternion();

  /** The hand-over's POSITION blend, written into `to` — an ORBIT, not a line.
   *
   *  Both ends are camera positions on a sphere about the lens, and at the
   *  hand-BACK they sit ~160° apart (the dive's sky park out at +X, the rewrap
   *  pose behind and above −X). A straight lerp between those is a CHORD, and
   *  that chord passes ~1 wu from the origin — INSIDE the model — so the camera
   *  rushed through the lens body mid-blend. Interpolating the DIRECTION along
   *  the great circle and the LENGTH separately swings the camera AROUND
   *  instead: the distance to the subject stays between the two endpoints' at
   *  every mix, so the model can never engulf the camera. (The lens still leaves
   *  frame and comes back — the dive ends with its back to it — but now it does
   *  so at the frame's edge, fifteen units off, and swings in at a steady size.)
   *
   *  The hand-OVER at the internals tail is the same code over a few degrees,
   *  where a slerp and a lerp agree to well under a trace frame. */
  function orbitBlendPosition(
    from: THREE.Vector3,
    to: THREE.Vector3,
    mix: number,
  ) {
    const lenA = from.length();
    const lenB = to.length();
    // a pose AT the subject has no direction to rotate — nothing orbital to do
    if (lenA < 1e-6 || lenB < 1e-6) {
      to.lerpVectors(from, to, mix);
      return;
    }
    flyDirA.copy(from).divideScalar(lenA);
    flyDirB.copy(to).divideScalar(lenB);
    flyAxis.crossVectors(flyDirA, flyDirB);
    // a degenerate cross means the directions are parallel (angle 0 — any axis
    // will do) or ANTIPODAL (no unique plane): swing over the top, and around
    // world Z instead if the pose is sitting on that pole itself
    if (flyAxis.lengthSq() < 1e-12) {
      flyAxis.set(0, 1, 0).cross(flyDirA);
      if (flyAxis.lengthSq() < 1e-12) flyAxis.set(0, 0, 1).cross(flyDirA);
    }
    const angle = Math.acos(Math.min(1, Math.max(-1, flyDirA.dot(flyDirB))));
    flyOrbit.setFromAxisAngle(flyAxis.normalize(), angle * mix);
    to.copy(flyDirA)
      .applyQuaternion(flyOrbit)
      .multiplyScalar(lerp(lenA, lenB, mix));
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
      // Fly-through camera override (story/fly.ts): blend the story rig toward
      // an orbital CameraPose. mix 0 = pure story sample, 1 = pure fly pose.
      // The story sample's view-offset park fades out with the blend (the fly
      // scene is centred), so the offset never pops.
      if (storyFlyPose && storyFlyMix > 0) {
        flySnapPos.copy(camera.position);
        flySnapQuat.copy(camera.quaternion);
        const storyFov = camera.fov;
        const vo = camera.view?.enabled
          ? { x: camera.view.offsetX, y: camera.view.offsetY }
          : null;
        applyCameraPose(storyFlyPose); // pos/up/lookAt/fov, clears view offset
        if (storyFlyMix < 1) {
          flyQuat.copy(camera.quaternion);
          orbitBlendPosition(flySnapPos, camera.position, storyFlyMix);
          camera.quaternion.slerpQuaternions(flySnapQuat, flyQuat, storyFlyMix);
          camera.fov = lerp(storyFov, camera.fov, storyFlyMix);
          if (vo) {
            camera.setViewOffset(
              canvas.clientWidth || 1,
              canvas.clientHeight || 1,
              vo.x * (1 - storyFlyMix),
              vo.y * (1 - storyFlyMix),
              canvas.clientWidth || 1,
              canvas.clientHeight || 1,
            );
          }
          camera.updateProjectionMatrix();
        }
      }
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
      // Under the fly override the real camera position IS the blend (story
      // targets are origin-only, so its length is exact at every mix).
      const camDist =
        storyMode || storyCam
          ? storyFlyPose && storyFlyMix > 0
            ? camera.position.length()
            : storyPos.length()
          : camera.position.length();
      uFadeNear1.value = camDist - modelRadius * 1.05;
      uFadeNear0.value = camDist - modelRadius * 2.3;
      uFadeFar0.value = camDist + modelRadius * 1.05;
      uFadeFar1.value = camDist + modelRadius * 2.6;
    }

    // Fly-through warp: the background trace reads the SAME channel values
    // the mechanism just used and the model's live world matrix, so the glass
    // it refracts through and the glass on screen can never disagree.
    lensWarp?.sync(
      clamp01(state.focus),
      clamp01(state.aperture),
      camera,
      gltfScene,
    );
    // The drawn sky rides ON the camera: parking the sphere on this frame's eye
    // position is what makes 200-unit-away geometry behave like the traced
    // background's infinitely distant sky (no parallax as the dive travels).
    starfield?.sync(camera);
    // The screen-space wormhole reads the SAME frame the warp just synced — the
    // throat is the exit axis projected through this tick's camera pose, so the
    // funnel's centre and the sky it swallows can never be a frame apart.
    if (postMounted) wormholePost?.sync(camera);

    const { explodeT } = driveChannels();
    // Per-part offsets compose ON TOP of what the mechanism just wrote (and are
    // reverted after the frame's callbacks — see the block above tick()).
    applyPartOffsets();
    cinematics.update(explodeT, clamp01(state.story), performance.now());
    // ONE owner writes every `.visible` flag, composing the demo isolate, the
    // glass gates and the accessory choice (see applyVisibility).
    applyVisibility();

    // TWO RENDER PATHS, and the second one exists only while the fly-through is
    // running: mounted, the frame goes through optics/wormhole-post.ts's
    // RenderPipeline (scene → target → pinch → canvas); unmounted, this is the
    // direct call the whole site has always made, untouched.
    // The fly warm-up's one off-screen frame, if it is owed (SceneHandle
    // .warmFly): taken HERE, ahead of this tick's own render, because the pass
    // renders its scene once per frame and a render driven from outside the
    // loop compiles nothing.
    // the pose for THIS frame is final here (story framing, the fly blend and
    // every channel have been applied) — record it before the render
    motionTrace?.record(camera, state, modelRadius);
    if (warmFlyPending) {
      const spans = warmFlyPending;
      warmFlyPending = null;
      warmFlyFrame(spans);
    }
    if (postMounted && wormholePost) wormholePost.render();
    else renderer.render(scene, camera);
    // screen-space overlay pass (demos) — composites over the finished frame.
    // Works on BOTH paths: it keeps the colour buffer (explore/overlay.ts sets
    // autoClear false) and the canvas is the current target either way. No demo
    // currently asks for both at once — the fly-through sets no overlay pass.
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
  // DEV (/lens Demos): the fly-through starfield warp (optics/warp.ts). While
  // mounted it owns `scene.backgroundNode` and is fed this frame's channel and
  // frame values from tick(). Dynamically imported, like the path viz and the
  // inspector, so nothing of it reaches the homepage bundle.
  let lensWarp: import("../optics/warp").LensWarp | null = null;
  // The page's live warp choice, tracked like accessoryOn: the lazy import is
  // awaited, so an on→off during that fetch must resolve OFF (see
  // enableLensWarp) instead of mounting an opaque sky with no demo running.
  let warpWanted = false;
  // Which direction of travel the BUILT warp traces (see enableLensWarp).
  let warpReverse = false;
  // DEV (/lens Demos): the fly-through's DRAWN starfield (optics/starfield.ts)
  // — the default sky, and the reason the traced warp above is now the fallback.
  // Same lazy-import + latest-state shape as the warp; while mounted it is
  // re-centred on the camera from tick() and owns scene.background.
  let starfield: import("../optics/starfield").Starfield | null = null;
  let starsWanted = false;
  let starsBgSaved: THREE.Scene["background"] = null;
  // DEV (/lens Demos): the fly-through's SCREEN-SPACE wormhole
  // (optics/wormhole-post.ts). Same lazy-import shape as the warp above, and
  // the same latest-state rule — `postMounted` is what tick() renders through,
  // and it is only ever set from `postWanted` AFTER the await, so an exit
  // during the import cannot strand the pipeline on the shipped path.
  let wormholePost: import("../optics/wormhole-post").WormholePost | null =
    null;
  let postWanted = false;
  let postMounted = false;
  /** warmFly runs once per page — see the handle method. */
  let warmedFly = false;
  /** the spans the dry frame owes, handed over by warmFly for tick() to take. */
  let warmFlyPending: Record<string, GlassSpanMm> | null = null;

  /** ONE FRAME OF THE DIVE, DRAWN NOWHERE (SceneHandle.warmFly). The dive's
   *  look goes on, one frame is drawn through the wormhole pass into a 1×1
   *  target, and everything comes back off — inside one tick, so no rendered
   *  frame ever sees the half-state and the canvas is repainted normally by the
   *  render below. What it buys is the pipeline cache: three keys a pipeline on
   *  the render context as well as the shader, so every material in the model
   *  needs a second one the first time the PASS draws it, and that compile is
   *  the crossing's stall. */
  function warmFlyFrame(spans: Record<string, GlassSpanMm>) {
    if (!starfield || !wormholePost) return;
    const dry = new THREE.RenderTarget(1, 1);
    const bgSaved = scene.background ?? null;
    scene.background = starfield.backdrop;
    scene.add(starfield.object);
    // withOriginals, not setShading: a mode switch re-materials every mesh both
    // ways and would stomp the transmissive clones enabled just below
    // (materials/shading.ts documents it).
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
    scene.remove(starfield.object);
    scene.background = bgSaved;
    dry.dispose();
    dirty = true;
  }

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
      // The two model dissolves, reachable from the console for look passes —
      // the handle itself is held by lens.astro and the demo kit, not by
      // window, and an opening treatment is judged by driving BOTH against a
      // parked scrub beat.
      setBodyFade: applyBodyFade,
      setGlassFade: applyGlassFade,
      // the dive's two darkness ramps, for the same parked-beat look passes —
      // the room, and the glass's own reflections
      setRoomLight: applyRoomLight,
      setGlassGlint: applyGlassGlint,
    };
  }

  // Named, because two methods call their siblings: the fly warm-up drives the
  // two optics latches through the same public path the dive does.
  const handle: SceneHandle = {
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
    setStoryFlyPose(pose, mix = 1) {
      if (!storyMode) return;
      storyFlyPose = pose;
      storyFlyMix = pose ? clamp01(mix) : 0;
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
    setDust(visible) {
      cinematics.setDust(visible);
      dirty = true;
    },
    setGlassHidden(hidden) {
      // Guarded like setTransparentBackground: the fly-through drives this from
      // apply(p) EVERY frame, and an unguarded write would run a second full
      // applyVisibility traversal per rendered frame on top of tick()'s.
      if (hidden === glassHidden) return;
      glassHidden = hidden;
      applyVisibility();
      dirty = true;
    },
    setGlassTransmissive(on, spans) {
      if (on === glassTransmissive) return;
      glassTransmissive = on;
      if (on) enableGlassTransmissive(spans ?? {});
      else disableGlassTransmissive();
      applyVisibility();
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
        // Ancestors AND descendants: the model group's own matrix carries the
        // recentre and MODEL_SCALE, and nothing guarantees this is called after
        // a render.
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
    setRoomLight(level) {
      applyRoomLight(level);
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
    starfieldAttach(obj) {
      // `.parent` is the mount test: enableStarfield adds/removes the group
      // from the scene and never disposes it in between, so a built-but-
      // unmounted starfield must read as false.
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
      // `.parent` is the mount test (see starfieldAttach): a built-but-unmounted
      // starfield's backdrop is not on screen, so dimming it would only leave
      // state behind for the next mount.
      if (!starfield || !starfield.object.parent) return;
      starfield.setBackdropDim(f, rgb[0], rgb[1], rgb[2]);
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
    async enableLensWarp(on, reverse = false) {
      warpWanted = on;
      // The mounted warp is built for ONE direction of travel (optics/warp.ts:
      // the trace's surface table is unrolled into the shader graph). Turning
      // the warp on in the other direction therefore has to REPLACE it, not
      // re-configure it — the same dispose-and-rebuild shape setTheme would
      // need if the sky bake were not swappable behind the texture node.
      if (lensWarp && on && reverse !== warpReverse) {
        scene.backgroundNode = null;
        lensWarp.dispose();
        lensWarp = null;
      }
      if (!lensWarp) {
        if (!on) return true; // never started, nothing to turn off
        try {
          const { createLensWarp } = await import("../optics/warp");
          if (destroyed) return false; // torn down mid-import
          lensWarp = createLensWarp(
            renderer,
            !document.documentElement.classList.contains("dark"),
            () => {
              dirty = true;
            },
            { reverse },
          );
          warpReverse = reverse;
        } catch (err) {
          // The message goes in the TEXT, not only in the second argument: a
          // phone's remote console (and the `?diag` card) shows the string.
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(
            `lens optics: the starfield warp failed to start — ${msg}`,
            err,
          );
          if (diag) diag.warp = `FAILED: ${msg}`;
          return false;
        }
      }
      // Mounting the node is the on/off switch: an assigned backgroundNode is
      // an opaque sphere, so `null` is what keeps the transparent clear the
      // whole site ships with. Mount per the LATEST desired state, not the
      // captured `on`: an exit during the import above would otherwise take the
      // early-return, unmount nothing, and let this continuation strand an
      // opaque sky over the stage. (Equal to `on` when nothing awaited.)
      scene.backgroundNode = warpWanted
        ? (lensWarp.node as THREE.Scene["backgroundNode"])
        : null;
      if (diag) diag.warp = warpWanted ? "mounted" : "unmounted";
      dirty = true;
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
      // The LATEST desired state, not the captured `on` — see enableLensWarp.
      // The BACKDROP travels with the mount: the stars are drawn ONTO a flat
      // ground rather than onto whatever the page was showing, and `backdrop`
      // is one live Color the starfield re-tints on a theme flip, so assigning
      // it once is enough.
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
    async enableWormholePost(on) {
      postWanted = on;
      if (!wormholePost) {
        if (!on) return true; // never started, nothing to turn off
        try {
          const { createWormholePost } =
            await import("../optics/wormhole-post");
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
      }
      // The LATEST desired state, not the captured `on` — see enableLensWarp.
      postMounted = postWanted;
      if (diag) diag.post = postMounted ? "mounted" : "unmounted";
      dirty = true;
      return true;
    },
    async warmFly(spans) {
      // Never over a live dive (nothing here would survive being torn down
      // under one) and never twice — the second call has nothing to compile.
      if (destroyed || warmedFly || glassTransmissive || postMounted)
        return false;
      warmedFly = true;
      // BUILD, then DROP. Each pair mounts and unmounts inside one microtask
      // chain, so no frame is ever rendered with the sky or the pass up, and
      // awaiting (rather than the fire-and-forget latch pair the dive uses)
      // means two calls can never both find the module missing and build it
      // twice. What survives is what costs: the modules, the geometry, and the
      // pass's own pipeline (createWormholePost compiles it in its
      // constructor).
      await handle.enableStarfield(true);
      await handle.enableStarfield(false);
      await handle.enableWormholePost(true);
      await handle.enableWormholePost(false);
      if (destroyed || !starfield || !wormholePost) return false;
      // The dry frame itself is TAKEN BY tick() (warmFlyFrame) — the wormhole
      // pass renders its scene once per FRAME (PassNode's update type), so a
      // render driven from outside the animation loop re-runs the quad over a
      // stale target and compiles nothing. Measured: 3ms and no effect.
      warmFlyPending = spans;
      dirty = true;
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
      lensWarp?.setTheme(l); // the sky re-bakes in the other ink palette
      starfield?.setTheme(l); // …and the drawn one just re-tints (no re-bake)
      // AFTER shading, never instead of it: shading.setTheme re-materials every
      // mesh and stomps the transmissive clones (the ownership hazard at
      // enableGlassTransmissive). Let the theme work land, then re-seat the swap
      // on top of it — the fade value rides along, so a flip mid-melt is
      // invisible instead of freezing the glass opaque for the rest of the dive.
      if (glassTransmissive) reseatGlassTransmissive();
      // a theme flip must not reintroduce a background while a demo backdrop is
      // showing through the canvas (setTransparentBackground)
      if (transparentBg) scene.background = null;
      dirty = true;
    },
    destroy() {
      destroyed = true;
      overlayPass = null;
      postMounted = false;
      if (activeSwap) {
        cancelAnimationFrame(activeSwap.raf);
        activeSwap.run.finish(); // restore whatever the transition was driving
        activeSwap = null;
      }
      renderer.setAnimationLoop(null);
      // put the shipped glass materials back before the model teardown walks
      // them, so the clones this owns are the only thing it frees here, and
      // hand the body materials back their opacity/transparent flags
      disableGlassTransmissive();
      // …and the cache the swap hands its clones back to, which outlives it.
      for (const e of glassCloneCache.values()) e.clone.dispose();
      glassCloneCache.clear();
      applyBodyFade(1);
      pathViz?.dispose();
      inspector?.dispose();
      lensWarp?.dispose();
      starfield?.dispose();
      wormholePost?.dispose();
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
  return handle;
}
