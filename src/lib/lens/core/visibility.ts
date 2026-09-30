// Which model pieces are visible, and the per-piece dissolve thresholds for
// the shell and interior fades. The only writer of a lens piece's `.visible`.
import * as THREE from "three/webgpu";
import { smoothstep } from "./math";
import { WINK_NONE } from "../ops/frames";
import {
  isAccessory,
  isDecal,
  isOpticalGlass,
  isPeelExtra,
  isPeelRest,
  isPeelTube,
  isShellPart,
} from "./parts";

/** The fade states that can hide a piece. */
export interface VisibilityGates {
  /** glass meshes faded to 0 */
  readonly glassGone: ReadonlySet<THREE.Mesh>;
  /** body fade at 0: everything but the glass is hidden */
  readonly bodyFadedOut: boolean;
  readonly shellGone: ReadonlySet<THREE.Mesh>;
  readonly interiorGone: ReadonlySet<THREE.Mesh>;
}

/** Accessory sub-meshes have generic names, so check the ancestors too. */
function underAccessory(o: THREE.Object3D): boolean {
  for (let a: THREE.Object3D | null = o; a; a = a.parent)
    if (isAccessory(a.name)) return true;
  return false;
}

/** Set `.visible` on every model mesh: shown unless any gate hides it.
 *  Accessories are skipped (the page controls them). */
export function sweepVisibility(
  root: THREE.Object3D,
  g: VisibilityGates,
): void {
  const { bodyFadedOut, glassGone, shellGone, interiorGone } = g;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    // outline meshes are children of the mesh they outline and follow it
    if (o.parent instanceof THREE.Mesh) return;
    if (underAccessory(o)) return;
    o.visible =
      !glassGone.has(o) &&
      !(bodyFadedOut && !isOpticalGlass(o.name)) &&
      !shellGone.has(o) &&
      !interiorGone.has(o);
  });
}

// Shell/interior dissolve ("wink"): each mesh has a threshold `t`. As the fade
// level drops from t to t - WINK_WIDTH the piece dissolves, then it is hidden.
// The shader reads the same threshold from the `_opY.w` attribute.

/** How much of the fade level one piece's dissolve spans. */
export const WINK_WIDTH = 0.2;
/** Thresholds all lie below this level. */
export const SHELL_FEATHER = 0.85;
/** Shell-channel bands (higher leaves earlier): decals [0.62, 0.85), baffles
 *  [0.5, 0.62), shell segments [WINK_WIDTH, 0.5). Decals must leave before the
 *  segments they sit on. */
export const DECAL_BAND = 0.62;
export const EXTRA_BAND = 0.5;
/** Interior-channel split: tubes above, other singles below. */
export const REST_BAND = 0.36;

/** A piece's opacity at a fade level: 1 at or above `t`, 0 at or below
 *  `t - WINK_WIDTH`. Mirrors `winkFactor` in materials/unified.ts. */
export const winkOpacity = (t: number, level: number): number =>
  smoothstep(t - WINK_WIDTH, t, level);

/** True where `winkOpacity` is exactly 0. */
export const winkGone = (t: number, level: number): boolean =>
  level <= t - WINK_WIDTH;

/** A mesh's fade channel and dissolve threshold. */
export interface WinkThreshold {
  channel: "shell" | "interior";
  threshold: number;
}

/** Encode for the `_opY.w` attribute: WINK_NONE (no fade), `t` (shell) or
 *  `2 + t` (interior). */
export const packWink = (w: WinkThreshold | null): number =>
  w === null ? WINK_NONE : w.threshold + (w.channel === "interior" ? 2 : 0);

export const unpackWink = (lane: number): WinkThreshold | null =>
  lane < 0
    ? null
    : lane < 1.5
      ? { channel: "shell", threshold: lane }
      : { channel: "interior", threshold: lane - 2 };

/** The n-th threshold in [lo, hi): a golden-ratio scatter, so consecutive
 *  pieces don't leave together. The half step keeps the first off the floor. */
export const inBand = (n: number, lo: number, hi: number): number =>
  lo + (((n + 0.5) * 0.618034) % 1) * (hi - lo);

/** Assigns thresholds to mesh names; call in traversal order (each band
 *  counts its members). Returns null for meshes that don't fade. */
export function makeWinkScatter(): (name: string) => WinkThreshold | null {
  let i = 0;
  let d = 0;
  let e = 0;
  let t = 0;
  let r = 0;
  return (name) => {
    if (isPeelTube(name))
      return { channel: "interior", threshold: inBand(t++, REST_BAND, SHELL_FEATHER) }; // prettier-ignore
    if (isPeelRest(name))
      return { channel: "interior", threshold: inBand(r++, WINK_WIDTH, REST_BAND) }; // prettier-ignore
    if (isPeelExtra(name))
      return { channel: "shell", threshold: inBand(e++, EXTRA_BAND, DECAL_BAND) }; // prettier-ignore
    if (isShellPart(name))
      return {
        channel: "shell",
        threshold: isDecal(name)
          ? inBand(d++, DECAL_BAND, SHELL_FEATHER)
          : inBand(i++, WINK_WIDTH, EXTRA_BAND),
      };
    return null;
  };
}

/** Write each mesh's threshold into its `_opY.w` attribute and return the
 *  thresholds, rounded to float32 so they match the shader exactly. Run after
 *  deriveFrames and before the ink edges are cut. */
export function stampWinkLanes(
  root: THREE.Object3D,
): Map<THREE.Mesh, WinkThreshold> {
  const wink = makeWinkScatter();
  const out = new Map<THREE.Mesh, WinkThreshold>();
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh) || o.parent instanceof THREE.Mesh) return;
    const lane = Math.fround(packWink(wink(o.name)));
    const w = unpackWink(lane);
    if (w) out.set(o, w);
    const y = o.geometry.getAttribute("_opY");
    if (!y) return;
    for (let i = 0; i < y.count; i++) y.setW(i, lane);
    y.needsUpdate = true;
  });
  return out;
}
