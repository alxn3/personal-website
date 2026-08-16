import { describe, expect, it } from "vitest";
import { isIrisMechanism, isOpticalGlass, partClassOf } from "../parts";
import { PART_CLASS } from "../../ops/ops";

// The name predicates on the names the shipped GLBs actually carry. Runtime
// names ARE node names (the web GLBs ship one primitive per mesh — lens_work
// MIGRATION §2), so these tests feed node names directly; the old
// `authoredNameOf` / `hasPrimitiveSplitNames` pair that resolved a loader
// primitive split back to its node went with the split.

describe("isOpticalGlass", () => {
  it("is the true glass only — never the metal iris blades", () => {
    expect(isOpticalGlass("Element_01")).toBe(true);
    expect(isOpticalGlass("Element_13")).toBe(true);
    expect(isOpticalGlass("Acc_Filter_Glass")).toBe(true);
    // The bug this module was created for: an `Iris_` prefix styled the blades
    // as glass.
    expect(isOpticalGlass("Iris_Blade_01")).toBe(false);
    expect(isOpticalGlass("Acc_Filter_Ring")).toBe(false);
  });
});

describe("isIrisMechanism", () => {
  it("covers the cam plate's WEDGES, not just the plate node", () => {
    // `Iris_CamPlate` is a segmented part: it owns `Iris_CamPlate_Seg0..6`.
    // The old `CamPlate$` anchor missed them, and the class they actually got
    // came from ops/frames.ts walking up to the parent — a decision made two
    // modules away from the one that is supposed to own it.
    expect(isIrisMechanism("Iris_CamPlate")).toBe(true);
    for (let i = 0; i < 7; i++)
      expect(isIrisMechanism(`Iris_CamPlate_Seg${i}`), `seg ${i}`).toBe(true);
    for (const n of ["Iris_Blade_01", "Iris_ActuatorGear"])
      expect(isIrisMechanism(n), n).toBe(true);
  });

  it("never claims the iris HOUSING — it is a shell and must wrap", () => {
    // A wider `/^Iris_/` here parked the housing out of the assemble sheet.
    expect(isIrisMechanism("Iris_Housing")).toBe(false);
    expect(isIrisMechanism("Iris_Housing_Seg5")).toBe(false);
  });
});

describe("partClassOf", () => {
  it("classifies by the ordered tests, glass first", () => {
    expect(partClassOf("Element_01")).toBe(PART_CLASS.glass);
    expect(partClassOf("Iris_Blade_01")).toBe(PART_CLASS.iris);
    expect(partClassOf("DecalT_Brand")).toBe(PART_CLASS.decal);
    // Acc_Filter_Glass is an ACCESSORY, not glass: it comes off with the filter
    // and its glass shading is the look swapper's business, not a selector's.
    expect(partClassOf("Acc_Filter_Glass")).toBe(PART_CLASS.accessory);
    expect(partClassOf("Acc_Hood")).toBe(PART_CLASS.accessory);
    // The housing falls through to STRUCTURE so it wraps with every other shell.
    expect(partClassOf("Iris_Housing_Seg0")).toBe(PART_CLASS.structure);
    expect(partClassOf("Barrel_Inner_Seg3")).toBe(PART_CLASS.structure);
  });
});
