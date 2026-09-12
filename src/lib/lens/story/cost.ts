// storyCostAt(p): the renderer's workload at one scroll position, as plain
// JSON — the cost twin of state.ts. An upper bound by construction, every
// number read from its owning module. PURE: no fs, DOM or renderer; geometry
// arrives as a `PartTable` from the shipped GLB's chunks or a live scene
// census. Not modelled: per-pixel cost, pipeline counts, unsupplied edge-line
// vertices (0, never estimated), per-element passage fades, state.ts's residuals.
// LAZY: reached only by `await import("./cost")`; never added to index.ts.

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
import { STARFIELD_LOOK } from "../optics/starfield";

// ── THE GEOMETRY TABLE ──────────────────────────────────────────────────────

/** One mesh node, with everything about it that is a property of the MODEL
 *  rather than of `p`. Built once per table; `storyCostAt` is a fold over it. */
export interface PartRow {
  name: string;
  tris: number;
  verts: number;
  /** Index into `parts` of the mesh this one RIDES, or −1 when it is top-level.
   *  A rider is never gated on its own and inherits its host's flag. */
  host: number;
  /** core/parts.ts isOpticalGlass — the body fade's hard tail spares it, and it
   *  is what puts the frame in the transmission pass. */
  glass: boolean;
  /** Does an ink edge-line object exist for this mesh (materials/unified.ts
   *  `hasInkEdgeLine`)? */
  edgeLine: boolean;
  /** Vertices of that edge line's EdgesGeometry — the LINE pass's own copy of
   *  the deform fold, invisible in `verts`. Supplied by the table's builder,
   *  and 0 for a mesh with no line or a table built without the counts. */
  lineVerts: number;
  /** core/visibility.ts's threshold-wink law: which fade level hides it, and
   *  where in that level. null = neither gate governs it. */
  wink: WinkThreshold | null;
}

export interface PartTable {
  /** every mesh node of the model GLB, IN TRAVERSAL ORDER — the order is an
   *  input, since the wink scatter's band counters advance per member */
  parts: PartRow[];
  /** every mesh node of the accessories GLB — none is drawn on the story path.
   *  The bucket exists so they are counted OUT of the model's census: they
   *  share the model's scene graph (see buildPartTableFromScene). */
  accessories: PartRow[];
}

/** The shape of a parsed glTF JSON chunk this module needs. A `PartTable` can
 *  equally be built from a live three scene (see `buildPartTableFromScene`) —
 *  this is the node-side source. */
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

/** Classify one mesh node. Shared by both table sources so they cannot drift. */
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
    // a mesh that wears no line carries no line vertices, whatever a caller
    // measured on it
    lineVerts: edgeLine ? lineVerts : 0,
    // a mesh that RIDES a host is never handed to the scatter, so it must not
    // advance a band counter
    wink: host < 0 ? wink(name) : null,
  };
}

/** The edge-line vertex count of one glTF MESH (by index), for a caller that
 *  has the decoded geometry the JSON chunk lacks. Keyed by mesh, since several
 *  nodes may share one geometry. Omitted ⇒ every `lineVerts` is 0. */
export type EdgeVerts = (meshIndex: number) => number;

/** The table, from a parsed glTF JSON chunk; does no I/O. The one number not in
 *  that chunk is the edge lines', which `edgeVerts` supplies for the MODEL
 *  ONLY — mesh indices belong to one file. */
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

/** The minimum a live three scene must look like — structural rather than an
 *  import, so this module stays renderer-free. */
export interface SceneLike {
  name: string;
  children: SceneLike[];
  isMesh?: boolean;
  geometry?: { index?: { count: number } | null; attributes?: Record<string, { count: number }> }; // prettier-ignore
  userData?: Record<string, unknown>;
}

// The same table, censused off a LIVE scene graph. Two things in that graph are
// not the model: the EXTRAS (edge lines, inverted hulls), which carry
// `userData.lensExtra` and ride their host; and the ACCESSORIES, which share
// the model's graph and are split off by ancestry, the rule the sweep uses.

/** The line vertices already IN the graph: the extras riding this mesh, summed.
 *  Zero until the first ink blend cuts the lines (`ensureLines` builds them
 *  lazily). */
function extraVerts(o: SceneLike): number {
  let n = 0;
  for (const c of o.children)
    if (c.userData?.lensExtra)
      n += c.geometry?.attributes?.position?.count ?? 0;
  return n;
}

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
        // an accessory is never handed to the scatter and never rides a body
        // host: its group root is its own visibility owner
        accessories.push({
          name: o.name,
          tris: idx / 3,
          verts: pos,
          host: -1,
          glass: isOpticalGlass(o.name),
          edgeLine: hasInkEdgeLine(o.name),
          lineVerts: extraVerts(o),
          wink: null,
        });
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

// ── THE COST RECORD ─────────────────────────────────────────────────────────

