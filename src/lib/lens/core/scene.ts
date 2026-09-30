import * as THREE from "three/webgpu";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLASS_SPECULAR, loadLensModel, setLensEnvironment } from "./model";
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
import { createWarmQueue, warmDrawSteps, type WarmStep } from "./warm";
import { captureBodyFade, restoreBodyFade } from "./body-fade";
// Type-only, so the dev instruments stay out of the bundle.
import type { PathViz } from "../dev/paths";
import type { Inspector } from "../dev/inspect";

export type { ShadingMode } from "../materials/shading";
export type { PathViz } from "../dev/paths";
export type { TransitionName } from "./transitions";

/** Options for SceneHandle.swapShading. */
export interface SwapShadingOptions {
  /** default "blink" */
  transition?: TransitionName;
  /** each transition has its own default */
  durationMs?: number;
  /** "twist" only: whole turns per swap (default 1) */
  turns?: number;
  /** Called each frame with progress 0..1; not called for an instant swap. */
  onProgress?: (t: number) => void;
}

// Scene orchestrator: renderer, camera, lights, model load, channel easing and
// the per-frame tick. /lens and the homepage story share this one setup path.

/** One channel's registry entry. */
interface ChannelSpec {
  /** rest value, and the ease target at boot */
  default: number;
  /** /lens resets this channel when the animation changes */
  animReset?: boolean;
  /** zeroed by the dev idle check (the deform is an exact identity at 0) */
  idleZero?: boolean;
  /** moves pieces off the body, so it widens the depth-fade band */
  spread?: boolean;
}

/** Every animated channel. All other per-channel lists derive from this. */
const CHANNEL_REGISTRY = {
  /** 0 (18mm, retracted) .. 1 (50mm, extended) */
  zoom: { default: 0 },
  /** 0 (infinity) .. 1 (min focus, ~0.12m) */
  focus: { default: 0 },
  /** 0 (f/2.8, wide open) .. 1 (f/22, closed down) */
  aperture: { default: 0 },
  /** 0 (seated) .. 1 (core pulled axially compact); story only */
  huddle: { default: 0 },
  /** 0 (assembled) .. 1 (parts spread along the axis) */
  explode: { default: 0, animReset: true, idleZero: true, spread: true },
  /** 0 (seated) .. 1 (sheets unwrapped) */
  assemble: { default: 0, animReset: true, idleZero: true, spread: true },
  /** 0 (seated) .. 1 (shell rolled out flat); story only */
  peel: { default: 0, animReset: true, idleZero: true, spread: true },
  /** 0 (seated) .. 1 (petals opened into an origami rose) */
  rose: { default: 0, animReset: true, idleZero: true, spread: true },
  /** 0..1 scroll-story progress; drives the scripted camera */
  story: { default: 0 },
} satisfies Record<string, ChannelSpec>;
type Channel = keyof typeof CHANNEL_REGISTRY;
const CHANNELS = Object.keys(CHANNEL_REGISTRY) as Channel[];
const TARGET_KEYS = CHANNELS.map((c) => `${c}Target`) as `${Channel}Target`[];
// Widens each entry back to ChannelSpec so the optional flags are readable.
const specOf = (c: Channel): ChannelSpec => CHANNEL_REGISTRY[c];

export const CHANNEL_DEFAULTS = Object.fromEntries(
  CHANNELS.map((c) => [c, CHANNEL_REGISTRY[c].default]),
) as Record<Channel, number>;

export const ANIM_RESET_CHANNELS = CHANNELS.filter((c) => specOf(c).animReset);
export const IDLE_ZERO_CHANNELS = CHANNELS.filter((c) => specOf(c).idleZero);
const SPREAD_CHANNELS = CHANNELS.filter((c) => specOf(c).spread);

export type { Channel };

/** Share of the remaining distance a channel closes per 60 Hz frame. */
export const CHANNEL_EASE = 0.22;
/** the frame length CHANNEL_EASE is defined for, ms */
export const EASE_FRAME_MS = 1000 / 60;
/** the longest dt one tick may integrate, ms */
export const EASE_DT_MAX_MS = 100;
/** a channel this close to its target snaps onto it */
const STATE_EPS = 1e-4;

/** CHANNEL_EASE rescaled to a frame of `dt` ms. */
export const easeK = (dt: number): number =>
  dt === EASE_FRAME_MS
    ? CHANNEL_EASE
    : 1 - Math.pow(1 - CHANNEL_EASE, dt / EASE_FRAME_MS);

/** One ease step toward `target`, snapping onto it within STATE_EPS. */
export const easeStep = (value: number, target: number, dt: number): number => {
  const next = lerp(value, target, easeK(dt));
  return Math.abs(target - next) < STATE_EPS ? target : next;
};

/** Live channel values plus targets; tick() eases values toward targets. */
export type SceneState = { [K in Channel]: number } & {
  [K in Channel as `${K}Target`]: number;
};

export type AccessoryGroup = "hood" | "filter" | "caps";

/** The model nodes each accessory group shows and hides. */
const ACCESSORY_NODES: Record<AccessoryGroup, string[]> = {
  hood: ["Acc_Hood"],
  filter: ["Acc_Filter_Glass", "Acc_Filter_Ring"],
  caps: ["Acc_CapFront", "Acc_CapRear"],
};

/** A camera orbit pose around (targetX, targetY, 0); angles in radians,
 *  azimuth measured from +z toward +x. */
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

/** One optical element's axial span in the gltf frame, in mm. Its length is
 *  the element's refraction thickness. */
