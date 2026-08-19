import * as THREE from "three/webgpu";
import type { UnifiedLook } from "./unified";
import type { ShadingBench, ShadingBenchFactory } from "./shading-bench";

// The look swapper. The story's pair ("realistic"/"ink") is ONE blended
// material (materials/unified.ts), so set("ink") is a uniform write, not a
// swap; the seven bench looks live in the lazy /lens-only shading-bench chunk.
//
// TYPE-ONLY EDGE: this file may name materials/shading-bench.ts through
// `import type` ONLY. A value import would give Rollup a static edge and
// collapse the bench into the homepage's chunk. core/scene.ts's
// enableShadingBench() dynamically imports it and hands the factory to
// `installBench`; every bench call is optional, so this controller is complete
// for the story with no bench installed. Pinned by
// __tests__/shading-boundary.test.ts.
//
// The mesh roster, the site theme and the current mode stay on this side for
// both halves — two copies of the theme flag is the drift the split must not
// introduce.
export type ShadingMode =
  | "realistic"
  | "ink"
  | "blueprint"
  | "flat"
  | "outline"
  | "ember"
  | "paper"
  | "riso"
  | "bronze";

/** The /lens bench's own looks — everything that is NOT the story's pair, and
 *  exactly the set materials/shading-bench.ts knows how to build. */
export type BenchMode = Exclude<ShadingMode, "realistic" | "ink">;

/** The story's pair — one blended material, no swap (materials/unified.ts).
 *  A type PREDICATE, so `set`'s early return narrows the rest of the function
 *  to a `BenchMode` by the compiler rather than by a cast. */
const MERGED = (mode: ShadingMode): mode is "realistic" | "ink" =>
  mode === "realistic" || mode === "ink";

export interface ShadingController {
  /** Wear `mode`. A bench look needs `installBench` first; without one this
   *  warns and holds the current look rather than half swapping the meshes. */
  set(mode: ShadingMode): void;
  /** Plug in the lazily-imported bench half (core/scene's enableShadingBench).
   *  Idempotent, so a second call keeps the first bench's parked builds. Takes
   *  the FACTORY so this controller stays the one owner of the theme flag. */
  installBench(factory: ShadingBenchFactory): void;
  /** Whether a bench is installed — the modes outside the story's pair are
   *  wearable iff this is true. */
  hasBench(): boolean;
  /** Fold meshes that loaded AFTER creation (the background accessories) into
   *  the swapper and style them in the current mode. Idempotent per mesh; the
   *  merged pair gets them from unified.integrate, which core/scene runs
   *  first. */
  integrate(root: THREE.Object3D): void;
  /** Re-palette for the site theme (light = no `.dark` on <html>). The merged
   *  pair re-tints in place; a bench look rebuilds. No-op if unchanged. */
  setTheme(light: boolean): void;
  /** Wear the REALISTIC look for the duration of `cb`, then restore exactly
   *  what each mesh was wearing — including anything else riding on it, such as
   *  the transmissive glass clones. Not `set("realistic")` and back, which
   *  would leave the ink blend at 0 on the way out. The blend matters:
   *  `transparent` rides it and pipelines are keyed on that, so a warm-up under
   *  the wrong blend warms nothing. */
  withOriginals(cb: () => void): void;
  dispose(): void;
}

export function createShading(
  root: THREE.Object3D,
  unified: UnifiedLook,
): ShadingController {
  // Site theme, detected here so both pages get the right palette without
  // wiring; toggles arrive via setTheme (the pages own the observer).
  let light = !document.documentElement.classList.contains("dark");
  let currentMode: ShadingMode = "realistic";
  const meshes: THREE.Mesh[] = [];
  const known = new Set<THREE.Mesh>();
  /** the /lens bench, once core/scene has imported it — null on the hero */
  let bench: ShadingBench | null = null;

  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    meshes.push(o);
    known.add(o);
  });

  function set(mode: ShadingMode) {
    if (MERGED(mode)) {
      // The story's pair: park whatever bench look held the meshes and clear
      // the renderOrder a bench look may have assigned, then wear and blend.
      bench?.park();
      currentMode = mode;
      for (const mesh of meshes) mesh.renderOrder = 0;
      unified.wear();
      unified.setInk(mode === "ink" ? 1 : 0);
      return;
    }
    if (!bench) {
      // Unreachable from /lens, which awaits enableShadingBench before it wires
      // the buttons — and impossible on the hero, which never asks for one.
      console.warn(
        `lens shading: "${mode}" needs the bench chunk — call SceneHandle.enableShadingBench() first`,
      );
      return;
    }
    currentMode = mode;
    // A bench look draws its own line-work, so the merged pair's has to go.
    unified.setInk(0);
    bench.wear(mode, meshes);
  }

  // Fold meshes that appear AFTER the initial capture (the accessories GLB)
  // into the roster, so a later mode switch covers them too. The merged pair
  // needs nothing here — core/scene runs unified.integrate first.
  function integrate(target: THREE.Object3D) {
    target.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || known.has(o)) return;
      meshes.push(o);
      known.add(o);
      bench?.integrate(o);
    });
  }

  function setTheme(l: boolean) {
    if (l === light) return;
    light = l;
    // The merged pair re-tints in place (colour uniforms), no rebuild…
    unified.setTheme(l);
    // …while every bench build is palette-BAKED, parked ones included: keeping
    // them would re-wear the old theme's colours on the next switch.
    bench?.setTheme(l);
    if (!MERGED(currentMode)) set(currentMode); // rebuild under the other palette
  }

  function withOriginals(cb: () => void) {
    const worn = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
    for (const mesh of meshes) worn.set(mesh, mesh.material);
    const blend = unified.ink();
    unified.setInk(0);
    unified.wear();
    try {
      cb();
    } finally {
      // the blend FIRST: it writes the elements' material itself, so the exact
      // restore below has to land after it
      unified.setInk(blend);
      for (const [mesh, mat] of worn) mesh.material = mat;
    }
  }

  return {
    set,
    installBench(factory) {
      bench ??= factory(light);
    },
    hasBench: () => bench !== null,
    integrate,
    setTheme,
    withOriginals,
    dispose() {
      bench?.dispose();
    },
  };
}
