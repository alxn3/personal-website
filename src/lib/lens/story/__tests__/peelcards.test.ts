import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { isSegWedge, isShellPart } from "../../core/parts";
import { atFrac, rangeOf } from "../story";
import {
  BAFFLE_FAMILY_ORDER,
  baffleDriftWindowOf,
  bafflePiece,
  CARD_COUNT,
  cardFadeAt,
  cardOrbitAt,
  cardScaleAt,
  cardsFadeOutAt,
  driftOrderOf,
  driftWindowOf,
  peelChannelAt,
  peelValueAt,
  SEG_COUNT,
  segSectorAngle,
  shellPartSector,
  stripDriftAt,
  TUBE_FAMILY_ORDER,
  tubeDriftWindowOf,
  tubePiece,
  tubeSectorAngle,
} from "../peelcards";

const peR = rangeOf("peel");
const cdR = rangeOf("cards");

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

const SEGS = [0, 1, 2, 3, 4];

describe("the strip drift", () => {
  it("holds every strip home until the unroll is done, and lands them all by the scene's end", () => {
    for (const seg of SEGS) {
      for (const local of [0, 0.1, 0.3, 0.35])
        expect(stripDriftAt(local, seg), `seg ${seg} local ${local}`).toBe(0);
      expect(stripDriftAt(0.95, seg), `seg ${seg}`).toBeCloseTo(2.2, 10);
      expect(stripDriftAt(1, seg), `seg ${seg} past the end`).toBeCloseTo(
        2.2,
        10,
      );
    }
  });

  it("travels monotonically", () => {
    for (const seg of SEGS) {
      let prev = -1;
      for (const local of SAMPLES) {
        const v = stripDriftAt(local, seg);
        expect(v, `seg ${seg} local ${local}`).toBeGreaterThanOrEqual(prev);
        prev = v;
      }
    }
  });

  it("leaves the flock one sector at a time, in MERIDIAN order", () => {
    // The point of the per-sector window, and of keying it on driftOrderOf: no
    // two sectors share a window, and the order they go in is the order their
    // seams come round — the same key the `peel` recipe fans its unroll on, so a
    // strip drifts on the heels of its own unroll.
    const order = [...SEGS].sort((a, b) => driftOrderOf(a) - driftOrderOf(b));
    const wins = order.map(driftWindowOf);
    for (let s = 1; s < SEG_COUNT; s++) {
      expect(
        wins[s][0],
        `${order[s]} opens after ${order[s - 1]}`,
      ).toBeGreaterThan(wins[s - 1][0]);
      expect(
        wins[s][1],
        `${order[s]} lands after ${order[s - 1]}`,
      ).toBeGreaterThan(wins[s - 1][1]);
    }
    // …and the sequence is visible mid-scene rather than only in the numbers
    const mid = order.map((s) => stripDriftAt(0.66, s));
    for (let s = 1; s < SEG_COUNT; s++)
      expect(mid[s], `${order[s]} vs ${order[s - 1]} at 0.66`).toBeLessThan(
        mid[s - 1],
      );
  });
});

/** the two tubes' wedge counts, in TUBE_FAMILY_ORDER — the cut each is really
 *  segmented on (five for the chassis, seven for the cam barrel) */
const TUBE_SEGS: Record<string, number[]> = {
  Chassis_Fixed: [0, 1, 2, 3, 4],
  Cam_Barrel: [0, 1, 2, 3, 4, 5, 6],
};
const TUBE_PIECES = TUBE_FAMILY_ORDER.flatMap((family) =>
  TUBE_SEGS[family].map((seg) => ({ family, seg })),
);

