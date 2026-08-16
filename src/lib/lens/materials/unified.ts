import * as THREE from "three/webgpu";
import {
  uniform,
  float,
  mix,
  vec3,
  vec4,
  output,
  materialOpacity,
  dot,
  clamp,
  floor,
  normalView,
} from "three/tsl";
import {
  attachOps,
  attachOpsLine,
  opsEdgeGeometry,
  hasOpFrames,
  opsVariantKey,
} from "../ops/host";
import type { TslNode } from "../ops/algebra-tsl";
import { depthFadeFactor } from "./depthfade";
import { isOpticalGlass, isDecal } from "../core/parts";
import { clamp01 } from "../core/math";

// THE STORY'S TWO LOOKS, ON ONE MATERIAL: "realistic" (core/model.ts's PBR
// spec, re-classed to a node material so the op deform rides it) and "ink" (the
// technical-drawing fill + edge lines), blended by `uInk` on `outputNode`:
//
//     output  = mix(the PBR result, inkColor · celShade, uInk)
//     opacity = materialOpacity · mix(1, uInkFill · depthFade, uInk)
//
// Wearing a look is a uniform write — nothing is re-materialled, so the dive's
// hand-over ramps instead of cutting and a theme flip re-tints by uniform.
//
// TWO THINGS CANNOT BLEND:
//
//   - `transparent`, flipped once on the shared body materials at the uInk
//     0-edge. It picks the render list, and three copies the transmission
//     backdrop from the OPAQUE pass only, so a permanently-transparent body
//     would vanish inside the glass during the dive. core/scene's body fade
//     wants the same flag: `bodyFadeActive` + `writeTransparent` resolve both.
//   - GLASS. `material.transmission > 0` puts a mesh in the transmission pass
//     forever, so the elements keep two materials and swap between them at
//     GLASS_HANDOVER — the middle of the ramp, where both sides are at zero
//     opacity, which is what makes the cut invisible.
//
// THE INK TWIN. At uInk = 1 (the story's dominant state) the blend still emits
// the whole MeshStandard/Physical fragment path and multiplies it by zero, so
// the body swaps to a MeshBasicNodeMaterial built from the SAME builders
// (`inkOutput` / `bodyFillOpacity`, sharing the blend's `ink` uniform) with
// `lights = false`. Both sides are the same expression at uInk = 1, so the swap
// needs no cross-fade — and the edge is `=== 1`, never `> 1 − ε`.
//
// A TWIN IS NEVER WORN ON A PIPELINE THAT HAS NOT BEEN DRAWN. three keys a
// pipeline on the material class AND the render context, so each key's twin is
// warmed per `RenderCtx` (`warmBodyLooks`, core/scene's warm frames) and a key
// minted later — the accessories', a re-keyed mesh's — stays cold and keeps the
// blend until it gets its own warm frame (`needsWarm`).
//
// The bench looks (outline / riso / blueprint / …) are materials/shading.ts's.

/** 0 = the realistic PBR look, 1 = the ink drawing; between = a live blend of
 *  the two. DELIBERATELY PRIVATE: two booleans ride the ramp (the `transparent`
 *  flip at the 0-edge, the elements' swap at GLASS_HANDOVER — see the header),
 *  so `setInk` — reachable as `SceneHandle.setInkMix`, which story/fly.ts ramps
 *  across the dive's edges — is the only sanctioned writer. */
const uInk = uniform(0);

/** Where the elements hand their two materials over: the MIDDLE of the ramp,
 *  which is where both the realistic glass and the ink fill are at zero (the
 *  header's cross-fade). Being deep inside the ramp also puts the swap further
 *  from the fly span's edges than the old uInk > 0 did, and story/fly.ts's
 *  hysteresis law only gets safer for it.
 *
 *  EXPORTED as a READING, not a knob: it is the uInk value at which the elements
 *  stop wearing a `transmission: 1` material, i.e. the exact edge at which
 *  three's per-frame framebuffer copy for the transmission pass switches off.
 *  story/cost.ts's `glassTx` column is that edge and may not spell it twice. */
export const GLASS_HANDOVER = 0.5;

/** The elements' cross-fade, as the two halves of the ramp: `inkBottomHalf`
 *  takes the realistic glass 1 → 0 over uInk [0, GLASS_HANDOVER] and
 *  `inkTopHalf` takes the ink fill 0 → 1 over [GLASS_HANDOVER, 1]. Both are 0
 *  AT the hand-over, which is what makes the material swap invisible.
 *
 *  SQUARE-ROOTED, the equal-power crossfade's shape, because the two halves are
 *  SEQUENTIAL (one mesh, one material — they cannot overlap, so no shaping can
 *  make their sum constant): `sqrt` rises steeply off zero, which is what keeps
 *  the elements PRESENT right up to the hand-over. A linear pair holds them
 *  under 10% opacity for a tenth of the ramp either side — long enough to read
 *  as missing; sqrt puts them at ~32% over the same span and leaves the trough
 *  only at the hand-over frame itself. (Both shapes measure the same at the swap
 *  frame — see the header — so this is chosen for the approach, not the seam.)
 *  Fresh nodes per material, like celShade. */
const inkBottomHalf = () =>
  clamp(float(1).sub((uInk as any).div(GLASS_HANDOVER)), 0, 1).sqrt() as any;
const inkTopHalf = () =>
  clamp(
    (uInk as any).sub(GLASS_HANDOVER).div(1 - GLASS_HANDOVER),
    0,
    1,
  ).sqrt() as any;

/** Ink fill opacity, 0 = pure line drawing (edge lines only) → 1 = solid fills.
 *  The scroll hero drives this so the intro reads as a blueprint that fills in. */
export const uInkFill = uniform(1);

/** THE `transparent` LAW for the shared body materials, as one expression: the
 *  body is transparent while ANY ink shows (its fills are translucent) OR while
 *  core/scene's body fade is under 1 — and opaque only when NEITHER wants it,
 *  which is the state the dive needs (three copies the transmission backdrop
 *  from the opaque pass). Two callers, one flag: see `writeTransparent`.
 *  Exported for __tests__/unified.test.ts; the controller is its only caller. */
