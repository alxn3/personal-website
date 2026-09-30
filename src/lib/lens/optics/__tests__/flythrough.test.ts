import { describe, expect, it } from "vitest";
import {
  FLY,
  flyPose,
  passageFade,
  passageOrder,
  poseCamX,
  travelRemap,
} from "../fly-core";

// The fly-through's pure math: camera path, passage fades and the travel remap.

const NEAR_PLANE = 0.1; // world units, the scene camera's near plane

describe("fly-through / travel remap", () => {
  it("(a) is the identity at insideRate 1", () => {
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

  it("(c) crosses the interior in 1/rate of the input p", () => {
    const [a, b] = FLY.pInside;
    const rate = FLY.insideRate;
    // the input p that maps onto the interior
    const inside = (p: number) => {
      const v = travelRemap(p, FLY.pInside, rate);
      return v >= a - 1e-12 && v <= b + 1e-12;
    };
    const hits: number[] = [];
    for (let i = 0; i <= 4000; i++) if (inside(i / 4000)) hits.push(i / 4000);
    const lo = hits[0];
    const hi = hits[hits.length - 1];
    expect(hi - lo).toBeCloseTo((b - a) / rate, 2);
    // centred on the same midpoint
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
    expect(passageFade(x0 - lead - fade - 0.01, x0, lead, fade)).toBe(1);
  });

  it("(f) is gone BEFORE the near plane reaches the element, and stays gone", () => {
    expect(passageFade(x0 - lead, x0, lead, fade)).toBe(0);
    // where the near plane meets the element
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
    // the near plane must never cut into drawn glass
    expect(FLY.passageLead).toBeGreaterThan(NEAR_PLANE);
    // and an element well ahead must not be fading yet
    expect(FLY.passageLead + FLY.passageFade).toBeLessThan(1);
  });

  it("(i) fades the elements one after another, rear to front", () => {
    // at any camera X the fades are non-decreasing toward the front
    const xs = [-1.9, -0.4, 1.7];
    for (let camX = -3; camX < 2.5; camX += 0.05) {
      const f = xs.map((x) => passageFade(camX, x, lead, fade));
      expect(f[0]).toBeLessThanOrEqual(f[1] + 1e-12);
      expect(f[1]).toBeLessThanOrEqual(f[2] + 1e-12);
    }
  });
});

describe("fly-through / camera path", () => {
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
    // az = −π/2 puts the camera at targetX − dist
    const camX = poseCamX({
      azimuth: -Math.PI / 2,
      elevation: 0,
      distance: 0.34,
      targetX: 2.54,
    });
    expect(camX).toBeCloseTo(2.2, 12);
    // elevation shortens the axial reach by cos(el)
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

  it("(l) keeps the interior window inside the barrel run", () => {
    // pInside must sit inside the linear pEnter..pOut stretch of the path
    expect(FLY.pInside[0]).toBeGreaterThan(FLY.pEnter);
    expect(FLY.pInside[1]).toBeLessThan(FLY.pOut);
    expect(FLY.pInside[0]).toBeLessThan(FLY.pInside[1]);
    expect(FLY.insideRate).toBeGreaterThanOrEqual(1);
  });

  it("(m) keeps the wormhole and streak ramps over the compressed interior", () => {
    // the interior window in input p
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
    // both ramps are well up for the whole crossing
    for (let i = 0; i <= 20; i++) {
      const p = mid - half + ((2 * half) / 20) * i;
      expect(arc(FLY.pWormhole, p)).toBeGreaterThan(0.5);
      expect(arc(FLY.pStreak, p)).toBeGreaterThan(0.4);
    }
    // and exactly 0 at both ends
    for (const p of [0, 1]) {
      expect(arc(FLY.pWormhole, p)).toBe(0);
      expect(arc(FLY.pStreak, p)).toBe(0);
    }
  });

  it("(n) holds the fov constant after pClear", () => {
    for (let i = 0; i <= 20; i++) {
      const p = FLY.pClear + ((1 - FLY.pClear) * i) / 20;
      expect(flyPose(p).fov, `fov at p ${p}`).toBeCloseTo(FLY.fovOut, 12);
    }
    // the camera keeps moving through the hold
    expect(poseCamX(flyPose(1))).toBeGreaterThan(poseCamX(flyPose(FLY.pClear)));
    // no fov overshoot between pEnter and pClear
    const lo = Math.min(FLY.fovIn, FLY.fovOut);
    const hi = Math.max(FLY.fovIn, FLY.fovOut);
    for (let i = 0; i <= 20; i++) {
      const p = FLY.pEnter + ((FLY.pClear - FLY.pEnter) * i) / 20;
      expect(flyPose(p).fov).toBeGreaterThanOrEqual(lo - 1e-9);
      expect(flyPose(p).fov).toBeLessThanOrEqual(hi + 1e-9);
    }
  });
  it("(o) flies straight down the optical axis", () => {
    // az = −π/2, el = 0: camera at (targetX − dist, 0, 0) looking down +X; the
    // story slides the model instead of the camera, which only works on-axis
    for (let i = 0; i <= 40; i++) {
      const pose = flyPose(i / 40);
      expect(pose.elevation, `elevation at p ${i / 40}`).toBeCloseTo(0, 12);
      expect(pose.azimuth, `azimuth at p ${i / 40}`).toBeCloseTo(
        FLY.azRear,
        12,
      );
      expect(pose.targetY ?? 0).toBe(0);
    }
    // total travel: distFar + xEnd = 25 world units
    expect(poseCamX(flyPose(0))).toBeCloseTo(-FLY.distFar, 12);
    expect(poseCamX(flyPose(1))).toBeCloseTo(FLY.xEnd, 12);
    expect(poseCamX(flyPose(1)) - poseCamX(flyPose(0))).toBeCloseTo(25, 12);
  });

  it("(p) dims the lighting and glass reflections before the stars arrive", () => {
    expect(FLY.pDark[0]).toBeLessThan(FLY.pDark[1]);
    expect(FLY.pDark[1]).toBeLessThanOrEqual(FLY.pSkyIn[1]);
    // both floors are levels; the glass floor is the darker
    expect(FLY.darkFloor).toBeGreaterThanOrEqual(0);
    expect(FLY.darkFloor).toBeLessThanOrEqual(1);
    expect(FLY.glintFloor).toBeGreaterThanOrEqual(0);
    expect(FLY.glintFloor).toBeLessThanOrEqual(FLY.darkFloor);
  });

  it("(q) opens the iris fully before the camera reaches the glass", () => {
    expect(FLY.pAperture[0]).toBeGreaterThanOrEqual(0);
    expect(FLY.pAperture[0]).toBeLessThan(FLY.pAperture[1]);
    expect(FLY.pAperture[1]).toBeLessThan(FLY.pEnter);
    // and before the stars are fully up
    expect(FLY.pAperture[1]).toBeLessThan(FLY.pSkyIn[1]);
    // starts stopped down (channel 0 = f/2.8, 1 = f/22)
    expect(FLY.apertureShut).toBeGreaterThan(0);
    expect(FLY.apertureShut).toBeLessThanOrEqual(1);
  });
});
