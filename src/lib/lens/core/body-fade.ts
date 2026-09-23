// The body fade's capture law (SceneHandle.setBodyFade). The fade writes
// `opacity` onto shared materials, so it remembers what each wore and puts it
// back exactly at 1. The capture is by material identity and only ever grows:
// a material that joins the set mid-fade (the glass, when the dive hands it
// back) is captured from its shipped state and written the live level.

/** the slice of THREE.Material the fade writes */
export interface FadeMaterial {
  transparent: boolean;
  opacity: number;
  needsUpdate: boolean;
}

export interface FadeSaved {
  transparent: boolean;
  opacity: number;
}

/** Fold every material of `materials` not yet in `saved` into the capture and
 *  write `opacity` on the whole set. `ownsTransparent` names the materials
 *  whose flag has another owner (materials/unified.ts) and is left alone.
 *  `transparent` is raised only where it moves: three keys a pipeline on it,
 *  so `needsUpdate` there is a program rebuild. */
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

/** Put every captured material back exactly and empty the capture, so the
 *  next fade captures afresh — a look swap may have re-materialed every mesh
 *  since. */
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