export const bodyTransparent = (inkOn: boolean, fadeOn: boolean) =>
  inkOn || fadeOn;

/** THE 1-EDGE, as the twin's swap reads it. All three are LIVE: `resolveBody`
 *  takes them off the uniforms and the flag every time it runs, including the
 *  runs `setInk` and `bodyFadeActive` make inside their own synchronous call. */
export interface InkEdge {
  /** setInk's live blend (uInk). The twin is worn at EXACTLY 1. */
  inkMix: number;
  /** core/scene's body fade is under 1 (materialOpacity is not 1). */
  fadeOn: boolean;
}

/** IS THE INK TWIN THE WHOLE DRAWING? At uInk = 1 the blend's output is its ink
 *  term alone, so the twin is exact — but only while `materialOpacity` is the
 *  material's shipped 1: under a body fade the fade OWNS that number and
 *  captures it per instance (core/scene applyBodyFade), so a swap under it
 *  would hand the mesh a material the capture never saw. */
export const inkTwinWorn = (e: InkEdge): boolean => e.inkMix === 1 && !e.fadeOn;

// CEL SHADE: quantized N·L against a fixed key light — three flat bands that
// give the unlit ink fills FORM (pop) without abandoning the blueprint look.
// Uses the transformed normal, so op-deformed pieces band correctly as they
// peel and wrap. Fresh node per material. (materials/shading.ts's bench looks
// build the same drawing under a different palette, so they share this.)
export const CEL_LIGHT = new THREE.Vector3(0.45, 0.8, 0.55).normalize();
export const celShade = () => {
  const ndl = dot(
    normalView as any,
    vec3(CEL_LIGHT.x, CEL_LIGHT.y, CEL_LIGHT.z) as any,
  )
    .mul(0.5)
    .add(0.5) as any;
  const band = clamp(floor(ndl.mul(3.0)), 0.0, 2.0).div(2.0) as any;
  return float(0.78).add(band.mul(0.38)) as any; // 0.78 · 0.97 · 1.16
};

// THE INK PALETTE — flat fill colours keyed by part name, one variant per SITE
// THEME, plus the edge-line colour pairs. Dark theme: the body shells sit
// near-black so the bright edge lines carry the drawing. Light theme: the
// relationship INVERTS — paper-light shells, dark sepia line-work
// (pencil-on-paper), same accent logic. Accents stay on the MECHANISM only:
// amber focus drivetrain (motor/screw/rods — matches the site accent and the
// refraction rays), brass contacts, blued-steel iris, slate grips. The GLASS is
// one uniform green — every element the same (owner: no per-element colour
// coding; the focusing element reads via its amber drivetrain instead).
//
// Both themes take the SAME branch for a name, which is what lets one material
// serve that name in either: the two hexes are cached as a pair and a theme
// flip writes the other one into the material's colour uniform.
function inkFill(name: string, light: boolean): number {
  if (light) {
    if (isOpticalGlass(name)) return 0x6fa863; // deeper mint — a 0.45-opacity fill must read on paper
    if (/^Iris_Blade/.test(name)) return 0x5b6478;
    if (isDecal(name)) return 0x3f3a2f; // printed text goes DARK on light shells
    if (/^Mount_Contacts/.test(name)) return 0xb08428;
    if (/^Mount_/.test(name)) return 0x7c766a;
    if (/^Focus_/.test(name)) return 0xa8672e;
    if (/^PCB_/.test(name)) return 0x5d7a48;
    if (/Ring_/.test(name)) return 0x4a4f5e; // rubber grips stay dark — real rubber is
    if (/Band_Mid|Barrel_Base|Chassis/.test(name)) return 0xe3ddcc; // gloss body
    return 0xece6d6; // matte body — paper-light so the dark outlines pop
  }
  if (isOpticalGlass(name)) return 0x9ccb92; // mint-green glass — uniform across elements
  if (/^Iris_Blade/.test(name)) return 0x4b5364; // blued-steel aperture blades
  if (isDecal(name)) return 0xefe8d4; // white printed text
  if (/^Mount_Contacts/.test(name)) return 0xd9a852; // bright brass contacts
  if (/^Mount_/.test(name)) return 0x9a9482; // chrome / metal
  if (/^Focus_/.test(name)) return 0xc5813f; // focus motor/screw/rods — amber metal
  if (/^PCB_/.test(name)) return 0x6d8a55; // circuit-board green
  if (/Ring_/.test(name)) return 0x343846; // rubber grip rings — dark slate
  if (/Band_Mid|Barrel_Base|Chassis/.test(name)) return 0x2c2720; // gloss body
  return 0x211d16; // matte body — near-black so the outlines pop
}

/** Ink edge-line colours: glass gets the green accent; the body lines are
 *  bright warm white on the dark stage, dark sepia ink on the light one. The
 *  bench's "flat" palette copies this pair — the outline language is the house
 *  one. */
const INK_EDGE = {
  body: { dark: 0xe4dbc4, light: 0x2f2a20 },
  glass: { dark: 0xc9e6bb, light: 0x3f6b39 },
};

/** EdgesGeometry crease angle for the ink line-work (a bench palette may pick
 *  its own — materials/shading.ts).
 *
 *  EXPORTED as a READING, like GLASS_HANDOVER: the ink pass's vertex count is a
 *  function of this angle, and story/cost.ts's `kLineV` column is measured by
 *  cutting EdgesGeometry at it. The generator may not spell the angle twice. */
export const EDGE_THRESHOLD_DEG = 24;

/** DOES THIS MESH WEAR AN INK EDGE-LINE — `addLine`'s own skip, as a predicate
 *  on the name, so the cost model can select the same set instead of restating
 *  the rule (story/cost.ts `PartRow.edgeLine`). A printed decal's outline is a
 *  rectangle, so it gets none. */
export const hasInkEdgeLine = (name: string): boolean => !isDecal(name);

