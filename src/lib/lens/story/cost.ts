// storyCostAt(p): an upper bound on the renderer's workload at one story
// position, as plain JSON. Pure: the geometry comes in as a PartTable, built
// from the GLB's JSON or a live scene. Per-pixel cost is not modelled.
// Lazy: only reached by dynamic import (a dev block or a test).

import { CHANNEL_DEFAULTS } from "../core/scene";
import { isAccessory, isOpticalGlass } from "../core/parts";
import {
  makeWinkScatter,
  winkGone,
  type WinkThreshold,
} from "../core/visibility";
import {
  GLASS_HANDOVER,
  bodyTransparent,
  hasInkEdgeLine,
} from "../materials/unified";
import { DIVE_P0, RANGES, holdCentreOf, rangeOf } from "./story";
import { EXIT_END, GLASS_OUT } from "./fly";
import { CARD_COUNT, MOUNT_HI, MOUNT_LO } from "./peelcards";
import {
  SPAN_P0 as TRAILS_SPAN_P0,
  SPAN_P1 as TRAILS_SPAN_P1,
} from "./trails";
import {
  SPAN_P0 as PETALS_SPAN_P0,
  SPAN_P1 as PETALS_SPAN_P1,
} from "./petals";
import {
  LABELS,
  SPAN_P0 as SKY_INK_P0,
  SPAN_P1 as SKY_INK_P1,
} from "./constellations";
import { STORY_SAMPLE_PS, storyStateAt, type StoryState } from "./state";
import { SKY } from "../optics/sky";

// --- the geometry table --------------------------------------------------------

/** One mesh node and its fixed properties. */
export interface PartRow {
  name: string;
  tris: number;
  verts: number;
  /** index in `parts` of the mesh this one rides (shares visibility with), or
   *  −1 for a top-level mesh */
  host: number;
  /** optical glass (core/parts.ts isOpticalGlass) */
  glass: boolean;
  /** has an ink edge-line object */
  edgeLine: boolean;
  /** vertices of that edge line, which runs the deform too; 0 when unknown */
  lineVerts: number;
  /** which fade level hides it and at what threshold (core/visibility.ts);
   *  null when no fade governs it */
  wink: WinkThreshold | null;
}

export interface PartTable {
  /** every mesh of the model, in traversal order (the fade scatter depends on
   *  the order) */
  parts: PartRow[];
  /** every accessory mesh; none is drawn by the story, but they share the
   *  model's scene graph and must be kept out of `parts` */
  accessories: PartRow[];
}

/** The parts of a parsed glTF JSON chunk this module reads. */
export interface GltfLike {
  nodes: { name: string; mesh?: number; children?: number[] }[];
  meshes: {
    primitives: {
      indices?: number;
      attributes: Record<string, number>;
    }[];
  }[];
  accessors: { count: number }[];
  scenes: { nodes: number[] }[];
}

/** One mesh node's row, shared by both table builders. */
function rowOf(
  name: string,
  tris: number,
  verts: number,
  host: number,
  wink: (n: string) => WinkThreshold | null,
  lineVerts = 0,
): PartRow {
  const edgeLine = hasInkEdgeLine(name);
  return {
    name,
    tris,
    verts,
    host,
    glass: isOpticalGlass(name),
    edgeLine,
    lineVerts: edgeLine ? lineVerts : 0,
    // a rider is not handed to the fade scatter, so it must not advance it
    wink: host < 0 ? wink(name) : null,
  };
}

/** The edge-line vertex count of a glTF mesh, by mesh index. */
export type EdgeVerts = (meshIndex: number) => number;

/** The table from parsed glTF JSON. `edgeVerts` applies to the model only;
 *  without it every `lineVerts` is 0. */
export function buildPartTable(
  model: GltfLike,
  accessories?: GltfLike,
  edgeVerts?: EdgeVerts,
): PartTable {
  return {
    parts: rowsOf(model, edgeVerts),
    accessories: accessories ? rowsOf(accessories) : [],
  };
}

function rowsOf(g: GltfLike, edgeVerts?: EdgeVerts): PartRow[] {
  const wink = makeWinkScatter();
  const rows: PartRow[] = [];
  const walk = (i: number, host: number) => {
    const n = g.nodes[i];
    let self = host;
    if (n.mesh !== undefined) {
      let tris = 0;
      let verts = 0;
      for (const prim of g.meshes[n.mesh].primitives) {
        if (prim.indices !== undefined)
          tris += g.accessors[prim.indices].count / 3;
        const pos = prim.attributes.POSITION;
        if (pos !== undefined) verts += g.accessors[pos].count;
      }
      self = rows.length;
      rows.push(
        rowOf(n.name, tris, verts, host, wink, edgeVerts?.(n.mesh) ?? 0),
      );
    }
    for (const c of n.children ?? []) walk(c, self);
  };
  for (const i of g.scenes[0].nodes) walk(i, -1);
  return rows;
}

/** The parts of a three.js object this module reads. */
export interface SceneLike {
  name: string;
  children: SceneLike[];
  isMesh?: boolean;
  geometry?: { index?: { count: number } | null; attributes?: Record<string, { count: number }> }; // prettier-ignore
  userData?: Record<string, unknown>;
}

