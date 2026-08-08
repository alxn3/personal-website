import type { Algebra, Sc } from "../ops/algebra";
import { PRESCRIPTION, IRIS, FOCUS_MM } from "./prescription";

// ============================================================================
// THE TRACE — Snell's law through the prescription, written ONCE against the
// house `Algebra<S>` (ops/algebra.ts) so the NUM backend runs it in vitest and
// the TSL backend compiles the SAME code into the background shader. No three
// import anywhere in this file; that is what keeps the goldens renderer-free.
//
// BRANCH-FREE, because TSL has no runtime branches worth taking per pixel:
//   • total internal reflection multiplies `alive` toward 0 (step of the
//     refraction discriminant), it does not return early;
//   • aperture clipping multiplies `alive` (step of aperture² − r²);
//   • a surface BEHIND the ray origin is skipped by blending with
//     `ahead = step(0, t)` rather than by an `if`.
// There are NO conditionals left at all: `stop` and `enter` used to be read off
// the static table at build time, which only worked while the GPU path UNROLLED
// the 21 surfaces. It no longer does (warp.ts loops a uniform surface table —
// three's WGSL builder hoists every shader `var` to module scope as
// `var<private>`, WGSLNodeBuilder.js:327/1940/2256, and 21 copies of this body
// blew WebKit's 8 KB private-address-space budget), so every flag is a RUNTIME
// scalar and both flags are resolved by `sel` below.
//
// NaN GUARDS, in the ops2 defensive style: every sqrt is sqrt(max(x, EPS)) and
// every divide is guarded by a signed max(|den|, EPS).
//
// THE SURFACE MODEL is written in CURVATURE, never radius, so a flat surface is
// c = 0 with no special case:
//     f(q) = c·|q|² − 2·q_y = 0,   q = p − (0, yMm, 0)
// with gradient direction n ∝ (c·q_x, c·q_y − 1, c·q_z) — which is exactly the
// plane normal −ŷ at c = 0. The centre of curvature sits at yMm + 1/c.
//
// THE ROOT is picked by the CITARDAUQ form, t = 2C / (−B − √k), which stays
// finite as A = c → 0 where the textbook (−B ± √k)/2A blows up. The MINUS sign
// is not a guess: with the real prescription and an axial ray entering from the
// front (d = −ŷ, origin well above the front vertex) the plus branch gives
// t < 0 and the minus branch lands the hit exactly on the vertex, for c > 0,
// c = 0 and c < 0 alike. It is pinned by the goldens.
//
// IMAGE INVERSION IS EMERGENT — nothing here special-cases it. trace-laws (g)
// pins that an off-axis parallel ray leaves bent across the axis.
// ============================================================================

/** The one epsilon: sqrt floors, divide guards. */
export const EPS = 1e-9;

/** A 3-vector in the backend's scalar type. `Algebra<S>` is scalar-only, so all
 *  vector math here is componentwise. */
export interface Vec3<S> {
  x: S;
  y: S;
  z: S;
}

/** The live physics knobs the trace reads. Scalars, not numbers, so the TSL
 *  backend can bind them to uniforms and the DEV handle can tune them without
 *  a shader rebuild. */
export interface TraceKnobs<S> {
  warpGain: Sc<S>;
  focusCouple: Sc<S>;
}

export interface TraceResult<S> {
  dir: Vec3<S>;
  /** 0 or 1 — the ray survived every aperture and every refraction. */
  alive: S;
}

/** One entry of the unrolled axial surface list. */
export interface TraceSurface {
  c: number;
  yMm: number;
  apertureMm: number;
  /** 1 = the surface slides with the focus channel (Optics_G4_Focus's element) */
  focusRide: 0 | 1;
  /** 1 = light ENTERS glass here (eta = 1/n), 0 = it leaves (eta = n) */
  enter: 0 | 1;
  /** 1 = the iris stop: no refraction, and its clear radius is the aperture channel */
  stop: 0 | 1;
  ior: number;
}

