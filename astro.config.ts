import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import alphinejs from "@astrojs/alpinejs";
import icon from "astro-icon";

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
  integrations: [alphinejs({ entrypoint: "/src/lib/alpine" }), icon()],
});
