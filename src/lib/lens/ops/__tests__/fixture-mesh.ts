import * as THREE from "three/webgpu";

// Synthetic geometry for the tests that run ops/frames.ts.

export const TAU = Math.PI * 2;

/** An indexed triangle strip through `cols`, each column a pair of points
 *  [x0, y0, z0, x1, y1, z1]. */
export function strip(cols: number[][]): THREE.BufferGeometry {
  const idx: number[] = [];
  for (let b = 0; b + 3 < cols.length * 2; b += 2)
    idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(cols.flat()), 3),
  );
  g.setIndex(idx);
  return g;
}

/** A cylinder-sector wedge at `radius`, centred on the `t0` meridian and
 *  `span` wide, spanning [yLo, yHi] axially in `steps` quads. */
export function wedgeGeometry(
  radius: number,
  t0: number,
  span: number,
  yLo: number,
  yHi: number,
  steps = 8,
): THREE.BufferGeometry {
  return strip(
    Array.from({ length: steps + 1 }, (_, i) => {
      const a = t0 - span / 2 + (span * i) / steps;
      const [x, z] = [radius * Math.cos(a), radius * Math.sin(a)];
      return [x, yLo, z, x, yHi, z];
    }),
  );
}

/** A named mesh. */
export function mesh(name: string, geo: THREE.BufferGeometry): THREE.Mesh {
  const m = new THREE.Mesh(geo);
  m.name = name;
  return m;
}

/** A segmented shell: `count` equal wedge meshes `<name>_Seg<i>` under one
 *  group, centred at i·TAU/count. */
export function shell(
  name: string,
  radius: number,
  count: number,
  yLo = -5,
  yHi = 5,
  steps = 8,
): THREE.Object3D {
  const group = new THREE.Object3D();
  group.name = name;
  for (let i = 0; i < count; i++)
    group.add(
      mesh(
        `${name}_Seg${i}`,
        wedgeGeometry(radius, (TAU * i) / count, TAU / count, yLo, yHi, steps),
      ),
    );
  return group;
}

/** A group named `name` holding `children`. */
export function group(
  name: string,
  ...children: THREE.Object3D[]
): THREE.Object3D {
  const g = new THREE.Object3D();
  g.name = name;
  if (children.length) g.add(...children);
  return g;
}
