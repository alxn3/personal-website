import { describe, expect, it } from "vitest";
import {
  FLY,
  flyPose,
  passageFade,
  passageOrder,
  poseCamX,
  travelRemap,
} from "../fly-core";

// No DOM shim: optics/fly-core.ts is pure math (core/math + the prescription
// table).

/**
 * The fly-through's PURE half: where the camera is, which element it is
 * arriving at, and how p is stretched over the flight. These are the numeric
 * laws the story's dive (story/fly.ts) rides — they outlived the /lens demo
 * that first exercised them.
 */

const NEAR_PLANE = 0.1; // world units — core/scene's camera near

describe("fly-through / travel remap", () => {
  it("(a) is the identity at insideRate 1 — the old linear dive, recoverable", () => {
    for (const p of [0, 0.13, 0.3, 0.5, 0.68, 0.91, 1])
      expect(travelRemap(p, FLY.pInside, 1)).toBe(p);
  });

  it("(b) pins both ends and stays monotone", () => {
    const rate = FLY.insideRate;
    expect(travelRemap(0, FLY.pInside, rate)).toBeCloseTo(0, 12);
    expect(travelRemap(1, FLY.pInside, rate)).toBeCloseTo(1, 12);
    let prev = -Infinity;
    for (let i = 0; i <= 200; i++) {
      const v = travelRemap(i / 200, FLY.pInside, rate);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });

  it("(c) crosses the interior in 1/rate of the p it used to", () => {
    const [a, b] = FLY.pInside;
    const rate = FLY.insideRate;
    // the INPUT p that maps onto the interior…
    const inside = (p: number) => {
      const v = travelRemap(p, FLY.pInside, rate);
      return v >= a - 1e-12 && v <= b + 1e-12;
    };
    const hits: number[] = [];
    for (let i = 0; i <= 4000; i++) if (inside(i / 4000)) hits.push(i / 4000);
    const lo = hits[0];
    const hi = hits[hits.length - 1];
    expect(hi - lo).toBeCloseTo((b - a) / rate, 2);
    // …and it is centred where it was, so the beat does not slide
    expect((hi + lo) / 2).toBeCloseTo((a + b) / 2, 2);
  });

  it("(d) is continuous at both knots", () => {
    const rate = FLY.insideRate;
    for (const [a, b] of [FLY.pInside, [0.2, 0.9] as [number, number]])
      for (const p of [0.001, 0.2, 0.4, 0.6, 0.8, 0.999]) {
        const h = 1e-6;
        const lo = travelRemap(p - h, [a, b], rate);
        const hi = travelRemap(p + h, [a, b], rate);
        expect(Math.abs(hi - lo)).toBeLessThan(1e-4);
      }
  });
});

describe("fly-through / passage fade", () => {
  const lead = FLY.passageLead;
  const fade = FLY.passageFade;
  const x0 = 1.25; // an element's rearmost world X

  it("(e) holds an element ahead of the camera fully present", () => {
    expect(passageFade(-8, x0, lead, fade)).toBe(1);
    expect(passageFade(x0 - lead - fade, x0, lead, fade)).toBe(1);
    // one ramp-length out, still untouched
    expect(passageFade(x0 - lead - fade - 0.01, x0, lead, fade)).toBe(1);
  });

  it("(f) is gone BEFORE the near plane reaches the element, and stays gone", () => {
    expect(passageFade(x0 - lead, x0, lead, fade)).toBe(0);
    // the near plane meets the element here — the glass left the frame already
    expect(passageFade(x0 - NEAR_PLANE, x0, lead, fade)).toBe(0);
    expect(passageFade(x0, x0, lead, fade)).toBe(0);
    expect(passageFade(x0 + 5, x0, lead, fade)).toBe(0);
  });

  it("(g) falls smoothly across the window — no pop", () => {
    let prev = 1.0000001;
    for (let i = 0; i <= 100; i++) {
      const camX = x0 - lead - fade + (fade * i) / 100;
      const v = passageFade(camX, x0, lead, fade);
      expect(v).toBeLessThanOrEqual(prev);
      // a smoothstep's steepest slope is 1.5/window; nothing may jump further
      expect(prev - v).toBeLessThan((1.5 / 100) * 1.05);
      prev = v;
    }
    expect(prev).toBe(0);
    expect(passageFade(x0 - lead - fade / 2, x0, lead, fade)).toBeCloseTo(
      0.5,
      12,
    );
  });

  it("(h) finishes clear of the near plane at the shipped knobs", () => {
    // the whole point: the camera must never be inside DRAWN glass, and the
    // near plane starts cutting an element open NEAR_PLANE before contact
    expect(FLY.passageLead).toBeGreaterThan(NEAR_PLANE);
    // and the ramp must be short enough that the element is already filling the
    // frame — an element two whole barrel-lengths ahead may not be fading
    expect(FLY.passageLead + FLY.passageFade).toBeLessThan(1);
  });

  it("(i) fades the elements one after another, rear to front", () => {
    // three elements at increasing X: at any camera X the fades are
    // non-decreasing front-ward — the one being passed is always the dimmest
    const xs = [-1.9, -0.4, 1.7];
    for (let camX = -3; camX < 2.5; camX += 0.05) {
      const f = xs.map((x) => passageFade(camX, x, lead, fade));
      expect(f[0]).toBeLessThanOrEqual(f[1] + 1e-12);
      expect(f[1]).toBeLessThanOrEqual(f[2] + 1e-12);
    }
  });
});

describe("fly-through / the ruler", () => {
  it("(j) orders the elements rear to front, keeping every id", () => {
    const measured = {
      Element_07: { x0: -0.3, x1: 0.0 },
      Element_13: { x0: -1.97, x1: -1.8 },
      Element_01: { x0: 1.6, x1: 1.79 },
    };
    const order = passageOrder(measured);
    expect(order.map((e) => e.id)).toEqual([
      "Element_13",
      "Element_07",
      "Element_01",
    ]);
    expect(order.map((e) => e.x0)).toEqual([-1.97, -0.3, 1.6]);
  });

  it("(k) reads camera world X off the spherical pose", () => {
    // the dive's own heading: az = −π/2 puts the camera at targetX − dist
    const camX = poseCamX({
      azimuth: -Math.PI / 2,
      elevation: 0,
      distance: 0.34,
      targetX: 2.54,
    });
    expect(camX).toBeCloseTo(2.2, 12);
    // an elevated park shortens the axial reach by cos(el)
    expect(
      poseCamX({
        azimuth: -Math.PI / 2,
        elevation: 0.1,
        distance: 9,
        targetX: 0,
      }),
    ).toBeCloseTo(-9 * Math.cos(0.1), 12);
    // no target ⇒ the origin
    expect(poseCamX({ azimuth: 0, elevation: 0, distance: 5 })).toBeCloseTo(
      0,
      12,
    );
  });

  it("(k2) is a pure AXIAL displacement — which is what lets the LENS do the moving", () => {
    // The story does not fly this camera: it parks one at −distFar and slides
    // the MODEL to (−distFar − camX) instead (story/fly.ts). Those are the same
    // frames only while the path stays ON the axis — a Y or Z component would
    // need a rotation no dolly can express — so this is the tripwire on the
    // precondition, not on the arithmetic.
    for (let i = 0; i <= 40; i++) {
      const pose = flyPose(i / 40);
      const y = pose.distance * Math.sin(pose.elevation) + (pose.targetY ?? 0);
      const z =
        pose.distance * Math.cos(pose.elevation) * Math.cos(pose.azimuth);
      expect(y, `world Y at p ${i / 40}`).toBeCloseTo(0, 12);
      expect(z, `world Z at p ${i / 40}`).toBeCloseTo(0, 12);
    }
    // …and the run the dolly has to cover: the park behind the mount to the
    // finale out front, distFar + xEnd = 25 world units of travel.
    expect(poseCamX(flyPose(0))).toBeCloseTo(-FLY.distFar, 12);
    expect(poseCamX(flyPose(1))).toBeCloseTo(FLY.xEnd, 12);
    expect(poseCamX(flyPose(1)) - poseCamX(flyPose(0))).toBeCloseTo(25, 12);
  });

  it("(l) keeps the interior window inside the barrel run", () => {
    // pInside is in POSE p and must sit inside the linear stretch the pose path
    // runs from pEnter to pOut, or the remap would reshape the approach easing
    expect(FLY.pInside[0]).toBeGreaterThan(FLY.pEnter);
    expect(FLY.pInside[1]).toBeLessThan(FLY.pOut);
    expect(FLY.pInside[0]).toBeLessThan(FLY.pInside[1]);
    expect(FLY.insideRate).toBeGreaterThanOrEqual(1);
  });

  it("(m) keeps the wormhole and streak ramps over the compressed interior", () => {
    // where the interior now lives in INPUT p
    const [a, b] = FLY.pInside;
    const rate = FLY.insideRate;
    const mid = (a + b) / 2;
    const half = (b - a) / 2 / rate;
    const arc = ([s, peak, e]: [number, number, number], p: number) => {
      const ss = (x: number, lo: number, hi: number) => {
        const t = Math.min(1, Math.max(0, (x - lo) / (hi - lo)));
        return t * t * (3 - 2 * t);
      };
      return ss(p, s, peak) * (1 - ss(p, peak, e));
    };
    // the pinch and the streaks are both well up for the whole crossing
    for (let i = 0; i <= 20; i++) {
      const p = mid - half + ((2 * half) / 20) * i;
      expect(arc(FLY.pWormhole, p)).toBeGreaterThan(0.5);
      expect(arc(FLY.pStreak, p)).toBeGreaterThan(0.4);
    }
    // and both are still exactly nothing at the two ends of the demo
    for (const p of [0, 1]) {
      expect(arc(FLY.pWormhole, p)).toBe(0);
      expect(arc(FLY.pStreak, p)).toBe(0);
    }
  });

  it("(n) HOLDS the finale's framing — the fov never moves after pClear", () => {
    // The demo used to reach fovOut on the LAST key, so everything after the
    // lens left the frame was a continuous zoom into the starfield ("we still
    // continue zooming in after we go through"). The settle now finishes at
    // pClear and the finale is a hold, whatever fovOut is tuned to.
    for (let i = 0; i <= 20; i++) {
      const p = FLY.pClear + ((1 - FLY.pClear) * i) / 20;
      expect(flyPose(p).fov, `fov at p ${p}`).toBeCloseTo(FLY.fovOut, 12);
    }
    // the camera is still FLYING through that hold — the field opens by
    // parallax, which is the calm the zoom was standing in for
    expect(poseCamX(flyPose(1))).toBeGreaterThan(poseCamX(flyPose(FLY.pClear)));
    // and nothing between the entrance and the settle overshoots the pair
    const lo = Math.min(FLY.fovIn, FLY.fovOut);
    const hi = Math.max(FLY.fovIn, FLY.fovOut);
    for (let i = 0; i <= 20; i++) {
      const p = FLY.pEnter + ((FLY.pClear - FLY.pEnter) * i) / 20;
      expect(flyPose(p).fov).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(flyPose(p).fov).toBeLessThanOrEqual(hi + 1e-9);
    }
  });
  it("(o) flies DEAD-ON down the axis, from the park to the finale", () => {
    // az = −π/2 and el = 0 put the camera at (targetX − dist, 0, 0) looking at
    // (targetX, 0, 0): the optical axis, square to the mount face. The park used
    // to carry a slight high angle that levelled off before the barrel, and it
    // read as the lens being tilted. Nothing on the path may reintroduce it.
    for (let i = 0; i <= 40; i++) {
      const pose = flyPose(i / 40);
      expect(pose.elevation, `elevation at p ${i / 40}`).toBeCloseTo(0, 12);
      expect(pose.azimuth, `azimuth at p ${i / 40}`).toBeCloseTo(
        FLY.azRear,
        12,
      );
      expect(pose.targetY ?? 0).toBe(0);
    }
    // …so the camera's world X is exactly targetX − dist the whole way (no
    // cos(el) foreshortening), which is what the passage ruler assumes
    const pose = flyPose(0);
    expect(poseCamX(pose)).toBeCloseTo(-FLY.distFar, 12);
  });

  it("(p) takes the room AND the glass glints down before the stars arrive", () => {
    // One window drives both (FLY.pDark): the frame has to be a dark tube by the
    // time the sky comes up in it, or the studio lights are still on the glass
    // when the starfield is supposed to be the only light in the frame.
    expect(FLY.pDark[0]).toBeLessThan(FLY.pDark[1]);
    expect(FLY.pDark[1]).toBeLessThanOrEqual(FLY.pSkyIn[1]);
    // both floors are levels, and the glass floor is the darker of the two —
    // the barrel keeps a rim, the elements keep nothing
    expect(FLY.darkFloor).toBeGreaterThanOrEqual(0);
    expect(FLY.darkFloor).toBeLessThanOrEqual(1);
    expect(FLY.glintFloor).toBeGreaterThanOrEqual(0);
    expect(FLY.glintFloor).toBeLessThanOrEqual(FLY.darkFloor);
  });

  it("(q) has the iris WIDE OPEN before the camera reaches the glass", () => {
    // The dive opens the stop on the approach; a stop still closing when the
    // camera arrives at the mount is a shut door in the frame it flies through.
    // pEnter is that arrival, and the passage through the stack begins after it.
    expect(FLY.pAperture[0]).toBeGreaterThanOrEqual(0);
    expect(FLY.pAperture[0]).toBeLessThan(FLY.pAperture[1]);
    expect(FLY.pAperture[1]).toBeLessThan(FLY.pEnter);
    // …and open before the sky is FULLY up: the trace clips every ray outside
    // the iris clear radius, so a still-shut stop must not be the thing
    // metering the risen starfield (the fades may overlap — the open is tuned
    // to land late, just before glass entry)
    expect(FLY.pAperture[1]).toBeLessThan(FLY.pSkyIn[1]);
    // the park is stopped DOWN and the flight ends wide open (the channel is
    // 0 = f/2.8 open, 1 = f/22 closed)
    expect(FLY.apertureShut).toBeGreaterThan(0);
    expect(FLY.apertureShut).toBeLessThanOrEqual(1);
  });
});
