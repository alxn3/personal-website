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
import type { TslNode } from "../ops/tsl-types";
import { depthFadeFactor } from "./depthfade";
import { isOpticalGlass, isDecal, isAccessory } from "../core/parts";
import { clamp01 } from "../core/math";

// The story's two looks on ONE material: "realistic" (core/model.ts's PBR spec,
// re-classed to a node material so the op deform rides it) and "ink" (the
// drawing), blended by `uInk` on `outputNode`:
//
//     output  = mix(the PBR result, inkColor · celShade, uInk)
//     opacity = materialOpacity · mix(1, uInkFill · depthFade, uInk)
//
// Wearing a look is a uniform write — nothing is re-materialled.
//
// TWO THINGS CANNOT BLEND:
//   - `transparent`, flipped on the shared body materials at the uInk 0-edge.
//     three copies the transmission backdrop from the OPAQUE pass only, so a
//     permanently-transparent body would vanish inside the glass during the
//     dive. core/scene's body fade wants the same flag, so it has ONE owner
//     with two inputs — `writeTransparent`.
//   - GLASS. `transmission > 0` puts a mesh in the transmission pass forever,
//     and the backdrop it refracts is copied from the OPAQUE pass alone — so
//     while the body is transparent (any ink at all, above) a transmissive
//     element refracts the BACKGROUND and reads as a hole through the lens.
//     The elements therefore keep two materials and swap at GLASS_HANDOVER,
//     where both sides are at zero opacity, which is what makes the cut
//     invisible. It is a plain crossfade of two FILLS: no line-work on glass.
//
// THE INK TWIN. At uInk = 1 the blend still emits the whole PBR fragment path
// and multiplies it by zero, so the body swaps to a MeshBasicNodeMaterial built
// from the SAME builders with `lights = false`. Both sides are the same
// expression at uInk = 1, so the swap needs no cross-fade — and the edge is
// `=== 1`, never `> 1 − ε`. A TWIN IS NEVER WORN ON A PIPELINE THAT HAS NOT
// BEEN DRAWN: three keys a pipeline on the material class AND the render
// context, so each key's twin is warmed per `RenderCtx` (`warmBodyLooks`) and a
// key minted later stays cold, on the blend, until its own warm frame.
//
// The bench looks (outline / riso / blueprint / …) are materials/shading.ts's.

/** 0 = the realistic PBR look, 1 = the ink drawing; between = a live blend.
 *  PRIVATE: two booleans ride the ramp (the `transparent` flip at the 0-edge,
 *  the elements' swap at GLASS_HANDOVER), so `setInk` is the only writer. */
const uInk = uniform(0);

/** Where the elements hand their two materials over — the middle of the ramp,
 *  where both the realistic glass and the ink fill are at zero. Exported as a
 *  READING, not a knob: it is the exact uInk at which three's transmission-pass
 *  framebuffer copy switches off, and story/cost.ts may not spell it twice. */
export const GLASS_HANDOVER = 0.5;

/** The elements' crossfade as the two halves of the ramp. Both are 0 AT the
 *  hand-over, which is what makes the material swap invisible. SQUARE-ROOTED
 *  because the halves are SEQUENTIAL — sqrt rises steeply off zero and so keeps
 *  the elements present right up to the swap. Fresh node per material. */
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

/** The `transparent` law for the shared body materials: transparent while ANY
 *  ink shows or while core/scene's body fade is under 1, opaque only when
 *  neither wants it. Two callers, one flag — see `writeTransparent`. */
export const bodyTransparent = (inkOn: boolean, fadeOn: boolean) =>
  inkOn || fadeOn;

/** The 1-edge, as the twin's swap reads it. Both are LIVE. */
export interface InkEdge {
  /** setInk's live blend (uInk). The twin is worn at EXACTLY 1. */
  inkMix: number;
  /** core/scene's body fade is under 1 (materialOpacity is not 1). */
  fadeOn: boolean;
}

/** Is the ink twin the whole drawing? Exact at uInk = 1, but only while
 *  `materialOpacity` is the shipped 1: under a body fade the fade owns that
 *  number per instance, so a swap would hand back a material it never saw. */
export const inkTwinWorn = (e: InkEdge): boolean => e.inkMix === 1 && !e.fadeOn;

// Cel shade: quantized N·L against a fixed key light, three flat bands giving
// the unlit ink fills form. Uses the TRANSFORMED normal, so op-deformed pieces
// band correctly as they peel. Fresh node per material.
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

