// Save/restore for SceneHandle.setBodyFade, which writes `opacity` onto shared
// materials and must put each one back exactly at full opacity.

/** the part of THREE.Material the fade writes */
export interface FadeMaterial {
  transparent: boolean;
  opacity: number;
  needsUpdate: boolean;
}

export interface FadeSaved {
  transparent: boolean;
  opacity: number;
}

/** Save any of `materials` not yet in `saved`, then write `opacity` on all
 *  saved ones. Leaves `transparent` alone where `ownsTransparent` says so. */
export function captureBodyFade<M extends FadeMaterial>(
  saved: Map<M, FadeSaved>,
  materials: Iterable<M>,
  ownsTransparent: (m: M) => boolean,
  opacity: number,
): void {
  for (const m of materials) {
    if (saved.has(m)) continue;
    saved.set(m, { transparent: m.transparent, opacity: m.opacity });
    if (ownsTransparent(m) || m.transparent) continue;
    m.transparent = true;
    m.needsUpdate = true;
  }
  for (const m of saved.keys()) m.opacity = opacity;
}

/** Restore every saved material and clear `saved`. */
export function restoreBodyFade<M extends FadeMaterial>(
  saved: Map<M, FadeSaved>,
  ownsTransparent: (m: M) => boolean,
): void {
  for (const [m, was] of saved) {
    m.opacity = was.opacity;
    if (ownsTransparent(m) || m.transparent === was.transparent) continue;
    m.transparent = was.transparent;
    m.needsUpdate = true;
  }
  saved.clear();
}
