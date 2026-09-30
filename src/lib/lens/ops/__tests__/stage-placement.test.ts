import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Anything the fragment stage reads from the deform must cross on a varying,
// or the whole deform re-runs per pixel. Checked against the source text.

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("fragment reads of the deform cross on varyings", () => {
  const host = src("../host.ts");
  const fade = src("../../materials/depthfade.ts");

  it("the normal's rot crosses on a varying", () => {
    expect(host).toMatch(/rotateAboutAxis\(\s*n,\s*varying\(rot\)/);
  });

  it("the wrap's deformed triad crosses on varyings", () => {
    for (const v of ["tF", "bF", "nF"])
      expect(host).toMatch(new RegExp(`varying\\(${v}\\)`));
  });

  it("the depth fade's viewZ crosses on a varying", () => {
    expect(fade).toMatch(/varying\(modelViewMatrix/);
  });
});
