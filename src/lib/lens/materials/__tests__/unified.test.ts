import { beforeAll, describe, expect, it } from "vitest";
import * as THREE from "three/webgpu";
import { float, renderGroup } from "three/tsl";
import {
  bodyFillOpacity,
  bodyTransparent,
  createUnified,
  edgeGeometry,
  glassFillOpacity,
  glassInkOpacity,
  inkLineOpacity,
  inkOutput,
  uInkFill,
  uInteriorFade,
  uShellFade,
  winkFactor,
  type UnifiedLook,
} from "../unified";
import { uFadeFar0, uFadeFar1, uFadeNear0, uFadeNear1 } from "../depthfade";
import { attachOps, setDeformBackend, tagOpsSpin } from "../../ops/host";

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

  // Flipping `transparent` recompiles the shader, so the flag is fixed per
  // material and the mesh swaps between an opaque and a transparent blend.
  it("is never flipped on a material: the mesh swaps between resident blends", () => {
    const { look, mesh } = wornLook(true);
    const seen = new Map<THREE.Material, boolean>();
    const steps: [number, boolean][] = [
      [0, false], [0.3, false], [0, false], [0.3, false], [0, true],
      [0.3, true], [0, true], [0, false], [0.3, false], [0, false],
    ]; // prettier-ignore
    for (const [ink, fade] of steps) {
      look.setInk(ink);
      look.bodyFadeActive(fade);
      look.syncBody();
      const m = asMat(mesh);
      expect(m.transparent, `ink ${ink} fade ${fade}`).toBe(
        bodyTransparent(ink > 0, fade),
      );
      for (const [mat, t] of seen) expect(mat.transparent).toBe(t);
      if (!seen.has(m)) seen.set(m, m.transparent);
    }
    expect(seen.size, "one opaque and one transparent blend").toBe(2);
  });

  it("warms every body look, so none first-compiles on a scroll frame", () => {
    const { root, mesh } = stubModel(true);
    const look = createUnified(root);
    const drawn = new Set<THREE.Material>();
    warmAll(look, () => drawn.add(asMat(mesh)));
    const worn = new Set<THREE.Material>();
    for (const ink of [0, 0.5, 1]) {
      look.setInk(ink);
      worn.add(asMat(mesh));
    }
    look.bodyFadeActive(true);
    worn.add(asMat(mesh));
    expect(worn.size).toBe(3);
    for (const m of worn) expect(drawn).toContain(m);
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

/** Run warm draws until every body look is warm. */
function warmAll(look: UnifiedLook, onDraw = () => {}) {
  for (let i = 0; i < 10 && look.needsWarm(); i++)
    look.warmBodyLooks(() => {
      onDraw();
      return true;
    });
  expect(look.needsWarm()).toBe(false);
}

/** …with every body look built and warmed for the canvas. */
function wornLook(framed = false): { look: UnifiedLook; mesh: THREE.Mesh } {
  const { root, mesh } = stubModel(framed);
  const look = createUnified(root);
  warmAll(look);
  return { look, mesh };
}

const asMat = (mesh: THREE.Mesh) => mesh.material as THREE.Material;

/** The transparent blend a warmed body mesh wears below uInk = 1, and the
 *  twin it wears at 1. */
function twinPair(framed = false) {
  const { look, mesh } = wornLook(framed);
  look.setInk(0.5);
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
  it("waits for its own warm-up — before that the body wears the transparent blend", () => {
    const { root, mesh } = stubModel();
    const look = createUnified(root);
    look.setInk(0.5);
    const blend = asMat(mesh);
    look.setInk(1);
    expect(asMat(mesh)).toBe(blend);
    look.warmBodyLooks(() => true);
    expect(asMat(mesh)).not.toBe(blend);
  });

  it("swaps AT 1 and nowhere near it", () => {
    const { look, mesh } = wornLook();
    look.setInk(0.5);
    const blend = asMat(mesh);
    for (const k of [0.5, 0.9999999]) {
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
    look.setInk(0.5);
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

// Warm-up is tracked per material key, because new body materials appear
// later (e.g. accessories).
describe("the twin's warm-up covers what it claims to", () => {
  it("keeps a material minted AFTER the warm frame on the blend, and asks for another", () => {
    const { root, mesh } = stubModel();
    const look = createUnified(root);
    warmAll(look);
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
    expect(look.needsWarm()).toBe(true);
    warmAll(look);
    expect(asMat(late)).not.toBe(lateBlend);
    expect(asMat(mesh)).toBe(twin); // the key that was already warm did not move
  });

  it("draws every body mesh in the warm frame, hidden ones included", () => {
    // hidden meshes must be shown for the warm draw (three skips hidden ones)
    const { root, mesh } = stubModel();
    mesh.visible = false;
    const look = createUnified(root);
    const seen: boolean[] = [];
    look.warmBodyLooks(() => {
      seen.push(mesh.visible);
      return true;
    });
    expect(seen).toEqual([true]);
    expect(mesh.visible).toBe(false); // …and put back exactly as it was
  });

  // A draw that didn't reach the scene must not mark anything warm.
  it("refuses a warm whose draw reported nothing drawn", () => {
    const { root, mesh } = stubModel();
    const look = createUnified(root);
    look.warmBodyLooks(() => false);
    expect(look.needsWarm()).toBe(true);
    look.setInk(1);
    const blend = asMat(mesh);
    warmAll(look);
    expect(asMat(mesh)).not.toBe(blend);
  });
});

// At full ink with no fill the body fills draw at exactly zero opacity, so
// their materials are hidden; the meshes stay, since the lines are children.
describe("the empty body fills", () => {
  const emptyFills = () => {
    const { root, mesh } = stubModel();
    const look = createUnified(root);
    look.setInk(1);
    uInkFill.value = 0;
    return { look, mesh };
  };

  it("are hidden only once warm, so they still compile", () => {
    const { look, mesh } = emptyFills();
    look.syncBody();
    expect(asMat(mesh).visible, "cold: drawn").toBe(true);
    warmAll(look);
    look.syncBody();
    expect(asMat(mesh).visible, "warm: skipped").toBe(false);
    expect(mesh.visible).toBe(true);
  });

  it("come back the moment any fill or realism shows", () => {
    const { look, mesh } = emptyFills();
    warmAll(look);
    look.syncBody();
    uInkFill.value = 1e-6;
    look.syncBody();
    expect(asMat(mesh).visible, "a sliver of fill").toBe(true);
    uInkFill.value = 0;
    look.syncBody();
    look.setInk(0.999);
    expect(asMat(mesh).visible, "ink below 1").toBe(true);
  });

  it("are shown for a later warm draw", () => {
    const { look, mesh } = emptyFills();
    warmAll(look);
    look.syncBody();
    const seen: boolean[] = [];
    look.warmBodyLooks(() => {
      seen.push(asMat(mesh).visible);
      return true;
    });
    expect(seen).toEqual([true]);
    expect(asMat(mesh).visible, "hidden again after").toBe(false);
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

// Page-wide uniforms upload once per render, not once per drawn object.
describe("the page-wide uniforms", () => {
  const groupOf = (u: unknown) => (u as { groupNode: unknown }).groupNode;

  const uniformsIn = (graph: unknown) =>
    [...graphOf(graph).nodes].filter(
      (n) => (n as { isUniformNode?: boolean }).isUniformNode,
    );

  it("sit on renderGroup: ink, fades, channels and knobs", () => {
    const deform = uniformsIn(attachOps(new THREE.MeshBasicNodeMaterial()));
    expect(deform.length, "uChannels + uKnobs").toBe(2);
    const fades = [uFadeNear0, uFadeNear1, uFadeFar0, uFadeFar1];
    const ink = uniformsIn(inkLineOpacity()).filter((u) => !fades.includes(u as never)); // prettier-ignore
    expect(ink.length, "uInk").toBe(1);
    const all = [
      ...ink,
      ...fades,
      uInkFill,
      uShellFade,
      uInteriorFade,
      tagOpsSpin(new THREE.Group()),
      ...deform,
    ];
    for (const u of all) expect(groupOf(u)).toBe(renderGroup);
  });
});

// Ink edge lines index the mesh's own vertices: the same segments as three's
// EdgesGeometry, and the mesh's attributes (frames included) by identity.
describe("the ink edge lines", () => {
  const shapes = (): [string, THREE.BufferGeometry][] => [
    ["cylinder (UV seam)", new THREE.CylinderGeometry(3, 2, 4, 24, 3)],
    ["torus knot", new THREE.TorusKnotGeometry(5, 1.5, 64, 12)],
    ["non-indexed box", new THREE.BoxGeometry(2, 3, 4).toNonIndexed()],
  ];
  const expanded = (g: THREE.BufferGeometry) => {
    const pos = g.getAttribute("position");
    const idx = g.getIndex();
    const n = idx ? idx.count : pos.count;
    return Array.from({ length: n }, (_, i) => {
      const v = idx ? idx.getX(i) : i;
      return [pos.getX(v), pos.getY(v), pos.getZ(v)];
    });
  };

  it.each(shapes())(
    "%s: EdgesGeometry's segments, in order, at every angle",
    (_, src) => {
      for (const deg of [1, 24, 40, 89]) {
        const ours = edgeGeometry(new THREE.Mesh(src), deg);
        const three = new THREE.EdgesGeometry(src, deg);
        expect(expanded(ours), `${deg}°`).toEqual(expanded(three));
        three.computeBoundingSphere();
        expect(ours.boundingSphere, `${deg}° bounds`).toEqual(
          three.boundingSphere,
        );
      }
    },
  );

  it("shares the mesh's attributes, and re-cuts when they change", () => {
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(3, 2, 4, 24, 3));
    const g = mesh.geometry;
    const n = g.getAttribute("position").count;
    g.setAttribute("_opA", new THREE.BufferAttribute(new Float32Array(n * 4), 4)); // prettier-ignore
    const line = edgeGeometry(mesh);
    for (const name of ["position", "_opA"])
      expect(line.getAttribute(name), name).toBe(g.getAttribute(name));
    expect(edgeGeometry(mesh), "cached").toBe(line);
    g.setAttribute("_opA", g.getAttribute("_opA").clone());
    const recut = edgeGeometry(mesh);
    expect(recut).not.toBe(line);
    expect(recut.getAttribute("_opA")).toBe(g.getAttribute("_opA"));
  });
});
