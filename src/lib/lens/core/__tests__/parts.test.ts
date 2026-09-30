import { describe, expect, it } from "vitest";
import { isIrisMechanism, isOpticalGlass, partClassOf } from "../parts";
import { PART_CLASS } from "../../ops/ops";

// The name predicates, fed node names from the shipped GLBs.

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
    expect(isIrisMechanism("Iris_Housing")).toBe(false);
    expect(isIrisMechanism("Iris_Housing_Seg5")).toBe(false);
  });
});

describe("partClassOf", () => {
  it("classifies by the ordered tests, glass first", () => {
    expect(partClassOf("Element_01")).toBe(PART_CLASS.glass);
    expect(partClassOf("Iris_Blade_01")).toBe(PART_CLASS.iris);
    expect(partClassOf("DecalT_Brand")).toBe(PART_CLASS.decal);
    // the filter glass is classed as an accessory
    expect(partClassOf("Acc_Filter_Glass")).toBe(PART_CLASS.accessory);
    expect(partClassOf("Acc_Hood")).toBe(PART_CLASS.accessory);
    expect(partClassOf("Iris_Housing_Seg0")).toBe(PART_CLASS.structure);
    expect(partClassOf("Barrel_Inner_Seg3")).toBe(PART_CLASS.structure);
  });
});
