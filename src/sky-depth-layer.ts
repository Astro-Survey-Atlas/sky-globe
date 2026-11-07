import * as THREE from "three";
import { Healpix } from "healpixjs";
import type { SkyDepthResponse, SkyDepthSourceResult, SkyDepthVoxel } from "./sky-depth-types.js";
import { raDecToCartesian } from "./coordinates.js";
import { sphericalCellBoundary } from "./spherical-cell-geometry.js";

const healpixByOrder = new Map<number, Healpix>();
/** Centre of a NESTED HEALPix cell in ICRS degrees. */
export function pixelCenter(order: number, pixel: number): { raDeg: number; decDeg: number } {
  let healpix = healpixByOrder.get(order);
  if (!healpix) healpixByOrder.set(order, healpix = new Healpix(2 ** order));
  const v = healpix.pix2vec(pixel);
  return { raDeg: ((Math.atan2(v.y, v.x) * 180 / Math.PI) + 360) % 360, decDeg: Math.asin(v.z) * 180 / Math.PI };
}

export interface SkyDepthAggregate {
  voxel: SkyDepthVoxel;
  source: SkyDepthSourceResult;
  position: THREE.Vector3;
  cellPixel: number;
  frameHeight: number;
}
export interface SkyDepthCellFrame {
  pixel: number;
  radialMax: number;
  count: number;
  height: number;
  boundary: THREE.Vector3[];
}
const vector = (ra: number, dec: number) => new THREE.Vector3().copy(raDecToCartesian(ra, dec));
const MAX_DEPTH_HEIGHT = .52;

export function isSkyDepthValueInRange(value: number, range: readonly [number, number]): boolean {
  return value >= range[0] && value <= range[1];
}

export function buildSkyDepthRangeFramePositions(
  boundaries: readonly THREE.Vector3[][],
  normal: THREE.Vector3,
  height: number,
  value: number,
  range: readonly [number, number],
): Float32Array {
  const fraction = THREE.MathUtils.clamp((value - range[0]) / (range[1] - range[0]), 0, 1);
  const positions: number[] = [];
  for (const boundary of boundaries) {
    for (let index = 0; index < boundary.length; index++) {
      const first = boundary[index]!.clone().addScaledVector(normal, fraction * height);
      const second = boundary[(index + 1) % boundary.length]!.clone().addScaledVector(normal, fraction * height);
      positions.push(...first.toArray(), ...second.toArray());
    }
  }
  return new Float32Array(positions);
}

