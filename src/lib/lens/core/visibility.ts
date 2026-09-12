// The model's `.visible` sweep — the one place a lens piece's flag is written
// (core/scene.ts's applyVisibility delegates here). A pure function of the
// current gate state: it never mutates the gates and keeps nothing between
// calls, so scene.ts can defer it to once per frame behind a dirty flag.
import * as THREE from "three/webgpu";
import { smoothstep } from "./math";
import { WINK_NONE } from "../ops/frames";
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
   *  keep their own owner — the page's choice — so the sweep skips them. */
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

/** Compose every active gate over the model: a piece is visible iff every gate
 *  allows it, so no gate's restore can stomp another that is still engaged. */
export function sweepVisibility(
  root: THREE.Object3D,
  g: VisibilityGates,
): void {
  // read the gates once per pass — scene.ts serves them through getters
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
      // the body fade's tail: everything that is not glass, once it hits 0
      !(bodyFadedOut && !isOpticalGlass(o.name)) &&
      // the shell gate: the peel's cast and the baffles
      !shellGone.has(o) &&
      // the interior gate: the cladding and the rest-cast
      !interiorGone.has(o);
  });
}

// The threshold-wink law (setShellFade / setInteriorFade): a fade level is
// compared against a per-mesh threshold `t`. A piece is whole while
// `level >= t`, dissolves over `WINK_WIDTH` of the level below it, and is gone
// (opacity exactly 0, then off the visibility pass) once `level <= t − w`.
// The materials read the same law off the `_opY.w` lane `stampWinkLanes`
// writes; scene.ts owns the levels and the `shellGone`/`interiorGone` sets.

/** How much of a fade level one piece's dissolve spans. */
export const WINK_WIDTH = 0.2;
/** The slice of a fade level, measured up from 0, the dissolves spread over.
 *  Above it the cast is wholly present — slack before the first piece goes. */
export const SHELL_FEATHER = 0.85;
/** The bands inside the shell channel's feather. A higher threshold means a
 *  piece leaves earlier, so they read top-down as the dissolve order: decals
 *  [0.62, 0.85), baffles [0.5, 0.62), shell wedges [w, 0.5). Decals must band
 *  above their host wedges (the scatter is sector-blind, so a decal outliving
 *  its wedge would float alone); the wedges go last, so the cards born on them
 *  (story/peelcards.ts) arrive across the scene boundary, under the turn. Every
 *  band floors at WINK_WIDTH, so the lowest piece is exactly gone at level 0. */
export const DECAL_BAND = 0.62;
export const EXTRA_BAND = 0.5;
/** Inside the interior channel's feather: tubes above, rest-cast below, so the
 *  deepest hardware leaves last and returns first. */
export const REST_BAND = 0.36;

/** A piece's opacity at a fade level: 1 at and above its threshold, 0 at and
 *  below `t − WINK_WIDTH`. materials/unified.ts `winkFactor` is this in TSL. */
export const winkOpacity = (t: number, level: number): number =>
  smoothstep(t - WINK_WIDTH, t, level);

/** Off the visibility pass: where `winkOpacity` is exactly 0. */
export const winkGone = (t: number, level: number): boolean =>
  level <= t - WINK_WIDTH;

/** Which fade level owns a mesh's wink, and where in that level it sits. */
export interface WinkThreshold {
  channel: "shell" | "interior";
  threshold: number;
}

/** The `_opY.w` lane: WINK_NONE for an ungoverned piece, `t` on the shell
 *  channel, `2 + t` on the interior one. */
export const packWink = (w: WinkThreshold | null): number =>
  w === null ? WINK_NONE : w.threshold + (w.channel === "interior" ? 2 : 0);

export const unpackWink = (lane: number): WinkThreshold | null =>
  lane < 0
    ? null
    : lane < 1.5
      ? { channel: "shell", threshold: lane }
      : { channel: "interior", threshold: lane - 2 };

/** Golden-ratio scatter within a band: deterministic, near-uniform, and
 *  consecutive pieces never leave together. The half-step offset keeps the
 *  first mesh off the band's floor, where `level <= t` would strand it. */
export const inBand = (n: number, lo: number, hi: number): number =>
  lo + (((n + 0.5) * 0.618034) % 1) * (hi - lo);

/** A fresh scatter, fed every top-level mesh name in traversal order — the
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

/** Run the scatter over every top-level mesh under `root`, in traversal order,
 *  and write each mesh's wink onto its `_opY.w` lane (a framed geometry's every
 *  vertex). Returns the governed meshes' thresholds, for the visibility cut, as
 *  the float32 values the lane holds — so the cut and the shader agree exactly.
 *  Runs once at model prep, after ops/frames.ts deriveFrames and before the
 *  ink edges are cut, so the line geometry carries the lane too. */
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
