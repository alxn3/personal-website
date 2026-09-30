import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { atPolar, frameAt, makeCtx, polarOf, vertexAt } from "./fixture";
import {
  anchor,
  arc,
  coil,
  crease,
  rot,
  runPipeline,
  selFront,
  straight,
  type OpCtx,
  type OpItem,
  type VertexState,
} from "../ops";

// Modifier ops (the bend chain and coil). Test wedge: half-span 0.4 rad on
// radius 10, so L = 8 mm. d = R·(halfSpan − phi): 0 at the seam
// (phi = +halfSpan), L at the far edge.

const R = 10;
const HALF = 0.4;
const T0 = 0.3;
const L = R * 2 * HALF; // 8

// The seam angle where `rot(halfSpan); anchor()` starts a chain, and its tangent.
const N0 = T0 + HALF;
const NHAT: [number, number] = [Math.cos(N0), Math.sin(N0)];
const THAT: [number, number] = [Math.sin(N0), -Math.cos(N0)];
const SEAT: [number, number] = [R * NHAT[0], R * NHAT[1]];
/** Every chain below starts by aiming at the seam and anchoring there. */
const chain = (...ops: OpItem<number>[]): OpItem<number>[] => [
  rot<number>((c) => c.halfSpan),
  anchor<number>(),
  ...ops,
];

/** The ctx at material coordinate d, seated (flight 0, stick 1) by default. */
const ctxAt = (d: number, over: Partial<OpCtx<number>> = {}): OpCtx<number> =>
  makeCtx({
    channel: 0,
    R,
    halfSpan: HALF,
    d,
    L,
    phi: HALF - d / R,
    flight: 0,
    stick: 1,
    ...over,
  });

// The seated vertex state at material coordinate d (plus any wall offset).
const seatedAt = (ctx: OpCtx<number>): VertexState<number> =>
  vertexAt(ctx.t0 + ctx.phi, ctx.R + ctx.off, {
    axial: 0.7,
    rot: 0,
    aim: ctx.t0,
    rem: 0,
  });

/** Run `ops` on the seated vertex at d, at weight w (modifiers get it folded
 *  into the ctx, so it is applied with a selector). */
function bend(
  ops: OpItem<number>[],
  d: number,
  over: Partial<OpCtx<number>> = {},
  w = 1,
  v?: VertexState<number>,
): VertexState<number> {
  const ctx = ctxAt(d, over);
  const frame = frameAt(T0, R, { axial: 0, orient: T0 });
  return runPipeline([selFront<number>(() => w), ...ops], v ?? seatedAt(ctx), frame, ctx).v; // prettier-ignore
}

const xz = (v: VertexState<number>): [number, number] => [v.x, v.z];
const dist = (a: [number, number], b: [number, number]): number =>
  Math.hypot(a[0] - b[0], a[1] - b[1]);
/** The absolute aim a bent vertex exits at. */
const aimOf = (out: VertexState<number>, d: number): number =>
  out.rot + T0 + HALF - d / R;