describe("the inner tubes' departure", () => {
  it("opens AFTER the skin's own wink-out and closes before the bore does", () => {
    for (const { family, seg } of TUBE_PIECES) {
      const [a, b] = tubeDriftWindowOf(family, seg);
      // the shell gate starts winking the skin away at peel-local 0.6
      expect(a, `${family}_Seg${seg} opens`).toBeGreaterThanOrEqual(0.48);
      // …and it has winked every TUBE away by ~0.85, so a wedge still
      // travelling then would vanish mid-flight
      expect(b, `${family}_Seg${seg} lands`).toBeLessThanOrEqual(0.84);
    }
  });

  it("leaves before the baffles do — the reveal layers outside-in", () => {
    // The two flocks overlap in the middle, as the strips' and the tubes' do:
    // what has to hold is that the tubes' fan sits EARLIER in the peel at both
    // of its ends, so the tube layer is coming off while the bore is still
    // closed and not the other way round. (The order a viewer actually reads is
    // the gate's — core/scene's four bands — and this is the drift that feeds
    // it.)
    const baffleOpens = BAFFLE_FAMILY_ORDER.flatMap((family) =>
      SEGS.map((seg) => baffleDriftWindowOf(family, seg)[0]),
    );
    const tubeOpens = TUBE_PIECES.map(
      ({ family, seg }) => tubeDriftWindowOf(family, seg)[0],
    );
    expect(Math.min(...tubeOpens), "first tube vs first baffle").toBeLessThan(
      Math.min(...baffleOpens),
    );
    expect(Math.max(...tubeOpens), "last tube vs last baffle").toBeLessThan(
      Math.max(...baffleOpens),
    );
  });

  it("gives every wedge its own window, the outer tube first", () => {
    const opens = TUBE_PIECES.map(
      ({ family, seg }) => tubeDriftWindowOf(family, seg)[0],
    );
    expect(new Set(opens.map((o) => o.toFixed(6))).size).toBe(
      TUBE_PIECES.length,
    );
    const openOf = ({ family, seg }: { family: string; seg: number }) =>
      tubeDriftWindowOf(family, seg)[0];
    const outer = TUBE_PIECES.filter((p) => p.family === "Chassis_Fixed");
    const inner = TUBE_PIECES.filter((p) => p.family === "Cam_Barrel");
    expect(Math.max(...outer.map(openOf))).toBeLessThan(
      Math.min(...inner.map(openOf)),
    );
  });

  it("names a tube wedge and nothing else", () => {
    expect(tubePiece("Cam_Barrel_Seg6")).toEqual({
      family: "Cam_Barrel",
      seg: 6,
    });
    // the family GROUP nodes, the hardware Chassis_Fixed adopts, and the other
    // casts must not be offset by this one
    for (const n of [
      "Chassis_Fixed",
      "Cam_Barrel",
      "Focus_Motor",
      "Focus_GuideRods",
      "Cam_OpticsCage_Seg2",
      "Barrel_Inner_Seg0",
      "Baffle_Rear_Seg0",
    ])
      expect(tubePiece(n), n).toBeUndefined();
  });
});

describe("the baffles' departure", () => {
  const PIECES = BAFFLE_FAMILY_ORDER.flatMap((family) =>
    SEGS.map((seg) => ({ family, seg })),
  );

  it("opens the bore AFTER the skin is off, and is done by the scene's end", () => {
    for (const { family, seg } of PIECES) {
      const [a, b] = baffleDriftWindowOf(family, seg);
      // the strips start at 0.35; nothing internal moves until they are away
      expect(a, `${family}_Seg${seg} opens`).toBeGreaterThanOrEqual(0.6);
      expect(b, `${family}_Seg${seg} lands`).toBeLessThanOrEqual(0.95);
    }
  });

  it("gives every plate its own window, the rear ring first", () => {
    const opens = PIECES.map(
      ({ family, seg }) => baffleDriftWindowOf(family, seg)[0],
    );
    expect(new Set(opens.map((o) => o.toFixed(6))).size).toBe(PIECES.length);
    // family-major: every plate of the rear ring goes before any optics trap
    const rear = PIECES.filter((p) => p.family === "Baffle_Rear");
    const front = PIECES.filter((p) => p.family !== "Baffle_Rear");
    const openOf = ({ family, seg }: { family: string; seg: number }) =>
      baffleDriftWindowOf(family, seg)[0];
    expect(Math.max(...rear.map(openOf))).toBeLessThan(
      Math.min(...front.map(openOf)),
    );
  });

  it("names a baffle wedge and nothing else", () => {
    expect(bafflePiece("Baffle_Rear_Seg3")).toEqual({
      family: "Baffle_Rear",
      seg: 3,
    });
    // the family GROUP nodes and the shell must not be offset by this cast
    for (const n of [
      "Baffle_Rear",
      "Optics_Baffle_G2",
      "Barrel_Inner_Seg0",
      "Optics_Cell_G3_Seg5",
    ])
      expect(bafflePiece(n), n).toBeUndefined();
  });
});

describe("the card cross-fade", () => {
  it("starts with the shell still rolling and no card yet out", () => {
    for (const k of KS) expect(cardFadeAt(k, 0.55), `card ${k}`).toBe(0);
  });

  it("is complete for every card by peel-local 0.98", () => {
    for (const k of KS) {
      expect(cardFadeAt(k, 0.98), `card ${k}`).toBe(1);
      expect(cardFadeAt(k, 1), `card ${k} past the end`).toBe(1);
    }
  });

  it("is staggered — the cards arrive in order, never together", () => {
    const mid = KS.map((k) => cardFadeAt(k, 0.75));
    for (let k = 1; k < CARD_COUNT; k++)
      expect(mid[k], `card ${k} vs ${k - 1}`).toBeLessThan(mid[k - 1]);
  });
});

