import * as THREE from "three/webgpu";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { isOpticalGlass } from "./parts";

// Loads the lens GLBs and gives every mesh its material. Circular parts are
// split into `<Part>_SegN` segments under an empty of the same name. The host
// must serve `.glb` with `Content-Encoding: br`.
export const MODEL_URL = "/models/lens_web_segmented.glb";
/** hood, UV filter and caps; merged into the body scene on load */
export const ACCESSORIES_URL = "/models/lens_web_accessories.glb";

// Front accessories move with the zoom barrel; the rear cap sits at the root.
const FRONT_ACCESSORIES = new Set([
  "Acc_CapFront",
  "Acc_Filter_Glass",
  "Acc_Filter_Ring",
  "Acc_Hood",
]);

// Material params per mesh name. The GLBs ship no materials of their own.
type LensMaterialSpec = {
  color: number;
  roughness: number;
  metalness: number;
  /** build a transmissive, coated MeshPhysicalMaterial */
  glass?: boolean;
};

function lensMaterialSpec(name: string): LensMaterialSpec {
  // Glass first, so the filter glass doesn't hit the `Acc_` rule below.
  if (isOpticalGlass(name))
    return { color: 0xfafdfc, roughness: 0, metalness: 0, glass: true };
  // Iris blades: blackened spring steel.
  if (name.startsWith("Iris_Blade"))
    return { color: 0x303032, roughness: 0.4, metalness: 1.0 };
  // Zoom/focus grips: matte black rubber.
  if (name.startsWith("Ring_"))
    return { color: 0x101011, roughness: 0.94, metalness: 0.0 };
  // Chrome bayonet mount and screws.
  if (
    name.startsWith("Mount_Bayonet") ||
    name.startsWith("Mount_Screw") ||
    name.startsWith("Mount_FlangeScrews")
  )
    return { color: 0xd7dce2, roughness: 0.2, metalness: 0.9 };
  // Brass electronic contacts.
  if (name === "Mount_Contacts")
    return { color: 0xb08d57, roughness: 0.35, metalness: 0.85 };
  // Badge letter: dark, over the white badge disc.
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

/** Glass specular strength (three's 1.0 is uncoated glass). scene.ts's
 *  transmissive glass reuses it so swapping between them doesn't pop. */
export const GLASS_SPECULAR = 0.15;

/** Build one material from a spec. Glass gets transmission, IOR and an
 *  iridescent coating, double-sided. */
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
  scene: THREE.Group;
  /** Resolves once the accessories are merged into `scene` (immediately if
   *  they weren't requested). */
  accessoriesReady: Promise<void>;
}

/** Load the body GLB and return once it is ready; the accessories GLB (if
 *  requested) loads in the background and is merged in when it arrives. */
export async function loadLensModel({
  accessories = true,
}: { accessories?: boolean } = {}): Promise<LensModel> {
  const loader = new GLTFLoader();

  // Meshes with identical params share one material.
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

  const stylize = (root: THREE.Object3D) => {
    root.traverse((child) => {
      if (child instanceof THREE.Mesh)
        child.material = sharedMaterialFor(child.name);
    });
  };

  const body = await loader.loadAsync(MODEL_URL);
  const scene = body.scene;
  stylize(scene);

  const accessoriesReady = accessories
    ? loader.loadAsync(ACCESSORIES_URL).then((acc) => {
        // Same rest space and Barrel_Inner sits at the origin, so .add() keeps
        // world positions.
        const barrel = scene.getObjectByName("Barrel_Inner");
        for (const child of [...acc.scene.children]) {
          (FRONT_ACCESSORIES.has(child.name) && barrel ? barrel : scene).add(
            child,
          );
          stylize(child);
        }
      })
    : Promise.resolve();

  return { scene, accessoriesReady };
}

/** Give the scene a room environment map (the glass needs something to
 *  refract). */
export function setLensEnvironment(
  renderer: THREE.WebGPURenderer,
  scene: THREE.Scene,
): void {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
}
