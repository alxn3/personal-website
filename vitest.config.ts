import { configDefaults, defineConfig } from "vitest/config";

/** The slow instrument: every piece through the real pipeline at every story
 *  edge over the shipped model. `npm run test:structural` runs it; `npm test`
 *  does not. Everything else, GLB readers included, is in the default tier. */
const STRUCTURAL = ["src/lib/lens/story/__tests__/piece-flow.test.ts"];

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
