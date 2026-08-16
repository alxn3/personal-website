// ============================================================================
// pieceStateAt(p, key) — WHERE EVERY PIECE OF THE LENS IS AT ONE SCROLL
// POSITION, as plain JSON. The third instrument of the family: story/state.ts
// answers "what is the story DOING at p", story/cost.ts answers "what does the
// frame at p COST", this one answers "where is each PIECE, and how is it moving".
//
// WHY IT EXISTS: "the pose and flow of the pieces throughout the story … it
// should be computable so you can better understand it. Still images don't tell
// a lot" (owner). A screenshot of an exploded lens says nothing about which
// pieces went where, how far, in what order, or whether one is inside another;
// the shader that moved them is not readable from the outside; and the CPU
// mirror that COULD answer it (ops/cpu.ts) only ever ran bound to a live scene.
// This is that field, evaluated offline, per piece, at any p.
//
// ── THE MEASUREMENT CONTRACT ───────────────────────────────────────────────
//
// IDENTITY. A piece is a DERIVED FRAME — the (t0, R, span, rank, layer phase,
// class, rung, axial extent) tuple ops/frames.ts measures and packs into the
// `_opA`/`_opB`/`_opY` attributes at load. That is the roster the deform host
// itself uses, so there is no parallel identity here: `buildPieceTable` reads
// the attributes back off a framed scene and cuts a mesh into ONE PIECE PER
// DISTINCT LANE TUPLE. A mesh of adopted features carries a tuple per island
// (ops/frames.ts frames each screw separately so it can snap to the wedge it is
// bolted to), so `Mount_Screws` is four pieces — but two islands that snapped to
// the SAME host wedge inherit byte-identical lanes and are therefore ONE piece
// here, which loses no measurement: identical lanes deform identically.
// 194 meshes ⇒ 207 pieces.
//
// STATE SPACE: BORE-CYLINDRICAL. Position is (theta, radius, axial) about the
// optical axis — the algebra's OWN space, in which a trajectory that looks like
// a curve in world space is a line or a ramp. Plus five shape scalars read off
// the probe set: `roll` (the piece turning in place about the bore), the
// complementary pair `bend` (the relative rotation of its two AXIAL ends) and
// `curl` (its CIRCUMFERENTIAL curvature against its seat, signed), and
// `stretch` / `stretchAxial` (its size round the bore and along it, 1 = rigid).
// The pair earns both columns: the peel, the cards and the internals deform a
// piece identically at both of its ends, so `bend` is a true 0.000 across the
// whole of that arc and `curl` is the only thing that sees a wedge flatten as it
// peels off the barrel. Every one is reported as a DELTA
// from the piece's own seat, so "at rest" is exactly zero — not approximately
// (see `restOf`).
//
// The frame all of that is reported in is the MESH's OWN local space, which is
// the bore's for every node but eight: `Iris_ActuatorGear` and
// `Iris_Blade_01…07` are seated up to 15.6mm off the axis (measured on the
// shipped glTF's node transforms — they are the only non-identity ones). Since
// ops/frames.ts measures their lanes and ops/host.ts folds their deform in that
// same local space, this module mirrors the render exactly; but their `radius`
// is a distance from their own origin rather than from the optical axis.
//
// EVALUATION: THE REAL PIPELINE, UNDER NUM. Every number below comes out of
// `ops/cpu.ts`'s `pieceField` — host.ts's `fold()` preamble and `runPipeline`
// on the exact NUM backend the recipe goldens are pinned on
// (ops/__tests__/recipe-goldens.test.ts). No browser, no shader, no second
// model of the deform: the probes ride the goldens' own path, which is pinned
// directly in this module's test. The recipe set is the one the hero bakes
// (story/cost.ts `DEFORM_RECIPES` — the LensStory.astro pin), driven at
// `storyStateAt(p).channels`, at each recipe's `knobDefaults` (the story never
// writes a knob; only the /lens bench's sliders do).
//
// THE PROBES. Seven points: the piece's frame ORIGIN, and one ARC at each end
// of its own axial extent (`yMin`, `yMax`) — an arc being three points on the
// seated median circle, its middle plus one at each end of the angular extent
// (capped at a quarter turn, so an axisymmetric piece — whose "extent" is the
// full circle — gets distinct probes instead of one antipodal point).
//
// TWO AXIAL LEVELS are what make the contract's "end to end" measurable at all:
// with every probe on one median plane (the shape this module took first) a
// piece stretched, sheared or bent ALONG THE BORE reads exactly rigid, because
// all of its probes ride the same `yN` and see the same axial term. THREE POINTS
// PER ARC are what give an END an ORIENTATION — the chord is its tangential
// direction and the plane the three span carries its normal — so `bend` is the
// genuine relative rotation of the two end frames rather than a change in one
// chord's angle. The pipeline's own rotational output (`rot`) is not carried
// here: ops/host.ts spends it on the shading normal alone, so `roll` and `bend`
// are re-derived from the probes' geometry, which for the position field is the
// polar decomposition's rotational part without a decomposition.
//
// THE RIGID HALF. story/peelcards.ts moves the peel's cast with per-piece
// `setPartOffset` writes rather than through the op pipeline, and during the
// peel and cards scenes that offset is most of where a shell strip IS. It is
// composed here exactly as core/scene composes it (turn about the bore, then
// the additive parent-frame position), read from `peelDriftAt` — the law
// peelcards' own frame() calls, named there rather than copied here.
//
// ── WHAT IT DELIBERATELY DOES NOT REPORT ───────────────────────────────────
//
//   · EVERY RESIDUAL story/state.ts DECLARES. The channels are the AUTHORED
//     ones at p: ease lag, phase clocks and mount latches all apply.
//   · THE MECHANISM DRIVES. The iris blades' aperture rotation and the focus
//     lead screw's spin (ops/mechanism.ts) are object-level transforms on an
//     aperture/focus clock, not deform-field terms. A blade's reported state is
//     its deform state; its live seat is that drive away.
//   · THE MODEL'S OWN PLACEMENT. The dolly, the two body rolls and the camera
//     are story/state.ts's `model`/`camera`. This module works in the gltf
//     frame throughout (optical axis +Y, radial plane X–Z, MILLIMETRES), which
//     is the frame the deform and the part offsets are both written in — with
//     the eight-node local-frame caveat above.
//   · AN AXISYMMETRIC PIECE'S `stretch`. 15 of the 207 are bodies of
//     revolution, whose frame span is the convention 2π rather than a measured
//     extent; their circumferential probes are a ring sample, which answers to
//     rigid motion, so no stretch is reported for them at all. The whole
//     argument, with the two measurements that settle it, is at `ringFramed`.
//   · A THIN PIECE'S AXIAL READINGS AT FACE VALUE. `bend` and `stretchAxial`
//     are read across the piece's OWN axial extent, and the thinnest piece of
//     the shipped roster (`Shim_Ring_02_Seg3`) is 0.093mm tall. No piece has a
//     ZERO extent (measured over all 207), so the axial probe is always
//     defined — but a ratio taken over a tenth of a millimetre is enormous for
//     an ordinary displacement (the shims read 107× in `rewrap`), and that is
//     the render's own behaviour rather than an artifact: the ops normalize the
//     axial coordinate per piece (`yN`), so an axial term really does spread a
//     shim a hundredfold. Read `stretchAxial` next to the piece's extent.
//   · THE DECAL SHRINK-WRAP. A decal vertex rides its host's rendered FACET
//     (ops/frames.ts `bindDecals`), so the smooth field probed here is the
//     ideal curve rather than the chord the decal actually lands on — a
//     sub-millimetre difference, and a decal's lanes are its host's anyway.
//   · VISIBILITY. A piece winked out by the shell/interior fades still has a
//     pose, and it is reported. story/cost.ts owns who is on screen.
//
// PURE. No fs, no DOM, no renderer: the roster arrives as a `PieceTable`
// parameter, built either from a framed live scene (the DEV rider) or from the
// shipped GLB decoded and framed in node (the test). Both call the SAME builder
// over the SAME `deriveFrames` output, so the two cannot drift.
//
// LAZY — NEVER STATICALLY REACHABLE FROM THE HOMEPAGE, for story/state.ts's
// reason and by importing it and story/cost.ts. Reached ONLY by
// `await import("./flow")` from hero-driver's DEV block, or by a test in
// node. It must NEVER be added to index.ts.
// ============================================================================

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

