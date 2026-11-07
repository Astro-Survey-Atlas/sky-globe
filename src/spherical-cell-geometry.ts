import * as THREE from "three";
import { Healpix, Pointing, Vec3 } from "healpixjs";

export interface SphericalCellGeometryInput {
  nside: number;
  pixel: number;
  innerRadius: number;
  outerRadius: number;
  color: THREE.Color;
  inset?: number;
}

export interface SphericalCellSheetGeometryInput {
  nside: number;
  pixel: number;
  radius: number;
  color: THREE.Color;
  inset?: number;
}

export interface SphericalCellSourceSectorGeometryInput {
  nside: number;
  pixel: number;
  radius: number;
  colors: readonly THREE.Color[];
  inset?: number;
}

export const TRIANGLES_PER_SPHERICAL_CELL = 12;
export const TRIANGLES_PER_SPHERICAL_CELL_SHEET = 2;

const healpixCache = new Map<number, Healpix>();

function healpix(nside: number): Healpix {
  let instance = healpixCache.get(nside);
  if (!instance) {
    instance = new Healpix(nside);
    healpixCache.set(nside, instance);
  }
  return instance;
}

function sceneVector(vector: { x: number; y: number; z: number }, radius: number): THREE.Vector3 {
  return new THREE.Vector3(-vector.y * radius, vector.z * radius, -vector.x * radius);
}

/** Inverse of the shared HEALPix -> Three.js celestial frame used by sceneVector. */
export function sceneDirectionToHealpixVector(direction: { x: number; y: number; z: number }): Vec3 {
  const length = Math.hypot(direction.x, direction.y, direction.z);
  if (length === 0) return new Vec3(1, 0, 0);
  return new Vec3(-direction.z / length, -direction.x / length, direction.y / length);
}

/** Map a Three.js celestial direction to the nested HEALPix pixel at the given NSIDE. */
export function healpixPixelFromSceneDirection(nside: number, direction: { x: number; y: number; z: number }): number {
  return healpix(nside).ang2pix(new Pointing(sceneDirectionToHealpixVector(direction)));
}

export function sphericalCellBoundary(nside: number, pixel: number, radius: number): THREE.Vector3[] {
  return healpix(nside).getBoundaries(pixel).map((vector) => sceneVector(vector, radius));
}

export function sphericalCellCenter(nside: number, pixel: number, radius: number): THREE.Vector3 {
  return sceneVector(healpix(nside).pix2vec(pixel), radius);
}

function insetBoundary(boundary: THREE.Vector3[], radius: number, inset: number): THREE.Vector3[] {
  if (inset <= 0) return boundary;
  const center = boundary.reduce((sum, point) => sum.add(point), new THREE.Vector3()).normalize();
  return boundary.map((point) => point.clone().normalize().lerp(center, inset).normalize().multiplyScalar(radius));
}

function arcPoint(start: THREE.Vector3, end: THREE.Vector3, fraction: number, radius: number): THREE.Vector3 {
  const left = start.clone().normalize();
  const right = end.clone().normalize();
  const angle = left.angleTo(right);
  if (angle < 1e-7) return left.multiplyScalar(radius);
  const sinAngle = Math.sin(angle);
  return left.multiplyScalar(Math.sin((1 - fraction) * angle) / sinAngle)
    .addScaledVector(right, Math.sin(fraction * angle) / sinAngle)
    .normalize()
    .multiplyScalar(radius);
}

function perimeterPoint(boundary: readonly THREE.Vector3[], fraction: number, radius: number): THREE.Vector3 {
  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < boundary.length; index += 1) {
    const length = boundary[index]!.angleTo(boundary[(index + 1) % boundary.length]!);
    lengths.push(length);
    total += length;
  }
  if (!total) return boundary[0]!.clone().normalize().multiplyScalar(radius);
  let distance = ((fraction % 1) + 1) % 1 * total;
  for (let index = 0; index < lengths.length; index += 1) {
    const length = lengths[index]!;
    if (distance <= length || index === lengths.length - 1) {
      return arcPoint(boundary[index]!, boundary[(index + 1) % boundary.length]!, length ? distance / length : 0, radius);
    }
    distance -= length;
  }
  return boundary[0]!.clone().normalize().multiplyScalar(radius);
}

function perimeterVertexFractions(boundary: readonly THREE.Vector3[]): number[] {
  const lengths = boundary.map((point, index) => point.angleTo(boundary[(index + 1) % boundary.length]!));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  if (!total) return boundary.map((_, index) => index / boundary.length);
  let cumulative = 0;
  return boundary.map((_, index) => {
    if (index > 0) cumulative += lengths[index - 1]!;
    return cumulative / total;
  });
}

