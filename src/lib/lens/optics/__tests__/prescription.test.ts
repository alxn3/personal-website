import { describe, expect, it } from "vitest";
import { PRESCRIPTION, IRIS, FOCUS_MM } from "../prescription";
import { MECHANISM } from "../../ops/mechanism";
import { MODEL, glbNodeNames } from "../../core/__tests__/glb";

// The prescription's shape: 13 elements named as in the GLB, in axial order,
// with positive apertures, and gaps wide enough that focusing never reorders
// surfaces.

describe("prescription", () => {
  it("(a) has one entry per shipped optical element", () => {
    expect(PRESCRIPTION).toHaveLength(13);
    const ids = PRESCRIPTION.map((e) => e.id);
    expect(ids).toEqual(
      Array.from(
        { length: 13 },
        (_, i) => `Element_${String(i + 1).padStart(2, "0")}`,
      ),
    );
    const names = new Set(glbNodeNames(MODEL));
    for (const id of ids) expect(names.has(id), `${id} in GLB`).toBe(true);
  });

  it("(b) runs front→rear in element sequence, never doubling back", () => {
    // axial vertex order; cemented pairs (k, k+1) share an interface, hence >=
    const CEMENTED = new Set([0, 3, 8]);
    for (const e of PRESCRIPTION)
      expect(e.front.yMm, `${e.id} front above its own rear`).toBeGreaterThan(
        e.rear.yMm,
      );
    for (let k = 0; k + 1 < PRESCRIPTION.length; k++) {
      const gap = PRESCRIPTION[k].rear.yMm - PRESCRIPTION[k + 1].front.yMm;
      const label = `${PRESCRIPTION[k].id} rear → ${PRESCRIPTION[k + 1].id} front`;
      if (CEMENTED.has(k))
        expect(gap, `${label} (cemented, coincident)`).toBeGreaterThanOrEqual(
          0,
        );
      else expect(gap, `${label} (air gap)`).toBeGreaterThan(0);
    }
  });

  it("(c) has positive apertures and sane curvature magnitudes", () => {
    for (const e of PRESCRIPTION)
      for (const s of [e.front, e.rear]) {
        expect(s.apertureMm, `${e.id} aperture`).toBeGreaterThan(0);
        // radii above 5mm
        expect(Math.abs(s.c), `${e.id} curvature`).toBeLessThan(1 / 5);
        expect(Number.isFinite(s.yMm)).toBe(true);
      }
  });

  it("(d) leaves the focus slide unable to reorder any surface", () => {
    // only Element_12 moves (+FOCUS_MM toward the front)
    const r = PRESCRIPTION.findIndex((e) => e.focusRide === 1);
    expect(r, "focus rider has a neighbour on each side").toBeGreaterThan(0);
    expect(r).toBeLessThan(PRESCRIPTION.length - 1);
    expect(
      PRESCRIPTION[r - 1].rear.yMm - PRESCRIPTION[r].front.yMm,
      `gap the focus rider closes (${PRESCRIPTION[r - 1].id} rear → ${PRESCRIPTION[r].id} front)`,
    ).toBeGreaterThan(FOCUS_MM);
    expect(
      PRESCRIPTION[r].rear.yMm - PRESCRIPTION[r + 1].front.yMm,
      `gap the focus rider opens (${PRESCRIPTION[r].id} rear → ${PRESCRIPTION[r + 1].id} front)`,
    ).toBeGreaterThan(0);
  });

  it("(e) rides focus on exactly one element", () => {
    const riders = PRESCRIPTION.filter((e) => e.focusRide === 1);
    expect(riders.map((e) => e.id)).toEqual(["Element_12"]);
  });

  it("(f) mirrors the mechanism's focus throw exactly", () => {
    // FOCUS_MM is a literal so prescription.ts need not import three
    expect(FOCUS_MM).toBe(MECHANISM.focusMm);
  });

  it("(g) fits the iris in a real air gap, open no wider than its neighbours", () => {
    expect(IRIS.irisMaxMm).toBeGreaterThan(IRIS.irisMinMm);
    expect(IRIS.irisMinMm).toBeGreaterThan(0);
    const below = PRESCRIPTION.filter((e) => e.rear.yMm < IRIS.yMm);
    const above = PRESCRIPTION.filter((e) => e.front.yMm > IRIS.yMm);
    expect(below.length, "elements behind the stop").toBeGreaterThan(0);
    expect(above.length, "elements ahead of the stop").toBeGreaterThan(0);

    expect(
      PRESCRIPTION.some((e) => e.front.yMm > IRIS.yMm && IRIS.yMm > e.rear.yMm),
      "stop inside an element's own span",
    ).toBe(false);

    // fully open, the iris is no wider than the glass on either side
    const k = PRESCRIPTION.findIndex(
      (e, i) =>
        i + 1 < PRESCRIPTION.length &&
        e.rear.yMm > IRIS.yMm &&
        PRESCRIPTION[i + 1].front.yMm < IRIS.yMm,
    );
    expect(k, "elements straddling the stop").toBeGreaterThan(-1);
    const neighbourMm = Math.min(
      PRESCRIPTION[k].rear.apertureMm,
      PRESCRIPTION[k + 1].front.apertureMm,
    );
    expect(
      IRIS.irisMaxMm,
      `open iris within ${PRESCRIPTION[k].id}/${PRESCRIPTION[k + 1].id} clear aperture`,
    ).toBeLessThanOrEqual(neighbourMm);
  });
});
