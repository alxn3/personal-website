import * as THREE from "three/webgpu";
import { attribute, uniform, varying, vec4 } from "three/tsl";
import { opsLocalPosition } from "../ops/host";
import { FRAME_ATTRS } from "../ops/frames";

// DEV ONLY — dynamically imported, so none of it reaches a visitor's bundle.
// Reads back where the REAL deformation shader puts a chosen set of vertices.
//
// The design rule: this module contains NO deformation math. It runs
// `opsLocalPosition()` — the node graph ops/host.ts hands the model's materials
// — on a throwaway mesh whose vertices are laid out one per PIXEL of a float
// render target, then reads the pixels back. Nothing to drift from.
//
// Layout: one COLUMN per sample point, one ROW per timestep. Callers set the
// uniforms for a step, call renderRow(k), and read every row back in ONE
// transfer. The step index is written into ALPHA so readback is independent of
// the backend's row order — the row a pixel came from is in the pixel.

/** One probe point: a real vertex of a real frame-carrying mesh. */
export interface ProbeSample {
  mesh: THREE.Mesh;
  /** index into `mesh.geometry`'s position attribute */
  vertex: number;
}

export interface PositionProbe {
  /** columns = probe points */
  readonly count: number;
  /** rows = timesteps this probe can hold */
  readonly rows: number;
  /** Seated (rest) local position of each sample, xyz-packed. */
  readonly seated: Float32Array;
  /** Compile the probe pipeline. Call once before the first renderRow — a
   *  WebGPU pipeline that isn't ready yet would render an empty row. */
  compile(): Promise<void>;
  /** Begin a batch: binds the target and stops the renderer clearing between
   *  rows. Must be paired with `end()`. */
  begin(): void;
  /** Evaluate the deformation graph at the CURRENT uniform/transform state and
   *  write it into row `row`. */
  renderRow(row: number): void;
  end(): void;
  /** Read `rowCount` rows back. Returns `[row][sample] → vec3` in each sample's
   *  own MESH-LOCAL space, indexed by the row written into alpha (so a
   *  backend row flip cannot silently transpose the result). */
  read(rowCount: number): Promise<Float32Array>;
  dispose(): void;
}

// Two triangles per sample, covering exactly one pixel of the target. Points
// would be a vertex cheaper but point SIZE is a backend-dependent mess (WGSL
// has no gl_PointSize); a quad is portable and this geometry is tiny anyway.
const CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
  [1, 1],
  [0, 1],
] as const;

/**
 * Build a probe over `samples`, able to hold `rows` timesteps. The geometry
 * copies each sample's seated `position` plus every `_op*` frame attribute the
 * graph reads, taken from ops/frames.ts's FRAME_ATTRS so a re-packed or new
 * attribute cannot fall out of the probe.
 *
 * A sample whose mesh is MISSING a frame attribute throws: uploading zeros
 * would put `R = 0` — a divisor all over the op algebra — into the graph and
 * hand back plausible-looking garbage rather than an obvious failure.
 */
