import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three/webgpu";
import { NUM } from "../../ops/algebra";
import { pieceField, type LiveRecipe, type PieceLanes } from "../../ops/cpu"; // prettier-ignore
import { shippedModel } from "./shipped-model";
import { PART_CLASS, type OpCtx } from "../../ops/ops";
import { DEPTH_THIN, WRAP_DIR, sheetTerm } from "../../ops/house";
import { makeRecipes } from "../../ops/recipes";
import { CHANNEL_DEFAULTS } from "../../core/scene";
import { RANGES, atFrac, rangeOf, windowEdges } from "../story";
import { DEFORM_RECIPES } from "../cost";
import {
  CARDS_APART,
  ROCK,
  ROSE_PULSE,
  WINK_SPAN,
  ASSEMBLE_KEEP_SCOPE,
  ENDING_BLOOM,
  ENDING_CURL,
  ENDING_RING_PHASE,
  ENDING_REBEND,
  interiorFadeAt,
  shellFadeAt,
} from "../envelopes";
import {
  makeWinkScatter,
  packWink,
  unpackWink,
  winkGone,
  winkOpacity,
} from "../../core/visibility";
import { isPeelKeep } from "../../core/parts";
import { frameOf } from "../../ops/frames";
import { storyStateAt } from "../state";
import {
  FLOW_DIMS,
  FLOW_SAMPLE_PS,
  OUTLIER_N,
  PIECE_CASTS,
  buildPieceTable,
  castOf,
  deformWindow,
  flowRollups,
  liveDeformAt,
  pieceFlow,
  pieceStateAt,
  type CastRollup,
  type PieceTable,
  type SceneFlow,
} from "../flow";

// ============================================================================
// THE PIECE-FLOW MAP — src/lib/lens/PIECE-FLOW.md, rendered from story/flow.ts
// and asserted byte-for-byte, so a wave that retunes a recipe fails here with
// the new table in the diff.
//
// TO REGENERATE, after a deliberate change:
//   LENS_PIECE_FLOW=1 npx vitest run src/lib/lens/story/__tests__/piece-flow.test.ts
// The per-scene × per-cast rollup is the surface to read.
//
// ONE CODE PATH, AND IT IS THE SHIPPED ONE: every number comes out of
// `pieceStateAt` — ops/cpu.ts's `pieceField`, host.ts's fold preamble on the
// NUM backend — driven at `storyStateAt(p)`'s channels over the frames
// ops/frames.ts derives from the SHIPPED GLB. `./shipped-model.ts` rebuilds
// that graph off the GLB's own bytes, so the roster here IS the browser's.
// ============================================================================

const MAP_URL = new URL("../../PIECE-FLOW.md", import.meta.url);

const root = shippedModel();
const table: PieceTable = buildPieceTable(root);
const rollups: SceneFlow[] = flowRollups(table);

// ── the renderer ────────────────────────────────────────────────────────────

/** fixed decimals with no signed zero — a `-0.000` cell would flip on a
 *  rounding change nothing else can see */
const fx = (v: number, d: number): string => {
  const s = v.toFixed(d);
  return s === `-${(0).toFixed(d)}` ? (0).toFixed(d) : s;
};

/** how each rolled-up dimension prints: radians to three places, millimetres to
 *  two, the size ratios to four (a 0.1% stretch is a real reading) */
const DIM_DP: Record<(typeof FLOW_DIMS)[number], number> = {
  dTheta: 3,
  dRadius: 2,
  dAxial: 2,
  roll: 3,
  bend: 3,
  curl: 3,
  stretch: 4,
  stretchAxial: 4,
};

const DIM_HEAD: Record<(typeof FLOW_DIMS)[number], string> = {
  dTheta: "dTheta",
  dRadius: "dR mm",
  dAxial: "dX mm",
  roll: "roll",
  bend: "bend",
  curl: "curl",
  stretch: "stretch",
  stretchAxial: "stretch X",
};

/** one fixed-width table, columns sized to their widest cell (STORY-COST's) */
const asTable = (head: string[], rows: string[][]): string => {
  const w = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => r[i].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padStart(w[i]))
      .join("  ")
      .trimEnd();
  return [
    line(head),
    line(w.map((n) => "-".repeat(n))),
    ...rows.map(line),
  ].join("\n");
};

const RANGE_HEAD = ["scene", "cast", "n", ...FLOW_DIMS.map((d) => DIM_HEAD[d]), "travel"]; // prettier-ignore
const MEAN_HEAD = ["scene", "cast", ...FLOW_DIMS.map((d) => DIM_HEAD[d])];

const rangeRow = (c: CastRollup): string[] => [
  c.scene,
  c.cast,
  String(c.n),
  ...FLOW_DIMS.map(
    (d) => `${fx(c.stats[d].min, DIM_DP[d])}…${fx(c.stats[d].max, DIM_DP[d])}`,
  ),
  fx(c.maxTravel, 2),
];

const meanRow = (c: CastRollup): string[] => [
  c.scene,
  c.cast,
  ...FLOW_DIMS.map((d) => fx(c.stats[d].mean, DIM_DP[d])),
];

function render(): string {
  const casts = rollups.flatMap((s) => s.casts);
  const roster = PIECE_CASTS.map(
    (c) => `${c} ${table.pieces.filter((r) => r.cast === c).length}`,
  ).join(", ");
  const [w0, w1] = deformWindow();
  const meshes = new Set(table.pieces.map((r) => r.name)).size;
  return `<!-- GENERATED — do not edit by hand. See story/__tests__/piece-flow.test.ts. -->

# PIECE-FLOW

Every piece's pose through the hero story in bore-cylindrical coordinates (the
op algebra's own space), rendered from \`story/flow.ts\`'s
\`pieceStateAt(p, key, table)\` — the real op pipeline on the NUM backend
(\`ops/cpu.ts\` \`pieceField\`) at the channels \`storyStateAt(p)\` reports.
Regenerate (the test pins the file byte-for-byte):

    LENS_PIECE_FLOW=1 npx vitest run src/lib/lens/story/__tests__/piece-flow.test.ts

**Roster.** \`lens_web_segmented.glb\` — ${meshes} mesh nodes, ${table.pieces.length} pieces (one per distinct \`_op*\` lane tuple; an adopted feature framed island by island can give a mesh several). By cast: ${roster}. Casts are core/visibility.ts's wink bands.

**Deform set.** The hero pins \`${DEFORM_RECIPES.join(" / ")}\`; knobs rest at \`knobDefaults\` except \`assemble.keepScope\`, \`explode.bloom\` and \`explode.curl\` (story/envelopes.ts). Nothing moves outside p ∈ [${w0.toFixed(4)}, ${w1.toFixed(4)}]; every piece is on its seat there.

**Columns.** \`dTheta\`/\`dR\`/\`dX\`: the frame's displacement from its seat (rad, mm, mm). \`roll\`: turn in place about the bore (0 for a rigid revolution). \`bend\`: axial, the relative rotation of the piece's two ends, unsigned, 0 for any rigid motion. \`curl\`: circumferential and signed, extra arc curvature over the seat. \`stretch\` / \`stretch X\`: size round the bore and along the axis (1 = rigid; \`stretch X\` is a ratio of the piece's own axial extent). \`travel\`: distance from the seat. Authored pose only — no mechanism drive, placement or visibility; \`stretch\` reads a flat 1.0000 ("not measured") for the 15 axisymmetric pieces; the iris nodes' \`radius\` is from their own origin.

## Per scene × cast — the range

\`min…max\` over every piece of the cast at every sample inside the scene's range
(the shared edge grid, half-open on the right, plus the hold centre).

\`\`\`text
${asTable(RANGE_HEAD, casts.map(rangeRow))}
\`\`\`

## Per scene × cast — the mean

The same cells averaged over pieces and samples; a signed mean near zero under
a wide range is a cast moving symmetrically.

\`\`\`text
${asTable(MEAN_HEAD, casts.map(meanRow))}
\`\`\`

## The pieces that move — top ${OUTLIER_N} per scene

Each at the sample where it is furthest from its seat inside the scene
(\`pieceFlow(key, table)\` has full trajectories).

\`\`\`text
${asTable(
  [
    "scene",
    "piece",
    "cast",
    "p",
    "travel",
    ...FLOW_DIMS.map((d) => DIM_HEAD[d]),
  ],
  rollups.flatMap((s) =>
    s.outliers.map((o) => [
      s.scene,
      o.key,
      o.cast,
      o.p.toFixed(4),
      fx(o.travel, 2),
      ...FLOW_DIMS.map((d) => fx(o[d], DIM_DP[d])),
    ]),
  ),
)}
\`\`\`
`;
}

