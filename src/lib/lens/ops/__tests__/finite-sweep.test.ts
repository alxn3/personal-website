import { describe, expect, it } from "vitest";
import { opsFold } from "../emit/deform.js";
import { LAYOUT } from "../emit/layout";
import { IDLE_EPS } from "../emit/emit";
import { packFlags, WINK_NONE } from "../frames";
import { PART_CLASS } from "../ops";
import { makeRecipes, type RecipeName } from "../recipes";
import { NUM } from "../algebra";
import { knobArray, knobCorners, v4, XYZW } from "./fixture";

// The checked-in deform must never output NaN or Inf: sweeps knob-range
// corners, channel edges, a spread of frame values and a few probe points.

const RECIPES = makeRecipes(NUM);

/** Every corner of the ranged box × the unranged knobs at default / 0 / 50. */
function knobSets(name: RecipeName): Record<string, number>[] {
  const spec = RECIPES[name].knobSpec;
  const free = Object.keys(spec).filter((k) => !spec[k].range);
  return [undefined, 0, 50].flatMap((at) =>
    knobCorners(RECIPES[name]).map((k) => {
      if (at !== undefined) for (const key of free) k[key] = at;
      return k;
    }),
  );
}

/** Frame values the model can carry: every class, both flags, thin and deep
 *  walls, a full ring, a thin sliver, and R at its floor. */
const LANES = [
  { cls: PART_CLASS.structure, axi: 0, adopted: 0, depth: 0, rank: 0.5, half: 0.4, R: 20 }, // prettier-ignore
  { cls: PART_CLASS.structure, axi: 1, adopted: 0, depth: 0, rank: 0, half: Math.PI, R: 20 }, // prettier-ignore
  { cls: PART_CLASS.decal, axi: 0, adopted: 1, depth: 0.1, rank: 1, half: 0.4, R: 30 }, // prettier-ignore
  { cls: PART_CLASS.kept, axi: 0, adopted: 1, depth: 0.5, rank: 1, half: 0.63, R: 29 }, // prettier-ignore
  { cls: PART_CLASS.glass, axi: 1, adopted: 0, depth: 0.3, rank: 0, half: Math.PI, R: 12 }, // prettier-ignore
  { cls: PART_CLASS.iris, axi: 0, adopted: 0, depth: 0, rank: 0.2, half: 0.1, R: 8 }, // prettier-ignore
  { cls: PART_CLASS.accessory, axi: 0, adopted: 0, depth: 0.02, rank: 1, half: 0.4, R: 40 }, // prettier-ignore
  { cls: PART_CLASS.structure, axi: 0, adopted: 0, depth: 1, rank: 0.5, half: 1e-3, R: 0.5 }, // prettier-ignore
];
const T0 = 0.7;
const Y = [-3, 3];
const CHANNELS = [IDLE_EPS, 1e-3, 0.5, 1 - 1e-6, 1];

/** Each lane's packed frame, with probe points on and off the wall, past the
 *  seam, at each axial edge, and on the optical axis itself. */
const PIECES = LANES.map((l) => {
  const pts = [{ x: 0, y: 0, z: 0 }];
  for (const phi of [0, l.half * 1.2])
    for (const off of [0, 0.3 * l.R])
      for (const y of [Y[0], (Y[0] + Y[1]) / 2, Y[1]])
        pts.push({ x: (l.R + off) * Math.cos(T0 + phi), y, z: (l.R + off) * Math.sin(T0 + phi) }); // prettier-ignore
  return {
    pts,
    a: v4(T0, l.R, l.half * 2, l.rank),
    b: v4(0.37, l.cls, -12.5, packFlags(l.axi, l.adopted)),
    y: v4(Y[0], Y[1], l.depth, WINK_NONE),
  };
});

/** Fail on the first non-finite output over every lane and probe. */
function expectFinite(
  ch: ReturnType<typeof v4>,
  k: ReturnType<typeof knobArray>,
  at: string,
): number {
  const out = new Float64Array(4);
  let cases = 0;
  PIECES.forEach(({ pts, a, b, y }, li) => {
    for (const p of pts) {
      opsFold(p, a, b, y, ch, k, out);
      for (let c = 0; c < 4; c++)
        if (!Number.isFinite(out[c]))
          expect.fail(`${at} lane ${li} probe ${JSON.stringify(p)} [${"xyzr"[c]}] = ${out[c]}`); // prettier-ignore
      cases++;
    }
  });
  return cases;
}

describe("the emitted deform is finite over every reachable input", () => {
  it("one recipe at a time: every knob corner × channel edge × lane × probe", () => {
    let cases = 0;
    LAYOUT.names.forEach((name, ri) => {
      for (const knobs of knobSets(name)) {
        const k = knobArray({ [name]: knobs });
        for (const channel of CHANNELS) {
          const ch = v4();
          ch[XYZW[ri]] = channel;
          cases += expectFinite(ch, k, `${name} ${JSON.stringify(knobs)} ch ${channel}`); // prettier-ignore
        }
      }
    });
    expect(cases).toBeGreaterThan(50000);
  });

  it("every recipe live at once, at the defaults and at the story's knobs", () => {
    const knobs = Object.fromEntries(
      LAYOUT.names.map((n) => [n, RECIPES[n].knobDefaults]),
    ) as Record<RecipeName, Record<string, number>>;
    knobs.explode = { ...knobs.explode, bloom: 4.5, curl: 4.5, ringPhase: 0.0325, rebend: 1 }; // prettier-ignore
    for (const channel of CHANNELS)
      expectFinite(v4(channel, channel, channel, channel), knobArray(knobs), `ch ${channel}`); // prettier-ignore
  });
});