/** what one mesh wears: for a GLASS mesh the merged material plus the ink fill
 *  that cannot merge with transmission (see the header); for a BODY mesh the
 *  three materials of its cache key, which carry their own blend. Exactly one
 *  of `mat` / `body` is set. */
interface Worn {
  mat?: THREE.Material;
  ink?: THREE.Material;
  body?: BodyMats;
}

/** THE TWO RENDER CONTEXTS the story draws the body in — the canvas, and the
 *  dive's wormhole pass (core/scene's `wormholePost`, which renders the scene
 *  into its own target). three keys a pipeline on the context as well as on the
 *  shader and `transparent`, so they are warmed, and tracked, SEPARATELY. */
export type RenderCtx = "canvas" | "pass";

/** THE BODY'S MATERIALS for one cache key. The twin is built on the first frame
 *  that reaches the 1-edge, not at load — a page that only ever wears realistic
 *  must not pay for the graph. */
interface BodyMats {
  /** the merged blend — every uInk below 1, and every frame of a body fade */
  blend: THREE.Material;
  /** the 1-edge twin. Undefined until it is built. */
  ink?: THREE.Material;
  /** true once this key's twin has been drawn off-screen in that context — the
   *  only thing that lets `current` hand it to a mesh there. Per key because
   *  `integrate` mints materials long after the first warm frame; per context
   *  because a pipeline compiled for the canvas is not one the pass can use. */
  warm: Record<RenderCtx, boolean>;
  /** what the lazy build needs: the mesh the key was resolved from, its frame
   *  state, and the SHARED ink colour uniform. */
  seed: { mesh: THREE.Mesh; framed: boolean; ink: TslNode };
}

/** which of `BodyMats` the body is wearing right now */
type BodyLook = "blend" | "ink";

/** one thing a theme flip re-tints, and the pair it flips between */
interface Tint {
  write(hex: number): void;
  dark: number;
  light: number;
}

export interface UnifiedLook {
  /** Fold meshes that arrive after creation (the background accessories) into
   *  the merged look. Also RE-KEYS a mesh whose op frame landed late, so an
   *  accessory measured after this ran still ends up on a deforming material. */
  integrate(root: THREE.Object3D): void;
  /** Put the merged materials back on every mesh — the realistic/ink arm of
   *  materials/shading.ts's swapper, after a bench look wore something else. */
  wear(): void;
  /** Blend the pair. The ramp's two edges flip what cannot blend (the header);
   *  everything else is one uniform write. */
  setInk(v: number): void;
  /** Declare that core/scene's body fade wants the shared body materials
   *  transparent (o < 1). THE SECOND INPUT TO ONE FLAG — see `writeTransparent`:
   *  `transparent` has a single owner, and this is how the other caller moves
   *  it. */
  bodyFadeActive(on: boolean): void;
  /** Whether `m`'s `transparent` is this controller's to write. core/scene's
   *  body fade covers materials this does not own (a bench look's fills, its
   *  line-work) and writes those itself. */
  ownsTransparent(m: THREE.Material): boolean;
  /** the live blend, for a caller that has to put it back (the warm-up frame) */
  ink(): number;
  /** THE 1-EDGE, RESOLVED ONCE PER FRAME, from core/scene's tick immediately
   *  before the render. `ctx` is the context THIS frame renders in — a twin
   *  only goes on if its key has been warmed in that one. */
  syncBody(ctx: RenderCtx): void;
  /** DRAW THE TWIN ONCE, off-screen, and only then allow it in `ctx`
   *  (core/scene's warm-up frames). `cb` renders the scene in the context being
   *  warmed — the canvas, or the dive's wormhole pass — and this wears the twin
   *  across it and puts back exactly what was on. */
  warmBodyLooks(ctx: RenderCtx, cb: () => void): void;
  /** DOES ANY BODY KEY STILL OWE A WARM FRAME IN `ctx`? Asked per tick rather
   *  than flagged once: `integrate` mints materials after the first warm frame
   *  has run, and those keys need one of their own. */
  needsWarm(ctx: RenderCtx): boolean;
  /** Re-tint the ink for the site theme. A VALUE WRITE — no rebuild. */
  setTheme(light: boolean): void;
  dispose(): void;
}

/** THE INK EDGE-LINES' OPACITY GRAPH. Its own function so the law in it can be
 *  tested without a renderer (`__tests__/unified.test.ts`, as `bodyTransparent`
 *  is).
 *
 *  THE LINES ARE THE INK: they ride the blend and simply are not there in the
 *  realistic look. The BODY's lines ride the whole ramp (`uInk`) — its fill
 *  mixes on the same factor, so line and fill arrive together at every point of
 *  the blend. The GLASS's lines ride the ramp's TOP HALF instead, the same
 *  envelope as the mint fill they outline (`glassInkOpacity`): an outline on
 *  the whole ramp appears half a hand-over before the fill it belongs to, and
 *  during the story's rewrap return the pieces are still wrap-displaced — the
 *  owner watched a lone glass outline "jut further out right before it
 *  appears". Outline and fill now share one edge in BOTH directions; the cost
 *  is that the elements draw nothing at the hand-over frame itself, where the
 *  lines used to be the one thing carrying them — both fills are at zero there
 *  by design, and the sqrt shapes keep the empty stretch to a frame or two.
 *
 *  …AND THEY RIDE THE BODY FADE, through `materialOpacity` — the same input the
 *  merged fill reads. core/scene's applyBodyFade writes `opacity` on these
 *  instances (they are in its `bodyMaterials()`, deliberately: "a body that
 *  fades while its outline stays put would read as a wireframe ghost"), and
 *  without this factor that write went nowhere. It was invisible over the dive,
 *  where `uInk` is 0 anyway; over the peel/cards span, where the ink is FULLY
 *  on and the story now fades the lens out under the card shell, a half-faded
 *  body kept a full-strength wireframe of itself. Inert at opacity 1 — the only
 *  frames this changes are the ones a fade is running. */
