import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three/webgpu";
import { NUM } from "../../ops/algebra";
import { IDLE_EPS, lanesAt, pieceField, type LiveRecipe, type PieceLanes } from "../../ops/cpu"; // prettier-ignore
import { shippedModel } from "./shipped-model";
import {
  HALF,
  PIECES,
  PROBES,
  type Piece,
} from "../../ops/__tests__/fixture";
import { lin } from "./fake-scene";
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
  ENDING_BLOOM,
  interiorFadeAt,
  shellFadeAt,
  STORY_KNOBS,
} from "../envelopes";
import {
  makeWinkScatter,
  packWink,
  unpackWink,
  winkGone,
  winkOpacity,
} from "../../core/visibility";
import { isPeelKeep } from "../../core/parts";
import { frameOf, wrapPi } from "../../ops/frames";
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
import { asTable } from "./md-table";

// Renders src/lib/lens/PIECE-FLOW.md from story/flow.ts over the shipped GLB.
// The test checks the map's shape and coverage, not its bytes. Regenerate with:
//   LENS_PIECE_FLOW=1 npx vitest run src/lib/lens/story/__tests__/piece-flow.test.ts

const MAP_URL = new URL("../../PIECE-FLOW.md", import.meta.url);

const root = shippedModel();
const table: PieceTable = buildPieceTable(root);
const rollups: SceneFlow[] = flowRollups(table);

// ── the renderer ────────────────────────────────────────────────────────────

/** fixed decimals, printing -0 as 0 */
const fx = (v: number, d: number): string => {
  const s = v.toFixed(d);
  return s === `-${(0).toFixed(d)}` ? (0).toFixed(d) : s;
};

/** decimal places per dimension: radians 3, millimetres 2, ratios 4 */
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
Regenerate (an on-demand instrument — the test checks shape, not bytes):

    LENS_PIECE_FLOW=1 npx vitest run src/lib/lens/story/__tests__/piece-flow.test.ts

