// pieceStateAt(p, key) — where every piece of the lens is at one scroll
// position, as plain JSON. The third instrument of the family: story/state.ts
// answers "what is the story DOING at p", story/cost.ts "what does the frame at
// p COST", this one "where is each PIECE, and how is it moving".
//
// IDENTITY. A piece is a DERIVED FRAME — the lane tuple ops/frames.ts packs
// into the `_op*` attributes at load, which is the roster the deform host
// itself uses. `buildPieceTable` reads those back off a framed scene and cuts a
// mesh into ONE PIECE PER DISTINCT LANE TUPLE; identical lanes deform
// identically, so merging two of them loses no measurement.
//
// STATE SPACE: BORE-CYLINDRICAL — (theta, radius, axial) about the optical
// axis, the algebra's OWN space, in which a world-space curve is a line or a
// ramp. Plus five shape scalars off the probe set: `roll`, the complementary
// pair `bend` / `curl`, and `stretch` / `stretchAxial`. Every one is a DELTA
// from the piece's own seat, so "at rest" is exactly zero, not approximately
// (see `restOf`). The frame is the MESH's OWN local space — the bore's for
// every node but the iris gear and blades, which are seated off the axis, so
// this mirrors the render but reports their `radius` from their own origin.
//
// EVALUATION: THE REAL PIPELINE, UNDER NUM — every number comes out of
// ops/cpu.ts's `pieceField` on the backend the recipe goldens are pinned on. No
// browser, no shader, no second model of the deform. The recipe set is the one
// the hero bakes (story/cost.ts `DEFORM_RECIPES`), driven at
// `storyStateAt(p).channels` and each recipe's `knobDefaults`.
//
// THE PROBES. Seven points: the frame ORIGIN and one ARC at each end of the
// piece's axial extent. TWO AXIAL LEVELS are what make "end to end" measurable
// — on one median plane every probe shares a `yN` and a piece bent along the
// bore reads rigid. THREE POINTS PER ARC give an END an ORIENTATION, so `bend`
// is a genuine relative rotation rather than one chord's change of angle. The
// pipeline's own rotational output is not carried here (ops/host.ts spends it
// on the shading normal), so `roll` and `bend` come from probe geometry.
//
// WHAT IT DELIBERATELY DOES NOT REPORT:
//
//   · EVERY RESIDUAL story/state.ts DECLARES — the channels are the AUTHORED
//     ones at p, so ease lag, phase clocks and mount latches all apply.
//   · THE MECHANISM DRIVES: the iris rotation and the focus screw's spin are
//     object-level transforms on their own clock, not deform terms.
//   · THE MODEL'S OWN PLACEMENT — the dolly, the body rolls and the camera are
//     story/state.ts's. This works in the gltf frame throughout (optical axis
//     +Y, radial plane X–Z, MILLIMETRES), the frame the deform is written in.
//   · AN AXISYMMETRIC PIECE'S `stretch`: its probes are a ring sample, which
//     answers to rigid motion. See `ringFramed`.
//   · A THIN PIECE'S AXIAL READINGS AT FACE VALUE — the ops normalize the axial
//     coordinate per piece (`yN`), so an axial term really does spread a
//     sub-millimetre shim a hundredfold. Read it next to the piece's extent.
//   · THE DECAL SHRINK-WRAP: a decal vertex rides its host's rendered FACET, so
//     the field probed here is the ideal curve rather than the chord.
//   · VISIBILITY. A winked-out piece still has a pose and it is reported;
//     story/cost.ts owns who is on screen.
//
// PURE. No fs, no DOM, no renderer: the roster arrives as a `PieceTable`, built
// from a framed live scene (the DEV rider) or from the shipped GLB framed in
// node (the test) — the SAME builder over the SAME `deriveFrames` output.
//
// LAZY — NEVER STATICALLY REACHABLE FROM THE HOMEPAGE, for story/state.ts's
// reason and by importing it and story/cost.ts. Reached ONLY by
// `await import("./flow")` from hero-driver's DEV block, or by a test in
// node. It must NEVER be added to index.ts.

