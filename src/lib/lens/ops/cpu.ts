import type * as THREE from "three/webgpu";
import { NUM } from "./algebra";
import { gate } from "./gate";
import {
  runPipeline,
  type OpCtx,
  type PieceFrame,
  type VertexState,
} from "./ops";
import { makeRecipes, type Recipe } from "./recipes";
import { WRAP_DIR } from "./house";
import {
  opsSpinBox,
  recipeChannels,
  recipeKnobs,
  RECIPE_NAMES,
} from "./host";

// CPU EVALUATION OF THE OP DEFORM — the field ops/host.ts builds as a shader
// graph, evaluated on the `NUM` backend at an ARBITRARY POINT of a piece.
//
// The op algebra is backend-agnostic below ops/host.ts, so the recipes, the
// gate and the pipeline runner all run here UNCHANGED. The only thing restated
// is host.ts's `fold()` PREAMBLE — the seated cylindrical mapping, the material
// coordinates, the seeded vertex state, the per-recipe gate/ctx assembly, the
// summed delta and the spin-pivot counter-rotation. IF `fold()` CHANGES SHAPE
// THIS PREAMBLE MUST FOLLOW IT; nothing enforces that automatically.
//
// The mirror exists because two callers need a value the GPU cannot hand back
// in time: dev/inspect.ts raycasts against displaced positions for every vertex
// (one probe sample per texel is past the backend's max texture dimension, and
// the inspector holds no renderer anyway), and story/cinematics.ts threads the
// refraction rays through each glass element's CENTRE, which is not a vertex.

const A = NUM;
const RECIPES = makeRecipes<number>(A);

// Mirrors of host.ts's fold() constants — same names, same values.
const TAU = 6.283185307179586;
const HOUSE_FROM = -1;
/** host.ts's hard idle gate. Exported so a second caller assembling a live set
 *  (story/flow.ts) skips an idle recipe by THIS number, not a copy of it. */
export const IDLE_EPS = 1e-6;

const wrapPi = (x: number) => x - TAU * Math.floor((x + Math.PI) / TAU);

/** A summed position delta, xyz. Callers own the array so a per-vertex (or
 *  per-frame) evaluation allocates nothing. */
export type Delta = [number, number, number];

export interface LiveRecipe {
  recipe: Recipe<number>;
  channel: number;
  knobs: Record<string, number>;
}

/** The recipes currently OFF their seat. A channel below the hard idle gate
 *  contributes EXACTLY zero to the render, so skipping it is not an
 *  approximation. Scoped to the scene's ACTIVE set (null = all): a recipe the
 *  host never folded into the material graphs contributes nothing whatever its
 *  channel reads, so folding it here would over-displace. */
export function liveRecipes(): LiveRecipe[] {
  const ch = recipeChannels();
  const kn = recipeKnobs();
  const live: LiveRecipe[] = [];
  for (const name of RECIPE_NAMES) {
    const channel = ch[name].value;
    if (channel < IDLE_EPS) continue;
    live.push({
      recipe: RECIPES[name],
      channel,
      knobs: Object.fromEntries(
        Object.entries(kn[name]).map(([k, box]) => [k, box.value]),
      ),
    });
  }
  return live;
}

/** The summed, hard-gated delta the deform produces AT AN ARBITRARY POINT of
 *  one piece, in the mesh's own LOCAL space (host.ts's `sampleAt`). Written
 *  into `out`, which is returned. */
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
  layerN: number;
  adopted: number;
}

/** THE FIELD OF ONE PIECE, from its lanes alone — host.ts's `fold()` preamble
 *  bound to a piece and a live recipe set, and the one place the mirror is
 *  written. Pure: same lanes, same live set, same point ⇒ same delta. Exported
 *  for story/flow.ts, which builds lanes from the frame attributes and probes
 *  points that are not vertices. */