/** All cells share one source-wide radial scale; only measured cells get raised frames. */
export function buildSkyDepthLayout(data: SkyDepthResponse, surfaceRadius: number) {
  const normal = data.query.cells.reduce((sum, cell) => {
    const center = pixelCenter(data.query.order, cell);
    return sum.add(vector(center.raDeg, center.decDeg));
  }, new THREE.Vector3()).normalize();
  const boundary = data.query.cells.map(pixel => sphericalCellBoundary(2 ** data.query.order, pixel, surfaceRadius));
  let halfWidth = 0;
  for (const outline of boundary) for (const v of outline) {
    if (v.clone().normalize().dot(normal) < .65) throw Error("Select a smaller connected sky region");
    halfWidth = Math.max(halfWidth, v.clone().addScaledVector(normal, -v.dot(normal)).length());
  }
  const sources = data.sources.filter(s => s.voxels.length);
  const range: [number, number] = [Math.min(0, ...sources.map(s => s.radialRange?.[0] ?? 0)), Math.max(.001, ...sources.map(s => s.radialRange?.[1] ?? 0))];
  const radialFraction = (value: number) => THREE.MathUtils.clamp((value - range[0]) / (range[1] - range[0]), 0, 1);
  const extentByPixel = new Map<number, { radialMax: number; count: number }>();
  for (const source of sources) for (const extent of source.cellExtents ?? []) {
    const existing = extentByPixel.get(extent.pixel);
    if (existing) { existing.radialMax = Math.max(existing.radialMax, extent.radialMax); existing.count += extent.count; }
    else extentByPixel.set(extent.pixel, { radialMax: extent.radialMax, count: extent.count });
  }
  const frames: SkyDepthCellFrame[] = [...extentByPixel].map(([pixel, extent]) => ({ pixel, ...extent,
    height: radialFraction(extent.radialMax) * MAX_DEPTH_HEIGHT,
    boundary: sphericalCellBoundary(2 ** data.query.order, pixel, surfaceRadius),
  }));
  const heightByPixel = new Map(frames.map(frame => [frame.pixel, frame.height]));
  const items: SkyDepthAggregate[] = [];
  const colors: number[] = [];
  const stops = [new THREE.Color("#ff745e"), new THREE.Color("#ffd768"), new THREE.Color("#3be3ca"), new THREE.Color("#66baff")];
  for (const source of sources) for (const voxel of source.voxels) {
    const center = pixelCenter(voxel.order, voxel.pixel);
    const cellPixel = voxel.order >= data.query.order ? Math.floor(voxel.pixel / 4 ** (voxel.order - data.query.order)) : voxel.pixel;
    const frameHeight = heightByPixel.get(cellPixel) ?? 0;
    const t = radialFraction(voxel.radialMean);
    const position = vector(center.raDeg, center.decDeg).multiplyScalar(surfaceRadius).addScaledVector(normal, t * MAX_DEPTH_HEIGHT);
    const at = Math.min(2, Math.floor(t * 3));
    const color = stops[at]!.clone().lerp(stops[at + 1]!, t * 3 - at);
    colors.push(...color.toArray()); items.push({ voxel, source, position, cellPixel, frameHeight });
  }
  const maxCount = items.reduce((max, item) => Math.max(max, item.voxel.count), 1);
  // Scale the whole legend together to stay within common WebGL point-size limits.
  const baseDiameter = Math.min(3, 24 / Math.sqrt(maxCount));
  return { normal, boundary, height: MAX_DEPTH_HEIGHT, halfWidth, range, frames, items, colors, maxCount, baseDiameter, surfaceRadius };
}
export type SkyDepthLayout = ReturnType<typeof buildSkyDepthLayout>;

