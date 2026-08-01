import * as THREE from "three/webgpu";
import {
  uniform,
  float,
  vec3,
  vec4,
  mix,
  clamp,
  smoothstep,
  step,
  positionLocal,
  modelWorldMatrix,
  modelWorldMatrixInverse,
} from "three/tsl";

// ============================================================================
// GENIE — the macOS dock-minimize effect as a TSL vertex warp, over the WHOLE
// model (not just the bloom wedges): every vertex funnels toward a target
// point in MODEL space (the gltfScene frame — optical axis = Y, mm).
//
// Construction (the classic two-rail genie, done per vertex):
//   Each axial slice of the model gets its own swallow progress — a front
//   sweeps from the target-side end (staggered by GENIE_SPREAD), so entry
//   slices lead and the far end holds until late. The travel term is the
//   front's progress SQUARED (zero tangent at 0 — material that hasn't been
//   reached holds its seated shape, then whips in; a linear blend lurched the
//   whole model toward the throat at once). A slice's CENTRE travels a
//   quadratic bezier from its rest axis point through a control point pulled
//   toward the target (the signature curved swoosh) while its cross-section
//   scales toward a near-zero mouth. Because the progress is monotone along
//   the axis, the in-between material traces the bezier as a smoothly
//   tapering curved stream — the genie funnel. At uGenie = 1 every slice
//   sits collapsed at the target.
//
// FRAME: vertices are taken to the TRUE model frame (mesh local → world via
// modelWorldMatrix, then world → model via the shared uGenieFrameInv uniform,
// and back after the warp), so parts whose local frame is NOT the model frame
// (the iris blades about their pivots, the re-parented lead screw) funnel to
// the same mouth as everything else instead of hovering pivot-offset beside
// it. core/rig refreshes the frame uniforms each driven frame.
//
// COMPOSITION ORDER: the warp applies to the CURRENT deformed position — in
// the bloom graph it composes LAST, after cardify (materials/bloom.ts), so
// the funnel sucks whatever the current look is (sheets, cards, formations).
// Non-bloom materials (glass, solids, lines, hulls) get it via attachGenie /
// attachGenieToModel, wrapping their existing positionNode.
//
// IDENTITY: at uGenie = 0 the swallow progress is 0 for every vertex (the
// warp reduces to a pass-through), and the hard idle gate (step) selects the
// untouched INPUT position outright — no matrix roundtrip, no trig residue;
// the seated render and the instrument hash stay bit-exact.
//
// NORMALS are left untouched (approximate on purpose): the effect lives in
// flat/ink-style compositions where shading error in the funnel is invisible,
// and the squeezed material is mostly silhouette.
// ============================================================================

/** 0 (rest, hard-gated exact identity) .. 1 (fully collapsed at the target). */
export const uGenie = uniform(0);
/** The funnel target ("dock point"), MODEL space (mm, optical axis = Y). */
export const uGenieTarget = uniform(new THREE.Vector3(0, 120, 40));
/** Rank band soloing which SHELLS genie (bloom wedges only — non-bloom meshes
 *  always follow the full channel, like every other wedge-level mask). Defaults
 *  fully open = whole model. */
export const uGenieRankLo = uniform(0);
export const uGenieRankHi = uniform(1);
export const GENIE_RANK_FEATHER = 0.08;

// The model frame (gltfScene local → world) and its inverse, shared by every
// material; refreshed by core/rig each driven frame (updateGenieFrame).
const uGenieFrame = uniform(new THREE.Matrix4());
const uGenieFrameInv = uniform(new THREE.Matrix4());

/** Refresh the shared model-frame uniforms from the live gltf root. Called by
 *  core/rig.update once per driven frame (cheap: one 4×4 invert). */
export function updateGenieFrame(modelRoot: THREE.Object3D): void {
  uGenieFrame.value.copy(modelRoot.matrixWorld);
  uGenieFrameInv.value.copy(modelRoot.matrixWorld).invert();
}