export interface GlassSpanMm {
  frontYmm: number;
  rearYmm: number;
}

export interface SceneHandle {
  state: SceneState;
  /** Show/hide a removable accessory group (all hidden by default). */
  setAccessory: (group: AccessoryGroup, visible: boolean) => void;
  /** Switch the render style for the whole model, instantly. */
  setShading: (mode: ShadingMode) => void;
  /** /lens only: lazy-load the extra shading looks. Await before using one;
   *  resolves false if the chunk failed to load. */
  enableShadingBench: () => Promise<boolean>;
  /** Blend realistic (0) to ink (1). Ignored while a bench look is on. */
  setInkMix: (v: number) => void;
  /** Switch the render style behind an animated transition. A call mid-swap
   *  retargets it; reduced motion switches instantly. */
  swapShading: (mode: ShadingMode, opts?: SwapShadingOptions) => void;
  /** Follow the site theme (light = no `.dark` on <html>). */
  setTheme: (light: boolean) => void;
  /** Stop/restart the render loop, e.g. when the hero is off screen. */
  setPaused: (paused: boolean) => void;
  /** Force one redraw. */
  invalidate: () => void;
  /** Story mode: run `cb` before each drawn frame with the eased story
   *  progress and dt (ms). Return true to request another frame. */
  onEvaluate: (cb: (pE: number, dt: number) => boolean | void) => void;
  /** Run `cb` after each drawn frame with a node-name → screen-position
   *  projector (null if missing or behind the camera). Return true to request
   *  another frame. Positions ignore the in-shader deform. */
  onFrame: (
    cb: (
      project: (name: string, out: TrackedPoint) => TrackedPoint | null,
      dt: number,
    ) => boolean | void,
  ) => void;

  /** Dev: motion-path overlay. Resolves null if it can't start. */
  enablePathViz: (
    onStatus: (text: string, ok: boolean) => void,
  ) => Promise<PathViz | null>;
  /** Dev: hover a mesh to read its node name, click to copy. */
  enableInspect: (on: boolean) => Promise<boolean>;
  /** Show the fly-through's starfield (it also owns `scene.background`). */
  enableStarfield: (on: boolean) => Promise<boolean>;
  /** Render through the fly-through's wormhole post pass. */
  enableWormholePost: (on: boolean) => Promise<boolean>;
  /** Build the wormhole pass ahead of time without showing it. */
  buildWormholePost: () => Promise<boolean>;
  /** Compile the fly-through's shaders ahead of time by drawing it off screen
   *  once. Changes no visible state; runs once per page. */
  warmFly: (spans: Record<string, GlassSpanMm>) => Promise<boolean>;
  /** Upload `objects` to the GPU ahead of time by drawing each once off
   *  screen. `viaPass` also draws them through the wormhole pass. */
  warmDraw: (objects: THREE.Object3D[], viaPass?: boolean) => void;
  /** Dev (/lens): drive the camera from `state.story`, not OrbitControls. */
  setStoryCamera: (on: boolean) => void;
  /** Story mode: override the fov, blended by `mix`; null releases it. */
  setStoryFov: (fov: number | null, mix?: number) => void;
  /** Story mode: 0 = the story's off-centre framing, 1 = lens dead centre. */
  setStoryCentre: (k: number) => void;
  /** Show/hide the ambient dust. */
  setDust: (visible: boolean) => void;
  /** Make the glass elements refractive. `spans` gives each element's
   *  thickness and is read only when turning on. */
  setGlassTransmissive: (
    on: boolean,
    spans?: Record<string, GlassSpanMm>,
  ) => void;
  /** Attach an object that moves with the lens (origin at its visual centre,
   *  bore along +X). The caller disposes it. */
  addModelOverlay: (obj: THREE.Object3D) => void;
  removeModelOverlay: (obj: THREE.Object3D) => void;
  /** World-X extent of each named node, at rest (ignores the deform). */
  worldAxialSpans: (
    ids: string[],
  ) => Record<string, { x0: number; x1: number }>;
  /** Fade all transmissive glass together; only while transmissive is on. */
  setGlassFade: (opacity: number) => void;
  /** Per-element glass opacity, multiplied by setGlassFade's; omitted ids keep
   *  their last value. */
  setGlassElementFade: (fades: Record<string, number>) => void;
  /** Scale reflections on the transmissive glass (reset when it turns off). */
  setGlassGlint: (level: number) => void;
  /** Fade everything except the optical glass. At 0 those meshes are hidden. */
  setBodyFade: (opacity: number) => void;
  /** Fade the outer shell off, piece by piece (clamped to 0..1). */
  setShellFade: (opacity: number) => void;
  /** Fade the interior pieces, on their own thresholds (clamped to 0..1). */
  setInteriorFade: (opacity: number) => void;
  /** Scale the environment and studio lights together (not the starfield). */
  setRoomLight: (level: number) => void;
  /** Set the model's orientation, keeping its centre on the origin. Omitted
   *  axes, or null, use the boot orientation. */
  setModelOrientation: (
    euler: { x?: number; y?: number; z?: number } | null,
  ) => void;
  /** Slide the model along world X (how the fly-through moves). */
  setLensDolly: (x: number) => void;
  /** Attach/detach an object at the scene root. The caller disposes it. */
  addOverlay: (obj: THREE.Object3D) => void;
  removeOverlay: (obj: THREE.Object3D) => void;
  /** Attach an object to the starfield so it follows the camera. False until
   *  the starfield is shown. */
  starfieldAttach: (obj: THREE.Object3D) => boolean;
  starfieldDetach: (obj: THREE.Object3D) => void;
  /** Blend the starfield backdrop `f` toward `rgb` (0-255). Reset to 0 before
   *  hiding the starfield. */
  setSkyDim: (f: number, rgb: [number, number, number]) => void;
  /** Vertical half-extent per unit of view depth: tan(fov/2) / zoom. */
  frameHalf: () => number;
  /** camera.aspect */
  frameAspect: () => number;
}