// The ink palette — flat fill colours keyed by part name, one variant per site
// theme. Both themes must take the SAME branch for a name, which is what lets
// one material serve it in either: the hexes are cached as a pair and a theme
// flip writes the other into the material's colour uniform.
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

/** Ink edge-line colour: warm white on the dark stage, sepia on the light one. */
const INK_EDGE = { dark: 0xe4dbc4, light: 0x2f2a20 };

/** EdgesGeometry crease angle for the ink line-work. A READING, not a knob:
 *  story/cost.ts cuts at it and may not spell it twice. */
export const EDGE_THRESHOLD_DEG = 24;

/** Does this mesh wear an ink edge-line — `addLine`'s own skip, as a predicate,
 *  so story/cost.ts can select the same set instead of restating the rule. */
export const hasInkEdgeLine = (name: string): boolean =>
  !isDecal(name) && !isOpticalGlass(name);

/** Cut every ink edge-line's geometry, keyed by mesh id — `addLine`'s cache,
 *  filled ahead of it. Pure geometry over the frame attributes, so core/scene
 *  runs it on the model-load chain (no renderer) and hands the map to
 *  `createUnified`; anything it misses is still cut on demand. */
export function cutInkEdges(
  root: THREE.Object3D,
): Map<number, THREE.BufferGeometry> {
  const cut = new Map<number, THREE.BufferGeometry>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !hasInkEdgeLine(o.name)) return;
    // Accessories are framed by their own later pass (core/scene), so cutting
    // one here would cache an UNFRAMED line for a mesh that goes on to deform.
    if (isAccessory(o.name)) return;
    cut.set(
      o.id,
      hasOpFrames(o)
        ? opsEdgeGeometry(o.geometry, EDGE_THRESHOLD_DEG)
        : new THREE.EdgesGeometry(o.geometry, EDGE_THRESHOLD_DEG),
    );
  });
  return cut;
}

/** What one mesh wears: for GLASS the merged material plus the ink fill that
 *  cannot merge with transmission; for a BODY mesh its cache key's materials.
 *  Exactly one of `mat` / `body` is set. */
interface Worn {
  mat?: THREE.Material;
  ink?: THREE.Material;
  body?: BodyMats;
}

/** The two render contexts the story draws the body in. three keys a pipeline
 *  on the context as well as on the shader and `transparent`, so the two are
 *  warmed, and tracked, SEPARATELY. */
export type RenderCtx = "canvas" | "pass";

/** The body's materials for one cache key. The twin is built on the first frame
 *  that reaches the 1-edge, not at load. */
interface BodyMats {
  /** the merged blend — every uInk below 1, and every frame of a body fade */
  blend: THREE.Material;
  /** the 1-edge twin. Undefined until it is built. */
  ink?: THREE.Material;
  /** true once this key's twin has been drawn off-screen in that context — the
   *  only thing that lets `current` hand it to a mesh there. */
  warm: Record<RenderCtx, boolean>;
  /** what the lazy twin build needs, incl. the SHARED ink colour uniform */
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
  /** Fold meshes that arrive after creation into the merged look. Also RE-KEYS
   *  a mesh whose op frame landed late, so it still ends up deforming. */
  integrate(root: THREE.Object3D): void;
  /** Put the merged materials back on every mesh — the realistic/ink arm of
   *  materials/shading.ts's swapper, after a bench look wore something else. */
  wear(): void;
  /** Blend the pair. The ramp's two edges flip what cannot blend (the header);
   *  everything else is one uniform write. */
  setInk(v: number): void;
  /** Declare that core/scene's body fade wants the shared body materials
   *  transparent (o < 1) — the SECOND input to `writeTransparent`'s flag. */
  bodyFadeActive(on: boolean): void;
  /** Whether `m`'s `transparent` is this controller's to write — core/scene's
   *  body fade also covers materials this does not own, and writes those. */
  ownsTransparent(m: THREE.Material): boolean;
  /** the live blend, for a caller that has to put it back (the warm-up frame) */
  ink(): number;
  /** The 1-edge, resolved once per frame from core/scene's tick immediately
   *  before the render. A twin only goes on if warmed in `ctx`. */
  syncBody(ctx: RenderCtx): void;
  /** Draw the twin once, off-screen, and only then allow it in `ctx`. `draw`
   *  renders the scene in the context being warmed and REPORTS WHETHER IT
   *  REACHED IT — a caller whose render collapsed to nothing warms nothing, and
   *  the context stays cold. This wears the twin across the draw and puts back
   *  exactly what was on. */
  warmBodyLooks(ctx: RenderCtx, draw: () => boolean): void;
  /** Does any body key still owe a warm frame in `ctx`? Asked per tick, not
   *  flagged once: `integrate` mints keys after the first warm frame. */
  needsWarm(ctx: RenderCtx): boolean;
  /** Re-tint the ink for the site theme. A VALUE WRITE — no rebuild. */
  setTheme(light: boolean): void;
  dispose(): void;
}

