import { describe, expect, it, vi } from "vitest";
import { NUM } from "../algebra";
import {
  fixtureGateAt,
  HALF,
  PIECES,
  PROBES,
  VERTS,
  pieceCtx,
  pieceFrame,
  polarOf,
  runRecipe,
  seatedAt,
  type Piece,
  type Probe,
} from "./fixture";
import {
  EXPLODE_AXIAL_GAIN,
  EXPLODE_HOVER,
  EXPLODE_HOVER_RANK,
  PEEL_CURL,
  PEEL_RANK_LO,
  makeRecipes,
} from "../recipes";
import { DEPTH_THIN } from "../house";
import {
  runPipeline,
  validatePipeline,
  PART_CLASS,
  type OpCtx,
  type OpItem,
  type Progress,
  type VertexState,
} from "../ops";

// The recipes on the NUM backend: every recipe is exactly seated at channel 0,
// each moves at channel 1, which pieces take part, and the pipelines pass
// validation. recipe-goldens.test.ts pins the full outputs.

const RECIPES = makeRecipes(NUM);
type Run = ReturnType<typeof runRecipe>;
type Lanes = Partial<OpCtx<number>>;

const dist = (a: VertexState<number>, b: VertexState<number>): number =>
  Math.hypot(a.x - b.x, a.z - b.z);
const dist3 = (a: VertexState<number>, b: VertexState<number>): number =>
  Math.hypot(a.x - b.x, a.z - b.z, a.axial - b.axial);
const same = (a: VertexState<number>, b: VertexState<number>): boolean =>
  [a.x, a.z, a.axial, a.rot].every((x, i) => Object.is(x, [b.x, b.z, b.axial, b.rot][i])); // prettier-ignore

/** The run moved only along the axis, by `axial` (0: exactly seated). Compares
 *  x/z, not angles, which can differ by a full turn at ±π. */
function expectOnlyAxial(r: Run, axial: number, at: string): void {
  expect(dist(r.out, r.seated), `${at}: no radial move or turn`).toBeCloseTo(0, 9); // prettier-ignore
  expect(r.out.axial - r.seated.axial, `${at}: axial`).toBeCloseTo(axial, 9);
  expect(r.out.rot, `${at}: normals untouched`).toBeCloseTo(0, 9);
}

/** `a` lands exactly where `b` does. */
function expectSame(a: Run, b: Run, at: string): void {
  for (const k of ["x", "z", "axial", "rot"] as const)
    expect(a.out[k], `${at}: ${k}`).toBeCloseTo(b.out[k], 12);
}

// ── (a) channel 0 is the seated identity ────────────────────────────────────

describe("every recipe is the seated identity at channel 0", () => {
  for (const recipe of Object.values(RECIPES)) {
    // Real wedges overrun their nominal span, so the identity holds past
    // [0, L] too — except peel's seam side, whose first arc is not the seated one.
    const probes = recipe.name === "peel" ? PROBES.filter((v) => v.frac >= 0) : PROBES; // prettier-ignore
    it(`(a) ${recipe.name} leaves every probe vertex seated`, () => {
      for (const p of PIECES)
        for (const v of probes) {
          const r = runRecipe(recipe, p, v, 0);
          expect([r.ctx.flight, r.ctx.stick]).toEqual([0, 1]);
          expectOnlyAxial(r, 0, `t0 ${p.t0} frac ${v.frac}`);
        }
    });
  }
});

// ── (b) assemble ────────────────────────────────────────────────────────────

