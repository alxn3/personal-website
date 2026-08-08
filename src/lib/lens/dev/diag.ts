import * as THREE from "three/webgpu";
import { traceChannelsFor } from "../optics/warp";

// ============================================================================
// `?diag` — the phone-readable status card (DEV only, the `?webgl` / `?story`
// param mould). A device that shows the lens but no stars cannot be attached to
// a console, so the four numbers that decide whether the background warp can
// run are printed on the glass instead and read aloud.
//
// core/scene.ts owns the state object and writes `warp` from enableLensWarp;
// this module only paints. It is imported dynamically so optics/warp.ts (the
// TSL graph) stays out of the eager bundle, exactly as the warp's own lazy
// import intends.
// ============================================================================

/** The fields the scene keeps live; everything else is read off the renderer. */
export interface LensDiag {
  /** `unmounted` | `mounted` | `FAILED: <message>` */
  warp: string;
  /** the screen-space wormhole's render path, same three states */
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
      `warp: ${state.warp}\n` +
      `post: ${state.post}\n` +
      `channels: ${traceChannelsFor(renderer)}\n` +
      `three: r${THREE.REVISION}`;
  };
  draw();
  setInterval(draw, 1000);
  document.body.appendChild(el);
}
