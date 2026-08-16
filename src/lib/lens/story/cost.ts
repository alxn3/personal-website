// ============================================================================
// storyCostAt(p) — THE RENDERER'S WORKLOAD AT ONE SCROLL POSITION, as plain
// JSON. The cost twin of story/state.ts: that module answers "what is the story
// DOING at p", this one answers "what does the frame at p COST".
//
// WHY IT EXISTS: "how many triangles and how many calculations are happening
// within a scene, not time dependent" (owner). The answer was previously a
// browser reading — park the ?story scrubber, read `__lensPerf.renderer.info` —
// which is a settled-session, eased-frame number that no test can regenerate and
// no diff can review. This is the deterministic half, and it is unusually
// honest here for three reasons the codebase supplies:
//
//   · VISIBILITY IS A PURE FUNCTION OF STATE. core/visibility.ts's sweep reads
//     gates, and every gate that moves on the story path is driven by a value
//     `storyStateAt(p)` already reports (the shell/interior levels, the body
//     fade, the ink mix). The threshold-wink law those levels feed is shared
//     verbatim — core/visibility.ts `makeWinkScatter` — so the gone-sets
//     computed here are the ones the browser computes, not a model of them.
//   · FRUSTUM CULLING IS OFF. Every framed mesh has `frustumCulled = false`
//     (materials/unified.ts, because in-shader displacement invalidates
//     rest-pose bounds) and every overlay sets it explicitly. So "no culling"
//     is not a worst-case fudge, it is what the renderer does — which also
//     makes this an upper bound by construction, the right polarity for a
//     budget tool.
//   · THE TRIANGLES COME OUT OF THE SHIPPED FILE. Per-node triangles are
//     `indices.count / 3` straight from the GLB's JSON chunk — no decode, no
//     browser, and it cannot go stale, since the generator reads the file
//     itself (see the test).
//
// NO SECOND MODEL. Every number is read from the module that owns it:
// `storyStateAt(p)` for state, core/parts.ts for classification, the GLB for
// geometry, the owners' own exported constants for every mount window. Where a
// window or a band was module-private it was NAMED AND EXPORTED in its owner
// (story/state.ts's rule) rather than copied here — that is the whole of this
// task's edits to existing modules. The one class of literal left below is the
// DRAW STRUCTURE of an engine module ("the trail arcs are one draw call"),
// which is a fact those modules' headers state about themselves.
//
// PURE. No fs (the geometry arrives as a `PartTable` parameter), no DOM, no
// three renderer. Two table sources, one cost law: the test builds a table from
// the shipped GLB's own chunks, the DEV handle builds one by censusing the live
// `gltfScene`, and any drift between them is one `evaluate` away from visible.
//
// LAZY — NEVER STATICALLY REACHABLE FROM THE HOMEPAGE, for story/state.ts's
// reason and by importing it: it drags optics/ in. Reached ONLY by
// `await import("./cost")` from hero-driver's DEV block, or by a test in
// node. It must NEVER be added to index.ts.
//
// ── WHAT IT DELIBERATELY DOES NOT MODEL ────────────────────────────────────
//
//   · PER-PIXEL COST. Overdraw, the transmission blur's own passes, the post
//     pass's tap count. Not countable from the codebase; `postPass` is reported
//     as the boolean it is.
//   · PROGRAM / PIPELINE COUNTS. Measured-only — `__lensPerf` in a browser.
//   · THE EDGE LINES' VERTICES, WHEN NOBODY HANDS THEM OVER. Their DRAW CALLS
//     were always exact (one per non-decal visible mesh — materials/unified.ts
//     `hasInkEdgeLine`), and `lineVerts` now carries the load that pass puts
//     through the deform. But EdgesGeometry is a function of DECODED positions,
//     which the JSON chunk does not carry, so the counts are SUPPLIED to
//     `buildPartTable` by whoever has the geometry: the test cuts them off the
//     shipped BIN chunk at materials/unified.ts's own threshold, and the live
//     census reads the lines already in the graph. A table built without them
//     reports 0 — never an estimate.
//   · THE PER-ELEMENT GLASS PASSAGE FADES. story/fly.ts measures the element
//     ruler off the live GLB at rest, so they are not a function of p at all
//     (story/state.ts declares the same residual). The glass is therefore
//     reported ALL-VISIBLE through the dive — the worst case, and within a few
//     hundred triangles of the truth.
//   · EVERY RESIDUAL storyStateAt ALREADY DECLARES: ease lag, phase clocks,
//     latches and warm-up. A mount window here is the DRIVEN window; the
//     modules' hysteresis pads (peelcards MOUNT_HYST, fly HYST) mean a live
//     scrub parked just outside an edge can still be mounted. Reported windows
//     are the tighter, driven ones. The opposite edge too: trails/crown/
//     constellations ATTACH only on their first nonzero envelope, so between a
//     span edge and the envelope's rise this reports +1 draw not yet in the
//     graph — the upper-bound polarity, both ways.
//   · THE `rays` DRAWS ARE AN UPPER BOUND. The three refraction lines are
//     mounted for the whole page but `.visible` is additionally gated on
//     explode depth inside story/cinematics.ts's own frame(); the mounted 3 is
//     reported.
//
// ── THE ONE BROWSER CROSS-CHECK ────────────────────────────────────────────
//
// MEASURED once, by hand, against `__lensPerf.renderer.info` and a direct walk
// of the live scene graph, at four parked `?story` positions (the hold centres
// of hero / cards / flythrough / capsOn), each settled for ~4s of frames so the
// eased `state.story` had caught the target to 1e-4. The result and every delta:
//
//   THE MODEL CENSUS IS EXACT. Visible mesh count and visible triangle count
//   agreed to the unit at all four points — 194 / 74,283 at the hero, 76 /
//   31,700 at the cards, 194 / 74,283 at the finale — as did the model's draw
//   calls (meshes + ink edge-lines: 370 = 194 + 176 at the hero, 152 = 76 + 76
//   at the cards, the line count matching the drawn edge-line objects exactly).
//   (The finale reading was taken when it still flew the two caps on, and
//   carried their 8,572 triangles and their four draws; the caps are out of the
//   story now — story/cinematics.ts — and NO accessory is drawn at any p.)
//
//   THE CROSS-CHECK EARNED ITS KEEP. It found that the accessories share the
//   model's scene graph (see buildPartTableFromScene), which had the live census
//   reporting 199 meshes / 101,940 triangles and a fourteenth transmission
//   surface. Fixed above — and the reason the accessories are still censused
//   into a bucket of their own now that nothing draws them.
//
//   THE ONE STANDING OVERSTATEMENT is the dive's glass, exactly where this file
//   says it is: at the flythrough hold the estimator reports all 13 elements
//   (46.2k triangles) where the live frame had ~7 left (42.5k) — the rest had
//   already gone under the per-element passage fades, which are not a function
//   of p. ~3.8k triangles, and deliberately the pessimistic side.
//
//   RESIDUAL DRAW-CALL DELTA: +2 against `render.drawCalls` away from the dive
//   (e.g. 374 estimated against 372 live at the hero). It is +3 for the
//   refraction lines, which this file reports as mounted and the frame gates on
//   explode depth (the documented upper bound), less 1 for a draw three issues
//   that no scene object accounts for.
//
//   AND THE TWO WAYS `renderer.info` IS NOT COMPARABLE, confirmed: its
//   `render.triangles` reads exactly 1 above the drawn geometry at every point,
//   and inside the dive it reads 50,005 against 42,452 actually in the graph —
//   the transmission pass renders the scene a second time. Its `calls` likewise
//   includes three's own passes (the framebuffer copy, the post quad), which
//   are booleans here rather than draws.
// ============================================================================

