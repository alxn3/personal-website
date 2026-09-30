import { describe, expect, it } from "vitest";
import {
  captureBodyFade,
  restoreBodyFade,
  type FadeMaterial,
  type FadeSaved,
} from "../body-fade";

// A material added mid-fade is saved from its original state, gets the current
// opacity, and is restored exactly with the rest.

interface Mat extends FadeMaterial {
  name: string;
  updates: number;
}
const mat = (name: string, transparent = false): Mat => ({
  name,
  transparent,
  opacity: 1,
  updates: 0,
  set needsUpdate(_v: boolean) {
    this.updates++;
  },
  get needsUpdate() {
    return false;
  },
});
const owned = (m: Mat) => m.name.startsWith("owned");

describe("the body fade's capture", () => {
  it("folds a material that joins mid-fade in at the live level, touching the rest only for opacity", () => {
    const body = mat("body");
    const glass = mat("glass");
    const saved = new Map<Mat, FadeSaved>();
    captureBodyFade(saved, [body], owned, 0.3); // the dive owns the glass
    captureBodyFade(saved, [body, glass], owned, 0.2); // the swap went off
    expect(glass.opacity).toBe(0.2);
    expect(glass.transparent).toBe(true);
    expect(saved.get(glass)).toEqual({ transparent: false, opacity: 1 });
    expect(body.opacity).toBe(0.2);
    expect(body.updates).toBe(1); // no second program rebuild
    expect(saved.get(body)).toEqual({ transparent: false, opacity: 1 }); // not re-captured mid-fade
  });

  it("leaves `transparent` alone where another owner has it, and where it is already on", () => {
    const shared = mat("owned-blend");
    const already = mat("already", true);
    const saved = new Map<Mat, FadeSaved>();
    captureBodyFade(saved, [shared, already], owned, 0.5);
    expect(shared.transparent).toBe(false);
    expect(shared.updates).toBe(0);
    expect(already.updates).toBe(0);
    expect(shared.opacity).toBe(0.5);
  });

  it("restores every captured material exactly, the late one included, and empties the capture", () => {
    const body = mat("body");
    const glass = mat("glass");
    const shared = mat("owned-blend");
    const already = mat("already", true);
    const saved = new Map<Mat, FadeSaved>();
    captureBodyFade(saved, [body, shared, already], owned, 0.3);
    captureBodyFade(saved, [body, glass, shared, already], owned, 0.1);
    shared.transparent = true; // its owner moved it meanwhile
    restoreBodyFade(saved, owned);
    for (const m of [body, glass]) {
      expect(m.opacity).toBe(1);
      expect(m.transparent).toBe(false);
      expect(m.updates).toBe(2); // one raise, one restore
    }
    expect(shared.opacity).toBe(1);
    expect(shared.transparent).toBe(true); // not this fade's flag
    expect(shared.updates).toBe(0);
    expect(already.opacity).toBe(1);
    expect(already.transparent).toBe(true);
    expect(already.updates).toBe(0); // the flag never moved, so no rebuild
    expect(saved.size).toBe(0);
  });
});
