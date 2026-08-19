import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { float } from "three/tsl";
import {
  bodyFillOpacity,
  bodyTransparent,
  createUnified,
  glassFillOpacity,
  glassInkOpacity,
  inkLineOpacity,
  inkOutput,
  inkTwinWorn,
  type InkEdge,
  type UnifiedLook,
} from "../unified";
import { setDeformBackend } from "../../ops/host";

/** every node in a TSL graph, by constructor name + whatever scope it carries,
 *  plus the node objects themselves (so a factor can be pinned by IDENTITY and
 *  not by a three-internal class name that a release may rename) */
function graphOf(root: unknown): { names: string[]; nodes: Set<unknown> } {
  const names: string[] = [];
  const nodes = new Set<unknown>();
  const seen = new Set<unknown>();
  const walk = (n: any, depth: number) => {
    if (!n || typeof n !== "object" || seen.has(n) || depth > 12) return;
    seen.add(n);
    if (n.isNode) {
      nodes.add(n);
      names.push(
        `${n.constructor?.name}${typeof n.scope === "string" ? `:${n.scope}` : ""}` +
          `${typeof n.op === "string" ? `[${n.op}]` : ""}` +
          `${typeof n.method === "string" ? `{${n.method}}` : ""}`,
      );
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((e) => walk(e, depth + 1));
      else walk(v, depth + 1);
    }
  };
  walk(root, 0);
  return { names, nodes };
}

// THE BODY FADE REACHES THE OUTLINES TOO. core/scene's applyBodyFade writes
// `material.opacity` on every material a non-glass mesh wears, edge lines
// INCLUDED — but a NodeMaterial's opacityNode REPLACES that value, so a line
// graph that does not read `materialOpacity` silently ignores the write. It cost
// nothing while the only body fade on the page was the dive's (uInk is 0 there,
// so the lines draw nothing); the story now fades the lens out under the card
// shell with the ink fully on, where the same omission left a full-strength
// wireframe ghost of the lens hanging in the frame.
describe("the ink edge-lines' opacity", () => {
  it("reads materialOpacity, so setBodyFade can fade the outlines with the fills", () => {
    for (const glass of [false, true])
      expect(graphOf(inkLineOpacity(glass)).names, `glass ${glass}`).toContain(
        "MaterialNode:opacity",
      );
  });

  // (The two line looks are no longer graph-identical — the glass lines ride
  // the ramp's TOP HALF with the fill they outline, see inkLineOpacity — so
  // the old graph-equality pin is replaced by the shared-envelope law below;
  // the materialOpacity factor on BOTH is covered by the test above.)
  it("arrives WITH the glass ink fill, and not before it", () => {
    // the coupling this pins: the glass outline and the mint
    // fill share ONE envelope (the ramp's top half — glassInkOpacity's own
    // factor), so neither can appear without the other while a returning piece
    // is still displaced. Pinned structurally: the glass line graph carries
    // the ink uniform through the same clamped-sub-div shape the fill uses,
    // and the BODY lines keep the whole ramp (their fill mixes on raw uInk).
    const glassLine = graphOf(inkLineOpacity(true)).names;
    const glassFill = graphOf(glassInkOpacity()).names;
    const bodyLine = graphOf(inkLineOpacity(false)).names;
    // the top-half shape — clamp((uInk − ½)/½).sqrt() — appears in both glass
    // graphs; the body line multiplies the raw uniform and has none of it
    const topHalfShape = [
      "MathNode{sqrt}",
      "MathNode{clamp}",
      "OperatorNode[/]",
    ];
    for (const node of topHalfShape) {
      expect(glassLine, `glass line has ${node}`).toContain(node);
      expect(glassFill, `glass fill has ${node}`).toContain(node);
      expect(bodyLine, `body line lacks ${node}`).not.toContain(node);
    }
  });
});

