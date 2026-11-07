import * as THREE from "three";
import type { LineSegments2 } from "three/addons/lines/LineSegments2.js";

import {
  buildSphericalCellSheetGeometry,
  type SphericalCellSheetGeometryInput,
} from "./spherical-cell-geometry.js";
import { fatLines, regionOutlinePositions } from "./hud-scene.js";

export interface OverlapHighlightStyle {
  /** Outline colour of the region boundary. */
  color: THREE.ColorRepresentation;
  /** Outline width in CSS pixels. */
  width: number;
  /** Optional wide additive halo under the outline (dark sky only). */
  glowWidth: number;
  glowOpacity: number;
}

export interface OverlapHighlight {
  root: THREE.Group;
  /** Flat, faint, pickable fill; it never pulses. */
  mesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  meshMaterial: THREE.MeshBasicMaterial;
  /** Static boundary of the whole region: interior cell edges cancel out. */
  outline: LineSegments2;
  glow: LineSegments2 | null;
}

const DEFAULT_STYLE: OverlapHighlightStyle = { color: "#f01951", width: 2.4, glowWidth: 0, glowOpacity: 0 };

/** Build one co-registered overlap surface marked only by its outer edge. */
export function buildOverlapHighlight(
  cells: readonly SphericalCellSheetGeometryInput[],
  renderOrder: number,
  opacity: number,
  resolution: THREE.Vector2,
  style: OverlapHighlightStyle = DEFAULT_STYLE,
): OverlapHighlight {
  const root = new THREE.Group();
  const meshMaterial = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    blending: THREE.NormalBlending,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), meshMaterial);
  mesh.renderOrder = renderOrder;
  root.add(mesh);

  const byNside = new Map<number, { radius: number; pixels: number[] }>();
  for (const cell of cells) {
    const entry = byNside.get(cell.nside) ?? { radius: cell.radius, pixels: [] };
    entry.pixels.push(cell.pixel);
    byNside.set(cell.nside, entry);
  }
  const positions: number[] = [];
  for (const [nside, entry] of byNside) positions.push(...regionOutlinePositions(nside, entry.pixels, entry.radius + 0.002));

  let glow: LineSegments2 | null = null;
  if (style.glowWidth > 0 && style.glowOpacity > 0) {
    glow = fatLines(positions, style.color, style.glowWidth, style.glowOpacity, resolution, { additive: true, depthTest: false, renderOrder: renderOrder + 1 });
    root.add(glow);
  }
  const outline = fatLines(positions, style.color, style.width, 1, resolution, { depthTest: false, renderOrder: renderOrder + 2 });
  root.add(outline);
  return { root, mesh, meshMaterial, outline, glow };
}
