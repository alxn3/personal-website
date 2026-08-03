import * as THREE from "three/webgpu";
import type { LensAnimation } from "../animations";
import { IDLE_ZERO_CHANNELS } from "../core/scene";
import type { SceneState } from "../core/scene";
import { isSegWedge } from "../core/parts";
import { frameOf } from "../ops/frames";
import { createPositionProbe, type ProbeSample } from "./path-probe";
import {
  createPathAnalysis,
  type AnalysisResult,
  type CompareResult,
  type CurlCornerResult,
  type InterferenceResult,
  type PathAnalysis,
} from "./analysis";

// ============================================================================
// MOTION PATHS — visualizer behind the /lens "Motion paths" toggle (see
// dev/path-probe.ts).
//
// Draws, for a handful of representative shell wedges, the WORLD-SPACE track
// every sample point of a low-poly sheet takes through the selected animation:
//   · polyline per sample point, COLOURED BY EDGE STRETCH (|edge| / |edge at
//     rest|) — 1.0 green = the sheet bends without stretching, red = the mesh
//     is being pulled apart, blue = crushed. Stretch is what caught the 3.7×
//     op bug, so it is the default channel rather than a decoration.
//   · tick crosses at even time intervals — bunched ticks = slow, spread out =
//     fast, so acceleration/stalls in the motion are visible directly.
//   · the live deformed sheet grid ("now"), sampled from the SAME probe at the
//     current uniform state.
//
// WHERE THE NUMBERS COME FROM: not a CPU mirror. Positions are read back from
// the GPU running the real deformation graph (dev/path-probe.ts), and the
// object-level motion comes from the real rig via matrixWorld — so there is no
// second copy of the op math to drift. What CAN still go wrong is the PLUMBING
// (wrong attributes, a stale path left over from a param tweak, a probe pass
// driven with different uniforms than the render). Two checks cover that, both
// reported in the panel and shouted at the console when they trip:
//   IDLE  — with every deformation channel at 0 the shader is contractually
//           an exact identity, so the probe must reproduce the seated vertex
//           positions. Non-zero error means the probe is not reading what the
//           material reads.
//   LIVE  — the "now" sheet is probed at the LIVE uniforms and compared against
//           the cached path at the current progress. Non-zero (once the channel
//           easing has settled) means the drawn path no longer describes what
//           is on screen — a stale path, or a walk driven differently.
// Neither is a lint: they compare against ground truth every time the overlay
// is on, and the "now" markers sitting visibly OFF the wedges is the same
// failure in a form you can't miss.
// ============================================================================

const STEPS = 96; // timesteps sampled across the animation's 0..1 progress
const GRID_U = 5; // sample columns across a wedge (its arc)
const GRID_V = 3; // sample rows up a wedge (its axial extent)
const SHEET_RANKS = [0, 0.5, 1]; // shell radius ranks to probe (inner/mid/outer)
const TICK_EVERY = 8; // draw a time tick every N steps
const TICK_LEN = 0.012; // world units (the lens is ~4 world units long)
// Tolerances in MODEL MILLIMETRES. Idle is a float-rounding budget: the graph
// rebuilds the seated point through trig, so it lands within ~1e-4mm.
const IDLE_TOL_MM = 0.01;
// Live is a RESAMPLING budget, measured: park the scrub on a walked sample and
// it reads 0.000mm for every animation; park it mid-segment and the worst case
// (a violent mid-scrub) reads ~0.8mm. Real drift — a stale
// path after a knob change, a walk driven with different uniforms — moves
// pieces by tens of millimetres, so 1mm separates the two cleanly.
const LIVE_TOL_MM = 1;

export interface PathVizContext {
  renderer: THREE.WebGPURenderer;
  /** World scene the overlay is attached to. */
  scene: THREE.Scene;
  /** Loaded GLB root — probe meshes are found under here. */
  model: THREE.Object3D;
  state: SceneState;
  /** Push `state`'s CURRENT channel values into the mechanism + the recipe
   *  channel uniforms (core/scene driveChannels). The walk re-drives this per
   *  timestep, so paths include the object-level mechanism motion (ring throws,
   *  element slides), not just the in-shader deform. */
  driveChannels: () => void;
  invalidate: () => void;
  /** Registry defaults for every plain channel (core/scene CHANNEL_DEFAULTS) —
   *  the analysis walks start each step from this neutral base so a walk is a
   *  pure function of the animation, not of whatever the page state held. */
  channelDefaults: Readonly<Record<string, number>>;
}

