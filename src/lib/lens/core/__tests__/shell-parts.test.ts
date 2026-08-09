import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { isPeelExtra, isPeelTube, isShellPart } from "../parts";

// The shell gate's cast, pinned against the names the SHIPPED GLBs actually
// carry — the same source ops/__tests__/shipped-glb.test.ts reads, for the same
// reason: a predicate written from memory drifts silently when the model drops,
// and this one decides what the story TAKES OFF THE LENS. Every name below is
// asserted to exist in a shipped model, so a rename fails here rather than in a
// scroll nobody re-checks.

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

/** Every PART (wedges folded back onto their group name) the gate takes off. */
const SHELL_PARTS = [
  "Band_Mid",
  "Barrel_Base",
  "Barrel_Inner",
  "DecalT_BadgeC",
  "DecalT_BadgeDisc",
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
  "Decal_Dot2",
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
      "Decal_Dot2",
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
      "Optics_Cell_G3_Seg5",
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
    // The `^` in `^Ring_` is what keeps these out — the collision the gate
    // would fail SILENTLY on, hiding internals behind the shell's envelope.
    for (const n of [
      "Shim_Ring_0",
      "Shim_Ring_1",
      "Shim_Ring_1_Seg3",
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
    // KNOWN LIMITATION: this catches a rename or a widened predicate, but NOT a
    // new exterior family whose name the predicate doesn't match — it would
    // simply never join the cast, and both assertions below would still pass.
    const shell = [...new Set(NAMES.filter(isShellPart).map(basePart))].sort();
    expect(shell).toEqual(SHELL_PARTS);
    // …and it is a real slice of the model, not everything and not nothing
    expect(NAMES.filter(isShellPart)).toHaveLength(48);
  });
});

describe("isPeelExtra", () => {
  it("is exactly the three baffle rings the shipped models carry", () => {
    const extra = [...new Set(NAMES.filter(isPeelExtra).map(basePart))].sort();
    expect(extra).toEqual([
      "Baffle_Rear",
      "Optics_Baffle_Front",
      "Optics_Baffle_G2",
    ]);
    // three family nodes + three rings of five wedges
    expect(NAMES.filter(isPeelExtra)).toHaveLength(18);
  });

  it("leaves the rest of the optics group behind", () => {
    for (const n of ["Optics_Cell_G3_Seg5", "Optics_G2", "Shim_Ring_1"]) {
      expect(REAL.has(n) || REAL.has(basePart(n)), `${n} is a real node`).toBe(
        true,
      );
      expect(isPeelExtra(n), n).toBe(false);
    }
  });
});

describe("isPeelTube", () => {
  it("is exactly the two closed tubes the skin was wrapped around", () => {
    const tubes = [...new Set(NAMES.filter(isPeelTube).map(basePart))].sort();
    expect(tubes).toEqual(["Cam_Barrel", "Chassis_Fixed"]);
    // two family nodes + a ring of seven wedges and a ring of five
    expect(NAMES.filter(isPeelTube)).toHaveLength(14);
  });

  it("stops at the cage — the next closed layer in stays", () => {
    // Removing Cam_OpticsCage was tried and rejected (core/parts isPeelTube):
    // it takes the lens's body away without uncovering any more glass, since
    // the elements it hides are wrapped in their own cells either way.
    for (const n of [
      "Cam_OpticsCage_Seg3",
      "Cam_LightTrap_Seg0",
      "Cam_RearTube_Seg2",
      "Optics_Cell_G3_Seg5",
      "Mount_ChassisPlate_Seg1", // NOT Chassis_Fixed — the `^` is load-bearing
      "Iris_Housing_Seg2",
    ]) {
      expect(REAL.has(n) || REAL.has(basePart(n)), `${n} is a real node`).toBe(
        true,
      );
      expect(isPeelTube(n), n).toBe(false);
    }
  });

  it("leaves the hardware the chassis ADOPTS behind", () => {
    // Focus_Motor/Focus_GuideRods are children of Chassis_Fixed (ops/frames.ts)
    // but carry their own names, so the gate never reaches them and the
    // mechanism stays whole once the tube is off.
    for (const n of ["Focus_Motor", "Focus_GuideRods"]) {
      expect(REAL.has(n), `${n} is a real node`).toBe(true);
      expect(isPeelTube(n), n).toBe(false);
    }
  });
});

describe("the three casts together", () => {
  it("share no piece — each gets its own band of the shell fade", () => {
    // core/scene gives each its own slice, so an overlap would put a piece in
    // two bands and the later branch would silently win.
    for (const n of NAMES) {
      const casts = [isShellPart(n), isPeelExtra(n), isPeelTube(n)].filter(
        Boolean,
      );
      expect(casts.length, n).toBeLessThanOrEqual(1);
    }
  });

  it("take a real slice of the model, not everything and not nothing", () => {
    const leaving = NAMES.filter(
      (n) => isShellPart(n) || isPeelExtra(n) || isPeelTube(n),
    );
    expect(leaving).toHaveLength(48 + 18 + 14);
    expect(leaving.length).toBeLessThan(NAMES.length / 2);
  });
});