describe("assemble", () => {
  const recipe = RECIPES.assemble;
  const knobs = recipe.knobDefaults;
  const run = (p: Piece, v: Probe, channel: number, lanes: Lanes = {}, k = {}) => runRecipe(recipe, p, v, channel, lanes, k); // prettier-ignore

  /** The recipe's own wrap chain (sheet group item 3, minus its bend
   *  selector), run at a fixed gate pair. */
  function wrapProbe(
    p: Piece,
    v: Probe,
    phase: { flight: number; stick: number },
    lanes: Lanes = {},
  ): VertexState<number> {
    const ctx = pieceCtx(p, v, 1, fixtureGateAt(p.rank01, p.layerPhase), { ...phase, ...lanes }); // prettier-ignore
    const sheet = recipe.build(ctx, knobs)[0];
    const wrap = sheet.kind === "group" ? sheet.items[3] : sheet;
    if (wrap.kind !== "group" || wrap.items[0].kind !== "selector")
      throw new Error("sheet item 3 is not the wrap group");
    const chain: OpItem<number>[] = wrap.items.slice(1);
    return runPipeline(chain, seatedAt(ctx), pieceFrame(p), ctx).v;
  }

  it("(b′) at stick 0 the sheet runs straight off the seam", () => {
    // Nothing in the roll bends yet and there is no breath.
    const p = PIECES[0];
    const seam = { x: p.R * Math.cos(p.t0 + HALF), z: p.R * Math.sin(p.t0 + HALF) }; // prettier-ignore
    for (const v of VERTS) {
      const out = wrapProbe(p, v, { flight: 1, stick: 0 });
      const d = v.frac * p.R * 2 * HALF;
      // Along the run: distance = material; across it: the wall offset.
      expect(Math.hypot(out.x - seam.x, out.z - seam.z)).toBeCloseTo(Math.hypot(d, v.off), 8); // prettier-ignore
    }
  });

  // ── (b‴) the wrap's constants, pinned mid-gate ──────────────────────────
  // Stick 0.85 exercises the breath; stick 0.35 at both yN signs exercises the
  // roll and shear. The literals were printed from the implementation.
  const BREATH = { flight: 0.6, stick: 0.85 };
  const ROLL = { flight: 0.6, stick: 0.35 };
  it.each([
    // rank01 1: the breath's (rank01 − 0.5)·1.1 term is live
    ["the breathing main arc (2.4 / 1.1 / 0.06 / smoothstep(0.75, 1))", PIECES[2], { frac: 0.4, yN: 0.3, off: 0.2 }, BREATH, [-1.2538255671775902, 33.62964799999999, -0.1338255671775903]], // prettier-ignore
    // rank01 0.5, R 14.5 ⇒ fract(R·5.13) < 0.5 ⇒ shearSign −1
    ["the roll, +yN (5.13 / 0.9 shear / smoothstep(0.05, 0.55))", PIECES[1], { frac: 0.7, yN: 0.4, off: -0.25 }, ROLL, [2.188493226215604, 19.477502718949776, 1.7738354285714286]], // prettier-ignore
    ["the roll, −yN (the shear front reverses across the axis)", PIECES[1], { frac: 0.9, yN: -0.4, off: 0.35 }, ROLL, [1.8720391520981805, 16.94471829535936, 1.0620829387755102]], // prettier-ignore
  ] as const)(
    "(b‴) the wrap's calibration is pinned — %s",
    (_, p, v, phase, [theta, radius, rot]) => {
      const out = wrapProbe(p, v, phase);
      expect(polarOf(out).theta).toBeCloseTo(theta, 10);
      expect(polarOf(out).radius).toBeCloseTo(radius, 10);
      expect(out.rot).toBeCloseTo(rot, 10);
    },
  );

  it("(b⁸) the diagonal front's slope is in millimetres", () => {
    // front = yN·min(1, height/L): a short piece shears like the matching band
    // of a tall one. Compares radial-plane positions only.
    const radial = (v: VertexState<number>): number[] => [v.x, v.z, v.rot];
    for (const p of PIECES) {
      const L = p.R * 2 * HALF;
      for (const yN of [-0.5, -0.2, 0.3, 0.5])
        for (const frac of [0.4, 0.7, 0.9]) {
          const v = { frac, yN, off: 0.2 };
          const at = `t0 ${p.t0} yN ${yN} frac ${frac}`;
          const square = radial(wrapProbe(p, { ...v, yN: (yN * 0.6) / L }, ROLL, { height: L })); // prettier-ignore
          radial(wrapProbe(p, v, ROLL, { height: 0.6 })).forEach((c, k) => expect(c, `short ${at}`).toBeCloseTo(square[k], 10)); // prettier-ignore
          const taller = radial(wrapProbe(p, v, ROLL, { height: 1e6 }));
          radial(wrapProbe(p, v, ROLL, { height: L })).forEach((c, k) => expect(c, `cap ${at}`).toBeCloseTo(taller[k], 10)); // prettier-ignore
        }
      // and the front has an effect
      const v = { frac: 0.7, yN: 0.5, off: 0.2 };
      expect(dist(wrapProbe(p, v, ROLL, { height: 0.6 }), wrapProbe(p, v, ROLL, { height: L }))).toBeGreaterThan(0.1); // prettier-ignore
    }
  });

  it("(b⁷) a deep sheet moves rigidly (distances kept) while a thin one bends", () => {
    let bent = 0;
    for (const channel of [0.2, 0.5, 0.8])
      for (const p of PIECES) {
        for (const depth of [DEPTH_THIN, 0.3, 1]) {
          const runs = VERTS.map((v) => run(p, v, channel, { depth }));
          for (let i = 0; i < runs.length; i++)
            for (let j = i + 1; j < runs.length; j++)
              expect(dist3(runs[i].out, runs[j].out), `depth ${depth} t0 ${p.t0} @ ${channel} probes ${i},${j}`).toBeCloseTo(dist3(runs[i].seated, runs[j].seated), 8); // prettier-ignore
        }
        const thin = VERTS.map((v) => run(p, v, channel, { depth: DEPTH_THIN - 0.01 })); // prettier-ignore
        for (let i = 0; i < thin.length; i++)
          for (let j = i + 1; j < thin.length; j++)
            if (Math.abs(dist3(thin[i].out, thin[j].out) - dist3(thin[i].seated, thin[j].seated)) > 1e-6) bent++; // prettier-ignore
      }
    expect(bent).toBeGreaterThan(20);
  });

  // Sheet = (adopted OR decal OR (span ≤ 2.5 AND not axi)) AND class not in
  // {glass, iris, accessory}. Everything else only moves on the ladder.
  it.each([
    ["a cut shell wedge", {}],
    ["a bolted screw (adopted frame)", { adopted: 1 }],
    ["a decal painted on a shell", { partClass: PART_CLASS.decal }],
    ["a kept piece while keepScope is 0", { partClass: PART_CLASS.kept }],
  ] as const)(
    "(b⁵) %s gets the full sheet motion at channel 1",
    (name, lanes) => {
      for (const p of PIECES)
        for (const v of VERTS) {
          const r = run(p, v, 1, lanes);
          if (p.rank01 === 0) expect([r.ctx.flight, r.ctx.stick]).toEqual([1, 0]); // prettier-ignore
          // sep alone is 5.5 mm on the smallest shell; the throw adds 16 mm.
          expect(dist(r.out, r.seated), `${name}: wraps, throws and swirls`).toBeGreaterThan(1); // prettier-ignore
          expectSame(r, run(p, v, 1), name);
        }
    },
  );

  it.each([
    ["an axisymmetric structure ring", { axi: 1 }],
    // A full-turn ring with axi 0 still has no sheet to unroll.
    ["a full ring, span 2π", { halfSpan: Math.PI }],
    ["a glass element", { partClass: PART_CLASS.glass }],
    // Iris blades are sector-shaped but class iris, so they don't wrap.
    ["an iris blade", { partClass: PART_CLASS.iris }],
    ["a removable accessory", { partClass: PART_CLASS.accessory }],
    ["an adopted accessory", { partClass: PART_CLASS.accessory, adopted: 1 }],
  ] as const)("(b⁗) %s only moves on the ladder", (name, lanes) => {
    for (const p of PIECES)
      for (const v of VERTS) {
        const r = run(p, v, 1, lanes);
        expectOnlyAxial(r, p.rung * 0.4 * knobs.depth * r.ctx.flight, name);
      }
  });

  it("(b⁶) keepScope 1 freezes the kept parts, glass and iris; a normal wedge still moves", () => {
    // The story sets keepScope to 1 during the cards chapter.
    for (const cls of [PART_CLASS.kept, PART_CLASS.glass, PART_CLASS.iris])
      for (const p of PIECES)
        for (const v of VERTS)
          expectOnlyAxial(run(p, v, 1, { partClass: cls }, { keepScope: 1 }), 0, `class ${cls}`); // prettier-ignore
    const wedge = run(PIECES[0], VERTS[0], 1, {}, { keepScope: 1 });
    expect(dist(wedge.out, wedge.seated)).toBeGreaterThan(1);
  });
});

