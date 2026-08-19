// WHERE EVERY CHANNEL AND KNOB LIVES in the packed uniform arrays the emitted
// deform reads. DERIVED from the recipe table's own `knobDefaults` key order —
// not a checked-in table — so the emitter and (from stage 2) the runtime setters
// cannot disagree about a lane, and adding a knob re-lays the block by itself.
//
// Channels are one `vec4` (one lane per recipe, table order). Knobs get a
// PER-RECIPE BLOCK of whole vec4s, so a recipe's lanes never straddle another's
// and a knob added to one recipe cannot renumber another's.

import { NUM } from "../algebra";
import { makeRecipes, type RecipeName } from "../recipes";

export interface Lane {
  /** index into the knob array */
  vec4: number;
  /** 0..3 → x y z w */
  lane: number;
}

export interface Layout {
  /** recipe names in table order — the channel lane order too */
  names: RecipeName[];
  /** recipe → knob → lane */
  knob: Record<string, Record<string, Lane>>;
  /** recipe → its block's first vec4 index */
  base: Record<string, number>;
  /** total vec4s the knob array needs */
  vec4Count: number;
  /** recipe → its knob names, in the order they were laid out */
  knobNames: Record<string, string[]>;
  /** recipe → knob → the recipe's own physical default, which the lanes boot
   *  at. Carried here so ops/host.ts needs no recipe table of its own. */
  knobDefaults: Record<string, Record<string, number>>;
}

export function buildLayout(): Layout {
  const recipes = makeRecipes(NUM);
  const names = Object.keys(recipes) as RecipeName[];
  const knob: Layout["knob"] = {};
  const base: Layout["base"] = {};
  const knobNames: Layout["knobNames"] = {};
  const knobDefaults: Layout["knobDefaults"] = {};
  let vec4 = 0;
  for (const name of names) {
    const ks = Object.keys(recipes[name].knobDefaults);
    base[name] = vec4;
    knobNames[name] = ks;
    knobDefaults[name] = { ...recipes[name].knobDefaults } as Record<string, number>; // prettier-ignore
    knob[name] = {};
    ks.forEach((k, i) => {
      knob[name][k] = { vec4: vec4 + Math.floor(i / 4), lane: i % 4 };
    });
    vec4 += Math.ceil(ks.length / 4);
  }
  return { names, knob, base, vec4Count: vec4, knobNames, knobDefaults };
}

/** The one layout, built once. */
export const LAYOUT: Layout = buildLayout();
