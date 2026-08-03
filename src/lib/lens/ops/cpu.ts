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
import {
  getActiveRecipes,
  opsSpinBox,
  recipeChannels,
  recipeKnobs,
  RECIPE_NAMES,
} from "./host";

// ============================================================================
// CPU EVALUATION OF THE OP DEFORM — the field ops/host.ts builds as a shader
// graph, evaluated on the `NUM` backend at an ARBITRARY POINT of a piece.
//
// The op algebra is backend-agnostic below ops/host.ts, so the recipes, the
// gate and the pipeline runner all run here UNCHANGED; the only thing this
// module restates is host.ts's `fold()` PREAMBLE — the seated cylindrical
// mapping, the material coordinates, the seeded vertex state (including the
// working direction `aim = t0` and the empty chain cursor `rem = 0`), the
// per-recipe gate/ctx assembly, the summed delta and the spin-pivot
// counter-rotation.
//
// That restatement is a mirror, which this stack normally refuses (see
// dev/path-probe.ts: it probes the GPU precisely so no CPU copy can drift).
// Two things force it, and both need a value the GPU cannot hand back in time:
//
//   • dev/inspect.ts needs DISPLACED positions for every one of ~128k vertices
//     to raycast against, and the GPU probe lays one sample per TEXEL — a
//     128k-wide render target is past the backend's max texture dimension, and
//     the inspector has no renderer handle to run a probe pass with anyway.
//   • story/cinematics.ts threads the refraction rays through each glass
//     element's CENTRE, which is not a vertex at all: a Box3 reads the seated
//     CPU geometry and cannot see a positionNode displacement, so at full
//     explode the rays span the seated column while the render draws one
//     stretched tens of millimetres along the axis.
//
// If `fold()` in ops/host.ts changes shape, this preamble must follow it;
// nothing enforces that automatically.
// ============================================================================

const A = NUM;
const RECIPES = makeRecipes<number>(A);

// Mirrors of host.ts's fold() constants — same names, same values.
const TAU = 6.283185307179586;
const WRAP_DIR = -1;
const HOUSE_FROM = -1;
/** host.ts's hard idle gate is `step(1e-6, channel)`. */
const IDLE_EPS = 1e-6;

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
 *  approximation — and it is what keeps a full proxy rebuild at one recipe's
 *  cost (~100ms over the whole model) instead of all five (~1.2s).
 *
 *  Scoped to the scene's ACTIVE set (`getActiveRecipes`, null = all): a recipe
 *  the host never folded into the material graphs contributes nothing to the
 *  render whatever its channel reads, so folding it here would over-displace.
 *  The hero selects two of the five and drives one of them. */
export function liveRecipes(): LiveRecipe[] {
  const ch = recipeChannels();
  const kn = recipeKnobs();
  const live: LiveRecipe[] = [];
  for (const name of getActiveRecipes() ?? RECIPE_NAMES) {
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
interface Lanes {
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

function makeField(lanes: Lanes, live: LiveRecipe[]): PieceField {
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
    theta: t0,
    radius: R,
    axial: yMid,
    orient: t0, // the piece's working direction: its own meridian
  };
  return (qx, qy, qz, out) => {
    // The ONE mapping point: optical axis = Y, radial plane = X–Z.
    const theta = Math.atan2(qz, qx);
    const radius = Math.hypot(qx, qz);
    const phi = wrapPi(theta - t0);
    const seated: VertexState<number> = {
      theta,
      radius,
      axial: qy,
      rot: 0,
      aim: t0,
      rem: 0,
    };
    // BOTH sides of the delta go through the same reconstruction, exactly as
    // host.ts does — that is what makes an identity pipeline cancel.
    const sx = radius * Math.cos(theta);
    const sz = radius * Math.sin(theta);
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    for (const { recipe, channel, knobs } of live) {
      // Mirrors host.ts: the spec is captured once and the ctx carries a closure
      // over it, so a `during` scope re-runs the SAME gate at its own channel.
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
      // validatePipeline is skipped on purpose: it is a once-per-recipe
      // authoring advisory that ops/host.ts already ran at material build, and
      // it would fire inside a 128k-iteration loop here.
      const v = runPipeline(recipe.build(ctx, knobs), seated, frame0, ctx).v;
      out[0] += v.radius * Math.cos(v.theta) - sx;
      out[1] += v.axial - qy;
      out[2] += v.radius * Math.sin(v.theta) - sz;
    }
    return out;
  };
}

/**
 * Bind `geo`'s frame lanes: hands back the deform field of the piece owning any
 * given VERTEX index. `null` when the geometry carries no `_op*` attributes —
 * nothing for the deform to read, so nothing moves.
 *
 * PER VERTEX, because a mesh can carry SEVERAL measured pieces (ops/frames.ts
 * splits an adopted feature into islands). Within one piece every lane is a
 * CONSTANT written to all of its vertices, which is what lets a caller evaluate
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
    makeField(
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
 * host.ts's spin counter-rotation, in place: a mesh under an OFF-AXIS mechanism
 * spin pivot (only the focus lead screw) has its delta added INSIDE the pivot's
 * rotation, so the delta is un-spun by the pivot's live angle and the piece
 * spins about its own DISPLACED axis instead of orbiting its seat. The whole
 * argument is in ops/host.ts's spin-pivot note; this is `unspinY` on numbers.
 *
 * Identity — and free — for every untagged mesh.
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
 * the surface around it: mesh-LOCAL space in, the same space out (`point` is
 * written in place and returned). Take it to world through the mesh's own
 * `matrixWorld`, exactly as the render does — the object-level motion (zoom
 * slides, ring turns, the screw pivot) is not this field's business.
 *
 * The lanes come from VERTEX 0, so on a multi-piece mesh this is the field of
 * its FIRST piece; callers ask about single-piece parts (the glass elements).
 *
 * THE SMOOTH FIELD, not the decal binding: a shrink-wrapped decal's vertices
 * ride their host's rendered FACET (host.ts's wrap variant), and that binding is
 * recorded per VERTEX, so it has no meaning at a point between them. Glass
 * carries no wrap lanes at all.
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