/**
 * Every refracting surface plus the iris stop, in AXIAL ORDER front→rear — the
 * order a ray meets them travelling down the optical axis (world +X ≡ gltf +Y).
 *
 * ELEMENT-SEQUENCE ORDER, NOT A SORT (plan amendment 4). The shipped elements
 * are DOMED and NESTED, so their vertex Ys interleave across elements; sorting
 * the flattened list by yMm would scramble the optical sequence and refract a
 * ray through the wrong glass. The ray-hit order AT THE AXIS is the element
 * order itself — front then rear, element 1 through 13 — which
 * __tests__/prescription.test.ts (b) pins, with (d) pinning that the focus
 * slide can never reorder it. So the sequence is fixed ONCE, here, at the
 * nominal (focus = 0) positions.
 *
 * CEMENTED INTERFACES ARE OMITTED (plan amendment 8). Three pairs — E01/E02,
 * E04/E05, E09/E10 — were clamped to a coincident plane on paste, so
 * `rear_k.yMm === front_{k+1}.yMm` exactly; that equality is how they are
 * DERIVED here rather than listed. Both surfaces of each pair are dropped:
 *   • optically the interface is NOTHING — both elements carry the same `ior`,
 *     so glass → air → glass at one plane is a pair of refractions that cancel;
 *   • keeping them would be actively WRONG, not merely wasteful. The second of
 *     two coincident surfaces intersects at t = ±µm of floating-point noise, so
 *     `ahead = step(0, t)` would keep one refraction and skip the other on a
 *     pixel-by-pixel basis: an uncancelled fake bend that shimmers;
 *   • no CLIPPING is lost with them. The probe reports one clear semi-diameter
 *     per element, so an omitted surface's aperture equals the surviving
 *     surface of its own element (18.210/16.809, 6.302/6.302, 6.502/6.602 for
 *     the three pairs) — every omitted aperture is bracketed by the neighbours
 *     that remain, which clip at least as tightly and one vertex away.
 * trace-laws (j) is the tripwire — it fails the moment a look-tune gives a
 * cemented pair unequal indices, at which point a real interface surface has to
 * come back.
 *
 * 13 × 2 − 3 × 2 + 1 iris stop = 21 surfaces.
 */
export const AXIAL_ORDER: readonly TraceSurface[] = (() => {
  // k is cemented when element k's rear vertex and element k+1's front vertex
  // are the SAME plane (Task 2 clamps exactly the three real pairs to their
  // mean, so the equality is exact, never a tolerance).
  const cemented = new Set<number>();
  for (let k = 0; k + 1 < PRESCRIPTION.length; k++)
    if (PRESCRIPTION[k].rear.yMm === PRESCRIPTION[k + 1].front.yMm)
      cemented.add(k);

  const out: TraceSurface[] = [];
  for (let i = 0; i < PRESCRIPTION.length; i++) {
    const e = PRESCRIPTION[i];
    // The front is dropped when this element is the REAR half of a cemented
    // pair; the rear when it is the FRONT half.
    if (!cemented.has(i - 1))
      out.push({
        c: e.front.c,
        yMm: e.front.yMm,
        apertureMm: e.front.apertureMm,
        focusRide: e.focusRide,
        enter: 1,
        stop: 0,
        ior: e.ior,
      });
    if (!cemented.has(i))
      out.push({
        c: e.rear.c,
        yMm: e.rear.yMm,
        apertureMm: e.rear.apertureMm,
        focusRide: e.focusRide,
        enter: 0,
        stop: 0,
        ior: e.ior,
      });
    // The stop goes in the air gap that CONTAINS it — derived, never an index.
    const next = PRESCRIPTION[i + 1];
    if (next && e.rear.yMm > IRIS.yMm && next.front.yMm < IRIS.yMm)
      out.push({
        c: 0,
        yMm: IRIS.yMm,
        apertureMm: IRIS.irisMaxMm,
        focusRide: 0,
        enter: 0,
        stop: 1,
        ior: 1,
      });
  }
  return out;
})();

