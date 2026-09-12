import { describe, expect, it } from "vitest";
import fs from "node:fs";
import * as THREE from "three/webgpu";
import { isSegWedge, isShellPart } from "../../core/parts";
import {
  EXTRA_BAND,
  SHELL_FEATHER,
  WINK_WIDTH,
  winkOpacity,
} from "../../core/visibility";
import { NUM } from "../../ops/algebra";
import { gate } from "../../ops/gate";
import { makeRecipes } from "../../ops/recipes";
import { STORY_R, atFrac, DIVE_P0, rangeOf, windowEdges } from "../story";
import { MODEL_BORE_X_Z, frameZoom, modelAnchorFor } from "../../core/scene";
import {
  CARDS_APART,
  DIP,
  HUDDLE,
  PEEL_ROLL_SPAN,
  TURN_SPAN,
  UPRIGHT,
  WINK_SPAN,
  assembleAt,
  huddleAt,
  peelRollAt,
  peelRollFracAt,
  peelTurnAt,
  peelTurnFracAt,
  uprightAt,
  winkLevelAt,
  winkPAt,
} from "../envelopes";
import {
  CARD_COUNT,
  CARDS_IN_SPAN,
  CARDS_OUT_SPAN,
  cardFitOf,
  cardGatherAt,
  cardInAt,
  cardOrbitAt,
  cardOutAt,
  cardRollAt,
  cardScaleAt,
  cardThresholdOf,
  MOUNT_HI,
  MOUNT_HYST,
  MOUNT_LO,
  segSectorAngle,
} from "../peelcards";

const peR = rangeOf("peel");
const cdR = rangeOf("cards");
const inR = rangeOf("internals");

// The peel/cards LAWS, not their plumbing: the lens' roll and turn are
// saturating pure functions of the scroll, each card opens as a wedge would
// dissolve and is whole before the departure walks home, the field is gone
// before the internals scene settles, and the sphere is reproducible.

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

/** each card's threshold — the wedge band's own scatter */
const CARD_TS = KS.map(cardThresholdOf);
/** where card k opens: the p its threshold's dissolve begins at */
const bornAt = (k: number) => winkPAt(cardThresholdOf(k));

