import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { PRESCRIPTION, IRIS, FOCUS_MM, OPTICS_KNOBS } from "../prescription";
import { MECHANISM } from "../../ops/mechanism";

// The prescription's SHAPE contract. The optical numbers themselves are
// measured (dev/prescription-probe.ts) and are look knobs, so nothing here
// pins a value — it pins the invariants the trace's static unroll depends on:
// thirteen entries, the shipped node names, a sequential axial order, positive
// apertures, and a gap ahead of the focus rider wide enough that the focus
// slide can never REORDER a surface (ops/trace.ts unrolls once, at module
// load).
//
// The GLB is read the same way ops/__tests__/shipped-glb.test.ts reads it: the
// glTF JSON chunk straight off disk, no renderer.

const MODEL = "public/models/lens_web_segmented.glb";

function glbNodeNames(path: string): string[] {
  const buf = fs.readFileSync(path);
  let off = 12;
  let json: { nodes: { name: string }[] } | null = null;
  while (off < buf.length) {
    const len = buf.readUInt32LE(off);
    if (buf.readUInt32LE(off + 4) === 0x4e4f534a)
      json = JSON.parse(buf.subarray(off + 8, off + 8 + len).toString("utf8"));
    off += 8 + len;
  }
  return json!.nodes.map((n) => n.name);
}

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
    // The shipped elements are DOMED and NESTED: their vertex Y spans
    // interleave across elements, so a global descending-yMm law is false of
    // real glass. What IS true is the AXIAL ray-hit order — the sequence a ray
    // on the optical axis meets the surfaces in. Cemented pairs (E01/E02,
    // E04/E05, E09/E10) are clamped to a coincident interface, hence >=.
    // Pair k = entries k and k+1: 0 = E01/E02, 3 = E04/E05, 8 = E09/E10.
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
        // radii above 5mm — anything tighter is a fit that went wrong, not glass
        expect(Math.abs(s.c), `${e.id} curvature`).toBeLessThan(1 / 5);
        expect(Number.isFinite(s.yMm)).toBe(true);
      }
  });

  it("(d) leaves the focus slide unable to reorder any surface", () => {
    // ops/trace.ts fixes the surface sequence ONCE at module load, at
    // focus = 0. Only ONE surface moves: Element_12 slides +FOCUS_MM toward
    // the front (ops/mechanism.ts sign), so only its own two neighbours can be
    // crossed. Every other pair is static — including the cemented interfaces,
    // which are coincident by construction and can never reorder.
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

    // The stop is a surface in that sequence too: it must sit strictly inside a
    // real inter-element air gap, between the axial points that straddle it.
    const straddle = PRESCRIPTION.findIndex(
      (e, i) =>
        i + 1 < PRESCRIPTION.length &&
        e.rear.yMm > IRIS.yMm &&
        PRESCRIPTION[i + 1].front.yMm < IRIS.yMm,
    );
    expect(
      straddle,
      "iris inside a real inter-element air gap",
    ).toBeGreaterThan(-1);
  });

  it("(e) rides focus on exactly one element", () => {
    const riders = PRESCRIPTION.filter((e) => e.focusRide === 1);
    expect(riders.map((e) => e.id)).toEqual(["Element_12"]);
  });

  it("(f) mirrors the mechanism's focus throw exactly", () => {
    // FOCUS_MM is a LITERAL, not an import: ops/mechanism.ts pulls in
    // three/webgpu and the optics tree must stay three-free so its tests run on
    // NUM alone. This test is the tripwire that keeps the two in step.
    expect(FOCUS_MM).toBe(MECHANISM.focusMm);
  });

  it("(g) fits the iris in a real air gap, open no wider than its neighbours", () => {
    expect(IRIS.irisMaxMm).toBeGreaterThan(IRIS.irisMinMm);
    expect(IRIS.irisMinMm).toBeGreaterThan(0);
    const below = PRESCRIPTION.filter((e) => e.rear.yMm < IRIS.yMm);
    const above = PRESCRIPTION.filter((e) => e.front.yMm > IRIS.yMm);
    expect(below.length, "elements behind the stop").toBeGreaterThan(0);
    expect(above.length, "elements ahead of the stop").toBeGreaterThan(0);

    // A stop buried inside an element's own axial span is a paste error.
    expect(
      PRESCRIPTION.some((e) => e.front.yMm > IRIS.yMm && IRIS.yMm > e.rear.yMm),
      "stop inside an element's own span",
    ).toBe(false);

    // Fully open, the door must still be narrower than the glass on either side
    // of it — otherwise the first stretch of the aperture channel clips nothing
    // and the dial has a dead zone (plan amendment 7).
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

  it("(h) ships the spec's knob defaults", () => {
    expect(OPTICS_KNOBS).toEqual({
      warpGain: 1,
      dispersion: 0.015,
      focusCouple: 1,
      skyMix: 0,
    });
  });
});