/**
 * The SAME surfaces, unrolled for a ray travelling the other way: rear→front,
 * i.e. +Y in the gltf frame (world −X → +X), against the light path. The
 * fly-through demo dives sensor-to-sky, so its background warp builds from this
 * table instead of AXIAL_ORDER.
 *
 * TWO things change, and nothing else:
 *   • THE SEQUENCE REVERSES — a ray going +Y meets the rear-most surface first.
 *     The order is still the element sequence, never a sort, for exactly the
 *     reason AXIAL_ORDER gives: the domed elements' vertex Ys interleave.
 *   • EVERY `enter` FLIPS. `enter` is not a property of the surface, it is a
 *     property of the surface AND the direction of travel: the face where light
 *     enters glass going down (−Y) is the face where it LEAVES going up (+Y).
 *     eta = n_before / n_after is read straight off that flag, so a table that
 *     reversed the order without flipping the roles would refract every
 *     interface backwards (1/n where n belongs) — a lens that un-bends.
 * The iris stop is unchanged: it has no `enter` role to swap (it refracts
 * nothing, it only clips), and its clear radius is direction-blind.
 *
 * Apertures, curvatures, vertices and focusRide are all direction-independent
 * geometry and are carried across untouched.
 */
export const AXIAL_ORDER_REVERSED: readonly TraceSurface[] = AXIAL_ORDER.map(
  (s): TraceSurface => (s.stop ? s : { ...s, enter: (1 - s.enter) as 0 | 1 }),
).reverse();

const dot = <S>(A: Algebra<S>, a: Vec3<S>, b: Vec3<S>): S =>
  A.add(A.add(A.mul(a.x, b.x), A.mul(a.y, b.y)), A.mul(a.z, b.z));

/** Normalize, guarding the zero-length case with the EPS-max idiom. A vector
 *  whose squared length is exactly 1 divides by exactly 1 and is returned
 *  bit-unchanged — which is what makes the warpGain = 0 identity exact. */
function norm<S>(A: Algebra<S>, v: Vec3<S>): Vec3<S> {
  const L = A.max(A.sqrt(A.max(dot(A, v, v), 0)), EPS);
  return { x: A.div(v.x, L), y: A.div(v.y, L), z: A.div(v.z, L) };
}

const mixV = <S>(A: Algebra<S>, a: Vec3<S>, b: Vec3<S>, t: Sc<S>): Vec3<S> => ({
  x: A.mix(a.x, b.x, t),
  y: A.mix(a.y, b.y, t),
  z: A.mix(a.z, b.z, t),
});

/**
 * THE SELECT FORM — `whenZero` at flag 0, `whenOne` at flag 1, no branch.
 *
 * EXACT for flag ∈ {0, 1} in IEEE754, which is the whole point: x·1 = x, x·0 = 0
 * and y + 0 = y are all exact, so `sel` returns its chosen operand bit-for-bit.
 * `A.mix` would NOT do — a + (b − a)·t is only approximately b at t = 1 — and
 * the goldens are pinned at 1e-9 with trace-laws (a) pinned EXACTLY. That is
 * why replacing the old build-time `if (!s.stop)` / `s.enter ? … : …` with
 * runtime arithmetic moves no golden.
 *
 * Callers must honour the contract: flag is 0 or 1, never in between, and the
 * un-chosen operand must be finite (0 · NaN is NaN, not 0).
 */
export const sel = <S>(
  A: Algebra<S>,
  flag: Sc<S>,
  whenZero: Sc<S>,
  whenOne: Sc<S>,
): S => A.add(A.mul(flag, whenOne), A.mul(A.sub(1, flag), whenZero));

