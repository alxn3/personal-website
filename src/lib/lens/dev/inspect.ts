import * as THREE from "three/webgpu";
import { vec4 } from "three/tsl";
import { displaceInto, opsStateKey } from "./ops-cpu";
import { isGraphGroup } from "../core/parts";

// ============================================================================
// PIECE INSPECTOR — the /lens "Inspect" toggle. Hover a piece to read the GLB
// node name under the pointer, click to copy it. Object names are the API with
// the lens_work/ Blender pipeline, so being able to point at a piece and read
// its name is how a change request gets phrased in the names the code uses.
//
// Read-only where the MODEL is concerned: no channels, no uniforms, no material
// touched — a CPU raycast, one DOM tooltip, and one overlay mesh washed over the
// hovered piece. Listeners exist ONLY while the toggle is on.
//
// WHAT IT RAYCASTS: not the model. The shell deform runs IN-SHADER, so every
// mesh's CPU geometry stays SEATED and picking an exploded lens off it would
// name whatever happens to sit at the piece's parking spot. Instead each mesh
// gets a PICKING PROXY — same indices, same triangle order, but positions
// re-evaluated on the CPU (dev/ops-cpu.ts) at the live channel/knob values. The
// proxy is left in MESH-LOCAL space and driven by the source's own matrixWorld,
// so the mechanism's real object motion (ring throws, zoom slides, the screw
// pivot) is applied exactly once, by the matrix chain, not twice.
//
// Rebuilds are lazy — see `maybeRebuild`.
//
// THE HOVER HIGHLIGHT reuses exactly that pair: the hovered piece's proxy
// geometry, drawn through the source's matrixWorld. It is a separate overlay
// mesh on purpose — the shading caches SHARE one material across dozens of
// meshes per look, so tinting (or swapping) the hovered mesh's material would
// tint every mesh that look assigned it and fight the look system's ownership.
// ============================================================================

/** Tooltip chrome, in the same tokens the floating controls card uses, so it
 *  reads correctly in both themes without a colour of its own. */
const TIP_CLASS =
  "border-border bg-surface/90 text-text pointer-events-none absolute z-30 hidden rounded-md border px-2 py-1 text-[0.6875rem] leading-snug backdrop-blur";

/** Pointer travel (CSS px) above which a release is an orbit drag, not a click. */
const DRAG_PX = 5;
/** Tooltip offset from the cursor. */
const CURSOR_GAP = 14;
const COPIED_MS = 1200;
/** How long the op state must hold still before the proxies are re-evaluated.
 *  Channels GLIDE toward their target, so a slider drag leaves the state moving
 *  for a while after the pointer stops; rebuilding per frame would burn ~100ms
 *  of main thread each time. Hovering against slightly stale proxies mid-glide
 *  is fine — a name lookup during a move does not need to be frame-accurate. */
const SETTLE_MS = 200;

/** The site's `--highlight` terracotta (global.css: #d18a5d light / #d99a63
 *  dark). ONE value for both themes — the terracotta reads on the cream and on
 *  the dark backdrop alike, and CSS custom properties are not visible to the
 *  scene without plumbing a reader in for a dev tool that doesn't need one. */
const HIGHLIGHT_HEX = 0xd18a5d;
const HIGHLIGHT_OPACITY = 0.35;

export interface InspectContext {
  /** Loaded GLB root: candidate meshes live under it and the ancestor walk
   *  stops at it. */
  model: THREE.Object3D;
  camera: THREE.Camera;
  /** Pointer target, and (through its offset parent) the tooltip's frame. */
  canvas: HTMLCanvasElement;
  /** Where the hover-highlight overlay is parented while shown. Deliberately
   *  the SCENE, not the model: every pass that traverses the GLB (shading
   *  swaps, disposal, this file's own proxy build) would otherwise pick the
   *  overlay up as if it were a piece of the lens. */
  scene: THREE.Object3D;
  /** The scene renders on demand, so a highlight appearing/moving/clearing
   *  needs a repaint requested explicitly. */
  invalidate: () => void;
}

