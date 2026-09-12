import type * as THREE from "three/webgpu";
import { NUM } from "./algebra";
import { makeRecipes, type Recipe } from "./recipes";
import { LAYOUT } from "./emit/layout";
import { opsFold } from "./emit/deform.js";
import { packFlags, unpackFlags } from "./frames";
import {
  IDLE_EPS,
  opsSpinBox,
  packedUniforms,
  recipeChannels,
  recipeKnobs,
  RECIPE_NAMES,
} from "./host";

// CPU EVALUATION OF THE OP DEFORM at an ARBITRARY POINT of a piece: the
// emitted chain on its JS dialect (ops/emit/deform.js.ts) — the same source
// the shader runs — over the packed frame lanes and uniforms. No per-point
// allocation: every input is a reused object and the fold writes an out-param.

export { IDLE_EPS };

const RECIPES = makeRecipes<number>(NUM);

/** A summed position delta, xyz. Callers own the array (no allocation). */
export type Delta = [number, number, number];

/** One recipe of a SNAPSHOT: its channel and knob values as plain numbers. A
 *  knob left out rests at the recipe's default. */
export interface LiveRecipe {
  recipe: Recipe<number>;
  channel: number;
  knobs: Record<string, number>;
}

/** The summed, hard-gated delta at an arbitrary point of one piece, in the
 *  mesh's own LOCAL space. Written into `out`, which is returned. */
export type PieceField = (
  qx: number,
  qy: number,
  qz: number,
  out: Delta,
) => Delta;

/** The packed `_op*` lanes of one piece, as ops/frames.ts wrote them. */
export interface PieceLanes {
  t0: number;
  R: number;
  halfSpan: number;
  rank01: number;
  layerPhase: number;
  partClass: number;
  rung: number;
  axi: number;
  yMin: number;
  yMax: number;
  depth: number;
  adopted: number;
  /** the packed wink lane (core/visibility.ts) — the materials' term, not the
   *  deform's */
  wink: number;
}

interface V4 {
  x: number;
  y: number;
  z: number;
  w: number;
}
const v4 = (x = 0, y = 0, z = 0, w = 0): V4 => ({ x, y, z, w });
const COMP = ["x", "y", "z", "w"] as const;

/** The `a`/`b`/`y` vec4s of a piece — the attribute lanes the fold reads. */
function packLanes(l: PieceLanes): [V4, V4, V4] {
  return [
    v4(l.t0, l.R, l.halfSpan * 2, l.rank01),
    v4(l.layerPhase, l.partClass, l.rung, packFlags(l.axi, l.adopted)),
    v4(l.yMin, l.yMax, l.depth, l.wink),
  ];
}

/** The channel and knob uniforms a snapshot describes: an absent recipe is
 *  idle, an absent knob rests at its default. */
function packLive(live: LiveRecipe[]): { ch: V4; k: V4[] } {
  const ch = v4();
  const k = Array.from({ length: LAYOUT.vec4Count }, () => v4());
  const knobsOf = new Map(live.map((l) => [l.recipe.name, l.knobs]));
  for (const l of live)
    ch[COMP[LAYOUT.names.indexOf(l.recipe.name)]] = l.channel;
  for (const name of RECIPE_NAMES) {
    const knobs = knobsOf.get(name);
    for (const kn of LAYOUT.knobNames[name]) {
      const lane = LAYOUT.knob[name][kn];
      k[lane.vec4][COMP[lane.lane]] =
        knobs?.[kn] ?? LAYOUT.spec[name][kn].default;
    }
  }
  return { ch, k };
}

const scratchP = { x: 0, y: 0, z: 0 };
const scratchOut = new Float64Array(4);

/** The field over fixed lanes and uniforms; `out` takes the delta's xyz. */
function fieldOf(
  [a, b, y]: [V4, V4, V4],
  ch: V4,
  k: ArrayLike<V4>,
): PieceField {
  return (qx, qy, qz, out) => {
    scratchP.x = qx;
    scratchP.y = qy;
    scratchP.z = qz;
    opsFold(scratchP, a, b, y, ch, k, scratchOut);
    out[0] = scratchOut[0];
    out[1] = scratchOut[1];
    out[2] = scratchOut[2];
    return out;
  };
}

/** The field of one piece from its lanes and a SNAPSHOT of live recipes. */
export function pieceField(lanes: PieceLanes, live: LiveRecipe[]): PieceField {
  const { ch, k } = packLive(live);
  return fieldOf(packLanes(lanes), ch, k);
}