const MODEL_H_MM = 76.5; // axial extent (mount y=0 → filter y=76.5)
// Axial stagger of the swallow front: slice a's progress is g·(1+S) − a·S, so
// the entry end leads and the far end starts moving at g = S/(1+S). Large on
// purpose — the far end stays visually ANCHORED (the intact "window") through
// most of the scrub while the entry end streams into the dock; the tail of
// the scrub then sweeps the rest through in one rush, like the real thing.
const GENIE_SPREAD = 1.6;
// Control-point pull toward the target (0 = bend at the entry end's axis
// point, 1 = straight line to the target). Sets how round the swoosh is.
const GENIE_CTRL = 0.1;
// Residual cross-section scale at the mouth — never exactly 0 (degenerate
// triangles shimmer); visually a point.
const GENIE_MOUTH = 0.04;

// TSL nodes carry math methods the .d.ts doesn't declare; `any` is the escape
// hatch (house style — see materials/formation.ts).
type Node = any;

/**
 * Warp a (possibly already-deformed) local-space position through the genie
 * funnel. `mask` is a per-vertex 0..1 factor (bloom.ts feeds the rank band;
 * non-bloom attaches pass 1) — masked-out material stays exactly put.
 */
export function genieWarp(pos: Node, mask: Node = float(1)): Node {
  const T = uGenieTarget as Node;
  const g = uGenie as Node;
  // mesh local → the TRUE model frame (see the FRAME note above)
  const mp: Node = (uGenieFrameInv as Node).mul(
    (modelWorldMatrix as Node).mul(vec4(pos, 1)),
  ).xyz;
  const aRaw: Node = clamp(mp.y.div(MODEL_H_MM), 0.0, 1.0);
  // entry end = the axial end nearest the target: target beyond the model's
  // mid ⇒ the front (y = H) leads, else the mount (y = 0) leads
  const entrySel: Node = step(MODEL_H_MM * 0.5, T.y);
  const a: Node = mix(aRaw, float(1).sub(aRaw), entrySel);
  const wRaw: Node = smoothstep(
    0.0,
    1.0,
    clamp(g.mul(1 + GENIE_SPREAD).sub(a.mul(GENIE_SPREAD)), 0.0, 1.0),
  ).mul(mask);
  // Travel progress is w² — ZERO tangent at 0, so not-yet-swallowed material
  // holds its seated shape and then whips into the funnel as its front
  // arrives (see the header).
  const w: Node = wRaw.mul(wRaw);
  // quadratic bezier from the slice's rest axis point through the pulled
  // control toward the target — the curved path every slice centre rides
  const yEntry: Node = entrySel.mul(MODEL_H_MM);
  const C: Node = mix(vec3(0, yEntry, 0), T, GENIE_CTRL);
  const iw: Node = float(1).sub(w);
  const B: Node = vec3(0, mp.y, 0)
    .mul(iw.mul(iw))
    .add(C.mul(w.mul(iw).mul(2)))
    .add(T.mul(w.mul(w)));
  // width taper: monotone in w (hence in a) ⇒ a smooth funnel neck
  const k: Node = float(1).sub(w.mul(1 - GENIE_MOUTH));
  const warpedModel: Node = B.add(vec3(mp.x, 0, mp.z).mul(k));
  // model frame → back to this mesh's local frame
  const warped: Node = (modelWorldMatrixInverse as Node).mul(
    (uGenieFrame as Node).mul(vec4(warpedModel, 1)),
  ).xyz;
  // hard idle gate: uGenie = 0 selects the untouched input outright
  return mix(pos, warped, step(1e-6, g));
}

// One attach per material — shared materials (the mode caches, the loader's
// signature cache) come through attachGenieToModel once per unique instance.
const attached = new WeakSet<THREE.Material>();

/** Wrap a Node material's position graph in the genie warp (mask = 1: the
 *  whole mesh follows the channel). For bloom-carrying materials do NOT call
 *  this — the bloom graph composes the warp itself (with the rank band). */
export function attachGenie(material: THREE.NodeMaterial): void {
  if (attached.has(material)) return;
  attached.add(material);
  material.positionNode = genieWarp(
    (material.positionNode as Node) ?? (positionLocal as Node),
  );
}

/**
 * Attach the genie warp to every NON-bloom mesh material under `root` (the
 * authored glass, iris metal, and the loader's stylized solids — everything
 * whose position graph the bloom pipeline doesn't own). Idempotent per
 * material; re-run after late merges (the background accessories).
 */
export function attachGenieToModel(root: THREE.Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    if (o.geometry.getAttribute("_bloomr")) return; // bloom graph owns it
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) attachGenie(m as THREE.NodeMaterial);
  });
}
