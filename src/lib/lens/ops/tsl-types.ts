// TSL nodes carry math methods (`.add`, `.negate`, …) that three's own .d.ts
// does not declare, so every shader-graph surface in this repo is typed `any`
// through this one alias — named, so a reader can tell "a shader node" from a
// genuine escape hatch. Type only: nothing here imports three, and the module
// disappears at build.
export type TslNode = any;
