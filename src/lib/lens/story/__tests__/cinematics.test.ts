import { describe, expect, it } from "vitest";
import {
  DUST_BOX,
  DUST_N,
  DUST_SEED,
  dustField,
  seededRandom,
} from "../cinematics";

// The dust field is a pure function of its seed: the same motes on every load,
// so a screenshot pair differs only where something moved.

describe("the dust field", () => {
  it("is the same field on every build", () => {
    expect(dustField()).toEqual(dustField());
    expect(dustField(DUST_N, DUST_SEED)).toEqual(dustField());
  });

  it("is a different field under a different seed", () => {
    expect(dustField(DUST_N, DUST_SEED + 1)).not.toEqual(dustField());
  });

  it("fills the box, one xyz triple per mote", () => {
    const f = dustField();
    expect(f.length).toBe(DUST_N * 3);
    for (let i = 0; i < f.length; i++) {
      expect(Math.abs(f[i])).toBeLessThanOrEqual(DUST_BOX[i % 3]);
    }
    // spread through the volume, not clumped: the mean sits near the centre
    const meanX =
      f.filter((_, i) => i % 3 === 0).reduce((a, b) => a + b) / DUST_N;
    expect(Math.abs(meanX)).toBeLessThan(DUST_BOX[0] * 0.15);
  });

  it("draws from a generator over [0, 1) that repeats for a seed", () => {
    const a = seededRandom(7);
    const b = seededRandom(7);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
