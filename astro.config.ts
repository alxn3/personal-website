import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig } from "astro/config";
import type { AstroIntegration } from "astro";
import tailwindcss from "@tailwindcss/vite";
import alphinejs from "@astrojs/alpinejs";
import icon from "astro-icon";

// Adds <link rel="modulepreload"> for each page script's static import closure
// (dynamic imports stay lazy), since neither Astro nor Rolldown emits them.
function modulePreload(): AstroIntegration {
  const imports = new Map<string, string[]>(); // client chunk -> its static imports
  return {
    name: "module-preload",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              {
                name: "module-preload-graph",
                generateBundle(_, bundle) {
                  for (const c of Object.values(bundle))
                    if (c.type === "chunk") imports.set(c.fileName, c.imports);
                },
              },
            ],
          },
        });
      },
      "astro:build:done": ({ dir }) => {
        const root = dir.pathname;
        for (const file of readdirSync(root, {
          recursive: true,
          encoding: "utf8",
        })) {
          if (!file.endsWith(".html")) continue;
          const path = join(root, file);
          const html = readFileSync(path, "utf8");
          const entries = [
            ...html.matchAll(/<script type="module" src="\/([^"]+)"/g),
          ].map((m) => m[1]);
          const closure = new Set(entries);
          for (const f of closure)
            for (const dep of imports.get(f) ?? []) closure.add(dep);
          const links = [...closure]
            .filter((f) => !entries.includes(f))
            .map((f) => `<link rel="modulepreload" href="/${f}">`)
            .join("");
          if (links)
            writeFileSync(path, html.replace("</head>", `${links}</head>`));
        }
      },
    },
  };
}

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
    // Resolve bare `three` to the WebGPU build so the renderer, node materials,
    // and the GLTFLoader/OrbitControls addons all share ONE core instance
    // (otherwise instanceof breaks across the two builds). Only the exact
    // specifier is remapped — `three/addons/*`, `three/tsl`, `three/examples/*`
    // still resolve normally (and their internal `three` imports alias too).
    resolve: {
      alias: [{ find: /^three$/, replacement: "three/webgpu" }],
    },
    // dev only (astro build bundles through rollup): pre-bundle the three
    // subpaths — the alias above hides bare `three` from the dep scanner.
    // Keep this list == the `from "three…"` specifiers under src/.
    optimizeDeps: {
      include: [
        "three/webgpu",
        "three/tsl",
        "three/examples/jsm/loaders/GLTFLoader.js",
        "three/examples/jsm/controls/OrbitControls.js",
        "three/examples/jsm/environments/RoomEnvironment.js",
      ],
    },
    server: {
      allowedHosts: [".trycloudflare.com"],
    },
  },
  integrations: [
    alphinejs({ entrypoint: "/src/lib/alpine" }),
    icon(),
    modulePreload(),
  ],
});