/** The ink edge-lines' opacity graph, its own function so the law is testable
 *  without a renderer. The lines ride the whole ramp, the factor their fill
 *  mixes on, and `materialOpacity`, the only way the body fade reaches them. */
export const inkLineOpacity = (opsPos?: TslNode): TslNode =>
  float(0.9)
    .mul(depthFadeFactor(opsPos))
    .mul(materialOpacity)
    .mul(uInk as any);

/** The glass elements' two opacity graphs — the crossfade's two halves. An
 *  opacityNode REPLACES the scalar, so `materialOpacity` is the only way the
 *  body fade reaches a NodeMaterial: miss it on either and a column of elements
 *  floats where the lens used to be. `fade` cannot be built here. */
export const glassFillOpacity = (): TslNode =>
  materialOpacity.mul(inkBottomHalf());
export const glassInkOpacity = (fade?: TslNode): TslNode =>
  float(0.45)
    .mul(fade ?? float(1))
    .mul(materialOpacity)
    .mul(inkTopHalf());

/** The body's two graphs, extracted so the twin cannot drift from the blend:
 *  the pair is only swappable because it is the SAME EXPRESSION.
 *
 *  `inkOutput` keeps the `mix` even on the twin, which only renders at uInk = 1
 *  where the PBR side is multiplied by zero, so both run the same arithmetic
 *  and only the dead operand differs. `ink` is the SHARED colour uniform. */
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
 * Build the merged material for every mesh under `root` and wear it: the deform
 * attach, ONE material per source material × graph variant, plus the ink half.
 * Runs in core/scene's prepareModelMaterials chain AFTER deriveFrames /
 * tagMechanismSpins, whose writes the deform graph reads, and BEFORE
 * createShading. `edges` is `cutInkEdges`' output, adopted as the line cache.
 */
