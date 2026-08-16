// ============================================================================
// SINGLE SOURCE OF TRUTH for the scroll-jacked lens story.
//
// Every scene is one entry below: its DURATION (in ≈screenfuls of scroll), its
// camera pose, which mechanism it drives, its background tint, and its caption.
// Everything downstream — the track height, each scene's normalized scroll range
// `p`, the camera path, mechanism curves, caption bands, background stops and the
// HUD — is DERIVED from this array. So adding, removing, or reordering a scene is
// a single edit here; pacing stays constant automatically (the track grows with
// the total duration) and nothing can drift out of sync.
//
// SCOPE — this table owns story STRUCTURE: beat order, durations and derived
// ranges, track height, camera poses/waypoints, stage tints, rail flags and
// titles. It deliberately does NOT own mechanism envelope tuning (the `pulse`
// windows in hero-driver.ts), cinematic implementation (cinematics.ts),
// authored overlay content (LensStory.astro), or content-specific visual
// effects (CSS reading the --beat-* vars) — those live with their consumers on
// purpose; don't try to consolidate them into this schema.
// ============================================================================

import { smoothstep } from "../core/math";
import { FLY } from "../optics/fly-core";

/** The story's ORBIT RADIUS, world units: every scene's `pos` is a direction in
 *  units of this, and the park shifts (`xs`, `ys`) are in the same unit. It
 *  lives with the table because the table is authored in it; story/camera.ts
 *  reads it back to place the camera. */
export const STORY_R = 11;

/** The subset of a Pose that a `via` waypoint actually contributes: camera.ts
 *  splines only these four along a waypoint chain. `ortho`, `ys` and `target`
 *  are endpoint-only — the flatten and the orbit-centre/lift slides are driven
 *  from the move's first and last poses, so authoring them on a via is silently
 *  dead. Hence the narrower type rather than `Pose[]`. */
export type Waypoint = Pick<Pose, "pos" | "fov" | "up" | "xs">;

/** THE REVEAL ENDS HERE — a fraction through `rewrap`: the frame the lens' last
 *  leg home opens (story/fly.ts flySeatAt — the reveal plays at an overshoot
 *  PAST the origin, and the remaining distance is given back from here).
 *
 *  IT IS NO LONGER THE FRAME THE EXPLODED RADIUS IS SPENT. It was, and the two
 *  were authored off this one constant — until the ending became the pieces
 *  flying in to construct the rose (story/envelopes.ts CONSTRUCT), which took
 *  the collapse out of this scene altogether. The seat's window was placed
 *  after the collapse so the collapse would not play on a moving range; with
 *  the collapse a scene later, this walk home now happens under a rigid cloud
 *  at constant radius and the law is satisfied by a wider margin than it was
 *  when the two shared an edge.
 *
 *  IT IS NO LONGER "the frame everything camera-side starts". It was, and the
 *  stack — chain release, fov push-in and the seat all onsetting on one frame
 *  out of a bit-still hold — is what the owner called "very jarring". The
 *  movers are now STAGGERED, each on its own edge with its own reason:
 *
 *    · the fused rewrap→capsOn chain creeps first (`CAM_RELEASE_F` below) —
 *      under way sub-perceptibly while the pieces are still turning, so the
 *      pull-back is part of the reassembly rather than an event after it;
 *    · the fly's fov hand-back opens at the sky's own far edge (story/fly.ts
 *      FOV_BACK — the frame the starfield is exactly gone);
 *    · the seat keeps THIS edge, now for the plainer reason that it is the far
 *      side of the crossfade with room to spare.
 *
 *  WHAT STILL FIXES THE NUMBER: the reveal is the shell crossfading in
 *  (rewrap-local [0.06, 0.16]) and standing established on its radius; this is
 *  comfortably the first frame past that, and the movers downstream are
 *  ordered off it. (The lens' own ROLL outlives it by design — story/reveal.ts
 *  ROLL_P1 — that is the owner's spin correction, and the RADIUS now outlives
 *  it by a whole scene.) */
export const REVEAL_END_F = 0.25;

/** WHERE THE ENDING'S CAMERA MOVE ACTUALLY LEAVES — the fused rewrap→capsOn
 *  chain's `camHold`, as a fraction of the rewrap scene. The camera is
 *  bit-for-bit still from the sky's park through the whole reveal crossfade
 *  (this is story/fly.ts flyRevealAt's far edge — the coupling is pinned in
 *  story-fly.test.ts, not by the two numbers matching), and then CREEPS: the
 *  chain's smoothstep leaves at zero rate, so by REVEAL_END the move is ~1%
 *  done (measured 1.12% of its arc length) — imperceptible as motion, but
 *  already moving, which is the owner's fix for the dead-stop-into-fast-move
 *  seam ("very jarring… smoothed or just incorporated into reassemble"): there
 *  is no frame on which the camera's motion BEGINS as an event. The
 *  pieces-turn-in-place beat is untouched — the camera still reads as parked
 *  for the whole crossfade and visibly beyond. */
export const CAM_RELEASE_F = 0.16;

