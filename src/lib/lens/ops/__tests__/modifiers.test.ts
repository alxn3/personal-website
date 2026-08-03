import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { fixtureGateAt } from "./fixture-gate";
import {
  anchor,
  arc,
  coil,
  rot,
  runPipeline,
  selAxialBand,
  selFront,
  stickPress,
  twist,
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
const FROM = -1; // stickPress's contact end (+Y), the only `from` left

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
    rung: 0,
    axi: 0,
    layerN: 5, // one wedge of a 5-cut layer
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
  return {
    theta: ctx.t0 + ctx.phi,
    radius: ctx.R + ctx.off,
    axial: 0.7,
    rot: 0,
    aim: ctx.t0,
    rem: 0,
  };
}

// A modifier does not take the selection weight: `walk` folds it into the ctx it
// hands over (the modifier weight law). So the weight arrives here the way a
// recipe states it — as a selector in front of the ops — and the pipeline runner
// does the fold. `selFront` is intrinsic, so the frame below is inert for the
// modifiers; `rot` reads its `orient` (the piece's own meridian, T0) to place a
// chain on the seam.
const FRAME: PieceFrame<number> = {
  theta: T0,
  radius: R,
  axial: 0,
  orient: T0,
};

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
  return [v.radius * Math.cos(v.theta), v.radius * Math.sin(v.theta)];
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
      expect(out.theta - (ctx.t0 + ctx.phi)).toBeCloseTo(0, 9);
      expect(out.radius - ctx.R).toBeCloseTo(0, 9);
      expect(out.rot).toBeCloseTo(0, 9);
      expect(out.axial).toBe(0.7); // v.axial passes through UNCHANGED
    }

    // The wall offset rides the final normal ⇒ radius = R + off.
    const offCtx = ctxAt(2, { off: 0.35 });
    const offOut = runM(op, seatedAt(offCtx), 1, offCtx);
    expect(offOut.radius - (offCtx.R + offCtx.off)).toBeCloseTo(0, 9);
    expect(offOut.theta - (offCtx.t0 + offCtx.phi)).toBeCloseTo(0, 9);
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
    // Hand-evaluated ONCE; the numbers below are literals on purpose — moving the
    // slip to the mid-arc tangent (or dropping it) must break them.
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
      expect(a.theta).toBeCloseTo(b.theta, 12);
      expect(a.radius).toBeCloseTo(b.radius, 12);
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

