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
  uInteriorFade,
  uShellFade,
  winkFactor,
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

// THE BODY FADE REACHES THE OUTLINES TOO: applyBodyFade writes
// `material.opacity` on every material a non-glass mesh wears, edge lines
// included, but a NodeMaterial's opacityNode REPLACES that value — a line graph
// that does not read `materialOpacity` leaves a wireframe ghost in the frame.
describe("the ink edge-lines' opacity", () => {
  it("reads materialOpacity, so setBodyFade can fade the outlines with the fills", () => {
    expect(graphOf(inkLineOpacity()).names).toContain("MaterialNode:opacity");
  });

  it("rides the whole ink ramp — the factor the fills mix on", () => {
    // one envelope for line and fill: the lines carry the raw uniform, with
    // none of a half-ramp's clamped-sub-div shape
    const line = graphOf(inkLineOpacity()).names;
    for (const node of ["MathNode{sqrt}", "MathNode{clamp}", "OperatorNode[/]"])
      expect(line, `line lacks ${node}`).not.toContain(node);
  });
});

// THE ONE-OWNER LAW for `transparent` on the merged body materials: setInk (the
// ink fills are translucent) and applyBodyFade (which fades the same shared
// instances) both want the flag, so neither writes it — both feed this.
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
// At uInk = 1 the merged material's output is its ink term alone and the body
// is sorted and blended for nothing. The swaps that take both back are legal
// only because the twin is the SAME drawing: a MeshBasicNodeMaterial from the
// same builders, on the same colour uniform, in the same render state — which
// is the identity pinned below.
// ============================================================================

/** One non-glass mesh wearing the shared PBR spec core/model.ts builds.
 *  UNFRAMED by default (no `_op*` attributes), so the deform attach is out of
 *  the comparison; `framed` adds the attribute `hasOpFrames` keys on. */
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

/** …with the twins built and warmed FOR THE CANVAS: the warm-up wears each
 *  variant across one render (a no-op here) and only then unlocks the swap, in
 *  that context alone. */
function wornLook(framed = false): { look: UnifiedLook; mesh: THREE.Mesh } {
  const { root, mesh } = stubModel(framed);
  const look = createUnified(root);
  look.warmBodyLooks("canvas", () => true);
  return { look, mesh };
}

const asMat = (mesh: THREE.Mesh) => mesh.material as THREE.Material;

beforeAll(() => {
  // The deform ships as generated source per dialect, so a material build needs
  // the dialect declared; core/scene.ts does it off the renderer.
  setDeformBackend("wgsl");
  // createUnified reads the site theme off the document; node has none.
  (globalThis as { document?: unknown }).document ??= {
    documentElement: { classList: { contains: () => false } },
  };
});

// EVERYTHING A GLASS MESH CAN WEAR — TWO FILLS AND NOTHING ELSE. `transmission
// > 0` pins a mesh in the transmission pass, so the elements crossfade between
// the realistic material and a flat mint fill at the middle of the ramp and
// grow no line-work. Glass stays VISIBLE at bodyFadedOut, so opacity is the
// only thing that removes it — miss `materialOpacity` on either fill and a
// column of mint elements floats where the lens used to be.
describe("everything a glass mesh can wear", () => {
  function glassLook() {
    const mesh = stubMesh();
    mesh.name = "Element_01";
    const root = new THREE.Group();
    root.add(mesh);
    return { look: createUnified(root), mesh };
  }

  const looks: [string, unknown][] = [
    ["the realistic fill (mergedGlass)", glassFillOpacity()],
    ["the ink fill (glassInkMaterial)", glassInkOpacity()],
  ];

  it("reads materialOpacity, so setBodyFade takes the elements with the body", () => {
    for (const [what, graph] of looks)
      expect(graphOf(graph).names, what).toContain("MaterialNode:opacity");
  });

  it("carries the depth-fade factor through without dropping it", () => {
    // the fade is passed IN, so the product must keep it rather than default;
    // pinned by IDENTITY — the node handed in must be the node in the graph
    const fade = float(0.5);
    expect(graphOf(glassInkOpacity(fade)).nodes).toContain(fade);
  });

  it("swaps ONCE, at the hand-over, and never grows an outline", () => {
    const { look, mesh } = glassLook();
    const realistic = asMat(mesh);
    look.setInk(0.49);
    expect(asMat(mesh), "below the hand-over").toBe(realistic);
    look.setInk(0.5);
    const fill = asMat(mesh);
    expect(fill, "at the hand-over").not.toBe(realistic);
    look.setInk(1);
    expect(asMat(mesh), "above it").toBe(fill);
    expect(mesh.children.filter((c) => c instanceof THREE.LineSegments)).toHaveLength(0); // prettier-ignore
  });
});

