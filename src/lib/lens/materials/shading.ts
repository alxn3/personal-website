import * as THREE from "three/webgpu";
import type { UnifiedLook } from "./unified";
import type { ShadingBench, ShadingBenchFactory } from "./shading-bench";

// ============================================================================
// THE LOOK SWAPPER — and, since the demo era ended, almost nothing else.
//
// THE STORY'S PAIR IS THE ONLY LOOK THIS FILE CAN WEAR. "realistic" and "ink"
// are ONE blended material (materials/unified.ts); set("ink") is a uniform
// write, not a swap, so the whole hero path through here is: clear any foreign
// renderOrder, put the merged materials on, write the blend.
//
// THE SEVEN BENCH LOOKS ARE A LAZY CHUNK (materials/shading-bench.ts) and
// /lens-only. They used to live in this file, which put ~600 lines of palettes,
// per-mesh build machinery and a procedural bronze matcap into the SHARED chunk
// the homepage hero loads — for looks the story can never show. The boundary:
//
//   · this file names the bench through TYPES ONLY (`import type` above, erased
//     at build), so Rollup sees no static edge to it;
//   · core/scene.ts's `enableShadingBench()` dynamically imports the module and
//     hands `createShadingBench` to `installBench` below;
//   · every bench call is `bench?.…` — with no bench installed, this controller
//     is complete for the story and `set` REFUSES a bench mode rather than half
//     applying one.
//
// The mesh ROSTER, the site theme and the current mode stay here, on both
// halves' behalf: `withOriginals` needs the roster with no bench in sight, and
// two copies of "which theme are we in" is exactly the drift the split must not
// introduce.
// ============================================================================
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
 *  A type PREDICATE, so `set`'s merged early-return is what narrows the rest of
 *  the function to a `BenchMode`: the two halves of the union are checked by
 *  the compiler rather than by a cast at the hand-over. */
const MERGED = (mode: ShadingMode): mode is "realistic" | "ink" =>
  mode === "realistic" || mode === "ink";

export interface ShadingController {
  /** Wear `mode`.
   *
   *  "realistic"/"ink" are a UNIFORM WRITE on the merged material (plus the two
   *  booleans it cannot blend). A bench look needs `installBench` first — see
   *  the header; without one this warns and holds the current look rather than
   *  leaving the meshes half swapped. */
  set(mode: ShadingMode): void;
  /** Plug in the lazily-imported bench half (core/scene's enableShadingBench).
   *  Idempotent: a second call keeps the first bench, so its parked builds
   *  survive. Takes the FACTORY, not the bench, so this controller stays the
   *  one owner of the site-theme flag. */
  installBench(factory: ShadingBenchFactory): void;
  /** Whether a bench is installed — the modes outside the story's pair are
   *  wearable iff this is true. */
  hasBench(): boolean;
  /** Fold meshes that loaded AFTER creation (the background accessories) into
   *  the swapper and style them in the current mode. Idempotent per mesh. The
   *  merged pair takes them through unified.integrate, which core/scene calls
   *  first. */
  integrate(root: THREE.Object3D): void;
  /** Re-palette for the site theme (light = no `.dark` on <html>). The merged
   *  pair re-tints in place; a bench look rebuilds. No-op if unchanged. */
  setTheme(light: boolean): void;
  /** Wear the REALISTIC look for the duration of `cb`, then put back exactly
   *  what each mesh was wearing.
   *
   *  NOT `set("realistic")` and back: that would leave the ink blend at 0 on the
   *  way out and, from a bench look, park and unpark its extras — and it would
   *  stomp anything else riding on a mesh (the transmissive glass clones the
   *  warm-up itself puts on). This drops the blend to 0, puts the merged
   *  materials on, and restores both, so a caller that needs the realistic look
   *  for one off-screen frame (core/scene's fly warm-up) pays nothing for the
   *  trip. The blend matters: `transparent` rides it, and a pipeline is keyed on
   *  that — warming the wrong one would warm nothing. */
  withOriginals(cb: () => void): void;
  dispose(): void;
}

export function createShading(
  root: THREE.Object3D,
  unified: UnifiedLook,
): ShadingController {
  // site theme — the palettes flip between paper-light and stage-dark. Detected
  // here so both pages get the right palette without wiring; toggles arrive via
  // setTheme (the pages own the observer — a controller-owned one would leak).
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
      // THE STORY'S PAIR: park whatever bench look held the meshes, then no
      // per-mesh work beyond the renderOrder clear every mode owes — a bench
      // look that assigned one must not leave it on the story. Then put the
      // merged materials back and write the blend.
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
    // A bench look draws its own line-work, so the merged pair's has to go —
    // setInk(0) hides it and costs nothing else while nothing wears the merged
    // materials.
    unified.setInk(0);
    bench.wear(mode, meshes);
  }

  // Fold meshes that appear AFTER the initial capture (the background accessories
  // GLB) into the swapper and apply the current mode using the SAME shared
  // caches, so a later mode switch covers them too. Idempotent — already-known
  // meshes are skipped. The merged pair needs nothing here: core/scene runs
  // unified.integrate first, which is what puts the blended material on a late
  // arrival (and the bench's own integrate is a no-op while the pair is worn).
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
    // The merged pair re-tints IN PLACE (colour uniforms), so the story's two
    // looks survive a flip without a single material being rebuilt…
    unified.setTheme(l);
    // …while every bench build is palette-BAKED, not just the live one: keeping
    // the parked ones would re-wear the old theme's colours on the next switch.
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
