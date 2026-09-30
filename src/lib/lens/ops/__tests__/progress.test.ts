import { describe, expect, it, vi } from "vitest";
import { NUM } from "../algebra";
import {
  fixtureGateAt,
  frameAt,
  makeCtx,
  polarOf,
  probe,
  vertexAt,
} from "./fixture";
import { makeRecipes } from "../recipes";
import {
  anchor,
  approach,
  arc,
  coil,
  during,
  group,
  rot,
  runPipeline,
  selFront,
  spread,
  validatePipeline,
  type OpCtx,
  type OpItem,
  type Progress,
  type VertexState,
} from "../ops";

// `during` remaps the channel for a subtree, which then runs the real gate
// (the fixture gate) at the remapped value.

const T0 = 0.3;
const R = 10;
const V0 = vertexAt(T0 + 0.1, R, { axial: 4, rot: 0, aim: T0, rem: 0 });
const F0 = frameAt(T0, R, { axial: 0, orient: T0 });

/** A wedge vertex (half-span 0.4, phi 0.1) at `channel` on the fixture gate. */
function ctxAt(
  channel: number,
  over: Partial<OpCtx<number>> = {},
): OpCtx<number> {
  const g = fixtureGateAt(over.rank01 ?? 0.5, over.layerPhase ?? 0.37);
  return makeCtx({
    channel,
    gateAt: g,
    R,
    layerPhase: 0.37,
    halfSpan: 0.4,
    phi: 0.1,
    d: R * (0.4 - 0.1),
    L: R * 0.4 * 2,
    yN: 0.25,
    rung: 1.5,
    wrapDir: -1,
    ...g(channel),
    ...over,
  });
}

// The expected remap, written independently of ops.ts.
function remap(p: Progress<number>, c: number): number {
  if (p.from === undefined && p.to === undefined) return c;
  const from = p.from ?? 0;
  const to = p.to ?? 1;
  return Math.min(1, Math.max(0, (c - from) / (to - from)));
}

type Seen = { w: number; ctx: OpCtx<number> };

/** The ctx and weight the probe saw inside `wrap(probe)`. */
function seen(
  wrap: (p: OpItem<number>) => OpItem<number>[],
  ctx: OpCtx<number>,
): Seen {
  const sink: Seen[] = [];
  runPipeline(wrap(probe(sink)), V0, F0, ctx);
  return sink[0];
}

// A subtree whose output depends on the scope's flight.
const SUB = [spread<number>(0.4), approach<number>(5), coil<number>(0.6)];

const RANKS = [0, 0.5, 1];
const PHASES = [0, 0.37, 1];

const REMAPS: Progress<number>[] = [
  {},
  { from: 0 },
  { from: 0.2 },
  { to: 0.5 },
  { from: 0.3, to: 0.8 },
  { from: 0.25, to: 0.75 },
];

const SEATED = { flight: 0, stick: 1 };
const pair = (c: OpCtx<number>) => ({ flight: c.flight, stick: c.stick });