export const inkLineOpacity = (glass: boolean, opsPos?: TslNode): TslNode =>
  float(glass ? 0.7 : 0.9)
    .mul(depthFadeFactor(opsPos))
    .mul(materialOpacity)
    .mul(glass ? inkTopHalf() : (uInk as any));

/** THE GLASS ELEMENTS' TWO OPACITY GRAPHS, extracted for inkLineOpacity's
 *  reason: a glass mesh wears one of three materials in the story
 *  (`mergedGlass`, `glassInkMaterial`, its edge lines), the peel/cards crossfade
 *  now takes the glass with the body, and `materialOpacity` is the only way
 *  core/scene's applyBodyFade reaches a NodeMaterial's opacity at all — an
 *  opacityNode REPLACES the scalar. Miss the factor on any one of the three and
 *  a column of mint elements is left floating where the lens used to be, in one
 *  look only, in a browser only. __tests__/unified.test.ts walks all three.
 *
 *  `fade` is the depth-fade factor, which needs the material to attach to and so
 *  cannot be built here; the graph is identical with and without it. */
export const glassFillOpacity = (): TslNode =>
  materialOpacity.mul(inkBottomHalf());
export const glassInkOpacity = (fade?: TslNode): TslNode =>
  float(0.45)
    .mul(fade ?? float(1))
    .mul(materialOpacity)
    .mul(inkTopHalf());

/** THE BODY'S TWO GRAPHS, EXTRACTED SO THE TWIN CANNOT DRIFT FROM THE BLEND.
 *
 *  The merged material and its 1-edge twin (the header) are only swappable
 *  because they are the SAME EXPRESSION — so they are built by the same two
 *  functions rather than by a copy of one in the other, and
 *  __tests__/unified.test.ts walks both graphs to keep it that way.
 *
 *  `inkOutput` keeps the `mix` even on the twin, which never renders at any
 *  other blend: at uInk = 1 the PBR side is multiplied by zero, so the two
 *  materials run the same arithmetic on the same numbers and only the DEAD
 *  operand differs. Writing the twin's output as the ink term alone would save
 *  three ALU and give up that guarantee. `ink` is the SHARED colour uniform —
 *  one theme write re-tints the pair.
 *
 *  `bodyFillOpacity` is `materialOpacity` (core/scene's body fade reaches a
 *  NodeMaterial no other way — see the merged material) times the ink's own
 *  dissolve, which is 1 at the realistic end and `uInkFill · depthFade` at the
 *
 *  `fade` is the depth-fade factor riding the material's own op position; it
 *  cannot be built here (it needs the material to attach to). */
export const inkOutput = (ink: TslNode): TslNode =>
  vec4(
    mix((output as any).rgb, ink.mul(celShade()), uInk as any),
    (output as any).a,
  ) as unknown as TslNode;
export const bodyFillOpacity = (fade: TslNode): TslNode =>
  materialOpacity.mul(
    mix(float(1), uInkFill.mul(fade), uInk as any) as any,
  ) as unknown as TslNode;

/**
 * Build the merged material for every mesh under `root` and wear it. This is
 * what ops/host's plain `applyOps` used to do for the model: the same deform
 * attach and the same ONE material per source material × graph variant, plus
 * the ink half of the blend.
 *
 * Runs in core/scene's prepareModelMaterials chain AFTER deriveFrames /
 * tagMechanismSpins (the deform graph reads what those write) and BEFORE
 * createShading, which is handed this controller.
 */
