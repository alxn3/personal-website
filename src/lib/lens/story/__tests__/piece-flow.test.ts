import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three/webgpu";
import { NUM } from "../../ops/algebra";
import { deriveFrames } from "../../ops/frames";
import { pieceField, type LiveRecipe } from "../../ops/cpu";
import { makeRecipes } from "../../ops/recipes";
import { CHANNEL_DEFAULTS } from "../../core/scene";
import { RANGES, windowEdges } from "../story";
import { DEFORM_RECIPES } from "../cost";
import { ROSE_PULSE } from "../envelopes";
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
// THE PIECE-FLOW MAP — src/lib/lens/PIECE-FLOW.md, rendered from story/flow.ts.
//
// A GENERATED artifact under the law STORY-MAP.md and STORY-COST.md both ship
// under: checked in so the pose and flow of every piece can be read and diffed
// without running anything, and asserted here so it can never rot. A wave that
// retunes a recipe fails this test with the new table in the diff.
//
// TO REGENERATE, after a deliberate change:
//   LENS_PIECE_FLOW=1 npx vitest run src/lib/lens/story/__tests__/piece-flow.test.ts
// and review the diff — the per-scene × per-cast rollup is the surface to read.
//
// ONE CODE PATH, AND IT IS THE SHIPPED ONE. The renderer below is pure
// presentation. Every number comes out of `pieceStateAt`, which is
// `ops/cpu.ts`'s `pieceField` — host.ts's fold preamble on the NUM backend —
// driven at `storyStateAt(p)`'s channels, over the frames `ops/frames.ts`
// derives from the SHIPPED GLB. Nothing about the model is tabulated here.
//
// THE MODEL IS READ FOR REAL. The GLB's vertices are plain float32 accessors in
// the BIN chunk, so this file slices them straight out and rebuilds the shipped
// node graph — names, parenting, transforms, positions and indices — then runs
// the real `deriveFrames` over it. That is the same measurement pass the browser
// runs at load, on the same bytes, so the roster here IS the browser's roster
// (spot-checked below against the measured ranks core/parts.ts quotes from the
// live model).
// ============================================================================

const MAP_URL = new URL("../../PIECE-FLOW.md", import.meta.url);
const MODEL = "public/models/lens_web_segmented.glb";

// ── the shipped model, read and framed in node ──────────────────────────────

interface Gltf {
  nodes: {
    name: string;
    mesh?: number;
    children?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }[];
  meshes: {
    primitives: { attributes: Record<string, number>; indices: number }[];
  }[];
  accessors: {
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    count: number;
    type: string;
  }[];
  bufferViews: {
    byteOffset?: number;
    byteLength: number;
    byteStride?: number;
  }[];
  scenes: { nodes: number[] }[];
}

/** The glTF JSON chunk and the BIN chunk of a .glb — ops/__tests__'s idiom,
 *  keeping the binary this time. */
function glb(path: string): { json: Gltf; bin: Buffer } {
  const buf = readFileSync(path);
  let off = 12;
  let json: Gltf | null = null;
  let bin: Buffer = Buffer.alloc(0);
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    const type = buf.readUInt32LE(off + 4);
    if (type === 0x4e4f534a)
      json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString("utf8"));
    if (type === 0x004e4942) bin = buf.subarray(off + 8, off + 8 + len);
    off += 8 + len;
  }
  return { json: json!, bin };
}

/** glTF `componentType` → the typed array that reads it. The shipped files use
 *  5126 for POSITION and 5123 for indices; the other two are here so a re-export
 *  that widens an index buffer past 65535 reads correctly instead of silently
 *  mis-slicing the BIN chunk. */
const COMPONENT = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
} as const;

const PER_ELEMENT: Record<string, number> = { SCALAR: 1, VEC3: 3 };

/** One accessor as a typed array over the BIN chunk. The bytes are COPIED, not
 *  viewed: a bufferView's offset in the file need not be aligned to the
 *  component size, and a misaligned typed-array view over the shared buffer
 *  throws. Interleaved bufferViews (`byteStride`) would need a strided gather
 *  and these exports are tightly packed, so that case is refused loudly. */
