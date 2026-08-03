import { describe, expect, it } from "vitest";
import {
  isIrisMechanism,
  isOpticalGlass,
  isOpticsIsolate,
  isSilhouetteGreeble,
  partClassOf,
} from "../parts";
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

describe("isOpticsIsolate", () => {
  it("keeps the glass and the whole iris assembly", () => {
    for (const n of [
      "Element_07",
      "Acc_Filter_Glass",
      "Iris_Blade_04",
      "Iris_CamPlate_Seg3",
      "Iris_Housing_Seg0",
    ])
      expect(isOpticsIsolate(n), n).toBe(true);
    expect(isOpticsIsolate("Ring_Zoom_Seg2")).toBe(false);
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

describe("isSilhouetteGreeble", () => {
  it("hides the mechanical clutter, keeps the shapes that draw the lens", () => {
    for (const n of [
      "DecalT_Brand",
      "PCB_Components_Seg3",
      "Mount_Screws",
      "Iris_Blade_02",
      "Iris_CamPlate_Seg1",
      "Focus_LeadScrew",
      // Focus_Arms is the carrier's bracket, split off it by lens_work N.12
      // (MIGRATION §10) — it hides with the ring it belongs to, not without it.
      "Focus_Arms",
      "Optics_Cell_G2",
      "Shim_Ring_0",
    ])
      expect(isSilhouetteGreeble(n), n).toBe(true);
    for (const n of [
      "Barrel_Inner_Seg3",
      "Ring_Zoom_Seg0",
      "Iris_Housing_Seg2",
      "Element_05",
    ])
      expect(isSilhouetteGreeble(n), n).toBe(false);
  });

  it("no longer mentions Iris_FlexTrunk — the part was cut model-side", () => {
    // lens_work MIGRATION §7b: the node does not exist in any web GLB, so the
    // regex arm was a silent no-op. Nothing named FlexTrunk should be special.
    expect(isSilhouetteGreeble("Iris_FlexTrunk")).toBe(false);
  });
});

describe("partClassOf", () => {
  it("classifies by the ordered tests, glass first", () => {
    expect(partClassOf("Element_01")).toBe(PART_CLASS.glass);
    expect(partClassOf("Iris_Blade_01")).toBe(PART_CLASS.iris);
    expect(partClassOf("DecalT_Brand")).toBe(PART_CLASS.decal);
    // Acc_Filter_Glass is an ACCESSORY, not glass: it comes off with the filter
    // and its glass shading is materials/shading.ts's business, not a selector's.
    expect(partClassOf("Acc_Filter_Glass")).toBe(PART_CLASS.accessory);
    expect(partClassOf("Acc_Hood")).toBe(PART_CLASS.accessory);
    // The housing falls through to STRUCTURE so it wraps with every other shell.
    expect(partClassOf("Iris_Housing_Seg0")).toBe(PART_CLASS.structure);
    expect(partClassOf("Barrel_Inner_Seg3")).toBe(PART_CLASS.structure);
  });
});
