// ============================================================================
// The STORY's fly-through span: the dive the /lens demo (explore/demos.ts
// d-flythrough) performs, re-hosted on the scroll. It runs from `flythrough`
// through `constellations` and `trails` and ends inside `rewrap`.
//
// THE STORY'S CAMERA NEVER LEAVES ITS RIG. The demo flies a camera down the
// bore; here the camera PARKS on the optical axis (the flythrough story row is
// authored at exactly the dive's opening pose) and the LENS travels past it —
// x_model = X_PARK − x_camera, the same frames from the same numbers, with the
// dive's own path demoted to a generator for that one scalar. The dive used to
// be a second camera blended in and out against the story rig, and the blend
// OUT is what put a 160° swing over the trails→rewrap seam. There is no blend
// now: the fov ramp is the only thing that stays camera-side, and it, the story
// camera's own move and the lens' last steps home all wait for one number
// (story/story.ts REVEAL_END) — so the reveal the lens walks back for is played
// on a camera that has not moved since the sky.
//
// EVERY OTHER LAW HERE IS THE DEMO'S, TRANSCRIBED — the aperture ramp, the focus
// rack, the sky window, the room/glint darkening, the travel remap and the
// passage fade are the same expressions over the same FLY knobs
// (optics/fly-core.ts). The demo's kit verbs become handle calls:
// `drive(ch, v)` → `scene.state.<ch>` + `<ch>Target`, `set(u, v)` → `u.value`.
// If a number here disagrees with the demo, the demo is right.
//
// WITH ONE DECLARED EXCEPTION, and it is one edge: the STREAK ramp's fall is
// re-hosted onto the WORMHOLE's fall window (see flyStreakAt) so the ring and
// the smear it is made of end on the same frame. (The ramps were once given a
// sustained fall into the sky scenes — task 62 — and the owner walked it back:
// "No pause. I just wanted the ring to look better when you slowly scroll
// down." The warp now lives and dies with the dive's own motion, on the demo's
// clock, and only the ring's visual-quality work from that task remains.)
//
// LAZY MODULE. It statically imports the uniform boxes from
// optics/wormhole-post.ts and optics/starfield.ts, which drag in three/tsl node
// graphs that must stay out of the homepage's initial chunk — so this file is reachable ONLY through
// hero-driver's dynamic import(), and must NEVER be re-exported from index.ts.
//
// WHAT IT OWNS: the aperture and focus channels (value AND target, so the
// driver's own per-frame writes cannot fight it), the four sky/warp uniforms, the
// realistic↔ink blend (materials/unified.ts — a RAMP at each edge, where the
// look used to cut), the glass swap, the room light and glass glint, the lens'
// dolly and body cover, and the camera's fov. It does NOT touch zoom/explode/
// assemble — the story drives those straight through the span (rewrap's bridge
// teardown runs while the fly is still active) — and it never PLACES the
// camera.
// ============================================================================
import type { CameraPose, SceneHandle } from "../core/scene";
import { clamp01, lerp, smoothstep } from "../core/math";
import { isLightTheme, watchTheme } from "../core/theme";
import { rangeOf, atFrac, REVEAL_END, SKY_OUT_END, DIVE_P0 } from "./story";
import {
  FLY,
  flyPose,
  travelRemap,
  passageFade,
  poseCamX,
  passageOrder,
  GLASS_SPANS,
} from "../optics/fly-core";
import { uWormhole } from "../optics/wormhole-post";
import { uStarMix, uStarStreak, uStarRing } from "../optics/starfield";

const flyR = rangeOf("flythrough");
const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");
/** where the story camera starts leaving the internals pose: the flythrough
 *  scene's own APPROACH — its `transit` (story/story.ts) — over which the rig
 *  swings onto the optical axis and parks. The iris is shut through it.
 *
 *  Exported for the same reason EXIT_END and HYST are: story/state.ts reports
 *  where the ink's way OUT sits, and it must read the edge rather than re-derive
 *  it from the scene table. */
export const CAM_IN = flyR.p0;
// DIVE_P0 — the end of that approach, where the camera is parked dead-on at
// −FLY.distFar and everything that moves from here to the sky's end is the LENS
// — is IMPORTED from story/story.ts, which derives it from the scene's transit.
// It lives there rather than here because hero-driver's body-fade tile has to
// end on exactly this number, and hero-driver cannot import it from this lazy
// module without dragging the dive's optics into the homepage's first chunk.
/** THE SPAN'S LAST FRAME — where the dive hands the scene back: the sky
 *  unmounts, the dolly and the fov override are released (the GLASS came off a
 *  scene earlier — GLASS_OUT below).
 *
 *  IT SITS PAST THE FOV HAND-BACK, and that ordering is why it is here rather
 *  than at the reveal's own end. The override may only be released where the two
 *  fovs already agree (exit() writes `null`, which is a cut, not a ramp) — so
 *  the span has to outlive that ramp (FOV_BACK, out at rewrap-local 0.52).
 *  Everything the sky needed was finished long before: the starfield fades out
 *  by rewrap-local 0.32 (SKY_OUT_END) and the trails' envelope by 0.28, so the
 *  extra scroll is a mounted-but-invisible sky, not a visible one. Exported so
 *  the tests pin the edges against this number instead of a copy of it. */
