import * as THREE from "three/webgpu";
import { createNdcOverlay, overlayMaterial, overlaySheet } from "./overlay";

// ============================================================================
// Path-driven ray ribbons for the /lens demos: a field of independently
// steerable SOLID FLAT bands, each following its own smooth 2D curve in
// screen space — the "snaking rays" building block. Same overlay language as
// prism-light (own NDC scene, second pass over the main frame, flat print
// color), but where the prism ribbon is one fixed diagram, every ray here is
// free: give it any polyline of control points and it becomes a constant-
// width ribbon snaking through them.
//
// COORDINATE SPACE — paths are authored in NDC (x, y ∈ −1..1, +y up), the
// space the overlay frustum spans and the space projected world anchors land
// in. A control point may instead be WORLD-ANCHORED ({ world: [x,y,z] }):
// it is projected with the live main camera every rendered frame, so a ray
// can emanate from a point on the 3D lens and then snake free. Widths and
// offsets are in NDC-Y units (1 = half the viewport height); the band math
// runs in an aspect-corrected space, so a ribbon keeps the same on-screen
// thickness whichever way it bends.
//
// CURVE — uniform Catmull-Rom through the control points (clamped ends). It
// interpolates — the ribbon passes THROUGH every point, so authors (and
// keyframe-lerp choreography) think in "the ray goes here, here, here"
// without tangent handles. Sampled at a fixed count into preallocated
// buffers, joined with central-difference average normals: at moderate
// curvature and this sampling density the joins read as one continuous band.
//
// BUTTING — a group of rays given the SAME path with offsets/widths from one
// shared boundary ladder tiles edge-to-edge: identical centerline + normals
// per ray, and each shared boundary is one scalar (offset ± width/2), so
// adjacent edges land within an ulp — the prism-style connected rainbow is
// the special case "one path, laddered offsets".
// ============================================================================

/** A path control point: screen-space NDC, or a world point projected with
 *  the live main camera each frame (dx/dy = NDC nudge off the projection). */
export type RayPoint =
  | { x: number; y: number }
  | { world: readonly [number, number, number]; dx?: number; dy?: number };

export interface RaySpec {
  /** ≥2 control points; the ribbon centerline passes through each. */
  path: readonly RayPoint[];
  /** full band width, NDC-y units */
  width: number;
  /** sideways shift of the band off the centerline (+ = left of travel),
   *  NDC-y units — the butting knob (see module header). Default 0. */
  offset?: number;
  color?: THREE.ColorRepresentation;
  /** default 1 — hard print. ≤0 hides the ray. */
  opacity?: number;
  /** visible parameter range of the curve, default [0,1] — animate trim[1]
   *  0→1 to grow a ray out of its source along its authored path. */
  trim?: readonly [number, number];
  /** draw order among the rays (higher = in front); default = ray index.
   *  This is the layering knob for braids/wraps — there is no 3D occlusion
   *  in the overlay, in-front/behind is declared per ray. */
  renderOrder?: number;
}

export interface RayField {
  setRay(i: number, spec: RaySpec | null): void;
  /** specs[i] → setRay(i, …); indexes past specs.length are hidden. */
  setAll(specs: readonly (RaySpec | null)[]): void;
  /** The overlay pass (SceneHandle.setOverlayPass): resolves world anchors
   *  with the live main camera, rebuilds every visible ribbon in place, and
   *  renders the overlay scene over the finished main frame. */
  render(renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera): void;
  dispose(): void;
}

/** curve samples per ray — the join/foldover quality knob */
const SAMPLES = 96;

/**
 * @param requestFrame Repaint hook (SceneHandle.invalidate). The ribbons are
 *   laid out inside the overlay pass — i.e. DURING the frame's render tick —
 *   and the WebGPU backend can leave already-existing vertex buffers one
 *   update behind on the frame a spec change lands. One echoed repaint after
 *   any spec change lets the settled frame draw the settled geometry.
 */