describe("anchor / arc", () => {
  it("(a) an all-q=1 chain off the seam anchor is the seated identity, including overrun and a wall offset", () => {
    const op = chain(arc<number>(1, L / 2), arc<number>(1));
    for (const d of [-1.5, 0, 0.001, 2, L / 2, L, L + 2.5])
      for (const off of [0, 0.35]) {
        const out = bend(op, d, { off });
        expect(polarOf(out).theta - (T0 + HALF - d / R)).toBeCloseTo(0, 9);
        expect(polarOf(out).radius - (R + off)).toBeCloseTo(0, 9);
        expect(out.rot).toBeCloseTo(0, 9);
        expect(out.axial).toBe(0.7); // v.axial passes through UNCHANGED
      }
  });

  it("(b) a roll-step chain lays a flat run then rolls: closed-form cartesian check", () => {
    const s0 = L / 2;
    const op = chain(arc<number>(0, s0), arc<number>(1));
    // d = 0: nothing consumed, so the point is the anchor R·n̂.
    const p0 = xz(bend(op, 0));
    expect(p0[0]).toBeCloseTo(SEAT[0], 8);
    expect(p0[1]).toBeCloseTo(SEAT[1], 8);
    // d = L: s0 laid flat along t̂, the rest rolled on radius R about C = t̂·s0.
    const out = bend(op, L);
    const nEnd = N0 - (L - s0) / R;
    expect(out.x).toBeCloseTo(THAT[0] * s0 + R * Math.cos(nEnd), 8);
    expect(out.z).toBeCloseTo(THAT[1] * s0 + R * Math.sin(nEnd), 8);
    expect(aimOf(out, L)).toBeCloseTo(nEnd, 8);
  });

  it("(c) participation bends only its share of the material, never walking past d", () => {
    const half = chain(arc<number>(1, undefined, { participation: 0.5 }));
    const full = chain(arc<number>(1));
    for (const d of [1, 2, 3, 5, L]) {
      // Half the material bends, so half the turn.
      expect(aimOf(bend(half, d), d) - N0).toBeCloseTo((aimOf(bend(full, d), d) - N0) / 2, 9); // prettier-ignore
      const moved = dist(xz(bend(half, d)), SEAT);
      expect(moved).toBeLessThanOrEqual(d + 1e-9);
      expect(moved).toBeGreaterThan(0);
    }
  });

  // The closed forms below: bent = c·s, psi = q·bent/R, slip = s − bent,
  // chord = bent·sinc(psi/2), P = R·n̂(N0) + chord·t̂(N0 − psi/2) + slip·t̂(N0 − psi).
  it.each([
    // q = 1, c = 0.5 at d = L: bent 4, psi 0.4, exit n = 0.3; rot = 0.4.
    ["the unbent share runs along the exit tangent", chain(arc<number>(1, undefined, { participation: 0.5 })), L, [10.735445717901419, -0.866143889889029, 0.4]], // prettier-ignore
    // q = −2, len 2, c = 0.6 at d = 1.5: bent 0.9, psi −0.18, exit n = 0.88;
    // rot = 0.88 − (0.3 + 0.25) = 0.33 (outward, the other way to the barrel).
    ["negative q rolls the other way", chain(arc<number>(-2, 2, { participation: 0.6 }), arc<number>(1)), 1.5, [8.749320415613807, 5.42728022755137, 0.33]], // prettier-ignore
  ] as const)("(c′) %s (closed form)", (_, op, d, [x, z, r]) => {
    const out = bend([...op], d);
    expect(out.x).toBeCloseTo(x, 10);
    expect(out.z).toBeCloseTo(z, 10);
    expect(out.rot).toBeCloseTo(r, 12);
  });

  it("(d) a zero-length arc contributes nothing and q = 0 is a straight line", () => {
    for (const d of [0, 2, 5, L, L + 1]) {
      const a = bend(chain(arc<number>(5, 0), arc<number>(1)), d);
      const b = bend(chain(arc<number>(1)), d);
      expect(a.x).toBeCloseTo(b.x, 12);
      expect(a.z).toBeCloseTo(b.z, 12);
      expect(a.rot).toBeCloseTo(b.rot, 12);
    }
    // q = 0 walks straight along the anchor tangent without turning.
    for (const d of [0, 1.5, L]) {
      const out = bend(chain(arc<number>(0)), d);
      expect(aimOf(out, d)).toBeCloseTo(N0, 9);
      expect(out.x).toBeCloseTo(SEAT[0] + THAT[0] * d, 8);
      expect(out.z).toBeCloseTo(SEAT[1] + THAT[1] * d, 8);
    }
  });
});

describe("crease", () => {
  const W = 0.5; // the crease's material band, model-mm

  it("(h) rad = 0 is exactly a seated arc", () => {
    const creased = chain(arc<number>(1, 2), crease<number>(0, W), arc<number>(1)); // prettier-ignore
    const plain = chain(arc<number>(1, 2), arc<number>(1, W), arc<number>(1));
    // All of the material (overrun ends and an off-wall vertex included).
    for (const d of [-1.5, 0, 0.3, 2, 2.25, 2.6, L, L + 2])
      for (const off of [0, 0.35]) {
        const a = bend(creased, d, { off });
        const b = bend(plain, d, { off });
        // Exactly equal: rad = 0 gives q = 1 through the same chainStep.
        expect([a.x, a.z, a.rot]).toEqual([b.x, b.z, b.rot]);
        expect(a.rot).toBeCloseTo(0, 12);
        expect(polarOf(a).radius).toBeCloseTo(R + off, 12);
      }
  });

  it("(h′) the turn across the band is the seated turn ± rad, and only past the band", () => {
    const RAD = 0.6;
    const fold = (rad: number) => chain(arc<number>(0, 3), crease<number>(rad, W), arc<number>(0)); // prettier-ignore
    // ψ = (1 + rad·R/W)·W/R = W/R + rad.
    expect(aimOf(bend(fold(RAD), L), L)).toBeCloseTo(N0 - (W / R + RAD), 12);
    const back = bend(fold(-RAD), L);
    expect(aimOf(back, L)).toBeCloseTo(N0 - (W / R - RAD), 12);
    expect(back.rot).toBeGreaterThan(0); // turned the opposite way
    // The band uses exactly W, so a vertex before it is unaffected.
    const a = bend(fold(RAD), 1.5);
    const b = bend(chain(arc<number>(0, 3)), 1.5);
    expect(a.x).toBeCloseTo(b.x, 12);
    expect(a.z).toBeCloseTo(b.z, 12);
  });

  it("(h″) panel/crease/panel/crease/panel: panels stay flat, the turn is in the folds", () => {
    const RAD = 0.5;
    const [p1, p2] = [2, 3]; // panel lengths; the last is the remainder
    const tent = chain(
      arc<number>(0, p1),
      crease<number>(RAD, W),
      arc<number>(0, p2),
      crease<number>(RAD, W),
      arc<number>(0),
    );
    // Three points in a panel are collinear.
    const straightness = (...ds: [number, number, number]): number => {
      const [P, Q, S] = ds.map((d) => xz(bend(tent, d)));
      return Math.abs(
        (Q[0] - P[0]) * (S[1] - P[1]) - (Q[1] - P[1]) * (S[0] - P[0]),
      );
    };
    expect(straightness(0.1, 1, 1.9)).toBeLessThan(1e-12);
    expect(straightness(p1 + W + 0.1, p1 + W + 1.5, p1 + W + p2 - 0.1)).toBeLessThan(1e-12); // prettier-ignore
    expect(straightness(p1 + p2 + 2 * W + 0.1, L - 1, L)).toBeLessThan(1e-12);
    // Both folds turn by the same angle, plus the bands' seated turn.
    const fold = W / R + RAD;
    for (const [d, turns] of [
      [1, 0],
      [p1 + W + 1, 1],
      [L, 2],
    ])
      // prettier-ignore
      expect(aimOf(bend(tent, d), d)).toBeCloseTo(N0 - turns * fold, 12);
  });
});

