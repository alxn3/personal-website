import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// shading.ts and shading-bench.ts may only `import type` each other, or the
// lazy bench ends up in the homepage bundle.

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
    // …and the type import still exists (so a rename can't pass vacuously)
    expect(swapper).toMatch(/^import type .* from ["']\.\/shading-bench/m);
  });

  it("shading-bench.ts names the swapper with type-only imports", () => {
    expect(valueEdges(bench, "./shading")).toEqual([]);
    expect(bench).toMatch(/^import type .* from ["']\.\/shading\.js/m);
  });
});
