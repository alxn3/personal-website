import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { atPolar, frameAt, polarOf, vertexAt } from "./fixture-state";
import { fixtureGateAt } from "./fixture-gate";
import {
  anchor,
  arc,
  coil,
  crease,
  rot,
  runPipeline,
  selFront,
  straight,
  PART_CLASS,
  type OpCtx,
  type OpItem,
  type PieceFrame,
  type VertexState,
} from "../ops";

// The modifier op family on the NUM backend (the executable spec). A modifier
// advances only the vertex state — it never sees (or returns) a frame.
//
// House geometry for these tests: a wedge of half-span 0.4 rad on a barrel of
// radius 10 ⇒ material length L = R·2·halfSpan = 8 model-mm. The house winding
// puts the seam at the +halfSpan edge, so the material coordinate runs
// d = R·(halfSpan − phi): d = 0 at the seam edge (phi = +halfSpan) up to d = L
// at the far edge (phi = −halfSpan).

const R = 10;
const HALF = 0.4;
const T0 = 0.3;
const L = R * 2 * HALF; // 8

// Where `rot(halfSpan); anchor()` starts a chain: the seam meridian, and the
// tangent the chain walks along there.
const N0 = T0 + HALF;
const NHAT: [number, number] = [Math.cos(N0), Math.sin(N0)];
const THAT: [number, number] = [Math.sin(N0), -Math.cos(N0)];
// Every chain below starts the same way: aim at the seam, then anchor there.
const SEAM = (): OpItem<number>[] => [
  rot<number>((c) => c.halfSpan),
  anchor<number>(),
];

function phiOf(d: number): number {
  return HALF - d / R;
}

function ctxAt(d: number, over: Partial<OpCtx<number>> = {}): OpCtx<number> {
  const rank01 = over.rank01 ?? 0.5;
  const layerPhase = over.layerPhase ?? 0;
  return {
    A: NUM,
    channel: 0, // the raw clock; `gateAt` is the real gate (fixture-gate.ts)
    gateAt: fixtureGateAt(rank01, layerPhase),
    t0: T0,
    R,
    rank01: 0.5,
    layerPhase: 0,
    halfSpan: HALF,
    partClass: PART_CLASS.structure,
    d,
    L,
    yN: 0,
    off: 0,
    height: 40,
    rung: 0,
    axi: 0,
    depth: 0, // a thin sheet
    adopted: 0, // frames its own sector; rides no host shell
    flight: 0,
    stick: 1,
    phi: phiOf(d),
    wrapDir: 1,
    ...over,
  };
}

// The seated vertex state at material coordinate d: on the barrel (plus any wall
// offset), at the seated meridian, with a zero rotation accumulator.
function seatedAt(ctx: OpCtx<number>): VertexState<number> {
  return vertexAt(ctx.t0 + ctx.phi, ctx.R + ctx.off, {
    axial: 0.7,
    rot: 0,
    aim: ctx.t0,
    rem: 0,
  });
}

// A modifier does not take the selection weight: `walk` folds it into the ctx.
// The weight therefore arrives as a selector in front of the ops. The frame
// below is inert for the modifiers; `rot` reads its `orient` (the piece's own
// meridian, T0) to place a chain on the seam.
const FRAME: PieceFrame<number> = frameAt(T0, R, { axial: 0, orient: T0 });

function runM(
  ops: OpItem<number>[],
  v: VertexState<number>,
  w: number,
  ctx: OpCtx<number>,
): VertexState<number> {
  return runPipeline([selFront<number>(() => w), ...ops], v, FRAME, ctx).v;
}

