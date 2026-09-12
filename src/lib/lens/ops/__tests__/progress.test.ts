import { describe, expect, it, vi } from "vitest";
import { NUM } from "../algebra";
import { FIXTURE_GATE_SPEC, fixtureGateAt } from "./fixture-gate";
import { frameAt, polarOf, vertexAt } from "./fixture-state";
import { gate } from "../gate";
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
  PART_CLASS,
  type OpCtx,
  type OpItem,
  type PieceFrame,
  type Progress,
  type VertexState,
} from "../ops";

// PROGRESS SCOPING (`during`) on the NUM backend, the middle of three maps: the
// driver maps scrub → channel, `during` maps channel → channel per SUBTREE, and
// gate.ts maps channel → (flight, stick) per piece. Everything below is the
// tier-2 map: exact at both ends, composing, scoping, stacking with the weight
// fold. The gate is the REAL one (fixture-gate.ts), run at a remapped channel.

const T0 = 0.3;
const R = 10;
const HALF = 0.4;

const V0: VertexState<number> = vertexAt(T0 + 0.1, R, {
  axial: 4,
  rot: 0,
  aim: T0,
  rem: 0,
});
const F0: PieceFrame<number> = frameAt(T0, R, {
  axial: 0,
  orient: T0,
});

function ctxAt(
  channel: number,
  over: Partial<OpCtx<number>> = {},
): OpCtx<number> {
  const rank01 = over.rank01 ?? 0.5;
  const layerPhase = over.layerPhase ?? 0.37;
  const gateAt = fixtureGateAt(rank01, layerPhase);
  const g = gateAt(channel);
  return {
    A: NUM,
    channel,
    gateAt,
    t0: T0,
    R,
    rank01,
    layerPhase,
    halfSpan: HALF,
    partClass: PART_CLASS.structure,
    phi: 0.1,
    d: R * (HALF - 0.1),
    L: R * HALF * 2,
    yN: 0.25,
    off: 0,
    rung: 1.5,
    axi: 0,
    depth: 0,
    adopted: 0,
    flight: g.flight,
    stick: g.stick,
    wrapDir: -1,
    ...over,
  };
}

// The remap, stated INDEPENDENTLY of ops.ts (same primitives, spelled out): the
// clamped ramp then the optional power.
function remap(p: Progress<number>, c: number): number {
  let q = c;
  if (p.from !== undefined || p.to !== undefined) {
    const from = p.from ?? 0;
    const to = p.to ?? 1;
    q = Math.min(1, Math.max(0, (q - from) / (to - from)));
  }
  if (p.ease !== undefined) q = Math.pow(q, p.ease);
  return q;
}

interface Seen {
  w: number;
  ctx: OpCtx<number>;
}

/** A transform probe: records the weight and the SCOPE ctx (unfolded). */
function probe(sink: Seen[]): OpItem<number> {
  return {
    kind: "transform",
    name: "probe",
    run: (v, f, w, ctx) => {
      sink.push({ w, ctx });
      return { v, f };
    },
  };
}

/** A modifier probe: records the EFFECTIVE ctx (the weight fold applied). */
function probeEff(sink: OpCtx<number>[]): OpItem<number> {
  return {
    kind: "modifier",
    name: "probeEff",
    run: (v, ctx) => {
      sink.push(ctx);
      return v;
    },
  };
}

/** Run a pipeline and hand back what the probes inside it saw. */
function run(
  build: (sink: Seen[]) => OpItem<number>[],
  ctx: OpCtx<number>,
): Seen[] {
  const sink: Seen[] = [];
  runPipeline(build(sink), V0, F0, ctx);
  return sink;
}

// A subtree with something to say: a rigid throw, an axial slide and a coil,
// all of them functions of the scope's flight.
const SUB = [spread<number>(0.4), approach<number>(5, 2), coil<number>(0.6)];

const RANKS = [0, 0.5, 1];
const PHASES = [0, 0.37, 1];

// ── (a) the identity anchor ─────────────────────────────────────────────────

