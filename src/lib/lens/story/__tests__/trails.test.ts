import { describe, expect, it } from "vitest";
import { REVEAL_END, SKY_OUT_END, atFrac, rangeOf } from "../story";
import { SKY, dirOf } from "../../optics/sky";
import { SKY_SPIN_AXIS, rodrigues, starRho } from "../../optics/starfield";
import {
  TRAIL_LOOK,
  TRAIL_SWEEP_MAX,
  TRAIL_TAIL_FRACTION,
  buildTrailArcs,
  trailDirAt,
} from "../../optics/star-trails";
import { CROWN_LOOK, crownPointAt } from "../../optics/crown-arc";
import {
  AMBIENT_DECAY,
  AMBIENT_MAX,
  AMBIENT_SPIN_RATE,
  CROWN_P1,
  ENV_END,
  SPAN_P0,
  SPAN_P1,
  crownEnvAt,
  crownLiveAt,
  crownResolveAt,
  trailEnvAt,
  trailSweepAt,
} from "../trails";
// the span's own edge, imported rather than copied: the crown's whole reason
// for hanging on the scene root is that it outlives the sky's unmount — and
// the reveal/sky ramps, for the hand-over overlap law below
import { EXIT_END, flyRevealAt, skyOutAt } from "../fly";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");

const unit = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
const angleTo = (a: readonly number[], b: readonly number[]) =>
  Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

describe("the sky's spin", () => {
  it("the pole is a unit direction ON the view axis", () => {
    // STRUCTURE CHANGE, OWNER-DIRECTED: this used to pin the pole 0.42 rad BELOW
    // the axis. A rectilinear camera projects a cone about its own axis to a
    // circle and a cone about any other axis to a conic section, and at fov 70
    // the tilt was visible — owner, off a screenshot: "it's not a perfect
    // circle. Is it due to the camera fov?" It was. The pole is on the axis now,
    // and every trail is a true circle concentric with the frame's centre.
    expect(unit(SKY_SPIN_AXIS)).toBeCloseTo(1, 12);
    // the held fly pose looks down world +X, so the axis IS the pole
    expect(angleTo(SKY_SPIN_AXIS, [1, 0, 0])).toBeCloseTo(0, 6);
    // exactly zero, both of them — `Math.abs` only because −sin(0) is −0, which
    // is 0 in every arithmetic that reads it and not in `Object.is`
    expect(Math.abs(SKY_SPIN_AXIS[1])).toBe(0);
    expect(Math.abs(SKY_SPIN_AXIS[2])).toBe(0);
  });

  it("keeps every star at a FIXED angle off the view axis — the circle law", () => {
    // what makes a trail a circle on screen: the spin cannot change a star's
    // angle to the pole, and the pole is the camera's own axis, so a star sweeps
    // a cone about the view direction and the projection of that is a circle
    // centred on the frame's centre at any fov.
    for (const [az, alt] of [
      [0.3, 0.2],
      [-1.1, -0.5],
      [2.6, 0.9],
    ] as [number, number][]) {
      const d = dirOf(az, alt);
      const g0 = angleTo(d, [1, 0, 0]);
      for (const th of [0.4, 1.6, TRAIL_SWEEP_MAX])
        expect(angleTo(rodrigues(d, SKY_SPIN_AXIS, th), [1, 0, 0])).toBeCloseTo(
          g0,
          10,
        );
    }
  });

  it("rotates nothing at all at angle 0 — bit-exact", () => {
    for (const d of [
      [1, 0, 0],
      [0, 1, 0],
      [0.3, -0.5, 0.81],
    ] as [number, number, number][]) {
      // toBe, not toBeCloseTo: the identity is exact in floating point (cos 0 is
      // 1 and sin 0 is 0), which is what lets the dive render unchanged.
      expect(rodrigues(d, SKY_SPIN_AXIS, 0)).toEqual(d);
    }
  });

  it("is a real rotation: the known quarter turn, and length preserved", () => {
    const q = rodrigues([1, 0, 0], [0, 0, 1], Math.PI / 2);
    expect(q[0]).toBeCloseTo(0, 12);
    expect(q[1]).toBeCloseTo(1, 12);
    expect(q[2]).toBeCloseTo(0, 12);
    // about its own axis, nothing moves
    // (acos loses half its digits next to 1, hence the loose tolerance on an
    // angle that is exactly 0 in exact arithmetic)
    const onAxis = rodrigues([...SKY_SPIN_AXIS], SKY_SPIN_AXIS, 1.1);
    expect(angleTo(onAxis, SKY_SPIN_AXIS)).toBeCloseTo(0, 6);
    // and every angle keeps the vector on the sphere
    for (const ang of [0.1, 0.55, 2.0, -0.7])
      expect(
        unit(rodrigues([0.3, -0.5, 0.81], SKY_SPIN_AXIS, ang)),
      ).toBeCloseTo(unit([0.3, -0.5, 0.81]), 12);
  });
});

