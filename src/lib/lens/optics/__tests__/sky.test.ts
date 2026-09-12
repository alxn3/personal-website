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
  skyUv,
  tintAt,
} from "../sky";

// The sky's TABLE contract and its direction↔uv mapping.
//
// The mapping must agree with three's own `equirectUV` (r185
// src/nodes/utils/EquirectUV.js), which the warp samples with:
//     u = atan2(dir.z, dir.x)/(2π) + 0.5
//     v = asin(clamp(dir.y, −1, 1))/π + 0.5
// so a star authored at (az, alt) lands at the uv the shader reads back.

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

  // ── THE GENERATED FIELD ──────────────────────────────────────────────────
  // The catalog is the authored table (shape) plus ONE seeded field, split at
  // BRIGHTNESS_LAW.brightMag into the prefix a stroke may end on and the
  // backdrop behind it.

  it("(h) generates the field from the seed alone — same seed, same sky", () => {
    const a = buildField();
    const b = buildField();
    expect(a.length).toBe(FIELD_LOOK.count);
    expect(b).toEqual(a); // no Math.random anywhere near this
    // …and the seed is what rolls a different one, deliberately
    expect(
      buildField({ ...FIELD_LOOK, seed: FIELD_LOOK.seed + 1 }),
    ).not.toEqual(a);
    // the shipped catalog IS the authored table ++ that one field, re-ordered
    // only by the bright cut (h2) — nothing added, nothing dropped
    expect(SKY.stars.length).toBe(AUTHORED_COUNT + FIELD_LOOK.count);
    const byPlace = (xs: typeof a) =>
      xs.slice().sort((p, q) => p.az - q.az || p.alt - q.alt);
    expect(byPlace(SKY.stars.slice(AUTHORED_COUNT))).toEqual(byPlace(a));
    // every star costs a quad in the starfield draw and a segmented arc in the
    // trail draw, so the count knob is bounded on both sides
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
    // A STABLE PARTITION, not a sort: each half is the generator's own stream
    // read in order.
    const isSubsequence = (sub: typeof field, all: typeof field) => {
      let j = 0;
      for (const s of all)
        if (j < sub.length && s.az === sub[j].az && s.alt === sub[j].alt) j++;
      return j === sub.length;
    };
    expect(isSubsequence(pool, field)).toBe(true);
    expect(isSubsequence(backdrop, field)).toBe(true);
    // FEW BRIGHT, MANY FAINT — the exponential, counted at the cut
    expect(pool.length).toBe(220);
    expect(backdrop.length).toBe(500);
    // and the tail really is backdrop: its mean ink is well under the pool's
    const mean = (xs: number[]) => xs.reduce((p, q) => p + q, 0) / xs.length;
    const ink = (xs: typeof field) => mean(xs.map((s) => s.ink ?? 1));
    expect(ink(backdrop)).toBeLessThan(ink(pool) * 0.6);
  });

  it("(h3) falls off EXPONENTIALLY in brightness — the whole point of the law", () => {
    const { magDark, magBright, decay, inkMin } = BRIGHTNESS_LAW;
    const rankOf = (mag: number) => (mag - magDark) / (magBright - magDark);
    const field = SKY.stars.slice(AUTHORED_COUNT);

    // `magAt` is the truncated exponential's inverse CDF: exact at u = 0,
    // monotone, and inside the range at the far end.
    expect(magAt(0)).toBeCloseTo(magDark, 12);
    expect(magAt(1 - 1e-12)).toBeLessThanOrEqual(magBright);
    for (let i = 1; i <= 20; i++)
      expect(magAt(i / 20)).toBeGreaterThan(magAt((i - 1) / 20));

    // THE LAW ITSELF: the count above a rank follows e^(−decay·rank), with a
    // wide band because the draw is small at the thin end.
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

    // INK IS THAT SAME RANK, rescaled — one brightness quantity per star.
    for (const u of [0, 0.2, 0.5, 0.9, 1 - 1e-9]) {
      const m = magAt(u);
      expect(inkOf(m)).toBeCloseTo(inkMin + (1 - inkMin) * rankOf(m), 12);
    }
    // …clamped at both ends, so an authored row off either end of the ramp is
    // still a legal star
    expect(inkOf(magDark - 5)).toBe(inkMin);
    expect(inkOf(magBright + 5)).toBe(1);

    // AND THE SPREAD IS WIDE: the catalog's ink runs the full inkMin…1.
    const inks = SKY.stars.map((s) => s.ink ?? 1);
    // the faintest star the draw lands is a whisker over rank 0
    expect(Math.min(...inks)).toBeGreaterThanOrEqual(inkMin);
    expect(Math.min(...inks)).toBeLessThan(inkMin * 1.02);
    expect(Math.max(...inks)).toBe(1);
    // with the mass down at the faint end — the median under a third of full
    const median = (xs: number[]) =>
      xs.slice().sort((p, q) => p - q)[Math.floor(xs.length / 2)];
    expect(median(inks)).toBeLessThan(0.35);
  });

  it("(i) leaves the AUTHORED rows exactly as authored", () => {
    // The constellations index this prefix; a generator that perturbed it would
    // silently redraw hand-placed shapes.
    expect(AUTHORED_COUNT).toBe(75);
    // az/alt/mag are authored; `tint` is a pure function of the row INDEX and
    // `ink` of the row's own magnitude, so neither can move a star.
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
    // NO CLUMP: the table's magnitude hierarchy is its ink hierarchy, so the
    // authored rows are a spread rather than all at full strength.
    const aInk = SKY.stars.slice(0, AUTHORED_COUNT).map((s) => s.ink ?? 1);
    expect(Math.min(...aInk)).toBeCloseTo(inkOf(0.8), 12); // the table's faintest
    expect(Math.max(...aInk)).toBe(1); // …and its nine at or over magBright
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
    // CONCENTRATED, BUT NOT A PATCH: the field gathers about the view axis
    // (world +X, az = alt = 0) and keeps a peripheral minority, which the dive
    // arrives through and the trails scene spins past.
    const gamma = (s: (typeof bg)[number]) =>
      Math.acos(Math.min(1, dirOf(s.az, s.alt)[0]));
    // the ~0.7 rad cone the story frames is 11.8% of the sphere, so a 0.35
    // share is over 3× the uniform one — only a genuine concentration passes
    const inFrame = bg.filter((s) => gamma(s) < 0.7).length;
    expect(inFrame / bg.length).toBeGreaterThan(0.35);
    // …and the far sky is dressed, not stripped
    expect(bg.filter((s) => gamma(s) > 1.2).length).toBeGreaterThan(
      bg.length * 0.15,
    );
    // the concentration is ROUND about the axis — its roll is uniform — so no
    // hemisphere of the sky is starved by it
    for (const half of [
      bg.filter((s) => s.az > 0),
      bg.filter((s) => s.alt > 0),
      bg.filter((s) => s.alt < 0),
    ])
      expect(half.length).toBeGreaterThan(bg.length * 0.3);
    // the peripheral branch draws `alt = asin(uniform)`, not a uniform alt
    // (which would bunch at the poles), so a real share sits over 30° off the
    // equator. Thin margin: a seed or coreFraction change can fail it.
    expect(
      bg.filter((s) => Math.abs(s.alt) > Math.PI / 6).length / bg.length,
    ).toBeGreaterThan(0.3);
  });

  it("(j2) tints every star, and can only ever take light out of the ink", () => {
    // A tint multiplies the theme's own star ink and every channel is ≤ 1, so a
    // tint can only ever take light out of the palette.
    for (const [k, t] of STAR_TINTS.entries()) {
      expect(Math.max(...t), `stop ${k} peaks at the ink`).toBeCloseTo(1, 12);
      expect(Math.min(...t), `stop ${k} stays a star`).toBeGreaterThan(0.4);
    }
    // both ends of the ramp are real colour, and the middle is untinted white
    expect(STAR_TINTS[0][1]).toBe(1); // the cool end is the site's sage
    expect(STAR_TINTS[0][2]).toBeLessThan(0.9);
    expect(STAR_TINTS[STAR_TINTS.length - 1][0]).toBe(1); // …the warm end its red
    expect(STAR_TINTS[STAR_TINTS.length - 1][2]).toBeLessThan(0.9);
    expect(STAR_TINTS.some((t) => t[0] === 1 && t[1] === 1 && t[2] === 1)).toBe(
      true,
    );

    // every star carries one, and it is one OF the ramp — no interpolation, so
    // the whole sky is six colours and the palette stays authorable
    for (const [i, s] of SKY.stars.entries())
      expect(STAR_TINTS, `star ${i} tint`).toContain(s.tint);

    // MOSTLY WHITE, with accents, counted over the shipped catalog rather than
    // the weights table.
    const share = (t: (typeof STAR_TINTS)[number]) =>
      SKY.stars.filter((s) => s.tint === t).length / SKY.stars.length;
    const whiteish =
      share(STAR_TINTS[1]) + share(STAR_TINTS[2]) + share(STAR_TINTS[3]);
    expect(whiteish).toBeGreaterThan(0.6);
    for (const t of [STAR_TINTS[0], STAR_TINTS[STAR_TINTS.length - 1]]) {
      expect(share(t)).toBeGreaterThan(0.01); // present…
      expect(share(t)).toBeLessThan(0.15); // …but an accent
    }

    // A HASH, NOT A DRAW — deterministic and independent of the generator's
    // stream, so it cannot move a star
    expect(tintAt(7)).toBe(tintAt(7));
    expect(
      new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => tintAt(i))).size,
    ).toBeGreaterThan(1);
    // and keyed, so a re-seed re-rolls the colours with the positions rather
    // than replaying the same run of six over a new sky
    const run = (key: number) =>
      Array.from({ length: 40 }, (_, i) => STAR_TINTS.indexOf(tintAt(i, key)));
    expect(run(FIELD_LOOK.seed)).not.toEqual(run(FIELD_LOOK.seed + 1));
  });

  it("(k) fills the very middle of the frame — no keep-out left in it", () => {
    // NO KEEP-OUT: the middle of the frame is drawn from the same concentration
    // as the ring around it, so its density matches rather than dips. Compared
    // as surface densities — count over a cap's solid angle, 2π(1 − cos γ).
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
    // several times the whole sphere's average — a cleared cone would read as a
    // fraction of it, not a multiple
    expect(middle).toBeGreaterThan((3.5 * bg.length) / (4 * Math.PI));
    // LEVEL with the ring outside it, within the 0.8 the counting noise needs:
    // the cap holds few enough stars that a seed roll can fail this.
    expect(middle).toBeGreaterThan(density(0.26, 0.5) * 0.8);
    // …and both stand well clear of the periphery, which is what the
    // concentration is for
    expect(middle).toBeGreaterThan(density(0.5, 1));
  });
});
