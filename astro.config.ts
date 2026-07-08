import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import alphinejs from "@astrojs/alpinejs";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
  },
  integrations: [alphinejs()],
});
