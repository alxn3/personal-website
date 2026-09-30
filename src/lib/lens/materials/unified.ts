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
  attribute,
  step,
  smoothstep,
  varying,
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
import { WINK_WIDTH } from "../core/visibility";
import { clamp01 } from "../core/math";

// The model's main material: the "realistic" PBR look and the "ink" drawing
// in one material, blended by `uInk`:
//
//     output  = mix(PBR result, inkColor * celShade, uInk)
//     opacity = materialOpacity * mix(1, uInkFill * depthFade, uInk) * wink
//
// Two things can't be blended and switch at fixed points instead:
//   - `transparent` on the body turns on when any ink shows (uInk > 0); an
//     always-transparent body would vanish behind transmissive glass.
//   - Glass swaps between its PBR material and a flat ink fill at
//     GLASS_HANDOVER, where both are at zero opacity.
// At exactly uInk = 1 the body switches to a cheaper unlit "twin" material
// that draws the same image, but only once that twin has been warmed
// (compiled) in the current render context.

/** 0 = realistic, 1 = ink. Write only through setInk. */
const uInk = uniform(0);

/** The uInk at which the glass swaps materials (both are invisible there). */
export const GLASS_HANDOVER = 0.5;

/** Glass crossfade: the PBR glass fades over the first half of the ramp and
 *  the ink fill over the second. sqrt keeps each visible until the swap. */
const inkBottomHalf = () =>
  clamp(float(1).sub((uInk as any).div(GLASS_HANDOVER)), 0, 1).sqrt() as any;
const inkTopHalf = () =>
  clamp(
    (uInk as any).sub(GLASS_HANDOVER).div(1 - GLASS_HANDOVER),
    0,
    1,
  ).sqrt() as any;

/** Ink fill opacity: 0 = edge lines only, 1 = solid fills. */
export const uInkFill = uniform(1);

/** Shell and interior fade levels (set by scene.ts; see core/visibility.ts). */
export const uShellFade = uniform(1);
export const uInteriorFade = uniform(1);

/** A piece's dissolve opacity from its `_opY.w` threshold; the shader form of
 *  `winkOpacity` in core/visibility.ts. Build one per material. */
export const winkFactor = (): TslNode => {
  const lane = (attribute("_opY", "vec4") as TslNode).w as TslNode;
  const ch = step(1.5, lane) as TslNode;
  const t = lane.sub(ch.mul(2));
  const level = mix(uShellFade as any, uInteriorFade as any, ch) as TslNode;
  return varying(smoothstep(t.sub(WINK_WIDTH), t, level)) as TslNode;
};

/** Body materials are transparent while any ink shows or the body is fading. */
export const bodyTransparent = (inkOn: boolean, fadeOn: boolean) =>
  inkOn || fadeOn;

// Cel shading: N·L against a fixed light, quantized into three flat bands.
// Build one per material.
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

// Ink fill colour per part, per theme. Both themes must take the same branch
// for a given name.
function inkFill(name: string, light: boolean): number {
  if (light) {
    if (isOpticalGlass(name)) return 0x6fa863; // mint glass
    if (/^Iris_Blade/.test(name)) return 0x5b6478;
    if (isDecal(name)) return 0x3f3a2f; // dark printed text
    if (/^Mount_Contacts/.test(name)) return 0xb08428;
    if (/^Mount_/.test(name)) return 0x7c766a;
    if (/^Focus_/.test(name)) return 0xa8672e;
    if (/^PCB_/.test(name)) return 0x5d7a48;
    if (/Ring_/.test(name)) return 0x4a4f5e; // rubber grips
    if (/Band_Mid|Barrel_Base|Chassis/.test(name)) return 0xe3ddcc; // gloss body
    return 0xece6d6; // matte body — paper-light so the dark outlines pop
  }
  if (isOpticalGlass(name)) return 0x9ccb92; // mint glass
  if (/^Iris_Blade/.test(name)) return 0x4b5364; // blued-steel aperture blades
  if (isDecal(name)) return 0xefe8d4; // white printed text
  if (/^Mount_Contacts/.test(name)) return 0xd9a852; // bright brass contacts
  if (/^Mount_/.test(name)) return 0x9a9482; // chrome / metal
  if (/^Focus_/.test(name)) return 0xc5813f; // amber focus drive
  if (/^PCB_/.test(name)) return 0x6d8a55; // circuit-board green
  if (/Ring_/.test(name)) return 0x343846; // rubber grip rings — dark slate
  if (/Band_Mid|Barrel_Base|Chassis/.test(name)) return 0x2c2720; // gloss body
  return 0x211d16; // matte body — near-black so the outlines pop
}