// …AND IT HAS TO REACH THE GLASS, which is the bigger half of the same law. The
// story's peel/cards crossfade takes the WHOLE lens away — core/scene's
// bodyMaterials() hands applyBodyFade the optical elements too, whenever the
// dive is not wearing its own transmissive clones — and applyVisibility
// deliberately leaves glass VISIBLE at bodyFadedOut, so opacity is the only
// thing that removes it. A glass mesh wears one of three materials over the
// story (the realistic fill, the ink fill, its edge lines); miss materialOpacity
// on ANY one of them and the frame keeps a column of mint elements floating
// where the lens used to be — which is exactly what it did, once
// (v3-cards-0.35-lens-hidden.png). Three looks, one law, no renderer needed.
describe("everything a glass mesh can wear", () => {
  const looks: [string, unknown][] = [
    ["the realistic fill (mergedGlass)", glassFillOpacity()],
    ["the ink fill (glassInkMaterial)", glassInkOpacity()],
    ["its edge lines", inkLineOpacity(true)],
  ];

  it("reads materialOpacity, so setBodyFade takes the elements with the body", () => {
    for (const [what, graph] of looks)
      expect(graphOf(graph).names, what).toContain("MaterialNode:opacity");
  });

  it("carries the depth-fade factor through without dropping it", () => {
    // the ink fill's own fade is attached to the material and passed IN, so the
    // extraction has to keep it in the product rather than quietly defaulting.
    // Pinned by IDENTITY — the node handed in must be the node in the graph.
    const fade = float(0.5);
    expect(graphOf(glassInkOpacity(fade)).nodes).toContain(fade);
  });
});

// THE ONE-OWNER LAW for `transparent` on the merged body materials. Two callers
// want the flag at once — materials/unified.ts's setInk (the ink fills are
// translucent) and core/scene.ts's applyBodyFade (which fades the same shared
// instances) — and they used to write it independently, so whichever ran last
// won: a look change mid-fade left the body opaque at opacity 0.5, and a fade
// restore mid-story left it transparent through the dive, where three copies the
// transmission backdrop from the OPAQUE pass only (the body would vanish inside
// the glass). Neither writes it now; both move an input into this.
describe("the body's transparent flag", () => {
  it("is on while EITHER owner wants it — so neither can clear it under the other", () => {
    expect(bodyTransparent(true, false)).toBe(true); // ink showing, fade restored
    expect(bodyTransparent(false, true)).toBe(true); // fade running, ink left
    expect(bodyTransparent(true, true)).toBe(true); // both
  });

  it("is off only when NEITHER does — the state the dive needs", () => {
    expect(bodyTransparent(false, false)).toBe(false);
  });
});

// ============================================================================
// THE 1-EDGE: THE INK TWIN AND THE OPAQUE FLIP (materials/unified.ts's header).
//
// At uInk = 1 the merged material's output is its ink term alone — the whole
// MeshStandard/Physical fragment path is computed and multiplied by zero — and
// with the fills at alpha 1 the body is sorted and blended for nothing. Two
// swaps take both back, and BOTH ARE ONLY LEGAL BECAUSE THE TWO SIDES ARE THE
// SAME DRAWING: the twin is a MeshBasicNodeMaterial built from the SAME
// builders, on the SAME colour uniform, wearing the SAME render state. What is
// pinned below is exactly that identity — a twin that drifted by one flag or
// one factor would be a look change nothing else in this repo would catch.
// ============================================================================

/** One non-glass mesh, wearing the shared PBR spec core/model.ts builds.
 *  UNFRAMED by default (no `_op*` attributes), so the deform attach is out of
 *  the comparison and what is left is the pair's own graphs; `framed` adds the
 *  frame attribute `hasOpFrames` keys on, which is what puts the op deform on
 *  both materials. */
function stubMesh(framed = false, color = 0x191919) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3),
  );
  if (framed)
    geo.setAttribute(
      "_opA",
      new THREE.BufferAttribute(new Float32Array(12), 4),
    );
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, roughness: 0.55 }),
  );
  mesh.name = "Barrel_Base";
  return mesh;
}

/** A minimal lens: one such mesh under a root. */
function stubModel(framed = false) {
  const mesh = stubMesh(framed);
  const root = new THREE.Group();
  root.add(mesh);
  return { root, mesh };
}

/** …with the twins built and warmed FOR THE CANVAS, which is the state the
 *  story runs in outside the dive: the warm-up wears each variant across one
 *  real render (here a no-op — no renderer is needed to build a node graph) and
 *  only then unlocks the swap, in that context alone. */
