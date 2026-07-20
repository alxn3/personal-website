import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import alphinejs from "@astrojs/alpinejs";
import icon from "astro-icon";

export default defineConfig({
  vite: {
    plugins: [tailwindcss()],
    server: {
      allowedHosts: [".trycloudflare.com"],
    },
  },
  integrations: [alphinejs({ entrypoint: "/src/lib/alpine" }), icon()],
});