// A bent vertex's position in the radial plane.
function xzOf(v: VertexState<number>): [number, number] {
  return [v.x, v.z];
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

// Chains used across the cases. `q` = R·κ: 1 is the seated barrel, 0 flat.
const seatedChain = (): OpItem<number>[] => [
  ...SEAM(),
  arc<number>(1, L / 2),
  arc<number>(1), // unbounded
];

describe("anchor / arc — the developable bend chain", () => {
  it("(a) an all-q=1 chain off the seam anchor is the seated identity, including overrun", () => {
    const op = seatedChain();
    for (const d of [-1.5, 0, 0.001, 2, L / 2, L, L + 2.5]) {
      const ctx = ctxAt(d);
      const out = runM(op, seatedAt(ctx), 1, ctx);
      expect(polarOf(out).theta - (ctx.t0 + ctx.phi)).toBeCloseTo(0, 9);
      expect(polarOf(out).radius - ctx.R).toBeCloseTo(0, 9);
      expect(out.rot).toBeCloseTo(0, 9);
      expect(out.axial).toBe(0.7); // v.axial passes through UNCHANGED
    }

    // The wall offset rides the final normal ⇒ radius = R + off.
    const offCtx = ctxAt(2, { off: 0.35 });
    const offOut = runM(op, seatedAt(offCtx), 1, offCtx);
    expect(polarOf(offOut).radius - (offCtx.R + offCtx.off)).toBeCloseTo(0, 9);
    expect(polarOf(offOut).theta - (offCtx.t0 + offCtx.phi)).toBeCloseTo(0, 9);
  });

  it("(b) a roll-step chain lays a flat run then rolls: closed-form cartesian check", () => {
    const s0 = L / 2;
    const op: OpItem<number>[] = [
      ...SEAM(),
      arc<number>(0, s0),
      arc<number>(1), // unbounded
    ];

    // d = 0: the chain has consumed nothing — the seam sits on the tangent
    // plane's anchor point R·n̂.
    const c0 = ctxAt(0);
    const p0 = xzOf(runM(op, seatedAt(c0), 1, c0));
    expect(p0[0]).toBeCloseTo(R * NHAT[0], 8);
    expect(p0[1]).toBeCloseTo(R * NHAT[1], 8);

    // d = L: s0 of material laid flat along t̂, the remaining (L − s0) rolled
    // around the circle of radius R centred at C = t̂·s0.
    const cL = ctxAt(L);
    const pL = xzOf(runM(op, seatedAt(cL), 1, cL));
    const psi = (L - s0) / R;
    const nEnd = N0 - psi;
    const expX = THAT[0] * s0 + R * Math.cos(nEnd);
    const expZ = THAT[1] * s0 + R * Math.sin(nEnd);
    expect(pL[0]).toBeCloseTo(expX, 8);
    expect(pL[1]).toBeCloseTo(expZ, 8);

    // The normal accumulator tracks the same turn: rot = n − θ_seated.
    const outL = runM(op, seatedAt(cL), 1, cL);
    expect(outL.rot).toBeCloseTo(nEnd - (cL.t0 + cL.phi), 8);
  });

  it("(c) participation bends only its share of the material and slips the rest straight", () => {
    const half: OpItem<number>[] = [
      ...SEAM(),
      arc<number>(1, undefined, { participation: 0.5 }),
    ];
    const full: OpItem<number>[] = [...SEAM(), arc<number>(1)];

    for (const d of [1, 3, L]) {
      const ctx = ctxAt(d);
      const seated = ctx.t0 + ctx.phi;
      const nHalf = runM(half, seatedAt(ctx), 1, ctx).rot + seated;
      const nFull = runM(full, seatedAt(ctx), 1, ctx).rot + seated;
      // Half the material bends ⇒ exactly half the turn.
      expect(nHalf - N0).toBeCloseTo((nFull - N0) / 2, 9);
    }

    // Material is never created: the chord+slip budget of a vertex at d is d, so
    // it can never sit further than d from the anchor — with equality exactly on
    // a straight (q = 0) run, where chord = s and nothing is spent turning.
    const straight: OpItem<number>[] = [...SEAM(), arc<number>(0)];
    const seam: [number, number] = [R * NHAT[0], R * NHAT[1]];
    for (const d of [2, 5, L]) {
      const ctx = ctxAt(d);
      const moved = dist(xzOf(runM(half, seatedAt(ctx), 1, ctx)), seam);
      expect(moved).toBeLessThanOrEqual(d + 1e-9);
      expect(moved).toBeGreaterThan(0);

      const flat = dist(xzOf(runM(straight, seatedAt(ctx), 1, ctx)), seam);
      expect(flat).toBeCloseTo(d, 8);
    }
  });

  it("(c′) the slip law is pinned to the EXIT tangent: closed-form cartesian at a participation < 1 vertex", () => {
    // One unbounded arc, q = 1, participation c = 0.5, read at d = L = 8:
    //   bent = c·d = 4      psi = q·bent/R = 0.4      slip = (1 − c)·d = 4
    //   chord = bent·sinc(psi/2) = 2R·sin(0.2) = 3.9733866159012243
    //   nMid = N0 − psi/2 = 0.5             nEnd = N0 − psi = 0.3
    // P = R·n̂(N0) + chord·t̂(nMid) + slip·t̂(nEnd), t̂(a) = (sin a, −cos a).
    // The literals below break if the slip moves to the mid-arc tangent.
    const op: OpItem<number>[] = [
      ...SEAM(),
      arc<number>(1, undefined, { participation: 0.5 }),
    ];
    const ctx = ctxAt(L);
    const out = runM(op, seatedAt(ctx), 1, ctx);
    const p = xzOf(out);
    expect(p[0]).toBeCloseTo(10.735445717901419, 10);
    expect(p[1]).toBeCloseTo(-0.866143889889029, 10);
    // Only the bent half turns: rot = −psi − (θ_seated − N0) = 0.4 exactly.
    expect(out.rot).toBeCloseTo(0.4, 12);
  });

  it("(c″) negative q rolls the other way: closed-form cartesian + rot", () => {
    // First arc len 2, q = −2, participation 0.6, read at d = 1.5 (inside it, so
    // the cursor is spent and the second arc gets s = 0):
    //   bent = 0.9    psi = q·bent/R = −0.18 (sinc is EVEN, the chord keeps its
    //   sign through the odd sin(psi/2))     slip = 1.5 − 0.9 = 0.6
    //   chord = 0.9·sin(0.09)/0.09 = 0.8987854919801104
    //   nMid = N0 − psi/2 = 0.79            nEnd = N0 − psi = 0.88
    // rot = nEnd − θ_seated = 0.88 − (0.3 + 0.25) = 0.33.
    const op: OpItem<number>[] = [
      ...SEAM(),
      arc<number>(-2, 2, { participation: 0.6 }),
      arc<number>(1), // unbounded
    ];
    const ctx = ctxAt(1.5);
    const out = runM(op, seatedAt(ctx), 1, ctx);
    const p = xzOf(out);
    expect(p[0]).toBeCloseTo(8.749320415613807, 10);
    expect(p[1]).toBeCloseTo(5.42728022755137, 10);
    expect(out.rot).toBeCloseTo(0.33, 12);
    // The negative curvature turns the normal the OPPOSITE way from the seated
    // barrel (q > 0 decreases the aim), i.e. it rolls outward.
    expect(out.rot + (ctx.t0 + ctx.phi)).toBeGreaterThan(N0);
  });

  it("(d) a zero-length arc contributes nothing and q = 0 is a straight line", () => {
    const withZero: OpItem<number>[] = [
      ...SEAM(),
      arc<number>(5, 0),
      arc<number>(1), // unbounded
    ];
    const without: OpItem<number>[] = [...SEAM(), arc<number>(1)];
    for (const d of [0, 2, 5, L, L + 1]) {
      const ctx = ctxAt(d);
      const a = runM(withZero, seatedAt(ctx), 1, ctx);
      const b = runM(without, seatedAt(ctx), 1, ctx);
      expect(a.x).toBeCloseTo(b.x, 12);
      expect(a.z).toBeCloseTo(b.z, 12);
      expect(a.rot).toBeCloseTo(b.rot, 12);
    }

    // q = 0: the chain walks the anchor tangent, never turning — the normal
    // stays at the anchor angle and the distance walked is the material consumed.
    const straight: OpItem<number>[] = [...SEAM(), arc<number>(0)];
    for (const d of [0, 1.5, L]) {
      const ctx = ctxAt(d);
      const out = runM(straight, seatedAt(ctx), 1, ctx);
      expect(out.rot + (ctx.t0 + ctx.phi)).toBeCloseTo(N0, 9);
      const p = xzOf(out);
      expect(p[0]).toBeCloseTo(R * NHAT[0] + THAT[0] * d, 8);
      expect(p[1]).toBeCloseTo(R * NHAT[1] + THAT[1] * d, 8);
    }
  });
});

describe("crease — the hard fold between two panels", () => {
  const W = 0.5; // the crease's material band, model-mm

  it("(h) rad = 0 is the seated arc segment — the identity a gate-driven crease rests on", () => {
    const creased: OpItem<number>[] = [
      ...SEAM(),
      arc<number>(1, 2),
      crease<number>(0, W),
      arc<number>(1),
    ];
    const plain: OpItem<number>[] = [
      ...SEAM(),
      arc<number>(1, 2),
      arc<number>(1, W),
      arc<number>(1),
    ];
    // Every position in the material, the two overrun ends included, and a
    // vertex off the wall: rad = 0 ⇒ q = 1 ⇒ the chain never left the barrel.
    for (const d of [-1.5, 0, 0.3, 2, 2.25, 2.6, L, L + 2]) {
      for (const off of [0, 0.35]) {
        const ctx = ctxAt(d, { off });
        const a = runM(creased, seatedAt(ctx), 1, ctx);
        const b = runM(plain, seatedAt(ctx), 1, ctx);
        // STRICT equality, not toBeCloseTo: rad = 0 makes q exactly 1 through
        // the shared chainStep, so crease-vs-plain is bit-for-bit — the
        // property a gate-driven crease actually rests on.
        expect(a.x).toBe(b.x);
        expect(a.z).toBe(b.z);
        expect(a.rot).toBe(b.rot);
        // …and that is the seated state to float rounding: the arc rebuilds the
        // seat through trig, and the idle gate force-zeroes the residue at
        // channel 0.
        expect(a.rot).toBeCloseTo(0, 12);
        expect(polarOf(a).radius).toBeCloseTo(ctx.R + off, 12);
      }
    }
  });

  it("(h′) the turn across the band is the seated turn PLUS rad, and the normal carries it", () => {
    const RAD = 0.6;
    const op: OpItem<number>[] = [
      ...SEAM(),
      arc<number>(0, 3), // flat panel
      crease<number>(RAD, W),
      arc<number>(0), // flat panel
    ];
    // Past the band the aim has turned by ψ = (1 + rad·R/W)·W/R = W/R + rad.
    const turn = W / R + RAD;
    const ctx = ctxAt(L);
    const out = runM(op, seatedAt(ctx), 1, ctx);
    expect(out.rot + (ctx.t0 + ctx.phi)).toBeCloseTo(N0 - turn, 12);

    // A NEGATIVE rad folds back the other way, past the anchor tangent — the
    // reflex flick — and the two are symmetric about the seated fold.
    const back: OpItem<number>[] = [
      ...SEAM(),
      arc<number>(0, 3),
      crease<number>(-RAD, W),
      arc<number>(0),
    ];
    const outBack = runM(back, seatedAt(ctx), 1, ctx);
    expect(outBack.rot + (ctx.t0 + ctx.phi)).toBeCloseTo(
      N0 - (W / R - RAD),
      12,
    );
    expect(outBack.rot).toBeGreaterThan(0); // turned the opposite way

    // Material is conserved: the band consumes exactly W, so a vertex BEFORE it
    // cannot feel it at all.
    const early = ctxAt(1.5);
    const short: OpItem<number>[] = [...SEAM(), arc<number>(0, 3)];
    const a = runM(op, seatedAt(early), 1, early);
    const b = runM(short, seatedAt(early), 1, early);
    expect(a.x).toBeCloseTo(b.x, 12);
    expect(a.z).toBeCloseTo(b.z, 12);
  });

  it("(h″) the tent: flat panels stay dead straight and the whole turn sits in the two folds", () => {
    // The rose's fold pattern in miniature: panel, crease, panel, crease, panel.
    const RAD = 0.5;
    const p1 = 2,
      p2 = 3; // panel lengths; the last is the remainder
    const tent: OpItem<number>[] = [
      ...SEAM(),
      arc<number>(0, p1),
      crease<number>(RAD, W),
      arc<number>(0, p2),
      crease<number>(RAD, W),
      arc<number>(0),
    ];
    const at = (d: number): [number, number] => {
      const ctx = ctxAt(d);
      return xzOf(runM(tent, seatedAt(ctx), 1, ctx));
    };
    // Three samples inside a panel are COLLINEAR (a facet is flat, not a
    // shallow arc): the cross product of the two spans vanishes.
    const straightness = (a: number, b: number, c: number): number => {
      const [P, Q, S] = [at(a), at(b), at(c)];
      return Math.abs(
        (Q[0] - P[0]) * (S[1] - P[1]) - (Q[1] - P[1]) * (S[0] - P[0]),
      );
    };
    expect(straightness(0.1, 1, 1.9)).toBeLessThan(1e-12);
    expect(
      straightness(p1 + W + 0.1, p1 + W + 1.5, p1 + W + p2 - 0.1),
    ).toBeLessThan(1e-12);
    expect(straightness(p1 + p2 + 2 * W + 0.1, L - 1, L)).toBeLessThan(1e-12);

    // Each fold turns the panel by the same dihedral, and the pattern's whole
    // turn is their sum (plus the seated turn the two bands themselves carry).
    const aimAt = (d: number): number => {
      const ctx = ctxAt(d);
      return runM(tent, seatedAt(ctx), 1, ctx).rot + (ctx.t0 + ctx.phi);
    };
    const fold = W / R + RAD;
    expect(aimAt(1)).toBeCloseTo(N0, 12);
    expect(aimAt(p1 + W + 1)).toBeCloseTo(N0 - fold, 12);
    expect(aimAt(L)).toBeCloseTo(N0 - 2 * fold, 12);
  });
});

describe("straight — the chain's flat run", () => {
  // A chain with a real bend in front of the flat run, so the tail inherits a
  // turned aim and a part-spent cursor rather than the seated ones.
  const bentThen = (tail: OpItem<number>): OpItem<number>[] => [
    ...SEAM(),
    arc<number>(1, L / 3),
    arc<number>(-0.6, L / 3),
    tail,
  ];

  it("(i) straight walks the EXACT chord along the aim, where arc(0) fell short", () => {
    // Straight off the seam anchor: the point lands `len` down the tangent
    // there, to the bit the closed form can be evaluated to.
    const ctx = ctxAt(L, { flight: 1, stick: 0 });
    const len = 3;
    const out = runM([...SEAM(), straight<number>(len)], seatedAt(ctx), 1, ctx);
    expect(
      dist(xzOf(out), [
        R * NHAT[0] + len * THAT[0],
        R * NHAT[1] + len * THAT[1],
      ]),
    ).toBeLessThan(1e-13);

    // arc(0) walks `len·sinc(ε)` — the singularity guard's clamp — so it is
    // SHORT, never long, and short by the clamp exactly.
    const viaArc = runM(
      [...SEAM(), arc<number>(0, len)],
      seatedAt(ctx),
      1,
      ctx,
    );
    const shortfall = dist(xzOf(out), xzOf(viaArc));
    expect(shortfall).toBeGreaterThan(0);
    expect(shortfall).toBeCloseTo(len * (1 - Math.sin(1e-5) / 1e-5), 15);
  });

  it("(i′) straight ≡ arc(0) across the gate and the whole sheet, to that residual", () => {
    for (const flight of [0.25, 0.5, 0.75, 1]) {
      for (const frac of [-0.2, 0, 0.25, 0.5, 0.75, 1, 1.2]) {
        for (const off of [0, 0.35]) {
          const ctx = ctxAt(frac * L, { flight, stick: 0, off });
          for (const chain of [
            bentThen,
            (t: OpItem<number>) => [...SEAM(), t],
          ]) {
            const a = runM(chain(straight<number>()), seatedAt(ctx), 1, ctx);
            const b = runM(chain(arc<number>(0)), seatedAt(ctx), 1, ctx);
            // The bound is the clamp times the material a tail can spend, so it
            // is nine orders under anything the chain means in model-mm.
            expect(
              dist(xzOf(a), xzOf(b)),
              `flight ${flight} frac ${frac} off ${off}`,
            ).toBeLessThan(1e-9);
            expect(a.rot, `rot flight ${flight} frac ${frac}`).toBe(b.rot);
            expect(a.rem).toBeCloseTo(b.rem, 12);
          }
        }
      }
    }
  });

  it("(i″) a flat run turns nothing: rot and the aim pass straight through", () => {
    const ctx = ctxAt(L / 2, { flight: 1, stick: 0 });
    const before = runM(bentThen(arc<number>(1, 0)), seatedAt(ctx), 1, ctx);
    const after = runM(bentThen(straight<number>()), seatedAt(ctx), 1, ctx);
    expect(after.rot).toBe(before.rot);
    expect(after.aim).toBe(before.aim);
    expect(after.axial).toBe(before.axial);
  });

  it("(i‴) the cursor spends min(rem, len), the negative overrun included", () => {
    // rem is seeded UNCLAMPED from ctx.d, so a seam-overrun vertex carries a
    // NEGATIVE cursor and the flat run walks it backwards.
    for (const [d, len, spent] of [
      [L, 3, 3], // len < rem: spend len
      [2, 5, 2], // len > rem: spend the remainder
      [-1.5, 3, -1.5], // negative overrun: min picks the cursor, walk-back
    ]) {
      const ctx = ctxAt(d, { flight: 1, stick: 0 });
      const out = runM([...SEAM(), straight<number>(len)], seatedAt(ctx), 1, ctx); // prettier-ignore
      expect(out.rem, `d = ${d}`).toBeCloseTo(d - spent, 12);
      // …and the walk itself is that same signed length down the tangent.
      const seat = runM([...SEAM()], seatedAt(ctx), 1, ctx);
      expect(
        (out.x - seat.x) * THAT[0] + (out.z - seat.z) * THAT[1],
        `walk d = ${d}`,
      ).toBeCloseTo(spent, 12);
    }

    // No `len` at all takes the whole remainder and leaves the cursor empty.
    const ctx = ctxAt(L, { flight: 1, stick: 0 });
    const all = runM([...SEAM(), straight<number>()], seatedAt(ctx), 1, ctx);
    expect(all.rem).toBe(0);
  });
});

describe("coil", () => {
  it("(e) identity at flight 0 / stick 1, and the constant-arc radius morph", () => {
    const idle = ctxAt(2, { flight: 0, stick: 1, yN: 0.4 });
    const vP = { theta: 0.42, radius: 10.6 };
    const v: VertexState<number> = vertexAt(vP.theta, vP.radius, {
      axial: 1.1,
      rot: 0.07,
      aim: T0,
      rem: 0,
    });
    const out = runM([coil<number>(0.5)], v, 1, idle);
    expect(out.x).toBe(v.x);
    expect(out.z).toBe(v.z);
    expect(out.axial).toBe(v.axial);
    expect(out.rot).toBe(v.rot);

    // coil: constant-arc radius morph — the wedge-local angle opens ∝ 1/factor.
    const coilCtx = ctxAt(2, { flight: 0.5 });
    const co = runM([coil<number>(0.5)], v, 1, coilCtx);
    const coilF = NUM.mix(1, 0.5, 0.5);
    const open = coilCtx.phi / coilF - coilCtx.phi;
    expect(polarOf(co).theta).toBeCloseTo(vP.theta + open, 12);
    expect(co.rot).toBeCloseTo(v.rot + open, 12);
    expect(polarOf(co).radius).toBeCloseTo(vP.radius + R * (coilF - 1), 12);
  });

  it("(e′) the gate law at an INTERMEDIATE w: flightEff = flight·w", () => {
    const vP = { theta: 0.42, radius: 10.6 };
    const v: VertexState<number> = vertexAt(vP.theta, vP.radius, {
      axial: 1.1,
      rot: 0.07,
      aim: T0,
      rem: 0,
    });

    // coil at w = 0.5, flight 0.8, factor 0.5:
    //   flightEff = 0.8·0.5 = 0.4   ⇒ coilF = mix(1, 0.5, 0.4) = 0.8
    //   phi(d = 2) = 0.2 ⇒ open = 0.2/0.8 − 0.2 = 0.05, radius += R·(0.8 − 1) = −2.
    // Any w-nonlinearity (flight·w² would give coilF = 0.9) misses these.
    const co = runM([coil<number>(0.5)], v, 0.5, ctxAt(2, { flight: 0.8 }));
    expect(polarOf(co).theta).toBeCloseTo(0.47, 12);
    expect(polarOf(co).radius).toBeCloseTo(8.6, 12);
    expect(co.rot).toBeCloseTo(0.12, 12);
  });
});

describe("modifier weight law — a masked piece stays seated", () => {
  // A chain that reduces to the seated barrel only at flight 0 / stick 1, so
  // under w = 0 every Live argument must read flightEff = 0 / stickEff = 1 off
  // the ctx `walk` hands it.
  const liveChain = (): OpItem<number>[] => [
    rot<number>((c) => c.halfSpan),
    anchor<number>((c) => c.R * (1 + 0.3 * (1 - c.stick))),
    arc<number>(0, (c) => c.flight * c.L * 0.5),
    arc<number>(1), // unbounded
  ];

  it("(f) the chain at w = 0 is the exact seated state even at full channel", () => {
    const op = liveChain();
    for (const d of [0, 1.5, L / 2, L, L + 2]) {
      const ctx = ctxAt(d, { flight: 1, stick: 0 });
      const seated = seatedAt(ctx);
      const out = runM(op, seated, 0, ctx);
      expect(polarOf(out).theta).toBeCloseTo(ctx.t0 + ctx.phi, 12);
      expect(polarOf(out).radius).toBeCloseTo(ctx.R, 12);
      expect(out.rot).toBeCloseTo(0, 12);
      expect(out.axial).toBe(seated.axial);

      // …and at w = 1 the same profile actually deforms (the law is not a no-op).
      const live = runM(op, seated, 1, ctx);
      expect(Math.abs(polarOf(live).radius - ctx.R)).toBeGreaterThan(1e-3);
    }
  });

  it("(f″) the chain at a FRACTIONAL w is the GATE FOLD, pinned to closed form", () => {
    // At w = 0 an amplitude mix would also land on the seated state, so only an
    // INTERMEDIATE weight tells the two apart. The numbers below are derived
    // from the gate fold — flightEff = flight·w, stickEff = mix(1, stick, w).
    //
    // Inputs: flight 1, stick 0, w = 0.5 ⇒
    //     flightEff = 1·0.5   = 0.5
    //     stickEff  = mix(1, 0, 0.5) = 0.5
    // The profile below reads BOTH: its flat run is flightEff·L = 4 material-mm
    // and its anchor lifts to R·(1 + 0.25·(1 − stickEff)) = 11.25.
    //
    // The chain (n̂(a) = (cos a, sin a), t̂(a) = (sin a, −cos a), anchor angle
    // N0 = t0 + halfSpan = 0.7):
    //
    //   d = 8 (the far edge): 4mm on the flat run (q = 0 ⇒ no turn, chord = 4
    //     along t̂(0.7)), then 4mm of seated arc — psi = q·bent/R = 0.4, so
    //     chord = 4·sinc(0.2) = 20·sin(0.2) along t̂(nMid = 0.5), exiting at
    //     n = 0.3:
    //       P = 11.25·n̂(0.7) + 4·t̂(0.7) + 20·sin(0.2)·t̂(0.5)
    //         = (13.086…, 0.701…)   ⇒ θ = 0.05352440319286591
    //                                   r = 13.105055979840916
    //       rot = n − (t0 + phi) = 0.3 − (0.3 − 0.4) = 0.4 exactly.
    //   d = 2 (inside the flat run): the cursor is spent, so the second arc
    //     gets s = 0.
    //       P = 11.25·n̂(0.7) + 2·t̂(0.7)
    //         ⇒ θ = 0.5240603745474721, r = 11.426394882026438
    //       rot = 0.7 − (0.3 + 0.2) = 0.2 exactly.
    const op: OpItem<number>[] = [
      rot<number>((c) => c.halfSpan),
      anchor<number>((c) => c.R * (1 + 0.25 * (1 - c.stick))),
      arc<number>(0, (c) => c.flight * c.L),
      arc<number>(1), // unbounded
    ];
    const GOLDEN = [
      {
        d: 8,
        theta: 0.05352440319286591,
        radius: 13.105055979840916,
        rot: 0.4,
      },
      { d: 2, theta: 0.5240603745474721, radius: 11.426394882026438, rot: 0.2 },
    ];
    for (const g of GOLDEN) {
      const ctx = ctxAt(g.d, { flight: 1, stick: 0 });
      const out = runM(op, seatedAt(ctx), 0.5, ctx);
      // 10 places: the chain rebuilds these through trig, so the last couple of
      // ULPs are float noise.
      expect(polarOf(out).theta, `d = ${g.d} theta`).toBeCloseTo(g.theta, 10);
      expect(polarOf(out).radius, `d = ${g.d} radius`).toBeCloseTo(g.radius, 10); // prettier-ignore
      expect(out.rot, `d = ${g.d} rot`).toBeCloseTo(g.rot, 12);
    }

    // The forbidden mutant: half-way between the seated state and the w = 1
    // shape is a DIFFERENT point, off the developable surface, far outside the
    // 1e-10 the pins above are held to.
    const ctx = ctxAt(8, { flight: 1, stick: 0 });
    const seated = seatedAt(ctx);
    const full = runM(op, seated, 1, ctx);
    const mixed: [number, number] = [
      (seated.x + full.x) / 2,
      (seated.z + full.z) / 2,
    ];
    const pinned = atPolar(GOLDEN[0].theta, GOLDEN[0].radius);
    expect(dist(mixed, [pinned.x, pinned.z])).toBeGreaterThan(0.5);
  });

  it("(f′) coil at w = 0 is an exact identity at full channel", () => {
    const ctx = ctxAt(2, { flight: 1, stick: 0, yN: 0.4 });
    const vP = { theta: 0.42, radius: 10.6 };
    const v: VertexState<number> = vertexAt(vP.theta, vP.radius, {
      axial: 1.1,
      rot: 0.07,
      aim: T0,
      rem: 0,
    });
    const out = runM([coil<number>(0.5)], v, 0, ctx);
    expect(out.x).toBe(v.x);
    expect(out.z).toBe(v.z);
    expect(out.axial).toBe(v.axial);
    expect(out.rot).toBe(v.rot);
  });
});