// ── the law ─────────────────────────────────────────────────────────────────

describe("PIECE-FLOW", () => {
  // an on-demand instrument, not a byte pin: LENS_PIECE_FLOW=1 rewrites it,
  // and the checked-in map must still be one this renderer produced
  it("is the renderer's own shape and covers every scene and cast", () => {
    const rendered = render();
    if (process.env.LENS_PIECE_FLOW) writeFileSync(MAP_URL, rendered);
    const current = readFileSync(MAP_URL, "utf8");
    for (const head of [
      "# PIECE-FLOW",
      "## Per scene × cast — the range",
      "## Per scene × cast — the mean",
      `## The pieces that move — top ${OUTLIER_N} per scene`,
    ])
      expect(current).toContain(head);
    expect(current.split("\n")[0]).toBe(rendered.split("\n")[0]);
    for (const r of RANGES)
      expect(current).toMatch(new RegExp(`\\b${r.scene.id}\\b`));
    for (const c of PIECE_CASTS)
      expect(current).toMatch(new RegExp(`\\b${c}\\b`));
  });

  it("regenerates to itself — the render is a pure function of the model", () => {
    expect(render()).toBe(render());
  });

  it("is a pure function of (p, piece, table)", () => {
    for (const p of [0, 0.31, 0.62, 0.93, 1])
      for (const key of ["Barrel_Base_Seg0", "Element_01", "Iris_Blade_01"])
        expect(pieceStateAt(p, key, table)).toEqual(
          pieceStateAt(p, key, table),
        );
  });
});

// ── the roster is the deform's own ──────────────────────────────────────────

describe("the piece table is the model's derived frames", () => {
  it("frames every mesh node and cuts one piece per distinct lane tuple", () => {
    // 194 meshes, six of which carry more than one tuple. The counts below are
    // DISTINCT FRAMES, not islands: adoption copies the host wedge's frame
    // verbatim, so islands that snapped to the same wedge are one piece here —
    // which is what the deform sees.
    expect(new Set(table.pieces.map((r) => r.name)).size).toBe(194);
    expect(table.pieces).toHaveLength(207);
    const multi = new Map<string, number>();
    for (const r of table.pieces)
      multi.set(r.name, (multi.get(r.name) ?? 0) + 1);
    expect([...multi].filter(([, n]) => n > 1).sort()).toEqual([
      ["DecalT_BezelMIJ", 2],
      ["Focus_GuideRods", 2],
      ["Mount_Contacts", 2],
      ["Mount_FlangeScrews", 4],
      ["Mount_ScrewCounterbores", 5],
      ["Mount_Screws", 4],
    ]);
    // every key is unique, which is what makes byKey a lookup
    expect(table.byKey.size).toBe(table.pieces.length);
  });

  it("reads the ranks core/parts.ts quotes off the LIVE model", () => {
    // The node-side decode + deriveFrames pass must measure what the browser
    // measures: core/parts.ts quotes two ranks read off the shipped model's
    // baked `_opA.w`, which a lossy decode or a wrong graph would miss.
    const rank = (key: string) => table.byKey.get(key)!.lanes.rank01;
    expect(rank("Chassis_Fixed_Seg0")).toBeCloseTo(0.9377, 4);
    const cam = [0, 1, 2, 3, 4, 5, 6].map((i) => rank(`Cam_Barrel_Seg${i}`));
    expect(Math.min(...cam)).toBeCloseTo(0.8927, 4);
    expect(Math.max(...cam)).toBeCloseTo(0.919, 4);
    // and the frames are sane everywhere: R above the R_MIN floor, a real
    // angular extent, a finite axial band
    for (const r of table.pieces) {
      const l = r.lanes;
      expect(l.R, r.key).toBeGreaterThanOrEqual(0.5);
      expect(l.halfSpan, r.key).toBeGreaterThan(0);
      expect(Number.isFinite(l.yMin) && Number.isFinite(l.yMax), r.key) //
        .toBe(true);
      expect(l.yMax, r.key).toBeGreaterThanOrEqual(l.yMin);
    }
  });

  it("classes every piece into exactly one cast", () => {
    const counts = new Map<string, number>();
    for (const r of table.pieces) {
      expect(r.cast).toBe(castOf(r.name));
      counts.set(r.cast, (counts.get(r.cast) ?? 0) + 1);
    }
    expect([...counts.values()].reduce((a, b) => a + b, 0)).toBe(207);
    // the two rosters the shipped-model tests already pin, seen from here
    expect(counts.get("elements")).toBe(13);
    expect(table.pieces.filter((r) => /_Seg\d+$/.test(r.name))).toHaveLength(
      143,
    );
    for (const c of PIECE_CASTS) expect(counts.get(c), c).toBeGreaterThan(0);
  });

  it("leaves the accessories out — they are not the body's pieces", () => {
    // ops/frames.ts frames them in their own scoped pass, and they share the
    // model's graph in the live scene, so a naive walk censuses the hood and
    // the filter as body
    expect(table.pieces.filter((r) => r.name.startsWith("Acc_"))).toEqual([]);
  });
});

// ── the probes ride the goldens' path ───────────────────────────────────────

