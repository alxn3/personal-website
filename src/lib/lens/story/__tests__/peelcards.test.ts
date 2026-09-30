import { describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { isSegWedge, isShellPart } from "../../core/parts";
import {
  EXTRA_BAND,
  SHELL_FEATHER,
  WINK_WIDTH,
  stampWinkLanes,
  winkOpacity,
} from "../../core/visibility";
import { shippedModel } from "./shipped-model";
import { lin } from "./fake-scene";
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
  SEG_COUNT,
  segSectorAngle,
} from "../peelcards";

const peR = rangeOf("peel");
const cdR = rangeOf("cards");
const inR = rangeOf("internals");
const [UP0, UP1] = windowEdges(UPRIGHT.rise);

const KS = Array.from({ length: CARD_COUNT }, (_, k) => k);

/** each card's wedge-fade threshold */
const CARD_TS = KS.map(cardThresholdOf);
/** the p where card k starts to fade in */
const bornAt = (k: number) => winkPAt(cardThresholdOf(k));

/** shortest angular distance, radians */
const apart = (a: number, b: number) =>
  Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));

/** assert `f` never falls over `ps` */
const rising = (f: (p: number) => number, ps: number[], label = "") => {
  for (let i = 1; i < ps.length; i++)
    expect(f(ps[i]), `${label} p ${ps[i]}`).toBeGreaterThanOrEqual(
      f(ps[i - 1]),
    );
};

// The bore roll and the turn: each opens asleep, closes spent on a whole
// number of revolutions (the angle snaps to 0 past its window) and settles on
// screen (rate 0 at both edges).
describe.each([
  {
    name: "the bore roll",
    frac: peelRollFracAt,
    angle: peelRollAt,
    span: PEEL_ROLL_SPAN,
    asleep: [0, peR.p0, PEEL_ROLL_SPAN[0]],
    spent: [PEEL_ROLL_SPAN[1], cdR.p0, 1],
    h: 1e-6,
  },
  {
    name: "the turn",
    frac: peelTurnFracAt,
    angle: peelTurnAt,
    span: TURN_SPAN,
    asleep: [0, 0.05, peR.p0, TURN_SPAN[0]],
    spent: [TURN_SPAN[1], inR.p1, 1],
    h: 1e-5,
  },
])("$name", ({ frac, angle, span, asleep, spent, h }) => {
  it("is asleep before it opens and spent after it closes", () => {
    for (const p of asleep) expect(frac(p), `p ${p}`).toBe(0);
    for (const p of spent) expect(frac(p), `p ${p}`).toBe(1);
  });

  it("lands on a WHOLE number of revolutions, so the drop to 0 is exact", () => {
    const turns = angle(span[1] - 1e-9) / (2 * Math.PI);
    expect(turns, "whole turns").toBeCloseTo(Math.round(turns), 6);
    expect(Math.round(turns), "and it actually moves").not.toBe(0);
    for (const p of [...asleep, ...spent, 0.5])
      expect(Math.abs(angle(p)), `p ${p}`).toBe(0);
  });

  it("SETTLES on screen — the rate is 0 at both edges", () => {
    const rate = (p: number) => (frac(p + h) - frac(p)) / h;
    const w = span[1] - span[0];
    const mid = rate(span[0] + 0.5 * w);
    expect(rate(span[0] + 0.01 * w), "opening").toBeLessThan(mid * 0.2);
    expect(rate(span[1] - 0.01 * w), "closing").toBeLessThan(mid * 0.2);
  });
});