describe("the ink twin's parity with the material it replaces", () => {
  it("is an UNLIT basic material — the whole point of the swap", () => {
    const { look, mesh } = wornLook();
    const blend = asMat(mesh);
    look.setInk(1);
    const twin = asMat(mesh) as THREE.MeshBasicNodeMaterial;
    expect(twin).not.toBe(blend);
    expect(twin.isMeshBasicNodeMaterial).toBe(true);
    // `lights = false` takes the lighting context, irradiance and environment
    // out of the fragment shader; MeshBasicNodeMaterial ships it true.
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

  // THE DEFORM IS THE ONE THING THE TWIN MAY NOT COPY: NodeMaterial.copy copies
  // node REFERENCES, and two materials cannot share a node graph in three, so a
  // framed mesh's twin must re-attach its own deform.
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

// THE WARM-UP IS PER KEY AND PER CONTEXT: a pipeline is compiled by a DRAW,
// keyed on the render context, and body materials are minted long after the
// first warm frame (late accessories, re-keyed frames). One global "warmed"
// flag would put their compile on the frame they are first worn, mid-scroll.
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
    // would compile nothing for the accessories, which load hidden.
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

  // A DRAW THAT NEVER REACHED THE SCENE COMPILES NOTHING: the dive's pass draws
  // its scene once per tick, so marking that context warm would hand the twin
  // out on a pipeline nobody built.
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
    // …over `output` (the PropertyNode), and celShade's band clamp, which rides
    // the material's normal
    expect(g.names).toContain("PropertyNode");
    expect(g.names).toContain("MathNode{clamp}");
  });
});

// THE WINK REACHES EVERY DRAWN PIXEL OF A PIECE: the fill (both body variants)
// and the edge lines multiply by the per-piece term, which reads the `_opY`
// lane and the two level uniforms. A framed mesh's materials carry it; an
// unframed one has no lane to read and must not declare the attribute.
describe("the wink term", () => {
  const readsLane = (root: unknown) =>
    [...graphOf(root).nodes].some(
      (n) => (n as { _attributeName?: string })._attributeName === "_opY",
    );

  it("reads the lane and BOTH level uniforms, by identity", () => {
    const g = graphOf(winkFactor());
    expect(readsLane(winkFactor())).toBe(true);
    expect(g.nodes).toContain(uShellFade);
    expect(g.nodes).toContain(uInteriorFade);
    expect(g.names).toContain("MathNode{smoothstep}");
  });

  it("multiplies the fill and the line graphs, and is carried by identity", () => {
    const wink = float(0.5);
    expect(graphOf(bodyFillOpacity(float(1), wink)).nodes).toContain(wink);
    expect(graphOf(inkLineOpacity(undefined, wink)).nodes).toContain(wink);
    // …and without one the graphs are the plain ones
    expect(readsLane(bodyFillOpacity(float(1)))).toBe(false);
  });

  it("is on a framed mesh's body materials and off an unframed one's", () => {
    const framed = wornLook(true);
    const blend = asMat(framed.mesh) as THREE.NodeMaterial;
    expect(readsLane(blend.opacityNode)).toBe(true);
    framed.look.setInk(1);
    expect(readsLane((asMat(framed.mesh) as THREE.NodeMaterial).opacityNode)).toBe(true); // prettier-ignore
    const bare = wornLook(false);
    expect(readsLane((asMat(bare.mesh) as THREE.NodeMaterial).opacityNode)).toBe(false); // prettier-ignore
  });
});