export const EXIT_END = atFrac(rwR, 0.58);
/** WHERE THE TRANSMISSIVE GLASS HANDS BACK — its own edge, INSIDE the span and
 *  far ahead of EXIT_END, because the ink return (INK_RETURN below) now opens
 *  while the span is still active and any ink at all over the dive's clones
 *  would stomp them (materials/unified.ts setInk swaps the elements' material
 *  at GLASS_HANDOVER, and the clone cache would then re-key). So the swap comes
 *  off HERE: after the blind journey home is finished (flyReturnAt saturates at
 *  0.05) and before the reveal's crossfade opens (0.06) — the lens is under the
 *  full body cover for the whole hand-back, so a material cut that would be a
 *  visible pop anywhere else lands on a lens that is not drawn at all. The
 *  reveal then uncovers elements wearing their own merged realistic material
 *  (transmission still on — the look is the story's realistic glass), and the
 *  ink's designed cross-fade takes them from there. A scrub back down remounts
 *  the swap a hysteresis below this edge, still under the cover, with the ink
 *  exactly 0 (INK_RETURN[0] sits a tenth of the scene above — pinned). */
export const GLASS_OUT = atFrac(rwR, 0.055);
/** THE INK'S WAY BACK — [start, end], both taste knobs (owner: the old return,
 *  rewrap-local [0.451, 0.65], was "wayyy too late").
 *
 *  THE START IS THE BODY-FADE TOP: flyRevealAt saturates at rewrap-local 0.16
 *  (the coupling is pinned in __tests__/story-fly.test.ts, not by the numbers
 *  matching), so the APPEARANCE itself is played entirely realistic — the
 *  owner's refined direction — and the realistic→ink dissolve visibly begins
 *  on the first frame the lens is wholly drawn. The LENGTH is the old window's
 *  (0.20 of the scene), just moved early: the assembling lens reads as ink from
 *  rewrap-local 0.36 on, well before caps-on. */
export const INK_RETURN: [number, number] = [
  atFrac(rwR, 0.16),
  atFrac(rwR, 0.36),
];
/** THE SLACK, exported so __tests__/story-fly.test.ts pins the ink ramps against
 *  the same number the edges are built from rather than a copy of it.
 *
 *  scroll-p slack past each edge before the span's side effects are torn down,
 *  so a scrub sitting exactly on an edge cannot thrash enter()/exit(). Every
 *  frame inside this slack past an edge is a frame of the WRONG look — the fly's
 *  realistic/dark over the story's scene, or the story's ink over the starfield —
 *  so it is kept to about half a wheel notch: enough to break the thrash, too
 *  narrow to read as a flash. */
export const HYST = 0.005;

/** THE LOOK'S HAND-OVER — 1 = the story's ink, 0 = the realistic lens the dive
 *  flies through. The two looks are ONE material now (materials/unified.ts), so
 *  this is a blend, not a cut: the ink dissolves out over the camera's approach
 *  swing and comes back over INK_RETURN, right after the reveal draws the lens.
 *
 *  BOTH RAMPS SIT OUTSIDE THE GLASS SUB-SPAN, hysteresis included. The elements
 *  are the one piece of the pair that still swaps a material (glass cannot
 *  merge — see materials/unified.ts's header), so any ink at all while the dive
 *  owns the glass would stomp its transmissive clones. The dissolve OUT ends at
 *  `DIVE_P0 − HYST`, so enter() only ever sees a whole realistic look; the way
 *  back opens at INK_RETURN[0], a tenth of the scene after GLASS_OUT has
 *  already handed the elements their own materials back — the ink returns while
 *  the SPAN is still active (deliberately: the owner moved it under the fov
 *  hand-back), but never while the clones are mounted. Pinned in
 *  __tests__/story-fly.test.ts.
 *
 *  THE DOLLY IS NO LONGER ITS LICENCE. This ramp used to be the thing that let
 *  the lens be away from home at all — the ink's depth fade read planes derived
 *  from the camera's distance to the ORIGIN, so ink over a dollied lens
 *  dissolved it. The planes now track the SUBJECT — the story target plus the
 *  lens' own dolly (core/scene.ts's fade-plane block) — so the return may open
 *  while the reveal's overshoot is still seating (dolly 3.5 → 0 over
 *  rewrap-local [0.25, 0.34], inside this very window) and the fade stays
 *  correct for every frame of it. */
export const flyInkAt = (p: number) =>
  1 -
  smoothstep(CAM_IN, DIVE_P0 - HYST, p) *
    (1 - smoothstep(INK_RETURN[0], INK_RETURN[1], p));

/** THE FRAMING'S CENTRE, on the ink's own ramp inverted: 1 = the optical axis
 *  is in the middle of the frame, which is what the dive is a shot down. It is
 *  written on the same terms as the ink — every frame, active or not — so the
 *  swing is over before the first dive frame rather than at it (see frame()).
 *
 *  A ONE-LINE COMPOSITION WITH A NAME because story/state.ts reports it: what
 *  frame() writes has to be a function this module exports, or the report is a
 *  transcription of a line it cannot see change. */
