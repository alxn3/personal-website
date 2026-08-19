import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { isOpticalGlass } from "./parts";

// Loading + material setup for the lens GLBs, produced by the lens_work/
// pipeline: de-branded, uncompressed, each circular part split into
// `<Part>_SegN` wedges under an empty of the same name.
export const MODEL_URL = "/models/lens_web_segmented.glb";
// Removable accessories ship separately (hood / UV filter / caps), merged into
// the body scene at load so the accessory toggles find them by name.
export const ACCESSORIES_URL = "/models/lens_web_accessories.glb";
// The GLBs carry plain accessors and no glTF extensions, so a bare GLTFLoader
// reads them — no Draco decoder. HOSTING REQUIREMENT, not an optimization:
// `.glb` must be served with `Content-Encoding: br`.

// Front accessories ride the extending zoom barrel; the rear cap sits at root.
const FRONT_ACCESSORIES = new Set([
  "Acc_CapFront",
  "Acc_Filter_Glass",
  "Acc_Filter_Ring",
  "Acc_Hood",
]);

// Per-mesh material spec, tuned to the real lens. EVERY mesh is shaded here:
// the GLBs ship bare geometry with zero materials, so anything skipped renders
// in three's white DefaultMaterial. The decision is name → spec, and
// loadLensModel memoizes on the spec signature so equal specs share one
// instance.
type LensMaterialSpec = {
  color: number;
  roughness: number;
  metalness: number;
  /** Optical glass: build a MeshPhysicalMaterial with transmission, IOR and the
   *  thin-film multicoating instead of a plain MeshStandardMaterial. */
  glass?: boolean;
};

function lensMaterialSpec(name: string): LensMaterialSpec {
  // Glass FIRST, so the accessory filter glass never falls through to the
  // matte-black `Acc_` rule below.
  if (isOpticalGlass(name))
    return { color: 0xfafdfc, roughness: 0, metalness: 0, glass: true };
  // Iris blades: blackened spring steel.
  if (name.startsWith("Iris_Blade"))
    return { color: 0x303032, roughness: 0.4, metalness: 1.0 };
  // Zoom/focus grips: matte black rubber.
  if (name.startsWith("Ring_"))
    return { color: 0x101011, roughness: 0.94, metalness: 0.0 };
  // Chrome bayonet mount / screws — the flange screws need their own test;
  // startsWith so `_SegN` wedges match too.
  if (
    name.startsWith("Mount_Bayonet") ||
    name.startsWith("Mount_Screw") ||
    name.startsWith("Mount_FlangeScrews")
  )
    return { color: 0xd7dce2, roughness: 0.2, metalness: 0.9 };
  // Brass electronic contacts.
  if (name === "Mount_Contacts")
    return { color: 0xb08d57, roughness: 0.35, metalness: 0.85 };
  // The badge letter — dark, so it reads against the white disc under it.
  if (name.startsWith("DecalT_BadgeC"))
    return { color: 0x161617, roughness: 0.5, metalness: 0.1 };
  // White printed markings (focal scale, name ring, badge disc).
  if (name.startsWith("Decal"))
    return { color: 0xeae9e4, roughness: 0.55, metalness: 0.0 };
  // Front head / filter bezel: gunmetal graphite, lighter than the body.
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
 *  ends. A MULTICOATING number, not a default: three's 1.0 is bare glass, and
 *  thirteen bare surfaces composite to a milky white disc across the bore when
 *  shot down the axis. Must stay equal to core/scene.ts's
 *  GLASS_TRANSMISSIVE_SPECULAR, or the dive's clone hand-back pops. */
export const GLASS_SPECULAR = 0.15;

/** Build one material from a spec. Glass is the only kind needing more than
 *  the three PBR params: crown-glass transmission + IOR, and the iridescent
 *  thin-film multicoating over a faint green specular tint. DoubleSide because
 *  light crosses both surfaces of an element. */
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
  /** Whether this load asked for the accessories GLB at all. False on the
   *  hero, so nothing downstream may expect hood/caps/filter nodes to exist. */
  hasAccessories: boolean;
  /** Resolves once the accessories GLB is merged into `scene`. Loaded in the
   *  BACKGROUND after the body, so callers must await this before touching
   *  hood/caps/filter nodes. Resolves immediately when `hasAccessories` is
   *  false, so that await stays valid either way. Rejections are the
   *  caller's. */
  accessoriesReady: Promise<void>;
}

/**
 * Load the body GLB and return as soon as it is ready; fetch the accessories
 * GLB in the BACKGROUND and merge it in once decoded (front group parented to
 * the zoom barrel so they ride the extension). Every mesh of each is stylized.
 * `accessories: false` skips the second GLB outright — the hero never draws it.
 */
export async function loadLensModel({
  accessories = true,
}: { accessories?: boolean } = {}): Promise<LensModel> {
  const loader = new GLTFLoader();

  // Per-LOAD cache keyed by the spec signature: meshes with identical params
  // share ONE source material, so the per-source caches downstream
  // (materials/unified.ts) yield one deform material per look rather than one
  // per mesh. Scoped to this call so disposeLensModel frees it cleanly.
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

  // EVERY mesh, no exceptions: the GLBs carry no materials, so anything
  // skipped renders in three's white default.
  const stylize = (root: THREE.Object3D) => {
    root.traverse((child) => {
      if (child instanceof THREE.Mesh)
        child.material = sharedMaterialFor(child.name);
    });
  };

  // Body first, so nothing the first frame needs waits on the accessories.
  const body = await loader.loadAsync(MODEL_URL);
  const scene = body.scene;
  stylize(scene);

  // Accessories in the BACKGROUND, off the critical path — deliberately not
  // awaited here; the caller awaits `accessoriesReady`.
  const accessoriesReady = accessories
    ? loader.loadAsync(ACCESSORIES_URL).then((acc) => {
        // Both GLBs share one rest-pose space and Barrel_Inner is at the
        // origin at load, so plain .add() keeps each world position.
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
 * Give the scene a PMREM'd room environment and return the texture for
 * disposal. Transmissive glass only reads as glass with something to refract.
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

/** Dispose every geometry/material under a loaded model root. Materials are
 *  SHARED across meshes, so the Set guards against a double-dispose. */
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
