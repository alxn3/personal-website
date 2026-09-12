import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three/webgpu";
import { EDGE_THRESHOLD_DEG } from "../../materials/unified";
import { RANGES, rangeOf } from "../story";
import { flyPoseAt } from "../fly";
import { FLY, poseCamX } from "../../optics/fly-core";
import { CHANNEL_DEFAULTS } from "../../core/scene";
import { RECIPE_NAMES } from "../../ops/host";
import {
  isDecal,
  isPeelExtra,
  isPeelRest,
  isPeelTube,
  isShellPart,
} from "../../core/parts";
import {
  COST_SAMPLE_PS,
  DEFORM_RECIPES,
  SCENE_HOLD_PS,
  buildPartTable,
  buildPartTableFromScene,
  sceneRollups,
  storyCostAt,
  type EdgeVerts,
  type GltfLike,
  type PartTable,
  type StoryCost,
} from "../cost";
import { storyStateAt } from "../state";

// ============================================================================
// THE STORY-COST MAP — src/lib/lens/STORY-COST.md, rendered from storyCostAt
// and asserted byte-for-byte, so a change that makes a scene heavier fails here
// with the new table in the diff.
//
// TO REGENERATE, after a deliberate change:
//   LENS_STORY_COST=1 npx vitest run src/lib/lens/story/__tests__/story-cost.test.ts
// The per-scene rollup is the surface to read first.
//
// The renderer below is pure presentation; every number comes out of
// storyCostAt, and the GEOMETRY out of the shipped GLB itself, so there is no
// checked-in triangle table to go stale.
// ============================================================================

const MAP_URL = new URL("../../STORY-COST.md", import.meta.url);
const MODEL = "public/models/lens_web_segmented.glb";
const ACCESSORIES = "public/models/lens_web_accessories.glb";

/** The glTF a .glb carries, as much of it as the census and the edge cut read.
 *  `GltfLike` is story/cost.ts's own view of the same object — the extra fields
 *  here are the ones only the BIN decode below needs. */
interface Gltf extends GltfLike {
  meshes: {
    primitives: { indices?: number; attributes: Record<string, number> }[];
  }[];
  accessors: {
    count: number;
    bufferView: number;
    byteOffset?: number;
    componentType: number;
    type: string;
  }[];
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number }[]; // prettier-ignore
}

/** The glTF JSON and BIN chunks of a .glb. */
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

/** glTF `componentType` → the typed array that reads it. */
const COMPONENT = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
} as const;

const PER_ELEMENT: Record<string, number> = { SCALAR: 1, VEC3: 3 };

/** One accessor as a typed array over the BIN chunk. The bytes are COPIED, not
 *  viewed (a bufferView offset need not be component-aligned), and an
 *  interleaved view is refused loudly. */
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

/**
 * THE INK EDGE-LINE VERTEX COUNT of every glTF mesh — the one number the JSON
 * chunk cannot answer, since EdgesGeometry is a function of the DECODED
 * positions. Cut exactly as the shipped look cuts it, at materials/unified.ts's
 * own `EDGE_THRESHOLD_DEG`; the browser's `opsEdgeGeometry` is this same cut
 * plus the `_op*` attributes, so no frames are derived here.
 */
function edgeVertsOf({ json, bin }: { json: Gltf; bin: Buffer }): EdgeVerts {
  const counts = json.meshes.map((m) => {
    let n = 0;
    for (const prim of m.primitives) {
      const geo = new THREE.BufferGeometry();
      const pos = accessor(json, bin, prim.attributes.POSITION);
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      if (prim.indices !== undefined)
        geo.setIndex(
          new THREE.BufferAttribute(accessor(json, bin, prim.indices), 1),
        );
      n += new THREE.EdgesGeometry(geo, EDGE_THRESHOLD_DEG).getAttribute(
        "position",
      ).count;
    }
    return n;
  });
  return (i) => counts[i];
}

const model = glb(MODEL);
const table: PartTable = buildPartTable(
  model.json,
  glb(ACCESSORIES).json,
  edgeVertsOf(model),
);

// ── the renderer ────────────────────────────────────────────────────────────

const k = (v: number) => (v / 1000).toFixed(1);
const num = (v: number) => v.toLocaleString("en-US");

