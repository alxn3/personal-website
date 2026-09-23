import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { fixtureGateAt } from "./fixture-gate";
import { atPolar, frameAt, polarOf, vertexAt } from "./fixture-state";
import {
  approach,
  ladder,
  orbit,
  rot,
  runPipeline,
  spread,
  swirl,
  tilt,
  PART_CLASS,
  type OpCtx,
  type OpItem,
  type PieceFrame,
  type VertexState,
} from "../ops";

// The transform op family, checked on the NUM backend (the executable spec) with
// hand-built ctx/state, mirroring pipeline.test.ts. A transform is called
// directly: run(v, f, w, ctx) → { v, f }.

// The seated pair in BARREL terms, which is how the laws below are stated;
// `fixture-state.ts` converts to the cartesian the state actually carries.
const V0P = { theta: 0.3, radius: 2 };
const F0P = { theta: 0.2, radius: 1.5 };
const V0: VertexState<number> = vertexAt(V0P.theta, V0P.radius, {
  axial: 0.5,
  rot: 0.1,
  aim: 0.3, // seeded to ctx.t0
  rem: 0,
});
const F0: PieceFrame<number> = frameAt(F0P.theta, F0P.radius, {
  axial: 0.2,
  orient: 0.3, // absolute, seeded to ctx.t0
});

// `channel` / `gateAt` are the raw clock and the REAL gate a `during` scope
// would re-run; each case passes its own flight/stick pair, since a transform's
// law does not care which channel produced its flight.
function makeCtx(over: Partial<OpCtx<number>> = {}): OpCtx<number> {
  const rank01 = over.rank01 ?? 0.5;
  const layerPhase = over.layerPhase ?? 0;
  return {
    A: NUM,
    channel: 1,
    gateAt: fixtureGateAt(rank01, layerPhase),
    t0: 0.3,
    R: 2,
    rank01: 0.5,
    layerPhase: 0,
    halfSpan: 0.5,
    partClass: PART_CLASS.structure,
    phi: 0.5, // d = R·(halfSpan − phi) at the house from = −1 ⇒ phi = halfSpan − d/R
    d: 0,
    L: 1,
    yN: 0,
    off: 0,
    height: 40,
    rung: 0,
    axi: 0,
    depth: 0, // a thin sheet
    adopted: 0, // frames its own sector; rides no host shell
    flight: 1,
    stick: 1,
    wrapDir: 1,
    ...over,
  };
}

function runT(
  op: OpItem<number>,
  v: VertexState<number>,
  f: PieceFrame<number>,
  w: number,
  ctx: OpCtx<number>,
): { v: VertexState<number>; f: PieceFrame<number> } {
  if (op.kind !== "transform") throw new Error("not a transform");
  return op.run(v, f, w, ctx);
}

// Assert a transform is a no-op on both vertex and frame. The POINT is strict;
// `axial` is not, because `tilt` rebuilds it as pivot + (axial − pivot), which
// cancels only to within an ULP for a distant hinge.
function expectIdentity(out: {
  v: VertexState<number>;
  f: PieceFrame<number>;
}): void {
  expect(out.v.x).toBe(V0.x);
  expect(out.v.z).toBe(V0.z);
  expect(out.v.rot).toBe(V0.rot);
  expect(out.f.x).toBe(F0.x);
  expect(out.f.z).toBe(F0.z);
  expect(out.f.orient).toBe(F0.orient);
  expect(out.v.axial).toBeCloseTo(V0.axial, 12);
  expect(out.f.axial).toBeCloseTo(F0.axial, 12);
}