const RECIPES = makeRecipes(NUM);

const TAU = Math.PI * 2;
const wrapPi = (x: number): number => x - TAU * Math.floor((x + Math.PI) / TAU);

// ── THE ROSTER ──────────────────────────────────────────────────────────────

/** The five families the rollups are cut by, plus the mechanism that is in none
 *  of them. These are core/visibility.ts's own wink bands under one name each —
 *  `interior` merges the two the interior channel governs (the tubes and the
 *  rest-cast) — so "which cast" reads the same here as it does for who is on
 *  screen. `other` is what neither fade governs: the iris, the focus train, the
 *  mount block, the PCB. */
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
 *  order — glass first (an `Element_` is never anything else), then the two
 *  interior bands, then the baffles, then the printed markings, then the skin.
 *  Every decal matches `isShellPart` too, which is why it is tested first. */
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

/** THE WHOLE TUPLE, in one string. Every lane the deform reads is in it — so
 *  two vertices with the same key are two vertices the field cannot tell apart,
 *  and "one piece per distinct key" is exactly "one piece per distinct deform".
 *  (`partClass`, `layerN` and `adopted` are constant per mesh on the shipped
 *  model — carrying them changes no count — but a key that is not the whole
 *  tuple would silently store whichever tuple was seen first.) */