import { CHANNEL_DEFAULTS } from "../core/scene";
import { isAccessory, isOpticalGlass } from "../core/parts";
import { makeWinkScatter, type WinkThreshold } from "../core/visibility";
import {
  GLASS_HANDOVER,
  bodyTransparent,
  hasInkEdgeLine,
} from "../materials/unified";
import { DIVE_P0, RANGES, holdCentreOf, rangeOf } from "./story";
import { EXIT_END, GLASS_OUT } from "./fly";
import { CARD_COUNT, MOUNT_HI, MOUNT_LO } from "./peelcards";
import {
  CROWN_P1,
  SPAN_P0 as TRAILS_SPAN_P0,
  SPAN_P1 as TRAILS_SPAN_P1,
} from "./trails";
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
   *  core/visibility.ts's sweep early-returns on a mesh parented under a mesh
   *  (shading's hull/line passes are shaped that way), so such a node is never
   *  gated on its own and simply inherits its host's flag. The shipped model has
   *  exactly one: `Mount_Contacts`, under `Mount_ContactShelf`. */
  host: number;
  /** core/parts.ts isOpticalGlass — the body fade's hard tail spares it, and it
   *  is what puts the frame in the transmission pass. */
  glass: boolean;
  /** Does an ink edge-line object exist for this mesh? materials/unified.ts
   *  `hasInkEdgeLine` — `addLine`'s own skip, called rather than restated. */
  edgeLine: boolean;
  /** Vertices of that edge line's EdgesGeometry — the load the LINE pass puts
   *  through its own copy of the deform fold, invisible in `verts`. MEASURED,
   *  never estimated: it is supplied by the table's builder (the test cuts it
   *  off the shipped GLB, the live census reads the lines in the graph) and is
   *  0 both for a mesh with no line and for a table built without the counts. */
  lineVerts: number;
  /** core/visibility.ts's threshold-wink law: which fade level hides it, and
   *  where in that level. null = neither gate governs it. */
  wink: WinkThreshold | null;
}