// ── (e) explode ─────────────────────────────────────────────────────────────

describe("explode", () => {
  const recipe = RECIPES.explode;
  const CHANNELS = [0, 0.2, 0.5, 0.8, 1];
  const run = (p: Piece, v: Probe, channel: number, lanes: Lanes = {}, k = {}) => runRecipe(recipe, p, v, channel, lanes, k); // prettier-ignore
  const hover = (p: Piece) => EXPLODE_HOVER * (1 + EXPLODE_HOVER_RANK * p.rank01); // prettier-ignore

  it.each([
    ["an accessory ring", { partClass: PART_CLASS.accessory }],
    ["an axisymmetric accessory (hood/cap/filter)", { partClass: PART_CLASS.accessory, axi: 1 }], // prettier-ignore
    ["an accessory bolted to a shell", { partClass: PART_CLASS.accessory, adopted: 1 }], // prettier-ignore
  ] as const)("(e) %s is untouched at every channel", (name, lanes) => {
    for (const channel of CHANNELS)
      for (const p of PIECES)
        for (const v of VERTS)
          expectOnlyAxial(run(p, v, channel, lanes), 0, `${name} @ ${channel}`);
  });

  it.each([
    ["a glass element", { partClass: PART_CLASS.glass }],
    ["an axisymmetric glass element", { partClass: PART_CLASS.glass, axi: 1 }],
    ["an iris blade", { partClass: PART_CLASS.iris }],
  ] as const)(
    "(e′) %s only moves axially: the rung and the hover",
    (name, lanes) => {
      for (const channel of CHANNELS)
        for (const p of PIECES)
          for (const v of VERTS) {
            const r = run(p, v, channel, lanes);
            // flight inside the recipe's `during` window, read from the recipe
            const { from, to } = (r.items[1] as { progress: Progress<number> }).progress; // prettier-ignore
            const q = NUM.clamp((channel - (from as number)) / ((to as number) - (from as number)), 0, 1); // prettier-ignore
            const flight = r.ctx.gateAt(q).flight;
            expectOnlyAxial(r, (p.rung * EXPLODE_AXIAL_GAIN + hover(p)) * flight, `${name} @ ${channel}`); // prettier-ignore
          }
    },
  );

  it("(e″) structure and decals spin, and ride the rung and the hover", () => {
    for (const p of PIECES)
      for (const v of VERTS) {
        const r = run(p, v, 1);
        expect(dist(r.out, r.seated)).toBeGreaterThan(1);
        expect(r.out.axial - r.seated.axial).toBeCloseTo((p.rung * EXPLODE_AXIAL_GAIN + hover(p)) * r.ctx.flight, 9); // prettier-ignore
        expect(Math.abs(r.out.rot)).toBeGreaterThan(0);
        expectSame(run(p, v, 1, { partClass: PART_CLASS.decal }), r, "decal");
      }
  });

  it("(e‴) with rebend on, deep pieces are unaffected and thin ones bend, whatever their class", () => {
    let bends = 0;
    for (const channel of CHANNELS)
      for (const p of PIECES)
        for (const v of VERTS) {
          const thinStructure = run(p, v, channel, { depth: DEPTH_THIN - 0.01 }, { rebend: 1 }).out; // prettier-ignore
          for (const partClass of [PART_CLASS.structure, PART_CLASS.kept]) {
            const rigid = run(p, v, channel, { partClass }, { rebend: 0 }).out;
            for (const depth of [DEPTH_THIN, DEPTH_THIN + 0.01, 1])
              expect(same(run(p, v, channel, { partClass, depth }, { rebend: 1 }).out, rigid), `deep ${depth} class ${partClass} @ ${channel}`).toBe(true); // prettier-ignore
            const thin = run(p, v, channel, { partClass, depth: DEPTH_THIN - 0.01 }, { rebend: 1 }).out; // prettier-ignore
            if (!same(thin, rigid)) bends++;
            // a kept thin shell bends exactly like a structure one
            expect(same(thin, thinStructure)).toBe(true);
          }
        }
    expect(bends).toBeGreaterThan(20);
  });

  it("(e⁗) at rebend 0 and curl 0, depth and class have no effect", () => {
    for (const channel of CHANNELS)
      for (const p of PIECES)
        for (const v of VERTS) {
          const ref = run(p, v, channel).out;
          for (const depth of [0, DEPTH_THIN - 0.01, DEPTH_THIN + 0.01, 1])
            for (const partClass of [PART_CLASS.structure, PART_CLASS.kept])
              expect(same(run(p, v, channel, { depth, partClass }).out, ref), `depth ${depth} class ${partClass} @ ${channel}`).toBe(true); // prettier-ignore
        }
  });
});