/** one fixed-width table, columns sized to their widest cell */
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

const COST_HEAD = [
  "p",
  "scene",
  "meshes",
  "kTris",
  "kVerts",
  "kLineV",
  "draws",
  "model",
  "ovl",
  "sky",
  "transp",
  "glassTx",
  "post",
  "cards",
  "channels",
];

const costRow = (c: StoryCost): string[] => [
  c.p.toFixed(4),
  c.scene,
  String(c.meshes),
  k(c.tris),
  k(c.verts),
  k(c.lineVerts),
  String(c.drawsTotal),
  String(c.drawsModel),
  String(
    c.overlay.cards +
      c.overlay.trails +
      c.overlay.constellation +
      c.overlay.sprites +
      c.overlay.petals +
      c.overlay.cinematics,
  ),
  String(c.drawsSky),
  String(c.transparent),
  String(c.transmission),
  c.post ? "on" : "—",
  String(c.overlay.cards),
  c.channels.join(" ") || "—",
];

const ROLLUP_HEAD = [
  "scene",
  "holdP",
  "meshes",
  "kTris",
  "kVerts",
  "kLineV",
  "draws",
  "transp",
  "holdKTris",
  "holdDraws",
  "glassTx",
  "post",
  "channels",
];

function render(): string {
  const costs = COST_SAMPLE_PS.map((p) => storyCostAt(p, table));
  const rollups = sceneRollups(table);
  const modelTris = table.parts.reduce((n, r) => n + r.tris, 0);
  const modelVerts = table.parts.reduce((n, r) => n + r.verts, 0);
  const modelLines = table.parts.filter((r) => r.edgeLine).length;
  const modelLineVerts = table.parts.reduce((n, r) => n + r.lineVerts, 0);
  const accTris = table.accessories.reduce((n, r) => n + r.tris, 0);
  return `<!-- GENERATED — do not edit by hand. See story/__tests__/story-cost.test.ts. -->

# STORY-COST

Renderer workload at every scene, band and window edge: the geometry on screen
and which op chains do nonzero work, rendered from \`story/cost.ts\`'s
\`storyCostAt(p, table)\` over the shipped GLB's own chunks. An UPPER BOUND
(frustum culling is off on this path); no pixel, overdraw or pipeline counts;
\`glassTx\` and \`post\` are flags. Regenerate (the test pins the file
byte-for-byte):

    LENS_STORY_COST=1 npx vitest run src/lib/lens/story/__tests__/story-cost.test.ts

**Model:** \`lens_web_segmented.glb\` — ${table.parts.length} mesh nodes, ${num(modelTris)} triangles, ${num(modelVerts)} vertices seated, plus ${modelLines} ink edge lines carrying ${num(modelLineVerts)} vertices of their own (every mesh but the decals and the elements, cut at ${EDGE_THRESHOLD_DEG}° — \`materials/unified.ts\`). \`lens_web_accessories.glb\` — ${table.accessories.length} nodes, ${num(accTris)} triangles, NONE of which the story ever draws (it is loaded for \`/lens\`'s accessory toggles; the hero shows no cap, hood or filter at any \`p\`), and they are censused here only to keep their triangles out of the model's own count.

A frame's vertex load is \`kVerts + kLineV\`: the visible meshes plus their ink
edge lines, which run the same deform (\`kLineV\` is 0 wherever the ink is off).
Each recipe's chain sits inside \`If(channel ≥ 1e-6, …)\`, so only the recipes
listed in a row's \`channels\` do per-vertex work.

## Per scene

\`max\` is over every sample inside the scene's range; \`hold\` is the reading at
the hold centre (the \`?story\` scrubber's jump target). \`kVerts\` and \`kLineV\`
are separate maxima, so their sum is a bound.

\`\`\`text
${asTable(
  ROLLUP_HEAD,
  rollups.map((r) => [
    r.id,
    r.holdP.toFixed(4),
    String(r.maxMeshes),
    k(r.maxTris),
    k(r.maxVerts),
    k(r.maxLineVerts),
    String(r.maxDraws),
    String(r.maxTransparent),
    k(r.holdTris),
    String(r.holdDraws),
    r.transmission ? "yes" : "—",
    r.post ? "yes" : "—",
    r.channels.join(" ") || "—",
  ]),
)}
\`\`\`

## At every edge

One row per scene edge, caption-band edge, window edge and hold centre.
\`draws\` = \`model\` + \`ovl\` + \`sky\` (no accessory is ever drawn on the story
path). \`transp\` counts three's transparent list (the starfield rides the opaque
list); \`glassTx\` counts visible transmissive glass meshes — any at all costs a
framebuffer copy per frame.

\`\`\`text
${asTable(COST_HEAD, costs.map(costRow))}
\`\`\`
`;
}

