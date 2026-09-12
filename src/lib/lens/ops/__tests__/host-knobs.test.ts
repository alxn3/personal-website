import { afterEach, describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { gate } from "../gate";
import { makeRecipes, type Recipe } from "../recipes";
import {
  recipeChannel,
  recipeChannels,
  recipeKnob,
  recipeKnobs,
  resetRecipeKnobs,
} from "../host";

// The knob RANGE contract (ops/recipes.ts knobSpec, clamped by ops/host.ts): a
// NaN inside a live recipe's branch reaches the render, so no reachable knob
// setting may zero a gate or op denominator. Walks the corners of every range
// box (plus interior and defaults) through the real gateSpec + gate.

const RECIPES = makeRecipes<number>(NUM);
const NAMES = Object.keys(RECIPES) as Recipe<number>["name"][];

/** every ranged knob of a recipe, with its [lo, hi] */
function limitsOf(
  name: Recipe<number>["name"],
): Record<string, readonly [number, number]> {
  const out: Record<string, readonly [number, number]> = {};
  for (const [k, row] of Object.entries(RECIPES[name].knobSpec))
    if (row.range) out[k] = row.range;
  return out;
}
const rangeOf = (name: Recipe<number>["name"], knob: string) =>
  RECIPES[name].knobSpec[knob].range!;

// The knob uniforms are MODULE state, so a write leaks into every later test.
// This is the SHIPPING reset, not a test-local copy.
afterEach(() => {
  resetRecipeKnobs();
});

/** Every corner of the limit box, plus its centre. A knob with no limit keeps
 *  its default — it is not a gate input. */
function knobSets(name: Recipe<number>["name"]): Record<string, number>[] {
  const defaults = RECIPES[name].knobDefaults;
  const limits = limitsOf(name);
  const keys = Object.keys(limits);
  const sets: Record<string, number>[] = [{ ...defaults }];
  for (let mask = 0; mask < 1 << keys.length; mask++) {
    const k: Record<string, number> = { ...defaults };
    keys.forEach((key, i) => (k[key] = limits[key][(mask >> i) & 1]));
    sets.push(k);
  }
  const mid: Record<string, number> = { ...defaults };
  for (const key of keys) mid[key] = (limits[key][0] + limits[key][1]) / 2;
  sets.push(mid);
  return sets;
}

describe("knob ranges — the gate identity survives every reachable setting", () => {
  it("gives flight 0 / stick 1, finite, at channel 0 for every piece", () => {
    for (const name of NAMES) {
      for (const knobs of knobSets(name)) {
        const spec = RECIPES[name].gateSpec(knobs);
        for (const rank01 of [0, 0.37, 1]) {
          for (const layerPhase of [0, 0.5, 1]) {
            const g = gate(NUM, spec, 0, { rank01, layerPhase });
            const where = `${name} ${JSON.stringify(knobs)} rank ${rank01} phase ${layerPhase}`;
            expect(Number.isFinite(g.flight), `flight ${where}`).toBe(true);
            expect(Number.isFinite(g.stick), `stick ${where}`).toBe(true);
            expect(g.flight, `flight ${where}`).toBeCloseTo(0, 12);
            expect(g.stick, `stick ${where}`).toBeCloseTo(1, 12);
          }
        }
      }
    }
  });

  it("keeps every gate denominator positive across the limits", () => {
    for (const name of NAMES) {
      for (const knobs of knobSets(name)) {
        const spec = RECIPES[name].gateSpec(knobs) as {
          windowFrac: number;
          split: number;
          overlap?: number;
          flightStart?: number;
          rollEnd?: number;
        };
        const overlap = spec.overlap ?? 0;
        const flightStart = spec.flightStart ?? 0;
        const rollEnd = spec.rollEnd ?? 1;
        const ov = Math.min(overlap, spec.split);
        expect(spec.windowFrac, `${name} windowFrac`).toBeGreaterThanOrEqual(
          0.05,
        );
        expect(spec.split - flightStart, `${name} flight span`).toBeGreaterThan(
          0,
        );
        expect(rollEnd - spec.split + ov, `${name} stick span`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it("stays finite mid-channel too, not just at the identity anchor", () => {
    for (const name of NAMES) {
      for (const knobs of knobSets(name)) {
        const spec = RECIPES[name].gateSpec(knobs);
        for (const channel of [0.001, 0.25, 0.5, 0.75, 1]) {
          const g = gate(NUM, spec, channel, { rank01: 0.5, layerPhase: 0.5 });
          expect(Number.isFinite(g.flight), `${name} @ ${channel}`).toBe(true);
          expect(Number.isFinite(g.stick), `${name} @ ${channel}`).toBe(true);
        }
      }
    }
  });
});

describe("recipeKnob — the clamp at the uniform boundary", () => {
  it("clamps a listed knob to its limits and rejects non-finite writes", () => {
    const stagger = recipeKnob("assemble", "stagger");
    const [lo, hi] = rangeOf("assemble", "stagger");
    stagger.value = 5;
    expect(stagger.value).toBe(hi);
    stagger.value = -3;
    expect(stagger.value).toBe(lo);
    stagger.value = NaN;
    expect(stagger.value).toBe(lo);
    stagger.value = 0.5;
    expect(stagger.value).toBe(0.5);

    // …and the same wrapper is what the dev table hands out.
    const table = recipeKnobs();
    table.assemble.split.value = 9;
    expect(table.assemble.split.value).toBe(rangeOf("assemble", "split")[1]);
  });

  it("clamps the DIVISOR knobs, which zero a denominator rather than the gate", () => {
    // rollR = R·mix(0.45, 0.18, curl) reaches 0 at curl = 5/3, and the roll
    // segment's q = −R/rollR goes non-finite there.
    const curl = recipeKnob("assemble", "curl");
    curl.value = 5 / 3;
    expect(curl.value).toBe(1);
    // assemble's flatten: the wrap's main arc is q = R/rf with
    // rf = Rb·mix(flatten, 1, stick), so an UNSTUCK piece (stick = 0 — the
    // whole flight) divides by flatten itself.
    const flatten = recipeKnob("assemble", "flatten");
    flatten.value = 0;
    expect(flatten.value).toBe(rangeOf("assemble", "flatten")[0]);
    expect(flatten.value).toBe(0.05);
    // explode's coil divides by 1 + curl·(1 − flight)² + rebend·bloom, so all
    // three are floored at 0 and the factor never drops below 1.
    for (const knob of ["curl", "rebend", "bloom"]) {
      const box = recipeKnob("explode", knob);
      box.value = -1;
      expect(box.value, knob).toBe(0);
    }
    recipeKnob("explode", "bloom").value = 4.5; // the story's ending bloom
    expect(recipeKnob("explode", "bloom").value).toBe(4.5);
  });

  it("clamps a CHANNEL write — the 0..1 scrub the idle gate reads directly", () => {
    // The idle branch reads `channel` raw, so a NaN write is undefined
    // behaviour at the gate — the same hole the knob ranges close.
    const explode = recipeChannel("explode");
    const before = explode.value;
    try {
      explode.value = NaN;
      expect(Number.isFinite(explode.value)).toBe(true);
      expect(explode.value).toBe(0); // the low limit, not a propagated NaN
      explode.value = 5;
      expect(explode.value).toBe(1);
      explode.value = -3;
      expect(explode.value).toBe(0);
      explode.value = 0.42;
      expect(explode.value).toBe(0.42);
      // …and the bulk table hands out the SAME clamping view, not a raw box.
      const box = recipeChannels().explode;
      box.value = Number.POSITIVE_INFINITY;
      expect(box.value).toBe(0);
    } finally {
      explode.value = before;
    }
  });

  it("leaves a non-gate knob unclamped but never lets a NaN in", () => {
    // An unranged knob feeds op amplitudes only, so a silly value is a silly
    // POSE and stays reachable — but a NaN would reach the render while live.
    const ringPhase = recipeKnob("explode", "ringPhase");
    ringPhase.value = 50;
    expect(ringPhase.value).toBe(50);
    ringPhase.value = NaN;
    expect(ringPhase.value).toBe(50);
    ringPhase.value = Number.POSITIVE_INFINITY;
    expect(ringPhase.value).toBe(50);
  });

  it("hands back the SAME box every call, for every knob", () => {
    // explore/scene-kit's set() keys its undo snapshot on the box object, so a
    // fresh view per call would record one undo per write instead of per knob.
    for (const name of NAMES)
      for (const knob of Object.keys(RECIPES[name].knobDefaults)) {
        expect(recipeKnob(name, knob), `${name}.${knob}`).toBe(
          recipeKnob(name, knob),
        );
        expect(recipeKnobs()[name][knob], `${name}.${knob} table`).toBe(
          recipeKnob(name, knob),
        );
      }
  });

  it("throws on an unknown recipe or knob rather than detaching a uniform", () => {
    // Call sites are module-load constants, so a typo must fail at import
    // instead of handing a slider a uniform no shader reads.
    expect(() => recipeKnob("assemble", "staggerr")).toThrow(/staggerr/);
    expect(() => recipeKnob("assmeble" as "assemble", "stagger")).toThrow(
      /assmeble/,
    );
  });

  it("resetRecipeKnobs restores every knob", () => {
    // a ranged knob and an unranged one, parked far from their defaults
    recipeKnob("assemble", "stagger").value = 0.06;
    recipeKnob("explode", "ringPhase").value = 50;

    resetRecipeKnobs();

    for (const name of NAMES)
      for (const [knob, v] of Object.entries(RECIPES[name].knobDefaults))
        expect(recipeKnob(name, knob).value, `${name}.${knob}`).toBe(v);
  });

  it("every knob default sits inside its own range", () => {
    for (const name of NAMES) {
      for (const [knob, [lo, hi]] of Object.entries(limitsOf(name))) {
        const v = RECIPES[name].knobDefaults[knob];
        expect(v, `${name}.${knob} default`).toBeGreaterThanOrEqual(lo);
        expect(v, `${name}.${knob} default`).toBeLessThanOrEqual(hi);
      }
    }
  });
});
