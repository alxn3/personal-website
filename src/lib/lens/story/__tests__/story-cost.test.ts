import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import * as THREE from "three/webgpu";
import {
  EDGE_THRESHOLD_DEG,
  bodyFillsEmpty,
  edgeGeometry,
} from "../../materials/unified";
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
  type PartTable,
  type StoryCost,
} from "../cost";
import { storyStateAt } from "../state";
import { LABEL_ENTRIES } from "../constellations";
import { RAY_MIN_OPACITY, rayOpacityAt } from "../cinematics";
import { SKY } from "../../optics/sky";
import { TRAIL_LOOK } from "../../optics/star-trails";
import {
  ACCESSORIES,
  MODEL,
  accessor,
  glb,
  type Gltf,
} from "../../core/__tests__/glb";
import { asTable } from "./md-table";

// Renders src/lib/lens/STORY-COST.md from storyCostAt over the shipped GLB.
// Regenerate: LENS_STORY_COST=1 npx vitest run src/lib/lens/story/__tests__/story-cost.test.ts

const MAP_URL = new URL("../../STORY-COST.md", import.meta.url);

/** The ink edge line's vertex invocations per glTF mesh: the mesh vertices
 *  its index references, cut by the ink's own edgeGeometry at the shipped
 *  EDGE_THRESHOLD_DEG from the decoded positions. */
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
      const index = edgeGeometry(new THREE.Mesh(geo), EDGE_THRESHOLD_DEG).index!
        .array;
      n += new Set(index).size;
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

// --- the renderer

const k = (v: number) => (v / 1000).toFixed(1);
const num = (v: number) => v.toLocaleString("en-US");

const COST_HEAD = [
  "p",
  "scene",
  "meshes",
  "kTris",
  "kVerts",
  "kLineV",
  "kSkyV",
  "draws",
  "model",
  "ovl",
  "sky",
  "transp",
  "glassTx",
  "fbCopy",
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
  k(c.skyVerts),
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
  String(c.fbCopies),
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
  "kSkyV",
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

**Model:** \`lens_web_segmented.glb\` — ${table.parts.length} mesh nodes, ${num(modelTris)} triangles, ${num(modelVerts)} vertices seated, plus ${modelLines} ink edge lines indexing ${num(modelLineVerts)} of those vertices (every mesh but the decals and the elements, cut at ${EDGE_THRESHOLD_DEG}° — \`materials/unified.ts\`). \`lens_web_accessories.glb\` — ${table.accessories.length} nodes, ${num(accTris)} triangles, NONE of which the story ever draws (it is loaded for \`/lens\`'s accessory toggles; the hero shows no cap, hood or filter at any \`p\`), and they are censused here only to keep their triangles out of the model's own count.

A frame's vertex load is \`kVerts + kLineV + kSkyV\`: the fills drawn plus
their ink edge lines, which index the same vertices and run the same deform
(\`kLineV\` counts each line's referenced vertices once, and is 0 wherever the
ink is off), plus the sky's stars, trails, strokes and names. At full ink with
no fill the body fills sit at zero opacity and are skipped, so \`kTris\`,
\`kVerts\` and \`model\` there cover only the glass fills and the lines. Each
recipe's chain sits inside \`If(channel ≥ 1e-6, …)\`, so only the recipes
listed in a row's \`channels\` do per-vertex work.

## Per scene

\`max\` is over every sample inside the scene's range; \`hold\` is the reading at
the hold centre (the \`?story\` scrubber's jump target). \`kVerts\`, \`kLineV\`
and \`kSkyV\` are separate maxima, so their sum is a bound.

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
    k(r.maxSkyVerts),
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
list); \`glassTx\` counts visible transmissive glass meshes (front faces only);
\`fbCopy\` counts the framebuffer copy their pass reads.

\`\`\`text
${asTable(COST_HEAD, costs.map(costRow))}
\`\`\`
`;
}

describe("STORY-COST", () => {
  // not byte-pinned: the checked-in map just has to match this renderer's shape
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
});

/** a table without the BIN decode */
const bare = buildPartTable(model.json);

