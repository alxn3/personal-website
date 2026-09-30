import { afterEach, describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { gate } from "../gate";
import { makeRecipes, type RecipeName } from "../recipes";
import {
  recipeChannel,
  recipeChannels,
  recipeKnob,
  recipeKnobs,
  resetRecipeKnobs,
} from "../host";
import { knobCorners } from "./fixture";

// No knob value inside its range may zero a gate denominator (a NaN would reach
// the render), and the host's boxes clamp every write into that range.

const RECIPES = makeRecipes<number>(NUM);
const NAMES = Object.keys(RECIPES) as RecipeName[];

// Knob uniforms are module state; reset them after each test.
afterEach(() => resetRecipeKnobs());

/** The defaults, every corner of the range box, and its centre. */
function knobSets(name: RecipeName): Record<string, number>[] {
  const { knobSpec, knobDefaults } = RECIPES[name];
  const mid = { ...knobDefaults };
  for (const [k, row] of Object.entries(knobSpec))
    if (row.range) mid[k] = (row.range[0] + row.range[1]) / 2;
  return [knobDefaults, ...knobCorners(RECIPES[name]), mid];
}

describe("knob ranges — the gate survives every reachable setting", () => {
  it("is seated (flight 0, stick 1) at channel 0 for every piece, and finite at every channel", () => {
    for (const name of NAMES)
      for (const knobs of knobSets(name)) {
        const spec = RECIPES[name].gateSpec(knobs);
        for (const rank01 of [0, 0.37, 1])
          for (const layerPhase of [0, 0.5, 1]) {
            const where = `${name} ${JSON.stringify(knobs)} rank ${rank01} phase ${layerPhase}`;
            const g = gate(NUM, spec, 0, { rank01, layerPhase });
            expect(g.flight, `flight ${where}`).toBeCloseTo(0, 12);
            expect(g.stick, `stick ${where}`).toBeCloseTo(1, 12);
            for (const channel of [0.001, 0.25, 0.5, 0.75, 1]) {
              const m = gate(NUM, spec, channel, { rank01, layerPhase });
              expect([m.flight, m.stick].every(Number.isFinite), `${where} @ ${channel}`).toBe(true); // prettier-ignore
            }
          }
      }
  });

  it("keeps every gate denominator positive and the window at least 0.05", () => {
    for (const name of NAMES)
      for (const knobs of knobSets(name)) {
        const spec = RECIPES[name].gateSpec(knobs) as {
          windowFrac: number;
          split: number;
          overlap?: number;
          flightStart?: number;
          rollEnd?: number;
        };
        const ov = Math.min(spec.overlap ?? 0, spec.split);
        expect(spec.windowFrac, `${name} windowFrac`).toBeGreaterThanOrEqual(0.05); // prettier-ignore
        expect(spec.split - (spec.flightStart ?? 0), `${name} flight span`).toBeGreaterThan(0); // prettier-ignore
        expect((spec.rollEnd ?? 1) - spec.split + ov, `${name} stick span`).toBeGreaterThan(0); // prettier-ignore
      }
  });

  it("every knob default sits inside its own range", () => {
    for (const name of NAMES)
      for (const [knob, { default: v, range }] of Object.entries(
        RECIPES[name].knobSpec,
      ))
        // prettier-ignore
        if (range) {
          expect(v, `${name}.${knob}`).toBeGreaterThanOrEqual(range[0]);
          expect(v, `${name}.${knob}`).toBeLessThanOrEqual(range[1]);
        }
  });
});

describe("recipeKnob / recipeChannel — the clamp at the uniform boundary", () => {
  const range = (name: RecipeName, knob: string) =>
    RECIPES[name].knobSpec[knob].range!;

  it.each([
    // A ranged knob clamps, and a non-finite write lands on the low limit.
    ["assemble", "stagger", [5], range("assemble", "stagger")[1]],
    ["assemble", "stagger", [-3], range("assemble", "stagger")[0]],
    ["assemble", "stagger", [0.5, NaN], range("assemble", "stagger")[0]],
    ["assemble", "stagger", [0.5], 0.5],
    ["assemble", "split", [9], range("assemble", "split")[1]],
    // rollR = R·mix(0.45, 0.18, curl) hits 0 at curl = 5/3.
    ["assemble", "curl", [5 / 3], 1],
    // The main arc divides by flatten while stick = 0.
    ["assemble", "flatten", [0], 0.05],
    // explode's coil divisor stays ≥ 1 with all three floored at 0.
    ["explode", "curl", [-1], 0],
    ["explode", "rebend", [-1], 0],
    ["explode", "bloom", [-1], 0],
    ["explode", "bloom", [4.5], 4.5], // the story's ending value
    // An unranged knob is free, but ignores a non-finite write.
    ["explode", "ringPhase", [50, NaN, Infinity], 50],
  ] as const)("%s.%s after writing %j reads %d", (name, knob, writes, want) => {
    const box = recipeKnob(name, knob);
    for (const w of writes) box.value = w;
    expect(box.value).toBe(want);
    // The dev table hands out the same box.
    expect(recipeKnobs()[name][knob]).toBe(box);
  });

  it("clamps a channel write to 0..1; a non-finite write lands on 0", () => {
    const box = recipeChannel("explode");
    expect(recipeChannels().explode).toBe(box);
    try {
      for (const [write, want] of [
        [0.42, 0.42],
        [NaN, 0],
        [5, 1],
        [-3, 0],
        [0.42, 0.42],
        [Infinity, 0],
      ]) {
        // prettier-ignore
        box.value = write;
        expect(box.value, `write ${write}`).toBe(want);
      }
    } finally {
      box.value = 0;
    }
  });

  it("hands back the same box every call, and resetRecipeKnobs restores every knob", () => {
    // Callers key undo snapshots on the box object.
    recipeKnob("assemble", "stagger").value = 0.06;
    recipeKnob("explode", "ringPhase").value = 50;
    resetRecipeKnobs();
    for (const name of NAMES)
      for (const [knob, v] of Object.entries(RECIPES[name].knobDefaults)) {
        expect(recipeKnob(name, knob), `${name}.${knob}`).toBe(recipeKnob(name, knob)); // prettier-ignore
        expect(recipeKnob(name, knob).value, `${name}.${knob}`).toBe(v);
      }
  });

  it("throws on an unknown recipe or knob rather than detaching a uniform", () => {
    // A typo should fail loudly, not hand back a uniform no shader reads.
    expect(() => recipeKnob("assemble", "staggerr")).toThrow(/staggerr/);
    expect(() => recipeKnob("assmeble" as "assemble", "stagger")).toThrow(/assmeble/); // prettier-ignore
  });
});