export function createRayField(
  count: number,
  requestFrame?: () => void,
): RayField {
  const overlay = createNdcOverlay();
  const specs: (RaySpec | null)[] = new Array(count).fill(null);

  const mats: THREE.MeshBasicMaterial[] = [];
  const meshes: THREE.Mesh[] = [];
  const geos: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const geo = new THREE.BufferGeometry();
    const posAttr = new THREE.BufferAttribute(
      new Float32Array(SAMPLES * 2 * 3),
      3,
    );
    posAttr.setUsage(THREE.DynamicDrawUsage); // rewritten every rendered frame
    geo.setAttribute("position", posAttr);
    const index: number[] = [];
    for (let j = 0; j < SAMPLES - 1; j++) {
      const a = j * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    geo.setIndex(index);
    const mat = overlayMaterial();
    const mesh = overlaySheet(geo, mat);
    mesh.renderOrder = i;
    mesh.visible = false;
    overlay.scene.add(mesh);
    geos.push(geo);
    mats.push(mat);
    meshes.push(mesh);
  }

  // scratch: resolved control points + sampled centerline, aspect-corrected
  // screen space (x·aspect, y) — all preallocated, rewritten every frame
  let px = new Float64Array(8);
  let py = new Float64Array(8);
  const cx = new Float64Array(SAMPLES);
  const cy = new Float64Array(SAMPLES);
  const proj = new THREE.Vector3();

  // uniform Catmull-Rom on the resolved points, clamped ends (endpoint
  // indices clamp, i.e. first/last points doubled) — u ∈ 0..1 over n−1 spans
  const sampleCurve = (n: number, u: number, out: { x: number; y: number }) => {
    const s = u * (n - 1);
    const i = Math.min(n - 2, Math.max(0, Math.floor(s)));
    const t = s - i;
    const i0 = Math.max(0, i - 1);
    const i2 = i + 1;
    const i3 = Math.min(n - 1, i + 2);
    const t2 = t * t;
    const t3 = t2 * t;
    const cr = (p0: number, p1: number, p2: number, p3: number) =>
      0.5 *
      (2 * p1 +
        (p2 - p0) * t +
        (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 +
        (3 * p1 - p0 - 3 * p2 + p3) * t3);
    out.x = cr(px[i0], px[i], px[i2], px[i3]);
    out.y = cr(py[i0], py[i], py[i2], py[i3]);
  };
  const pt = { x: 0, y: 0 };

  const layoutRay = (
    ray: number,
    spec: RaySpec,
    camera: THREE.PerspectiveCamera,
  ): boolean => {
    const n = spec.path.length;
    if (n < 2) return false;
    const aspect = camera.aspect;
    if (px.length < n) {
      px = new Float64Array(n);
      py = new Float64Array(n);
    }
    // resolve control points → aspect-corrected screen space
    for (let k = 0; k < n; k++) {
      const p = spec.path[k];
      if ("world" in p) {
        proj.set(p.world[0], p.world[1], p.world[2]).project(camera);
        // behind-camera / degenerate anchor: hide the ray this frame
        if (!(Math.abs(proj.z) < 1) || !isFinite(proj.x + proj.y)) return false;
        px[k] = (proj.x + (p.dx ?? 0)) * aspect;
        py[k] = proj.y + (p.dy ?? 0);
      } else {
        px[k] = p.x * aspect;
        py[k] = p.y;
      }
    }
    const t0 = spec.trim?.[0] ?? 0;
    const t1 = spec.trim?.[1] ?? 1;
    if (t1 - t0 < 1e-4) return false;
    for (let j = 0; j < SAMPLES; j++) {
      sampleCurve(n, t0 + ((t1 - t0) * j) / (SAMPLES - 1), pt);
      cx[j] = pt.x;
      cy[j] = pt.y;
    }
    // extrude: central-difference tangent → left normal, offset both edges
    const e0 = (spec.offset ?? 0) - spec.width / 2;
    const e1 = (spec.offset ?? 0) + spec.width / 2;
    const pos = geos[ray].getAttribute("position") as THREE.BufferAttribute;
    let nx = 0;
    let ny = 1; // fallback for a fully degenerate head
    for (let j = 0; j < SAMPLES; j++) {
      const ja = Math.max(0, j - 1);
      const jb = Math.min(SAMPLES - 1, j + 1);
      const dx = cx[jb] - cx[ja];
      const dy = cy[jb] - cy[ja];
      const len = Math.hypot(dx, dy);
      if (len > 1e-9) {
        nx = -dy / len;
        ny = dx / len;
      }
      pos.setXYZ(j * 2, (cx[j] + nx * e0) / aspect, cy[j] + ny * e0, 0);
      pos.setXYZ(j * 2 + 1, (cx[j] + nx * e1) / aspect, cy[j] + ny * e1, 0);
    }
    pos.needsUpdate = true;
    return true;
  };

  let dirty = false;
  return {
    setRay(i, spec) {
      specs[i] = spec;
      dirty = true;
      if (spec) {
        if (spec.color !== undefined) mats[i].color.set(spec.color);
        mats[i].opacity = spec.opacity ?? 1;
        meshes[i].renderOrder = spec.renderOrder ?? i;
      }
    },
    setAll(all) {
      for (let i = 0; i < count; i++) this.setRay(i, all[i] ?? null);
    },
    render(renderer, camera) {
      let any = false;
      for (let i = 0; i < count; i++) {
        const spec = specs[i];
        const on =
          !!spec && mats[i].opacity > 0.001 && layoutRay(i, spec, camera);
        meshes[i].visible = on;
        any ||= on;
      }
      if (any) overlay.render(renderer);
      // echo one repaint after spec changes (see the requestFrame doc above)
      if (dirty) {
        dirty = false;
        requestFrame?.();
      }
    },
    dispose() {
      for (const g of geos) g.dispose();
      for (const m of mats) m.dispose();
    },
  };
}