function accessor(json: Gltf, bin: Buffer, i: number) {
  const a = json.accessors[i];
  const bv = json.bufferViews[a.bufferView];
  const Ctor = COMPONENT[a.componentType as keyof typeof COMPONENT];
  if (!Ctor) throw new Error(`accessor ${i}: componentType ${a.componentType}`);
  if (bv.byteStride !== undefined)
    throw new Error(`accessor ${i}: interleaved bufferView is not supported`);
  const n = a.count * PER_ELEMENT[a.type];
  const at = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const bytes = new Uint8Array(
    bin.subarray(at, at + n * Ctor.BYTES_PER_ELEMENT),
  );
  return new Ctor(bytes.buffer);
}

/** The shipped node graph with REAL geometry — the browser's scene, minus the
 *  materials nothing here reads. */
function shippedModel(): THREE.Object3D {
  const { json, bin } = glb(MODEL);
  const geos = json.meshes.map((m) => {
    const prim = m.primitives[0];
    const geo = new THREE.BufferGeometry();
    const pos = accessor(json, bin, prim.attributes.POSITION);
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setIndex(
      new THREE.BufferAttribute(accessor(json, bin, prim.indices), 1),
    );
    return geo;
  });
  const objs = json.nodes.map((n) => {
    const o =
      n.mesh !== undefined
        ? new THREE.Mesh(geos[n.mesh])
        : new THREE.Object3D();
    o.name = n.name;
    if (n.translation) o.position.fromArray(n.translation);
    if (n.rotation) o.quaternion.fromArray(n.rotation);
    if (n.scale) o.scale.fromArray(n.scale);
    return o;
  });
  json.nodes.forEach((n, i) => {
    for (const c of n.children ?? []) objs[i].add(objs[c]);
  });
  const root = new THREE.Object3D();
  root.name = "lens";
  for (const i of json.scenes[0].nodes) root.add(objs[i]);
  deriveFrames(root);
  return root;
}

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