const laneKey = (l: PieceLanes): string =>
  `${l.t0},${l.R},${l.halfSpan},${l.rank01},${l.layerPhase},${l.partClass},${l.rung},${l.axi},${l.yMin},${l.yMax},${l.layerN},${l.adopted}`;

/**
 * THE ROSTER, censused off a FRAMED scene graph — one that `deriveFrames` has
 * run over, so every mesh carries the `_op*` attributes. Two callers, one law:
 * the DEV rider hands it the live `gltfScene`, and the test hands it the
 * shipped GLB decoded and framed in node. A mesh with no frame is skipped (it
 * is not a piece the deform can move).
 *
 * SEVERAL PIECES PER MESH is normal, not defensive: ops/frames.ts splits an
 * adopted feature mesh into ISLANDS so each screw snaps to the wedge it is
 * bolted to, and writes that island's lane tuple to its vertices. Walking the
 * attribute in vertex order and cutting on a new tuple therefore gives ONE PIECE
 * PER DISTINCT LANE TUPLE, in a deterministic order — which is NOT one piece per
 * island: adoption copies the host wedge's frame verbatim (`ops/frames.ts` step
 * 2), so two islands that snapped to the same wedge carry byte-identical lanes
 * and merge into one piece. Six meshes of the shipped model carry more than one
 * tuple, and three of them carry fewer tuples than they have islands
 * (`Mount_ScrewCounterbores` 8 islands ⇒ 5, `Mount_Contacts` 10 ⇒ 2,
 * `DecalT_BezelMIJ` 11 ⇒ 2 — measured with frames.ts's own component law).
 * Merging them loses no measurement, because the deform of a piece is a function
 * of its lanes alone; it only means a mesh's islands weigh once per distinct
 * frame in the rollups rather than once per island.
 *
 * ACCESSORIES ARE NOT PIECES. They are framed by their own scoped pass and
 * share the model's graph in the live scene (the front group hangs off
 * `Barrel_Inner`), so they are split off by ancestry — the same rule
 * core/visibility.ts's sweep and story/cost.ts's census both use. So are the
 * shading extras (edge lines, inverted hulls), which carry a clone of their
 * host's geometry and would otherwise census as a second copy of it.
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
 * contributes EXACTLY zero, so skipping it is not an approximation — the same
 * argument `liveRecipes()` makes for the live tier, at a third the work.
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
      knobs: RECIPES[name].knobDefaults,
    });
  }
  return live;
}

// ── ONE PIECE'S STATE ───────────────────────────────────────────────────────

/** A point in the mesh's own local space (gltf frame, mm). */
type V3 = [number, number, number];

/** ONE AXIAL END of a piece: three points of its seated median circle at one
 *  axial level — the arc's middle, and one at each end of the angular extent.
 *  Three rather than two, because three carry an ORIENTATION: the chord a→b is
 *  the end's tangential direction and the plane they span carries its normal. */
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