import type * as THREE from "three/webgpu";
import { NUM } from "../ops/algebra";
import {
  IDLE_EPS,
  pieceField,
  type LiveRecipe,
  type PieceLanes,
} from "../ops/cpu";
import { makeRecipes } from "../ops/recipes";
import {
  isAccessory,
  isDecal,
  isOpticalGlass,
  isPeelExtra,
  isPeelRest,
  isPeelTube,
  isShellPart,
} from "../core/parts";
import { RANGES, holdCentreOf } from "./story";
import { COST_SAMPLE_PS, DEFORM_RECIPES } from "./cost";
import { storyStateAt } from "./state";
import { assembleKeepScopeAt } from "./envelopes";

const RECIPES = makeRecipes(NUM);

const TAU = Math.PI * 2;
const wrapPi = (x: number): number => x - TAU * Math.floor((x + Math.PI) / TAU);

// ── THE ROSTER ──────────────────────────────────────────────────────────────

/** The five families the rollups are cut by, plus the mechanism that is in none
 *  of them. These are core/visibility.ts's own wink bands under one name each,
 *  so "which cast" reads the same here as it does for who is on screen.
 *  `other` is what neither fade governs: the iris, focus train, mount, PCB. */
export type PieceCast =
  "wedges" | "decals" | "extras" | "interior" | "elements" | "other";

export const PIECE_CASTS: PieceCast[] = [
  "wedges",
  "decals",
  "extras",
  "interior",
  "elements",
  "other",
];

/** A piece's cast, from core/parts.ts's predicates in core/visibility.ts's own
 *  order. Every decal matches `isShellPart` too, which is why it is tested
 *  first. */
export function castOf(name: string): PieceCast {
  if (isOpticalGlass(name)) return "elements";
  if (isPeelTube(name) || isPeelRest(name)) return "interior";
  if (isPeelExtra(name)) return "extras";
  if (isDecal(name)) return "decals";
  if (isShellPart(name)) return "wedges";
  return "other";
}

/** One piece of the model: its identity (the derived frame), its name and its
 *  cast. Everything about it that is a property of the MODEL rather than of p. */
export interface PieceRow {
  /** unique across the table: the node name, suffixed `#i` on the six meshes
   *  whose vertices carry more than one lane tuple */
  key: string;
  /** the glTF node name — several pieces may share it */
  name: string;
  cast: PieceCast;
  lanes: PieceLanes;
}

export interface PieceTable {
  pieces: PieceRow[];
  byKey: Map<string, PieceRow>;
}

/** The lane tuple of vertex `i`, as ops/frames.ts packed it. */
function lanesAt(geo: THREE.BufferGeometry, i: number): PieceLanes | null {
  const a = geo.getAttribute("_opA");
  const b = geo.getAttribute("_opB");
  const y = geo.getAttribute("_opY");
  if (!a || !b || !y) return null;
  return {
    t0: a.getX(i),
    R: a.getY(i),
    // `_opA.z` is the piece's full angular SPAN; the ops read the half
    halfSpan: a.getZ(i) * 0.5,
    rank01: a.getW(i),
    layerPhase: b.getX(i),
    partClass: b.getY(i),
    rung: b.getZ(i),
    axi: b.getW(i),
    yMin: y.getX(i),
    yMax: y.getY(i),
    layerN: y.getZ(i),
    adopted: y.getW(i),
  };
}

/** The whole tuple, in one string. Every lane the deform reads is in it, so
 *  two vertices with the same key are two the field cannot tell apart and "one
 *  piece per distinct key" is exactly "one piece per distinct deform". A key
 *  that was not the whole tuple would silently keep whichever came first. */
const laneKey = (l: PieceLanes): string =>
  `${l.t0},${l.R},${l.halfSpan},${l.rank01},${l.layerPhase},${l.partClass},${l.rung},${l.axi},${l.yMin},${l.yMax},${l.layerN},${l.adopted}`;

