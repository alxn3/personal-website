import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { REVEAL_END, SKY_OUT_END, atFrac, rangeOf } from "../story";
import { SKY, dirOf } from "../../optics/sky";
import { SKY_SPIN_AXIS, rodrigues, starRho } from "../../optics/starfield";
import {
  TRAIL_LOOK,
  TRAIL_SWEEP_MAX,
  TRAIL_TAIL_FRACTION,
  buildTrailArcs,
  createStarTrails,
  trailDirAt,
} from "../../optics/star-trails";
import {
  AMBIENT_DECAY,
  AMBIENT_MAX,
  AMBIENT_SPIN_RATE,
  ENV_END,
  SPAN_P0,
  SPAN_P1,
  trailEnvAt,
  trailSweepAt,
} from "../trails";
import { flyRevealAt, skyOutAt } from "../fly";

const tR = rangeOf("trails");
const rwR = rangeOf("rewrap");

const unit = (v: readonly number[]) => Math.hypot(v[0], v[1], v[2]);
const angleTo = (a: readonly number[], b: readonly number[]) =>
  Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

describe("the sky's spin", () => {
  it("the pole is a unit direction ON the view axis", () => {
    // STRUCTURE CHANGE: this used to pin the pole 0.42 rad BELOW the axis. A
    // rectilinear camera projects a cone about its own axis to a circle and a
    // cone about any other axis to a conic section, and at fov 70 the tilt was
    // visible — the trails read as ellipses, not circles. The pole is on the
    // axis now, and every trail is a true circle concentric with the centre.
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
    // this used to be a cut — the 90 brightest inside a 60° cone — and the cut
    // is what read as lopsided on screen: stars missing from one corner left
    // the opposite side of the frame more trail-heavy. There is no selection
    // left to be lopsided.
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
    // full-sweep frame that used to read as a uniform rope-field.
    const at = (t: number) => arcs.filter((a) => a.ink >= t).length;
    expect(at(0.9)).toBeLessThan(arcs.length * 0.04);
    expect(at(0.6)).toBeLessThan(arcs.length * 0.1);
    expect(at(0.6)).toBeGreaterThan(at(0.9) * 2);
    expect(at(0.3)).toBeGreaterThan(at(0.6) * 4);
  });
});