/** The widest half-extent a probe is placed at. An axisymmetric piece measures
 *  a full turn (ops/frames.ts pins `span = 2π` for a body of revolution), and
 *  ±π about its meridian is the SAME point — so the probes are placed at the
 *  quarter turns instead, which is the widest pair that stays distinct. That
 *  makes an axisymmetric piece's arcs a RING SAMPLE rather than a span of its
 *  material, which is why `stretch` is not reported for one — see `ringFramed`. */
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
  /** THE PIECE TURNING IN PLACE about the bore: the angle its own tangential
   *  direction has swung out of tangential, measured in the local cylindrical
   *  frame AT ITS DEFORMED POSITION. A rigid revolution about the axis carries
   *  that frame with it and reads 0 here, by construction — this is the part of
   *  the motion that is not just "further round". Radians. */
  roll: number;
  /** THE PIECE'S END-TO-END RELATIVE ROTATION: the angle of the rotation that
   *  takes the frame of its low-axial end onto the frame of its high-axial end
   *  — twist about the bore and tip out of the piece's own plane together, the
   *  whole of what one end has done relative to the other. Radians, unsigned
   *  (a rotation angle in 3D has no sign; its axis is what `roll` reports the
   *  bore-ward component of), and exactly 0 for any rigid motion.
   *
   *  ZERO ALSO MEANS "NOT MEASURED" in the degenerate case `endTurn` names —
   *  nothing on the shipped model reaches it. */
  bend: number;
  /** THE PIECE'S CURL, SIGNED: how much more (or less) its arcs curve than they
   *  do at their seat, in radians of the turn between an arc's two chords,
   *  averaged over the two ends. Positive = curled TIGHTER than seated,
   *  negative = FLATTENED, exactly 0 for a rigid motion.
   *
   *  `bend`'s complement, and the reason both are here: `bend` is the AXIAL
   *  reading (what one end has done relative to the other) and reads a true
   *  0.000 through the peel, the cards and the internals, because those scenes
   *  do the same thing to a piece's two ends. What they DO do is circumferential
   *  — a wedge peeling off the barrel flattens out of its seated curve — and
   *  that is this column. Neither is derivable from the other, and the pair is
   *  what makes "how did that piece change shape" answerable in every scene. */
  curl: number;
  /** THE PIECE'S SIZE ROUND THE BORE: the deformed arcs' total pairwise
   *  separation over their seated one. 1 = rigid; >1 = stretched, <1 =
   *  compressed. NOT MEASURED for an axisymmetric piece — it reads a flat 1
   *  there, for the reason `ringFramed` gives at length. */
  stretch: number;
  /** THE PIECE'S SIZE ALONG THE BORE: the same ratio, over the three flanks
   *  joining its two axial ends. 1 = rigid, and measured for every piece. It is
   *  a RATIO of a piece's own axial extent, so it is large where that extent is
   *  small: the ops normalize the axial coordinate per piece (`yN`), and a
   *  0.093mm shim spread over a millimetre by an axial term is a hundredfold
   *  ratio — as it is on screen (see the header's last bullet). */
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

/** ONE END'S ORIENTATION, as an orthonormal triple: its own tangential chord,
 *  the piece's SPINE with that chord's component projected out, and their cross.
 *  `null` if either has collapsed — an end with no width, or a spine parallel to
 *  it, carries no orientation.
 *
 *  The spine (both ends' midpoints joined) is shared by the two ends, so it
 *  contributes nothing of its own to their relative rotation — it is there as
 *  the common reference the two tangents are read against. The arc's OWN plane
 *  normal would do the same job and also catch a strip tipping out of its plane,
 *  but it is ill-conditioned exactly where the deform puts these pieces: a probe
 *  arc that flattens and curves back the other way flips that normal, and `bend`
 *  jumps discontinuously to π. Measured — with the plane normal, every explode
 *  cell of the map saturated at 3.142. The spine is at 90° to every tangent at
 *  rest and stays far from parallel, so this one degrades gracefully. */
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

/** `bend`: THE ANGLE OF THE ROTATION taking the low end's frame onto the high
 *  end's, which is the contract's "end-to-end relative rotation between the
 *  probes at the piece's two ends".
 *
 *  No rest value is subtracted, and none is needed: at rest the two arcs are the
 *  SAME arc at two heights, so their frames are the same three vectors and the
 *  relative rotation is exactly the identity. (Formally the rest frames cancel —
 *  R_hi·R_loᵀ = F_hi·F₀ᵀ·F₀·F_loᵀ = F_hi·F_loᵀ — which is why this reads 0 for
 *  any rigid motion of the whole piece, not just for the seat.)
 *
 *  Read off BOTH parts of that rotation rather than the trace alone:
 *  Σᵢ axisᵢ(lo)·axisᵢ(hi) = 1 + 2cos(angle) and Σᵢ axisᵢ(lo) × axisᵢ(hi) =
 *  2sin(angle)·axis, so `atan2` of the two is the angle. The trace alone loses
 *  half its digits near rest — `acos` of a normalized dot product that is 1 to
 *  within an ulp returns 3e-8, not 0 — and this module's whole rest law is that
 *  a piece which has not moved reads EXACTLY zero. The cross terms vanish
 *  identically when the two frames are the same vectors, so they do.
 *
 *  THE ONE DEGENERATE CASE, named for the same reason `ringFramed` is: if either
 *  end has no orientation — an arc collapsed to a point, or a spine that has
 *  swung parallel to a tangent — there is no rotation to measure and the 0
 *  returned below means NOT MEASURED, not "rigid". It is latent, not live:
 *  nothing on the shipped model comes near it (the worst conditioning over all
 *  207 pieces at every row of the grid is |sin∠(spine, tangent)| = 0.355,
 *  measured; at rest every piece is at exactly 1). It stays a returned 0 rather
 *  than a NaN or a flag because a NaN would have to be special-cased through
 *  every rollup and a flag would be a column of `false`. */
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