export interface PartTable {
  /** every mesh node of the model GLB, IN TRAVERSAL ORDER — the order is an
   *  input, since the wink scatter's band counters advance per member */
  parts: PartRow[];
  /** every mesh node of the accessories GLB. NONE of them is ever drawn on the
   *  story path — core/scene.ts boots every accessory group off, the hero never
   *  calls setAccessory, and nothing else writes their flags now the caps are
   *  out of the finale (story/cinematics.ts). The bucket exists so they are
   *  counted OUT of the model's own census: they share the model's scene graph
   *  (see buildPartTableFromScene), so a walk that missed them would report
   *  their triangles as the body's. It costs the story nothing. */
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
    // A mesh that RIDES a host is never handed to the scatter, exactly as
    // core/scene.ts's capture skips it — so it must not advance a band counter.
    wink: host < 0 ? wink(name) : null,
  };
}

/** The edge-line vertex count of one glTF MESH (by index), for a caller that
 *  has the decoded geometry the JSON chunk lacks — keyed by mesh and not by
 *  node because EdgesGeometry is a pure function of the geometry, which several
 *  nodes may share. Omitted ⇒ every `lineVerts` is 0. */
export type EdgeVerts = (meshIndex: number) => number;

/** THE TABLE, from a parsed glTF JSON chunk. Pure: hand it `JSON.parse`d JSON,
 *  it does no I/O. Triangles are `indices.count / 3` and vertices are
 *  `POSITION.count` — the accessor counts are the real numbers, and reading
 *  them touches only the JSON chunk. The one number NOT in that chunk is the
 *  edge lines', which `edgeVerts` supplies FOR THE MODEL ONLY: mesh indices
 *  belong to one file, and no accessory is drawn on the story path, so an
 *  accessory's line-work is outside every reported column exactly as its
 *  triangles are. */
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

/** The minimum a live three scene must look like — kept structural rather than
 *  importing three, so this module stays renderer-free. */