function wornLook(framed = false): { look: UnifiedLook; mesh: THREE.Mesh } {
  const { root, mesh } = stubModel(framed);
  const look = createUnified(root);
  look.warmBodyLooks("canvas", () => true);
  return { look, mesh };
}

const asMat = (mesh: THREE.Mesh) => mesh.material as THREE.Material;

beforeAll(() => {
  // The deform ships as generated source per dialect (ops/emit), so a material
  // build needs the dialect declared — core/scene.ts does it off the renderer.
  setDeformBackend("wgsl");
  // createUnified reads the site theme off the document; node has none.
  (globalThis as { document?: unknown }).document ??= {
    documentElement: { classList: { contains: () => false } },
  };
});

describe("the ink twin's parity with the material it replaces", () => {
  it("is an UNLIT basic material — the whole point of the swap", () => {
    const { look, mesh } = wornLook();
    const blend = asMat(mesh);
    look.setInk(1);
    const twin = asMat(mesh) as THREE.MeshBasicNodeMaterial;
    expect(twin).not.toBe(blend);
    expect(twin.isMeshBasicNodeMaterial).toBe(true);
    // `lights = false` is what takes the lighting context, the irradiance and
    // the environment out of the fragment shader. MeshBasicNodeMaterial ships
    // it true (for the light map / env map an unlit material can still wear).
    expect(twin.lights).toBe(false);
    // …and the basic material's own setupNormal is what would drop the op
    // deform's normal and band celShade by the rest pose.
    expect(twin.setupNormal).toBe(THREE.NodeMaterial.prototype.setupNormal);
    expect(twin.setupNormal).not.toBe(
      THREE.MeshBasicNodeMaterial.prototype.setupNormal,
    );
  });

  it("draws the SAME graphs — output and opacity, node for node", () => {
    const { look, mesh } = wornLook();
    const blend = asMat(mesh) as THREE.NodeMaterial;
    look.setInk(1);
    const twin = asMat(mesh) as THREE.NodeMaterial;
    for (const node of ["outputNode", "opacityNode"] as const) {
      const a = graphOf(blend[node]);
      const b = graphOf(twin[node]);
      expect(b.names, `${node} structure`).toEqual(a.names);
    }
  });

  it("shares the ink colour uniform BY IDENTITY, so one theme write re-tints the pair", () => {
    const { look, mesh } = wornLook();
    const blend = asMat(mesh) as THREE.NodeMaterial;
    look.setInk(1);
    const twin = asMat(mesh) as THREE.NodeMaterial;
    // the colour uniform is the one node object the two graphs must SHARE (the
    // rest are fresh per material — a node cannot be reused across materials)
    const shared = [...graphOf(blend.outputNode).nodes].filter((n) =>
      graphOf(twin.outputNode).nodes.has(n),
    );
    const tint = shared.filter(
      (n) => (n as { value?: unknown }).value instanceof THREE.Color,
    );
    expect(tint).toHaveLength(1);
    look.setTheme(true);
    expect(
      ((tint[0] as { value: THREE.Color }).value as THREE.Color).getHex(),
    ).toBe(0xe3ddcc); // inkFill("Barrel_Base", light) — the light gloss body
  });

  it("wears the SAME render state — every flag that decides a pixel", () => {
    const { look, mesh } = wornLook();
    const blend = asMat(mesh);
    look.setInk(1);
    const twin = asMat(mesh);
    for (const k of [
      "alphaTest",
      "alphaToCoverage",
      "blending",
      "colorWrite",
      "depthFunc",
      "depthTest",
      "depthWrite",
      "opacity",
      "polygonOffset",
      "polygonOffsetFactor",
      "polygonOffsetUnits",
      "premultipliedAlpha",
      "side",
      "toneMapped",
      "vertexColors",
    ] as const)
      expect(twin[k], k).toBe(blend[k]);
    // `transparent` is the ONE difference, and it is the variant's definition:
    // this one replaces a transparent material, so it is transparent too.
    expect(twin.transparent).toBe(blend.transparent);
  });

  // THE DEFORM IS THE ONE THING THE TWIN MAY NOT COPY. It is built by
  // `m.copy(blend)` + overrides, and NodeMaterial.copy copies node REFERENCES —
  // so on a FRAMED mesh (one carrying the op frame attributes, i.e. every piece
  // the story moves) a twin that failed to re-attach would be pointing at the
  // blend's own position/normal nodes. Two materials cannot share a node graph
  // in three, and the symptom would be an undrawable material or a piece
  // deforming on the wrong material's state — not something the unframed stub
  // above can see, because there is nothing to attach there.
  it("attaches its OWN op deform on a framed mesh — never the blend's nodes", () => {
    const { look, mesh } = wornLook(true);
    const blend = asMat(mesh) as THREE.NodeMaterial;
    // the blend really is deformed — otherwise the assertions below pass on two
    // nulls and pin nothing
    expect(blend.positionNode).toBeTruthy();
    expect(blend.normalNode).toBeTruthy();
    look.setInk(1);
    const twin = asMat(mesh) as THREE.NodeMaterial;
    expect(twin).not.toBe(blend);
    expect(twin.positionNode).toBeTruthy();
    expect(twin.normalNode).toBeTruthy();
    expect(twin.positionNode).not.toBe(blend.positionNode);
    expect(twin.normalNode).not.toBe(blend.normalNode);
    // …and they are the SAME deform, freshly built: same graph, other objects
    expect(graphOf(twin.positionNode).names).toEqual(
      graphOf(blend.positionNode).names,
    );
  });
});

