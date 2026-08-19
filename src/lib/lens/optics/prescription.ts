// The prescription: the 13 optical elements as an authored constant table, in
// gltf-frame millimetres (optical axis = gltf +Y, front at +Y; core/scene's
// MODEL_SCALE = 0.05 puts the front at world +X).
//
// Authored, never re-derived at runtime. Re-measure with
// `window.__lensPrescriptionProbe()` (dev/prescription-probe.ts) on the /lens
// bench with every channel at rest, and paste its JSON over the table below.
//
// SIGN CONVENTION (this file's, not a textbook's): a surface is
//     f(q) = c·|q|² − 2·q_y = 0,   q = p − (0, yMm, 0)
// so its centre of curvature sits at y = yMm + 1/c, and positive c puts that
// centre toward the FRONT (+Y). c = 0 is flat — the trace is written in
// curvature, never in radius, so there is no branch anywhere.

/** One refracting surface. */
export interface OpticalSurface {
  /** curvature 1/mm; centre of curvature at yMm + 1/c. 0 encodes FLAT. */
  c: number;
  /** axial vertex position, gltf Y mm */
  yMm: number;
  /** clear semi-diameter, mm */
  apertureMm: number;
}

export interface PrescriptionEntry {
  /** matches the GLB node name exactly — `Element_01` … `Element_13` */
  id: string;
  front: OpticalSurface;
  rear: OpticalSurface;
  /** refractive index at the reference wavelength (core/model.ts ships 1.52) */
  ior: number;
  /** 1 = this element rides Optics_G4_Focus (L4 / Element_12) */
  focusRide: 0 | 1;
}

/** The focus throw, in mm of axial element travel at focus = 1.
 *
 *  A LITERAL, deliberately not an import of MECHANISM.focusMm: ops/mechanism.ts
 *  pulls in three/webgpu, and optics/ stays three-free so its tests run with no
 *  renderer. __tests__/prescription.test.ts (f) keeps the two equal. */
export const FOCUS_MM: number = 1.5;

/** The iris stop — a stop plane, not glass, so not a member of the table below.
 *  The clear semi-diameter runs irisMaxMm → irisMinMm as the aperture channel
 *  rises (0 = f/2.8 wide open → 1 = f/22). Rays outside it die.
 *
 *  irisMaxMm is CAPPED by the smaller clear aperture straddling the stop
 *  (Element_06's rear); open wider and the glass is the narrowest thing in the
 *  gap, so the dial's open end would clip nothing. Held by
 *  __tests__/prescription.test.ts (g). */
export const IRIS = {
  yMm: 37.5,
  irisMinMm: 1.2,
  irisMaxMm: 5.8,
};

/** The physics knobs, live-tunable through `window.__lensOptics`.
 *  ORPHANED: the per-pixel refraction trace that read them is gone, so nothing
 *  consumes this table today. */
export const OPTICS_KNOBS = {
  /** exaggerates bend angles: 0 = vacuum, 1 = honest physics, >1 = drama */
  warpGain: 1,
  /** per-channel IOR offset (R = ior−d, G = ior, B = ior+d); 0 = no fringing */
  dispersion: 0.015,
  /** how far the focus channel moves focusRide surfaces; 0 = ignore the dial */
  focusCouple: 1,
  /** fades the warp background in; 0 = the sky is black behind the lens */
  skyMix: 0,
};

// `ior` and `focusRide` are authored on top of the probe's output — look/rig
// facts the probe cannot see. The cemented pairs (E01/E02, E04/E05, E09/E10)
// have each interface's two yMm clamped to their mean on paste, so the two
// surfaces share one plane; curvatures stay exactly as measured.
/* prettier-ignore */
export const PRESCRIPTION: PrescriptionEntry[] = [
  { id: "Element_01", front: { c: -0.037001, yMm: 73.208, apertureMm: 18.210 }, rear: { c: -0.047592, yMm: 71.832, apertureMm: 18.210 }, ior: 1.52, focusRide: 0 }, // cemented
  { id: "Element_02", front: { c: -0.047592, yMm: 71.832, apertureMm: 16.809 }, rear: { c: -0.010005, yMm: 62.617, apertureMm: 16.809 }, ior: 1.52, focusRide: 0 }, // cemented
  { id: "Element_03", front: { c: -0.043450, yMm: 61.414, apertureMm:  8.603 }, rear: { c: -0.102110, yMm: 60.044, apertureMm:  8.603 }, ior: 1.52, focusRide: 0 },
  { id: "Element_04", front: { c:  0.047655, yMm: 55.092, apertureMm:  6.302 }, rear: { c: -0.095342, yMm: 54.413, apertureMm:  6.302 }, ior: 1.52, focusRide: 0 }, // cemented
  { id: "Element_05", front: { c: -0.095101, yMm: 54.413, apertureMm:  6.302 }, rear: { c: -0.006612, yMm: 52.028, apertureMm:  6.302 }, ior: 1.52, focusRide: 0 }, // cemented
  { id: "Element_06", front: { c:  0.120557, yMm: 49.455, apertureMm:  5.802 }, rear: { c:  0.090850, yMm: 48.605, apertureMm:  5.802 }, ior: 1.52, focusRide: 0 },
  // — the iris stop sits in the 48.605 → 32.383 gap (IRIS.yMm above) —
  { id: "Element_07", front: { c: -0.104127, yMm: 32.383, apertureMm:  7.803 }, rear: { c:  0.030503, yMm: 26.660, apertureMm:  7.803 }, ior: 1.52, focusRide: 0 },
  { id: "Element_08", front: { c: -0.006812, yMm: 25.298, apertureMm:  7.002 }, rear: { c: -0.111145, yMm: 24.101, apertureMm:  7.002 }, ior: 1.52, focusRide: 0 },
  { id: "Element_09", front: { c: -0.087035, yMm: 21.193, apertureMm:  6.502 }, rear: { c: -0.014172, yMm: 18.887, apertureMm:  6.502 }, ior: 1.52, focusRide: 0 }, // cemented
  { id: "Element_10", front: { c: -0.014239, yMm: 18.887, apertureMm:  6.602 }, rear: { c:  0.113590, yMm: 12.490, apertureMm:  6.602 }, ior: 1.52, focusRide: 0 }, // cemented
  { id: "Element_11", front: { c: -0.090918, yMm: 12.316, apertureMm:  6.902 }, rear: { c:  0.049932, yMm:  8.305, apertureMm:  6.902 }, ior: 1.52, focusRide: 0 },
  { id: "Element_12", front: { c: -0.008209, yMm:  6.614, apertureMm:  6.402 }, rear: { c: -0.096145, yMm:  5.964, apertureMm:  6.402 }, ior: 1.52, focusRide: 1 },
  { id: "Element_13", front: { c: -0.016584, yMm:  2.477, apertureMm: 10.503 }, rear: { c:  0.018209, yMm: -0.775, apertureMm: 10.503 }, ior: 1.52, focusRide: 0 },
];