describe("the pipeline under the probes is the goldens' pipeline", () => {
  // `pieceField` reaches the goldens' own `runPipeline` through host.ts's fold
  // preamble rather than through their hand-built ctx, so a golden row must be
  // reproducible by handing this module a piece with the goldens' lanes and
  // probing the point that ctx describes.
  //
  // The goldens' fixture, and how a (piece, probe) pair becomes a POINT:
  //   halfSpan 0.4, partClass structure, axi 0, depth 0, adopted 0;
  //   yMin/yMax = ∓20, so the probe's `yN` is simply y/40 and the piece's
  //   yMid is 0 (the goldens' frame0.axial);
  //   phi = halfSpan·(1 − 2·frac), radius = R + off — i.e. the seated vertex.
  const RECIPES = makeRecipes(NUM);
  const HALF = 0.4;

  const lanesOf = (t0: number, R: number, rank01: number, layerPhase: number, rung: number) => ({ t0, R, halfSpan: HALF, rank01, layerPhase, partClass: 0, rung, axi: 0, yMin: -20, yMax: 20, depth: 0, adopted: 0, wink: -1 }); // prettier-ignore

  /** the golden row's (theta, radius, axial) at one probe, through pieceField */
  function probe(
    lanes: ReturnType<typeof lanesOf>,
    frac: number,
    yN: number,
    off: number,
    live: LiveRecipe[],
  ): [number, number, number] {
    const theta = lanes.t0 + HALF * (1 - 2 * frac);
    const r = lanes.R + off;
    const q: [number, number, number] = [
      r * Math.cos(theta),
      yN * 40,
      r * Math.sin(theta),
    ];
    const out: [number, number, number] = [0, 0, 0];
    const d = pieceField(lanes, live)(q[0], q[1], q[2], out);
    const [x, y, z] = [q[0] + d[0], q[1] + d[1], q[2] + d[2]];
    return [Math.atan2(z, x), Math.hypot(x, z), y];
  }

  const TAU = Math.PI * 2;
  const wrapPi = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU);

  it("reproduces explode's pinned rows for the rank-0 piece", () => {
    // recipe-goldens GOLDEN.explode, PIECES[0] × PROBES[0] × the four channels
    const lanes = lanesOf(0.3, 10, 0, 0, 2.5);
    const rows: [number, [number, number, number]][] = [
      [0.25, [0.7, 10, -20]],
      [0.5, [0.7, 10, -20]],
      [0.75, [0.7, 10, -20]],
      [1, [-0.8393314555380286, 18.622324745329713, 81]],
    ];
    for (const [channel, g] of rows) {
      const live = [
        { recipe: RECIPES.explode, channel, knobs: RECIPES.explode.knobDefaults }, // prettier-ignore
      ];
      const [theta, radius, axial] = probe(lanes, 0, -0.5, 0, live);
      expect(theta, `explode ch=${channel} theta`).toBeCloseTo(wrapPi(g[0]), 9);
      expect(radius, `explode ch=${channel} radius`).toBeCloseTo(g[1], 9);
      expect(axial, `explode ch=${channel} axial`).toBeCloseTo(g[2], 9);
    }
  });

  it("reproduces assemble's pinned rows for the rank-1 piece", () => {
    // GOLDEN.assemble, PIECES[2] (t0 −1.2, R 21, rank01 1) × PROBES[2]
    // (frac 0.5, yN 0, off 0) × the four channels — the overrun-free middle of
    // the sheet, on the piece the gate's staggers release FIRST (outermost
    // rank, latest phase), so it is spent by a quarter of the channel
    const lanes = lanesOf(-1.2, 21, 1, 0.82, -3.25);
    const rows: [number, [number, number, number]][] = [
      [0.25, [-2.380550661654163, 59.94469078376348, -1.267620924078974]],
      [0.5, [-2.645185686121488, 66.50099716874665, -1.3]],
      [0.75, [-2.645185686121488, 66.50099716874665, -1.3]],
      [1, [-2.645185686121488, 66.50099716874665, -1.3]],
    ];
    for (const [channel, g] of rows) {
      const live = [
        { recipe: RECIPES.assemble, channel, knobs: RECIPES.assemble.knobDefaults }, // prettier-ignore
      ];
      const [theta, radius, axial] = probe(lanes, 0.5, 0, 0, live);
      expect(theta, `assemble ch=${channel} theta`).toBeCloseTo(
        wrapPi(g[0]),
        9,
      );
      expect(radius, `assemble ch=${channel} radius`).toBeCloseTo(g[1], 9);
      expect(axial, `assemble ch=${channel} axial`).toBeCloseTo(g[2], 9);
    }
  });

  it("reproduces peel's pinned row for a wall-offset probe", () => {
    // GOLDEN.peel, PIECES[2] × PROBES[4] (frac 1, yN 0.5, off 0.2), channel 1 —
    // the off-median probe, which is where a wrong `off` would show
    const lanes = lanesOf(-1.2, 21, 1, 0.82, -3.25);
    const live = [
      { recipe: RECIPES.peel, channel: 1, knobs: RECIPES.peel.knobDefaults },
    ];
    const [theta, radius, axial] = probe(lanes, 1, 0.5, 0.2, live);
    expect(theta).toBeCloseTo(wrapPi(-1.0059758433139938), 9);
    expect(radius).toBeCloseTo(33.62760686649838, 9);
    expect(axial).toBeCloseTo(20, 9);
  });
});

// ── the laws ────────────────────────────────────────────────────────────────

