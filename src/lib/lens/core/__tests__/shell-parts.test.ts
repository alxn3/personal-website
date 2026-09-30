import { describe, expect, it } from "vitest";
import { ACCESSORIES, MODEL, glbNodeNames } from "./glb";
import {
  isPeelExtra,
  isPeelKeep,
  isPeelRest,
  isPeelTube,
  isShellPart,
} from "../parts";
import { PART } from "../names";

// The part predicates checked against the node names in the shipped GLBs, so a
// rename fails here.

const NAMES = [...glbNodeNames(MODEL), ...glbNodeNames(ACCESSORIES)];
const REAL = new Set(NAMES);
/** a wedge's part name */
const basePart = (n: string) => n.replace(/_Seg\d+$/, "");

describe("the node-name table", () => {
  it("names only parts the shipped models actually carry", () => {
    // a name matching no node would make its predicate silently match nothing
    for (const name of Object.values(PART))
      expect(REAL.has(name), `${name} is a real node`).toBe(true);
  });
});

/** Every PART (wedges folded back onto their group name) the gate takes off. */
const SHELL_PARTS = [
  "Band_Mid",
  "Barrel_Base",
  "Barrel_Inner",
  "DecalT_BadgeC",
  "DecalT_Bezel",
  "DecalT_BezelMIJ",
  "DecalT_Brand",
  "DecalT_Edition",
  "DecalT_Index",
  "DecalT_Label",
  "DecalT_MIJ",
  "DecalT_MinF",
  "DecalT_Serial",
  "DecalT_Zoom_18",
  "DecalT_Zoom_24",
  "DecalT_Zoom_28",
  "DecalT_Zoom_35",
  "DecalT_Zoom_50",
  "Decal_BadgeDisc",
  "Decal_DotMIJ",
  "Decal_HoodDash",
  "Ring_Focus",
  "Ring_Zoom",
];

// Each cast is pinned to its exact set of parts in the shipped models, so any
// name a predicate wrongly takes or drops fails here.
describe("isShellPart", () => {
  it("partitions the SHIPPED models into exactly this cast", () => {
    const shell = [...new Set(NAMES.filter(isShellPart).map(basePart))].sort();
    expect(shell).toEqual(SHELL_PARTS);
    // a real subset of the model
    expect(NAMES.filter(isShellPart)).toHaveLength(48);
  });
});

describe("isPeelExtra", () => {
  it("is exactly the two optics traps the shipped models carry", () => {
    // the rear plate stays
    const extra = [...new Set(NAMES.filter(isPeelExtra).map(basePart))].sort();
    expect(extra).toEqual(["Baffle_Front", "Baffle_G2"]);
    // two family nodes + two rings of five wedges
    expect(NAMES.filter(isPeelExtra)).toHaveLength(12);
  });
});

describe("isPeelTube", () => {
  it("is the tubes AND the inner cladding down to the glass", () => {
    const tubes = [...new Set(NAMES.filter(isPeelTube).map(basePart))].sort();
    expect(tubes).toEqual([
      "Cam_Barrel",
      "Cell_Collar",
      "Cell_Flange",
      "Cell_G3",
      "Chassis_Fixed",
      "Iris_CamPlate",
      "Iris_Housing",
      "LightTrap",
      "OpticsCage",
      "RearTube",
    ]);
    // ten family nodes + seven 7-cut rings + three 5-cut rings of wedges
    expect(NAMES.filter(isPeelTube)).toHaveLength(52 + 6 + 8 + 8);
  });
});

describe("the casts together", () => {
  it("share no piece — each gets its own band of a fade channel", () => {
    // no name may match two predicates
    for (const n of NAMES) {
      const casts = [
        isShellPart(n),
        isPeelExtra(n),
        isPeelTube(n),
        isPeelRest(n),
      ].filter(Boolean);
      expect(casts.length, n).toBeLessThanOrEqual(1);
    }
  });

  it("with the keep-set, WHITELIST the whole model (owner's law)", () => {
    // every name is kept, in one of the four peel groups, or a group node
    const GROUPS = new Set([
      "Grp_FocusDrive",
      "Grp_MountRear",
      "Optics_G1",
      "Optics_G2",
      "Optics_G3",
      "Optics_G5",
      "Optics_G4_Focus",
      "Focus_Carrier",
    ]);
    for (const n of NAMES) {
      if (n.startsWith("Acc_")) continue; // accessories have their own owner
      const placed =
        isPeelKeep(n) ||
        isShellPart(n) ||
        isPeelExtra(n) ||
        isPeelTube(n) ||
        isPeelRest(n) ||
        GROUPS.has(n);
      expect(placed, `${n} is unplaced — whitelist it or cast it`).toBe(true);
    }
  });

  it("take a real slice of the model, not everything and not nothing", () => {
    const leaving = NAMES.filter(
      (n) => isShellPart(n) || isPeelExtra(n) || isPeelTube(n) || isPeelRest(n),
    );
    expect(leaving).toHaveLength(48 + 12 + 74 + 1);
    // the peel groups must not cover most of the model
    expect(leaving.length).toBeLessThan(NAMES.length * 0.75);
  });
});
