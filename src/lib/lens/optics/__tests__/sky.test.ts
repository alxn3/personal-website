import { describe, expect, it } from "vitest";
import {
  AUTHORED_COUNT,
  BACKGROUND_LOOK,
  KEYHOLE_DIR,
  SKY,
  SKY_INK,
  SKY_LOOK,
  buildBackground,
  dirOf,
  meanDir,
  skyUv,
} from "../sky";

// The sky's TABLE contract and its direction↔uv mapping. The bake itself needs
// a GPU and is verified in the demo (spec §6: "bake is visual").
//
// The mapping must agree with three's own `equirectUV` (r185
// src/nodes/utils/EquirectUV.js), which the warp samples with:
//     u = atan2(dir.z, dir.x)/(2π) + 0.5
//     v = asin(clamp(dir.y, −1, 1))/π + 0.5
// so a star authored at (az, alt) must land at exactly the uv the shader reads
// back for the direction it names. These tests pin BOTH halves of that loop.

describe("sky", () => {
  it("(a) authors stars with sane magnitudes and in-range angles", () => {
    expect(SKY.stars.length).toBeGreaterThanOrEqual(35);
    for (const [i, s] of SKY.stars.entries()) {
      expect(Math.abs(s.az), `star ${i} az`).toBeLessThanOrEqual(Math.PI);
      expect(Math.abs(s.alt), `star ${i} alt`).toBeLessThanOrEqual(Math.PI / 2);
      expect(s.mag, `star ${i} mag`).toBeGreaterThan(0);
    }
  });

  it("(b) keeps every constellation index inside the star table", () => {
    expect(SKY.constellations.length).toBeGreaterThanOrEqual(3);
    for (const c of SKY.constellations) {
      expect(c.id).toBeTruthy();
      expect(typeof c.label, `${c.id} label`).toBe("string");
      expect(c.label.length, `${c.id} label`).toBeGreaterThan(0);
      expect(c.stars.length).toBeGreaterThan(1);
      for (const i of c.stars) {
        expect(Number.isInteger(i)).toBe(true);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(SKY.stars.length);
      }
      for (const [a, b] of c.lines) {
        expect(c.stars, `${c.id} line start`).toContain(a);
        expect(c.stars, `${c.id} line end`).toContain(b);
        expect(a).not.toBe(b);
      }
    }
  });

  it("(c) maps (az, alt) onto the unit square", () => {
    for (const s of SKY.stars) {
      const [u, v] = skyUv(s.az, s.alt);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    expect(skyUv(0, 0)).toEqual([0.5, 0.5]);
    expect(skyUv(Math.PI / 2, 0)[0]).toBeCloseTo(0.75, 12);
    expect(skyUv(0, Math.PI / 2)[1]).toBeCloseTo(1, 12);
    expect(skyUv(0, -Math.PI / 2)[1]).toBeCloseTo(0, 12);
  });

  it("(d) round-trips (az, alt) → direction → three's equirectUV", () => {
    // The shader side, transcribed from three r185 EquirectUV.js.
    const equirectUV = (d: [number, number, number]): [number, number] => [
      Math.atan2(d[2], d[0]) / (Math.PI * 2) + 0.5,
      Math.asin(Math.min(1, Math.max(-1, d[1]))) / Math.PI + 0.5,
    ];
    for (const s of [
      ...SKY.stars,
      { az: 0, alt: 0 },
      { az: 3.1, alt: -1.2 },
      { az: Math.PI, alt: 0 }, // the u seam
      { az: 0.7, alt: Math.PI / 2 }, // the pole, where az is degenerate
    ]) {
      const d = dirOf(s.az, s.alt);
      expect(Math.hypot(...d)).toBeCloseTo(1, 12);
      const [su, sv] = skyUv(s.az, s.alt);
      const [eu, ev] = equirectUV(d);
      expect(eu, `u at az=${s.az}`).toBeCloseTo(su, 12);
      expect(ev, `v at alt=${s.alt}`).toBeCloseTo(sv, 12);
    }
  });

  it("(e) carries a full dual palette", () => {
    for (const p of [SKY_INK.dark, SKY_INK.light]) {
      for (const k of ["backdrop", "star", "line"] as const) {
        expect(typeof p[k]).toBe("number");
        expect(p[k]).toBeGreaterThanOrEqual(0);
        expect(p[k]).toBeLessThanOrEqual(0xffffff);
      }
      expect(p.lineOpacity).toBeGreaterThan(0);
      expect(p.lineOpacity).toBeLessThanOrEqual(1);
      expect(p.starOpacity).toBeGreaterThan(0);
      expect(p.starOpacity).toBeLessThanOrEqual(1);
    }
    expect(SKY_INK.dark.backdrop).not.toBe(SKY_INK.light.backdrop);
  });

  it("(f) ships even, large-enough texture width and sane look knobs", () => {
    expect(SKY_LOOK.texW % 2).toBe(0);
    expect(SKY_LOOK.texW).toBeGreaterThanOrEqual(512);
    expect(SKY_LOOK.starRhoRad).toBeGreaterThan(0);
    expect(SKY_LOOK.poleGuard).toBeGreaterThan(0);
    expect(SKY_LOOK.poleGuard).toBeLessThan(1);
  });

  it("(g) keeps every star's disc and every stroke clear of the u seam", () => {
    // The bake silently CLIPS a disc that straddles az = ±π and silently DROPS a
    // seam-crossing stroke — this is the tripwire the header's authoring rule
    // needs, because real content is authored data and gets no compiler.
    for (const [i, s] of SKY.stars.entries()) {
      const rho = SKY_LOOK.starRhoRad * Math.pow(s.mag, SKY_LOOK.magRhoGain);
      const ru =
        rho / (Math.PI * 2 * Math.max(Math.cos(s.alt), SKY_LOOK.poleGuard));
      expect(
        (Math.PI - Math.abs(s.az)) / (Math.PI * 2),
        `star ${i} seam clearance`,
      ).toBeGreaterThan(ru);
    }
    for (const c of SKY.constellations)
      for (const [a, b] of c.lines)
        expect(
          Math.abs(skyUv(SKY.stars[b].az, 0)[0] - skyUv(SKY.stars[a].az, 0)[0]),
          `${c.id} stroke ${a}->${b} would be dropped at the seam`,
        ).toBeLessThanOrEqual(0.5);
  });

  // ── THE GENERATED BACKGROUND ─────────────────────────────────────────────
  // The catalog is two populations: the authored table (shape) and a seeded
  // background field (texture). These pin the contract between them — the
  // generator is reproducible, and it cannot touch what was authored.

  it("(h) generates the background from the seed alone — same seed, same sky", () => {
    const a = buildBackground(KEYHOLE_DIR);
    const b = buildBackground(KEYHOLE_DIR);
    expect(a.length).toBe(BACKGROUND_LOOK.count);
    expect(b).toEqual(a); // no Math.random anywhere near this
    // …and the seed is what rolls a different one, deliberately
    expect(
      buildBackground(KEYHOLE_DIR, {
        ...BACKGROUND_LOOK,
        seed: BACKGROUND_LOOK.seed + 1,
      }),
    ).not.toEqual(a);
    // the shipped catalog IS authored ++ background, in that order
    expect(SKY.stars.length).toBe(AUTHORED_COUNT + BACKGROUND_LOOK.count);
    expect(SKY.stars.slice(AUTHORED_COUNT)).toEqual(a);
    // and it is the field the finale needs, not a handful of discs
    expect(SKY.stars.length).toBeGreaterThanOrEqual(280);
    expect(SKY.stars.length).toBeLessThanOrEqual(320);
  });

  it("(i) leaves the AUTHORED rows exactly as authored", () => {
    // The four constellations index this prefix; a generator that perturbed it
    // would silently redraw shapes that were placed by hand.
    expect(AUTHORED_COUNT).toBe(82);
    expect(SKY.stars[0]).toEqual({ az: 2.33, alt: 0.34, mag: 2.6 });
    expect(SKY.stars[18]).toEqual({ az: -2.18, alt: -0.02, mag: 3.0 });
    expect(SKY.stars[42]).toEqual({ az: -0.25, alt: 0.1, mag: 2.6 });
    expect(SKY.stars[48]).toEqual({ az: -0.17, alt: -0.18, mag: 1.4 });
    expect(SKY.stars[81]).toEqual({ az: -1.66, alt: 0.48, mag: 1.1 });
    for (const c of SKY.constellations)
      for (const i of c.stars)
        expect(i, `${c.id} indexes an authored star`).toBeLessThan(
          AUTHORED_COUNT,
        );
  });

  it("(j) keeps the background faint, whole-sky, off the seam and off the Keyhole", () => {
    const authored = SKY.stars.slice(0, AUTHORED_COUNT);
    const bg = SKY.stars.slice(AUTHORED_COUNT);
    const cosGuard = Math.cos(BACKGROUND_LOOK.guardRad);
    for (const [i, s] of bg.entries()) {
      expect(s.mag, `bg ${i} mag`).toBeGreaterThanOrEqual(
        BACKGROUND_LOOK.magMin,
      );
      expect(s.mag, `bg ${i} mag`).toBeLessThanOrEqual(BACKGROUND_LOOK.magMax);
      expect(
        Math.PI - Math.abs(s.az),
        `bg ${i} seam clearance`,
      ).toBeGreaterThanOrEqual(BACKGROUND_LOOK.seamMarginRad);
      const d = dirOf(s.az, s.alt);
      expect(
        d[0] * KEYHOLE_DIR[0] + d[1] * KEYHOLE_DIR[1] + d[2] * KEYHOLE_DIR[2],
        `bg ${i} crowds the Keyhole`,
      ).toBeLessThanOrEqual(cosGuard);
    }
    // FAINT: this population is texture behind the authored marks, so its
    // middle sits well under theirs and its brightest never reaches their top.
    const median = (xs: number[]) =>
      xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)];
    expect(median(bg.map((s) => s.mag))).toBeLessThan(
      median(authored.map((s) => s.mag)) * 0.6,
    );
    expect(Math.max(...bg.map((s) => s.mag))).toBeLessThan(
      Math.max(...authored.map((s) => s.mag)),
    );
    // WHOLE-SKY: uniform on the sphere, not a patch — both signs of az and alt
    // carry a real share, and alt is asin-distributed so the poles do not bunch.
    for (const half of [
      bg.filter((s) => s.az > 0),
      bg.filter((s) => s.alt > 0),
      bg.filter((s) => Math.abs(s.alt) > Math.PI / 6),
    ])
      expect(half.length).toBeGreaterThan(bg.length * 0.3);
  });

  it("(k) aims the Keyhole guard at the Keyhole", () => {
    expect(Math.hypot(...KEYHOLE_DIR)).toBeCloseTo(1, 12);
    // the cluster's own stars are all INSIDE the guard cap it defines
    for (const i of [42, 43, 44, 45, 46, 47, 48]) {
      const d = dirOf(SKY.stars[i].az, SKY.stars[i].alt);
      const cosA =
        d[0] * KEYHOLE_DIR[0] + d[1] * KEYHOLE_DIR[1] + d[2] * KEYHOLE_DIR[2];
      expect(
        Math.acos(Math.min(1, cosA)),
        `keyhole star ${i} inside the guard`,
      ).toBeLessThan(BACKGROUND_LOOK.guardRad);
    }
    // and it is the mean of exactly those stars
    expect(
      meanDir([42, 43, 44, 45, 46, 47, 48].map((i) => SKY.stars[i])),
    ).toEqual(KEYHOLE_DIR);
  });
});