Where every PIECE of the lens is through the hero story, in the bore's own
cylindrical coordinates — the space the op algebra works in, where a
trajectory that looks like a curve on screen is a line or a ramp. Rendered from
\`story/flow.ts\`'s \`pieceStateAt(p, key, table)\`, which runs the REAL op
pipeline on the NUM backend (\`ops/cpu.ts\` \`pieceField\` — the same fold
preamble the shader is built from, and the same path the recipe goldens are
pinned on) at the channels \`storyStateAt(p)\` reports, and composes
story/peelcards.ts's rigid per-piece offset on top exactly as core/scene does.
Regenerate with

    LENS_PIECE_FLOW=1 npx vitest run src/lib/lens/story/__tests__/piece-flow.test.ts

and \`story/__tests__/piece-flow.test.ts\` asserts the checked-in file matches,
so a wave that retunes a recipe fails the suite with the new table in the diff.

**Roster.** \`lens_web_segmented.glb\` — ${meshes} mesh nodes, ${table.pieces.length} pieces: ONE PIECE PER DISTINCT LANE TUPLE, which is how the deform itself reads the model. Six meshes carry more than one tuple (an adopted feature is framed island by island so each screw snaps to its own host wedge) — and islands that snapped to the SAME wedge inherit identical lanes and are therefore one piece, so a mesh's pieces are its distinct FRAMES, not its islands. By cast: ${roster}. A piece IS its derived frame (\`ops/frames.ts\`'s \`_op*\` lanes); the casts are core/visibility.ts's own wink bands.

**Deform set.** The hero pins \`${DEFORM_RECIPES.join(" / ")}\` and drives them off the story's channels; every knob rests at its recipe's \`knobDefaults\`. Nothing moves outside p ∈ [${w0.toFixed(4)}, ${w1.toFixed(4)}] — the op channels' own live span, scanned at 1/2000 and snapped outward by a step. Every piece is exactly on its seat outside it.

**The dimensions.** \`dTheta\`/\`dR\`/\`dX\` are the piece frame's displacement from its seat — round the bore (rad), out from the axis (mm), along the axis (mm). \`roll\` is the piece turning IN PLACE about the bore (a rigid revolution reads 0: the local frame is carried with it). \`bend\` and \`curl\` are the two halves of "how did its shape change", and neither implies the other: \`bend\` is AXIAL — the relative rotation of the piece's two ends, how much one has turned against the other, unsigned, 0 for any rigid motion (and a true 0.000 through the peel, cards and internals, which move a piece's two ends alike) — while \`curl\` is CIRCUMFERENTIAL and SIGNED: how much more its arcs curve than they do at their seat, positive curled tighter, negative flattened, which is what a wedge peeling off the barrel does. \`stretch\` and \`stretch X\` are its size round the bore and along it: 1 is rigid, and they are separate readings off separate probe pairs (\`stretch X\` is a ratio of the piece's OWN axial extent, so it runs to 100× on a 0.093mm shim the ops spread by a millimetre — as the render does). \`travel\` is the straight-line distance from the seat. There is no rigid half any more: story/peelcards.ts's per-piece offsets went with the cards scene's old drift departure, so every motion in the story is a deform channel and this table is all of it.

**What it is not.** The AUTHORED pose at \`p\`: every residual \`story/state.ts\`
declares (ease lag, phase clocks, mount latches) applies. It carries no
mechanism drive (the iris blades' aperture rotation, the focus screw's spin are
object-level and on their own clocks), no model placement (dolly, rolls,
camera) and no visibility — a winked-out piece still has a pose and it is
reported here. Two measurement restrictions are worth naming. \`stretch\` is NOT
REPORTED for the 15 axisymmetric pieces (\`Cam_Followers\`, \`Iris_ActuatorGear\`,
\`Element_01…13\`): a body of revolution's frame span is the convention 2π rather
than a measured extent, so its circumferential probes are a ring sample, whose
size answers to the ring's rigid motion and not to any stretch — those cells
read a flat 1.0000 and mean "not measured". And the eight iris nodes are seated
off the optical axis, so their \`radius\` is a distance from their own origin —
the frame ops/frames.ts measures and ops/host.ts deforms them in, so the
instrument mirrors the render. \`story/flow.ts\`'s header has the full list.

## Per scene × cast — the range

\`min…max\` over every piece of the cast at every sample inside the scene's own
range (the shared edge grid, half-open on the right, plus the scene's hold
centre). This is the diff surface: regenerate after a wave and read this table.

\`\`\`text
${asTable(RANGE_HEAD, casts.map(rangeRow))}
\`\`\`

## Per scene × cast — the mean

The same cells averaged over pieces and samples. A signed mean near zero with a
wide range above is a cast moving SYMMETRICALLY — the fan of a shell opening
outward round the whole bore — rather than one standing still.

\`\`\`text
${asTable(MEAN_HEAD, casts.map(meanRow))}
\`\`\`

## The pieces that move — top ${OUTLIER_N} per scene

Each named at the sample where it is furthest from its seat inside the scene,
with its whole state there. Full per-piece trajectories are the API's job
(\`pieceFlow(key, table)\`), not this file's.

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
  it("matches the checked-in map", () => {
    const rendered = render();
    if (process.env.LENS_PIECE_FLOW) writeFileSync(MAP_URL, rendered);
    expect(
      readFileSync(MAP_URL, "utf8"),
      "src/lib/lens/PIECE-FLOW.md is stale — regenerate with LENS_PIECE_FLOW=1 and review the diff",
    ).toBe(rendered);
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
    // 194 meshes (ops/__tests__/shipped-glb.test.ts pins the file's count). Six
    // of them carry more than one tuple, and the count below is the number of
    // DISTINCT FRAMES each carries — NOT its island count: adoption copies the
    // host wedge's frame verbatim, so islands that snapped to the same wedge are
    // one piece here (`Mount_ScrewCounterbores` has 8 islands and 5 frames,
    // `Mount_Contacts` 10 and 2, `DecalT_BezelMIJ` 11 and 2). That is the whole
    // of what this asserts, and it is what the deform sees.
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
    // The whole claim of this test file: the node-side decode + deriveFrames
    // pass measures what the browser measures. core/parts.ts's isPeelTube doc
    // quotes two ranks it read off the shipped model's baked `_opA.w` — if the
    // decode were lossy or the graph rebuilt wrong, these would not land.
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
    // ops/frames.ts frames them in their own scoped pass and they share the
    // model's graph in the live scene; a naive walk would census the hood and
    // the filter as body (story/cost.ts's census learned this the hard way)
    expect(table.pieces.filter((r) => r.name.startsWith("Acc_"))).toEqual([]);
  });
});

// ── the probes ride the goldens' path ───────────────────────────────────────

describe("the pipeline under the probes is the goldens' pipeline", () => {
  // ops/__tests__/recipe-goldens.test.ts pins every recipe's FULL-PIPELINE
  // output as literals, generated by RUNNING the pipeline. `pieceField` reaches
  // that same `runPipeline` through host.ts's fold preamble instead of through
  // the goldens' hand-built ctx — so a golden row must be reproducible by
  // handing this module a piece with the goldens' lanes and probing the point
  // that ctx describes. If it is not, the instrument is measuring something
  // other than the shipped machinery.
  //
  // The goldens' fixture, and how a (piece, probe) pair becomes a POINT:
  //   halfSpan 0.4, partClass structure, axi 0, layerN 5, adopted 0;
  //   yMin/yMax = ∓20, so the probe's `yN` is simply y/40 and the piece's
  //   yMid is 0 (the goldens' frame0.axial);
  //   phi = halfSpan·(1 − 2·frac), radius = R + off — i.e. the seated vertex.
  const RECIPES = makeRecipes(NUM);
  const HALF = 0.4;

  const lanesOf = (t0: number, R: number, rank01: number, layerPhase: number, rung: number) => ({ t0, R, halfSpan: HALF, rank01, layerPhase, partClass: 0, rung, axi: 0, yMin: -20, yMax: 20, layerN: 5, adopted: 0 }); // prettier-ignore

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
    // (the theta column moved with the spiral — explode's `spin` knob is
    // 0.7 rad now; recipe-goldens' own header carries the why)
    const rows: [number, [number, number, number]][] = [
      [0.25, [0.7, 10, -20]],
      [0.5, [0.46793960967747383, 14.298272680429886, -19.845859348467272]],
      [0.75, [-0.0456245571536491, 29.594939357229784, -19.31772857436145]],
      [1, [-0.2997399815328022, 38.90598908216705, -19]],
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
    // the sheet, on the piece the gate's rank stagger releases last
    const lanes = lanesOf(-1.2, 21, 1, 0.82, -3.25);
    const rows: [number, [number, number, number]][] = [
      [0.25, [-1.192257449585948, 30.623591717577295, -0.9798290250356197]],
      [0.5, [-2.645185686121488, 66.50099716874664, -1.3]],
      [0.75, [-2.645185686121488, 66.50099716874664, -1.3]],
      [1, [-2.645185686121488, 66.50099716874664, -1.3]],
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
    // the identity edge: outside the deform's window the hard idle gate leaves
    // the live set empty, so nothing is evaluated and nothing may move — not
    // approximately, exactly. `restOf` decoding the seat through the same path
    // as the pose is what makes this assertable at all.
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
    // THE PROBE GEOMETRY'S OWN LAW. `bend` is the relative rotation of the two
    // ends and `stretchAxial` the ratio of the flanks joining them, so BOTH are
    // structurally zero/one for any probe set that lives on a single yMid — the
    // shape this instrument had first, under which every `bend` and every axial
    // stretch in the generated map read a flat 0.000 / 1.0000 whatever the ops
    // did along the bore. This fails if that ever comes back.
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
    // …and `bend`'s complement is NOT the same reading: the peel flattens the
    // shell wedges circumferentially while doing the same thing to both of a
    // piece's ends, so exactly here `curl` must be non-zero where `bend` is 0.
    // (v1's single-plane column read −0.201…1.046 over this cast — the sanity
    // reference for the magnitude, not a pinned value.)
    const peeling = RANGES.find((r) => r.scene.id === "peel")!;
    const pPeel = FLOW_SAMPLE_PS.filter(
      (p) => p > peeling.p0 && p < peeling.p1,
    );
    const wedges = table.pieces.filter((r) => r.cast === "wedges");
    const curls = pPeel.flatMap((p) => {
      const live = liveDeformAt(p);
      return wedges.map((r) => pieceStateAt(p, r.key, table, live));
    });
    expect(Math.max(...curls.map((s) => Math.abs(s.curl)))).toBeGreaterThan(
      0.5,
    );
    expect(Math.max(...curls.map((s) => s.bend))).toBe(0);
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
    // 2π, so its circumferential probes are a RING SAMPLE and their separation
    // answers to the ring's rigid motion. Measured on `Cam_Followers`, whose raw
    // girth ratio reads 3.9500 at p=0.6935 (a dilation, radius ×3.9500) and
    // 1.0000 at p=0.2833333 (a lateral carry, radius ×3.7884) — two rigid motions,
    // two different answers, so nothing built on the frame's radius can correct
    // it. The flat 1 below MEANS "not measured", and the map says so.
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
    // …while a piece with a MEASURED span still reports one (the map's own
    // cards outlier, compressed to 0.7677 where it is furthest from its seat)
    // Pinned at the sample grid's OWN extreme rather than at a hand-picked p:
    // the cards scene drives the wrap channel now (story/envelopes.ts
    // CARDS_WRAP — its transition IS the reassembly), so the reading that used
    // to be this piece's most compressed sample (0.7677 at p 0.2612, inside the
    // cards scene) is no longer the extreme; the sky chapter's reveal is.
    const measured = FLOW_SAMPLE_PS.map((q) => ({
      p: q,
      stretch: pieceStateAt(q, "Ring_Focus_Seg4", table).stretch,
    }));
    const worst = measured.reduce((a, b) => (b.stretch < a.stretch ? b : a));
    expect(worst.p).toBeCloseTo(0.8643537, 6);
    expect(worst.stretch).toBeCloseTo(0.619, 3);
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

  it("takes a shell wedge out and flies it INTO the flower, never back onto the lens", () => {
    // the story's own arc, read off one piece: seated at the top, far from home
    // through the peel and the cards — and then straight into the bloom. This
    // is the question the instrument exists to answer, asserted at its coarsest.
    const flow = pieceFlow("Barrel_Base_Seg0", table);
    const at = (p: number) =>
      flow.samples.reduce((best, s) =>
        Math.abs(s.p - p) < Math.abs(best.p - p) ? s : best,
      );
    expect(at(0).travel).toBe(0);
    // THE SEATED-LENS BEAT IS GONE (owner: "the last scene would be the pieces
    // flying in to construct the rose"). The ending used to seat the shell for
    // one frame at RETURN's far edge — assemble landing on exactly 0 where the
    // rose's rise opens — and grow the flower out of the re-formed lens. The
    // radius now outlives the wrap (story/envelopes.ts CONSTRUCT overlaps
    // ROSE_PULSE), so at the bloom's foot this wedge is still well out…
    const seam = windowEdges(ROSE_PULSE.rise)[0];
    expect(at(seam).travel).toBeGreaterThan(10);
    // …and it never comes home again: not one frame from the bloom's foot to
    // the end of the track shows this piece on its seat.
    for (const s of flow.samples.filter((s) => s.p >= seam))
      expect(s.travel, `p ${s.p}`).toBeGreaterThan(0);
    expect(at(1).travel).toBeGreaterThan(0);
    expect(Math.max(...flow.samples.map((s) => s.travel))).toBeGreaterThan(10);
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

  it("takes every knob at its recipe's default — the story writes none", () => {
    // ops/host.ts's knob uniforms are moved by the /lens bench's sliders only;
    // the hero never calls recipeKnob, so the offline evaluation is exact
    // rather than a settled approximation. Pinned on the source, since a future
    // wave reaching for a knob from the story path would silently invalidate
    // every number in the map.
    const src = [
      readFileSync(new URL("../hero-driver.ts", import.meta.url), "utf8"),
      readFileSync(
        new URL("../../../../components/LensStory.astro", import.meta.url),
        "utf8",
      ),
    ].join("\n");
    expect(src).not.toContain("recipeKnob");
    for (const p of FLOW_SAMPLE_PS)
      for (const l of liveDeformAt(p))
        expect(l.knobs).toBe(l.recipe.knobDefaults);
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
