import { describe, expect, it } from "vitest";
import { atFrac, rangeOf } from "../story";
import { starRho } from "../../optics/starfield";
import {
  CONST_LINES_LOOK,
  GAP_MAX,
  GAP_RAD,
  HEAD_SOFT,
  SLOT_COUNT,
  lineAlphaAt,
  lineDrawMs,
  lineHeadAt,
  lineInsetAt,
  type Dir3,
} from "../../optics/constellation-lines";
import { BRIGHT_COUNT, SKY, dirOf } from "../../optics/sky";
import {
  CANDIDATE_CDF,
  CANDIDATE_DIRS,
  CANDIDATE_RHO,
  LABELS,
  LABEL_ENTRIES,
  LABEL_SEP,
  LABEL_STARS,
  MAX_TOUCH,
  QUOTE_ATTR,
  QUOTE_CLEAR_RAD,
  QUOTE_DIR,
  QUOTE_TEXT,
  SKY_TYPE_LOOK,
  SPAN_P0,
  SPAN_P1,
  SPAWN_MS,
  arcDist,
  arcsClash,
  arcsCross,
  centreCdf,
  constellationEnvAt,
  inLabelFrame,
  inkOf,
  labelEnvAt,
  pairKey,
  pickLabelStars,
  pickPair,
  quoteEnvAt,
  sampleCdf,
  sepOf,
  strokeClashes,
} from "../constellations";
import { lcg } from "../../core/math";

// Sky chapter: strokes draw on and fade, pairs are reproducible and well
// spread, and every envelope is 0 outside the chapter.

const coR = rangeOf("constellations");
const tR = rangeOf("trails");

// the driver's separation window and stroke clearance, pinned as literals
const MIN_SEP = 0.08;
const MAX_SEP = 0.3;
const CLEAR_RAD = 0.02;

const inWindow = (sep: number, label: string) => {
  expect(sep, label).toBeGreaterThanOrEqual(MIN_SEP);
  expect(sep, label).toBeLessThanOrEqual(MAX_SEP);
};

describe("the pen", () => {
  it("starts at nothing, only moves forward, and arrives exactly once", () => {
    expect(lineHeadAt(0, 1200)).toBe(0);
    expect(lineHeadAt(1200, 1200)).toBe(1);
    expect(lineHeadAt(9999, 1200)).toBe(1);
    // and it has actually travelled in between — not a step at either end
    expect(lineHeadAt(600, 1200)).toBeCloseTo(0.5, 6);
    for (let age = 25; age <= 2400; age += 25)
      expect(lineHeadAt(age, 1200), `age ${age}`) //
        .toBeGreaterThanOrEqual(lineHeadAt(age - 25, 1200));
  });

  it("runs the feather clear of the far end when it lands", () => {
    // the shader draws to head × (1 + HEAD_SOFT), so a landed stroke is full
    // ink to t = 1
    expect(lineHeadAt(1200, 1200) * (1 + HEAD_SOFT)).toBeGreaterThan(1);
    expect(HEAD_SOFT).toBeGreaterThan(0);
    expect(HEAD_SOFT).toBeLessThan(0.5);
  });

  it("takes longer over a longer stroke, within bounds", () => {
    expect(lineDrawMs(MIN_SEP)).toBeLessThanOrEqual(lineDrawMs(MAX_SEP));
    for (const sep of [0, MIN_SEP, 0.2, MAX_SEP, 3]) {
      expect(lineDrawMs(sep)).toBeGreaterThanOrEqual(
        CONST_LINES_LOOK.drawMsMin,
      );
      expect(lineDrawMs(sep)).toBeLessThanOrEqual(CONST_LINES_LOOK.drawMsMax);
    }
  });
});

describe("a stroke's life", () => {
  const draw = 1000;
  const life = 9000;
  const fade = 3500;
  const alpha = (age: number) => lineAlphaAt(age, draw, life, fade);

  it("holds full ink while drawing and living, fades monotonically, then stays gone", () => {
    for (const age of [0, 500, draw, draw + 1, draw + life / 2, draw + life])
      expect(alpha(age), `age ${age}`).toBe(1);
    for (let age = draw + life + 50; age <= draw + life + fade; age += 50)
      expect(alpha(age), `age ${age}`).toBeLessThanOrEqual(alpha(age - 50));
    expect(alpha(draw + life + fade)).toBe(0);
    expect(alpha(draw + life + fade + 60_000)).toBe(0);
    // an unused slot's birth is far in the past and must read exactly 0
    expect(alpha(1e6)).toBe(0);
  });

  it("never recycles a slot that is still on screen", () => {
    // one full turn of the ring buffer must outlast a stroke's lifetime
    const { drawMsMax, lifeMs, fadeMs } = CONST_LINES_LOOK;
    expect(SLOT_COUNT * SPAWN_MS).toBeGreaterThan(drawMsMax + lifeMs + fadeMs);
  });
});

