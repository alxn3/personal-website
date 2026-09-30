// pieceStateAt(p, key): where each piece of the lens is at one story position,
// as plain JSON. A piece is one distinct set of `_op*` lanes on a mesh; its pose
// comes from ops/cpu.ts `pieceField` at storyStateAt(p)'s channels, in the
// bore's cylindrical coordinates (glTF frame, mm), relative to its seat.
// Mechanism drives, model placement and visibility are not included.
// Lazy: only reached by dynamic import (a dev block or a test).

import type * as THREE from "three/webgpu";
import { NUM } from "../ops/algebra";
import {
  IDLE_EPS,
  lanesAt,
  pieceField,
  type LiveRecipe,
  type PieceLanes,
} from "../ops/cpu";
import { makeRecipes } from "../ops/recipes";
import { wrapPi } from "../ops/frames";
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
import { COST_SAMPLE_PS, DEFORM_RECIPES, scenePs } from "./cost";
import { storyStateAt } from "./state";
import { STORY_KNOBS } from "./envelopes";

const RECIPES = makeRecipes(NUM);

// --- the pieces ---------------------------------------------------------------

/** The families pieces are grouped by (core/visibility.ts's fade bands), plus
 *  `other` for what no fade governs: iris, focus train, mount, PCB. */
export const PIECE_CASTS = [
  "wedges",
  "decals",
  "extras",
  "interior",
  "elements",
  "other",
] as const;

export type PieceCast = (typeof PIECE_CASTS)[number];

/** A piece's family, in core/visibility.ts's order. Decals also match
 *  `isShellPart`, so they are tested first. */
export function castOf(name: string): PieceCast {
  if (isOpticalGlass(name)) return "elements";
  if (isPeelTube(name) || isPeelRest(name)) return "interior";
  if (isPeelExtra(name)) return "extras";
  if (isDecal(name)) return "decals";
  if (isShellPart(name)) return "wedges";
  return "other";
}

/** One piece of the model: a mesh plus one distinct lane tuple. */
export interface PieceRow {
  /** unique: the node name, plus `#i` when a mesh holds several pieces */
  key: string;
  /** the glTF node name (may be shared) */
  name: string;
  cast: PieceCast;
  lanes: PieceLanes;
}

export interface PieceTable {
  pieces: PieceRow[];
  byKey: Map<string, PieceRow>;
}

/** Every lane the deform reads, joined: one piece per distinct key. */
const laneKey = (l: PieceLanes): string =>
  `${l.t0},${l.R},${l.halfSpan},${l.rank01},${l.layerPhase},${l.partClass},${l.rung},${l.axi},${l.yMin},${l.yMax},${l.depth},${l.adopted}`;

/** Every piece in a scene graph that `deriveFrames` has run over. Meshes
 *  without frames, accessories and shading extras are skipped. */
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

// --- the deform at p -----------------------------------------------------------

/** The recipes running at p. One below the host's IDLE_EPS contributes nothing
 *  and is dropped. */
export function liveDeformAt(p: number): LiveRecipe[] {
  const channels = storyStateAt(p).channels;
  const live: LiveRecipe[] = [];
  for (const name of DEFORM_RECIPES) {
    const channel = channels[name];
    if (channel < IDLE_EPS) continue;
    live.push({
      recipe: RECIPES[name],
      channel,
      knobs: { ...RECIPES[name].knobDefaults, ...STORY_KNOBS[name] },
    });
  }
  return live;
}

// --- one piece's state ----------------------------------------------------------

/** A point in the mesh's local space (glTF frame, mm). */
type V3 = [number, number, number];

/** Three points on a piece's seated arc at one axial level; a→b is the
 *  tangential direction. */
interface Arc {
  a: V3;
  m: V3;
  b: V3;
}

/** A piece's probe points: its frame origin and an arc at each axial end. */
interface Probes {
  o: V3;
  lo: Arc;
  hi: Arc;
}

/** The widest half-angle a probe arc spans. A full ring is sampled at quarter
 *  turns, so its `stretch` isn't measured (see `ringFramed`). */
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

/** One piece's pose at p. Every field after `axial` is relative to its seat. */
export interface PieceState {
  p: number;
  key: string;
  cast: PieceCast;
  /** angle around the optical axis, radians, in (−π, π] */
  theta: number;
  /** distance from the optical axis, mm */
  radius: number;
  /** position along the optical axis, mm */
  axial: number;
  /** theta, radius and axial minus their seated values; dTheta wraps, so a
   *  full turn reads 0 */
  dTheta: number;
  dRadius: number;
  dAxial: number;
  /** straight-line distance from the seat, mm */
  travel: number;
  /** how far the piece has turned in place about the bore, radians; 0 for a
   *  rigid revolution */
  roll: number;
  /** rotation between the piece's two axial ends, radians; 0 for any rigid
   *  motion (and when not measurable) */
  bend: number;
  /** how much more (+) or less (−) its arcs curve than when seated, radians */
  curl: number;
  /** size around the bore vs seated (1 = unchanged); always 1 for a full ring */
  stretch: number;
  /** size along the bore vs seated (1 = unchanged) */
  stretchAxial: number;
}

/** A probe point in cylindrical coordinates. */
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

/** The unit vector, or null for a zero vector. */
function unit(u: V3): V3 | null {
  const n = len(u);
  return n > 0 ? [u[0] / n, u[1] / n, u[2] / n] : null;
}