/** WHERE THE LAST OF THE SKY IS EXACTLY GONE — a fraction through `rewrap`:
 *  the far edge of the starfield's fade (story/fly.ts skyOutAt lands on
 *  exactly 0 here), the frame the fov hand-back may open (story/fly.ts
 *  FOV_BACK — the push-in scales the sky, so it must wait for it), and the
 *  frame the sky's TURN is allowed to end (story/reveal.ts TURN_P1 — the one
 *  place its angular rate steps, put where nothing that turns is drawn).
 *
 *  0.32, NOT the 0.22 it used to be, and the move is the owner's
 *  fluid-transition correction: the trails→reassemble hand-over concentrated
 *  its whole identity exchange (arcs fading, shell crossfading in, spin
 *  handed over) into rewrap-local [0.06, 0.18], which at a fast scroll
 *  compressed to a blink — "there's no fluid transition". The sky now
 *  OUTLIVES the reveal and the collapse (REVEAL_END_F 0.25 sits inside it):
 *  the arcs' own ink runs out at 0.28 (story/trails.ts), the star discs here,
 *  so the two figures — the sweeping sky and the turning pieces — share the
 *  frame for the whole exchange instead of one being cut for the other.
 *
 *  It lives in this table for REVEAL_END_F's reason: three modules need the
 *  number (fly, reveal, and the tests that pin their coupling) and two of
 *  them may not import each other — reveal.ts is homepage-safe and fly.ts is
 *  lazy — so the one owner is the table both already read. */
export const SKY_OUT_END_F = 0.32;

export interface Pose {
  pos: [number, number, number]; // camera direction (scaled by the scene radius)
  fov: number;
  up: [number, number, number];
  ortho: number; // 1 = flatten to an orthographic elevation on the HOLD; 0 = perspective
  xs: number; // horizontal lens-park: >0 shoves the lens left (caption sits right)
  ys?: number; // vertical look-shift (along camera-up): reframes on a detail, e.g.
  // the focus scene dollying onto the focusing element instead of the whole lens
  target?: [number, number, number]; // orbit centre / look-at, WORLD units (the
  // recentred lens centre is the origin; optical axis = world X, front at +X).
  // Default [0,0,0]. Shifts the whole orbit sphere, so framing and transit arcs
  // are preserved — use it to aim a scene at a feature (a cap, the mount) instead
  // of the lens centre. Unlike ys (a 2D reframe), this changes the 3D pivot.
}

// NOTE: scene CONTENT does not live here. This table is the ENGINE — durations,
// camera, mechanism, tint. The overlay content is authored as real markup in
// components/LensStory.astro via <LensSceneContent scene="…">…
// </LensSceneContent> (any HTML/components), keyed to a scene id; the scroll
// driver derives each block's fade band from the ranges below. (An earlier
// design kept preset caption strings in this table — replaced so scenes can
// host arbitrary components.)
export interface StoryScene {
  id: string;
  title: string; // display name — the HUD readout ("SCN 05 / LIGHT PATH") and the rail label
  rail?: boolean; // show this scene on the scene rail (bottom-right progress dots)
  hold: number; // duration weight, ≈ screenfuls of scroll
  transit: number; // 0..1 of the scene spent easing the camera IN from the previous pose
  cam: Pose; // settle pose (the parked "hold")
  via?: Waypoint[]; // optional waypoints during the transit (multi-step orbits / up-vector routing)
  bg: [number, number, number]; // stage tint on the hold (dark theme)
  bgLight: [number, number, number]; // stage tint on the hold (light theme — warm paper family)
  linkNext?: boolean; // fuse this scene's camera move with the NEXT scene's into ONE
  // spline + ONE ease (start of this scene → end of the next's transit). Without it
  // every boundary is a dead stop: an eased transit decelerates to zero velocity,
  // parks, and the next re-accelerates from zero — a visible hitch when the story
  // wants one continuous move (rewrap → capsOn). This scene's own `transit` is
  // ignored for the camera when set (mechanism/caption ranges are unaffected).
  camHold?: number; // LINKED CHAINS ONLY: fraction of THIS scene's range the fused
  // move WAITS before it starts, so the chain leaves from a dead-still camera part
  // way into the head scene instead of at its first frame. The move then runs from
  // there to the same end (the tail's transit), i.e. the same path in less scroll.
  // A linked head is in motion for its whole range by construction — there is no
  // `transit` to shorten — so a beat that must play under a still camera inside the
  // head scene has nowhere else to come from. Validated below: dead without
  // linkNext, so it may not be authored there.
}

