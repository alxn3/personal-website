import { describe, expect, it } from "vitest";
import { atPolar, frameAt, makeCtx, polarOf, probe, vertexAt } from "./fixture";
import {
  approach,
  group,
  ladder,
  orbit,
  rot,
  runPipeline,
  selFront,
  spread,
  swirl,
  tilt,
  type OpCtx,
  type OpItem,
  type VertexState,
} from "../ops";

// Transform and orient ops on a hand-built ctx (t0 = 0.3, R = 2) and state.
// Seated positions are given in polar terms.
const T0 = 0.3;
const V0P = { theta: 0.3, radius: 2 };
const F0P = { theta: 0.2, radius: 1.5 };
const V0 = vertexAt(V0P.theta, V0P.radius, {
  axial: 0.5,
  rot: 0.1,
  aim: T0,
  rem: 0,
});
const F0 = frameAt(F0P.theta, F0P.radius, { axial: 0.2, orient: T0 });

/** Run `ops` at weight `w` on `ctx` (fixture defaults: flight 1, stick 1). */
function run(
  ops: OpItem<number>[],
  over: Partial<OpCtx<number>> = {},
  w = 1,
  v: VertexState<number> = V0,
) {
  return runPipeline([selFront<number>(() => w), ...ops], v, F0, makeCtx(over));
}

describe("rot — the working direction", () => {
  it("(a) moves no geometry and turns no normal; it writes both aims", () => {
    const out = run([rot<number>(0.7)]);
    expect({ ...out.v, aim: 0 }).toEqual({ ...V0, aim: 0 });
    expect({ ...out.f, orient: 0 }).toEqual({ ...F0, orient: 0 });
    expect(out.v.aim).toBeCloseTo(T0 + 0.7, 12);
    expect(out.f.orient).toBeCloseTo(T0 + 0.7, 12);
  });

  it("(b) rots compose additively, in either order, and invert", () => {
    const orient = (a: number, b: number) =>
      run([rot<number>(a), rot<number>(b)]).f.orient;
    expect(orient(0.7, -0.25)).toBeCloseTo(T0 + 0.45, 12);
    expect(orient(-0.25, 0.7)).toBeCloseTo(T0 + 0.45, 12);
    expect(orient(0.7, -0.7)).toBeCloseTo(T0, 12);
  });

  it("(c) the direction persists after a group; only the weight is scoped", () => {
    const out = run([group<number>([rot<number>(0.7)]), rot<number>(0.1)]);
    expect(out.f.orient).toBeCloseTo(T0 + 0.8, 12);

    const seen: { w: number; ctx: OpCtx<number> }[] = [];
    const after = run([
      group<number>([selFront<number>(() => 0.5), rot<number>(0.7)]),
      probe(seen),
    ]);
    expect(seen[0].w).toBe(1); // the weight came back
    expect(after.f.orient).toBeCloseTo(T0 + 0.7, 12); // the aim did not
  });

  it("(d) a constant re-aim ignores the weight; a flight-driven one fades with it", () => {
    for (const w of [1, 0.5, 0]) {
      const fixed = run([rot<number>(0.7)], { flight: 0.8 }, w);
      expect(fixed.f.orient, `w = ${w}`).toBeCloseTo(T0 + 0.7, 12);
      // The ctx has flight·w folded in.
      const gated = run([rot<number>((c) => c.flight)], { flight: 0.8 }, w);
      expect(gated.f.orient, `gated w = ${w}`).toBeCloseTo(T0 + 0.8 * w, 12);
    }
  });

  it("(e) takes a ctx function, read when the op runs", () => {
    for (const halfSpan of [0.5, 1.2])
      expect(run([rot<number>((c) => c.halfSpan)], { halfSpan }).f.orient).toBeCloseTo(T0 + halfSpan, 12); // prettier-ignore
  });
});