/** Zoom that sizes the lens by the smaller viewport side, capped at `maxPx`. */
export const frameZoom = (w: number, h: number, maxPx = Infinity): number =>
  Math.min(w, h, maxPx) / h;

/** How far the story shifts the lens sideways: 1 wide screen, 0 phone. */
export const parkScaleFor = (w: number, h: number): number =>
  Math.max(0, Math.min(1, (w / h - 0.8) / 0.7));

// The GLB is in millimetres (Y-up, front along +y); scales mm to world units.
const MODEL_SCALE = 0.05;

/** The camera's minimum far plane. */
const CAM_FAR = 400;

/** Far plane for a camera `dist` from a model of `radius` (>= CAM_FAR). */
export const farFor = (dist: number, radius: number): number =>
  Math.max(CAM_FAR, dist + radius * 8);

export interface SceneOptions {
  /** Multiplier on the default camera distance. */
  cameraDistance?: number;
  /** Scroll-story mode: the camera follows `state.story`; no OrbitControls. */
  story?: boolean;
  /** Load the accessories GLB. Defaults to `!story`. */
  accessories?: boolean;
}

/**
 * CPU prep on the loaded model. Order matters: deriveFrames stamps the `_op*`
 * attributes that the next three passes read. Runs while the renderer boots.
 */
async function prepModel(gltfScene: THREE.Object3D) {
  // Yield first so renderer.init()'s GPU round trips aren't starved.
  await new Promise((r) => setTimeout(r, 0));
  const frames = deriveFrames(gltfScene);
  const winks = stampWinkLanes(gltfScene);
  tagMechanismSpins(gltfScene);
  performance.mark("lens:frames-derived");
  const inkEdges = cutInkEdges(gltfScene);
  performance.mark("lens:lines-cut");
  return { frames, winks, inkEdges };
}

/** The model's boot rotation about Z: lays the optical axis (gltf +Y) along
 *  world +X. At 0 the lens stands upright. */
export const MODEL_BORE_X_Z = -Math.PI / 2;

/** A group under the model whose world transform is the identity at boot and
 *  then follows the model's rotation about its visual centre `center`. */
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

/**
 * Boot the lens viewer onto `canvas`. One scene per document: deform channels
 * and shading uniforms are module state, so destroy one before booting another.
 */