export interface SceneLike {
  name: string;
  children: SceneLike[];
  isMesh?: boolean;
  geometry?: { index?: { count: number } | null; attributes?: Record<string, { count: number }> }; // prettier-ignore
  userData?: Record<string, unknown>;
}

/**
 * THE SAME TABLE, censused off a LIVE scene graph — the honesty bridge. Counts
 * decoded geometry (`geometry.index.count / 3`), so the browser's numbers and
 * the checked-in table are an identity check on each other rather than two
 * models.
 *
 * TWO THINGS IN THAT GRAPH ARE NOT THE MODEL, and both were caught by running
 * this against `renderer.info` rather than reasoned about:
 *
 *   · THE EXTRAS materials/unified.ts and the bench looks hang ON a mesh
 *     (edge lines, inverted hulls). They carry `userData.lensExtra` and ride
 *     their host, exactly as core/visibility.ts's sweep treats them — no row of
 *     their own, and their vertices are their host's `lineVerts`.
 *   · THE ACCESSORIES SHARE THE MODEL'S GRAPH. The front group (cap / filter /
 *     hood) is parented under `Barrel_Inner`, so a naive walk counts five extra
 *     meshes and 27.7k triangles as body — and `Acc_Filter_Glass` even classes
 *     as optical glass, which would report a fourteenth transmission surface.
 *     They are split off here by ANCESTRY, which is the same rule the sweep
 *     uses (`underAccessory`) and for the same reason: they have their own
 *     owners and the body's gates must not speak for them.
 */
/** The line vertices already IN the graph: the extras riding this mesh, summed.
 *  On the story path that is exactly materials/unified.ts's one edge line — a
 *  bench look's inverted hull is an extra too, and /lens is not this path. Zero
 *  until the first ink blend cuts the lines (`ensureLines` builds them lazily),
 *  which is the live graph telling the truth, not a gap in the census. */
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
      // a non-indexed geometry draws position.count/3 tris — unreachable with
      // today's model (every shipped mesh is indexed), honest if that changes
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
  /** the long-exposure arcs — one merged draw (optics/star-trails.ts) */
  trails: number;
  /** the authored screen-space arc — one draw (optics/crown-arc.ts) */
  crown: number;
  /** the self-drawing strokes' ring buffer — one draw, forever
   *  (optics/constellation-lines.ts) */
  constellation: number;
  /** the star-name sprites plus the quote, one draw each. ENVELOPE-GATED at p
   *  and reported at its MAXIMUM: which labels are eligible depends on the live
   *  frame, and `LABELS.length` is the binding constraint either way. */
  sprites: number;
  /** the ambient dust cloud (1 THREE.Points) + the three refraction lines —
   *  mounted for the life of the page, dust off inside the dive
   *  (story/cinematics.ts, story/fly.ts). An UPPER BOUND: see the header. */
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
   *  the baked op graph every frame. See `DEFORM_RECIPES`. */
  verts: number;
  /** Σ vertices of those meshes' INK EDGE LINES, 0 while the ink is off (the
   *  line objects are `visible = inkOn`). The line materials run the same fold
   *  as the surfaces they outline (ops/host.ts `attachOpsLine`), so the frame's
   *  real vertex-shader load is `verts + lineVerts` — this column is the half
   *  `verts` cannot see. */
  lineVerts: number;
  /** one draw per visible mesh, plus one per visible ink edge-line object */
  drawsModel: number;
  /** overlay draws, itemised */
  overlay: OverlayCost;
  /** starfield draws: the star quad-soup, plus the static-stroke soup when
   *  STARFIELD_LOOK.staticLines is on. 0 while it is unmounted. */
  drawsSky: number;
  drawsTotal: number;
  /** visible surfaces in three's TRANSPARENT render list. The starfield is
   *  deliberately NOT among them: it ships `transparent = false` +
   *  CustomBlending precisely so it rides the OPAQUE list and is therefore
   *  inside the transmission copy (optics/starfield.ts's law). */
  transparent: number;
  /** visible glass meshes still wearing a `transmission: 1` material. ANY of
   *  them ⇒ three copies the whole framebuffer once per frame. */
  transmission: number;
  /** the wormhole post pass mounted (story/fly.ts enter/exit) */
  post: boolean;
  /** stars in the mounted field, 0 when it is not mounted */
  stars: number;
  /** channels away from their registry default at p — which op chains are
   *  producing NONZERO deltas. See `DEFORM_RECIPES` for why this, and not a
   *  per-chain multiplier, is the honest "how much work" signal. */
  channels: string[];
}