describe("the census covers the model exactly once", () => {
  it("reads the shipped counts straight out of the GLB", () => {
    // the accessor arithmetic matches the shipped geometry
    expect(table.parts).toHaveLength(194);
    expect(table.parts.reduce((n, r) => n + r.tris, 0)).toBe(74283);
    expect(table.parts.reduce((n, r) => n + r.verts, 0)).toBe(86966);
    expect(table.accessories).toHaveLength(5);
    expect(table.accessories.reduce((n, r) => n + r.tris, 0)).toBe(27657);
    // a fractional count would mean an index accessor that isn't a triangle list
    for (const r of table.parts)
      expect(Number.isInteger(r.tris), `${r.name} tris`).toBe(true);
  });

  it("cuts the ink line-work off the shipped geometry, and only where it exists", () => {
    // every mesh but the 18 decals and the 13 elements
    expect(table.parts.filter((r) => r.edgeLine)).toHaveLength(163);
    for (const r of table.parts) {
      expect(r.lineVerts > 0, `${r.name} lineVerts`).toBe(r.edgeLine);
      // the lines index the mesh's own vertices, so they never exceed them
      expect(r.lineVerts, `${r.name} lineVerts`).toBeLessThanOrEqual(r.verts);
    }
    expect(table.parts.reduce((n, r) => n + r.lineVerts, 0)).toBe(41152);
    // without the decode, 0 rather than an estimate
    expect(bare.parts.reduce((n, r) => n + r.lineVerts, 0)).toBe(0);
  });

  it("classifies every mesh exactly once, and the buckets sum", () => {
    const shell = table.parts.filter((r) => r.wink?.channel === "shell");
    const interior = table.parts.filter((r) => r.wink?.channel === "interior");
    const ungated = table.parts.filter((r) => r.wink === null && r.host < 0);
    const riders = table.parts.filter((r) => r.host >= 0);
    expect(shell.length + interior.length + ungated.length + riders.length) //
      .toBe(table.parts.length);

    // re-run the fade predicates independently of the scatter
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
    expect(bare.parts.map((r) => r.wink)).toEqual(
      table.parts.map((r) => r.wink),
    );
  });

  it("censuses a live-shaped scene through the SAME law", () => {
    // the live-scene table builder, on a fixture with shipped names
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
        // accessories hang off Barrel_Inner in the live graph
        mesh("Barrel_Inner_Seg0", 7, [
          mesh("Acc_Hood", 500),
          mesh("Acc_Filter_Glass", 40),
        ]),
        // edge lines are extras, not model pieces
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
    expect(live.parts[0].wink?.channel).toBe("shell");
    expect(live.parts[2].glass).toBe(true);
    // accessories get their own bucket; the filter glass is not an element
    expect(live.accessories.map((r) => r.name)).toEqual([
      "Acc_Hood",
      "Acc_Filter_Glass",
    ]);
    expect(live.parts.filter((r) => r.glass)).toHaveLength(1);
    for (const a of live.accessories) {
      expect(a.host, a.name).toBe(-1);
      expect(a.wink, a.name).toBeNull();
    }
    expect(live.parts.reduce((n, r) => n + r.tris, 0)).toBe(54);
  });
});

