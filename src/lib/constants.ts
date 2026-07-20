// Mirrors Tailwind's `lg` breakpoint (64rem): every JS matchMedia check must
// agree with the templates' `lg:`/`max-lg:` variants on where "desktop"
// starts, or panel state and styling would disagree at the boundary.
export const DESKTOP_MEDIA = "(min-width: 64rem)";

export const isDesktop = () => window.matchMedia(DESKTOP_MEDIA).matches;