/** Build equal perimeter sectors for multiple sources sharing one HEALPix cell. */
export function buildSphericalCellSourceSectorGeometry(cells: readonly SphericalCellSourceSectorGeometryInput[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  // Fan from the centre: the rim distance is the radial fraction.
  const cellUvs: number[] = [];
  cells.forEach((cell) => {
    if (!cell.colors.length) return;
    const boundary = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, cell.radius), cell.radius, cell.inset ?? 0);
    if (boundary.length !== 4) throw new Error("HEALPix cell boundary is not quadrilateral");
    const center = boundary.reduce((sum, point) => sum.add(point), new THREE.Vector3()).normalize().multiplyScalar(cell.radius);
    if (cell.colors.length === 1) {
      boundary.forEach((start, index) => {
        const end = boundary[(index + 1) % boundary.length]!;
        [center, start, end].forEach((vertex, vertexIndex) => {
          positions.push(vertex.x, vertex.y, vertex.z);
          colors.push(cell.colors[0]!.r, cell.colors[0]!.g, cell.colors[0]!.b);
          cellUvs.push(vertexIndex === 0 ? 0.5 : 1, 0.5);
        });
      });
      return;
    }
    const vertexFractions = perimeterVertexFractions(boundary);
    cell.colors.forEach((color, index) => {
      const startFraction = index / cell.colors.length;
      const endFraction = (index + 1) / cell.colors.length;
      const perimeter = [
        perimeterPoint(boundary, startFraction, cell.radius),
        ...vertexFractions
          .filter((fraction) => fraction > startFraction && fraction < endFraction)
          .map((fraction) => perimeterPoint(boundary, fraction, cell.radius)),
        perimeterPoint(boundary, endFraction, cell.radius),
      ];
      for (let pointIndex = 0; pointIndex < perimeter.length - 1; pointIndex += 1) {
        [center, perimeter[pointIndex]!, perimeter[pointIndex + 1]!].forEach((vertex, vertexIndex) => {
          positions.push(vertex.x, vertex.y, vertex.z);
          colors.push(color.r, color.g, color.b);
          cellUvs.push(vertexIndex === 0 ? 0.5 : 1, 0.5);
        });
      }
    });
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("cellUv", new THREE.Float32BufferAttribute(cellUvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

export function buildSphericalCellGeometry(cells: readonly SphericalCellGeometryInput[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const triangles = [
    [4, 5, 6], [4, 6, 7],
    [0, 2, 1], [0, 3, 2],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
  ] as const;
  cells.forEach((cell) => {
    const inner = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, cell.innerRadius), cell.innerRadius, cell.inset ?? 0);
    const outer = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, cell.outerRadius), cell.outerRadius, cell.inset ?? 0);
    const vertices = [...inner, ...outer];
    if (vertices.length !== 8) throw new Error("HEALPix cell boundary is not quadrilateral");
    triangles.forEach((triangle) => {
      triangle.forEach((vertexIndex) => {
        const vertex = vertices[vertexIndex]!;
        positions.push(vertex.x, vertex.y, vertex.z);
        colors.push(cell.color.r, cell.color.g, cell.color.b);
      });
    });
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

const SHEET_CORNER_UVS = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;

export function buildSphericalCellSheetGeometry(cells: readonly SphericalCellSheetGeometryInput[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  // Unit-square coordinates per cell let materials draw a bright rim.
  const cellUvs: number[] = [];
  const triangles = [[0, 1, 2], [0, 2, 3]] as const;
  cells.forEach((cell) => {
    const vertices = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, cell.radius), cell.radius, cell.inset ?? 0);
    if (vertices.length !== 4) throw new Error("HEALPix cell boundary is not quadrilateral");
    triangles.forEach((triangle) => {
      triangle.forEach((vertexIndex) => {
        const vertex = vertices[vertexIndex]!;
        positions.push(vertex.x, vertex.y, vertex.z);
        colors.push(cell.color.r, cell.color.g, cell.color.b);
        cellUvs.push(...SHEET_CORNER_UVS[vertexIndex]!);
      });
    });
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.setAttribute("cellUv", new THREE.Float32BufferAttribute(cellUvs, 2));
  geometry.computeBoundingSphere();
  return geometry;
}

export function buildSphericalCellEdges(cells: readonly (SphericalCellGeometryInput | SphericalCellSheetGeometryInput)[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  cells.forEach((cell) => {
    const radius = ("radius" in cell ? cell.radius : cell.outerRadius) + 0.0015;
    const boundary = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, radius), radius, cell.inset ?? 0);
    for (let index = 0; index < boundary.length; index += 1) {
      const start = boundary[index]!;
      const end = boundary[(index + 1) % boundary.length]!;
      positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
      colors.push(cell.color.r, cell.color.g, cell.color.b, cell.color.r, cell.color.g, cell.color.b);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** Build the visible outer boundary of a spherical HEALPix cell volume. */
export function buildSphericalCellVolumeEdges(cells: readonly SphericalCellGeometryInput[]): THREE.BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  cells.forEach((cell) => {
    const innerRadius = Math.max(0.001, cell.innerRadius) + 0.0015;
    const outerRadius = cell.outerRadius + 0.0015;
    const inner = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, innerRadius), innerRadius, cell.inset ?? 0);
    const outer = insetBoundary(sphericalCellBoundary(cell.nside, cell.pixel, outerRadius), outerRadius, cell.inset ?? 0);
    if (inner.length !== 4 || outer.length !== 4) throw new Error("HEALPix cell boundary is not quadrilateral");
    const addSegment = (start: THREE.Vector3, end: THREE.Vector3): void => {
      positions.push(start.x, start.y, start.z, end.x, end.y, end.z);
      colors.push(cell.color.r, cell.color.g, cell.color.b, cell.color.r, cell.color.g, cell.color.b);
    };
    for (let index = 0; index < 4; index += 1) {
      addSegment(outer[index]!, outer[(index + 1) % 4]!);
      addSegment(inner[index]!, outer[index]!);
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}