// --- the story --------------------------------------------------------------
export const STORY: StoryScene[] = [
  {
    id: "hero",
    title: "HERO",
    hold: 0.9,
    transit: 0,
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    cam: { pos: [1.3, 0, 0], fov: 30, up: [0, 1, 0], ortho: 1, xs: -0.34 }, // dead-front elevation, lens right
  },
  {
    id: "zoom",
    title: "ZOOM",
    rail: true,
    hold: 1.35,
    // 0.6, not 0.5: the ortho flatten eases in over the 0.12 past the transit
    // and the scene releases it again from local 0.9, so a 0.5 transit left the
    // camera DEAD STILL from local 0.62 to 0.9 — the one real stop between the
    // zoom and the cards' park, and what made scenes 1→3 read as three moves
    // rather than one flow (owner). Moving the transit shortens that stop to
    // [0.72, 0.9] without touching the flatten itself, which still reaches a
    // full ortho 1 and holds it (a signed-off look).
    transit: 0.6,
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    cam: { pos: [0, 0, 1.3], fov: 32, up: [0, 1, 0], ortho: 1, xs: -0.24 }, // side profile (horizontal)
  },
  {
    id: "peel",
    title: "PEEL",
    rail: true,
    hold: 1.2,
    // 0.72, not 0.6: the spiral gets more of the scene, so the camera is still
    // arriving while the sides come off and the dead hold before the cards'
    // transit is 28% of the scene rather than 40% (owner: scenes 1→3 should
    // read as ONE flow). It cannot go much further — the pose below is this
    // scene's subject as much as the peel is, and a settle nobody sees is not a
    // pose. FUSING the pair was tried instead and rejected: a linked head is in
    // motion for its whole range by construction, so the peel would pass
    // THROUGH the pose below at cards-local 0.10 and never hold it.
    transit: 0.72,
    bg: [26, 23, 17],
    bgLight: [240, 236, 226],
    // THE SPIRAL IN (owner direction): from the zoom's side profile the camera
    // corkscrews up OVER the barrel and down the other side while the sides
    // peel — azimuth sweep + progressive roll in the up-vectors.
    //
    // …AND IT ENDS NOSE-UP, TILTED FORWARD-RIGHT (owner, on this scene's pose).
    // The lens' orientation in the world is not this table's to change (the
    // model's euler is the SPIN's, story/peelcards.ts peelRollAt), so the pose
    // is expressed where every other pose in the story is: in the camera. The
    // ups below are AUTHORED FROM THE SCREEN ANGLE the nose is wanted at —
    // measured CCW from screen-right, with the nose being world +X:
    //
    //     zoom  0°  →  via 20°  →  via 45°  →  settle 70°  →  cards 50°
    //
    // one continuous unwind, peaking here. For a camera at orbit offset `pos`
    // the up that produces angle θ is sin θ·ê₁ + cos θ·ê₂, where ê₁ is +X with
    // its component along p̂ removed and normalized, and ê₂ = p̂ × ê₁ — every
    // vector below is that expression evaluated. To recover a θ from an authored
    // `up`, build three's own lookAt basis (x = up × p̂, y = p̂ × x) and take
    // atan2(X·y, X·x); ONLY the direction of `pos` enters, so a via may be moved
    // in or out without invalidating its roll.
    //
    // "Tilted forward" is the other half and lives in `pos`: X·p̂ = 0.278 here,
    // so the nose leans 16° OUT of the screen plane toward the viewer, up from
    // 10° when the settle sat at [0.28, 0.18, −1.5].
    //
    // THE VIAS KEEP THEIR DIRECTIONS AND GIVE UP THEIR DIVE. They used to sit at
    // |pos|·STORY_R = 11.8 and 9.7 wu against endpoints at 14.3 and 16.6, so the
    // corkscrew swooped IN over the barrel. With the transit longer (above) the
    // camera is still on that swoop where the cards now arrive, and at 10 wu a
    // card of the 5.2 wu shell comes within ~5 wu and fills the whole frame —
    // and the flock, which used to be gone by now, is still on screen and still
    // expanding. Pushed out to 15.9 and 15.6, the move runs 14.3 → 16.6 wu with
    // no dive in it. Only the RADIUS moved: the direction, and so the roll each
    // `up` below encodes, is untouched.
    via: [
      {
        pos: [0.679, 0.679, 1.086],
        fov: 33,
        up: [0.302, 0.712, -0.634],
        xs: 0,
      },
      {
        pos: [0.561, 0.962, -0.881],
        fov: 32,
        up: [0.65, -0.684, -0.332],
        xs: 0,
      },
    ],
    cam: {
      pos: [0.42, 0.16, -1.44],
      fov: 32,
      up: [0.903, -0.369, 0.222],
      ortho: 0,
      xs: -0.26,
    },
  },
  {
    id: "cards",
    title: "CARDS",
    rail: true,
    hold: 1.3,
    transit: 0.5,
    bg: [26, 23, 17],
    bgLight: [240, 236, 226],
    // The hold carries the peel's nose-up pose on and starts letting it back
    // down — 70° at the peel's settle, 62° at the via, 50° here (the screen
    // angle of the lens' nose; the peel row derives the up-vectors) — so the
    // roll is still unwinding in ONE direction when the internals scene takes it
    // the rest of the way. The via also bulges out along +Z, a dolly-away in
    // depth, before settling.
    via: [
      {
        pos: [0.28, 0.14, -1.85],
        fov: 33,
        up: [0.873, -0.478, 0.096],
        xs: 0.1,
      },
    ],
    // The card field's hold, |pos|·STORY_R = 16.2 wu out. The card shell turns
    // about the OPTICAL AXIS at a radius of 5.2 wu (story/peelcards.ts
    // SHELL_R), so a card comes to within ~11 wu of the camera at the near side
    // of its pass; the via's own 20.6 wu is the dolly-away that keeps that
    // swell off the frame while the shell arrives, and the fov flattens the
    // rest of it. THAT RADIUS NEVER CHANGES: the shell's station is a function
    // of TIME alone (story/peelcards.ts cardOrbitAt takes no scroll argument),
    // so every near pass is the same ~11 wu for as long as the field is lit and
    // the pose has to hold that swell for the whole scene — what ends it is the
    // field's DISSOLVE (CARDS_OUT, spent at cards-local 0.68), under which the
    // lens wraps back home. xs is
    // POSITIVE and this scene's caption sits RIGHT, the mirror of the peel: the
    // lens and the shell are shoved LEFT off it.
    cam: {
      pos: [0.34, 0.2, -1.42],
      fov: 32,
      up: [0.745, -0.661, 0.085],
      ortho: 0,
      xs: 0.2,
    },
  },
  {
    id: "internals",
    title: "INTERNALS",
    rail: true,
    hold: 1.4,
    transit: 0.5,
    bg: [30, 35, 24],
    bgLight: [238, 242, 229],
    // FRONT three-quarter from the viewer's right (owner: "rotate the lens so
    // that it's pointed towards us and to the right and zoom in a bit more into
    // where the focus elements are"). The interior cladding no longer returns
    // during this scene (it comes back inside the fly-through approach), so the
    // mechanism is readable from OUTSIDE the chassis — the old rear-bore-only
    // constraint died with that change.
    // The scene opens on the BARE MECHANISM: the cards scene takes the lens
    // apart and winks the shell and the cladding out inside its own valley
    // (story/peelcards.ts WINK_SPAN). Camera in the +X/+Z quadrant puts the
    // front element toward the viewer with the nose angled screen-right; the
    // `target` pivots the whole orbit at the focus rig (motor, lead screw,
    // carrier — rear third, world x ≈ −1.5…−0.9) so the zoom lands on the
    // mechanism rather than the lens centre. Perspective, NOT the ortho
    // flatten. Don't pull |pos| much below ~1.0: closer, the depth fade starts
    // showing the chassis through itself and the frame turns to mush.
    cam: {
      pos: [0.78, 0.2, 0.66],
      fov: 26,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0.1,
      ys: 0.03,
      target: [-1.0, 0, 0],
    },
  },
  {
    id: "flythrough",
    title: "FLY-THROUGH",
    rail: true,
    // 2.15 = the 0.35 approach below + the 1.8 the DIVE itself scrubs over.
    hold: 2.15,
    // THE APPROACH IS THIS SCENE'S TRANSIT, and the dive starts when it ends
    // (story/fly.ts DIVE_P0 reads this number). Spelled as the 0.35 screenfuls
    // it is meant to be, over this scene's own hold:
    // the camera swings off the internals scene's rear three-quarter onto the
    // optical axis — the lens locking in, centred and dead-on down its own axis,
    // while the iris sits shut — and PARKS there. It does not move again until
    // the rewrap: from here to the sky's end the LENS does the travelling
    // (SceneHandle.setLensDolly), past a camera that never leaves this pose.
    transit: 0.35 / 2.15,
    bg: [12, 11, 8],
    bgLight: [231, 227, 215],
    // THE DIVE'S PARK, and it is exact: |pos| × STORY_R = FLY.distFar puts the
    // camera at world (−9, 0, 0) looking down +X, which is the pose the dive's
    // own path (optics/fly-core flyPose) starts from — so the model's dolly is 0
    // on the dive's first frame. Pinned in story/__tests__/story-fly.test.ts.
    cam: {
      pos: [-FLY.distFar / STORY_R, 0, 0],
      fov: FLY.fovFar,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0,
    },
  },
  {
    id: "constellations",
    title: "CONSTELLATIONS",
    rail: true,
    hold: 1.3,
    transit: 0,
    bg: [10, 9, 7],
    bgLight: [238, 234, 222],
    // Sky scene — holds the fly-through's parked pose exactly (transit 0 must
    // not snap: same pose, pure hold). Through this scene and the next the lens
    // is parked at world x = −25 (its dolly's full reach), which is 16 units
    // BEHIND this camera: there is nothing in frame but sky.
    cam: {
      pos: [-FLY.distFar / STORY_R, 0, 0],
      fov: FLY.fovFar,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0,
    },
  },
  {
    id: "trails",
    title: "TRAILS",
    rail: true,
    // A LONG HOLD (2nd only to the flythrough's 2.15, of which 1.8 is the dive
    // itself), and the sweep is why: the sky turns a half revolution here
    // (optics/star-trails.ts TRAIL_SWEEP_MAX), and the turn is ramped over
    // roughly two thirds of the scene, so at the old 1.2 it read as a spin
    // rather than as a long exposure. 1.7, down from 1.8: a tenth of a
    // screenful LENT to the rewrap's widened trails→reveal overlap (the
    // owner's fluid-transition correction — see the rewrap hold), which the
    // turn's own longer window (story/reveal.ts TURN_P1 now sits at
    // SKY_OUT_END, deeper into rewrap) more than gives back in sweep time.
    // Everything downstream — the track height, the caption band, the pulse
    // windows — derives from it.
    hold: 1.7,
    transit: 0,
    bg: [10, 9, 7],
    bgLight: [238, 234, 222],
    // Still the same parked pose, pure hold — and it is the pose the fused
    // rewrap→capsOn chain leaves FROM, so the ending's first move starts where
    // the sky ended rather than from a rig the dive was blended out of.
    cam: {
      pos: [-FLY.distFar / STORY_R, 0, 0],
      fov: FLY.fovFar,
      up: [0, 1, 0],
      ortho: 0,
      xs: 0,
    },
  },
  {
    id: "rewrap",
    title: "REWRAP",
    // 1.7 (was 1.4): the trails→reveal hand-over lives in this scene's early
    // fractions, and the owner's correction is that it was too SHORT in scroll
    // space — "for the trail to reassemble there should be a longer transition
    // with the spinning… if we scroll fast it will look very off". The scene
    // grew 0.3 of a screenful (0.1 lent by the trails hold, +0.2 net = +1.4%
    // of track, the same delta the capsOn settle beat set as precedent), and
    // the sky's far edge moved deeper in (SKY_OUT_END below) — so the stretch
    // where BOTH the fading arcs and the spinning shell are on screen runs
    // ~0.37 screenfuls where it ran ~0.17, and every beat of the reassembly
    // breathes with it.
    hold: 1.7,
    transit: 0.95, // camera-ignored while linkNext (one chain with capsOn) — kept for caption pacing
    linkNext: true, // ONE continuous camera move across the 06→07 boundary (no boundary stop)
    // THE ENDING WAITS FOR THE REVEAL'S CROSSFADE, then creeps. The chain used
    // to start at this scene's first frame, which put ~0.9 world units of
    // camera travel into the reveal by rewrap-local 0.08 — a swing across the
    // exact beat the owner wanted shot from a dead-still camera. It then held
    // to REVEAL_END_F, and THAT made the far edge a lurch (three movers
    // onsetting on one frame — owner: "very jarring"). CAM_RELEASE_F is the
    // middle: bit-still through the whole crossfade, under way imperceptibly
    // while the pieces collapse; the path is untouched.
    camHold: CAM_RELEASE_F,
    bg: [22, 20, 14],
    bgLight: [238, 234, 222],
    // The camera sweeps half-around the lens and ROLLS IT UPRIGHT as the layers
    // wrap on. Because of linkNext this pose is just an interior waypoint of the
    // fused rewrap→capsOn spline — the lens is mid-SPIN here (the chain keeps
    // orbiting around the lens' long axis into capsOn without pausing). The
    // up-vector routes through +Y (down → up is antipodal; a direct lerp would
    // collapse to zero).
    cam: {
      pos: [0.1, -0.2, 1.26],
      fov: 30,
      up: [0.9, -0.32, 0],
      ortho: 0,
      xs: 0,
    },
    via: [
      {
        pos: [-1.1, 0.35, -0.7],
        fov: 30,
        up: [-0.55, 0.8, 0],
        xs: 0,
      },
      { pos: [-1.3, 0.5, 0.35], fov: 30, up: [0.4, 0.9, 0], xs: 0 },
      { pos: [-0.6, 0.3, 1.1], fov: 30, up: [1, 0.15, 0], xs: 0 },
    ],
  },
  {
    id: "capsOn",
    // THE ID STAYS `capsOn` though the beat is now the BLOOM and NO CAP IS EVER
    // SHOWN (owner: the caps blocked part of the rose, so they are out of the
    // story entirely): the id is a contract (story/story.ts REQUIRED_IDS, the
    // caption slot in components/LensStory.astro, /lens's own preview span) and
    // renaming it takes /lens down. Only the display label moved.
    title: "BLOOM",
    // 1.7 (was 1.5): a settle beat. The choreography used to run to the very
    // last frame of the track ("normal scroll happens right when it finishes
    // so it feels incomplete" — owner), so the finale ends with a rest. The
    // scene is the RETURN landing (story/envelopes.ts, capsOn-local 0.25) and
    // then the rose opening (ROSE_PULSE, [0.25, 0.9]) alone, plus a held frame
    // of the open flower before the page releases.
    hold: 1.7,
    transit: 0.7, // still perceptibly rotating while the cap seats — fluid, not parked
    bg: [29, 26, 20],
    bgLight: [244, 240, 230],
    // SPINNING-CYLINDER SETTLE (tail of the fused rewrap→capsOn chain): the lens
    // stands vertical and the camera orbits ~one full revolution around its long
    // axis. On screen that reads as the cylinder SPINNING in place; the up-vector
    // wobble decays like a spun top righting itself (±0.32 → ±0.22 → ±0.12 →
    // ±0.06 → 0) until it settles on its base. The fast first half of the spin
    // orbits WIDE (r ≈ 1.5): unwrapped shells are sheets up to ~11 world units
    // long and the last outer ones are still reeling home — an equatorial pass at
    // the parked radius flies straight through them (giant panels filling the
    // frame). The BACK half climbs to x 0.45 → 0.28 → 0: the lens TILTS toward
    // the camera (~20° elevation, never face-on) so the FRONT ELEMENT is visible
    // exactly while the cap flies in to meet it, then straightens for the settle.
    // The dolly-in swell is the last waypoint (r ≈ 1.11), once every layer has
    // seated; the cap seats during that final slow quarter-turn. fov is FLAT (30)
    // across the spin — the spline follows per-via fov, so alternating values
    // read as a zoom pump. The settle pose is CENTRED (xs 0, and 0 on every via —
    // any via xs would slide the lens out and back).
    // ORTHO IS OFF (was 1) FOR THE BLOOM: the flatten's pullback would push the
    // settle out to the long-lens elevation the capped product shot wanted,
    // where the opening flower reads as a flat disc. At ortho 0 the settle sits
    // at 22 wu / fov 30 — within 4% of the approved d-rose finale framing — so
    // the flower stands upright and opens toward the top of frame. That upright,
    // dead-centre bloom is the hand-off frame the rest of the page scrolls up
    // over.
    cam: { pos: [0, 0, 2.0], fov: 30, up: [1, 0, 0], ortho: 0, xs: 0 }, // final: centred perspective elevation — page hand-off
    via: [
      {
        pos: [0.11, -1.3, -0.75],
        fov: 30,
        up: [0.94, 0.22, 0],
        xs: 0,
      }, // wide, fast spin
      {
        pos: [0.45, 1.1, -0.62],
        fov: 30,
        up: [0.97, -0.12, 0],
        xs: 0,
      }, // tilts to camera — front element
      {
        pos: [0.28, 0.76, 0.76],
        fov: 30,
        up: [0.99, 0.06, 0],
        xs: 0,
      }, // swell — cap meets the front
    ],
  },
];

