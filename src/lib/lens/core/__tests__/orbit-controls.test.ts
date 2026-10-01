import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

// OrbitControls is /lens only: the homepage's story never builds it, so it is
// reached by dynamic import alone.
describe("OrbitControls", () => {
  const root = new URL("../../../../", import.meta.url).pathname; // src/
  const files: string[] = [];
  (function walk(dir: string) {
    for (const e of readdirSync(dir)) {
      const f = join(dir, e);
      if (statSync(f).isDirectory()) walk(f);
      else if (/\.(ts|astro)$/.test(f) && !f.includes("__tests__"))
        files.push(f);
    }
  })(root);
  const staticImport =
    /(^|\n)\s*(import|export)(?!\s+type\b)(\s*[^;]*?\s+from)?\s*["'][^"']*\/OrbitControls\.js["']/;

  it("has no static importer", () => {
    const hits = files.filter((f) =>
      staticImport.test(readFileSync(f, "utf8")),
    );
    expect(hits.map((f) => relative(root, f))).toEqual([]);
  });

  it("is imported dynamically by the scene", () => {
    const scene = readFileSync(join(root, "lib/lens/core/scene.ts"), "utf8");
    expect(scene).toMatch(/import\(\s*["'][^"']*\/OrbitControls\.js["']\s*\)/);
  });
});