describe("the bore roll", () => {
  it("is asleep before it opens and spent after it closes", () => {
    for (const p of [0, peR.p0, PEEL_ROLL_SPAN[0]])
      expect(peelRollFracAt(p), `p ${p}`).toBe(0);
    for (const p of [PEEL_ROLL_SPAN[1], cdR.p0, 1])
      expect(peelRollFracAt(p), `p ${p}`).toBe(1);
  });

  it("lands on a WHOLE number of revolutions, so the drop to 0 is exact", () => {
    // peelRollAt is hard 0 past its window because the model's orientation is
    // one snap-per-call write — the same law the turn carries.
    const turns = peelRollAt(PEEL_ROLL_SPAN[1] - 1e-9) / (2 * Math.PI);
    expect(turns, "whole turns").toBeCloseTo(Math.round(turns), 6);
    expect(Math.round(turns), "and it actually rolls").not.toBe(0);
    for (const p of [
      0,
      peR.p0,
      PEEL_ROLL_SPAN[0],
      PEEL_ROLL_SPAN[1],
      cdR.p0,
      1,
    ])
      expect(Math.abs(peelRollAt(p)), `p ${p}`).toBe(0);
  });

  it("is SPENT before the turn and the dip open — a roll, not a precession", () => {
    // it rides the model's `x`, which is a roll about the bore only while the
    // turn's `y` and the dip's `z` are 0 (the driver's one write composes
    // Rx·Ry·Rz). Both of those open at the cards scene's foot.
    expect(PEEL_ROLL_SPAN[1]).toBeLessThanOrEqual(TURN_SPAN[0]);
    expect(PEEL_ROLL_SPAN[1]).toBeLessThanOrEqual(windowEdges(DIP.rise)[0]);
  });

  it("SETTLES on screen — the rate is 0 at both edges", () => {
    const rate = (p: number) =>
      (peelRollFracAt(p + 1e-6) - peelRollFracAt(p)) / 1e-6;
    const span = PEEL_ROLL_SPAN[1] - PEEL_ROLL_SPAN[0];
    const mid = rate(PEEL_ROLL_SPAN[0] + 0.5 * span);
    expect(rate(PEEL_ROLL_SPAN[0] + 0.01 * span), "opening").toBeLessThan(mid * 0.2); // prettier-ignore
    expect(rate(PEEL_ROLL_SPAN[1] - 0.01 * span), "closing").toBeLessThan(mid * 0.2); // prettier-ignore
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

  it("carries the cards' arrival: the wedges dissolve into the turn", () => {
    // the arrival runs from inside the peel across the boundary, so the last
    // cards land while the lens is already turning — no bare-core beat
    expect(CARDS_IN_SPAN[0]).toBeGreaterThan(WINK_SPAN[0]);
    expect(CARDS_IN_SPAN[0]).toBeLessThan(peR.p1);
    expect(CARDS_IN_SPAN[1]).toBeGreaterThan(cdR.p0);
    expect(CARDS_IN_SPAN[1]).toBe(WINK_SPAN[1]);
    expect(peelTurnFracAt(CARDS_IN_SPAN[1])).toBeGreaterThan(0);
    // …and every card's whole fade-in lies inside it
    for (const k of KS) {
      expect(bornAt(k), `card ${k} opens`).toBeGreaterThanOrEqual(CARDS_IN_SPAN[0] - 1e-12); // prettier-ignore
      expect(cardInAt(k, CARDS_IN_SPAN[1]), `card ${k} whole`).toBe(1);
    }
  });
});

// THE HAND-OFF: a card's opacity is the complement of a wedge's at the card's
// own threshold — one law, two readers — so it rises as the wedges fall.
// Pinned exact at both edges: a card window authored on its own scene fraction
// (the old CARD_FADE_*) fails "0 while the wedge is whole"; a card that fades
// ABOVE the threshold fails it too; one that lags the wedge fails "1 where the
// wedge is gone".
describe("the hand-off", () => {
  const PS = Array.from(
    { length: 400 },
    (_, i) => WINK_SPAN[0] - 0.01 + ((WINK_SPAN[1] - WINK_SPAN[0] + 0.02) * i) / 399, // prettier-ignore
  );

  it("takes its thresholds from the wedge band, one per card, all distinct", () => {
    for (const t of CARD_TS) {
      expect(t).toBeGreaterThanOrEqual(WINK_WIDTH);
      expect(t).toBeLessThan(EXTRA_BAND);
    }
    expect(new Set(CARD_TS).size).toBe(CARD_COUNT);
  });

  it("conserves the crossfade: card + wedge = 1 at every p", () => {
    for (const k of KS)
      for (const p of PS)
        expect(cardInAt(k, p) + winkOpacity(CARD_TS[k], winkLevelAt(p)), `card ${k} p ${p}`).toBeCloseTo(1, 12); // prettier-ignore
  });

  it("is exactly 0 while the wedge is whole and exactly 1 where the wedge is gone", () => {
    for (const k of KS) {
      const born = bornAt(k);
      expect(winkLevelAt(born), `card ${k} opening level`).toBeCloseTo(CARD_TS[k], 9); // prettier-ignore
      for (const p of [0, WINK_SPAN[0], born - 1e-7])
        expect(cardInAt(k, p), `card ${k} p ${p}`).toBe(0);
      expect(cardInAt(k, born + 1e-4), `card ${k} just open`).toBeGreaterThan(0); // prettier-ignore
      const gone = winkPAt(CARD_TS[k] - WINK_WIDTH);
      for (const p of [gone + 1e-7, WINK_SPAN[1], cdR.p1])
        expect(cardInAt(k, p), `card ${k} p ${p}`).toBe(1);
      expect(cardInAt(k, gone - 1e-4), `card ${k} still going`).toBeLessThan(1); // prettier-ignore
    }
  });

  it("only ever rises, and in the casts' order — a higher threshold opens first", () => {
    for (const k of KS) {
      let prev = -1;
      for (const p of PS) {
        const v = cardInAt(k, p);
        expect(v, `card ${k} p ${p}`).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
    const byT = [...KS].sort((a, b) => CARD_TS[b] - CARD_TS[a]);
    for (let i = 1; i < byT.length; i++)
      expect(bornAt(byT[i])).toBeGreaterThan(bornAt(byT[i - 1]));
    // decals go before the wedges: the shell's top threshold opens before any
    // card can
    for (const k of KS) expect(winkPAt(SHELL_FEATHER)).toBeLessThan(bornAt(k));
  });
});

// THE EXIT: the cards leave on the tip's own rise, fanned along the bore so
// they go the way the lens stands up, and the last is out before the field
// unmounts at the scene's end.
describe("the field's fade-out", () => {
  it("is 0 until the tip opens and exactly 1 for every card by the scene's end", () => {
    const [up0] = windowEdges(UPRIGHT.rise);
    for (const k of KS) {
      for (const p of [0, cdR.p0, atFrac(cdR, 0.5), up0])
        expect(cardOutAt(k, p), `card ${k} p ${p}`).toBe(0);
      expect(cardOutAt(k, cdR.p1), `card ${k} at the end`).toBe(1);
      expect(cardOutAt(k, 1), `card ${k} past the end`).toBe(1);
    }
    expect(CARDS_OUT_SPAN[0]).toBeGreaterThanOrEqual(up0);
    expect(CARDS_OUT_SPAN[1]).toBeLessThanOrEqual(cdR.p1);
    expect(CARDS_OUT_SPAN[1]).toBeLessThan(windowEdges(UPRIGHT.rise)[1]);
  });

  it("is ordered along the bore: the +X end leaves first, one card at a time", () => {
    const PS = Array.from(
      { length: 401 },
      (_, i) => CARDS_OUT_SPAN[0] + ((CARDS_OUT_SPAN[1] - CARDS_OUT_SPAN[0]) * i) / 400, // prettier-ignore
    );
    const xs = KS.map((k) => cardOrbitAt(k, 0).x);
    /** the first sample a card has begun to go */
    const opensAt = (k: number) => PS.find((p) => cardOutAt(k, p) > 0)!;
    for (let k = 1; k < CARD_COUNT; k++) {
      expect(xs[k], `card ${k} further along +X`).toBeGreaterThan(xs[k - 1]);
      // further out at every p, and strictly earlier to open
      for (const p of PS)
        expect(cardOutAt(k, p), `card ${k} at ${p}`).toBeGreaterThanOrEqual(cardOutAt(k - 1, p)); // prettier-ignore
      expect(opensAt(k), `card ${k} opens first`).toBeLessThan(opensAt(k - 1));
    }
    for (const k of KS) {
      let prev = -1;
      for (const p of PS) {
        const v = cardOutAt(k, p);
        expect(v).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it("goes with the huddle's release — the same gesture", () => {
    expect(HUDDLE.fall).toBe(UPRIGHT.rise);
    expect(huddleAt(CARDS_OUT_SPAN[0])).toBeLessThan(1);
  });
});

// THE CARD SPHERE: eight stations on ONE sphere about the bore, ONE rotation
// axis, ONE direction, ONE rate, and no second motion on top. Taste values (the
// radius, the rate) are deliberately NOT pinned; the structure is.
describe("the card sphere", () => {
  const TIMES = [0, 250, 1_000, 4_500, 12_000, 47_300, 600_000];

  it("is a pure function of (card, time)", () => {
    for (const k of KS)
      for (const t of TIMES)
        expect(cardOrbitAt(k, t), `card ${k} at ${t}ms`).toEqual(
          cardOrbitAt(k, t),
        );
  });

  it("is a SPHERE: every card is the same distance from the lens, always", () => {
    // An identity, not a bound, so the sphere clears the model everywhere at
    // once. 2.56 wu is the seated model's own bounding-sphere radius.
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

  it("turns about the BORE, so no card's axial station ever moves", () => {
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

  it("advances every card by the SAME angle: one rate, one direction — a drift", () => {
    // a sphere that turns as one body cannot give a card its own ω or reverse
    // the direction by parity — either reads as aimless drift
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
      expect(ds[0], "the sphere is actually turning").not.toBe(0);
    }
    // parked, a revolution takes longer than the reader's glance: under half a
    // radian a second, so the scroll-driven turn is the motion that shows
    expect(Math.abs(step(0, 0, 1000))).toBeLessThan(0.5);
  });

  it("carries NO second motion — no bob, no sway, nothing off the circle", () => {
    // Anything added on top of the rotation (a bob, an idle sway) shows up as a
    // card leaving its own latitude circle. Sampled densely: a slow wobble is
    // what a coarse sample misses.
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
    // …and the ROLL is a pure function of the card's fade, with no clock at all
    expect(cardRollAt.length, "cardRollAt takes (k, fade)").toBe(2);
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

  it("tips a card in on entry and settles it over its own fade", () => {
    for (const k of KS) {
      const entry = Math.abs(cardRollAt(k, 0));
      const rest = Math.abs(cardRollAt(k, 1));
      expect(entry, `card ${k} enters tipped`).toBeGreaterThan(rest);
      expect(rest, `card ${k} keeps a residual`).toBeGreaterThan(0);
      expect(entry, `card ${k} entry is a tip, not a tumble`).toBeLessThan(0.5);
    }
  });
});

// THE FIELD'S PARENT: the model overlay anchor is the identity at boot and the
// model's live rotation about its visual centre thereafter, so a field authored
// on the rest-world axes rides the lens without a frame conversion.
describe("the model overlay anchor", () => {
  const MODEL_SCALE = 0.05;
  /** core/scene.ts's placement: bore onto +X, mm to world, recentred */
  const placed = (centreLocal: THREE.Vector3) => {
    const group = new THREE.Group();
    group.rotation.z = MODEL_BORE_X_Z;
    group.scale.setScalar(MODEL_SCALE);
    group.updateWorldMatrix(true, true);
    const centreWorld = centreLocal.clone().applyMatrix4(group.matrixWorld);
    group.position.sub(centreWorld);
    const bootQuatInv = group.quaternion.clone().invert();
    const anchor = modelAnchorFor(centreWorld, bootQuatInv);
    group.add(anchor);
    group.updateWorldMatrix(true, true);
    return { group, anchor, bootQuatInv, bootPosition: group.position.clone() };
  };

  it("is the identity under the boot placement", () => {
    const { anchor } = placed(new THREE.Vector3(12, -30, 7));
    const e = anchor.matrixWorld.elements;
    const I = new THREE.Matrix4().identity().elements;
    for (let i = 0; i < 16; i++) expect(e[i], `element ${i}`).toBeCloseTo(I[i], 9); // prettier-ignore
  });

  it("is the model's live rotation about the origin under a reorient", () => {
    const { group, anchor, bootQuatInv, bootPosition } = placed(new THREE.Vector3(12, -30, 7)); // prettier-ignore
    group.rotation.set(0.7, -1.9, MODEL_BORE_X_Z + 0.4);
    // scene.ts applyModelPlacement: the recentre re-derived under the rotation
    group.position
      .copy(bootPosition)
      .applyQuaternion(bootQuatInv)
      .applyQuaternion(group.quaternion);
    group.updateWorldMatrix(true, true);
    const want = new THREE.Matrix4().makeRotationFromQuaternion(
      group.quaternion.clone().multiply(bootQuatInv),
    );
    const e = anchor.matrixWorld.elements;
    for (let i = 0; i < 16; i++) expect(e[i], `element ${i}`).toBeCloseTo(want.elements[i], 9); // prettier-ignore
    // a point of the field maps by rotation alone — no translation, no scale
    const p = new THREE.Vector3(5.2, 0, 0).applyMatrix4(anchor.matrixWorld);
    expect(p.length()).toBeCloseTo(5.2, 9);
  });
});

describe("the field's gather — what the middle of the scene is about", () => {
  it("forms as the field arrives, and is spent before it goes", () => {
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

  it("flattens the sphere onto ONE ring and draws it in, short of the core", () => {
    // the sphere's stations converge to the equator and the radius pulls in, so
    // the field reads as a carousel passing the lens rather than a sphere
    // around it. Same eight quads: no draw, no upload, no residency change.
    const axialSpread = (g: number) =>
      Math.max(...KS.map((k) => Math.abs(cardOrbitAt(k, 0, g).x)));
    expect(axialSpread(1)).toBeLessThan(axialSpread(0) * 0.05);
    const radius = (g: number) => {
      const o = cardOrbitAt(0, 0, g);
      return Math.hypot(o.x, o.y, o.z);
    };
    expect(radius(1)).toBeLessThan(radius(0));
    // the ring never crosses the core: it clears the model's bounding sphere
    // (≈ 2.56 wu) by more than a card's own reach (1.2 wu)
    expect(radius(1)).toBeGreaterThan(2.56 + 1.2);
  });

  it("advances on the SCROLL, which is what the middle was missing", () => {
    // the sphere's own clock is time; the gather adds a scroll term, so a
    // reader who stops sees it drift and a reader who scrolls flips the deck
    const still = cardOrbitAt(3, 0, 0.4);
    const scrolled = cardOrbitAt(3, 0, 0.6);
    expect(Math.hypot(still.y - scrolled.y, still.z - scrolled.z)).toBeGreaterThan(0.5); // prettier-ignore
    // …and it is a pure function of (k, t, gather) either way
    expect(cardOrbitAt(3, 250, 0.5)).toEqual(cardOrbitAt(3, 250, 0.5));
  });
});

describe("how the sides disappear", () => {
  it("takes the OUTER casts only once they have flown, while the deep ranks still travel", () => {
    // A wink that opens on the flight's outer ranks dissolves a cast before it
    // has visibly travelled. The first pieces it may take are the outer half of
    // the rank range — and at the frame the first cast may go they are already
    // fully departed.
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
    // form of that overlap is pinned in piece-flow.test.ts.
    const deep = gate(NUM, ASSEMBLE_GATE, c, { rank01: 0.25, layerPhase: 0 });
    expect(deep.flight, "the deep ranks are mid-flight").toBeLessThan(1);
    // it opens inside the departure's rise and runs into the cards scene, under
    // the turn, so the hand-over is one motion rather than a still frame
    expect(WINK_SPAN[0]).toBeGreaterThan(windowEdges(CARDS_APART.rise)[0]);
    expect(WINK_SPAN[0]).toBeLessThan(windowEdges(CARDS_APART.rise)[1]);
    expect(WINK_SPAN[1]).toBeGreaterThan(cdR.p0);
    expect(WINK_SPAN[1]).toBeLessThan(inR.p0);
  });

  it("takes the DEPARTURE'S CHANNEL home behind that wink", () => {
    // the fall is the one snap the scene has to cover, and the wink is the
    // cover: every piece the departure moves is exactly gone before the
    // channel walks back to 0.
    const [f0, f1] = windowEdges(CARDS_APART.fall);
    expect(f0).toBeGreaterThanOrEqual(WINK_SPAN[1]);
    expect(f1).toBeLessThanOrEqual(cdR.p1);
    expect(winkLevelAt(f0)).toBe(0);
  });

  it("dies into its own edge, so the hard 0 past it is a rate identity too", () => {
    const rate = (p: number) => (peelTurnAt(p + 1e-7) - peelTurnAt(p)) / 1e-7;
    expect(Math.abs(rate(TURN_SPAN[1] - 1e-4))).toBeLessThan(1);
    expect(rate(TURN_SPAN[1] + 1e-5)).toBe(0);
  });
});

// --- the shipped geometry ---------------------------------------------------
// The two claims this module makes ABOUT THE MODEL, pinned against it: which
// sector each piece of the shell's cast sits on, and that a part offset written
// in the gltf frame is a radial offset in the world frame. A re-export that
// re-cuts or renumbers the seams must fail HERE.

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
  // EXPORTED so story/cost.ts can count the eight draws without spelling the
  // window twice; pinned here, where it is owned.

  it("mounts a whole scene early and leaves before the dive", () => {
    // the eight texture uploads land in the zoom's quiet beat, not on the
    // peel's first frames
    expect(MOUNT_LO).toBe(rangeOf("zoom").p0);
    expect(MOUNT_LO).toBeLessThan(peR.p0);
    // …and the tail is the cards scene's own end: the field dissolves inside
    // the scene, so no invisible card survives into the internals or the dive
    expect(MOUNT_HI).toBe(cdR.p1);
    expect(MOUNT_HI).toBeLessThan(DIVE_P0);
    expect(MOUNT_HI).toBeLessThanOrEqual(inR.p0);
    for (const k of KS)
      expect(cardOutAt(k, MOUNT_HI), `card ${k} is gone by the scene's end`).toBe(1); // prettier-ignore
  });

  it("covers the whole span the cards are ever drawn over", () => {
    for (const p of [
      CARDS_IN_SPAN[0],
      cdR.p0,
      cdR.p1,
      atFrac(cdR, 0.5),
      peR.p0,
    ])
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
    // 10° is the bounding box's own asymmetry; half a sector is 36°, so this
    // cannot admit the wrong sector.
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

describe("the card fit — the sphere sized to the frame", () => {
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
    // the fitted sphere still clears the model's bounding sphere (≈ 2.56 wu)
    expect(5.2 * phone).toBeGreaterThan(2.9);
  });
});