/** One end's orientation: its tangential chord, the spine (joining both ends'
 *  midpoints) with the chord projected out, and their cross. Null if collapsed. */
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

/** `bend`: the angle rotating the low end's frame onto the high end's (both
 *  frames match when seated). 0 when either end has no orientation. */
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

/** The angle between an arc's two half-chords, unsigned. */
function arcTurn(q: Arc): number {
  const u = unit(sub(q.m, q.a));
  const v = unit(sub(q.b, q.m));
  if (!u || !v) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot(u, v))));
}

/** Both ends' arcTurn, averaged. */
const curlOf = (pr: Probes): number => (arcTurn(pr.lo) + arcTurn(pr.hi)) * 0.5;

/** The sum of pairwise distances within one arc. */
const arcGirth = (q: Arc): number =>
  len(sub(q.m, q.a)) + len(sub(q.b, q.m)) + len(sub(q.b, q.a));

/** Extent around the bore: both ends' arcGirth. */
const girth = (pr: Probes): number => arcGirth(pr.lo) + arcGirth(pr.hi);

/** Extent along the bore: the three lines joining the two ends. */
const flanks = (pr: Probes): number =>
  len(sub(pr.hi.a, pr.lo.a)) +
  len(sub(pr.hi.m, pr.lo.m)) +
  len(sub(pr.hi.b, pr.lo.b));

/** The piece's mean tangential direction (both ends' chords summed). */
const tangentOf = (pr: Probes): V3 =>
  add(sub(pr.lo.b, pr.lo.a), sub(pr.hi.b, pr.hi.a));

/** How far direction `t` has swung out of tangential at angle `theta`. */
function rollOf(t: V3, theta: number): number {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return Math.atan2(t[0] * c + t[2] * s, -t[0] * s + t[2] * c);
}

/** True for a body of revolution: its probe arcs are just ring samples, so
 *  `stretch` means nothing for it. */
const ringFramed = (l: PieceLanes): boolean => l.axi >= 0.5;

/** The seated values, computed the same way as the moved pose so that a
 *  piece at rest reads exactly 0. */
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

/** The pose of one piece at p. */
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
  // stretch reads 1 for a full ring or a degenerate seat
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

// --- one piece's trajectory -----------------------------------------------------

/** The sample grid, shared with cost.ts so the instruments' tables line up. */
export const FLOW_SAMPLE_PS: number[] = COST_SAMPLE_PS;

/** How many steps deformWindow scans the track in. */
const WINDOW_STEPS = 2000;

let window_: [number, number] | null = null;

/** The [first, last] p where any piece is off its seat, found by scanning
 *  and padded one step outward. Memoized. */
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
  /** samples spread over deformWindow() (default 200) */
  dense?: number;
}

export interface PieceFlow {
  key: string;
  cast: PieceCast;
  /** the piece's seated position */
  seat: { theta: number; radius: number; axial: number };
  window: [number, number];
  samples: PieceState[];
}

/** One piece's trajectory: dense where the deform runs, sparse elsewhere, and
 *  at every FLOW_SAMPLE_PS. */
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

// --- the rollups ----------------------------------------------------------------

/** min / max / mean of one state field over one (scene, family) cell. */
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

/** The PieceState fields the rollups summarise. */
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

/** What one family of pieces does in one scene. */
export interface CastRollup {
  scene: string;
  cast: PieceCast;
  /** pieces in the family */
  n: number;
  /** samples × pieces behind each stat */
  readings: number;
  stats: Record<FlowDim, Stat>;
  /** the furthest any piece of the family gets from its seat here, mm */
  maxTravel: number;
}

export interface SceneFlow {
  scene: string;
  /** the scene's range and hold centre */
  p0: number;
  p1: number;
  holdP: number;
  casts: CastRollup[];
  /** the pieces that travel furthest in the scene, each at its furthest */
  outliers: PieceState[];
}

/** Outliers listed per scene. */
export const OUTLIER_N = 5;
/** Travel below this (mm) is numerical noise, not motion. */
export const TRAVEL_FLOOR = 1e-9;

/** Every scene × family rollup, plus each scene's outliers. */
export function flowRollups(table: PieceTable): SceneFlow[] {
  return RANGES.map((r, i) => {
    const ps = [...new Set([...scenePs(i), holdCentreOf(r)])].sort(
      (a, b) => a - b,
    );
    // one recipe set per p, shared by every piece
    const states = ps.flatMap((p) => {
      const live = liveDeformAt(p);
      return table.pieces.map((row) => pieceStateAt(p, row.key, table, live));
    });

    const casts: CastRollup[] = [];
    for (const cast of PIECE_CASTS) {
      const mine = states.filter((s) => s.cast === cast);
      if (mine.length === 0) continue;
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

    // each piece's furthest reading in the scene, then the top N
    const best = new Map<string, PieceState>();
    for (const s of states) {
      const cur = best.get(s.key);
      if (!cur || s.travel > cur.travel) best.set(s.key, s);
    }
    const outliers = [...best.values()]
      .filter((s) => s.travel > TRAVEL_FLOOR)
      .sort((a, b) => b.travel - a.travel || (a.key < b.key ? -1 : 1))
      .slice(0, OUTLIER_N);

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
