import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { isSegWedge, isShellPart } from "../../core/parts";
import { atFrac, DIVE_P0, rangeOf, windowEdges } from "../story";
import { CARDS_APART } from "../envelopes";
import {
  BODY_FADE_BACK,
  BODY_FADE_OUT,
  CARD_COUNT,
  cardFadeAt,
  cardOrbitAt,
  cardRollAt,
  cardScaleAt,
  cardsFadeOutAt,
  peelBodyFadeAt,
  peelChannelAt,
  peelRollAt,
  MOUNT_HI,
  MOUNT_HYST,
  MOUNT_LO,
  peelSpinAt,
  peelValueAt,
  RELEASE_SPAN,
  segSectorAngle,
  SPIN_SPAN,
  VALLEY,
  WINK_SPAN,
} from "../peelcards";

const peR = rangeOf("peel");
const cdR = rangeOf("cards");
const inR = rangeOf("internals");

// The peel/cards LAWS, not their plumbing. What the scene depends on is that the
// unroll is a saturating pure function of the scroll, that a strip is flat before
// it travels, that every card is out before the shell winks away and gone before
// the internals scene settles, and that the orbit is reproducible.

const SAMPLES = Array.from({ length: 101 }, (_, i) => i / 100);
const KS = Array.from({ length: CARD_COUNT }, (_, k) => k);