describe("the field's fade-out", () => {
  it("is gone by internals-local 0.22, before the labels arrive", () => {
    for (const local of [0.22, 0.3, 1])
      expect(cardsFadeOutAt(local), `local ${local}`).toBe(1);
  });

  it("is still whole as the internals scene opens", () => {
    expect(cardsFadeOutAt(0)).toBe(0);
    expect(cardsFadeOutAt(0.1)).toBeGreaterThan(0);
    expect(cardsFadeOutAt(0.1)).toBeLessThan(1);
  });
});

describe("the orbit", () => {
  const TIMES = [0, 250, 1_000, 4_500, 12_000, 47_300, 600_000];

  it("is a pure function of (card, time)", () => {
    for (const k of KS)
      for (const t of TIMES)
        expect(cardOrbitAt(k, t), `card ${k} at ${t}ms`).toEqual(
          cardOrbitAt(k, t),
        );
  });

  it("rings the OPTICAL AXIS, always clear of the model", () => {
    // The ring is in Y–Z, about world X. The floor is the load-bearing number:
    // the model's silhouette is 2.8 wu, so a card centre inside ~3.4 would be
    // riding through the barrel instead of past it.
    for (const k of KS)
      for (const t of TIMES) {
        const o = cardOrbitAt(k, t);
        const r = Math.hypot(o.y, o.z);
        expect(r, `card ${k} at ${t}ms`).toBeGreaterThanOrEqual(3.4);
        expect(r, `card ${k} at ${t}ms`).toBeLessThanOrEqual(6.2);
      }
  });

  it("strings the rings ALONG the axis, and holds each card's station", () => {
    for (const k of KS) {
      const x = cardOrbitAt(k, 0).x;
      expect(Math.abs(x), `card ${k}`).toBeLessThanOrEqual(2.5);
      // the axial station is the card's, not the clock's: nothing but the ring
      // and the bob moves, so a card cannot wander down the barrel
      for (const t of TIMES)
        expect(cardOrbitAt(k, t).x, `card ${k} at ${t}ms`).toBe(x);
    }
    // the eight are spread across the run rather than stacked on one hoop
    const xs = KS.map((k) => cardOrbitAt(k, 0).x);
    expect(new Set(xs.map((x) => x.toFixed(6))).size).toBe(CARD_COUNT);
  });

  it("sweeps every card through a real range of camera depths", () => {
    // What the sizes come from: over a pass, a card's own Z (the story cameras
    // sit side-on-ish, ~20 wu out on +Z) swings by twice its ring radius, so no
    // two cards are at one depth for long.
    for (const k of KS) {
      const zs = Array.from(
        { length: 400 },
        (_, i) => cardOrbitAt(k, i * 500).z,
      );
      expect(Math.max(...zs) - Math.min(...zs), `card ${k}`).toBeGreaterThan(6);
    }
  });

  it("starts every card on its own phase", () => {
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
});

describe("the whole peel channel", () => {
  it("is asleep outside the two scenes it belongs to", () => {
    for (const p of [0, peR.p0 - 0.01, peR.p0, cdR.p1, cdR.p1 + 0.05, 1])
      expect(peelValueAt(p), `p ${p}`).toBe(0);
  });

  it("holds fully unrolled from the peel's tail into the cards", () => {
    for (const f of [0.72, 0.85, 1])
      expect(peelValueAt(atFrac(peR, f)), `peel ${f}`).toBe(1);
    for (const f of [0, 0.05])
      expect(peelValueAt(atFrac(cdR, f)), `cards ${f}`).toBe(1);
  });

  it("is released again by cards-local 0.35, behind the winked-out shell", () => {
    for (const f of [0.35, 0.6, 1])
      expect(peelValueAt(atFrac(cdR, f)), `cards ${f}`).toBe(0);
    const mid = peelValueAt(atFrac(cdR, 0.2));
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
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
    let posed = false;
    for (
      let up: number | undefined = i;
      up !== undefined;
      up = parent.get(up)
    ) {
      const nd = gltf.nodes[up];
      if (nd.translation) for (const k of [0, 1, 2]) c[k] += nd.translation[k];
      if (nd.rotation || nd.scale || nd.matrix) posed = true;
    }
    // the radial plane is X–Z; +Y is the optical axis
    return [
      { name: n.name, seg, angle: Math.atan2(c[2], c[0]), y: c[1], posed },
    ];
  });
}

const stripCentres = () =>
  centres((n) => (isShellPart(n) ? shellPartSector(n) : undefined));

/** shortest angular distance, in degrees */
const apart = (a: number, b: number) =>
  (Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b))) * 180) / Math.PI;

