// TSL nodes carry math methods (`.add`, `.negate`, …) that three's .d.ts does
// not declare, so every shader-graph surface is typed `any` through this alias.
export type TslNode = any;
