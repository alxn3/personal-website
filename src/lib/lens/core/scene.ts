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
  /** the STORY's scoped unroll recipe (the sticker chain, admitted only to the
   *  shell cast): 0 (seated, bit-exact default) .. 1 (the shells rolled out
   *  flat). Driven by the peel scene, not by any /lens slider. */
  peel: { default: 0, animReset: true, idleZero: true },
  /** the origami-bloom recipe (ops/recipes.ts `rose`): 0 (seated, bit-exact
   *  default) .. 1 (full bloom — petals hinged open in ranked whorl waves).
   *  The story's ENDING drives it (story/envelopes.ts ROSE_PULSE); the /lens
   *  Animations bench drives the same channel from its slider. */
  rose: { default: 0, animReset: true, idleZero: true },
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

/** THE ONE EASE EVERY CHANNEL RUNS ON — tick()'s per-frame
 *  `value += EASE·(target − value)`, applied to the whole registry at once.
 *  Exported as a READING: a channel is drawn at this value, not the one its
 *  writer authored, so laws that hold on DRAWN values import it rather than
 *  respelling it (story/__tests__/channel-ease.test.ts). */
export const CHANNEL_EASE = 0.22;

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

/** A spherical camera pose: the camera sits `distance` from
 *  (targetX ?? 0, targetY ?? 0, 0) at `azimuth`/`elevation` (radians — azimuth
 *  measured from +z toward +x) and looks at that target.
 *
 *  The TARGET is what travels. Holding az/el and sliding `targetX` flies the
 *  camera in a straight line along world X with a FIXED heading — which is the
 *  dive's whole pose path (`optics/fly-core.ts` `flyPose`). Nothing on the site
 *  writes one to the camera any more: the story parks its rig and dollies the
 *  LENS instead (`setLensDolly`), reading these poses only for the displacement
 *  and the fov. */
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

/** THE KNOB THAT MAKES THE FEATURE VISIBLE AT ALL, and it is the SHIPPED glass's
 *  own number (core/model.ts GLASS_SPECULAR) — the clones re-apply it because
 *  `setGlassGlint` scales it and a clone must start from the unscaled value, not
 *  because the two looks disagree. At three's default 1 and roughness ~0 each
 *  element is a MIRROR of `scene.environment` (core/model.ts's RoomEnvironment):
 *  the reflected room is so much brighter than the transmitted view that the
 *  glass reads as chrome and nothing behind it can be seen. MEASURED on the
 *  bench — with the specular at 1 the dome is invisibly indifferent to what is
 *  behind it (blanking the sky with `__lensOptics.set({skyMix:0})` does not
 *  change one pixel of it); at this value the barrel rings, the iris and the far
 *  elements come through. Low, not zero, so an element still catches a highlight
 *  and reads as GLASS rather than as a hole — the iridescent multicoat (which
 *  the clone inherits) carries the coloured coating sheen on top.
 *
 *  NOTE for anyone tempted by `envMapIntensity` instead: it is inert on a node
 *  material lit by a SCENE environment in three r185 — verified live at 0 and
 *  at 12, both indistinguishable from 1. */
