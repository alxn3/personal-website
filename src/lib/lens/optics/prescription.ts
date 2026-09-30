// The 13 optical elements, in glTF-frame millimetres (optical axis = +Y, front
// at +Y). Re-measure with `window.__lensPrescriptionProbe()`.
//
// A surface is c·|q|² − 2·q_y = 0 for q = p − (0, yMm, 0): its centre of
// curvature is at y = yMm + 1/c, and c = 0 is flat.

/** One refracting surface. */
export interface OpticalSurface {
  /** curvature, 1/mm (0 = flat) */
  c: number;
  /** axial vertex position, gltf Y mm */
  yMm: number;
  /** clear semi-diameter, mm */
  apertureMm: number;
}

export interface PrescriptionEntry {
  /** GLB node name, `Element_01` … `Element_13` */
  id: string;
  front: OpticalSurface;
  rear: OpticalSurface;
  /** refractive index */
  ior: number;
  /** 1 = moves with the focus group (Optics_G4_Focus) */
  focusRide: 0 | 1;
}

/** Focus-group travel at focus = 1, mm; must equal MECHANISM.focusMm (a test checks). */
export const FOCUS_MM: number = 1.5;

/** The iris stop plane; its clear semi-diameter runs irisMaxMm → irisMinMm as
 *  the aperture channel goes 0 (f/2.8) → 1 (f/22). */
export const IRIS = {
  yMm: 37.5,
  irisMinMm: 1.2,
  irisMaxMm: 5.8,
};

// Cemented pairs (E01/E02, E04/E05, E09/E10) share one yMm at their interface.
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