/**
 * The roster, censused off a FRAMED scene graph — one `deriveFrames` has run
 * over, so every mesh carries the `_op*` attributes. A mesh with no frame is
 * skipped.
 *
 * SEVERAL PIECES PER MESH is normal: ops/frames.ts splits an adopted feature
 * mesh into ISLANDS so each screw snaps to its own wedge. Cutting on a new
 * tuple in vertex order gives one piece per DISTINCT LANE TUPLE — not one per
 * island, since adoption copies the host wedge's frame verbatim and two islands
 * on one wedge merge. Such a mesh just weighs once per frame, not per island.
 *
 * ACCESSORIES ARE NOT PIECES, and neither are the shading extras (a clone of
 * their host's geometry). Both are split off by ancestry — the rule
 * core/visibility.ts's sweep and story/cost.ts's census both use.
 */
export function buildPieceTable(root: THREE.Object3D): PieceTable {
  const pieces: PieceRow[] = [];
  const walk = (o: THREE.Object3D, underAcc: boolean): void => {
    if (o.userData?.lensExtra) return;
    const acc = underAcc || isAccessory(o.name);
    const geo = (o as THREE.Mesh).geometry;
    if (!acc && (o as THREE.Mesh).isMesh && geo) {
      const seen = new Set<string>();
      const mine: PieceLanes[] = [];
      const pos = geo.getAttribute("position");
      for (let i = 0; i < (pos?.count ?? 0); i++) {
        const lanes = lanesAt(geo, i);
        if (!lanes) break;
        const k = laneKey(lanes);
        if (seen.has(k)) continue;
        seen.add(k);
        mine.push(lanes);
      }
      const cast = castOf(o.name);
      for (const [i, lanes] of mine.entries())
        pieces.push({
          key: mine.length > 1 ? `${o.name}#${i}` : o.name,
          name: o.name,
          cast,
          lanes,
        });
    }
    for (const c of o.children) walk(c, acc);
  };
  walk(root, false);
  return { pieces, byKey: new Map(pieces.map((r) => [r.key, r])) };
}

// ── THE DEFORM AT p ─────────────────────────────────────────────────────────

/**
 * The recipes the hero's baked graph is running at p, at the channels the story
 * writes and the knobs it never touches. An IDLE recipe is dropped by the
 * host's own hard gate value (ops/cpu.ts `IDLE_EPS`): below it a recipe
 * contributes EXACTLY zero, so skipping it is not an approximation.
 */
export function liveDeformAt(p: number): LiveRecipe[] {
  const channels = storyStateAt(p).channels;
  const live: LiveRecipe[] = [];
  for (const name of DEFORM_RECIPES) {
    const channel = channels[name];
    if (channel < IDLE_EPS) continue;
    live.push({
      recipe: RECIPES[name],
      channel,
      // THE ONE KNOB THE STORY WRITES: the departure's scope, which is a pure
      // function of p (story/envelopes.ts) and therefore reportable here.
      // Everything else rests at the recipe's own defaults.
      knobs:
        name === "assemble"
          ? { ...RECIPES[name].knobDefaults, keepScope: assembleKeepScopeAt(p) }
          : RECIPES[name].knobDefaults,
    });
  }
  return live;
}

// ── ONE PIECE'S STATE ───────────────────────────────────────────────────────

/** A point in the mesh's own local space (gltf frame, mm). */
type V3 = [number, number, number];

/** One axial end of a piece: three points of its seated median circle at one
 *  axial level. Three rather than two, because three carry an ORIENTATION: the
 *  chord a→b is the tangential direction, the plane they span the normal. */
interface Arc {
  a: V3;
  m: V3;
  b: V3;
}

/** A piece's probe set: its frame ORIGIN, and one arc at each end of its own
 *  axial extent. Seven points, evaluated through the pipeline together. */
interface Probes {
  o: V3;
  lo: Arc;
  hi: Arc;
}

/** The widest half-extent a probe is placed at. An axisymmetric piece has
 *  `span = 2π`, and ±π about its meridian is the SAME point, so the probes go
 *  at the quarter turns — the widest pair that stays distinct. That makes such
 *  a piece's arcs a RING SAMPLE, which is why `stretch` is not reported for
 *  one; see `ringFramed`. */
const PROBE_SPAN_CAP = Math.PI / 2;

