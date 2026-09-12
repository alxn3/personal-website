import { describe, expect, it } from "vitest";
import fs from "node:fs";
import {
  isPeelExtra,
  isPeelKeep,
  isPeelRest,
  isPeelTube,
  isShellPart,
} from "../parts";
import { PART } from "../names";

// The shell gate's cast, pinned against the names the SHIPPED GLBs carry: this
// predicate decides what the story takes off the lens, so every name below is
// asserted to exist in a shipped model and a rename fails here.

interface Gltf {
  nodes: { name: string }[];
}

/** The glTF JSON chunk of a .glb (shipped-glb.test.ts's reader). */
function glbNames(path: string): string[] {
  const buf = fs.readFileSync(path);
  let off = 12;
  let json: Gltf | null = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    if (buf.readUInt32LE(off + 4) === 0x4e4f534a)
      json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString("utf8"));
    off += 8 + len;
  }
  return json!.nodes.map((n) => n.name);
}

const NAMES = [
  ...glbNames("public/models/lens_web_segmented.glb"),
  ...glbNames("public/models/lens_web_accessories.glb"),
];
const REAL = new Set(NAMES);
const basePart = (n: string) => n.replace(/_Seg\d+$/, "");

describe("the node-name table", () => {
  it("names only parts the shipped models actually carry", () => {
    // A table entry pointing at nothing must fail here rather than as a
    // predicate that quietly matches no mesh.
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

describe("isShellPart", () => {
  it("takes the outer skin: the barrels, the band, the grips, the markings", () => {
    for (const n of [
      "Barrel_Base",
      "Barrel_Inner",
      "Barrel_Inner_Seg3", // a wedge carries its part's name — no parent walk
      "Band_Mid",
      "Band_Mid_Seg0",
      "Ring_Focus",
      "Ring_Zoom_Seg4",
      "DecalT_Brand",
      "DecalT_Zoom_50",
      "Decal_DotMIJ",
    ]) {
      expect(REAL.has(n) || REAL.has(basePart(n)), `${n} is a real node`).toBe(
        true,
      );
      expect(isShellPart(n), n).toBe(true);
    }
  });

  it("leaves every internal and every mechanism behind", () => {
    for (const n of [
      "Element_07", // the light path
      "Iris_Blade_03",
      "Iris_Housing_Seg2", // a shell, but an INTERNAL one
      "Focus_LeadScrew",
      "Focus_Carrier_Seg1",
      "Cam_Barrel_Seg0", // a tube under the skin — its own cast, not this one
      "Cam_Followers",
      "Chassis_Fixed_Seg2", // likewise (r 29.4 vs the skin's 30.8)
      "PCB_Rear",
      "Mount_Bayonet",
      "Cell_G3_Seg5",
      "Baffle_Rear_Seg0",
      "Acc_CapFront", // accessories have their own owner
      "Acc_Hood",
    ]) {
      expect(REAL.has(n) || REAL.has(basePart(n)), `${n} is a real node`).toBe(
        true,
      );
      expect(isShellPart(n), n).toBe(false);
    }
  });

  it("never mistakes a shim ring (or a brass one) for a control ring", () => {
    // The `^` in `^Ring_` keeps these out; the collision would fail silently.
    for (const n of [
      "Shim_Ring_01",
      "Shim_Ring_02",
      "Shim_Ring_02_Seg3",
      "Mount_BrassRing",
      "Mount_BrassRing_Seg2",
      "Acc_Filter_Ring",
    ]) {
      expect(REAL.has(n) || REAL.has(basePart(n)), `${n} is a real node`).toBe(
        true,
      );
      expect(isShellPart(n), n).toBe(false);
    }
  });

  it("partitions the SHIPPED models into exactly this cast", () => {
    // Catches a rename or a widened predicate, but NOT a new exterior family
    // the predicate doesn't match — it would just never join the cast.
    const shell = [...new Set(NAMES.filter(isShellPart).map(basePart))].sort();
    expect(shell).toEqual(SHELL_PARTS);
    // …and it is a real slice of the model, not everything and not nothing
    expect(NAMES.filter(isShellPart)).toHaveLength(48);
  });
});

describe("isPeelExtra", () => {
  it("is exactly the two optics traps the shipped models carry", () => {
    // Baffle_Rear is the KEEP-set's now — the rear plate stays with the back
    const extra = [...new Set(NAMES.filter(isPeelExtra).map(basePart))].sort();
    expect(extra).toEqual(["Baffle_Front", "Baffle_G2"]);
    // two family nodes + two rings of five wedges
    expect(NAMES.filter(isPeelExtra)).toHaveLength(12);
  });

  it("leaves the rest of the optics group behind", () => {
    for (const n of ["Cell_G3_Seg5", "Optics_G2", "Shim_Ring_02"]) {
      expect(REAL.has(n) || REAL.has(basePart(n)), `${n} is a real node`).toBe(
        true,
      );
      expect(isPeelExtra(n), n).toBe(false);
    }
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

  it("stops at its own cast — the rest-cast and the keep-set are not tubes", () => {
    // The shims and focus metalwork leave on the REST cast; the keep-set (iris,
    // mount) never leaves. Neither may ride this predicate.
    for (const n of [
      "Shim_Ring_02_Seg3",
      "Mount_ChassisPlate_Seg1", // NOT Chassis_Fixed — the `^` is load-bearing
      "Iris_Blade_03", // the working star stays — KEEP-set
      "Iris_ActuatorGear",
      "Optics_G4_Focus", // the focus GROUP carries a moving element — mechanism
      "Focus_Carrier",
    ]) {
      expect(REAL.has(n) || REAL.has(basePart(n)), `${n} is a real node`).toBe(
        true,
      );
      expect(isPeelTube(n), n).toBe(false);
    }
  });

  it("leaves the hardware the chassis ADOPTS behind", () => {
    // Focus_Motor/Focus_GuideRods are children of Chassis_Fixed but carry their
    // own names, so the gate never reaches them.
    for (const n of ["Focus_Motor", "Focus_GuideRods"]) {
      expect(REAL.has(n), `${n} is a real node`).toBe(true);
      expect(isPeelTube(n), n).toBe(false);
    }
  });
});

describe("the casts together", () => {
  it("share no piece — each gets its own band of a fade channel", () => {
    // An overlap would put a piece in two bands and the later branch would win.
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
    // Every model name is either KEPT for the card scene (glass, iris,
    // mount/PCB), in one of the four departing casts, or a pure GROUP node
    // (no mesh, never gated). A new part must be placed, or this fails.
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
    // Caps the slice so the casts can never quietly swallow the model.
    expect(leaving.length).toBeLessThan(NAMES.length * 0.75);
  });
});
