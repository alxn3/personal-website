// The model's `.visible` sweep — the ONE place a lens piece's flag is written
// (core/scene.ts applyVisibility delegates here; see its doc comment for the
// gate inventory). A pure function of the CURRENT gate state: it reads the
// gates, never mutates them, and carries no state of its own between calls —
// which is the law core/scene.ts's dirty flag rests on. Gate writers only mark
// the composition stale; the sweep runs once, in tick(), before the render
// that could show it — so N gate moves in one frame cost one traversal, a
// frame with no gate motion costs none, and the outcome is identical to
// sweeping at every mutation site (the law test walks that equivalence).
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
  // read the gates ONCE per pass (core/scene.ts serves the booleans through
  // getters over its closure state; nothing can move them mid-traversal)
  const { bodyFadedOut, glassGone, shellGone, interiorGone } = g;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    // materials/shading parents its inverted-hull pass UNDER the mesh it
    // outlines — not a piece of the lens, and it rides its host's flag.
    if (o.parent instanceof THREE.Mesh) return;
    if (g.underAccessory(o)) return;
    o.visible =
      // the two glass fades' tail, scoped by the set writeGlassOpacity keeps:
      // exactly the meshes this scene swapped a clone onto whose effective
      // opacity has reached 0 (stack-wide fade × passage fade)
      !glassGone.has(o) &&
      // the body fade's tail: everything that is NOT glass, once it hits 0
      !(bodyFadedOut && !isOpticalGlass(o.name)) &&
      // the shell gate (setShellFade): the peel's cast and the baffles,
      // each from its own point in the story's fade
      !shellGone.has(o) &&
      // the interior gate (setInteriorFade): the cladding and the rest-cast,
      // off for the cards/internals span and back for the dive
      !interiorGone.has(o);
  });
}

// ── THE THRESHOLD-WINK LAW (setShellFade / setInteriorFade) ─────────────────
//
// `shellGone` and `interiorGone` above are the OUTPUT of this law; it lives here
// so the two halves of one question — which pieces are hidden, and why — have
// one home. core/scene.ts owns the LEVELS and the sets; the bands and the
// scatter are pure, so they are read (never re-derived) by story/cost.ts, which
// reproduces the gates in node off the shipped GLB.
//
// A level is a per-mesh THRESHOLD rather than a material opacity, so the cast
// leaves piece by piece across the story's fade and no shading swap can stomp
// it: a mesh is gone once the level has fallen TO its threshold (`level <= t`).

/** The slice of a fade level, measured UP FROM 0, that the wink-outs are spread
 *  over. The remainder is the tail at the TOP of the level (0.85 → 1), where
 *  every threshold is already below the level and the cast is therefore still
 *  wholly PRESENT — slack before the first piece leaves. */
export const SHELL_FEATHER = 0.85;
/** THE BANDS inside the shell channel's feather, measured up from 0. A higher
 *  threshold means a piece leaves EARLIER, so the bands read top-down as the
 *  departure order — outside-in:
 *
 *      decals   [0.62, 0.85)   the printed markings, first
 *      wedges   [0.30, 0.62)   the shell itself
 *      baffles  [0,    0.30)   the internal light traps, last
 *
 *  Decals band ABOVE the wedges because a marking is printed ON a wedge and the
 *  scatter is sector-blind: a decal drawn after its host would float alone once
 *  the wedge winked. Baffles band below — the bore may only open once the skin
 *  has gone. */
export const DECAL_BAND = 0.62;
export const EXTRA_BAND = 0.3;
/** Inside the INTERIOR channel's own feather: the tubes above (they leave first,
 *  being what the shell uncovers), the rest-cast below — the deepest hardware
 *  leaves last and, on the RETURN with the level rising, reappears first, so the
 *  lens re-forms inside-out. */
export const REST_BAND = 0.3;

/** Which fade level owns a mesh's wink, and where in that level it sits. */
export interface WinkThreshold {
  channel: "shell" | "interior";
  threshold: number;
}

/** Golden-ratio scatter over the capture order, WITHIN a band: deterministic (so
 *  a scrub back and forth is stable), near-uniform, and consecutive pieces —
 *  which are a part's own neighbouring wedges — never leave together. The
 *  half-step offset keeps the first mesh off the band's floor exactly, where
 *  `gone = level <= t` would strand it visible until the level hit that value
 *  dead on. */
export const inBand = (n: number, lo: number, hi: number): number =>
  lo + (((n + 0.5) * 0.618034) % 1) * (hi - lo);

/** A fresh scatter, to be fed every top-level mesh name IN TRAVERSAL ORDER —
 *  the order IS an input, since each band's counter advances per member. Returns
 *  the mesh's threshold, or null for a mesh neither gate governs.
 *
 *  ONE law, two callers: core/scene.ts walks the live `gltfScene` with it, and
 *  story/cost.ts walks the shipped GLB's node graph. */
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