export const flyCentreAt = (p: number) => 1 - flyInkAt(p);

/** THE SKY'S WAY OUT — the reveal's fade, the mirror of the dive's `pSkyIn`
 *  window at the other end of the span. Over rewrap-local [0.02, 0.32] the sky
 *  and the stars ramp to nothing WHILE the backdrop is blended to the rewrap
 *  stage's own tint (scene.setSkyDim), so the unmount at the span's edge —
 *  which swaps a three-rendered background for the page's CSS one — happens
 *  between two frames of the same color. The far edge is story/story.ts's
 *  SKY_OUT_END — the owner's fluid-transition correction pushed it deeper
 *  into the scene (it was 0.22), so the starfield now OUTLIVES the reveal and
 *  the collapse (REVEAL_END sits at 0.25, inside this fade) and the arcs die
 *  under a sky that is still going out rather than one already gone. It still
 *  ends well before EXIT_END (0.32 against 0.58): the sky must be gone by the
 *  time the span tears itself down, not at that moment.
 *  1 through the whole dive and both sky scenes; 0 from SKY_OUT_END on. */
export const skyOutAt = (p: number) =>
  1 - smoothstep(atFrac(rwR, 0.02), SKY_OUT_END, p);

/** Dive progress: the flythrough scene scrubs the dive from the end of its
 *  approach (DIVE_P0); the two sky scenes hold its end frame. */
export const flyDiveP = (p: number) =>
  clamp01((p - DIVE_P0) / (flyR.p1 - DIVE_P0));

/** THE SKY'S WAY IN, on the DIVE's own clock (the demo's `FLY.pSkyIn`): no
 *  stars before the camera reaches the mount. The mirror of skyOutAt above. */
export const flySkyInAt = (pFly: number) =>
  smoothstep(FLY.pSkyIn[0], FLY.pSkyIn[1], pFly);

/** WHAT BOTH SKY FADE UNIFORMS GET — the arrival, less the reveal's fade. Only
 *  the starfield ever mounts on the story path, but the two uniforms are written
 *  together (branching here would put a dead check in the per-frame path), so
 *  there is one value and this is it.
 *
 *  EXACTLY 0 OUTSIDE THE SPAN, which is what lets story/state.ts report it
 *  everywhere: below DIVE_P0 the dive progress is 0 and the arrival has not
 *  opened; above EXIT_END the way out closed a quarter of the rewrap scene
 *  earlier. So the function agrees with exit()'s teardown rather than the report
 *  having to copy it — pinned in __tests__/story-fly.test.ts. */
export const flySkyMixAt = (p: number) => flySkyInAt(flyDiveP(p)) * skyOutAt(p);

/** THE DARKNESS: the room and the glass' own reflections going out with the
 *  barrel, on the dive's clock and RELEASED by the sky's fade (× skyOutAt) so
 *  the light is already back when exit() sets it to 1. The two LEVELS are one
 *  lerp away each (FLY.darkFloor, FLY.glintFloor) and are composed in frame().
 *  Exactly 0 outside the span, for the same two reasons flySkyMixAt is. */
export const flyDarkAt = (p: number) =>
  smoothstep(FLY.pDark[0], FLY.pDark[1], flyDiveP(p)) * skyOutAt(p);

/** THE PINCH at story p: the demo's own arc, whole — rise to the mid-dive peak,
 *  fall spent by 0.84 of the dive (`FLY.pWormhole`), i.e. alive exactly while
 *  the dive visibly travels and gone as its tail drifts into the park.
 *
 *  IT WAS BRIEFLY SUSTAINED into the sky scenes (task 62 gave it a story-side
 *  fall through the first third of `constellations`), and the owner walked
 *  that back: the sustain held the frame at meaningful warp strength after the
 *  dive's motion had ended, and "No pause. I just wanted the ring to look
 *  better when you slowly scroll down." What that task was actually for — the
 *  ring riding the sprite band, the widened profile, radius-scaled streak
 *  widths, the derived ring radius (optics/wormhole-post.ts, optics/starfield.ts) — is
 *  untouched; only the envelope came home. Dying on the dive's own clock also
 *  makes the old hard laws trivial: exactly 0 through `trails` (the perfect
 *  circles), exactly 0 under the constellation quote — a whole scene of margin
 *  each. Also the ring's ramp — the sprite band's swing from radial to
 *  tangential (`uStarRing`) is half of the same feature. */
export const flyWarpAt = (p: number) => {
  const pFly = flyDiveP(p);
  return (
    smoothstep(FLY.pWormhole[0], FLY.pWormhole[1], pFly) *
    (1 - smoothstep(FLY.pWormhole[1], FLY.pWormhole[2], pFly))
  );
};