function probesOf(l: PieceLanes): Probes {
  const s = Math.min(l.halfSpan, PROBE_SPAN_CAP);
  const at = (theta: number, y: number): V3 => [
    l.R * Math.cos(theta),
    y,
    l.R * Math.sin(theta),
  ];
  const arc = (y: number): Arc => ({
    a: at(l.t0 - s, y),
    m: at(l.t0, y),
    b: at(l.t0 + s, y),
  });
  return {
    o: at(l.t0, (l.yMin + l.yMax) * 0.5),
    lo: arc(l.yMin),
    hi: arc(l.yMax),
  };
}

/** One piece's pose at one p, in the bore's own cylindrical coordinates. Every
 *  field but the three absolute ones is a DELTA from the piece's seat. */
export interface PieceState {
  p: number;
  key: string;
  cast: PieceCast;
  /** meridian of the piece's frame origin, radians, wrapped to (−π, π] */
  theta: number;
  /** distance from the optical axis, mm */
  radius: number;
  /** position ALONG the optical axis (the bore's own x), mm */
  axial: number;
  /** the three above, less the piece's seated values. `dTheta` is wrapped, so a
   *  piece that has gone a full turn reads 0 — `roll` and the trajectory's own
   *  continuity are where a revolution shows. */
  dTheta: number;
  dRadius: number;
  dAxial: number;
  /** straight-line distance from the seat, mm — the one scalar summary, and
   *  what the outlier lists are ranked by */
  travel: number;
  /** THE PIECE TURNING IN PLACE about the bore: the angle its tangential
   *  direction has swung out of tangential, in the local cylindrical frame AT
   *  ITS DEFORMED POSITION. A rigid revolution carries that frame with it and
   *  reads 0, so this is the motion that is not just "further round". */
  roll: number;
  /** THE PIECE'S END-TO-END RELATIVE ROTATION: the angle of the rotation taking
   *  its low-axial end's frame onto its high-axial end's. Radians, unsigned,
   *  and exactly 0 for any rigid motion. ZERO ALSO MEANS "NOT MEASURED" in the
   *  degenerate case `endTurn` names. */
  bend: number;
  /** THE PIECE'S CURL, SIGNED: how much more (or less) its arcs curve than at
   *  their seat, averaged over the two ends. Positive = tighter, negative =
   *  flattened, exactly 0 for a rigid motion.
   *
   *  `bend`'s complement: `bend` is the AXIAL reading and is a true 0 through
   *  the peel, the cards and the internals, which do the same thing to both of
   *  a piece's ends. What they do do is circumferential, and that is this
   *  column. Neither is derivable from the other. */
  curl: number;
  /** THE PIECE'S SIZE ROUND THE BORE: the deformed arcs' total pairwise
   *  separation over their seated one. 1 = rigid. NOT MEASURED for an
   *  axisymmetric piece — it reads a flat 1 there, see `ringFramed`. */
  stretch: number;
  /** THE PIECE'S SIZE ALONG THE BORE: the same ratio over the three flanks
   *  joining its two axial ends. 1 = rigid, and measured for every piece. It is
   *  a RATIO of the piece's own axial extent, so it is large where that extent
   *  is small — see the header. */
  stretchAxial: number;
}

/** The decoded cylindrical coordinates of one probe. */
const decode = (q: V3) => ({
  theta: Math.atan2(q[2], q[0]),
  radius: Math.hypot(q[0], q[2]),
  axial: q[1],
});

const sub = (u: V3, v: V3): V3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];

const add = (u: V3, v: V3): V3 => [u[0] + v[0], u[1] + v[1], u[2] + v[2]];

const len = (u: V3): number => Math.hypot(u[0], u[1], u[2]);

const dot = (u: V3, v: V3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];

const cross = (u: V3, v: V3): V3 => [
  u[1] * v[2] - u[2] * v[1],
  u[2] * v[0] - u[0] * v[2],
  u[0] * v[1] - u[1] * v[0],
];

/** `null` for a zero-length vector — the caller decides what a degenerate
 *  measurement means rather than dividing by zero into a NaN. */
