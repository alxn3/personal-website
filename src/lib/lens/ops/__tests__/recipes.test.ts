import { describe, expect, it, vi } from "vitest";
import { NUM } from "../algebra";
import { atPolar, polarOf } from "./fixture-state";
import { gate } from "../gate";
import { fixtureGateAt } from "./fixture-gate";
import { EXPLODE_HOVER_RANK, makeRecipes, type Recipe } from "../recipes";
import {
  group,
  ladder,
  rot,
  runPipeline,
  selFront,
  selSector,
  spread,
  swirl,
  validatePipeline,
  PART_CLASS,
  type OpCtx,
  type Progress,
  type OpItem,
  type PieceFrame,
  type VertexState,
} from "../ops";

// The recipe table on the NUM backend (the executable spec). A recipe is three
// things — a gate spec derived from its knobs, an ORDERED op list, and the knob
// defaults — so the tests check exactly those three: the channel-0 identity
// (every recipe leaves the seated model untouched), the composition ORDER (the
// recipe IS its order; permuting it must change the result), non-identity at
// channel 1, and pipeline hygiene.

const RECIPES = makeRecipes(NUM);
const HALF = 0.4; // wedge half-span (rad) — L = R·2·halfSpan
const WRAP_DIR = -1; // the house peel handedness

interface Piece {
  t0: number;
  R: number;
  rank01: number;
  layerPhase: number;
  rung: number;
}

// The piece grid spans the rank extremes (rank01 drives both the gate stagger
// and the swirl's rank scaling) and a spread of sector angles / shell radii.
const PIECES: Piece[] = [
  { t0: 0.3, R: 10, rank01: 0, layerPhase: 0, rung: 2.5 },
  { t0: 2.1, R: 14.5, rank01: 0.5, layerPhase: 0.37, rung: -1.5 },
  { t0: -1.2, R: 21, rank01: 1, layerPhase: 0.82, rung: -3.25 },
];

// The vertex grid walks the material coordinate d = frac·L across the sheet,
// the axial extent (yN, which the wrap shear and the twist/press read) and the
// wall offset.
const VERTS = [
  { frac: 0, yN: -0.5, off: 0 },
  { frac: 0.25, yN: -0.2, off: 0.35 },
  { frac: 0.5, yN: 0, off: 0 },
  { frac: 0.75, yN: 0.3, off: -0.4 },
  { frac: 1, yN: 0.5, off: 0.2 },
];
type Vert = (typeof VERTS)[number];

// Real wedges OVERRUN the nominal half-span on both edges, and a bend chain's
// first/last segments are unbounded for exactly that reason — so the identity
// has to hold outside [0, L] too. The one exception is `peel`'s negative
// overrun: the travelling-front chain leads with a non-seated arc by
// construction (the inverted curl), so seam overrun there leaves the barrel
// instead of following it.
const OVERRUN = [
  { frac: -0.2, yN: 0.15, off: 0 },
  { frac: 1.2, yN: -0.35, off: 0.25 },
];

// `over` re-labels the piece's PARTICIPATION intrinsics (partClass / axi /
// halfSpan / adopted) so a probe can ask what a glass column, a full ring or a
// bolted screw sees. The default is the sheet-like shell every other probe in
// this file is about: one wedge of a 5-cut layer.
//
// A `halfSpan` override is applied BEFORE the material coordinates, so an
// overridden span stays consistent with the d/L/phi the ops read.
//
// `channel` / `gateAt` are the recipe's OWN clock and gate — the same spec the
// pair below was computed from — so a `during` scope inside a recipe re-gates
// through the real thing.
function ctxOf(
  p: Piece,
  v: Vert,
  phase: { flight: number; stick: number },
  clock?: { channel: number; gateAt: OpCtx<number>["gateAt"] },
  over: Partial<OpCtx<number>> = {},
): OpCtx<number> {
  const half = over.halfSpan ?? HALF;
  const L = p.R * 2 * half;
  const d = v.frac * L;
  return {
    A: NUM,
    // The probes that hand a flight/stick pair straight in (rather than running
    // a channel through the recipe's gate) still carry a REAL gate here — the
    // shared house-shaped fixture spec — at the full-channel clock.
    channel: clock?.channel ?? 1,
    gateAt: clock?.gateAt ?? fixtureGateAt(p.rank01, p.layerPhase),
    t0: p.t0,
    R: p.R,
    rank01: p.rank01,
    layerPhase: p.layerPhase,
    halfSpan: half,
    partClass: PART_CLASS.structure,
    phi: half - d / p.R, // the house from = −1 ⇒ d = R·(halfSpan − phi)
    d,
    L,
    yN: v.yN,
    off: v.off,
    rung: p.rung,
    axi: 0,
    layerN: 5,
    adopted: 0,
    flight: phase.flight,
    stick: phase.stick,
    wrapDir: WRAP_DIR,
    ...over,
  };
}

// The seated vertex: on the barrel (plus the wall offset), at its seated
// meridian, rotation accumulator zero.
function seatedAt(ctx: OpCtx<number>): VertexState<number> {
  return {
    ...atPolar(ctx.t0 + ctx.phi, ctx.R + ctx.off),
    axial: ctx.yN * 40,
    rot: 0,
    aim: ctx.t0,
    rem: 0,
  };
}