const REMAPS: Progress<number>[] = [
  {},
  { from: 0 },
  { from: 0.2 },
  { to: 0.5 },
  { from: 0.3, to: 0.8 },
  { ease: 2 },
  { ease: 0.5 },
  { from: 0.25, to: 0.75, ease: 3 },
];

describe("during — the identity anchor", () => {
  it("(a) every remap leaves its scope EXACTLY seated at channel 0", () => {
    for (const p of REMAPS) {
      for (const rank01 of RANKS) {
        for (const layerPhase of PHASES) {
          const ctx = ctxAt(0, { rank01, layerPhase });
          // The anchor the scope inherits: the gate is exact at channel 0.
          expect(ctx.flight).toBe(0);
          expect(ctx.stick).toBe(1);
          const [inner] = run((s) => [during(p, [probe(s)])], ctx);
          expect(inner.ctx.channel).toBe(0);
          expect(inner.ctx.flight).toBe(0);
          expect(inner.ctx.stick).toBe(1);
        }
      }
    }
  });
});

// ── (b) the window edges ────────────────────────────────────────────────────

describe("during — the window edges are exact", () => {
  const P: Progress<number> = { from: 0.3, to: 0.6 };

  it("(b) the scope is seated at/below `from` and complete at/above `to`", () => {
    for (const c of [0, 0.15, 0.3]) {
      const [inner] = run((s) => [during(P, [probe(s)])], ctxAt(c));
      expect(inner.ctx.channel).toBe(0);
      expect(inner.ctx.flight).toBe(0);
      expect(inner.ctx.stick).toBe(1);
    }

    // Past `to` the scope is HELD complete, so its subtree's output does not
    // move by a bit while the recipe's own channel keeps rising.
    const out = [0.6, 0.8, 1].map(
      (c) => runPipeline([during(P, SUB)], V0, F0, ctxAt(c)).v,
    );
    for (const o of out) {
      expect(o.x).toBe(out[0].x);
      expect(o.z).toBe(out[0].z);
      expect(o.axial).toBe(out[0].axial);
      expect(o.rot).toBe(out[0].rot);
    }
    const [held] = run((s) => [during(P, [probe(s)])], ctxAt(0.8));
    expect(held.ctx.channel).toBe(1);
  });
});

// ── (c) the empty window builds nothing ─────────────────────────────────────

describe("during — an omitted field builds no node", () => {
  it("(c) during({}, items) is group(items) to the bit", () => {
    const ctx = ctxAt(0.42);
    const a = runPipeline([group(SUB)], V0, F0, ctx);
    const b = runPipeline([during({}, SUB)], V0, F0, ctx);
    for (const k of ["x", "z", "axial", "rot", "aim", "rem"] as const) {
      expect(b.v[k]).toBe(a.v[k]);
    }
    for (const k of ["x", "z", "axial", "orient"] as const) {
      expect(b.f[k]).toBe(a.f[k]);
    }
    // Stronger than equal numbers: the scope runs on the VERY ctx object the
    // caller passed, so on the GPU there is no second gate subgraph either.
    const [inner] = run((s) => [during({}, [probe(s)])], ctx);
    expect(inner.ctx).toBe(ctx);
  });
});

// ── (d) progress against weight ─────────────────────────────────────────────

describe("during — the weight fold stacks outside it", () => {
  const P: Progress<number> = { from: 0.2, to: 0.9 };
  const CH = 0.65;

  function effAt(w: number): OpCtx<number> {
    const sink: OpCtx<number>[] = [];
    runPipeline(
      [during(P, [selFront<number>(() => w), probeEff(sink)])],
      V0,
      F0,
      ctxAt(CH),
    );
    return sink[0];
  }

  it("(d) w = 0 is the exact seat, w = 1 is the phased pair, fractional is the fold", () => {
    const phased = gate(NUM, FIXTURE_GATE_SPEC, remap(P, CH), {
      rank01: 0.5,
      layerPhase: 0.37,
    });
    expect(phased.flight).toBeGreaterThan(0); // the case has to be live

    // w = 0: the selection contract, on the PHASED pair — a masked piece is
    // seated whatever window it is scoped to.
    const zero = effAt(0);
    expect(zero.flight).toBe(0);
    expect(zero.stick).toBe(1);

    // w = 1 leaves the phased gate untouched.
    const one = effAt(1);
    expect(one.flight).toBe(phased.flight);
    expect(one.stick).toBeCloseTo(phased.stick, 15);

    // Fractional: the closed form is effCtx(phasedCtx, w) — the fold applied
    // AFTER the gate, never before it.
    for (const w of [0.25, 0.6]) {
      const eff = effAt(w);
      expect(eff.flight).toBe(phased.flight * w);
      expect(eff.stick).toBe(NUM.mix(1, phased.stick, w));
    }
  });
});