export function createUnified(root: THREE.Object3D): UnifiedLook {
  // site theme — the ink palette flips between paper-light and stage-dark.
  // Detected here so both pages get the right one without wiring; toggles
  // arrive via setTheme (the pages own the observer).
  let light = !document.documentElement.classList.contains("dark");
  let inkAmount = 0;
  /** the boolean half of the blend: true whenever ANY ink is showing */
  let inkOn = false;
  /** the elements' own edge — whether they are wearing the ink fill yet
   *  (GLASS_HANDOVER), which is a different point on the ramp from `inkOn` */
  let glassInkOn = false;
  /** core/scene's body fade is under 1 (bodyFadeActive) — the second input to
   *  `transparent`. */
  let fadeOn = false;
  let linesBuilt = false;
  /** which of the body's three materials every body mesh is wearing (the
   *  header's 1-edge). Moved ONLY by `resolveBody`. */
  let bodyLook: BodyLook = "blend";
  /** the context the frame being prepared renders in, handed to `syncBody` by
   *  core/scene's tick — an input to what a mesh wears, because a twin is only
   *  wearable where its pipelines exist (the header). */
  let bodyCtx: RenderCtx = "canvas";
  /** the (look, context) every body mesh is currently DRESSED for, or "" to
   *  force the next `resolveBody` to dress them again — which is what a warm
   *  frame does, having just made twins wearable that nothing is wearing. */
  let dressed = "";
  /** how many body keys still owe a warm frame in each context (`needsWarm`).
   *  Counted rather than flagged so `integrate`'s late materials re-arm the
   *  warm by themselves. */
  const coldKeys: Record<RenderCtx, number> = { canvas: 0, pass: 0 };
  let twinsBuilt = false;
  // THE UNIFORMS ARE MODULE STATE (one lens scene per document, core/scene's
  // law) but a controller is not: a page that destroys one and builds another
  // would otherwise open at the previous scene's blend, before any driver
  // writes it. Reset them to the look this controller starts in.
  uInk.value = 0;
  uInkFill.value = 1;

  const worn = new Map<THREE.Mesh, Worn>();
  /** the source material each mesh arrived wearing (core/model.ts's shared spec
   *  instance). The merged material replaces it, so it is remembered here for a
   *  re-key. */
  const source = new Map<THREE.Mesh, THREE.Material>();
  /** the cache key each mesh resolved to, so integrate() can tell a mesh that
   *  merely re-appeared from one whose VARIANT changed. */
  const keyed = new Map<THREE.Mesh, string>();

  /** SHARED materials: one per source material × ink colour × graph variant,
   *  not one per mesh (~200 node graphs was the largest chunk of
   *  time-to-first-frame this file's ancestor ever measured). */
  const merged = new Map<string, THREE.Material>();
  /** the BODY's own cache — three materials per key, not one (the 1-edge twin;
   *  `merged` above is the glass's half of the same law). */
  const bodyMats = new Map<string, BodyMats>();
  const glassInk = new Map<string, THREE.Material>();
  const lineMats = new Map<string, THREE.LineBasicNodeMaterial>();
  /** every material whose `transparent` flips at the 0-edge (the body's) */
  const flips = new Set<THREE.Material>();
  /** every 1-edge twin, both variants — the set `ownsTransparent` adds to
   *  `flips` so core/scene's body fade leaves their flag alone */
  const twins = new Set<THREE.Material>();
  const tints: Tint[] = [];
  const inkLines: THREE.LineSegments[] = [];
  const edgeGeo = new Map<number, THREE.BufferGeometry>();
  const created = new Set<THREE.Material>();

  const track = <T extends THREE.Material>(m: T): T => {
    created.add(m);
    return m;
  };

  /** The target class tracks the SOURCE: copying a MeshPhysicalMaterial into a
   *  MeshStandardNodeMaterial silently DROPS transmission/ior/iridescence
   *  (NodeMaterial.copy only copies properties the target already declares). */
  function reclass(src: THREE.Material): THREE.NodeMaterial {
    const m = (src as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial
      ? new THREE.MeshPhysicalNodeMaterial()
      : new THREE.MeshStandardNodeMaterial();
    m.copy(src as THREE.MeshStandardMaterial);
    return m as unknown as THREE.NodeMaterial;
  }

  /** Attach the deform and hand back the depth fade riding the SAME position
   *  node: the framed pieces move in-shader, so the fade fed positionView would
   *  miss it, and building a second position graph would double the deform. */
  const opsFade = (
    mat: THREE.NodeMaterial,
    mesh: THREE.Mesh,
    framed: boolean,
  ) => depthFadeFactor(framed ? attachOps(mat, mesh) : undefined);

  /** THE RENDER STATE BOTH BODY MATERIALS WEAR, written once so the twin cannot
   *  drift from the blend on a flag that decides pixels. Everything here is
   *  identical on the pair; `transparent` is the one thing that is not, and it
   *  is the variant's whole definition. */
  function bodyRenderState(m: THREE.Material) {
    // Push the fill's depth back a hair so the edge lines (which share the
    // surface's exact vertices) always win the depth test — without this the
    // lines z-fight the fill and FLICKER whenever the model moves. Left ON in
    // both looks: with no lines drawn it is inert, and one bias across the
    // whole body changes nothing the realistic look can see.
    m.polygonOffset = true;
    m.polygonOffsetFactor = 1;
    m.polygonOffsetUnits = 1;
    // DISCARD fully-faded fragments: a transparent fill at opacity ~0 still
    // writes depth, so a depth-faded wedge would invisibly hard-clip everything
    // behind its silhouette. Also left on — at realistic's opacity 1 nothing is
    // ever discarded, and `alphaTest` is a GRAPH branch, so flipping it would
    // cost a rebuild where the flag below costs only a pipeline.
    m.alphaTest = 0.02;
  }

  function mergedMaterial(mesh: THREE.Mesh, key: string, framed: boolean) {
    const hit = bodyMats.get(key);
    if (hit) return hit;
    const m = reclass(source.get(mesh)!);
    const fade = opsFade(m, mesh, framed);
    const dark = inkFill(mesh.name, false);
    const lit = inkFill(mesh.name, true);
    const ink = uniform(new THREE.Color(light ? lit : dark));
    m.outputNode = inkOutput(ink as unknown as TslNode) as any;
    // materialOpacity keeps `material.opacity` LIVE through the graph: the
    // transmissive glass clones and core/scene's setBodyFade both write it, and
    // an opacityNode that ignored it would silently break them.
    //
    // THE BODY FADE IS THE OTHER HALF-OWNER OF THIS MATERIAL. It writes
    // `opacity` here (captured and restored per instance, core/scene
    // applyBodyFade) and needs `transparent` for as long as it does — the same
    // flag setInk's 0-edge moves, on the same shared instance. It therefore
    // does NOT write the flag: it declares itself through `bodyFadeActive` and
    // `writeTransparent` resolves both inputs. `ownsTransparent` is how it
    // knows to leave these alone (the bench looks' materials are its own).
    m.opacityNode = bodyFillOpacity(fade) as any;
    bodyRenderState(m as unknown as THREE.Material);
    // THE ONE FLAG THAT MOVES (writeTransparent). A material built while the
    // ink is already on — or while the body fade is running — has to arrive
    // matching it, so it takes the resolver's value, not `inkOn`.
    m.transparent = bodyTransparent(inkOn, fadeOn);
    const mat = m as unknown as THREE.Material;
    const rec: BodyMats = {
      blend: mat,
      // BORN COLD, whenever it is born. A key minted after the warm frames have
      // run — the accessories', a late-framed mesh's — owes its own warm in
      // both contexts before either twin may be worn, and this is what tells
      // core/scene it is owed (`needsWarm`).
      warm: { canvas: false, pass: false },
      seed: { mesh, framed, ink: ink as unknown as TslNode },
    };
    coldKeys.canvas++;
    coldKeys.pass++;
    bodyMats.set(key, rec);
    flips.add(mat);
    tints.push({
      write: (h) => (ink.value as THREE.Color).setHex(h),
      dark,
      light: lit,
    });
    track(mat);
    if (twinsBuilt) buildTwins(rec);
    return rec;
  }

  /** THE 1-EDGE TWIN. Everything the blend decides about the fragment is
   *  rebuilt from the SAME builders — the deform attach, `inkOutput` on the
   *  SAME `ink` uniform, `bodyFillOpacity` on this material's own depth fade,
   *  the shared render state — and everything else is COPIED OFF THE BLEND, so
   *  `side`, `depthWrite/Test`, `blending`, `alphaTest` and the rest cannot go
   *  stale against the pair they mirror.
   *
   *  `lights = false` is what takes the lighting context, the irradiance and
   *  the environment out of the fragment shader. The setupNormal override keeps
   *  the DRAWING: MeshBasicNodeMaterial would replace the material's normal
   *  with the geometric one and band an op-deformed piece by its rest normal. */
  function twinFor(rec: BodyMats): THREE.Material {
    const { mesh, framed, ink } = rec.seed;
    const m = new THREE.MeshBasicNodeMaterial();
    m.copy(rec.blend as THREE.MeshBasicMaterial);
    // `opacity` off the SOURCE, not the blend's live value: the build is lazy,
    // so it can land while core/scene's body fade is holding that number down,
    // and the fade restores to the material it captured — never this one.
    m.opacity = source.get(mesh)!.opacity;
    m.lights = false;
    (
      m as unknown as { setupNormal: THREE.NodeMaterial["setupNormal"] }
    ).setupNormal = THREE.NodeMaterial.prototype.setupNormal;
    const fade = opsFade(m as unknown as THREE.NodeMaterial, mesh, framed);
    m.outputNode = inkOutput(ink) as any;
    m.opacityNode = bodyFillOpacity(fade) as any;
    bodyRenderState(m as unknown as THREE.Material);
    m.transparent = true;
    const mat = m as unknown as THREE.Material;
    twins.add(mat);
    return track(mat);
  }

  function buildTwins(rec: BodyMats) {
    if (!rec.ink) rec.ink = twinFor(rec);
  }

  function ensureTwins() {
    if (twinsBuilt) return;
    twinsBuilt = true;
    for (const rec of bodyMats.values()) buildTwins(rec);
  }

  /** The elements' ink fill — flat, uniform mint, NOT cel-banded (the drawing
   *  keeps the glass clean) and never dissolved by uInkFill: glass stays filled
   *  while the body fades to wireframe. The SECOND HALF of the elements'
   *  cross-fade (the header): 0 at the hand-over, full ink at the ramp's end. */
  function glassInkMaterial(mesh: THREE.Mesh, key: string, framed: boolean) {
    const hit = glassInk.get(key);
    if (hit) return hit;
    const dark = inkFill(mesh.name, false);
    const lit = inkFill(mesh.name, true);
    const m = new THREE.MeshBasicNodeMaterial();
    m.color.setHex(light ? lit : dark);
    const fade = opsFade(m as unknown as THREE.NodeMaterial, mesh, framed);
    // × the ramp's TOP HALF, so this material is at exactly 0 on the frame the
    // swap puts it on (uInk = GLASS_HANDOVER) and reaches its full 45% at the
    // end of the ramp. Its partner (mergedGlass) is at 0 there too. And ×
    // `materialOpacity`, for the edge lines' reason — glassInkOpacity carries
    // both, and the law test walks it.
    m.opacityNode = glassInkOpacity(fade) as any;
    m.transparent = true;
    m.polygonOffset = true;
    m.polygonOffsetFactor = 1;
    m.polygonOffsetUnits = 1;
    m.alphaTest = 0.02;
    const mat = m as unknown as THREE.Material;
    glassInk.set(key, mat);
    tints.push({ write: (h) => m.color.setHex(h), dark, light: lit });
    return track(mat);
  }

  const edgeTint = (glass: boolean) => (glass ? INK_EDGE.glass : INK_EDGE.body);

  function lineMaterial(mesh: THREE.Mesh, glass: boolean, framed: boolean) {
    const key = `${glass}|${framed}|${opsVariantKey(mesh)}`;
    const hit = lineMats.get(key);
    if (hit) return hit;
    const m = new THREE.LineBasicNodeMaterial();
    const pair = edgeTint(glass);
    m.color.setHex(light ? pair.light : pair.dark);
    m.transparent = true;
    // Attach the deform first, then share its position node with the fade.
    const opsPos = framed
      ? attachOpsLine(m as unknown as THREE.NodeMaterial, mesh)
      : undefined;
    m.opacityNode = inkLineOpacity(glass, opsPos);
    m.alphaTest = 0.02; // faded lines must not depth-clip either
    lineMats.set(key, m);
    tints.push({
      write: (h) => m.color.setHex(h),
      dark: pair.dark,
      light: pair.light,
    });
    track(m);
    return m;
  }

  /** WHAT THIS MESH WEARS RIGHT NOW — the glass's own edge (GLASS_HANDOVER) or
   *  the body's (the 1-edge twin). A pure read of the resolved state: both
   *  edges are moved by their writers, never by this.
   *
   *  THE WARM GATE LIVES HERE, per key and per context, so it cannot be
   *  by-passed by any path that dresses a mesh — a key whose twins have not
   *  been drawn in the context this frame renders in gets the blend material,
   *  whatever the 1-edge says (the header). */
  const current = (mesh: THREE.Mesh) => {
    const w = worn.get(mesh)!;
    const b = w.body;
    if (b) {
      if (bodyLook === "ink" && b.warm[bodyCtx] && b.ink) return b.ink;
      return b.blend;
    }
    return glassInkOn && w.ink ? w.ink : w.mat!;
  };

  /** Resolve what `mesh` should wear — building the material on first demand —
   *  and put it on. A no-op once the mesh's key is settled. */
  function style(mesh: THREE.Mesh) {
    const src = source.get(mesh)!;
    const name = mesh.name;
    const glass = isOpticalGlass(name);
    const framed = hasOpFrames(mesh);
    // A mesh whose deform graph VARIES (a mechanism spin pivot, a decal's
    // shrink-wrap binding) can only share a material with meshes that vary the
    // same way — hence the variant in the key (ops/host.ts opsVariantKey).
    const key = `${src.uuid}|${inkFill(name, false)}|${inkFill(name, true)}|${glass}|${framed}|${opsVariantKey(mesh)}`;
    if (keyed.get(mesh) === key) return;
    keyed.set(mesh, key);
    // In-shader displacement invalidates the mesh's rest-pose bounds, so
    // stale-bounds frustum culling would pop deformed pieces out.
    if (framed) mesh.frustumCulled = false;
    if (glass)
      worn.set(mesh, {
        mat: mergedGlass(mesh, key, framed),
        ink: glassInkMaterial(mesh, key, framed),
      });
    else worn.set(mesh, { body: mergedMaterial(mesh, key, framed) });
    mesh.material = current(mesh);
  }

  /** The elements' realistic material: the plain op material — the dive's
   *  transmissive clones are made from it and every law they carry (core/scene
   *  enableGlassTransmissive) still holds — plus the FIRST HALF of the
   *  elements' cross-fade (the header). */
  function mergedGlass(mesh: THREE.Mesh, key: string, framed: boolean) {
    const hit = merged.get(key);
    if (hit) return hit;
    const m = reclass(source.get(mesh)!);
    if (framed) attachOps(m, mesh);
    // materialOpacity first, for mergedMaterial's reason (the dive's clones
    // write `opacity` and the passage fade depends on it), then out over the
    // ramp's bottom half. The clones inherit this node — harmless: the dive
    // runs at uInk 0, where the factor is exactly 1.
    m.opacityNode = glassFillOpacity() as any;
    // AND THE FLAG THE FADE NEEDS, once, at build. Not flipped with the body's
    // (`flips`): three keys a pipeline on `transparent`, so a flip at the ramp's
    // 0-edge would compile a second glass pipeline on the first frame of the
    // cross-fade — the one frame that must not stall. It costs nothing to leave
    // on, for the reason core/scene's own clones are marked once and never
    // flipped (glassCloneFor): a transmissive material is already drawn in the
    // transmission pass, and at opacity 1 the blend is the identity.
    m.transparent = true;
    const mat = m as unknown as THREE.Material;
    merged.set(key, mat);
    return track(mat);
  }

  /** ONE mesh's edge lines. The geometry is cached per mesh: it is a pure
   *  function of the (immutable) source geometry, and rebuilding ~260
   *  EdgesGeometry plus the frame-attribute copy is the ink look's expensive
   *  half. */
  function addLine(mesh: THREE.Mesh) {
    if (!hasInkEdgeLine(mesh.name)) return; // a decal's outline is a rectangle
    const framed = hasOpFrames(mesh);
    let geo = edgeGeo.get(mesh.id);
    if (!geo) {
      geo = framed
        ? opsEdgeGeometry(mesh.geometry, EDGE_THRESHOLD_DEG)
        : new THREE.EdgesGeometry(mesh.geometry, EDGE_THRESHOLD_DEG);
      edgeGeo.set(mesh.id, geo);
    }
    const line = new THREE.LineSegments(
      geo,
      lineMaterial(mesh, isOpticalGlass(mesh.name), framed),
    );
    line.raycast = () => {}; // extras are never pickable
    line.userData.lensExtra = true; // …and never a piece of the model (integrate)
    line.visible = inkOn;
    mesh.add(line);
    inkLines.push(line);
  }

  /** Built on the first blend that shows ink, not at load: the edge geometry is
   *  the costliest thing in here, and a page that only ever wears realistic (a
   *  bench look, a demo) must not pay for it. Never taken down again — the
   *  realistic look simply does not draw them. */
  function ensureLines() {
    if (linesBuilt) return;
    linesBuilt = true;
    for (const mesh of worn.keys()) addLine(mesh);
  }

  /** Take OUR line-work off `mesh` — the ones in `inkLines`, never every
   *  LineSegments child: a bench technical look parents its own edge lines on
   *  the same meshes (materials/shading.ts `attach`), and that build owns them. */
  function dropLines(mesh: THREE.Mesh) {
    for (const c of [...mesh.children]) {
      const i = c instanceof THREE.LineSegments ? inkLines.indexOf(c) : -1;
      if (i < 0) continue;
      c.removeFromParent();
      inkLines.splice(i, 1);
    }
    edgeGeo.get(mesh.id)?.dispose();
    edgeGeo.delete(mesh.id);
  }

  function integrate(scope: THREE.Object3D) {
    scope.traverse((o) => {
      // A LOOK'S OWN EXTRA, not a piece of the lens (a bench look's inverted
      // hull). NOT a parent-is-a-Mesh test: `Mount_Contacts` is authored as a
      // child of the mesh it sits on, and it is as much of the model as
      // anything else.
      if (!(o instanceof THREE.Mesh) || o.userData.lensExtra) return;
      const fresh = !source.has(o);
      if (fresh) source.set(o, o.material as THREE.Material);
      const before = keyed.get(o);
      style(o);
      // A LATE FRAME (an accessory measured after this controller was built)
      // moves the key, and that mesh's line-work has to be re-cut against the
      // deforming geometry it just gained.
      if (linesBuilt && before !== keyed.get(o)) {
        if (!fresh) dropLines(o);
        addLine(o);
      }
    });
  }

  function wear() {
    for (const mesh of worn.keys()) mesh.material = current(mesh);
  }

  /** THE ONE PLACE `transparent` IS WRITTEN on the shared body materials. Two
   *  owners want it at once — setInk's 0-edge (the ink fills are translucent)
   *  and core/scene's setBodyFade (applyBodyFade, which fades the same shared
   *  instances) — and either one clearing the flag under the other is a body
   *  that renders opaque mid-fade or vanishes inside the glass mid-dive. So
   *  neither writes it: both move an input and the flag is resolved HERE. */
  const writeTransparent = () => {
    const on = bodyTransparent(inkOn, fadeOn);
    for (const m of flips) m.transparent = on;
  };

  function bodyFadeActive(on: boolean) {
    if (on === fadeOn) return;
    fadeOn = on;
    writeTransparent();
    // …AND THE TWIN COMES OFF BEFORE THE FADE STARTS WRITING. core/scene's
    // applyBodyFade calls this FIRST, ahead of its own capture, precisely so
    // this swap has already happened when it takes the set of materials it will
    // fade and restore: the fade owns `opacity` on whatever the meshes are
    // wearing at that moment, and a swap under it would leave the level on a
    // material nothing wears and the worn one at 1 (see inkTwinWorn).
    resolveBody();
  }

  function setInk(v: number) {
    const k = clamp01(v);
    if (k === inkAmount) return;
    inkAmount = k;
    uInk.value = k;
    // THE 0-EDGE — one flag per shared material, one flag per line object.
    const on = k > 0;
    if (on !== inkOn) {
      inkOn = on;
      if (on) ensureLines();
      writeTransparent();
      for (const l of inkLines) l.visible = on;
    }
    // …AND THE ELEMENTS' OWN EDGE, at the middle of the ramp, where the two
    // materials it chooses between are both at zero opacity (GLASS_HANDOVER).
    const glassOn = k >= GLASS_HANDOVER;
    if (glassOn !== glassInkOn) {
      glassInkOn = glassOn;
      for (const [mesh, w] of worn) if (w.ink) mesh.material = current(mesh);
    }
    // …AND THE BODY'S OWN 1-EDGE, resolved in the SAME synchronous call that
    // moved the uniform: whatever drove this write (story/fly.ts's ramp, a look
    // switch) cannot render a frame between the two, so the twin can never be
    // on for a frame drawn at uInk < 1. The per-frame syncBody re-resolves it
    // again, from the same law, immediately before the render.
    resolveBody();
  }

  // ── The 1-EDGE (the header's INK TWIN) ─────────────────────────────────────

  /** THE 1-EDGE, RESOLVED. One function, called by every writer that can move
   *  an input and once more per frame before the render (syncBody), so the worn
   *  material and the live state can never disagree on a drawn frame. Cheap and
   *  idempotent: it re-dresses the meshes only when the look, the render
   *  context or the warm-up has moved since the last time it did.
   *
   *  It resolves the look for the WHOLE body; whether a given key can actually
   *  wear it is `current`'s per-key warm gate. */
  function resolveBody() {
    bodyLook = inkTwinWorn({ inkMix: inkAmount, fadeOn }) ? "ink" : "blend";
    const key = `${bodyLook}|${bodyCtx}`;
    if (key === dressed) return;
    dressed = key;
    for (const [mesh, w] of worn) {
      // …BUT ONLY ONTO A MESH THIS LOOK IS ACTUALLY DRESSING. A bench look
      // (materials/shading.ts) owns `mesh.material` for as long as it is worn,
      // and the ink blend it left behind keeps whatever value the /lens page
      // last drove it to — so a swap here would stomp the bench's own fills.
      // `wear()` is how the merged pair comes back, and it writes regardless.
      if (!w.body || !ours(mesh, w.body)) continue;
      mesh.material = current(mesh);
    }
  }

  /** is `mesh` wearing one of ITS OWN body materials right now? */
  const ours = (mesh: THREE.Mesh, b: BodyMats) =>
    mesh.material === b.blend || mesh.material === b.ink;

  function syncBody(ctx: RenderCtx) {
    bodyCtx = ctx;
    resolveBody();
  }

  /** THE WARM FRAME'S HALF OF THE TWIN: the twin is worn across one real render
   *  in the context being warmed, then everything is put back exactly as it was
   *  — a pipeline is compiled by a DRAW, and `current` may not hand the twin out
   *  until it has had one in that context. It is worn DIRECTLY here, not through
   *  `current`, which is the gate this is opening.
   *
   *  EVERY BODY MESH IS SHOWN for the frame: three does not draw a hidden
   *  object, and the accessories load hidden but /lens can toggle one on at any
   *  moment. Nothing of it is seen — the warm frame is overwritten by the real
   *  render in the same tick (canvas) or drawn into a 1×1 target (pass) — and
   *  core/scene's one owner of `.visible` keeps exactly the flags it wrote. */
  function warmBodyLooks(ctx: RenderCtx, cb: () => void) {
    ensureTwins();
    const was = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    for (const mesh of worn.keys()) was.set(mesh, mesh.material);
    const shown: THREE.Object3D[] = [];
    for (const [mesh, w] of worn) {
      if (!w.body) continue;
      // …up the parents too: a hidden ANCESTOR (the accessory group nodes) is
      // where three stops descending.
      for (let o: THREE.Object3D | null = mesh; o; o = o.parent)
        if (!o.visible) {
          o.visible = true;
          shown.push(o);
        }
    }
    try {
      for (const [mesh, w] of worn) {
        const m = w.body?.ink;
        if (m) mesh.material = m;
      }
      cb();
    } finally {
      for (const [mesh, mat] of was) mesh.material = mat;
      for (const o of shown) o.visible = false;
    }
    // …and only now is the pipeline a fact. Marked per key, so keys minted by a
    // later integrate() stay cold and keep the blend (`needsWarm`).
    for (const rec of bodyMats.values())
      if (!rec.warm[ctx]) {
        rec.warm[ctx] = true;
        coldKeys[ctx]--;
      }
    // the meshes were dressed before those keys were wearable — dress them again
    dressed = "";
    resolveBody();
  }

  function setTheme(l: boolean) {
    if (l === light) return;
    light = l;
    for (const t of tints) t.write(l ? t.light : t.dark);
  }

  function dispose() {
    for (const l of inkLines) l.removeFromParent();
    inkLines.length = 0;
    created.forEach((m) => m.dispose());
    created.clear();
    edgeGeo.forEach((g) => g.dispose());
    edgeGeo.clear();
  }

  integrate(root);

  return {
    integrate,
    wear,
    setInk,
    bodyFadeActive,
    // The TWINS are this controller's too — they are never worn while a fade
    // runs (inkTwinWorn), so the fade should never see one; this keeps that a
    // law rather than a timing.
    ownsTransparent: (m) => flips.has(m) || twins.has(m),
    ink: () => inkAmount,
    syncBody,
    warmBodyLooks,
    needsWarm: (ctx) => coldKeys[ctx] > 0,
    setTheme,
    dispose,
  };
}