describe("straight", () => {
  // A bend before the flat run, so it starts from a turned aim.
  const bentThen = (tail: OpItem<number>) =>
    chain(arc<number>(1, L / 3), arc<number>(-0.6, L / 3), tail);

  it("(i) straight walks exactly `len` along the aim; arc(0) falls slightly short", () => {
    const len = 3;
    const out = bend(chain(straight<number>(len)), L);
    expect(dist(xz(out), [SEAT[0] + len * THAT[0], SEAT[1] + len * THAT[1]])).toBeLessThan(1e-13); // prettier-ignore
    // arc(0) walks len·sinc(ε) (the guard's clamp), so it is slightly short.
    const shortfall = dist(xz(out), xz(bend(chain(arc<number>(0, len)), L)));
    expect(shortfall).toBeGreaterThan(0);
    expect(shortfall).toBeCloseTo(len * (1 - Math.sin(1e-5) / 1e-5), 15);
  });

  it("(i′) straight matches arc(0) everywhere, up to that residual, and keeps rot/aim/axial", () => {
    for (const flight of [0.25, 0.5, 0.75, 1])
      for (const frac of [-0.2, 0, 0.25, 0.5, 0.75, 1, 1.2])
        for (const off of [0, 0.35])
          for (const tail of [bentThen, (t: OpItem<number>) => chain(t)]) {
            const over = { flight, stick: 0, off };
            const a = bend(tail(straight<number>()), frac * L, over);
            const b = bend(tail(arc<number>(0)), frac * L, over);
            // Bound: the clamp times the material the tail can spend.
            const at = `flight ${flight} frac ${frac} off ${off}`;
            expect(dist(xz(a), xz(b)), at).toBeLessThan(1e-9);
            expect([a.rot, a.aim, a.axial], at).toEqual([b.rot, b.aim, b.axial]); // prettier-ignore
            expect(a.rem).toBeCloseTo(b.rem, 12);
          }
  });

  it("(i‴) the cursor spends min(rem, len), the negative overrun included", () => {
    // An overrun vertex has negative rem and walks backwards.
    for (const [d, len, spent] of [
      [L, 3, 3], // len < rem: spend len
      [2, 5, 2], // len > rem: spend the remainder
      [-1.5, 3, -1.5], // negative overrun: min picks the cursor, walk-back
    ]) {
      const out = bend(chain(straight<number>(len)), d);
      expect(out.rem, `d = ${d}`).toBeCloseTo(d - spent, 12);
      const seat = bend(chain(), d);
      expect((out.x - seat.x) * THAT[0] + (out.z - seat.z) * THAT[1], `walk d = ${d}`).toBeCloseTo(spent, 12); // prettier-ignore
    }
    // With no `len` it takes all that's left.
    expect(bend(chain(straight<number>()), L).rem).toBe(0);
  });
});

