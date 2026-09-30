import * as THREE from "three/webgpu";
import { attribute, uniform, varying, vec4 } from "three/tsl";
import { opsLocalPosition } from "../ops/host";
import { FRAME_ATTRS } from "../ops/frames";

// Dev only, dynamically imported. Reads back where the deform shader puts a set
// of vertices: it runs `opsLocalPosition()` on a mesh drawn one pixel per sample
// into a float render target (one column per sample, one row per step) and
// reads the pixels.

/** One probe point: a vertex of a mesh that carries the `_op*` frame. */
export interface ProbeSample {
  mesh: THREE.Mesh;
  /** index into `mesh.geometry`'s position attribute */
  vertex: number;
}

export interface PositionProbe {
  /** Seated (rest) local position of each sample, xyz-packed. */
  readonly seated: Float32Array;
  /** Call once before the first renderRow, or the first rows come back empty. */
  compile(): Promise<void>;
  /** Bind the target and stop auto-clear; pair with `end()`. */
  begin(): void;
  /** Evaluate the deform at the current uniforms into row `row`. */
  renderRow(row: number): void;
  end(): void;
  /** Read `rowCount` rows as `[row][sample]` xyz in each sample's mesh-local
   *  space. Throws if any row is missing. */
  read(rowCount: number): Promise<Float32Array>;
  dispose(): void;
}

// Two triangles per sample, covering one pixel (point size is not portable).
const CORNERS = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 0],
  [1, 1],
  [0, 1],
] as const;

/** A probe over `samples` holding `rows` steps. Throws if a sample's mesh
 *  lacks a frame attribute (zeros would give R = 0, a divisor in the ops). */
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
    const meshName = s.mesh.name || "(unnamed)";
    const attrs = FRAME_ATTRS.map(({ name, size }) => {
      const a = geo.getAttribute(name);
      if (!a)
        throw new Error(
          `probe: mesh "${meshName}" has no ${name} — ` +
            `ops/frames.ts did not run over it, and probing it with zeros ` +
            `would feed the op graph R = 0 (a divisor)`,
        );
      if (a.itemSize !== size)
        throw new Error(
          `probe: mesh "${meshName}" has ${name} with ` +
            `itemSize ${a.itemSize}, expected ${size}`,
        );
      return { name, size, a };
    });
    const p = geo.getAttribute("position");
    const xyz = [p.getX(s.vertex), p.getY(s.vertex), p.getZ(s.vertex)];
    seated.set(xyz, i * 3);
    for (let c = 0; c < CORNERS.length; c++) {
      const v = i * CORNERS.length + c;
      position.set(xyz, v * 3);
      col[v] = i;
      corner.set(CORNERS[c], v * 2);
      for (const { name, size, a } of attrs)
        for (let k = 0; k < size; k++)
          extra[name][v * size + k] = a.getComponent(s.vertex, k) as number;
    }
  });

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(position, 3));
  geometry.setAttribute("_probeCol", new THREE.BufferAttribute(col, 1));
  geometry.setAttribute("_probeCorner", new THREE.BufferAttribute(corner, 2));
  for (const { name, size } of FRAME_ATTRS) {
    geometry.setAttribute(name, new THREE.BufferAttribute(extra[name], size));
  }

  // Width padded to 16 texels (256 bytes of rgba32float), WebGPU's readback
  // row alignment.
  const texW = Math.ceil(count / 16) * 16;

  const uRow = uniform(0);
  // TSL node math methods are missing from the typings.
  const c = attribute("_probeCol", "float") as any;
  const k = attribute("_probeCorner", "vec2") as any;
  const row = uRow as any;
  const ndcX = c.add(k.x).div(texW).mul(2).sub(1);
  const ndcY = row.add(k.y).div(rows).mul(2).sub(1);

  const material = new THREE.NodeMaterial();
  material.depthTest = false;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // Place each sample straight in clip space (no camera transform).
  material.vertexNode = vec4(ndcX, ndcY, 0, 1);
  // varying() keeps the deform in the vertex stage, as in the real material.
  // Alpha stores row + 1, so a cleared pixel (0) reads as "never written".
  material.fragmentNode = vec4(varying(opsLocalPosition()) as any, row.add(1));

  const mesh = new THREE.Mesh(geometry, material);
  mesh.frustumCulled = false;
  const probeScene = new THREE.Scene();
  probeScene.add(mesh);
  // Unused by vertexNode, but the renderer needs a real camera.
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
    seated,
    async compile() {
      // Compile against the float target's format, not the canvas's.
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
      renderer.clear(); // unwritten pixels read as alpha 0
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
      // Read the whole target and place each pixel by the row in its alpha,
      // so a backend's row order does not matter.
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
        if (sample >= count) continue; // alignment padding
        const r = Math.round(raw[i * 4 + 3]) - 1;
        if (r < 0 || r >= rowCount) continue;
        written[r] = 1;
        const o = (r * count + sample) * 3;
        out[o] = raw[i * 4];
        out[o + 1] = raw[i * 4 + 1];
        out[o + 2] = raw[i * 4 + 2];
      }
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