function unit(u: V3): V3 | null {
  const n = len(u);
  return n > 0 ? [u[0] / n, u[1] / n, u[2] / n] : null;
}

/** One end's orientation, as an orthonormal triple: its own tangential chord,
 *  the piece's SPINE with that chord's component projected out, and their
 *  cross. `null` if either has collapsed.
 *
 *  The spine (both ends' midpoints joined) is shared by the two ends, so it
 *  contributes nothing of its own to their relative rotation — it is the common
 *  reference the tangents are read against. The arc's own plane normal would do
 *  the same job but is ill-conditioned exactly where the deform puts these
 *  pieces: an arc that flattens and curves back flips it, and `bend` jumps to
 *  π. The spine stays far from parallel and degrades gracefully. */
function frameOf(q: Arc, spine: V3): [V3, V3, V3] | null {
  const t = unit(sub(q.b, q.a));
  if (!t) return null;
  const k = dot(spine, t);
  const n = unit([
    spine[0] - k * t[0],
    spine[1] - k * t[1],
    spine[2] - k * t[2],
  ]);
  return n ? [t, n, cross(t, n)] : null;
}

/** `bend`: the angle of the rotation taking the low end's frame onto the high
 *  end's. No rest value is subtracted and none is needed — at rest the two arcs
 *  are the SAME arc at two heights, so the rest frames cancel, which is why
 *  this reads 0 for any rigid motion and not only for the seat.
 *
 *  BOTH PARTS of the rotation are read rather than the trace alone, since the
 *  trace loses half its digits near rest and this module's law is that a piece
 *  which has not moved reads EXACTLY zero.
 *
 *  THE ONE DEGENERATE CASE: if either end has no orientation there is no
 *  rotation to measure, and the 0 returned means NOT MEASURED, not "rigid". */
function endTurn(pr: Probes): number {
  const spine = sub(pr.hi.m, pr.lo.m);
  const lo = frameOf(pr.lo, spine);
  const hi = frameOf(pr.hi, spine);
  if (!lo || !hi) return 0;
  const c = dot(lo[0], hi[0]) + dot(lo[1], hi[1]) + dot(lo[2], hi[2]) - 1;
  const s = add(
    add(cross(lo[0], hi[0]), cross(lo[1], hi[1])),
    cross(lo[2], hi[2]),
  );
  return Math.atan2(len(s), c);
}

/** One arc's own turn: the angle between its two half-chords, unsigned. `curl`
 *  is the DIFFERENCE of this from its seated value, which is what carries the
 *  sign. */
function arcTurn(q: Arc): number {
  const u = unit(sub(q.m, q.a));
  const v = unit(sub(q.b, q.m));
  if (!u || !v) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot(u, v))));
}

/** Both ends' turn, averaged, so `curl` stays on the scale of one arc's turn
 *  rather than doubling with the probe count. */
const curlOf = (pr: Probes): number => (arcTurn(pr.lo) + arcTurn(pr.hi)) * 0.5;

/** The total pairwise separation inside one arc. */
const arcGirth = (q: Arc): number =>
  len(sub(q.m, q.a)) + len(sub(q.b, q.m)) + len(sub(q.b, q.a));

/** The circumferential extent: every pairwise distance inside each end's arc —
 *  `stretch`'s numerator. */
const girth = (pr: Probes): number => arcGirth(pr.lo) + arcGirth(pr.hi);

/** The axial extent: the three flanks joining the two ends — `stretchAxial`'s.
 *  Disjoint from `girth` by construction (these are pure y-offsets at rest,
 *  `girth`'s all lie in a y-plane), so the two ratios are independent. */
const flanks = (pr: Probes): number =>
  len(sub(pr.hi.a, pr.lo.a)) +
  len(sub(pr.hi.m, pr.lo.m)) +
  len(sub(pr.hi.b, pr.lo.b));

/** The piece's mean tangential direction — both ends' chords summed, so a piece
 *  whose ends have turned oppositely reports the middle of them (and `bend`
 *  reports that they differ at all). */
const tangentOf = (pr: Probes): V3 =>
  add(sub(pr.lo.b, pr.lo.a), sub(pr.hi.b, pr.hi.a));