export interface OverlayCost {
  /** the peel's eight card quads (story/peelcards.ts CARD_COUNT) */
  cards: number;
  /** the long-exposure arcs — one instanced draw (optics/star-trails.ts) */
  trails: number;
  /** the self-drawing strokes' ring buffer — one draw, forever
   *  (optics/constellation-lines.ts) */
  constellation: number;
  /** the star-name sprites plus the quote, one draw each, at their MAXIMUM */
  sprites: number;
  /** the bloom's falling petals — one instanced draw (story/petals.ts) */
  petals: number;
  /** the ambient dust cloud (1 THREE.Points) + the three refraction lines,
   *  mounted for the life of the page; dust is off inside the dive and the
   *  bloom. */
  cinematics: number;
}

export interface StoryCost {
  p: number;
  scene: string;
  /** model meshes passing every visibility gate */
  meshes: number;
  /** Σ triangles of visible model meshes */
  tris: number;
  /** Σ vertices of visible model meshes — what the deform host pushes through
   *  the baked op graph every frame. */
  verts: number;
  /** Σ vertices of those meshes' INK EDGE LINES, 0 while the ink is off. They
   *  run the same fold, so the frame's vertex load is `verts + lineVerts`. */
  lineVerts: number;
  /** one draw per visible mesh, plus one per visible ink edge-line object */
  drawsModel: number;
  /** overlay draws, itemised */
  overlay: OverlayCost;
  /** starfield draws: the star quad-soup, plus the static-stroke soup when
   *  STARFIELD_LOOK.staticLines is on. 0 while it is unmounted. */
  drawsSky: number;
  drawsTotal: number;
  /** visible surfaces in three's TRANSPARENT render list. The starfield is not
   *  among them: it ships `transparent = false` + CustomBlending, so it rides
   *  the opaque list inside the transmission copy. */
  transparent: number;
  /** visible glass meshes still wearing a `transmission: 1` material. ANY of
   *  them ⇒ three copies the whole framebuffer once per frame. */
  transmission: number;
  /** the wormhole post pass mounted (story/fly.ts enter/exit) */
  post: boolean;
  /** stars in the mounted field, 0 when it is not mounted */
  stars: number;
  /** channels away from their registry default at p — which op chains are
   *  producing NONZERO deltas */
  channels: string[];
}

/** THE BAKED DEFORM SET the hero pins (`components/LensStory.astro`). The host
 *  folds one fused graph at material build, but each recipe's chain sits inside
 *  `If(channel >= 1e-6, …)`, so an idle recipe costs nothing: the per-vertex
 *  cost is `(verts + lineVerts) ×` this set's members that appear in
 *  `channels`. */
export const DEFORM_RECIPES = ["assemble", "explode", "peel", "rose"] as const;

/** Is p inside a driven mount window? Half-open at neither end: the modules
 *  gate with `>=` / `<=`, and the hysteresis pads are a latch, not a window. */
const inSpan = (p: number, p0: number, p1: number) => p >= p0 && p <= p1;

/** The three refraction lines story/cinematics.ts builds — the mounted count,
 *  and an upper bound: their `.visible` is further gated on explode depth. */
const RAY_LINES = 3;

/** The dive's own range end — where the camera has flown out past the last
 *  element into open starfield. */
const DIVE_P1 = rangeOf("flythrough").p1;

/**
 * Is the whole glass stack in `glassGone` at p. The passage fade is monotone in
 * camera X and pinned at 0 once passed, so "all of them have gone" needs only
 * that the dive ends past the last element. Inside the dive it reports the
 * stack ALL PRESENT — the worst case.
 */
const glassGoneAt = (p: number): boolean =>
  p > DIVE_P1 && p <= GLASS_OUT && p >= DIVE_P0;