**Roster.** \`lens_web_segmented.glb\` — ${meshes} mesh nodes, ${table.pieces.length} pieces (one per distinct \`_op*\` lane tuple; an adopted feature framed island by island can give a mesh several). By cast: ${roster}. Casts are core/visibility.ts's wink bands.

**Deform set.** The hero pins \`${DEFORM_RECIPES.join(" / ")}\`; knobs rest at \`knobDefaults\` except \`assemble.keepScope\` and explode's \`bloom\`, \`curl\`, \`ringPhase\` and \`rebend\` (story/envelopes.ts). Nothing moves outside p ∈ [${w0.toFixed(4)}, ${w1.toFixed(4)}]; every piece is on its seat there.

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
  // LENS_PIECE_FLOW=1 rewrites the map; otherwise only its shape is checked
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
    for (const id of [...RANGES.map((r) => r.scene.id), ...PIECE_CASTS])
      expect(current).toMatch(new RegExp(`\\b${id}\\b`));
  });

  it("is a pure function of (p, piece, table)", () => {
    for (const p of [0, 0.31, 0.62, 0.93, 1])
      for (const key of ["Barrel_Base_Seg0", "Element_01", "Iris_Blade_01"])
        expect(pieceStateAt(p, key, table)).toEqual(
          pieceStateAt(p, key, table),
        );
  });

  it("throws on a piece that is not in the table", () => {
    expect(() => pieceStateAt(0.5, "Nope_Seg9", table)).toThrow(/no piece/);
    expect(() => pieceFlow("Nope_Seg9", table)).toThrow(/no piece/);
  });
});

// ── the roster is the deform's own ──────────────────────────────────────────

describe("the piece table is the model's derived frames", () => {
  it("frames every mesh node and cuts one piece per distinct lane tuple", () => {
    // counts are distinct frames, not islands: islands adopted onto the same
    // wedge share its frame
    expect(new Set(table.pieces.map((r) => r.name)).size).toBe(194);
    expect(table.pieces).toHaveLength(207);
    expect(table.byKey.size).toBe(table.pieces.length); // every key is unique
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
    // the accessories are not the body's pieces
    expect(table.pieces.filter((r) => r.name.startsWith("Acc_"))).toEqual([]);
  });

  it("reads the ranks core/parts.ts quotes off the LIVE model", () => {
    const rank = (key: string) => table.byKey.get(key)!.lanes.rank01;
    expect(rank("Chassis_Fixed_Seg0")).toBeCloseTo(0.9377, 4);
    const cam = [0, 1, 2, 3, 4, 5, 6].map((i) => rank(`Cam_Barrel_Seg${i}`));
    expect(Math.min(...cam)).toBeCloseTo(0.8927, 4);
    expect(Math.max(...cam)).toBeCloseTo(0.919, 4);
    // every frame is sane: R above the floor, a real span, a finite axial band
    for (const { key, lanes: l } of table.pieces) {
      expect(l.R, key).toBeGreaterThanOrEqual(0.5);
      expect(l.halfSpan, key).toBeGreaterThan(0);
      expect(Number.isFinite(l.yMin) && Number.isFinite(l.yMax), key).toBe(true); // prettier-ignore
      expect(l.yMax, key).toBeGreaterThanOrEqual(l.yMin);
    }
  });

  it("classes every piece into exactly one cast", () => {
    for (const r of table.pieces) expect(r.cast).toBe(castOf(r.name));
    const count = (c: string) => table.pieces.filter((r) => r.cast === c).length; // prettier-ignore
    for (const c of PIECE_CASTS) expect(count(c), c).toBeGreaterThan(0);
    expect(count("elements")).toBe(13);
    expect(table.pieces.filter((r) => /_Seg\d+$/.test(r.name))).toHaveLength(143); // prettier-ignore
  });
});

// ── the probes ride the goldens' path ───────────────────────────────────────

describe("the pipeline under the probes is the goldens' pipeline", () => {
  // Recipe-golden rows must be reproducible through `pieceField`, on the
  // goldens' pieces and probes: yMin/yMax ∓20 (so y = 40·yN), structure class;
  // a probe is the seated vertex at phi = halfSpan·(1 − 2·frac), radius R+off.
  const RECIPES = makeRecipes(NUM);
  const lanesOf = (p: Piece): PieceLanes => ({ ...p, halfSpan: HALF, partClass: 0, axi: 0, yMin: -20, yMax: 20, depth: 0, adopted: 0, wink: -1 }); // prettier-ignore
  const [P0, , P2] = PIECES.map(lanesOf);
  const [PR0, , PR2, , PR4] = PROBES;
  const ASM: [number, number, number] = [-2.645185686121488, 66.50099716874665, -1.3]; // prettier-ignore

  // prettier-ignore
  it.each([
    ["explode", P0, PR0, 0.25, [0.7, 10, -20]],
    ["explode", P0, PR0, 0.5, [0.7, 10, -20]],
    ["explode", P0, PR0, 0.75, [0.7, 10, -20]],
    ["explode", P0, PR0, 1, [-0.8393314555380286, 18.622324745329713, 81]],
    ["assemble", P2, PR2, 0.25, [-2.380550661654163, 59.94469078376348, -1.267620924078974]],
    ["assemble", P2, PR2, 0.5, ASM],
    ["assemble", P2, PR2, 0.75, ASM],
    ["assemble", P2, PR2, 1, ASM],
    ["peel", P2, PR4, 1, [-1.0059758433139938, 33.62760686649838, 20]],
  ] as const)("reproduces %s's pinned row %#", (name, lanes, { frac, yN, off }, channel, g) => {
    const recipe = RECIPES[name];
    const live = [{ recipe, channel, knobs: recipe.knobDefaults }] as LiveRecipe[];
    // the golden row's (theta, radius, axial) at one probe, through pieceField
    const theta0 = lanes.t0 + HALF * (1 - 2 * frac);
    const r = lanes.R + off;
    const q = [r * Math.cos(theta0), yN * 40, r * Math.sin(theta0)];
    const d = pieceField(lanes, live)(q[0], q[1], q[2], [0, 0, 0]);
    const [x, y, z] = [q[0] + d[0], q[1] + d[1], q[2] + d[2]];
    expect(Math.atan2(z, x), "theta").toBeCloseTo(wrapPi(g[0]), 9);
    expect(Math.hypot(x, z), "radius").toBeCloseTo(g[1], 9);
    expect(y, "axial").toBeCloseTo(g[2], 9);
  });
});

const TAU = Math.PI * 2;

/** Whether ops/house.ts `sheetTerm` treats the piece as a sheet. */
function sheetLike(l: PieceLanes): boolean {
  const ctx: OpCtx<number> = { A: NUM, t0: l.t0, R: l.R, rank01: l.rank01, layerPhase: l.layerPhase, halfSpan: l.halfSpan, partClass: l.partClass, phi: 0, d: 0, L: 0, yN: 0, off: 0, height: 1, rung: l.rung, axi: l.axi, depth: l.depth, adopted: l.adopted, channel: 0, gateAt: () => ({ flight: 0, stick: 0 }), flight: 0, stick: 0, wrapDir: WRAP_DIR }; // prettier-ignore
  return sheetTerm(NUM, ctx) === 1;
}

/** `live` with explode's knobs overridden */
const withExplode = (live: LiveRecipe[], knobs: Record<string, number>) =>
  live.map((l) =>
    l.recipe.name === "explode" ? { ...l, knobs: { ...l.knobs, ...knobs } } : l,
  );

/** the piece's seat point: its meridian, at its radius, mid-band */
const seatOf = (l: PieceLanes): [number, number, number] => [
  l.R * Math.cos(l.t0),
  (l.yMin + l.yMax) / 2,
  l.R * Math.sin(l.t0),
];

/** the field's displacement of the piece's seat point */
const seatMove = (l: PieceLanes, live: LiveRecipe[]) => {
  const q = seatOf(l);
  return pieceField(l, live)(q[0], q[1], q[2], [0, 0, 0]);
};

/** every piece's state at every grid row */
const GRID = FLOW_SAMPLE_PS.map((p) => {
  const live = liveDeformAt(p);
  return {
    p,
    states: table.pieces.map((r) => pieceStateAt(p, r.key, table, live)),
  };
});

// ── the laws ────────────────────────────────────────────────────────────────

describe("the state at rest, and the state's own algebra", () => {
  it("puts every piece EXACTLY on its seat where no channel is live", () => {
    // outside the deform window nothing is live, so nothing moves at all
    const [lo, hi] = deformWindow();
    const outside = [0, lo - 1e-4, hi + 1e-4, 1].filter(
      (p) => p >= 0 && p <= 1 && liveDeformAt(p).length === 0,
    );
    expect(outside.length, "the track has rest on both sides").toBeGreaterThan(1); // prettier-ignore
    const rest = { dTheta: 0, dRadius: 0, dAxial: 0, travel: 0, roll: 0, bend: 0, stretch: 1, stretchAxial: 1 }; // prettier-ignore
    for (const p of outside)
      for (const row of table.pieces) {
        const s = pieceStateAt(p, row.key, table);
        const got = Object.fromEntries(Object.keys(rest).map((k) => [k, s[k as keyof typeof rest]])); // prettier-ignore
        expect(got, `${row.key} @${p}`).toEqual(rest);
      }
  });

  it("reports the seat itself as the piece's own frame, axially at the midpoint of its two ends", () => {
    // at rest the measured frame matches the lanes, up to atan2/hypot rounding
    for (const { key, lanes: l } of table.pieces) {
      const s = pieceStateAt(0, key, table);
      expect(s.radius, key).toBeCloseTo(l.R, 4);
      expect(s.axial, key).toBeCloseTo((l.yMin + l.yMax) * 0.5, 9);
      expect(Math.cos(s.theta - l.t0), key).toBeCloseTo(1, 9);
    }
  });

  it("never reports a non-finite reading anywhere on the grid", () => {
    for (const { p, states } of GRID)
      for (const [i, s] of states.entries()) {
        const at = `${table.pieces[i].key} @${p}`;
        for (const [k, v] of Object.entries(s))
          if (typeof v === "number")
            expect(Number.isFinite(v), `${at} ${k}`).toBe(true);
        expect(s.stretch, `${at} stretch`).toBeGreaterThan(0);
        expect(s.stretchAxial, `${at} stretchAxial`).toBeGreaterThan(0);
        // a rotation angle, bounded on both sides
        expect(s.bend, `${at} bend`).toBeGreaterThanOrEqual(0);
        expect(s.bend, `${at} bend`).toBeLessThanOrEqual(Math.PI);
        expect(Math.abs(s.dTheta), `${at} dTheta`).toBeLessThanOrEqual(Math.PI);
      }
  });

  it("measures the piece's two AXIAL ENDS, not one median plane", () => {
    // probes on one median plane would always read bend 0 and stretchAxial 1
    const all = GRID.flatMap((g) => g.states);
    expect(all.some((s) => s.bend > 1e-3), "the ops turn one end against the other").toBe(true); // prettier-ignore
    expect(all.some((s) => Math.abs(s.stretchAxial - 1) > 1e-3), "the ops stretch along the bore").toBe(true); // prettier-ignore
    // curl is a separate reading: somewhere it is large while bend is exactly 0
    const flat = Math.max(...all.filter((s) => s.bend === 0).map((s) => Math.abs(s.curl))); // prettier-ignore
    expect(flat, "curl without bend").toBeGreaterThan(0.5);
  });

  it("reports no circumferential stretch for a body of revolution", () => {
    // axisymmetric pieces report a flat 1 ("not measured")
    const axi = table.pieces.flatMap((r, i) => (r.lanes.axi >= 0.5 ? [i] : []));
    expect(axi.map((i) => table.pieces[i].key).sort()).toEqual([
      "Cam_Followers",
      ...Array.from({ length: 13 }, (_, i) => `Element_${String(i + 1).padStart(2, "0")}`), // prettier-ignore
      "Iris_ActuatorGear",
    ]);
    for (const { p, states } of GRID)
      for (const i of axi)
        expect(states[i].stretch, `${table.pieces[i].key} @${p}`).toBe(1);
    // a piece with a measured span does report a stretch
    const peel = RANGES[2];
    const worst = Math.min(
      ...lin(peel.p0, peel.p1, 40).map(
        (q) => pieceStateAt(q, "Ring_Focus_Seg4", table).stretch,
      ),
    );
    expect(worst).toBeLessThan(0.95);
    expect(worst).toBeGreaterThan(0.5);
  });

  const ALL = makeRecipes(NUM);

  it("PARKS THE PIECES IN A SCATTERED CLOUD — not a tower, not a ring", () => {
    // the ending's parked pose (channel 1): lifted up and pushed sideways
    const live = [
      { recipe: ALL.explode, channel: 1, knobs: ALL.explode.knobDefaults },
    ];
    const moves = table.pieces.map((r) => seatMove(r.lanes, live));
    const up = moves.map((d) => d[1]);
    const lat = moves.map((d) => Math.hypot(d[0], d[2]));
    const ratio = lat.map((v, i) => v / up[i]);
    const med = (xs: number[]) =>
      [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    // every piece is held clear of its seat…
    expect(Math.min(...up), "the lowest piece still hovers").toBeGreaterThan(30); // prettier-ignore
    // …a typical one well off to the side…
    expect(med(lat), "the cloud is dispersed").toBeGreaterThan(20);
    expect(med(ratio), "…and visibly so").toBeGreaterThan(0.1);
    // …but the rise dominates, so the cloud sits above the lens
    expect(Math.max(...ratio), "up beats lateral, everywhere").toBeLessThan(1);
    // only glass and the iris stay on their seat axis (selNotOptical)
    const flat = table.pieces.filter((_, i) => lat[i] === 0).map((r) => r.lanes.partClass); // prettier-ignore
    expect([...new Set(flat)].sort()).toEqual([PART_CLASS.glass, PART_CLASS.iris]); // prettier-ignore
    expect(flat).toHaveLength(28);
  });

  it("PARKS RIGID: no piece is bent, stretched or turned out of its arc", () => {
    // With rebend 0, the park and the seated pose are rigid to 9 dp; mid-fall
    // only the girth (the curl) may change. Checked up to the bloom's foot.
    const noRebend = (live: LiveRecipe[]) => withExplode(live, { rebend: 0 });
    for (const f of [0, 0.15, 0.3, 0.5, 0.64, 0.7]) {
      const p = atFrac(rangeOf("capsOn"), f);
      const live = noRebend(liveDeformAt(p));
      const inFlight = f > 0 && f < 0.64;
      for (const row of table.pieces) {
        const st = pieceStateAt(p, row.key, table, live);
        const at = `${row.key} at capsOn ${f}`;
        expect(st.stretch, `${at} girth`).toBeCloseTo(1, inFlight ? 1 : 9);
        expect(st.stretchAxial, `${at} length`).toBeCloseTo(1, 9);
        expect(st.bend, `${at} bend`).toBeCloseTo(0, 9);
        expect(st.roll, `${at} roll`).toBeCloseTo(0, 9);
        if (!inFlight) expect(st.curl, `${at} curl`).toBeCloseTo(0, 9);
      }
    }

    // With rebend on, the park differs only in curl and girth, and only for
    // pieces thinner than DEPTH_THIN; deeper sheet-like pieces slide rigid.
    const park = atFrac(rangeOf("capsOn"), 0);
    const on = liveDeformAt(park);
    const off = noRebend(on);
    let bent = 0;
    let rigidSheets = 0;
    for (const row of table.pieces) {
      const a = pieceStateAt(park, row.key, table, on);
      const b = pieceStateAt(park, row.key, table, off);
      for (const k of [
        "dRadius",
        "dTheta",
        "stretchAxial",
        "bend",
        "roll",
      ] as const)
        // prettier-ignore
        expect(a[k], `${row.key} ${k}`).toBeCloseTo(b[k], 9);
      const thin = row.lanes.depth < DEPTH_THIN;
      const at = `${row.key} depth ${row.lanes.depth}`;
      if (Math.abs(a.curl - b.curl) < 1e-9) {
        expect(a.stretch, `${row.key} girth`).toBeCloseTo(b.stretch, 9);
        // a sheet-like piece that did not bend is a deep one
        if (sheetLike(row.lanes)) {
          expect(thin, `${at} did not bend`).toBe(false);
          rigidSheets++;
        }
        continue;
      }
      bent++;
      expect(thin, `${at} bent`).toBe(true);
      expect(a.curl, `${row.key} opens`).toBeLessThan(b.curl);
      expect(a.stretch, `${row.key} chord`).toBeGreaterThanOrEqual(b.stretch - 1e-9); // prettier-ignore
      expect(a.stretch, `${row.key} chord bound`).toBeLessThan(1.06);
    }
    expect(bent, "thin shells bent to their ring").toBeGreaterThan(100);
    expect(rigidSheets, "deep sheets slid rigid").toBeGreaterThan(20);

    // wall strain: girth of the inner and outer surfaces, deformed over seated
    let worstThin = 1;
    for (const { key, lanes: l } of table.pieces) {
      if (l.axi >= 0.5) continue;
      const ratio = wallGirth(l, on);
      if (l.depth >= DEPTH_THIN)
        expect(ratio, `${key} wall girth`).toBeLessThanOrEqual(1.05);
      else worstThin = Math.max(worstThin, ratio);
    }
    expect(worstThin, "the thin cast's worst wall strain").toBeLessThan(1.35);
  });

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
    // A wedge opens as it leaves the park and closes as it lands; with and
    // without the curl the field is bit-identical at the park and at the seat.
    let parkDiff = 0;
    let seatDiff = 0;
    let seated = 0;
    let deepest = 0;
    /** the curl knob's own contribution beyond the curl-free build */
    let knobDeepest = 0;
    for (const f of lin(0, 1, 40)) {
      const p = atFrac(rangeOf("capsOn"), f);
      const live = liveDeformAt(p);
      const bare = withExplode(live, { curl: 0 });
      for (const row of table.pieces) {
        const a = seatMove(row.lanes, live);
        const b = seatMove(row.lanes, bare);
        const same = a.every((v, k) => Object.is(v, b[k]));
        if (f === 0 && !same) parkDiff++;
        // "seated" is judged on the curl-free build
        const bareSt = pieceStateAt(p, row.key, table, bare);
        if (f > 0 && bareSt.travel === 0) {
          seated++;
          if (!same) seatDiff++;
        }
        // the fall only; the bloom past 0.72 is the rose's fold
        if (f <= 0.6) {
          const curl = pieceStateAt(p, row.key, table, live).curl;
          deepest = Math.min(deepest, curl);
          knobDeepest = Math.min(knobDeepest, curl - bareSt.curl);
        }
      }
    }
    expect(parkDiff, "pieces the curl moves at the park").toBe(0);
    expect(seated, "seated (piece, sample) pairs checked").toBeGreaterThan(2000); // prettier-ignore
    expect(seatDiff, "pieces the curl moves at their seat").toBe(0);
    // in between the wedge opens (curl < 0)
    expect(deepest, "how far open the fall gets").toBeLessThan(-0.1);
    // and the curl knob accounts for a real share of that
    expect(knobDeepest, "the curl knob's own opening").toBeLessThan(-0.05);
  });

  it("PARKS EVEN: one ring, one radius, one angle for every piece on it", () => {
    // At the park every opened piece sits at exactly (1 + bloom) × its seat
    // radius, and every ring (a `<Part>_SegN` family) shares one turn.
    const park = rangeOf("capsOn").p0;
    const live = liveDeformAt(park);
    let opened = 0;
    let still = 0;
    const turns = new Map<string, number>();
    for (const row of table.pieces) {
      const st = pieceStateAt(park, row.key, table, live);
      // checked before the exemption below: bodies of revolution still turn
      const ring = row.name.replace(/_Seg\d+$/, "");
      const seen = turns.get(ring);
      if (seen === undefined) turns.set(ring, st.dTheta);
      else expect(st.dTheta, `${row.key} turn`).toBeCloseTo(seen, 9);
      // the optical column and bodies of revolution stay on the axis
      if (Math.abs(st.dRadius) < 1e-6) {
        still++;
        continue;
      }
      opened++;
      expect(st.radius / (st.radius - st.dRadius), `${row.key} radius`) //
        .toBeCloseTo(1 + ENDING_BLOOM, 9);
    }
    expect(opened, "pieces opened onto their ring").toBeGreaterThan(150);
    expect(still, "pieces held on the axis").toBeGreaterThan(20);
    // different rings turn by different amounts, spread round the bore
    const spread = [...turns.values()].filter((t) => t !== 0);
    expect(new Set(spread.map((t) => t.toFixed(6))).size, "distinct ring turns") //
      .toBeGreaterThan(15);
    expect(Math.max(...spread) - Math.min(...spread), "spread round the bore") //
      .toBeGreaterThan(4);
  });

  it("PARKS AS BROKEN CONCENTRIC CIRCLES — no arms", () => {
    // Seen down the bore, every shell is cut on the same meridians, so without
    // the ring phase the gaps line up into arms: a strong angular harmonic.
    const live = liveDeformAt(rangeOf("capsOn").p0);
    const BINS = 360;
    /** the strongest angular harmonic of the coverage, as a share of its mean */
    const arms = (set: LiveRecipe[]): { peak: number; at: number } => {
      const seen = Array.from({ length: BINS }, () => new Set<number>());
      for (const { lanes: l } of table.pieces) {
        const field = pieceField(l, set);
        const y = (l.yMin + l.yMax) / 2;
        for (let i = 0; i <= 24; i++) {
          const th = l.t0 + l.halfSpan * (i / 12 - 1);
          const q = [l.R * Math.cos(th), y, l.R * Math.sin(th)] as const;
          const d = field(q[0], q[1], q[2], [0, 0, 0]);
          const [x, z] = [q[0] + d[0], q[2] + d[2]];
          const r = Math.hypot(x, z);
          // only pieces opened onto a ring
          if (r < 1.5 * l.R) continue;
          const b = Math.round((Math.atan2(z, x) / TAU) * BINS);
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
          const a = (TAU * m * i) / BINS;
          re += v * Math.cos(a);
          im += v * Math.sin(a);
        });
        const amp = (2 * Math.hypot(re, im)) / BINS / mean;
        if (amp > peak) [peak, at] = [amp, m];
      }
      return { peak, at };
    };
    // without the ring phase: five arms, one per cut
    const off = arms(withExplode(live, { ringPhase: 0 }));
    expect(off.at, "the arm count is the cut count").toBe(5);
    expect(off.peak, "the pinwheel").toBeGreaterThan(0.9);
    // with it: no arms at any count
    expect(arms(live).peak, "arms with the ring phase").toBeLessThan(0.35);
  });

  it("DISPERSES IN FLIGHT — the evenness is the POSE's, not the motion's", () => {
    // a ring that is one circle at the park is scattered mid-fall
    const capR = rangeOf("capsOn");
    const ring = table.pieces.filter((r) => /^Barrel_Inner_Seg\d$/.test(r.key));
    expect(ring).toHaveLength(5);
    const spreadAt = (p: number) => {
      const live = liveDeformAt(p);
      const st = ring.map((r) => pieceStateAt(p, r.key, table, live));
      // opening relative to each piece's own seat radius
      const rad = st.map((s) => s.dRadius / (s.radius - s.dRadius));
      const th = st.map((s) => s.dTheta);
      return {
        radius: Math.max(...rad) - Math.min(...rad),
        theta: Math.max(...th) - Math.min(...th),
      };
    };
    // worst spread anywhere on the way down
    const fall = lin(0, 1, 60).map((f) => spreadAt(atFrac(capR, f)));
    expect(Math.max(...fall.map((w) => w.radius)), "mid-fall radii scatter").toBeGreaterThan(0.1); // prettier-ignore
    expect(Math.max(...fall.map((w) => w.theta)), "mid-fall angular scatter").toBeGreaterThan(0.3); // prettier-ignore
    // gone once seated, before the bloom opens
    const home = spreadAt(atFrac(capR, 0.7));
    expect(home.radius).toBeCloseTo(0, 9);
    expect(home.theta).toBeCloseTo(0, 9);
  });

  it("DESCENDS INSIDE-OUT, evenly, and is home before the bloom", () => {
    // One continuous landing order: outward by rank, winding round the bore.
    const cap = RANGES[RANGES.length - 1];
    const local = (p: number) => (p - cap.p0) / (cap.p1 - cap.p0);
    const ps = lin(cap.p0, cap.p1, 200);
    const seats = table.pieces.map((row) => {
      const p = ps.find((q) => pieceStateAt(q, row.key, table).travel < 0.05);
      return { rank: row.lanes.rank01, t: p === undefined ? 1 : local(p) };
    });
    const ts = seats.map((s) => s.t).sort((a, b) => a - b);

    // evenly spaced arrivals
    let hole = 0;
    for (let i = 1; i < ts.length; i++)
      hole = Math.max(hole, ts[i] - ts[i - 1]);
    expect(hole, "the worst gap between arrivals").toBeLessThan(0.05);

    // inside-out: the median arrival per rank bin climbs
    const bins: number[][] = Array.from({ length: 10 }, () => []);
    for (const s of seats) bins[Math.min(9, Math.floor(s.rank * 10))].push(s.t);
    const meds = bins
      .filter((b) => b.length)
      .map((b) => b.sort((x, y) => x - y)[Math.floor(b.length / 2)]);
    for (let i = 1; i < meds.length; i++)
      expect(meds[i], "the build runs outward").toBeGreaterThanOrEqual(meds[i - 1]); // prettier-ignore
    expect(meds[meds.length - 1] - meds[0], "and it is a sequence").toBeGreaterThan(0.2); // prettier-ignore

    // winding: within a rank band, arrival tracks the piece's meridian
    const corr = (xs: number[], ys: number[]) => {
      const mean = (vs: number[]) => vs.reduce((a, b) => a + b, 0) / vs.length;
      const [mx, my] = [mean(xs), mean(ys)];
      const sxy = mean(xs.map((x, i) => (x - mx) * (ys[i] - my)));
      const sxx = mean(xs.map((x) => (x - mx) ** 2));
      const syy = mean(ys.map((y) => (y - my) ** 2));
      return sxy / Math.sqrt(sxx * syy);
    };
    for (const [lo, hi] of [
      [0, 0.5],
      [0.5, 0.8],
      [0.8, 0.9],
      [0.9, 1.01],
    ]) {
      const band = table.pieces
        .map((row, i) => ({ ang: row.lanes.t0 / TAU + 0.5, ...seats[i] }))
        .filter((x) => x.rank >= lo && x.rank < hi);
      expect(band.length, `band ${lo}–${hi} is populated`).toBeGreaterThan(4);
      expect(corr(band.map((b) => b.ang), band.map((b) => b.t)), `band ${lo}–${hi} winds`).toBeGreaterThan(0.4); // prettier-ignore
    }

    // …and the whole cast is seated before the bloom's foot
    expect(ts[ts.length - 1]).toBeLessThan(local(windowEdges(ROSE_PULSE.rise)[0])); // prettier-ignore
  });

  it("never moves the mechanism the cards scene REVEALS", () => {
    // every kept piece stays seated through the peel and cards scenes
    const ps = FLOW_SAMPLE_PS.filter((q) => q >= RANGES[2].p0 && q <= RANGES[3].p1); // prettier-ignore
    expect(ps.length).toBeGreaterThan(8);
    const kept = table.pieces.filter((r) => isPeelKeep(r.name));
    expect(kept.length).toBeGreaterThan(50);
    for (const row of kept)
      for (const q of ps)
        // allows float residue from the peel chain's trig
        expect(pieceStateAt(q, row.key, table).travel, `${row.key} @${q}`).toBeLessThan(1e-9); // prettier-ignore
    // while the departing layers do move
    const shell = pieceStateAt(windowEdges(CARDS_APART.rise)[1], "Barrel_Base_Seg0", table); // prettier-ignore
    expect(shell.travel).toBeGreaterThan(10);
  });

  it("NEVER TAKES A PIECE BEFORE ITS OWN FLIGHT IS OVER — and never queues behind it", () => {
    // A piece may start fading only after its own flight ends, but fading
    // must begin before the last pieces stop moving.
    const peel = RANGES[2];
    const local = (p: number) => (p - peel.p0) / (peel.p1 - peel.p0);
    const ps = lin(peel.p0, peel.p1, 400);
    // per MESH, the last sample at which any of its pieces is still travelling
    const EPS = 1e-3; // mm per step
    const doneAt = new Map<string, number>();
    let firstMove = 1;
    let lastMove = 0;
    for (const row of table.pieces) {
      const travel = ps.map((p) => pieceStateAt(p, row.key, table).travel);
      for (let i = 1; i < ps.length; i++)
        if (Math.abs(travel[i] - travel[i - 1]) > EPS) {
          doneAt.set(row.name, local(ps[i]));
          firstMove = Math.min(firstMove, local(ps[i - 1]));
          lastMove = Math.max(lastMove, local(ps[i]));
        }
    }
    expect(doneAt.size, "the departure moves a real cast").toBeGreaterThan(100);

    // each faded top-level mesh's stamped wink lane, against a fresh scatter
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
    const opacityAt = (g: (typeof gates)[number], p: number) =>
      winkOpacity(g.threshold, g.shell ? shellFadeAt(p) : interiorFadeAt(p));

    let tightest = { name: "", margin: Infinity };
    let fadesFirst = 1;
    for (const g of gates) {
      // the first sample at which the mesh is no longer whole
      const p = ps.find((q) => opacityAt(g, q) < 1);
      const fades = p === undefined ? 1 : local(p);
      fadesFirst = Math.min(fadesFirst, fades);
      const done = doneAt.get(g.name);
      if (done === undefined) continue; // the departure never moves it
      if (fades - done < tightest.margin)
        tightest = { name: g.name, margin: fades - done };
    }
    // no piece fades mid-flight, with margin
    expect(tightest.margin, `tightest: ${tightest.name}`).toBeGreaterThan(0.03);
    // fading starts before the last pieces stop moving
    expect(fadesFirst - lastMove, "the roll-only stretch").toBeLessThan(0.02);
    // the departure spans most of the peel
    expect(firstMove).toBeLessThan(0.25);
    expect(lastMove).toBeGreaterThan(0.7);
    // every piece is whole when fading starts and gone before it returns home
    const [fall0] = windowEdges(CARDS_APART.fall);
    for (const g of gates) {
      const at = g.shell ? shellFadeAt : interiorFadeAt;
      expect(winkGone(g.threshold, at(fall0)), `${g.name} gone`).toBe(true);
      expect(opacityAt(g, WINK_SPAN[0]), `${g.name} whole`).toBe(1);
    }
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
    const ps = flow.samples.map((s) => s.p);
    const inside = ps.filter((p) => p >= lo && p <= hi).length;
    expect(inside).toBeGreaterThan(ps.length - inside);
    // increasing, spans [0, 1], and includes every table row's p
    for (let i = 1; i < ps.length; i++)
      expect(ps[i]).toBeGreaterThan(ps[i - 1]);
    expect([ps[0], ps[ps.length - 1]]).toEqual([0, 1]);
    for (const p of FLOW_SAMPLE_PS) expect(ps, `row ${p}`).toContain(p);
  });

  it("takes a shell wedge out, spirals it home, and blooms it — in that order", () => {
    const flow = pieceFlow("Barrel_Base_Seg0", table);
    const at = (p: number) =>
      flow.samples.reduce((best, s) =>
        Math.abs(s.p - p) < Math.abs(best.p - p) ? s : best,
      );
    const capsOn = RANGES[RANGES.length - 1];
    expect(at(0).travel).toBe(0);
    expect(Math.max(...flow.samples.map((s) => s.travel))).toBeGreaterThan(10);

    // far out where the ending opens, home by the bloom's foot
    const seam = windowEdges(ROSE_PULSE.rise)[0];
    expect(at(capsOn.p0).travel).toBeGreaterThan(10);
    expect(at(seam).travel).toBe(0);

    // it lands during the rock, and rests only briefly before the bloom
    const seated = flow.samples
      .filter((s) => s.p >= capsOn.p0 && s.travel === 0)
      .map((s) => s.p);
    const home = Math.min(...seated);
    const last = Math.max(...seated);
    const rockEnd = windowEdges(ROCK)[1];
    expect(last - home).toBeGreaterThan(0);
    expect(last - home).toBeLessThan(0.045);
    expect(home).toBeLessThan(rockEnd);
    // the rock ends at or just before the bloom's foot
    expect(rockEnd).toBeLessThanOrEqual(seam);
    expect(seam - rockEnd).toBeLessThan(0.01);
    expect(last).toBeLessThanOrEqual(seam);

    // the bloom moves it off the seat again
    expect(at(1).travel).toBeGreaterThan(0);
  });
});

describe("the rollups", () => {
  it("rolls every scene up, in the story's order, with its outliers furthest first", () => {
    expect(rollups.map((r) => r.scene)).toEqual(RANGES.map((r) => r.scene.id));
    for (const s of rollups) {
      const casts = s.casts.map((c) => c.cast);
      expect(casts).toEqual(PIECE_CASTS.filter((c) => casts.includes(c)));
      expect(s.outliers.length).toBeLessThanOrEqual(OUTLIER_N);
      for (const [i, o] of s.outliers.entries()) {
        // an outlier's travel is inside its cast's own reported maximum
        const cast = s.casts.find((c) => c.cast === o.cast)!;
        expect(o.travel, `${s.scene}/${o.key}`).toBeLessThanOrEqual(cast.maxTravel + 1e-9); // prettier-ignore
        if (i > 0)
          expect(o.travel).toBeLessThanOrEqual(s.outliers[i - 1].travel);
      }
    }
  });

  it("keeps every stat inside its own min/max", () => {
    for (const s of rollups)
      for (const c of s.casts)
        for (const d of FLOW_DIMS) {
          const { min, mean, max } = c.stats[d];
          expect(min, `${s.scene}/${c.cast}/${d}`).toBeLessThanOrEqual(mean + 1e-9); // prettier-ignore
          expect(mean, `${s.scene}/${c.cast}/${d}`).toBeLessThanOrEqual(max + 1e-9); // prettier-ignore
        }
  });

  it("holds the whole model still in the hero", () => {
    const hero = rollups.find((r) => r.scene === "hero")!;
    for (const c of hero.casts) {
      expect(c.maxTravel, c.cast).toBe(0);
      expect(c.stats.stretch.min, c.cast).toBe(1);
      expect(c.stats.stretch.max, c.cast).toBe(1);
    }
  });
});

describe("the flow module's coverage", () => {
  it("drives only the hero's recipes, each by the host's own idle gate", () => {
    for (const name of DEFORM_RECIPES)
      expect(Object.keys(CHANNEL_DEFAULTS)).toContain(name);
    for (const p of FLOW_SAMPLE_PS) {
      const channels = storyStateAt(p).channels;
      const live = liveDeformAt(p).map((l) => l.recipe.name);
      // channels the story never drives stay out of the live set
      for (const name of live) expect([...DEFORM_RECIPES]).toContain(name);
      for (const c of ["helix", "rollout", "bend", "scratch"])
        expect(live, c).not.toContain(c);
      for (const name of DEFORM_RECIPES)
        expect(live.includes(name), `${name} @${p}`).toBe(channels[name] >= 1e-6); // prettier-ignore
    }
  });

  it("takes every knob at its default but the ones STORY_KNOBS writes", () => {
    // per recipe, since several recipes have a `curl` knob
    for (const p of FLOW_SAMPLE_PS)
      for (const l of liveDeformAt(p)) {
        const knobs = l.knobs as Record<string, number>;
        const dflt = l.recipe.knobDefaults as Record<string, number>;
        const written: Record<string, number> =
          STORY_KNOBS[l.recipe.name] ?? {};
        for (const [k, v] of Object.entries(knobs))
          expect(v, `${l.recipe.name}.${k}`).toBe(written[k] ?? dflt[k]);
        for (const k of Object.keys(written))
          expect(knobs, `${l.recipe.name}.${k}`).toHaveProperty(k);
      }
  });
});

// ── the girth law, on the shipped vertices ──────────────────────────────────
// Pairwise vertex distance ratios, deformed over seated: rigid pieces keep 1;
// rolled sheets may stretch far pairs but not near ones (≤ 3 mm).

describe("the girth law on the shipped vertices", () => {
  interface Body {
    key: string;
    lanes: PieceLanes;
    verts: [number, number, number][];
  }
  const bodies: Body[] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const pos = o.geometry.getAttribute("position");
    const byKey = new Map<string, Body>();
    for (let i = 0; i < pos.count; i++) {
      const l = lanesAt(o.geometry, i);
      if (!l) return;
      const k = `${l.t0},${l.R},${l.rank01},${l.layerPhase},${l.rung},${l.yMin},${l.depth},${l.adopted}`;
      let b = byKey.get(k);
      if (!b) {
        b = { key: byKey.size ? `${o.name}#${byKey.size}` : o.name, lanes: l, verts: [] }; // prettier-ignore
        byKey.set(k, b);
      }
      b.verts.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
    }
    bodies.push(...byKey.values());
  });
  const family = (key: string) => key.replace(/(_Seg\d+)?(#\d+)?$/, "");
  /** deep, sheet-like bodies, which must slide rigid */
  const deepSheet = (l: PieceLanes) => l.depth >= DEPTH_THIN && sheetLike(l);

  /** worst pair ratio over all pairs ≥ 0.5 mm apart, and over the NEAR pairs
   *  (≤ 3 mm), from up to 40 anchor vertices against every vertex */
  function girth(b: Body, live: LiveRecipe[]): { all: number; near: number } {
    const f = pieceField(b.lanes, live);
    const out: [number, number, number] = [0, 0, 0];
    const moved = b.verts.map((q) => {
      f(q[0], q[1], q[2], out);
      return [q[0] + out[0], q[1] + out[1], q[2] + out[2]];
    });
    const n = b.verts.length;
    const stride = Math.max(1, Math.floor(n / 24));
    let all = 1;
    let near = 1;
    for (let i = 0; i < n; i += stride)
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        const a = b.verts[i];
        const c = b.verts[j];
        const s = Math.hypot(a[0] - c[0], a[1] - c[1], a[2] - c[2]);
        if (s < 0.5) continue;
        const A = moved[i];
        const C = moved[j];
        const d = Math.hypot(A[0] - C[0], A[1] - C[1], A[2] - C[2]);
        const r = Math.max(d / s, s / d);
        if (r > all) all = r;
        if (s <= 3 && r > near) near = r;
      }
    return { all, near };
  }

  it("the cards departure: deep sheets slide RIGID, thin rings do not tear, nothing folds past its roll", () => {
    // the assemble channel's own window
    const on = lin(0, 1, 2000).filter(
      (p) => storyStateAt(p).channels.assemble >= IDLE_EPS,
    );
    const [p0, p1] = [on[0], on[on.length - 1]];
    expect(p1 - p0).toBeGreaterThan(0.1);
    const worst = new Map<Body, { all: number; near: number }>();
    for (const p of lin(p0, p1, 14)) {
      const live = liveDeformAt(p);
      for (const b of bodies) {
        const w = unpackWink(b.lanes.wink);
        const opacity = w ? winkOpacity(w.threshold, w.channel === "shell" ? shellFadeAt(p) : interiorFadeAt(p)) : 1; // prettier-ignore
        if (opacity < 0.5) continue;
        const g = girth(b, live);
        const was = worst.get(b) ?? { all: 1, near: 1 };
        worst.set(b, { all: Math.max(was.all, g.all), near: Math.max(was.near, g.near) }); // prettier-ignore
      }
    }
    expect(worst.size).toBeGreaterThan(150);
    let deepSheets = 0;
    for (const [b, g] of worst) {
      // deep non-kept sheets slide rigid
      if (deepSheet(b.lanes) && b.lanes.partClass !== PART_CLASS.kept) {
        expect(g.all, `${b.key} depth ${b.lanes.depth} rigid`).toBeLessThan(1 + 1e-6); // prettier-ignore
        deepSheets++;
      }
      // thin rings that are prone to tearing
      if (/^(Cell_Flange|Cell_Collar|RearTube)$/.test(family(b.key)))
        expect(g.near, `${b.key} near-pair tear`).toBeLessThan(2.2);
      // no piece folds past its roll centre or shears across a 3 mm pair
      expect(g.near, `${b.key} near-pair girth`).toBeLessThan(2.5);
    }
    for (const fam of ["Baffle_G2", "Barrel_Inner"])
      expect([...worst.keys()].filter((b) => family(b.key) === fam).length, fam).toBeGreaterThan(3); // prettier-ignore
    expect(deepSheets).toBeGreaterThan(8);
  }, 30_000);

  it("the park: adopted hardware keeps its OWN depth, so the rods and motor slide rigid", () => {
    const live = liveDeformAt(atFrac(rangeOf("capsOn"), 0));
    let hardware = 0;
    let worstThin = 1;
    for (const b of bodies) {
      const g = girth(b, live);
      if (b.lanes.adopted && b.lanes.partClass !== PART_CLASS.decal) {
        hardware++;
        expect(b.lanes.depth, `${b.key} depth`).toBeGreaterThan(DEPTH_THIN);
        expect(g.all, `${b.key} rigid`).toBeLessThan(1 + 1e-6);
      } else if (deepSheet(b.lanes)) {
        expect(g.all, `${b.key} deep sheet rigid`).toBeLessThan(1 + 1e-6);
      } else if (b.lanes.axi < 0.5) worstThin = Math.max(worstThin, g.near);
    }
    expect(hardware).toBeGreaterThan(10);
    expect(bodies.some((b) => b.key.startsWith("Focus_GuideRods"))).toBe(true);
    expect(bodies.some((b) => b.key.startsWith("Focus_Motor"))).toBe(true);
    // the thin cast's re-bend strains a near pair by at most this
    expect(worstThin).toBeLessThan(1.25);
  });
});