describe("when the twin is worn", () => {
  it("waits for its own warm-up — before that the body is exactly what it was", () => {
    const { root, mesh } = stubModel();
    const look = createUnified(root);
    const blend = asMat(mesh);
    look.setInk(1);
    expect(asMat(mesh)).toBe(blend);
    look.warmBodyLooks("canvas", () => true);
    expect(asMat(mesh)).not.toBe(blend);
  });

  it("swaps AT 1 and nowhere near it", () => {
    const { look, mesh } = wornLook();
    const blend = asMat(mesh);
    for (const k of [0, 0.5, 0.9999999]) {
      look.setInk(k);
      expect(asMat(mesh), `uInk ${k}`).toBe(blend);
    }
    look.setInk(1);
    expect(asMat(mesh)).not.toBe(blend);
    look.setInk(0.9999999);
    expect(asMat(mesh)).toBe(blend);
  });

  it("comes off for a body fade, which owns the opacity it would carry", () => {
    const { look, mesh } = wornLook();
    const blend = asMat(mesh);
    look.setInk(1);
    expect(asMat(mesh)).not.toBe(blend);
    look.bodyFadeActive(true);
    expect(asMat(mesh)).toBe(blend);
    look.bodyFadeActive(false);
    expect(asMat(mesh)).not.toBe(blend);
  });

  it("is core/scene's to leave alone: both variants own their own flag", () => {
    const { look, mesh } = wornLook();
    look.setInk(1);
    expect(look.ownsTransparent(asMat(mesh))).toBe(true);
  });
});

