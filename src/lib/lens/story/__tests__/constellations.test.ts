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
  lcg,
  pairKey,
  pickLabelStars,
  pickPair,
  quoteEnvAt,
  sampleCdf,
  sepOf,
  strokeClashes,
} from "../constellations";

// The sky chapter's LAWS, not its plumbing. What the scene depends on is that a
// stroke is DRAWN (a head that starts at nothing, travels, and arrives), that it
// then goes away on its own, that the pairs are reproducible and well-spread,
// and that both envelopes are dead everywhere outside the chapter.

const coR = rangeOf("constellations");
const tR = rangeOf("trails");

// the separation window and the recent depth the driver is authored against —
// pinned as literals so a tune of either has to come past this file
const MIN_SEP = 0.08;
const MAX_SEP = 0.3;
const CLEAR_RAD = 0.02;

describe("the pen", () => {
  it("starts at nothing and arrives exactly once", () => {
    expect(lineHeadAt(0, 1200)).toBe(0);
    expect(lineHeadAt(1200, 1200)).toBe(1);
    expect(lineHeadAt(9999, 1200)).toBe(1);
    // and it has actually travelled in between — not a step at either end
    expect(lineHeadAt(600, 1200)).toBeCloseTo(0.5, 6);
  });

  it("only ever moves forward", () => {
    let prev = -1;
    for (let age = 0; age <= 2400; age += 25) {
      const h = lineHeadAt(age, 1200);
      expect(h, `age ${age}`).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });

  it("runs the feather clear of the far end when it lands", () => {
    // the shader drives the pen to head × (1 + HEAD_SOFT), so a finished stroke
    // is at full ink all the way to t = 1 — a soft edge that never lands would
    // leave every completed line permanently frayed
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

  it("holds at full ink while it is drawing and while it lives", () => {
    for (const age of [0, 500, draw, draw + 1, draw + life / 2, draw + life])
      expect(alpha(age), `age ${age}`).toBe(1);
  });

  it("is gone after life + fade, and stays gone", () => {
    expect(alpha(draw + life + fade)).toBe(0);
    expect(alpha(draw + life + fade + 60_000)).toBe(0);
    // a slot that has never been used carries a birth stamp far in the past;
    // its alpha must be a hard zero, not an epsilon
    expect(alpha(1e6)).toBe(0);
  });

  it("fades monotonically in between", () => {
    let prev = 2;
    for (let age = draw + life; age <= draw + life + fade; age += 50) {
      const a = alpha(age);
      expect(a, `age ${age}`).toBeLessThanOrEqual(prev);
      prev = a;
    }
  });

  it("never recycles a slot that is still on screen", () => {
    // THE RING BUFFER'S ONE INVARIANT: a full turn of the buffer at the
    // driver's cadence has to outlast a stroke, or a spawn would blank a line
    // mid-life. Both halves come from the shipped constants.
    const lifetime =
      CONST_LINES_LOOK.drawMsMax +
      CONST_LINES_LOOK.lifeMs +
      CONST_LINES_LOOK.fadeMs;
    expect(SLOT_COUNT * SPAWN_MS).toBeGreaterThan(lifetime);
  });
});

describe("pair picking", () => {
  it("pools every star in the cone that is not backdrop", () => {
    // lines may join ANY star, not only the authored ones —
    // so the pool is the whole catalog inside the cone MINUS the dim tier
    expect(CANDIDATE_DIRS.length).toBeGreaterThanOrEqual(60);
    const cos = Math.cos((55 * Math.PI) / 180);
    for (const d of CANDIDATE_DIRS) expect(d[0]).toBeGreaterThan(cos);
    // EXACTLY the non-dim prefix inside that cone: one short and a bright star
    // is unreachable, one over and a backdrop speck can carry ink
    let inCone = 0;
    for (let i = 0; i < BRIGHT_COUNT; i++)
      if (dirOf(SKY.stars[i].az, SKY.stars[i].alt)[0] >= cos) inCone++;
    expect(CANDIDATE_DIRS.length).toBe(inCone);
  });

  it("draws from the middle of the frame far more often than the edge", () => {
    // "priority in the center": the pick is weighted, not the pool. Measured
    // against a UNIFORM draw over the same pool, which is the thing it replaces.
    const rng = lcg(31);
    const gamma = (i: number) => Math.acos(Math.min(1, CANDIDATE_DIRS[i][0]));
    let weighted = 0;
    let uniform = 0;
    const n = 2000;
    for (let k = 0; k < n; k++) {
      weighted += gamma(sampleCdf(CANDIDATE_CDF, rng()));
      uniform += gamma(
        Math.min(
          CANDIDATE_DIRS.length - 1,
          Math.floor(rng() * CANDIDATE_DIRS.length),
        ),
      );
    }
    // 0.85 is a loose LAW bound, not a pin on CENTRE_SIGMA_RAD: what has to hold
    // is only that the weighted draw sits nearer the axis than a uniform one.
    expect(weighted / n).toBeLessThan((uniform / n) * 0.85);
    // the edge is rare, not barred: a pool this size still reaches its far half
    const far = CANDIDATE_DIRS.filter((_, i) => gamma(i) > 0.7).length;
    expect(far).toBeGreaterThan(0);
  });

  it("samples a cumulative table by its weights", () => {
    // structure, not look: three items weighted 1 : 0 : 1 must never yield 1
    const cdf = [1, 1, 2];
    expect(sampleCdf(cdf, 0)).toBe(0);
    expect(sampleCdf(cdf, 0.49)).toBe(0);
    expect(sampleCdf(cdf, 0.51)).toBe(2);
    expect(sampleCdf(cdf, 0.999)).toBe(2);
    // and the builder is monotone increasing, so it is a usable table
    const built = centreCdf(CANDIDATE_DIRS);
    for (let i = 1; i < built.length; i++)
      expect(built[i]).toBeGreaterThan(built[i - 1]);
  });

  it("is reproducible from a seed", () => {
    const run = () => {
      const rng = lcg(4242);
      return Array.from({ length: 12 }, () =>
        pickPair(rng, CANDIDATE_DIRS, CANDIDATE_CDF, []),
      );
    };
    expect(run()).toEqual(run());
    // and it is not just returning the same pair every time
    expect(new Set(run().map(String)).size).toBeGreaterThan(1);
  });

  it("only ever draws inside the separation window", () => {
    const rng = lcg(7);
    for (let k = 0; k < 400; k++) {
      const pair = pickPair(rng, CANDIDATE_DIRS, CANDIDATE_CDF, []);
      expect(pair).not.toBeNull();
      const [i, j] = pair!;
      expect(i).not.toBe(j);
      const sep = sepOf(CANDIDATE_DIRS[i], CANDIDATE_DIRS[j]);
      expect(sep, `pair ${i}-${j}`).toBeGreaterThanOrEqual(MIN_SEP);
      expect(sep, `pair ${i}-${j}`).toBeLessThanOrEqual(MAX_SEP);
    }
  });

  it("refuses the recent set, in either direction", () => {
    const rng = lcg(99);
    const recent: string[] = [];
    for (let k = 0; k < 200; k++) {
      const pair = pickPair(rng, CANDIDATE_DIRS, CANDIDATE_CDF, recent);
      expect(pair, `draw ${k}`).not.toBeNull();
      const key = pairKey(pair![0], pair![1]);
      expect(recent).not.toContain(key);
      // the key is order-free, so the reverse pair is barred as well
      expect(pairKey(pair![1], pair![0])).toBe(key);
      recent.push(key);
      if (recent.length > 6) recent.shift();
    }
  });

  it("never returns a stroke that is already on the sky", () => {
    // A DUPLICATE PASSES EVERY OTHER GUARD: the recent set remembers fewer
    // spawns than a stroke stays visible for, and the clash test exempts a
    // shared endpoint. Driven over a six-direction ring where every pairing is
    // drawable and three are already up, so the collision is not a rarity.
    const rho = (MIN_SEP + MAX_SEP / 2) / 2; // ≥ MIN_SEP, and 2ρ ≤ MAX_SEP
    const ring = Array.from({ length: 6 }, (_, k) => {
      const roll = (k / 6) * Math.PI * 2;
      return [
        Math.cos(rho),
        Math.sin(rho) * Math.cos(roll),
        Math.sin(rho) * Math.sin(roll),
      ] as const;
    });
    // the fixture only proves anything if every pairing really is drawable
    for (let a = 0; a < ring.length; a++)
      for (let b = a + 1; b < ring.length; b++) {
        const sep = sepOf(ring[a], ring[b]);
        expect(sep, `ring ${a}-${b}`).toBeGreaterThanOrEqual(MIN_SEP);
        expect(sep, `ring ${a}-${b}`).toBeLessThanOrEqual(MAX_SEP);
      }
    const live = [
      [0, 1],
      [2, 3],
      [4, 5],
    ] as const;
    const liveKeys = new Set(live.map(([a, b]) => pairKey(a, b)));
    const rng = lcg(20260812);
    const seen = new Set<string>();
    for (let k = 0; k < 400; k++) {
      const pair = pickPair(rng, ring, centreCdf(ring), [], () => false, live);
      expect(pair, `draw ${k}`).not.toBeNull();
      const key = pairKey(pair![0], pair![1]);
      expect(liveKeys.has(key), `draw ${k} repeats live stroke ${key}`).toBe(
        false,
      );
      seen.add(key);
    }
    // …and it refused ONLY those: every other pairing came back, so what is
    // being measured is the duplicate guard and not a starved pool
    expect(seen.size).toBe((ring.length * (ring.length - 1)) / 2 - live.length);
  });

  /** THE DRIVER'S SPAWN LOOP, in miniature: a sliding window of live strokes and
   *  the driver's own clash test (`strokeClashes`) taken against it — the
   *  inputs `createStoryConstellations` assembles each spawn tick. `clash`
   *  swaps that test out, for measuring what a guard is worth. */
  const soak = (
    seed: number,
    ticks: number,
    onPick?: (
      pair: [number, number],
      live: readonly [number, number][],
    ) => void,
    clash: (
      i: number,
      j: number,
      live: readonly [number, number][],
    ) => boolean = strokeClashes,
  ) => {
    const rng = lcg(seed);
    const live: [number, number][] = [];
    let picked = 0;
    for (let k = 0; k < ticks; k++) {
      const pair = pickPair(
        rng,
        CANDIDATE_DIRS,
        CANDIDATE_CDF,
        [],
        (i, j) => clash(i, j, live),
        live,
      );
      if (!pair) continue; // a starved tick is a legal answer
      picked++;
      onPick?.(pair, live);
      live.push(pair);
      // the ring buffer holds a dozen or so strokes at a time
      if (live.length > 13) live.shift();
    }
    return picked;
  };

  it("never returns a pair the overlap test refuses", () => {
    const picked = soak(2026, 300, (pair, live) => {
      for (const [a, b] of live)
        expect(
          arcsClash(
            CANDIDATE_DIRS[pair[0]],
            CANDIDATE_DIRS[pair[1]],
            CANDIDATE_DIRS[a],
            CANDIDATE_DIRS[b],
            CLEAR_RAD,
          ),
          `pick ${pair} clashes with ${a}-${b}`,
        ).toBe(false);
    });
    // the test proves something only if the pool could actually feed the sky
    expect(picked).toBeGreaterThan(200);
  });

  it("keeps every stroke out of the quote's disc, at every tick", () => {
    // the words hang at QUOTE_DIR; a stroke through them is a line drawn across
    // type. The clearance is the sprite's own half-width plus the strokes'
    // clearance — derived, so a wider quote reserves more sky.
    const Q = SKY_TYPE_LOOK.quote;
    expect(QUOTE_CLEAR_RAD).toBeCloseTo(Q.widthRad / 2 + CLEAR_RAD, 12);
    expect(QUOTE_CLEAR_RAD).toBeGreaterThan(Q.widthRad / 2);
    const clear = ([i, j]: readonly [number, number]) =>
      arcDist(QUOTE_DIR, CANDIDATE_DIRS[i], CANDIDATE_DIRS[j]);
    const picked = soak(2026, 300, (pair, live) => {
      expect(clear(pair), `pick ${pair}`).toBeGreaterThanOrEqual(
        QUOTE_CLEAR_RAD,
      );
      // and nothing already on the sky is inside it either: the guard is not
      // gated on the quote's envelope, so a stroke born early still clears it
      for (const s of live)
        expect(clear(s), `live ${s}`).toBeGreaterThanOrEqual(QUOTE_CLEAR_RAD);
    });
    // the guard does not starve the sky
    expect(picked).toBeGreaterThan(200);
    // …and it is doing the work: with only the stroke-on-stroke test, the same
    // seed does put lines through the words
    let through = 0;
    soak(
      2026,
      300,
      (pair) => {
        if (clear(pair) < QUOTE_CLEAR_RAD) through++;
      },
      (i, j, live) =>
        live.some(([a, b]) =>
          arcsClash(
            CANDIDATE_DIRS[i],
            CANDIDATE_DIRS[j],
            CANDIDATE_DIRS[a],
            CANDIDATE_DIRS[b],
            CLEAR_RAD,
          ),
        ),
    );
    expect(through).toBeGreaterThan(0);
  });

  it("grows what is already on the sky far more often than it starts afresh", () => {
    // stars that already have a connection are prioritized, so the sky reads as
    // a few connected figures rather than scattered singles. Counted over the
    // driver's own loop: picks that share a star with a live stroke.
    let joined = 0;
    const picked = soak(11, 300, (pair, live) => {
      if (live.some(([a, b]) => new Set([a, b, ...pair]).size < 4)) joined++;
    });
    expect(picked).toBeGreaterThan(200);
    expect(joined / picked).toBeGreaterThan(0.6);
    // …and not ALL of them, or no second figure could ever start
    expect(joined).toBeLessThan(picked);
  });

  it("never lets one star collect more than MAX_TOUCH strokes", () => {
    // the bound that keeps a growing figure from turning into a starburst
    soak(7, 300, (pair, live) => {
      const touch = new Map<number, number>();
      for (const s of live)
        for (const k of s) touch.set(k, (touch.get(k) ?? 0) + 1);
      for (const i of pair)
        expect(touch.get(i) ?? 0, `star ${i} is already a hub`).toBeLessThan(
          MAX_TOUCH,
        );
    });
  });

  it("refuses a star that is already carrying its limit", () => {
    // structure, not probability: a saturated star is out of the pick whichever
    // branch an attempt takes, as an anchor and as a far end alike
    const rng = lcg(5);
    // MAX_TOUCH strokes already ending on candidate 0, each with a different
    // partner so nothing else is saturated with it
    const live = Array.from(
      { length: MAX_TOUCH },
      (_, k) => [0, k + 1] as [number, number],
    );
    let picked = 0;
    for (let k = 0; k < 200; k++) {
      const pair = pickPair(
        rng,
        CANDIDATE_DIRS,
        CANDIDATE_CDF,
        [],
        () => false,
        live,
      );
      if (!pair) continue;
      picked++;
      expect(pair).not.toContain(0);
    }
    expect(picked).toBeGreaterThan(150);
  });

  it("comes back null rather than spinning when nothing is legal", () => {
    const rng = lcg(1);
    // two directions 90° apart: outside the window, so no attempt can succeed
    const two = [
      [1, 0, 0],
      [0, 1, 0],
    ] as const;
    expect(pickPair(rng, two, centreCdf(two), [])).toBeNull();
    const one = [[1, 0, 0]] as const;
    expect(pickPair(rng, one, centreCdf(one), [])).toBeNull();
  });

  it("is reproducible in the generator itself", () => {
    // the LCG is optics/sky.ts's, copied because it is private there — pin the
    // stream so a stray edit to the constants cannot silently reshuffle it
    const rng = lcg(1);
    expect([rng(), rng(), rng()]).toEqual([
      0.23645552527159452, 0.3692706737201661, 0.5042420323006809,
    ]);
  });
});

describe("no two strokes may cross", () => {
  // Unit vectors on the sphere, built from screen-ish angles about the view
  // axis so the cases read the way they look on the page.
  const at = (up: number, right: number) =>
    [
      Math.cos(up) * Math.cos(right),
      Math.sin(up),
      Math.cos(up) * Math.sin(right),
    ] as const;

  it("catches a transversal crossing", () => {
    // an X: one stroke bottom-left → top-right, the other top-left → bottom-right
    expect(
      arcsCross(at(-0.1, -0.1), at(0.1, 0.1), at(0.1, -0.1), at(-0.1, 0.1)),
    ).toBe(true);
    // …and the order of the two strokes, and of each stroke's ends, is immaterial
    expect(
      arcsCross(at(0.1, 0.1), at(-0.1, -0.1), at(-0.1, 0.1), at(0.1, -0.1)),
    ).toBe(true);
    expect(
      arcsCross(at(0.1, -0.1), at(-0.1, 0.1), at(-0.1, -0.1), at(0.1, 0.1)),
    ).toBe(true);
  });

  it("lets two strokes MEET at a shared star", () => {
    // what is banned is lines drawn ACROSS lines, not a chart's own junctions
    const hub = at(0, 0);
    expect(arcsCross(hub, at(0.1, 0.1), hub, at(-0.1, 0.12))).toBe(false);
    expect(arcsCross(at(0.1, 0.1), hub, at(-0.1, 0.12), hub)).toBe(false);
    // even when the two strokes leave the hub at a very shallow angle
    expect(arcsCross(hub, at(0.1, 0.1), hub, at(0.1, 0.104))).toBe(false);
  });

  it("leaves disjoint strokes alone", () => {
    expect(
      arcsCross(at(0.2, -0.2), at(0.2, 0.2), at(-0.2, -0.2), at(-0.2, 0.2)),
    ).toBe(false);
    // a NEAR MISS: the second stroke stops just short of the first
    expect(arcsCross(at(-0.1, 0), at(0.1, 0), at(0, -0.2), at(0, -0.001))).toBe(
      false,
    );
    // …and crosses once it is extended past it
    expect(arcsCross(at(-0.1, 0), at(0.1, 0), at(0, -0.2), at(0, 0.2))).toBe(
      true,
    );
  });

  it("keeps a near-parallel stroke off an existing one", () => {
    // THE ARTIFACT THIS CATCHES, which crossing alone does not: two strokes a
    // couple of pixels apart never intersect and still land on the page as one
    // doubled line.
    const a = at(0, -0.1);
    const b = at(0, 0.1);
    const near = [at(0.004, -0.08), at(0.004, 0.08)] as const;
    expect(arcsCross(a, b, near[0], near[1])).toBe(false);
    expect(arcsClash(a, b, near[0], near[1], CLEAR_RAD)).toBe(true);
    // …and lets it through once it is a stroke's worth of sky away
    const far = [at(0.05, -0.08), at(0.05, 0.08)] as const;
    expect(arcsClash(a, b, far[0], far[1], CLEAR_RAD)).toBe(false);
    // a crossing is a clash whatever the clearance
    expect(arcsClash(a, b, at(-0.05, 0), at(0.05, 0.001), CLEAR_RAD)).toBe(
      true,
    );
  });

  it("still lets two strokes meet at a shared star", () => {
    const hub = at(0, 0);
    // the shared end is exempt — measured, it would read as zero clearance
    expect(arcsClash(hub, at(0.1, 0.1), hub, at(-0.1, 0.12), CLEAR_RAD)).toBe(
      false,
    );
    // …but a wedge thin enough to read as a doubled line is still refused
    expect(arcsClash(hub, at(0.1, 0.1), hub, at(0.1, 0.104), CLEAR_RAD)).toBe(
      true,
    );
  });

  it("says no to a stroke against itself", () => {
    // collinear great circles have no single intersection to test; `recent` is
    // what keeps a repeat off the sky, not this
    const a = at(0, 0);
    const b = at(0.1, 0.1);
    expect(arcsCross(a, b, a, b)).toBe(false);
  });

  it("cannot be fooled by the ANTIPODAL intersection", () => {
    // two great circles meet twice. These arcs straddle each other's PLANE — the
    // cheap sign test passes — but their crossing point is on the far side of
    // the sphere, so nothing is drawn across anything.
    const a = at(0, 0.4);
    const b = at(0, 1.2);
    const c = at(-0.3, -Math.PI / 2);
    const d = at(0.3, -Math.PI / 2 + 0.2);
    expect(arcsCross(a, b, c, d)).toBe(false);
  });
});

describe("the endpoint gap", () => {
  it("is the same angle whatever the stroke's length", () => {
    // a gap written as a FRACTION of the segment would stand a long stroke off
    // its stars further than a short one
    for (const sep of [MIN_SEP, 0.12, 0.2, MAX_SEP])
      expect(lineInsetAt(sep) * sep, `sep ${sep}`).toBeCloseTo(GAP_RAD, 12);
  });

  it("clears the biggest disc in the catalog with air to spare", () => {
    const rho = starRho(3.1); // the authored table's brightest, i.e. widest
    expect(GAP_RAD).toBeGreaterThan(rho * 1.5);
    // …and every star the pool can actually offer, on the shortest legal stroke
    for (const r of CANDIDATE_RHO) expect(GAP_RAD).toBeGreaterThan(r);
  });

  it("leaves a stroke to draw at the shortest legal separation", () => {
    // the degenerate guard lives in the driver's window: both gaps together
    // must not eat the segment
    expect(2 * GAP_RAD).toBeLessThan(MIN_SEP * 0.5);
    expect(2 * lineInsetAt(MIN_SEP)).toBeLessThan(1);
  });

  it("is capped, so no separation however degenerate can invert a stroke", () => {
    for (const sep of [1e-9, 0.001, MIN_SEP, 0.2, MAX_SEP, 3])
      expect(lineInsetAt(sep), `sep ${sep}`).toBeLessThanOrEqual(GAP_MAX);
    expect(GAP_MAX * 2).toBeLessThan(1);
  });
});

describe("the lines envelope", () => {
  it("is asleep everywhere outside the sky chapter", () => {
    for (const p of [0, coR.p0 - 0.02, coR.p0, tR.p1, tR.p1 + 0.05, 1])
      expect(constellationEnvAt(p), `p ${p}`).toBe(0);
  });

  it("is full once the sky scene has settled", () => {
    for (const f of [0.2, 0.4, 0.7, 1])
      expect(constellationEnvAt(atFrac(coR, f)), `local ${f}`).toBe(1);
  });

  it("is gone by a quarter of the way into the trails", () => {
    expect(constellationEnvAt(atFrac(tR, 0.25))).toBe(0);
    // …and on its way down before that, not a cliff at the end
    const mid = constellationEnvAt(atFrac(tR, 0.12));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

describe("the names", () => {
  const every = [...LABELS];
  const placed = LABEL_ENTRIES.map((e) => e.text);

  it("are non-empty and never repeat", () => {
    for (const name of [...every, ...placed])
      expect(name.trim().length).toBeGreaterThan(0);
    expect(new Set(every).size).toBe(every.length);
    expect(new Set(placed).size).toBe(placed.length);
  });

  it("stay inside the sprite budget", () => {
    // the phase plan's perf line: ≤ 8 label/quote sprites, one draw each. The
    // entries plus the one quote is exactly what the driver builds.
    expect(LABEL_ENTRIES.length + 1).toBeLessThanOrEqual(8);
  });

  it("are the picked stars, in pool order", () => {
    expect(placed).toEqual(LABELS.slice(0, LABEL_STARS.length));
    for (let n = 0; n < LABEL_STARS.length; n++)
      expect(LABEL_ENTRIES[n].dir).toBe(CANDIDATE_DIRS[LABEL_STARS[n]]);
  });

  it("go on stars that are picked the same way every time", () => {
    const run = () =>
      pickLabelStars(CANDIDATE_DIRS, CANDIDATE_RHO, {
        eligible: inLabelFrame,
        reserved: [QUOTE_DIR],
        max: LABELS.length,
      });
    expect(run()).toEqual(run());
    expect(run()).toEqual(LABEL_STARS);
  });

  it("sit where they can be read — inside the frame window", () => {
    for (const i of LABEL_STARS)
      expect(inLabelFrame(CANDIDATE_DIRS[i]), `label star ${i}`).toBe(true);
    // the window is a good deal tighter than the strokes' 55° cone, or a name
    // would hang off the edge of the canvas
    expect(inLabelFrame([Math.cos(0.9), Math.sin(0.9), 0])).toBe(false);
    expect(inLabelFrame([-1, 0, 0])).toBe(false);
  });

  it("are spread out — no two names inside LABEL_SEP of each other", () => {
    // LABELS is a pool, not a quota; the floor is what makes a sky with names
    expect(LABEL_STARS.length).toBeGreaterThanOrEqual(4);
    expect(LABEL_STARS.length).toBeLessThanOrEqual(LABELS.length);
    expect(new Set(LABEL_STARS).size).toBe(LABEL_STARS.length);
    for (let a = 0; a < LABEL_STARS.length; a++) {
      const dir = CANDIDATE_DIRS[LABEL_STARS[a]];
      for (let b = a + 1; b < LABEL_STARS.length; b++)
        expect(
          sepOf(dir, CANDIDATE_DIRS[LABEL_STARS[b]]),
          `labels ${a} and ${b}`,
        ).toBeGreaterThan(LABEL_SEP);
    }
  });

  it("take the brightest star of any crowd, not the first one found", () => {
    // three directions: two of them within LABEL_SEP of each other, and the
    // FAINTER of that pair listed first
    const near: [number, number, number] = [Math.cos(0.1), Math.sin(0.1), 0];
    const dirs = [[1, 0, 0], near, [Math.cos(0.6), 0, Math.sin(0.6)]] as const;
    const picked = pickLabelStars(dirs, [1, 9, 5], {
      eligible: () => true,
      reserved: [],
      max: 3,
    });
    expect(picked).toEqual([1, 2]);
  });

  it("honour the reserved directions", () => {
    const dirs = [
      [1, 0, 0],
      [Math.cos(0.6), 0, Math.sin(0.6)],
    ] as const;
    expect(
      pickLabelStars(dirs, [9, 5], {
        eligible: () => true,
        reserved: [[1, 0, 0]],
        max: 3,
      }),
    ).toEqual([1]);
  });

  it("stand off their star by the one shared offset", () => {
    // every name hangs off a POINT — right of the star and a little below —
    // with no per-entry override to drift
    expect(SKY_TYPE_LOOK.label.rightRad).toBeGreaterThan(0);
    expect(SKY_TYPE_LOOK.label.downRad).toBeGreaterThan(0);
    for (const e of LABEL_ENTRIES)
      expect(Object.keys(e).sort()).toEqual(["dir", "text"]);
  });

  it("share the strokes' envelope exactly", () => {
    // the names and the lines are the same gesture, held by an alias so a
    // future edit has to break it deliberately
    expect(labelEnvAt).toBe(constellationEnvAt);
    for (const f of [0, 0.1, 0.3, 0.6, 1])
      expect(labelEnvAt(atFrac(coR, f))).toBe(
        constellationEnvAt(atFrac(coR, f)),
      );
  });
});

describe("the type's ink", () => {
  const { label, quote } = SKY_TYPE_LOOK;

  it("is written stronger on paper than on the night sky", () => {
    // The renderer composites in LINEAR space: cream ink over a near-black sky
    // lands above its nominal alpha, dark ink over paper far below it, so
    // parity costs a HIGHER alpha on the light stage.
    expect(label.ink.light).toBeGreaterThan(label.ink.dark);
    expect(quote.ink.light).toBeGreaterThan(quote.ink.dark);
  });

  it("keeps the words above the names in both themes", () => {
    for (const light of [false, true]) {
      expect(inkOf(quote.ink, light)).toBeGreaterThan(inkOf(label.ink, light));
      // …and the names stay SUBTLE either way: never fully opaque ink
      expect(inkOf(label.ink, light)).toBeGreaterThan(0);
      expect(inkOf(label.ink, light)).toBeLessThan(0.9);
      expect(inkOf(quote.ink, light)).toBeLessThanOrEqual(1);
    }
  });
});

describe("the quotation", () => {
  it("is set with typographic punctuation", () => {
    expect(QUOTE_TEXT.startsWith("“")).toBe(true);
    expect(QUOTE_TEXT.endsWith("”")).toBe(true);
    expect(QUOTE_TEXT).toContain("Boredom always precedes");
    expect(QUOTE_TEXT).not.toContain('"');
    expect(QUOTE_ATTR.startsWith("— ")).toBe(true);
    expect(QUOTE_ATTR).toContain("PIRSIG");
  });

  it("hangs in the visible cone, off the axis and above it", () => {
    const len = Math.hypot(...QUOTE_DIR);
    expect(len).toBeCloseTo(1, 12);
    // 25° off the view axis (+X), up (+Y) and to the screen's left (−Z)
    expect(Math.acos(QUOTE_DIR[0])).toBeCloseTo((25 * Math.PI) / 180, 12);
    expect(QUOTE_DIR[1]).toBeGreaterThan(0);
    expect(QUOTE_DIR[2]).toBeLessThan(0);
    // and clear of every name, so the words never land on one
    for (const i of LABEL_STARS)
      expect(
        sepOf(QUOTE_DIR, CANDIDATE_DIRS[i]),
        `label star ${i}`,
      ).toBeGreaterThan(LABEL_SEP);
  });
});

describe("the quote envelope", () => {
  it("arrives after the lines are already drawing", () => {
    expect(quoteEnvAt(atFrac(coR, 0.35))).toBe(0);
    expect(quoteEnvAt(atFrac(coR, 0.2))).toBe(0);
    expect(quoteEnvAt(atFrac(coR, 0.6))).toBe(1);
  });

  it("outlives them, and is gone by the end of the trails", () => {
    // the lines are long dead here; the words are still on the sky
    expect(constellationEnvAt(atFrac(tR, 0.5))).toBe(0);
    expect(quoteEnvAt(atFrac(tR, 0.5))).toBe(1);
    expect(quoteEnvAt(tR.p1)).toBe(0);
    expect(quoteEnvAt(tR.p1 + 0.05)).toBe(0);
  });
});

describe("the sky ink's attach window", () => {
  // EXPORTED for story/cost.ts, which counts the stroke draw and the sprite
  // slots and may not re-spell this window. Pinned where it lives.

  it("spans the whole chapter, padded at both ends", () => {
    expect(SPAN_P0).toBeLessThan(coR.p0);
    expect(SPAN_P1).toBeGreaterThan(tR.p1);
    expect(coR.p0 - SPAN_P0).toBeCloseTo(SPAN_P1 - tR.p1, 12);
  });

  it("holds every mark this module draws", () => {
    // nothing of the chapter's ink is nonzero outside it — lines, labels, quote
    for (const at of [constellationEnvAt, labelEnvAt, quoteEnvAt]) {
      expect(at(SPAN_P0)).toBe(0);
      expect(at(SPAN_P1)).toBe(0);
    }
    expect(constellationEnvAt(atFrac(coR, 0.5))).toBeGreaterThan(0);
  });
});