describe("during", () => {
  it("(a) every remap leaves its scope EXACTLY seated at channel 0", () => {
    for (const p of REMAPS)
      for (const rank01 of RANKS)
        for (const layerPhase of PHASES) {
          const ctx = ctxAt(0, { rank01, layerPhase });
          expect(pair(ctx)).toEqual(SEATED);
          const inner = seen((pr) => [during(p, [pr])], ctx).ctx;
          expect({ channel: inner.channel, ...pair(inner) }).toEqual({ channel: 0, ...SEATED }); // prettier-ignore
        }
  });

  it("(b) the scope is seated at/below `from` and complete (fixed output) at/above `to`", () => {
    const P: Progress<number> = { from: 0.3, to: 0.6 };
    for (const c of [0, 0.15, 0.3]) {
      const inner = seen((pr) => [during(P, [pr])], ctxAt(c)).ctx;
      expect({ channel: inner.channel, ...pair(inner) }).toEqual({ channel: 0, ...SEATED }); // prettier-ignore
    }
    const out = [0.6, 0.8, 1].map(
      (c) => runPipeline([during(P, SUB)], V0, F0, ctxAt(c)).v,
    );
    for (const o of out) expect(o).toEqual(out[0]);
    expect(seen((pr) => [during(P, [pr])], ctxAt(0.8)).ctx.channel).toBe(1);
  });

  it("(c) during({}, items) is group(items) to the bit, on the same ctx object", () => {
    const ctx = ctxAt(0.42);
    expect(runPipeline([during({}, SUB)], V0, F0, ctx)).toEqual(
      runPipeline([group(SUB)], V0, F0, ctx),
    );
    // Same ctx object, so the shader gets no second gate subgraph.
    expect(seen((pr) => [during({}, [pr])], ctx).ctx).toBe(ctx);
  });

  it("(d) the weight folds in after the scope's gate: w = 0 seats, w = 1 is the phased pair", () => {
    const P: Progress<number> = { from: 0.2, to: 0.9 };
    const CH = 0.65;
    const effAt = (w: number): OpCtx<number> => {
      const sink: OpCtx<number>[] = [];
      const probeEff: OpItem<number> = {
        kind: "modifier",
        name: "probeEff",
        run: (v, ctx) => (sink.push(ctx), v),
      };
      runPipeline([during(P, [selFront<number>(() => w), probeEff])], V0, F0, ctxAt(CH)); // prettier-ignore
      return sink[0];
    };
    const phased = fixtureGateAt(0.5, 0.37)(remap(P, CH));
    expect(phased.flight).toBeGreaterThan(0); // the case has to be live
    expect(pair(effAt(0))).toEqual(SEATED);
    const one = effAt(1);
    expect(one.flight).toBe(phased.flight);
    expect(one.stick).toBeCloseTo(phased.stick, 15);
    for (const w of [0.25, 0.6])
      expect(pair(effAt(w))).toEqual({
        flight: phased.flight * w,
        stick: NUM.mix(1, phased.stick, w),
      });
  });

  it("(e) the per-piece stagger re-anchors: the pair at from + u·(to − from) is the raw pair at u", () => {
    const P: Progress<number> = { from: 0.25, to: 0.75 };
    for (const rank01 of RANKS)
      for (const layerPhase of PHASES)
        for (let i = 0; i <= 10; i++) {
          const u = i / 10;
          const ctx = ctxAt(0.25 + u * 0.5, { rank01, layerPhase });
          const inner = seen((pr) => [during(P, [pr])], ctx).ctx;
          const raw = fixtureGateAt(rank01, layerPhase)(u);
          expect(inner.flight).toBeCloseTo(raw.flight, 12);
          expect(inner.stick).toBeCloseTo(raw.stick, 12);
        }
  });

  it("(f) ops after a during see the raw ctx object", () => {
    const ctx = ctxAt(0.55);
    const sink: Seen[] = [];
    runPipeline(
      [during({ from: 0.5 }, [probe(sink)]), probe(sink)],
      V0,
      F0,
      ctx,
    );
    expect(sink[0].ctx.channel).not.toBe(ctx.channel);
    expect(sink[1].ctx).toBe(ctx);
  });

  it("(g) nesting is function composition: an inner window reads the OUTER window's clock", () => {
    const outer: Progress<number> = { from: 0.2, to: 0.8 };
    const inner: Progress<number> = { from: 0.25, to: 0.5 };
    for (const c of [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1])
      expect(
        seen((pr) => [during(outer, [during(inner, [pr])])], ctxAt(c)).ctx
          .channel,
      ).toBe(remap(inner, remap(outer, c)));
  });

  it("(h) a stick-reading selector inside the scope uses the scope's stick", () => {
    // As assemble's reel-in does; the recipe's own stick would differ here.
    const pin = selFront<number>((c) => 1 - NUM.smoothstep(0, 0.4, c.stick));
    const P: Progress<number> = { from: 0.5 };
    const ctx = ctxAt(0.7);
    const inner = seen((pr) => [during(P, [pin, pr])], ctx).w;
    const phased = fixtureGateAt(0.5, 0.37)(remap(P, 0.7));
    expect(inner).toBe(1 - NUM.smoothstep(0, 0.4, phased.stick));
    const raw = seen((pr) => [pin, pr], ctx).w;
    expect(raw).toBe(1 - NUM.smoothstep(0, 0.4, ctx.stick));
    expect(inner).not.toBe(raw);
  });

  it("(i) a chain op inside a scope: scoped out, it is an exact chord of the seated barrel, consuming the same material", () => {
    const LEAD = 1; // material-mm before the crease
    const MID = 1; // the crease's own material
    const runChain = (channel: number) => {
      const sink: VertexState<number>[] = [];
      const probeV: OpItem<number> = {
        kind: "modifier",
        name: "probeV",
        run: (v) => (sink.push(v), v),
      };
      // Its curvature reads the gate, its material length does not.
      const out = runPipeline(
        [
          rot<number>((c) => c.halfSpan),
          anchor<number>(),
          arc<number>(1, LEAD),
          during({ from: 0.5 }, [arc<number>((c) => 1 + c.flight * 2, MID), probeV]), // prettier-ignore
          arc<number>(1),
        ],
        V0,
        F0,
        ctxAt(channel),
      ).v;
      return { out, rem: sink[0].rem };
    };
    const idle = runChain(0);
    const early = runChain(0.3); // below `from` ⇒ the scope reads p′ = 0
    const played = runChain(1);
    const ctx = ctxAt(0.3);

    // The same material is spent at every channel.
    for (const r of [idle, early, played]) expect(r.rem).toBe(ctx.d - LEAD - MID); // prettier-ignore
    // Below the window the chain is the seated barrel.
    expect(early.out).toEqual(idle.out);
    expect(polarOf(early.out).theta).toBeCloseTo(ctx.t0 + ctx.phi, 9);
    expect(polarOf(early.out).radius).toBeCloseTo(ctx.R, 9);
    expect(early.out.rot).toBeCloseTo(0, 9);
    // Inside the window the crease does fold.
    expect(Math.abs(played.out.rot)).toBeGreaterThan(1e-3);
  });
});