// ── (f) peel ────────────────────────────────────────────────────────────────
// Sheet pieces in the outer rank band, checked at every channel.

describe("peel", () => {
  const recipe = RECIPES.peel;
  const OUTER = PIECES[2]; // rank01 1 — inside the band
  const CHANNELS = [0.25, 0.5, 0.75, 1];
  const run = (p: Piece, v: Probe, channel: number, lanes: Lanes = {}) => runRecipe(recipe, p, v, channel, lanes); // prettier-ignore

  it.each([
    ["a cut shell wedge", {}],
    ["a bolted screw (adopted frame)", { adopted: 1 }],
    ["a decal painted on a shell", { partClass: PART_CLASS.decal }],
  ] as const)("(f) %s in the outer rank unrolls", (name, lanes) => {
    const runs = VERTS.map((v) => run(OUTER, v, 1, lanes));
    expect(Math.max(...runs.map((r) => dist(r.out, r.seated))), `${name}: unrolls`).toBeGreaterThan(1); // prettier-ignore
    runs.forEach((r, i) => expectSame(r, run(OUTER, VERTS[i], 1), name));
  });

  it.each([
    ["a glass element", { partClass: PART_CLASS.glass }],
    ["an iris blade", { partClass: PART_CLASS.iris }],
    ["a removable accessory", { partClass: PART_CLASS.accessory }],
    ["an accessory bolted to a shell", { partClass: PART_CLASS.accessory, adopted: 1 }], // prettier-ignore
    ["an axisymmetric structure ring", { axi: 1 }],
    ["a full ring, span 2π", { halfSpan: Math.PI }],
    // rank01 0.5 is below PEEL_RANK_LO, so the weight is exactly 0.
    ["an inner-rank sheet", { rank01: 0.5 }],
    ["an innermost-rank sheet", { rank01: 0 }],
  ] as const)(
    "(f′) %s never unrolls (and peel has no ladder)",
    (name, lanes) => {
      for (const channel of CHANNELS)
      for (const v of VERTS)
        expectOnlyAxial(run({ ...OUTER, ...lanes }, v, channel, lanes), 0, `${name} @ ${channel}`); // prettier-ignore
    },
  );

  it("(f‴) the peeled part curls backwards", () => {
    // The freed run turns by −curl·d/R against the barrel, so the total rot is
    // (1 + curl)·d/R. All pieces are moved into the rank band.
    for (const p of PIECES)
      for (const v of VERTS) {
        const r = run({ ...p, rank01: PEEL_RANK_LO }, v, 1);
        const at = `t0 ${p.t0} frac=${v.frac}`;
        expect(r.ctx.flight, `${at}: fully freed`).toBe(1);
        expect(r.out.rot, `${at}: flat seed + back-roll`).toBeCloseTo(((1 + PEEL_CURL) * r.ctx.d) / p.R, 12); // prettier-ignore
      }
    // and rolls tighter than the barrel: curl × the seated turn per wedge
    expect(PEEL_CURL).toBeGreaterThan(1);
  });
});

describe("validatePipeline", () => {
  it("(d) no recipe places a spatial selector after a modifier", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const recipe of Object.values(RECIPES)) {
      const ctx = runRecipe(recipe, PIECES[1], VERTS[2], 0.5).ctx;
      // Warnings fire once per name per module, so use a name unique to this file.
      validatePipeline(recipe.build(ctx, recipe.knobDefaults), `recipes.test:${recipe.name}`); // prettier-ignore
    }
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
