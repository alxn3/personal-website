import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { fixtureGateAt } from "./fixture-gate";
import {
  approach,
  ladder,
  orbit,
  rot,
  runPipeline,
  scale,
  shear,
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

const V0: VertexState<number> = {
  theta: 0.3,
  radius: 2,
  axial: 0.5,
  rot: 0.1,
  aim: 0.3, // seeded to ctx.t0
  rem: 0,
};
const F0: PieceFrame<number> = {
  theta: 0.2,
  radius: 1.5,
  axial: 0.2,
  orient: 0.3, // absolute, seeded to ctx.t0
};

// `channel` / `gateAt` are the raw clock and the REAL gate a `during` scope
// would re-run (see fixture-gate.ts); the flight/stick pair each case passes is
// the case's own, since a transform's law does not care which channel produced
// its flight.
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
    rung: 0,
    axi: 0,
    layerN: 5, // one wedge of a 5-cut layer
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

// Assert a transform is a no-op on both vertex and frame (allowing for the
// cartesian round-trip's floating-point dust in scale/shear).
function expectIdentity(out: {
  v: VertexState<number>;
  f: PieceFrame<number>;
}): void {
  expect(out.v.theta).toBeCloseTo(V0.theta, 12);
  expect(out.v.radius).toBeCloseTo(V0.radius, 12);
  expect(out.v.axial).toBeCloseTo(V0.axial, 12);
  expect(out.v.rot).toBeCloseTo(V0.rot, 12);
  expect(out.f.theta).toBeCloseTo(F0.theta, 12);
  expect(out.f.radius).toBeCloseTo(F0.radius, 12);
  expect(out.f.axial).toBeCloseTo(F0.axial, 12);
  expect(out.f.orient).toBeCloseTo(F0.orient, 12);
}

describe("transforms", () => {
  it("(a) every transform is identity (v AND f) at flight = 0 for any knobs", () => {
    const ctx = makeCtx({ flight: 0, stick: 0.4, rung: 3.7, wrapDir: -1 });
    const w = 0.9;
    const ops: OpItem<number>[] = [
      approach(3, 4),
      orbit(1.2),
      orbit(1.2, { about: "frame" }),
      swirl(1.2, { exp: 2, rankScale: true }),
      spread(0.4),
      ladder<number>("attr", 2),
      ladder(5, 2),
      scale(2),
      shear(0.7),
      tilt(1.2),
      tilt(1.2, { pivot: -7 }),
    ];
    for (const op of ops) expectIdentity(runT(op, V0, F0, w, ctx));
  });

  it("(b) approach moves axial by flight·w·(axialMm + rank01·pitchMm), frame too, theta/rot untouched", () => {
    const ctx = makeCtx({ flight: 0.8, rank01: 0.5 });
    const w = 1;
    const out = runT(approach(3, 4), V0, F0, w, ctx);
    const delta = 0.8 * 1 * (3 + 0.5 * 4); // = 4
    expect(out.v.axial).toBeCloseTo(V0.axial + delta, 12);
    expect(out.f.axial).toBeCloseTo(F0.axial + delta, 12);
    // Untouched:
    expect(out.v.theta).toBe(V0.theta);
    expect(out.v.rot).toBe(V0.rot);
    expect(out.f.theta).toBe(F0.theta);
    expect(out.f.orient).toBe(F0.orient);
  });

  it("(c) orbit about the AXIS adds the SAME angle to v.theta, v.rot, f.theta, f.orient", () => {
    // The sign is the CALLER's now — ctx.wrapDir does not reach into the op —
    // so a −1 wrapDir must not change the angle by itself.
    for (const wrapDir of [1, -1]) {
      const ctx = makeCtx({ flight: 0.5, wrapDir });
      const out = runT(orbit(1.2), V0, F0, 1, ctx);
      const a = 0.5 * 1.2; // = 0.6
      expect(out.v.theta, `wrapDir ${wrapDir}`).toBeCloseTo(V0.theta + a, 12);
      expect(out.v.rot).toBeCloseTo(V0.rot + a, 12);
      expect(out.f.theta).toBeCloseTo(F0.theta + a, 12);
      expect(out.f.orient).toBeCloseTo(F0.orient + a, 12);
    }

    // …and a recipe that WANTS the peel handedness multiplies it in itself.
    const ctx = makeCtx({ flight: 0.5, wrapDir: -1 });
    const signed = runT(orbit(1.2 * ctx.wrapDir), V0, F0, 1, ctx);
    expect(signed.v.theta).toBeCloseTo(V0.theta - 0.6, 12);
  });

  it("(c′) swirl is orbit plus the fly-in couplings: flight^exp, (rank01 + ½), wrapDir", () => {
    // The same numbers the flagged orbit produced — swirl is a verbatim copy of
    // that body. exp 0.65 and rankScale are assemble's; wrapDir stays INSIDE
    // this op, because the swirl is the wrap's own motion.
    const ctx = makeCtx({ flight: 0.5, rank01: 0.5, wrapDir: -1 });
    const out = runT(
      swirl(1.2, { exp: 0.65, rankScale: true }),
      V0,
      F0,
      1,
      ctx,
    );
    const a = Math.pow(0.5, 0.65) * 1.2 * (0.5 + 0.5) * -1;
    expect(out.v.theta).toBeCloseTo(V0.theta + a, 12);
    expect(out.v.rot).toBeCloseTo(V0.rot + a, 12);
    expect(out.f.theta).toBeCloseTo(F0.theta + a, 12);
    expect(out.f.orient).toBeCloseTo(F0.orient + a, 12);

    // Plain swirl (no couplings) is orbit's angle × wrapDir.
    const plain = runT(swirl(1.2), V0, F0, 1, ctx);
    expect(plain.v.theta).toBeCloseTo(V0.theta - 0.6, 12);
    // …and the weight scales the angle linearly, as it does for orbit.
    const half = runT(swirl(1.2), V0, F0, 0.5, ctx);
    expect(half.v.theta - V0.theta).toBeCloseTo(-0.3, 12);
  });

  it("(c″) orbit about the FRAME is a rigid spin in place", () => {
    const ctx = makeCtx({ flight: 0.5, wrapDir: 1 });
    const a = 0.5 * 1.2;
    const cx = F0.radius * Math.cos(F0.theta);
    const cz = F0.radius * Math.sin(F0.theta);
    const distToCentre = (v: VertexState<number>): number =>
      Math.hypot(
        v.radius * Math.cos(v.theta) - cx,
        v.radius * Math.sin(v.theta) - cz,
      );

    // RIGID: every vertex of the piece keeps its distance to the frame centre,
    // and turns by exactly `a` about it.
    for (const theta of [0.3, 1.9, -2.2]) {
      for (const radius of [0.4, 2, 5]) {
        const v: VertexState<number> = { ...V0, theta, radius };
        const out = runT(orbit(1.2, { about: "frame" }), v, F0, 1, ctx);
        expect(distToCentre(out.v)).toBeCloseTo(distToCentre(v), 12);
        const before = Math.atan2(
          radius * Math.sin(theta) - cz,
          radius * Math.cos(theta) - cx,
        );
        const after = Math.atan2(
          out.v.radius * Math.sin(out.v.theta) - cz,
          out.v.radius * Math.cos(out.v.theta) - cx,
        );
        expect(Math.atan2(Math.sin(after - before), Math.cos(after - before)))
          .toBeCloseTo(a, 12); // prettier-ignore
      }
    }

    // The centre is the FIXED POINT: frame placement does not move. Direction
    // and normal still advance — the piece turned, it just did not travel.
    const out = runT(orbit(1.2, { about: "frame" }), V0, F0, 1, ctx);
    expect(out.f.theta).toBe(F0.theta);
    expect(out.f.radius).toBe(F0.radius);
    expect(out.f.axial).toBe(F0.axial);
    expect(out.f.orient).toBeCloseTo(F0.orient + a, 12);
    expect(out.v.rot).toBeCloseTo(V0.rot + a, 12);
    expect(out.v.axial).toBe(V0.axial);

    // Revolution WITHOUT spin is the composition of the two, no carry flag: the
    // frame travels by `a` while the piece's own facing comes back to where it
    // started.
    const composed = runPipeline(
      [orbit<number>(1.2), orbit<number>(-1.2, { about: "frame" })],
      V0,
      F0,
      ctx,
    );
    expect(composed.f.theta).toBeCloseTo(F0.theta + a, 12);
    expect(composed.f.orient).toBeCloseTo(F0.orient, 12);
    expect(composed.v.rot).toBeCloseTo(V0.rot, 12);
  });

  it("(d) spread displaces along the WORKING DIRECTION — rot then spread IS the old seam flag", () => {
    // F0.orient is the seat (t0 = 0.3, the direction every piece starts aimed
    // along), so one rot of −halfSpan aims at t0 − halfSpan: the meridian the
    // deleted `seamDir: 1` flag used to name, and the same numbers it produced.
    const ctx = makeCtx({ flight: 0.5, R: 2, t0: 0.3, halfSpan: 0.5 });
    const out = runPipeline(
      [rot<number>(-0.5), spread<number>(0.4)],
      V0,
      F0,
      ctx,
    );

    const D = 0.5 * 0.4 * 2 * 1; // = 0.4
    const dir = 0.3 - 0.5 * 1; // = −0.2
    const px = V0.radius * Math.cos(V0.theta) + D * Math.cos(dir);
    const pz = V0.radius * Math.sin(V0.theta) + D * Math.sin(dir);
    expect(out.v.theta).toBeCloseTo(Math.atan2(pz, px), 12);
    expect(out.v.radius).toBeCloseTo(Math.hypot(px, pz), 12);

    // Frame runs the identical law:
    const fpx = F0.radius * Math.cos(F0.theta) + D * Math.cos(dir);
    const fpz = F0.radius * Math.sin(F0.theta) + D * Math.sin(dir);
    expect(out.f.theta).toBeCloseTo(Math.atan2(fpz, fpx), 12);
    expect(out.f.radius).toBeCloseTo(Math.hypot(fpx, fpz), 12);

    // The rot did the re-aiming; the spread is a translation, so it turns
    // neither the normal nor the direction it moved along.
    expect(out.v.rot).toBe(V0.rot);
    expect(out.f.orient).toBeCloseTo(dir, 12);
    const plain = runT(spread(0.4), V0, F0, 1, ctx);
    expect(plain.f.orient).toBe(F0.orient);
    expect(plain.v.rot).toBe(V0.rot);
  });

  it("(d′) spread on an AXISYMMETRIC piece dilates per vertex and moves no frame", () => {
    // A body of revolution has no meridian (t0 is the pinned 0), so sliding the
    // whole piece along t0 would drag a ring off-axis in an arbitrary direction.
    // Instead every vertex moves out along its OWN meridian — the classic
    // explode's radial dilation: theta unchanged, radius + D — and the frame,
    // which a dilation does not translate, stays exactly put.
    const ctx = makeCtx({
      flight: 0.5,
      R: 2,
      t0: 0,
      halfSpan: Math.PI,
      axi: 1,
    });
    const D = 0.5 * 0.4 * 2 * 1;

    for (const theta of [0.3, -2.4, 3.0]) {
      const v = { ...V0, theta, radius: 7 };
      const out = runT(spread(0.4), v, F0, 1, ctx);
      expect(out.v.theta).toBeCloseTo(theta, 12); // same meridian
      expect(out.v.radius).toBeCloseTo(7 + D, 12); // dilated outward
      expect(out.f.theta).toBeCloseTo(F0.theta, 12); // frame stays put
      expect(out.f.radius).toBeCloseTo(F0.radius, 12);
    }

    // A re-aimed spread falls back the same way (an aimed meridian is still a
    // meridian, and a ring has none).
    const seam = runPipeline(
      [rot<number>(-0.5), spread<number>(0.4)],
      V0,
      F0,
      ctx,
    );
    expect(seam.v.theta).toBeCloseTo(V0.theta, 12);
    expect(seam.v.radius).toBeCloseTo(V0.radius + D, 12);
    expect(seam.f.radius).toBeCloseTo(F0.radius, 12);

    // …and axi = 0 is the unchanged piece-meridian law (regression guard).
    const wedge = makeCtx({
      flight: 0.5,
      R: 2,
      t0: 0.3,
      halfSpan: 0.5,
      axi: 0,
    });
    const out = runT(spread(0.4), V0, F0, 1, wedge);
    const px = V0.radius * Math.cos(V0.theta) + D * Math.cos(0.3);
    const pz = V0.radius * Math.sin(V0.theta) + D * Math.sin(0.3);
    expect(out.v.theta).toBeCloseTo(Math.atan2(pz, px), 12);
    expect(out.v.radius).toBeCloseTo(Math.hypot(px, pz), 12);
    expect(out.f.radius).not.toBeCloseTo(F0.radius, 6);
  });

  it("(e) w = 0.5 halves every displacement", () => {
    const ctx = makeCtx({ flight: 0.8, rank01: 0.5 });

    // approach: linear in w.
    const full = runT(approach(3, 4), V0, F0, 1, ctx);
    const half = runT(approach(3, 4), V0, F0, 0.5, ctx);
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
    expect(oHalf.v.theta - V0.theta).toBeCloseTo(
      (oFull.v.theta - V0.theta) / 2,
      12,
    );

    // ladder: linear in w.
    const lFull = runT(ladder(5, 2), V0, F0, 1, ctx);
    const lHalf = runT(ladder(5, 2), V0, F0, 0.5, ctx);
    expect(lHalf.v.axial - V0.axial).toBeCloseTo(
      (lFull.v.axial - V0.axial) / 2,
      12,
    );
  });

  it("(f) scale(2) at flight 1, w 1 doubles the vertex's offset from the frame centre; shear displaces theta-wise ∝ (axial − f.axial)", () => {
    const ctx = makeCtx({ flight: 1 });

    // Frame centre and vertex in radial-plane cartesian.
    const cx = F0.radius * Math.cos(F0.theta);
    const cz = F0.radius * Math.sin(F0.theta);
    const vx = V0.radius * Math.cos(V0.theta);
    const vz = V0.radius * Math.sin(V0.theta);
    const offBefore = Math.hypot(vx - cx, vz - cz, V0.axial - F0.axial);

    const out = runT(scale(2), V0, F0, 1, ctx);
    const nx = out.v.radius * Math.cos(out.v.theta);
    const nz = out.v.radius * Math.sin(out.v.theta);
    const offAfter = Math.hypot(nx - cx, nz - cz, out.v.axial - F0.axial);
    expect(offAfter).toBeCloseTo(2 * offBefore, 12);
    // Frame is the fixed point; rot unchanged.
    expect(out.f).toEqual(F0);
    expect(out.v.rot).toBe(V0.rot);

    // ladder rung = ctx.rung when rungOf === "attr".
    const attr = runT(
      ladder<number>("attr", 2),
      V0,
      F0,
      1,
      makeCtx({ flight: 1, rung: 3 }),
    );
    expect(attr.v.axial).toBeCloseTo(V0.axial + 3 * 2 * 1 * 1, 12);

    // shear: the tangential push (tang) is exactly amt·flight·w·(axial − f.axial),
    // added perpendicular to the meridian ⇒ Δtheta = atan2(tang, radius).
    const amt = 0.7;
    const tangOf = (vtx: VertexState<number>): number =>
      amt * 1 * 1 * (vtx.axial - F0.axial);
    const near: VertexState<number> = { ...V0, axial: F0.axial + 0.3 };
    const far: VertexState<number> = { ...V0, axial: F0.axial + 0.6 };
    const sNear = runT(shear(amt), near, F0, 1, ctx);
    const sFar = runT(shear(amt), far, F0, 1, ctx);
    expect(sNear.v.theta).toBeCloseTo(
      near.theta + Math.atan2(tangOf(near), near.radius),
      12,
    );
    expect(sFar.v.theta).toBeCloseTo(
      far.theta + Math.atan2(tangOf(far), far.radius),
      12,
    );
    // The raw tangential displacement is proportional to (axial − f.axial): the
    // far vertex (2× the offset) is pushed exactly 2×.
    expect(tangOf(far) / tangOf(near)).toBeCloseTo(2, 12);
    // A vertex level with the frame (axial === f.axial) is unmoved.
    const level: VertexState<number> = { ...V0, axial: F0.axial };
    const sLevel = runT(shear(amt), level, F0, 1, ctx);
    expect(sLevel.v.theta).toBeCloseTo(level.theta, 12);
    expect(sLevel.v.radius).toBeCloseTo(level.radius, 12);
    // Frame + rot unchanged.
    expect(sNear.f).toEqual(F0);
    expect(sNear.v.rot).toBe(V0.rot);
  });

  it("(g) tilt turns (radius, axial) about the hinge (f.radius, pivot); theta, rot and the working direction untouched", () => {
    const ctx = makeCtx({ flight: 0.5 });
    const rad = 1.2;
    const a = 0.5 * rad * 1; // flight·rad·w
    const pivot = -0.4;
    const out = runT(tilt(rad, { pivot }), V0, F0, 1, ctx);
    // The vertex's meridian-plane offset off the hinge point rotates rigidly:
    // (dr, dy) → (dr·cos a + dy·sin a, dy·cos a − dr·sin a) — positive rad tips
    // the +Y side of the pivot OUTWARD.
    const dr = V0.radius - F0.radius;
    const dy = V0.axial - pivot;
    expect(out.v.radius).toBeCloseTo(
      F0.radius + dr * Math.cos(a) + dy * Math.sin(a),
      12,
    );
    expect(out.v.axial).toBeCloseTo(
      pivot + dy * Math.cos(a) - dr * Math.sin(a),
      12,
    );
    // The hinge-plane distance is preserved — the motion is rigid per meridian.
    expect(
      Math.hypot(out.v.radius - F0.radius, out.v.axial - pivot),
    ).toBeCloseTo(Math.hypot(dr, dy), 12);
    // theta never moves (the hinge is the tangent circle), and rot stays seated
    // — a tilt turns normals about the local tangent axis, which the one
    // optical-axis rot angle cannot express (see the op's note).
    expect(out.v.theta).toBe(V0.theta);
    expect(out.v.rot).toBe(V0.rot);
    // The frame rides the same rotation with dr = 0 (it sits ON the hinge
    // radius); its placement tracks the tilted piece, its facing does not turn.
    const dyF = F0.axial - pivot;
    expect(out.f.radius).toBeCloseTo(F0.radius + dyF * Math.sin(a), 12);
    expect(out.f.axial).toBeCloseTo(pivot + dyF * Math.cos(a), 12);
    expect(out.f.theta).toBe(F0.theta);
    expect(out.f.orient).toBe(F0.orient);

    // Default pivot = the frame centre: a vertex level with it and on the hinge
    // radius is the fixed point.
    const onHinge: VertexState<number> = {
      ...V0,
      radius: F0.radius,
      axial: F0.axial,
    };
    const still = runT(tilt(rad), onHinge, F0, 1, ctx);
    expect(still.v.radius).toBeCloseTo(F0.radius, 12);
    expect(still.v.axial).toBeCloseTo(F0.axial, 12);
    expect(still.f.radius).toBeCloseTo(F0.radius, 12);
    expect(still.f.axial).toBeCloseTo(F0.axial, 12);

    // w folds like every transform: w = 0.5 halves the ANGLE.
    const half = runT(tilt(rad, { pivot }), V0, F0, 0.5, ctx);
    const aH = a * 0.5;
    expect(half.v.radius).toBeCloseTo(
      F0.radius + dr * Math.cos(aH) + dy * Math.sin(aH),
      12,
    );
  });
});