// --- authoring validation ----------------------------------------------------
// Real invariants of the table, checked once at module load so a bad edit fails
// loudly at boot instead of surfacing as subtly wrong motion. (Pulse-window
// fractions are NOT checked here — they don't live in this table; pulse()
// validates its own windows at call time.)

// Scene ids consumers resolve BY NAME: camera.ts's hero-end portrait lift, the
// hero-driver's pulse windows and return window, envelopes.ts's and reveal.ts's
// module-scope ranges, and pages/lens.astro's hero-camera preview span. That
// last one is why a renamed id takes down /lens too — a page with no story at
// all.
const REQUIRED_IDS = [
  "hero",
  "zoom",
  "peel",
  "cards",
  "internals",
  "flythrough",
  "constellations",
  "trails",
  "rewrap",
  "capsOn",
];

export function validateStory(story: StoryScene[]): void {
  if (story.length === 0) throw new Error("lens story: STORY is empty");
  const ids = new Set<string>();
  for (let i = 0; i < story.length; i++) {
    const sc = story[i];
    if (ids.has(sc.id))
      throw new Error(`lens story: duplicate scene id "${sc.id}"`);
    ids.add(sc.id);
    if (!Number.isFinite(sc.hold) || sc.hold <= 0)
      throw new Error(
        `lens story: scene "${sc.id}" hold must be finite and > 0 (got ${sc.hold})`,
      );
    if (!Number.isFinite(sc.transit) || sc.transit < 0 || sc.transit > 1)
      throw new Error(
        `lens story: scene "${sc.id}" transit must be within [0,1] (got ${sc.transit})`,
      );
    if (sc.linkNext && i === story.length - 1)
      throw new Error(
        `lens story: final scene "${sc.id}" must not set linkNext — there is no next scene to fuse with`,
      );
    // camHold shortens a FUSED chain's ease (camera.ts's linked branch reads it
    // and nothing else does), so on an unlinked scene it is silently dead — and
    // a hold of the whole scene would leave the move zero-wide.
    if (sc.camHold !== undefined) {
      if (!sc.linkNext)
        throw new Error(
          `lens story: scene "${sc.id}" sets camHold without linkNext — only a fused chain's ease reads it (story/camera.ts), so it would do nothing`,
        );
      if (!Number.isFinite(sc.camHold) || sc.camHold < 0 || sc.camHold >= 1)
        throw new Error(
          `lens story: scene "${sc.id}" camHold must be within [0,1) (got ${sc.camHold})`,
        );
    }
    // camera.ts resolves a fused chain's head by looking back exactly ONE scene
    // (sampleStory's `head` resolution), so a chain can only span two scenes —
    // a second consecutive linkNext would silently never fuse.
    if (sc.linkNext && story[i + 1]?.linkNext)
      throw new Error(
        `lens story: scenes "${sc.id}" and "${story[i + 1].id}" are consecutive linkNext scenes — camera.ts only looks back one scene, so chains longer than two never fuse`,
      );
  }
  const missing = REQUIRED_IDS.filter((id) => !ids.has(id));
  if (missing.length)
    throw new Error(
      `lens story: missing required scene id(s) ${missing.map((id) => `"${id}"`).join(", ")} — consumers resolve these by name (see REQUIRED_IDS); rename the scene there too, or keep the id`,
    );
  // story/envelopes.ts takes RANGES[0] positionally for the scroll-cue fade, so
  // a prepended beat would silently retarget it instead of failing.
  if (story[0].id !== "hero")
    throw new Error(
      `lens story: the first scene must be "hero" (got "${story[0].id}") — story/envelopes.ts reads RANGES[0] positionally`,
    );
}
validateStory(STORY);