/** THE COST AT p. Pure: same p and same table, same output. */
export function storyCostAt(p: number, table: PartTable): StoryCost {
  const s = storyStateAt(p);

  // ── the visibility gates, exactly as core/visibility.ts composes them ─────
  // the demo isolate and the fly's hard glass gate are not modelled: nothing on
  // the story path engages them
  const bodyOut = s.look.bodyFade <= 0;
  const glassOut = glassGoneAt(p);
  const vis = table.parts.map((r) => {
    if (r.host >= 0) return false; // resolved from the host below
    if (r.wink) {
      const level =
        r.wink.channel === "shell" ? s.look.shellFade : s.look.interiorFade;
      if (winkGone(r.wink.threshold, level)) return false;
    }
    if (r.glass) return !glassOut;
    // the body fade's hard tail: everything that is NOT glass, once it hits 0
    return !bodyOut;
  });
  // a host is always earlier in the traversal than what rides it, so one
  // forward pass resolves every rider
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

  // ── the looks that decide which render list a surface lands in ────────────
  // the ink 0-edge is materials/unified.ts setInk's own (`const on = k > 0`)
  const inkOn = s.look.inkMix > 0;
  // the elements wear their transmissive material below the hand-over and their
  // flat ink fill above it: the transmission pass reads the OPAQUE backdrop, so
  // glass may not stay transmissive once the ink puts the body in the
  // transparent list
  const transmission = s.look.inkMix < GLASS_HANDOVER ? glassVisible : 0;
  const channels = activeChannels(s);
  // the body is in the transparent list while any ink shows or a fade runs;
  // glass is always there, both of its materials being built transparent
  const bodyTransp = bodyTransparent(inkOn, s.look.bodyFade < 1);

  // ── the mount windows, each read from its owner ───────────────────────────
  const flyOn = inSpan(p, DIVE_P0, EXIT_END);
  const petalsOn = inSpan(p, PETALS_SPAN_P0, PETALS_SPAN_P1);
  const overlay: OverlayCost = {
    cards: inSpan(p, MOUNT_LO, MOUNT_HI) ? CARD_COUNT : 0,
    trails: inSpan(p, TRAILS_SPAN_P0, TRAILS_SPAN_P1) ? 1 : 0,
    constellation: inSpan(p, SKY_INK_P0, SKY_INK_P1) ? 1 : 0,
    sprites: inSpan(p, SKY_INK_P0, SKY_INK_P1) ? LABELS.length + 1 : 0,
    petals: petalsOn ? 1 : 0,
    // the dust cloud goes out for the dive and for the bloom, and comes back
    // with each; the three refraction lines are mounted throughout
    cinematics: flyOn || petalsOn ? RAY_LINES : RAY_LINES + 1,
  };
  const drawsSky = flyOn ? (STARFIELD_LOOK.staticLines ? 2 : 1) : 0;
  // no accessory column: the story shows none at any p

  const drawsModel = meshes + (inkOn ? lines : 0);
  const drawsOverlay = Object.values(overlay).reduce((a, b) => a + b, 0);

  return {
    p,
    scene: s.scene.id,
    meshes,
    tris,
    verts,
    // the lines are drawn only while the ink shows, and cost nothing otherwise
    lineVerts: inkOn ? lineVerts : 0,
    drawsModel,
    overlay,
    drawsSky,
    drawsTotal: drawsModel + drawsOverlay + drawsSky,
    transparent:
      glassVisible +
      (bodyTransp ? meshes - glassVisible : 0) +
      // every edge-line material is built transparent, and the objects are
      // shown only while the ink is on
      (inkOn ? lines : 0) +
      // every mounted overlay above is transparent; the starfield is not
      drawsOverlay,
    transmission,
    post: flyOn,
    stars: flyOn ? SKY.stars.length : 0,
    channels,
  };
}

/** Channels away from their registry default at p. A `null` reading counts as
 *  ACTIVE: a writer owns the channel on a phase clock rather than on p. */
function activeChannels(s: StoryState): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(s.channels)) {
    const def = CHANNEL_DEFAULTS[name as keyof typeof CHANNEL_DEFAULTS];
    if (value === null || value !== def) out.push(name);
  }
  return out.sort();
}

// ── THE SAMPLE GRID ─────────────────────────────────────────────────────────

/** Each scene's HOLD CENTRE — the positions a reader rests at, and the
 *  rollup's rows. */
export const SCENE_HOLD_PS: { id: string; p: number }[] = RANGES.map((r) => ({
  id: r.scene.id,
  p: holdCentreOf(r),
}));

/** Every p the cost table reports: story/state.ts's edge grid plus each scene's
 *  hold centre. Sorted, deduped, inside the track. */
export const COST_SAMPLE_PS: number[] = [
  ...new Set([...STORY_SAMPLE_PS, ...SCENE_HOLD_PS.map((h) => h.p)]),
]
  .filter((v) => v >= 0 && v <= 1)
  .sort((a, b) => a - b);

/** One scene's rollup: `max` is over every sample inside the scene's range,
 *  `hold` the reading at its hold centre. */
export interface SceneRollup {
  id: string;
  holdP: number;
  maxMeshes: number;
  maxTris: number;
  /** the two halves of the vertex load, each at its own worst sample */
  maxVerts: number;
  maxLineVerts: number;
  maxDraws: number;
  maxTransparent: number;
  holdTris: number;
  holdDraws: number;
  /** does the scene ever pay the transmission framebuffer copy? */
  transmission: boolean;
  post: boolean;
  /** every channel active anywhere in the scene */
  channels: string[];
}

export function sceneRollups(table: PartTable): SceneRollup[] {
  return RANGES.map((r, i) => {
    const hold = SCENE_HOLD_PS[i];
    // half-open on the right (last scene keeps its p1): a sample sitting ON a
    // boundary belongs to the scene whose p0 it is
    const inScene = COST_SAMPLE_PS.filter(
      (p) => p >= r.p0 && (i === RANGES.length - 1 ? p <= r.p1 : p < r.p1),
    );
    const costs = [...inScene, hold.p].map((p) => storyCostAt(p, table));
    const holdCost = storyCostAt(hold.p, table);
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
