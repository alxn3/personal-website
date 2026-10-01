import type * as THREE from "three/webgpu";
import { liveRecipes, pieceFields, unspinDelta, type Delta } from "../ops/cpu";
import { recipeChannels, recipeKnobs, RECIPE_NAMES } from "../ops/host";

// Dev only, dynamically imported. Whole-geometry CPU deform for inspect.ts's
// picking proxies (the per-vertex math lives in ops/cpu.ts).

/** Every recipe channel and knob value as one string, to detect changes.
 *  Mechanism channels move whole objects, not vertices, so they are left out. */
export function opsStateKey(): string {
  const ch = recipeChannels();
  const kn = recipeKnobs();
  const parts: number[] = [];
  for (const name of RECIPE_NAMES) {
    parts.push(ch[name].value);
    for (const box of Object.values(kn[name])) parts.push(box.value);
  }
  return parts.join(",");
}

/**
 * Write `geo`'s vertices as the shader places them into `out` (xyz-packed),
 * in mesh-local space. `mesh` supplies the spin counter-rotation; without it
 * that step is skipped. Geometry without an `_op*` frame is copied unchanged.
 */
export function displaceInto(
  geo: THREE.BufferGeometry,
  out: Float32Array,
  mesh?: THREE.Object3D | null,
): void {
  const pos = geo.getAttribute("position");
  const n = pos.count;
  // Decals only: the host triangle each vertex is wrapped onto.
  const wa = geo.getAttribute("_wrapA");
  const wb = geo.getAttribute("_wrapB");
  const wc = geo.getAttribute("_wrapC");
  const live = liveRecipes();
  const fieldAt = live.length > 0 ? pieceFields(geo, live) : null;
  const delta: Delta = [0, 0, 0];

  for (let i = 0; i < n; i++) {
    const px = pos.getX(i);
    const py = pos.getY(i);
    const pz = pos.getZ(i);
    if (!fieldAt) {
      out[i * 3] = px;
      out[i * 3 + 1] = py;
      out[i * 3 + 2] = pz;
      continue;
    }
    const sampleAt = fieldAt(i);
    if (wa && wb && wc) {
      // Rebuild the decal vertex on its deformed host triangle, as host.ts does.
      const c0 = [wa.getX(i), wa.getY(i), wa.getZ(i)];
      const c1 = [wb.getX(i), wb.getY(i), wb.getZ(i)];
      const c2 = [wc.getX(i), wc.getY(i), wc.getZ(i)];
      const u = wa.getW(i);
      const v = wb.getW(i);
      const h = wc.getW(i);
      const w = 1 - u - v;
      const P = [c0, c1, c2].map((c) => {
        const d = sampleAt(c[0], c[1], c[2], delta);
        return [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
      });
      const e1 = [0, 1, 2].map((k) => P[1][k] - P[0][k]);
      const e2 = [0, 1, 2].map((k) => P[2][k] - P[0][k]);
      const nrm = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      const nl = Math.max(Math.hypot(nrm[0], nrm[1], nrm[2]), 1e-9);
      const seat = [px, py, pz];
      for (let k = 0; k < 3; k++)
        delta[k] =
          P[0][k] * u + P[1][k] * v + P[2][k] * w + (nrm[k] / nl) * h - seat[k];
    } else {
      sampleAt(px, py, pz, delta);
    }
    unspinDelta(mesh, delta);
    out[i * 3] = px + delta[0];
    out[i * 3 + 1] = py + delta[1];
    out[i * 3 + 2] = pz + delta[2];
  }
}