// --- derived pacing ---------------------------------------------------------
// Track length is the total duration in screenfuls → svh, CLAMPED so a short
// viewport isn't rushed and a huge one isn't a marathon (raw scroll input is
// pixel-based, so pure vh drifts across screen sizes).
//
// THE UNIT LAW — svh everywhere in this file, and everywhere downstream that
// lays the story out (the track, the caption bands, the sticky slots in
// LensSceneContent.astro). Two deliberate dvh survivors: the pinned stage
// (below) and the caption fade-IN anchors (LensStory.astro — timing against
// the LIVE viewport edge, not geometry). `dvh` tracks the browser's DYNAMIC
// viewport, which on iOS Safari changes by ~10% every time the toolbar
// collapses or expands: a ~1400dvh track and every band inside it would then
// RE-LAY-OUT mid-scroll — a >1000px shift of everything below the hero, on a
// gesture the reader did not make. `svh` is the SMALL viewport (the height with
// the browser UI shown) and never moves, so the story's geometry is frozen and
// the toolbar animation costs nothing. The price is that with the toolbar
// hidden the captions sit slightly high in the taller viewport — accepted.
//
// The ONE exception is the pinned stage (LensStory.astro's `h-dvh`): the canvas
// must fill the visible screen with no bottom gap. It costs nothing — sticky
// inside a fixed-height track, its height affects no other box — and it is what
// keeps the END of the story exact: 100dvh IS window.innerHeight, the height
// hero-driver.ts subtracts from the track to form p's denominator, so the
// stage unpins at precisely p = 1 whatever the toolbar is doing.
export const TOTAL_HOLD = STORY.reduce((s, sc) => s + sc.hold, 0);
const PER_SCREENFUL_MIN_PX = 460;
const PER_SCREENFUL_MAX_PX = 1000;
export const TRACK_MIN_PX = Math.round(TOTAL_HOLD * PER_SCREENFUL_MIN_PX);
export const TRACK_MAX_PX = Math.round(TOTAL_HOLD * PER_SCREENFUL_MAX_PX);
export const TRACK_SVH = Math.round(TOTAL_HOLD * 100);
export const TRACK_HEIGHT_CSS = `clamp(${TRACK_MIN_PX}px, ${TRACK_SVH}svh, ${TRACK_MAX_PX}px)`;