/** THE STREAKS — the demo's rise (a touch behind the pinch's: the smear wants a
 *  throat to smear into), and the PINCH'S fall rather than the demo's own
 *  (`FLY.pStreak[2]`, out by 0.78 of the dive): the ring is MADE of the streaks
 *  on the sprite side — a band star's mark is `uStarRing` swinging its streak
 *  tangential, and a streak of zero length swings nothing — so the two halves
 *  of the feature end on the same frame, which is the one piece of task 62's
 *  ring work that lives in an envelope. */
export const flyStreakAt = (p: number) => {
  const pFly = flyDiveP(p);
  return (
    smoothstep(FLY.pStreak[0], FLY.pStreak[1], pFly) *
    (1 - smoothstep(FLY.pWormhole[1], FLY.pWormhole[2], pFly))
  );
};

/** WHERE THE PARKED CAMERA SITS, world X. The dive's own path opens with the
 *  camera `FLY.distFar` behind the lens (flyPose at p 0), so parking there is
 *  what makes the model's dolly exactly 0 on the dive's first frame — and the
 *  flythrough story row is authored from the same number (story/story.ts). */
export const X_PARK = -FLY.distFar;

/** The dive's pose at story p, through the interior remap (FLY.insideRate) —
 *  held at the first pose until the approach is over (flyDiveP is 0 there).
 *  Read TWICE: as the model's dolly below, and as the passage fade's ruler. */
export const flyPoseAt = (p: number) =>
  flyPose(travelRemap(flyDiveP(p), FLY.pInside, FLY.insideRate));

/** WHERE THE REVEAL IS PLAYED, world X: the lens does not come back to the
 *  origin for it, it comes back to HERE — three and a half units PAST home, i.e.
 *  12.5 world units from the parked camera instead of 9.
 *
 *  THE OWNER'S NOTE: "the lens is a bit too close to the camera during the
 *  reveal". The reveal is shot on the dive's own fov (70°, the widest framing in
 *  the story) and the exploded shell is far bigger than the assembled lens, so a
 *  lens standing at the origin filled the frame at the one beat that wants to
 *  read as a whole object coming together. The overshoot is a pure DOLLY — the
 *  camera does not move and the fov does not change, so nothing about the shot's
 *  geometry changes, only how much of the frame the thing occupies: 12.5/9 =
 *  1.39× less of it, everywhere.
 *
 *  MEASURED against the shipped reveal, in frame heights: the model's bounding
 *  sphere read 0.232 at rewrap-local 0.08 and shrank to 0.192 by 0.16 (the
 *  camera was drifting away through the beat); it is now 0.171 and HELD for the
 *  whole of it. The front element's own drawn disc at 0.14 goes 0.047 → 0.041.
 *
 *  IT IS NOT A NEW PLACE FOR THE LENS TO LIVE. The story's poses all orbit the
 *  ORIGIN, so the lens has to be exactly home before the chain's framing means
 *  anything — see flySeatAt, which gives the distance back as the chain starts
 *  to move. */
export const REVEAL_X = 3.5;

/** THE JOURNEY BACK — 0 while the lens is out on the dive, 1 once it has
 *  returned to the reveal's park (REVEAL_X above; it is NOT home yet, see
 *  flySeatAt). It has an ease of ITS OWN rather than a reversed dive: the dive's
 *  tail is a slow drift, so replaying it backwards would slide the lens 28 units
 *  in the last hundredth of it.
 *
 *  IT RUNS BLIND, and that is the constraint that places it: the lens travels
 *  through the camera's own position, and the only thing that makes that
 *  survivable is the BODY COVER — nothing of the model is drawn for any frame of
 *  this window (see frame()). So it ends BEFORE the reveal window the cover
 *  lifts over — the lens is standing still on the first frame anyone can see it
 *  — and starts inside the trails' hold, where the model is 16 units behind the
 *  camera and the sky is the whole frame. */
export const flyReturnAt = (p: number) =>
  smoothstep(atFrac(tR, 0.9), atFrac(rwR, 0.05), p);

/** …AND THE LAST LEG, from the reveal's park to the origin: 0 through the whole
 *  reveal, 1 once the lens is exactly home.
 *
 *  IT STARTS AT REVEAL_END (story/story.ts). That edge used to be the frame the
 *  exploded radius was spent, so that nothing of this ran while the shell was
 *  still travelling; the collapse now belongs to the ending (story/envelopes.ts
 *  CONSTRUCT) and the shell IS still out here — but parked, rigid, at a
 *  constant radius, so this walk translates a cloud that is not itself moving,
 *  which is what that ordering was protecting. It is the LAST of the staggered
 *  movers (chain creep at CAM_RELEASE_F, fov push at FOV_BACK[0], then this):
 *  the frame closes on the lens while the lens comes to meet it.
 *
 *  IT MUST STILL FINISH EARLY: the chain's poses orbit the ORIGIN, so a lens
 *  short of it is a lens off the frame's centre by the sine of however far the
 *  camera has swung — and the chain now leaves at CAM_RELEASE_F (story/story.ts,
 *  the de-stacked onset), 0.09 of the scene before this window even opens. The
 *  chain's zero-rate departure is what keeps that affordable: its move is ~1%
 *  done at this window's start and ~4% at its end, and the measured off-centre
 *  drift stays within a few hundredths of a frame height, under everything else
 *  the reassembly is doing. (The INK is no longer a reason to hurry — its
 *  return overlaps this window by design, licensed by the subject-tracking
 *  fade planes; see flyInkAt.) */
