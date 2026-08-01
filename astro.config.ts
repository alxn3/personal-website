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
    server: {
      allowedHosts: [".trycloudflare.com"],
    },
  },
  integrations: [alphinejs({ entrypoint: "/src/lib/alpine" }), icon()],
});