export interface SceneRange {
  scene: StoryScene;
  p0: number;
  p1: number;
}

/** Each scene's normalized scroll range [p0, p1), cumulative over the durations. */
export const RANGES: SceneRange[] = (() => {
  const out: SceneRange[] = [];
  let acc = 0;
  for (const scene of STORY) {
    const p0 = acc / TOTAL_HOLD;
    acc += scene.hold;
    out.push({ scene, p0, p1: acc / TOTAL_HOLD });
  }
  return out;
})();

export const rangeOf = (id: string): SceneRange => {
  const r = RANGES.find((r) => r.scene.id === id);
  if (!r) throw new Error(`Unknown lens story scene: "${id}"`);
  return r;
};

// --- caption bands ----------------------------------------------------------
// The HTML LAYOUT of the hero's captions, derived from the same ranges the
// canvas reads at runtime. Each captioned scene gets a band element in the
// scroll track (components/LensSceneContent.astro) positioned by `top`/`height`
// below. The caption is sticky inside its band, so it appears, pins and leaves
// because of WHERE IT SITS IN THE DOCUMENT: no runtime system raises it, and a
// slow, broken or absent scene changes nothing. `a`/`b` are the same band in
// normalized story p, for the driver's --beat-visibility (the pins' fade rides
// it).
//
// The geometry is SCROLL space, not track space. Scroll progress is
// p = scrollY / (track height − 100svh): the stage is pinned for one viewport,
// so the LAST viewport of track buys no progress. A band for [a, b] therefore
// starts a·(100% − 100svh) down the track and is (b − a)·(100% − 100svh) tall
// PLUS one viewport. That extra viewport is the sticky caption's PIN ROOM — a
// sticky box can only stay stuck for (band height − its own height) — and it is
// what puts the band's top edge at the viewport top exactly at p = a and its
// bottom edge at the viewport bottom exactly at p = b, which is what the fade
// windows in LensStory.astro key off. Sizing a band as a plain percentage of
// the track instead places it p·100svh too late (a whole viewport of drift
// across the track) and leaves the 100svh hero intro almost no pin room.

