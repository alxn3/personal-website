# Lens principles

Standing laws that no test or code comment states. Everything else lives next to the code.

## Design

- Only the lens model reads as 3D. Rays, wipes, cards, constellation lines, trails and words are flat ink — cards are camera-facing billboards that move through depth but never read as solids.
- Scroll drives entrances, exits and camera moves; life inside a scene (card orbit, focus rack, iris breath, trail rotation) runs on time. A held scroll position is never frozen.
- Every scene transition hands a physical object to the next scene: shell strips → cards, closed iris → the dive's aperture, trails → shell pieces.
- Motion has character: staggered, curved, reassemble-style paths — never single-axis shifts.
- Every aesthetic number is a knob (`knobDefaults`, `FLY`, the envelope constants); the look is tuned in one pass after the mechanics work.

## Architecture

- Code is the format: scenes, recipes and envelopes are TypeScript. No score files, no DSL — a clumsy scene is an API problem.
- A frame at rest is a pure function of `p` (`story/state.ts` reports it); the only clocks are the channel ease in `core/scene.ts` and the riders' phase clocks. Easing is an input concern, never state.
- The frame loop takes no blocking work. Simplify by deleting per-frame cost, not relocating it; warm frames stay.

## Verification

- Three instruments for three failure classes: the path instrument and the generated maps for motion identity, screenshots for composition, the owner's hands for feel.
- A law is not pinned until its mutant fails: every load-bearing rule carries a test seen to break when the rule is broken.
- Structural work (ops, algebra, story path) gets full rigor; look iterations get a visual verdict plus the minimal gates (goldens regenerated, format, lint, vitest).