describe("transforms", () => {
  it("(a) every transform is identity (v AND f) at flight = 0 for any knobs", () => {
    const ops: OpItem<number>[] = [
      approach(3),
      orbit(1.2),
      swirl(1.2, { exp: 2, rankScale: true }),
      spread(0.4),
      ladder<number>(2),
      tilt(1.2),
      tilt(1.2, { pivot: -7 }),
    ];
    const over = { flight: 0, stick: 0.4, rung: 3.7, wrapDir: -1 };
    for (const op of ops) {
      const out = run([op], over, 0.9);
      // `tilt` rebuilds axial as pivot + (axial − pivot), so compare it closely.
      expect({ ...out.v, axial: 0 }).toEqual({ ...V0, axial: 0 });
      expect({ ...out.f, axial: 0 }).toEqual({ ...F0, axial: 0 });
      expect(out.v.axial).toBeCloseTo(V0.axial, 12);
      expect(out.f.axial).toBeCloseTo(F0.axial, 12);
    }
  });

  it("(b) approach and ladder slide axial by flight·w·amount, frame too, nothing else", () => {
    // ladder's amount is the piece's rung × gain.
    for (const [op, amount] of [
      [approach<number>(3), 3],
      [ladder<number>(2), 5 * 2],
    ] as const)
      for (const w of [1, 0.5]) {
        const out = run([op], { flight: 0.8, rung: 5 }, w);
        const delta = 0.8 * w * amount;
        expect({ ...out.v, axial: 0 }).toEqual({ ...V0, axial: 0 });
        expect({ ...out.f, axial: 0 }).toEqual({ ...F0, axial: 0 });
        expect(out.v.axial).toBeCloseTo(V0.axial + delta, 12);
        expect(out.f.axial).toBeCloseTo(F0.axial + delta, 12);
      }
  });

  it("(c) orbit turns the point, v.rot, the frame and f.orient by flight·rad·w, ignoring wrapDir", () => {
    for (const wrapDir of [1, -1])
      for (const w of [1, 0.5]) {
        const out = run([orbit(1.2)], { flight: 0.5, wrapDir }, w);
        const a = 0.5 * 1.2 * w;
        expect(polarOf(out.v).theta, `wrapDir ${wrapDir}`).toBeCloseTo(V0P.theta + a, 12); // prettier-ignore
        expect(out.v.rot).toBeCloseTo(V0.rot + a, 12);
        expect(polarOf(out.f).theta).toBeCloseTo(F0P.theta + a, 12);
        expect(out.f.orient).toBeCloseTo(F0.orient + a, 12);
      }
  });

  it("(c′) swirl is orbit plus the fly-in couplings: flight^exp, (rank01 + ½), wrapDir", () => {
    const over = { flight: 0.5, rank01: 0.5, wrapDir: -1 };
    const out = run([swirl(1.2, { exp: 0.65, rankScale: true })], over);
    const a = Math.pow(0.5, 0.65) * 1.2 * (0.5 + 0.5) * -1;
    expect(polarOf(out.v).theta).toBeCloseTo(V0P.theta + a, 12);
    expect(out.v.rot).toBeCloseTo(V0.rot + a, 12);
    expect(polarOf(out.f).theta).toBeCloseTo(F0P.theta + a, 12);
    expect(out.f.orient).toBeCloseTo(F0.orient + a, 12);

    // Plain swirl is orbit's angle × wrapDir, linear in w.
    expect(polarOf(run([swirl(1.2)], over).v).theta).toBeCloseTo(V0P.theta - 0.6, 12); // prettier-ignore
    expect(polarOf(run([swirl(1.2)], over, 0.5).v).theta).toBeCloseTo(V0P.theta - 0.3, 12); // prettier-ignore
  });

  it("(d) spread slides v and f by flight·frac·R·w along the aim; rot(a) turns it by exactly a", () => {
    for (const a of [0, 0.7, -0.5, -1.9])
      for (const w of [1, 0.5]) {
        const out = run([rot<number>(a), spread<number>(0.4)], { flight: 0.5 }, w); // prettier-ignore
        const D = 0.5 * 0.4 * 2 * w;
        const dir = T0 + a;
        const at = `a = ${a}, w = ${w}`;
        expect(out.v.x, at).toBeCloseTo(V0.x + D * Math.cos(dir), 12);
        expect(out.v.z, at).toBeCloseTo(V0.z + D * Math.sin(dir), 12);
        expect(out.f.x, at).toBeCloseTo(F0.x + D * Math.cos(dir), 12);
        expect(out.f.z, at).toBeCloseTo(F0.z + D * Math.sin(dir), 12);
        // spread itself turns neither the normal nor the direction.
        expect(out.v.rot).toBe(V0.rot);
        expect(out.f.orient).toBeCloseTo(dir, 12);
      }
  });

  it("(d′) spread on an axisymmetric piece pushes each vertex outward; the frame stays", () => {
    const over = { flight: 0.5, t0: 0, halfSpan: Math.PI, axi: 1 };
    const D = 0.5 * 0.4 * 2;
    for (const theta of [0.3, -2.4, 3.0]) {
      const v = { ...V0, ...atPolar(theta, 7) };
      // The same after a rot.
      for (const ops of [
        [spread<number>(0.4)],
        [rot<number>(-0.5), spread<number>(0.4)],
      ]) {
        // prettier-ignore
        const out = run(ops, over, 1, v);
        expect(polarOf(out.v).theta).toBeCloseTo(theta, 12);
        expect(polarOf(out.v).radius).toBeCloseTo(7 + D, 12);
        expect(out.f.x).toBeCloseTo(F0.x, 12);
        expect(out.f.z).toBeCloseTo(F0.z, 12);
      }
    }
  });

  it("(g) tilt turns (radius, axial) about (frame radius, pivot), leaving angle, rot and direction", () => {
    const rad = 1.2;
    const pivot = -0.4;
    for (const w of [1, 0.5]) {
      const out = run([tilt(rad, { pivot })], { flight: 0.5 }, w);
      const a = 0.5 * rad * w; // flight·rad·w
      // (dr, dy) → (dr·cos a + dy·sin a, dy·cos a − dr·sin a); positive rad
      // tips the +Y side outward.
      const dr = V0P.radius - F0P.radius;
      const dy = V0.axial - pivot;
      expect(polarOf(out.v).radius).toBeCloseTo(F0P.radius + dr * Math.cos(a) + dy * Math.sin(a), 12); // prettier-ignore
      expect(out.v.axial).toBeCloseTo(pivot + dy * Math.cos(a) - dr * Math.sin(a), 12); // prettier-ignore
      expect(polarOf(out.v).theta).toBeCloseTo(V0P.theta, 12);
      expect(out.v.rot).toBe(V0.rot);
      // The frame sits on the hinge radius (dr = 0) and turns with it; its
      // direction does not change.
      const dyF = F0.axial - pivot;
      expect(polarOf(out.f).radius).toBeCloseTo(F0P.radius + dyF * Math.sin(a), 12); // prettier-ignore
      expect(out.f.axial).toBeCloseTo(pivot + dyF * Math.cos(a), 12);
      expect(polarOf(out.f).theta).toBeCloseTo(F0P.theta, 12);
      expect(out.f.orient).toBe(F0.orient);
    }

    // The default pivot is the frame centre, which stays fixed.
    const onHinge = {
      ...V0,
      ...atPolar(V0P.theta, F0P.radius),
      axial: F0.axial,
    };
    const still = run([tilt(rad)], { flight: 0.5 }, 1, onHinge);
    expect(polarOf(still.v).radius).toBeCloseTo(F0P.radius, 12);
    expect(still.v.axial).toBeCloseTo(F0.axial, 12);
    expect(polarOf(still.f).radius).toBeCloseTo(F0P.radius, 12);
    expect(still.f.axial).toBeCloseTo(F0.axial, 12);
  });
});
