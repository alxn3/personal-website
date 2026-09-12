import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Pins host.ts law 5 to the source text: fragment-facing reads off fold() must
// cross on varyings, or the whole recipe chain re-emits per pixel.

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("the deform chain's stage placement (host.ts law 5)", () => {
  const host = src("../host.ts");
  const fade = src("../../materials/depthfade.ts");

  it("the normal's rot crosses on a varying", () => {
    expect(host).toMatch(
      /rotateAboutAxis\(\s*normalLocal[^,]*,\s*varying\(f\.rot\)/,
    );
  });

  it("the wrap's deformed triad crosses on varyings", () => {
    for (const v of ["tF", "bF", "nF"])
      expect(host).toMatch(new RegExp(`varying\\(${v}\\)`));
  });

  it("the depth fade's viewZ crosses on a varying", () => {
    expect(fade).toMatch(/varying\(modelViewMatrix/);
  });
});