// ── (e) the stagger replays inside the sub-window ───────────────────────────

describe("during — the per-piece stagger re-anchors to [from, to]", () => {
  it("(e) the scope's pair at from + u·(to − from) is the raw pair at u", () => {
    const P: Progress<number> = { from: 0.25, to: 0.75 };
    for (const rank01 of RANKS) {
      for (const layerPhase of PHASES) {
        for (let i = 0; i <= 10; i++) {
          const u = i / 10;
          const c = 0.25 + u * 0.5;
          const [inner] = run(
            (s) => [during(P, [probe(s)])],
            ctxAt(c, { rank01, layerPhase }),
          );
          const raw = fixtureGateAt(rank01, layerPhase)(u);
          expect(inner.ctx.flight).toBeCloseTo(raw.flight, 12);
          expect(inner.ctx.stick).toBeCloseTo(raw.stick, 12);
        }
      }
    }
  });
});

// ── (f) the scope restores ──────────────────────────────────────────────────

describe("during — the scope restores", () => {
  it("(f) ops after a during see the raw channel and the raw pair", () => {
    const ctx = ctxAt(0.55);
    const sink: Seen[] = [];
    runPipeline(
      [during({ from: 0.5 }, [probe(sink)]), probe(sink)],
      V0,
      F0,
      ctx,
    );
    const [inside, after] = sink;
    expect(inside.ctx.channel).not.toBe(ctx.channel);
    expect(after.ctx).toBe(ctx); // the same object, not merely the same numbers
    expect(after.ctx.channel).toBe(0.55);
    expect(after.ctx.flight).toBe(ctx.flight);
    expect(after.ctx.stick).toBe(ctx.stick);
  });
});

// ── (g) nesting composes ────────────────────────────────────────────────────

describe("during — nesting is function composition", () => {
  it("(g) an inner window reads the OUTER window's clock", () => {
    const outer: Progress<number> = { from: 0.2, to: 0.8 };
    const inner: Progress<number> = { from: 0.25, to: 0.5, ease: 2 };
    for (const c of [0, 0.2, 0.35, 0.5, 0.65, 0.8, 1]) {
      const [deep] = run(
        (s) => [during(outer, [during(inner, [probe(s)])])],
        ctxAt(c),
      );
      expect(deep.ctx.channel).toBe(remap(inner, remap(outer, c)));
    }
  });
});

// ── (h) selectors read the phased ctx ───────────────────────────────────────

describe("during — selectors inside a scope read the phased ctx", () => {
  // assemble's pin idiom: a selector that fades as the piece tapes down. It
  // must read the SCOPED clock, or a pinned group releases on the recipe's
  // schedule instead of its own.
  const PIN_END = 0.4;
  const pin = selFront<number>((c) => 1 - NUM.smoothstep(0, PIN_END, c.stick));

  it("(h) a stick-reading selector inside the scope uses the scope's stick", () => {
    const P: Progress<number> = { from: 0.5 };
    const ctx = ctxAt(0.7);
    const [inner] = run((s) => [during(P, [pin, probe(s)])], ctx);
    const phased = fixtureGateAt(0.5, 0.37)(remap(P, 0.7));
    expect(inner.w).toBe(1 - NUM.smoothstep(0, PIN_END, phased.stick));

    // …and that is NOT what the recipe's own clock says here: the raw piece is
    // still pinned wide open while the scope has already begun to release.
    const [raw] = run((s) => [pin, probe(s)], ctx);
    expect(raw.w).toBe(1 - NUM.smoothstep(0, PIN_END, ctx.stick));
    expect(inner.w).not.toBe(raw.w);
  });
});

