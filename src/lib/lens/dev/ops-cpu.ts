import type * as THREE from "three/webgpu";
import {
  liveRecipes,
  pieceFields,
  unspinDelta,
  type Delta,
} from "../ops/cpu";
import { recipeChannels, recipeKnobs, RECIPE_NAMES } from "../ops/host";

// Dev only — dynamically imported. The whole-geometry CPU deform, for
// dev/inspect.ts: the per-vertex sweep that fills a picking proxy, the decal
// shrink-wrap binding it reproduces, and the state key its rebuild policy uses.
// The evaluation itself lives in ops/cpu.ts.

/** The live op state as one comparable string — every recipe channel and knob.
 *  The mechanism channels are absent: they drive real object transforms, so no
 *  vertex moves in local space because of them. */
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
 * Write `geo`'s vertex positions as the shader places them into `out`
 * (xyz-packed, length 3 × position.count), in the geometry's own mesh-local
 * space — object transforms are not applied.
 *
 * `mesh` is the geometry's owner, read for its mechanism spin tag; omit it and
 * a spin-tagged mesh's vertices land where they would without the
 * counter-rotation. A geometry without the `_op*` frame attributes is copied
 * through seated.
 */
export function displaceInto(
  geo: THREE.BufferGeometry,
  out: Float32Array,
  mesh?: THREE.Object3D | null,
): void {
  const pos = geo.getAttribute("position");
  const n = pos.count;
  // The decal shrink-wrap binding (ops/frames.ts): present only on decals.
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
      // The shrink-wrap binding, mirroring host.ts: rebuild this decal vertex
      // from its host triangle's deformed corners, so picking rides the same
      // faceted surface the render does.
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
