import tsParser from "@typescript-eslint/parser";
import astro from "eslint-plugin-astro";
import tailwindcss from "eslint-plugin-tailwindcss";

export default [
  { ignores: ["dist/", ".astro/", "node_modules/", "public/"] },
  ...astro.configs.recommended,
  // the recommended astro config parses frontmatter as TS; plain .ts files
  // need the parser wired themselves
  { files: ["**/*.ts"], languageOptions: { parser: tsParser } },
  {
    plugins: { tailwindcss },
    settings: { tailwindcss: { cssConfigPath: "src/styles/global.css" } },
    rules: {
      // arbitrary value with an exact canonical utility (w-[26rem] → w-104)
      "tailwindcss/no-unnecessary-arbitrary-value": "error",
      // two classes fighting over one property (w-4 w-6, hidden flex)
      "tailwindcss/no-contradicting-classname": "error",
      // collapsible pairs (h-9 w-9 → size-9); auto-fixable
      "tailwindcss/enforces-shorthand": "error",
    },
  },
];