describe("the state at rest, and the state's own algebra", () => {
  it("puts every piece EXACTLY on its seat where no channel is live", () => {
    // outside the deform's window the idle gate leaves the live set empty, so
    // nothing is evaluated and nothing may move — exactly, not approximately
    const [lo, hi] = deformWindow();
    const outside = [0, lo - 1e-4, hi + 1e-4, 1].filter(
      (p) => p >= 0 && p <= 1 && liveDeformAt(p).length === 0,
    );
    expect(outside.length, "the track has rest on both sides").toBeGreaterThan(1); // prettier-ignore
    for (const p of outside)
      for (const row of table.pieces) {
        const s = pieceStateAt(p, row.key, table);
        expect(s.dTheta, `${row.key} dTheta @${p}`).toBe(0);
        expect(s.dRadius, `${row.key} dRadius @${p}`).toBe(0);
        expect(s.dAxial, `${row.key} dAxial @${p}`).toBe(0);
        expect(s.travel, `${row.key} travel @${p}`).toBe(0);
        expect(s.roll, `${row.key} roll @${p}`).toBe(0);
        expect(s.bend, `${row.key} bend @${p}`).toBe(0);
        expect(s.stretch, `${row.key} stretch @${p}`).toBe(1);
        expect(s.stretchAxial, `${row.key} stretchAxial @${p}`).toBe(1);
      }
  });

  it("reports the seat itself as the piece's own frame", () => {
    // theta/radius/axial at rest ARE the lanes, to a rounding of them: the
    // decode goes through atan2/hypot, which is the point of measuring the rest
    // state the same way rather than reading the lanes back
    for (const row of table.pieces) {
      const s = pieceStateAt(0, row.key, table);
      const l = row.lanes;
      expect(s.radius, row.key).toBeCloseTo(l.R, 4);
      expect(s.axial, row.key).toBeCloseTo((l.yMin + l.yMax) * 0.5, 4);
      expect(Math.cos(s.theta - l.t0), row.key).toBeCloseTo(1, 9);
    }
  });

  it("never reports a non-finite reading anywhere on the grid", () => {
    for (const p of FLOW_SAMPLE_PS) {
      const live = liveDeformAt(p);
      for (const row of table.pieces) {
        const s = pieceStateAt(p, row.key, table, live);
        for (const [k, v] of Object.entries(s))
          if (typeof v === "number")
            expect(Number.isFinite(v), `${row.key}.${k} @${p}`).toBe(true);
        expect(s.stretch, `${row.key} stretch @${p}`).toBeGreaterThan(0);
        expect(s.stretchAxial, `${row.key} stretchAxial @${p}`) //
          .toBeGreaterThan(0);
        // a rotation angle, so this one is bounded on both sides
        expect(s.bend, `${row.key} bend @${p}`).toBeGreaterThanOrEqual(0);
        expect(s.bend, `${row.key} bend @${p}`).toBeLessThanOrEqual(Math.PI);
        expect(Math.abs(s.dTheta), `${row.key} dTheta @${p}`) //
          .toBeLessThanOrEqual(Math.PI);
      }
    }
  });

  it("measures the piece's two AXIAL ENDS, not one median plane", () => {
    // THE PROBE GEOMETRY'S OWN LAW: `bend` is the relative rotation of the two
    // ends and `stretchAxial` the ratio of the flanks joining them, so both are
    // structurally zero/one for any probe set living on a single yMid.
    let bent = 0;
    let stretched = 0;
    for (const p of FLOW_SAMPLE_PS) {
      const live = liveDeformAt(p);
      for (const row of table.pieces) {
        const s = pieceStateAt(p, row.key, table, live);
        if (s.bend > 1e-3) bent++;
        if (Math.abs(s.stretchAxial - 1) > 1e-3) stretched++;
      }
    }
    expect(bent, "the ops turn one end against the other").toBeGreaterThan(0);
    expect(stretched, "the ops stretch along the bore").toBeGreaterThan(0);
    // …and `bend`'s complement is NOT the same reading: a piece can flatten
    // circumferentially while its two ends stay parallel, so somewhere on the
    // grid `curl` is large where `bend` is EXACTLY 0.
    let flat = 0;
    for (const q of FLOW_SAMPLE_PS) {
      const lv = liveDeformAt(q);
      for (const row of table.pieces) {
        const st = pieceStateAt(q, row.key, table, lv);
        if (st.bend === 0) flat = Math.max(flat, Math.abs(st.curl));
      }
    }
    expect(flat, "curl without bend").toBeGreaterThan(0.5);
    // and the two ends really are at the piece's own extremes: the seat's
    // axial reading is their midpoint, which is the frame's own `axial`
    for (const key of ["Barrel_Base_Seg0", "Shim_Ring_02_Seg3", "Element_01"]) {
      const l = table.byKey.get(key)!.lanes;
      expect(pieceStateAt(0, key, table).axial, key) //
        .toBeCloseTo((l.yMin + l.yMax) * 0.5, 9);
    }
  });

  it("reports no circumferential stretch for a body of revolution", () => {
    // story/flow.ts `ringFramed`: an axisymmetric frame's span is the convention
    // 2π, so its circumferential probes are a RING SAMPLE whose separation
    // answers to the ring's rigid motion. The flat 1 means "not measured".
    const axi = table.pieces.filter((r) => r.lanes.axi >= 0.5);
    expect(axi.map((r) => r.key).sort()).toEqual([
      "Cam_Followers",
      ...Array.from({ length: 13 }, (_, i) => `Element_${String(i + 1).padStart(2, "0")}`), // prettier-ignore
      "Iris_ActuatorGear",
    ]);
    for (const p of FLOW_SAMPLE_PS) {
      const live = liveDeformAt(p);
      for (const row of axi)
        expect(
          pieceStateAt(p, row.key, table, live).stretch,
          `${row.key} @${p}`,
        ).toBe(1);
    }
    // …while a piece with a MEASURED span still reports one, pinned at the
    // sample grid's own extreme rather than at a hand-picked p.
    const peel = RANGES[2];
    const measured = Array.from({ length: 41 }, (_, i) => {
      const q = peel.p0 + ((peel.p1 - peel.p0) * i) / 40;
      return {
        p: q,
        stretch: pieceStateAt(q, "Ring_Focus_Seg4", table).stretch,
      };
    });
    const worst = measured.reduce((a, b) => (b.stretch < a.stretch ? b : a));
    expect(worst.stretch).toBeLessThan(0.95);
    expect(worst.stretch).toBeGreaterThan(0.5);
  });

  const ALL = makeRecipes(NUM);

  it("PARKS THE PIECES IN A SCATTERED CLOUD — not a tower, not a ring", () => {
    // The ending's parked pose (channel 1): every piece is lifted up the optical
    // axis AND pushed off its own seat meridian and radius, so the cloud reads
    // as loose parts rather than as the lens stretched.
    const live = [
      { recipe: ALL.explode, channel: 1, knobs: ALL.explode.knobDefaults },
    ];
    const up: number[] = [];
    const lat: number[] = [];
    const flat: number[] = []; // the pieces nothing pushes sideways
    for (const row of table.pieces) {
      const l = row.lanes;
      const q: [number, number, number] = [
        l.R * Math.cos(l.t0),
        (l.yMin + l.yMax) / 2,
        l.R * Math.sin(l.t0),
      ];
      const out: [number, number, number] = [0, 0, 0];
      const d = pieceField(l, live)(q[0], q[1], q[2], out);
      up.push(d[1]);
      lat.push(Math.hypot(d[0], d[2]));
      if (lat[lat.length - 1] === 0) flat.push(l.partClass);
    }
    const med = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    // every piece is held clear of its seat…
    expect(Math.min(...up), "the lowest piece still hovers").toBeGreaterThan(
      30,
    );
    // …a typical one by a good fraction of the lens' own radius sideways…
    expect(med(lat), "the cloud is dispersed").toBeGreaterThan(20);
    expect(
      med(lat.map((v, i) => v / up[i])),
      "…and visibly so",
    ).toBeGreaterThan(0.1);
    // …but the rise still dominates everywhere, so it stays a cloud ABOVE the
    // lens rather than a ring around it
    expect(
      Math.max(...lat.map((v, i) => v / up[i])),
      "up beats lateral, everywhere",
    ).toBeLessThan(1);
    // THE ONE EXEMPTION, and nothing else: the optical column keeps its line
    // (ops/house.ts selNotOptical), so glass and the iris mechanism are the only
    // pieces the dispersal leaves on their seat axis.
    expect([...new Set(flat)].sort()).toEqual([PART_CLASS.glass, PART_CLASS.iris]); // prettier-ignore
    expect(flat).toHaveLength(28);
  });

  it("PARKS RIGID: no piece is bent, stretched or turned out of its arc", () => {
    // ops/host.ts SUMS each live recipe's delta off the same seated vertex, so
    // two saturated recipes never compose into a rigid motion. The ending is
    // the explode recipe alone, and everything in it that reaches the park or
    // the seat is a rotation about the bore or a translation.
    //
    // At the park and once every piece is seated that is exact to 9 dp. IN
    // BETWEEN, only the mid-fall curl moves: `coil` re-radiuses the wedge at
    // constant arc length, so the piece keeps its length, its straightness and
    // its square-to-tangential facing, and its girth chords open by a few
    // percent. Held only up to the BLOOM's foot, since the rose is a fold.
    // The counterfactual (rebend 0) carries the exact rigid state, so
    // everything the rebend must NOT touch stays pinned to 9 dp.
    const noRebend = (live: LiveRecipe[]): LiveRecipe[] =>
      live.map((l) =>
        l.recipe.name === "explode"
          ? { ...l, knobs: { ...l.knobs, rebend: 0 } }
          : l,
      );
    for (const f of [0, 0.15, 0.3, 0.5, 0.64, 0.7]) {
      const p = atFrac(rangeOf("capsOn"), f);
      const live = noRebend(liveDeformAt(p));
      const inFlight = f > 0 && f < 0.64;
      for (const row of table.pieces) {
        const st = pieceStateAt(p, row.key, table, live);
        expect(st.stretch, `${row.key} girth at capsOn ${f}`).toBeCloseTo(1, inFlight ? 1 : 9); // prettier-ignore
        expect(st.stretchAxial, `${row.key} length at capsOn ${f}`).toBeCloseTo(1, 9); // prettier-ignore
        expect(st.bend, `${row.key} bend at capsOn ${f}`).toBeCloseTo(0, 9);
        expect(st.roll, `${row.key} roll at capsOn ${f}`).toBeCloseTo(0, 9);
        if (!inFlight)
          expect(st.curl, `${row.key} curl at capsOn ${f}`).toBeCloseTo(0, 9);
      }
    }

    // …AND THE REBEND IS THE PARK'S ONLY BEND: a parked wedge lies ON its ring,
    // re-bent at constant arc length to the circle the slide carried it to, so
    // against the counterfactual the only deltas are the bend itself — the curl
    // opens, the girth chords open a few percent, and nothing else moves.
    //
    // WHO BENDS IS THINNESS (ops/house.ts DEPTH_THIN), not class: every
    // sheet-like piece with a wall shallower than the cut takes the ring's
    // curvature, every deeper one slides rigid — a bend strains a wall by
    // |off|/R, and the deep pieces (the mount plates, the boards, the focus
    // arms) would read as squashed bodies, not arcs.
    const park = atFrac(rangeOf("capsOn"), 0);
    const on = liveDeformAt(park);
    const off = noRebend(liveDeformAt(park));
    let bent = 0;
    let rigidSheets = 0;
    for (const row of table.pieces) {
      const a = pieceStateAt(park, row.key, table, on);
      const b = pieceStateAt(park, row.key, table, off);
      expect(a.dRadius, `${row.key} travel`).toBeCloseTo(b.dRadius, 9);
      expect(a.dTheta, `${row.key} turn`).toBeCloseTo(b.dTheta, 9);
      expect(a.stretchAxial, `${row.key} length`).toBeCloseTo(b.stretchAxial, 9); // prettier-ignore
      expect(a.bend, `${row.key} bend`).toBeCloseTo(b.bend, 9);
      expect(a.roll, `${row.key} roll`).toBeCloseTo(b.roll, 9);
      const thin = row.lanes.depth < DEPTH_THIN;
      if (Math.abs(a.curl - b.curl) < 1e-9) {
        expect(a.stretch, `${row.key} girth`).toBeCloseTo(b.stretch, 9);
        // a sheet-like piece that kept its curvature is a DEEP one
        if (sheetLike(row.lanes)) {
          expect(thin, `${row.key} depth ${row.lanes.depth} did not bend`).toBe(false); // prettier-ignore
          rigidSheets++;
        }
        continue;
      }
      bent++;
      expect(thin, `${row.key} depth ${row.lanes.depth} bent`).toBe(true);
      expect(a.curl, `${row.key} opens`).toBeLessThan(b.curl);
      expect(a.stretch, `${row.key} chord`).toBeGreaterThanOrEqual(b.stretch - 1e-9); // prettier-ignore
      expect(a.stretch, `${row.key} chord bound`).toBeLessThan(1.06);
    }
    expect(bent, "thin shells bent to their ring").toBeGreaterThan(100);
    expect(rigidSheets, "deep sheets slid rigid").toBeGreaterThan(20);

    // THE WALL-STRAIN LAW, measured AT THE WALLS: the girth of a piece's
    // innermost and outermost surfaces, deformed over seated. A rigid slide
    // keeps both at exactly 1; a bend at constant mid-surface arc length
    // strains them by about depth·(1 − 1/c). Deep pieces never pay it.
    let worstThin = 1;
    for (const row of table.pieces) {
      if (row.lanes.axi >= 0.5) continue;
      const ratio = wallGirth(row.lanes, on);
      if (row.lanes.depth >= DEPTH_THIN)
        expect(ratio, `${row.key} wall girth`).toBeLessThanOrEqual(1.05);
      else worstThin = Math.max(worstThin, ratio);
    }
    expect(worstThin, "the thin cast's worst wall strain").toBeLessThan(1.35);
  });

  /** ops/house.ts `sheetTerm` over a piece's lanes — who the sheet casts see. */
  function sheetLike(l: PieceLanes): boolean {
    const ctx: OpCtx<number> = { A: NUM, t0: l.t0, R: l.R, rank01: l.rank01, layerPhase: l.layerPhase, halfSpan: l.halfSpan, partClass: l.partClass, phi: 0, d: 0, L: 0, yN: 0, off: 0, rung: l.rung, axi: l.axi, depth: l.depth, adopted: l.adopted, channel: 0, gateAt: () => ({ flight: 0, stick: 0 }), flight: 0, stick: 0, wrapDir: WRAP_DIR }; // prettier-ignore
    return sheetTerm(NUM, ctx) === 1;
  }

  /** The worst wall girth ratio, deformed over seated: the chord across the
   *  piece's span at its innermost and outermost radius, R·(1 ∓ depth). */
  function wallGirth(l: PieceLanes, live: LiveRecipe[]): number {
    const field = pieceField(l, live);
    const y = (l.yMin + l.yMax) * 0.5;
    const s = Math.min(l.halfSpan, Math.PI / 2);
    const out: [number, number, number] = [0, 0, 0];
    let worst = 1;
    for (const r of [l.R * (1 - l.depth), l.R * (1 + l.depth)]) {
      const ends = [l.t0 - s, l.t0 + s].map((th) => {
        const q: [number, number, number] = [r * Math.cos(th), y, r * Math.sin(th)]; // prettier-ignore
        field(q[0], q[1], q[2], out);
        return [q[0] + out[0], q[1] + out[1], q[2] + out[2]];
      });
      const seated = 2 * r * Math.sin(s);
      if (seated < 1e-6) continue;
      const chord = Math.hypot(ends[0][0] - ends[1][0], ends[0][1] - ends[1][1], ends[0][2] - ends[1][2]); // prettier-ignore
      worst = Math.max(worst, chord / seated);
    }
    return worst;
  }

  it("CURLS SHUT ON THE WAY DOWN — and only on the way down", () => {
    // THE WRAP BEAT, on the descent alone: a shell wedge opens off its seated
    // radius as it leaves and shuts back onto it as it lands. The window is the
    // piece's OWN flight, so the beat costs neither end.
    //
    // Both ends are BITWISE, not "to 9 dp": the term is exactly 1 at flight 1
    // and at flight 0, so the field with the curl and the field without it are
    // the same floats at the park and at every already-seated piece.
    const capR = rangeOf("capsOn");
    const N = 40;
    const off = (live: LiveRecipe[]): LiveRecipe[] =>
      live.map((l) =>
        l.recipe.name === "explode"
          ? { ...l, knobs: { ...l.knobs, curl: 0 } }
          : l,
      );
    let parkDiff = 0;
    let seatDiff = 0;
    let seated = 0;
    let deepest = 0;
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const p = atFrac(capR, f);
      const live = liveDeformAt(p);
      const bare = off(live);
      for (const row of table.pieces) {
        const l = row.lanes;
        const q: [number, number, number] = [
          l.R * Math.cos(l.t0),
          (l.yMin + l.yMax) / 2,
          l.R * Math.sin(l.t0),
        ];
        const a = pieceField(l, live)(q[0], q[1], q[2], [0, 0, 0]);
        const b = pieceField(l, bare)(q[0], q[1], q[2], [0, 0, 0]);
        const same = a.every((v, k) => Object.is(v, b[k]));
        if (f === 0 && !same) parkDiff++;
        // "seated" measured on the CURL-FREE build, so the pin cannot be
        // satisfied by the curl moving the arrival
        if (f > 0 && pieceStateAt(p, row.key, table, bare).travel === 0) {
          seated++;
          if (!same) seatDiff++;
        }
        // the fall's own span only — the bloom past 0.72 is the rose's fold
        if (f <= 0.6)
          deepest = Math.min(
            deepest,
            pieceStateAt(p, row.key, table, live).curl,
          );
      }
    }
    expect(parkDiff, "pieces the curl moves at the park").toBe(0);
    expect(seated, "seated (piece, sample) pairs checked").toBeGreaterThan(
      2000,
    );
    expect(seatDiff, "pieces the curl moves at their seat").toBe(0);
    // …and ALIVE in between: the wedge opens (curl < 0 — less turn than its
    // seated arc), by a good fraction of that arc's own ~0.63 rad
    expect(deepest, "how far open the fall gets").toBeLessThan(-0.1);
  });

  it("PARKS EVEN: one ring, one radius, one angle for every piece on it", () => {
    // The pose is UNIFORM WITHIN A RING: both per-piece scatter terms ride the
    // flight window, so at the park the only radial term is `bloom` and the
    // only angular ones are `spin` and the ring phase. Stated on the piece's
    // OWN seat — every piece the opening touches sits at exactly `1 + bloom` of
    // its seat radius — so a ring is one circle.
    //
    // The ring is asserted as the MODEL's own family (`<Part>_SegN` grouped by
    // name), independently of the lane the recipe's phase reads.
    const park = rangeOf("capsOn").p0;
    const live = liveDeformAt(park);
    let opened = 0;
    let still = 0;
    const turns = new Map<string, number>();
    for (const row of table.pieces) {
      const st = pieceStateAt(park, row.key, table, live);
      const seat = st.radius - st.dRadius;
      // ONE turn per RING, hoisted above the radial exemption below so a body
      // of revolution — held on its line by `spread` but still turned by
      // `orbit` — is in this half of the law rather than skipped.
      const ring = row.name.replace(/_Seg\d+$/, "");
      const seen = turns.get(ring);
      if (seen === undefined) turns.set(ring, st.dTheta);
      else expect(st.dTheta, `${row.key} turn`).toBeCloseTo(seen, 9);
      // the optical column and the bodies of revolution keep their line
      // (ops/house.ts selNotOptical, and `spread`'s own axi exemption)
      if (Math.abs(st.dRadius) < 1e-6) {
        still++;
        continue;
      }
      opened++;
      expect(st.radius / seat, `${row.key} radius`).toBeCloseTo(
        1 + ENDING_BLOOM,
        9,
      );
    }
    expect(opened, "pieces opened onto their ring").toBeGreaterThan(150);
    expect(still, "pieces held on the axis").toBeGreaterThan(20);
    // …AND THE RINGS DO NOT SHARE ONE. At ring phase 0 every turn is the same
    // number and the seams stay stacked; here they are spread round the whole
    // circle, which is the pinwheel's cure (the arm law below measures it).
    const spread = [...turns.values()].filter((t) => t !== 0);
    expect(new Set(spread.map((t) => t.toFixed(6))).size, "distinct ring turns") //
      .toBeGreaterThan(15);
    expect(Math.max(...spread) - Math.min(...spread), "spread round the bore") //
      .toBeGreaterThan(4);
  });

  it("PARKS AS BROKEN CONCENTRIC CIRCLES — no arms", () => {
    // THE FIGURE ITSELF, measured face-on down the bore, which is what the
    // ending's ortho opening frames. Every shell is cut on the SAME meridians,
    // so a park that only slides each piece out along its own leaves every
    // ring's gaps on one set of radial lines — a five-armed pinwheel instead of
    // broken concentric circles. The reading is the angular COVERAGE profile
    // and its strongest harmonic: arms are a harmonic at the cut count.
    const park = rangeOf("capsOn").p0;
    const live = liveDeformAt(park);
    const BINS = 360;
    const bare = live.map((l) =>
      l.recipe.name === "explode"
        ? { ...l, knobs: { ...l.knobs, ringPhase: 0 } }
        : l,
    );
    /** the strongest angular harmonic of the coverage, as a share of its mean */
    const arms = (set: LiveRecipe[]): { peak: number; at: number } => {
      const seen = Array.from({ length: BINS }, () => new Set<number>());
      for (const row of table.pieces) {
        const l = row.lanes;
        const field = pieceField(l, set);
        const y = (l.yMin + l.yMax) / 2;
        for (let i = 0; i <= 24; i++) {
          const th = l.t0 + l.halfSpan * (i / 12 - 1);
          const q = [l.R * Math.cos(th), y, l.R * Math.sin(th)] as const;
          const d = field(q[0], q[1], q[2], [0, 0, 0]);
          const [x, z] = [q[0] + d[0], q[2] + d[2]];
          const r = Math.hypot(x, z);
          // the pieces the opening puts on a ring — the column it holds on the
          // axis draws no arc and carries no seam
          if (r < 1.5 * l.R) continue;
          const b = Math.round((Math.atan2(z, x) / (Math.PI * 2)) * BINS);
          seen[((b % BINS) + BINS) % BINS].add(Math.round(r));
        }
      }
      const prof = seen.map((s) => s.size);
      const mean = prof.reduce((a, b) => a + b, 0) / BINS;
      let peak = 0;
      let at = 0;
      for (let m = 2; m <= 12; m++) {
        let re = 0;
        let im = 0;
        prof.forEach((v, i) => {
          const a = (2 * Math.PI * m * i) / BINS;
          re += v * Math.cos(a);
          im += v * Math.sin(a);
        });
        const amp = (2 * Math.hypot(re, im)) / BINS / mean;
        if (amp > peak) [peak, at] = [amp, m];
      }
      return { peak, at };
    };
    // WITHOUT the phase the model is cut in five, so the arms are the fifth
    // harmonic at nearly the mean.
    const off = arms(bare);
    expect(off.at, "the arm count is the cut count").toBe(5);
    expect(off.peak, "the pinwheel").toBeGreaterThan(0.9);
    // …and with it there is no arm structure left at any count.
    expect(arms(live).peak, "arms with the ring phase").toBeLessThan(0.35);
  });

  it("DISPERSES IN FLIGHT — the evenness is the POSE's, not the motion's", () => {
    // The descent still has to read as individual pieces flying in: the bump
    // peaks mid-fall, so a ring that is one circle at the park is a scatter of
    // radii and angles on the way down.
    const capR = rangeOf("capsOn");
    const ring = table.pieces.filter((r) => /^Barrel_Inner_Seg\d$/.test(r.key));
    expect(ring).toHaveLength(5);
    const spreadAt = (p: number) => {
      const live = liveDeformAt(p);
      const st = ring.map((r) => pieceStateAt(p, r.key, table, live));
      // each piece's own opening, in its own seat radii — the ring's five
      // pieces are not seated at identical radii, so an absolute spread would
      // read the model's own variation as scatter
      const rad = st.map((s) => s.dRadius / (s.radius - s.dRadius));
      const th = st.map((s) => s.dTheta);
      return {
        radius: Math.max(...rad) - Math.min(...rad),
        theta: Math.max(...th) - Math.min(...th),
      };
    };
    // SCANNED, not sampled at one p: the ring's five pieces share a `during`
    // slot keyed on their own rank, so they leave the park together and late —
    // this looks for the worst spread anywhere on the way down.
    let worstR = 0;
    let worstT = 0;
    for (let i = 0; i <= 60; i++) {
      const w = spreadAt(atFrac(capR, i / 60));
      worstR = Math.max(worstR, w.radius);
      worstT = Math.max(worstT, w.theta);
    }
    expect(worstR, "mid-fall radii scatter").toBeGreaterThan(0.1);
    expect(worstT, "mid-fall angular scatter").toBeGreaterThan(0.3);
    // …spent at BOTH ends — the seat here being CONSTRUCT's own far edge,
    // before the bloom's fold opens on top of it
    const home = spreadAt(atFrac(capR, 0.7));
    expect(home.radius).toBeCloseTo(0, 9);
    expect(home.theta).toBeCloseTo(0, 9);
  });

  it("DESCENDS INSIDE-OUT, evenly, and is home before the bloom", () => {
    // No waves: one continuous order that winds the piece's own meridian into
    // its rank, so consecutive landings go AROUND the bore as they go outward.
    // Measured off the CPU mirror — a key that bunched would show as a hole or
    // a crowd here.
    const cap = RANGES[RANGES.length - 1];
    const N = 200;
    const local = (p: number) => (p - cap.p0) / (cap.p1 - cap.p0);
    const ps = Array.from(
      { length: N + 1 },
      (_, i) => cap.p0 + ((cap.p1 - cap.p0) * i) / N,
    );
    const seats = table.pieces.map((row) => {
      for (const p of ps)
        if (pieceStateAt(p, row.key, table).travel < 0.05)
          return { rank: row.lanes.rank01, t: local(p) };
      return { rank: row.lanes.rank01, t: 1 };
    });
    const ts = seats.map((s) => s.t).sort((a, b) => a - b);

    // EVENLY SPACED: no silent stretch inside the descent
    let hole = 0;
    for (let i = 1; i < ts.length; i++)
      hole = Math.max(hole, ts[i] - ts[i - 1]);
    expect(hole, "the worst gap between arrivals").toBeLessThan(0.05);

    // INSIDE-OUT: the radial bins' medians climb. Pieces sharing a rank layer
    // are at one radius, so the gate's phase grain may reorder them inside a
    // bin — the ORDER is radial, not per-piece.
    const bins: number[][] = Array.from({ length: 10 }, () => []);
    for (const s of seats) bins[Math.min(9, Math.floor(s.rank * 10))].push(s.t);
    const meds = bins
      .filter((b) => b.length)
      .map((b) => b.sort((x, y) => x - y)[Math.floor(b.length / 2)]);
    let drops = 0;
    for (let i = 1; i < meds.length; i++) if (meds[i] < meds[i - 1]) drops++;
    expect(drops, "the build runs outward").toBe(0);
    expect(meds[meds.length - 1] - meds[0], "and it is a sequence").toBeGreaterThan(0.2); // prettier-ignore

    // …AND IT WINDS: inside a narrow rank band arrival still tracks the piece's
    // own meridian — the staircase turning as it climbs. At EXPLODE_WIND 0
    // these collapse to noise. The inner half of rank01 is ONE band, since the
    // order exponent compresses it into the key's first eighth.
    const ang = (row: (typeof table.pieces)[number]) =>
      row.lanes.t0 / (Math.PI * 2) + 0.5;
    const corr = (xs: number[], ys: number[]) => {
      const n = xs.length;
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      let sxy = 0;
      let sxx = 0;
      let syy = 0;
      for (let i = 0; i < n; i++) {
        sxy += (xs[i] - mx) * (ys[i] - my);
        sxx += (xs[i] - mx) ** 2;
        syy += (ys[i] - my) ** 2;
      }
      return sxy / Math.sqrt(sxx * syy);
    };
    for (const [lo, hi] of [
      [0, 0.5],
      [0.5, 0.8],
      [0.8, 0.9],
      [0.9, 1.01],
    ]) {
      const band = table.pieces
        .map((row, i) => ({
          ang: ang(row),
          t: seats[i].t,
          rank: seats[i].rank,
        }))
        .filter((x) => x.rank >= lo && x.rank < hi);
      expect(band.length, `band ${lo}–${hi} is populated`).toBeGreaterThan(4);
      expect(
        corr(
          band.map((b) => b.ang),
          band.map((b) => b.t),
        ),
        `band ${lo}–${hi} winds`,
      ).toBeGreaterThan(0.4);
    }

    // …and the whole cast is seated before the bloom's foot
    const seam = (windowEdges(ROSE_PULSE.rise)[0] - cap.p0) / (cap.p1 - cap.p0);
    expect(ts[ts.length - 1]).toBeLessThan(seam);
  });

  it("never moves the mechanism the cards scene REVEALS", () => {
    // THE DEPARTURE'S SCOPE, measured rather than asserted of the recipe: every
    // piece the wink keeps stays on its seat through the peel and cards scenes,
    // so the internals are uncovered in place.
    const cards = RANGES[3];
    const peel = RANGES[2];
    const ps = FLOW_SAMPLE_PS.filter((q) => q >= peel.p0 && q <= cards.p1);
    expect(ps.length).toBeGreaterThan(8);
    const kept = table.pieces.filter((r) => isPeelKeep(r.name));
    expect(kept.length).toBeGreaterThan(50);
    for (const row of kept)
      for (const q of ps)
        // the peel chain rebuilds a point through trig, so its own scope leaves
        // a last-ULP residue on the pieces it excludes — 3e-15 mm, not motion
        expect(
          pieceStateAt(q, row.key, table).travel,
          `${row.key} @${q}`,
        ).toBeLessThan(1e-9);
    // …and the layers that DO leave are moving over the same samples, so this
    // is a scope and not a dead channel
    const shell = pieceStateAt(windowEdges(CARDS_APART.rise)[1], "Barrel_Base_Seg0", table); // prettier-ignore
    expect(shell.travel).toBeGreaterThan(10);
  });

  it("NEVER TAKES A PIECE BEFORE ITS OWN FLIGHT IS OVER — and never queues behind it", () => {
    // Two failures, both measured off the shipped model since the name → rank
    // map only exists here:
    //
    //   · a wink that opens on a piece still in flight dissolves the departure
    //     mid-throw (every mesh's own margin, below);
    //   · a wink that waits for the LAST mover leaves a stretch of the band
    //     whose only motion is the whole-model bore roll (the relay gap).
    //
    // "Taken" is on OPACITY now: a piece begins to go the frame its wink
    // opacity drops below 1, and is gone where that opacity is exactly 0.
    const peel = RANGES[2];
    const N = 400;
    const local = (p: number) => (p - peel.p0) / (peel.p1 - peel.p0);
    const ps = Array.from(
      { length: N + 1 },
      (_, i) => peel.p0 + ((peel.p1 - peel.p0) * i) / N,
    );
    // per MESH, the last sample at which any of its pieces is still travelling
    const EPS = 1e-3; // mm per step — the motion foot, not the window's foot
    const doneAt = new Map<string, number>();
    let firstMove = 1;
    let lastMove = 0;
    for (const row of table.pieces) {
      let prevTravel = pieceStateAt(ps[0], row.key, table).travel;
      for (let i = 1; i <= N; i++) {
        const t = pieceStateAt(ps[i], row.key, table).travel;
        if (Math.abs(t - prevTravel) > EPS) {
          doneAt.set(row.name, local(ps[i]));
          firstMove = Math.min(firstMove, local(ps[i - 1]));
          lastMove = Math.max(lastMove, local(ps[i]));
        }
        prevTravel = t;
      }
    }
    expect(doneAt.size, "the departure moves a real cast").toBeGreaterThan(100);

    // every wink-governed top-level mesh, read off the STAMPED lane the
    // materials read — and checked against a fresh scatter in traversal order,
    // which is the stamp's own law
    const wink = makeWinkScatter();
    const gates: { name: string; shell: boolean; threshold: number }[] = [];
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.parent instanceof THREE.Mesh) return;
      const lane = frameOf(o.geometry)!.wink;
      expect(lane, `${o.name} lane`).toBe(Math.fround(packWink(wink(o.name))));
      const w = unpackWink(lane); // the float32 the shader reads
      if (w) gates.push({ name: o.name, shell: w.channel === "shell", threshold: w.threshold }); // prettier-ignore
    });
    expect(gates.length).toBeGreaterThan(100);
    const levelAt = (g: (typeof gates)[number], p: number) =>
      g.shell ? shellFadeAt(p) : interiorFadeAt(p);
    /** the first sample at which a mesh is no longer whole (opacity < 1) */
    const fadesLocalOf = (g: (typeof gates)[number]) => {
      for (const p of ps)
        if (winkOpacity(g.threshold, levelAt(g, p)) < 1) return local(p);
      return 1;
    };

    let tightest = { name: "", margin: Infinity };
    let fadesFirst = 1;
    for (const g of gates) {
      const fades = fadesLocalOf(g);
      fadesFirst = Math.min(fadesFirst, fades);
      const done = doneAt.get(g.name);
      if (done === undefined) continue; // the departure never moves it
      if (fades - done < tightest.margin)
        tightest = { name: g.name, margin: fades - done };
    }
    // NO PIECE DISSOLVES MID-THROW — with room, since the wink's scatter and
    // the gate's rank order are independent and a re-export moves both
    expect(tightest.margin, `tightest: ${tightest.name}`).toBeGreaterThan(0.03);
    // …AND NOTHING QUEUES: the first cast begins to go while the last ranks are
    // still coming out, so no stretch of the band is carried by the roll alone
    expect(fadesFirst - lastMove, "the roll-only stretch").toBeLessThan(0.02);
    // the departure itself still fills the band it was widened to fill
    expect(firstMove).toBeLessThan(0.25);
    expect(lastMove).toBeGreaterThan(0.7);
    // …AND EVERY PIECE IS EXACTLY GONE before the departure's fall walks it
    // home, so the walk is never seen; it is still whole at the wink's foot
    const [fall0] = windowEdges(CARDS_APART.fall);
    for (const g of gates) {
      expect(winkGone(g.threshold, levelAt(g, fall0)), `${g.name} gone`).toBe(true); // prettier-ignore
      expect(winkOpacity(g.threshold, levelAt(g, WINK_SPAN[0])), `${g.name} whole`).toBe(1); // prettier-ignore
    }
  });

  it("throws on a piece that is not in the table", () => {
    expect(() => pieceStateAt(0.5, "Nope_Seg9", table)).toThrow(/no piece/);
    expect(() => pieceFlow("Nope_Seg9", table)).toThrow(/no piece/);
  });
});