export const flySeatAt = (p: number) =>
  smoothstep(REVEAL_END, atFrac(rwR, 0.34), p);

/** THE REVEAL — the exploded lens coming back on screen, 0 = covered, 1 = fully
 *  drawn. THE OWNER'S BEAT: the pieces arrive at FULL explosion — parked on
 *  their outer radius, the channel held at 1 across this whole window — and it
 *  now stays at 1 for the whole scene, since the collapse moved to the ending
 *  (story/envelopes.ts CONSTRUCT) — and already
 *  turning about the optical axis, because the MODEL is rolling in the sky's
 *  own direction (story/reveal.ts revealRollAt, written from
 *  story/hero-driver.ts) while the star trails sweep on. The sky's rotation is
 *  handed to the model rather than cut away from: both are on screen together
 *  across a LONG shared stretch — this is up by 0.16 and the trails' own
 *  envelope runs out at rewrap-local 0.28 (story/trails.ts), so the fully
 *  drawn shell turns under the sweeping arcs for 0.12 of the scene before
 *  they go (the owner's fluid-transition correction: the old 0.18 far edge
 *  made the exchange a blink at any real scroll speed) — and the sky is
 *  still turning at its cruising rate when it goes.
 *
 *  IT IS PLAYED ON A DEAD-STILL CAMERA, and that is the second half of the
 *  owner's direction. Nothing camera-side moves for any frame of this window:
 *  the fused chain is held bit-still through its far edge (story/story.ts
 *  CAM_RELEASE_F — the chain then CREEPS, sub-perceptibly, so the ending's move
 *  is never an onset event), the fov is the dive's own 70 with the hand-back
 *  not yet started (FOV_BACK opens at SKY_OUT_END, 0.32), and the lens is
 *  parked at REVEAL_X — so the pieces' spin, their fade-in and the assembly are
 *  the ONLY motion in the frame.
 *
 *  It is also the LIGHT: the room comes back up on the sky's fade-out window
 *  (`out` in frame()), so the model rises out of the dive's darkness over
 *  exactly these beats instead of being switched on. */
export const flyRevealAt = (p: number) =>
  smoothstep(atFrac(rwR, 0.06), atFrac(rwR, 0.16), p);

/** THE BODY COVER, this span's half of the `setBodyFade` channel: 1 = the model
 *  is drawn, 0 = it is not. On over the dive's last tenth — where the lens is
 *  already behind the camera (FLY.pClear) and nothing can see it leave, since
 *  the return CROSSES the camera — and off again over the reveal.
 *
 *  EXACTLY 1 AT DIVE_P0, which is the other half of the range-tiled hand-over:
 *  hero-driver writes story/peelcards.ts's `peelBodyFadeAt` for every p BELOW
 *  DIVE_P0 (also exactly 1 there, from cards-local 0.82 on) and this from
 *  DIVE_P0 up, so the channel has an owner at every p and no step where they
 *  meet. Pure and exported so __tests__/story-fly.test.ts can pin that. */
export const flyBodyFadeAt = (p: number) =>
  1 - smoothstep(0.9, 1, flyDiveP(p)) * (1 - flyRevealAt(p));

/** WHERE THE FRAMING GOES BACK TO THE STORY — the fly's fov ramp unwinding to
 *  the story chain's own. The dive ends at fov 70 and the chain leaves on 42, so
 *  this is a real 1.8× push-in on whatever is in the frame, and it is a CAMERA
 *  move in everything but name.
 *
 *  ITS EDGES ARE THE DE-STACKING (owner: the trails→reassemble camera work was
 *  "very jarring" — three movers used to onset together on REVEAL_END out of a
 *  bit-still hold). The push-in opens at the SKY'S far edge — SKY_OUT_END,
 *  rewrap-local 0.32, skyOutAt's own second edge, where the starfield is
 *  exactly gone (the coupling is pinned in __tests__/story-fly.test.ts): the
 *  ramp SCALES the sky (the starfield is geometry on the camera), so this is
 *  the earliest frame it cannot bend a star or a live trail (envelope out at
 *  0.28), and the crown arc is fully tracking the front element's own drawn
 *  disc long before (story/trails.ts crownLiveAt saturates at 0.22) so it
 *  follows the push like any part of the lens. With the sky's exit moved deep
 *  for the fluid hand-over (SKY_OUT_END's comment), this now opens AFTER the
 *  seat's onset rather than before it — the stagger's ORDER changed (chain,
 *  seat, fov) but no frame gained a second onset, which is the law the
 *  de-stacking actually states. The window's scroll length barely moves —
 *  0.34 screenfuls ([0.32, 0.52] of a 1.7 scene) against 0.31 ([0.22, 0.44]
 *  of 1.4) — so the 1.8× spread keeps its gentle rate, running over the
 *  reassembly's last gathering. It must still be FINISHED before the span
 *  releases the override, since exit() writes `null`, which is a cut — hence
 *  EXIT_END sits past its end, not on it. */