/** THE BAKED DEFORM SET the hero pins (`components/LensStory.astro`
 *  `recipes: [...]`). The deform host folds ONE fused graph of the scene's
 *  selected recipes at material build and never recompiles it (ops/host.ts) —
 *  but each recipe's chain sits inside `If(channel >= 1e-6, …)`, so an IDLE
 *  recipe costs nothing at all: the branch is on a uniform, coherent across the
 *  draw, and the hard idle gate behind it makes the skipped case the zero it was
 *  already contributing. (It did evaluate every recipe for every vertex every
 *  frame until commit 41bb38d.) So the per-vertex cost at p is
 *  `(verts + lineVerts) × the recipes ACTIVE there`, and since every recipe
 *  channel rests at 0 (core/scene.ts CHANNEL_DEFAULTS), those are exactly this
 *  set's members that appear in `channels`. Do not invent a per-chain-depth
 *  multiplier the shader does not have. */
export const DEFORM_RECIPES = ["assemble", "explode", "peel", "rose"] as const;

/** Is p inside a driven mount window? Half-open at neither end: the modules
 *  gate with `>=` / `<=`, and the hysteresis pads are a latch, not a window. */
const inSpan = (p: number, p0: number, p1: number) => p >= p0 && p <= p1;

/** The three refraction lines story/cinematics.ts builds. Their `.visible` is
 *  additionally gated on explode depth inside that module's own frame(), so
 *  this is the mounted count and an upper bound (header). */
const RAY_LINES = 3;

/** The dive's own range end — where the camera has flown out past the last
 *  element into open starfield. */
const DIVE_P1 = rangeOf("flythrough").p1;

/**
 * IS THE WHOLE GLASS STACK IN `glassGone` AT p — the one gate here that reads a
 * STRUCTURE of the dive rather than a number the dive exports, and the only
 * place the per-element ruler is summarised instead of reported worst-case.
 *
 * While the dive's transmissive swap is on, each element's opacity is its
 * passage fade (optics/fly-core.ts `passageFade`) and core/scene.ts's
 * `writeGlassOpacity` puts a mesh in `glassGone` at 0. That fade is
 * `1 - smoothstep(x0 - lead - fade, x0 - lead, camX)`: MONOTONE in camera X and
 * pinned at 0 once passed. So although WHICH element has gone at a p inside the
 * dive needs the ruler — measured off the live GLB, which is why story/state.ts
 * refuses to report it — "all of them have gone" needs only the fact that the
 * dive ENDS past the last element, which is what its range end means. Between
 * that end and the swap's release (story/fly.ts GLASS_OUT) the stack is
 * therefore wholly gone: no draw, no triangles, and no framebuffer copy.
 *
 * INSIDE the dive it reports the stack ALL PRESENT — the worst case, and the
 * right polarity for a budget tool. Outside the swap entirely the elements wear
 * their own materials at full opacity and this gate is simply off.
 */
const glassGoneAt = (p: number): boolean =>
  p > DIVE_P1 && p <= GLASS_OUT && p >= DIVE_P0;