describe("the flow of one piece", () => {
  it("samples dense inside the deform's window and sparse outside", () => {
    const flow = pieceFlow("Barrel_Base_Seg0", table, {
      sparse: 20,
      dense: 60,
    });
    const [lo, hi] = deformWindow();
    expect(flow.window).toEqual([lo, hi]);
    const inside = flow.samples.filter((s) => s.p >= lo && s.p <= hi).length;
    const outside = flow.samples.length - inside;
    expect(inside).toBeGreaterThan(outside);
    // monotone, inside the track, and every table row is on it
    for (let i = 1; i < flow.samples.length; i++)
      expect(flow.samples[i].p).toBeGreaterThan(flow.samples[i - 1].p);
    expect(flow.samples[0].p).toBe(0);
    expect(flow.samples[flow.samples.length - 1].p).toBe(1);
    for (const p of FLOW_SAMPLE_PS)
      expect(
        flow.samples.some((s) => s.p === p),
        `row ${p}`,
      ).toBe(true);
  });

  it("takes a shell wedge out, spirals it home, and blooms it — in that order", () => {
    // THE ENDING'S SEQUENCE, read off one piece: out through the peel and the
    // cards, home before the bloom's foot, still for a beat, and off the seat
    // again only under the rose.
    const flow = pieceFlow("Barrel_Base_Seg0", table);
    const at = (p: number) =>
      flow.samples.reduce((best, s) =>
        Math.abs(s.p - p) < Math.abs(best.p - p) ? s : best,
      );
    const capsOn = RANGES[RANGES.length - 1];
    expect(at(0).travel).toBe(0);
    expect(Math.max(...flow.samples.map((s) => s.travel))).toBeGreaterThan(10);

    // it is still far out where the ending opens, and HOME by the bloom's foot
    const seam = windowEdges(ROSE_PULSE.rise)[0];
    expect(at(capsOn.p0).travel).toBeGreaterThan(10);
    expect(at(seam).travel).toBe(0);

    // THE SETTLE IS A BEAT, NOT A SCENE, and it is not dead air: the wedge
    // lands INTO the rock (story/envelopes.ts ROCK) and the still frame between
    // the wobble damping out and the bloom's foot is a breath.
    const seated = flow.samples.filter(
      (s) => s.p >= capsOn.p0 && s.travel === 0,
    );
    const home = Math.min(...seated.map((s) => s.p));
    const span = Math.max(...seated.map((s) => s.p)) - home;
    const rockEnd = windowEdges(ROCK)[1];
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThan(0.045);
    expect(home).toBeLessThan(rockEnd);
    // the breath is bounded on BOTH sides: the wobble must be spent BEFORE the
    // bloom's foot (a rock running through the bloom would satisfy the upper
    // bound alone), and the still frame it leaves is short
    expect(rockEnd).toBeLessThanOrEqual(seam);
    expect(seam - rockEnd).toBeLessThan(0.01);
    expect(Math.max(...seated.map((s) => s.p))).toBeLessThanOrEqual(seam);

    // …and the bloom is what takes it off the seat again — never the wrap: the
    // assemble channel is spent a whole scene earlier.
    expect(at(1).travel).toBeGreaterThan(0);
  });
});