export interface PathViz {
  /** Recompute and draw the path for `anim` (null clears the overlay).
   *  `getProgress` reads the page's current scrub position, used by the LIVE
   *  agreement check. */
  show(anim: LensAnimation | null, getProgress: () => number): Promise<void>;
  setVisible(on: boolean): void;
  // Programmatic analysis (dev/analysis.ts) — every-piece sampling, plain-JSON
  // results, each carrying its coverage + idle-check lines. Also reachable from
  // the console/driver as `window.__lensPaths` while the toggle is on.
  /** Walk `animId` and return per-piece/per-rank motion analysis. Pass
   *  `{ timeline: false }` to drop the bulky per-step arrays. */
  analyze(
    animId: string,
    opts?: { timeline?: boolean },
  ): Promise<AnalysisResult>;
  /** Walk BOTH animations over the same sample set: per-piece divergence at
   *  equal p + per-rank radial envelopes. */
  compare(idA: string, idB: string): Promise<CompareResult>;
  /** Adjacent-seat-rank radial band overlaps while both pieces are in flight. */
  interference(animId: string): Promise<InterferenceResult>;
  /** Which wedge corner departs the seated surface last (leads the stick), per
   *  shell, in each of two animations (defaults: assemble vs rollout). */
  curlCorners(idA?: string, idB?: string): Promise<CurlCornerResult>;
  dispose(): void;
}

/** The plain (non-`*Target`) channel names of SceneState. */
type Channel = Exclude<keyof SceneState, `${string}Target`>;

const wrapPi = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

/** Stretch ratio → colour. 1.0 green, >1 red (pulled), <1 blue (crushed). */
function stretchColor(ratio: number, out: THREE.Color): THREE.Color {
  const d = clamp01(Math.abs(ratio - 1) / 0.5); // saturate at ±50%
  return out.setHSL(ratio >= 1 ? 0.33 * (1 - d) : 0.33 + 0.29 * d, 0.85, 0.5);
}

interface Sheet {
  mesh: THREE.Mesh;
  /** index of this sheet's first sample in the flat sample list */
  first: number;
  /** [a, b] sample-index pairs of the grid's edges */
  edges: [number, number][];
}

/**
 * Choose GRID_U × GRID_V sample points on a wedge — REAL mesh vertices nearest
 * a parametric grid over the wedge's own (arc, axial) extent, not synthesized
 * ones. Real vertices mean the "now" markers land exactly on the rendered
 * surface, which is what makes the visual agreement check trustworthy.
 */
function pickSheetVertices(mesh: THREE.Mesh): number[] {
  const pos = mesh.geometry.getAttribute("position");
  // NOT negated: the classic `_bloomtheta0` was stored negated, the frame's t0
  // is the sector meridian as measured (ops/frames.ts).
  const t0 = frameOf(mesh.geometry)?.t0 ?? 0;
  const n = pos.count;
  const phi: number[] = [];
  const yy: number[] = [];
  const rr: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    phi.push(wrapPi(Math.atan2(z, x) - t0));
    yy.push(y);
    rr.push(Math.hypot(x, z));
  }
  // Keep the OUTER skin only: a wedge is a walled shell, and mixing inner-wall
  // vertices into the grid would make "edges" that cross the wall thickness.
  const rMin = Math.min(...rr);
  const rMax = Math.max(...rr);
  const cut = rMin + (rMax - rMin) * 0.7;
  let cand = [...Array(n).keys()].filter((i) => rr[i] >= cut);
  if (cand.length < GRID_U * GRID_V) cand = [...Array(n).keys()];

  const p0 = Math.min(...cand.map((i) => phi[i]));
  const p1 = Math.max(...cand.map((i) => phi[i]));
  const y0 = Math.min(...cand.map((i) => yy[i]));
  const y1 = Math.max(...cand.map((i) => yy[i]));
  const dp = p1 - p0 || 1;
  const dy = y1 - y0 || 1;

  const out: number[] = [];
  for (let j = 0; j < GRID_V; j++) {
    for (let i = 0; i < GRID_U; i++) {
      const tp = p0 + (dp * i) / (GRID_U - 1);
      const ty = y0 + (dy * j) / (GRID_V - 1);
      let best = cand[0];
      let bd = Infinity;
      for (const k of cand) {
        const a = (phi[k] - tp) / dp;
        const b = (yy[k] - ty) / dy;
        const d = a * a + b * b;
        if (d < bd) {
          bd = d;
          best = k;
        }
      }
      out.push(best);
    }
  }
  return out;
}

