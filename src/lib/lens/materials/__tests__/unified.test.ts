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
  uInteriorFade,
  uShellFade,
  winkFactor,
  type UnifiedLook,
} from "../unified";
import { setDeformBackend } from "../../ops/host";

/** Every node in a TSL graph, as names and as objects (to check identity). */
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

// Every fill and line graph must read `materialOpacity` (the body fade writes
// `material.opacity`), and carry the fade/wink/colour nodes handed in.
describe("the opacity and colour graphs", () => {
  it.each([
    ["the ink edge lines", () => inkLineOpacity()],
    ["the realistic glass fill", () => glassFillOpacity()],
    ["the glass ink fill", () => glassInkOpacity()],
    ["the body fill", () => bodyFillOpacity(float(1))],
  ])("%s read materialOpacity, so setBodyFade reaches them", (_, graph) => {
    expect(graphOf(graph()).names).toContain("MaterialNode:opacity");
  });

  it.each([
    ["glass ink fill, depth fade", (n: any) => glassInkOpacity(n)],
    ["body fill, depth fade", (n: any) => bodyFillOpacity(n)],
    ["body fill, wink", (n: any) => bodyFillOpacity(float(1), n)],
    ["edge lines, wink", (n: any) => inkLineOpacity(undefined, n)],
    ["body output, ink colour", (n: any) => inkOutput(n)],
  ])("%s: carries the node handed in, by identity", (_, build) => {
    const node = float(0.5);
    expect(graphOf(build(node)).nodes).toContain(node);
  });

  it("rides the lines on the whole ink ramp — the factor the fills mix on", () => {
    // lines use uInk directly, not a half-ramp
    const line = graphOf(inkLineOpacity()).names;
    for (const node of ["MathNode{sqrt}", "MathNode{clamp}", "OperatorNode[/]"])
      expect(line, `line lacks ${node}`).not.toContain(node);
  });

  it("mixes the ink over the lit output, so the twin's dead side is × 0", () => {
    const g = graphOf(inkOutput(float(0.25)));
    expect(g.names).toContain("MathNode{mix}");
    // …over `output` and celShade's band clamp
    expect(g.names).toContain("PropertyNode");
    expect(g.names).toContain("MathNode{clamp}");
  });
});

// `transparent` on body materials: on while ink shows or the body is fading.
describe("the body's transparent flag", () => {
  it("is on while EITHER owner wants it, and off only when neither does", () => {
    expect(bodyTransparent(true, false)).toBe(true); // ink showing
    expect(bodyTransparent(false, true)).toBe(true); // fade running
    expect(bodyTransparent(true, true)).toBe(true);
    expect(bodyTransparent(false, false)).toBe(false); // what the dive needs
  });
});

// --- the unlit twin at uInk = 1 ---
// Swapping to the twin is only invisible if it draws exactly what the blend
// draws: same graphs, same colour uniform, same render state.

/** A non-glass mesh with a model.ts-style material. `framed` adds the `_op*`
 *  attribute so it gets the deform. */
function stubMesh(framed = false, color = 0x191919, name = "Barrel_Base") {
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
  mesh.name = name;
  return mesh;
}

/** A minimal lens: one such mesh under a root. */
function stubModel(framed = false, name?: string) {
  const mesh = stubMesh(framed, undefined, name);
  const root = new THREE.Group();
  root.add(mesh);
  return { root, mesh };
}

/** …with the twins built and warmed for the canvas. */
function wornLook(framed = false): { look: UnifiedLook; mesh: THREE.Mesh } {
  const { root, mesh } = stubModel(framed);
  const look = createUnified(root);
  look.warmBodyLooks("canvas", () => true);
  return { look, mesh };
}

const asMat = (mesh: THREE.Mesh) => mesh.material as THREE.Material;

/** The blend a warmed body mesh wears, and the twin it wears at uInk = 1. */
function twinPair(framed = false) {
  const { look, mesh } = wornLook(framed);
  const blend = asMat(mesh) as THREE.NodeMaterial;
  look.setInk(1);
  return { look, blend, twin: asMat(mesh) as THREE.NodeMaterial };
}

