import { describe, expect, it, vi } from "vitest";
import { NUM } from "../algebra";
import { fixtureGateAt } from "./fixture-gate";
import {
  anchor,
  arc,
  group,
  runPipeline,
  selAxialBand,
  selClass,
  selFront,
  selPick,
  selRank,
  selSector,
  validatePipeline,
  PART_CLASS,
  type OpCtx,
  type OpItem,
  type PieceFrame,
  type VertexState,
} from "../ops";

// The pipeline runs on the NUM backend (the executable spec), driven by
// hand-built ctx/state so every scoping and selector law is checked as a plain
// number.

const V0: VertexState<number> = {
  theta: 0,
  radius: 1,
  axial: 0,
  rot: 0,
  aim: 0.3, // seeded to ctx.t0
  rem: 0,
};
const F0: PieceFrame<number> = {
  theta: 0.3,
  radius: 1,
  axial: 0,
  orient: 0.3,
};

function makeCtx(over: Partial<OpCtx<number>> = {}): OpCtx<number> {
  const rank01 = over.rank01 ?? 0.5;
  const layerPhase = over.layerPhase ?? 0;
  return {
    A: NUM,
    channel: 0,
    gateAt: fixtureGateAt(rank01, layerPhase),
    t0: 0.3,
    R: 1,
    rank01: 0.5,
    layerPhase: 0,
    halfSpan: 1,
    partClass: PART_CLASS.structure,
    phi: 1, // d = R·(halfSpan − phi) at the house from = −1 ⇒ phi = halfSpan − d/R
    d: 0,
    L: 1,
    yN: 0,
    off: 0,
    rung: 0,
    axi: 0,
    layerN: 5, // one wedge of a 5-cut layer
    adopted: 0, // frames its own sector; rides no host shell
    flight: 0,
    stick: 1,
    wrapDir: 1,
    ...over,
  };
}

// A probe transform: records the active weight it received, passes v/f through.
function probe(sink: number[]): OpItem<number> {
  return {
    kind: "transform",
    name: "probe",
    run: (v, f, w) => {
      sink.push(w);
      return { v, f };
    },
  };
}

// A frame-advancing transform: adds `dTheta` to the piece frame's theta.
function orbit(dTheta: number): OpItem<number> {
  return {
    kind: "transform",
    name: "orbit",
    run: (v, f) => ({ v, f: { ...f, theta: f.theta + dTheta } }),
  };
}

describe("runPipeline — scoped selection", () => {
  it("(a) a selector inside a group does not affect ops after the group", () => {
    const inside: number[] = [];
    const after: number[] = [];
    runPipeline(
      [group([selFront(() => 0.5), probe(inside)]), probe(after)],
      V0,
      F0,
      makeCtx(),
    );
    expect(inside[0]).toBe(0.5); // the group's selector is in force inside it
    expect(after[0]).toBe(1); // …and the weight is restored when it exits
  });

  it("(b) selectors compound multiplicatively", () => {
    const rec: number[] = [];
    runPipeline(
      [selFront(() => 0.5), selFront(() => 0.5), probe(rec)],
      V0,
      F0,
      makeCtx(),
    );
    expect(rec[0]).toBe(0.25);
  });

  it("(c) a spatial selector sees the frame advanced by an earlier transform", () => {
    // Seated theta 0.3; orbit adds 1.0 → frame theta 1.3. A sector centred at
    // 1.3 then selects fully; the same sector before the orbit selects nothing.
    const seen: number[] = [];
    runPipeline(
      [orbit(1.0), selSector(F0.theta + 1.0, 0.2), probe(seen)],
      V0,
      F0,
      makeCtx(),
    );
    expect(seen[0]).toBe(1);

    const seenNoOrbit: number[] = [];
    runPipeline(
      [selSector(F0.theta + 1.0, 0.2), probe(seenNoOrbit)],
      V0,
      F0,
      makeCtx(),
    );
    expect(seenNoOrbit[0]).toBe(0);
  });
});