/** Pick one wedge mesh per target shell rank (inner / mid / outer). */
function pickSheetMeshes(model: THREE.Object3D): THREE.Mesh[] {
  const wedges: { mesh: THREE.Mesh; rank: number }[] = [];
  model.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !isSegWedge(o.name)) return;
    const frame = frameOf(o.geometry);
    if (!frame) return;
    wedges.push({ mesh: o, rank: frame.rank });
  });
  const picked: THREE.Mesh[] = [];
  for (const target of SHEET_RANKS) {
    let best: THREE.Mesh | null = null;
    let bd = Infinity;
    for (const w of wedges) {
      if (picked.includes(w.mesh)) continue;
      const d = Math.abs(w.rank - target);
      if (d < bd) {
        bd = d;
        best = w.mesh;
      }
    }
    if (best) picked.push(best);
  }
  return picked;
}

export function createPathViz(
  ctx: PathVizContext,
  onStatus: (text: string, ok: boolean) => void,
): PathViz {
  const meshes = pickSheetMeshes(ctx.model);
  const samples: ProbeSample[] = [];
  const sheets: Sheet[] = [];
  for (const mesh of meshes) {
    const first = samples.length;
    for (const v of pickSheetVertices(mesh)) samples.push({ mesh, vertex: v });
    const edges: [number, number][] = [];
    const at = (i: number, j: number) => first + j * GRID_U + i;
    for (let j = 0; j < GRID_V; j++) {
      for (let i = 0; i < GRID_U; i++) {
        if (i + 1 < GRID_U) edges.push([at(i, j), at(i + 1, j)]);
        if (j + 1 < GRID_V) edges.push([at(i, j), at(i, j + 1)]);
      }
    }
    sheets.push({ mesh, first, edges });
  }

  const count = samples.length;
  // rows = one per timestep, plus a final row reserved for the IDLE check
  const IDLE_ROW = STEPS;
  const walkProbe = createPositionProbe(ctx.renderer, samples, STEPS + 1);
  const liveProbe = createPositionProbe(ctx.renderer, samples, 1);
  const allEdges = sheets.flatMap((s) => s.edges);
  const restLen = allEdges.map(([a, b]) =>
    Math.hypot(
      walkProbe.seated[a * 3] - walkProbe.seated[b * 3],
      walkProbe.seated[a * 3 + 1] - walkProbe.seated[b * 3 + 1],
      walkProbe.seated[a * 3 + 2] - walkProbe.seated[b * 3 + 2],
    ),
  );

  // --- overlay objects -------------------------------------------------------
  const overlay = new THREE.Group();
  overlay.renderOrder = 999;
  overlay.visible = false;
  ctx.scene.add(overlay);

  const lineOpts = {
    depthTest: false,
    depthWrite: false,
    transparent: true,
    toneMapped: false,
  } as const;
  const pathMat = new THREE.LineBasicNodeMaterial({
    ...lineOpts,
    vertexColors: true,
  });
  const tickMat = new THREE.LineBasicNodeMaterial({
    ...lineOpts,
    color: 0x94a3b8,
    opacity: 0.7,
  });
  const nowMat = new THREE.LineBasicNodeMaterial({
    ...lineOpts,
    color: 0xff5a1f,
  });

  const pathGeo = new THREE.BufferGeometry();
  const tickGeo = new THREE.BufferGeometry();
  const nowGeo = new THREE.BufferGeometry();
  const pathLines = new THREE.LineSegments(pathGeo, pathMat);
  const tickLines = new THREE.LineSegments(tickGeo, tickMat);
  const nowLines = new THREE.LineSegments(nowGeo, nowMat);
  for (const o of [pathLines, tickLines, nowLines]) {
    o.frustumCulled = false;
    overlay.add(o);
  }

  const nowPos = new Float32Array(allEdges.length * 2 * 3);
  nowGeo.setAttribute("position", new THREE.BufferAttribute(nowPos, 3));

  // --- state -----------------------------------------------------------------
  // The channel names, derived from the live state object rather than
  // re-listed here — core/scene's CHANNEL_DEFAULTS stays the one registry.
  const channels = Object.keys(ctx.state).filter(
    (k) => !k.endsWith("Target"),
  ) as Channel[];
  /** the walk, in each sample's own MESH-LOCAL space: [step][sample] */
  let localPath: Float32Array | null = null;
  let peakStretch = 1;
  let idleErr = 0;
  let liveErr = 0;
  let liveSettled = false;
  let getProgress: () => number = () => 0;
  let busy = false;
  let compiled = false;
  let failure: string | null = null;
  /** what the panel's checkbox asked for — a recompute must not un-hide */
  let wanted = false;
  const syncVisible = () => {
    overlay.visible = wanted && localPath != null;
  };

  const tmpV = new THREE.Vector3();
  const tmpC = new THREE.Color();

  const snapshot = () => ({ ...ctx.state }) as SceneState;
  const restore = (snap: SceneState) => {
    for (const c of channels) ctx.state[c] = snap[c];
    ctx.driveChannels();
  };

  function report() {
    if (failure) return onStatus(failure, false);
    const ok =
      idleErr <= IDLE_TOL_MM && (!liveSettled || liveErr <= LIVE_TOL_MM);
    const live = liveSettled ? `${liveErr.toFixed(3)}mm` : "settling…";
    onStatus(
      localPath
        ? `${sheets.length} sheets · ${GRID_U}×${GRID_V} pts · ${STEPS} steps · ` +
            `peak stretch ${peakStretch.toFixed(3)} · idle Δ ${idleErr.toFixed(4)}mm · live Δ ${live}`
        : "no path — pick an animation",
      ok,
    );
  }

  /** Max |probe − reference| over every sample, in model mm. */
  function maxDelta(probed: Float32Array, ref: Float32Array, off = 0): number {
    let m = 0;
    for (let i = 0; i < count; i++) {
      const d = Math.hypot(
        probed[i * 3] - ref[off + i * 3],
        probed[i * 3 + 1] - ref[off + i * 3 + 1],
        probed[i * 3 + 2] - ref[off + i * 3 + 2],
      );
      if (d > m) m = d;
    }
    return m;
  }

  async function show(anim: LensAnimation | null, progress: () => number) {
    getProgress = progress;
    if (!anim) {
      localPath = null;
      syncVisible();
      report();
      ctx.invalidate();
      return;
    }
    if (busy) return;
    busy = true;
    failure = null;
    const snap = snapshot();
    try {
      if (!compiled) {
        await walkProbe.compile();
        await liveProbe.compile();
        compiled = true;
      }
      const matrices: THREE.Matrix4[][] = [];
      walkProbe.begin();
      for (let k = 0; k < STEPS; k++) {
        const scratch = snapshot();
        anim.apply(k / (STEPS - 1), scratch);
        for (const c of channels) ctx.state[c] = scratch[`${c}Target`];
        ctx.driveChannels();
        ctx.model.updateWorldMatrix(true, true);
        matrices.push(sheets.map((s) => s.mesh.matrixWorld.clone()));
        walkProbe.renderRow(k);
      }
      // IDLE CHECK: every deformation channel at 0 ⇒ the shader is an exact
      // identity, so this row must come back as the seated geometry. The zero
      // list is DERIVED from the one channel registry (core/scene
      // IDLE_ZERO_CHANNELS) — it must name EVERY recipe channel, and a missing
      // one inherits the LIVE page value (the page restores animation +
      // progress from storage), turning this contractual check into a false
      // alarm (measured 43mm on a mid-scrub bend back when the list was
      // hand-kept). Deriving it means a new deform channel can't silently fall out.
      for (const c of channels) ctx.state[c] = snap[c];
      for (const c of IDLE_ZERO_CHANNELS) ctx.state[c] = 0;
      ctx.driveChannels();
      walkProbe.renderRow(IDLE_ROW);
      walkProbe.end();

      const read = await walkProbe.read(STEPS + 1);
      localPath = read;
      idleErr = maxDelta(read.subarray(IDLE_ROW * count * 3), walkProbe.seated);
      if (idleErr > IDLE_TOL_MM) {
        console.error(
          `lens paths: IDLE CHECK FAILED — the probe reads ${idleErr.toFixed(4)}mm off the seated ` +
            `geometry where the deformation graph is contractually an identity. The drawn paths do ` +
            `NOT describe the rendered shader; fix the probe before trusting them.`,
        );
      }
      buildGeometry(matrices);
      syncVisible();
    } catch (err) {
      // A path that failed to build must never be left on screen looking real.
      localPath = null;
      syncVisible();
      failure = "path walk failed — see console";
      console.error("lens paths: walk failed", err);
    } finally {
      restore(snap);
      busy = false;
      ctx.invalidate();
      report();
    }
  }

  /** Turn the read-back walk into the overlay's line geometry. */
  function buildGeometry(matrices: THREE.Matrix4[][]) {
    const path = localPath!;
    // world-space track, [step][sample]
    const world = new Float32Array(STEPS * count * 3);
    for (let k = 0; k < STEPS; k++) {
      sheets.forEach((s, si) => {
        const m = matrices[k][si];
        for (let i = s.first; i < s.first + GRID_U * GRID_V; i++) {
          const o = (k * count + i) * 3;
          tmpV.set(path[o], path[o + 1], path[o + 2]).applyMatrix4(m);
          world[o] = tmpV.x;
          world[o + 1] = tmpV.y;
          world[o + 2] = tmpV.z;
        }
      });
    }

    // per-sample stretch = the incident grid edge furthest from rest length
    const stretch = new Float32Array(STEPS * count).fill(1);
    peakStretch = 1;
    for (let k = 0; k < STEPS; k++) {
      allEdges.forEach(([a, b], e) => {
        if (restLen[e] < 1e-6) return;
        const oa = (k * count + a) * 3;
        const ob = (k * count + b) * 3;
        const ratio =
          Math.hypot(
            path[oa] - path[ob],
            path[oa + 1] - path[ob + 1],
            path[oa + 2] - path[ob + 2],
          ) / restLen[e];
        peakStretch = Math.max(peakStretch, ratio);
        for (const s of [a, b]) {
          const idx = k * count + s;
          if (Math.abs(ratio - 1) > Math.abs(stretch[idx] - 1))
            stretch[idx] = ratio;
        }
      });
    }

    const segs = (STEPS - 1) * count;
    const pp = new Float32Array(segs * 6);
    const pc = new Float32Array(segs * 6);
    let w = 0;
    for (let k = 0; k + 1 < STEPS; k++) {
      for (let i = 0; i < count; i++) {
        for (const step of [k, k + 1]) {
          const o = (step * count + i) * 3;
          pp[w] = world[o];
          pp[w + 1] = world[o + 1];
          pp[w + 2] = world[o + 2];
          stretchColor(stretch[step * count + i], tmpC);
          pc[w] = tmpC.r;
          pc[w + 1] = tmpC.g;
          pc[w + 2] = tmpC.b;
          w += 3;
        }
      }
    }
    pathGeo.setAttribute("position", new THREE.BufferAttribute(pp, 3));
    pathGeo.setAttribute("color", new THREE.BufferAttribute(pc, 3));

    // time ticks: a 3-axis cross every TICK_EVERY steps — bunched ticks read
    // directly as "slow here", spread-out ticks as "fast here"
    const ticks: number[] = [];
    for (let k = 0; k < STEPS; k += TICK_EVERY) {
      for (let i = 0; i < count; i++) {
        const o = (k * count + i) * 3;
        for (let ax = 0; ax < 3; ax++) {
          for (const sign of [-1, 1]) {
            ticks.push(
              world[o] + (ax === 0 ? sign * TICK_LEN : 0),
              world[o + 1] + (ax === 1 ? sign * TICK_LEN : 0),
              world[o + 2] + (ax === 2 ? sign * TICK_LEN : 0),
            );
          }
        }
      }
    }
    tickGeo.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(ticks), 3),
    );
  }

  /**
   * LIVE agreement: probe the SAME graph at whatever uniforms the last rendered
   * frame used, draw the resulting sheet grid, and compare it against the
   * cached path at the current progress. A mismatch means the drawn path is no
   * longer the thing on screen.
   */
  async function sampleLive() {
    if (busy || !localPath || !overlay.visible) return;
    busy = true;
    try {
      liveProbe.begin();
      liveProbe.renderRow(0);
      liveProbe.end();
      const live = await liveProbe.read(1);

      let w = 0;
      for (const [a, b] of allEdges) {
        for (const i of [a, b]) {
          tmpV
            .set(live[i * 3], live[i * 3 + 1], live[i * 3 + 2])
            .applyMatrix4(matrixFor(i));
          nowPos[w] = tmpV.x;
          nowPos[w + 1] = tmpV.y;
          nowPos[w + 2] = tmpV.z;
          w += 3;
        }
      }
      nowGeo.getAttribute("position").needsUpdate = true;
      nowGeo.computeBoundingSphere();

      // Strict: the per-shell assemble windows are narrow enough that a
      // 1e-3 channel residual is worth a visible fraction of a millimetre, and
      // that would be charged to the path instead of to the easing.
      liveSettled = channels.every(
        (c) => Math.abs(ctx.state[c] - ctx.state[`${c}Target`]) < 1e-5,
      );
      if (liveSettled) {
        // Reference = the cached walk resampled at the same progress. CATMULL-
        // ROM, not linear: on a fast segment the chord between two of the 64
        // samples sits millimetres inside the true curve, and that sag is a
        // property of the sampling rate, not drift — reporting it would bury
        // the signal this check exists for.
        const f = clamp01(getProgress()) * (STEPS - 1);
        const k1 = Math.min(STEPS - 1, Math.floor(f));
        const t = f - k1;
        const row = (k: number) =>
          Math.min(STEPS - 1, Math.max(0, k)) * count * 3;
        const r0 = row(k1 - 1);
        const r1 = row(k1);
        const r2 = row(k1 + 1);
        const r3 = row(k1 + 2);
        const ref = new Float32Array(count * 3);
        for (let i = 0; i < count * 3; i++) {
          const p0 = localPath[r0 + i];
          const p1 = localPath[r1 + i];
          const p2 = localPath[r2 + i];
          const p3 = localPath[r3 + i];
          ref[i] =
            0.5 *
            (2 * p1 +
              (p2 - p0) * t +
              (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t +
              (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
        }
        liveErr = maxDelta(live, ref);
        if (liveErr > LIVE_TOL_MM) {
          console.warn(
            `lens paths: LIVE CHECK — the rendered pose is ${liveErr.toFixed(3)}mm off the drawn ` +
              `path at this progress. The path is stale (re-select the animation) or the walk ran ` +
              `with different uniforms than the render.`,
          );
        }
      }
      report();
      ctx.invalidate();
    } finally {
      busy = false;
    }
  }

  /** matrixWorld of the sheet a sample belongs to. */
  function matrixFor(sample: number): THREE.Matrix4 {
    const s = sheets[Math.floor(sample / (GRID_U * GRID_V))];
    return s.mesh.matrixWorld;
  }

  // ~8Hz is plenty for a health readout and keeps the readbacks off the frame
  const timer = window.setInterval(() => void sampleLive(), 120);
  report();

  // --- programmatic analysis (dev/analysis.ts) -------------------------------
  // Built lazily on first use (its every-mesh probe is bigger than the overlay's
  // 3-sheet one), and serialized behind the SAME busy flag as the walk/live
  // probes — an analysis walk drives the whole rig, and the live sampler
  // reading mid-walk would compare a half-driven pose against the drawn path.
  let analysis: PathAnalysis | null = null;
  const getAnalysis = () => (analysis ??= createPathAnalysis(ctx));
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      while (busy) await new Promise((r) => setTimeout(r, 30));
      busy = true;
      try {
        return await fn();
      } finally {
        busy = false;
        ctx.invalidate();
      }
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const api: PathViz = {
    show,
    setVisible(on) {
      wanted = on;
      syncVisible();
      ctx.invalidate();
    },
    analyze: (animId, opts) =>
      exclusive(() => getAnalysis().analyze(animId, opts)),
    compare: (idA, idB) => exclusive(() => getAnalysis().compare(idA, idB)),
    interference: (animId) =>
      exclusive(() => getAnalysis().interference(animId)),
    curlCorners: (idA, idB) =>
      exclusive(() => getAnalysis().curlCorners(idA, idB)),
    dispose() {
      window.clearInterval(timer);
      const w = window as unknown as { __lensPaths?: PathViz };
      if (w.__lensPaths === api) delete w.__lensPaths;
      ctx.scene.remove(overlay);
      for (const g of [pathGeo, tickGeo, nowGeo]) g.dispose();
      for (const m of [pathMat, tickMat, nowMat]) m.dispose();
      walkProbe.dispose();
      liveProbe.dispose();
      analysis?.dispose();
    },
  };
  // Dev hook: drive the analysis from the console / an automation driver while
  // the Motion-paths toggle is on. Dev-only by construction — this module only
  // loads through scene.enablePathViz()'s dynamic import.
  (window as unknown as { __lensPaths?: PathViz }).__lensPaths = api;
  return api;
}