describe("the unroll channel", () => {
  it("is exactly 0 through the camera's transit into the scene", () => {
    for (const local of [0, 0.005, 0.01, 0.02])
      expect(peelChannelAt(local), `local ${local}`).toBe(0);
  });

  it("is exactly 1 well before the scene ends", () => {
    for (const local of [0.72, 0.8, 0.95, 1])
      expect(peelChannelAt(local), `local ${local}`).toBe(1);
  });

  it("only ever rises", () => {
    let prev = -1;
    for (const local of SAMPLES) {
      const v = peelChannelAt(local);
      expect(v, `local ${local}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });
});

/** every peel-tube family's wedge indices, in TUBE_FAMILY_ORDER — the cut each
 *  is really segmented on (5-cut on the shell's seams, 7-cut on the cam's) */

describe("the spin", () => {
  const SPAN = Array.from({ length: 201 }, (_, i) => peR.p0 + (i / 200) * 0.2);

  it("is asleep before it opens and spent after it closes", () => {
    // probed off SPIN_SPAN itself: a retune of the window is taste and must not
    // fail a law test — only the shape's edges are the law
    for (const p of [0, 0.05, peR.p0, SPIN_SPAN[0]])
      expect(peelSpinAt(p), `p ${p}`).toBe(0);
    for (const p of [SPIN_SPAN[1], cdR.p1, 1])
      expect(peelSpinAt(p), `p ${p}`).toBe(1);
  });

  it("only ever winds forward", () => {
    let prev = -1;
    for (const p of SPAN) {
      const v = peelSpinAt(p);
      expect(v, `p ${p}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("is STILL AT CRUISE where the cards take over — it does not decelerate in", () => {
    // story/reveal.ts's lesson, in a second place: a smoothstep would be dying
    // right where the card shell has to look like it is continuing the motion.
    // The rate over the handover — the body fade's own out-ramp, read from it —
    // must be the same as the rate well before it.
    //
    // AND THE MARGIN IS THIN, deliberately: the fade's foot sits at spin-local
    // 0.3762 against SPIN_WIND_UP 0.35, so a wind-up retune past 0.376 fails
    // here rather than shipping a decelerating handover. That is the law; the
    // 0.026 of slack is the number to know before touching it.
    const rate = (p: number) => (peelSpinAt(p + 1e-5) - peelSpinAt(p)) / 1e-5;
    const span = SPIN_SPAN[1] - SPIN_SPAN[0];
    const cruise = rate(SPIN_SPAN[0] + 0.9 * span);
    expect(rate(BODY_FADE_OUT[0]), "at the fade's foot").toBeCloseTo(cruise, 6);
    expect(rate(BODY_FADE_OUT[1]), "at the fade's floor").toBeCloseTo(
      cruise,
      6,
    );
    // …and the wind-up really is behind it by then
    expect(rate(SPIN_SPAN[0] + 0.05 * span), "still winding up").toBeLessThan(
      cruise,
    );
  });

  it("lands the lens on a WHOLE number of turns, so the drop to 0 is exact", () => {
    // peelRollAt is hard 0 past its window because the reveal's own roll shares
    // the one setModelOrientation writer. That drop may only ever be the
    // identity, which is what an integer turn count buys.
    const last = peelRollAt(SPIN_SPAN[1] - 1e-9);
    const turns = last / (2 * Math.PI);
    expect(turns, "whole turns").toBeCloseTo(Math.round(turns), 6);
    expect(Math.round(turns), "and it actually turns").not.toBe(0);
    for (const p of [SPIN_SPAN[1], cdR.p1, 0.5, 1])
      expect(Math.abs(peelRollAt(p)), `p ${p}`).toBe(0);
    for (const p of [0, peR.p0, SPIN_SPAN[0]])
      expect(Math.abs(peelRollAt(p)), `p ${p}`).toBe(0);
  });

  it("hands over MONOTONELY: the cards arrive while the lens is still going", () => {
    // The crossfade's structure, pinned without pinning either envelope's
    // edges: over the peel's tail the card field's opacity only ever rises, the
    // spin only ever advances, and the field is fully out before the lens'
    // fade-out floor (hero-driver, cards 0.20) is reached.
    let prevFade = -1;
    for (let i = 0; i <= 100; i++) {
      const local = 0.5 + (i / 100) * 0.5;
      const fade = Math.min(...KS.map((k) => cardFadeAt(k, local)));
      expect(fade, `peel ${local}`).toBeGreaterThanOrEqual(prevFade);
      prevFade = fade;
    }
    for (const k of KS)
      expect(cardFadeAt(k, 1), `card ${k} by the peel's end`).toBe(1);
  });
});

describe("the card cross-fade", () => {
  it("starts once the lens is apart and no card is out before that", () => {
    for (const k of KS) expect(cardFadeAt(k, 0.28), `card ${k}`).toBe(0);
  });

  it("is complete for every card before the body fade lands", () => {
    for (const k of KS) {
      expect(cardFadeAt(k, 0.62), `card ${k}`).toBe(1);
      expect(cardFadeAt(k, 1), `card ${k} past the end`).toBe(1);
    }
  });

  it("is staggered — the cards arrive in order, never together", () => {
    const mid = KS.map((k) => cardFadeAt(k, 0.45));
    for (let k = 1; k < CARD_COUNT; k++)
      expect(mid[k], `card ${k} vs ${k - 1}`).toBeLessThan(mid[k - 1]);
  });
});

describe("the field's fade-out", () => {
  it("hands back to the bare lens inside its OWN scene", () => {
    for (const local of [0.88, 0.95, 1])
      expect(cardsFadeOutAt(local), `local ${local}`).toBe(1);
  });

  it("is still whole while the cards scene is the cards scene", () => {
    expect(cardsFadeOutAt(0)).toBe(0);
    expect(cardsFadeOutAt(0.6)).toBe(0);
    expect(cardsFadeOutAt(0.8)).toBeGreaterThan(0);
    expect(cardsFadeOutAt(0.8)).toBeLessThan(1);
  });
});

// THE CARD SHELL. The field's laws changed shape with the peel re-choreography
// (owner: the lens "is replaced with the cards spinning as a transition"), so
// these pin the NEW ones — a coherent spherical shell — rather than the old run
// of hoops: eight stations on ONE sphere, ONE rotation axis, ONE direction, ONE
// rate, and no second motion of any kind on top. Taste values (the radius, the
// rate) are deliberately NOT pinned; the structure is.
describe("the card shell", () => {
  const TIMES = [0, 250, 1_000, 4_500, 12_000, 47_300, 600_000];

  it("is a pure function of (card, time)", () => {
    for (const k of KS)
      for (const t of TIMES)
        expect(cardOrbitAt(k, t), `card ${k} at ${t}ms`).toEqual(
          cardOrbitAt(k, t),
        );
  });

  it("is a SPHERE: every card is the same distance from the lens, always", () => {
    // An identity, not a bound — that is what makes "the shell clears the model
    // everywhere at once" a fact rather than a per-ring promise. MEASURED off
    // the seated model in the browser: a 4.07 × 3.08 × 3.09 wu world box, i.e. a
    // bounding sphere of √(2.04² + 1.54²) = 2.56 wu.
    const r0 = Math.hypot(...Object.values(cardOrbitAt(0, 0)));
    expect(r0).toBeGreaterThan(2.56);
    for (const k of KS)
      for (const t of TIMES) {
        const o = cardOrbitAt(k, t);
        expect(Math.hypot(o.x, o.y, o.z), `card ${k} at ${t}ms`).toBeCloseTo(
          r0,
          10,
        );
      }
  });

  it("turns about the OPTICAL AXIS, so no card's axial station ever moves", () => {
    for (const k of KS) {
      const x = cardOrbitAt(k, 0).x;
      for (const t of TIMES)
        expect(cardOrbitAt(k, t).x, `card ${k} at ${t}ms`).toBe(x);
    }
    // the eight sit on eight distinct latitudes, none of them a POLE (where a
    // rotation about the axis would leave a card dead still)
    const xs = KS.map((k) => cardOrbitAt(k, 0).x);
    expect(new Set(xs.map((x) => x.toFixed(6))).size).toBe(CARD_COUNT);
    const r0 = Math.hypot(...Object.values(cardOrbitAt(0, 0)));
    for (const k of KS)
      expect(
        Math.hypot(cardOrbitAt(k, 0).y, cardOrbitAt(k, 0).z),
        `card ${k}`,
      ).toBeGreaterThan(0.5 * r0);
  });

  it("advances every card by the SAME angle: one rate, one direction", () => {
    // The rewrite's whole point. The old field gave each card its own ω and
    // ALTERNATED the direction by parity, which is why it read as aimless drift;
    // a shell that turns as one body cannot have either.
    const step = (k: number, t0: number, t1: number) => {
      const a = cardOrbitAt(k, t0);
      const b = cardOrbitAt(k, t1);
      const d = Math.atan2(b.z, b.y) - Math.atan2(a.z, a.y);
      return Math.atan2(Math.sin(d), Math.cos(d));
    };
    for (const [t0, t1] of [
      [0, 250],
      [4_500, 4_750],
      [600_000, 600_250],
    ]) {
      const ds = KS.map((k) => step(k, t0, t1));
      for (const k of KS) {
        expect(ds[k], `card ${k} over [${t0}, ${t1}]`).toBeCloseTo(ds[0], 12);
        expect(Math.sign(ds[k]), `card ${k} direction`).toBe(Math.sign(ds[0]));
      }
      expect(ds[0], "the shell is actually turning").not.toBe(0);
    }
  });

  it("carries NO second motion — no bob, no sway, nothing off the circle", () => {
    // Anything added on top of the rotation (the old vertical bob, the old idle
    // roll sway) shows up as a card leaving its own latitude circle. Sampled
    // densely, because a slow wobble is exactly what a coarse sample misses.
    for (const k of KS) {
      const ring = Math.hypot(cardOrbitAt(k, 0).y, cardOrbitAt(k, 0).z);
      for (let i = 0; i < 400; i++) {
        const o = cardOrbitAt(k, i * 137);
        expect(Math.hypot(o.y, o.z), `card ${k} sample ${i}`).toBeCloseTo(
          ring,
          10,
        );
      }
    }
    // …and the ROLL is a pure function of the scroll now, with no clock at all
    expect(cardRollAt.length, "cardRollAt takes (k, cardsLocal)").toBe(2);
  });

  it("sweeps every card through a real range of camera depths", () => {
    // What the sizes come from: over a pass, a card's own Z (the story cameras
    // sit side-on-ish, ~16 wu out on −Z) swings by twice its latitude circle's
    // radius, so no two cards are at one depth for long.
    for (const k of KS) {
      const zs = Array.from(
        { length: 400 },
        (_, i) => cardOrbitAt(k, i * 500).z,
      );
      expect(Math.max(...zs) - Math.min(...zs), `card ${k}`).toBeGreaterThan(6);
    }
  });

  it("starts every card on its own longitude", () => {
    const phases = KS.map((k) => {
      const o = cardOrbitAt(k, 0);
      return Math.atan2(o.z, o.y);
    });
    for (let a = 0; a < CARD_COUNT; a++)
      for (let b = a + 1; b < CARD_COUNT; b++) {
        // shortest angular distance, so 179° and −179° do not read as far apart
        const d = Math.abs(
          Math.atan2(
            Math.sin(phases[a] - phases[b]),
            Math.cos(phases[a] - phases[b]),
          ),
        );
        expect(d, `cards ${a} and ${b}`).toBeGreaterThan(0.1);
      }
  });

  it("gives the cards their own base sizes, all within a card's worth", () => {
    const s = KS.map(cardScaleAt);
    for (const k of KS) {
      expect(s[k], `card ${k}`).toBeGreaterThanOrEqual(0.85);
      expect(s[k], `card ${k}`).toBeLessThanOrEqual(1.2);
    }
    // more than one size, and not so many that a "size" stops meaning anything
    expect(new Set(s).size).toBeGreaterThan(1);
  });

  it("tips a card in on entry and settles it, on the SCROLL", () => {
    // What survives from the old roll law (owner: "when the cards come off let's
    // have it roll on its side a little bit"): a card arrives tipped over and
    // rights itself on its own fade window, so a scrub replays it exactly.
    for (const k of KS) {
      const entry = Math.abs(cardRollAt(k, 0));
      const rest = Math.abs(cardRollAt(k, 1));
      expect(entry, `card ${k} enters tipped`).toBeGreaterThan(rest);
      expect(rest, `card ${k} keeps a residual`).toBeGreaterThan(0);
      expect(entry, `card ${k} entry is a tip, not a tumble`).toBeLessThan(0.5);
    }
  });
});

describe("the whole peel channel", () => {
  it("is asleep outside the two scenes it belongs to", () => {
    for (const p of [0, peR.p0 - 0.01, peR.p0, cdR.p1, cdR.p1 + 0.05, 1])
      expect(peelValueAt(p), `p ${p}`).toBe(0);
  });

  it("holds fully unrolled to the end of the peel scene", () => {
    for (const f of [0.72, 0.85, 1])
      expect(peelValueAt(atFrac(peR, f)), `peel ${f}`).toBe(1);
  });

  it("is spent before the departure opens — the two never share a wedge", () => {
    // the unroll and the reverse reassembly are two unwrap chains on one wedge,
    // so the release runs to EXACTLY 0 at the rise's foot rather than fading
    // under a cover
    const apart = windowEdges(CARDS_APART.rise)[0];
    expect(peelValueAt(apart), "spent where the departure opens").toBe(0);
    for (const p of [RELEASE_SPAN[1], VALLEY[0], cdR.p1])
      expect(peelValueAt(p), `p ${p}`).toBe(0);
    const mid = peelValueAt((RELEASE_SPAN[0] + RELEASE_SPAN[1]) / 2);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });
});

// THE VALLEY, and the four things that live inside it. It is THE load-bearing
// structure of the peel→cards seam: the body fade's envelope is exactly 0 across
// it, so the lens is out of core/scene's applyVisibility entirely and every snap
// the chapter has to make is put in there. Its four edges used to be literals
// copied into three modules and re-typed as bare numbers here; they are
// story/peelcards.ts's now, and these are the containments — move the envelope
// and something fails HERE rather than becoming a visible pop in a scroll nobody
// re-checks.
describe("the body fade's valley", () => {
  it("is EXACTLY 0 across the valley, and exactly 1 at both far ends", () => {
    // not "≈0": both smoothsteps saturate, which is what takes the meshes out of
    // the visibility pass rather than merely making them faint
    for (let i = 0; i <= 200; i++)
      expect(
        peelBodyFadeAt(VALLEY[0] + ((VALLEY[1] - VALLEY[0]) * i) / 200),
        `valley ${i / 200}`,
      ).toBe(0);
    for (const p of [0, peR.p0, BODY_FADE_OUT[0]])
      expect(peelBodyFadeAt(p), `p ${p}`).toBe(1);
    for (const p of [BODY_FADE_BACK[1], inR.p0, inR.p1, 1])
      expect(peelBodyFadeAt(p), `p ${p}`).toBe(1);
  });

  it("never goes over 1 or under 0 anywhere on the track", () => {
    // the two terms are added, not composed, so an overlap of the out-ramp and
    // the back-ramp would drive the channel past 1 — core/scene clamps, but the
    // shape would no longer be the one every gate below is timed against
    for (let i = 0; i <= 1000; i++) {
      const v = peelBodyFadeAt(i / 1000);
      expect(v, `p ${i / 1000}`).toBeGreaterThanOrEqual(0);
      expect(v, `p ${i / 1000}`).toBeLessThanOrEqual(1);
    }
  });

  it("hides the WINK inside the valley, where it belongs again", () => {
    // the shell and the interior are filed out of applyVisibility behind the
    // body fade's 0-stretch, so the internals scene opens on the bare mechanism
    expect(WINK_SPAN[0]).toBeGreaterThanOrEqual(VALLEY[0]);
    expect(WINK_SPAN[1]).toBeLessThanOrEqual(VALLEY[1]);
    expect(peelBodyFadeAt(WINK_SPAN[0]), "nothing is drawn there").toBe(0);
    expect(peelBodyFadeAt(WINK_SPAN[1])).toBe(0);
    // …and it is spent a whole scene before the internals scene settles
    expect(WINK_SPAN[1]).toBeLessThan(inR.p0);
  });

  it("hides the spin's STOP — the one place the angular rate steps", () => {
    expect(SPIN_SPAN[1]).toBeGreaterThan(VALLEY[0]);
    expect(SPIN_SPAN[1]).toBeLessThan(VALLEY[1]);
    expect(peelBodyFadeAt(SPIN_SPAN[1]), "and the lens is gone there").toBe(0);
  });

  // …AND HIDES IT ON THE CLOCK THE WRITER ACTUALLY USES. The containment above
  // is a statement about ONE p. It only buys the guarantee — the rate step
  // happens behind a lens nobody can see — while the roll and the body fade are
  // sampled at the SAME p, which is the raw one frame() writes the fade, the
  // per-piece drift and the card field from. story/hero-driver.ts's single
  // setModelOrientation writer moved onto the render loop for the reveal's sake
  // and takes its OTHER term from the eased story channel; this pins that the
  // peel's term did not come along.
  it("hides it on ONE clock — and the peel's roll is written on the RAW p", () => {
    // the whole margin is the valley's tail past the stop: 0.0062 of the track
    const slack = VALLEY[1] - SPIN_SPAN[1];
    expect(slack).toBeGreaterThan(0);
    expect(slack).toBeLessThan(0.01);
    // core/scene's tick() eases with EASE = 0.12, so a channel read there trails
    // the raw position by Σ(1−EASE)ⁿ = 7.33 frames of whatever the scroll is
    // doing. Against that slack the guarantee breaks at 0.00084 p/frame — at
    // 60 Hz over a 14.7-screenful track, 0.75 screenfuls/second, which is a
    // reading flick, not a fling. Past it the body fades back IN on a lens still
    // turning at cruise (−146 rad per unit p here), which then stops dead.
    const EASE_LAG_FRAMES = 0.88 / 0.12;
    expect(slack / EASE_LAG_FRAMES).toBeLessThan(0.001);
    const rate = (p: number) => (peelRollAt(p + 1e-7) - peelRollAt(p)) / 1e-7;
    expect(Math.abs(rate(SPIN_SPAN[1] - 1e-5))).toBeGreaterThan(100);
    expect(rate(SPIN_SPAN[1] + 1e-5)).toBe(0);
    // the counterfactual, at 1.5× that threshold speed: raw p is past the
    // valley's far edge — the lens is back in the visibility pass — while a
    // lagged sample is still short of the stop, i.e. still at cruise
    const lag = EASE_LAG_FRAMES * 1.5 * (slack / EASE_LAG_FRAMES);
    const pRaw = VALLEY[1] + 0.2 * slack;
    expect(peelBodyFadeAt(pRaw), "the lens is drawn again").toBeGreaterThan(0);
    expect(pRaw - lag).toBeLessThan(SPIN_SPAN[1]);
    expect(
      Math.abs(rate(pRaw - lag)),
      "and a lagged clock would still be turning at cruise under it",
    ).toBeGreaterThan(100);
    // …so the writer takes this term at frame()'s own raw p. The reveal's term
    // keeps the eased channels — that is the fast-scroll fix — but they are two
    // clocks in one call, deliberately, and this is the structural guard on it.
    const driver = fs.readFileSync(
      new URL("../hero-driver.ts", import.meta.url),
      "utf8",
    );
    expect(driver).toMatch(/peelRollAt\(lastP\)/);
    expect(driver).not.toMatch(/peelRollAt\(pE\)/);
  });

  it("takes the DEPARTURE'S CHANNEL home inside it", () => {
    // the wrap's fall is the one snap the valley still has to cover: the
    // recipe's ladder moves the mechanism the wink KEEPS, so the channel must
    // read 0 before the body fade brings it back
    const [f0, f1] = windowEdges(CARDS_APART.fall);
    expect(f0).toBeGreaterThanOrEqual(VALLEY[0]);
    expect(f1).toBeLessThanOrEqual(VALLEY[1]);
    expect(peelBodyFadeAt(f0), "nothing is drawn there").toBe(0);
    expect(peelBodyFadeAt(f1)).toBe(0);
  });

  it("puts the lens back BEFORE the internals scene opens on it", () => {
    // the whole point of the return: the internals scene still starts on exactly
    // the mechanism it always did, with no fade running under its first frame
    expect(BODY_FADE_BACK[1]).toBeLessThan(inR.p0);
    expect(peelBodyFadeAt(inR.p0)).toBe(1);
  });

  it("owns the channel all the way to the DIVE's first frame", () => {
    // THE RANGE-TILED WRITER MAP. hero-driver writes this envelope for every
    // p < DIVE_P0 and story/fly.ts owns setBodyFade from DIVE_P0 on (its own
    // half is pinned in story-fly.test.ts). The tile used to end at the
    // flythrough scene's p0 instead, which left [internals p1, DIVE_P0] with no
    // owner at all — and applyBodyFade holds its last level on an unchanged
    // write, so one frame(p) jumping out of the valley into that band left the
    // lens hidden for the whole approach with nothing to restore it.
    expect(DIVE_P0).toBeGreaterThan(inR.p1);
    for (let i = 0; i <= 200; i++)
      expect(
        peelBodyFadeAt(inR.p0 + ((DIVE_P0 - inR.p0) * i) / 200),
        `approach ${i / 200}`,
      ).toBe(1);
  });
});

// --- the shipped geometry ---------------------------------------------------
// The two claims this module makes ABOUT THE MODEL, pinned against the model
// (core/__tests__/shell-parts.test.ts's reader, for its reason): which sector
// each piece of the shell's cast sits on, and that a part offset written in the
// gltf frame is a radial offset in the world frame. A lens_work re-export that
// re-cuts the seams, renumbers them, moves a marking or introduces a rotation
// anywhere above a strip must fail HERE, not as ink floating in mid-air in a
// scroll nobody re-checks.

interface Gltf {
  nodes: {
    name: string;
    mesh?: number;
    children?: number[];
    translation?: [number, number, number];
    rotation?: number[];
    scale?: number[];
    matrix?: number[];
  }[];
  meshes: { primitives: { attributes: { POSITION: number } }[] }[];
  accessors: { min: number[]; max: number[] }[];
}

function gltfJson(path: string): Gltf {
  const buf = fs.readFileSync(path);
  let off = 12;
  let json: Gltf | null = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    if (buf.readUInt32LE(off + 4) === 0x4e4f534a)
      json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString("utf8"));
    off += 8 + len;
  }
  return json!;
}

interface Strip {
  name: string;
  seg: number;
  /** bounding-box centre direction in the gltf radial plane — the quantity a
   *  runtime Box3 walk would measure */
  angle: number;
  /** the centre's own optical-axis height (gltf +Y), in model mm */
  y: number;
  /** does anything from this mesh up to the root turn or scale its frame? */
  posed: boolean;
  /** the sum of every translation from this mesh up to the root — where the
   *  piece's own local origin sits in the gltf frame */
  origin: [number, number, number];
}

/** Every mesh of the peel's drifting cast, measured in the gltf frame —
 *  `segOf` picks which cast (the shell's strips, or the baffles). */
function centres(segOf: (name: string) => number | undefined): Strip[] {
  const gltf = gltfJson("public/models/lens_web_segmented.glb");
  const parent = new Map<number, number>();
  gltf.nodes.forEach((n, i) =>
    (n.children ?? []).forEach((c) => parent.set(c, i)),
  );
  return gltf.nodes.flatMap((n, i) => {
    const seg = segOf(n.name);
    if (seg === undefined || n.mesh === undefined) return [];
    const acc =
      gltf.accessors[gltf.meshes[n.mesh].primitives[0].attributes.POSITION];
    const c = [0, 1, 2].map((k) => (acc.min[k] + acc.max[k]) / 2);
    const t = [0, 0, 0];
    let posed = false;
    for (
      let up: number | undefined = i;
      up !== undefined;
      up = parent.get(up)
    ) {
      const nd = gltf.nodes[up];
      if (nd.translation) for (const k of [0, 1, 2]) t[k] += nd.translation[k];
      if (nd.rotation || nd.scale || nd.matrix) posed = true;
    }
    for (const k of [0, 1, 2]) c[k] += t[k];
    // the radial plane is X–Z; +Y is the optical axis
    return [
      {
        name: n.name,
        seg,
        angle: Math.atan2(c[2], c[0]),
        y: c[1],
        posed,
        origin: t as [number, number, number],
      },
    ];
  });
}

describe("the card field's mount window", () => {
  // Newly EXPORTED so story/cost.ts can count the eight draws at p without
  // spelling this window a second time — pinned here, where it is owned.

  it("mounts a whole scene early and leaves before the dive", () => {
    // the eight texture uploads (~80ms) land in the zoom's quiet beat, not on
    // the peel's first frames
    expect(MOUNT_LO).toBe(rangeOf("zoom").p0);
    expect(MOUNT_LO).toBeLessThan(peR.p0);
    // …and the tail is the cards scene's own end: the field is spent inside the
    // scene (it dissolves as the pieces fly home under it), so nothing is left
    // to draw past this edge and no invisible card survives into the internals
    // scene or the fly-through
    expect(MOUNT_HI).toBe(cdR.p1);
    expect(MOUNT_HI).toBeLessThan(DIVE_P0);
    expect(MOUNT_HI).toBeLessThanOrEqual(inR.p0);
    expect(cardsFadeOutAt(1), "the field is gone by the scene's end").toBe(1);
  });

  it("covers the whole span the cards are ever drawn over", () => {
    for (const p of [cdR.p0, cdR.p1, atFrac(cdR, 0.5), peR.p0])
      expect(p, `card p ${p}`).toBeGreaterThanOrEqual(MOUNT_LO);
    expect(cdR.p1).toBeLessThanOrEqual(MOUNT_HI);
  });

  it("pads the unmount, and by less than the window it guards", () => {
    expect(MOUNT_HYST).toBeGreaterThan(0);
    expect(MOUNT_HYST).toBeLessThan((MOUNT_HI - MOUNT_LO) / 2);
  });
});

/** every `<family>_SegN` wedge of the shell cast, off the shipped GLB */
const stripCentres = () =>
  centres((n) => {
    const m = /_Seg(\d+)$/.exec(n);
    return m && isShellPart(n) && isSegWedge(n) ? Number(m[1]) : undefined;
  });

/** shortest angular distance, in degrees */
const apart = (a: number, b: number) =>
  (Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * 180) / Math.PI;

describe("the shell's seam convention", () => {
  const wedges = stripCentres();

  it("is five sectors on each of five families — 25 wedges", () => {
    expect(wedges).toHaveLength(25);
    for (const seg of [0, 1, 2, 3, 4])
      expect(wedges.filter((w) => w.seg === seg)).toHaveLength(5);
  });

  it("puts every wedge on the sector segSectorAngle names for it", () => {
    // 10°: the residual is the bounding box's own asymmetry. Half a sector is
    // 36°, so this cannot admit the wrong sector. The card field's own
    // longitudes are seeded off this law (cardPhaseAt).
    for (const w of wedges)
      expect(apart(w.angle, segSectorAngle(w.seg)), w.name).toBeLessThan(10);
  });
});