/** Overlap pad on each side of a scene's range, in normalized story p — the
 *  slight lead-in/lead-out that makes neighbouring captions cross-fade. */
export const CAPTION_PAD = 0.02;

/** The track's SCROLLABLE length, as CSS: everything but the viewport the stage
 *  is pinned to. p = scrollY / this, so it is the unit the bands are laid out
 *  in and the unit the fades are timed in. */
export const TRACK_SCROLL_CSS = `calc(${TRACK_HEIGHT_CSS} - 100svh)`;

/** How long a caption crossfade runs, in scroll pixels: neighbouring bands
 *  overlap by a pad on each side of the scene boundary they share, and that
 *  overlap IS the handover. LensStory.astro publishes it as --cap-fade on
 *  #lens-track and both fade windows are exactly this long. */
export const CAPTION_FADE_CSS = `calc(${2 * CAPTION_PAD} * ${TRACK_SCROLL_CSS})`;

export interface CaptionBand {
  id: string;
  /** band edges in normalized story p (the scene's range, padded) */
  a: number;
  b: number;
  /** the band as a CSS box on the track — see the scroll-space note above */
  top: string;
  height: string;
  /** this band ends AT the track end: nothing follows it to hand over to */
  final: boolean;
  /** `final` as an Astro attribute value. Astro STRINGIFIES a `false` on a
   *  data-* attribute rather than dropping it, so `data-final={band.final}`
   *  would mark every band final; the guard lives here so both call sites
   *  (LensSceneContent, LensStory's hero band) cannot get it wrong separately. */
  finalAttr: true | undefined;
}

/** `f` of the track's scrollable length, as a CSS length. 100% is the track's
 *  own height (a band is absolutely positioned in it) and 100svh the pinned
 *  stage, so this is the same quantity TRACK_SCROLL_CSS spells out. */
const scroll = (f: number) => `${f.toFixed(6)} * (100% - 100svh)`;

export const CAPTION_BANDS: CaptionBand[] = RANGES.map(({ scene, p0, p1 }) => {
  const a = Math.max(0, p0 - CAPTION_PAD);
  // the FINAL scene's band runs to the END of the track — there is no next
  // caption to hand over to, and the page scrolls up over the parked lens
  const final = p1 >= 0.999;
  const b = final ? 1 : p1 + CAPTION_PAD;
  return {
    id: scene.id,
    a,
    b,
    top: `calc(${scroll(a)})`,
    height: `calc(${scroll(b - a)} + 100svh)`,
    final,
    finalAttr: final || undefined,
  };
});