describe("coil / twist / stickPress", () => {
  it("(e) identity at flight 0 / stick 1, and twist adds rad·flight·w·yN to theta AND rot", () => {
    const idle = ctxAt(2, { flight: 0, stick: 1, yN: 0.4 });
    const v: VertexState<number> = {
      theta: 0.42,
      radius: 10.6,
      axial: 1.1,
      rot: 0.07,
      aim: T0,
      rem: 0,
    };
    for (const op of [
      coil<number>(0.5),
      twist<number>(0.7),
      stickPress<number>(4, 0.3, FROM),
    ]) {
      const out = runM([op], v, 1, idle);
      expect(out.theta).toBe(v.theta);
      expect(out.radius).toBe(v.radius);
      expect(out.axial).toBe(v.axial);
      expect(out.rot).toBe(v.rot);
    }

    // twist: the angle is rad · flight · w · yN, on theta AND rot.
    const ctx = ctxAt(2, { flight: 0.8, yN: 0.4 });
    const tw = runM([twist<number>(0.7)], v, 0.5, ctx);
    const ang = 0.7 * 0.8 * 0.5 * 0.4;
    expect(tw.theta).toBeCloseTo(v.theta + ang, 12);
    expect(tw.rot).toBeCloseTo(v.rot + ang, 12);
    expect(tw.radius).toBe(v.radius);
    expect(tw.axial).toBe(v.axial);

    // coil: constant-arc radius morph — the wedge-local angle opens ∝ 1/factor.
    const coilCtx = ctxAt(2, { flight: 0.5 });
    const co = runM([coil<number>(0.5)], v, 1, coilCtx);
    const coilF = NUM.mix(1, 0.5, 0.5);
    const open = coilCtx.phi / coilF - coilCtx.phi;
    expect(co.theta).toBeCloseTo(v.theta + open, 12);
    expect(co.rot).toBeCloseTo(v.rot + open, 12);
    expect(co.radius).toBeCloseTo(v.radius + R * (coilF - 1), 12);

    // stickPress: the hover S-bend sweeps along the axis from the contact end.
    const pressCtx = ctxAt(2, { stick: 0.4, yN: 0.1 });
    const pr = runM([stickPress<number>(4, 0.3, FROM)], v, 1, pressCtx);
    const u = 0.5 - pressCtx.yN * FROM;
    const front = pressCtx.stick * 1.3;
    const amt = 4 * NUM.smoothstep(0, 0.3, u - front + 0.3);
    expect(pr.radius).toBeCloseTo(v.radius + amt, 12);
    expect(pr.theta).toBe(v.theta);
    expect(pr.rot).toBe(v.rot);
  });

  it("(e′) the gate law at an INTERMEDIATE w: flightEff = flight·w, stickEff = mix(1, stick, w)", () => {
    const v: VertexState<number> = {
      theta: 0.42,
      radius: 10.6,
      axial: 1.1,
      rot: 0.07,
      aim: T0,
      rem: 0,
    };

    // coil at w = 0.5, flight 0.8, factor 0.5:
    //   flightEff = 0.8·0.5 = 0.4   ⇒ coilF = mix(1, 0.5, 0.4) = 0.8
    //   phi(d = 2) = 0.2 ⇒ open = 0.2/0.8 − 0.2 = 0.05, radius += R·(0.8 − 1) = −2.
    // Any w-nonlinearity (flight·w² would give coilF = 0.9) misses these.
    const co = runM([coil<number>(0.5)], v, 0.5, ctxAt(2, { flight: 0.8 }));
    expect(co.theta).toBeCloseTo(0.47, 12);
    expect(co.radius).toBeCloseTo(8.6, 12);
    expect(co.rot).toBeCloseTo(0.12, 12);

    // stickPress at w = 0.5, stick 0.4, yN 0.26, hover 4, blendFrac 0.3:
    //   stickEff = mix(1, 0.4, 0.5) = 0.7 ⇒ front f = 0.7·1.3 = 0.91
    //   u = 0.5 − yN·from = 0.76 ⇒ smoothstep(0, 0.3, 0.76 − 0.91 + 0.3) =
    //   smoothstep at t = 0.5 = 0.5 ⇒ hoverAmt = 2 exactly.
    const pr = runM(
      [stickPress<number>(4, 0.3, FROM)],
      v,
      0.5,
      ctxAt(2, { stick: 0.4, yN: 0.26 }),
    );
    expect(pr.radius).toBeCloseTo(12.6, 12);
    expect(pr.theta).toBe(v.theta);
    expect(pr.rot).toBe(v.rot);
  });
});