describe("the trail arc law", () => {
  const d = dirOf(0.2, -0.1);

  it("the head is the star: s = 0 is the CURRENT direction, exactly", () => {
    for (const theta of [0, 0.2, TRAIL_SWEEP_MAX]) {
      // this is the heads-glued law: story/trails.ts hands `uSkySpin` and the
      // sweep ONE θ, and at s = 0 the arc's backward rotation is zero — so the
      // head is bit-for-bit where optics/starfield.ts draws the disc.
      expect(trailDirAt(d, theta, theta, 0)).toEqual(
        rodrigues(d, SKY_SPIN_AXIS, theta),
      );
    }
  });

  it("the tail is where the turn started: s = 1 is the UNROTATED direction", () => {
    expect(TRAIL_TAIL_FRACTION).toBe(1);
    for (const theta of [0.1, 0.3, TRAIL_SWEEP_MAX]) {
      const tail = trailDirAt(d, theta, theta, 1);
      expect(tail[0]).toBeCloseTo(d[0], 12);
      expect(tail[1]).toBeCloseTo(d[1], 12);
      expect(tail[2]).toBeCloseTo(d[2], 12);
    }
  });

  it("sweeps monotonically backward along the arc", () => {
    const theta = TRAIL_SWEEP_MAX;
    let prev = 0;
    for (let i = 1; i <= TRAIL_LOOK.segments; i++) {
      const a = angleTo(
        trailDirAt(d, theta, theta, i / TRAIL_LOOK.segments),
        trailDirAt(d, theta, theta, 0),
      );
      expect(a).toBeGreaterThan(prev);
      prev = a;
    }
  });

  it("draws nothing anywhere when the sky has not turned", () => {
    for (const s of [0, 0.5, 1]) expect(trailDirAt(d, 0, 0, s)).toEqual(d);
  });
});

