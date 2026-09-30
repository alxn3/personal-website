import * as THREE from "three/webgpu";
import type { UnifiedLook } from "./unified";
import type { ShadingBench, ShadingBenchFactory } from "./shading-bench";

// Switches the model's render style. "realistic" and "ink" are one blended
// material (unified.ts); the other looks live in shading-bench.ts, loaded
// lazily on /lens only. Only `import type` from shading-bench here, or it
// lands in the homepage bundle.
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

/** The looks shading-bench.ts builds. */
export type BenchMode = Exclude<ShadingMode, "realistic" | "ink">;

/** True for the two looks served by the blended material. */
const MERGED = (mode: ShadingMode): mode is "realistic" | "ink" =>
  mode === "realistic" || mode === "ink";

export interface ShadingController {
  /** Switch look. Bench looks need `installBench` first (else warns, no-op). */
  set(mode: ShadingMode): void;
  /** Install the lazily loaded bench. Only the first call has an effect. */
  installBench(factory: ShadingBenchFactory): void;
  hasBench(): boolean;
  /** Add meshes that loaded later (the accessories). */
  integrate(root: THREE.Object3D): void;
  /** Re-palette for the site theme (light = no `.dark` on <html>). */
  setTheme(light: boolean): void;
  /** Run `cb` with every mesh in the realistic look, then restore exactly
   *  what each wore before (ink blend included). */
  withOriginals(cb: () => void): void;
}

export function createShading(
  root: THREE.Object3D,
  unified: UnifiedLook,
): ShadingController {
  let light = !document.documentElement.classList.contains("dark");
  let currentMode: ShadingMode = "realistic";
  const meshes = new Set<THREE.Mesh>();
  /** null until installBench (always null on the homepage) */
  let bench: ShadingBench | null = null;

  function set(mode: ShadingMode) {
    if (MERGED(mode)) {
      // undo any bench look, then apply the blend
      bench?.park();
      currentMode = mode;
      unified.wear();
      unified.setInk(mode === "ink" ? 1 : 0);
      return;
    }
    if (!bench) {
      console.warn(
        `lens shading: "${mode}" needs the bench chunk — call SceneHandle.enableShadingBench() first`,
      );
      return;
    }
    currentMode = mode;
    // bench looks draw their own lines
    unified.setInk(0);
    bench.wear(mode, meshes);
  }

  function integrate(target: THREE.Object3D) {
    target.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || meshes.has(o)) return;
      meshes.add(o);
      bench?.integrate(o);
    });
  }
  integrate(root);

  function setTheme(l: boolean) {
    if (l === light) return;
    light = l;
    unified.setTheme(l);
    bench?.setTheme(l);
    if (!MERGED(currentMode)) set(currentMode); // rebuild with the new palette
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
      // blend first: it sets the glass materials, which the restore overrides
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
  };
}