// ── (i) a bend chain across a scope boundary ────────────────────────────────

describe("during — a chain op inside a scope", () => {
  // A chain carries STATE (the material cursor and the aim) from op to op while
  // `during` scopes the CTX; a scope that lost the cursor would tear the sheet
  // in half at the boundary.
  const WINDOW = 0.5;
  const LATE: Progress<number> = { from: WINDOW };
  const LEAD = 1; // material-mm before the crease
  const MID = 1; // the crease's own material

  /** A modifier that records the vertex state it is handed. */
  function probeV(sink: VertexState<number>[]): OpItem<number> {
    return {
      kind: "modifier",
      name: "probeV",
      run: (v) => {
        sink.push(v);
        return v;
      },
    };
  }

  // A seated chain with ONE scoped arc in the middle: the crease's CURVATURE
  // reads the gate, its MATERIAL does not.
  const chain = (sink: VertexState<number>[]): OpItem<number>[] => [
    rot<number>((c) => c.halfSpan),
    anchor<number>(),
    arc<number>(1, LEAD),
    during(LATE, [arc<number>((c) => 1 + c.flight * 2, MID), probeV(sink)]),
    arc<number>(1), // unbounded tail
  ];

  function runChain(channel: number): {
    out: VertexState<number>;
    atCrease: VertexState<number>;
  } {
    const sink: VertexState<number>[] = [];
    const out = runPipeline(chain(sink), V0, F0, ctxAt(channel)).v;
    return { out, atCrease: sink[0] };
  }

  it("(i) a scoped-out arc is an exact chord of the seated barrel, consuming the same material", () => {
    const idle = runChain(0);
    const early = runChain(0.3); // below `from` ⇒ the scope reads p′ = 0
    const played = runChain(1);
    const ctx = ctxAt(0.3);
    expect(ctx.channel).toBeLessThan(WINDOW);

    // THE CURSOR IS UNTOUCHED BY THE SCOPE. Same material spent at every
    // channel — outside the window, inside it, and at the seat.
    const spent = ctx.d - LEAD - MID;
    expect(idle.atCrease.rem).toBe(spent);
    expect(early.atCrease.rem).toBe(idle.atCrease.rem);
    expect(played.atCrease.rem).toBe(idle.atCrease.rem);

    // Below the window the chain is all-q = 1 off the seated anchor: the seated
    // barrel, to the bit against the channel-0 run and to 1e-9 against the seat.
    expect(early.out.x).toBe(idle.out.x);
    expect(early.out.z).toBe(idle.out.z);
    expect(early.out.rot).toBe(idle.out.rot);
    expect(polarOf(early.out).theta).toBeCloseTo(ctx.t0 + ctx.phi, 9);
    expect(polarOf(early.out).radius).toBeCloseTo(ctx.R, 9);
    expect(early.out.rot).toBeCloseTo(0, 9);

    // Not vacuous: inside the window the crease really creases, and it does it
    // WITHOUT taking more of the sheet than it was given.
    expect(Math.abs(played.out.rot)).toBeGreaterThan(1e-3);
  });
});

// ── (j) the authoring advisory ──────────────────────────────────────────────