/** Ink edge-line colour per theme. */
const INK_EDGE = { dark: 0xe4dbc4, light: 0x2f2a20 };

/** Crease angle for the ink edge lines. */
export const EDGE_THRESHOLD_DEG = 24;

/** Whether a mesh gets ink edge lines. */
export const hasInkEdgeLine = (name: string): boolean =>
  !isDecal(name) && !isOpticalGlass(name);

/** Edge-line geometry for `mesh` at a crease angle (the deformable kind if
 *  the mesh has op frames). */
export const edgeGeometry = (
  mesh: THREE.Mesh,
  deg = EDGE_THRESHOLD_DEG,
): THREE.BufferGeometry =>
  hasOpFrames(mesh)
    ? opsEdgeGeometry(mesh.geometry, deg)
    : new THREE.EdgesGeometry(mesh.geometry, deg);

/** Precompute ink edge-line geometry per mesh id (no renderer needed), to
 *  pass to `createUnified`. */
export function cutInkEdges(
  root: THREE.Object3D,
): Map<number, THREE.BufferGeometry> {
  const cut = new Map<number, THREE.BufferGeometry>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !hasInkEdgeLine(o.name)) return;
    // accessories get their frames later, so cut theirs then
    if (isAccessory(o.name)) return;
    cut.set(o.id, edgeGeometry(o));
  });
  return cut;
}

/** A mesh's materials: glass has `mat` + `ink`, body meshes have `body`. */
interface Worn {
  mat?: THREE.Material;
  ink?: THREE.Material;
  body?: BodyMats;
}

/** Where the body is drawn: straight to the canvas or through the post pass.
 *  Shaders compile separately for each. */
export type RenderCtx = "canvas" | "pass";

/** The body materials for one cache key. */
interface BodyMats {
  /** the blended material */
  blend: THREE.Material;
  /** the unlit twin for uInk = 1; built lazily */
  ink?: THREE.Material;
  /** whether the twin has been warmed in each context (it's only worn if so) */
  warm: Record<RenderCtx, boolean>;
  /** inputs for building the twin */
  seed: { mesh: THREE.Mesh; framed: boolean; ink: TslNode };
}

type BodyLook = "blend" | "ink";

/** A colour to switch on theme change. */
interface Tint {
  color: THREE.Color;
  dark: number;
  light: number;
}

export interface UnifiedLook {
  /** Add meshes that loaded later, and re-key meshes whose frames changed. */
  integrate(root: THREE.Object3D): void;
  /** Put these materials back on every mesh (after a bench look). */
  wear(): void;
  /** Set the realistic (0) to ink (1) blend. */
  setInk(v: number): void;
  /** Tell this module the body fade is running (it needs `transparent`). */
  bodyFadeActive(on: boolean): void;
  /** Whether this module controls `m.transparent`. */
  ownsTransparent(m: THREE.Material): boolean;
  /** the current blend */
  ink(): number;
  /** Called each frame before rendering in `ctx`; picks blend or twin. */
  syncBody(ctx: RenderCtx): void;
  /** Wear the twins for one `draw` in `ctx` to compile them, then restore.
   *  `draw` returns false if it didn't reach the scene (nothing warmed). */
  warmBodyLooks(ctx: RenderCtx, draw: () => boolean): void;
  /** Whether any body material still needs warming in `ctx`. */
  needsWarm(ctx: RenderCtx): boolean;
  /** Re-tint for the site theme (no rebuild). */
  setTheme(light: boolean): void;
}

/** Ink edge-line opacity: uInk × depth fade × material opacity × dissolve. */
export const inkLineOpacity = (opsPos?: TslNode, wink?: TslNode): TslNode =>
  float(0.9)
    .mul(depthFadeFactor(opsPos))
    .mul(materialOpacity)
    .mul(uInk as any)
    .mul(wink ?? float(1));

/** Glass opacity for the PBR material and the ink fill. Both include
 *  `materialOpacity` so the fades still reach them. */
export const glassFillOpacity = (): TslNode =>
  materialOpacity.mul(inkBottomHalf());
export const glassInkOpacity = (fade?: TslNode): TslNode =>
  float(0.45)
    .mul(fade ?? float(1))
    .mul(materialOpacity)
    .mul(inkTopHalf());

/** Body colour and opacity graphs, shared by the blend and the twin so the two
 *  always match. `ink` is the fill colour uniform. */
