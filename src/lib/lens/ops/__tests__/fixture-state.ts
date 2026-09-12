import { NUM } from "../algebra";
import {
  radiusOf,
  thetaOf,
  type PieceFrame,
  type VertexState,
} from "../ops";

// The op state carries the radial-plane point in CARTESIAN; the laws in this
// folder are about a BARREL, so they stay stated in (theta, radius) and convert
// here. `polarOf` reads the angle back through atan2, so it lands in (−π, π] —
// an expectation built by adding to a seated angle must be folded the same way.

/** The radial-plane point at (theta, radius). */
export const atPolar = (
  theta: number,
  radius: number,
): { x: number; z: number } => ({
  x: radius * Math.cos(theta),
  z: radius * Math.sin(theta),
});

/** A state's point back in barrel terms. */
export const polarOf = (
  p: VertexState<number> | PieceFrame<number>,
): { theta: number; radius: number } => ({
  theta: thetaOf(NUM, p),
  radius: radiusOf(NUM, p),
});

/** A vertex state seated at (theta, radius, axial), with the rest defaulted. */
export const vertexAt = (
  theta: number,
  radius: number,
  rest: Omit<VertexState<number>, "x" | "z">,
): VertexState<number> => ({ ...atPolar(theta, radius), ...rest });

/** A piece frame placed at (theta, radius, axial). */
export const frameAt = (
  theta: number,
  radius: number,
  rest: Omit<PieceFrame<number>, "x" | "z">,
): PieceFrame<number> => ({ ...atPolar(theta, radius), ...rest });
