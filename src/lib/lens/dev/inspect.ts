import * as THREE from "three/webgpu";
import { vec4 } from "three/tsl";
import { displaceInto, opsStateKey } from "./ops-cpu";
import { isGraphGroup } from "../core/parts";

// Dev only, dynamically imported. The /lens "Inspect" toggle: hover a piece to
// see its GLB node name, click to copy it. The deform runs in the shader, so
// raycasts hit CPU-deformed proxy copies of each mesh (ops-cpu.ts) instead.

/** Tooltip classes, using the site's theme tokens. */
const TIP_CLASS =
  "border-border bg-surface/90 text-text pointer-events-none absolute z-30 hidden rounded-md border px-2 py-1 text-[0.6875rem] leading-snug backdrop-blur";

/** Pointer travel (CSS px) above which a release is an orbit drag, not a click. */
const DRAG_PX = 5;
/** Tooltip offset from the cursor. */
const CURSOR_GAP = 14;
const COPIED_MS = 1200;
/** How long the op state must hold still before the proxies are re-evaluated. */
const SETTLE_MS = 200;

/** The site's `--highlight` terracotta. */
const HIGHLIGHT_HEX = 0xd18a5d;
const HIGHLIGHT_OPACITY = 0.35;

export interface InspectContext {
  /** Loaded GLB root. */
  model: THREE.Object3D;
  camera: THREE.Camera;
  /** Pointer target; the tooltip goes in its parent. */
  canvas: HTMLCanvasElement;
  /** Parent for the highlight (not the model, which other passes traverse). */
  scene: THREE.Object3D;
  /** Request a repaint. */
  invalidate: () => void;
}

export interface Inspector {
  setEnabled(on: boolean): void;
  dispose(): void;
}

/** `[hit name, part name]`: the nearest named node at or above the hit, and
 *  its topmost named ancestor below the root. `Grp_*` empties are skipped. */
function namesOf(obj: THREE.Object3D, root: THREE.Object3D): [string, string] {
  const chain: string[] = [];
  for (let o: THREE.Object3D | null = obj; o && o !== root; o = o.parent)
    if (o.name && !isGraphGroup(o.name)) chain.push(o.name);
  if (chain.length === 0) return [root.name || "(unnamed)", ""];
  return [chain[0], chain[chain.length - 1]];
}

/** True if the object and all its ancestors are visible. */
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
  // DoubleSide so a piece can be picked from its inner face too.
  const proxyMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  let proxies: PickProxy[] = [];
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
  let listening: AbortController | null = null;

  // The hover highlight: one reused mesh drawing the hovered proxy's geometry
  // at its source mesh's matrixWorld.
  const highlightMat = new THREE.MeshBasicNodeMaterial({
    transparent: true,
    side: THREE.DoubleSide,
    // Drawn on top of the real surface: offset toward the camera, no depth write.
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    toneMapped: false,
  });
  // A constant fragment: `color`/`opacity` would need a `normal` attribute the
  // proxies don't have.
  {
    const c = new THREE.Color(HIGHLIGHT_HEX);
    highlightMat.fragmentNode = vec4(c.r, c.g, c.b, HIGHLIGHT_OPACITY);
  }
  /** Placeholder so the highlight never holds a disposed proxy geometry. */
  const emptyGeo = new THREE.BufferGeometry();
  const highlight = new THREE.Mesh(emptyGeo, highlightMat);
  highlight.frustumCulled = false;
  // matrixWorld is copied by hand from the source mesh.
  highlight.matrixAutoUpdate = false;
  highlight.matrixWorldAutoUpdate = false;
  let highlighted: PickProxy | null = null;

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
    highlight.geometry = emptyGeo;
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

  /** One proxy per mesh: same index and draw range, CPU-deformed positions.
   *  Hidden meshes are included and filtered at hit time. */
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
      // Cloned so disposing the proxy leaves the real index buffer alone.
      if (src.index) geo.setIndex(src.index.clone());
      geo.drawRange = { ...src.drawRange };
      proxies.push({ src: o, proxy: new THREE.Mesh(geo, proxyMat), positions });
    });
    refreshProxies();
  };

  const refreshProxies = () => {
    for (const p of proxies) {
      displaceInto(p.src.geometry, p.positions, p.src);
      // Raycasts pre-cull on the bounding sphere, so it must follow the deform.
      p.proxy.geometry.computeBoundingSphere();
      p.proxy.geometry.attributes.position.needsUpdate = true;
    }
    if (highlighted) ctx.invalidate();
  };

  const disposeProxies = () => {
    clearHighlight(); // it may be drawing one of these geometries
    for (const p of proxies) p.proxy.geometry.dispose();
    proxies = [];
  };

  /** Re-deform the proxies once the op state has held still for SETTLE_MS.
   *  Runs on pointer move only. */
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
    for (const p of proxies) p.proxy.matrixWorld.copy(p.src.matrixWorld);
    const pick = raycaster
      .intersectObjects(
        proxies.map((p) => p.proxy),
        false,
      )
      .map((h) => proxies.find((p) => p.proxy === h.object)!)
      .find((p) => shown(p.src));
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
    // Ignore the release at the end of an orbit drag.
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
    if (on === Boolean(listening)) return;
    if (on) {
      // Rebuilt on each enable, since accessories load in after boot.
      builtKey = opsStateKey();
      seenKey = builtKey;
      buildProxies();
      savedCursor = canvas.style.cursor;
      canvas.style.cursor = "crosshair";
      listening = new AbortController();
      const opts = { signal: listening.signal };
      canvas.addEventListener("pointermove", onMove, opts);
      canvas.addEventListener("pointerdown", onDown, opts);
      canvas.addEventListener("pointerup", onUp, opts);
      canvas.addEventListener("pointerleave", onLeave, opts);
    } else {
      listening?.abort();
      listening = null;
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
      setEnabled(false);
      clearTimeout(copyTimer);
      proxyMat.dispose();
      highlightMat.dispose();
      emptyGeo.dispose();
      tip.remove();
    },
  };
}
