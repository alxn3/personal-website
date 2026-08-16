import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { isOpticalGlass } from "./parts";

// Shared loading + material setup for the Sigma 18-50mm GLB (produced by the
// lens_work/ pipeline, `lens_web_segmented.glb`: de-branded, uncompressed, with
// each circular part split into `<Part>_SegN` wedges under an empty of the same
// name). See core/scene.ts for the full axis-mapping notes.
export const MODEL_URL = "/models/lens_web_segmented.glb";
// Removable accessories ship in their own GLB (hood / UV filter / caps); merged
// into the body scene at load so the accessory toggles find them by name.
export const ACCESSORIES_URL = "/models/lens_web_accessories.glb";
// The web GLBs carry plain accessors and no glTF extensions at all, so a bare
// GLTFLoader reads them. Draco was dropped upstream (lens_work N.15): it saved
// transfer bytes on the first visit only, while its wasm decoder was fetched,
// instantiated and run on EVERY page load. Brotli on the wire buys most of the
// same bytes with none of the recurring cost — which makes serving `.glb` with
// `Content-Encoding: br` a hosting requirement, not an optimization.

// Front accessories ride the extending zoom barrel; the rear cap sits at root.
const FRONT_ACCESSORIES = new Set([
  "Acc_CapFront",
  "Acc_Filter_Glass",
  "Acc_Filter_Ring",
  "Acc_Hood",
]);

// Per-mesh material, tuned to the real Sigma 18-50mm: a near-black matte body,
// a graphite gunmetal front bezel, chrome mount, brass contacts, white printed
// text, transmissive coated glass, blackened-steel iris blades.
//
// EVERY mesh is shaded here. The web GLBs ship bare geometry — zero materials,
// zero UVs (lens_work MIGRATION §1) — so a mesh left alone would render in
// three's white `DefaultMaterial`. The glass and the blades used to arrive
// wearing Blender's own `M_Glass` (KHR_materials_transmission, ior 1.52) and
// `M_Blade`; those two looks are re-authored below from the same numbers, so
// the render is unchanged and the model file no longer has an opinion.
//
// The DECISION is name → this spec; two names that resolve to the same spec
// yield an identical material, so loadLensModel memoizes on the signature and
// shares one instance (see there).
type LensMaterialSpec = {
  color: number;
  roughness: number;
  metalness: number;
  /** Optical glass: build a MeshPhysicalMaterial with transmission, IOR and the
   *  thin-film multicoating instead of a plain MeshStandardMaterial. */
  glass?: boolean;
};

function lensMaterialSpec(name: string): LensMaterialSpec {
  // Optical glass — the 13 elements and the accessory UV filter. FIRST, so the
  // filter glass never falls through to the matte-black `Acc_` rule below.
  if (isOpticalGlass(name))
    return { color: 0xfafdfc, roughness: 0, metalness: 0, glass: true };
  // Iris blades: blackened spring steel (Blender's M_Blade).
  if (name.startsWith("Iris_Blade"))
    return { color: 0x303032, roughness: 0.4, metalness: 1.0 };
  // Zoom/focus grips: matte black rubber.
  if (name.startsWith("Ring_"))
    return { color: 0x101011, roughness: 0.94, metalness: 0.0 };
  // Chrome bayonet mount / screws — incl. the flange screws, which the
  // `Mount_Screw` prefix misses (startsWith so `_SegN` wedges match too).
  if (
    name.startsWith("Mount_Bayonet") ||
    name.startsWith("Mount_Screw") ||
    name.startsWith("Mount_FlangeScrews")
  )
    return { color: 0xd7dce2, roughness: 0.2, metalness: 0.9 };
  // Brass electronic contacts.
  if (name === "Mount_Contacts")
    return { color: 0xb08d57, roughness: 0.35, metalness: 0.85 };
  // The letter on the badge — dark so it reads against the white disc
  // (otherwise it's white-on-white and invisible).
  if (name.startsWith("DecalT_BadgeC"))
    return { color: 0x161617, roughness: 0.5, metalness: 0.1 };
  // White printed markings (focal scale, name ring, "MADE IN JAPAN", badge disc).
  if (name.startsWith("Decal"))
    return { color: 0xeae9e4, roughness: 0.55, metalness: 0.0 };
  // Front head / filter bezel: gunmetal graphite, distinctly lighter than the
  // black body (the ring around the front glass on the real lens).
  if (name.startsWith("Barrel_Inner"))
    return { color: 0x343331, roughness: 0.48, metalness: 0.4 };
  // Front name ring: glossier near-black plastic.
  if (name.startsWith("Band_Mid"))
    return { color: 0x1c1c1d, roughness: 0.4, metalness: 0.15 };
  // Anodized-aluminum filter ring.
  if (name === "Acc_Filter_Ring")
    return { color: 0x1a1c1f, roughness: 0.35, metalness: 0.8 };
  // Hood + caps: matte black plastic.
  if (name.startsWith("Acc_"))
    return { color: 0x0d0d0e, roughness: 0.88, metalness: 0.0 };
  // Everything else (barrel, chassis, base, baffle): near-black matte body.
  return { color: 0x191919, roughness: 0.55, metalness: 0.28 };
}