/** The band a scene id owns. Throws — an overlay block naming a scene that
 *  does not exist is a BUILD error (the Astro template calls this in its
 *  frontmatter), not a caption that silently never shows. */
export const bandOf = (id: string): CaptionBand => {
  const b = CAPTION_BANDS.find((band) => band.id === id);
  if (!b)
    throw new Error(
      `lens story: no scene named "${id}" — a caption band must name a scene in STORY`,
    );
  return b;
};

/** Absolute p at fraction `f` through a scene's range. */
export const atFrac = (r: SceneRange, f: number): number => {
  if (!Number.isFinite(f) || f < 0 || f > 1)
    throw new Error(
      `lens story: fraction ${f} through scene "${r.scene.id}" is outside [0,1]`,
    );
  return r.p0 + (r.p1 - r.p0) * f;
};

/** A scene's HOLD CENTRE — the settle region's midpoint, past the camera
 *  transit, i.e. where a reader parked in the scene actually rests. ONE formula,
 *  two readers: the `?story` scrubber's per-scene jump targets
 *  (story/hero-driver.ts) and STORY-COST.md's per-scene hold rows
 *  (story/cost.ts) must be the same positions, or the benchmark's "hold"
 *  column silently stops describing the parks a reader sees. */
export const holdCentreOf = (r: SceneRange): number =>
  atFrac(r, (r.scene.transit + 1) / 2);

/** REVEAL_END_F as an absolute story p — the form story/fly.ts's windows are
 *  built from. Derived here so the fraction and the position can never drift
 *  apart, and declared after `atFrac` because it calls it at module load. */
export const REVEAL_END = atFrac(rangeOf("rewrap"), REVEAL_END_F);

/** SKY_OUT_END_F as an absolute story p — REVEAL_END's twin, for the same
 *  no-drift reason. */
export const SKY_OUT_END = atFrac(rangeOf("rewrap"), SKY_OUT_END_F);

/** THE DIVE'S FIRST FRAME as an absolute story p: the end of the `flythrough`
 *  scene's camera APPROACH — its `transit` — where the camera is parked dead-on
 *  and everything that moves from there is the LENS (story/fly.ts's whole span
 *  is built off this).
 *
 *  IT IS ALSO A SEAM IN THE RANGE-TILED WRITER MAP, which is why it lives here
 *  rather than in the module that dives. hero-driver owns the `setBodyFade`
 *  channel below this p and story/fly.ts owns it above, and the two tiles must
 *  meet EXACTLY: a gap leaves the channel holding whatever it had, and a jump
 *  into that gap from inside the peel/cards valley would keep the whole lens
 *  hidden for the flythrough's approach with nothing to restore it. hero-driver
 *  cannot simply import the number from fly.ts — fly.ts is LAZY (dynamically
 *  imported, so the dive's optics stay out of the homepage's first chunk) — so
 *  the one owner has to be the table both of them already read.
 *
 *  Declared after `atFrac` for REVEAL_END's reason: it calls it at module load. */
const FLY_RANGE = rangeOf("flythrough");
export const DIVE_P0 = atFrac(FLY_RANGE, FLY_RANGE.scene.transit);

/** A point on the story timeline: fraction `f` through the named scene. */
export type StoryPoint = [id: string, f: number];
/** A smoothstep window: both edges in ONE scene (`[id, f0, f1]`), or each edge
 *  in its OWN scene (`[[idA, f0], [idB, f1]]` — e.g. a scrub that runs from one
 *  scene into the next). */
export type StoryWindow =
  [id: string, f0: number, f1: number] | [StoryPoint, StoryPoint];

/** A window's absolute story p edges. Exported because a WINDOW is authored as
 *  scene-relative fractions but every reader that wants to know where it SITS —
 *  story/state.ts's open-window report, the STORY-MAP's sample points — needs
 *  the absolute pair, and re-resolving the fractions at those call sites would
 *  be a second copy of this resolution. `pulse` below is the same function's
 *  first consumer. */
export const windowEdges = (w: StoryWindow): [number, number] => {
  if (typeof w[0] === "string") {
    const [id, f0, f1] = w as [string, number, number];
    const r = rangeOf(id);
    return [atFrac(r, f0), atFrac(r, f1)];
  }
  const [a, b] = w as [StoryPoint, StoryPoint];
  return [atFrac(rangeOf(a[0]), a[1]), atFrac(rangeOf(b[0]), b[1])];
};

/** Mechanism envelope: smoothstep RISE over one window × optional smoothstep
 *  FALL over another (omit `fall` for a one-way ramp). Windows name their
 *  scenes — see StoryWindow for the two edge forms. */
export const pulse = (
  p: number,
  w: { rise: StoryWindow; fall?: StoryWindow },
): number => {
  const [r0, r1] = windowEdges(w.rise);
  if (r0 >= r1)
    throw new Error(
      `lens story: pulse rise window ${JSON.stringify(w.rise)} resolves reversed or zero-width (p0 ${r0} >= p1 ${r1})`,
    );
  const rise = smoothstep(r0, r1, p);
  if (!w.fall) return rise;
  const [f0, f1] = windowEdges(w.fall);
  if (f0 >= f1)
    throw new Error(
      `lens story: pulse fall window ${JSON.stringify(w.fall)} resolves reversed or zero-width (p0 ${f0} >= p1 ${f1})`,
    );
  return rise * (1 - smoothstep(f0, f1, p));
};
