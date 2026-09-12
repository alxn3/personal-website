import * as THREE from "three/webgpu";

// Dev only — dynamically imported. `?diag`: a phone-readable status card
// printing the numbers that decide whether the dive's render path can run.
// core/scene.ts owns the state object; this module only paints.

/** The fields the scene keeps live; everything else is read off the renderer. */
export interface LensDiag {
  /** the screen-space wormhole's render path:
   *  `unmounted` | `mounted` | `FAILED: <message>` */
  post: string;
}

export function mountLensDiag(
  renderer: THREE.WebGPURenderer,
  state: LensDiag,
): void {
  const backend = (
    renderer as unknown as { backend?: { isWebGLBackend?: true } }
  ).backend?.isWebGLBackend
    ? "webgl2"
    : "webgpu";
  const el = document.createElement("div");
  el.style.cssText =
    "position:fixed;left:0;top:0;z-index:99999;max-width:100vw;padding:6px 8px;" +
    "font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;" +
    "color:#7CFC9B;background:rgba(0,0,0,.82);pointer-events:none";
  const draw = () => {
    el.textContent =
      `backend: ${backend}\n` +
      `post: ${state.post}\n` +
      `three: r${THREE.REVISION}`;
  };
  draw();
  setInterval(draw, 1000);
  document.body.appendChild(el);
}