export async function initScene(
  canvas: HTMLCanvasElement,
  opts: SceneOptions = {},
): Promise<SceneHandle> {
  performance.mark("lens:init-start");
  const storyMode = opts.story ?? false;
  // Start the model fetch before the renderer so the two overlap.
  const withAccessories = opts.accessories ?? !storyMode;
  const modelPromise = loadLensModel({ accessories: withAccessories }).then(
    async (loaded) => ({ ...loaded, ...(await prepModel(loaded.scene)) }),
  );
  // WebGPU, falling back to WebGL2 where unsupported; `?webgl` forces WebGL2.
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "high-performance",
    forceWebGL: new URLSearchParams(location.search).has("webgl"),
  });
  // Story mode renders continuously at full viewport, so it gets a lower cap.
  renderer.setPixelRatio(
    Math.min(window.devicePixelRatio, storyMode ? 1.5 : 2),
  );
  renderer.setClearColor(0x000000, 0);
  await renderer.init();
  performance.mark("lens:renderer-ready");
  // Pick the deform shader dialect before any material is built.
  setDeformBackend(
    (renderer as unknown as { backend?: { isWebGLBackend?: true } }).backend
      ?.isWebGLBackend
      ? "glsl"
      : "wgsl",
  );

  // Dev (`?diag`): an on-screen status card, for phones.
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
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, CAM_FAR);
  const camDist = opts.cameraDistance ?? 1;
  camera.position.set(3.5 * camDist, 1.6 * camDist, 5 * camDist);

  setLensEnvironment(renderer, scene);

  const key = new THREE.DirectionalLight(0xffffff, 2.0);
  key.position.set(3, 5, 6);
  const rim = new THREE.DirectionalLight(0xbcd4ff, 1.3);
  rim.position.set(-4, -1, -3);
  const hemi = new THREE.HemisphereLight(0xf1f5f9, 0x8090a0, 0.9);
  scene.add(key, rim, hemi);

  // Boot intensities, so setRoomLight is a pure scale.
  const roomLightBoot = {
    env: scene.environmentIntensity,
    key: key.intensity,
    rim: rim.intensity,
    hemi: hemi.intensity,
  };
  let roomLight = 1;

  // --- model ---
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
  // Never rejects: on failure the accessories just don't appear.
  const accessoriesReady = accessoriesLoad.catch((err) => {
    console.warn("lens: accessories failed to load (hood/caps/filter)", err);
  });
  performance.mark("lens:model-loaded");
  modelGroup.add(gltfScene);
  // Dev (`?probe`): expose the model root on window for console poking.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("probe"))
    (window as unknown as Record<string, unknown>).__lensModel = gltfScene;

  // Roll the lens about its own optical axis so it sits upright.
  gltfScene.rotation.y = Math.PI / 2;

  // needs prepModel's attributes and setDeformBackend() first
  const unified = createUnified(gltfScene, inkEdges);
  const shading = createShading(gltfScene, unified);
  performance.mark("lens:materials-ready");
  if (import.meta.env.DEV) {
    reportOpsFrames(gltfScene, frames);
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
    // `window.__lensPrescriptionProbe()` prints optics/prescription.ts's table.
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

  // The requested visibility per group, applied when the accessories arrive.
  const accessoryOn: Record<AccessoryGroup, boolean> = {
    hood: false,
    filter: false,
    caps: false,
  };

  // Centre the bare lens (no accessories) on the world origin.
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
  // World radius of the assembled lens (sizes the depth-fade band).
  const modelRadius = bbox.getBoundingSphere(new THREE.Sphere()).radius;

  // Boot pose, so a reorientation can keep the visual centre on the origin.
  const bootRotation = modelGroup.rotation.clone();
  const bootPosition = modelGroup.position.clone();
  const bootQuatInv = modelGroup.quaternion.clone().invert();

  const modelAnchor = modelAnchorFor(center, bootQuatInv);
  modelGroup.add(modelAnchor);
  modelAnchor.updateWorldMatrix(true, false);

  let dollyX = 0;

  /** The only writer of modelGroup.position: the centring offset rotated to
   *  the current orientation, plus the dolly. */
  function applyModelPlacement() {
    modelGroup.position
      .copy(bootPosition)
      .applyQuaternion(bootQuatInv)
      .applyQuaternion(modelGroup.quaternion);
    modelGroup.position.x += dollyX;
    dirty = true;
  }

  // Created after centring: the mechanism's pivot math reads world positions.
  const mechanism = createMechanism(gltfScene);
  const cinematics = createCinematics(scene, gltfScene);

  let dirty = true;
  const invalidate = () => {
    dirty = true;
  };

  // --- transmissive glass ---
  // Each glass mesh gets its own clone of its material with a real thickness
  // (the shipped glass shares one material with thickness 0). Restores only
  // touch meshes still wearing our clone, since shading swaps can replace it.
  let glassTransmissive = false;
  /** kept so setTheme can rebuild the clones */
  let glassSpans: Record<string, GlassSpanMm> = {};
  /** Each mesh's source material and its clone. Clones are reused across
   *  toggles so their shaders compile only once. */
  const glassCloneCache = new Map<
    THREE.Mesh,
    { src: THREE.Material; clone: THREE.MeshPhysicalNodeMaterial }
  >();
  /** the meshes wearing a clone, by element id */
  const glassElements = new Map<string, THREE.Mesh[]>();
  let glassFade = 1;
  /** per-element opacity multiplier; absent = 1 */
  const glassElementFade = new Map<string, number>();
  let glassGlint = 1;
  /** glass meshes at opacity 0, hidden by the visibility sweep */
  const glassGone = new Set<THREE.Mesh>();

  /** Write each element's opacity onto its clones and update `glassGone`.
   *  Returns true if `glassGone` changed. */
  function writeGlassOpacity(): boolean {
    let goneMoved = false;
    for (const [id, meshes] of glassElements) {
      const o = glassFade * (glassElementFade.get(id) ?? 1);
      const gone = o <= 0;
      for (const m of meshes) {
        glassCloneCache.get(m)!.clone.opacity = o;
        if (gone === glassGone.has(m)) continue;
        goneMoved = true;
        if (gone) glassGone.add(m);
        else glassGone.delete(m);
      }
    }
    return goneMoved;
  }

  /** The transmissive clone for `m`: the cached one if `src` is unchanged,
   *  else a fresh clone. */
  function glassCloneFor(
    m: THREE.Mesh,
    src: THREE.Material,
    thickness: number,
  ): THREE.MeshPhysicalNodeMaterial {
    const hit = glassCloneCache.get(m);
    if (hit && hit.src === src) {
      hit.clone.thickness = thickness;
      hit.clone.specularIntensity = GLASS_SPECULAR * glassGlint;
      return hit.clone;
    }
    hit?.clone.dispose(); // stale: the mesh wears a different material now
    const clone = src.clone() as THREE.MeshPhysicalNodeMaterial;
    clone.transmission = 1;
    clone.ior = 1.52;
    // a little roughness softens what is seen through the glass
    clone.roughness = 0.05;
    clone.specularIntensity = GLASS_SPECULAR * glassGlint;
    clone.thickness = thickness;
    // Neutral colour slots. Assign new Colors rather than `.setHex`: the
    // source may lack these slots.
    clone.color = new THREE.Color(0xffffff);
    clone.specularColor = new THREE.Color(0xffffff);
    clone.attenuationColor = new THREE.Color(0xffffff);
    clone.attenuationDistance = Infinity;
    clone.iridescence = 0;
    // Set once up front: toggling `transparent` later forces a recompile.
    clone.transparent = true;
    glassCloneCache.set(m, { src, clone });
    return clone;
  }

  function enableGlassTransmissive(spans: Record<string, GlassSpanMm>) {
    glassSpans = spans;
    for (const [id, span] of Object.entries(spans)) {
      // local units (mm); three applies the model scale itself
      const thickness = Math.abs(span.frontYmm - span.rearYmm);
      const meshes: THREE.Mesh[] = [];
      node(id)?.traverse((o) => {
        // skip outline meshes (parented under the mesh they outline) and
        // multi-material meshes
        if (!(o instanceof THREE.Mesh) || o.parent instanceof THREE.Mesh)
          return;
        if (Array.isArray(o.material)) return;
        o.material = glassCloneFor(o, o.material, thickness);
        meshes.push(o);
      });
      if (meshes.length) glassElements.set(id, meshes);
    }
    // re-apply the current fade levels (they survive a rebuild)
    writeGlassOpacity();
  }

  /** Give each mesh still wearing a clone its original material back. Keeps
   *  the fade levels and the clone cache. */
  function releaseGlassClones() {
    for (const meshes of glassElements.values())
      for (const m of meshes) {
        const { src, clone } = glassCloneCache.get(m)!;
        if (m.material === clone) m.material = src;
      }
    glassElements.clear();
    glassGone.clear();
  }

  function disableGlassTransmissive() {
    releaseGlassClones();
    glassSpans = {};
    glassFade = 1;
    glassElementFade.clear();
    glassGlint = 1;
    // the glass is back under the body fade: include it if one is running
    if (bodySaved.size) captureBody();
  }

  /** Rebuild the clones from whatever materials the meshes wear now (after a
   *  theme change re-materials them). */
  function reseatGlassTransmissive() {
    releaseGlassClones();
    enableGlassTransmissive(glassSpans);
    visibilityDirty = true;
  }

  // --- body fade ---
  // Writes opacity onto the shared materials; `bodySaved` holds each one's
  // original transparent/opacity for an exact restore.
  let bodyFade = 1;
  let bodyFadedOut = false;
  const bodySaved = new Map<
    THREE.Material,
    { transparent: boolean; opacity: number }
  >();

  /** Every material on the model's meshes and their child passes (outlines,
   *  line-work), minus the glass while it is transmissive. */
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

  /** Capture the materials worn right now and apply the current fade to them.
   *  Done lazily because shading and theme changes swap materials. */
  function captureBody() {
    captureBodyFade(
      bodySaved,
      bodyMaterials(),
      unified.ownsTransparent,
      bodyFade,
    );
  }

  // The apply* setters run every frame, so they return early on no change.
  function applyGlassFade(opacity: number) {
    const o = clamp01(opacity);
    if (!glassTransmissive || o === glassFade) return;
    glassFade = o;
    if (writeGlassOpacity()) visibilityDirty = true;
    dirty = true;
  }

  function applyGlassElementFade(fades: Record<string, number>) {
    if (!glassTransmissive) return;
    let moved = false;
    for (const [id, v] of Object.entries(fades)) {
      const o = clamp01(v);
      if ((glassElementFade.get(id) ?? 1) === o) continue;
      glassElementFade.set(id, o);
      moved = true;
    }
    if (!moved) return;
    if (writeGlassOpacity()) visibilityDirty = true;
    dirty = true;
  }

  /** Kept even while transmissive is off; new clones pick it up. */
  function applyGlassGlint(level: number) {
    const k = clamp01(level);
    if (k === glassGlint) return;
    glassGlint = k;
    for (const { clone } of glassCloneCache.values())
      clone.specularIntensity = GLASS_SPECULAR * k;
    dirty = true;
  }

  function applyBodyFade(opacity: number) {
    const o = clamp01(opacity);
    if (o === bodyFade) return;
    bodyFade = o;
    // unified.ts owns `transparent` on its materials. Must run before the
    // capture below: it can swap which material the meshes wear.
    unified.bodyFadeActive(o < 1);
    if (o >= 1) restoreBodyFade(bodySaved, unified.ownsTransparent);
    else if (!bodySaved.size) captureBody();
    else for (const m of bodySaved.keys()) m.opacity = o;
    const out = o <= 0;
    if (out !== bodyFadedOut) {
      bodyFadedOut = out;
      visibilityDirty = true;
    }
    dirty = true;
  }

  // --- shell and interior fades ---
  // The level is a shader uniform each piece dissolves against at its own
  // threshold; fully dissolved pieces are also hidden.
  /** A fade channel's setter: writes the uniform and keeps `gone` (the
   *  meshes fully dissolved at the current level) up to date. */
  function winkFader(
    channel: WinkThreshold["channel"],
    uniform: { value: number },
    gone: Set<THREE.Mesh>,
  ) {
    const thresholds: [THREE.Mesh, number][] = [];
    for (const [m, w] of winks)
      if (w.channel === channel) thresholds.push([m, w.threshold]);
    let level = 1;
    return (opacity: number) => {
      const o = clamp01(opacity);
      if (o === level) return;
      level = o;
      uniform.value = o;
      for (const [m, t] of thresholds) {
        const out = winkGone(t, o);
        if (out === gone.has(m)) continue;
        if (out) gone.add(m);
        else gone.delete(m);
        visibilityDirty = true;
      }
      dirty = true;
    };
  }
  const shellGone = new Set<THREE.Mesh>();
  const interiorGone = new Set<THREE.Mesh>();
  const applyShellFade = winkFader("shell", uShellFade, shellGone);
  const applyInteriorFade = winkFader("interior", uInteriorFade, interiorGone);

  function applyRoomLight(level: number) {
    const k = clamp01(level);
    if (k === roomLight) return;
    roomLight = k;
    scene.environmentIntensity = roomLightBoot.env * k;
    key.intensity = roomLightBoot.key * k;
    rim.intensity = roomLightBoot.rim * k;
    hemi.intensity = roomLightBoot.hemi * k;
    dirty = true;
  }

  // The only writer of the model's `.visible` flags (accessories aside): a
  // piece shows unless a fade has hidden it. Recomputed in tick() when dirty.
  let visibilityDirty = true;
  const visibilityGates: VisibilityGates = {
    glassGone,
    get bodyFadedOut() {
      return bodyFadedOut;
    },
    shellGone,
    interiorGone,
  };

  /** Apply a group's requested visibility (once the accessories have loaded). */
  function showAccessory(group: AccessoryGroup) {
    for (const name of ACCESSORY_NODES[group]) {
      const obj = node(name);
      if (obj) obj.visible = accessoryOn[group];
    }
  }
  // Once the accessories load: apply visibility, derive frames, set up materials.
  accessoriesReady.then(() => {
    for (const group of Object.keys(ACCESSORY_NODES) as AccessoryGroup[]) {
      showAccessory(group);
      // Separate frame pass per accessory, so the body's frames are unchanged.
      for (const name of ACCESSORY_NODES[group]) {
        const obj = node(name);
        if (obj) deriveFrames(obj);
      }
    }
    unified.integrate(gltfScene);
    shading.integrate(gltfScene);
    visibilityDirty = true;
    dirty = true;
  });

  // --- viewport ---
  let parkScale = 1;
  /** drawing buffer size in CSS px; the height only grows (see resize) */
  let bufW = 0;
  let bufH = 0;
  /** when the buffer last resized (0 = no post-pass rebuild owed) */
  let postStaleAt = 0;
  /** canvas CSS size, cached to avoid forced layouts per frame */
  let cssW = 1;
  let cssH = 1;
  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    cssW = w;
    cssH = h;
    // Mobile toolbars resize the viewport on scroll, so only reallocate on a
    // width change or a taller height.
    if (w !== bufW || h > bufH) {
      renderer.setSize(w, h, false);
      bufW = w;
      bufH = h;
      // three keeps rendering transmission into its old-sized texture after a
      // resize, so the post pass must be rebuilt.
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

  // --- frame callbacks and node tracking ---
  const frameCbs: Parameters<SceneHandle["onFrame"]>[0][] = [];
  const evaluateCbs: Parameters<SceneHandle["onEvaluate"]>[0][] = [];

  const trackCache = new Map<
    string,
    { obj: THREE.Object3D; local: THREE.Vector3 } | null
  >();
  const trackVec = new THREE.Vector3();
  /** Screen position of a node's bbox centre (cached in its local frame). */
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
    t.obj.localToWorld(trackVec).project(camera);
    if (trackVec.z > 1) return null; // behind the camera
    out.x = ((trackVec.x + 1) / 2) * cssW;
    out.y = ((1 - trackVec.y) / 2) * cssH;
    return out;
  }

  // --- camera control ---
  // Story mode scripts the camera, so it has no OrbitControls.
  const controls = storyMode ? null : new OrbitControls(camera, canvas);
  if (controls) {
    controls.enableDamping = true;
    controls.minDistance = 2;
    controls.maxDistance = 20;
    controls.target.set(0, 0, 0);
    // middle-drag orbits like left-drag; the wheel already owns dolly
    controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE;
    controls.addEventListener("change", invalidate);
    controls.update();
  }

  // Dev (setStoryCamera); orbitPose is restored on exit.
  let storyCam = false;
  const orbitPose = {
    pos: new THREE.Vector3(),
    up: new THREE.Vector3(),
    fov: camera.fov,
  };

  // Fly-through overrides on top of the story camera (setStoryFov/Centre).
  const dive: DiveFraming = {
    centre: 0,
    fov: null,
    fovMix: 1,
    far: (dist) => farFor(dist, modelRadius),
  };

  const state = Object.fromEntries(
    CHANNELS.flatMap((c) => [
      [c, CHANNEL_DEFAULTS[c]],
      [`${c}Target`, CHANNEL_DEFAULTS[c]],
    ]),
  ) as SceneState;

  // --- shading ---
  let currentShading: ShadingMode = "realistic";
  function applyShading(mode: ShadingMode) {
    currentShading = mode;
    shading.set(mode);
    dirty = true;
  }

  // Animated swap (transitions in core/transitions.ts). One at a time: a call
  // mid-swap retargets the pending mode.
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
    onProgress?: (t: number) => void;
  } | null = null;
  function swapShading(mode: ShadingMode, opts: SwapShadingOptions = {}) {
    if (activeSwap) {
      activeSwap.pending = mode;
      // already past the swap point: switch now rather than animate again
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
      onProgress: opts.onProgress,
    };
    const step = (now: number) => {
      if (!activeSwap) return;
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
        requestAnimationFrame(step);
      }
    };
    requestAnimationFrame(step);
  }

  // --- per-frame drive ---
  /** Push channel values into the mechanism and the shader uniforms. Also
   *  called by the dev path visualizer. */
  const mech = { zoom: NaN, focus: NaN, aperture: NaN, huddle: NaN };
  function driveChannels() {
    const zoom = smoothstep(0, 1, clamp01(state.zoom));
    const focus = clamp01(state.focus);
    const aperture = clamp01(state.aperture);
    const huddle = clamp01(state.huddle);
    // Mechanism (rings, element slides, iris): only when an input changed.
    if (
      zoom !== mech.zoom ||
      focus !== mech.focus ||
      aperture !== mech.aperture ||
      huddle !== mech.huddle
    ) {
      mech.zoom = zoom;
      mech.focus = focus;
      mech.aperture = aperture;
      mech.huddle = huddle;
      mechanism.update(mech);
    }
    // Deform recipes run in the shader off these uniforms.
    for (const name of RECIPE_NAMES)
      recipeChannel(name).value = clamp01(state[name]);
  }

  let paused = false;
  let pathViz: PathViz | null = null;
  let inspector: Inspector | null = null;

  // --- fly-through: starfield and wormhole post pass (lazy-loaded) ---
  // `*Wanted` is the latest request, applied after the import resolves.
  let starfield: import("../optics/starfield").Starfield | null = null;
  let starsWanted = false;
  let starsBgSaved: THREE.Scene["background"] = null;
  let wormholePost: import("../optics/wormhole-post").WormholePost | null =
    null;
  /** kept from the first import so a rebuild is synchronous */
  let makePost:
    typeof import("../optics/wormhole-post").createWormholePost | null =
    null;
  let postWanted = false;
  let postMounted = false;

  // Off-screen warm-up draws (core/warm.ts), one per tick before its render.
  const warmQueue = createWarmQueue();
  function queueWarm(...steps: WarmStep[]) {
    warmQueue.push(...steps);
    dirty = true;
  }
  /** a step that waits for a tick with no post pass and no fly-through */
  const bareStep = (run: () => void): WarmStep => ({ bare: true, run });

  /** Run `body` with rendering sent to a throwaway 1×1 target, so its draws
   *  compile shaders without reaching the canvas. */
  function drawDry(body: () => void) {
    const dry = new THREE.RenderTarget(1, 1);
    try {
      renderer.setRenderTarget(dry);
      body();
    } finally {
      renderer.setRenderTarget(null);
      dry.dispose();
    }
  }

  /** Draw one frame through the post pass off screen (compiles it). */
  function warmPassFrame() {
    const post = wormholePost;
    if (post) drawDry(() => post.render());
  }

  /** Owed after every pass build; skipped if the pass is already drawing. */
  const warmPassStep: WarmStep = {
    bare: false,
    run(mounted) {
      if (!mounted) warmPassFrame();
    },
  };

  /** Build the pass if needed (does not mount it). */
  async function startPost(): Promise<boolean> {
    if (wormholePost) return true;
    try {
      makePost ??= (await import("../optics/wormhole-post"))
        .createWormholePost;
      if (wormholePost) return true; // built by a concurrent call
      wormholePost = makePost(renderer, scene, camera, invalidate);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `lens optics: the wormhole post pass failed to start — ${msg}`,
        err,
      );
      if (diag) diag.post = `FAILED: ${msg}`;
      return false;
    }
    queueWarm(warmPassStep);
    return true;
  }

  /** How long resizing must pause before the post pass is rebuilt. */
  const POST_RESIZE_SETTLE_MS = 250;

  /** Replace the post pass synchronously, so no frame renders without one. */
  function rebuildPost() {
    postStaleAt = 0;
    if (!wormholePost || !makePost) return;
    const stale = wormholePost;
    wormholePost = makePost(renderer, scene, camera, invalidate);
    stale.dispose();
    queueWarm(warmPassStep);
  }

  /** The ink material is warmed from the second frame on, never the first. */
  let firstFrameDone = false;
  let lastTickAt = performance.now();
  function tick() {
    if (controls && !storyCam) controls.update();

    const now = performance.now();
    const dt = Math.min(EASE_DT_MAX_MS, now - lastTickAt);
    lastTickAt = now;

    if (postStaleAt !== 0 && now - postStaleAt > POST_RESIZE_SETTLE_MS)
      rebuildPost();

    let easing = false;
    for (let i = 0; i < CHANNELS.length; i++) {
      const c = CHANNELS[i];
      const before = state[c];
      state[c] = easeStep(before, state[TARGET_KEYS[i]], dt);
      if (state[c] !== before) easing = true;
    }

    // idle: skip the frame
    if (!dirty && !easing) return;

    // Story callbacks write this frame's values before anything reads them.
    const storyP = clamp01(state.story);
    let live = false;
    if (storyMode)
      for (const cb of evaluateCbs) if (cb(storyP, dt)) live = true;
    dirty = live;

    if (storyMode || storyCam) {
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

    // Depth-fade planes follow the camera, the dolly and the widest spread.
    let spread = 0;
    for (const c of SPREAD_CHANNELS) if (state[c] > spread) spread = state[c];
    writeFadeBands(camera.position, dollyX, modelRadius, spread);

    // Both centre on this frame's camera, so the sky has no parallax.
    starfield?.sync(camera);
    if (postMounted) wormholePost?.sync(camera);

    driveChannels();
    cinematics.update(clamp01(state.explode), dt);

    if (visibilityDirty) {
      visibilityDirty = false;
      sweepVisibility(gltfScene, visibilityGates);
    }

    motionTrace?.record(camera, state, modelRadius);
    // Warm the ink material on the canvas (rechecked each frame: accessories
    // add new materials when they load).
    if (firstFrameDone && unified.needsWarm("canvas"))
      unified.warmBodyLooks("canvas", () =>
        drewScene(() => renderer.render(scene, camera)),
      );
    // Read once: syncBody and the render below must agree on the target.
    const viaPass = postMounted && wormholePost !== null ? wormholePost : null;
    // At most one warm step per tick, before this tick's render.
    const warm = warmQueue.step({
      mounted: viaPass !== null,
      bare: !postMounted && !glassTransmissive,
    });
    if (warm && warmQueue.length) dirty = true;
    unified.syncBody(viaPass ? "pass" : "canvas");
    if (viaPass) viaPass.render();
    else renderer.render(scene, camera);
    warm?.after?.();
    for (const cb of frameCbs) if (cb(project, dt)) dirty = true;

    if (!firstFrameDone) {
      firstFrameDone = true;
      performance.mark("lens:first-frame");
    }
  }

  // --- warm-up draws ---
  let warmedFly = false;

  /** True if `body` drew more than one draw call, i.e. the scene and not just
   *  the post pass's output quad. */
  function drewScene(body: () => void): boolean {
    const before = renderer.info.render.drawCalls;
    body();
    return renderer.info.render.drawCalls - before > 1;
  }

  /** Draw off screen as the fly-through does: starfield in the scene and
   *  through the post pass. `body` does the drawing. */
  function warmFlyDraw(body: (post: NonNullable<typeof wormholePost>) => void) {
    const sky = starfield;
    const post = wormholePost;
    if (!sky || !post) return;
    const bgSaved = scene.background ?? null;
    scene.background = sky.backdrop;
    scene.add(sky.object);
    try {
      drawDry(() => body(post));
    } finally {
      scene.remove(sky.object);
      scene.background = bgSaved;
    }
    dirty = true;
  }

  /** Fly-through warm step 1: the original materials on the canvas, then the
   *  transmissive glass through the post pass, all off screen in one tick. */
  function warmFlyFrame(spans: Record<string, GlassSpanMm>) {
    if (!starfield || !wormholePost) return;
    shading.withOriginals(() => renderer.render(scene, camera));
    // withOriginals, not setShading: a mode switch would replace the clones
    warmFlyDraw((post) =>
      shading.withOriginals(() => {
        enableGlassTransmissive(spans);
        try {
          post.render();
        } finally {
          disableGlassTransmissive(); // the clones stay cached
        }
      }),
    );
  }

  // Dev: scene internals on window for console poking.
  if (import.meta.env.DEV) {
    (window as unknown as Record<string, unknown>).__lensPerf = {
      renderer,
      scene,
      camera,
      state,
      model: gltfScene,
      invalidate,
      setBodyFade: applyBodyFade,
      setGlassFade: applyGlassFade,
      setRoomLight: applyRoomLight,
      setGlassGlint: applyGlassGlint,
    };
  }

  // Named so warmFly can call its own methods.
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
      // may run before the accessories load; applies the latest request then
      accessoriesReady.then(() => {
        showAccessory(group);
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
        // snap, not ease: easing back would replay the story on the way down
        state.story = 0;
        state.storyTarget = 0;
        camera.position.copy(orbitPose.pos);
        camera.up.copy(orbitPose.up);
        camera.fov = orbitPose.fov;
        camera.clearViewOffset();
        camera.updateProjectionMatrix();
        if (controls) {
          controls.enabled = true;
          controls.update();
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
    setGlassFade: applyGlassFade,
    setGlassElementFade: applyGlassElementFade,
    setGlassGlint: applyGlassGlint,
    worldAxialSpans(ids) {
      const out: Record<string, { x0: number; x1: number }> = {};
      for (const id of ids) {
        const root = node(id);
        if (!root) continue;
        root.updateWorldMatrix(true, true); // may run before any render
        const box = new THREE.Box3().setFromObject(root);
        if (box.isEmpty()) continue;
        out[id] = { x0: box.min.x, x1: box.max.x };
      }
      return out;
    },
    setBodyFade: applyBodyFade,
    setShellFade: applyShellFade,
    setInteriorFade: applyInteriorFade,
    setRoomLight: applyRoomLight,
    setModelOrientation(euler) {
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
      // a parent means the starfield is shown
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
            invalidate,
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
            invalidate,
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
            invalidate,
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
      // Apply the latest request, which may have changed during the import.
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
      // apply the latest request, which may have changed during the import
      postMounted = postWanted;
      if (diag) diag.post = postMounted ? "mounted" : "unmounted";
      dirty = true;
      return true;
    },
    async warmFly(spans) {
      // never during a fly-through, and only once
      if (warmedFly || glassTransmissive || postMounted) return false;
      warmedFly = true;
      // Build both, then hide them again before any frame renders.
      await handle.enableStarfield(true);
      await handle.enableStarfield(false);
      await handle.enableWormholePost(true);
      await handle.enableWormholePost(false);
      if (!starfield || !wormholePost) return false;
      // one step per tick
      queueWarm(
        bareStep(() => warmFlyFrame(spans)),
        // the ink material, then the original glass, through the post pass
        bareStep(() =>
          warmFlyDraw((post) =>
            unified.warmBodyLooks("pass", () => drewScene(() => post.render())),
          ),
        ),
        bareStep(() =>
          warmFlyDraw((post) => shading.withOriginals(() => post.render())),
        ),
      );
      return true;
    },
    warmDraw(objects, viaPass = false) {
      // queued for tick(), one draw per tick
      if (objects.length === 0) return;
      queueWarm(
        ...warmDrawSteps(objects.slice(), viaPass, {
          scene,
          render: () => renderer.render(scene, camera),
          dryPass: warmPassFrame,
        }),
      );
    },
    setInkMix(v) {
      unified.setInk(v);
      // keep currentShading true at the endpoints (swapShading checks it)
      if (v <= 0) currentShading = "realistic";
      else if (v >= 1) currentShading = "ink";
      dirty = true;
    },
    setShading: applyShading,
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
      starfield?.setTheme(l);
      // after shading.setTheme, which may have replaced the glass clones
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
  renderer.setAnimationLoop(tick);
  return handle;
}