describe("the arcs' geometry", () => {
  // AN ARC IS A CIRCLE ABOUT THE POLE, so none of it is pre-expanded: ONE
  // template ribbon of `segments` quads carries the parametric coordinate and
  // every star is an INSTANCE of it. The buffers used to hold every star's arc
  // vertex by vertex — 795 × 81 × 2 vertices, ~7 MB of attributes uploaded at
  // warm — for a draw that is identical either way.
  const trails = createStarTrails({ light: false });
  const mesh = trails.object as THREE.Mesh;
  const geo = mesh.geometry as THREE.InstancedBufferGeometry;
  const RUNGS = TRAIL_LOOK.segments + 1;
  const n = SKY.stars.length;
  const attr = (name: string) =>
    geo.getAttribute(name) as THREE.BufferAttribute;

  it("draws one instance of one ribbon per star", () => {
    expect(geo.isInstancedBufferGeometry).toBe(true);
    expect(geo.instanceCount).toBe(n);
    // the DRAWN vertex count is what it always was — this is a representation
    // change, not a look change
    expect(geo.instanceCount * RUNGS * 2).toBe(n * RUNGS * 2);
    expect(geo.getIndex()!.count).toBe(TRAIL_LOOK.segments * 6);
  });

  it("the template carries the arc's PARAMETERS and nothing else", () => {
    const pos = attr("position");
    expect(pos.count).toBe(RUNGS * 2);
    expect(pos instanceof THREE.InstancedBufferAttribute).toBe(false);
    for (let r = 0; r < RUNGS; r++)
      for (const k of [0, 1]) {
        const v = r * 2 + k;
        expect(pos.getX(v), `rung ${r} side`).toBe(k === 0 ? -1 : 1);
        expect(pos.getY(v), `rung ${r} s`).toBe(
          Math.fround(r / TRAIL_LOOK.segments),
        );
      }
  });

  it("everything per-STAR is an instance attribute, in catalog order", () => {
    const arcs = buildTrailArcs(SKY.stars);
    for (const name of ["aDir", "aHalf", "aInk", "aTint"]) {
      expect(attr(name) instanceof THREE.InstancedBufferAttribute, name).toBe(
        true,
      );
      expect(attr(name).count, name).toBe(n);
    }
    for (const i of [0, 3, 17, n - 1]) {
      const a = arcs[i];
      expect([
        attr("aDir").getX(i),
        attr("aDir").getY(i),
        attr("aDir").getZ(i),
      ]).toEqual(a.dir.map((x) => Math.fround(x)));
      expect(attr("aHalf").getX(i)).toBe(Math.fround(a.half));
      expect(attr("aInk").getX(i)).toBe(Math.fround(a.ink));
      expect(attr("aTint").getX(i)).toBe(Math.fround(a.tint[0]));
    }
  });

  it("states its own bounding sphere — the whole sky", () => {
    // `position` holds parameters, so three's own computation would measure the
    // template's unit ball; the mesh rides the camera-centred starfield group
    expect(geo.boundingSphere!.radius).toBe(TRAIL_LOOK.radius);
    expect(geo.boundingSphere!.center.length()).toBe(0);
    expect(mesh.frustumCulled).toBe(false);
  });

  it("fits in tens of KB", () => {
    let bytes = geo.getIndex()!.array.byteLength;
    for (const a of Object.values(geo.attributes))
      bytes += (a as THREE.BufferAttribute).array.byteLength;
    expect(bytes).toBeLessThan(64 * 1024);
    // …where the pre-expanded soup was megabytes
    expect(bytes).toBeLessThan(n * RUNGS * 2 * 44 * 0.01);
  });
});

describe("the trails driver's laws", () => {
  it("the sweep holds at zero until local 0.25, then runs to the max at SKY_OUT_END", () => {
    // coarsely: the chapter turns the sky AROUND half a
    // revolution. A range, not a pin — the exact
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
    // the reverse of what this case used to pin (the turn is over before the
    // arcs start to fade): the sweep used to saturate at trails-local 0.9, so
    // the crossfade into the reveal played over a sky that had already
    // stopped, and the trails must keep spinning through the transition
    // instead. The turn now holds its cruising rate past the envelope's own
    // end, and the reveal's rotation is handed the same law (story/reveal.ts).
    const end = atFrac(rwR, 0.28); // where trailEnvAt reaches 0
    expect(trailEnvAt(end)).toBe(0);
    const rate = (p: number) =>
      (trailSweepAt(p + 1e-5) - trailSweepAt(p)) / 1e-5;
    // still moving as the arcs vanish, and at a real fraction of the rate it
    // held mid-scene — not a smoothstep's dying foot
    expect(rate(end)).toBeGreaterThan(0.8 * rate(atFrac(tR, 0.6)));
  });

  // THE HAND-OVER IS LONG — the fluid-transition correction: a fast scroll made
  // the short exchange look off, so the reassemble needs a longer transition
  // with the spinning arcs still on screen. The old windows concentrated
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
    // (0.2258 at 0.20; the envelope runs out at 0.28)
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

describe("the arcs' attach window", () => {
  // EXPORTED for story/cost.ts's overlay column — one draw call, and it may not
  // re-spell the window. Pinned here, where it is owned.

  it("pads the driven span at both ends", () => {
    expect(SPAN_P0).toBeLessThan(tR.p0);
    expect(SPAN_P1).toBeGreaterThan(ENV_END);
    // the same pad on each edge, and small enough that a scrub cannot park
    // outside the span while the envelope is still nonzero
    expect(tR.p0 - SPAN_P0).toBeCloseTo(SPAN_P1 - ENV_END, 12);
    expect(trailEnvAt(SPAN_P0)).toBe(0);
    expect(trailEnvAt(SPAN_P1)).toBe(0);
  });
});