const GLASS_TRANSMISSIVE_SPECULAR = GLASS_SPECULAR;

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
  /** /lens ONLY: load the shading BENCH — the seven technical looks
   *  (materials/shading-bench.ts). Dynamically imported on first call, like the
   *  path viz and the inspector, so the homepage hero never fetches the
   *  palettes, the per-mesh build machinery or the procedural matcap for looks
   *  the story cannot show.
   *
   *  AWAIT IT BEFORE OFFERING A BENCH LOOK. `setShading`/`swapShading` stay
   *  SYNCHRONOUS (a transition cuts on its own apex frame — an awaited swap
   *  there would land late), so a bench mode asked for before this resolves is
   *  refused with a console warning rather than half applied. /lens awaits it
   *  in boot(), exactly as it awaits `loadAnimations()`. Idempotent; resolves
   *  false if the chunk couldn't be fetched, leaving realistic/ink working. */
  enableShadingBench: () => Promise<boolean>;
  /** BLEND the story's pair rather than swapping it: 0 = realistic, 1 = ink,
   *  anything between is both at once (materials/unified.ts). The two looks
   *  share one material, so this is a uniform write — story/fly.ts ramps it
   *  across the dive's edges where a swap used to CUT. Writing 0 or 1 leaves
   *  the scene in exactly the state `setShading("realistic"/"ink")` would; a
   *  bench look wears its own materials and ignores the blend. */
  setInkMix: (v: number) => void;
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
   *  out of view. Story mode keeps drawing even when nothing is dirty (ambient
   *  dust/rays), so an off-screen hero
   *  would otherwise burn GPU frames forever. */
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
  /** THE DIVE'S SKY — the authored starfield drawn as real billboarded quads
   *  (optics/starfield.ts). The stars are drawn into the OPAQUE pass on purpose so three's
   *  transmission copy picks them up and the glass refracts them — see the glass
   *  contract in optics/starfield.ts before touching those materials.
   *
   *  While mounted this also owns `scene.background`, holding the sky palette's
   *  flat backdrop behind the stars (near-black on the dark stage) and putting
   *  back whatever was there on `false`. Dynamically imported on first enable;
   *  resolves false if it couldn't start. */
  enableStarfield: (on: boolean) => Promise<boolean>;
  /** DEV (/lens Demos): route the frame through the SCREEN-SPACE wormhole
   *  (optics/wormhole-post.ts) instead of rendering it straight to the canvas.
   *  While mounted, every rendered frame goes scene → render target → radial
   *  pinch about the exit axis → canvas, so the barrel, the internals, the
   *  glass and the sky all bend into the same funnel. `false` unmounts and
   *  restores the direct `renderer.render` the whole site ships with; resolves
   *  false if it couldn't start (the demo then runs undistorted, not broken).
   *  Dynamically imported on first enable. */
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
   *  the canned animations can be previewed under the story choreography. OFF
   *  restores the saved orbit pose.
   *  No-op in story mode, where the hero already owns the camera. */
  setStoryCamera: (on: boolean) => void;
  /** STORY MODE ONLY: per-frame FOV override
   *  for the fly-through span — the dive's own 42°→70° ramp, laid over the pose
   *  the story rig placed. `mix` blends it against the story's own fov (1 = the
   *  dive's, 0 = the story's), which is how the dive hands the framing back
   *  without a step; null releases it. The POSE is never overridden: the dive
   *  translates the LENS past a parked camera (setLensDolly). No restore
   *  bookkeeping — the story sample re-asserts itself the next frame it is off. */
  setStoryFov: (fov: number | null, mix?: number) => void;
  /** STORY MODE ONLY: how much the DIVE owns the framing — 0 = the story's own
   *  park/lift view offset, 1 = dead centre. The dive is shot down the optical
   *  axis with the lens ON it, so it wants the axis at the middle of the frame
   *  and nothing else; the story's offset carries the portrait LIFT
   *  (story/camera.ts), which is 6% of the canvas height on a narrow viewport
   *  and framed the whole dive that far high. story/fly.ts ramps this with the
   *  ink hand-over, so the framing centres over the same beats the drawing
   *  becomes the real lens. Landscape rows park at xs 0 with no lift, where
   *  every value of this is the same projection. */
  setStoryCentre: (k: number) => void;
  /** DEV (/lens Demos): show/hide the ambient cinematics dust. The fly-through
   *  clears it so the starfield reads; everything else leaves it on. */
  setDust: (visible: boolean) => void;
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
  /** The INTERIOR's own level, same mechanism as setShellFade on a second
   *  threshold set: the cladding (isPeelTube) and the rest-cast (isPeelRest)
   *  leave during the peel with everything else, but this channel brings them
   *  BACK over the internals tail — the dive flies through the full interior
   *  while the shell and baffles stay off until the rewrap. */
  setInteriorFade: (opacity: number) => void;
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
  /** STORY: slide the model GROUP along world X, world units. This is how the
   *  fly-through dives — the camera parks on the optical axis and the LENS
   *  travels past it, which is exactly equivalent to flying a second camera
   *  through a parked lens (x_model = x_park − x_camera) and needs no rig
   *  hand-off at either end. 0 is home. Composes with setModelOrientation
   *  (both write through one placement). */
  setLensDolly: (x: number) => void;
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
   *  clears the one part. */
  setPartOffset: (name: string, offset: PartOffset | null) => void;
  /** The addressable part registry for setPartOffset: every NAMED node of the
   *  model — the mechanism's driven group empties AND every mesh (including
   *  `_SegN` wedges and the Focus_LeadScrew_Pivot it creates). Sorted, deduped. */
  partNames: () => string[];
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
  /** Load the removable accessories GLB (hood / UV filter / caps). Defaults to
   *  `!story`: only /lens can show them, and the hero would otherwise download
   *  855 KB it never draws. With it off, `setAccessory` is a no-op. */
  accessories?: boolean;
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
  // Choose which recipes the deform folds in (per scene) BEFORE the materials
  // bake them into their graphs. Undefined = all recipes.
  setActiveRecipes(recipes ?? null);
  // TAG the meshes that ride an off-axis mechanism spin pivot (the focus lead
  // screw) BEFORE any material is built: the counter-rotation their op delta
  // needs is a baked node, not a runtime branch, so a tag arriving later would
  // do nothing. `createMechanism`, which owns the pivot itself, has to wait for
  // the recentre and runs far below — hence the split.
  tagMechanismSpins(gltfScene);
  // THE MODEL'S MATERIAL: the realistic PBR look and the story's ink drawing,
  // merged into one blended node material carrying the op deform.
  const unified = createUnified(gltfScene);
  // …and the /lens bench's own look swapper on top, which forwards the merged
  // pair to `unified` and builds only the seven bench-only styles itself.
  const shading = createShading(gltfScene, unified);
  return { unified, shading, frames };
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
  // Kick the model fetch + parse off FIRST — it needs no renderer, and
  // serializing it behind the (~100ms+) WebGPU adapter/device request was pure
  // added latency before the lens could appear. The BODY GLB alone gates the
  // first frame now; accessories stream in behind it (model.ts accessoriesReady).
  // …and the hero skips that second GLB entirely: the story shows no accessory
  // at any point, so downloading 855 KB it never draws was pure waste.
  const withAccessories = opts.accessories ?? !storyMode;
  const modelPromise = loadLensModel({ accessories: withAccessories });
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
  // owner can read off a PHONE — backend, wormhole-post status, three revision.
  // `post` is live, written by enableWormholePost below; the overlay module is
  // imported lazily so it stays out of the eager bundle. After
  // `renderer.init()`, which is when the backend choice (WebGPU vs the WebGL2
  // fallback) is final.
  const diag: import("../dev/diag").LensDiag | null =
    import.meta.env.DEV && new URLSearchParams(location.search).has("diag")
      ? { post: "unmounted" }
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
  // DEV (`?probe`, same param mould): the raw model root on window, so a part
  // can be pointed at by NAME from the console/Playwright — "which mesh is
  // that?" is a toggle-and-look instead of a guessing game.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("probe"))
    (window as unknown as Record<string, unknown>).__lensModel = gltfScene;

  // Roll the lens upright about its own optical axis (gltf-local +Y). The model
  // loads with the gear train off to one side; this rotates it to the intended
  // "up". Rolling about the optical axis is rig-safe: every mechanism (zoom/focus
  // ring turns, iris, every recipe's theta) is defined along/about this axis,
  // so a roll about it just re-phases the start angle without breaking anything.
  gltfScene.rotation.y = Math.PI / 2;

  const { unified, shading, frames } = prepareModelMaterials(
    gltfScene,
    opts.recipes,
  );
  performance.mark("lens:materials-ready");
  if (import.meta.env.DEV) {
    reportOpsFrames(gltfScene, frames);
    // Model-contract tripwire: a lens_work re-export that drifts from the
    // code's structural assumptions (part names, glass count) — or a derivation
    // that leaves a mesh unframed — fails loudly HERE, not weeks later as a
    // silent no-op or a NaN. Runs AFTER deriveFrames on purpose: half the
    // contract is about the frames it stamps.
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
  // The page's live accessory choice (default all off), tracked so the
  // background load applies the latest desired visibility on arrival and a
  // setAccessory toggle-off before load completes still wins (no stranded
  // mesh). `setAccessory` is the ONLY writer — the story shows no accessory at
  // any point on the track.
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
  // visual centre pinned at the origin — and the boot rotation restores these
  // exact values.
  const bootRotation = modelGroup.rotation.clone();
  const bootPosition = modelGroup.position.clone();
  const bootQuatInv = modelGroup.quaternion.clone().invert();

  /** The dive's dolly along world X (setLensDolly). */
  let dollyX = 0;

  /** THE ONLY WRITER of modelGroup.position: the recentring offset re-derived
   *  under the group's CURRENT rotation, plus the dolly. Both setters compose
   *  through here because the recentre is a whole-vector write — a dolly added
   *  beside it would be erased by the next reorient, and a reorient would erase
   *  the dolly. The placement is a pure function of the two pieces of state, so
   *  the setters compose in either order. */
  function applyModelPlacement() {
    modelGroup.position
      .copy(bootPosition)
      .applyQuaternion(bootQuatInv)
      .applyQuaternion(modelGroup.quaternion);
    modelGroup.position.x += dollyX;
    dirty = true;
  }

  // Mechanism (zoom/focus/aperture) + cinematic extras — both resolve nodes
  // AFTER the recentre, since the lead-screw pivot math reads world positions.
  const mechanism = createMechanism(gltfScene);
  const cinematics = createCinematics(scene, gltfScene);

  // Was the scene torn down before the background accessories load resolved? The
  // deferred integration below (and a late-arriving merge) must then no-op /
  // clean up instead of touching a disposed controller. See destroy().
  let destroyed = false;

  let dirty = true;

  /** Accessory-ness by ANCESTRY: the accessories merge into the body's graph and
   *  their sub-meshes carry generic names, so only the walk up to the `Acc_*`
   *  root tells them apart. */
  function underAccessory(o: THREE.Object3D): boolean {
    for (let a: THREE.Object3D | null = o; a; a = a.parent)
      if (isAccessory(a.name)) return true;
    return false;
  }

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
  // OWNERSHIP HAZARD. The look swapper re-materials EVERY mesh — a bench look
  // from its own build (materials/shading-bench.ts), the story's pair through
  // unified.wear() — and neither knows about these clones. So a shading switch
  // while this is on silently stomps them (harmless: that mode's look simply
  // wins), and a naive restore would stomp the new mode right back. Hence the
  // restore only touches meshes still wearing the clone it made. On the STORY
  // path the swap is safe by construction: the hero wears ink for the whole
  // track and the dive drives the blend, not the swapper.
  //
  // THE ONE PATH THAT IS NOT ORDERED: a SITE THEME FLIP on a BENCH look, on
  // /lens, while the dive's glass swap is up. shading's setTheme re-runs the
  // active mode over every mesh (materials/shading.ts setTheme → set(currentMode))
  // for those, which stomps the clones out from under it — the melt then writes
  // opacity onto materials nothing is wearing and the glass draws opaque for the
  // rest of the dive. There is no ordering that fixes it, because the flip is
  // the USER's, not a demo's. So setTheme RE-SEATS instead: the theme work is
  // allowed to land, and the swap is re-made on top of it from the spans this
  // remembers, carrying `glassFade` across (see reseatGlassTransmissive). The
  // STORY never takes that path — the merged pair re-tints through colour
  // uniforms and re-materials nothing — so the re-seat is a no-op there, but it
  // is what makes the flip safe on /lens.
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
   *  on a BENCH look rebuilds every mesh's material (the story's merged pair
   *  re-tints in place instead), and a clone of the old palette must not come
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
   *  owes a visibilityDirty mark — the traversal half, so it is not marked from
   *  in here (this is called every frame of the dive). */
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
    visibilityDirty = true;
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

  /** Every DISTINCT material currently worn by a piece of the model the body
   *  fade owns. Walks the same shapes applyVisibility does, plus the child
   *  passes that ride a host mesh (shading's inverted hulls and its
   *  LineSegments) — those are separate materials, and a body that fades while
   *  its outline stays put would read as a wireframe ghost rather than as a body
   *  going away.
   *
   *  THE GLASS IS IN IT, EXCEPT DURING THE DIVE. "The lens leaves" has to mean
   *  the elements too: the story's peel/cards cross-fade takes the whole lens
   *  away under the card shell, and with the glass held out of this set the
   *  frame kept a column of mint elements floating where the lens had been. The
   *  glass's own materials read `materialOpacity` for the same reason the edge
   *  lines do (materials/unified.ts), and their `alphaTest` is what stops a
   *  fully-faded element from writing depth — so the glass needs no branch in
   *  applyVisibility, unlike the body's hard tail.
   *
   *  …BUT NOT WHILE THE DIVE OWNS THEM. Inside the fly-through the elements wear
   *  TRANSMISSIVE CLONES whose opacity is the passage fades' (setGlassFade /
   *  setGlassElementFade, resolved by writeGlassOpacity), and the dive uses this
   *  same body fade as a COVER for the lens walking home past the camera. Two
   *  owners on one opacity is exactly the hazard the glass swap documents, so
   *  the set is captured with the glass left out for as long as the swap is on —
   *  which, since the capture is lazy and re-taken after every restore, is
   *  precisely the dive's own span. */
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
    // Guarded like setGlassHidden: the fly-through calls this from apply(p)
    // every frame, and writeGlassOpacity walks every clone.
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
    // THE MERGED PAIR'S `transparent` HAS ONE OWNER (materials/unified.ts
    // writeTransparent), because setInk's 0-edge flips the very instances this
    // fades: whichever of the two wrote last would win, and a captured value
    // restored here would put back a flag the ink has moved since. So the fade
    // does not write it on those — it declares itself and unified resolves
    // `inkOn || fadeActive`. The materials it does NOT own (a bench look's
    // fills, its line-work) are this function's, below.
    //
    // FIRST, AHEAD OF THE CAPTURE, because the declaration also takes the ink
    // twin OFF (materials/unified.ts inkTwinWorn): this function owns `opacity`
    // on whatever the meshes are wearing when it captures them, and a swap
    // after the capture would leave the level on a material nothing wears. The
    // restore below is the same story in reverse — the twin goes back on before
    // the saved opacities land on the materials it replaced.
    unified.bodyFadeActive(o < 1);
    if (o >= 1) {
      // Back to the shipped state, exactly: opacity, plus the transparent flag
      // on everything whose flag is this function's, so the body returns to the
      // opaque render list it normally lives in.
      for (const [m, was] of bodySaved) {
        m.opacity = was.opacity;
        if (unified.ownsTransparent(m)) continue; // …but not that flag (below)
        // …and only when it actually MOVES: three keys a pipeline on
        // `transparent`, so a needsUpdate here is a program rebuild. The
        // materials that reach this branch and were already built transparent
        // (the glass pair, which unified does not `flip`) would otherwise pay
        // one at every edge of the peel/cards crossfade — mid-scroll, on the
        // story's busiest beat, for a flag that never changed value.
        if (m.transparent === was.transparent) continue;
        m.transparent = was.transparent;
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
  /** THE INTERIOR — its own fade CHANNEL, not a band: the tubes/cladding and
   *  the rest-cast (core/parts isPeelTube + isPeelRest) leave with the peel
   *  like the shell does, but they RETURN over the internals tail so the
   *  fly-through dives through the full interior (owner: "don't remove the
   *  back elements that are part of the fly-through transition"), while the
   *  shell and baffles stay off until the rewrap. Two levels, one mechanism. */
  let interiorFade = 1;
  const interiorGone = new Set<THREE.Mesh>();
  const interiorThreshold = new Map<THREE.Mesh, number>();

  /** Hand every top-level mesh, IN TRAVERSAL ORDER, to the shared threshold-wink
   *  law (core/visibility.ts) and file what it hands back on the right channel.
   *  The bands and the scatter live there because story/cost.ts reproduces these
   *  same two gone-sets in node, off the shipped GLB. */
  function captureShellThresholds() {
    const wink = makeWinkScatter();
    gltfScene.traverse((o) => {
      // the same shapes applyVisibility walks: top-level meshes only, since
      // shading's child line/hull passes ride their host's flag
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
    // The sweep is owed only when the hidden set actually MOVED — this runs
    // from the scroll driver on every frame of the story.
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
   * THE ONE OWNER of the model's `.visible` flags. Four gates can hide a
   * piece — the tail of the glass fades (setGlassFade / setGlassElementFade,
   * once a transmissive clone reaches opacity 0), the body fade's tail
   * (setBodyFade at 0), the shell gate (setShellFade) and the interior gate
   * (setInteriorFade). Composed in ONE pass: a piece is visible iff EVERY
   * active gate allows it, so no gate's restore can stomp another that is still
   * engaged.
   *
   * ACCESSORIES have their own owner — `setAccessory` drives their group ROOT —
   * so the sweep skips them entirely.
   *
   * DIRTY-FLAGGED: the sweep is a pure function of the current gate state
   * (core/visibility.ts), so gate writers raise `visibilityDirty` instead of
   * sweeping at their own mutation sites, and tick() composes ONCE before the
   * render — the frame that could show the change. N gate moves in one scroll
   * frame cost one traversal; a frame with no gate motion costs none.
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

  // Fold the accessories into the live scene once they finish loading: resolve
  // the group node lists, apply the user's current visibility choice, and
  // register the new meshes with the shading swapper so a mode switch styles
  // them too.
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
    // gets its OWN scoped deriveFrames pass. Deliberate limitation: an
    // accessory is measured against itself alone — it joins neither the body's
    // rank pool nor its ladder (it has no group under its own root, so its rung
    // is 0). Folding them into the body pass instead would drag the hood/caps
    // into Barrel_Inner's group centroid and shift the body ladder; selections
    // (class `accessory`) are how a recipe addresses them.
    for (const group of Object.keys(accessories) as AccessoryGroup[])
      for (const obj of accessories[group]) deriveFrames(obj);
    // …then the merged material, over the WHOLE scene: a mesh that was already
    // present when the look was built but only got its frame just now (a fast
    // local load beats the body's own pass to it) is re-keyed onto the
    // deforming variant here.
    unified.integrate(gltfScene);
    shading.integrate(gltfScene); // …and the bench swapper learns the new meshes
    visibilityDirty = true; // fold the just-arrived meshes into every active gate
    dirty = true;
  });
  // Horizontal lens-parking is only sensible on landscape screens; on portrait /
  // phone viewports it would shove the lens off-frame, so fade it out below ~1.5:1.
  let parkScale = 1;
  /** the drawing buffer's CSS-pixel size — held GROW-ONLY in height (below) */
  let bufW = 0;
  let bufH = 0;
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    // THE URL-BAR LAW: mobile Safari collapses/expands its chrome on every
    // scroll direction change, resizing the dvh viewport by ~10% — and a
    // drawing-buffer realloc (plus its pipeline work) on each of those is a
    // felt stutter. So the buffer only reallocates when the WIDTH changes
    // (a real resize or a rotation) or the height GROWS past what we have;
    // a height-only shrink keeps the taller buffer and renders into it at the
    // CSS aspect. The projection maps NDC to the buffer's full height and the
    // browser squashes it back to the CSS height — the two scalings cancel
    // exactly, so proportions stay correct and the only cost is rendering a
    // few extra rows that are downscaled away.
    if (w !== bufW || h > bufH) {
      renderer.setSize(w, h, false);
      bufW = w;
      bufH = h;
    }
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

  // STORY fly-through fov override (see setStoryFov): the dive's own fov ramp,
  // laid over the story sample in tick(). The POSE stays the story's — the dive
  // moves the lens, not the camera (setLensDolly).
  let storyFov: number | null = null;
  let storyFovMix = 1;
  /** setStoryCentre: how much of the story's view offset the dive drops. */
  let storyCentre = 0;

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

  const EASE = CHANNEL_EASE;
  const STATE_EPS = 1e-4;

  // --- shading swaps (instant + choreographed) -------------------------------
  // applyShading is the ONE instant-swap path — the plain setShading method and
  // the transition runner below both land here.
  let currentShading: ShadingMode = "realistic";
  function applyShading(mode: ShadingMode) {
    currentShading = mode;
    shading.set(mode);
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
    // skipped (not just disabled) under the hero-camera preview: update() would
    // re-aim the camera from the controls' own state every frame
    if (controls && !storyCam) controls.update();

    // ease every channel toward its target; `easing` = any channel still moving
    // (past STATE_EPS), which keeps redraws running until everything settles
    let easing = false;
    for (const c of CHANNELS) {
      const before = state[c];
      state[c] = lerp(before, state[`${c}Target`], EASE);
      if (Math.abs(state[c] - before) > STATE_EPS) easing = true;
    }

    // Story mode has no idle early-out: it renders every tick, because the
    // ambient dust, the internals phase clock and the card orbit are time-based
    // onFrame riders that write no channel and mark nothing dirty — gating them
    // on dirty/easing would FREEZE them. (A parked-story half-rate throttle
    // lived here once; the owner cut it — the ambients are always moving, so
    // the 30 Hz was always visible.) Everything below only affects the frame
    // we're about to render, so it sits behind this gate — a fully idle /lens
    // tick does near-zero work (only the controls-damping update + the cheap
    // ease loop above run). controls.update() above still marks dirty while a
    // glide damps, so those frames DO render here and pick up the fresh camera
    // transform before renderer.render.
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
      // THE DIVE'S FRAMING, over the pose the story just placed (story/fly.ts):
      // its own fov ramp, and its claim on the CENTRE of the frame.
      //
      // The offset the framing wrote is scaled toward zero rather than cleared,
      // so the two owners cross over on a ramp instead of at an edge: at
      // storyCentre 1 the optical axis is exactly at the middle of the frame,
      // which is the dive's whole geometry (a bore shot from the axis) and what
      // the old moving-camera path got for free by clearing the offset. The
      // fly-through rows park at xs 0, so on landscape there is nothing here to
      // scale; on PORTRAIT the offset is story/camera.ts's lift, 6% of the
      // canvas height, and leaving it in place framed the entire dive that high.
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

    // Depth-fade planes track the live camera distance so the lens body stays in the
    // full-opacity middle; pieces exploding toward the camera cross the near plane
    // (and pieces receding cross the far plane) and dissolve. Widths are in model
    // radii, so it scales with whatever distance the current scene is shot from.
    // Runs on every RENDERED frame (before the render below) with the pose just
    // applied above, so a scrub/orbit/animation-select repaints with correct fade.
    {
      // distance to the SUBJECT: the story's orbit target PLUS the lens' own
      // dolly (the story camera is at target + storyPos and the model's centre
      // sits at x = dollyX, so this is |camera − subject| while the orbit
      // target stays at the origin — true of every dolly≠0 scene today; at
      // dolly 0 the sqrt form below is storyPos.length() bit for bit, x−0
      // being x), or the origin the free-orbit /lens camera circles.
      // TRACKING THE DOLLY IS THE INK'S LICENCE: the ink
      // look folds this fade into its opacity (×uInk, materials/unified.ts),
      // and the return ramp now opens while the reveal's overshoot is still
      // seating (story/fly.ts INK_RETURN against flySeatAt) — planes centred
      // on the ORIGIN there would put the parked lens 3.5 units into its own
      // far fade and dissolve its tail as the drawing came back. (Dev bench:
      // the /lens ?story preview's ink display modes — whose fade is not
      // uInk-gated, shading.ts — ride these same tracked planes; dev-only.)
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

    // The drawn sky rides ON the camera: parking the sphere on this frame's eye
    // position is what makes 200-unit-away geometry behave like the traced
    // background's infinitely distant sky (no parallax as the dive travels).
    starfield?.sync(camera);
    // The screen-space wormhole reads the SAME frame the starfield just synced — the
    // throat is the exit axis projected through this tick's camera pose, so the
    // funnel's centre and the sky it swallows can never be a frame apart.
    if (postMounted) wormholePost?.sync(camera);

    const { explodeT } = driveChannels();
    // Per-part offsets compose ON TOP of what the mechanism just wrote (and are
    // reverted after the frame's callbacks — see the block above tick()).
    applyPartOffsets();
    cinematics.update(explodeT, performance.now());
    // ONE owner writes every `.visible` flag, composing the glass, body, shell
    // and interior gates (see applyVisibility) — but only when a gate writer
    // marked the composition stale since the last pass.
    if (visibilityDirty) {
      visibilityDirty = false;
      applyVisibility();
    }

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
    // THE BODY'S OWN WARM-UP, FROM THE FRAME AFTER THE FIRST: the ink twin's
    // pipeline, drawn once on the CANVAS, ahead of the look resolution below so
    // the first frame that can wear it is a frame whose pipeline exists. Asked
    // per frame rather than armed once — integrate() mints body materials when
    // the accessories land, and those keys owe their own warm.
    if (firstFrameDone && unified.needsWarm("canvas"))
      unified.warmBodyLooks("canvas", () => renderer.render(scene, camera));
    if (warmFlyPending) {
      const spans = warmFlyPending;
      warmFlyPending = null;
      warmFlyFrame(spans);
    }
    // WHICH CONTEXT THIS FRAME DRAWS IN — one reading, handed to the look
    // resolution and then used: three keys a pipeline on the render context, so
    // it decides whether the twin may be worn at all, and the two must not be
    // able to disagree.
    const viaPass = postMounted && wormholePost !== null ? wormholePost : null;
    unified.syncBody(viaPass ? "pass" : "canvas");
    if (viaPass) viaPass.render();
    else renderer.render(scene, camera);
    // after the render, so tracked annotations see this frame's final transforms
    for (const cb of frameCbs) cb(project);
    revertPartOffsets();
    if (!firstFrameDone) {
      firstFrameDone = true;
      performance.mark("lens:first-frame"); // model visible (pipelines compiled)
    }
  }
  /** …and the ink twin's own compile goes on the frame AFTER the first, never
   *  on it: the first frame is the one the whole site's time-to-first-frame is
   *  measured on, and the twin is an optimization for the frames after it (see
   *  the warm-up in tick). Until a warm frame is paid, the body wears the blend
   *  material — which is exactly what it wore before the twin existed. */
  let firstFrameDone = false;
  renderer.setAnimationLoop(tick);
  let paused = false;
  let pathViz: PathViz | null = null;
  let inspector: Inspector | null = null;
  // The dive's DRAWN starfield (optics/starfield.ts). Dynamically imported,
  // like the path viz and the inspector, so nothing of it reaches the initial
  // bundle; the page's live choice is tracked separately because that import is
  // awaited, so an on→off during the fetch must resolve OFF. While mounted it
  // is re-centred on the camera from tick() and owns scene.background.
  let starfield: import("../optics/starfield").Starfield | null = null;
  let starsWanted = false;
  let starsBgSaved: THREE.Scene["background"] = null;
  // DEV (/lens Demos): the fly-through's SCREEN-SPACE wormhole
  // (optics/wormhole-post.ts). Same lazy-import shape as the starfield above, and
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
    // THE CANVAS'S OWN HALF OF THE WARM-UP, first. `transparent` is the one
    // thing the realistic/ink blend cannot blend (materials/unified.ts) — and
    // three keys a pipeline on it, so the realistic variant of every shared
    // material compiles on the frame the dive's ramp reaches 0 unless it is
    // compiled here (measured: one 95ms frame right at the dive's edge). This
    // is a real render of the live canvas at ink 0, which is the only way to
    // reach the CANVAS render context; tick() repaints it normally a few lines
    // below, inside this same frame, so nothing is ever shown.
    shading.withOriginals(() => renderer.render(scene, camera));
    const dry = new THREE.RenderTarget(1, 1);
    const bgSaved = scene.background ?? null;
    scene.background = starfield.backdrop;
    scene.add(starfield.object);
    // withOriginals, not setShading: a mode switch re-materials every mesh both
    // ways and would stomp the transmissive clones enabled just below (the
    // ownership hazard materials/shading.ts's swapper documents above).
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
    // AND THE INK TWIN THROUGH THE SAME PASS: the ink returns while the span is
    // still active (story/fly.ts INK_RETURN), so the twin is drawn through the
    // wormhole pass for the last third of the rewrap. Its OWN context flag —
    // the canvas warm unlocks the twin for canvas frames only.
    try {
      renderer.setRenderTarget(dry);
      unified.warmBodyLooks("pass", () => wormholePost?.render());
    } finally {
      renderer.setRenderTarget(null);
    }
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
      // where a node is DRAWN, in frame heights — the same reading the crown
      // arc tracks with (story/trails.ts), reachable from the console so its
      // authored landing circle can be re-measured against the live scene
      // instead of off a screenshot.
      projectDrawn,
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
        // SNAP the story channel home — easing it down would sweep storyP back
        // through the light-path isolate window and flash the structure out.
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
    setInteriorFade(opacity) {
      applyInteriorFade(opacity);
    },
    setRoomLight(level) {
      applyRoomLight(level);
    },
    setModelOrientation(euler) {
      // null (and every omitted axis) is the boot rotation, which makes the
      // recentring re-derivation below the identity — one path, no reset branch.
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
      // import above must not let this continuation strand a mount.
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
      // The LATEST desired state, not the captured `on`: an exit during the
      // import above must not let this continuation strand a mount.
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
    setInkMix(v) {
      unified.setInk(v);
      // THE ENDPOINTS ARE THE TWO MODES, and `currentShading` has to say so for
      // TWO reasons. (1) swapShading early-returns on `mode === currentShading`,
      // so leaving it stale would make a later swapShading("ink") — after the
      // story had already blended to 1 — a no-op that drops the transition and
      // whatever the blend is holding. (2) getShading() is what /lens's demos
      // snapshot on enter() to restore on exit(), and the honest answer is the
      // look that is actually on screen.
      //
      // MID-RAMP THE TWO DIVERGE, deliberately: between the endpoints this
      // leaves `currentShading` reading "realistic" or "ink" while the screen
      // shows a blend of both. Benign, because a ramp only ever runs on the
      // STORY page, where nothing calls swapShading and no demo snapshots
      // anything — and the ramp's own next frame writes the endpoint the moment
      // it lands. Naming the blend would need a third mode the swapper cannot
      // wear, which is a worse lie than a stale endpoint.
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
      // AFTER shading, never instead of it: on a BENCH look shading.setTheme
      // re-materials every mesh and stomps the transmissive clones (the
      // ownership hazard at enableGlassTransmissive). Let the theme work land,
      // then re-seat the swap on top of it — the fade value rides along, so a
      // flip mid-melt is invisible instead of freezing the glass opaque for the
      // rest of the dive. On the story's merged pair nothing is re-materialled
      // (the ink re-tints through a colour uniform), so this re-clones from the
      // same materials and costs one pass.
      if (glassTransmissive) reseatGlassTransmissive();
      dirty = true;
    },
    destroy() {
      destroyed = true;
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
      // The accessories may still be in flight — dispose again once (if) they
      // merge, so their deferred geometries/materials are freed too. disposeLensModel
      // dedupes per call, so re-running over the (already-disposed) body is safe.
      accessoriesReady.then(() => disposeLensModel(gltfScene));
    },
  };
  return handle;
}
