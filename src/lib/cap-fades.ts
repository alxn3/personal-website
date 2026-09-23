// Hero caption fades, fallback path: browsers without `animation-timeline:
// view()` get an IntersectionObserver that lights `.is-in` on the ONE band the
// reader is in (bands overlap, so applyCapFades arbitrates). It observes the
// BANDS, never the captions — a sticky caption rides its band's bottom edge a
// viewport past the scene's end. Standalone on purpose: imports nothing from
// lib/lens and ships in its own <script>, so a failed 3D chunk cannot take the
// captions with it. Additive: CSS hides captions only under `.cap-io`, and
// `.cap-io-armed` enables the transition one frame later so load never animates.

/** Markup contract: LensSceneContent and LensStory wrap every caption in one of
 *  these — its scene's slice of the scroll track — and the CSS lights the
 *  caption inside whichever band this module marks `.is-in`. */
export const CAP_BAND_SELECTOR = ".cap-band";

/** Collapses the observer root to a zero-height line along the viewport's
 *  bottom edge. A band for [a, b] spans document [a·S, b·S + 100svh] (story.ts),
 *  so it crosses the line while scrollY ∈ (a·S − 100dvh, b·S). */
export const CAP_FADE_ROOT_MARGIN = "-100% 0px 0px 0px";

export interface CapFadeTarget {
  classList: { toggle(token: string, force: boolean): void };
}

export interface CapFadeEntry {
  target: CapFadeTarget;
  isIntersecting: boolean;
  /** the band's top edge is above the line (it has started) */
  above: boolean;
}

/** The observed bands in DOCUMENT order, which of them cross the line, and
 *  whether the last band has started. */
export interface CapFadeState {
  targets: readonly CapFadeTarget[];
  intersecting: Set<CapFadeTarget>;
  lastStarted: boolean;
}

export const capFadeState = (
  targets: readonly CapFadeTarget[],
): CapFadeState => ({ targets, intersecting: new Set(), lastStarted: false });

/** The observer body, split out so it is testable without a DOM. Lights ONE
 *  band — the first crossing the line in document order (story order), since a
 *  batch of booleans cannot crossfade two stacked captions. With none crossing,
 *  the last band stays lit only once it has started (at max scroll its bottom
 *  edge sits on the line); a gap mid-track lights nothing, as the CSS path does. */
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

/** Wire the fallback. A no-op where the browser drives the fades in CSS — the
 *  same condition the stylesheet's @supports test asks. */
export function startCapFades(root: ParentNode = document): void {
  if (CSS.supports("animation-timeline", "view()")) return;
  // querySelectorAll returns DOCUMENT order, which the one-at-a-time rule needs
  const bands = [...root.querySelectorAll<HTMLElement>(CAP_BAND_SELECTOR)];
  const state = capFadeState(bands);
  let started = false;
  const io = new IntersectionObserver(
    (entries) => {
      // The first batch lands as the initial state; the transition is armed a
      // frame later so load never animates.
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
    { rootMargin: CAP_FADE_ROOT_MARGIN, threshold: 0 },
  );
  for (const el of bands) io.observe(el);
}