export interface Inspector {
  setEnabled(on: boolean): void;
  dispose(): void;
}

/** `[hit name, part name]` for a picked node: the nearest named node at or above
 *  the hit, and the TOPMOST named ancestor below the model root. Topmost is the
 *  same grouping `ops/frames.ts` `groupOf` derives the explode ladder from, so
 *  the second name is the sub-assembly a request would talk about
 *  (`Mount_BrassRing_Seg2` → `Mount_BrassRing`; a generic `Cylinder012` under
 *  `Focus_LeadScrew` reports both). Empty part name when the hit IS the root.
 *
 *  The `Grp_*` graph empties are skipped for the SAME reason `groupOf` skips
 *  them (core/parts isGraphGroup): they own no rung and name no sub-assembly, so
 *  reporting `Focus_Motor` as part of "Grp_FocusDrive" would name a node the
 *  ladder does not have. */
function namesOf(obj: THREE.Object3D, root: THREE.Object3D): [string, string] {
  const chain: string[] = [];
  for (let o: THREE.Object3D | null = obj; o && o !== root; o = o.parent)
    if (o.name && !isGraphGroup(o.name)) chain.push(o.name);
  if (chain.length === 0) return [root.name || "(unnamed)", ""];
  return [chain[0], chain[chain.length - 1]];
}

/** Visible all the way up — the isolate/occluder logic hides whole branches by
 *  flipping a PARENT's flag, which a per-mesh `.visible` test would miss. */
function shown(obj: THREE.Object3D): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent)
    if (!o.visible) return false;
  return true;
}

/** One pickable mesh and the stand-in the raycaster actually sees. */
interface PickProxy {
  src: THREE.Mesh;
  proxy: THREE.Mesh;
  positions: Float32Array;
}