describe("the roll and the turn together", () => {
  it("spends the roll before the turn and the dip open — a roll, not a precession", () => {
    // `x` rolls about the bore only while the turn's `y` and dip's `z` are 0
    expect(PEEL_ROLL_SPAN[1]).toBeLessThanOrEqual(TURN_SPAN[0]);
    expect(PEEL_ROLL_SPAN[1]).toBeLessThanOrEqual(windowEdges(DIP.rise)[0]);
  });

  it("only ever winds the turn forward", () => {
    rising(peelTurnFracAt, lin(TURN_SPAN[0] - 0.02, TURN_SPAN[1] + 0.02, 200));
  });

  it("spends the turn EXACTLY where the lens stands up, dying into its own edge", () => {
    // once the bore is vertical, a turn about world +Y no longer moves it
    expect(TURN_SPAN[1]).toBe(UP1);
    expect(uprightAt(TURN_SPAN[1])).toBe(1);
    // the hard 0 past the edge is a rate identity too
    const rate = (p: number) => (peelTurnAt(p + 1e-7) - peelTurnAt(p)) / 1e-7;
    expect(Math.abs(rate(TURN_SPAN[1] - 1e-4))).toBeLessThan(1);
    expect(rate(TURN_SPAN[1] + 1e-5)).toBe(0);
  });

  it("carries the cards' arrival: the wedges dissolve into the turn", () => {
    // the last cards land while the lens is already turning
    expect(CARDS_IN_SPAN[0]).toBeGreaterThan(WINK_SPAN[0]);
    expect(CARDS_IN_SPAN[0]).toBeLessThan(peR.p1);
    expect(CARDS_IN_SPAN[1]).toBeGreaterThan(cdR.p0);
    expect(CARDS_IN_SPAN[1]).toBe(WINK_SPAN[1]);
    expect(peelTurnFracAt(CARDS_IN_SPAN[1])).toBeGreaterThan(0);
    // every card's whole fade-in lies inside the arrival
    for (const k of KS) {
      expect(bornAt(k), `card ${k} opens`).toBeGreaterThanOrEqual(CARDS_IN_SPAN[0] - 1e-12); // prettier-ignore
      expect(cardInAt(k, CARDS_IN_SPAN[1]), `card ${k} whole`).toBe(1);
    }
  });
});

const model = shippedModel();

// A card's opacity is 1 minus its seed wedge's, so cards rise as wedges fade.
describe("the hand-off", () => {
  const PS = lin(WINK_SPAN[0] - 0.01, WINK_SPAN[1] + 0.01, 399);

  it("takes its thresholds from the wedge band, one per card, all distinct", () => {
    for (const t of CARD_TS) {
      expect(t).toBeGreaterThanOrEqual(WINK_WIDTH);
      expect(t).toBeLessThan(EXTRA_BAND);
    }
    expect(new Set(CARD_TS).size).toBe(CARD_COUNT);
  });

  it("conserves the crossfade against the card's OWN seed wedge, as the model is stamped", () => {
    // find the wedge by its stamped f32 threshold on the shipped model
    const lanes = [...stampWinkLanes(model)];
    for (const k of KS) {
      const t = Math.fround(CARD_TS[k]);
      const mates = lanes.filter(
        ([, w]) => w.channel === "shell" && Math.fround(w.threshold) === t,
      );
      expect(mates, `card ${k} has one wedge on its threshold`).toHaveLength(1);
      const [mesh, wedge] = mates[0];
      // it is the sector the card is seeded from
      expect(isSegWedge(mesh.name), mesh.name).toBe(true);
      expect(mesh.name, mesh.name).toMatch(new RegExp(`_Seg${k % SEG_COUNT}$`));
      for (const p of PS)
        expect(cardInAt(k, p) + winkOpacity(wedge.threshold, winkLevelAt(p)), `card ${k} p ${p}`).toBeCloseTo(1, 6); // prettier-ignore
    }
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
    for (const k of KS) rising((p) => cardInAt(k, p), PS, `card ${k}`);
    const byT = [...KS].sort((a, b) => CARD_TS[b] - CARD_TS[a]);
    for (let i = 1; i < byT.length; i++)
      expect(bornAt(byT[i])).toBeGreaterThan(bornAt(byT[i - 1]));
    // the shell's decals fade before any card opens
    for (const k of KS) expect(winkPAt(SHELL_FEATHER)).toBeLessThan(bornAt(k));
  });
});