// THE WARM-UP IS PER KEY AND PER CONTEXT, and both halves of that are load-
// bearing: a pipeline is compiled by a DRAW, keyed on the render context, and
// this file mints body materials long after the first warm frame has run (the
// accessories arrive a second or two into the page, and `integrate` re-keys any
// mesh whose op frame landed late). One global "warmed" flag would hand those
// materials out unwarmed, and their compile would land on the frame they are
// first worn — mid-scroll, which is the one thing the warm-up exists to stop.
describe("the twin's warm-up covers what it claims to", () => {
  it("keeps a material minted AFTER the warm frame on the blend, and asks for another", () => {
    const { root, mesh } = stubModel();
    const look = createUnified(root);
    look.warmBodyLooks("canvas", () => true);
    expect(look.needsWarm("canvas")).toBe(false);
    look.setInk(1);
    const twin = asMat(mesh);
    // an accessory arriving late, on its own source material (a new cache key)
    const late = stubMesh(false, 0x272727);
    root.add(late);
    look.integrate(root);
    const lateBlend = asMat(late);
    expect(lateBlend).not.toBe(twin);
    expect(lateBlend.transparent).toBe(true); // the blend, at ink 1
    // …and the controller says so, which is how core/scene knows to spend a
    // second warm frame on it
    expect(look.needsWarm("canvas")).toBe(true);
    look.warmBodyLooks("canvas", () => true);
    expect(look.needsWarm("canvas")).toBe(false);
    expect(asMat(late)).not.toBe(lateBlend);
    expect(asMat(mesh)).toBe(twin); // the key that was already warm did not move
  });

  it("draws every body mesh in the warm frame, hidden ones included", () => {
    // three does not draw a hidden object, so a warm frame that skipped them
    // would compile nothing for the accessories — which load hidden and can be
    // toggled on at any moment from /lens.
    const { root, mesh } = stubModel();
    mesh.visible = false;
    const look = createUnified(root);
    const seen: boolean[] = [];
    look.warmBodyLooks("canvas", () => {
      seen.push(mesh.visible);
      return true;
    });
    expect(seen).toEqual([true]);
    expect(mesh.visible).toBe(false); // …and put back exactly as it was
  });

  it("does not let one context's warm stand in for the other's", () => {
    const { root, mesh } = stubModel();
    const look = createUnified(root);
    const blend = asMat(mesh);
    look.warmBodyLooks("canvas", () => true);
    look.setInk(1);
    const twin = asMat(mesh);
    expect(twin).not.toBe(blend);
    // the dive's wormhole pass is a second pipeline per material, and nothing
    // has drawn one there yet
    look.syncBody("pass");
    expect(asMat(mesh)).toBe(blend);
    expect(look.needsWarm("pass")).toBe(true);
    look.warmBodyLooks("pass", () => true);
    look.syncBody("pass");
    expect(asMat(mesh)).toBe(twin);
    // …and the canvas keeps its own answer through all of it
    look.syncBody("canvas");
    expect(asMat(mesh)).toBe(twin);
  });

  // A DRAW THAT NEVER REACHED THE SCENE COMPILES NOTHING. core/scene's dive
  // warm renders through a pass that draws its scene once per tick, so a second
  // call inside one tick collapses to the output quad; marking the context warm
  // on that would hand the twin out on a pipeline nobody built.
  it("refuses a context whose draw reported nothing drawn", () => {
    const { root, mesh } = stubModel();
    const look = createUnified(root);
    look.warmBodyLooks("canvas", () => false);
    expect(look.needsWarm("canvas")).toBe(true);
    look.setInk(1);
    const blend = asMat(mesh);
    look.warmBodyLooks("canvas", () => true);
    expect(look.needsWarm("canvas")).toBe(false);
    expect(asMat(mesh)).not.toBe(blend);
  });
});

describe("the 1-edge's laws, without a scene", () => {
  const edge = (o: Partial<InkEdge> = {}): InkEdge => ({
    inkMix: 1,
    fadeOn: false,
    ...o,
  });

  it("wears the twin only at EXACTLY 1, and never under a fade", () => {
    expect(inkTwinWorn(edge())).toBe(true);
    expect(inkTwinWorn(edge({ inkMix: 1 - 1e-12 }))).toBe(false);
    expect(inkTwinWorn(edge({ fadeOn: true }))).toBe(false);
  });
});

describe("the body's two graphs, shared by the pair", () => {
  it("keeps materialOpacity, so the body fade still reaches the fills", () => {
    expect(graphOf(bodyFillOpacity(float(1))).names).toContain(
      "MaterialNode:opacity",
    );
  });

  it("carries the depth fade handed in, by identity", () => {
    const fade = float(0.5);
    expect(graphOf(bodyFillOpacity(fade)).nodes).toContain(fade);
  });

  it("mixes the ink over the lit output, so the twin's dead side is × 0", () => {
    const ink = float(0.25);
    const g = graphOf(inkOutput(ink));
    expect(g.nodes).toContain(ink);
    expect(g.names).toContain("MathNode{mix}");
    // …over `output` (the PropertyNode), and celShade's own band clamp — the
    // banding rides the material's normal, which is why the twin restores the
    // base setupNormal (MeshBasicNodeMaterial's would read the rest pose).
    expect(g.names).toContain("PropertyNode");
    expect(g.names).toContain("MathNode{clamp}");
  });
});