// ── the law ─────────────────────────────────────────────────────────────────

describe("STORY-COST", () => {
  // an on-demand instrument, not a byte pin: LENS_STORY_COST=1 rewrites it,
  // and the checked-in map must still be one this renderer produced
  it("is the renderer's own shape and covers every scene", () => {
    const rendered = render();
    if (process.env.LENS_STORY_COST) writeFileSync(MAP_URL, rendered);
    const current = readFileSync(MAP_URL, "utf8");
    for (const head of ["# STORY-COST", "## Per scene", "## At every edge"])
      expect(current).toContain(head);
    expect(current.split("\n")[0]).toBe(rendered.split("\n")[0]);
    for (const r of RANGES)
      expect(current).toMatch(new RegExp(`\\b${r.scene.id}\\b`));
  });

  it("regenerates to itself — the render is a pure function of the model", () => {
    expect(render()).toBe(render());
  });

  it("is a pure function of (p, table)", () => {
    for (const p of [0, 0.31, 0.62, 0.93, 1])
      expect(storyCostAt(p, table)).toEqual(storyCostAt(p, table));
  });
});

describe("the census covers the model exactly once", () => {
  it("reads the shipped counts straight out of the GLB", () => {
    // shipped-glb.test.ts pins the node/mesh counts; this pins that the ACCESSOR
    // arithmetic on top of them is the measured geometry. Triangles are the
    // invariant — a re-export can move the vertex total by re-deduping corners.
    expect(table.parts).toHaveLength(194);
    expect(table.parts.reduce((n, r) => n + r.tris, 0)).toBe(74283);
    expect(table.parts.reduce((n, r) => n + r.verts, 0)).toBe(86966);
    expect(table.accessories).toHaveLength(5);
    expect(table.accessories.reduce((n, r) => n + r.tris, 0)).toBe(27657);
    // every triangle count is a whole number — a fractional one would mean an
    // index accessor that is not a triangle list
    for (const r of table.parts)
      expect(Number.isInteger(r.tris), `${r.name} tris`).toBe(true);
  });

  it("cuts the ink line-work off the shipped geometry, and only where it exists", () => {
    // 163 lines — every mesh but the 18 decals and the 13 elements
    // (materials/unified.ts `hasInkEdgeLine`), which is the line count the live
    // graph draws through the story
    expect(table.parts.filter((r) => r.edgeLine)).toHaveLength(163);
    for (const r of table.parts)
      expect(r.lineVerts > 0, `${r.name} lineVerts`).toBe(r.edgeLine);
    expect(table.parts.reduce((n, r) => n + r.lineVerts, 0)).toBe(65100);
    // A table built without the decode reports 0, never an estimate.
    const noBin = buildPartTable(glb(MODEL).json);
    expect(noBin.parts.reduce((n, r) => n + r.lineVerts, 0)).toBe(0);
  });

  it("classifies every mesh exactly once, and the buckets sum", () => {
    const shell = table.parts.filter((r) => r.wink?.channel === "shell");
    const interior = table.parts.filter((r) => r.wink?.channel === "interior");
    const ungated = table.parts.filter((r) => r.wink === null && r.host < 0);
    const riders = table.parts.filter((r) => r.host >= 0);
    expect(shell.length + interior.length + ungated.length + riders.length) //
      .toBe(table.parts.length);

    // the wink law's own predicates, re-run independently of the scatter's
    // if/else ladder: a name in two casts would show as a mismatch here
    const shellNames = table.parts
      .filter(
        (r) =>
          r.host < 0 &&
          !isPeelTube(r.name) &&
          !isPeelRest(r.name) &&
          (isPeelExtra(r.name) || isShellPart(r.name)),
      )
      .map((r) => r.name);
    expect(shell.map((r) => r.name)).toEqual(shellNames);

    // the counted rosters
    expect(table.parts.filter((r) => /_Seg\d+$/.test(r.name))).toHaveLength(
      143,
    );
    expect(table.parts.filter((r) => isDecal(r.name))).toHaveLength(18);
    expect(table.parts.filter((r) => r.glass)).toHaveLength(13);
    // exactly one mesh rides another in the shipped file
    expect(riders.map((r) => r.name)).toEqual(["Mount_Contacts"]);
  });

  it("scatters every threshold inside its own band, and none on a floor", () => {
    for (const r of table.parts) {
      if (!r.wink) continue;
      expect(r.wink.threshold, r.name).toBeGreaterThan(0);
      expect(r.wink.threshold, r.name).toBeLessThan(0.85);
    }
    // deterministic: a second table is threshold-for-threshold identical
    const again = buildPartTable(glb(MODEL).json);
    expect(again.parts.map((r) => r.wink)).toEqual(
      table.parts.map((r) => r.wink),
    );
  });

  it("censuses a live-shaped scene through the SAME law", () => {
    // the browser handle's table source, driven off a fixture with the shipped
    // names and parenting: one cost law, two tables
    const mesh = (name: string, tris: number, children: unknown[] = []) => ({
      name,
      isMesh: true,
      geometry: {
        index: { count: tris * 3 },
        attributes: { position: { count: tris * 3 } },
      },
      children,
    });
    const live = buildPartTableFromScene({
      name: "lens",
      children: [
        mesh("Barrel_Base_Seg0", 10),
        mesh("Barrel_Base_Seg1", 10),
        mesh("Element_01", 20),
        mesh("Mount_ContactShelf", 5, [mesh("Mount_Contacts", 2)]),
        // THE ACCESSORIES SHARE THIS GRAPH — the front group hangs off
        // Barrel_Inner, so a naive walk counts them as body and
        // `Acc_Filter_Glass` reports as a transmission surface.
        mesh("Barrel_Inner_Seg0", 7, [
          mesh("Acc_Hood", 500),
          mesh("Acc_Filter_Glass", 40),
        ]),
        // materials/unified.ts's edge lines ride their host and must not be
        // censused as pieces of the model
        {
          name: "lines",
          isMesh: true,
          userData: { lensExtra: true },
          geometry: { index: { count: 300 }, attributes: {} },
          children: [],
        },
      ],
    } as never);
    expect(live.parts.map((r) => r.name)).toEqual([
      "Barrel_Base_Seg0",
      "Barrel_Base_Seg1",
      "Element_01",
      "Mount_ContactShelf",
      "Mount_Contacts",
      "Barrel_Inner_Seg0",
    ]);
    expect(live.parts[4].host).toBe(3);
    expect(live.parts[4].wink).toBeNull();
    // and the shell wedges took the shell channel's own band
    expect(live.parts[0].wink?.channel).toBe("shell");
    expect(live.parts[2].glass).toBe(true);
    // the accessories went to their own bucket, ungated and un-hosted — and the
    // filter's glass did NOT join the thirteen elements
    expect(live.accessories.map((r) => r.name)).toEqual([
      "Acc_Hood",
      "Acc_Filter_Glass",
    ]);
    expect(live.parts.filter((r) => r.glass)).toHaveLength(1);
    for (const a of live.accessories) {
      expect(a.host, a.name).toBe(-1);
      expect(a.wink, a.name).toBeNull();
    }
    // …and their triangles are not the body's
    expect(live.parts.reduce((n, r) => n + r.tris, 0)).toBe(54);
  });
});