describe("transforms", () => {
  it("(a) every transform is identity (v AND f) at flight = 0 for any knobs", () => {
    const ctx = makeCtx({ flight: 0, stick: 0.4, rung: 3.7, wrapDir: -1 });
    const w = 0.9;
    const ops: OpItem<number>[] = [
      approach(3),
      orbit(1.2),
      swirl(1.2, { exp: 2, rankScale: true }),
      spread(0.4),
      ladder<number>(2),
      tilt(1.2),
      tilt(1.2, { pivot: -7 }),
    ];
    for (const op of ops) expectIdentity(runT(op, V0, F0, w, ctx));
  });

  it("(b) approach moves axial by flight·w·axialMm, frame too, the point and rot untouched", () => {
    const ctx = makeCtx({ flight: 0.8, rank01: 0.5 });
    const w = 1;
    const out = runT(approach(3), V0, F0, w, ctx);
    const delta = 0.8 * 1 * 3; // = 2.4
    expect(out.v.axial).toBeCloseTo(V0.axial + delta, 12);
    expect(out.f.axial).toBeCloseTo(F0.axial + delta, 12);
    // Untouched:
    expect(out.v.x).toBe(V0.x);
    expect(out.v.z).toBe(V0.z);
    expect(out.v.rot).toBe(V0.rot);
    expect(out.f.x).toBe(F0.x);
    expect(out.f.z).toBe(F0.z);
    expect(out.f.orient).toBe(F0.orient);
  });

  it("(c) orbit about the AXIS turns the point, v.rot, the frame and f.orient by the SAME angle", () => {
    // The sign is the CALLER's now — ctx.wrapDir does not reach into the op —
    // so a −1 wrapDir must not change the angle by itself.
    for (const wrapDir of [1, -1]) {
      const ctx = makeCtx({ flight: 0.5, wrapDir });
      const out = runT(orbit(1.2), V0, F0, 1, ctx);
      const a = 0.5 * 1.2; // = 0.6
      expect(polarOf(out.v).theta, `wrapDir ${wrapDir}`).toBeCloseTo(V0P.theta + a, 12); // prettier-ignore
      expect(out.v.rot).toBeCloseTo(V0.rot + a, 12);
      expect(polarOf(out.f).theta).toBeCloseTo(F0P.theta + a, 12);
      expect(out.f.orient).toBeCloseTo(F0.orient + a, 12);
    }

    // …and a recipe that WANTS the peel handedness multiplies it in itself.
    const ctx = makeCtx({ flight: 0.5, wrapDir: -1 });
    const signed = runT(orbit(1.2 * ctx.wrapDir), V0, F0, 1, ctx);
    expect(polarOf(signed.v).theta).toBeCloseTo(V0P.theta - 0.6, 12);
  });

  it("(c′) swirl is orbit plus the fly-in couplings: flight^exp, (rank01 + ½), wrapDir", () => {
    // exp 0.65 and rankScale are assemble's; wrapDir stays INSIDE this op,
    // because the swirl is the wrap's own motion.
    const ctx = makeCtx({ flight: 0.5, rank01: 0.5, wrapDir: -1 });
    const out = runT(
      swirl(1.2, { exp: 0.65, rankScale: true }),
      V0,
      F0,
      1,
      ctx,
    );
    const a = Math.pow(0.5, 0.65) * 1.2 * (0.5 + 0.5) * -1;
    expect(polarOf(out.v).theta).toBeCloseTo(V0P.theta + a, 12);
    expect(out.v.rot).toBeCloseTo(V0.rot + a, 12);
    expect(polarOf(out.f).theta).toBeCloseTo(F0P.theta + a, 12);
    expect(out.f.orient).toBeCloseTo(F0.orient + a, 12);

    // Plain swirl (no couplings) is orbit's angle × wrapDir.
    const plain = runT(swirl(1.2), V0, F0, 1, ctx);
    expect(polarOf(plain.v).theta).toBeCloseTo(V0P.theta - 0.6, 12);
    // …and the weight scales the angle linearly, as it does for orbit.
    const half = runT(swirl(1.2), V0, F0, 0.5, ctx);
    expect(polarOf(half.v).theta - V0P.theta).toBeCloseTo(-0.3, 12);
  });

  it("(d) spread displaces along the WORKING DIRECTION — rot then spread IS the old seam flag", () => {
    // F0.orient is the seat (t0 = 0.3), so one rot of −halfSpan aims at
    // t0 − halfSpan: the seam meridian.
    const ctx = makeCtx({ flight: 0.5, R: 2, t0: 0.3, halfSpan: 0.5 });
    const out = runPipeline(
      [rot<number>(-0.5), spread<number>(0.4)],
      V0,
      F0,
      ctx,
    );

    const D = 0.5 * 0.4 * 2 * 1; // = 0.4
    const dir = 0.3 - 0.5 * 1; // = −0.2
    expect(out.v.x).toBeCloseTo(V0.x + D * Math.cos(dir), 12);
    expect(out.v.z).toBeCloseTo(V0.z + D * Math.sin(dir), 12);

    // Frame runs the identical law:
    expect(out.f.x).toBeCloseTo(F0.x + D * Math.cos(dir), 12);
    expect(out.f.z).toBeCloseTo(F0.z + D * Math.sin(dir), 12);

    // The rot did the re-aiming; the spread is a translation, so it turns
    // neither the normal nor the direction it moved along.
    expect(out.v.rot).toBe(V0.rot);
    expect(out.f.orient).toBeCloseTo(dir, 12);
    const plain = runT(spread(0.4), V0, F0, 1, ctx);
    expect(plain.f.orient).toBe(F0.orient);
    expect(plain.v.rot).toBe(V0.rot);
  });

  it("(d′) spread on an AXISYMMETRIC piece dilates per vertex and moves no frame", () => {
    // A body of revolution has no meridian, so sliding it along t0 would drag a
    // ring off-axis; instead every vertex moves out along its OWN meridian
    // (radius + D) and the frame, which a dilation does not translate, stays.
    const ctx = makeCtx({
      flight: 0.5,
      R: 2,
      t0: 0,
      halfSpan: Math.PI,
      axi: 1,
    });
    const D = 0.5 * 0.4 * 2 * 1;

    for (const theta of [0.3, -2.4, 3.0]) {
      const v = { ...V0, ...atPolar(theta, 7) };
      const out = runT(spread(0.4), v, F0, 1, ctx);
      expect(polarOf(out.v).theta).toBeCloseTo(theta, 12); // same meridian
      expect(polarOf(out.v).radius).toBeCloseTo(7 + D, 12); // dilated outward
      expect(out.f.x).toBeCloseTo(F0.x, 12); // frame stays put
      expect(out.f.z).toBeCloseTo(F0.z, 12);
    }

    // A re-aimed spread falls back the same way (an aimed meridian is still a
    // meridian, and a ring has none).
    const seam = runPipeline(
      [rot<number>(-0.5), spread<number>(0.4)],
      V0,
      F0,
      ctx,
    );
    expect(polarOf(seam.v).theta).toBeCloseTo(V0P.theta, 12);
    expect(polarOf(seam.v).radius).toBeCloseTo(V0P.radius + D, 12);
    expect(polarOf(seam.f).radius).toBeCloseTo(F0P.radius, 12);

    // …and axi = 0 is the unchanged piece-meridian law (regression guard).
    const wedge = makeCtx({
      flight: 0.5,
      R: 2,
      t0: 0.3,
      halfSpan: 0.5,
      axi: 0,
    });
    const out = runT(spread(0.4), V0, F0, 1, wedge);
    expect(out.v.x).toBeCloseTo(V0.x + D * Math.cos(0.3), 12);
    expect(out.v.z).toBeCloseTo(V0.z + D * Math.sin(0.3), 12);
    expect(polarOf(out.f).radius).not.toBeCloseTo(F0P.radius, 6);
  });

  it("(e) w = 0.5 halves every displacement", () => {
    const ctx = makeCtx({ flight: 0.8, rank01: 0.5 });

    // approach: linear in w.
    const full = runT(approach(3), V0, F0, 1, ctx);
    const half = runT(approach(3), V0, F0, 0.5, ctx);
    expect(half.v.axial - V0.axial).toBeCloseTo(
      (full.v.axial - V0.axial) / 2,
      12,
    );
    expect(half.f.axial - F0.axial).toBeCloseTo(
      (full.f.axial - F0.axial) / 2,
      12,
    );

    // orbit angle: linear in w.
    const oFull = runT(orbit(1.2), V0, F0, 1, ctx);
    const oHalf = runT(orbit(1.2), V0, F0, 0.5, ctx);
    expect(polarOf(oHalf.v).theta - V0P.theta).toBeCloseTo(
      (polarOf(oFull.v).theta - V0P.theta) / 2,
      12,
    );

    // ladder: linear in w.
    const rung = makeCtx({ flight: 0.8, rung: 5 });
    const lFull = runT(ladder<number>(2), V0, F0, 1, rung);
    const lHalf = runT(ladder<number>(2), V0, F0, 0.5, rung);
    expect(lHalf.v.axial - V0.axial).toBeCloseTo(
      (lFull.v.axial - V0.axial) / 2,
      12,
    );
  });

  it("(f) ladder reads the piece's own rung", () => {
    const attr = runT(
      ladder<number>(2),
      V0,
      F0,
      1,
      makeCtx({ flight: 1, rung: 3 }),
    );
    expect(attr.v.axial).toBeCloseTo(V0.axial + 3 * 2 * 1 * 1, 12);
  });

  it("(g) tilt turns (radius, axial) about the hinge (frame radius, pivot); the meridian, rot and the working direction untouched", () => {
    const ctx = makeCtx({ flight: 0.5 });
    const rad = 1.2;
    const a = 0.5 * rad * 1; // flight·rad·w
    const pivot = -0.4;
    const out = runT(tilt(rad, { pivot }), V0, F0, 1, ctx);
    // The vertex's meridian-plane offset off the hinge point rotates rigidly:
    // (dr, dy) → (dr·cos a + dy·sin a, dy·cos a − dr·sin a) — positive rad tips
    // the +Y side of the pivot OUTWARD.
    const dr = V0P.radius - F0P.radius;
    const dy = V0.axial - pivot;
    expect(polarOf(out.v).radius).toBeCloseTo(
      F0P.radius + dr * Math.cos(a) + dy * Math.sin(a),
      12,
    );
    expect(out.v.axial).toBeCloseTo(
      pivot + dy * Math.cos(a) - dr * Math.sin(a),
      12,
    );
    // The hinge-plane distance is preserved — the motion is rigid per meridian.
    expect(
      Math.hypot(polarOf(out.v).radius - F0P.radius, out.v.axial - pivot),
    ).toBeCloseTo(Math.hypot(dr, dy), 12);
    // The meridian never moves (the hinge is the tangent circle) and rot stays
    // seated, since a tilt turns normals about the local tangent axis, which
    // the single optical-axis rot angle cannot express.
    expect(polarOf(out.v).theta).toBeCloseTo(V0P.theta, 12);
    expect(out.v.rot).toBe(V0.rot);
    // The frame rides the same rotation with dr = 0 (it sits ON the hinge
    // radius); its placement tracks the tilted piece, its facing does not turn.
    const dyF = F0.axial - pivot;
    expect(polarOf(out.f).radius).toBeCloseTo(F0P.radius + dyF * Math.sin(a), 12); // prettier-ignore
    expect(out.f.axial).toBeCloseTo(pivot + dyF * Math.cos(a), 12);
    expect(polarOf(out.f).theta).toBeCloseTo(F0P.theta, 12);
    expect(out.f.orient).toBe(F0.orient);

    // Default pivot = the frame centre: a vertex level with it and on the hinge
    // radius is the fixed point.
    const onHinge: VertexState<number> = {
      ...V0,
      ...atPolar(V0P.theta, F0P.radius),
      axial: F0.axial,
    };
    const still = runT(tilt(rad), onHinge, F0, 1, ctx);
    expect(polarOf(still.v).radius).toBeCloseTo(F0P.radius, 12);
    expect(still.v.axial).toBeCloseTo(F0.axial, 12);
    expect(polarOf(still.f).radius).toBeCloseTo(F0P.radius, 12);
    expect(still.f.axial).toBeCloseTo(F0.axial, 12);

    // w folds like every transform: w = 0.5 halves the ANGLE.
    const half = runT(tilt(rad, { pivot }), V0, F0, 0.5, ctx);
    const aH = a * 0.5;
    expect(polarOf(half.v).radius).toBeCloseTo(
      F0P.radius + dr * Math.cos(aH) + dy * Math.sin(aH),
      12,
    );
  });
});