export function pieceField(lanes: PieceLanes, live: LiveRecipe[]): PieceField {
  const {
    t0,
    R,
    halfSpan,
    rank01,
    layerPhase,
    partClass,
    rung,
    axi,
    yMin,
    yMax,
    layerN,
    adopted,
  } = lanes;
  const yMid = (yMin + yMax) * 0.5;
  // The piece frame spatial selectors track: the piece's own seated centre.
  const frame0: PieceFrame<number> = {
    x: R * Math.cos(t0),
    z: R * Math.sin(t0),
    axial: yMid,
    orient: t0, // the piece's working direction: its own meridian
  };
  return (qx, qy, qz, out) => {
    // The ONE mapping point: optical axis = Y, radial plane = X–Z.
    const theta = Math.atan2(qz, qx);
    const radius = Math.hypot(qx, qz);
    const phi = wrapPi(theta - t0);
    const seated: VertexState<number> = {
      x: qx,
      z: qz,
      axial: qy,
      rot: 0,
      aim: t0,
      rem: 0,
    };
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    for (const { recipe, channel, knobs } of live) {
      // The spec is captured once and the ctx carries a closure over it, so a
      // `during` scope re-runs the SAME gate at its own channel.
      const spec = recipe.gateSpec(knobs);
      const gateAt = (c: number): { flight: number; stick: number } =>
        gate(A, spec, c, { rank01, layerPhase });
      const g = gateAt(channel);
      const ctx: OpCtx<number> = {
        A,
        t0,
        R,
        rank01,
        layerPhase,
        halfSpan,
        partClass,
        phi,
        d: R * (phi * HOUSE_FROM + halfSpan),
        L: R * halfSpan * 2,
        yN: (qy - yMin) / Math.max(yMax - yMin, 1e-6) - 0.5,
        off: radius - R,
        rung,
        axi,
        layerN,
        adopted,
        channel,
        gateAt,
        flight: g.flight,
        stick: g.stick,
        wrapDir: WRAP_DIR,
      };
      // The pipeline validator is skipped on purpose: it is a once-per-recipe
      // authoring advisory host.ts already ran, and this is a per-vertex loop.
      const v = runPipeline(recipe.build(ctx, knobs), seated, frame0, ctx).v;
      out[0] += v.x - qx;
      out[1] += v.axial - qy;
      out[2] += v.z - qz;
    }
    return out;
  };
}

/**
 * Bind `geo`'s frame lanes: hands back the deform field of the piece owning any
 * given VERTEX index, or `null` when the geometry carries no `_op*` attributes.
 * PER VERTEX, because a mesh can carry SEVERAL pieces; within one piece every
 * lane is a CONSTANT on all its vertices, which is what lets a caller evaluate
 * the field at a point that is not a vertex at all.
 */
export function pieceFields(
  geo: THREE.BufferGeometry,
  live: LiveRecipe[],
): ((vertex: number) => PieceField) | null {
  // Packed frame lanes: A = (t0, R, span, rank), B = (phase, class, rung, axi),
  // Y = (yMin, yMax, layerN, adopted).
  const fa = geo.getAttribute("_opA");
  const fb = geo.getAttribute("_opB");
  const fy = geo.getAttribute("_opY");
  if (!fa || !fb || !fy) return null;
  return (i) =>
    pieceField(
      {
        t0: fa.getX(i),
        R: fa.getY(i),
        halfSpan: fa.getZ(i) * 0.5,
        rank01: fa.getW(i),
        layerPhase: fb.getX(i),
        partClass: fb.getY(i),
        rung: fb.getZ(i),
        axi: fb.getW(i),
        yMin: fy.getX(i),
        yMax: fy.getY(i),
        layerN: fy.getZ(i),
        adopted: fy.getW(i),
      },
      live,
    );
}

/**
 * host.ts's `unspinY` on numbers, in place: a mesh under an OFF-AXIS mechanism
 * spin pivot has its delta added INSIDE the pivot's rotation, so the delta must
 * be un-spun by the pivot's live angle. Identity for every untagged mesh.
 */
export function unspinDelta(
  mesh: THREE.Object3D | null | undefined,
  d: Delta,
): Delta {
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

const pointDelta: Delta = [0, 0, 0];

/**
 * Displace ONE point of `mesh`'s SEATED geometry the way the shader displaces
 * the surface around it: mesh-LOCAL in, mesh-LOCAL out (written in place). Take
 * it to world through the mesh's own `matrixWorld` as the render does —
 * object-level motion is not this field's business.
 *
 * The lanes come from VERTEX 0, so on a multi-piece mesh this is the field of
 * its FIRST piece. THE SMOOTH FIELD, not the decal binding, which is recorded
 * per VERTEX and has no meaning at a point between them.
 */
export function displaceSeatedPoint(
  mesh: THREE.Mesh,
  point: THREE.Vector3,
): THREE.Vector3 {
  const live = liveRecipes();
  if (live.length === 0) return point; // the hard idle gate: nothing moved
  const fieldAt = pieceFields(mesh.geometry, live);
  if (!fieldAt) return point;
  const d = unspinDelta(
    mesh,
    fieldAt(0)(point.x, point.y, point.z, pointDelta),
  );
  return point.set(point.x + d[0], point.y + d[1], point.z + d[2]);
}