describe("selectors — exact-1 bypasses and exact matches", () => {
  const ctx = makeCtx();

  function weightOf(item: OpItem<number>, f: PieceFrame<number>): number {
    if (item.kind !== "selector") throw new Error("not a selector");
    return item.weight(f, ctx);
  }

  it("(d) selRank(0,1), selSector(width 6.3) and selPick(1) are exactly 1", () => {
    expect(weightOf(selRank(0, 1), F0)).toBe(1);
    expect(weightOf(selSector(0, 6.3), F0)).toBe(1);
    expect(weightOf(selPick(1, 7), F0)).toBe(1);
  });

  it("(d′) selClass matches exactly one part class", () => {
    const sel = selClass<number>(PART_CLASS.iris);
    expect(weightOf(sel, F0)).toBe(0); // ctx.partClass defaults to structure
    const irisCtx = makeCtx({ partClass: PART_CLASS.iris });
    if (sel.kind !== "selector") throw new Error("not a selector");
    expect(sel.weight(F0, irisCtx)).toBe(1);
  });

  // The sector width is a shipped /lens slider over 0..TAU, so the mask has to
  // keep its orientation over the WHOLE range: cos turns around at π, and an
  // uncapped outer angle (half-width + feather) crossed the inner one for width
  // > 2π − feather, inverting the mask inside the bypass's blind spot.
  const at = (theta: number): PieceFrame<number> => ({ ...F0, theta });
  const CENTRE = F0.theta;
  const ANTIPODE = at(F0.theta + Math.PI);

  it("(d‴) selSector keeps its orientation up to the exact-open edge", () => {
    for (const width of [3.0, 5.9, 6.0, 6.1, 6.19]) {
      const sel = selSector(CENTRE, width);
      expect(weightOf(sel, F0)).toBeCloseTo(1, 12);
      expect(weightOf(sel, ANTIPODE)).toBeCloseTo(0, 12);
    }
    // At and past the bypass the mask is exactly open — including at TAU, where
    // both ramp edges would otherwise land on cos π and divide 0 by 0.
    for (const width of [6.2, Math.PI * 2]) {
      const sel = selSector(CENTRE, width);
      expect(weightOf(sel, F0)).toBe(1);
      expect(weightOf(sel, ANTIPODE)).toBe(1);
    }
  });

  it("(d⁗) selSector's normal-regime ramp is pinned", () => {
    const sel = selSector(CENTRE, Math.PI); // band edge at ±π/2, feather 0.3
    expect(weightOf(sel, at(CENTRE + 1.4))).toBe(1);
    expect(weightOf(sel, at(CENTRE + 1.65))).toBeCloseTo(0.823338336776, 12);
    expect(weightOf(sel, at(CENTRE - 1.8))).toBeCloseTo(0.13562122039, 12);
  });

  it("(d″) selAxialBand bands on the frame axial coordinate", () => {
    const sel = selAxialBand(0, 1, 0.1);
    expect(weightOf(sel, { ...F0, axial: 0.5 })).toBe(1);
    expect(weightOf(sel, { ...F0, axial: 2 })).toBe(0);
  });
});

describe("validatePipeline — order-of-operations advisories", () => {
  const modifier: OpItem<number> = {
    kind: "modifier",
    name: "nudge",
    run: (v) => v,
  };
  const spatial = selSector(0, 0.5); // spatial: true

  it("(e) warns for a spatial selector after a modifier", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validatePipeline([modifier, spatial], "recipe-warns");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("(e′) a group boundary does NOT scope the taint — walk threads the frame through it", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // In: the modifier ran before the group, and the group's ops see the same
    // shared vertex/frame state, so the selector inside it reads a stale frame.
    validatePipeline([modifier, group([spatial])], "recipe-group-in");
    expect(warn).toHaveBeenCalledTimes(1);

    // Out: the group's modifier advances that same state past the group.
    warn.mockClear();
    validatePipeline([group([modifier]), spatial], "recipe-group-out");
    expect(warn).toHaveBeenCalledTimes(1);

    warn.mockRestore();
  });

  it("(e″) a spatial selector ahead of every modifier is clean, grouped or not", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    validatePipeline([spatial, group([spatial, modifier])], "recipe-clean");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("(e‴) warns for an arc with no anchor before it — and the anchor threads out of a group", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Dangling: the chain cursor is still the seeded rem = 0, so this arc
    // consumes nothing and walks off whatever the last op left behind.
    validatePipeline([arc<number>(1)], "recipe-dangling-arc");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/anchor/);

    // The cursor is VERTEX state, so an anchor inside an earlier group counts
    // for the arcs after it — exactly as the aim does.
    warn.mockClear();
    validatePipeline(
      [group([anchor<number>()]), arc<number>(1)],
      "recipe-anchor-out",
    );
    expect(warn).not.toHaveBeenCalled();

    // …and one before the group counts inside it.
    warn.mockClear();
    validatePipeline(
      [anchor<number>(), group([arc<number>(1)])],
      "recipe-anchor-in",
    );
    expect(warn).not.toHaveBeenCalled();

    warn.mockRestore();
  });
});