describe("pair picking", () => {
  it("pools every star in the cone that is not backdrop", () => {
    // every star inside the 55° cone except the dim backdrop tier
    expect(CANDIDATE_DIRS.length).toBeGreaterThanOrEqual(60);
    const cos = Math.cos((55 * Math.PI) / 180);
    for (const d of CANDIDATE_DIRS) expect(d[0]).toBeGreaterThan(cos);
    let inCone = 0;
    for (let i = 0; i < BRIGHT_COUNT; i++)
      if (dirOf(SKY.stars[i].az, SKY.stars[i].alt)[0] >= cos) inCone++;
    expect(CANDIDATE_DIRS.length).toBe(inCone);
  });

  it("draws from the middle of the frame far more often than the edge", () => {
    // the centre-weighted pick against a uniform draw over the same pool
    const rng = lcg(31);
    const gamma = (i: number) => Math.acos(Math.min(1, CANDIDATE_DIRS[i][0]));
    const n = CANDIDATE_DIRS.length;
    let weighted = 0;
    let uniform = 0;
    for (let k = 0; k < 2000; k++) {
      weighted += gamma(sampleCdf(CANDIDATE_CDF, rng()));
      uniform += gamma(Math.min(n - 1, Math.floor(rng() * n)));
    }
    // a loose bound: the weighted draw only has to sit nearer the axis
    expect(weighted).toBeLessThan(uniform * 0.85);
    // the edge is rare, not barred
    expect(CANDIDATE_DIRS.some((_, i) => gamma(i) > 0.7)).toBe(true);
  });

  it("samples a cumulative table by its weights", () => {
    // items weighted 1 : 0 : 1 must never yield 1
    const cdf = [1, 1, 2];
    expect([0, 0.49, 0.51, 0.999].map((u) => sampleCdf(cdf, u))) //
      .toEqual([0, 0, 2, 2]);
    // the built table is strictly increasing
    const built = centreCdf(CANDIDATE_DIRS);
    for (let i = 1; i < built.length; i++)
      expect(built[i]).toBeGreaterThan(built[i - 1]);
  });

  it("is reproducible from a seed, down to the generator's own stream", () => {
    const run = () => {
      const rng = lcg(4242);
      return Array.from({ length: 12 }, () =>
        pickPair(rng, CANDIDATE_DIRS, CANDIDATE_CDF, []),
      );
    };
    expect(run()).toEqual(run());
    // and it is not just returning the same pair every time
    expect(new Set(run().map(String)).size).toBeGreaterThan(1);
    const rng = lcg(1);
    expect([rng(), rng(), rng()]).toEqual([
      0.23645552527159452, 0.3692706737201661, 0.5042420323006809,
    ]);
  });

  it("only ever draws inside the separation window", () => {
    const rng = lcg(7);
    for (let k = 0; k < 400; k++) {
      const [i, j] = pickPair(rng, CANDIDATE_DIRS, CANDIDATE_CDF, [])!;
      expect(i).not.toBe(j);
      inWindow(sepOf(CANDIDATE_DIRS[i], CANDIDATE_DIRS[j]), `pair ${i}-${j}`);
    }
  });

  it("refuses the recent set, in either direction", () => {
    const rng = lcg(99);
    const recent: string[] = [];
    for (let k = 0; k < 200; k++) {
      const [i, j] = pickPair(rng, CANDIDATE_DIRS, CANDIDATE_CDF, recent)!;
      const key = pairKey(i, j);
      expect(recent).not.toContain(key);
      // the key is order-free, so the reverse pair is barred as well
      expect(pairKey(j, i)).toBe(key);
      recent.push(key);
      if (recent.length > 6) recent.shift();
    }
  });

  it("never returns a stroke that is already on the sky", () => {
    // Six ring directions, every pairing drawable, three already live: a
    // duplicate would pass the recent set and the shared-endpoint exemption.
    const rho = (MIN_SEP + MAX_SEP / 2) / 2; // ≥ MIN_SEP, and 2ρ ≤ MAX_SEP
    const ring = Array.from({ length: 6 }, (_, k) => {
      const roll = (k / 6) * Math.PI * 2;
      const d: Dir3 = [Math.cos(rho), Math.sin(rho) * Math.cos(roll), Math.sin(rho) * Math.sin(roll)]; // prettier-ignore
      return d;
    });
    for (let a = 0; a < ring.length; a++)
      for (let b = a + 1; b < ring.length; b++)
        inWindow(sepOf(ring[a], ring[b]), `ring ${a}-${b}`);
    const live = [[0, 1], [2, 3], [4, 5]] as const; // prettier-ignore
    const liveKeys = live.map(([a, b]) => pairKey(a, b));
    const rng = lcg(20260812);
    const seen = new Set<string>();
    for (let k = 0; k < 400; k++) {
      const pair = pickPair(rng, ring, centreCdf(ring), [], () => false, live)!;
      const key = pairKey(pair[0], pair[1]);
      expect(liveKeys, `draw ${k}`).not.toContain(key);
      seen.add(key);
    }
    // every other pairing still came back, so the pool is not starved
    expect(seen.size).toBe((ring.length * (ring.length - 1)) / 2 - live.length);
  });

  type Live = readonly [number, number][];
  const clashesLive = (i: number, j: number, live: Live) =>
    live.some(
      ([a, b]) =>
      arcsClash(CANDIDATE_DIRS[i], CANDIDATE_DIRS[j], CANDIDATE_DIRS[a], CANDIDATE_DIRS[b], CLEAR_RAD), // prettier-ignore
    );

  /** The driver's spawn loop in miniature: a sliding window of live strokes
   *  checked with `strokeClashes`, or with `clash` when given. Returns how
   *  many ticks picked a pair. */
  const soak = (
    seed: number,
    onPick: (pair: [number, number], live: Live) => void,
    clash: (i: number, j: number, live: Live) => boolean = strokeClashes,
  ) => {
    const rng = lcg(seed);
    const live: [number, number][] = [];
    let picked = 0;
    for (let k = 0; k < 300; k++) {
      const pair = pickPair(rng, CANDIDATE_DIRS, CANDIDATE_CDF, [], (i, j) => clash(i, j, live), live); // prettier-ignore
      if (!pair) continue; // a starved tick is a legal answer
      picked++;
      onPick(pair, live);
      live.push(pair);
      // about as many strokes as the ring buffer holds
      if (live.length > 13) live.shift();
    }
    return picked;
  };

  it("never returns a pair the overlap test refuses", () => {
    const picked = soak(2026, (pair, live) => {
      expect(clashesLive(pair[0], pair[1], live), `pick ${pair}`).toBe(false);
    });
    // only meaningful if the pool can actually feed the sky
    expect(picked).toBeGreaterThan(200);
  });

  it("keeps every stroke out of the quote's disc, at every tick", () => {
    // the clearance is the quote sprite's half-width plus the stroke clearance
    const Q = SKY_TYPE_LOOK.quote;
    expect(QUOTE_CLEAR_RAD).toBeCloseTo(Q.widthRad / 2 + CLEAR_RAD, 12);
    const clear = ([i, j]: readonly [number, number]) =>
      arcDist(QUOTE_DIR, CANDIDATE_DIRS[i], CANDIDATE_DIRS[j]);
    const picked = soak(2026, (pair, live) => {
      // strokes already on the sky clear it too, whenever they were born
      for (const s of [pair, ...live])
        expect(clear(s), `stroke ${s}`).toBeGreaterThanOrEqual(QUOTE_CLEAR_RAD);
    });
    // the guard does not starve the sky
    expect(picked).toBeGreaterThan(200);
    // without the quote guard, the same seed does draw through the words
    let through = 0;
    soak(2026, (pair) => { if (clear(pair) < QUOTE_CLEAR_RAD) through++; }, clashesLive); // prettier-ignore
    expect(through).toBeGreaterThan(0);
  });

  it("grows what is already on the sky far more often than it starts afresh", () => {
    // picks that share a star with a live stroke, so figures grow
    let joined = 0;
    const picked = soak(11, (pair, live) => {
      if (live.some(([a, b]) => new Set([a, b, ...pair]).size < 4)) joined++;
    });
    expect(picked).toBeGreaterThan(200);
    expect(joined / picked).toBeGreaterThan(0.6);
    // but not all, or no new figure could start
    expect(joined).toBeLessThan(picked);
  });

  it("never lets one star collect more than MAX_TOUCH strokes", () => {
    // keeps a growing figure from becoming a starburst
    soak(7, (pair, live) => {
      for (const i of pair)
        expect(live.flat().filter((k) => k === i).length, `star ${i} is already a hub`).toBeLessThan(MAX_TOUCH); // prettier-ignore
    });
    // and a star already carrying its limit is refused
    const rng = lcg(5);
    const full = Array.from({ length: MAX_TOUCH }, (_, k) => [0, k + 1] as [number, number]); // prettier-ignore
    let picked = 0;
    for (let k = 0; k < 200; k++) {
      const pair = pickPair(rng, CANDIDATE_DIRS, CANDIDATE_CDF, [], () => false, full); // prettier-ignore
      if (!pair) continue;
      picked++;
      expect(pair).not.toContain(0);
    }
    expect(picked).toBeGreaterThan(150);
  });

  it("comes back null rather than spinning when nothing is legal", () => {
    const rng = lcg(1);
    // two directions 90° apart: outside the window, so no attempt can succeed
    const two: Dir3[] = [[1, 0, 0], [0, 1, 0]]; // prettier-ignore
    expect(pickPair(rng, two, centreCdf(two), [])).toBeNull();
    expect(pickPair(rng, two.slice(0, 1), centreCdf(two.slice(0, 1)), [])).toBeNull(); // prettier-ignore
  });
});