/** Vertices of the extras (edge lines, hulls) under this mesh; 0 until the
 *  ink first builds its lines. */
function extraVerts(o: SceneLike): number {
  let n = 0;
  for (const c of o.children)
    if (c.userData?.lensExtra)
      n += c.geometry?.attributes?.position?.count ?? 0;
  return n;
}

/** The table from a live scene graph. Extras (`userData.lensExtra`) are
 *  skipped; accessories are split off by ancestry. */
export function buildPartTableFromScene(root: SceneLike): PartTable {
  const wink = makeWinkScatter();
  const parts: PartRow[] = [];
  const accessories: PartRow[] = [];
  const walk = (o: SceneLike, host: number, underAcc: boolean) => {
    if (o.userData?.lensExtra) return;
    const acc = underAcc || isAccessory(o.name);
    let self = host;
    if (o.isMesh && o.geometry) {
      const pos = o.geometry.attributes?.position?.count ?? 0;
      // a non-indexed geometry draws position.count/3 tris
      const idx = o.geometry.index?.count ?? pos;
      if (acc) {
        // accessories don't take part in the fade scatter or ride a host
        accessories.push(
          rowOf(o.name, idx / 3, pos, -1, () => null, extraVerts(o)),
        );
      } else {
        self = parts.length;
        parts.push(rowOf(o.name, idx / 3, pos, host, wink, extraVerts(o)));
      }
    }
    for (const c of o.children) walk(c, self, acc);
  };
  walk(root, -1, false);
  return { parts, accessories };
}

// --- the cost record -------------------------------------------------------------

/** Overlay draw calls. */
export interface OverlayCost {
  /** the peel's card quads */
  cards: number;
  /** star trails (one instanced draw) */
  trails: number;
  /** constellation strokes (one draw) */
  constellation: number;
  /** star-name sprites plus the quote, at most */
  sprites: number;
  /** the bloom's petals (one instanced draw) */
  petals: number;
  /** the three refraction rays, plus the dust while it is on */
  cinematics: number;
}

export interface StoryCost {
  p: number;
  scene: string;
  /** visible model meshes */
  meshes: number;
  /** triangles of visible model meshes */
  tris: number;
  /** vertices of visible model meshes, all run through the deform each frame */
  verts: number;
  /** vertices of their ink edge lines (0 while the ink is off); these run the
   *  deform too */
  lineVerts: number;
  /** one draw per visible mesh, plus one per visible edge line */
  drawsModel: number;
  overlay: OverlayCost;
  /** starfield draws; 0 while it is not mounted */
  drawsSky: number;
  drawsTotal: number;
  /** visible surfaces in the transparent render list (the starfield draws in
   *  the opaque list) */
  transparent: number;
  /** visible glass meshes with a transmission material; any at all means a
   *  full framebuffer copy per frame */
  transmission: number;
  /** the wormhole post pass is mounted */
  post: boolean;
  /** stars in the mounted starfield */
  stars: number;
  /** channels away from their default at p */
  channels: string[];
}

/** The recipes compiled into the hero's deform. Each only costs anything while
 *  its channel is nonzero. */
export const DEFORM_RECIPES = ["assemble", "explode", "peel", "rose"] as const;

/** Inside a mount window, both ends inclusive. */
const inSpan = (p: number, p0: number, p1: number) => p >= p0 && p <= p1;

/** The refraction rays cinematics.ts builds (always mounted). */
const RAY_LINES = 3;

/** The end of the flythrough scene: the camera is past the last glass element. */
const DIVE_P1 = rangeOf("flythrough").p1;

/** Whether every glass element has faded out behind the dive. Inside the dive
 *  all glass counts as visible (the worst case). */
const glassGoneAt = (p: number): boolean => p > DIVE_P1 && p <= GLASS_OUT;

