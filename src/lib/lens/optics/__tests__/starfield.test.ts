import * as THREE from "three/webgpu";
import { describe, expect, it } from "vitest";
import {
  AUTHORED_COUNT,
  BRIGHTNESS_LAW,
  BRIGHT_COUNT,
  SKY,
  THROAT_ALT,
  THROAT_AZ,
  dirOf,
} from "../sky";
import {
  STARFIELD_LOOK,
  buildStarQuads,
  createStarfield,
  ringWeight,
  starRho,
  streakOf,
  throatAngle,
} from "../starfield";

// The starfield's CPU side: quad packing and the streak basis. The shaders
// need a GPU and are not tested here.

const THROAT = dirOf(THROAT_AZ, THROAT_ALT);
const dot = (a: number[], b: number[]) =>
  a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

describe("starfield", () => {
  it("(a) aims every streak along the great circle toward the throat", () => {
    for (const [i, s] of SKY.stars.entries()) {
      const d = dirOf(s.az, s.alt);
      const { tan, len } = streakOf(d);
      if (len === 0) continue; // on or too close to the axis
      // a unit tangent…
      expect(Math.hypot(...tan), `star ${i} |tan|`).toBeCloseTo(1, 12);
      // …perpendicular to the star (a great-circle tangent AT the star)…
      expect(dot(tan, d), `star ${i} tan·dir`).toBeCloseTo(0, 12);
      // …leaning toward the throat, never away from it.
      expect(dot(tan, THROAT), `star ${i} tan·throat`).toBeGreaterThan(0);
    }
  });

  it("(b) grows the streak with the angle to the throat, and never past it", () => {
    // sampled along one meridian: γ runs 0 → π as az does
    let prev = -1;
    for (const az of [0.2, 0.6, 1.0, 1.6, 2.2, 2.8, 3.1]) {
      const { len } = streakOf(dirOf(az, 0));
      expect(len).toBeGreaterThan(prev);
      expect(len, `az ${az} never overshoots the throat`).toBeLessThanOrEqual(
        az + 1e-12,
      );
      prev = len;
    }
    expect(streakOf(dirOf(3.14159, 0)).len).toBeCloseTo(
      STARFIELD_LOOK.streakLenRad,
      3,
    );
  });

  it("(c) leaves a star ON the exit axis with no streak at all", () => {
    expect(streakOf(THROAT)).toEqual({ tan: [0, 0, 0], len: 0 });
    // and the antipode is a degenerate tangent too
    expect(streakOf([-1, 0, 0]).len).toBe(0);
    // near the axis the length collapses under streakMinLenRad and is dropped
    expect(streakOf(dirOf(0.01, 0)).len).toBe(0);
  });

  it("(d) packs one quad per star, four corners covering [-1,1]²", () => {
    const q = buildStarQuads(SKY.stars);
    const n = SKY.stars.length;
    for (const [k, per] of Object.entries({
      position: 12,
      dir: 12,
      tan: 12,
      tint: 12,
      rho: 4,
      ink: 4,
      len: 4,
      ring: 4,
      index: 6,
    }))
      expect(q[k as keyof typeof q].length, k).toBe(n * per);
    // every index addresses a real vertex
    for (const i of q.index) expect(i).toBeLessThan(n * 4);
    // the four corners of star 0 are the four sign combinations, once each
    const corners = new Set<string>();
    for (let c = 0; c < 4; c++)
      corners.add(`${q.position[c * 3]},${q.position[c * 3 + 1]}`);
    expect(corners).toEqual(new Set(["-1,-1", "1,-1", "1,1", "-1,1"]));
  });

  it("(e) repeats each star's own direction, radius, streak and ring weight on all four corners", () => {
    const q = buildStarQuads(SKY.stars);
    for (const [s, star] of SKY.stars.entries()) {
      const d = dirOf(star.az, star.alt);
      const streak = streakOf(d);
      const rho = Math.max(STARFIELD_LOOK.minRhoRad, starRho(star.mag));
      const ring = ringWeight(throatAngle(d));
      for (let c = 0; c < 4; c++) {
        const v = s * 4 + c;
        // float32 storage
        expect(q.rho[v], `star ${s} rho`).toBeCloseTo(rho, 6);
        expect(q.len[v], `star ${s} len`).toBeCloseTo(streak.len, 6);
        expect(q.ring[v], `star ${s} ring`).toBeCloseTo(ring, 6);
        for (let k = 0; k < 3; k++) {
          expect(q.dir[v * 3 + k], `star ${s} dir[${k}]`).toBeCloseTo(d[k], 6);
          expect(q.tan[v * 3 + k], `star ${s} tan[${k}]`).toBeCloseTo(
            streak.tan[k],
            6,
          );
          expect(q.tint[v * 3 + k], `star ${s} tint[${k}]`).toBeCloseTo(
            star.tint[k],
            6,
          );
        }
      }
    }
  });

  it("(e2) bands the ring: peak at the centre, smooth 0 at both edges, calm axis", () => {
    const c = STARFIELD_LOOK.ringCentreRad;
    const hw = STARFIELD_LOOK.ringHalfWidthRad;
    // 1 at the centre, exactly 0 at and beyond both edges
    expect(ringWeight(c)).toBe(1);
    expect(ringWeight(c - hw)).toBe(0);
    expect(ringWeight(c + hw)).toBe(0);
    expect(ringWeight(c - hw - 0.2)).toBe(0);
    expect(ringWeight(c + hw + 0.9)).toBe(0);
    // nothing on or near the exit axis is in the band
    expect(ringWeight(0)).toBe(0);
    expect(c - hw, "the band must clear the axis").toBeGreaterThan(0);
    // …and the far field keeps its radial streaks
    expect(ringWeight(Math.PI)).toBe(0);
    // symmetric, monotone on each side, and no edge to see (slope → 0 there)
    for (let i = 1; i < 20; i++) {
      const d = (hw * i) / 20;
      expect(ringWeight(c - d)).toBeCloseTo(ringWeight(c + d), 12);
      expect(ringWeight(c + d)).toBeLessThan(ringWeight(c + d - hw / 20));
    }
    const eps = hw / 1000;
    expect(ringWeight(c + hw - eps)).toBeLessThan(1e-4);
    expect(ringWeight(c - hw + eps)).toBeLessThan(1e-4);
  });

  it("(e3) has stars in the ring band, measured from the throat", () => {
    const inBand = SKY.stars.filter(
      (s) => ringWeight(throatAngle(dirOf(s.az, s.alt))) > 0,
    );
    expect(inBand.length).toBeGreaterThan(0);
    // the throat itself is on the axis: γ = 0, weight 0
    expect(throatAngle(THROAT as [number, number, number])).toBeCloseTo(0, 12);
    expect(throatAngle([-THROAT[0], -THROAT[1], -THROAT[2]])).toBeCloseTo(
      Math.PI,
      6,
    );
  });

  it("(f) sizes discs by magnitude, monotonically", () => {
    expect(starRho(1)).toBeCloseTo(STARFIELD_LOOK.starRhoRad, 12);
    expect(starRho(3)).toBeGreaterThan(starRho(2));
    expect(starRho(2)).toBeGreaterThan(starRho(1));
    expect(starRho(0.5)).toBeLessThan(starRho(1));
  });

  it("(f2) draws the generated field clearly UNDER the authored stars", () => {
    const authored = SKY.stars.slice(0, AUTHORED_COUNT);
    const bg = SKY.stars.slice(AUTHORED_COUNT);
    const median = (stars: typeof bg) =>
      stars.map((s) => starRho(s.mag)).sort((p, q) => p - q)[
        Math.floor(stars.length / 2)
      ];
    // the field's median disc against the authored table's
    expect(median(bg)).toBeLessThan(median(authored) * 0.7);
    expect(starRho(3.1) / starRho(BRIGHTNESS_LAW.magDark)).toBeGreaterThan(3);
  });

  it("(f4) splits bright from backdrop exactly where the disc floor starts", () => {
    // sky.ts's brightMag is a literal; keep it matched to minRhoRad
    expect(starRho(BRIGHTNESS_LAW.brightMag)).toBeGreaterThanOrEqual(
      STARFIELD_LOOK.minRhoRad,
    );
    expect(starRho(BRIGHTNESS_LAW.brightMag * 0.95)).toBeLessThan(
      STARFIELD_LOOK.minRhoRad,
    );
    for (const [i, s] of SKY.stars
      .slice(AUTHORED_COUNT, BRIGHT_COUNT)
      .entries())
      expect(starRho(s.mag), `pool ${i} is a real disc`).toBeGreaterThanOrEqual(
        STARFIELD_LOOK.minRhoRad,
      );
  });

  it("(f3) dims floored discs by their size gain, and dims the backdrop", () => {
    const q = buildStarQuads(SKY.stars);
    const inkOf = (s: number) => q.ink[s * 4];
    for (const [s, star] of SKY.stars.entries()) {
      // a disc drawn at the floor is dimmed by the ratio it was enlarged
      const wanted = starRho(star.mag);
      const gain = Math.min(1, wanted / STARFIELD_LOOK.minRhoRad);
      expect(inkOf(s), `star ${s} ink`).toBeCloseTo((star.ink ?? 1) * gain, 6);
      expect(inkOf(s), `star ${s} ink`).toBeGreaterThan(0);
      expect(inkOf(s), `star ${s} ink`).toBeLessThanOrEqual(1);
    }
    // the backdrop is much dimmer than the bright prefix
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const inks = (from: number, to: number) =>
      SKY.stars.slice(from, to).map((_, i) => inkOf(from + i));
    expect(mean(inks(BRIGHT_COUNT, SKY.stars.length))).toBeLessThan(
      mean(inks(0, BRIGHT_COUNT)) * 0.5,
    );
    // the authored stars span a range of ink
    expect(Math.max(...inks(0, AUTHORED_COUNT))).toBe(1);
    expect(Math.min(...inks(0, AUTHORED_COUNT))).toBeLessThan(0.4);
    // and the whole catalog spans a wide, continuous ink range
    const all = inks(0, SKY.stars.length);
    expect(Math.min(...all)).toBeLessThan(0.12);
    expect(Math.min(...all)).toBeGreaterThan(0.05);
    expect(Math.max(...all)).toBe(1);
  });

  // Glass transmission samples a copy of the opaque pass, so marks must be in
  // the opaque list. Predicates transcribed from three r185 RenderList.js.
  it("(i) keeps every mark in the opaque list, blended, and never occluding", () => {
    const field = createStarfield(false);
    const mats: THREE.Material[] = [];
    field.object.traverse((o) => {
      if (o instanceof THREE.Mesh) mats.push(o.material as THREE.Material);
    });
    expect(mats.length).toBe(1);
    for (const raw of mats) {
      const m = raw as THREE.Material & {
        transmission?: number;
        transmissionNode?: { isNode?: boolean } | null;
        backdropNode?: { isNode?: boolean } | null;
      };
      const goesTransparent =
        m.transparent === true ||
        (m.transmission ?? 0) > 0 ||
        m.transmissionNode?.isNode === true ||
        m.backdropNode?.isNode === true;
      expect(goesTransparent, "must land in the opaque list").toBe(false);
      // still alpha-blended (any non-Normal blending applies a blend state)
      expect(m.blending).toBe(THREE.CustomBlending);
      expect(m.blendSrc).toBe(THREE.SrcAlphaFactor);
      expect(m.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
      // alpha factors that don't punch holes in the alpha canvas
      expect(m.blendSrcAlpha).toBe(THREE.OneFactor);
      expect(m.blendDstAlpha).toBe(THREE.OneMinusSrcAlphaFactor);
      // NodeBuilder.isOpaque() must be false, or alpha is forced to 1
      const builderOpaque =
        m.transparent === false &&
        m.blending === THREE.NormalBlending &&
        m.alphaToCoverage === false;
      expect(builderOpaque, "alpha must reach the blend").toBe(false);
      expect(m.depthWrite).toBe(false);
      expect(m.depthTest).toBe(true);
    }
    field.dispose();
  });
});