/** HOW MUCH THE ELEMENTS REFLECT — a scale on the dielectric Fresnel at both
 *  ends (three r185 reads `specularIntensity` into F0 and IS specularF90 at
 *  metalness 0), i.e. the ONE number for the strength of everything the glass
 *  bounces back: the environment, the studio key, the rim.
 *
 *  IT IS A COATING NUMBER, NOT A DEFAULT. three's 1.0 is bare glass — ~4% per
 *  surface — and the elements are a stack of THIRTEEN of them, each drawn in
 *  the transmission pass over the last: shot dead down the bore, where the
 *  story's fly-through approach leaves the camera, that stack composited to a
 *  milky white disc across the whole bore, swallowing the shut iris behind it
 *  (the owner: "the aperture blades turn white during the transition"). At 0.15
 *  each surface returns ~0.6%, which is what a real multicoated element does,
 *  and the bore reads as glass with the blades visible through it.
 *
 *  The dive already knew this: its transmissive clones (core/scene.ts
 *  GLASS_TRANSMISSIVE_SPECULAR) are built at exactly this number, and matching
 *  it here is also what makes the clones' hand-BACK at the end of the span a
 *  no-op instead of a pop. */
export const GLASS_SPECULAR = 0.15;

/** Build one material from a spec. Glass is the only kind that needs more than
 *  the three PBR params: transmission + IOR (the crown glass the elements used
 *  to carry as KHR_materials_transmission) and the iridescent thin-film
 *  multicoating — the green/amber/purple sheen of real lens coatings — over a
 *  faint green specular tint, at coating strength (GLASS_SPECULAR).
 *  DoubleSide because light crosses both surfaces of an element. */
function buildLensMaterial(spec: LensMaterialSpec): THREE.Material {
  const { color, roughness, metalness, glass } = spec;
  if (!glass)
    return new THREE.MeshStandardMaterial({ color, roughness, metalness });
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness,
    metalness,
    transmission: 1,
    ior: 1.52,
    side: THREE.DoubleSide,
    iridescence: 0.55,
    iridescenceIOR: 1.3,
    iridescenceThicknessRange: [140, 400],
    specularColor: new THREE.Color(0xb9e0c6),
    specularIntensity: GLASS_SPECULAR,
  });
}

export interface LensModel {
  /** The body scene — ready to render on its own. */
  scene: THREE.Group;
  /** Whether this load asked for the accessories GLB at all (see `accessories`
   *  in loadLensModel's options). False on the hero, where nothing downstream
   *  may expect hood/caps/filter nodes to exist. */
  hasAccessories: boolean;
  /** Resolves once the accessories GLB has been fetched, decoded, stylized and
   *  merged into `scene` (front group under Barrel_Inner). Loaded in the
   *  BACKGROUND after the body so the first frame never waits on it; consumers
   *  (the /lens accessory toggles) await this before touching the hood/caps/
   *  filter nodes. Rejections are the caller's to handle. Resolves immediately
   *  when `hasAccessories` is false — the toggles' await stays valid either way. */
  accessoriesReady: Promise<void>;
}

