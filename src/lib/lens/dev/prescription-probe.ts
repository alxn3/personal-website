import * as THREE from "three/webgpu";
import { isGlassElement } from "../core/parts";

// Dev only, dynamically imported. Measures each `Element_*` glass mesh and
// prints a PRESCRIPTION table for optics/prescription.ts: vertices are split
// into front/rear surfaces by normal and each is sphere-fitted. Run only with
// every channel at its default.

/** Normal Y above which a vertex is on the front surface (below −this: rear);
 *  anything between is rim. */
const NORMAL_MIN = 0.35;
/** A surface flatter than this (mm of Y spread) is reported as a plane, c = 0. */
const FLAT_SPREAD_MM = 0.05;
/** Fewer surface vertices than this are reported as a plane. */
const MIN_CAP_POINTS = 12;

export interface ProbeSurface {
  /** curvature 1/mm; centre of curvature at yMm + 1/c. 0 = flat. */
  c: number;
  /** axial vertex position, gltf-frame mm */
  yMm: number;
  /** clear semi-diameter (max radial extent of the surface), mm */
  apertureMm: number;
  /** diagnostic: RMS distance of the vertices from the fitted sphere, mm */
  rmsMm: number;
  /** diagnostic: distance of the fitted centre from the optical axis, mm */
  axisOffMm: number;
}

export interface ProbeEntry {
  id: string;
  front: ProbeSurface;
  rear: ProbeSurface;
}

/** Solve m·x = b by Gaussian elimination; null if singular. */
function solve(m: number[][], b: number[]): number[] | null {
  const n = b.length;
  const a = m.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++)
      if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    if (Math.abs(a[piv][col]) < 1e-12) return null;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / a[col][col];
      for (let k = col; k <= n; k++) a[r][k] -= f * a[col][k];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = a[r][n];
    for (let k = r + 1; k < n; k++) s -= a[r][k] * x[k];
    x[r] = s / a[r][r];
  }
  return x;
}

/** Least-squares sphere fit (Coope's linear method) over flat xyz triples:
 *  solves |p|² = 2c·p + k for centre c, with radius² = k + |c|². */
function fitSphere(
  pts: number[],
): { cx: number; cy: number; cz: number; r: number } | null {
  const n = pts.length / 3;
  if (n < MIN_CAP_POINTS) return null;
  const M = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  const rhs = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3];
    const y = pts[i * 3 + 1];
    const z = pts[i * 3 + 2];
    const row = [2 * x, 2 * y, 2 * z, 1];
    const t = x * x + y * y + z * z;
    for (let r = 0; r < 4; r++) {
      rhs[r] += row[r] * t;
      for (let c = 0; c < 4; c++) M[r][c] += row[r] * row[c];
    }
  }
  const s = solve(M, rhs);
  if (!s) return null;
  const [cx, cy, cz, k] = s;
  const r2 = k + cx * cx + cy * cy + cz * cz;
  if (!(r2 > 0)) return null;
  return { cx, cy, cz, r: Math.sqrt(r2) };
}

const round = (v: number, p: number) =>
  Number.isFinite(v) ? Number(v.toFixed(p)) : 0;

/** One classified vertex set (flat xyz triples) → one surface record. */
function probeSurface(pts: number[]): ProbeSurface {
  let yMin = Infinity;
  let yMax = -Infinity;
  let apertureMm = 0;
  // The surface's axial position is that of its vertex nearest the axis.
  let bestR = Infinity;
  let yMm = 0;
  for (let i = 0; i < pts.length; i += 3) {
    const y = pts[i + 1];
    const r = Math.hypot(pts[i], pts[i + 2]);
    yMin = Math.min(yMin, y);
    yMax = Math.max(yMax, y);
    apertureMm = Math.max(apertureMm, r);
    if (r < bestR) {
      bestR = r;
      yMm = y;
    }
  }
  const flat: ProbeSurface = {
    c: 0,
    yMm: round(yMm, 3),
    apertureMm: round(apertureMm, 3),
    rmsMm: 0,
    axisOffMm: 0,
  };
  if (yMax - yMin < FLAT_SPREAD_MM) return flat;
  const fit = fitSphere(pts);
  if (!fit) return flat;
  // Centre at yMm + 1/c, so c = 1 / (centre.y − yMm).
  const dy = fit.cy - yMm;
  if (Math.abs(dy) < 1e-6) return flat;
  let sum = 0;
  const n = pts.length / 3;
  for (let i = 0; i < pts.length; i += 3) {
    const d =
      Math.hypot(pts[i] - fit.cx, pts[i + 1] - fit.cy, pts[i + 2] - fit.cz) -
      fit.r;
    sum += d * d;
  }
  return {
    ...flat,
    c: round(1 / dy, 6),
    rmsMm: round(Math.sqrt(sum / n), 3),
    axisOffMm: round(Math.hypot(fit.cx, fit.cz), 3),
  };
}

/** Measure every `Element_*` mesh under `root`, front-to-rear (descending Y). */
export function probePrescription(root: THREE.Object3D): ProbeEntry[] {
  const out: ProbeEntry[] = [];
  const v = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  root.updateWorldMatrix(true, true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || !isGlassElement(o.name)) return;
    const pos = o.geometry.getAttribute("position");
    if (!pos) return;
    const nor = o.geometry.getAttribute("normal");
    if (!nor) {
      console.warn(
        `[lens] prescription probe: ${o.name} has no normal attribute — skipped`,
      );
      return;
    }
    // Mesh-local to GLB-root space (millimetres).
    const m = new THREE.Matrix4().multiplyMatrices(toRoot, o.matrixWorld);
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const front: number[] = [];
    const rear: number[] = [];
    for (let i = 0; i < pos.count; i++) {
      nrm
        .fromBufferAttribute(nor as THREE.BufferAttribute, i)
        .applyMatrix3(nm)
        .normalize();
      if (Math.abs(nrm.y) < NORMAL_MIN) continue; // rim / chamfer
      v.fromBufferAttribute(pos as THREE.BufferAttribute, i).applyMatrix4(m);
      (nrm.y > 0 ? front : rear).push(v.x, v.y, v.z);
    }
    out.push({
      id: o.name,
      front: probeSurface(front),
      rear: probeSurface(rear),
    });
  });
  out.sort((a, b) => b.front.yMm - a.front.yMm);
  return out;
}

/** Expose the probe on the console as `window.__lensPrescriptionProbe()`. */
export function installPrescriptionProbe(root: THREE.Object3D): void {
  (window as unknown as Record<string, unknown>).__lensPrescriptionProbe =
    () => {
      const entries = probePrescription(root);
      console.log(
        `[lens] prescription probe: ${entries.length} Element_* meshes (front→rear)`,
      );
      console.log(JSON.stringify(entries, null, 2));
      return entries;
    };
}