export const inkOutput = (ink: TslNode): TslNode =>
  vec4(
    mix((output as any).rgb, ink.mul(celShade()), uInk as any),
    (output as any).a,
  ) as unknown as TslNode;
export const bodyFillOpacity = (fade: TslNode, wink?: TslNode): TslNode =>
  materialOpacity
    .mul(mix(float(1), uInkFill.mul(fade), uInk as any) as any)
    .mul(wink ?? float(1)) as unknown as TslNode;

/** Build and apply the blended material to every mesh under `root`. Run after
 *  deriveFrames and tagMechanismSpins. `edges` is `cutInkEdges`' output. */
export function createUnified(
  root: THREE.Object3D,
  edges?: Map<number, THREE.BufferGeometry>,
): UnifiedLook {
  let light = !document.documentElement.classList.contains("dark");
  let inkAmount = 0;
  /** uInk > 0 */
  let inkOn = false;
  /** uInk >= GLASS_HANDOVER */
  let glassInkOn = false;
  let fadeOn = false;
  let linesBuilt = false;
  /** set only by resolveBody */
  let bodyLook: BodyLook = "blend";
  let bodyCtx: RenderCtx = "canvas";
  /** the `${look}|${ctx}` the meshes are dressed for; "" forces a re-dress */
  let dressed = "";
  /** body keys not yet warmed, per context */
  const coldKeys: Record<RenderCtx, number> = { canvas: 0, pass: 0 };
  let twinsBuilt = false;
  // Reset the module-level uniforms for this scene.
  uInk.value = 0;
  uInkFill.value = 1;
  uShellFade.value = 1;
  uInteriorFade.value = 1;

  const worn = new Map<THREE.Mesh, Worn>();
  /** each mesh's original (model.ts) material */
  const source = new Map<THREE.Mesh, THREE.Material>();
  /** each mesh's current cache key */
  const keyed = new Map<THREE.Mesh, string>();

  // Materials are shared per cache key, not built per mesh.
  const merged = new Map<string, THREE.Material>();
  const bodyMats = new Map<string, BodyMats>();
  const glassInk = new Map<string, THREE.Material>();
  const lineMats = new Map<string, THREE.LineBasicNodeMaterial>();
  /** body blend materials, whose `transparent` this module sets */
  const flips = new Set<THREE.Material>();
  const twins = new Set<THREE.Material>();
  const tints: Tint[] = [];
  const inkLines: THREE.LineSegments[] = [];
  const edgeGeo = edges ?? new Map<number, THREE.BufferGeometry>();

  /** Node-material copy of `src`, keeping the physical class for glass (copy
   *  drops properties the target class lacks). */
  function reclass(src: THREE.Material): THREE.NodeMaterial {
    const m = (src as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial
      ? new THREE.MeshPhysicalNodeMaterial()
      : new THREE.MeshStandardNodeMaterial();
    m.copy(src as THREE.MeshStandardMaterial);
    return m as unknown as THREE.NodeMaterial;
  }

  /** Attach the deform; return a depth fade on the deformed position. */
  const opsFade = (
    mat: THREE.NodeMaterial,
    mesh: THREE.Mesh,
    framed: boolean,
  ) => depthFadeFactor(framed ? attachOps(mat, mesh) : undefined);

  /** The dissolve term, only for meshes with op frames. */
  const opsWink = (framed: boolean) => (framed ? winkFactor() : undefined);

  /** Render state shared by the blend, the twin and the glass ink fill. */
  function fillRenderState(m: THREE.Material) {
    // push fills back so edge lines on the same vertices win the depth test
    m.polygonOffset = true;
    m.polygonOffsetFactor = 1;
    m.polygonOffsetUnits = 1;
    // discard faded fragments so they don't write depth
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
    m.opacityNode = bodyFillOpacity(fade, opsWink(framed)) as any;
    fillRenderState(m as unknown as THREE.Material);
    m.transparent = bodyTransparent(inkOn, fadeOn);
    const mat = m as unknown as THREE.Material;
    const rec: BodyMats = {
      blend: mat,
      warm: { canvas: false, pass: false },
      seed: { mesh, framed, ink: ink as unknown as TslNode },
    };
    coldKeys.canvas++;
    coldKeys.pass++;
    bodyMats.set(key, rec);
    flips.add(mat);
    tints.push({ color: ink.value as THREE.Color, dark, light: lit });
    if (twinsBuilt) rec.ink = twinFor(rec);
    return rec;
  }

  /** The unlit twin: same graphs and settings as the blend, no lighting. */
  function twinFor(rec: BodyMats): THREE.Material {
    const { mesh, framed, ink } = rec.seed;
    const m = new THREE.MeshBasicNodeMaterial();
    m.copy(rec.blend as THREE.MeshBasicMaterial);
    // from the source, since the blend's opacity may be mid-fade
    m.opacity = source.get(mesh)!.opacity;
    m.lights = false;
    // use the deformed normal (MeshBasic's own would band by the rest pose)
    (
      m as unknown as { setupNormal: THREE.NodeMaterial["setupNormal"] }
    ).setupNormal = THREE.NodeMaterial.prototype.setupNormal;
    const fade = opsFade(m as unknown as THREE.NodeMaterial, mesh, framed);
    m.outputNode = inkOutput(ink) as any;
    m.opacityNode = bodyFillOpacity(fade, opsWink(framed)) as any;
    fillRenderState(m as unknown as THREE.Material);
    m.transparent = true;
    const mat = m as unknown as THREE.Material;
    twins.add(mat);
    return mat;
  }

  function ensureTwins() {
    if (twinsBuilt) return;
    twinsBuilt = true;
    for (const rec of bodyMats.values()) rec.ink ??= twinFor(rec);
  }

  /** Glass ink fill: flat colour, unaffected by uInkFill. */
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
    fillRenderState(m as unknown as THREE.Material);
    const mat = m as unknown as THREE.Material;
    glassInk.set(key, mat);
    tints.push({ color: m.color, dark, light: lit });
    return mat;
  }

  function lineMaterial(mesh: THREE.Mesh, framed: boolean) {
    const key = `${framed}|${opsVariantKey(mesh)}`;
    const hit = lineMats.get(key);
    if (hit) return hit;
    const m = new THREE.LineBasicNodeMaterial();
    m.color.setHex(light ? INK_EDGE.light : INK_EDGE.dark);
    m.transparent = true;
    const opsPos = framed
      ? attachOpsLine(m as unknown as THREE.NodeMaterial, mesh)
      : undefined;
    m.opacityNode = inkLineOpacity(opsPos, opsWink(framed));
    m.alphaTest = 0.02;
    lineMats.set(key, m);
    tints.push({ color: m.color, ...INK_EDGE });
    return m;
  }

  /** The material `mesh` should wear now (the twin only once warmed). */
  const current = (mesh: THREE.Mesh) => {
    const w = worn.get(mesh)!;
    const b = w.body;
    if (b) {
      if (bodyLook === "ink" && b.warm[bodyCtx] && b.ink) return b.ink;
      return b.blend;
    }
    return glassInkOn && w.ink ? w.ink : w.mat!;
  };

  /** Build and apply `mesh`'s materials; no-op if its key is unchanged. */
  function style(mesh: THREE.Mesh) {
    const src = source.get(mesh)!;
    const name = mesh.name;
    const glass = isOpticalGlass(name);
    const framed = hasOpFrames(mesh);
    const key = `${src.uuid}|${inkFill(name, false)}|${inkFill(name, true)}|${glass}|${framed}|${opsVariantKey(mesh)}`;
    if (keyed.get(mesh) === key) return;
    keyed.set(mesh, key);
    // the shader moves the mesh, so its bounds are stale
    if (framed) mesh.frustumCulled = false;
    if (glass)
      worn.set(mesh, {
        mat: mergedGlass(mesh, key, framed),
        ink: glassInkMaterial(mesh, key, framed),
      });
    else worn.set(mesh, { body: mergedMaterial(mesh, key, framed) });
    mesh.material = current(mesh);
  }

  /** Glass PBR material (scene.ts clones it for transmission). */
  function mergedGlass(mesh: THREE.Mesh, key: string, framed: boolean) {
    const hit = merged.get(key);
    if (hit) return hit;
    const m = reclass(source.get(mesh)!);
    if (framed) attachOps(m, mesh);
    m.opacityNode = glassFillOpacity() as any;
    // always transparent; flipping it would force a recompile
    m.transparent = true;
    const mat = m as unknown as THREE.Material;
    merged.set(key, mat);
    return mat;
  }

  /** Add ink edge lines to `mesh` (geometry cached per mesh). */
  function addLine(mesh: THREE.Mesh) {
    if (!hasInkEdgeLine(mesh.name)) return;
    let geo = edgeGeo.get(mesh.id);
    if (!geo) {
      geo = edgeGeometry(mesh);
      edgeGeo.set(mesh.id, geo);
    }
    const line = new THREE.LineSegments(
      geo,
      lineMaterial(mesh, hasOpFrames(mesh)),
    );
    line.raycast = () => {};
    line.userData.lensExtra = true; // not a model piece (see integrate)
    line.visible = inkOn;
    mesh.add(line);
    inkLines.push(line);
  }

  /** Build the edge lines the first time ink shows (they're expensive). */
  function ensureLines() {
    if (linesBuilt) return;
    linesBuilt = true;
    for (const mesh of worn.keys()) addLine(mesh);
  }

  /** Remove this module's lines from `mesh` (bench looks add their own). */
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
      // skip added extras; can't test parent-is-Mesh (Mount_Contacts is one)
      if (!(o instanceof THREE.Mesh) || o.userData.lensExtra) return;
      const fresh = !source.has(o);
      if (fresh) source.set(o, o.material as THREE.Material);
      const before = keyed.get(o);
      style(o);
      // key changed (e.g. frames arrived): re-cut its lines
      if (linesBuilt && before !== keyed.get(o)) {
        if (!fresh) dropLines(o);
        addLine(o);
      }
    });
  }

  function wear() {
    for (const mesh of worn.keys()) mesh.material = current(mesh);
  }

  /** The only writer of `transparent` on the body materials. */
  const writeTransparent = () => {
    const on = bodyTransparent(inkOn, fadeOn);
    for (const m of flips) m.transparent = on;
  };

  function bodyFadeActive(on: boolean) {
    if (on === fadeOn) return;
    fadeOn = on;
    writeTransparent();
    // swap the twin off before the fade captures materials
    resolveBody();
  }

  function setInk(v: number) {
    const k = clamp01(v);
    if (k === inkAmount) return;
    inkAmount = k;
    uInk.value = k;
    const on = k > 0;
    if (on !== inkOn) {
      inkOn = on;
      if (on) ensureLines();
      writeTransparent();
      for (const l of inkLines) l.visible = on;
    }
    const glassOn = k >= GLASS_HANDOVER;
    if (glassOn !== glassInkOn) {
      glassInkOn = glassOn;
      for (const [mesh, w] of worn) if (w.ink) mesh.material = current(mesh);
    }
    // same call as the uniform write, so no frame sees them disagree
    resolveBody();
  }

  /** Pick blend or twin for the body; re-dress the meshes if it changed. */
  function resolveBody() {
    // the unlit twin is worn at exactly uInk = 1, and never during a body fade
    bodyLook = inkAmount === 1 && !fadeOn ? "ink" : "blend";
    const key = `${bodyLook}|${bodyCtx}`;
    if (key === dressed) return;
    dressed = key;
    for (const [mesh, w] of worn) {
      // skip meshes wearing a bench look
      if (!w.body || !ours(mesh, w.body)) continue;
      mesh.material = current(mesh);
    }
  }

  /** is `mesh` wearing one of its own body materials right now? */
  const ours = (mesh: THREE.Mesh, b: BodyMats) =>
    mesh.material === b.blend || mesh.material === b.ink;

  function syncBody(ctx: RenderCtx) {
    bodyCtx = ctx;
    resolveBody();
  }

  /** Compile the twins in `ctx` by wearing them for one draw (with hidden body
   *  meshes shown), then restore everything. */
  function warmBodyLooks(ctx: RenderCtx, draw: () => boolean) {
    ensureTwins();
    const was = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    for (const mesh of worn.keys()) was.set(mesh, mesh.material);
    const shown: THREE.Object3D[] = [];
    for (const [mesh, w] of worn) {
      if (!w.body) continue;
      // including hidden ancestors
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
    if (!drawn) return;
    for (const rec of bodyMats.values())
      if (!rec.warm[ctx]) {
        rec.warm[ctx] = true;
        coldKeys[ctx]--;
      }
    dressed = "";
    resolveBody();
  }

  function setTheme(l: boolean) {
    if (l === light) return;
    light = l;
    for (const t of tints) t.color.setHex(l ? t.light : t.dark);
  }

  integrate(root);

  return {
    integrate,
    wear,
    setInk,
    bodyFadeActive,
    ownsTransparent: (m) => flips.has(m) || twins.has(m),
    ink: () => inkAmount,
    syncBody,
    warmBodyLooks,
    needsWarm: (ctx) => coldKeys[ctx] > 0,
    setTheme,
  };
}