const selV = <S>(
  A: Algebra<S>,
  flag: Sc<S>,
  whenZero: Vec3<S>,
  whenOne: Vec3<S>,
): Vec3<S> => ({
  x: sel(A, flag, whenZero.x, whenOne.x),
  y: sel(A, flag, whenZero.y, whenOne.y),
  z: sel(A, flag, whenZero.z, whenOne.z),
});

/** Signed EPS floor on a divisor: |den| is lifted to at least EPS while its
 *  sign is preserved, and a den of exactly 0 is treated as +EPS. Branch-free:
 *  sign(0) = 0, so `sign + (1 − |sign|)` is sign for non-zero and 1 at zero. */
function safeDen<S>(A: Algebra<S>, den: S): S {
  const sg = A.sign(den);
  const dir = A.add(sg, A.sub(1, A.abs(sg)));
  return A.mul(dir, A.max(A.abs(den), EPS));
}

interface Hit<S> {
  /** hit point */
  p: Vec3<S>;
  /** hit point relative to the surface vertex — its radial part is the clip */
  q: Vec3<S>;
  /** unit surface normal at the hit */
  n: Vec3<S>;
  /** ray parameter; negative means the surface is behind the origin */
  t: S;
  /** 0 if the quadratic had no real root */
  real: S;
}

/** Intersect a normalized ray with the curvature-form surface at `yMm`. `c` is a
 *  SCALAR, not a number — the GPU path reads it out of a uniform table. */
function intersect<S>(
  A: Algebra<S>,
  p: Vec3<S>,
  d: Vec3<S>,
  c: Sc<S>,
  yMm: Sc<S>,
): Hit<S> {
  const q0: Vec3<S> = { x: p.x, y: A.sub(p.y, yMm), z: p.z };
  // A = c·(d·d) = c since d is normalized; B = 2(c(d·q0) − d_y); C = c|q0|² − 2q0_y
  const B = A.mul(2, A.sub(A.mul(c, dot(A, d, q0)), d.y));
  const C = A.sub(A.mul(c, dot(A, q0, q0)), A.mul(2, q0.y));
  const k = A.sub(A.mul(B, B), A.mul(A.mul(4, c), C));
  const real = A.step(0, k);
  const s = A.sqrt(A.max(k, EPS * EPS));
  // citardauq, minus branch — see the header. Finite as c → 0.
  const t = A.div(A.mul(2, C), safeDen(A, A.sub(A.neg(B), s)));
  const hp: Vec3<S> = {
    x: A.add(p.x, A.mul(t, d.x)),
    y: A.add(p.y, A.mul(t, d.y)),
    z: A.add(p.z, A.mul(t, d.z)),
  };
  const q: Vec3<S> = { x: hp.x, y: A.sub(hp.y, yMm), z: hp.z };
  const n = norm(A, {
    x: A.mul(c, q.x),
    y: A.sub(A.mul(c, q.y), 1),
    z: A.mul(c, q.z),
  });
  return { p: hp, q, n, t, real };
}

/** Snell in vector form. `n` is flipped branch-free to face the incident ray. */
function refract<S>(
  A: Algebra<S>,
  d: Vec3<S>,
  n: Vec3<S>,
  eta: S,
): { dir: Vec3<S>; alive: S } {
  const flip = A.neg(A.sign(dot(A, d, n)));
  const nn: Vec3<S> = {
    x: A.mul(n.x, flip),
    y: A.mul(n.y, flip),
    z: A.mul(n.z, flip),
  };
  const cosI = A.neg(dot(A, d, nn));
  const k = A.sub(1, A.mul(A.mul(eta, eta), A.sub(1, A.mul(cosI, cosI))));
  // k < 0 is total internal reflection: the ray dies, it does not branch.
  const alive = A.step(0, k);
  const f = A.sub(A.mul(eta, cosI), A.sqrt(A.max(k, EPS)));
  return {
    dir: norm(A, {
      x: A.add(A.mul(eta, d.x), A.mul(f, nn.x)),
      y: A.add(A.mul(eta, d.y), A.mul(f, nn.y)),
      z: A.add(A.mul(eta, d.z), A.mul(f, nn.z)),
    }),
    alive,
  };
}

