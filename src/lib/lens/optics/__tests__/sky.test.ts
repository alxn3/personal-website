import { describe, expect, it } from "vitest";
import {
  AUTHORED_COUNT,
  BRIGHTNESS_LAW,
  BRIGHT_COUNT,
  FIELD_LOOK,
  SKY,
  SKY_INK,
  STAR_TINTS,
  buildField,
  dirOf,
  inkOf,
  magAt,
  tintAt,
} from "../sky";

// The sky catalog, and its (az, alt) convention, which must match three's
// `equirectUV` (r185 EquirectUV.js).

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

  it("(d) round-trips (az, alt) → direction → three's equirectUV", () => {
    // transcribed from three r185 EquirectUV.js
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
      const [su, sv] = [s.az / (Math.PI * 2) + 0.5, s.alt / Math.PI + 0.5];
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

  // The generated field, split at BRIGHTNESS_LAW.brightMag into bright and backdrop.

  it("(h) generates the field from the seed alone — same seed, same sky", () => {
    const a = buildField();
    const b = buildField();
    expect(a.length).toBe(FIELD_LOOK.count);
    expect(b).toEqual(a);
    expect(
      buildField({ ...FIELD_LOOK, seed: FIELD_LOOK.seed + 1 }),
    ).not.toEqual(a);
    // the catalog is the authored stars plus exactly that field
    expect(SKY.stars.length).toBe(AUTHORED_COUNT + FIELD_LOOK.count);
    const byPlace = (xs: typeof a) =>
      xs.slice().sort((p, q) => p.az - q.az || p.alt - q.alt);
    expect(byPlace(SKY.stars.slice(AUTHORED_COUNT))).toEqual(byPlace(a));
    // star count bounds
    expect(SKY.stars.length).toBeGreaterThanOrEqual(700);
    expect(SKY.stars.length).toBeLessThanOrEqual(900);
  });

  it("(h2) splits the field at the bright cut — pool first, backdrop behind", () => {
    const field = buildField();
    const pool = SKY.stars.slice(AUTHORED_COUNT, BRIGHT_COUNT);
    const backdrop = SKY.stars.slice(BRIGHT_COUNT);
    expect(pool.length + backdrop.length).toBe(FIELD_LOOK.count);
    expect(BRIGHT_COUNT).toBe(AUTHORED_COUNT + pool.length);
    // the cut is BRIGHTNESS_LAW.brightMag and nothing else
    for (const [i, s] of pool.entries())
      expect(s.mag, `pool ${i}`).toBeGreaterThanOrEqual(
        BRIGHTNESS_LAW.brightMag,
      );
    for (const [i, s] of backdrop.entries())
      expect(s.mag, `backdrop ${i}`).toBeLessThan(BRIGHTNESS_LAW.brightMag);
    // each half keeps generation order
    const isSubsequence = (sub: typeof field, all: typeof field) => {
      let j = 0;
      for (const s of all)
        if (j < sub.length && s.az === sub[j].az && s.alt === sub[j].alt) j++;
      return j === sub.length;
    };
    expect(isSubsequence(pool, field)).toBe(true);
    expect(isSubsequence(backdrop, field)).toBe(true);
    // few bright, many faint
    expect(pool.length).toBe(220);
    expect(backdrop.length).toBe(500);
    const mean = (xs: number[]) => xs.reduce((p, q) => p + q, 0) / xs.length;
    const ink = (xs: typeof field) => mean(xs.map((s) => s.ink ?? 1));
    expect(ink(backdrop)).toBeLessThan(ink(pool) * 0.6);
  });

  it("(h3) falls off exponentially in brightness", () => {
    const { magDark, magBright, decay, inkMin } = BRIGHTNESS_LAW;
    const rankOf = (mag: number) => (mag - magDark) / (magBright - magDark);
    const field = SKY.stars.slice(AUTHORED_COUNT);

    // magAt: exact at u = 0, monotone, in range at the top
    expect(magAt(0)).toBeCloseTo(magDark, 12);
    expect(magAt(1 - 1e-12)).toBeLessThanOrEqual(magBright);
    for (let i = 1; i <= 20; i++)
      expect(magAt(i / 20)).toBeGreaterThan(magAt((i - 1) / 20));

    // the count above a rank follows e^(−decay·rank), with a loose tolerance
    for (const r of [0.1, 0.25, 0.4, 0.5]) {
      const pred = FIELD_LOOK.count * Math.exp(-decay * r);
      const n = field.filter((s) => rankOf(s.mag) >= r).length;
      expect(n, `rank ≥ ${r} (pred ${pred.toFixed(0)})`).toBeGreaterThan(
        pred * 0.7,
      );
      expect(n, `rank ≥ ${r} (pred ${pred.toFixed(0)})`).toBeLessThan(
        pred * 1.4,
      );
    }

    // ink is the same rank, rescaled
    for (const u of [0, 0.2, 0.5, 0.9, 1 - 1e-9]) {
      const m = magAt(u);
      expect(inkOf(m)).toBeCloseTo(inkMin + (1 - inkMin) * rankOf(m), 12);
    }
    // clamped at both ends
    expect(inkOf(magDark - 5)).toBe(inkMin);
    expect(inkOf(magBright + 5)).toBe(1);

    // the catalog's ink spans inkMin…1
    const inks = SKY.stars.map((s) => s.ink ?? 1);
    expect(Math.min(...inks)).toBeGreaterThanOrEqual(inkMin);
    expect(Math.min(...inks)).toBeLessThan(inkMin * 1.02);
    expect(Math.max(...inks)).toBe(1);
    // most stars are faint
    const median = (xs: number[]) =>
      xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)];
    expect(median(inks)).toBeLessThan(0.35);
  });

  it("(i) leaves the authored rows exactly as authored", () => {
    // the constellations index this prefix
    expect(AUTHORED_COUNT).toBe(75);
    for (const [i, row] of [
      [0, { az: 2.33, alt: 0.34, mag: 2.6 }],
      [18, { az: -2.18, alt: -0.02, mag: 3.0 }],
      [41, { az: 3.11, alt: -0.63, mag: 1.4 }],
      [42, { az: -0.52, alt: 0.31, mag: 1.3 }],
      [74, { az: -1.66, alt: 0.48, mag: 1.1 }],
    ] as [number, { az: number; alt: number; mag: number }][])
      expect(SKY.stars[i], `authored row ${i}`).toEqual({
        ...row,
        ink: inkOf(row.mag),
        tint: tintAt(i),
      });
    for (const c of SKY.constellations)
      for (const i of c.stars)
        expect(i, `${c.id} indexes an authored star`).toBeLessThan(
          AUTHORED_COUNT,
        );
    // the authored rows span a range of ink
    const aInk = SKY.stars.slice(0, AUTHORED_COUNT).map((s) => s.ink ?? 1);
    expect(Math.min(...aInk)).toBeCloseTo(inkOf(0.8), 12); // the faintest row
    expect(Math.max(...aInk)).toBe(1);
    expect(new Set(aInk).size).toBeGreaterThan(10);
  });

  it("(j) keeps the field under the authored table, whole-sky and off the seam", () => {
    const authored = SKY.stars.slice(0, AUTHORED_COUNT);
    const bg = SKY.stars.slice(AUTHORED_COUNT);
    for (const [i, s] of bg.entries()) {
      expect(s.mag, `field ${i} mag`).toBeGreaterThanOrEqual(
        BRIGHTNESS_LAW.magDark,
      );
      expect(s.mag, `field ${i} mag`).toBeLessThanOrEqual(
        BRIGHTNESS_LAW.magBright,
      );
      expect(
        Math.PI - Math.abs(s.az),
        `field ${i} seam clearance`,
      ).toBeGreaterThanOrEqual(FIELD_LOOK.seamMarginRad);
    }
    // the field is fainter than the authored stars
    const median = (xs: number[]) =>
      xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)];
    expect(median(bg.map((s) => s.mag))).toBeLessThan(
      median(authored.map((s) => s.mag)) * 0.6,
    );
    expect(Math.max(...bg.map((s) => s.mag))).toBeLessThan(
      Math.max(...authored.map((s) => s.mag)),
    );
    // clustered about the view axis (+X), with some stars everywhere else
    const gamma = (s: (typeof bg)[number]) =>
      Math.acos(Math.min(1, dirOf(s.az, s.alt)[0]));
    // a 0.7 rad cone is 11.8% of the sphere, so 35% means real clustering
    const inFrame = bg.filter((s) => gamma(s) < 0.7).length;
    expect(inFrame / bg.length).toBeGreaterThan(0.35);
    // and the far sky is not empty
    expect(bg.filter((s) => gamma(s) > 1.2).length).toBeGreaterThan(
      bg.length * 0.15,
    );
    // the cluster is round, so no hemisphere is starved
    for (const half of [
      bg.filter((s) => s.az > 0),
      bg.filter((s) => s.alt > 0),
      bg.filter((s) => s.alt < 0),
    ])
      expect(half.length).toBeGreaterThan(bg.length * 0.3);
    // uniform-sphere stars reach high altitudes (thin margin: seed-sensitive)
    expect(
      bg.filter((s) => Math.abs(s.alt) > Math.PI / 6).length / bg.length,
    ).toBeGreaterThan(0.3);
  });

  it("(j2) tints every star, and tints only darken the ink", () => {
    for (const [k, t] of STAR_TINTS.entries()) {
      expect(Math.max(...t), `stop ${k} peaks at the ink`).toBeCloseTo(1, 12);
      expect(Math.min(...t), `stop ${k} stays a star`).toBeGreaterThan(0.4);
    }
    // both ends are coloured and one stop is plain white
    expect(STAR_TINTS[0][1]).toBe(1);
    expect(STAR_TINTS[0][2]).toBeLessThan(0.9);
    expect(STAR_TINTS[STAR_TINTS.length - 1][0]).toBe(1);
    expect(STAR_TINTS[STAR_TINTS.length - 1][2]).toBeLessThan(0.9);
    expect(STAR_TINTS.some((t) => t[0] === 1 && t[1] === 1 && t[2] === 1)).toBe(
      true,
    );

    // every star uses one of the tints exactly
    for (const [i, s] of SKY.stars.entries())
      expect(STAR_TINTS, `star ${i} tint`).toContain(s.tint);

    // mostly white, with coloured accents
    const share = (t: (typeof STAR_TINTS)[number]) =>
      SKY.stars.filter((s) => s.tint === t).length / SKY.stars.length;
    const whiteish =
      share(STAR_TINTS[1]) + share(STAR_TINTS[2]) + share(STAR_TINTS[3]);
    expect(whiteish).toBeGreaterThan(0.6);
    for (const t of [STAR_TINTS[0], STAR_TINTS[STAR_TINTS.length - 1]]) {
      expect(share(t)).toBeGreaterThan(0.01); // present…
      expect(share(t)).toBeLessThan(0.15); // …but an accent
    }

    // deterministic hash
    expect(tintAt(7)).toBe(tintAt(7));
    expect(
      new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => tintAt(i))).size,
    ).toBeGreaterThan(1);
    // and a different key gives different tints
    const run = (key: number) =>
      Array.from({ length: 40 }, (_, i) => STAR_TINTS.indexOf(tintAt(i, key)));
    expect(run(FIELD_LOOK.seed)).not.toEqual(run(FIELD_LOOK.seed + 1));
  });

  it("(k) fills the middle of the frame as densely as around it", () => {
    // surface density: count over the band's solid angle, 2π(cos g0 − cos g1)
    const bg = SKY.stars.slice(AUTHORED_COUNT);
    const density = (g0: number, g1: number) => {
      let n = 0;
      for (const s of bg) {
        const g = Math.acos(Math.min(1, dirOf(s.az, s.alt)[0]));
        if (g >= g0 && g < g1) n++;
      }
      return n / (2 * Math.PI * (Math.cos(g0) - Math.cos(g1)));
    };
    const middle = density(0, 0.26);
    // several times the whole-sphere average
    expect(middle).toBeGreaterThan((3.5 * bg.length) / (4 * Math.PI));
    // level with the ring around it (loose tolerance for counting noise)
    expect(middle).toBeGreaterThan(density(0.26, 0.5) * 0.8);
    // and denser than the periphery
    expect(middle).toBeGreaterThan(density(0.5, 1));
  });
});
