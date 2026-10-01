# Lens backlog

## Work items

- **Canonical part identity** — one `authoredPartOf(object)` / `partNameOf(object, root)` helper in `core/parts.ts`, used everywhere semantic identity matters (frames, classification, materials, isolation, inspection). Currently each site re-derives it.
- **Gear pinion split** — `Focus_Pinion` is welded into `Focus_Motor` (lens_work/build_internals.py:353-355; lens_mechanism.md:121). Split it, re-export the GLB (never touch lens_full.glb), spin at −2× screw in `ops/mechanism.ts`, update SHELL_ADOPT + MECHANISM_PARTS, diff the GLB node inventory, restart the dev server after the swap.
- **Rose prototype** — origami bloom recipe on the /lens bench only, no story wiring. Story placement decided at prototype review.
- **Dark sky chapter** — make flythrough→trails an always-dark stage in both themes, removing the light-theme sky compromises. Owner is separately weighing dark story stage + light site.
- **Caption rework** — needs a design session first ("tell a story, not a showcase"). Trail-words were rejected; don't re-pitch.
- **Placeholder content** — the cards (`story/peelcards.ts` PLACEHOLDER photos/titles), star labels (`story/constellations.ts` LABELS) and the star catalog (`optics/sky.ts`) await real content.
- **Skip-to-bottom button** — planned instant jump past the hero; not built.
- **Opening chapter rework** — hero + zoom are unchanged from the pre-ring story; separate effort.

## Owner calls (flag at review, don't act unilaterally)

- GLASS_SPECULAR 0.15 also de-mirrors the /lens bench glass (one-line revert if unwanted).
- Trails arcs cruise ~110° at trails 0.9 vs the old saturated 180° — unjudged.
- Lens stays realistic-shaded under the crown fade (ink returns [0.451, 0.65]).
- fov push-in after the reveal is ~20% deeper than the old move.
