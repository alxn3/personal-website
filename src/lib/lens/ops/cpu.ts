// The op deform on the CPU, at any point of a piece: runs the generated JS
// deform (ops/emit/deform.js.ts, same source as the shader). Allocation-free.

import type * as THREE from "three/webgpu";
import { NUM } from "./algebra";
import { makeRecipes, type Recipe } from "./recipes";
import { LAYOUT } from "./emit/layout";
import { opsFold } from "./emit/deform.js";
import { frameOf, packFlags } from "./frames";
import {
  IDLE_EPS,
  opsSpinBox,
  packedUniforms,
  recipeChannels,
  recipeKnobs,
  RECIPE_NAMES,
} from "./host";

export { IDLE_EPS };

/** The numeric recipes, built on first use. */
let recipes: Record<Recipe<number>["name"], Recipe<number>> | null = null;
const recipesOf = () => (recipes ??= makeRecipes<number>(NUM));

/** A position delta, xyz. */
export type Delta = [number, number, number];

/** A recipe's channel and knob values; missing knobs use their defaults. */
export interface LiveRecipe {
  recipe: Recipe<number>;
  channel: number;
  knobs: Record<string, number>;
}

/** The summed delta at a point of one piece, in mesh-local space; writes and
 *  returns `out`. */
type PieceField = (qx: number, qy: number, qz: number, out: Delta) => Delta;

/** One piece's `_op*` frame values, unpacked. */
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
  /** Packed fade lane (core/visibility.ts); not used by the deform. */
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

/** Pack a piece's values into the three vec4s the deform reads. */
function packLanes(l: PieceLanes): [V4, V4, V4] {
  return [
    v4(l.t0, l.R, l.halfSpan * 2, l.rank01),
    v4(l.layerPhase, l.partClass, l.rung, packFlags(l.axi, l.adopted)),
    v4(l.yMin, l.yMax, l.depth, l.wink),
  ];
}

/** Pack recipe values into channel and knob uniforms (missing = idle/default). */
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

/** The deform field over fixed lanes and uniforms. */
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

/** The deform field of one piece for the given recipe values. */
export function pieceField(lanes: PieceLanes, live: LiveRecipe[]): PieceField {
  const { ch, k } = packLive(live);
  return fieldOf(packLanes(lanes), ch, k);
}

/** Snapshot of the recipes currently active, with their knob values. */
export function liveRecipes(): LiveRecipe[] {
  const ch = recipeChannels();
  const live: LiveRecipe[] = [];
  for (const name of RECIPE_NAMES) {
    const channel = ch[name].value;
    if (channel < IDLE_EPS) continue;
    const knobs = Object.fromEntries(
      Object.entries(recipeKnobs()[name]).map(([k, box]) => [k, box.value]),
    );
    live.push({ recipe: recipesOf()[name], channel, knobs });
  }
  return live;
}

/** Frame values of the piece owning vertex `i`, or null if the geometry has none. */
export function lanesAt(
  geo: THREE.BufferGeometry,
  i: number,
): PieceLanes | null {
  const f = frameOf(geo, i);
  if (!f) return null;
  const { span, rank, phase, cls, ...rest } = f;
  return {
    ...rest,
    halfSpan: span * 0.5,
    rank01: rank,
    layerPhase: phase,
    partClass: cls,
  };
}

/** For a geometry, a function from vertex index to the deform field of that
 *  vertex's piece; null if the geometry has no frames. */
export function pieceFields(
  geo: THREE.BufferGeometry,
  live: LiveRecipe[],
): ((vertex: number) => PieceField) | null {
  if (!lanesAt(geo, 0)) return null;
  const { ch, k } = packLive(live);
  return (i) => fieldOf(packLanes(lanesAt(geo, i)!), ch, k);
}

/** Undo a spin pivot's rotation on a delta, in place (see host.ts spin pivots).
 *  No-op for untagged meshes. */
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

interface PointDisplacer {
  /** Move a seated mesh-local point by the deform, in place. */
  displace(point: THREE.Vector3): THREE.Vector3;
}

/** Displace points by a mesh's live deform, for use in the frame loop. Uses the
 *  piece of vertex 0; identity for a mesh without frames. */
export function seatedPointDisplacer(mesh: THREE.Mesh): PointDisplacer {
  const lanes = lanesAt(mesh.geometry, 0);
  if (!lanes) return { displace: (point) => point };
  const [a, b, y] = packLanes(lanes);
  const { channels: ch, knobs: k } = packedUniforms;
  return {
    displace(point) {
      if (ch.x < IDLE_EPS && ch.y < IDLE_EPS && ch.z < IDLE_EPS && ch.w < IDLE_EPS) return point; // prettier-ignore
      const d = unspinDelta(mesh, opsFold(point, a, b, y, ch, k, scratchOut));
      return point.set(point.x + d[0], point.y + d[1], point.z + d[2]);
    },
  };
}