describe("no two strokes may cross", () => {
  // Unit vector from up/right angles about the view axis (+X).
  const at = (up: number, right: number): Dir3 => [
    Math.cos(up) * Math.cos(right),
    Math.sin(up),
    Math.cos(up) * Math.sin(right),
  ];
  const hub = at(0, 0);

  // prettier-ignore
  it.each([
    // an X: bottom-left → top-right against top-left → bottom-right, in any
    // order of strokes or ends
    ["an X", [at(-0.1, -0.1), at(0.1, 0.1), at(0.1, -0.1), at(-0.1, 0.1)], true],
    ["an X, ends swapped", [at(0.1, 0.1), at(-0.1, -0.1), at(-0.1, 0.1), at(0.1, -0.1)], true],
    ["an X, strokes swapped", [at(0.1, -0.1), at(-0.1, 0.1), at(-0.1, -0.1), at(0.1, 0.1)], true],
    // junctions are allowed; only crossings are banned
    ["a shared star", [hub, at(0.1, 0.1), hub, at(-0.1, 0.12)], false],
    ["a shared star, ends swapped", [at(0.1, 0.1), hub, at(-0.1, 0.12), hub], false],
    ["a shallow shared star", [hub, at(0.1, 0.1), hub, at(0.1, 0.104)], false],
    ["disjoint strokes", [at(0.2, -0.2), at(0.2, 0.2), at(-0.2, -0.2), at(-0.2, 0.2)], false],
    ["a near miss", [at(-0.1, 0), at(0.1, 0), at(0, -0.2), at(0, -0.001)], false],
    ["the near miss extended", [at(-0.1, 0), at(0.1, 0), at(0, -0.2), at(0, 0.2)], true],
    // collinear arcs have no single intersection; `recent` prevents repeats
    ["a stroke against itself", [hub, at(0.1, 0.1), hub, at(0.1, 0.1)], false],
    // the arcs straddle each other's planes but meet only on the far side
    ["an antipodal intersection", [at(0, 0.4), at(0, 1.2), at(-0.3, -Math.PI / 2), at(0.3, -Math.PI / 2 + 0.2)], false],
  ] as [string, Dir3[], boolean][])("arcsCross: %s", (_, [a, b, c, d], want) => {
    expect(arcsCross(a, b, c, d)).toBe(want);
  });

  it("keeps a near-parallel stroke off an existing one, but lets strokes meet", () => {
    // two strokes a few pixels apart never cross but read as one doubled line
    const a = at(0, -0.1);
    const b = at(0, 0.1);
    const clash = (c: Dir3, d: Dir3) => arcsClash(a, b, c, d, CLEAR_RAD);
    expect(arcsCross(a, b, at(0.004, -0.08), at(0.004, 0.08))).toBe(false);
    expect(clash(at(0.004, -0.08), at(0.004, 0.08))).toBe(true);
    // …and lets it through once it is a stroke's worth of sky away
    expect(clash(at(0.05, -0.08), at(0.05, 0.08))).toBe(false);
    // a crossing is a clash whatever the clearance
    expect(clash(at(-0.05, 0), at(0.05, 0.001))).toBe(true);
    // the shared end is exempt from the clearance check…
    expect(arcsClash(hub, at(0.1, 0.1), hub, at(-0.1, 0.12), CLEAR_RAD)).toBe(false); // prettier-ignore
    // …but a wedge thin enough to read as a doubled line is still refused
    expect(arcsClash(hub, at(0.1, 0.1), hub, at(0.1, 0.104), CLEAR_RAD)).toBe(true); // prettier-ignore
  });
});

