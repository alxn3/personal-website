import { describe, expect, it } from "vitest";
import { isIrisMechanism, isOpticalGlass, partClassOf } from "../parts";
import { PART_CLASS } from "../../ops/ops";

// The name predicates on the names the shipped GLBs carry. Runtime names ARE
// node names (one primitive per mesh), so these tests feed node names directly.

describe("isOpticalGlass", () => {
  it("is the true glass only — never the metal iris blades", () => {
    expect(isOpticalGlass("Element_01")).toBe(true);
    expect(isOpticalGlass("Element_13")).toBe(true);
    expect(isOpticalGlass("Acc_Filter_Glass")).toBe(true);
    // An `Iris_` prefix must not style the blades as glass.
    expect(isOpticalGlass("Iris_Blade_01")).toBe(false);
    expect(isOpticalGlass("Acc_Filter_Ring")).toBe(false);
  });
});

describe("isIrisMechanism", () => {
  it("covers the cam plate's WEDGES, not just the plate node", () => {
    // `Iris_CamPlate` is segmented: it owns `Iris_CamPlate_Seg0..6`.
    expect(isIrisMechanism("Iris_CamPlate")).toBe(true);
    for (let i = 0; i < 7; i++)
      expect(isIrisMechanism(`Iris_CamPlate_Seg${i}`), `seg ${i}`).toBe(true);
    for (const n of ["Iris_Blade_01", "Iris_ActuatorGear"])
      expect(isIrisMechanism(n), n).toBe(true);
  });

  it("never claims the iris HOUSING — it is a shell and must wrap", () => {
    // A wider `/^Iris_/` would park the housing out of the assemble sheet.
    expect(isIrisMechanism("Iris_Housing")).toBe(false);
    expect(isIrisMechanism("Iris_Housing_Seg5")).toBe(false);
  });
});

describe("partClassOf", () => {
  it("classifies by the ordered tests, glass first", () => {
    expect(partClassOf("Element_01")).toBe(PART_CLASS.glass);
    expect(partClassOf("Iris_Blade_01")).toBe(PART_CLASS.iris);
    expect(partClassOf("DecalT_Brand")).toBe(PART_CLASS.decal);
    // Acc_Filter_Glass is an ACCESSORY, not glass: it comes off with the filter.
    expect(partClassOf("Acc_Filter_Glass")).toBe(PART_CLASS.accessory);
    expect(partClassOf("Acc_Hood")).toBe(PART_CLASS.accessory);
    // The housing falls through to STRUCTURE so it wraps with every other shell.
    expect(partClassOf("Iris_Housing_Seg0")).toBe(PART_CLASS.structure);
    expect(partClassOf("Barrel_Inner_Seg3")).toBe(PART_CLASS.structure);
  });
});