export class SkyDepthLayer {
  /** Ink for the frame top, high marker, axis and labels. Near-white on the
   * dark sky; a neutral (achromatic) ink on the light sky keeps it visible
   * without adding chromatic pixels to depth range measurements. */
  ink = { line: "#f6f6ff", axis: "#8fbbcd", label: "#d0e5ed" };
  readonly group = new THREE.Group();
  #layout: SkyDepthLayout | null = null;
  #material: THREE.ShaderMaterial | null = null;
  #pointsGeometry: THREE.BufferGeometry | null = null;
  #rangeGeometries: [THREE.BufferGeometry, THREE.BufferGeometry] | null = null;
  get layout() { return this.#layout; }
  constructor() { this.group.name = "selected-sky-depth"; }

  setData(data: SkyDepthResponse, surfaceRadius: number): SkyDepthLayout {
    this.clear();
    const layout = buildSkyDepthLayout(data, surfaceRadius); this.#layout = layout;
    if (!layout.items.length) return layout;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(layout.items.flatMap(item => item.position.toArray()), 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(layout.colors, 3));
    geometry.setAttribute("objectCount", new THREE.Float32BufferAttribute(layout.items.map(item => item.voxel.count), 1));
    geometry.setAttribute("highlightOpacity", new THREE.Float32BufferAttribute(layout.items.map(() => 1), 1));
    this.#pointsGeometry = geometry;
    this.#material = new THREE.ShaderMaterial({
      uniforms: { pixelRatio: { value: Math.min(devicePixelRatio, 1.35) }, baseDiameter: { value: layout.baseDiameter } },
      vertexShader: `attribute float objectCount; attribute float highlightOpacity; varying vec3 tint; varying float pointOpacity; uniform float pixelRatio; uniform float baseDiameter;
        void main(){tint=color; pointOpacity=highlightOpacity; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);
          gl_PointSize=baseDiameter*sqrt(objectCount)*pixelRatio;}`,
      fragmentShader: `varying vec3 tint; varying float pointOpacity; void main(){float r=length(gl_PointCoord-vec2(.5))*2.0;
        if(r>1.0)discard; float alpha=1.0-smoothstep(.55,1.0,r);
        gl_FragColor=vec4(tint*.82+vec3(.08)*pow(1.0-r,4.0),alpha*.95*pointOpacity);}`,
      vertexColors: true, transparent: true, depthWrite: false, toneMapped: false,
    });
    const cloud = new THREE.Points(geometry, this.#material);
    cloud.name = "sky-depth-aggregates"; cloud.renderOrder = 15002;
    cloud.userData.representedCount = layout.items.reduce((sum, item) => sum + item.voxel.count, 0);
    this.group.add(cloud);
    // Occlude the far side even where transparent coverage has no filled cells.
    const occluder = new THREE.Mesh(new THREE.SphereGeometry(surfaceRadius - .005, 48, 24), new THREE.MeshBasicMaterial({ colorWrite: false, transparent: true }));
    occluder.name = "sky-depth-occlusion"; occluder.renderOrder = 15001; this.group.add(occluder);
    const verticals: number[] = [], tops: number[] = [];
    for (const frame of layout.frames) {
      if (frame.height <= 0) continue;
      for (let i = 0; i < frame.boundary.length; i++) {
        const base = frame.boundary[i]!, next = frame.boundary[(i + 1) % frame.boundary.length]!;
        const top = base.clone().addScaledVector(layout.normal, frame.height);
        const nextTop = next.clone().addScaledVector(layout.normal, frame.height);
        verticals.push(...base.toArray(), ...top.toArray()); tops.push(...top.toArray(), ...nextTop.toArray());
      }
    }
    const verticalGeometry = new THREE.BufferGeometry(); verticalGeometry.setAttribute("position", new THREE.Float32BufferAttribute(verticals, 3));
    const verticalEdges = new THREE.LineSegments(verticalGeometry, new THREE.LineBasicMaterial({ color: "#6debdc", transparent: true, opacity: .74, depthWrite: false }));
    verticalEdges.renderOrder = 15002; this.group.add(verticalEdges);
    const topGeometry = new THREE.BufferGeometry(); topGeometry.setAttribute("position", new THREE.Float32BufferAttribute(tops, 3));
    const topEdges = new THREE.LineSegments(topGeometry, new THREE.LineBasicMaterial({ color: this.ink.line, transparent: true, opacity: .96, depthWrite: false }));
    topEdges.renderOrder = 15003; this.group.add(topEdges);
    const rangeStyles = [
      { color: "#6debdc", opacity: .88, value: layout.range[0], name: "sky-depth-range-low" },
      { color: this.ink.line, opacity: .96, value: layout.range[1], name: "sky-depth-range-high" },
    ] as const;
    this.#rangeGeometries = rangeStyles.map(style => {
      const rangeGeometry = new THREE.BufferGeometry();
      rangeGeometry.setAttribute("position", new THREE.BufferAttribute(
        buildSkyDepthRangeFramePositions(layout.boundary, layout.normal, layout.height, style.value, layout.range), 3,
      ));
      const marker = new THREE.LineSegments(rangeGeometry, new THREE.LineBasicMaterial({ color: style.color, transparent: true, opacity: style.opacity, depthWrite: false }));
      marker.name = style.name; marker.renderOrder = 15004; this.group.add(marker);
      return rangeGeometry;
    }) as [THREE.BufferGeometry, THREE.BufferGeometry];
    const axis = layout.boundary[0]![0]!.clone();
    const axisGeometry = new THREE.BufferGeometry().setFromPoints([axis, axis.clone().addScaledVector(layout.normal, layout.height)]);
    const axisLine = new THREE.Line(axisGeometry, new THREE.LineBasicMaterial({ color: this.ink.axis, transparent: true, opacity: .55 })); axisLine.renderOrder = 15002; this.group.add(axisLine);
    for (const t of [0, .5, 1]) {
      const value = layout.range[0] + t * (layout.range[1] - layout.range[0]);
      const suffix = data.query.axis === "distance" ? " Mpc" : " z";
      this.#label(value.toFixed(data.query.axis === "distance" ? 0 : 2) + suffix, axis.clone().addScaledVector(layout.normal, t * layout.height), Math.max(.015, layout.halfWidth * .5));
    }
    return layout;
  }
  setRange(range: readonly [number, number]) {
    const layout = this.#layout, geometry = this.#pointsGeometry;
    if (!layout || !geometry) return null;
    const low = THREE.MathUtils.clamp(Math.min(range[0], range[1]), layout.range[0], layout.range[1]);
    const high = THREE.MathUtils.clamp(Math.max(range[0], range[1]), low, layout.range[1]);
    const opacity = geometry.getAttribute("highlightOpacity") as THREE.BufferAttribute;
    let inRange = 0;
    layout.items.forEach((item, index) => {
      const selected = isSkyDepthValueInRange(item.voxel.radialMean, [low, high]);
      opacity.setX(index, selected ? 1 : .5);
      if (selected) inRange++;
    });
    opacity.needsUpdate = true;
    this.#rangeGeometries?.forEach((rangeGeometry, index) => {
      const value = index === 0 ? low : high;
      const positions = buildSkyDepthRangeFramePositions(layout.boundary, layout.normal, layout.height, value, layout.range);
      const attribute = rangeGeometry.getAttribute("position") as THREE.BufferAttribute;
      if (attribute.array.length === positions.length) {
        (attribute.array as Float32Array).set(positions);
        attribute.needsUpdate = true;
      } else rangeGeometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
      rangeGeometry.computeBoundingSphere();
    });
    return { range: [low, high] as const, inRange, faded: layout.items.length - inRange };
  }
  setPixelRatio(value: number) { if (this.#material) this.#material.uniforms.pixelRatio!.value = value; }
  #label(value: string, position: THREE.Vector3, width: number) {
    const canvas = document.createElement("canvas"); canvas.width = 256; canvas.height = 64;
    const ctx = canvas.getContext("2d")!; ctx.font = "26px monospace"; ctx.fillStyle = this.ink.label; ctx.fillText(value, 8, 42);
    const texture = new THREE.CanvasTexture(canvas);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false }));
    sprite.position.copy(position); sprite.scale.set(width, width / 4, 1); sprite.center.set(1.1, .5); sprite.renderOrder = 15002; this.group.add(sprite);
  }
  /** Match the count-sized screen discs rather than a fixed world-space ray tolerance. */
  pick(x: number, y: number, camera: THREE.Camera, bounds: DOMRect): SkyDepthAggregate | null {
    const layout = this.#layout; if (!layout) return null;
    let selected: SkyDepthAggregate | null = null, front = Infinity;
    const ray = new THREE.Ray(); ray.origin.copy(camera.position);
    const sphere = new THREE.Sphere(new THREE.Vector3(), layout.surfaceRadius - .005), hit = new THREE.Vector3();
    for (const item of layout.items) {
      const p = item.position.clone().project(camera);
      if (p.z < -1 || p.z > 1 || p.z > front) continue;
      const dx = bounds.left + (p.x + 1) / 2 * bounds.width - x, dy = bounds.top + (1 - p.y) / 2 * bounds.height - y;
      const radius = Math.max(3, layout.baseDiameter * Math.sqrt(item.voxel.count) / 2);
      if (dx * dx + dy * dy > radius * radius) continue;
      ray.direction.copy(item.position).sub(camera.position).normalize();
      if (ray.intersectSphere(sphere, hit) && hit.distanceTo(camera.position) < item.position.distanceTo(camera.position) - .001) continue;
      front = p.z; selected = item;
    }
    return selected;
  }
  focusPose() {
    const l = this.#layout; if (!l?.items.length) return null;
    const east = new THREE.Vector3(0, 1, 0).cross(l.normal).normalize(); if (!east.lengthSq()) east.set(1, 0, 0);
    const north = l.normal.clone().cross(east).normalize();
    const target = l.normal.clone().multiplyScalar(l.surfaceRadius + l.height * .35);
    const distance = Math.max(.55, l.halfWidth * 7, l.height * 2.5);
    const camera = target.clone().addScaledVector(l.normal, distance * .55).addScaledVector(east, distance * .78).addScaledVector(north, distance * .32);
    return { target, camera, up: north };
  }
  clear() {
    for (const child of [...this.group.children]) {
      child.traverse(object => {
        if (object instanceof THREE.Points || object instanceof THREE.Mesh || object instanceof THREE.Line || object instanceof THREE.Sprite) {
          if ("geometry" in object) object.geometry.dispose();
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
            if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
            material.dispose();
          }
        }
      });
      this.group.remove(child);
    }
    this.#layout = null; this.#material = null; this.#pointsGeometry = null; this.#rangeGeometries = null;
  }
}