describe("the endpoint gap", () => {
  it("is one fixed angle, capped, whatever the stroke's length", () => {
    for (const sep of [MIN_SEP, 0.12, 0.2, MAX_SEP])
      expect(lineInsetAt(sep) * sep, `sep ${sep}`).toBeCloseTo(GAP_RAD, 12);
    // no separation however degenerate can invert a stroke
    for (const sep of [1e-9, 0.001, MIN_SEP, 0.2, MAX_SEP, 3])
      expect(lineInsetAt(sep), `sep ${sep}`).toBeLessThanOrEqual(GAP_MAX);
    expect(GAP_MAX * 2).toBeLessThan(1);
  });

  it("clears every disc in the pool, and leaves a stroke at the shortest separation", () => {
    // the brightest (widest) authored star, with air to spare
    expect(GAP_RAD).toBeGreaterThan(starRho(3.1) * 1.5);
    for (const r of CANDIDATE_RHO) expect(GAP_RAD).toBeGreaterThan(r);
    // both gaps together must leave some stroke
    expect(2 * GAP_RAD).toBeLessThan(MIN_SEP * 0.5);
    expect(2 * lineInsetAt(MIN_SEP)).toBeLessThan(1);
  });
});

describe("the envelopes", () => {
  // prettier-ignore
  it.each([
    // the lines: asleep outside the chapter, full once the sky has settled
    ...[0, coR.p0 - 0.02, coR.p0, tR.p1, tR.p1 + 0.05, 1].map((p) => ["lines", p, 0] as const),
    ...[0.2, 0.4, 0.7, 1].map((f) => ["lines", atFrac(coR, f), 1] as const),
    // gone a quarter of the way into the trails
    ["lines", atFrac(tR, 0.25), 0],
    ["lines", atFrac(tR, 0.5), 0],
    // the quote arrives after the lines are drawing, outlives them, and is
    // gone by the end of the trails
    ["quote", atFrac(coR, 0.2), 0],
    ["quote", atFrac(coR, 0.35), 0],
    ["quote", atFrac(coR, 0.6), 1],
    ["quote", atFrac(tR, 0.5), 1],
    ["quote", tR.p1, 0],
    ["quote", tR.p1 + 0.05, 0],
  ] as const)("%s at p %f is %i", (which, p, want) => {
    expect((which === "lines" ? constellationEnvAt : quoteEnvAt)(p)).toBe(want);
  });

  it("dims the lines on the way down, not a cliff; the names share their envelope", () => {
    const mid = constellationEnvAt(atFrac(tR, 0.12));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(labelEnvAt).toBe(constellationEnvAt);
  });

  // exported for story/cost.ts
  it("sit inside the sky ink's attach window, padded at both ends", () => {
    expect(SPAN_P0).toBeLessThan(coR.p0);
    expect(SPAN_P1).toBeGreaterThan(tR.p1);
    expect(coR.p0 - SPAN_P0).toBeCloseTo(SPAN_P1 - tR.p1, 12);
    for (const f of [constellationEnvAt, quoteEnvAt]) {
      expect(f(SPAN_P0)).toBe(0);
      expect(f(SPAN_P1)).toBe(0);
    }
  });
});

