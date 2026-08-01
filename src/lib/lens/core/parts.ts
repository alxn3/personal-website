// ============================================================================
// Part-name classification: the ONE place that knows what a model node name
// MEANS. Object names are the API with the lens_work/ Blender pipeline (do not
// rename — see core/rig.ts); these predicates give each name-pattern test a
// single, documented home so consumers can't drift into subtly different
// regexes. The sets below are DELIBERATELY different from each other — each
// doc comment states the semantic, so keep them distinct on purpose.
// ============================================================================

/** True optical glass only — the 13 lens elements and the accessory UV filter.
 *  NOT the iris blades: they're metal, and an earlier `Iris_` prefix match
 *  mis-styled them as glass (the bug that motivated this module). */
export const isOpticalGlass = (name: string): boolean =>
  /^Element_|^Acc_Filter_Glass$/.test(name);

/** Meshes that keep their Blender-authored material at load (KHR transmission
 *  glass etc.): the glass PLUS the iris blades — wider than isOpticalGlass on
 *  purpose (the blades' authored metal is kept, but they must never be
 *  restyled as glass). */
export const keepsAuthoredMaterial = (name: string): boolean =>
  /^(Element|Iris)_|^Acc_Filter_Glass$/.test(name);

/** The optical elements alone (no filter glass) — the light path the
 *  refraction rays thread and the isolate preserves. */
export const isGlassElement = (name: string): boolean => /^Element_/.test(name);

/** Removable accessories (hood, caps, UV filter) — excluded from the bare-lens
 *  bounding box, the teardown, and the isolate. */
export const isAccessory = (name: string): boolean => name.startsWith("Acc_");

/** Printed markings (focal scale, name ring, badge…). Unanchored on purpose:
 *  matches every `Decal*`/`DecalT_*` family name the same way the ink
 *  edge-line skip always has. */
export const isDecal = (name: string): boolean => /Decal/.test(name);

/** A shell wedge sub-mesh (`<Part>_SegN`) — deforms in-shader via the bloom
 *  graph, so object-space rigs must leave it alone. */
export const isSegWedge = (name: string): boolean => /_Seg\d+$/.test(name);

/** The rig's loose-parts exemption (checked up the ANCESTOR chain): glass,
 *  decals, accessories and the iris are all driven elsewhere and must not be
 *  flung by the explode tumble. A policy composite, kept here so it's visible
 *  next to the sets it's built from. */
export const isRigExempt = (name: string): boolean =>
  /^(Element|Decal|Acc_|Iris)/.test(name);
