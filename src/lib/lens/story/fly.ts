// ============================================================================
// The STORY's fly-through span: the dive the /lens demo (explore/demos.ts
// d-flythrough) performs, re-hosted on the scroll. It runs from `flythrough`
// through `constellations` and `trails` and hands the camera back at `rewrap`.
//
// EVERY LAW HERE IS THE DEMO'S, TRANSCRIBED — the aperture ramp, the focus
// rack, the sky window, the room/glint darkening, the wormhole and streak arcs,
// the travel remap and the passage fade are the same expressions over the same
// FLY knobs (optics/fly-core.ts). The demo's kit verbs become handle calls:
// `drive(ch, v)` → `scene.state.<ch>` + `<ch>Target`, `set(u, v)` → `u.value`.
// If a number here disagrees with the demo, the demo is right.
//
// LAZY MODULE. It statically imports the uniform boxes from optics/warp.ts and
// optics/starfield.ts, which drag in three/tsl node graphs that must stay out of
// the homepage's initial chunk — so this file is reachable ONLY through
// hero-driver's dynamic import(), and must NEVER be re-exported from index.ts.
//
// WHAT IT OWNS: the aperture and focus channels (value AND target, so the
// driver's own per-frame writes cannot fight it), the six sky/warp uniforms, the
// glass swap, the room light and glass glint, and the camera pose override. It
// does NOT touch zoom/explode/assemble — the story drives those straight through
// the span (rewrap's bridge teardown runs while the fly is still active).
// ============================================================================
import type { SceneHandle } from "../core/scene";
import { clamp01, lerp, smoothstep } from "../core/math";
import { isLightTheme, watchTheme } from "../core/theme";
import { rangeOf, atFrac } from "./story";
import {
  FLY,
  flyPose,
  arc,
  travelRemap,
  passageFade,
  poseCamX,
  passageOrder,
  GLASS_SPANS,
} from "../optics/fly-core";
import { uSkyMix, uWormhole, uStreak } from "../optics/warp";
import { uStarMix, uStarStreak, uStarRing } from "../optics/starfield";

const flyR = rangeOf("flythrough");
const rwR = rangeOf("rewrap");
/** where the camera starts leaving the internals pose — the last quarter of the
 *  internals scene, the beat where the iris is closing down. */
const CAM_IN = atFrac(rangeOf("internals"), 0.75);
const EXIT_END = atFrac(rwR, 0.25);
/** scroll-p slack past each edge before the span's side effects are torn down,
 *  so a scrub sitting exactly on an edge cannot thrash enter()/exit(). Every
 *  frame inside this slack past an edge is a frame of the WRONG look — the fly's
 *  realistic/dark over the story's scene, or the story's ink over the starfield —
 *  so it is kept to about half a wheel notch: enough to break the thrash, too
 *  narrow to read as a flash. */
const HYST = 0.005;

/** Camera blend: 0 = story rig, 1 = fly pose.
 *
 *  THE HAND-OVER FINISHES BEFORE THE DIVE DOES ANYTHING. The blend rises over
 *  the INTERNALS TAIL and is complete AT the span's first frame, so the swing
 *  out of the rear three-quarter pose is the last beat of the internals scene —
 *  the lens locking in, centred and dead-on down its own axis, while the iris
 *  closes — and the dive itself opens on a frame that is already aimed. (It
 *  used to complete at flythrough-local 0.35, which spent the opening of the
 *  dive still swinging the camera round.) The story sample's view-offset park
 *  fades with this same number (core/scene scales the offset by 1 − mix), so
 *  the internals scene's xs park is gone by the time the blend is home.
 *
 *  IT IS THE CAMERA'S NUMBER ONLY. The span's side effects — the shading swap,
 *  the glass clones, the sky and the pass — gate on the SPAN (see frame), never
 *  on this: nothing may mount while the story still owns the scene. */
export const flyMixAt = (p: number) =>
  smoothstep(CAM_IN, flyR.p0, p) * (1 - smoothstep(rwR.p0, EXIT_END, p));

/** THE SKY'S WAY OUT — the reveal's fade, the mirror of the dive's `pSkyIn`
 *  window at the other end of the span. Over rewrap-local [0.02, 0.22] the sky
 *  and the stars ramp to nothing WHILE the backdrop is blended to the rewrap
 *  stage's own tint (scene.setSkyDim), so the unmount at the span's edge —
 *  which swaps a three-rendered background for the page's CSS one — happens
 *  between two frames of the same color. It ends well before EXIT_END: the sky
 *  must be gone by the time the fly hands the camera back, not at that moment.
 *  1 through the whole dive and both sky scenes; 0 from rewrap-local 0.22 on. */
export const skyOutAt = (p: number) =>
  1 - smoothstep(atFrac(rwR, 0.02), atFrac(rwR, 0.22), p);

/** Dive progress: the flythrough scene scrubs the dive; the two sky scenes
 *  hold its end frame. */
export const flyDiveP = (p: number) =>
  clamp01((p - flyR.p0) / (flyR.p1 - flyR.p0));

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