/** ONE ARC'S OWN TURN: the angle between its two half-chords — how much it
 *  curves, unsigned. `curl` is the DIFFERENCE of this from its seated value,
 *  which is what carries the sign (tighter positive, flatter negative), so a
 *  piece whose arc is a straight line at rest and at p reads 0 either way. */
function arcTurn(q: Arc): number {
  const u = unit(sub(q.m, q.a));
  const v = unit(sub(q.b, q.m));
  if (!u || !v) return 0;
  return Math.acos(Math.min(1, Math.max(-1, dot(u, v))));
}

/** BOTH ENDS' TURN, averaged — so `curl` stays on the same scale as one arc's
 *  turn (and as the single-plane reading this instrument's first cut reported)
 *  rather than doubling with the probe count. */
const curlOf = (pr: Probes): number => (arcTurn(pr.lo) + arcTurn(pr.hi)) * 0.5;

/** The total pairwise separation inside one arc. */
const arcGirth = (q: Arc): number =>
  len(sub(q.m, q.a)) + len(sub(q.b, q.m)) + len(sub(q.b, q.a));

/** THE CIRCUMFERENTIAL EXTENT: every pairwise distance inside each end's arc —
 *  `stretch`'s numerator. */
const girth = (pr: Probes): number => arcGirth(pr.lo) + arcGirth(pr.hi);

/** THE AXIAL EXTENT: the three flanks joining the two ends — `stretchAxial`'s.
 *  Disjoint from `girth` by construction (every one of these segments is a pure
 *  y-offset at rest, and every one of `girth`'s lies in a y-plane), so the two
 *  ratios are independent readings rather than two views of one number. */
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
 * IS THIS PIECE'S CIRCUMFERENTIAL BASELINE MATERIAL? — the gate on `stretch`.
 *
 * A body of revolution has no meridian: ops/frames.ts pins its `t0` to 0, its
 * span to exactly 2π and raises `axi`, because the measured meridian of a full
 * ring is float noise. Its probe arcs are therefore NOT a span of its own
 * material; they are the median circle sampled at the quarter turns, and the
 * distance between two points a quarter turn apart on a ring answers to the
 * ring's RIGID motion, not to any stretch of the thing.
 *
 * MEASURED, on `Cam_Followers` (three follower blocks framed as one body of
 * revolution — nothing about it stretches anywhere in the story), where the raw
 * girth ratio takes two different values for two rigid motions:
 *
 *   p = 0.6935     girth 3.9500×, radius 110.0583/27.8629 = 3.9500×  — the ring
 *                  DILATES, and the girth tracks the radius exactly;
 *   p = 0.2833333  girth 1.0000×, radius 105.5570/27.8629 = 3.7884×  — the ring
 *                  is CARRIED sideways whole, and the girth does not move.
 *
 * (Both p are read to the digits printed: the second is the shared grid's own
 * row at 0.2833333…, and a p rounded to 0.2833 lands 0.0122mm away at 3.7880.)
 *
 * So no divisor built from the frame's radius can be right in both: normalising
 * by it fixes the first cell (which used to publish "an interior piece stretches
 * to 3.95× its seated size", the one number the first cut of this instrument put
 * in front of the owner) and breaks the second into a 0.2640 compression that is
 * just as false. With three points on a circle the rigid part cannot be
 * separated from the shape part at all, so this reports NEITHER: an
 * axisymmetric piece's `stretch` is the rigid 1.0000, which is the only honest
 * reading, and the fact that it is not a measurement is stated here, in the
 * header, and in the generated map.
 *
 * `bend` and `stretchAxial` are NOT suppressed, and do not need to be: both are
 * RELATIVE readings between the piece's two axial ends, so a rigid motion (or a
 * dilation) of the whole ring applies to both ends alike and cancels.
 *
 * 15 pieces of 207 carry the flag: `Cam_Followers`, `Iris_ActuatorGear` and
 * `Element_01…13`. The other 192 have a measured angular extent, their arcs lie
 * inside it, and their girth is a material distance — a rigid carry leaves it
 * alone, which is exactly why the shell wedges read 0.77 while their radius more
 * than doubles.
 */
