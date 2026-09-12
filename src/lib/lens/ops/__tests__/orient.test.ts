import { describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { fixtureGateAt } from "./fixture-gate";
import { frameAt, polarOf, vertexAt } from "./fixture-state";
import {
  group,
  rot,
  runPipeline,
  selFront,
  spread,
  PART_CLASS,
  type OpCtx,
  type PieceFrame,
  type VertexState,
} from "../ops";

// The DIRECTION CLASS on the NUM backend: an orient op writes the working
// direction both levels carry (v.aim / f.orient) and nothing else.
// The seat: a piece framed on the t0 = 0.3 meridian, so both aims start there.

const T0 = 0.3;

const V0: VertexState<number> = vertexAt(0.42, 2, {
  axial: 0.5,
  rot: 0.1,
  aim: T0,
  rem: 0,
});
const F0: PieceFrame<number> = frameAt(T0, 1.5, {
  axial: 0.2,
  orient: T0,
});

function makeCtx(over: Partial<OpCtx<number>> = {}): OpCtx<number> {
  const rank01 = over.rank01 ?? 0.5;
  const layerPhase = over.layerPhase ?? 0;
  return {
    A: NUM,
    channel: 1, // the raw clock; `gateAt` is the real gate (fixture-gate.ts)
    gateAt: fixtureGateAt(rank01, layerPhase),
    t0: T0,
    R: 2,
    rank01: 0.5,
    layerPhase: 0,
    halfSpan: 0.5,
    partClass: PART_CLASS.structure,
    phi: 0.12,
    d: 0,
    L: 1,
    yN: 0,
    off: 0,
    rung: 0,
    axi: 0,
    depth: 0,
    adopted: 0,
    flight: 1,
    stick: 1,
    wrapDir: 1,
    ...over,
  };
}

describe("rot — the direction class", () => {
  it("(a) rot moves no geometry and turns no normal; it writes both aims", () => {
    const out = runPipeline([rot<number>(0.7)], V0, F0, makeCtx());
    expect(out.v.x).toBe(V0.x);
    expect(out.v.z).toBe(V0.z);
    expect(out.v.axial).toBe(V0.axial);
    expect(out.v.rot).toBe(V0.rot); // the normal is untouched
    expect(out.f.x).toBe(F0.x);
    expect(out.f.z).toBe(F0.z);
    expect(out.f.axial).toBe(F0.axial);
    // …and the ONE thing it does write, on both levels.
    expect(out.v.aim).toBeCloseTo(T0 + 0.7, 12);
    expect(out.f.orient).toBeCloseTo(T0 + 0.7, 12);
  });

  it("(b) rots compose additively, in either order, and invert", () => {
    const ctx = makeCtx();
    const twoWay = runPipeline([rot<number>(0.7), rot<number>(-0.25)], V0, F0, ctx); // prettier-ignore
    const other = runPipeline([rot<number>(-0.25), rot<number>(0.7)], V0, F0, ctx); // prettier-ignore
    expect(twoWay.f.orient).toBeCloseTo(T0 + 0.45, 12);
    expect(other.f.orient).toBeCloseTo(twoWay.f.orient, 12);

    // The inverse is one explicit rot — there is no scoping to undo it for you.
    const back = runPipeline(
      [rot<number>(0.7), rot<number>(-0.7)],
      V0,
      F0,
      ctx,
    );
    expect(back.f.orient).toBeCloseTo(F0.orient, 12);
  });

  it("(c) the direction threads FORWARD out of a group — group scopes the weight only", () => {
    const ctx = makeCtx();
    const out = runPipeline(
      [group<number>([rot<number>(0.7)]), rot<number>(0.1)],
      V0,
      F0,
      ctx,
    );
    expect(out.f.orient).toBeCloseTo(T0 + 0.8, 12);

    // A SELECTOR inside the same group is restored on exit; the re-aim is not.
    const seen: number[] = [];
    runPipeline(
      [
        group<number>([selFront<number>(() => 0.5), rot<number>(0.7)]),
        {
          kind: "transform",
          name: "probe",
          run: (v, f, w) => {
            seen.push(w, f.orient);
            return { v, f };
          },
        },
      ],
      V0,
      F0,
      ctx,
    );
    expect(seen[0]).toBe(1); // the weight came back
    expect(seen[1]).toBeCloseTo(T0 + 0.7, 12); // the aim did not
  });

  it("(d) a re-aim is NOT scaled by the selection weight", () => {
    // Scaling it would drift a masked piece's chain anchor off the seam. A
    // constant re-aim survives the mask; a gate-driven one fades on its own,
    // since an orient op reads the EFFECTIVE ctx (flightEff = flight·w).
    const ctx = makeCtx({ flight: 0.8 });
    for (const w of [1, 0.5, 0]) {
      const out = runPipeline(
        [selFront<number>(() => w), rot<number>(0.7)],
        V0,
        F0,
        ctx,
      );
      expect(out.f.orient, `w = ${w}`).toBeCloseTo(T0 + 0.7, 12);
    }

    // The gate-driven form, at the same three weights: flight·w, so it vanishes
    // at w = 0 without the class needing a rule about it.
    for (const w of [1, 0.5, 0]) {
      const out = runPipeline(
        [selFront<number>(() => w), rot<number>((c) => c.flight)],
        V0,
        F0,
        ctx,
      );
      expect(out.f.orient, `gated w = ${w}`).toBeCloseTo(T0 + 0.8 * w, 12);
    }
  });

  it("(e) spread follows the aim: rot(a) turns the displacement by exactly a", () => {
    const ctx = makeCtx({ flight: 0.5, R: 2, t0: T0 });
    const D = 0.5 * 0.4 * 2; // flight · frac · R at w = 1
    for (const a of [0, 0.7, -1.9]) {
      const out = runPipeline(
        [rot<number>(a), spread<number>(0.4)],
        V0,
        F0,
        ctx,
      );
      const dir = T0 + a;
      const px = V0.x + D * Math.cos(dir);
      const pz = V0.z + D * Math.sin(dir);
      expect(polarOf(out.v).theta, `a = ${a}`).toBeCloseTo(
        Math.atan2(pz, px),
        12,
      );
      expect(polarOf(out.v).radius, `a = ${a}`).toBeCloseTo(
        Math.hypot(px, pz),
        12,
      );
      // The frame rides the identical cartesian add.
      const fx = F0.x + D * Math.cos(dir);
      const fz = F0.z + D * Math.sin(dir);
      expect(polarOf(out.f).theta, `a = ${a}`).toBeCloseTo(
        Math.atan2(fz, fx),
        12,
      );
      expect(polarOf(out.f).radius, `a = ${a}`).toBeCloseTo(
        Math.hypot(fx, fz),
        12,
      );
    }
  });

  it("(f) rot takes a LIVE value — a per-piece quantity read when the op runs", () => {
    // How a recipe reaches the seam without making `build` ctx-dependent: the
    // seam sits one halfSpan off the seat, per piece.
    const aim = rot<number>((c) => c.halfSpan);
    for (const halfSpan of [0.5, 1.2]) {
      const out = runPipeline([aim], V0, F0, makeCtx({ halfSpan }));
      expect(out.f.orient, `halfSpan = ${halfSpan}`).toBeCloseTo(
        T0 + halfSpan,
        12,
      );
    }
  });
});
