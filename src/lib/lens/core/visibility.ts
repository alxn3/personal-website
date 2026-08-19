// The model's `.visible` sweep — the ONE place a lens piece's flag is written
// (core/scene.ts's applyVisibility delegates here).
//
// PURE FUNCTION OF THE CURRENT GATE STATE: it reads the gates, never mutates
// them, and keeps nothing between calls. That is what makes core/scene.ts's
// dirty-flag deferral sound — writers only mark the composition stale and the
// sweep runs once per frame, with the same outcome as sweeping at every site.
import * as THREE from "three/webgpu";
import {
  isDecal,
  isOpticalGlass,
  isPeelExtra,
  isPeelRest,
  isPeelTube,
  isShellPart,
} from "./parts";

export interface VisibilityGates {
  /** accessory-ness by ancestry (sub-meshes carry generic names). Accessories
   *  keep their OWN owner — the page's accessory choice — so the sweep only
   *  ever skips them. */
  underAccessory(o: THREE.Object3D): boolean;
  /** glass meshes whose transmissive-clone opacity reached 0 (the glass fades'
   *  tail — see core/scene.ts writeGlassOpacity) */
  readonly glassGone: ReadonlySet<THREE.Mesh>;
  /** the body fade's hard tail (setBodyFade at 0) */
  readonly bodyFadedOut: boolean;
  /** the shell gate's currently-hidden set (setShellFade thresholds) */
  readonly shellGone: ReadonlySet<THREE.Mesh>;
  /** the interior gate's currently-hidden set (setInteriorFade thresholds) */
  readonly interiorGone: ReadonlySet<THREE.Mesh>;
}

/** Compose every active gate over the model: a piece is visible iff EVERY gate
 *  allows it, so no gate's restore can stomp another that is still engaged. */
export function sweepVisibility(
  root: THREE.Object3D,
  g: VisibilityGates,
): void {
  // read the gates ONCE per pass — scene.ts serves them through getters
  const { bodyFadedOut, glassGone, shellGone, interiorGone } = g;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    // the inverted-hull outline pass is parented under the mesh it outlines —
    // not a lens piece, and it rides its host's flag
    if (o.parent instanceof THREE.Mesh) return;
    if (g.underAccessory(o)) return;
    o.visible =
      // the glass fades' tail (writeGlassOpacity)
      !glassGone.has(o) &&
      // the body fade's tail: everything that is NOT glass, once it hits 0
      !(bodyFadedOut && !isOpticalGlass(o.name)) &&
      // the shell gate: the peel's cast and the baffles
      !shellGone.has(o) &&
      // the interior gate: the cladding and the rest-cast
      !interiorGone.has(o);
  });
}

// ── THE THRESHOLD-WINK LAW (setShellFade / setInteriorFade) ─────────────────
// `shellGone`/`interiorGone` are the OUTPUT of this law. core/scene.ts owns the
// LEVELS and the sets; the bands and the scatter are pure, so a second caller
// can reproduce the gates off the shipped GLB rather than re-deriving them.
//
// A level is a per-mesh THRESHOLD, not a material opacity, so the cast leaves
// piece by piece and no shading swap can stomp it: gone once `level <= t`.

/** The slice of a fade level, measured UP FROM 0, the wink-outs spread over.
 *  Above it every threshold is below the level, so the cast is wholly present —
 *  slack before the first piece leaves. */
export const SHELL_FEATHER = 0.85;
/** THE BANDS inside the shell channel's feather. A higher threshold means a
 *  piece leaves EARLIER, so they read top-down as the departure order:
 *  decals [0.62, 0.85), shell wedges [0.30, 0.62), baffles [0, 0.30).
 *  Decals must band above their host wedges (the scatter is sector-blind, so a
 *  decal outliving its wedge would float alone); baffles below, since the bore
 *  may only open once the skin has gone. */
export const DECAL_BAND = 0.62;
export const EXTRA_BAND = 0.3;
/** Inside the INTERIOR channel's feather: tubes above, rest-cast below, so the
 *  deepest hardware leaves last and returns first (the lens re-forms
 *  inside-out). */
export const REST_BAND = 0.3;

/** Which fade level owns a mesh's wink, and where in that level it sits. */
export interface WinkThreshold {
  channel: "shell" | "interior";
  threshold: number;
}

/** Golden-ratio scatter within a band: deterministic (so scrubbing is stable),
 *  near-uniform, and consecutive pieces — a part's own neighbouring wedges —
 *  never leave together. The half-step offset keeps the first mesh off the
 *  band's floor, where `gone = level <= t` would strand it visible. */
export const inBand = (n: number, lo: number, hi: number): number =>
  lo + (((n + 0.5) * 0.618034) % 1) * (hi - lo);

/** A fresh scatter, fed every top-level mesh name IN TRAVERSAL ORDER — the
 *  order is an input, since each band's counter advances per member. Returns
 *  null for a mesh neither gate governs. */
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
      return { channel: "interior", threshold: inBand(r++, 0, REST_BAND) };
    if (isPeelExtra(name))
      return { channel: "shell", threshold: inBand(e++, 0, EXTRA_BAND) };
    if (isShellPart(name))
      return {
        channel: "shell",
        threshold: isDecal(name)
          ? inBand(d++, DECAL_BAND, SHELL_FEATHER)
          : inBand(i++, EXTRA_BAND, DECAL_BAND),
      };
    return null;
  };
}