export function createStoryFly(scene: SceneHandle): {
  frame(p: number): void;
  warm(): Promise<void>;
} {
  let active = false;
  let warmed = false;
  /** whether the camera override is currently ours — the latch that pairs the
   *  pose release with the blend reaching 0 (see frame). */
  let posed = false;
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

  function enter() {
    // The spans come off the CPU geometry in its rest pose, so a measurement
    // taken with a mechanism mid-move would place the elements wrong for the
    // whole dive. The story's zoom/explode/assemble are all home on the way IN,
    // but an upward re-entry from rewrap arrives with assemble/explode mid-move
    // — so a good measurement is kept for the life of the page and a bad one
    // (deep link into the span) is used for its own activation only, then
    // replaced by the first activation that does catch the mechanism at rest.
    if (!passageAtRest) {
      const atRest =
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
    scene.setShading(FLY.shading);
    // AFTER setShading, which re-materials every mesh and would stomp the swap
    // (core/scene setGlassTransmissive documents the hazard).
    scene.setGlassTransmissive(true, GLASS_SPANS);
    scene.setGlassFade(1);
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

  function exit() {
    // Per-element fades back to 1 BY ID: applyGlassElementFade only writes the
    // ids it is handed, so an empty record restores nothing — and the write is
    // a no-op once the swap is off, hence before setGlassTransmissive(false).
    for (const id of Object.keys(GLASS_SPANS)) fades[id] = 1;
    scene.setGlassElementFade(fades);
    // BEFORE the ink restore: the original element materials must be back on
    // the meshes before the story's look is re-applied over them.
    scene.setGlassTransmissive(false);
    scene.setShading("ink");
    scene.setDust(true);
    scene.setRoomLight(1);
    scene.setGlassGlint(1);
    uSkyMix.value = 0;
    uStarMix.value = 0;
    uWormhole.value = 0;
    uStreak.value = 0;
    uStarStreak.value = 0;
    uStarRing.value = 0;
    // BEFORE the unmount, which is what makes it land: setSkyDim is a no-op on
    // an unmounted starfield, so a dim left on here would still be on the
    // backdrop the NEXT mount puts up (a scrub back into the dive would open on
    // a rewrap-colored sky).
    scene.setSkyDim(0, rewrapBg);
    void scene.enableStarfield(false);
    void scene.enableWormholePost(false);
    // NOT the camera: the blend outlives the span at BOTH edges now (it is
    // whole through the internals tail below and still unwinding above), and
    // frame() releases the pose when the blend itself reaches 0. A release
    // here would snap the camera back mid-hand-over.
  }

  return {
    warm,
    frame(p) {
      const mix = flyMixAt(p);
      const pFly = flyDiveP(p);
      // THE POSE, through the interior remap (FLY.insideRate) — held at the
      // dive's first pose for the whole hand-over, since flyDiveP is 0 until
      // the span opens.
      const pose = flyPose(travelRemap(pFly, FLY.pInside, FLY.insideRate));
      // THE CAMERA, ON ITS OWN GATE (flyMixAt): the hand-over runs through the
      // internals tail, where none of the dive's side effects may fire, and is
      // complete at the span's first frame. Nothing in this branch mounts or
      // swaps anything — it is one pose write and the release that pairs with
      // it, which is why it is safe outside the span.
      if (mix > 0) {
        scene.setStoryFlyPose(pose, mix);
        posed = true;
      } else if (posed) {
        posed = false;
        scene.setStoryFlyPose(null);
      }
      // THE SIDE EFFECTS, on the SPAN's own edges — the camera above is no
      // longer what opens them.
      if (!active && p >= flyR.p0 && p <= EXIT_END) {
        active = true;
        enter();
      }
      if (!active) return;
      if (p < flyR.p0 - HYST || p > EXIT_END + HYST) {
        active = false;
        exit();
        return;
      }
      // Value AND target on both channels: the driver's own per-frame writes
      // land before this call, and tick()'s ease would otherwise chase them.
      const a = flyApertureAt(pFly);
      scene.state.aperture = a;
      scene.state.apertureTarget = a;
      // the dial focusing the new world: the rack runs once the front element
      // is behind us, so the star world resolves while the camera is already
      // facing nothing but open sky
      const f = smoothstep(FLY.pFocus[0], FLY.pFocus[1], pFly);
      scene.state.focus = f;
      scene.state.focusTarget = f;
      // NO STARS BEFORE THE DIVE: the sky comes up as the camera reaches the
      // mount. One window, written to both sky paths' fade uniforms — only the
      // starfield ever mounts on the story path, and branching here would put a
      // dead check in the per-frame path.
      // …AND ONE WINDOW BACK OUT (skyOutAt), composed here rather than written
      // by a second owner: these two uniforms are this module's, every active
      // frame, so the reveal's fade can only be a factor on that write.
      const skyIn = smoothstep(FLY.pSkyIn[0], FLY.pSkyIn[1], pFly);
      const out = skyOutAt(p);
      uSkyMix.value = skyIn * out;
      uStarMix.value = skyIn * out;
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
      const dark = smoothstep(FLY.pDark[0], FLY.pDark[1], pFly) * out;
      scene.setRoomLight(lerp(1, FLY.darkFloor, dark));
      scene.setGlassGlint(lerp(1, FLY.glintFloor, dark));
      // the frame pinches toward the exit axis and the stars draw out into
      // lines; the ring rides the WORMHOLE's ramp, not the streak's
      uWormhole.value = arc(FLY.pWormhole, pFly);
      const streak = arc(FLY.pStreak, pFly);
      uStreak.value = streak;
      uStarStreak.value = streak;
      uStarRing.value = arc(FLY.pWormhole, pFly);
      // …and each element goes down as the camera arrives at it (the pose is
      // this frame's, taken above) — from inside an element three's
      // screen-space transmission blows up, so the camera must never be inside
      // visible glass.
      const camX = poseCamX(pose);
      for (const e of passage)
        fades[e.id] = passageFade(camX, e.x0, FLY.passageLead, FLY.passageFade);
      scene.setGlassElementFade(fades);
    },
  };
}