const ringFramed = (l: PieceLanes): boolean => l.axi >= 0.5;

/** THE PIECE'S SEAT, decoded through the SAME path as its deformed pose — not
 *  read off the lanes. `theta` from `atan2(R sin t0, R cos t0)` is `t0` to
 *  within a rounding of it, and a rest state that read 1e-16 instead of 0 would
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

/** THE POSE OF ONE PIECE AT p. Pure: same p, same piece, same output. */
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
  // circumferential baseline is not material (see `ringFramed`) or whose seat is
  // degenerate (probes that coincide cannot stretch)
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

/** Every p the table's rows are read at: story/cost.ts's grid — each scene
 *  edge, caption-band edge, window edge and hold centre. SHARED rather than
 *  rebuilt, so the three instruments' tables line up row for row. */
export const FLOW_SAMPLE_PS: number[] = COST_SAMPLE_PS;

/** Resolution of the window scan below: 1/2000 of the track, ~2 pixels of
 *  scroll on a 100-viewport story. */
const WINDOW_STEPS = 2000;

let window_: [number, number] | null = null;

/** THE WINDOW EVERYTHING MOVES IN: [first p, last p] outside which every piece
 *  is exactly on its seat (the identity this module's test pins), so a
 *  trajectory only needs resolution inside it.
 *
 *  ONE SPAN, SCANNED. The channels' windows are authored in story/envelopes.ts
 *  in several shapes and spelling their union here would be exactly the second
 *  copy story/state.ts's rule forbids, so it is measured instead. It used to be
 *  unioned with a second, NON-channel span — story/peelcards.ts's rigid
 *  per-piece drift, which no scan of `liveDeformAt` could see — and that span
 *  is gone with the drift itself: the cards scene's departure is an op recipe
 *  on the assemble channel now, so every motion in the story is a channel and
 *  the scan sees all of it.
 *
 *  SNAPPED OUTWARD by one scan step, so the window is a SUPERSET of what the
 *  scan saw rather than the first grid point that happened to land inside it:
 *  at 1/2000 the channels' true opening is up to one step before the first
 *  sample that catches it, and "every piece is exactly on its seat outside this"
 *  has to be true, not nearly.
 *
 *  Memoized — the scan costs ~2000 evaluations and is deliberately NOT paid at
 *  import. */
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

/** ONE PIECE'S WHOLE TRAJECTORY — dense through the window where the deform is
 *  live, sparse elsewhere, and always through every row of `FLOW_SAMPLE_PS` so
 *  a trajectory and the checked-in table can be read against each other. This
 *  is the API half of the instrument: the table cannot carry 207 trajectories
 *  and stay diffable, and it does not try. */
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
 *  own, so a dimension added there is one line from being in the table. */
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

/** ONE SCENE × ONE CAST — "what does this family of pieces do in this scene". */
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
 *  surface, and a long list of near-ties is not one. */
export const OUTLIER_N = 5;

/** Each scene's own sample set: the shared grid clipped to its range, plus its
 *  hold centre. HALF-OPEN on the right exactly as story/cost.ts's rollups are,
 *  so a sample sitting ON a boundary is attributed to the scene whose p0 it is
 *  and a wave's change cannot be double-counted. */
function scenePs(i: number): number[] {
  const r = RANGES[i];
  const last = i === RANGES.length - 1;
  const ps = FLOW_SAMPLE_PS.filter(
    (p) => p >= r.p0 && (last ? p <= r.p1 : p < r.p1),
  );
  return [...new Set([...ps, holdCentreOf(r)])].sort((a, b) => a - b);
}

/** THE WHOLE TABLE: every scene, every cast, rolled up — and the pieces that
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
    // a scene where nothing moves names nobody — five arbitrary pieces at
    // travel 0 are not an outlier list, and a zero scene that starts moving
    // should appear in the diff as rows arriving
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
