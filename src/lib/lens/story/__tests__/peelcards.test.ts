import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { isSegWedge, isShellPart } from "../../core/parts";
import { NUM } from "../../ops/algebra";
import { gate } from "../../ops/gate";
import { makeRecipes } from "../../ops/recipes";
import { STORY_R, atFrac, DIVE_P0, rangeOf, windowEdges } from "../story";
import { frameZoom } from "../../core/scene";
import {
  CARDS_APART,
  DIP,
  HUDDLE,
  UPRIGHT,
  assembleAt,
  huddleAt,
  uprightAt,
} from "../envelopes";
import {
  CARD_COUNT,
  cardFadeAt,
  cardGatherAt,
  cardOrbitAt,
  cardRollAt,
  cardScaleAt,
  cardsFadeOutAt,
  peelRollAt,
  peelRollFracAt,
  peelTurnAt,
  MOUNT_HI,
  MOUNT_HYST,
  MOUNT_LO,
  peelTurnFracAt,
  ROLL_SPAN,
  segSectorAngle,
  TURN_SPAN,
  WINK_SPAN,
  cardFitOf,
} from "../peelcards";

const peR = rangeOf("peel");
const cdR = rangeOf("cards");
const inR = rangeOf("internals");

// The peel/cards LAWS, not their plumbing. What the scene depends on is that the
// lens' turn is a saturating pure function of the scroll, that the sides are
// gone before the cards arrive and the cards gone before the internals scene
// settles, and that the orbit is reproducible.

const KS = Array.from({ length: CARD_COUNT }, (_, k) => k);

/** the departure's REAL gate — the shipped recipe at its shipped knobs, so the
 *  wink's law below is checked against the flight the shader plays, not a
 *  transcription of it. */
const ASSEMBLE = makeRecipes(NUM).assemble;
const ASSEMBLE_GATE = ASSEMBLE.gateSpec(ASSEMBLE.knobDefaults);

/** The gate's other key, SWEPT rather than transcribed: the model carries a
 *  different `layerPhase` set per family (5-cut and 7-cut families disagree),
 *  and the gate is monotone in it, so a sweep of [0, 1] covers whatever a
 *  re-export ships. */
const LAYER_PHASES = Array.from({ length: 11 }, (_, i) => i / 10);

/** every peel-tube family's wedge indices, in TUBE_FAMILY_ORDER — the cut each
 *  is really segmented on (5-cut on the shell's seams, 7-cut on the cam's) */

describe("the bore roll", () => {
  it("is asleep before it opens and spent after it closes", () => {
    for (const p of [0, peR.p0, ROLL_SPAN[0]])
      expect(peelRollFracAt(p), `p ${p}`).toBe(0);
    for (const p of [ROLL_SPAN[1], cdR.p0, 1])
      expect(peelRollFracAt(p), `p ${p}`).toBe(1);
  });

  it("lands on a WHOLE number of revolutions, so the drop to 0 is exact", () => {
    // peelRollAt is hard 0 past its window because the model's orientation is
    // one snap-per-call write — the same law the turn carries.
    const turns = peelRollAt(ROLL_SPAN[1] - 1e-9) / (2 * Math.PI);
    expect(turns, "whole turns").toBeCloseTo(Math.round(turns), 6);
    expect(Math.round(turns), "and it actually rolls").not.toBe(0);
    for (const p of [0, peR.p0, ROLL_SPAN[0], ROLL_SPAN[1], cdR.p0, 1])
      expect(Math.abs(peelRollAt(p)), `p ${p}`).toBe(0);
  });

  it("is SPENT before the turn and the dip open — a roll, not a precession", () => {
    // it rides the model's `x`, which is a roll about the bore only while the
    // turn's `y` and the dip's `z` are 0 (the driver's one write composes
    // Rx·Ry·Rz). Both of those open at the cards scene's foot.
    expect(ROLL_SPAN[1]).toBeLessThanOrEqual(TURN_SPAN[0]);
    expect(ROLL_SPAN[1]).toBeLessThanOrEqual(windowEdges(DIP.rise)[0]);
  });

  it("SETTLES on screen — the rate is 0 at both edges", () => {
    const rate = (p: number) =>
      (peelRollFracAt(p + 1e-6) - peelRollFracAt(p)) / 1e-6;
    const span = ROLL_SPAN[1] - ROLL_SPAN[0];
    const mid = rate(ROLL_SPAN[0] + 0.5 * span);
    expect(rate(ROLL_SPAN[0] + 0.01 * span), "opening").toBeLessThan(mid * 0.2);
    expect(rate(ROLL_SPAN[1] - 0.01 * span), "closing").toBeLessThan(mid * 0.2);
  });

  it("keeps the roll on the RAW p — its neighbours' own clock", () => {
    const driver = fs.readFileSync(
      new URL("../hero-driver.ts", import.meta.url),
      "utf8",
    );
    expect(driver).toMatch(/peelRollAt\(lastP\)/);
    expect(driver).not.toMatch(/peelRollAt\(pE\)/);
  });
});

