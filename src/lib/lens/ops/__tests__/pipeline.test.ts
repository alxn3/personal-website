import { afterEach, describe, expect, it, vi } from "vitest";
import { frameAt, makeCtx, probe, vertexAt } from "./fixture";
import {
  anchor,
  arc,
  crease,
  group,
  orbit,
  runPipeline,
  selFront,
  selRank,
  selSector,
  straight,
  validatePipeline,
  type OpCtx,
  type OpItem,
  type PieceFrame,
} from "../ops";

// Scoping, selectors and authoring warnings, on hand-built ctx and state.

const V0 = vertexAt(0, 1, { axial: 0, rot: 0, aim: 0.3, rem: 0 });
const F0 = frameAt(0.3, 1, { axial: 0, orient: 0.3 });

/** The weight each probe in `build` saw. */
function weights(build: (p: OpItem<number>) => OpItem<number>[]): number[] {
  const sink: { w: number; ctx: OpCtx<number> }[] = [];
  runPipeline(build(probe(sink)), V0, F0, makeCtx());
  return sink.map((s) => s.w);
}

describe("runPipeline — scoped selection", () => {
  it("(a) a selector inside a group does not affect ops after the group", () => {
    expect(weights((p) => [group([selFront(() => 0.5), p]), p])).toEqual([
      0.5, 1,
    ]);
  });

  it("(b) selectors compound multiplicatively", () => {
    expect(weights((p) => [selFront(() => 0.5), selFront(() => 0.5), p])).toEqual([0.25]); // prettier-ignore
  });

  it("(c) a spatial selector sees the frame advanced by an earlier transform", () => {
    // The orbit moves the frame from 0.3 to 1.3; a sector at 1.3 selects it only
    // after the orbit.
    const sector = selSector<number>(1.3, 0.2);
    expect(weights((p) => [orbit(1.0), sector, p])).toEqual([1]);
    expect(weights((p) => [sector, p])).toEqual([0]);
  });
});

describe("selectors — exact-1 bypasses and exact matches", () => {
  const ctx = makeCtx();
  const weightOf = (item: OpItem<number>, f: PieceFrame<number>): number =>
    item.kind === "selector" ? item.weight(f, ctx) : NaN;
  const at = (theta: number) => frameAt(theta, 1, { axial: 0, orient: 0.3 });
  const CENTRE = 0.3;
  const ANTIPODE = at(CENTRE + Math.PI);

  it("(d) selRank(0,1) and selSector(width 6.3) are exactly 1", () => {
    expect(weightOf(selRank(0, 1), F0)).toBe(1);
    expect(weightOf(selSector(0, 6.3), F0)).toBe(1);
  });

  it("(d‴) selSector keeps its orientation up to the exact-open edge", () => {
    // The width can be anything in 0..TAU; the mask must not invert near 2π.
    for (const width of [3.0, 5.9, 6.0, 6.1, 6.19]) {
      const sel = selSector(CENTRE, width);
      expect(weightOf(sel, F0)).toBeCloseTo(1, 12);
      expect(weightOf(sel, ANTIPODE)).toBeCloseTo(0, 12);
    }
    // From 6.2 up (including TAU) the mask is exactly open.
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
});

describe("validatePipeline — order-of-operations advisories", () => {
  const modifier: OpItem<number> = {
    kind: "modifier",
    name: "nudge",
    run: (v) => v,
  };
  const spatial = selSector<number>(0, 0.5); // spatial: true
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warn.mockClear());

  // Warnings fire once per recipe name, so each case has its own name.
  it.each([
    ["a spatial selector after a modifier", [modifier, spatial], /stale frame/],
    ["a modifier before the group, selector inside it", [modifier, group([spatial])], /stale frame/], // prettier-ignore
    ["a modifier inside the group, selector after it", [group([modifier]), spatial], /stale frame/], // prettier-ignore
    ["a spatial selector ahead of every modifier", [spatial, group([spatial, modifier])], null], // prettier-ignore
    ["an arc with no anchor", [arc<number>(1)], /anchor/],
    ["a straight with no anchor", [straight<number>()], /anchor/],
    ["a crease with no anchor", [crease<number>(0.2, 1)], /anchor/],
    ["an anchor in an earlier group", [group([anchor<number>()]), arc<number>(1)], null], // prettier-ignore
    ["an anchor before the group", [anchor<number>(), group([arc<number>(1)])], null], // prettier-ignore
    ["an anchored chain", [anchor<number>(), arc<number>(1), straight<number>(), crease<number>(0.2, 1)], null], // prettier-ignore
  ] as const)("%s", (name, items, message) => {
    validatePipeline([...items] as OpItem<number>[], `pipeline.test:${name}`);
    if (message === null) expect(warn).not.toHaveBeenCalled();
    else {
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toMatch(message);
    }
  });
});