describe("validatePipeline — the Progress invariants", () => {
  // Warnings fire once per recipe name, so each case uses its own name.
  const warningsFor = (p: Progress<unknown>, name: string): string[] => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validatePipeline([{ kind: "group", items: [], progress: p }], name);
    const messages = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    return messages;
  };

  it.each([
    [{ from: -0.2 }, /pops/],
    [{ from: 0.6, to: 0.6 }, /NaN/],
    [{ from: 0.8, to: 0.4 }, /NaN/],
    [{ to: 1.5 }, /advisory/],
    // A bare `from` is checked against the default to = 1.
    [{ from: 1 }, /NaN/],
  ])("(j) %o warns", (p, message) => {
    expect(warningsFor(p, `prog-${JSON.stringify(p)}`)[0]).toMatch(message);
  });

  it("(j′) legal windows and a non-literal (knob-bound) field are silent", () => {
    for (const [i, p] of REMAPS.entries())
      expect(warningsFor(p, `prog-legal-${i}`)).toEqual([]);
    // A uniform field can't be checked; it is left to the knob's range.
    expect(warningsFor({ from: { node: "u_from" } }, "prog-knob")).toEqual([]);
  });

  it("(l) the shipped windows are legal: from ≥ 0, to > from, to ≤ 1 at every meridian, rank and stagger", () => {
    const RECIPES = makeRecipes(NUM);
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cases: [keyof typeof RECIPES, Partial<OpCtx<number>>, Record<string, number>][] = []; // prettier-ignore
    for (const t0 of [-Math.PI, -1.15, 0, 1.4, Math.PI]) {
      cases.push(["peel", { t0 }, {}]);
      for (const rank01 of [0, 0.5, 1]) cases.push(["explode", { t0, rank01 }, {}]); // prettier-ignore
    }
    // Petals sit at rank 0.875…1, so sample there.
    for (const stagger of [0, 0.45, 0.6, 0.85])
      for (const rank01 of [0, 0.88, 0.92, 0.96, 1])
        cases.push(["rose", { rank01 }, { stagger }]);
    for (const [name, over, knobs] of cases) {
      const recipe = RECIPES[name];
      const items = recipe.build(ctxAt(0.5, over), { ...recipe.knobDefaults, ...knobs }); // prettier-ignore
      const scope = items.find((i) => i.kind === "group" && i.progress);
      const { from, to } = (scope as { progress: { from: number; to: number } }).progress; // prettier-ignore
      const at = `${name} ${JSON.stringify({ ...over, ...knobs })}`;
      expect(from, `${at}: from`).toBeGreaterThanOrEqual(0);
      expect(to, `${at}: width`).toBeGreaterThan(from);
      expect(to, `${at}: ends by 1`).toBeLessThanOrEqual(1 + 1e-12);
      validatePipeline(items, `window-${at}`);
    }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
