// Must match Tailwind's `lg` breakpoint (64rem) used by the templates.
export const DESKTOP_MEDIA = "(min-width: 64rem)";

export const isDesktop = () => window.matchMedia(DESKTOP_MEDIA).matches;