describe("the shell's seam convention", () => {
  const measured = stripCentres();
  const wedges = measured.filter((s) => isSegWedge(s.name));
  const decals = measured.filter((s) => !isSegWedge(s.name));

  it("is five sectors on each of five families — 25 wedges", () => {
    expect(wedges).toHaveLength(25);
    for (const seg of [0, 1, 2, 3, 4])
      expect(wedges.filter((w) => w.seg === seg)).toHaveLength(5);
  });

  it("puts every wedge on the sector segSectorAngle names for it", () => {
    for (const w of wedges)
      // 10°: the residual is the bounding box's own asymmetry (Barrel_Inner,
      // which carries interior geometry, is the worst at ~7°). Half a sector is
      // 36°, so this is nowhere near able to admit the wrong sector.
      expect(apart(w.angle, segSectorAngle(w.seg)), w.name).toBeLessThan(10);
  });

  it("carries every printed marking on a sector it really sits on", () => {
    // all 18 markings of the cast are in this GLB and all are assigned
    expect(decals).toHaveLength(18);
    for (const d of decals)
      // half a sector: past this the marking would be riding a strip it is not
      // printed on. DecalT_Zoom_35 (~33°) straddles a seam — see DECAL_SECTOR.
      expect(apart(d.angle, segSectorAngle(d.seg)), d.name).toBeLessThan(36);
  });

  it("hangs every strip off a chain of pure TRANSLATIONS", () => {
    // What makes a gltf-frame offset a world-radial offset: nothing between a
    // strip and the gltf root turns or scales its frame, so the only rotations
    // in play are core/scene's two model rolls (peelcards.ts drift()).
    for (const s of measured) expect(s.posed, s.name).toBe(false);
  });
});

describe("the inner tubes, against the shipped model", () => {
  const measured = centres((n) => tubePiece(n)?.seg);
  const familyOf = (name: string) => /^(.*)_Seg\d+$/.exec(name)![1];

  it("is two tubes on two DIFFERENT cuts — five wedges and seven", () => {
    expect(measured).toHaveLength(12);
    for (const family of TUBE_FAMILY_ORDER)
      expect(
        measured.filter((t) => familyOf(t.name) === family),
        family,
      ).toHaveLength(TUBE_SEGS[family].length);
  });

  it("puts every wedge on the sector tubeSectorAngle names for it", () => {
    // Same 10° tolerance the shell's wedges get, and for the same reason: the
    // residual is the bounding box's own asymmetry. Half of the NARROWER sector
    // (seven-way, so 25.7°) is still well clear of it, so this cannot admit the
    // wrong sector on either family.
    for (const t of measured)
      expect(
        apart(t.angle, tubeSectorAngle(familyOf(t.name), t.seg)),
        t.name,
      ).toBeLessThan(10);
  });

  it("hangs every wedge off a chain of pure TRANSLATIONS", () => {
    // What makes the gltf-frame offset a world-radial one. `Cam_Barrel`'s GROUP
    // node is additionally turned at runtime by the zoom mechanism — harmless
    // here, since the drift only opens at peel-local 0.48 and the zoom channel
    // is home by peel-local 0.4, and a turned parent would rotate the offset
    // with the wedge's own meridian in any case.
    for (const t of measured) expect(t.posed, t.name).toBe(false);
  });
});

describe("the baffles, against the shipped model", () => {
  const measured = centres((n) => bafflePiece(n)?.seg);
  // the lens body spans y ≈ 1…77, so this is the plane an exit is chosen about
  const MID_Y = 39;

  it("is three rings of five, cut on the SHELL's seams", () => {
    expect(measured).toHaveLength(15);
    for (const family of BAFFLE_FAMILY_ORDER)
      expect(
        measured.filter((b) => b.name.startsWith(`${family}_Seg`)),
        family,
      ).toHaveLength(SEG_COUNT);
    // riding segSectorAngle is what lets a baffle fan out like a strip
    for (const b of measured)
      expect(apart(b.angle, segSectorAngle(b.seg)), b.name).toBeLessThan(10);
  });

  it("sends every plate out of the END IT IS NEAREST", () => {
    // The claim BAFFLE_EXIT makes about the model: a plate's exit sign is the
    // side of the mid-plane it sits on. A re-export that moves one across must
    // fail here, not as a baffle sliding the length of the optical column.
    for (const b of measured) {
      const family = /^(.*)_Seg\d+$/.exec(b.name)![1];
      const [a, z] = baffleDriftWindowOf(family, b.seg);
      expect(z, `${b.name} has a window`).toBeGreaterThan(a);
      expect(Math.sign(b.y - MID_Y), b.name).toBe(
        family === "Baffle_Rear" ? -1 : 1,
      );
    }
  });

  it("hangs every plate off a chain of pure TRANSLATIONS", () => {
    for (const b of measured) expect(b.posed, b.name).toBe(false);
  });
});
