import { afterEach, describe, expect, it } from "vitest";
import { NUM } from "../algebra";
import { gate } from "../gate";
import { makeRecipes, type Recipe } from "../recipes";
import {
  JOINT_SUMS,
  KNOB_LIMITS,
  recipeChannel,
  recipeChannels,
  recipeKnob,
  recipeKnobs,
  resetRecipeKnobs,
} from "../host";

// The KNOB_LIMITS contract (ops/host.ts). The hard idle gate multiplies the
// whole delta by step(1e-6, channel) — zero at channel 0 — and NaN · 0 is NaN,
// so a knob setting that makes ops/gate.ts (or an op's own denominator) divide
// by zero would push NaN through the gate the seated render's bit-exactness
// rests on. This file is the proof that no value inside the limits can: it
// walks the CORNERS of every limit box (plus the interior, plus the untouched
// defaults) through the real gateSpec + gate and asserts the identity pair
// (flight 0, stick 1), finite.

const RECIPES = makeRecipes<number>(NUM);
const NAMES = Object.keys(RECIPES) as Recipe<number>["name"][];

// The knob uniforms are MODULE state — one table for the whole process — so a
// test that writes one leaks into every later test. Restoring here rather than
// at the end of each test means a mid-test failure cannot leak either. This is
// the SHIPPING reset (/lens runs it between animation selections), not a
// test-local copy of it — the ordering it has to get right (joint pairs zeroed
// before the defaults are written) is exactly the same problem.
afterEach(() => {
  resetRecipeKnobs();
});

/** The JOINT constraint applied exactly as the knob VIEW applies it: the second
 *  knob of the pair is clamped against the first's current value (ops/host
 *  jointClamped), the first is left alone. A raw box corner like assemble's
 *  (0.9, 0.9) is therefore NOT reachable, and this projection is what makes the
 *  corner walk below describe reachable settings rather than imaginary ones. */
function projectJoint(
  name: Recipe<number>["name"],
  k: Record<string, number>,
): Record<string, number> {
  const j = JOINT_SUMS[name];
  if (!j) return k;
  const [a, b] = j.pair;
  return { ...k, [b]: Math.max(0, Math.min(k[b], j.max - k[a])) };
}

/** Every corner of the limit box, plus its centre, plus the JOINT corner the
 *  meridian preset drives (formation-anims: stagger 0.06 then
 *  partStagger 0.78 — the pair sums to 0.84, inside the 0.9 cap, and no per-knob
 *  box corner lands near it). A knob with no limit keeps its default (it is not
 *  a gate input). */
function knobSets(name: Recipe<number>["name"]): Record<string, number>[] {
  const defaults = RECIPES[name].knobDefaults;
  const limits = KNOB_LIMITS[name] ?? {};
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
  if (name === "assemble")
    sets.push({ ...defaults, stagger: 0.06, partStagger: 0.78 });
  return sets.map((k) => projectJoint(name, k));
}

describe("KNOB_LIMITS — the gate identity survives every reachable setting", () => {
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
    const [lo, hi] = KNOB_LIMITS.assemble!.stagger;
    // the BOX alone is the subject here — the joint cap (below) would otherwise
    // eat the partner's own default out of the ceiling
    recipeKnob("assemble", "partStagger").value = 0;
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
    expect(table.assemble.split.value).toBe(KNOB_LIMITS.assemble!.split[1]);
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
    expect(flatten.value).toBe(KNOB_LIMITS.assemble!.flatten[0]);
    expect(flatten.value).toBe(0.05);
  });

  it("clamps a CHANNEL write — the 0..1 scrub the idle gate reads directly", () => {
    // The channel boxes are the other write surface into the graph (scene.ts
    // drives them every frame, the dev console can poke them), and the hard
    // idle gate reads `channel` raw: a NaN there multiplies the delta by
    // step(1e-6, NaN) and NaN · 0 is NaN — the same hole KNOB_LIMITS closes on
    // the knob side.
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

  it("clamps the JOINT pair's sum, capping the knob being WRITTEN", () => {
    const { max } = JOINT_SUMS.assemble!;
    const stagger = recipeKnob("assemble", "stagger");
    const partStagger = recipeKnob("assemble", "partStagger");
    // each half is reachable on its own…
    stagger.value = 0;
    partStagger.value = 0.9;
    expect(partStagger.value).toBe(0.9);
    // …but the second write only gets the headroom the first left, and it never
    // moves the partner (order-dependent by design — ops/host JOINT_SUMS)
    stagger.value = 0.5;
    expect(stagger.value).toBeCloseTo(max - 0.9, 12);
    expect(partStagger.value).toBe(0.9);
    // the ceiling is read at WRITE time, not captured when the view was built
    partStagger.value = 0.3;
    stagger.value = 0.5;
    expect(stagger.value).toBe(0.5);
    expect(stagger.value + partStagger.value).toBeLessThanOrEqual(max);
  });

  it("leaves a non-gate knob unclamped but never lets a NaN in", () => {
    // A knob outside KNOB_LIMITS feeds op amplitudes only, so a silly value is a
    // silly POSE and stays reachable — but NaN is not a pose: the idle gate
    // multiplies it by zero and NaN · 0 = NaN, which kills the SEATED render
    // (the one thing no knob is allowed to touch).
    const hover = recipeKnob("explode", "hover");
    hover.value = 50;
    expect(hover.value).toBe(50);
    hover.value = NaN;
    expect(hover.value).toBe(50);
    hover.value = Number.POSITIVE_INFINITY;
    expect(hover.value).toBe(50);
  });

  it("hands back the SAME box every call, for every knob", () => {
    // Identity is a contract, not an accident: explore/scene-kit's set() keys
    // its first-write undo snapshot on the box object, so a fresh view per call
    // would record one undo per write instead of one per knob.
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
    // Every call site is a module-load constant, so a typo has to fail at import
    // instead of handing a slider a uniform no shader reads.
    expect(() => recipeKnob("assemble", "staggerr")).toThrow(/staggerr/);
    expect(() => recipeKnob("assmeble" as "assemble", "stagger")).toThrow(
      /assmeble/,
    );
  });

  it("resetRecipeKnobs restores every knob, joint pair included", () => {
    const stagger = recipeKnob("assemble", "stagger");
    const partStagger = recipeKnob("assemble", "partStagger");
    const hover = recipeKnob("explode", "hover");
    // the meridian preset: the joint pair parked far from its defaults, plus an
    // unlimited knob a slider dragged
    stagger.value = 0.06;
    partStagger.value = 0.78;
    hover.value = 50;

    resetRecipeKnobs();

    for (const name of NAMES)
      for (const [knob, v] of Object.entries(RECIPES[name].knobDefaults))
        expect(recipeKnob(name, knob).value, `${name}.${knob}`).toBe(v);
  });

  it("every knob default sits inside its own limit", () => {
    for (const name of NAMES) {
      for (const [knob, [lo, hi]] of Object.entries(KNOB_LIMITS[name] ?? {})) {
        const v = RECIPES[name].knobDefaults[knob];
        expect(v, `${name}.${knob} default`).toBeGreaterThanOrEqual(lo);
        expect(v, `${name}.${knob} default`).toBeLessThanOrEqual(hi);
      }
    }
  });
});
