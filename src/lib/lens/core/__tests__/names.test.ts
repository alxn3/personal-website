import { describe, expect, it } from "vitest";
import {
  BAFFLE_KEEP,
  CELL_PARTS,
  PART,
  PEEL_BAFFLES,
  PEEL_SINGLES,
  PEEL_TUBES,
  prefixRe,
} from "../names";

// The vocabulary's own invariants: the table is internally coherent and the
// regex it hands the predicates is anchored. (That the names are the RIGHT ones
// is pinned against the shipped GLBs in shell-parts.test.ts.)

const ROSTERS = { PEEL_TUBES, CELL_PARTS, PEEL_BAFFLES, PEEL_SINGLES };

describe("the node-name table", () => {
  it("spells every name in its own key — the greppability contract", () => {
    // Grepping a name reaches every use site only while the key is the
    // camelCase mirror of the value.
    const camel = (name: string) =>
      name
        .split("_")
        .map((seg, i) =>
          i === 0
            ? seg[0].toLowerCase() + seg.slice(1)
            : seg[0].toUpperCase() + seg.slice(1),
        )
        .join("");
    for (const [key, name] of Object.entries(PART))
      expect(camel(name), name).toBe(key);
  });

  it("lists every roster once, with no name repeated inside one", () => {
    for (const [label, roster] of Object.entries(ROSTERS))
      expect(new Set(roster).size, label).toBe(roster.length);
  });

  it("draws every roster from the table", () => {
    const known = new Set<string>(Object.values(PART));
    for (const [label, roster] of Object.entries(ROSTERS))
      for (const name of roster)
        expect(known.has(name), `${label}/${name}`).toBe(true);
  });
});

describe("the cell family", () => {
  it("is part of the peel's tube cast", () => {
    for (const name of CELL_PARTS) expect(PEEL_TUBES).toContain(name);
  });
});

describe("the baffle family", () => {
  it("keeps the rear plate OUT of the pair that leaves", () => {
    // The pair is named rather than matched on `Baffle_` so the rear plate
    // stays in the keep-set.
    expect(PEEL_BAFFLES).not.toContain(BAFFLE_KEEP);
    expect(prefixRe(PEEL_BAFFLES).test(BAFFLE_KEEP)).toBe(false);
  });
});

describe("prefixRe", () => {
  const re = prefixRe(["OpticsCage", "Cell_G3"]);

  it("matches a listed part and its wedges", () => {
    expect(re.test("OpticsCage")).toBe(true);
    expect(re.test("OpticsCage_Seg3")).toBe(true);
    expect(re.test("Cell_G3_Seg6")).toBe(true);
  });

  it("is ANCHORED — a bare stem may not match mid-name", () => {
    // Unanchored, a bare stem would claim anything with the stem buried in it
    // and the peel would take a part the story never meant to remove.
    expect(re.test("Mount_OpticsCage")).toBe(false);
    expect(re.test("Optics_Cell_G3")).toBe(false);
    expect(re.test("Sub_Cell_G3")).toBe(false);
  });
});
