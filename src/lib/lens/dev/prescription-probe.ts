import * as THREE from "three/webgpu";
import { isGlassElement } from "../core/parts";

// ============================================================================
// PRESCRIPTION PROBE — dev only, bench-run, imported by nothing that ships.
// Measures the shipped model's 13 optical elements and prints a paste-ready
// PRESCRIPTION table for optics/prescription.ts. House pattern is the same as
// dev/model-contract.ts and dev/inspect.ts: a dynamic import behind
// `import.meta.env.DEV` in core/scene.ts, console-invocable, read-only.
//
// METHOD (v2 — OUTWARD NORMAL): for each `Element_*` mesh, take its vertices
// into the GLB ROOT's frame (the gltf frame — optical axis +Y, real
// millimetres) and split them by the direction their OUTWARD NORMAL faces: a
// vertex is FRONT if its gltf-frame normal.y > +NORMAL_MIN, REAR if
// < −NORMAL_MIN, and rim/chamfer (excluded) in between. Each surface's vertex
// set is fitted with Coope's linear least squares. The fitted centre lies on
// the optical axis at yMm + 1/c, so the curvature comes out signed for free:
// c = 1 / (centre.y − yMm). A surface whose Y spread is under FLAT_SPREAD_MM is
// a plane and reports c = 0.
//
// WHY NOT Y-EXTREME CAP BANDS (the v1 method, wrong): the shipped elements are
// DOMED and NESTED. On a dome the mesh's Y-minimum is the RIM RING, not the
// rear surface — so a "bottom 15% of the Y range" band collects rim vertices,
// fits a sphere to a ring (fictitious flats, wild centres) and under-reports
// the aperture, because the true rear pole sits far above the band. Normals do
// not care about nesting: a rear surface faces −Y wherever it happens to lie.
//
// FRAME, not matrixWorld: element geometry is baked in place but the group
// empties (Optics_G2/G3/G4_Focus) SLIDE with zoom and focus, so the numbers are
// only the rest prescription when every channel sits at its default. Run it on
// a freshly loaded /lens bench with no demo selected — the printed table IS the
// rest table, and `focusRide` is what encodes the one element that moves.
//
// (ops/frames.ts stamps per-vertex axial extents as `_opY` = (yMin, yMax, …).
// This module deliberately does not read them — they are mesh extents, and it
// is exactly mesh extents that mislead on a dome.)
// ============================================================================

/**
 * Outward-normal Y threshold that separates the optical surfaces from the rim.
 * A vertex counts as FRONT above +NORMAL_MIN and REAR below −NORMAL_MIN;
 * everything between is rim/chamfer and is thrown away. 0.35 ≈ 70° off axis:
 * loose enough to keep the steep skirt of a fast dome, tight enough that a
 * cylindrical edge (normal.y ≈ 0) never contaminates a fit.
 */
const NORMAL_MIN = 0.35;
/** A surface flatter than this (mm of Y spread) is reported as a plane, c = 0. */
const FLAT_SPREAD_MM = 0.05;
/** Below this many surface vertices the fit is not trustworthy; report a plane. */
const MIN_CAP_POINTS = 12;

export interface ProbeSurface {
  /** curvature 1/mm; centre of curvature at yMm + 1/c. 0 = flat. */
  c: number;
  /** axial vertex position, gltf-frame mm */
  yMm: number;
  /** clear semi-diameter (max radial extent of the surface), mm */
  apertureMm: number;
  /** DIAGNOSTIC, not pasted into the prescription: RMS of ||p − centre| − r|
   *  over the surface's vertices, mm. Small = the sphere really fits. 0 = flat. */
  rmsMm: number;
  /** DIAGNOSTIC, not pasted into the prescription: how far the fitted centre
   *  sits off the optical axis, mm. Small = the surface is a figure of
   *  revolution about +Y as the model assumes. 0 = flat. */
  axisOffMm: number;
}

export interface ProbeEntry {
  id: string;
  front: ProbeSurface;
  rear: ProbeSurface;
}

/** Solve a small dense symmetric system by Gaussian elimination with partial
 *  pivoting. Returns null if the system is singular (a degenerate cap). */
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

/**
 * Coope's linear sphere fit over `pts` (flat xyz triples): minimise the
 * residual of |p|² = 2a·x + 2b·y + 2c·z + k in the four unknowns (a, b, c, k),
 * where (a, b, c) is the centre and radius = sqrt(k + a² + b² + c²). Linear —
 * one normal-equation solve, no iteration, no initial guess.
 */
function fitSphere(
  pts: number[],
): { cx: number; cy: number; cz: number; r: number } | null {
  const n = pts.length / 3;
  if (n < MIN_CAP_POINTS) return null;
  // design row per point: [2x, 2y, 2z, 1], target |p|²
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
  // The VERTEX of the surface is its AXIAL point — the vertex closest to the
  // optical axis, which on a dome is the pole, wherever it sits in Y. (The
  // mesh's Y extreme is the rim ring, which is why v1 measured the wrong thing.)
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
  // Centre at yMm + 1/c ⇒ c = 1/(centre.y − yMm). Signed for free.
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
    c: round(1 / dy, 6),
    yMm: round(yMm, 3),
    apertureMm: round(apertureMm, 3),
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
    // mesh local → world → GLB-root local (the gltf frame, real millimetres)
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

/** Expose the probe on the console. DEV-only caller (core/scene.ts). */
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
