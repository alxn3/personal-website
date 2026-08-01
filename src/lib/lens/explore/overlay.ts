import * as THREE from "three/webgpu";

// Shared plumbing for the /lens screen-space overlay modules (prism-light,
// ray-ribbons): an own Scene + OrthographicCamera whose frustum IS the
// viewport (NDC space), rendered as a second pass over the finished main
// frame via SceneHandle.setOverlayPass. Points projected with the main
// camera drop straight in as overlay coordinates.

export interface NdcOverlay {
  scene: THREE.Scene;
  /** Second pass over the finished main frame: keeps the color buffer. */
  render(renderer: THREE.WebGPURenderer): void;
}

export function createNdcOverlay(): NdcOverlay {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
  return {
    scene,
    render(renderer) {
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = false;
      renderer.render(scene, camera);
      renderer.autoClear = prevAutoClear;
    },
  };
}

/** Flat print-color overlay material: solid, tone-map-free (authored hexes
 *  stay true), never depth-clipped — pure screen-space graphics. */
export function overlayMaterial(
  color: THREE.ColorRepresentation = 0xffffff,
): THREE.MeshBasicMaterial {
  const m = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    side: THREE.DoubleSide,
  });
  m.toneMapped = false;
  return m;
}

/** Overlay mesh whose geometry/transform is rewritten per frame — culling off. */
export function overlaySheet(
  geo: THREE.BufferGeometry,
  mat: THREE.MeshBasicMaterial,
): THREE.Mesh {
  const mesh = new THREE.Mesh(geo, mat);
  mesh.frustumCulled = false;
  return mesh;
}