describe("the arcs", () => {
  const arcs = buildTrailArcs(SKY.stars);

  it("gives EVERY star an arc, in catalog order, all unit directions", () => {
    // OWNER-DIRECTED: this used to be a cut — the 90 brightest inside a 60°
    // cone — and the cut is what the owner read off the screen ("we're missing
    // some stars that start at the bottom left so the right sides are more trail
    // heavy"). There is no selection left to be lopsided.
    expect(arcs.length).toBe(SKY.stars.length);
    for (const a of arcs) expect(unit(a.dir)).toBeCloseTo(1, 10);
    for (const [i, a] of arcs.entries()) {
      const s = SKY.stars[i];
      expect(a.dir, `arc ${i} is star ${i}`).toEqual(dirOf(s.az, s.alt));
      expect(a.tint, `arc ${i} tint`).toBe(s.tint);
    }
  });

  it("carries its own star's ink, and is never sub-pixel thin", () => {
    for (const [i, a] of arcs.entries()) {
      const s = SKY.stars[i];
      expect(a.half, `arc ${i} half`).toBeGreaterThanOrEqual(
        TRAIL_LOOK.minHalfRad,
      );
      expect(a.ink, `arc ${i} ink`).toBeGreaterThan(0);
      // an arc can only ever be as bright as its star: the floor's compensation
      // is a dimming, never a gain
      expect(a.ink, `arc ${i} ink`).toBeLessThanOrEqual(s.ink ?? 1);
    }
    // an authored star above the floor: the honest 0.8 of its disc radius, at
    // its star's full ink
    const bright = arcs[3]; // the catalog's brightest, mag 3.1
    expect(SKY.stars[3].mag).toBe(3.1);
    expect(bright.half).toBeCloseTo(TRAIL_LOOK.widthK * starRho(3.1), 12);
    expect(bright.ink).toBe(1);
    // …and a BACKDROP star is faint BY ITS STAR, which is the whole ink
    // hierarchy now that nothing fades along an arc: the catalog's exponential
    // brightness law (optics/sky.ts BRIGHTNESS_LAW) is the only thing setting
    // how heavy the sky of 180° arcs reads.
    const faintStar = SKY.stars.reduce((a, b) => (b.mag < a.mag ? b : a));
    const faintInk = faintStar.ink ?? 1;
    expect(faintInk).toBeLessThan(0.4);
    const dim = buildTrailArcs([faintStar])[0];
    expect(dim.ink).toBeLessThan(faintInk);
    // a floored arc pays for the width in ink: half × ink is the honest width
    expect(dim.half).toBe(TRAIL_LOOK.minHalfRad);
    expect(dim.half * (dim.ink / faintInk)).toBeCloseTo(
      TRAIL_LOOK.widthK * starRho(faintStar.mag),
      12,
    );
    expect(dim.half * dim.ink).toBeLessThan(TRAIL_LOOK.minHalfRad);
    // THE SPREAD, over the whole catalog: a handful of bright arcs over an
    // exponentially growing mass of faint ones — 16 of the 795 at ≥ 0.9 of full
    // ink, 53 at ≥ 0.6 and 493 at ≥ 0.2, median 0.24. That is the fix for a
    // full-sweep frame the owner read as a uniform rope-field.
    const at = (t: number) => arcs.filter((a) => a.ink >= t).length;
    expect(at(0.9)).toBeLessThan(arcs.length * 0.04);
    expect(at(0.6)).toBeLessThan(arcs.length * 0.1);
    expect(at(0.6)).toBeGreaterThan(at(0.9) * 2);
    expect(at(0.3)).toBeGreaterThan(at(0.6) * 4);
  });
});