/** THE COST AT p. Pure: same p and same table, same output. */
export function storyCostAt(p: number, table: PartTable): StoryCost {
  const s = storyStateAt(p);

  // ── the visibility gates, exactly as core/visibility.ts composes them ─────
  // NOT modelled, because nothing on the story path engages them: the demo
  // isolate (setIsolate — /lens only) and the fly's hard glass gate
  // (setGlassHidden — demos only).
  const bodyOut = s.look.bodyFade <= 0;
  const glassOut = glassGoneAt(p);
  const vis = table.parts.map((r) => {
    if (r.host >= 0) return false; // resolved from the host below
    if (r.wink) {
      const level =
        r.wink.channel === "shell" ? s.look.shellFade : s.look.interiorFade;
      if (level <= r.wink.threshold) return false;
    }
    if (r.glass) return !glassOut;
    // the body fade's hard tail: everything that is NOT glass, once it hits 0
    return !bodyOut;
  });
  // A host is always earlier in the traversal than what rides it, so one
  // forward pass resolves every rider.
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
  // The elements wear their realistic (transmissive) material below the
  // hand-over and their flat ink fill above it (materials/unified.ts setInk).
  const transmission = s.look.inkMix < GLASS_HANDOVER ? glassVisible : 0;
  const channels = activeChannels(s);
  // THE BODY'S 0-EDGE, called rather than respelled: the body is in the
  // transparent list while any ink shows or a fade runs. Glass is in neither —
  // both of ITS materials are built `transparent = true` once, never flipped.
  const bodyTransp = bodyTransparent(inkOn, s.look.bodyFade < 1);

  // ── the mount windows, each read from its owner ───────────────────────────
  const flyOn = inSpan(p, DIVE_P0, EXIT_END);
  const overlay: OverlayCost = {
    cards: inSpan(p, MOUNT_LO, MOUNT_HI) ? CARD_COUNT : 0,
    trails: inSpan(p, TRAILS_SPAN_P0, TRAILS_SPAN_P1) ? 1 : 0,
    crown: inSpan(p, TRAILS_SPAN_P0, CROWN_P1) ? 1 : 0,
    constellation: inSpan(p, SKY_INK_P0, SKY_INK_P1) ? 1 : 0,
    sprites: inSpan(p, SKY_INK_P0, SKY_INK_P1) ? LABELS.length + 1 : 0,
    // the dust cloud goes out for the dive and comes back with it; the three
    // refraction lines are mounted throughout
    cinematics: flyOn ? RAY_LINES : RAY_LINES + 1,
  };
  const drawsSky = flyOn ? (STARFIELD_LOOK.staticLines ? 2 : 1) : 0;
  // NO ACCESSORY COLUMN: the story shows none at any p (PartTable.accessories),
  // so there is nothing here to add to the draws, the triangles or the
  // transparent list — not a zero worth carrying.

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
 *  ACTIVE: null means a writer owns the channel on a phase clock rather than on
 *  p (story/internals.ts's rack and breath), which is a channel doing work. */
function activeChannels(s: StoryState): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(s.channels)) {
    const def = CHANNEL_DEFAULTS[name as keyof typeof CHANNEL_DEFAULTS];
    if (value === null || value !== def) out.push(name);
  }
  return out.sort();
}

// ── THE SAMPLE GRID ─────────────────────────────────────────────────────────

/** Each scene's HOLD CENTRE — story.ts's `holdCentreOf`, the same formula the
 *  `?story` scrubber's per-scene jump targets use (story/hero-driver.ts). These
 *  are the positions a reader actually rests at, so they are the rows the
 *  rollup reports and the ones a browser cross-check should park on. */
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

/** ONE SCENE'S ROLLUP — the "did this wave make scene X heavier" surface.
 *  `max` is over every sample inside the scene's range; `hold` is the reading at
 *  its hold centre. */
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
    // HALF-OPEN on the right (last scene keeps its p1): a sample sitting ON a
    // boundary belongs to the scene whose p0 it is — its own `scene` column in
    // the edge table says so — or every rollup's max would absorb the NEXT
    // scene's first sample and misattribute a wave's cost change.
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