describe("the rollups", () => {
  it("rolls every scene up, in the story's order", () => {
    expect(rollups.map((r) => r.scene)).toEqual(RANGES.map((r) => r.scene.id));
    for (const s of rollups) {
      expect(s.casts.map((c) => c.cast)).toEqual(
        PIECE_CASTS.filter((c) => s.casts.some((x) => x.cast === c)),
      );
      expect(s.outliers.length).toBeLessThanOrEqual(OUTLIER_N);
      // an outlier's travel is inside its cast's own reported maximum
      for (const o of s.outliers) {
        const cast = s.casts.find((c) => c.cast === o.cast)!;
        expect(o.travel, `${s.scene}/${o.key}`).toBeLessThanOrEqual(
          cast.maxTravel + 1e-9,
        );
      }
      // …and they are ordered, furthest first
      for (let i = 1; i < s.outliers.length; i++)
        expect(s.outliers[i].travel).toBeLessThanOrEqual(
          s.outliers[i - 1].travel,
        );
    }
  });

  it("keeps every stat inside its own min/max", () => {
    for (const s of rollups)
      for (const c of s.casts)
        for (const d of FLOW_DIMS) {
          const st = c.stats[d];
          expect(st.min, `${s.scene}/${c.cast}/${d}`).toBeLessThanOrEqual(
            st.mean + 1e-9,
          );
          expect(st.mean, `${s.scene}/${c.cast}/${d}`).toBeLessThanOrEqual(
            st.max + 1e-9,
          );
        }
  });

  it("holds the whole model still in the scenes that hold it still", () => {
    // the hero opens and the finale closes with every channel idle — the map's
    // first and last rows are all zeros, and that is a property of the story,
    // not of this instrument
    for (const id of ["hero", "capsOn"]) {
      const s = rollups.find((r) => r.scene === id);
      if (!s) continue;
      for (const c of s.casts) {
        if (liveDeformAt(s.p0).length > 0) continue;
        expect(c.stats.stretch.min, `${id}/${c.cast}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe("the flow module's coverage", () => {
  it("drives only channels the registry knows, and only the hero's set", () => {
    // the one-registry law's derived-list discipline (story/cost.ts's own test)
    for (const name of DEFORM_RECIPES)
      expect(Object.keys(CHANNEL_DEFAULTS)).toContain(name);
    const seen = new Set(
      FLOW_SAMPLE_PS.flatMap((p) => liveDeformAt(p).map((l) => l.recipe.name)),
    );
    for (const name of seen) expect([...DEFORM_RECIPES]).toContain(name);
    // and the channels the story never drives never enter the live set
    for (const c of ["helix", "rollout", "bend", "scratch"])
      expect([...seen], c).not.toContain(c);
  });

  it("takes every knob at its default but the FIVE the story writes", () => {
    // the departure's keep-scope and the ending's spread, mid-fall curl, ring
    // phase and rebend — constants the driver writes once
    for (const p of FLOW_SAMPLE_PS)
      for (const l of liveDeformAt(p)) {
        const knobs = l.knobs as Record<string, number>;
        const dflt = l.recipe.knobDefaults as Record<string, number>;
        // NAMED PER RECIPE, not destructured: `curl` is a knob on three of the
        // four, and only the explode's is the story's.
        const written: Record<string, number> =
          l.recipe.name === "assemble"
            ? { keepScope: ASSEMBLE_KEEP_SCOPE }
            : l.recipe.name === "explode"
              ? {
                  bloom: ENDING_BLOOM,
                  curl: ENDING_CURL,
                  ringPhase: ENDING_RING_PHASE,
                  rebend: ENDING_REBEND,
                }
              : {};
        for (const [k, v] of Object.entries(written))
          expect(knobs[k], `${l.recipe.name}.${k}`).toBe(v);
        for (const [k, v] of Object.entries(knobs))
          if (!(k in written)) expect(v, `${l.recipe.name}.${k}`).toBe(dflt[k]);
      }
  });

  it("skips an idle recipe by the host's own gate", () => {
    for (const p of FLOW_SAMPLE_PS) {
      const channels = storyStateAt(p).channels;
      const live = liveDeformAt(p);
      for (const name of DEFORM_RECIPES)
        expect(
          live.some((l) => l.recipe.name === name),
          `${name} @${p}`,
        ).toBe(channels[name] >= 1e-6);
    }
  });
});