/** The ray state threaded from surface to surface. In the JS path these are
 *  plain numbers rebound each iteration; in the TSL path they are `.toVar()`
 *  shader variables the loop body assigns into. */
export interface TraceState<S> {
  p: Vec3<S>;
  d: Vec3<S>;
  alive: S;
  notYet: S;
  missFirst: S;
}

/** One surface AS THE STEP SEES IT — every flag a runtime scalar, never a
 *  build-time boolean, which is what lets one body serve a JS `for` and a TSL
 *  `Loop` over a uniform table.
 *
 *  `apMm` is CALLER-RESOLVED: the iris stop's clear radius rides the aperture
 *  channel (`TraceStart.clearMm`), every other surface uses its own fixed
 *  semi-diameter. Resolving it outside keeps the surface table STATIC — the GPU
 *  path uploads it once at warp creation and never touches it again, mixing in
 *  `clearMm` per pixel with the same `sel` the flags use. */
export interface StepSurface<S> {
  c: Sc<S>;
  yMm: Sc<S>;
  apMm: Sc<S>;
  /** 1 = this surface slides with the focus channel */
  focusRide: Sc<S>;
  /** 1 = light ENTERS glass here (eta = 1/n), 0 = it leaves (eta = n) */
  enter: Sc<S>;
  /** 1 = the iris stop: it clips but never refracts, and never grants bypass */
  stop: Sc<S>;
  ior: Sc<S>;
}

/** The ray-global inputs every surface folds in: this channel's dispersion
 *  offset and this frame's focus slide. */
export interface StepEnv<S> {
  iorShift: Sc<S>;
  rideMm: Sc<S>;
}

/**
 * ONE SURFACE. The whole of the per-surface physics lives here and nowhere
 * else — the JS unroll (`traceLens`, for the goldens) and the GPU loop
 * (warp.ts) both call THIS function, so the two paths cannot drift.
 *
 * Everything the old build-time conditionals did is now `sel` arithmetic:
 *   • the focus ride is `yMm + focusRide·rideMm` — at focusRide = 0 that adds a
 *     zero, which is exact;
 *   • the stop refracts UNCONDITIONALLY and then throws the result away
 *     (`sel(stop, refracted, incoming)`). Safe because the stop is flat (c = 0),
 *     whose normal is the constant (0, −1, 0) however wild the hit point is, so
 *     the discarded refraction is always finite — `sel`'s no-NaN contract holds;
 *   • `enter` picks eta between n and 1/n;
 *   • `stop` zeroes `isFirst`, which is what keeps an iris miss a KILL rather
 *     than a miss-the-lens bypass (see `traceLens`).
 */
