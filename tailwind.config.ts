import typography from '@tailwindcss/typography';
import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{html,js,svelte,ts}'],

  theme: {
    fontFamily: {
      primary: ['Figtree'],
      secondary: ['Playfair\\ Display'],
      tertiary: ['Lora'],
    },
    extend: {},
  },

  plugins: [typography],
} satisfies Config;