export const FOV_BACK: [number, number] = [SKY_OUT_END, atFrac(rwR, 0.52)];

export const flyFovBackAt = (p: number) =>
  smoothstep(FOV_BACK[0], FOV_BACK[1], p);

/** THE OVERRIDE'S TWO ARGUMENTS, named so the report reads them rather than
 *  rebuilding them: how much of the fly's fov is in force (1 = wholly the dive's,
 *  0 = wholly the story chain's) … */
export const flyFovMixAt = (p: number) => 1 - flyFovBackAt(p);

/** … and WHICH fov that is: the pose's own, or the park's where a path segment
 *  omits it (posePath keys a fov on every segment; the type allows omission and
 *  the park's value is what such a pose would be opening on). */
export const flyFovOf = (pose: CameraPose) => pose.fov ?? FLY.fovFar;

/** THE DOLLY, world X: the model's placement under the parked camera. The dive
 *  is authored as a camera flying to `camX`; with the camera parked at X_PARK
 *  the identical frame comes from putting the model at X_PARK − camX (both are
 *  the same relative displacement along the axis, and nothing else in the scene
 *  is world-anchored — the sky rides the camera).
 *
 *  THEN TWO LEGS BACK, not one: the blind journey to the reveal's park
 *  (flyReturnAt → REVEAL_X, all of it under the body cover) and the last three
 *  and a half units to the origin once the reveal is over (flySeatAt). The two
 *  windows do not overlap — the first is finished at rewrap-local 0.05 and the
 *  second does not open until REVEAL_END — so the composition below is a plain
 *  hold in between and cannot fight itself. 0 outside the span, where the story
 *  owns the lens. */
export const flyDollyAt = (p: number) =>
  lerp(
    lerp(X_PARK - poseCamX(flyPoseAt(p)), REVEAL_X, flyReturnAt(p)),
    0,
    flySeatAt(p),
  );

/** The demo's iris ramp (d-flythrough apply): stopped down at the park, wide
 *  open by the end of the approach and held — a smoothstep saturates at both
 *  edges, so this is exactly `apertureShut` below pAperture[0] and exactly 0
 *  above pAperture[1]. Fully open BEFORE the glass (FLY.pAperture's law). */
export const flyApertureAt = (pFly: number) =>
  lerp(
    FLY.apertureShut,
    0,
    smoothstep(FLY.pAperture[0], FLY.pAperture[1], pFly),
  );

/** …and the demo's focus rack (d-flythrough apply): the dial finds the new world
 *  once the front element is behind us (FLY.pFocus), so the stars resolve while
 *  the camera already faces nothing but open sky. */
export const flyFocusAt = (pFly: number) =>
  smoothstep(FLY.pFocus[0], FLY.pFocus[1], pFly);

