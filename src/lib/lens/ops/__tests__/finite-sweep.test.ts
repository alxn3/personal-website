import { describe, expect, it } from "vitest";
import { opsFold } from "../emit/deform.js";
import { LAYOUT } from "../emit/layout";
import { IDLE_EPS } from "../emit/emit";
import { packFlags, WINK_NONE } from "../frames";
import { PART_CLASS } from "../ops";
import { makeRecipes, type RecipeName } from "../recipes";
import { NUM } from "../algebra";

// THE FINITE-OUTPUT CONTRACT (host.ts law 3): a NaN or Inf inside a live
// branch reaches the render, so no reachable knob setting, lane the model can
// carry or channel edge may produce one. Coarse on purpose — every corner of
// every ranged knob box with the unranged knobs at their default, 0 and a
// silly value, the channel's edges, a spread of lane rows and a few probe
// points — through the CHECKED-IN fold, the text the shader runs.

const RECIPES = makeRecipes(NUM);
const XYZW = ["x", "y", "z", "w"] as const;
const v4 = (x = 0, y = 0, z = 0, w = 0) => ({ x, y, z, w });

/** Every corner of the ranged box × the unranged knobs at default / 0 / 50. */
function knobSets(name: RecipeName): Record<string, number>[] {
  const spec = RECIPES[name].knobSpec;
  const ranged = Object.keys(spec).filter((k) => spec[k].range);
  const free = Object.keys(spec).filter((k) => !spec[k].range);
  const sets: Record<string, number>[] = [];
  for (const freeAt of [null, 0, 50]) {
    for (let mask = 0; mask < 1 << ranged.length; mask++) {
      const k = { ...RECIPES[name].knobDefaults };
      ranged.forEach((key, i) => (k[key] = spec[key].range![(mask >> i) & 1]));
      if (freeAt !== null) for (const key of free) k[key] = freeAt;
      sets.push(k);
    }
  }
  return sets;
}

/** Lane rows the shipped model can carry: every class, both flags, a thin and
 *  a deep wall, a full ring, a sliver of a sector, and R at frames.ts's floor. */
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

/** Probe points: on the mid-surface, on the wall, past the seam (overrun), at
 *  each axial edge — and the optical axis itself (atan2(0, 0)). */
function probes(l: (typeof LANES)[number]) {
  const pts: { x: number; y: number; z: number }[] = [];
  for (const phi of [0, l.half * 1.2])
    for (const off of [0, 0.3 * l.R])
      for (const y of [Y[0], (Y[0] + Y[1]) / 2, Y[1]])
        pts.push({ x: (l.R + off) * Math.cos(T0 + phi), y, z: (l.R + off) * Math.sin(T0 + phi) }); // prettier-ignore
  pts.push({ x: 0, y: 0, z: 0 });
  return pts;
}

describe("the emitted deform is finite over every reachable input", () => {
  const out = new Float64Array(4);
  const laneVecs = LANES.map((l) => [
    v4(T0, l.R, l.half * 2, l.rank),
    v4(0.37, l.cls, -12.5, packFlags(l.axi, l.adopted)),
    v4(Y[0], Y[1], l.depth, WINK_NONE),
  ]);

  it("one recipe at a time: every knob corner × channel edge × lane × probe", () => {
    let cases = 0;
    LAYOUT.names.forEach((name, ri) => {
      for (const knobs of knobSets(name)) {
        const k = Array.from({ length: LAYOUT.vec4Count }, () => v4());
        for (const [kn, val] of Object.entries(knobs)) {
          const lane = LAYOUT.knob[name][kn];
          k[lane.vec4][XYZW[lane.lane]] = val;
        }
        for (const channel of CHANNELS) {
          const ch = v4();
          ch[XYZW[ri]] = channel;
          LANES.forEach((l, li) => {
            const [a, b, y] = laneVecs[li];
            for (const p of probes(l)) {
              opsFold(p, a, b, y, ch, k, out);
              for (let c = 0; c < 4; c++)
                if (!Number.isFinite(out[c]))
                  expect.fail(`${name} ${JSON.stringify(knobs)} ch ${channel} lane ${li} probe ${JSON.stringify(p)} [${"xyzr"[c]}] = ${out[c]}`); // prettier-ignore
              cases++;
            }
          });
        }
      }
    });
    expect(cases).toBeGreaterThan(50000);
  });

  it("every recipe live at once, at the defaults and at the story's knobs", () => {
    const k = Array.from({ length: LAYOUT.vec4Count }, () => v4());
    for (const name of LAYOUT.names)
      for (const [kn, val] of Object.entries(RECIPES[name].knobDefaults)) {
        const lane = LAYOUT.knob[name][kn];
        k[lane.vec4][XYZW[lane.lane]] = val;
      }
    const story = { bloom: 4.5, curl: 4.5, ringPhase: 0.0325, rebend: 1 };
    for (const [kn, val] of Object.entries(story)) {
      const lane = LAYOUT.knob.explode[kn];
      k[lane.vec4][XYZW[lane.lane]] = val;
    }
    for (const channel of CHANNELS) {
      const ch = v4(channel, channel, channel, channel);
      LANES.forEach((l, li) => {
        const [a, b, y] = laneVecs[li];
        for (const p of probes(l)) {
          opsFold(p, a, b, y, ch, k, out);
          for (let c = 0; c < 4; c++)
            expect(Number.isFinite(out[c]), `ch ${channel} lane ${li} ${JSON.stringify(p)} [${"xyzr"[c]}]`).toBe(true); // prettier-ignore
        }
      });
    }
  });
});