/** One recipe's knob values as plain numbers, read off the host's boxes. */
function knobValues(
  name: (typeof RECIPE_NAMES)[number],
): Record<string, number> {
  const boxes = recipeKnobs()[name];
  const knobs: Record<string, number> = {};
  for (const k in boxes) knobs[k] = boxes[k].value;
  return knobs;
}

/** The recipes currently OFF their seat, as a SNAPSHOT of the host's channel
 *  and knob values. */
export function liveRecipes(): LiveRecipe[] {
  const ch = recipeChannels();
  const live: LiveRecipe[] = [];
  for (const name of RECIPE_NAMES) {
    const channel = ch[name].value;
    if (channel < IDLE_EPS) continue;
    live.push({ recipe: RECIPES[name], channel, knobs: knobValues(name) });
  }
  return live;
}

/** The lanes of the piece owning vertex `i`, or null when the geometry carries
 *  no `_op*` attributes. */
export function lanesAt(
  geo: THREE.BufferGeometry,
  i: number,
): PieceLanes | null {
  // Packed frame lanes: A = (t0, R, span, rank), B = (phase, class, rung,
  // flags), Y = (yMin, yMax, depth, wink).
  const fa = geo.getAttribute("_opA");
  const fb = geo.getAttribute("_opB");
  const fy = geo.getAttribute("_opY");
  if (!fa || !fb || !fy) return null;
  const { axi, adopted } = unpackFlags(fb.getW(i));
  return {
    t0: fa.getX(i),
    R: fa.getY(i),
    halfSpan: fa.getZ(i) * 0.5,
    rank01: fa.getW(i),
    layerPhase: fb.getX(i),
    partClass: fb.getY(i),
    rung: fb.getZ(i),
    axi,
    yMin: fy.getX(i),
    yMax: fy.getY(i),
    depth: fy.getZ(i),
    adopted,
    wink: fy.getW(i),
  };
}

/**
 * Bind `geo`'s frame lanes: hands back the deform field of the piece owning a
 * given VERTEX index, or `null` when the geometry carries no `_op*` attributes.
 * Per vertex, because a mesh can carry several pieces; lanes are constant
 * within one piece, so the field can be sampled at non-vertex points.
 */
export function pieceFields(
  geo: THREE.BufferGeometry,
  live: LiveRecipe[],
): ((vertex: number) => PieceField) | null {
  if (!lanesAt(geo, 0)) return null;
  const { ch, k } = packLive(live);
  return (i) => fieldOf(packLanes(lanesAt(geo, i)!), ch, k);
}

/**
 * host.ts's `unspinY` on numbers, in place: a mesh under an off-axis spin pivot
 * has its delta added INSIDE the pivot's rotation, so the delta must be un-spun
 * by the pivot's live angle. Identity for untagged meshes.
 */
export function unspinDelta<D extends Delta | Float64Array>(
  mesh: THREE.Object3D | null | undefined,
  d: D,
): D {
  const theta = (mesh && opsSpinBox(mesh)?.value) || 0;
  if (theta === 0) return d;
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const x = d[0];
  const z = d[2];
  d[0] = x * c - z * s;
  d[2] = x * s + z * c;
  return d;
}

// ── The frame-loop reader ───────────────────────────────────────────────────

export interface PointDisplacer {
  /** Displace ONE point of the mesh's SEATED geometry: mesh-LOCAL in, mesh-LOCAL
   *  out (written in place); callers take it to world via `matrixWorld`. */
  displace(point: THREE.Vector3): THREE.Vector3;
}

/**
 * A mesh's point displacer against the host's LIVE channels and knobs, read
 * at each call straight off the packed uniforms. Lanes come from VERTEX 0, so
 * on a multi-piece mesh this is the field of its FIRST piece; a mesh without
 * `_op*` attributes gets the identity.
 */
export function seatedPointDisplacer(mesh: THREE.Mesh): PointDisplacer {
  const lanes = lanesAt(mesh.geometry, 0);
  if (!lanes) return { displace: (point) => point };
  const [a, b, y] = packLanes(lanes);
  const { channels: ch, knobs: k } = packedUniforms;
  return {
    displace(point) {
      // the hard idle gate: nothing moved, so the point is returned untouched
      if (ch.x < IDLE_EPS && ch.y < IDLE_EPS && ch.z < IDLE_EPS && ch.w < IDLE_EPS) return point; // prettier-ignore
      const d = unspinDelta(mesh, opsFold(point, a, b, y, ch, k, scratchOut));
      return point.set(point.x + d[0], point.y + d[1], point.z + d[2]);
    },
  };
}