export function createPositionProbe(
  renderer: THREE.WebGPURenderer,
  samples: ProbeSample[],
  rows: number,
): PositionProbe {
  const count = samples.length;
  const verts = count * CORNERS.length;

  const position = new Float32Array(verts * 3);
  const col = new Float32Array(verts);
  const corner = new Float32Array(verts * 2);
  const extra: Record<string, Float32Array> = Object.fromEntries(
    FRAME_ATTRS.map((a) => [a.name, new Float32Array(verts * a.size)]),
  );
  const seated = new Float32Array(count * 3);

  samples.forEach((s, i) => {
    const geo = s.mesh.geometry;
    const p = geo.getAttribute("position");
    for (const { name, size } of FRAME_ATTRS) {
      const a = geo.getAttribute(name);
      if (!a)
        throw new Error(
          `probe: mesh "${s.mesh.name || "(unnamed)"}" has no ${name} — ` +
            `ops/frames.ts did not run over it, and probing it with zeros ` +
            `would feed the op graph R = 0 (a divisor)`,
        );
      if (a.itemSize !== size)
        throw new Error(
          `probe: mesh "${s.mesh.name || "(unnamed)"}" has ${name} with ` +
            `itemSize ${a.itemSize}, expected ${size}`,
        );
    }
    const px = p.getX(s.vertex);
    const py = p.getY(s.vertex);
    const pz = p.getZ(s.vertex);
    seated[i * 3] = px;
    seated[i * 3 + 1] = py;
    seated[i * 3 + 2] = pz;
    for (let c = 0; c < CORNERS.length; c++) {
      const v = i * CORNERS.length + c;
      position[v * 3] = px;
      position[v * 3 + 1] = py;
      position[v * 3 + 2] = pz;
      col[v] = i;
      corner[v * 2] = CORNERS[c][0];
      corner[v * 2 + 1] = CORNERS[c][1];
      for (const { name, size } of FRAME_ATTRS) {
        const a = geo.getAttribute(name);
        for (let k = 0; k < size; k++)
          extra[name][v * size + k] = a.getComponent(s.vertex, k) as number;
      }
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("_probeCol", new THREE.BufferAttribute(col, 1));
  geometry.setAttribute("_probeCorner", new THREE.BufferAttribute(corner, 2));
  for (const { name, size } of FRAME_ATTRS) {
    geometry.setAttribute(name, new THREE.BufferAttribute(extra[name], size));
  }

  // Target WIDTH padded to a multiple of 16 texels: WebGPU requires a
  // texture→buffer copy's bytesPerRow to be a multiple of 256 and three hands
  // the readback back with that padding still in it, so an unpadded width would
  // shear every row. 16 × rgba32float = 256 bytes exactly.
  const texW = Math.ceil(count / 16) * 16;

  const uRow = uniform(0);
  // TSL attribute()/uniform() nodes carry math methods the .d.ts doesn't
  // declare — the same `any` escape hatch ops/host.ts uses.
  const c = attribute("_probeCol", "float") as any;
  const k = attribute("_probeCorner", "vec2") as any;
  const row = uRow as any;
  const ndcX = c.add(k.x).div(texW).mul(2).sub(1);
  const ndcY = row.add(k.y).div(rows).mul(2).sub(1);

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // vertexNode replaces the whole model-view-projection chain: this mesh is a
  // pixel layout, not something in the scene.
  material.vertexNode = vec4(ndcX, ndcY, 0, 1);
  // varying() forces the deformation to run in the VERTEX stage, exactly where
  // the real material runs it; alpha carries the row (offset by 1, so the
  // cleared value 0 reads as "never written") and makes readback self-
  // describing — no assumption about which way up the backend hands rows back.
  material.fragmentNode = vec4(varying(opsLocalPosition()) as any, row.add(1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const probeScene = new THREE.Scene();
  probeScene.add(mesh);
  // Any camera works — vertexNode discards the MVP chain entirely — but the
  // renderer still calls updateProjectionMatrix on it, which bare Camera lacks.
  const probeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const target = new THREE.RenderTarget(texW, rows, {
    type: THREE.FloatType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });

  let prevTarget: THREE.RenderTarget | null = null;
  let prevAutoClear = true;

  return {
    count,
    rows,
    seated,
    async compile() {
      // The target MUST be bound while compiling: compileAsync builds the
      // pipeline for the currently bound colour format, and a pipeline built
      // for the canvas is not the one a float target needs — the mismatch is
      // compiled lazily at draw time and the first rows come back empty.
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(target);
      await renderer.compileAsync(probeScene, probeCamera);
      renderer.setRenderTarget(prev);
    },
    begin() {
      prevTarget = renderer.getRenderTarget();
      prevAutoClear = renderer.autoClear;
      renderer.setRenderTarget(target);
      renderer.autoClear = false;
      // Clear once so anything the batch does NOT write reads as alpha 0, i.e.
      // "no row here" — see read().
      renderer.clear();
    },
    renderRow(r) {
      uRow.value = r;
      renderer.render(probeScene, probeCamera);
    },
    end() {
      renderer.setRenderTarget(prevTarget);
      renderer.autoClear = prevAutoClear;
    },
    async read(rowCount) {
      // Always transfer the FULL target: a partial read would depend on which
      // end of the texture the backend calls row 0. Alpha then says which
      // timestep each pixel belongs to, and unwritten pixels (alpha 0) drop out.
      const raw = (await renderer.readRenderTargetPixelsAsync(
        target,
        0,
        0,
        texW,
        rows,
      )) as Float32Array;
      const out = new Float32Array(rowCount * count * 3);
      const written = new Uint8Array(rowCount);
      for (let i = 0; i < rows * texW; i++) {
        const sample = i % texW;
        if (sample >= count) continue; // alignment padding, never drawn
        const r = Math.round(raw[i * 4 + 3]) - 1; // the row is IN the pixel
        if (r < 0 || r >= rowCount) continue;
        written[r] = 1;
        const o = (r * count + sample) * 3;
        out[o] = raw[i * 4];
        out[o + 1] = raw[i * 4 + 1];
        out[o + 2] = raw[i * 4 + 2];
      }
      // A row that never arrived would read as the origin and quietly poison
      // every derived number (a 0,0,0 "position" looks like a huge move and a
      // huge stretch). Refuse to hand back a partial result.
      const missing = [...written].flatMap((w, r) => (w ? [] : [r]));
      if (missing.length) {
        throw new Error(
          `probe rows [${missing.join(",")}] of ${rowCount} were never written — the readback is incomplete`,
        );
      }
      return out;
    },
    dispose() {
      geometry.dispose();
      material.dispose();
      target.dispose();
    },
  };
}