export function createStoryFly(scene: SceneHandle): {
  frame(p: number): void;
  warm(): Promise<void>;
} {
  let active = false;
  /** the transmissive glass sub-span's own flag (GLASS_OUT) — a subset of
   *  `active` in time, never true without it. */
  let glassOn = false;
  let warmed = false;
  /** the dolly this module last wrote — it is the only writer, and the ruler
   *  below may only be measured while it is 0 (see enter). */
  let dollyNow = 0;
  let warnedOffRest = false;
  /** the elements REAR TO FRONT with their rearmost world X — the ruler the
   *  passage fade reads, measured once per page load at channel rest. */
  let passage: { id: string; x0: number }[] = [];
  /** the measurement in `passage` was taken at rest, so it is the real ruler
   *  and no later activation may re-take it. */
  let passageAtRest = false;
  const fades: Record<string, number> = {};
  /** the tint the sky fades INTO: the rewrap scene's own stage color, which is
   *  what the page paints behind the canvas once the starfield unmounts. Cached
   *  per theme rather than re-picked per frame. */
  let rewrapBg = isLightTheme() ? rwR.scene.bgLight : rwR.scene.bg;
  watchTheme((l) => {
    rewrapBg = l ? rwR.scene.bgLight : rwR.scene.bg;
  });

  function enter(p: number) {
    // The spans come off the CPU geometry in its rest pose, so a measurement
    // taken with a mechanism mid-move would place the elements wrong for the
    // whole dive. The story's zoom/explode/assemble are all home on the way IN,
    // but an upward re-entry from rewrap arrives with assemble/explode mid-move
    // — so a good measurement is kept for the life of the page and a bad one
    // (deep link into the span) is used for its own activation only, then
    // replaced by the first activation that does catch the mechanism at rest.
    if (!passageAtRest) {
      // AT REST INCLUDES AT HOME: worldAxialSpans measures the model where it
      // stands, so a measurement taken with the lens dollied out would place
      // every element up to 25 world units off and hold every glass fade at 1
      // for the whole dive. This module is the dolly's only writer and it is 0
      // on every frame outside the span, so the term states the INVARIANT the
      // measurement depends on rather than covering a reachable case.
      const atRest =
        dollyNow === 0 &&
        Math.abs(scene.state.zoom) +
          Math.abs(scene.state.explode) +
          Math.abs(scene.state.assemble) <
          0.01;
      if (!atRest && !warnedOffRest) {
        warnedOffRest = true;
        console.warn("lens fly: measuring spans off-rest");
      }
      passage = passageOrder(scene.worldAxialSpans(Object.keys(GLASS_SPANS)));
      passageAtRest = atRest;
    }
    // THE GLASS ONLY MOUNTS BELOW ITS OWN EDGE. An activation from the dive
    // side (p ≤ GLASS_OUT) wears the clones; an activation from ABOVE — a
    // scrub back down across EXIT_END, where the ink is already fully returned
    // and the elements wear their mint fill — must NOT clone whatever the
    // meshes have on (a clone of the ink material carries no transmission and
    // would poison the clone cache); the sub-span gate in frame() remounts it
    // under the body cover once the scrub crosses GLASS_OUT with the ink gone.
    if (p <= GLASS_OUT) mountGlass();
    // The always-on dust would float in front of the sky.
    scene.setDust(false);
    // The sky and the pinch, fire-and-forget: a mount that never lands leaves a
    // dive that otherwise runs, minus the stars — say so out loud.
    void scene.enableStarfield(true).then((ok) => {
      if (!ok) console.warn("lens fly: starfield failed to start");
    });
    void scene.enableWormholePost(true).then((ok) => {
      if (!ok) console.warn("lens fly: wormhole post pass failed to start");
    });
  }

  /** COMPILE THE DIVE BEFORE IT IS NEEDED. enter()'s own work is under a
   *  millisecond (measured — the shading swap and the glass clones both); what
   *  cost the crossing ~180ms of one frame was everything three does the first
   *  time the dive's look is DRAWN: the wormhole pass's own pipeline, and then
   *  a second pipeline per material because the pass renders into its own
   *  target rather than onto the canvas. core/scene's warmFly draws exactly
   *  that frame into a 1×1 target, off screen and off the crossing; this hands
   *  it the same two knobs enter() uses, so the frame it warms is the frame the
   *  dive asks for. Driven at idle from hero-driver's prefetch, scenes ahead. */
  async function warm() {
    if (warmed || active) return;
    warmed = true;
    await scene.warmFly(GLASS_SPANS);
  }

  /** The transmissive sub-span's two edges — see GLASS_OUT for why the swap has
   *  a life of its own inside the span. Mount is idempotent-by-flag; both are
   *  called from enter()/exit() AND from the gate in frame(). */
  function mountGlass() {
    if (glassOn) return;
    glassOn = true;
    scene.setGlassTransmissive(true, GLASS_SPANS);
    scene.setGlassFade(1);
  }

  function releaseGlass() {
    if (!glassOn) return;
    glassOn = false;
    // Per-element fades back to 1 BY ID: applyGlassElementFade only writes the
    // ids it is handed, so an empty record restores nothing — and the write is
    // a no-op once the swap is off, hence before setGlassTransmissive(false).
    for (const id of Object.keys(GLASS_SPANS)) fades[id] = 1;
    scene.setGlassElementFade(fades);
    // The elements' own materials go back on here. On the scroll-through path
    // this runs at GLASS_OUT, under the full body cover (nothing of the model
    // is drawn), which is what makes a material cut invisible; the ink return
    // opens a tenth of the scene later, so the drawing never lands on a mesh
    // still wearing a clone.
    scene.setGlassTransmissive(false);
  }

  function exit() {
    releaseGlass();
    scene.setDust(true);
    scene.setRoomLight(1);
    scene.setGlassGlint(1);
    scene.setBodyFade(1);
    // THE LENS GOES HOME WITH THE SPAN. On the way out this is a no-op — the
    // return above finished before this edge — but a scrub back out of the dive
    // leaves the span at any dolly, and the story owns a lens at the origin.
    dollyNow = 0;
    scene.setLensDolly(0);
    scene.setStoryFov(null);
    uStarMix.value = 0;
    uWormhole.value = 0;
    uStarStreak.value = 0;
    uStarRing.value = 0;
    // BEFORE the unmount, which is what makes it land: setSkyDim is a no-op on
    // an unmounted starfield, so a dim left on here would still be on the
    // backdrop the NEXT mount puts up (a scrub back into the dive would open on
    // a rewrap-colored sky).
    scene.setSkyDim(0, rewrapBg);
    void scene.enableStarfield(false);
    void scene.enableWormholePost(false);
  }

  return {
    warm,
    frame(p) {
      const pFly = flyDiveP(p);
      const pose = flyPoseAt(p);
      // LEAVE FIRST, THEN THE LOOK, THEN ARRIVE. exit() hands the elements
      // their own materials back and must run BEFORE any ink returns to them;
      // enter() clones those materials and must run AFTER the last of it is
      // gone. flyInkAt's dissolve-out sits outside the hysteresis at the rise
      // edge, and the return ramp opens a tenth of the scene after the GLASS
      // sub-span's own release (GLASS_OUT) — so the writes below are never
      // actually in the same frame; this order is what keeps that true if an
      // edge is ever moved.
      if (active && (p < DIVE_P0 - HYST || p > EXIT_END + HYST)) {
        active = false;
        exit();
      }
      scene.setInkMix(flyInkAt(p));
      // …AND THE FRAMING CENTRES WITH IT. Written on the same terms as the ink
      // — every frame, active or not — because the approach's swing is where it
      // has to happen: the dive is a shot down the optical axis and wants that
      // axis at the middle of the frame (core/scene setStoryCentre), and the
      // ramp has to be over before the first dive frame, not at it.
      scene.setStoryCentre(flyCentreAt(p));
      if (!active && p >= DIVE_P0 && p <= EXIT_END) {
        active = true;
        enter(p);
      }
      if (!active) return;
      // THE GLASS SUB-SPAN'S OWN GATE (see GLASS_OUT): the swap comes off as
      // the scroll crosses its edge — under the body cover, before the reveal
      // — and goes back on a hysteresis BELOW it on the way down, so a scrub
      // parked exactly on the edge cannot thrash the clones on and off.
      if (glassOn && p > GLASS_OUT) releaseGlass();
      else if (!glassOn && p < GLASS_OUT - HYST) mountGlass();
      // Value AND target on both channels: the driver's own per-frame writes
      // land before this call, and tick()'s ease would otherwise chase them.
      const a = flyApertureAt(pFly);
      scene.state.aperture = a;
      scene.state.apertureTarget = a;
      const f = flyFocusAt(pFly);
      scene.state.focus = f;
      scene.state.focusTarget = f;
      // NO STARS BEFORE THE DIVE, and one window back out: both are folded into
      // flySkyMixAt above. The way out is a FACTOR rather than a second writer's
      // own write, because this uniform is this module's on every active frame.
      const sky = flySkyMixAt(p);
      const out = skyOutAt(p);
      uStarMix.value = sky;
      // the ground under the fading stars walks to the color of the stage that
      // is about to replace it — the cut at the unmount lands on matching frames
      scene.setSkyDim(1 - out, rewrapBg);
      // AND THE ROOM GOES OUT WITH IT — the barrel is a dark tube, and the
      // glass's own reflections go with the room on the same window, to a
      // floor of their own (the barrel keeps a rim; the elements keep nothing).
      // The dark span RELEASES with the reveal fade (× out): as the backdrop
      // walks to the stage tint, the room light comes back up, so the model is
      // never a black silhouette on a light stage in the pre-cut frames — and
      // exit()'s setRoomLight(1) lands as a no-op instead of a jump.
      const dark = flyDarkAt(p);
      scene.setRoomLight(lerp(1, FLY.darkFloor, dark));
      scene.setGlassGlint(lerp(1, FLY.glintFloor, dark));
      // the frame pinches toward the exit axis and the stars draw out into
      // lines; the ring rides the WORMHOLE's ramp, not the streak's — and both
      // ramps outlive the dive by the sustain above (flyWarpAt/flyStreakAt),
      // which is the one place this file is not the demo's transcription
      const warp = flyWarpAt(p);
      uWormhole.value = warp;
      const streak = flyStreakAt(p);
      uStarStreak.value = streak;
      uStarRing.value = warp;
      // THE DIVE ITSELF: the lens slides past the parked camera, and its fov
      // ramp is the one thing that stays camera-side (a lens cannot carry it).
      // The returns are separate beats and separate windows: the LENS comes
      // back to the reveal's park before anything can see it (flyReturnAt),
      // then the staggered enders — fov at FOV_BACK, the last of the dolly at
      // REVEAL_END (flySeatAt). At DIVE_P0 the story row's own fov IS this
      // pose's (FLY.fovFar), so the way in has no step either way.
      dollyNow = flyDollyAt(p);
      scene.setLensDolly(dollyNow);
      scene.setStoryFov(flyFovOf(pose), flyFovMixAt(p));
      // THE BODY GOES WITH IT (flyBodyFadeAt, which carries the law and the
      // hand-over's half of the writer map).
      scene.setBodyFade(flyBodyFadeAt(p));
      // …and each element goes down as the camera arrives at it (the pose is
      // this frame's, taken above) — from inside an element three's
      // screen-space transmission blows up, so the camera must never be inside
      // visible glass.
      //
      // NOBODY HAS TO BRING THEM BACK ANY MORE: the per-element fade rides the
      // CLONES, and the clones are gone at GLASS_OUT — before the reveal's
      // window opens — so the elements return with the BODY, on the body-fade
      // crossfade over their own merged materials (the write below is a
      // guarded no-op once the swap is off). The reveal used to be a second
      // term here, needed only because the clones stayed mounted through it.
      const camX = poseCamX(pose);
      for (const e of passage)
        fades[e.id] = passageFade(camX, e.x0, FLY.passageLead, FLY.passageFade);
      scene.setGlassElementFade(fades);
    },
  };
}