describe("modifier weight law — a masked piece stays seated", () => {
  // A chain that only reduces to the seated barrel at flight 0 / stick 1: the
  // flat run grows with flight and the anchor lifts off the barrel as the sheet
  // unsticks. Under w = 0 every Live argument below must read flightEff = 0 /
  // stickEff = 1 off the ctx `walk` hands it, giving the exact seated state.
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
      expect(out.theta).toBeCloseTo(ctx.t0 + ctx.phi, 12);
      expect(out.radius).toBeCloseTo(ctx.R, 12);
      expect(out.rot).toBeCloseTo(0, 12);
      expect(out.axial).toBe(seated.axial);

      // …and at w = 1 the same profile actually deforms (the law is not a no-op).
      const live = runM(op, seated, 1, ctx);
      expect(Math.abs(live.radius - ctx.R)).toBeGreaterThan(1e-3);
    }
  });

  it("(f″) the chain at a FRACTIONAL w is the GATE FOLD, pinned to closed form", () => {
    // The law that (f) alone cannot see: at w = 0 an amplitude mix
    // (`mix(seated, bent, w)`) also lands on the seated state, so only an
    // INTERMEDIATE weight tells the two apart. Everything below is derived by
    // hand from the gate fold — flightEff = flight·w, stickEff = mix(1, stick,
    // w) — and hardcoded, so a mutant that blends amplitudes (or scales κ by w)
    // misses these numbers by centimetres.
    //
    // The weight is a `selFront(() => 0.5)` in front of the chain (runM), so this
    // exercises the fold where it now lives — in `walk` — rather than a call
    // convention the ops no longer have.
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
      // 10 places (≈1e-10 rad / model-mm) — the chain rebuilds these through
      // trig, so the last couple of ULPs are float noise, not the law.
      expect(out.theta, `d = ${g.d} theta`).toBeCloseTo(g.theta, 10);
      expect(out.radius, `d = ${g.d} radius`).toBeCloseTo(g.radius, 10);
      expect(out.rot, `d = ${g.d} rot`).toBeCloseTo(g.rot, 12);
    }

    // The forbidden mutant, spelled out: half-way between the seated state and
    // the w = 1 shape is a DIFFERENT point — off the developable surface, and
    // 0.79mm from the pinned one. Small in millimetres, but nine orders of
    // magnitude past the 1e-10 the pins above are held to, so the goldens
    // reject it outright. (At w = 1 the whole 8mm is flat run.)
    const ctx = ctxAt(8, { flight: 1, stick: 0 });
    const seated = seatedAt(ctx);
    const full = runM(op, seated, 1, ctx);
    const mixed = {
      x: (seated.radius * Math.cos(seated.theta) + full.radius * Math.cos(full.theta)) / 2, // prettier-ignore
      z: (seated.radius * Math.sin(seated.theta) + full.radius * Math.sin(full.theta)) / 2, // prettier-ignore
    };
    expect(
      dist(
        [mixed.x, mixed.z],
        [
          GOLDEN[0].radius * Math.cos(GOLDEN[0].theta),
          GOLDEN[0].radius * Math.sin(GOLDEN[0].theta),
        ],
      ),
    ).toBeGreaterThan(0.5);
  });

  it("(f′) coil / twist / stickPress at w = 0 are exact identities at full channel", () => {
    const ctx = ctxAt(2, { flight: 1, stick: 0, yN: 0.4 });
    const v: VertexState<number> = {
      theta: 0.42,
      radius: 10.6,
      axial: 1.1,
      rot: 0.07,
      aim: T0,
      rem: 0,
    };
    for (const op of [
      coil<number>(0.5),
      twist<number>(0.7),
      stickPress<number>(4, 0.3, FROM),
    ]) {
      const out = runM([op], v, 0, ctx);
      expect(out.theta).toBe(v.theta);
      expect(out.radius).toBe(v.radius);
      expect(out.axial).toBe(v.axial);
      expect(out.rot).toBe(v.rot);
    }
  });
});

describe("selAxialBand — open bypass", () => {
  const F0: PieceFrame<number> = {
    theta: 0.3,
    radius: 1,
    axial: 0,
    orient: 0.3,
  };

  it("(g) a band wider than the ±1e5 sentinel is exactly 1 anywhere", () => {
    const sel = selAxialBand<number>(-1e5, 1e5);
    if (sel.kind !== "selector") throw new Error("not a selector");
    const ctx = ctxAt(0);
    for (const axial of [-4321, 0, 12.5, 987]) {
      expect(sel.weight({ ...F0, axial }, ctx)).toBe(1);
    }
    // A real (finite) band still bands.
    const narrow = selAxialBand<number>(0, 1, 0.1);
    if (narrow.kind !== "selector") throw new Error("not a selector");
    expect(narrow.weight({ ...F0, axial: 5 }, ctx)).toBe(0);
  });
});