/** `roll`: the tangential direction's swing out of tangential, in the local
 *  cylindrical frame at `theta`. At rest the chords are purely tangential and
 *  this is exactly 0. */
function rollOf(t: V3, theta: number): number {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return Math.atan2(t[0] * c + t[2] * s, -t[0] * s + t[2] * c);
}

/**
 * Is this piece's circumferential baseline MATERIAL? — the gate on `stretch`.
 *
 * A body of revolution has no meridian, so ops/frames.ts pins its span to 2π
 * and raises `axi`. Its probe arcs are then the median circle sampled at the
 * quarter turns rather than a span of its own material, and the distance
 * between two such points answers to the ring's RIGID motion: it tracks the
 * radius under a dilation and does not move under a sideways carry, so no
 * divisor built from the frame's radius is right in both. This therefore
 * reports NEITHER — an axisymmetric piece's `stretch` is the rigid 1.
 *
 * `bend` and `stretchAxial` need no such gate: both are RELATIVE readings
 * between the piece's two axial ends, so a rigid motion of the whole ring
 * applies to both alike and cancels.
 */
const ringFramed = (l: PieceLanes): boolean => l.axi >= 0.5;

/** The piece's seat, decoded through the SAME path as its deformed pose rather
 *  than read off the lanes: a rest state that read 1e-16 instead of 0 would
 *  make "nothing has moved yet" un-assertable and every table cell noisy. */
function restOf(pr: Probes) {
  const o = decode(pr.o);
  return {
    o,
    girth: girth(pr),
    flanks: flanks(pr),
    curl: curlOf(pr),
    roll: rollOf(tangentOf(pr), o.theta),
  };
}

/** The pose of one piece at p. Pure: same p, same piece, same output. */
export function pieceStateAt(
  p: number,
  key: string,
  table: PieceTable,
  live: LiveRecipe[] = liveDeformAt(p),
): PieceState {
  const row = table.byKey.get(key);
  if (!row) throw new Error(`pieceStateAt: no piece "${key}" in the table`);
  const seat = probesOf(row.lanes);
  const rest = restOf(seat);

  const field = pieceField(row.lanes, live);
  const out: V3 = [0, 0, 0];
  const move = (q: V3): V3 => {
    const d = field(q[0], q[1], q[2], out);
    return [q[0] + d[0], q[1] + d[1], q[2] + d[2]];
  };
  const moveArc = (q: Arc): Arc => ({
    a: move(q.a),
    m: move(q.m),
    b: move(q.b),
  });
  const now: Probes = {
    o: move(seat.o),
    lo: moveArc(seat.lo),
    hi: moveArc(seat.hi),
  };

  const o = decode(now.o);
  const d = sub(now.o, seat.o);
  // 1 is the rigid reading and the only honest one for a piece whose
  // circumferential baseline is not material (see `ringFramed`) or whose seat
  // is degenerate (probes that coincide cannot stretch)
  const girthed = !ringFramed(row.lanes) && rest.girth > 0;
  return {
    p,
    key,
    cast: row.cast,
    theta: o.theta,
    radius: o.radius,
    axial: o.axial,
    dTheta: wrapPi(o.theta - rest.o.theta),
    dRadius: o.radius - rest.o.radius,
    dAxial: o.axial - rest.o.axial,
    travel: len(d),
    roll: wrapPi(rollOf(tangentOf(now), o.theta) - rest.roll),
    bend: endTurn(now),
    curl: curlOf(now) - rest.curl,
    stretch: girthed ? girth(now) / rest.girth : 1,
    stretchAxial: rest.flanks > 0 ? flanks(now) / rest.flanks : 1,
  };
}

// ── ONE PIECE'S TRAJECTORY ──────────────────────────────────────────────────

/** Every p the table's rows are read at: story/cost.ts's grid. SHARED rather
 *  than rebuilt, so the three instruments' tables line up row for row. */
export const FLOW_SAMPLE_PS: number[] = COST_SAMPLE_PS;