describe("the turn", () => {
  // TURN_SPAN-derived, with a margin either side: an absolute-p width would
  // silently stop covering the window when a hold weight moves.
  const SPAN = Array.from(
    { length: 201 },
    (_, i) =>
      TURN_SPAN[0] - 0.02 + (i / 200) * (TURN_SPAN[1] - TURN_SPAN[0] + 0.04),
  );

  it("is asleep before it opens and spent after it closes", () => {
    // probed off TURN_SPAN itself: a retune of the window is taste and must not
    // fail a law test — only the shape's edges are the law
    for (const p of [0, 0.05, peR.p0, TURN_SPAN[0]])
      expect(peelTurnFracAt(p), `p ${p}`).toBe(0);
    for (const p of [TURN_SPAN[1], inR.p1, 1])
      expect(peelTurnFracAt(p), `p ${p}`).toBe(1);
  });

  it("only ever winds forward", () => {
    let prev = -1;
    for (const p of SPAN) {
      const v = peelTurnFracAt(p);
      expect(v, `p ${p}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it("SETTLES on screen — the rate is 0 at both edges", () => {
    // there is no body fade over this scene, so the turn cannot end on a rate
    // step: it accelerates in and decelerates out, and the mid-window rate is
    // the fastest the lens ever turns.
    const rate = (p: number) =>
      (peelTurnFracAt(p + 1e-5) - peelTurnFracAt(p)) / 1e-5;
    const span = TURN_SPAN[1] - TURN_SPAN[0];
    const mid = rate(TURN_SPAN[0] + 0.5 * span);
    expect(rate(TURN_SPAN[0] + 0.01 * span), "opening").toBeLessThan(mid * 0.2);
    expect(rate(TURN_SPAN[1] - 0.01 * span), "closing").toBeLessThan(mid * 0.2);
  });

  it("lands the lens on a WHOLE number of revolutions, so the drop to 0 is exact", () => {
    // peelTurnAt is hard 0 past its window because the model's orientation is
    // one snap-per-call write. That drop may only ever be the identity, which
    // is what an integer revolution count buys.
    const last = peelTurnAt(TURN_SPAN[1] - 1e-9);
    const turns = last / (2 * Math.PI);
    expect(turns, "whole turns").toBeCloseTo(Math.round(turns), 6);
    expect(Math.round(turns), "and it actually turns").not.toBe(0);
    for (const p of [TURN_SPAN[1], inR.p1, 0.5, 1])
      expect(Math.abs(peelTurnAt(p)), `p ${p}`).toBe(0);
    for (const p of [0, peR.p0, TURN_SPAN[0]])
      expect(Math.abs(peelTurnAt(p)), `p ${p}`).toBe(0);
  });

  it("is spent EXACTLY where the lens stands up", () => {
    // the owner's hand-off: the turn carries on through the tip and stops on
    // the frame the bore reaches vertical, where a rotation about world +Y no
    // longer moves it at all — so the scene leads into the internals rather
    // than stopping first.
    expect(TURN_SPAN[1]).toBe(windowEdges(UPRIGHT.rise)[1]);
    expect(uprightAt(TURN_SPAN[1])).toBe(1);
  });

  it("hands over MONOTONELY: the cards arrive while the lens is still going", () => {
    // The crossfade's structure, pinned without pinning either envelope's
    // edges: over the cards scene the field's opacity only ever rises, the turn
    // only ever advances, and every card is fully out before the scene ends.
    let prevFade = -1;
    for (let i = 0; i <= 100; i++) {
      const local = 0.3 + (i / 100) * 0.7;
      const fade = Math.min(...KS.map((k) => cardFadeAt(k, local)));
      expect(fade, `cards ${local}`).toBeGreaterThanOrEqual(prevFade);
      prevFade = fade;
    }
    for (const k of KS)
      expect(cardFadeAt(k, 1), `card ${k} by the scene's end`).toBe(1);
  });
});

describe("the card cross-fade", () => {
  it("holds off until the turn is under way", () => {
    for (const k of KS) expect(cardFadeAt(k, 0.2), `card ${k}`).toBe(0);
  });

  it("is complete for every card before the field dissolves", () => {
    for (const k of KS) {
      expect(cardFadeAt(k, 0.7), `card ${k}`).toBe(1);
      expect(cardFadeAt(k, 1), `card ${k} past the end`).toBe(1);
    }
  });

  it("is staggered — the cards arrive in order, never together", () => {
    const mid = KS.map((k) => cardFadeAt(k, 0.4));
    for (let k = 1; k < CARD_COUNT; k++)
      expect(mid[k], `card ${k} vs ${k - 1}`).toBeLessThan(mid[k - 1]);
  });
});

describe("the field's fade-out", () => {
  it("hands back to the bare lens inside its OWN scene", () => {
    for (const local of [0.97, 0.99, 1])
      expect(cardsFadeOutAt(local), `local ${local}`).toBe(1);
  });

  it("is still whole while the cards scene is the cards scene", () => {
    expect(cardsFadeOutAt(0)).toBe(0);
    expect(cardsFadeOutAt(0.8)).toBe(0);
    expect(cardsFadeOutAt(0.92)).toBeGreaterThan(0);
    expect(cardsFadeOutAt(0.92)).toBeLessThan(1);
  });
});

// THE CARD SHELL. The field's laws changed shape with the peel re-choreography
// (the lens is replaced by the spinning cards, as a transition), so
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
    // What survives from the old roll law (a card rolls on its side a little
    // as it comes off): a card arrives tipped over and
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

// WHAT COVERS THE CHAPTER'S ONE SNAP, now that nothing fades the lens out: the
// departed casts' own wink. These are the containments — move a window and it
// fails here rather than as a visible pop in a scroll nobody re-checks.
describe("the field's gather — what the middle of the scene is about", () => {
  it("forms as the field arrives, and is spent before it goes", () => {
    // the gather is the shape the deck ARRIVES in, subordinate to the pieces
    // still leaving: it runs under the fade-in and is done by the dissolve
    expect(cardGatherAt(0.35)).toBe(0);
    expect(cardGatherAt(1)).toBe(1);
    // monotone, and actually moving across the middle
    let prev = -1;
    for (let i = 0; i <= 100; i++) {
      const v = cardGatherAt(i / 100);
      expect(v, `local ${i / 100}`).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(cardGatherAt(0.6)).toBeGreaterThan(0.2);
    expect(cardGatherAt(0.6)).toBeLessThan(0.8);
  });

  it("flattens the shell onto ONE ring and draws it in", () => {
    // the sphere's stations converge to the equator and the radius pulls in, so
    // the field reads as a carousel passing the lens rather than a shell around
    // it. Same eight quads: no draw, no upload, no residency change.
    const axialSpread = (g: number) =>
      Math.max(...KS.map((k) => Math.abs(cardOrbitAt(k, 0, g).x)));
    expect(axialSpread(1)).toBeLessThan(axialSpread(0) * 0.05);
    const radius = (g: number) => {
      const o = cardOrbitAt(0, 0, g);
      return Math.hypot(o.x, o.y, o.z);
    };
    expect(radius(1)).toBeLessThan(radius(0));
    expect(radius(1)).toBeGreaterThan(2.56); // still clears the model
  });

  it("advances on the SCROLL, which is what the middle was missing", () => {
    // the shell's own clock is time; the gather adds a scroll term, so a reader
    // who stops sees it turn and a reader who scrolls flips the deck
    const still = cardOrbitAt(3, 0, 0.4);
    const scrolled = cardOrbitAt(3, 0, 0.6);
    expect(Math.hypot(still.y - scrolled.y, still.z - scrolled.z)).toBeGreaterThan(0.5); // prettier-ignore
    // …and it is a pure function of (k, t, gather) either way
    expect(cardOrbitAt(3, 250, 0.5)).toEqual(cardOrbitAt(3, 250, 0.5));
  });
});

describe("how the sides disappear", () => {
  it("takes the OUTER casts only once they have flown, while the deep ranks still travel", () => {
    // THE FAILURE THIS PINS: a wink that opens on the flight's outer ranks
    // takes a cast off screen before it has visibly travelled, and the
    // departure reads as a cut rather than an animation. The wink's bands run
    // outside-in (core/visibility.ts), so the pieces it may take FIRST are the
    // outer half of the rank range — checked against the GATE: at the frame the
    // first cast may go they are already at their final departed pose (flight
    // 1, stick 0, the channel-1 anchors).
    const c = assembleAt(WINK_SPAN[0]);
    for (let r = 0.6; r <= 1.0001; r += 0.02)
      for (const layerPhase of LAYER_PHASES) {
        const g = gate(NUM, ASSEMBLE_GATE, c, {
          rank01: Math.min(1, r),
          layerPhase,
        });
        expect(g.flight, `rank ${r} phase ${layerPhase}`).toBe(1);
        expect(g.stick, `rank ${r} phase ${layerPhase}`).toBe(0);
      }
    // …AND IT IS A RELAY: the deepest ranks are still flying here, so the band
    // never holds a stretch whose only motion is the bore roll. The per-piece
    // law behind that overlap — every mesh's own wink lands after its own
    // flight — is pinned against the shipped model in piece-flow.test.ts, which
    // is the only place the name → rank map exists.
    const deep = gate(NUM, ASSEMBLE_GATE, c, { rank01: 0.25, layerPhase: 0 });
    expect(deep.flight, "the deep ranks are mid-flight").toBeLessThan(1);
    // it opens inside the departure's own rise and is spent INSIDE THE PEEL, so
    // the scene hands over on a still frame with the mechanism already bare —
    // and a whole scene before the internals settles on it
    expect(WINK_SPAN[0]).toBeGreaterThan(windowEdges(CARDS_APART.rise)[0]);
    expect(WINK_SPAN[0]).toBeLessThan(windowEdges(CARDS_APART.rise)[1]);
    expect(WINK_SPAN[1]).toBeLessThanOrEqual(peR.p1);
    expect(WINK_SPAN[1]).toBeLessThan(inR.p0);
  });

  it("takes the DEPARTURE'S CHANNEL home behind that wink", () => {
    // the fall is the one snap the scene still has to cover, and the cover is
    // the wink: every piece the departure moves is out of the visibility pass
    // before the channel walks back to 0 (the mechanism it would otherwise move
    // is scoped out — ops/recipes.ts keepScope).
    const [f0, f1] = windowEdges(CARDS_APART.fall);
    expect(f0).toBeGreaterThanOrEqual(WINK_SPAN[1]);
    expect(f1).toBeLessThanOrEqual(cdR.p1);
  });

  it("dies into its own edge, so the hard 0 past it is a rate identity too", () => {
    const rate = (p: number) => (peelTurnAt(p + 1e-7) - peelTurnAt(p)) / 1e-7;
    expect(Math.abs(rate(TURN_SPAN[1] - 1e-4))).toBeLessThan(1);
    expect(rate(TURN_SPAN[1] + 1e-5)).toBe(0);
  });

  it("keeps the cards' turn on the RAW p — its neighbours' own clock", () => {
    const driver = fs.readFileSync(
      new URL("../hero-driver.ts", import.meta.url),
      "utf8",
    );
    expect(driver).toMatch(/peelTurnAt\(lastP\)/);
    expect(driver).not.toMatch(/peelTurnAt\(pE\)/);
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

describe("the huddle — the compact core the cards turn", () => {
  it("is EXACTLY 0 while the peel's departures are in flight", () => {
    // every departing piece flies from its SEATED position: a huddled core
    // under the departure would misalign every flight's start
    for (const f of [0, 0.25, 0.5, 0.75, 1])
      expect(huddleAt(atFrac(peR, f)), `peel ${f}`).toBe(0);
    expect(windowEdges(HUDDLE.rise)[0]).toBeGreaterThanOrEqual(cdR.p0);
  });

  it("its release IS the stand-up — one hand-over gesture", () => {
    // the fall is UPRIGHT's own rise BY IDENTITY, not a window that happens to
    // match: retuning the stand-up retunes the release with it
    expect(HUDDLE.fall).toBe(UPRIGHT.rise);
  });

  it("is WRITTEN — the driver drives the channel every frame", () => {
    // the bore roll's own census idiom: a channel nobody writes dies silently
    const driver = fs.readFileSync(
      new URL("../hero-driver.ts", import.meta.url),
      "utf8",
    );
    expect(driver).toMatch(/huddleTarget = huddleAt\(p\)/);
  });

  it("is full for the turn's middle and spent with the tip", () => {
    expect(huddleAt(atFrac(cdR, 0.3))).toBe(1);
    expect(huddleAt(atFrac(cdR, 0.7))).toBe(1);
    // gone exactly where the lens is upright, and everywhere after — the
    // internals stack, the dive and everything the dive returns see seats
    const [, up1] = windowEdges(UPRIGHT.rise);
    expect(huddleAt(up1)).toBe(0);
    for (const p of [atFrac(inR, 0.5), 0.6, 0.8, 1])
      expect(huddleAt(p), `p ${p}`).toBe(0);
  });
});

describe("the card fit — the shell sized to the frame", () => {
  const halfWAt = (w: number, h: number) => {
    // core/scene's zoom law + the cards row's own fov and settle distance
    const zoom = frameZoom(w, h);
    const fov = cdR.scene.cam.fov;
    const dist = Math.hypot(...cdR.scene.cam.pos) * STORY_R;
    return (Math.tan((fov * Math.PI) / 360) / zoom) * (w / h) * dist;
  };

  it("leaves a LANDSCAPE frame untouched — the authored field is landscape's", () => {
    expect(cardFitOf(halfWAt(1440, 810))).toBe(1);
    expect(cardFitOf(halfWAt(1440, 900))).toBe(1);
  });

  it("pulls the sphere inside a PORTRAIT frame, and never onto the lens", () => {
    const phone = cardFitOf(halfWAt(390, 844));
    expect(phone).toBeLessThan(1);
    expect(phone).toBeGreaterThanOrEqual(0.6);
    // the fitted shell still clears the model's bounding sphere (≈ 2.56 wu)
    expect(5.2 * phone).toBeGreaterThan(2.9);
  });
});
