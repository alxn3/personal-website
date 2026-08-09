import { describe, expect, it } from "vitest";
import { atFrac, rangeOf } from "../story";
import { SKY, dirOf } from "../../optics/sky";
import { SKY_SPIN_AXIS, rodrigues, starRho } from "../../optics/starfield";
import {
  TRAIL_LOOK,
  TRAIL_SWEEP_MAX,
  TRAIL_TAIL_FRACTION,
  buildTrailArcs,
  pickTrailStars,
  trailDirAt,
} from "../../optics/star-trails";
import { CROWN_LOOK, crownPointAt } from "../../optics/crown-arc";
import {
  AMBIENT_DECAY,
  AMBIENT_MAX,
  AMBIENT_SPIN_RATE,
  crownEnvAt,
  crownLiveAt,
  crownResolveAt,
  trailEnvAt,
  trailSweepAt,
} from "../trails";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");

const unit = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
const angleTo = (a: readonly number[], b: readonly number[]) =>
  Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

describe("the sky's spin", () => {
  it("the pole is a unit direction low in the frame", () => {
    expect(unit(SKY_SPIN_AXIS)).toBeCloseTo(1, 12);
    // the held fly pose looks down world +X with +Y up: negative Y is BELOW the
    // view axis, i.e. low on the screen
    expect(SKY_SPIN_AXIS[1]).toBeLessThan(0);
    expect(SKY_SPIN_AXIS[2]).toBe(0);
    expect(angleTo(SKY_SPIN_AXIS, [1, 0, 0])).toBeCloseTo(0.42, 6);
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

  it("turns a star by exactly the sweep, about the pole", () => {
    const d = dirOf(0.1, 0.2);
    const spun = rodrigues(d, SKY_SPIN_AXIS, TRAIL_SWEEP_MAX);
    // the angle to the pole is what a rotation about it cannot change
    expect(angleTo(spun, SKY_SPIN_AXIS)).toBeCloseTo(
      angleTo(d, SKY_SPIN_AXIS),
      12,
    );
    expect(angleTo(spun, d)).toBeGreaterThan(0.01);
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

describe("which stars get a trail", () => {
  const picks = pickTrailStars(SKY.stars);

  it("takes the brightest inside the visible cone, and no more", () => {
    expect(picks.length).toBe(TRAIL_LOOK.count);
    const cos = Math.cos(TRAIL_LOOK.coneRad);
    for (const i of picks)
      expect(
        dirOf(SKY.stars[i].az, SKY.stars[i].alt)[0],
      ).toBeGreaterThanOrEqual(cos);
    // brightest first, ties by index — deterministic from the catalog alone
    for (let k = 1; k < picks.length; k++)
      expect(SKY.stars[picks[k]].mag).toBeLessThanOrEqual(
        SKY.stars[picks[k - 1]].mag,
      );
    // nothing left out in the cone is brighter than the faintest pick
    const faintest = SKY.stars[picks[picks.length - 1]].mag;
    const taken = new Set(picks);
    for (let i = 0; i < SKY.stars.length; i++) {
      if (taken.has(i)) continue;
      if (dirOf(SKY.stars[i].az, SKY.stars[i].alt)[0] < cos) continue;
      expect(SKY.stars[i].mag).toBeLessThanOrEqual(faintest);
    }
  });

  it("is stable across calls", () => {
    expect(pickTrailStars(SKY.stars)).toEqual(picks);
  });
});

describe("the arcs", () => {
  const arcs = buildTrailArcs(SKY.stars, pickTrailStars(SKY.stars));

  it("is exactly one arc per star, all unit directions", () => {
    // the crown is NOT in here any more — it is authored screen ink
    // (optics/crown-arc.ts), not a trail of the sky's own
    expect(arcs.length).toBe(TRAIL_LOOK.count);
    for (const a of arcs) expect(unit(a.dir)).toBeCloseTo(1, 10);
  });

  it("stays under the star's own disc, and never sub-pixel thin", () => {
    for (let k = 0; k < TRAIL_LOOK.count; k++) {
      const a = arcs[k];
      expect(a.half).toBeGreaterThanOrEqual(TRAIL_LOOK.minHalfRad);
      expect(a.ink).toBeGreaterThan(0);
      expect(a.ink).toBeLessThanOrEqual(1);
    }
    // the brightest pick's arc is the honest 0.8 of its disc radius, undimmed
    const brightest = arcs[0];
    expect(brightest.half).toBeCloseTo(
      TRAIL_LOOK.widthK * starRho(SKY.stars[pickTrailStars(SKY.stars)[0]].mag),
      12,
    );
    expect(brightest.ink).toBe(1);
    // a floored arc pays for the width in ink: half × ink is the honest width
    const floored = arcs.find(
      (a, i) => i < TRAIL_LOOK.count && a.half === TRAIL_LOOK.minHalfRad,
    );
    expect(floored).toBeDefined();
    expect(floored!.half * floored!.ink).toBeLessThan(TRAIL_LOOK.minHalfRad);
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

  it("resolves from a wide low arc to a tight one at the frame's centre", () => {
    // the trail circle is centred well below the frame and is much the bigger
    expect(trail.cy).toBeGreaterThan(0.2);
    expect(lens.cy).toBeGreaterThan(-0.1);
    expect(lens.cy).toBeLessThan(0.1);
    expect(trail.r).toBeGreaterThan(lens.r * 2);
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

  it("resolves late, and is finished before the reveal begins", () => {
    expect(crownResolveAt(tR.p0)).toBe(0);
    expect(crownResolveAt(atFrac(tR, 0.5))).toBe(0);
    expect(crownResolveAt(atFrac(tR, 0.6))).toBe(0);
    expect(crownResolveAt(atFrac(tR, 0.8))).toBeGreaterThan(0);
    expect(crownResolveAt(atFrac(tR, 0.8))).toBeLessThan(1);
    expect(crownResolveAt(tR.p1)).toBeCloseTo(1, 12);
    expect(crownResolveAt(atFrac(rwR, 0.3))).toBeCloseTo(1, 12);
    // scrub back below the start and it is a trail again, exactly
    expect(crownResolveAt(rangeOf("constellations").p1)).toBe(0);
  });

  it("holds still until the lens is drawn, then follows it", () => {
    // nothing of the hand-over may run while there is nothing to follow: the
    // element is behind the camera through the resolve and invisible glass
    // after it, right up to story/fly.ts's hand-back at rewrap 0.25
    expect(crownLiveAt(tR.p1)).toBe(0);
    expect(crownLiveAt(atFrac(rwR, 0.25))).toBe(0);
    // …and it is following by the time the crown starts to go, so the whole of
    // the fade is spent tracking rather than travelling
    expect(crownLiveAt(atFrac(rwR, 0.32))).toBeCloseTo(1, 12);
    expect(crownEnvAt(atFrac(rwR, 0.32))).toBeGreaterThan(0.9);
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
    expect(trailEnvAt(atFrac(rwR, 0.2))).toBe(0);
    expect(crownEnvAt(atFrac(rwR, 0.2))).toBeCloseTo(1, 12);
    // …and past rewrap 0.25, where story/fly.ts unmounts the starfield AND the
    // front element is finally drawn again: this is why the crown hangs on the
    // SCENE ROOT and not on the sky. It is still whole there.
    expect(crownEnvAt(atFrac(rwR, 0.25))).toBeCloseTo(1, 12);
    expect(crownEnvAt(atFrac(rwR, 0.44))).toBe(0);
    expect(crownEnvAt(rangeOf("capsOn").p0)).toBe(0);
    expect(crownEnvAt(rangeOf("flythrough").p0)).toBe(0);
  });
});

describe("the trails driver's laws", () => {
  it("the sweep holds at zero until local 0.2, then saturates at the max", () => {
    expect(trailSweepAt(tR.p0)).toBe(0);
    expect(trailSweepAt(tR.p0 - 0.05)).toBe(0);
    expect(trailSweepAt(rangeOf("constellations").p1)).toBe(0);
    // THE INK GOES FIRST: story/constellations.ts anchors its strokes and names
    // to UNROTATED directions and fades them over trails-local [0, 0.25], so
    // nothing may turn while they are still legible.
    expect(trailSweepAt(atFrac(tR, 0.1))).toBe(0);
    expect(trailSweepAt(atFrac(tR, 0.2))).toBe(0);
    // and the smoothstep's flat foot covers the rest of the ink's fall: at
    // local 0.22, where the strokes are still at ~12%, the turn has moved the
    // outermost star (1.3 rad off the pole) by about one pixel
    expect(trailSweepAt(atFrac(tR, 0.22)) * 1.3).toBeLessThan(0.002);
    expect(trailSweepAt(atFrac(tR, 0.9))).toBeCloseTo(TRAIL_SWEEP_MAX, 12);
    expect(trailSweepAt(tR.p1)).toBeCloseTo(TRAIL_SWEEP_MAX, 12);
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

  it("the turn is over before the arcs start to fade", () => {
    // the sweep saturates at local 0.9, the envelope only starts falling at
    // rewrap 0.02 — so the last beat of the chapter is a fade, not a fade over
    // a move
    expect(atFrac(tR, 0.9)).toBeLessThan(atFrac(rwR, 0.02));
  });

  it("the envelope rises inside trails and dies into the reveal", () => {
    expect(trailEnvAt(tR.p0)).toBe(0);
    expect(trailEnvAt(atFrac(tR, 0.02))).toBe(0);
    expect(trailEnvAt(atFrac(tR, 0.12))).toBeCloseTo(1, 12);
    expect(trailEnvAt(atFrac(tR, 0.9))).toBeCloseTo(1, 12);
    // holds through the top of rewrap — the sky is still up there
    expect(trailEnvAt(rwR.p0)).toBeCloseTo(1, 12);
    expect(trailEnvAt(atFrac(rwR, 0.02))).toBeCloseTo(1, 12);
    expect(trailEnvAt(atFrac(rwR, 0.18))).toBe(0);
    expect(trailEnvAt(atFrac(rwR, 0.5))).toBe(0);
    expect(trailEnvAt(rangeOf("capsOn").p0)).toBe(0);
    // and it is 0 everywhere before the chapter, including the whole dive
    expect(trailEnvAt(rangeOf("flythrough").p0)).toBe(0);
    expect(trailEnvAt(atFrac(rangeOf("constellations"), 0.5))).toBe(0);
  });

  it("the envelope falls INSIDE the starfield's own life", () => {
    // story/fly.ts hands the camera back (and unmounts the sky) at rewrap 0.25:
    // the arcs must be gone before that, or the unmount cuts them off mid-ink
    expect(atFrac(rwR, 0.18)).toBeLessThan(atFrac(rwR, 0.25));
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
    // …and the total turn stays inside what the arcs are drawn for
    expect(TRAIL_SWEEP_MAX + AMBIENT_MAX).toBeLessThan(1);
    // the unwind from a full cap is short enough to finish inside a scrub
    expect(AMBIENT_MAX / AMBIENT_DECAY).toBeLessThan(5);
  });
});