// Cards leave during the stand-up, staggered along the bore.
describe("the field's fade-out", () => {
  it("is 0 until the tip opens and exactly 1 for every card by the scene's end", () => {
    for (const k of KS) {
      for (const p of [0, cdR.p0, atFrac(cdR, 0.5), UP0])
        expect(cardOutAt(k, p), `card ${k} p ${p}`).toBe(0);
      expect(cardOutAt(k, cdR.p1), `card ${k} at the end`).toBe(1);
      expect(cardOutAt(k, 1), `card ${k} past the end`).toBe(1);
    }
    expect(CARDS_OUT_SPAN[0]).toBeGreaterThanOrEqual(UP0);
    expect(CARDS_OUT_SPAN[1]).toBeLessThanOrEqual(cdR.p1);
    expect(CARDS_OUT_SPAN[1]).toBeLessThan(UP1);
  });

  it("is ordered along the bore: the +X end leaves first, one card at a time", () => {
    const PS = lin(CARDS_OUT_SPAN[0], CARDS_OUT_SPAN[1], 400);
    const xs = KS.map((k) => cardOrbitAt(k, 0).x);
    /** the first sample a card has begun to go */
    const opensAt = (k: number) => PS.find((p) => cardOutAt(k, p) > 0)!;
    for (const k of KS) rising((p) => cardOutAt(k, p), PS, `card ${k}`);
    for (let k = 1; k < CARD_COUNT; k++) {
      expect(xs[k], `card ${k} further along +X`).toBeGreaterThan(xs[k - 1]);
      // further out at every p, and strictly earlier to open
      for (const p of PS)
        expect(cardOutAt(k, p), `card ${k} at ${p}`).toBeGreaterThanOrEqual(cardOutAt(k - 1, p)); // prettier-ignore
      expect(opensAt(k), `card ${k} opens first`).toBeLessThan(opensAt(k - 1));
    }
  });
});