export function createInspector(ctx: InspectContext): Inspector {
  const { canvas, model } = ctx;
  const tip = document.createElement("div");
  tip.className = TIP_CLASS;
  const nameEl = document.createElement("div");
  const partEl = document.createElement("div");
  partEl.className = "text-text-muted";
  tip.append(nameEl, partEl);
  (canvas.parentElement ?? document.body).appendChild(tip);

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  // DoubleSide so an exploded piece can be picked from its inner face too. The
  // proxies are never added to a scene, but Mesh.raycast reads `material.side`.
  const proxyMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  let proxies: PickProxy[] = [];
  let proxyMeshes: THREE.Mesh[] = [];
  /** proxy mesh → its entry, so a hit yields both the name source and the
   *  geometry the highlight borrows. */
  const pickOf = new Map<THREE.Object3D, PickProxy>();
  let builtKey = ""; // op state the proxies were evaluated at
  let seenKey = ""; // op state last observed
  let seenAt = 0;
  let pending: PointerEvent | null = null;
  let raf = 0;
  let hitName = "";
  let partText = "";
  let downAt: { x: number; y: number } | null = null;
  let copyTimer = 0;
  let savedCursor = "";
  let enabled = false;

  // --- hover highlight -------------------------------------------------------
  // ONE mesh, reused across hovers: its geometry is BORROWED from the hovered
  // piece's proxy (already the CPU-displaced surface) and its matrixWorld copied
  // from the source mesh — the very pair the raycast used, so the wash lands
  // exactly where the hit was computed.
  const highlightMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    // DoubleSide for the same reason the proxies use it: a piece looked into
    // from the inside presents only back faces.
    side: THREE.DoubleSide,
    // The wash is COINCIDENT with the drawn surface, so: depthTest stays ON (a
    // piece behind another must not shine through) and equal depths must pass,
    // which three's default LessEqualDepth already does; the polygon offset
    // pulls the overlay a hair toward the camera to absorb the last-bit
    // disagreement between the CPU mirror's positions and the shader's, which
    // would otherwise speckle. depthWrite OFF so the overlay never occludes
    // anything drawn after it — and, with the real surface's depth already in
    // the buffer, the far side of a closed shell fails the test and only the
    // near face tints, instead of double-blending.
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    toneMapped: false, // a dev marker should be the token colour, not graded
  });
  // A CONSTANT fragment, not `color`/`opacity`: those go through the lit path,
  // which — the scene having an `environment` — folds in a BasicEnvironmentNode
  // and so demands a `normal` attribute the picking proxies deliberately don't
  // carry (positions only, half the memory, nothing to recompute per rebuild).
  // `fragmentNode` short-circuits lighting entirely, which is also what a flat
  // marker wants: no env sheen riding on the terracotta. THREE.Color does the
  // sRGB→working-space conversion the `color` parameter would have done.
  {
    const c = new THREE.Color(HIGHLIGHT_HEX);
    highlightMat.fragmentNode = vec4(c.r, c.g, c.b, HIGHLIGHT_OPACITY);
  }
  /** Owned placeholder. The highlight only ever BORROWS proxy geometry, so it
   *  must not be holding one when `disposeProxies` frees them. */
  const emptyGeo = new THREE.BufferGeometry();
  const highlight = new THREE.Mesh(emptyGeo, highlightMat);
  highlight.frustumCulled = false;
  // matrixWorld is written by hand from the source mesh; leaving the auto-update
  // on would have the scene root overwrite it back to identity every frame.
  highlight.matrixAutoUpdate = false;
  highlight.matrixWorldAutoUpdate = false;
  let highlighted: PickProxy | null = null;

  /** Wash the hovered piece. Both inputs are as fresh as the pick that produced
   *  them: the geometry is only re-evaluated once the op state SETTLES, and the
   *  matrix is sampled on pointer events — so a hover held still while an
   *  animation runs shows a slightly stale outline. Hovering mid-glide is
   *  already approximate (see SETTLE_MS); a name lookup during a move does not
   *  need to be frame-accurate. */
  const showHighlight = (p: PickProxy) => {
    highlight.geometry = p.proxy.geometry;
    highlight.matrixWorld.copy(p.src.matrixWorld);
    if (!highlight.parent) ctx.scene.add(highlight);
    highlighted = p;
    ctx.invalidate();
  };
  const clearHighlight = () => {
    if (!highlighted) return;
    highlighted = null;
    highlight.removeFromParent();
    highlight.geometry = emptyGeo; // must not outlive the borrowed proxy
    ctx.invalidate();
  };

  const setPart = (text: string) => {
    partEl.textContent = text;
    partEl.classList.toggle("hidden", text === "");
  };
  const hide = () => {
    tip.classList.add("hidden");
    hitName = "";
    clearHighlight();
  };

  /** One proxy per mesh under the model root, keeping the source's index and
   *  draw range so triangle order — and therefore which mesh a hit belongs to —
   *  is unchanged; only the positions differ. Hidden meshes are included:
   *  visibility is filtered at hit time, so an isolate flip needs no rebuild. */
  const buildProxies = () => {
    disposeProxies();
    model.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      const src = o.geometry;
      const seated = src.getAttribute("position");
      if (!seated) return;
      const positions = new Float32Array(seated.count * 3);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      // CLONED, not shared: disposing a proxy geometry would otherwise take the
      // real mesh's index buffer down with it.
      if (src.index) geo.setIndex(src.index.clone());
      geo.drawRange = { ...src.drawRange };
      const proxy = new THREE.Mesh(geo, proxyMat);
      const entry: PickProxy = { src: o, proxy, positions };
      proxies.push(entry);
      pickOf.set(proxy, entry);
    });
    proxyMeshes = proxies.map((p) => p.proxy);
    refreshProxies();
  };

  const refreshProxies = () => {
    for (const p of proxies) {
      displaceInto(p.src.geometry, p.positions, p.src);
      // Mesh.raycast pre-culls on the bounding sphere: a seated one left in
      // place would cull away every piece the explode threw outward.
      p.proxy.geometry.computeBoundingSphere();
      // The highlight DRAWS one of these, so a rewritten position array has to
      // be re-uploaded — the raycast alone never needed it.
      p.proxy.geometry.attributes.position.needsUpdate = true;
    }
    if (highlighted) ctx.invalidate();
  };

  const disposeProxies = () => {
    clearHighlight(); // it borrows one of these geometries — drop it first
    for (const p of proxies) p.proxy.geometry.dispose();
    proxies = [];
    proxyMeshes = [];
    pickOf.clear();
  };

  /** Re-evaluate the proxies once the op state has held still for SETTLE_MS.
   *  Called from the pointer rAF, so a slider dragged with the pointer parked
   *  off-canvas rebuilds on the next hover instead of eagerly. */
  const maybeRebuild = () => {
    const key = opsStateKey();
    if (key === builtKey) return;
    const now = performance.now();
    if (key !== seenKey) {
      seenKey = key;
      seenAt = now;
      return; // still moving
    }
    if (now - seenAt < SETTLE_MS) return;
    refreshProxies();
    builtKey = key;
  };

  const process = () => {
    raf = 0;
    const ev = pending;
    pending = null;
    if (!ev) return;
    const rect = canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    ndc.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, ctx.camera);
    maybeRebuild();
    // The proxies hold LOCAL displaced positions; the source's world matrix (kept
    // live by the render loop) carries the object-level motion on top.
    for (const p of proxies) p.proxy.matrixWorld.copy(p.src.matrixWorld);
    const pick = raycaster
      .intersectObjects(proxyMeshes, false)
      .map((h) => pickOf.get(h.object))
      .find((p): p is PickProxy => p !== undefined && shown(p.src));
    if (!pick) return hide();
    showHighlight(pick);

    const [name, part] = namesOf(pick.src, model);
    hitName = name;
    nameEl.textContent = name;
    partText = part && part !== name ? part : "";
    setPart(partText);
    tip.classList.remove("hidden");
    const left =
      x + CURSOR_GAP + tip.offsetWidth > canvas.clientWidth
        ? x - CURSOR_GAP - tip.offsetWidth
        : x + CURSOR_GAP;
    tip.style.left = `${left}px`;
    tip.style.top = `${y + CURSOR_GAP}px`;
  };

  const onMove = (e: PointerEvent) => {
    pending = e;
    if (!raf) raf = requestAnimationFrame(process);
  };
  const onDown = (e: PointerEvent) => {
    downAt = { x: e.clientX, y: e.clientY };
  };
  const onUp = (e: PointerEvent) => {
    const down = downAt;
    downAt = null;
    if (!down || !hitName) return;
    // An orbit drag ends over the model too — only a near-stationary release
    // counts as a click on the piece.
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) return;
    const done = (text: string) => {
      setPart(text);
      clearTimeout(copyTimer);
      copyTimer = window.setTimeout(() => setPart(partText), COPIED_MS);
    };
    navigator.clipboard
      ?.writeText(hitName)
      .then(() => done("copied"))
      .catch(() => done("clipboard blocked"));
  };
  const onLeave = () => {
    pending = null;
    hide();
  };

  const setEnabled = (on: boolean) => {
    if (on === enabled) return;
    enabled = on;
    if (on) {
      // Rebuilt per enable: the accessories merge into the model AFTER boot, so
      // a proxy set captured once at construction could miss them.
      builtKey = opsStateKey();
      seenKey = builtKey;
      buildProxies();
      savedCursor = canvas.style.cursor;
      canvas.style.cursor = "crosshair";
      canvas.addEventListener("pointermove", onMove);
      canvas.addEventListener("pointerdown", onDown);
      canvas.addEventListener("pointerup", onUp);
      canvas.addEventListener("pointerleave", onLeave);
    } else {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      canvas.style.cursor = savedCursor;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      disposeProxies();
      onLeave();
    }
  };

  return {
    setEnabled,
    dispose() {
      setEnabled(false); // detaches + clears the highlight, frees the proxies
      clearTimeout(copyTimer);
      proxyMat.dispose();
      highlightMat.dispose();
      emptyGeo.dispose();
      tip.remove();
    },
  };
}