describe("the names", () => {
  const placed = LABEL_ENTRIES.map((e) => e.text);

  it("are non-empty, never repeat, and fit the sprite budget", () => {
    for (const name of [...LABELS, ...placed])
      expect(name.trim().length).toBeGreaterThan(0);
    expect(new Set(LABELS).size).toBe(LABELS.length);
    expect(new Set(placed).size).toBe(placed.length);
    // at most 8 sprites: the label entries plus the one quote
    expect(LABEL_ENTRIES.length + 1).toBeLessThanOrEqual(8);
  });

  it("are the picked stars, in pool order, picked the same way every time", () => {
    expect(placed).toEqual(LABELS.slice(0, LABEL_STARS.length));
    for (let n = 0; n < LABEL_STARS.length; n++)
      expect(LABEL_ENTRIES[n].dir).toBe(CANDIDATE_DIRS[LABEL_STARS[n]]);
    const run = () =>
      pickLabelStars(CANDIDATE_DIRS, CANDIDATE_RHO, {
        eligible: inLabelFrame,
        reserved: [QUOTE_DIR],
        max: LABELS.length,
      });
    expect(run()).toEqual(LABEL_STARS);
  });

  it("sit where they can be read — inside the frame window", () => {
    for (const i of LABEL_STARS)
      expect(inLabelFrame(CANDIDATE_DIRS[i]), `label star ${i}`).toBe(true);
    // the label window is tighter than the strokes' 55° cone
    expect(inLabelFrame([Math.cos(0.9), Math.sin(0.9), 0])).toBe(false);
    expect(inLabelFrame([-1, 0, 0])).toBe(false);
  });

  it("are spread out — no two names inside LABEL_SEP of each other", () => {
    // LABELS is a pool, not a quota
    expect(LABEL_STARS.length).toBeGreaterThanOrEqual(4);
    expect(LABEL_STARS.length).toBeLessThanOrEqual(LABELS.length);
    expect(new Set(LABEL_STARS).size).toBe(LABEL_STARS.length);
    for (let a = 0; a < LABEL_STARS.length; a++)
      for (let b = a + 1; b < LABEL_STARS.length; b++)
        expect(sepOf(CANDIDATE_DIRS[LABEL_STARS[a]], CANDIDATE_DIRS[LABEL_STARS[b]]), `labels ${a} and ${b}`).toBeGreaterThan(LABEL_SEP); // prettier-ignore
  });

  it("take the brightest star of any crowd, and honour the reserved directions", () => {
    // two directions within LABEL_SEP, the fainter listed first
    const near: Dir3 = [Math.cos(0.1), Math.sin(0.1), 0];
    const side: Dir3 = [Math.cos(0.6), 0, Math.sin(0.6)];
    const pick = (dirs: Dir3[], bright: number[], reserved: Dir3[]) =>
      pickLabelStars(dirs, bright, { eligible: () => true, reserved, max: 3 });
    expect(pick([[1, 0, 0], near, side], [1, 9, 5], [])).toEqual([1, 2]);
    expect(pick([[1, 0, 0], side], [9, 5], [[1, 0, 0]])).toEqual([1]);
  });
});