describe("the crown arc", () => {
  const trail = CROWN_LOOK.trail;
  const lens = CROWN_LOOK.lens;

  it("draws a circle: every point of the arc is one radius from the centre", () => {
    for (const c of [trail, lens])
      for (const s of [0, 0.25, 0.5, 0.75, 1]) {
        const [x, y] = crownPointAt(c, CROWN_LOOK.phi0, CROWN_LOOK.span, s);
        expect(Math.hypot(x - c.cx, y - c.cy)).toBeCloseTo(c.r, 12);
      }
  });

  it("sweeps BACKWARD from the head, like a trail", () => {
    // s = 0 is the head and sits exactly at phi0; the tail is span radians back
    const head = crownPointAt(trail, CROWN_LOOK.phi0, CROWN_LOOK.span, 0);
    expect(head[0]).toBeCloseTo(
      trail.cx + trail.r * Math.cos(CROWN_LOOK.phi0),
      12,
    );
    const ang = (s: number) =>
      Math.atan2(
        crownPointAt(trail, CROWN_LOOK.phi0, CROWN_LOOK.span, s)[1] - trail.cy,
        crownPointAt(trail, CROWN_LOOK.phi0, CROWN_LOOK.span, s)[0] - trail.cx,
      );
    let prev = ang(0);
    for (let i = 1; i <= 8; i++) {
      const a = ang(i / 8);
      expect(a).toBeLessThan(prev);
      prev = a;
    }
  });

  it("is a zero-length mark before the sky has turned", () => {
    // the head rides the spin and the arc IS the history behind it, so at
    // sweep 0 the whole strip collapses onto one point — nothing to see, which
    // is what makes a scrub back into the dive bit-for-bit unchanged
    const a = crownPointAt(trail, CROWN_LOOK.phi0, 0, 0);
    const b = crownPointAt(trail, CROWN_LOOK.phi0, 0, 1);
    expect(a).toEqual(b);
  });

  it("resolves from one of the family to a tight arc on the element", () => {
    // WHILE IT IS A TRAIL it must be one: the pole is on the view axis, so every
    // star's arc is a circle about the FRAME'S CENTRE and the crown's has to be
    // centred there too or it reads as the odd one out.
    expect(trail.cx).toBe(0);
    expect(trail.cy).toBe(0);
    // …and the landing circle is a different circle: much TIGHTER, which is now
    // the whole of the resolve's visible move. It is CONCENTRIC with the family
    // (the reveal is shot straight down the optical axis and the element sits on
    // that axis — story/story.ts REVEAL_END holds the camera there), so the arc
    // tightens onto the element instead of walking off to find it. What still
    // disqualifies it from being a real trail is that a trail's radius is fixed
    // by its star: it can neither shrink to this nor grow and walk away from it
    // afterwards, which is what the live tracking does from 0.14 on.
    expect(trail.r).toBeGreaterThan(lens.r * 3);
    expect(lens.cx).toBe(trail.cx);
    expect(lens.cy).toBe(trail.cy);
    // and the crown's own arc, centred on phi0, opens UPWARD (screen +y is down)
    const mid = crownPointAt(
      lens,
      CROWN_LOOK.phi0 + CROWN_LOOK.span / 2,
      CROWN_LOOK.span,
      0.5,
    );
    expect(mid[1]).toBeCloseTo(lens.cy - lens.r, 12);
    expect(mid[0]).toBeCloseTo(lens.cx, 12);
    // …and stops short of closing into a ring
    expect(CROWN_LOOK.span).toBeLessThan(Math.PI);
  });

  // IT RESOLVES WITH THE FIELD, NOT AHEAD OF IT — at BOTH edges. The crown must
  // be one of the trails for the whole of the scene (the resolve is the beat
  // where the field goes out and this one arc does something else instead, so it
  // may not start before `trailEnvAt` starts falling, rewrap-local 0.02), and it
  // must not be finished and parked while the field is still most of the way
  // there. The far edge is PROPORTIONAL: 0.75 of the fade's own span, which is
  // where it sat when the fade ran [0.02, 0.18] and the resolve [0.02, 0.14].
  it("stays a trail until the field starts to go, then resolves with it", () => {
    expect(crownResolveAt(tR.p0)).toBe(0);
    expect(crownResolveAt(atFrac(tR, 0.6))).toBe(0);
    expect(crownResolveAt(atFrac(tR, 0.9))).toBe(0);
    expect(crownResolveAt(tR.p1)).toBe(0);
    // not one frame of it runs while the field is still whole
    expect(crownResolveAt(atFrac(rwR, 0.02))).toBe(0);
    expect(trailEnvAt(atFrac(rwR, 0.02))).toBeCloseTo(1, 12);
    // …then it travels while the field fades under it…
    const mid = crownResolveAt(atFrac(rwR, 0.08));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(trailEnvAt(atFrac(rwR, 0.08))).toBeGreaterThan(0);
    // …still travelling where the field is only half gone — the far edge rides
    // the fade rather than sitting at a fixed 0.14 (measured: 0.5576 of the
    // field's ink left there, and it was DONE at 0.14 before this was re-timed)
    expect(crownResolveAt(atFrac(rwR, 0.14))).toBeLessThan(1);
    expect(trailEnvAt(atFrac(rwR, 0.14))).toBeGreaterThan(0.5);
    // …and lands at 0.75 of the fade's span, inside the live hand-off's own far
    // edge (0.22), with the field down to a sixth of its ink
    // built from the FADE's own edges (0.02 → the imported ENV_END), so a
    // retune of the field's exit in EITHER direction fails here instead of
    // quietly decoupling the two
    const fadeFoot = atFrac(rwR, 0.02);
    const far = fadeFoot + 0.75 * (ENV_END - fadeFoot);
    expect(crownResolveAt(far)).toBeCloseTo(1, 12);
    expect(far).toBeLessThan(atFrac(rwR, 0.22));
    expect(trailEnvAt(far)).toBeLessThan(0.2);
    expect(crownResolveAt(atFrac(rwR, 0.3))).toBeCloseTo(1, 12);
    // scrub back below the start and it is a trail again, exactly
    expect(crownResolveAt(rangeOf("constellations").p1)).toBe(0);
  });

  it("holds still until the lens is drawn, then follows it", () => {
    // nothing of the hand-over may run while there is nothing to follow: the
    // element is behind the camera through the sky chapter and fully faded glass
    // until story/fly.ts's reveal restores it — which is why this starts at 0.14
    // (where CROWN_LOOK.lens was measured), not at the span's edge. The resolve
    // above is still travelling onto that same circle when it does; both are
    // lerps toward one target, so they compose without a fight.
    expect(crownLiveAt(tR.p1)).toBe(0);
    expect(crownLiveAt(atFrac(rwR, 0.14))).toBe(0);
    // …and it is following well before the crown starts to go, so the whole of
    // the fade is spent tracking rather than travelling
    expect(crownLiveAt(atFrac(rwR, 0.22))).toBeCloseTo(1, 12);
    expect(crownLiveAt(atFrac(rwR, 0.3))).toBeCloseTo(1, 12);
    expect(crownEnvAt(atFrac(rwR, 0.3))).toBeGreaterThan(0.9);
  });

  it("outlives the field, and the sky it was drawn on", () => {
    // it arrives with the trails…
    expect(crownEnvAt(tR.p0)).toBe(0);
    expect(crownEnvAt(atFrac(tR, 0.12))).toBeCloseTo(1, 12);
    expect(crownEnvAt(atFrac(tR, 0.12))).toBeCloseTo(
      trailEnvAt(atFrac(tR, 0.12)),
      12,
    );
    // …holds at full where the last trail is already gone…
    expect(trailEnvAt(atFrac(rwR, 0.3))).toBe(0);
    expect(crownEnvAt(atFrac(rwR, 0.3))).toBeCloseTo(1, 12);
    // …is still whole where the front element is drawn again (the reveal, up by
    // rewrap 0.16) and past the frame the sky's own fade lands on zero
    // (SKY_OUT_END, rewrap 0.32 — the crown's fall foot sits at 0.34, just
    // clear of it, so "alone" survived the widened hand-over): this is why the
    // crown hangs on the SCENE ROOT and not the sky. (It does not outlive the
    // SPAN's unmount edge — EXIT_END sits out at 0.58 for the de-stacked fov
    // hand-back, past the crown's own 0.48 fall — but the unmount tears down
    // an invisible starfield, and the law was always about the VISIBLE sky.)
    expect(crownEnvAt(SKY_OUT_END)).toBeCloseTo(1, 12);
    expect(crownEnvAt(atFrac(rwR, 0.4))).toBeGreaterThan(0);
    expect(EXIT_END).toBeGreaterThan(atFrac(rwR, 0.48)); // the new order, stated
    expect(crownEnvAt(atFrac(rwR, 0.48))).toBe(0);
    expect(crownEnvAt(rangeOf("capsOn").p0)).toBe(0);
    expect(crownEnvAt(rangeOf("flythrough").p0)).toBe(0);
  });
});