/** Resolution of the window scan below: 1/2000 of the track, ~2 pixels of
 *  scroll on a 100-viewport story. */
const WINDOW_STEPS = 2000;

let window_: [number, number] | null = null;

/** The window everything moves in: [first p, last p] outside which every piece
 *  is exactly on its seat, so a trajectory only needs resolution inside it.
 *
 *  ONE SPAN, SCANNED rather than spelled: the channels' windows are authored in
 *  several shapes in story/envelopes.ts, and their union here would be the
 *  second copy story/state.ts's rule forbids. Every motion in the story is a
 *  channel, so the scan sees all of it.
 *
 *  SNAPPED OUTWARD by one scan step, so the window is a SUPERSET of what the
 *  scan saw: "every piece is exactly on its seat outside this" has to be true,
 *  not nearly. Memoized — the scan is deliberately not paid at import. */
export function deformWindow(): [number, number] {
  if (window_) return window_;
  const step = 1 / WINDOW_STEPS;
  let lo = 1;
  let hi = 0;
  for (let i = 0; i <= WINDOW_STEPS; i++) {
    const p = i * step;
    if (liveDeformAt(p).length === 0) continue;
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  window_ =
    lo <= hi ? [Math.max(0, lo - step), Math.min(1, hi + step)] : [0, 0];
  return window_;
}

export interface FlowOpts {
  /** samples spread over the whole track (default 40) */
  sparse?: number;
  /** samples spread over `DEFORM_WINDOW` (default 200) */
  dense?: number;
}

export interface PieceFlow {
  key: string;
  cast: PieceCast;
  /** the piece's seat, for reading the absolute columns against */
  seat: { theta: number; radius: number; axial: number };
  window: [number, number];
  samples: PieceState[];
}

/** One piece's whole trajectory — dense through the window where the deform is
 *  live, sparse elsewhere, and always through every row of `FLOW_SAMPLE_PS` so
 *  a trajectory and the checked-in table can be read against each other. The
 *  API half of the instrument: the table cannot carry every trajectory and
 *  stay diffable. */
export function pieceFlow(
  key: string,
  table: PieceTable,
  opts: FlowOpts = {},
): PieceFlow {
  const row = table.byKey.get(key);
  if (!row) throw new Error(`pieceFlow: no piece "${key}" in the table`);
  const sparse = opts.sparse ?? 40;
  const dense = opts.dense ?? 200;
  const ps = new Set<number>(FLOW_SAMPLE_PS);
  for (let i = 0; i <= sparse; i++) ps.add(i / sparse);
  const window = deformWindow();
  const [lo, hi] = window;
  for (let i = 0; i <= dense; i++) ps.add(lo + ((hi - lo) * i) / dense);
  const seat = decode(probesOf(row.lanes).o);
  return {
    key,
    cast: row.cast,
    seat,
    window,
    samples: [...ps]
      .filter((p) => p >= 0 && p <= 1)
      .sort((a, b) => a - b)
      .map((p) => pieceStateAt(p, key, table)),
  };
}

// ── THE ROLLUPS ─────────────────────────────────────────────────────────────

/** min / max / mean of one state dimension over one (scene, cast) cell. */
export interface Stat {
  min: number;
  max: number;
  mean: number;
}

const statOf = (values: number[]): Stat => ({
  min: values.reduce((a, b) => Math.min(a, b), Infinity),
  max: values.reduce((a, b) => Math.max(a, b), -Infinity),
  mean: values.reduce((a, b) => a + b, 0) / values.length,
});

/** The state dimensions the rollups summarise — the names are `PieceState`'s
 *  own, so a dimension added there is one line from the table. */
export const FLOW_DIMS = [
  "dTheta",
  "dRadius",
  "dAxial",
  "roll",
  "bend",
  "curl",
  "stretch",
  "stretchAxial",
] as const;

export type FlowDim = (typeof FLOW_DIMS)[number];

/** One scene × one cast — "what does this family of pieces do here". */
export interface CastRollup {
  scene: string;
  cast: PieceCast;
  /** pieces in the cast (constant across scenes; carried so a row reads alone) */
  n: number;
  /** samples × pieces behind every stat below */
  readings: number;
  stats: Record<FlowDim, Stat>;
  /** the furthest any piece of the cast gets from its seat in this scene, mm */
  maxTravel: number;
}

/** A named piece at its extreme, for the per-scene outlier list. */
export interface Outlier {
  key: string;
  cast: PieceCast;
  /** the p at which it is furthest from its seat, and how far */
  p: number;
  travel: number;
  dTheta: number;
  dRadius: number;
  dAxial: number;
  roll: number;
  bend: number;
  curl: number;
  stretch: number;
  stretchAxial: number;
}

export interface SceneFlow {
  scene: string;
  /** the scene's own range, and the hold centre the reader rests at */
  p0: number;
  p1: number;
  holdP: number;
  casts: CastRollup[];
  /** the N pieces that travel furthest anywhere in the scene */
  outliers: Outlier[];
}

/** How many pieces each scene names. Small on purpose: the table is a diff
 *  surface, and a long list of near-ties is not. */
export const OUTLIER_N = 5;

/** Each scene's own sample set: the shared grid clipped to its range, plus its
 *  hold centre. HALF-OPEN on the right exactly as story/cost.ts's rollups are,
 *  so a sample on a boundary belongs to the scene whose p0 it is. */
function scenePs(i: number): number[] {
  const r = RANGES[i];
  const last = i === RANGES.length - 1;
  const ps = FLOW_SAMPLE_PS.filter(
    (p) => p >= r.p0 && (last ? p <= r.p1 : p < r.p1),
  );
  return [...new Set([...ps, holdCentreOf(r)])].sort((a, b) => a - b);
}

/** The whole table: every scene, every cast, rolled up — and the pieces that
 *  stand out named. Pure: same table, same output. */
export function flowRollups(table: PieceTable): SceneFlow[] {
  return RANGES.map((r, i) => {
    const ps = scenePs(i);
    // one live set per p, shared by all 207 pieces
    const states = ps.flatMap((p) => {
      const live = liveDeformAt(p);
      return table.pieces.map((row) => pieceStateAt(p, row.key, table, live));
    });

    const byCast = new Map<PieceCast, PieceState[]>();
    for (const s of states) {
      const list = byCast.get(s.cast);
      if (list) list.push(s);
      else byCast.set(s.cast, [s]);
    }

    const casts: CastRollup[] = [];
    for (const cast of PIECE_CASTS) {
      const mine = byCast.get(cast);
      if (!mine || mine.length === 0) continue;
      casts.push({
        scene: r.scene.id,
        cast,
        n: table.pieces.filter((row) => row.cast === cast).length,
        readings: mine.length,
        stats: Object.fromEntries(
          FLOW_DIMS.map((d) => [d, statOf(mine.map((s) => s[d]))]),
        ) as Record<FlowDim, Stat>,
        maxTravel: mine.reduce((n, s) => Math.max(n, s.travel), 0),
      });
    }

    // the extreme reading of each piece inside the scene, then the top N
    const best = new Map<string, PieceState>();
    for (const s of states) {
      const cur = best.get(s.key);
      if (!cur || s.travel > cur.travel) best.set(s.key, s);
    }
    // a scene where nothing moves names nobody — pieces at travel 0 are not an
    // outlier list, and a zero scene that starts moving should show up in the
    // diff as rows arriving
    const outliers = [...best.values()]
      .filter((s) => s.travel > 0)
      .sort((a, b) => b.travel - a.travel || (a.key < b.key ? -1 : 1))
      .slice(0, OUTLIER_N)
      .map((s): Outlier => ({
        key: s.key,
        cast: s.cast,
        p: s.p,
        travel: s.travel,
        dTheta: s.dTheta,
        dRadius: s.dRadius,
        dAxial: s.dAxial,
        roll: s.roll,
        bend: s.bend,
        curl: s.curl,
        stretch: s.stretch,
        stretchAxial: s.stretchAxial,
      }));

    return {
      scene: r.scene.id,
      p0: r.p0,
      p1: r.p1,
      holdP: holdCentreOf(r),
      casts,
      outliers,
    };
  });
}