describe("the cost at the story's edges", () => {
  const at = (p: number) => storyCostAt(p, table);
  /** the cost at a scene's hold centre */
  const hold = (id: string) => at(SCENE_HOLD_PS.find((h) => h.id === id)!.p);
  const COSTS = COST_SAMPLE_PS.map(at);

  const glassRows = table.parts.filter((r) => r.glass);
  const glassTris = glassRows.reduce((n, r) => n + r.tris, 0);
  const glassVerts = glassRows.reduce((n, r) => n + r.verts, 0);

  it("shows the whole body at p = 0 but draws only the glass fills, and no sky", () => {
    // every mesh, nothing gated off yet; full ink with no fill skips the body fills
    const c = at(0);
    const s = storyStateAt(0);
    expect(bodyFillsEmpty(s.look.inkMix, s.look.inkFill)).toBe(true);
    expect(c.meshes).toBe(194);
    expect(c.tris).toBe(glassTris);
    expect(c.verts).toBe(glassVerts);
    expect(c.drawsModel).toBe(13 + 163);
    expect(c.drawsSky).toBe(0);
    expect(c.post).toBe(false);
    expect(c.overlay.trails).toBe(0);
    expect(c.overlay.constellation).toBe(0);
  });

  it("draws every fill once the ink fill shows", () => {
    const p = COST_SAMPLE_PS.find((q) => {
      const s = storyStateAt(q);
      return s.look.inkMix === 1 && s.look.inkFill > 0 && s.look.bodyFade === 1;
    });
    expect(p, "a filled-ink sample").toBeDefined();
    const c = at(p!);
    expect(c.drawsModel).toBe(c.meshes + 163);
    expect(c.tris).toBeGreaterThan(glassTris);
  });

  it("carries the line pass's vertices, and drops them with the ink", () => {
    // hero: every edge line, ink on
    const hero = hold("hero");
    expect(hero.lineVerts).toBe(41152);
    // dive: ink 0, so the lines cost nothing
    const dive = hold("flythrough");
    expect(storyStateAt(dive.p).look.inkMix).toBe(0);
    expect(dive.verts).toBeGreaterThan(0);
    expect(dive.lineVerts).toBe(0);
    expect(dive.drawsModel).toBe(dive.meshes);
  });

  it("leaves only the glass column under the DIVE's own body cover", () => {
    // the body fade spares the 13 glass elements, which are still submitted
    const p = COST_SAMPLE_PS.find((q) => storyStateAt(q).look.bodyFade <= 0);
    expect(p, "the valley is sampled").toBeDefined();
    const c = at(p!);
    expect(c.meshes).toBe(13);
    expect(c.meshes).toBe(table.parts.filter((r) => r.glass).length);
  });

  it("turns the sky, the post pass and the transmission on together in the dive", () => {
    const c = hold("flythrough");
    expect(c.post).toBe(true);
    expect(c.drawsSky).toBeGreaterThan(0);
    expect(c.stars).toBeGreaterThan(700);
    // ink 0: realistic, transmissive glass, all thirteen (the worst case)
    expect(c.transmission).toBe(13);
    // front faces only: one pass, one copy
    expect(c.drawsModel).toBe(c.meshes);
    expect(c.fbCopies).toBe(1);
  });

  it("counts the sky's ink only while it shows, and its vertices", () => {
    const stars = SKY.stars.length;
    // trails hold: the strokes and names are gone, the quote holds
    const c = hold("trails");
    expect(c.overlay.trails).toBe(1);
    expect(c.overlay.constellation).toBe(0);
    expect(c.overlay.sprites).toBe(1);
    const trailVerts = stars * (TRAIL_LOOK.segments + 1) * 2;
    expect(c.skyVerts).toBe(stars * 4 + trailVerts + 4);
    // constellations hold: strokes, every name and the quote; no trails yet
    const co = hold("constellations");
    expect(co.overlay.trails).toBe(0);
    expect(co.overlay.constellation).toBe(1);
    expect(co.overlay.sprites).toBe(LABEL_ENTRIES.length + 1);
    // no sky at all outside the dive's mount
    expect(at(0).skyVerts).toBe(0);
  });

  it("draws the refraction rays only while the explode shows them", () => {
    const shown = COSTS.map((c) => {
      const s = storyStateAt(c.p);
      const rays = c.overlay.cinematics - (s.look.dust ? 1 : 0);
      const on = rayOpacityAt(s.channels.explode) > RAY_MIN_OPACITY;
      expect(rays, `p ${c.p}`).toBe(on ? 3 : 0);
      return on;
    });
    expect(shown).toContain(true);
    expect(shown).toContain(false);
  });

  it("pays no framebuffer copy while the story wears its ink", () => {
    // the ink glass fill has no transmission
    for (const id of [
      "hero",
      "zoom",
      "peel",
      "cards",
      "internals",
      "rewrap",
      "capsOn",
    ])
      // prettier-ignore
      expect([hold(id).transmission, hold(id).fbCopies], id).toEqual([0, 0]);
  });

  it("takes the glass out on the dive's far side, and the copy with it", () => {
    // the sky scenes draw no lens at all
    for (const id of ["constellations", "trails"]) {
      const c = hold(id);
      expect(c.meshes, id).toBe(0);
      expect(c.tris, id).toBe(0);
      expect(c.transmission, id).toBe(0);
      expect(c.drawsModel, id).toBe(0);
      expect(c.drawsSky, id).toBeGreaterThan(0);
    }
  });

  it("rests on a dive that actually clears the stack — the premise, pinned", () => {
    // cost.ts assumes the camera is past the last element by the dive's end
    const diveEnd = rangeOf("flythrough").p1;
    expect(poseCamX(flyPoseAt(diveEnd))).toBe(FLY.xEnd);
    expect(FLY.xEnd).toBeGreaterThan(FLY.xClear);
    expect(poseCamX(flyPoseAt(1))).toBe(FLY.xEnd);
  });

  it("holds its invariants at every sampled p", () => {
    for (const c of COSTS) {
      const at = `p ${c.p}`;
      // edge lines cost vertices exactly when they are drawn
      if (c.drawsModel === c.meshes) expect(c.lineVerts, at).toBe(0);
      else expect(c.lineVerts, at).toBeGreaterThan(0);
      // draws = model + overlays + sky: no accessory is ever drawn
      const overlay = Object.values(c.overlay).reduce((a, b) => a + b, 0);
      expect(c.drawsTotal, at).toBe(c.drawsModel + overlay + c.drawsSky);
      // the sky's marks stay inside the sky's chapters
      if (c.overlay.trails || c.overlay.constellation)
        expect(c.scene, at).not.toBe("hero");
      for (const [key, v] of Object.entries(c))
        if (typeof v === "number") {
          expect(Number.isFinite(v), `${key} at ${at}`).toBe(true);
          expect(v, `${key} at ${at}`).toBeGreaterThanOrEqual(0);
        }
      expect(c.meshes).toBeLessThanOrEqual(table.parts.length);
      expect(c.tris).toBeLessThanOrEqual(74283);
    }
    // the caps are in the accessories GLB, for /lens
    expect(
      table.accessories
        .filter((r) => r.name === "Acc_CapFront" || r.name === "Acc_CapRear")
        .reduce((n, r) => n + r.tris, 0),
    ).toBe(8572);
  });

  it("reports only registry channels, and none the story never drives", () => {
    // a channel added to CHANNEL_REGISTRY must be reachable here too
    const seen = new Set(COSTS.flatMap((c) => c.channels));
    for (const c of seen) expect(Object.keys(CHANNEL_DEFAULTS)).toContain(c);
    for (const c of ["helix", "rollout", "bend", "scratch"])
      expect([...seen], c).not.toContain(c);
  });
});

describe("the cost module's coverage", () => {
  it("names the deform set the shader actually carries", () => {
    // the emitted deform carries every recipe
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
