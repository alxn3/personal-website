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

/** Collapses the observer root to a zero-height LINE along the viewport's BOTTOM
 *  edge: a −100% TOP margin shrinks the root down onto it. That line, not a
 *  slice, is what makes this path scene-accurate.
 *
 *  A band for scene [a, b] occupies document [a·S, b·S + 100svh], where S is the
 *  track's scrollable length (story.ts — the trailing viewport is the sticky
 *  caption's pin room). The observer's line, though, is the LIVE viewport bottom
 *  — an implicit IntersectionObserver root is the LAYOUT viewport, whose height
 *  is the DYNAMIC one on iOS — so a band straddles it while
 *  scrollY ∈ [a·S − 100dvh, b·S + (100svh − 100dvh)]. Bands overlap, so
 *  applyCapFades keeps the FIRST one in document order: band N lights when N−1
 *  releases at b(N−1)·S = (p0 + PAD)·S and releases at (p1 + PAD)·S — its own
 *  scene, shifted by one PAD of scroll (~233px at 1440×900). The only
 *  viewport-height term left is (100svh − 100dvh): zero except on an iOS Safari
 *  with the toolbar hidden, where it is NEGATIVE, up to ~80px in magnitude — a
 *  fraction of a pad, and it
 *  moves a fade THRESHOLD, never a box, so the worst it can do is hand a
 *  caption over slightly early. Nothing here to tune at any screen size.
 *
 *  Anchoring to the viewport TOP instead (`0px 0px -100% 0px`) shifts every
 *  window a full viewport later; a symmetric inset — the obvious "is it on
 *  screen" reading — keys off the caption's sticky box and is later still. */
export const CAP_FADE_ROOT_MARGIN = "-100% 0px 0px 0px";

export interface CapFadeTarget {
  classList: { toggle(token: string, force: boolean): void };
}

export interface CapFadeEntry {
  target: CapFadeTarget;
  isIntersecting: boolean;
}

/** Everything the fallback remembers between batches: the bands it observes, in
 *  DOCUMENT order, and which of them the observer last reported as crossing the
 *  line. */
export interface CapFadeState {
  targets: readonly CapFadeTarget[];
  intersecting: Set<CapFadeTarget>;
}

export const capFadeState = (
  targets: readonly CapFadeTarget[],
): CapFadeState => ({ targets, intersecting: new Set() });

/** The observer body, split out so it is testable without a DOM.
 *
 *  ONE band is lit at a time — the first intersecting one in document order,
 *  released to the next when it leaves. The CSS path can overlap two captions
 *  (that IS the crossfade), but this path has no timeline to crossfade along: a
 *  batch is only a set of booleans, so two captions both "in" would sit at 1.0
 *  on top of each other. Bands overlap by a pad at every handover and, at first
 *  paint, the hero's and the zoom band both cross the line — which is exactly
 *  where Firefox used to show the pair stacked. Document order is story order
 *  (bands are emitted in scene order), so "first" is "the one whose scene comes
 *  first": the outgoing caption holds its slot until its own scene is done. */
export const applyCapFades = (
  state: CapFadeState,
  entries: readonly CapFadeEntry[],
): void => {
  for (const e of entries) {
    if (e.isIntersecting) state.intersecting.add(e.target);
    else state.intersecting.delete(e.target);
  }
  // The bands TILE the track — each starts before its predecessor ends, and the
  // first one starts at the very top — so "none is crossing the line" can only
  // mean the reader is past the LAST band. The final band's bottom edge sits
  // exactly on the line at maximum track scroll, and edge-touching does not
  // count as intersecting, so without this the last caption blinks off on the
  // closing pixel of the story. Falling back to the last band (rather than to
  // whatever was lit before) keeps this a pure function of the current state:
  // a jump straight to the end lands on the same answer as scrolling there.
  const lit =
    state.targets.find((t) => state.intersecting.has(t)) ??
    state.targets.at(-1);
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
      // The FIRST batch has to land as a plain initial state, not as a fade:
      // the gate class (which is what makes the CSS hide anything at all) and
      // the first .is-in toggles are applied in one style change, and the
      // transition is only armed a frame later. Otherwise load flashes twice
      // over — the hero, already in its slot, would fade IN from 0, and any
      // caption lit at scroll 0 would paint and then fade OUT over 450ms. A rAF
      // asked for from inside an observer callback runs on the NEXT frame, i.e.
      // after this state has been painted.
      if (!started) {
        started = true;
        const hero = document.getElementById("lens-hero");
        hero?.classList.add("cap-io");
        requestAnimationFrame(() => hero?.classList.add("cap-io-armed"));
      }
      applyCapFades(state, entries);
    },
    { rootMargin: CAP_FADE_ROOT_MARGIN, threshold: 0 },
  );
  for (const el of bands) io.observe(el);
}