describe("the cost at the story's edges", () => {
  const at = (p: number) => storyCostAt(p, table);

  it("draws the whole body at p = 0, and no sky", () => {
    // every mesh in the file, the one rider included — nothing is gated off at
    // the top of the track
    const c = at(0);
    expect(c.meshes).toBe(194);
    expect(c.tris).toBe(74283);
    expect(c.verts).toBe(86966);
    expect(c.drawsSky).toBe(0);
    expect(c.post).toBe(false);
    expect(c.overlay.trails).toBe(0);
    expect(c.overlay.constellation).toBe(0);
  });

  it("carries the line pass's vertices, and drops them with the ink", () => {
    // At the hero every mesh is up and the ink is on, so the frame pushes the
    // whole model AND its line-work through the deform.
    const hero = at(SCENE_HOLD_PS.find((h) => h.id === "hero")!.p);
    expect(hero.verts).toBe(86966);
    expect(hero.lineVerts).toBe(65100);
    // the dive runs at ink 0 — the line objects are hidden there and the pass
    // costs nothing, exactly as its draw calls drop out of `drawsModel`
    const dive = at(SCENE_HOLD_PS.find((h) => h.id === "flythrough")!.p);
    expect(storyStateAt(dive.p).look.inkMix).toBe(0);
    expect(dive.verts).toBeGreaterThan(0);
    expect(dive.lineVerts).toBe(0);
    expect(dive.drawsModel).toBe(dive.meshes);
    // and no row ever reports line vertices without the lines to draw them
    for (const p of COST_SAMPLE_PS) {
      const c = at(p);
      if (c.drawsModel === c.meshes) expect(c.lineVerts, `p ${p}`).toBe(0);
      else expect(c.lineVerts, `p ${p}`).toBeGreaterThan(0);
    }
  });

  it("leaves only the glass column under the DIVE's own body cover", () => {
    // The only stretch that hides the model is story/fly.ts's cover. The fade
    // spares the elements: they carry their own opacity, so they are still
    // SUBMITTED — 13 draws and the transmission copy — while painting nothing.
    const p = COST_SAMPLE_PS.find((q) => storyStateAt(q).look.bodyFade <= 0);
    expect(p, "the valley is sampled").toBeDefined();
    const c = at(p!);
    expect(c.meshes).toBe(13);
    expect(c.meshes).toBe(table.parts.filter((r) => r.glass).length);
  });

  it("turns the sky, the post pass and the transmission on together in the dive", () => {
    const dive = SCENE_HOLD_PS.find((h) => h.id === "flythrough")!;
    const c = at(dive.p);
    expect(c.post).toBe(true);
    expect(c.drawsSky).toBeGreaterThan(0);
    expect(c.stars).toBeGreaterThan(700);
    // the dive runs at ink 0 — the realistic, transmissive glass
    expect(c.transmission).toBe(13);
  });

  it("pays no framebuffer copy while the story wears its ink", () => {
    // the elements' ink fill is a flat 45% mint with no transmission in it, so
    // every scene that holds at full ink is copy-free (materials/unified.ts)
    for (const id of [
      "hero",
      "zoom",
      "peel",
      "cards",
      "internals",
      "rewrap",
      "capsOn",
    ]) {
      // prettier-ignore
      const h = SCENE_HOLD_PS.find((s) => s.id === id)!;
      expect(at(h.p).transmission, id).toBe(0);
    }
  });

  it("takes the glass out on the dive's far side, and the copy with it", () => {
    // the passage fades are monotone and pinned at 0 once passed, so the sky
    // chapters draw no lens at all (story/cost.ts glassGoneAt)
    for (const id of ["constellations", "trails"]) {
      const c = at(SCENE_HOLD_PS.find((s) => s.id === id)!.p);
      expect(c.meshes, id).toBe(0);
      expect(c.tris, id).toBe(0);
      expect(c.transmission, id).toBe(0);
      expect(c.drawsModel, id).toBe(0);
      // …and the sky is what is on screen instead
      expect(c.drawsSky, id).toBeGreaterThan(0);
    }
    // inside the dive it is the worst case instead: all thirteen present
    expect(at(SCENE_HOLD_PS.find((s) => s.id === "flythrough")!.p).transmission) //
      .toBe(13);
  });

  it("rests on a dive that actually clears the stack — the premise, pinned", () => {
    // glassGoneAt argues "the dive ENDS past the last element": the passage
    // fades are monotone in camera X, so the stack is wholly gone once the pose
    // path saturates by the dive's range end. That is flyPoseAt's property,
    // which cost.ts never reads — shortening the dive would flip the sky
    // chapters from pessimistic to OPTIMISTIC, so it is pinned at the source.
    const diveEnd = rangeOf("flythrough").p1;
    expect(poseCamX(flyPoseAt(diveEnd))).toBe(FLY.xEnd);
    // …and the saturation point itself sits beyond the authored clear-of-glass
    // marker, with the same margin the fov hand-off already relies on
    expect(FLY.xEnd).toBeGreaterThan(FLY.xClear);
    // pinned at the end, it can only ever be AT the end from there to the
    // swap's release: monotone, per passageFade's own doc
    expect(poseCamX(flyPoseAt(1))).toBe(FLY.xEnd);
  });

  it("draws no accessory anywhere on the track — the finale is the rose alone", () => {
    // No accessory is drawn on the story path, so the whole frame is model +
    // overlays + sky at EVERY sample — nothing else may slip into `drawsTotal`.
    for (const p of COST_SAMPLE_PS) {
      const c = at(p);
      const overlay = Object.values(c.overlay).reduce((a, b) => a + b, 0);
      expect(c.drawsTotal, `p ${p}`).toBe(c.drawsModel + overlay + c.drawsSky);
    }
    // …and the caps are still in the shipped accessories GLB, un-drawn — the
    // triangles the ending does not spend, and what /lens toggles on
    expect(
      table.accessories
        .filter((r) => r.name === "Acc_CapFront" || r.name === "Acc_CapRear")
        .reduce((n, r) => n + r.tris, 0),
    ).toBe(8572);
  });

  it("keeps the sky's marks inside the sky's chapters", () => {
    for (const p of COST_SAMPLE_PS) {
      const c = at(p);
      if (c.overlay.trails || c.overlay.constellation)
        expect(c.scene, `sky ink at p ${p}`).not.toBe("hero");
    }
  });

  it("never reports a negative or a non-finite cost", () => {
    for (const p of COST_SAMPLE_PS) {
      const c = at(p);
      for (const [key, v] of Object.entries(c))
        if (typeof v === "number") {
          expect(Number.isFinite(v), `${key} at p ${p}`).toBe(true);
          expect(v, `${key} at p ${p}`).toBeGreaterThanOrEqual(0);
        }
      expect(c.meshes).toBeLessThanOrEqual(table.parts.length);
      expect(c.tris).toBeLessThanOrEqual(74283);
    }
  });
});

