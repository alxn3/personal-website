// Caption fade fallback for browsers without `animation-timeline: view()`: an
// IntersectionObserver marks the one band the reader is in with `.is-in`.
// Must not import from lib/lens, so a failed 3D chunk can't break captions.

export interface CapFadeTarget {
  classList: { toggle(token: string, force: boolean): void };
}

export interface CapFadeEntry {
  target: CapFadeTarget;
  isIntersecting: boolean;
  /** the band's top edge is above the line */
  above: boolean;
}

/** Bands in document order, which cross the line, and whether the last has started. */
export interface CapFadeState {
  targets: readonly CapFadeTarget[];
  intersecting: Set<CapFadeTarget>;
  lastStarted: boolean;
}

export const capFadeState = (
  targets: readonly CapFadeTarget[],
): CapFadeState => ({ targets, intersecting: new Set(), lastStarted: false });

/** Lights the first band crossing the line; with none crossing, the last band
 *  if it has started, otherwise nothing. */
export const applyCapFades = (
  state: CapFadeState,
  entries: readonly CapFadeEntry[],
): void => {
  const last = state.targets.at(-1);
  for (const e of entries) {
    if (e.isIntersecting) state.intersecting.add(e.target);
    else state.intersecting.delete(e.target);
    if (e.target === last) state.lastStarted = e.above;
  }
  const lit =
    state.targets.find((t) => state.intersecting.has(t)) ??
    (state.lastStarted ? last : undefined);
  for (const t of state.targets) t.classList.toggle("is-in", t === lit);
};

/** Starts the fallback; a no-op where CSS scroll timelines are supported. */
export function startCapFades(): void {
  if (CSS.supports("animation-timeline", "view()")) return;
  // Bands are observed, never the sticky captions (they outlive their band).
  const bands = [...document.querySelectorAll<HTMLElement>(".cap-band")];
  const state = capFadeState(bands);
  let started = false;
  const io = new IntersectionObserver(
    (entries) => {
      // The first batch sets the initial state; arm the transition a frame later.
      if (!started) {
        started = true;
        const hero = document.getElementById("lens-hero");
        hero?.classList.add("cap-io");
        requestAnimationFrame(() => hero?.classList.add("cap-io-armed"));
      }
      applyCapFades(
        state,
        entries.map((e) => ({
          target: e.target as HTMLElement,
          isIntersecting: e.isIntersecting,
          above:
            e.boundingClientRect.top < (e.rootBounds?.bottom ?? innerHeight),
        })),
      );
    },
    // The root shrinks to a line along the viewport's bottom edge.
    { rootMargin: "-100% 0px 0px 0px", threshold: 0 },
  );
  for (const el of bands) io.observe(el);
}