// The seated piece frame: the sector centre on the barrel, on the mid plane.
function frameAt(p: Piece): PieceFrame<number> {
  return { ...atPolar(p.t0, p.R), axial: 0, orient: p.t0 };
}

// `partClass == c` as an exact 0/1, the algebra selSheet is written in — spelled
// out here (not imported) so the hand-composed selection below really is an
// independent statement of the participation rule.
function isClass(ctx: OpCtx<number>, c: number): number {
  return NUM.step(c - 0.5, ctx.partClass) * NUM.step(ctx.partClass, c + 0.5);
}

function xz(v: VertexState<number>): [number, number] {
  return [v.x, v.z];
}

function dist(a: [number, number], b: [number, number]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

interface Run {
  ctx: OpCtx<number>;
  items: OpItem<number>[];
  seated: VertexState<number>;
  out: VertexState<number>;
  flight: number;
  stick: number;
}

function runAt(
  recipe: Recipe<number>,
  p: Piece,
  v: Vert,
  channel: number,
  over: Partial<OpCtx<number>> = {},
  knobsOver: Record<string, number> = {},
): Run {
  const knobs = { ...recipe.knobDefaults, ...knobsOver };
  const gateAt = (c: number): { flight: number; stick: number } =>
    gate(NUM, recipe.gateSpec(knobs), c, {
      rank01: p.rank01,
      layerPhase: p.layerPhase,
    });
  const phase = gateAt(channel);
  const ctx = ctxOf(p, v, phase, { channel, gateAt }, over);
  const seated = seatedAt(ctx);
  const items = recipe.build(ctx, knobs);
  const out = runPipeline(items, seated, frameAt(p), ctx).v;
  return { ctx, items, seated, out, ...phase };
}

// ── (a) the channel-0 identity ──────────────────────────────────────────────

describe("every recipe is the seated identity at channel 0", () => {
  for (const recipe of Object.values(RECIPES)) {
    const probes =
      recipe.name === "peel"
        ? [...VERTS, OVERRUN[1]] // see OVERRUN: negative overrun is by design
        : [...VERTS, ...OVERRUN];
    it(`(a) ${recipe.name} leaves every probe vertex seated`, () => {
      for (const p of PIECES) {
        for (const v of probes) {
          const r = runAt(recipe, p, v, 0);
          // The gate anchors it: stagger + partStagger + window ≤ 1 ⇒ win = 1.
          expect(r.flight).toBe(0);
          expect(r.stick).toBe(1);
          const seated = xz(r.seated);
          const out = xz(r.out);
          expect(out[0]).toBeCloseTo(seated[0], 9);
          expect(out[1]).toBeCloseTo(seated[1], 9);
          expect(r.out.axial).toBeCloseTo(r.seated.axial, 9);
          expect(r.out.rot).toBeCloseTo(0, 9);
        }
      }
    });
  }
});

// ── (a′) the gate-spec invariant that makes the identity representable ──────

// GateSpec's law: split < rollEnd + overlap, i.e. the stick ramp's denominator
// (rollEnd − split + min(overlap, split)) is POSITIVE. At exactly zero the
// seated state (win = 1) computes stick = 0/0 = NaN where the identity anchor
// demands an exact 1 — explode's split = 1 was precisely that bug. Asserting
// the denominator for EVERY recipe makes the whole class unrepresentable, not
// just the one instance.
const GATE_RANKS = [0, 0.25, 0.5, 0.75, 1];
const GATE_PHASES = [0, 0.37, 0.82, 1];

describe("every recipe's gate spec keeps the stick ramp non-degenerate", () => {
  for (const recipe of Object.values(RECIPES)) {
    it(`(a′) ${recipe.name}: positive stick denominator ⇒ exact channel-0 gate`, () => {
      const spec = recipe.gateSpec(recipe.knobDefaults);
      const rollEnd = spec.rollEnd ?? 1;
      const overlap = spec.overlap ?? 0;
      expect(
        rollEnd - spec.split + Math.min(overlap, spec.split),
      ).toBeGreaterThan(0);
      for (const rank01 of GATE_RANKS) {
        for (const layerPhase of GATE_PHASES) {
          const g = gate(NUM, spec, 0, { rank01, layerPhase });
          expect(g.flight).toBe(0);
          expect(g.stick).toBe(1);
        }
      }
    });
  }

  it("(a″) assemble's window is DERIVED from the live knobs, not the defaults", () => {
    // windowFrac = 1 − stagger − partStagger is a LAW, so a moved slider moves
    // the window with it and offset + window ≡ 1 still holds — the identity
    // survives knob values the defaults never visit.
    const knobs = {
      ...RECIPES.assemble.knobDefaults,
      stagger: 0.8,
      partStagger: 0.05,
    };
    const spec = RECIPES.assemble.gateSpec(knobs);
    expect(spec.windowFrac).toBeCloseTo(0.15, 12);
    for (const rank01 of GATE_RANKS) {
      for (const layerPhase of GATE_PHASES) {
        const g = gate(NUM, spec, 0, { rank01, layerPhase });
        expect(g.flight).toBe(0);
        expect(g.stick).toBe(1);
      }
    }
  });
});

// ── (b) assemble at channel 1: displacement, the wrap law, and ORDER ────────

describe("assemble at channel 1", () => {
  const recipe = RECIPES.assemble;
  const knobs = recipe.knobDefaults;
  const rank0 = PIECES[0];

  // The pipeline is TWO items: the sheet group (everything scoped to the pieces
  // that participate in the wrap) and the ladder inside its own keep-scope
  // group. Inside the sheet group: the three selectors, the WRAP CHAIN (a seam
  // re-aim, the anchor, three arcs and the re-aim spent again), sep, and the
  // reel-in group. The wrap is a SLICE rather than one item.
  const SHEET_WRAP = 3;
  const SHEET_SEP = 9;

  function sheetOf(items: OpItem<number>[]): OpItem<number>[] {
    const sheet = items[0];
    if (sheet.kind !== "group")
      throw new Error("item 0 is not the sheet group");
    return sheet.items;
  }

  // The recipe's OWN wrap chain, so the probes below exercise the shipped ops
  // rather than a copy of them.
  function wrapOf(ctx: OpCtx<number>): OpItem<number>[] {
    const chain = sheetOf(recipe.build(ctx, knobs)).slice(
      SHEET_WRAP,
      SHEET_SEP,
    );
    if (chain.length !== 6 || chain.some((i) => i.kind === "selector"))
      throw new Error("the sheet group's items 2..7 are not the wrap chain");
    return chain;
  }

  // A modifier reads the EFFECTIVE ctx `walk` hands it, so a standalone probe
  // runs the chain through the pipeline at an unmasked weight rather than
  // calling the ops directly — the fold at w = 1 is part of the arithmetic these
  // goldens pin, and so is the ONE effective ctx the chain's terms memoize on.
  function runChain(
    items: OpItem<number>[],
    p: Piece,
    ctx: OpCtx<number>,
  ): VertexState<number> {
    return runPipeline(items, seatedAt(ctx), frameAt(p), ctx).v;
  }

  it("(b) the innermost rank is in full flight and every probe is displaced", () => {
    for (const v of VERTS) {
      const r = runAt(recipe, rank0, v, 1);
      expect(r.flight).toBe(1);
      expect(r.stick).toBe(0);
      // sep (0.55·R) alone is 5.5mm on this shell; the throw adds 16mm more.
      expect(dist(xz(r.out), xz(r.seated))).toBeGreaterThan(1);
    }
  });

  it("(b′) the wrap's roll consumes the material: at stick 0 the sheet lies straight off the seam", () => {
    // At stick = 0 the curl ramp is 0, so NONE of the roll arc bends — every
    // vertex slips along the seam tangent (the classic's relaxed-flat waiting
    // sheet). breath = 0 there too, so the anchor is the seated seam point.
    const chain = wrapOf(ctxOf(rank0, VERTS[0], { flight: 1, stick: 0 }));
    const anchorAng = rank0.t0 + HALF; // the house winding puts the seam here
    const anchor: [number, number] = [
      rank0.R * Math.cos(anchorAng),
      rank0.R * Math.sin(anchorAng),
    ];
    for (const v of VERTS) {
      const ctx = ctxOf(rank0, v, { flight: 1, stick: 0 });
      const out = runChain(chain, rank0, ctx);
      // Straight run ⇒ the walked distance IS the material consumed, with the
      // wall offset riding the (unturned) normal perpendicular to it.
      expect(dist(xz(out), anchor)).toBeCloseTo(Math.hypot(ctx.d, ctx.off), 8);
    }
  });

  // ── (b‴) the wrap's calibration constants, pinned mid-gate ───────────────
  // Every other probe in this file sits at a DEGENERATE stick, where the breath
  // (smoothstep(0.75, 1, stick)), the shear envelope (4·stick·(1 − stick)) and
  // the curl ramp (smoothstep(0.05, 0.55, stick)) multiply to zero — so 2.4,
  // 1.1, 0.06, 5.13, the 0.9 shear and mix(0.45, 0.18) are never observed. No
  // SINGLE gate value lights them all: the breath only wakes above stick 0.75,
  // where the curl ramp has already saturated to 1 and stops reporting its own
  // edges. So the probes split the difference:
  //
  //   • stick 0.85 on a rank01 = 1 piece, on the main arc — the breath owns the
  //     anchor radius, q and the seam angle there, so 2.4, 1.1, 0.06 and the
  //     smoothstep(0.75, 1) edges are the only things the vertex reads.
  //   • stick 0.35 past the travelling contact, at yN of BOTH signs — breath is
  //     0, so the roll alone answers: 5.13 (the per-shell shear sign), the 0.9
  //     shear, smoothstep(0.05, 0.55) and mix(0.45, 0.18).
  //
  // CHARACTERIZATION: the literals were printed from the verified
  // implementation — a change detector, not an independent derivation.
  // These probe SHEET ctxs (ctxOf's default partClass structure / axi 0), which
  // is what the wrap group selects, and they drive the chain at w = 1 directly
  // — so the goldens are unchanged by the participation split.
  //
  // They also survived the profile → op decomposition UNCHANGED at the ten
  // places below, which was that refactor's acceptance test: the rewrite is
  // worth ~1e-14 of float re-association and nothing else. A golden that has to
  // move means the recomposition is wrong, not that the numbers are stale.
  const wrapProbe = (
    p: Piece,
    v: Vert,
    phase: { flight: number; stick: number },
  ): VertexState<number> => {
    const ctx = ctxOf(p, v, phase);
    return runChain(wrapOf(ctx), p, ctx);
  };

  const BREATH = { flight: 0.6, stick: 0.85 };
  const ROLL = { flight: 0.6, stick: 0.35 };
  const WRAP_GOLDEN: {
    name: string;
    p: Piece;
    v: Vert;
    phase: { flight: number; stick: number };
    want: { theta: number; radius: number; rot: number };
  }[] = [
    {
      name: "the breathing main arc (2.4 / 1.1 / 0.06 / smoothstep(0.75, 1))",
      p: PIECES[2], // rank01 1 — the breath's (rank01 − 0.5)·1.1 term is live
      v: { frac: 0.4, yN: 0.3, off: 0.2 },
      phase: BREATH,
      want: {
        theta: -1.2538255671775902,
        radius: 33.62964799999999,
        rot: -0.1338255671775903,
      },
    },
    {
      name: "the roll, +yN (5.13 / 0.9 shear / smoothstep(0.05, 0.55))",
      p: PIECES[1], // rank01 0.5, R 14.5 ⇒ fract(R·5.13) < 0.5 ⇒ shearSign −1
      v: { frac: 0.7, yN: 0.4, off: -0.25 },
      phase: ROLL,
      want: {
        theta: 2.188493226215604,
        radius: 19.477502718949776,
        rot: 1.7738354285714286,
      },
    },
    {
      name: "the roll, −yN (the shear front reverses across the axis)",
      p: PIECES[1],
      v: { frac: 0.9, yN: -0.4, off: 0.35 },
      phase: ROLL,
      want: {
        theta: 1.8720391520981805,
        radius: 16.94471829535936,
        rot: 1.0620829387755102,
      },
    },
  ];

  for (const g of WRAP_GOLDEN) {
    it(`(b‴) the wrap's calibration is pinned — ${g.name}`, () => {
      const out = wrapProbe(g.p, g.v, g.phase);
      expect(polarOf(out).theta).toBeCloseTo(g.want.theta, 10);
      expect(polarOf(out).radius).toBeCloseTo(g.want.radius, 10);
      expect(out.rot).toBeCloseTo(g.want.rot, 10);
    });
  }

  it("(b″) the recipe IS its composition order", () => {
    const v = VERTS[3];
    // MID-flight on purpose: at flight = 1 the swirl's pow(flight, exp) is 1
    // for any exponent and the reel-in pin is fully open, so neither would be
    // pinned by the comparison below.
    const ctx = ctxOf(rank0, v, { flight: 0.45, stick: 0.2 });
    const items = recipe.build(ctx, knobs);
    const seated = seatedAt(ctx);
    const frame = frameAt(rank0);

    // Hand-composed: the same ops, the same arguments, the same order, the same
    // SCOPING — the sheet pipeline inside its participation group, the ladder
    // outside it. The wrap CHAIN itself is the recipe's own; everything AROUND
    // it is written out here, so a changed argument, a changed order or a
    // changed scope breaks this.
    const sheet = sheetOf(items);
    const hand: OpItem<number>[] = [
      group<number>([
        selSector<number>(knobs.maskCenter, knobs.maskWidth, 0.3),
        selFront<number>(
          (c) =>
            Math.max(
              Math.max(c.adopted, isClass(c, PART_CLASS.decal)),
              (1 - NUM.step(2.5, c.halfSpan * 2)) * (1 - c.axi),
            ) *
            (1 -
              Math.max(
                Math.max(
                  isClass(c, PART_CLASS.glass),
                  isClass(c, PART_CLASS.iris),
                ),
                isClass(c, PART_CLASS.accessory),
              )),
        ),
        selFront<number>(
          (c) =>
            1 -
            knobs.keepScope *
              Math.max(
                isClass(c, PART_CLASS.kept),
                Math.max(
                  isClass(c, PART_CLASS.glass),
                  isClass(c, PART_CLASS.iris),
                ),
              ),
        ),
        ...sheet.slice(SHEET_WRAP, SHEET_SEP),
        spread<number>(knobs.sep),
        group<number>([
          selFront<number>((c) => 1 - NUM.smoothstep(0, 0.25, c.stick)),
          rot<number>((c) => c.halfSpan),
          spread<number>(knobs.spreadThrow),
          swirl<number>(knobs.swirl, { exp: 0.65, rankScale: true }),
        ]),
      ]),
      group<number>([
        selFront<number>(
          (c) =>
            1 -
            knobs.keepScope *
              Math.max(
                isClass(c, PART_CLASS.kept),
                Math.max(
                  isClass(c, PART_CLASS.glass),
                  isClass(c, PART_CLASS.iris),
                ),
              ),
        ),
        ladder<number>("attr", 0.4 * knobs.depth),
      ]),
    ];
    const asBuilt = runPipeline(items, seated, frame, ctx).v;
    const byHand = runPipeline(hand, seated, frame, ctx).v;
    expect(byHand.x).toBeCloseTo(asBuilt.x, 12);
    expect(byHand.z).toBeCloseTo(asBuilt.z, 12);
    expect(byHand.axial).toBeCloseTo(asBuilt.axial, 12);
    expect(byHand.rot).toBeCloseTo(asBuilt.rot, 12);

    // PERTURB: run the slow sep slide BEFORE the wrap. The chain's `anchor`
    // REPLACES the point off the material coordinate, so a translation
    // placed ahead of it is erased — the order is load-bearing, not cosmetic.
    const swappedSheet = [
      ...sheet.slice(0, SHEET_WRAP),
      sheet[SHEET_SEP],
      ...sheet.slice(SHEET_WRAP, SHEET_SEP),
      ...sheet.slice(SHEET_SEP + 1),
    ];
    const perturbed = runPipeline(
      [group<number>(swappedSheet), items[1]],
      seated,
      frame,
      ctx,
    ).v;
    expect(dist(xz(perturbed), xz(asBuilt))).toBeGreaterThan(1e-3);
  });

  // ── (b⁗) the DEFAULT SELECTION: who wraps and who only rides the ladder ──
  // The shrink-wrap runs on "is a segmented shell, or rides one", while the
  // tier ladder moves everything. Without that split every ring, lens element
  // and PCB throws and swirls with the shells and the reassembly reads as
  // chaos; with it drawn too tight, the decals stay behind while the shells
  // they are painted on fly 140-190mm. frames.ts measures per MESH, so the
  // derived rule reads the piece's SHAPE:
  //
  //   SHEET  ⇔  (adopted = 1 OR class = decal OR (span ≤ 2.5 AND axi = 0))
  //             AND class ∉ {glass, iris, accessory}
  //
  // Everyone else translates on the ladder ALONE.
  const LADDER_GAIN = 0.4;
  const FULL_RING = Math.PI; // halfSpan of a 2π piece

  it("(b⁗) non-participants ride the ladder alone — glass, the iris mechanism, axisymmetric solids and full rings", () => {
    const PASSENGERS: { name: string; over: Partial<OpCtx<number>> }[] = [
      { name: "an axisymmetric structure ring", over: { axi: 1 } },
      // A ring with cutouts can measure a meridian (axi 0) and still be a body
      // of revolution: it spans the whole turn, so there is no sheet to unroll.
      { name: "a full ring, span 2π", over: { halfSpan: FULL_RING } },
      {
        name: "a glass element",
        over: { partClass: PART_CLASS.glass, axi: 0 },
      },
      // The iris MECHANISM (blades/cam plate/gear) is class iris even though the
      // blades are sector-shaped: they are driven by aperture, never by the
      // wrap. The HOUSING is class structure and wraps — see the case below.
      {
        name: "an iris blade (class iris, sector-shaped)",
        over: { partClass: PART_CLASS.iris },
      },
      {
        name: "a removable accessory",
        over: { partClass: PART_CLASS.accessory },
      },
      // Barred beats riding: an accessory bolted to a shell still comes off.
      {
        name: "an adopted accessory",
        over: { partClass: PART_CLASS.accessory, adopted: 1 },
      },
    ];

    for (const { name, over } of PASSENGERS) {
      for (const p of PIECES) {
        for (const v of VERTS) {
          const r = runAt(recipe, p, v, 1, over);
          const want = p.rung * LADDER_GAIN * knobs.depth * r.flight;
          expect(
            r.out.axial - r.seated.axial,
            `${name}: axial rides the rung`,
          ).toBeCloseTo(want, 9);
          // Compared in the RADIAL PLANE, not as a raw (theta, radius) pair: a
          // full-turn piece reaches phi = ±π, where an untouched reconstruction
          // may name the same point a turn away.
          expect(
            dist(xz(r.out), xz(r.seated)),
            `${name}: no wrap, sep, throw or swirl`,
          ).toBeCloseTo(0, 9);
          expect(r.out.rot, `${name}: normals untouched`).toBeCloseTo(0, 9);
        }
      }
    }
  });

  it("(b⁶) the KEEP-SCOPE freezes the mechanism the cards scene reveals", () => {
    // story/envelopes.ts drives `keepScope` to 1 across the cards chapter so the
    // departure uncovers the mechanism in place. Driven through the pipeline
    // here, because the goldens' grid is all structure: a sign error in
    // ops/house selNotKept would leave every row of it green.
    const KEPT: { name: string; over: Partial<OpCtx<number>> }[] = [
      { name: "a kept structure piece", over: { partClass: PART_CLASS.kept } },
      { name: "a glass element", over: { partClass: PART_CLASS.glass } },
      { name: "an iris blade", over: { partClass: PART_CLASS.iris } },
    ];
    // THE KNOB SET the story ships: the scope the cards chapter writes.
    const CARDS: { label: string; knobs: Record<string, number> }[] = [
      { label: "scope", knobs: { keepScope: 1 } },
    ];
    for (const { label, knobs: over2 } of CARDS)
      for (const { name, over } of KEPT)
        for (const p of PIECES)
          for (const v of VERTS) {
            const r = runAt(recipe, p, v, 1, over, over2);
            expect(
              dist(xz(r.out), xz(r.seated)),
              `${name} (${label}): not thrown`,
            ).toBeCloseTo(0, 9);
            expect(
              r.out.axial - r.seated.axial,
              `${name} (${label}): not laddered`,
            ).toBeCloseTo(0, 9);
            expect(
              r.out.rot,
              `${name} (${label}): normals untouched`,
            ).toBeCloseTo(0, 9);
          }

    // …and it is a SCOPE, not a kill switch: a wedge still gets the whole
    // composition at the same knob value…
    const wedge = runAt(recipe, PIECES[0], VERTS[0], 1, {}, { keepScope: 1 });
    expect(dist(xz(wedge.out), xz(wedge.seated))).toBeGreaterThan(1);
    // …and at 0 — the sky chapter's own value — the kept piece moves again,
    // which is what makes the block above a scope rather than a dead branch
    const free = runAt(recipe, PIECES[0], VERTS[0], 1, {
      partClass: PART_CLASS.kept,
    });
    expect(dist(xz(free.out), xz(free.seated))).toBeGreaterThan(1);
  });

  it("(b⁵) participants get the WHOLE sheet composition — sector-shaped structure, the hardware bolted to it, and the decals painted on it", () => {
    // Three ways in, one composition. The sector piece is in on its measured
    // span; the screw is in on the adopted flag (its frame IS its host wedge's,
    // so its span would carry it anyway — the flag is what makes that
    // deliberate); the decal is in on its class, the classic's 140-190mm ride.
    const WRAPPERS: { name: string; over: Partial<OpCtx<number>> }[] = [
      { name: "a cut shell wedge (the file's default)", over: {} },
      { name: "a bolted screw (adopted frame)", over: { adopted: 1 } },
      {
        name: "a decal painted on a shell",
        over: { partClass: PART_CLASS.decal },
      },
    ];

    for (const { name, over } of WRAPPERS) {
      for (const p of PIECES) {
        for (const v of VERTS) {
          const r = runAt(recipe, p, v, 1, over);
          // Displaced far past the ladder's own axial slide: the wrap, sep,
          // throw and swirl are all live.
          expect(
            dist(xz(r.out), xz(r.seated)),
            `${name}: wraps, throws and swirls`,
          ).toBeGreaterThan(1);
          // …and it is the SAME composition the reference sheet piece gets —
          // participation is the only thing these ctxs change.
          const ref = runAt(recipe, p, v, 1);
          expect(r.out.x, `${name}: x`).toBeCloseTo(ref.out.x, 12);
          expect(r.out.z, `${name}: z`).toBeCloseTo(ref.out.z, 12);
          expect(r.out.axial, `${name}: axial`).toBeCloseTo(ref.out.axial, 12);
          expect(r.out.rot, `${name}: rot`).toBeCloseTo(ref.out.rot, 12);
        }
      }
    }
  });
});

// ── (e) explode's DEFAULT SELECTION: the classic teardown's exemptions ──────

describe("explode's default selection", () => {
  const recipe = RECIPES.explode;
  const knobs = recipe.knobDefaults;
  const CHANNELS = [0, 0.2, 0.5, 0.8, 1];

  it("(e) an ACCESSORY is untouched at every channel — no orbit, no ladder", () => {
    // Accessories come OFF; they never rode the teardown. Both the bare class
    // and the axisymmetric case are probed, and the ladder is checked too: the
    // head selector scopes the WHOLE pipeline, not just the spin group.
    const ACCESSORIES: { name: string; over: Partial<OpCtx<number>> }[] = [
      { name: "an accessory ring", over: { partClass: PART_CLASS.accessory } },
      {
        name: "an axisymmetric accessory (hood/cap/filter)",
        over: { partClass: PART_CLASS.accessory, axi: 1 },
      },
      {
        name: "an accessory bolted to a shell (adopted)",
        over: { partClass: PART_CLASS.accessory, adopted: 1 },
      },
    ];
    for (const { name, over } of ACCESSORIES) {
      for (const channel of CHANNELS) {
        for (const p of PIECES) {
          for (const v of VERTS) {
            const r = runAt(recipe, p, v, channel, over);
            expect(
              dist(xz(r.out), xz(r.seated)),
              `${name} @ ${channel}: no dilation, sep or spin`,
            ).toBeCloseTo(0, 9);
            expect(
              r.out.axial - r.seated.axial,
              `${name} @ ${channel}: off the ladder too`,
            ).toBeCloseTo(0, 9);
            expect(r.out.rot, `${name} @ ${channel}: normals`).toBeCloseTo(
              0,
              9,
            );
          }
        }
      }
    }
  });

  it("(e′) GLASS and the iris MECHANISM take the ladder and the HOVER only", () => {
    // The optical column and the blade pack never turn round the bore — that
    // is what keeps the elements reading as one column while the shells swirl
    // around them. They DO ride the hover: the parked pose is a cloud held
    // above the lens and the glass is part of it, so their whole displacement
    // is axial — the rung plus the rise — with x and z exactly untouched (an
    // orbit would move them).
    const OPTICS: { name: string; over: Partial<OpCtx<number>> }[] = [
      { name: "a glass element", over: { partClass: PART_CLASS.glass } },
      {
        name: "an axisymmetric glass element",
        over: { partClass: PART_CLASS.glass, axi: 1 },
      },
      { name: "an iris blade", over: { partClass: PART_CLASS.iris } },
    ];
    for (const { name, over } of OPTICS) {
      for (const channel of CHANNELS) {
        for (const p of PIECES) {
          for (const v of VERTS) {
            const r = runAt(recipe, p, v, channel, over);
            // the ladder and the hover sit inside the ORDER slot, so the
            // flight they scale by is the gate re-run at that slot's own clock
            // — read off the recipe's own `during`, never a copy of its numbers
            const scope = r.items[1] as { progress?: Progress<number> };
            const from = scope.progress!.from as number;
            const to = scope.progress!.to as number;
            const q = Math.min(1, Math.max(0, (channel - from) / (to - from)));
            const slotFlight = r.ctx.gateAt(q).flight;
            expect(
              r.out.x - r.seated.x,
              `${name} @ ${channel}: no dilation, no orbit`,
            ).toBeCloseTo(0, 9);
            expect(
              r.out.z - r.seated.z,
              `${name} @ ${channel}: no dilation, no orbit (z)`,
            ).toBeCloseTo(0, 9);
            // the whole displacement is axial: the rung plus the hover's rise,
            // both scaled by the slot's own flight
            const hoverRise =
              knobs.hover * (1 + EXPLODE_HOVER_RANK * p.rank01) * slotFlight;
            expect(
              r.out.axial - r.seated.axial,
              `${name} @ ${channel}: the rung and the rise`,
            ).toBeCloseTo(p.rung * knobs.axialGain * slotFlight + hoverRise, 9);
            expect(r.out.rot, `${name} @ ${channel}: no spin`).toBeCloseTo(
              0,
              9,
            );
          }
        }
      }
    }
  });

  it("(e″) structure still gets the whole teardown — the spin AND the axial", () => {
    for (const p of PIECES) {
      for (const v of VERTS) {
        const r = runAt(recipe, p, v, 1);
        // the spin carries the piece round the bore
        expect(dist(xz(r.out), xz(r.seated))).toBeGreaterThan(1);
        // axially: the rung plus the hover's rise, like everything else
        expect(r.out.axial - r.seated.axial).toBeCloseTo(
          (p.rung * knobs.axialGain +
            knobs.hover * (1 + EXPLODE_HOVER_RANK * p.rank01)) *
            r.flight,
          9,
        );
        // the spin is the only op here that turns a normal
        expect(Math.abs(r.out.rot)).toBeGreaterThan(0);
      }
    }
    // …and a DECAL rides its shell: painted markings are not an exemption.
    for (const p of PIECES) {
      const ref = runAt(recipe, p, VERTS[2], 1);
      const decal = runAt(recipe, p, VERTS[2], 1, {
        partClass: PART_CLASS.decal,
      });
      expect(decal.out.x).toBeCloseTo(ref.out.x, 12);
      expect(decal.out.z).toBeCloseTo(ref.out.z, 12);
      expect(decal.out.axial).toBeCloseTo(ref.out.axial, 12);
    }
  });
});

// ── (f) peel's DEFAULT SELECTION: the story's SCOPED unroll ─────────────────
// `peel` is the sticker roll step under two participation selectors, so the
// recipe's whole content is WHO unrolls: the sheet cast (selSheet) intersected
// with the outer rank band (selRank at the [0.93, 1] default). Everything below
// probes that admission, at every channel — the story drives this channel over
// a whole scene, so a piece that leaks in mid-scrub is as wrong as one that
// leaks in at 1.

describe("peel's scoped selection", () => {
  const recipe = RECIPES.peel;
  const knobs = recipe.knobDefaults;
  const OUTER = PIECES[2]; // rank01 1 — inside the default band
  const CHANNELS = [0.25, 0.5, 0.75, 1];

  it("(f) an OUTER-rank shell wedge unrolls, and so does what rides it", () => {
    // The three ways into selSheet, exactly as assemble's (b⁵): the measured
    // sector span, the adopted flag, the decal class.
    const ADMITTED: { name: string; over: Partial<OpCtx<number>> }[] = [
      { name: "a cut shell wedge (the file's default)", over: {} },
      { name: "a bolted screw (adopted frame)", over: { adopted: 1 } },
      {
        name: "a decal painted on a shell",
        over: { partClass: PART_CLASS.decal },
      },
    ];
    for (const { name, over } of ADMITTED) {
      const moved = VERTS.map((v) => {
        const r = runAt(recipe, OUTER, v, 1, over);
        return dist(xz(r.out), xz(r.seated));
      });
      expect(Math.max(...moved), `${name}: unrolls`).toBeGreaterThan(1);
      for (const m of moved) expect(Number.isFinite(m)).toBe(true);
      // …and it is the SAME chain the reference wedge walks.
      for (const v of VERTS) {
        const r = runAt(recipe, OUTER, v, 1, over);
        const ref = runAt(recipe, OUTER, v, 1);
        expect(r.out.x, `${name}: x`).toBeCloseTo(ref.out.x, 12);
        expect(r.out.z, `${name}: z`).toBeCloseTo(ref.out.z, 12);
        expect(r.out.rot, `${name}: rot`).toBeCloseTo(ref.out.rot, 12);
      }
    }
  });

  it("(f′) glass, the iris mechanism, accessories and bodies of revolution NEVER unroll", () => {
    // The reason the story needs a SCOPED recipe: these are
    // in the outer ranks too (the front element sits at rank 1 with the front
    // shell), so the rank band alone would admit them. Probed at rank01 1 on
    // purpose — the band is wide open here, and selSheet is the only thing
    // holding them.
    const BARRED: { name: string; over: Partial<OpCtx<number>> }[] = [
      { name: "a glass element", over: { partClass: PART_CLASS.glass } },
      { name: "an iris blade", over: { partClass: PART_CLASS.iris } },
      {
        name: "a removable accessory",
        over: { partClass: PART_CLASS.accessory },
      },
      {
        name: "an accessory bolted to a shell (adopted)",
        over: { partClass: PART_CLASS.accessory, adopted: 1 },
      },
      { name: "an axisymmetric structure ring", over: { axi: 1 } },
      { name: "a full ring, span 2π", over: { halfSpan: Math.PI } },
    ];
    for (const { name, over } of BARRED) {
      for (const channel of CHANNELS) {
        for (const v of VERTS) {
          const r = runAt(recipe, OUTER, v, channel, over);
          expect(
            dist(xz(r.out), xz(r.seated)),
            `${name} @ ${channel}: seated`,
          ).toBeCloseTo(0, 9);
          expect(
            r.out.axial - r.seated.axial,
            `${name} @ ${channel}: no axial slide (peel has no ladder)`,
          ).toBeCloseTo(0, 9);
          expect(r.out.rot, `${name} @ ${channel}: normals`).toBeCloseTo(0, 9);
        }
      }
    }
  });

  it("(f″) the rank band keeps the INNER sheet-like structure seated", () => {
    // rankLo 0.93 with the house 0.1 feather: rank01 0.5 (PCB wings, chassis
    // plates — sector-shaped structure that would otherwise unroll) is well
    // below the ramp's foot, so its weight is exactly 0 at every channel.
    for (const p of [PIECES[0], PIECES[1]]) {
      for (const channel of CHANNELS) {
        for (const v of VERTS) {
          const r = runAt(recipe, p, v, channel);
          expect(
            dist(xz(r.out), xz(r.seated)),
            `rank ${p.rank01} @ ${channel}`,
          ).toBeCloseTo(0, 9);
          expect(r.out.rot).toBeCloseTo(0, 9);
        }
      }
    }
  });

  it("(f‴) the freed run CURLS BACK — the sticker law", () => {
    // What the sticker chain does that a FLAT unroll does not: over the freed
    // material it turns the OTHER WAY from the seated barrel, by exactly q·d/R
    // with q = −curl. A flat unroll's freed run is q = 0 — it adds no turn at
    // all beyond the anchor's own seam-to-here seed (d/R), which is the flatten
    // the scene rejected. So the freed run's total rot is (1 + curl)·d/R and
    // the back-roll is the `curl·d/R` term. Probed at channel 1, where flight
    // is 1 for every piece and the whole sheet is therefore freed.
    //
    // The rank band is opened so the law is about the CHAIN, not about who is
    // admitted — (f)…(f″) above are the scope's own statements.
    const open: Recipe<number> = {
      ...recipe,
      knobDefaults: { ...knobs, rankLo: 0, rankHi: 1 },
    };
    for (const p of PIECES) {
      for (const v of VERTS) {
        const a = runAt(open, p, v, 1);
        const at = `rank ${p.rank01} frac=${v.frac}`;
        const d = v.frac * a.ctx.L;
        expect(a.flight, `${at}: fully freed`).toBe(1);
        expect(a.out.rot, `${at}: flat seed + back-roll`).toBeCloseTo(
          ((1 + knobs.curl) * d) / p.R,
          12,
        );
      }
    }
    // …and the back-roll is TIGHTER than the barrel it left: over one wedge's
    // material the seated shell turns 2·halfSpan, the freed lip curl× that.
    expect(knobs.curl).toBeGreaterThan(1);
  });
});

// ── (c) non-identity smoke ─────────────────────────────────────────────────

describe("channel-1 non-identity", () => {
  it("(c) explode actually deforms at channel 1", () => {
    const moved = PIECES.flatMap((p) =>
      VERTS.map((v) => {
        const r = runAt(RECIPES.explode, p, v, 1);
        return (
          dist(xz(r.out), xz(r.seated)) + Math.abs(r.out.axial - r.seated.axial)
        );
      }),
    );
    expect(Math.max(...moved)).toBeGreaterThan(1e-2);
    // …and the deformation is finite everywhere on the grid.
    for (const m of moved) expect(Number.isFinite(m)).toBe(true);
  });
});

// ── (d) pipeline hygiene ────────────────────────────────────────────────────

describe("validatePipeline", () => {
  it("(d) no recipe places a spatial selector after a modifier", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const recipe of Object.values(RECIPES)) {
        const ctx = ctxOf(PIECES[1], VERTS[2], { flight: 0.5, stick: 0.5 });
        // The validator's warned-set is module-level and never resets, so the
        // name must be unique to this test file or (d) could pass vacuously.
        validatePipeline(
          recipe.build(ctx, recipe.knobDefaults),
          `recipes.test:${recipe.name}`,
        );
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