beforeAll(() => {
  // material builds need a deform dialect (scene.ts sets it from the renderer)
  setDeformBackend("wgsl");
  // createUnified reads the theme from `document`
  (globalThis as { document?: unknown }).document ??= {
    documentElement: { classList: { contains: () => false } },
  };
});

// Glass wears two fills (PBR and flat ink), no lines.
describe("everything a glass mesh can wear", () => {
  it("swaps ONCE, at the hand-over, and never grows an outline", () => {
    const { root, mesh } = stubModel(false, "Element_01");
    const look = createUnified(root);
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
    const { blend, twin } = twinPair();
    expect(twin).not.toBe(blend);
    expect((twin as THREE.MeshBasicNodeMaterial).isMeshBasicNodeMaterial).toBe(
      true,
    );
    // unlit
    expect(twin.lights).toBe(false);
    // uses the deformed normal, not MeshBasic's own
    expect(twin.setupNormal).toBe(THREE.NodeMaterial.prototype.setupNormal);
    expect(twin.setupNormal).not.toBe(
      THREE.MeshBasicNodeMaterial.prototype.setupNormal,
    );
  });

  it("draws the SAME graphs — output and opacity, node for node", () => {
    const { blend, twin } = twinPair();
    for (const node of ["outputNode", "opacityNode"] as const) {
      const a = graphOf(blend[node]);
      const b = graphOf(twin[node]);
      expect(b.names, `${node} structure`).toEqual(a.names);
    }
  });

  it("shares the ink colour uniform BY IDENTITY, so one theme write re-tints the pair", () => {
    const { look, blend, twin } = twinPair();
    // the colour uniform is the one node the two graphs share
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
    const { blend, twin } = twinPair();
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
    // the twin is always transparent
    expect(twin.transparent).toBe(blend.transparent);
  });

  // The twin must build its own deform graph: materials can't share nodes.
  it("attaches its OWN op deform on a framed mesh — never the blend's nodes", () => {
    const { blend, twin } = twinPair(true);
    // guard: the blend is deformed, so the checks below are meaningful
    expect(blend.positionNode).toBeTruthy();
    expect(blend.normalNode).toBeTruthy();
    expect(twin).not.toBe(blend);
    expect(twin.positionNode).toBeTruthy();
    expect(twin.normalNode).toBeTruthy();
    expect(twin.positionNode).not.toBe(blend.positionNode);
    expect(twin.normalNode).not.toBe(blend.normalNode);
    // same graph shape, different node objects
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

// Warm-up is tracked per material key and per render context, because new
// body materials appear later (e.g. accessories).
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
    // …and needsWarm reports it
    expect(look.needsWarm("canvas")).toBe(true);
    look.warmBodyLooks("canvas", () => true);
    expect(look.needsWarm("canvas")).toBe(false);
    expect(asMat(late)).not.toBe(lateBlend);
    expect(asMat(mesh)).toBe(twin); // the key that was already warm did not move
  });

  it("draws every body mesh in the warm frame, hidden ones included", () => {
    // hidden meshes must be shown for the warm draw (three skips hidden ones)
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
    // the post pass is a separate context, not yet warmed
    look.syncBody("pass");
    expect(asMat(mesh)).toBe(blend);
    expect(look.needsWarm("pass")).toBe(true);
    look.warmBodyLooks("pass", () => true);
    look.syncBody("pass");
    expect(asMat(mesh)).toBe(twin);
    look.syncBody("canvas");
    expect(asMat(mesh)).toBe(twin);
  });

  // A draw that didn't reach the scene must not mark the context warm.
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

// Fills and edge lines of framed meshes include the dissolve term; unframed
// meshes (no `_opY` attribute) must not reference it.
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

  it("is on a framed mesh's body materials and off an unframed one's", () => {
    const framed = wornLook(true);
    const blend = asMat(framed.mesh) as THREE.NodeMaterial;
    expect(readsLane(blend.opacityNode)).toBe(true);
    framed.look.setInk(1);
    expect(readsLane((asMat(framed.mesh) as THREE.NodeMaterial).opacityNode)).toBe(true); // prettier-ignore
    const bare = wornLook(false);
    expect(readsLane((asMat(bare.mesh) as THREE.NodeMaterial).opacityNode)).toBe(false); // prettier-ignore
    expect(readsLane(bodyFillOpacity(float(1)))).toBe(false);
  });
});
