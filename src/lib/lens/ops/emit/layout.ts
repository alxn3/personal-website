// Where each channel and knob lives in the packed uniforms, derived from the
// recipes' `knobSpec` key order. Channels are one vec4 (one lane per recipe);
// each recipe's knobs get their own block of whole vec4s.

import { NUM } from "../algebra";
import { makeRecipes, type KnobSpec, type RecipeName } from "../recipes";

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
  /** total vec4s the knob array needs */
  vec4Count: number;
  /** recipe → its knob names, in the order they were laid out */
  knobNames: Record<string, string[]>;
  /** recipe → knob → default and range */
  spec: Record<string, Record<string, KnobSpec>>;
}

function buildLayout(): Layout {
  const recipes = makeRecipes(NUM);
  const names = Object.keys(recipes) as RecipeName[];
  const knob: Layout["knob"] = {};
  const knobNames: Layout["knobNames"] = {};
  const spec: Layout["spec"] = {};
  let vec4 = 0;
  for (const name of names) {
    const ks = Object.keys(recipes[name].knobSpec);
    knobNames[name] = ks;
    spec[name] = recipes[name].knobSpec;
    knob[name] = {};
    ks.forEach((k, i) => {
      knob[name][k] = { vec4: vec4 + Math.floor(i / 4), lane: i % 4 };
    });
    vec4 += Math.ceil(ks.length / 4);
  }
  return { names, knob, vec4Count: vec4, knobNames, spec };
}

/** The one layout, built once. */
export const LAYOUT: Layout = buildLayout();