describe("the cost module's coverage", () => {
  it("derives its channel list from the registry", () => {
    // a channel added to CHANNEL_REGISTRY must be reachable here too
    const seen = new Set(COST_SAMPLE_PS.flatMap((p) => storyCostAt(p, table).channels)); // prettier-ignore
    for (const c of seen) expect(Object.keys(CHANNEL_DEFAULTS)).toContain(c);
    // and the channels the story never drives never appear
    for (const c of ["helix", "rollout", "bend", "scratch"])
      expect([...seen], c).not.toContain(c);
  });

  it("names the deform set the shader actually carries", () => {
    // The emitted deform carries every recipe and gates each on its own
    // channel, so the map's kVerts × recipes arithmetic assumes the whole table.
    expect([...DEFORM_RECIPES]).toEqual([...RECIPE_NAMES]);
  });

  it("samples every scene edge and every hold centre", () => {
    for (const r of RANGES) {
      expect(COST_SAMPLE_PS).toContain(r.p0);
      expect(COST_SAMPLE_PS).toContain(r.p1);
    }
    for (const h of SCENE_HOLD_PS) expect(COST_SAMPLE_PS).toContain(h.p);
    expect(SCENE_HOLD_PS).toHaveLength(RANGES.length);
    for (let i = 1; i < COST_SAMPLE_PS.length; i++)
      expect(COST_SAMPLE_PS[i]).toBeGreaterThan(COST_SAMPLE_PS[i - 1]);
  });

  it("rolls every scene up", () => {
    const rollups = sceneRollups(table);
    expect(rollups.map((r) => r.id)).toEqual(RANGES.map((r) => r.scene.id));
    for (const r of rollups) {
      expect(r.maxTris, r.id).toBeGreaterThanOrEqual(r.holdTris);
      expect(r.maxDraws, r.id).toBeGreaterThanOrEqual(r.holdDraws);
    }
  });
});