describe("coil", () => {
  const V = vertexAt(0.42, 10.6, { axial: 1.1, rot: 0.07, aim: T0, rem: 0 });
  const coilAt = (over: Partial<OpCtx<number>>, w = 1) =>
    bend([coil<number>(0.5)], 2, { yN: 0.4, ...over }, w, V);

  it("(e) an exact identity at flight 0, and at w = 0 even at full channel", () => {
    expect(coilAt({ flight: 0, stick: 1 })).toEqual(V);
    expect(coilAt({ flight: 1, stick: 0 }, 0)).toEqual(V);
  });

  it("(e′) keeps arc length: the angle from the sector centre scales by 1/factor, flight scaled by w", () => {
    // w = 1, flight 0.5: coilF = mix(1, 0.5, 0.5) = 0.75.
    // w = 0.5, flight 0.8: flightEff = 0.4 ⇒ coilF = 0.8.
    for (const [flight, w, coilF] of [
      [0.5, 1, 0.75],
      [0.8, 0.5, 0.8],
    ]) {
      // prettier-ignore
      const co = coilAt({ flight }, w);
      const phi = HALF - 2 / R; // 0.2
      const open = phi / coilF - phi;
      expect(polarOf(co).theta).toBeCloseTo(0.42 + open, 12);
      expect(co.rot).toBeCloseTo(0.07 + open, 12);
      expect(polarOf(co).radius).toBeCloseTo(10.6 + R * (coilF - 1), 12);
    }
  });
});

describe("modifier weight: a masked piece stays seated", () => {
  it("(f) a live chain at w = 0 is the exact seated state even at full channel", () => {
    // Seated only at flight 0 / stick 1.
    const live = [
      rot<number>((c) => c.halfSpan),
      anchor<number>((c) => c.R * (1 + 0.3 * (1 - c.stick))),
      arc<number>(0, (c) => c.flight * c.L * 0.5),
      arc<number>(1),
    ];
    for (const d of [0, 1.5, L / 2, L, L + 2]) {
      const out = bend(live, d, { flight: 1, stick: 0 }, 0);
      expect(polarOf(out).theta).toBeCloseTo(T0 + HALF - d / R, 12);
      expect(polarOf(out).radius).toBeCloseTo(R, 12);
      expect(out.rot).toBeCloseTo(0, 12);
      expect(out.axial).toBe(0.7);
      // At w = 1 the same chain does deform.
      const moved = bend(live, d, { flight: 1, stick: 0 });
      expect(Math.abs(polarOf(moved).radius - R)).toBeGreaterThan(1e-3);
    }
  });

  it("(f″) at fractional w the weight is folded into the gate (closed form)", () => {
    // flightEff = flight·w, stickEff = mix(1, stick, w). With flight 1,
    // stick 0, w = 0.5 both are 0.5, so the flat run is flightEff·L = 4
    // material-mm and the anchor lifts to R·(1 + 0.25·(1 − stickEff)) = 11.25.
    //   d = 8: 4 mm flat along t̂(0.7), then 4 mm of seated arc (psi = 0.4,
    //     chord 20·sin(0.2) along t̂(0.5)), exiting at n = 0.3 ⇒ rot = 0.4.
    //   d = 2: inside the flat run, so the second arc gets s = 0 ⇒ rot = 0.2.
    const op = [
      rot<number>((c) => c.halfSpan),
      anchor<number>((c) => c.R * (1 + 0.25 * (1 - c.stick))),
      arc<number>(0, (c) => c.flight * c.L),
      arc<number>(1),
    ];
    const GOLDEN = [
      { d: 8, theta: 0.05352440319286591, radius: 13.105055979840916, rot: 0.4 }, // prettier-ignore
      { d: 2, theta: 0.5240603745474721, radius: 11.426394882026438, rot: 0.2 },
    ];
    const full = { flight: 1, stick: 0 };
    for (const g of GOLDEN) {
      const out = bend(op, g.d, full, 0.5);
      // 10 places: trig rounding.
      expect(polarOf(out).theta, `d = ${g.d} theta`).toBeCloseTo(g.theta, 10);
      expect(polarOf(out).radius, `d = ${g.d} radius`).toBeCloseTo(g.radius, 10); // prettier-ignore
      expect(out.rot, `d = ${g.d} rot`).toBeCloseTo(g.rot, 12);
    }
    // Simply blending seated and w = 1 positions gives a different point.
    const seated = seatedAt(ctxAt(8, full));
    const moved = bend(op, 8, full);
    const pinned = atPolar(GOLDEN[0].theta, GOLDEN[0].radius);
    const mixed: [number, number] = [
      NUM.mix(seated.x, moved.x, 0.5),
      NUM.mix(seated.z, moved.z, 0.5),
    ];
    expect(dist(mixed, [pinned.x, pinned.z])).toBeGreaterThan(0.5);
  });
});