export function createUnified(
  root: THREE.Object3D,
  edges?: Map<number, THREE.BufferGeometry>,
): UnifiedLook {
  // Site theme, detected here so both pages get the right palette without
  // wiring; toggles arrive via setTheme (the pages own the observer).
  let light = !document.documentElement.classList.contains("dark");
  let inkAmount = 0;
  /** the boolean half of the blend: true whenever ANY ink is showing */
  let inkOn = false;
  /** the elements' own edge (GLASS_HANDOVER) — a different point on the ramp */
  let glassInkOn = false;
  /** core/scene's body fade is under 1 — `transparent`'s second input */
  let fadeOn = false;
  let linesBuilt = false;
  /** which body material every body mesh wears. Moved ONLY by `resolveBody`. */
  let bodyLook: BodyLook = "blend";
  /** the context this frame renders in — a twin is only wearable where its
   *  pipelines exist */
  let bodyCtx: RenderCtx = "canvas";
  /** the (look, context) the meshes are DRESSED for; "" forces a re-dress */
  let dressed = "";
  /** body keys still owing a warm frame per context. Counted, not flagged, so
   *  `integrate`'s late materials re-arm it. */
  const coldKeys: Record<RenderCtx, number> = { canvas: 0, pass: 0 };
  let twinsBuilt = false;
  // The uniforms are MODULE state but a controller is not, so a rebuilt scene
  // would otherwise open at the previous one's blend.
  uInk.value = 0;
  uInkFill.value = 1;

  const worn = new Map<THREE.Mesh, Worn>();
  /** the source material each mesh arrived wearing — the merged material
   *  replaces it, so it is remembered here for a re-key */
  const source = new Map<THREE.Mesh, THREE.Material>();
  /** the key each mesh resolved to, so integrate() can tell a mesh that merely
   *  re-appeared from one whose VARIANT changed */
  const keyed = new Map<THREE.Mesh, string>();

  /** SHARED materials: one per source material × ink colour × graph variant,
   *  not one per mesh — a node graph each would dominate first-frame time. */
  const merged = new Map<string, THREE.Material>();
  /** the BODY's own cache — the blend plus its 1-edge twin per key. */
  const bodyMats = new Map<string, BodyMats>();
  const glassInk = new Map<string, THREE.Material>();
  const lineMats = new Map<string, THREE.LineBasicNodeMaterial>();
  /** every material whose `transparent` flips at the 0-edge (the body's) */
  const flips = new Set<THREE.Material>();
  /** every 1-edge twin — `ownsTransparent` adds these to `flips` so the body
   *  fade leaves their flag alone */
  const twins = new Set<THREE.Material>();
  const tints: Tint[] = [];
  const inkLines: THREE.LineSegments[] = [];
  const edgeGeo = edges ?? new Map<number, THREE.BufferGeometry>();
  const created = new Set<THREE.Material>();

  const track = <T extends THREE.Material>(m: T): T => {
    created.add(m);
    return m;
  };

  /** The target class must track the SOURCE: NodeMaterial.copy only copies
   *  properties the target declares, so a MeshPhysicalMaterial copied into a
   *  MeshStandardNodeMaterial silently DROPS transmission/ior. */
  function reclass(src: THREE.Material): THREE.NodeMaterial {
    const m = (src as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial
      ? new THREE.MeshPhysicalNodeMaterial()
      : new THREE.MeshStandardNodeMaterial();
    m.copy(src as THREE.MeshStandardMaterial);
    return m as unknown as THREE.NodeMaterial;
  }

  /** Attach the deform and hand back the depth fade riding the SAME position
   *  node — a second position graph would double the deform. */
  const opsFade = (
    mat: THREE.NodeMaterial,
    mesh: THREE.Mesh,
    framed: boolean,
  ) => depthFadeFactor(framed ? attachOps(mat, mesh) : undefined);

  /** The render state BOTH body materials wear, written once so the twin
   *  cannot drift from the blend. `transparent` is the one thing that differs
   *  — it is the variant's whole definition. */
  function bodyRenderState(m: THREE.Material) {
    // Push the fill's depth back a hair so the edge lines, which share the
    // surface's exact vertices, win the depth test rather than z-fighting.
    m.polygonOffset = true;
    m.polygonOffsetFactor = 1;
    m.polygonOffsetUnits = 1;
    // DISCARD fully-faded fragments: a transparent fill at opacity ~0 still
    // writes depth, so a depth-faded wedge would invisibly hard-clip whatever
    // is behind it. Left on — `alphaTest` is a GRAPH branch, so flipping it
    // would cost a rebuild rather than a pipeline.
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
    // transmissive glass clones and core/scene's body fade both write it. The
    // fade is this material's other half-owner, and moves an input through
    // `bodyFadeActive` rather than writing `transparent` itself.
    m.opacityNode = bodyFillOpacity(fade) as any;
    bodyRenderState(m as unknown as THREE.Material);
    // A material built while the ink is already on — or while the body fade is
    // running — has to arrive matching, so it takes the resolver's value.
    m.transparent = bodyTransparent(inkOn, fadeOn);
    const mat = m as unknown as THREE.Material;
    const rec: BodyMats = {
      blend: mat,
      // Born cold: a key minted after the warm frames have run owes its own
      // in both contexts before its twin is wearable.
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

  /** The 1-edge twin. The fragment is rebuilt from the SAME builders on the
   *  SAME `ink` uniform; everything else is COPIED off the blend, so `side`,
   *  `depthWrite/Test` and `blending` cannot go stale against it.
   *
   *  `lights = false` takes the lighting context out of the fragment shader.
   *  The setupNormal override keeps the drawing: MeshBasicNodeMaterial would
   *  use the geometric normal and band an op-deformed piece by its rest
   *  pose. */
  function twinFor(rec: BodyMats): THREE.Material {
    const { mesh, framed, ink } = rec.seed;
    const m = new THREE.MeshBasicNodeMaterial();
    m.copy(rec.blend as THREE.MeshBasicMaterial);
    // `opacity` off the SOURCE, not the blend's live value: the lazy build can
    // land mid-fade, and the fade restores to the material it captured.
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

  /** The elements' ink fill — flat mint, NOT cel-banded and never dissolved by
   *  uInkFill, so the glass stays filled while the body goes to wireframe. The
   *  SECOND half of the crossfade: 0 at the hand-over, full at 1. */
  function glassInkMaterial(mesh: THREE.Mesh, key: string, framed: boolean) {
    const hit = glassInk.get(key);
    if (hit) return hit;
    const dark = inkFill(mesh.name, false);
    const lit = inkFill(mesh.name, true);
    const m = new THREE.MeshBasicNodeMaterial();
    m.color.setHex(light ? lit : dark);
    const fade = opsFade(m as unknown as THREE.NodeMaterial, mesh, framed);
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

  function lineMaterial(mesh: THREE.Mesh, framed: boolean) {
    const key = `${framed}|${opsVariantKey(mesh)}`;
    const hit = lineMats.get(key);
    if (hit) return hit;
    const m = new THREE.LineBasicNodeMaterial();
    m.color.setHex(light ? INK_EDGE.light : INK_EDGE.dark);
    m.transparent = true;
    // Attach the deform first, then share its position node with the fade.
    const opsPos = framed
      ? attachOpsLine(m as unknown as THREE.NodeMaterial, mesh)
      : undefined;
    m.opacityNode = inkLineOpacity(opsPos);
    m.alphaTest = 0.02; // faded lines must not depth-clip either
    lineMats.set(key, m);
    tints.push({
      write: (h) => m.color.setHex(h),
      dark: INK_EDGE.dark,
      light: INK_EDGE.light,
    });
    track(m);
    return m;
  }

  /** What this mesh wears right now — the glass's edge or the body's. A pure
   *  read; both edges are moved elsewhere. THE WARM GATE LIVES HERE, per key
   *  and per context, so no path that dresses a mesh can by-pass it. */
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
    // A mesh whose deform graph VARIES (a spin pivot, a decal's shrink-wrap)
    // can only share a material with meshes that vary the same way — hence the
    // variant in the key.
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

  /** The elements' realistic material: the plain op material the dive's
   *  transmissive clones are made from, plus the FIRST half of the
   *  crossfade. */
  function mergedGlass(mesh: THREE.Mesh, key: string, framed: boolean) {
    const hit = merged.get(key);
    if (hit) return hit;
    const m = reclass(source.get(mesh)!);
    if (framed) attachOps(m, mesh);
    // materialOpacity first, so the dive's clones can write `opacity`, then out
    // over the ramp's bottom half. The clones inherit this node harmlessly: the
    // dive runs at uInk 0, where the factor is exactly 1.
    m.opacityNode = glassFillOpacity() as any;
    // Set once at build, never flipped with the body's: three keys a pipeline
    // on `transparent`, so a flip at the 0-edge would compile a second glass
    // pipeline on the crossfade's first frame. Free to leave on.
    m.transparent = true;
    const mat = m as unknown as THREE.Material;
    merged.set(key, mat);
    return track(mat);
  }

  /** ONE mesh's edge lines. The geometry is cached per mesh — a pure function
   *  of the immutable source geometry, and the ink look's expensive half. */
  function addLine(mesh: THREE.Mesh) {
    if (!hasInkEdgeLine(mesh.name)) return;
    const framed = hasOpFrames(mesh);
    let geo = edgeGeo.get(mesh.id);
    if (!geo) {
      geo = framed
        ? opsEdgeGeometry(mesh.geometry, EDGE_THRESHOLD_DEG)
        : new THREE.EdgesGeometry(mesh.geometry, EDGE_THRESHOLD_DEG);
      edgeGeo.set(mesh.id, geo);
    }
    const line = new THREE.LineSegments(geo, lineMaterial(mesh, framed));
    line.raycast = () => {}; // extras are never pickable
    line.userData.lensExtra = true; // …and never a piece of the model (integrate)
    line.visible = inkOn;
    mesh.add(line);
    inkLines.push(line);
  }

  /** Built on the first blend that shows ink, not at load: the edge geometry is
   *  the costliest thing in here. Never taken down again — the realistic look
   *  simply does not draw them. */
  function ensureLines() {
    if (linesBuilt) return;
    linesBuilt = true;
    for (const mesh of worn.keys()) addLine(mesh);
  }

  /** Take OUR line-work off `mesh` — those in `inkLines`, never every
   *  LineSegments child: a bench look parents its own on the same meshes. */
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
      // Skip a look's own extra (a bench hull). NOT a parent-is-a-Mesh test:
      // `Mount_Contacts` is authored as a child of the mesh it sits on.
      if (!(o instanceof THREE.Mesh) || o.userData.lensExtra) return;
      const fresh = !source.has(o);
      if (fresh) source.set(o, o.material as THREE.Material);
      const before = keyed.get(o);
      style(o);
      // A late frame moves the key, and that mesh's line-work has to be re-cut
      // against the deforming geometry it just gained.
      if (linesBuilt && before !== keyed.get(o)) {
        if (!fresh) dropLines(o);
        addLine(o);
      }
    });
  }

  function wear() {
    for (const mesh of worn.keys()) mesh.material = current(mesh);
  }

  /** THE ONE PLACE `transparent` is written on the shared body materials. Two
   *  owners want it at once — setInk's 0-edge and core/scene's body fade — and
   *  either clearing it under the other is a body that renders opaque mid-fade
   *  or vanishes inside the glass mid-dive. Both move an input instead. */
  const writeTransparent = () => {
    const on = bodyTransparent(inkOn, fadeOn);
    for (const m of flips) m.transparent = on;
  };

  function bodyFadeActive(on: boolean) {
    if (on === fadeOn) return;
    fadeOn = on;
    writeTransparent();
    // The twin comes off BEFORE the fade starts writing: core/scene calls this
    // ahead of its own capture, so the fade takes `opacity` on whatever the
    // meshes end up wearing.
    resolveBody();
  }

  function setInk(v: number) {
    const k = clamp01(v);
    if (k === inkAmount) return;
    inkAmount = k;
    uInk.value = k;
    // The 0-edge — one flag per shared material, one per line object.
    const on = k > 0;
    if (on !== inkOn) {
      inkOn = on;
      if (on) ensureLines();
      writeTransparent();
      for (const l of inkLines) l.visible = on;
    }
    // …the elements' own edge, at the middle of the ramp, where the two
    // materials it chooses between are both at zero opacity.
    const glassOn = k >= GLASS_HANDOVER;
    if (glassOn !== glassInkOn) {
      glassInkOn = glassOn;
      for (const [mesh, w] of worn) if (w.ink) mesh.material = current(mesh);
    }
    // …and the body's 1-edge, resolved in the SAME synchronous call that moved
    // the uniform: no frame can render between the two, so the twin is never
    // on for a frame drawn at uInk < 1.
    resolveBody();
  }

  // ── The 1-EDGE (the header's INK TWIN) ─────────────────────────────────────

  /** The 1-edge, resolved. Called by every writer that can move an input and
   *  once per frame before the render, so the worn material and the live state
   *  can never disagree on a drawn frame. Idempotent. Resolves the look for the
   *  WHOLE body; per-key wearability is `current`'s warm gate. */
  function resolveBody() {
    bodyLook = inkTwinWorn({ inkMix: inkAmount, fadeOn }) ? "ink" : "blend";
    const key = `${bodyLook}|${bodyCtx}`;
    if (key === dressed) return;
    dressed = key;
    for (const [mesh, w] of worn) {
      // Only onto a mesh this look is actually dressing: a bench look owns
      // `mesh.material` while it is worn, so a swap here would stomp its fills.
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

  /** The warm frame's half of the twin: it is worn across one real render in
   *  the context being warmed, then everything is put back — a pipeline is
   *  compiled by a DRAW. Worn DIRECTLY, not through `current`, which is the
   *  gate this opens. EVERY body mesh is shown for the frame, since three does
   *  not draw a hidden object; nothing of it is seen. */
  function warmBodyLooks(ctx: RenderCtx, draw: () => boolean) {
    ensureTwins();
    const was = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    for (const mesh of worn.keys()) was.set(mesh, mesh.material);
    const shown: THREE.Object3D[] = [];
    for (const [mesh, w] of worn) {
      if (!w.body) continue;
      // …up the parents too: a hidden ANCESTOR is where three stops descending.
      for (let o: THREE.Object3D | null = mesh; o; o = o.parent)
        if (!o.visible) {
          o.visible = true;
          shown.push(o);
        }
    }
    let drawn = false;
    try {
      for (const [mesh, w] of worn) {
        const m = w.body?.ink;
        if (m) mesh.material = m;
      }
      drawn = draw();
    } finally {
      for (const [mesh, mat] of was) mesh.material = mat;
      for (const o of shown) o.visible = false;
    }
    // A draw that never reached the scene compiled nothing, so the context owes
    // its warm still — everything above is already back where it was.
    if (!drawn) return;
    // …and only now is the pipeline a fact. Marked per key, so keys minted by
    // a later integrate() stay cold and keep the blend.
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
    // The twins are this controller's too. They are never worn while a fade
    // runs, so this keeps that a law rather than a timing.
    ownsTransparent: (m) => flips.has(m) || twins.has(m),
    ink: () => inkAmount,
    syncBody,
    warmBodyLooks,
    needsWarm: (ctx) => coldKeys[ctx] > 0,
    setTheme,
    dispose,
  };
}
