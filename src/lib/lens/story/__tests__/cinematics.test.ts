import { describe, expect, it } from "vitest";
import { DUST_BOX, DUST_N, DUST_SEED, dustField } from "../cinematics";

describe("the dust field", () => {
  it("is one fixed field per seed, and a different one under another seed", () => {
    expect(dustField()).toEqual(dustField());
    expect(dustField(DUST_N, DUST_SEED)).toEqual(dustField());
    expect(dustField(DUST_N, DUST_SEED + 1)).not.toEqual(dustField());
  });

  it("fills the box, one xyz triple per mote", () => {
    const f = dustField();
    expect(f.length).toBe(DUST_N * 3);
    for (let i = 0; i < f.length; i++) {
      expect(Math.abs(f[i])).toBeLessThanOrEqual(DUST_BOX[i % 3]);
    }
    // spread out, not clumped
    const meanX =
      f.filter((_, i) => i % 3 === 0).reduce((a, b) => a + b) / DUST_N;
    expect(Math.abs(meanX)).toBeLessThan(DUST_BOX[0] * 0.15);
  });
});
