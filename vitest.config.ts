import { configDefaults, defineConfig } from "vitest/config";

/** The GLB-loading instruments: every piece through the real pipeline over the
 *  shipped model. `npm run test:structural` runs them; `npm test` does not. */
const STRUCTURAL = [
  "src/lib/lens/story/__tests__/story-ending.test.ts",
  "src/lib/lens/story/__tests__/piece-flow.test.ts",
  "src/lib/lens/story/__tests__/story-cost.test.ts",
  "src/lib/lens/story/__tests__/story-portrait.test.ts",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "default",
          exclude: [...configDefaults.exclude, ...STRUCTURAL],
        },
      },
      {
        test: { name: "structural", include: STRUCTURAL },
      },
    ],
  },
});