describe("validatePipeline — the Progress invariants", () => {
  // `warn` fires once per RECIPE NAME (module state), so each case gets its own.
  function warningsFor(p: Progress<number>, name: string): string[] {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    validatePipeline([during(p, SUB)], name);
    const messages = spy.mock.calls.map((c) => String(c[0]));
    spy.mockRestore();
    return messages;
  }

  it("(j) each illegal literal warns, and legal windows are silent", () => {
    expect(warningsFor({ from: -0.2 }, "prog-from-neg")[0]).toMatch(/pops/);
    expect(warningsFor({ from: 0.6, to: 0.6 }, "prog-zero-width")[0]).toMatch(
      /NaN/,
    );
    expect(warningsFor({ from: 0.8, to: 0.4 }, "prog-inverted")[0]).toMatch(
      /NaN/,
    );
    expect(warningsFor({ ease: 0 }, "prog-ease-zero")[0]).toMatch(/pow/);
    expect(warningsFor({ ease: -1 }, "prog-ease-neg")[0]).toMatch(/pow/);
    expect(warningsFor({ to: 1.5 }, "prog-past-end")[0]).toMatch(/advisory/);
    // A bare `from` still checks against the DEFAULT to = 1.
    expect(warningsFor({ from: 1 }, "prog-from-at-end")[0]).toMatch(/NaN/);

    for (const [i, p] of REMAPS.entries()) {
      expect(warningsFor(p, `prog-legal-${i}`)).toEqual([]);
    }
  });

  it("(j′) a non-literal (knob-bound) field is left to the knob's range", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A backend scalar stands in for a uniform: nothing static can read it, so
    // the pass must stay quiet rather than guess.
    const knobbed: Progress<{ node: string }> = { from: { node: "u_from" } };
    validatePipeline(
      [{ kind: "group", items: [], progress: knobbed }],
      "prog-knob",
    );
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── (l) inertness ───────────────────────────────────────────────────────────

describe("which shipped recipes use during", () => {
  const RECIPES = makeRecipes(NUM);
  const carries = (items: OpItem<number>[]): boolean =>
    items.some(
      (i) =>
        i.kind === "group" && (i.progress !== undefined || carries(i.items)),
    );

  it("(l) three do — `peel`, `rose` and `explode`, whose staggers ARE windows", () => {
    // `peel` windows because both of the gate's stagger inputs are degenerate
    // on its cast, `rose` keys the same idiom on whorl = rank01^ROSE_WHORL_EXP,
    // and `explode` keys three waves on quantized rank. `assemble` is inert.
    const DURING_RECIPES = ["peel", "rose", "explode"];
    for (const recipe of Object.values(RECIPES))
      expect(
        carries(recipe.build(ctxAt(0.5), recipe.knobDefaults)),
        recipe.name,
      ).toBe(DURING_RECIPES.includes(recipe.name));
  });

  it("(l′) peel's window is legal at every meridian and every stagger", () => {
    // validatePipeline reads literals only, so the knob-bound window is checked
    // here: from ≥ 0, to > from and to ≤ 1 at both ends of the knob's range.
    const recipe = RECIPES.peel;
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const stagger of [0, 0.45, 0.72, 0.85])
      for (const t0 of [-Math.PI, -1.15, 0, 1.4, Math.PI]) {
        const items = recipe.build(
          { ...ctxAt(0.5), t0 },
          {
            ...recipe.knobDefaults,
            stagger,
          },
        );
        const g = items[0] as { progress: { from: number; to: number } };
        const at = `stagger ${stagger} t0 ${t0}`;
        expect(g.progress.from, `${at}: from`).toBeGreaterThanOrEqual(0);
        expect(g.progress.to, `${at}: width`).toBeGreaterThan(g.progress.from);
        expect(g.progress.to, `${at}: ends by 1`).toBeLessThanOrEqual(
          1 + 1e-12,
        );
        validatePipeline(items, `peel-${at}`);
      }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("(l″) rose's window is legal at every rank and every stagger", () => {
    // The same invariants as (l′), for the rank-keyed window, at every whorl
    // depth and both ends of the knob's range.
    const recipe = RECIPES.rose;
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // the grid samples the CAST's real ranks: the visible petals live at
    // rank 0.875…1, so a grid spread over [0,1] would collapse under the whorl
    // exponent and probe one window three times
    for (const stagger of [0, 0.45, 0.6, 0.85])
      for (const rank01 of [0, 0.88, 0.92, 0.96, 1]) {
        const items = recipe.build(
          { ...ctxAt(0.5), rank01 },
          { ...recipe.knobDefaults, stagger },
        );
        const g = items[0] as { progress: { from: number; to: number } };
        const at = `stagger ${stagger} rank01 ${rank01}`;
        expect(g.progress.from, `${at}: from`).toBeGreaterThanOrEqual(0);
        expect(g.progress.to, `${at}: width`).toBeGreaterThan(g.progress.from);
        expect(g.progress.to, `${at}: ends by 1`).toBeLessThanOrEqual(
          1 + 1e-12,
        );
        validatePipeline(items, `rose-${at}`);
      }
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