// Eight cards on one sphere turning about the bore at one rate; radius and rate
// are not pinned, only the structure.
describe("the card sphere", () => {
  const TIMES = [
    ...[0, 250, 1_000, 4_500, 12_000, 47_300, 600_000],
    ...Array.from({ length: 400 }, (_, i) => i * 137),
  ];
  const r0 = Math.hypot(...Object.values(cardOrbitAt(0, 0)));

  it("is a SPHERE turning about the BORE: fixed radius and axial station, nothing else", () => {
    // 2.56 wu is the seated model's bounding-sphere radius
    expect(r0).toBeGreaterThan(2.56);
    for (const k of KS) {
      const x = cardOrbitAt(k, 0).x;
      for (const t of TIMES) {
        const o = cardOrbitAt(k, t);
        expect(Math.hypot(o.x, o.y, o.z), `card ${k} at ${t}ms`).toBeCloseTo(r0, 10); // prettier-ignore
        expect(o.x, `card ${k} at ${t}ms`).toBe(x);
      }
    }
    // eight distinct latitudes, none near a pole where the card would not move
    const xs = KS.map((k) => cardOrbitAt(k, 0).x);
    expect(new Set(xs.map((x) => x.toFixed(6))).size).toBe(CARD_COUNT);
    for (const k of KS)
      expect(Math.hypot(cardOrbitAt(k, 0).y, cardOrbitAt(k, 0).z), `card ${k}`).toBeGreaterThan(0.5 * r0); // prettier-ignore
  });

  it("advances every card by the SAME angle: one rate, one direction — a drift", () => {
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
      expect(ds[0], "the sphere is actually turning").not.toBe(0);
      for (const k of KS)
        expect(ds[k], `card ${k} over [${t0}, ${t1}]`).toBeCloseTo(ds[0], 12);
    }
    // under half a radian a second when parked
    expect(Math.abs(step(0, 0, 1000))).toBeLessThan(0.5);
  });

  it("sweeps every card through a real range of camera depths", () => {
    // the cameras look along Z, so a card's Z swing is its change in depth
    for (const k of KS) {
      const zs = Array.from({ length: 400 }, (_, i) => cardOrbitAt(k, i * 500).z); // prettier-ignore
      expect(Math.max(...zs) - Math.min(...zs), `card ${k}`).toBeGreaterThan(6);
    }
  });

  it("starts every card on its own longitude", () => {
    const phases = KS.map((k) => {
      const o = cardOrbitAt(k, 0);
      return Math.atan2(o.z, o.y);
    });
    for (let a = 0; a < CARD_COUNT; a++)
      for (let b = a + 1; b < CARD_COUNT; b++)
        expect(apart(phases[a], phases[b]), `cards ${a} and ${b}`).toBeGreaterThan(0.1); // prettier-ignore
  });

  it("gives the cards their own base sizes, all within a card's worth", () => {
    const s = KS.map(cardScaleAt);
    for (const v of s) {
      expect(v).toBeGreaterThanOrEqual(0.85);
      expect(v).toBeLessThanOrEqual(1.2);
    }
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

// The anchor is the identity at boot and the model's live rotation after, so
// the card field rides the lens.
describe("the model overlay anchor", () => {
  /** core/scene.ts's placement: bore onto +X, mm to world, recentred */
  const placed = () => {
    const group = new THREE.Group();
    group.rotation.z = MODEL_BORE_X_Z;
    group.scale.setScalar(0.05);
    group.updateWorldMatrix(true, true);
    const centreWorld = new THREE.Vector3(12, -30, 7).applyMatrix4(group.matrixWorld); // prettier-ignore
    group.position.sub(centreWorld);
    const bootQuatInv = group.quaternion.clone().invert();
    const anchor = modelAnchorFor(centreWorld, bootQuatInv);
    group.add(anchor);
    group.updateWorldMatrix(true, true);
    return { group, anchor, bootQuatInv, bootPosition: group.position.clone() };
  };
  const matches = (m: THREE.Matrix4, want: THREE.Matrix4) =>
    m.elements.forEach((e, i) =>
      expect(e, `element ${i}`).toBeCloseTo(want.elements[i], 9),
    );

  it("is the identity under the boot placement", () => {
    matches(placed().anchor.matrixWorld, new THREE.Matrix4());
  });

  it("is the model's live rotation about the origin under a reorient", () => {
    const { group, anchor, bootQuatInv, bootPosition } = placed();
    group.rotation.set(0.7, -1.9, MODEL_BORE_X_Z + 0.4);
    // re-derive the recentre under the rotation, as scene.ts does
    group.position
      .copy(bootPosition)
      .applyQuaternion(bootQuatInv)
      .applyQuaternion(group.quaternion);
    group.updateWorldMatrix(true, true);
    matches(
      anchor.matrixWorld,
      new THREE.Matrix4().makeRotationFromQuaternion(
        group.quaternion.clone().multiply(bootQuatInv),
      ),
    );
    // rotation only: no translation, no scale
    const p = new THREE.Vector3(5.2, 0, 0).applyMatrix4(anchor.matrixWorld);
    expect(p.length()).toBeCloseTo(5.2, 9);
  });
});

describe("the field's gather — what the middle of the scene is about", () => {
  it("forms as the field arrives, and is spent before it goes", () => {
    expect(cardGatherAt(0.35)).toBe(0);
    expect(cardGatherAt(1)).toBe(1);
    rising(cardGatherAt, lin(0, 1, 100));
    expect(cardGatherAt(0.6)).toBeGreaterThan(0.2);
    expect(cardGatherAt(0.6)).toBeLessThan(0.8);
  });

  it("flattens the sphere onto ONE ring and draws it in, short of the core", () => {
    const axialSpread = (g: number) =>
      Math.max(...KS.map((k) => Math.abs(cardOrbitAt(k, 0, g).x)));
    expect(axialSpread(1)).toBeLessThan(axialSpread(0) * 0.05);
    const radius = (g: number) =>
      Math.hypot(...Object.values(cardOrbitAt(0, 0, g)));
    expect(radius(1)).toBeLessThan(radius(0));
    // clears the model's bounding sphere (2.56 wu) by more than a card (1.2 wu)
    expect(radius(1)).toBeGreaterThan(2.56 + 1.2);
  });

  it("advances on the SCROLL, which is what the middle was missing", () => {
    const still = cardOrbitAt(3, 0, 0.4);
    const scrolled = cardOrbitAt(3, 0, 0.6);
    expect(Math.hypot(still.y - scrolled.y, still.z - scrolled.z)).toBeGreaterThan(0.5); // prettier-ignore
  });
});

describe("how the sides disappear", () => {
  it("takes the OUTER casts only once they have flown, while the deep ranks still travel", () => {
    // when the wedge fade opens, the outer ranks have fully departed
    const assemble = makeRecipes(NUM).assemble;
    const spec = assemble.gateSpec(assemble.knobDefaults);
    const c = assembleAt(WINK_SPAN[0]);
    for (let r = 0.6; r <= 1.0001; r += 0.02)
      for (const layerPhase of lin(0, 1, 10)) {
        const g = gate(NUM, spec, c, { rank01: Math.min(1, r), layerPhase });
        expect([g.flight, g.stick], `rank ${r} phase ${layerPhase}`).toEqual([1, 0]); // prettier-ignore
      }
    // while the deepest ranks are still flying
    const deep = gate(NUM, spec, c, { rank01: 0.25, layerPhase: 0 });
    expect(deep.flight, "the deep ranks are mid-flight").toBeLessThan(1);
    // opens inside the departure's rise and ends inside the cards scene
    const [a0, a1] = windowEdges(CARDS_APART.rise);
    expect(WINK_SPAN[0]).toBeGreaterThan(a0);
    expect(WINK_SPAN[0]).toBeLessThan(a1);
    expect(WINK_SPAN[1]).toBeGreaterThan(cdR.p0);
    expect(WINK_SPAN[1]).toBeLessThan(inR.p0);
  });

  it("takes the DEPARTURE'S CHANNEL home behind that wink", () => {
    // every departed piece is fully faded before the channel returns to 0
    const [f0, f1] = windowEdges(CARDS_APART.fall);
    expect(f0).toBeGreaterThanOrEqual(WINK_SPAN[1]);
    expect(f1).toBeLessThanOrEqual(cdR.p1);
    expect(winkLevelAt(f0)).toBe(0);
  });
});

// exported for story/cost.ts
describe("the card field's mount window", () => {
  it("mounts one hysteresis ahead of the first card and leaves at the scene's end, before the dive", () => {
    expect(MOUNT_LO).toBe(CARDS_IN_SPAN[0] - MOUNT_HYST);
    expect(MOUNT_LO).toBeGreaterThan(peR.p0);
    for (const k of KS)
      expect(cardInAt(k, MOUNT_LO), `card ${k} unborn at the mount`).toBe(0);
    // unmounts at the cards scene's end, with every card already gone
    expect(MOUNT_HI).toBe(cdR.p1);
    expect(MOUNT_HI).toBeLessThan(DIVE_P0);
    expect(MOUNT_HI).toBeLessThanOrEqual(inR.p0);
    for (const k of KS)
      expect(cardOutAt(k, MOUNT_HI), `card ${k} is gone by the scene's end`).toBe(1); // prettier-ignore
    // pads the unmount, by less than the window it guards
    expect(MOUNT_HYST).toBeGreaterThan(0);
    expect(MOUNT_HYST).toBeLessThan((MOUNT_HI - MOUNT_LO) / 2);
  });
});

// Which sector each shell wedge sits on, measured on the shipped model in the
// glTF frame (+Y the optical axis, X–Z the radial plane).
describe("the shell's seam convention", () => {
  const wedges: { name: string; seg: number; angle: number }[] = [];
  model.traverse((o) => {
    const m = /_Seg(\d+)$/.exec(o.name);
    if (!(o instanceof THREE.Mesh) || !m) return;
    if (!isShellPart(o.name) || !isSegWedge(o.name)) return;
    o.geometry.computeBoundingBox();
    const c = o.geometry.boundingBox!.getCenter(new THREE.Vector3());
    // add every translation up to the root
    for (let up: THREE.Object3D | null = o; up; up = up.parent)
      c.add(up.position);
    wedges.push({ name: o.name, seg: Number(m[1]), angle: Math.atan2(c.z, c.x) }); // prettier-ignore
  });

  it("is five sectors on each of five families — 25 wedges", () => {
    expect(wedges).toHaveLength(25);
    for (const seg of [0, 1, 2, 3, 4])
      expect(wedges.filter((w) => w.seg === seg)).toHaveLength(5);
  });

  it("puts every wedge on the sector segSectorAngle names for it", () => {
    // 10° allows for bounding-box asymmetry; half a sector is 36°
    for (const w of wedges)
      expect(apart(w.angle, segSectorAngle(w.seg)), w.name).toBeLessThan((10 * Math.PI) / 180); // prettier-ignore
  });
});

describe("the huddle — the compact core the cards turn", () => {
  it("is EXACTLY 0 while the peel's departures are in flight", () => {
    // departing pieces fly from their seated positions
    for (const f of [0, 0.25, 0.5, 0.75, 1])
      expect(huddleAt(atFrac(peR, f)), `peel ${f}`).toBe(0);
    expect(windowEdges(HUDDLE.rise)[0]).toBeGreaterThanOrEqual(cdR.p0);
  });

  it("its release IS the stand-up — one hand-over gesture, the cards leaving with it", () => {
    // the same window object, not a copy
    expect(HUDDLE.fall).toBe(UPRIGHT.rise);
    expect(huddleAt(CARDS_OUT_SPAN[0])).toBeLessThan(1);
  });

  it("is full for the turn's middle and spent with the tip", () => {
    expect(huddleAt(atFrac(cdR, 0.3))).toBe(1);
    expect(huddleAt(atFrac(cdR, 0.7))).toBe(1);
    // gone once the lens is upright, and for the rest of the story
    for (const p of [UP1, atFrac(inR, 0.5), 0.6, 0.8, 1])
      expect(huddleAt(p), `p ${p}`).toBe(0);
  });
});

describe("the card fit — the sphere sized to the frame", () => {
  /** visible half-width at the cards camera's distance, for a w × h viewport */
  const halfWAt = (w: number, h: number) => {
    const fov = cdR.scene.cam.fov;
    const dist = Math.hypot(...cdR.scene.cam.pos) * STORY_R;
    return (Math.tan((fov * Math.PI) / 360) / frameZoom(w, h)) * (w / h) * dist;
  };

  it("leaves a LANDSCAPE frame untouched — the authored field is landscape's", () => {
    expect(cardFitOf(halfWAt(1440, 810))).toBe(1);
    expect(cardFitOf(halfWAt(1440, 900))).toBe(1);
  });

  it("pulls the sphere inside a PORTRAIT frame, and never onto the lens", () => {
    const phone = cardFitOf(halfWAt(390, 844));
    expect(phone).toBeLessThan(1);
    expect(phone).toBeGreaterThanOrEqual(0.6);
    // still clear of the model's bounding sphere (2.56 wu)
    expect(5.2 * phone).toBeGreaterThan(2.9);
  });
});
