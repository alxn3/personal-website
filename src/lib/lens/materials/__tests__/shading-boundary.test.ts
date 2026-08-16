import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// THE LAZY BOUNDARY IS A TYPE-ONLY EDGE (materials/shading.ts ↔
// materials/shading-bench.ts). A value import — or a re-export — in either
// direction folds the bench's lazy chunk back into the homepage's shared
// bundle with every other gate still green; the only signal would be someone
// re-measuring dist/ by hand. This pins the headers' stated rule to the
// source text (precedent: story/__tests__/piece-flow.test.ts pins
// hero-driver.ts's source for the same class of unpinnable property).

const src = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Every static import/re-export statement of `spec` that is NOT type-only. */
const valueEdges = (text: string, spec: string): string[] =>
  [...text.matchAll(/^(?:import|export)[^;]*?from\s+["']([^"']+)["']/gm)]
    .filter((m) => m[1].includes(spec))
    .map((m) => m[0])
    .filter((stmt) => !/^(?:import|export)\s+type\b/.test(stmt));

describe("the shading lazy boundary", () => {
  const swapper = src("../shading.ts");
  const bench = src("../shading-bench.ts");

  it("shading.ts names the bench with type-only imports", () => {
    expect(valueEdges(swapper, "shading-bench")).toEqual([]);
    // …and the boundary is still THERE (a rename must not vacuously pass)
    expect(swapper).toMatch(/^import type .* from ["']\.\/shading-bench/m);
  });

  it("shading-bench.ts names the swapper with type-only imports", () => {
    expect(valueEdges(bench, "./shading")).toEqual([]);
    expect(bench).toMatch(/^import type .* from ["']\.\/shading\.js/m);
  });
});