export function traceSurfaceStep<S>(
  A: Algebra<S>,
  state: TraceState<S>,
  surf: StepSurface<S>,
  env: StepEnv<S>,
): TraceState<S> {
  const yMm = A.add(surf.yMm, A.mul(surf.focusRide, env.rideMm));
  const hit = intersect(A, state.p, state.d, surf.c, yMm);
  // A surface BEHIND the ray origin is SKIPPED, not fatal. The fly-through
  // parks the camera between elements (spec §5), and killing on t < 0 blacks
  // the entire sky out the instant the camera passes the front vertex.
  // Everything this surface would do is blended by `ahead` instead.
  const ahead = A.step(0, hit.t);
  const r2 = A.add(A.mul(hit.q.x, hit.q.x), A.mul(hit.q.z, hit.q.z));
  const clip = A.step(0, A.sub(A.mul(surf.apMm, surf.apMm), r2));
  // Latch the bypass BEFORE `notYet` is consumed, so `isFirst` is 1 on exactly
  // the first ahead surface and 0 everywhere else.
  const isFirst = A.mul(A.sub(1, surf.stop), A.mul(state.notYet, ahead));
  const missFirst = A.add(state.missFirst, A.mul(isFirst, A.sub(1, clip)));
  const notYet = A.mul(state.notYet, A.sub(1, ahead));
  const aliveClipped = A.mul(
    state.alive,
    A.mix(1, A.mul(hit.real, clip), ahead),
  );
  // eta = n_before / n_after. Entering: 1/n. Leaving: n. The shift is the
  // dispersion channel offset, guarded so a wild knob can't divide by 0.
  const n = A.max(A.add(surf.ior, env.iorShift), EPS);
  const r = refract(A, state.d, hit.n, sel(A, surf.enter, n, A.div(1, n)));
  return {
    p: mixV(A, state.p, hit.p, ahead),
    d: selV(A, surf.stop, mixV(A, state.d, r.dir, ahead), state.d),
    alive: A.mul(aliveClipped, sel(A, surf.stop, A.mix(1, r.alive, ahead), 1)),
    notYet,
    missFirst,
  };
}

/** What `traceBegin` hands the surface list. */
export interface TraceStart<S> {
  /** the normalized input direction — `traceFinish` mixes back toward it */
  dirIn: Vec3<S>;
  state: TraceState<S>;
  /** the iris clear semi-diameter this frame: the stop's `apMm` */
  clearMm: S;
  /** the focus slide this frame, for `StepEnv.rideMm` */
  rideMm: S;
}

/** Set the ray up and resolve the two per-frame channel values. Split out of
 *  `traceLens` so the GPU loop shares this arithmetic rather than restating it. */
export function traceBegin<S>(
  A: Algebra<S>,
  originMm: Vec3<S>,
  dir: Vec3<S>,
  focusT: Sc<S>,
  apertureT: Sc<S>,
  knobs: TraceKnobs<S>,
): TraceStart<S> {
  const dirIn = norm(A, dir);
  return {
    dirIn,
    state: {
      p: originMm,
      d: dirIn,
      alive: A.lit(1),
      notYet: A.lit(1),
      missFirst: A.lit(0),
    },
    // The iris clear semi-diameter. The aperture channel is 0 = WIDE OPEN and
    // 1 = stopped down (ops/mechanism.ts MechanismDrive), so the radius runs
    // irisMaxMm → irisMinMm as it rises. Rays outside it die: the door is real.
    clearMm: A.mix(IRIS.irisMaxMm, IRIS.irisMinMm, apertureT),
    // The focus slide, mirroring ops/mechanism.ts exactly: Optics_G4_Focus moves
    // +focus × 1.5mm along the optical axis, and L4's surfaces ride it.
    rideMm: A.mul(A.mul(focusT, FOCUS_MM), knobs.focusCouple),
  };
}

/**
 * Close the trace: apply warpGain, honour the bypass, hand back the direction.
 *
 * warpGain exaggerates (or cancels) the whole bend. At 0 this is mix(a, b, 0)
 * = a exactly, and the trailing normalize divides a unit vector by exactly 1
 * — the identity law, pinned by trace-laws (a).
 *
 * A BYPASSING ray discards the whole traced result. Everything the surfaces did
 * to it after the miss was arithmetically real but physically nothing: it
 * refracted through glass it flew past. Nothing needs undoing, only ignoring —
 * and the NaN guards held all the way down that discarded path, which is what
 * trace-laws (d) checks over a grid wide enough to miss the front element.
 *
 * Applied by GATING THE GAIN, not by a trailing mix(traced, dirIn, missFirst).
 * `mix(a, b, 1)` is a + (b−a)·1, which is NOT b to the last ulp, so a trailing
 * mix would return the input direction only approximately. Folding the bypass
 * into the gain makes BOTH branches exact: missFirst = 1 gives mix(dirIn, d, 0)
 * = dirIn bit-for-bit — the same identity trace-laws (a) pins — while
 * missFirst = 0 multiplies the gain by exactly 1, leaving every traced ray's
 * arithmetic untouched, so the goldens do not move.
 */