/** The cost at p. */
export function storyCostAt(p: number, table: PartTable): StoryCost {
  const s = storyStateAt(p);

  // --- visibility, as core/visibility.ts composes it
  const bodyOut = s.look.bodyFade <= 0;
  const glassOut = glassGoneAt(p);
  const vis = table.parts.map((r) => {
    if (r.host >= 0) return false; // copied from the host below
    if (r.wink) {
      const level =
        r.wink.channel === "shell" ? s.look.shellFade : s.look.interiorFade;
      if (winkGone(r.wink.threshold, level)) return false;
    }
    if (r.glass) return !glassOut;
    // everything else hides once the body fade reaches 0
    return !bodyOut;
  });
  // a host always precedes its riders, so one forward pass resolves them
  table.parts.forEach((r, i) => {
    if (r.host >= 0) vis[i] = vis[r.host];
  });

  let meshes = 0;
  let tris = 0;
  let verts = 0;
  let lines = 0;
  let lineVerts = 0;
  let glassVisible = 0;
  for (const [i, r] of table.parts.entries()) {
    if (!vis[i]) continue;
    meshes++;
    tris += r.tris;
    verts += r.verts;
    if (r.edgeLine) {
      lines++;
      lineVerts += r.lineVerts;
    }
    if (r.glass) glassVisible++;
  }

  // --- which render list each surface lands in
  const inkOn = s.look.inkMix > 0;
  // glass is transmissive until the ink passes GLASS_HANDOVER
  const transmission = s.look.inkMix < GLASS_HANDOVER ? glassVisible : 0;
  const channels = activeChannels(s);
  // the body is transparent while ink shows or a fade runs; glass always is
  const bodyTransp = bodyTransparent(inkOn, s.look.bodyFade < 1);

  // --- overlays, each mounted over its owner's window
  const flyOn = inSpan(p, DIVE_P0, EXIT_END);
  const petalsOn = inSpan(p, PETALS_SPAN_P0, PETALS_SPAN_P1);
  const overlay: OverlayCost = {
    cards: inSpan(p, MOUNT_LO, MOUNT_HI) ? CARD_COUNT : 0,
    trails: inSpan(p, TRAILS_SPAN_P0, TRAILS_SPAN_P1) ? 1 : 0,
    constellation: inSpan(p, SKY_INK_P0, SKY_INK_P1) ? 1 : 0,
    sprites: inSpan(p, SKY_INK_P0, SKY_INK_P1) ? LABELS.length + 1 : 0,
    petals: petalsOn ? 1 : 0,
    cinematics: s.look.dust ? RAY_LINES + 1 : RAY_LINES,
  };
  const drawsSky = flyOn ? 1 : 0;

  const drawsModel = meshes + (inkOn ? lines : 0);
  const drawsOverlay = Object.values(overlay).reduce((a, b) => a + b, 0);

  return {
    p,
    scene: s.scene.id,
    meshes,
    tris,
    verts,
    lineVerts: inkOn ? lineVerts : 0,
    drawsModel,
    overlay,
    drawsSky,
    drawsTotal: drawsModel + drawsOverlay + drawsSky,
    transparent:
      glassVisible +
      (bodyTransp ? meshes - glassVisible : 0) +
      (inkOn ? lines : 0) +
      drawsOverlay,
    transmission,
    post: flyOn,
    stars: flyOn ? SKY.stars.length : 0,
    channels,
  };
}

/** Channels away from their default at p; a clock-driven (`null`) channel
 *  counts as active. */
function activeChannels(s: StoryState): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(s.channels)) {
    const def = CHANNEL_DEFAULTS[name as keyof typeof CHANNEL_DEFAULTS];
    if (value === null || value !== def) out.push(name);
  }
  return out.sort();
}

// --- the sample grid -------------------------------------------------------------

/** Each scene's hold centre. */
export const SCENE_HOLD_PS: { id: string; p: number }[] = RANGES.map((r) => ({
  id: r.scene.id,
  p: holdCentreOf(r),
}));

/** Every p the cost table reports: state.ts's edge grid plus each scene's hold
 *  centre. Sorted, deduped, within [0, 1]. */
export const COST_SAMPLE_PS: number[] = [
  ...new Set([...STORY_SAMPLE_PS, ...SCENE_HOLD_PS.map((h) => h.p)]),
]
  .filter((v) => v >= 0 && v <= 1)
  .sort((a, b) => a - b);

/** Scene i's samples from COST_SAMPLE_PS: [p0, p1), the last scene keeping p1. */
export function scenePs(i: number): number[] {
  const r = RANGES[i];
  const last = i === RANGES.length - 1;
  return COST_SAMPLE_PS.filter(
    (p) => p >= r.p0 && (last ? p <= r.p1 : p < r.p1),
  );
}

/** One scene's rollup: `max*` over every sample in the scene, `hold*` at its
 *  hold centre. */
export interface SceneRollup {
  id: string;
  holdP: number;
  maxMeshes: number;
  maxTris: number;
  maxVerts: number;
  maxLineVerts: number;
  maxDraws: number;
  maxTransparent: number;
  holdTris: number;
  holdDraws: number;
  /** whether the scene ever pays the transmission copy */
  transmission: boolean;
  post: boolean;
  /** every channel active anywhere in the scene */
  channels: string[];
}

export function sceneRollups(table: PartTable): SceneRollup[] {
  return RANGES.map((r, i) => {
    const hold = SCENE_HOLD_PS[i];
    const costs = [...scenePs(i), hold.p].map((p) => storyCostAt(p, table));
    const holdCost = costs[costs.length - 1];
    const max = (f: (c: StoryCost) => number) =>
      costs.reduce((n, c) => Math.max(n, f(c)), 0);
    return {
      id: r.scene.id,
      holdP: hold.p,
      maxMeshes: max((c) => c.meshes),
      maxTris: max((c) => c.tris),
      maxVerts: max((c) => c.verts),
      maxLineVerts: max((c) => c.lineVerts),
      maxDraws: max((c) => c.drawsTotal),
      maxTransparent: max((c) => c.transparent),
      holdTris: holdCost.tris,
      holdDraws: holdCost.drawsTotal,
      transmission: costs.some((c) => c.transmission > 0),
      post: costs.some((c) => c.post),
      channels: [...new Set(costs.flatMap((c) => c.channels))].sort(),
    };
  });
}
