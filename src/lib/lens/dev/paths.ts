import * as THREE from "three/webgpu";
import type { LensAnimation } from "../animations";
import { IDLE_ZERO_CHANNELS } from "../core/scene";
import type { SceneState } from "../core/scene";
import { isSegWedge } from "../core/parts";
import { frameOf, wrapPi } from "../ops/frames";
import { createPositionProbe, type ProbeSample } from "./path-probe";
import {
  argmax,
  createPathAnalysis,
  dist3,
  extent,
  gridPick,
  type PathAnalysis,
} from "./analysis";

// Dev only, dynamically imported. The /lens "Motion paths" overlay: for three
// shell wedges it draws the track of a grid of points through the selected
// animation, coloured by stretch (green = none, red = pulled, blue = crushed),
// with time ticks and the live deformed grid ("now").
//
// Positions come from the GPU probe running the real deform shader, plus each
// mesh's matrixWorld. Two self-checks:
//   idle: with every deform channel at 0 the probe must return the rest pose.
//   live: the "now" grid must match the drawn path at the current progress.

const STEPS = 96; // timesteps sampled across the animation's 0..1 progress
const GRID_U = 5; // sample columns across a wedge (its arc)
const GRID_V = 3; // sample rows up a wedge (its axial extent)
const SHEET_RANKS = [0, 0.5, 1]; // inner, middle and outer shell
const TICK_EVERY = 8; // draw a time tick every N steps
const TICK_LEN = 0.012; // world units (the lens is ~4 world units long)
// Tolerances in model millimetres.
const IDLE_TOL_MM = 0.01;
const LIVE_TOL_MM = 1;

export interface PathVizContext {
  renderer: THREE.WebGPURenderer;
  /** Scene the overlay is added to. */
  scene: THREE.Scene;
  /** Loaded GLB root. */
  model: THREE.Object3D;
  state: SceneState;
  /** Push `state`'s channel values into the rig and shader uniforms. */
  driveChannels: () => void;
  invalidate: () => void;
  /** Default value of every channel. */
  channelDefaults: Readonly<Record<string, number>>;
}

/** The overlay plus the JSON analysis, on the console as `window.__lensPaths`. */
export interface PathViz extends PathAnalysis {
  /** Walk and draw `anim` (null clears). `getProgress` reads the page's
   *  scrub position for the live check. */
  show(anim: LensAnimation | null, getProgress: () => number): Promise<void>;
  setVisible(on: boolean): void;
}

type Channel = Exclude<keyof SceneState, `${string}Target`>;

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

/** GRID_U × GRID_V real vertices spread over a wedge's arc and length. */
function pickSheetVertices(mesh: THREE.Mesh): number[] {
  const pos = mesh.geometry.getAttribute("position");
  const t0 = frameOf(mesh.geometry)?.t0 ?? 0;
  const all = [...Array(pos.count).keys()];
  const phi = all.map((i) => wrapPi(Math.atan2(pos.getZ(i), pos.getX(i)) - t0));
  const yy = all.map((i) => pos.getY(i));
  const rr = all.map((i) => Math.hypot(pos.getX(i), pos.getZ(i)));
  // Outer skin only, so no grid edge crosses the wall thickness.
  const [rMin, rMax] = extent(all, rr);
  const cut = rMin + (rMax - rMin) * 0.7;
  let cand = all.filter((i) => rr[i] >= cut);
  if (cand.length < GRID_U * GRID_V) cand = all;
  return gridPick(cand, phi, yy, GRID_U, GRID_V);
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
    const left = wedges.filter((w) => !picked.includes(w.mesh));
    if (left.length)
      picked.push(argmax(left, (w) => -Math.abs(w.rank - target)).mesh);
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
  // One row per step, plus a final row for the idle check.
  const IDLE_ROW = STEPS;
  const walkProbe = createPositionProbe(ctx.renderer, samples, STEPS + 1);
  const liveProbe = createPositionProbe(ctx.renderer, samples, 1);
  const allEdges = sheets.flatMap((s) => s.edges);
  const restLen = allEdges.map(([a, b]) =>
    dist3(walkProbe.seated, a * 3, walkProbe.seated, b * 3),
  );

  // --- overlay ---
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

  // --- state ---
  const channels = Object.keys(ctx.state).filter(
    (k) => !k.endsWith("Target"),
  ) as Channel[];
  /** the walk in each sample's mesh-local space, [step][sample] */
  let localPath: Float32Array | null = null;
  let peakStretch = 1;
  let idleErr = 0;
  let liveErr = 0;
  let liveSettled = false;
  let getProgress: () => number = () => 0;
  let busy = false;
  let compiled = false;
  let failure: string | null = null;
  /** the checkbox state; a recompute must not un-hide the overlay */
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
  function maxDelta(probed: Float32Array, ref: Float32Array): number {
    let m = 0;
    for (let i = 0; i < count * 3; i += 3) {
      const d = dist3(probed, i, ref, i);
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
      // Idle row: every deform channel at 0, so the shader is an identity.
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
      // Never leave a failed path on screen.
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
    // WebGPU frees replaced attribute buffers only on dispose(); the geometry
    // stays usable afterwards.
    pathGeo.dispose();
    tickGeo.dispose();
    const path = localPath!;
    // world-space track, [step][sample]
    const world = new Float32Array(STEPS * count * 3);
    for (let k = 0; k < STEPS; k++) {
      sheets.forEach((s, si) => {
        const m = matrices[k][si];
        for (let i = s.first; i < s.first + GRID_U * GRID_V; i++) {
          const o = (k * count + i) * 3;
          tmpV.fromArray(path, o).applyMatrix4(m).toArray(world, o);
        }
      });
    }

    // A sample's stretch is that of its most-stretched grid edge.
    const stretch = new Float32Array(STEPS * count).fill(1);
    peakStretch = 1;
    for (let k = 0; k < STEPS; k++) {
      allEdges.forEach(([a, b], e) => {
        if (restLen[e] < 1e-6) return;
        const ratio =
          dist3(path, (k * count + a) * 3, path, (k * count + b) * 3) /
          restLen[e];
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

    // Time ticks: a 3-axis cross every TICK_EVERY steps.
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

  /** Probe the live pose, draw it as the "now" grid, and compare it with the
   *  drawn path at the current progress. */
  async function sampleLive() {
    if (busy || !localPath || !overlay.visible) return;
    busy = true;
    try {
      liveProbe.begin();
      liveProbe.renderRow(0);
      liveProbe.end();
      const live = await liveProbe.read(1);

      allEdges.flat().forEach((i, w) => {
        const sheet = sheets[Math.floor(i / (GRID_U * GRID_V))];
        tmpV
          .fromArray(live, i * 3)
          .applyMatrix4(sheet.mesh.matrixWorld)
          .toArray(nowPos, w * 3);
      });
      nowGeo.getAttribute("position").needsUpdate = true;
      nowGeo.computeBoundingSphere();

      // Only compare once every channel has reached its target.
      liveSettled = channels.every(
        (c) => Math.abs(ctx.state[c] - ctx.state[`${c}Target`]) < 1e-5,
      );
      if (liveSettled) {
        // The walk resampled at the current progress (Catmull-Rom, which
        // follows fast curved segments far better than linear).
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

  // Live check at ~8Hz.
  const timer = window.setInterval(() => void sampleLive(), 120);
  report();

  // The analysis is built on first use and shares the busy flag, since its
  // walks drive the whole rig.
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
  (window as unknown as { __lensPaths?: PathViz }).__lensPaths = api;
  return api;
}