export function traceFinish<S>(
  A: Algebra<S>,
  dirIn: Vec3<S>,
  state: TraceState<S>,
  knobs: TraceKnobs<S>,
): TraceResult<S> {
  const gain = A.mul(knobs.warpGain, A.sub(1, state.missFirst));
  return {
    dir: norm(A, mixV(A, dirIn, state.d, gain)),
    alive: A.mix(state.alive, 1, state.missFirst),
  };
}

/**
 * Trace one ray from `originMm` (gltf-frame mm) through the prescription.
 *
 * `iorShift` is the per-channel dispersion offset (0 for green). `focusT` and
 * `apertureT` are the live 0..1 channel values — the SAME numbers core/scene
 * feeds ops/mechanism, so the glass the trace refracts through and the glass on
 * screen move together.
 *
 * `order` is the surface table, i.e. the DIRECTION OF TRAVEL: AXIAL_ORDER for
 * light coming in the front (the default), AXIAL_ORDER_REVERSED for a ray
 * running rear→front. The JS loop below unrolls it, which is what the NUM
 * backend wants; the GPU builds the same steps as a real shader loop over the
 * same table uploaded as a uniform (warp.ts), so this function is now the
 * TESTS' entry point rather than the shader's.
 */
export function traceLens<S>(
  A: Algebra<S>,
  originMm: Vec3<S>,
  dir: Vec3<S>,
  iorShift: Sc<S>,
  focusT: Sc<S>,
  apertureT: Sc<S>,
  knobs: TraceKnobs<S> = { warpGain: 1, focusCouple: 1 },
  order: readonly TraceSurface[] = AXIAL_ORDER,
): TraceResult<S> {
  // THE MISS-THE-LENS BYPASS (plan amendment 9). A ray outside the clear
  // aperture of the FIRST surface IN `order` — the first glass it meets
  // travelling its way, front or rear — never entered the glass — it passes AROUND the
  // barrel — so it must see the sky UNWARPED rather than dying. Killing it
  // blacks out the entire background around the lens instead of just the lens.
  // (Where that is physically wrong — the ray would hit barrel wall, not sky —
  // the rendered model is drawn on top and occludes the pixel anyway.)
  //
  // `notYet` is 1 until the first surface AHEAD of the origin is consumed;
  // `missFirst` latches 1 iff THAT surface's aperture rejected the ray. Only
  // one surface can ever contribute, so missFirst is 0 or 1 by construction —
  // no clamp needed. Misses at every LATER surface, plus total internal
  // reflection, are real vignetting inside the glass path and stay black.
  //
  // THE IRIS NEVER GRANTS BYPASS, even when it is the first surface ahead: a
  // ray outside its clear radius is light on the BLADES, which is a kill, not
  // open sky. Without the exclusion a camera parked in the E06→E07 gap (where
  // the stop lives) would render sky straight through closed blades. The stop
  // still CONSUMES `notYet`, so no later surface can grant bypass either —
  // once the ray is past the iris it is unambiguously inside the mechanism.
  const start = traceBegin(A, originMm, dir, focusT, apertureT, knobs);
  const env: StepEnv<S> = { iorShift, rideMm: start.rideMm };

  let state = start.state;
  for (const s of order)
    state = traceSurfaceStep(
      A,
      state,
      {
        c: s.c,
        yMm: s.yMm,
        // the caller's half of the stop's aperture — see StepSurface
        apMm: s.stop ? start.clearMm : s.apertureMm,
        focusRide: s.focusRide,
        enter: s.enter,
        stop: s.stop,
        ior: s.ior,
      },
      env,
    );

  return traceFinish(A, start.dirIn, state, knobs);
}
