// ============================================================================
// THE PRESCRIPTION — the 13 optical elements as an AUTHORED CONSTANT TABLE, in
// gltf-frame millimetres (optical axis = gltf +Y, front at +Y; world conversion
// is core/scene's MODEL_SCALE = 0.05 with the front at world +X).
//
// House pattern, same as the mechanism constants: MEASURED from the shipped
// model once, then authored here as constants. The measuring instrument is
// dev/prescription-probe.ts — run `window.__lensPrescriptionProbe()` on the
// /lens bench with every channel at rest and paste its JSON over the table
// below. Nothing at runtime re-derives these.
//
// SIGN CONVENTION (this file's, not a textbook's): a surface is
//     f(q) = c·|q|² − 2·q_y = 0,   q = p − (0, yMm, 0)
// so its centre of curvature sits at y = yMm + 1/c. POSITIVE c therefore puts
// the centre toward the FRONT (+Y) — the surface is concave-front, convex-rear,
// and its rim lies forward of its vertex. c = 0 is flat, with no branch
// anywhere: the whole trace is written in curvature, never in radius.
// ============================================================================

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
 *  A LITERAL, deliberately not an import: ops/mechanism.ts pulls in
 *  three/webgpu, and the whole optics tree stays three-free so its tests run on
 *  the NUM backend with no renderer. __tests__/prescription.test.ts (f) is the
 *  tripwire that keeps this equal to MECHANISM.focusMm. */
export const FOCUS_MM: number = 1.5;

/** The iris stop. Not a member of the 13-entry table — it is a stop plane, not
 *  glass — and every number is a knob. The clear semi-diameter is driven by the
 *  APERTURE CHANNEL, which runs 0 = f/2.8 wide open → 1 = f/22 closed down
 *  (ops/mechanism.ts MechanismDrive), so the radius runs irisMaxMm → irisMinMm
 *  as the channel rises. The door is real: rays outside it die.
 *
 *  irisMaxMm is CAPPED by the smaller of the two clear apertures straddling the
 *  stop — Element_06's rear, 5.802 (Element_07's front is 7.803). Open any
 *  wider and the glass, not the door, is the narrowest thing in the gap, so the
 *  first stretch of the aperture channel would clip nothing: a dead zone at the
 *  open end of the dial. __tests__/prescription.test.ts (g) holds the cap. */
export const IRIS = {
  yMm: 37.5,
  irisMinMm: 1.2,
  irisMaxMm: 5.8,
};

/** The physics knobs (spec §2), all live-tunable through `window.__lensOptics`
 *  ORPHANED: the per-pixel refraction trace that read them is gone (cleanup
 *  wave 1), so nothing consumes this table today — kept with the measured
 *  prescription it belongs to. */
export const OPTICS_KNOBS = {
  /** exaggerates bend angles: 0 = glass is vacuum, 1 = honest physics, >1 = drama */
  warpGain: 1,
  /** per-channel IOR offset (R = ior−d, G = ior, B = ior+d); 0 = no fringing */
  dispersion: 0.015,
  /** how much the focus channel moves focusRide surfaces; 0 = physics ignores the dial */
  focusCouple: 1,
  /** fades the whole warp background in; 0 = the sky is black behind the lens */
  skyMix: 0,
};

// MEASURED 2026-08-07 by window.__lensPrescriptionProbe (dev/prescription-probe.ts,
// v2 normal-classified). Only `ior` and `focusRide` are authored on top of the
// probe's output — they are look/rig facts the probe cannot see. IOR starts at
// the model's shipped glass index (core/model.ts buildLensMaterial: `ior: 1.52`)
// for every element; per-element values are look-tuning knobs from here on.
//
// THREE CEMENTED PAIRS are clamped on paste — E01/E02, E04/E05 and E09/E10 came
// back coincident to within ±14µm of authoring slop, so each interface's two
// yMm values are set to their mean (3 dp) and the surfaces share one plane.
// Curvatures are left exactly as measured. Both sides carry ior 1.52, so the
// glass→air→glass pair nets to ~identity (the two curvatures still differ
// slightly) — which is what cement is.
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