/**
 * Load the body GLB and return as soon as it is ready; kick the accessories GLB
 * (hood / UV filter / caps) off in the BACKGROUND, merging it into the body
 * scene (front group parented to the zoom barrel so they ride the extension)
 * once decoded. Stylized materials are applied to every mesh of each.
 * The accessories are hidden by default on /lens and never shown by the hero at
 * all (the story's ending is the rose alone), so `accessories: false` skips that
 * second GLB outright — the hero used to download 855 KB it never drew.
 */
export async function loadLensModel({
  accessories = true,
}: { accessories?: boolean } = {}): Promise<LensModel> {
  const loader = new GLTFLoader();

  // Per-LOAD material cache keyed by the name→spec decision signature: meshes that
  // resolve to identical params share ONE source material, so the per-source
  // material caches downstream (materials/unified.ts, the bench looks) then
  // yield ONE deform material per look (~10 instead of ~168).
  // Scoped to this call (not module-global) so disposeLensModel frees it cleanly.
  // Shared across the body + accessories: the accessory specs don't collide with
  // the body's, so they simply get their own instances (their own ~8 materials).
  const matCache = new Map<string, THREE.Material>();
  const sharedMaterialFor = (name: string): THREE.Material => {
    const s = lensMaterialSpec(name);
    const key = `${s.color}|${s.roughness}|${s.metalness}|${s.glass ?? false}`;
    let m = matCache.get(key);
    if (!m) {
      m = buildLensMaterial(s);
      matCache.set(key, m);
    }
    return m;
  };

  // EVERY mesh, no exceptions: the GLBs carry no materials at all, so anything
  // skipped here would render in three's white default (MIGRATION §1). Runtime
  // names are node names now (§2), so `child.name` is the classification key.
  const stylize = (root: THREE.Object3D) => {
    root.traverse((child) => {
      if (child instanceof THREE.Mesh)
        child.material = sharedMaterialFor(child.name);
    });
  };

  // Body first — the returned promise resolves the instant it is ready, so
  // nothing the first frame needs waits behind the accessories.
  const body = await loader.loadAsync(MODEL_URL);
  const scene = body.scene;
  stylize(scene);

  // Accessories in the BACKGROUND: fetch+parse+merge off the critical path. Not
  // awaited here — the caller renders on the body alone and awaits
  // accessoriesReady before touching hood/caps/filter.
  const accessoriesReady = accessories
    ? loader.loadAsync(ACCESSORIES_URL).then((acc) => {
        // Both GLBs share the same rest-pose space; Barrel_Inner is at the
        // origin at load, so plain .add() keeps each accessory's world position.
        const barrel = scene.getObjectByName("Barrel_Inner");
        for (const child of [...acc.scene.children]) {
          (FRONT_ACCESSORIES.has(child.name) && barrel ? barrel : scene).add(
            child,
          );
          stylize(child);
        }
      })
    : Promise.resolve();

  return { scene, hasAccessories: accessories, accessoriesReady };
}

/**
 * Give the scene a PMREM'd room environment. Transmissive glass only reads as
 * glass with a real environment to refract — against a void it renders milky.
 * Returns the generated texture for disposal.
 */
export function setLensEnvironment(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = texture;
  pmrem.dispose();
  return texture;
}

/** Dispose every geometry/material under a loaded model root. Materials are now
 *  SHARED across meshes (the signature cache above; ink/deform caches too), so each
 *  is disposed exactly once — a Set guards against double-dispose / a leaked skip. */
export function disposeLensModel(root: THREE.Object3D): void {
  const seenMat = new Set<THREE.Material>();
  root.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      const mats = Array.isArray(child.material)
        ? child.material
        : [child.material];
      for (const m of mats) {
        if (!m || seenMat.has(m)) continue;
        seenMat.add(m);
        m.dispose();
      }
    }
  });
}