describe("the type", () => {
  const { label, quote } = SKY_TYPE_LOOK;

  it("is inked stronger on paper, and keeps the words above the names", () => {
    // linear-space blending makes dark ink on paper read weaker
    expect(label.ink.light).toBeGreaterThan(label.ink.dark);
    expect(quote.ink.light).toBeGreaterThan(quote.ink.dark);
    for (const light of [false, true]) {
      expect(inkOf(quote.ink, light)).toBeGreaterThan(inkOf(label.ink, light));
      // names stay subtle: never fully opaque
      expect(inkOf(label.ink, light)).toBeGreaterThan(0);
      expect(inkOf(label.ink, light)).toBeLessThan(0.9);
      expect(inkOf(quote.ink, light)).toBeLessThanOrEqual(1);
    }
  });

  it("sets the quotation with typographic punctuation", () => {
    expect(QUOTE_TEXT.startsWith("“")).toBe(true);
    expect(QUOTE_TEXT.endsWith("”")).toBe(true);
    expect(QUOTE_TEXT).toContain("Boredom always precedes");
    expect(QUOTE_TEXT).not.toContain('"');
    expect(QUOTE_ATTR.startsWith("— ")).toBe(true);
    expect(QUOTE_ATTR).toContain("PIRSIG");
  });

  it("hangs the quote in the visible cone, off the axis and above it", () => {
    expect(Math.hypot(...QUOTE_DIR)).toBeCloseTo(1, 12);
    // 25° off the view axis (+X), up (+Y) and to the screen's left (−Z)
    expect(Math.acos(QUOTE_DIR[0])).toBeCloseTo((25 * Math.PI) / 180, 12);
    expect(QUOTE_DIR[1]).toBeGreaterThan(0);
    expect(QUOTE_DIR[2]).toBeLessThan(0);
    // clear of every name
    for (const i of LABEL_STARS)
      expect(sepOf(QUOTE_DIR, CANDIDATE_DIRS[i]), `label star ${i}`) //
        .toBeGreaterThan(LABEL_SEP);
  });
});