describe("the trails driver's laws", () => {
  it("the sweep holds at zero until local 0.25, then runs to the max at SKY_OUT_END", () => {
    // the owner's ask, coarsely: the chapter turns the sky AROUND half a
    // revolution ("around a 180deg revolution"). A range, not a pin — the exact
    // sweep is a look value and the suite must not hold look values still.
    expect(TRAIL_SWEEP_MAX).toBeGreaterThan(2.6);
    expect(TRAIL_SWEEP_MAX).toBeLessThan(3.7);
    expect(trailSweepAt(tR.p0)).toBe(0);
    expect(trailSweepAt(tR.p0 - 0.05)).toBe(0);
    expect(trailSweepAt(rangeOf("constellations").p1)).toBe(0);
    // THE INK GOES FIRST: story/constellations.ts anchors its strokes and names
    // to UNROTATED directions and fades them over trails-local [0, 0.25], so
    // nothing may turn while they are still legible. The turn's foot is that
    // window's far EDGE, so the field is exactly still for the whole of the
    // fall — no overlap to reason about at a half-revolution sweep, where a
    // couple of percent of local scroll is already several pixels of drag.
    //
    // f = 0.25 is a KNIFE EDGE: it is exactly the law's foot, and the equality
    // holds only while story/reveal.ts spells TURN_P0 as `atFrac(tR, 0.25)` —
    // the same expression, so the two agree bit for bit. Move the turn's start
    // and this case moves with it.
    for (const f of [0.05, 0.1, 0.2, 0.22, 0.25])
      expect(trailSweepAt(atFrac(tR, f)), `trails-local ${f}`).toBe(0);
    // …and it is NOT over inside this scene any more (see the case below): the
    // whole turn lands on SKY_OUT_END — the frame the last of the sky is gone
    // (story/reveal.ts TURN_P1), which the fluid-transition correction moved
    // PAST the reveal's end, so the sky is still mid-turn over the collapse.
    expect(trailSweepAt(atFrac(tR, 0.9))).toBeLessThan(TRAIL_SWEEP_MAX * 0.75);
    expect(trailSweepAt(tR.p1)).toBeLessThan(TRAIL_SWEEP_MAX * 0.85);
    expect(trailSweepAt(REVEAL_END)).toBeLessThan(TRAIL_SWEEP_MAX);
    expect(trailSweepAt(SKY_OUT_END)).toBeCloseTo(TRAIL_SWEEP_MAX, 12);
    expect(trailSweepAt(atFrac(rwR, 0.5))).toBeCloseTo(TRAIL_SWEEP_MAX, 12);
  });

  it("the sweep is monotone across the scene", () => {
    let prev = -1;
    for (let i = 0; i <= 40; i++) {
      const v = trailSweepAt(atFrac(tR, i / 40));
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(trailSweepAt(atFrac(tR, 0.5))).toBeGreaterThan(0);
    expect(trailSweepAt(atFrac(tR, 0.5))).toBeLessThan(TRAIL_SWEEP_MAX);
  });

  it("the sky is STILL TURNING when the last arc goes out", () => {
    // OWNER-DIRECTED, and the reverse of what this case used to pin ("the turn
    // is over before the arcs start to fade"): the sweep used to saturate at
    // trails-local 0.9, so the crossfade into the reveal played over a sky that
    // had already stopped — "have the trails continue spinning during the
    // transition". The turn now holds its cruising rate past the envelope's own
    // end, and the reveal's rotation is handed the same law (story/reveal.ts).
    const end = atFrac(rwR, 0.28); // where trailEnvAt reaches 0
    expect(trailEnvAt(end)).toBe(0);
    const rate = (p: number) =>
      (trailSweepAt(p + 1e-5) - trailSweepAt(p)) / 1e-5;
    // still moving as the arcs vanish, and at a real fraction of the rate it
    // held mid-scene — not a smoothstep's dying foot
    expect(rate(end)).toBeGreaterThan(0.8 * rate(atFrac(tR, 0.6)));
  });

  // THE HAND-OVER IS LONG — the owner's fluid-transition correction ("for the
  // trail to reassemble there should be a longer transition with the spinning…
  // if we scroll fast it will look very off"). The old windows concentrated
  // the whole identity exchange into rewrap-local [0.06, 0.18]; these pins
  // hold the widened overlap open so it cannot silently shrink back.
  it("keeps BOTH figures on screen across a long shared stretch", () => {
    // the frame the shell finishes drawing, the arcs are still REAL ink — a
    // third of their strength at least, not a dying epsilon…
    const top = atFrac(rwR, 0.16);
    expect(flyRevealAt(top)).toBe(1);
    expect(trailEnvAt(top)).toBeGreaterThan(1 / 3);
    // …and they are still VISIBLE ink — not a dying epsilon — a twentieth of
    // the scene beyond it, with the fully drawn shell turning under them
    // (measured 0.2258 at 0.20; the envelope runs out at 0.28)
    expect(trailEnvAt(atFrac(rwR, 0.2))).toBeGreaterThan(0.15);
    // the sky itself outlives the whole collapse (REVEAL_END inside its fade),
    // so the pieces never seat onto an already-empty stage…
    expect(skyOutAt(REVEAL_END)).toBeGreaterThan(0);
    // …and the sweep is a cruise, not a stall, for every frame an arc is drawn
    // (TURN_P1 = SKY_OUT_END, pinned in reveal.test.ts — restated here as the
    // consumer-side fact: the arcs' far edge sits strictly inside the turn)
    expect(atFrac(rwR, 0.28)).toBeLessThan(SKY_OUT_END);
  });

  it("the envelope rises inside trails and dies into the reveal", () => {
    expect(trailEnvAt(tR.p0)).toBe(0);
    expect(trailEnvAt(atFrac(tR, 0.02))).toBe(0);
    expect(trailEnvAt(atFrac(tR, 0.12))).toBeCloseTo(1, 12);
    expect(trailEnvAt(atFrac(tR, 0.9))).toBeCloseTo(1, 12);
    // holds through the top of rewrap — the sky is still up there
    expect(trailEnvAt(rwR.p0)).toBeCloseTo(1, 12);
    expect(trailEnvAt(atFrac(rwR, 0.02))).toBeCloseTo(1, 12);
    // …still ALIVE over the reveal's top and the collapse (the fluid
    // hand-over: the crossfade saturates at 0.16, the arcs run to 0.28)…
    expect(trailEnvAt(atFrac(rwR, 0.18))).toBeGreaterThan(0);
    // …and out BEFORE the star discs' own fade lands (SKY_OUT_END, 0.32 —
    // arcs die into a sky that is still there, never onto an empty stage) and
    // long before the span's unmount (EXIT_END), which would cut them mid-ink
    expect(trailEnvAt(atFrac(rwR, 0.28))).toBe(0);
    expect(skyOutAt(atFrac(rwR, 0.28))).toBeGreaterThan(0);
    expect(trailEnvAt(atFrac(rwR, 0.5))).toBe(0);
    expect(trailEnvAt(rangeOf("capsOn").p0)).toBe(0);
    // and it is 0 everywhere before the chapter, including the whole dive
    expect(trailEnvAt(rangeOf("flythrough").p0)).toBe(0);
    expect(trailEnvAt(atFrac(rangeOf("constellations"), 0.5))).toBe(0);
  });

  it("the drift is small next to the scrolled sweep, and given back faster", () => {
    // ten seconds parked adds well under a fifth of the turn
    expect(AMBIENT_SPIN_RATE * 10).toBeLessThan(TRAIL_SWEEP_MAX * 0.25);
    expect(AMBIENT_DECAY).toBeGreaterThan(AMBIENT_SPIN_RATE);
  });

  it("the drift is capped, and the cap unwinds in a few seconds", () => {
    // a tab parked in the scene forever cannot wind the sky up without limit
    expect(AMBIENT_MAX).toBeGreaterThan(0);
    expect(AMBIENT_MAX).toBeLessThan(TRAIL_SWEEP_MAX);
    // …and the drift cannot turn the half revolution the scene promises into a
    // visibly longer one. HELD IN ABSOLUTE ANGLE, exactly as story/trails.ts
    // documents it: 0.25 rad is ~14°, a drift on top of a turn rather than a
    // second turn.
    expect(AMBIENT_MAX).toBeLessThan(0.25);
    // the unwind from a full cap is short enough to finish inside a scrub
    expect(AMBIENT_MAX / AMBIENT_DECAY).toBeLessThan(5);
  });
});

describe("the arcs' and the crown's attach windows", () => {
  // Newly EXPORTED for story/cost.ts's overlay columns — a draw call each, and
  // it may not re-spell either window. Pinned here, where they are owned.

  it("pads the driven span at both ends", () => {
    expect(SPAN_P0).toBeLessThan(tR.p0);
    expect(SPAN_P1).toBeGreaterThan(ENV_END);
    // the same pad on each edge, and small enough that a scrub cannot park
    // outside the span while the envelope is still nonzero
    expect(tR.p0 - SPAN_P0).toBeCloseTo(SPAN_P1 - ENV_END, 12);
    expect(trailEnvAt(SPAN_P0)).toBe(0);
    expect(trailEnvAt(SPAN_P1)).toBe(0);
  });

  it("keeps the crown attached long after the arcs have gone", () => {
    // the crown hangs on the SCENE ROOT precisely so it outlives the sky — it
    // resolves onto the front element and fades out on it
    expect(CROWN_P1).toBeGreaterThan(SPAN_P1);
    expect(crownEnvAt(SPAN_P1)).toBeGreaterThan(0);
    expect(crownEnvAt(CROWN_P1)).toBe(0);
    // …and it outlives even the fly span, which is the whole reason it hangs on
    // the scene root rather than on the starfield: the sky unmounts under it
    expect(CROWN_P1).toBeGreaterThan(EXIT_END);
  });
});
