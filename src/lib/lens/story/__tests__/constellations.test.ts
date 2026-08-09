import { describe, expect, it } from "vitest";
import { atFrac, rangeOf } from "../story";
import { starRho } from "../../optics/starfield";
import {
  CONST_LINES_LOOK,
  GAP_MAX,
  HEAD_SOFT,
  LINE_GAP,
  SLOT_COUNT,
  lineAlphaAt,
  lineDrawMs,
  lineHeadAt,
  lineInsetAt,
} from "../../optics/constellation-lines";
import { KEYHOLE_DIR } from "../../optics/sky";
import {
  CANDIDATE_DIRS,
  CANDIDATE_RHO,
  KEYHOLE_LABEL,
  LABELS,
  LABEL_ENTRIES,
  LABEL_SEP,
  LABEL_STARS,
  QUOTE_ATTR,
  QUOTE_DIR,
  QUOTE_TEXT,
  SKY_TYPE_LOOK,
  SPAWN_MS,
  asterismDropRad,
  constellationEnvAt,
  inLabelFrame,
  inkOf,
  labelEnvAt,
  labelWidthRad,
  lcg,
  pairKey,
  pickLabelStars,
  pickPair,
  quoteEnvAt,
  sepOf,
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
const MAX_SEP = 0.4;

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
  it("has a pool worth picking from", () => {
    expect(CANDIDATE_DIRS.length).toBeGreaterThanOrEqual(12);
    // every candidate is inside the ~55° cone about the view axis (world +X)
    for (const d of CANDIDATE_DIRS)
      expect(d[0]).toBeGreaterThan(Math.cos((55 * Math.PI) / 180));
  });

  it("is reproducible from a seed", () => {
    const run = () => {
      const rng = lcg(4242);
      return Array.from({ length: 12 }, () =>
        pickPair(rng, CANDIDATE_DIRS, []),
      );
    };
    expect(run()).toEqual(run());
    // and it is not just returning the same pair every time
    expect(new Set(run().map(String)).size).toBeGreaterThan(1);
  });

  it("only ever draws inside the separation window", () => {
    const rng = lcg(7);
    for (let k = 0; k < 400; k++) {
      const pair = pickPair(rng, CANDIDATE_DIRS, []);
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
      const pair = pickPair(rng, CANDIDATE_DIRS, recent);
      expect(pair, `draw ${k}`).not.toBeNull();
      const key = pairKey(pair![0], pair![1]);
      expect(recent).not.toContain(key);
      // the key is order-free, so the reverse pair is barred as well
      expect(pairKey(pair![1], pair![0])).toBe(key);
      recent.push(key);
      if (recent.length > 6) recent.shift();
    }
  });

  it("comes back null rather than spinning when nothing is legal", () => {
    const rng = lcg(1);
    // two directions 90° apart: outside the window, so no attempt can succeed
    expect(
      pickPair(
        rng,
        [
          [1, 0, 0],
          [0, 1, 0],
        ],
        [],
      ),
    ).toBeNull();
    expect(pickPair(rng, [[1, 0, 0]], [])).toBeNull();
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

describe("the endpoint gaps", () => {
  const MAX_MAG = 3.1; // the authored catalog's brightest, i.e. the widest disc

  it("clears the disc on the worst case there is", () => {
    // the shortest legal stroke drawn to the biggest disc in the catalog: a
    // purely proportional gap (LINE_GAP × sep) would end UNDER that disc
    const rho = starRho(MAX_MAG);
    expect(LINE_GAP * MIN_SEP).toBeLessThan(rho); // the bug this law fixes
    expect(lineInsetAt(MIN_SEP, rho) * MIN_SEP).toBeGreaterThan(rho);
  });

  it("clears every disc on every legal pair in the real pool", () => {
    let pairs = 0;
    for (let i = 0; i < CANDIDATE_DIRS.length; i++)
      for (let j = i + 1; j < CANDIDATE_DIRS.length; j++) {
        const sep = sepOf(CANDIDATE_DIRS[i], CANDIDATE_DIRS[j]);
        if (sep < MIN_SEP || sep > MAX_SEP) continue;
        pairs++;
        for (const k of [i, j])
          expect(
            lineInsetAt(sep, CANDIDATE_RHO[k]) * sep,
            `pair ${i}-${j} at star ${k}`,
          ).toBeGreaterThan(CANDIDATE_RHO[k]);
      }
    expect(pairs).toBeGreaterThan(20); // the sweep actually swept something
  });

  it("falls back to the proportional gap on a long stroke, and is capped", () => {
    // a wide pair round a faint star: the disc term is the smaller of the two
    expect(lineInsetAt(MAX_SEP, starRho(1.2))).toBe(LINE_GAP);
    // and no inset can ever eat a stroke from both ends at once
    for (const sep of [1e-9, 0.001, MIN_SEP, 0.2, MAX_SEP, 3])
      expect(
        lineInsetAt(sep, starRho(MAX_MAG)),
        `sep ${sep}`,
      ).toBeLessThanOrEqual(GAP_MAX);
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
  const every = [...LABELS, KEYHOLE_LABEL];
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

  it("are the picked stars in pool order, then the Keyhole", () => {
    expect(placed).toEqual([
      ...LABELS.slice(0, LABEL_STARS.length),
      KEYHOLE_LABEL,
    ]);
    for (let n = 0; n < LABEL_STARS.length; n++)
      expect(LABEL_ENTRIES[n].dir).toBe(CANDIDATE_DIRS[LABEL_STARS[n]]);
    // a star's name takes the shared offset; only the Keyhole overrides it
    for (let n = 0; n < LABEL_STARS.length; n++) {
      expect(LABEL_ENTRIES[n].rightRad).toBeUndefined();
      expect(LABEL_ENTRIES[n].downRad).toBeUndefined();
    }
  });

  it("go on stars that are picked the same way every time", () => {
    const run = () =>
      pickLabelStars(CANDIDATE_DIRS, CANDIDATE_RHO, {
        eligible: inLabelFrame,
        reserved: [KEYHOLE_DIR, QUOTE_DIR],
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
    // today's catalog yields five (LABELS is a pool, not a quota — see
    // LABEL_STARS); the floor is what makes a sky with names on it
    expect(LABEL_STARS.length).toBeGreaterThanOrEqual(4);
    expect(LABEL_STARS.length).toBeLessThanOrEqual(LABELS.length);
    expect(new Set(LABEL_STARS).size).toBe(LABEL_STARS.length);
    for (let a = 0; a < LABEL_STARS.length; a++) {
      // …and each clears the Keyhole's own heading, which is reserved before
      // the first pick so its label cannot land on top of a star's
      const dir = CANDIDATE_DIRS[LABEL_STARS[a]];
      expect(
        sepOf(dir, KEYHOLE_DIR),
        `label ${a} vs the Keyhole`,
      ).toBeGreaterThan(LABEL_SEP);
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

  it("step the Keyhole's name clear of its own shape", () => {
    // THE BUG THIS PINS: the Keyhole's name anchors on the asterism's MEAN
    // heading, so the shared offset (a couple of hundredths of a radian) left it
    // lying across the middle of the shape as a permanent strike-through.
    const keyhole = LABEL_ENTRIES.at(-1)!;
    expect(keyhole.text).toBe(KEYHOLE_LABEL);
    const drop = asterismDropRad("keyhole", KEYHOLE_DIR);
    // the shape really does reach well below its own mean — otherwise this test
    // would pass on a default offset and prove nothing
    expect(drop).toBeGreaterThan(0.15);
    expect(drop).toBeGreaterThan(SKY_TYPE_LOOK.label.downRad);
    // …and the name clears the lowest star, its disc, and its own half-height
    const halfBox = (SKY_TYPE_LOOK.label.boxPx * SKY_TYPE_LOOK.pxRad) / 2;
    expect(keyhole.downRad!).toBeGreaterThan(drop + halfBox);
    // it steps LEFT as well, so it reads as centred under the shape rather than
    // hung off the bottom-right corner
    expect(keyhole.rightRad!).toBeCloseTo(
      -labelWidthRad(KEYHOLE_LABEL) / 2,
      12,
    );
    expect(keyhole.rightRad!).toBeLessThan(0);
    // and it is still on the screen after stepping down
    expect(
      Math.atan2(KEYHOLE_DIR[1], KEYHOLE_DIR[0]) - keyhole.downRad!,
    ).toBeGreaterThan((-30 * Math.PI) / 180);
  });

  it("read a missing asterism as no drop at all", () => {
    expect(asterismDropRad("no-such-shape", KEYHOLE_DIR)).toBe(0);
  });

  it("share the strokes' envelope exactly", () => {
    // ONE LAW: the names and the lines are the same gesture, and the alias is
    // what a future edit has to break deliberately rather than by drift.
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
    // lands above its nominal alpha, dark ink over paper far below it (measured
    // ~0.63 against ~0.26 of full contrast at one and the same 0.55). Parity is
    // bought with a higher alpha on the light stage — never a lower one.
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

  it("picks the stage's number", () => {
    expect(inkOf({ dark: 0.1, light: 0.9 }, true)).toBe(0.9);
    expect(inkOf({ dark: 0.1, light: 0.9 }, false)).toBe(0.1);
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
