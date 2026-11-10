import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import type { LineMaterial } from "three/addons/lines/LineMaterial.js";

import {
  buildSurveyLayerModel,
  overlapCountByPixel,
  sideNeighbours,
  surveySourceIdentity,
  visibleCoverageAtPixel,
  visibleSurveySlots,
  type CoverageCellMembership,
  type SurveyLayerLayoutMode,
  type SurveyLayerModel,
} from "./survey-layer-model.js";
import type { SurveyFootprint, SurveyFootprintManifest } from "./survey-footprints.js";
import { cartesianToRaDec, raDecToCartesian, type EquatorialCoordinate } from "./coordinates.js";
import { rectangleFromDrag, rectangleNavigationEnabled, rectangleOutlinePositions, unwrapRectangleRa, validateSkyRectangle, type SkyRectangle, type SkyRectangleChangePhase } from "./sky-rectangle.js";
export type { SkyRectangle, SkyRectangleChangePhase } from "./sky-rectangle.js";
import { SkyDepthLayer, type SkyDepthAggregate, type SkyDepthLayout } from "./sky-depth-layer.js";
import type { SkyDepthResponse } from "./sky-depth-types.js";
import { LAYER_RADIUS_MAX, LAYER_RADIUS_MIN, normalizeLayerOrder, visibleLayerDepths, type LayerDepth } from "./layer-order.js";
import { buildOverlapHighlight, type OverlapHighlightStyle } from "./overlap-highlight.js";
import { surveyColorFor } from "./survey-colors.js";

/** The survey fields the globe reads; any richer survey record satisfies it. */
export interface GlobeSurvey {
  id: string;
  color?: string;
}
import type { OverlapHighlight } from "./overlap-highlight.js";
import { applyCellRim, applyNeutralDepth, buildHudBackdrop, cellBracketPositions, cellRimUniforms, fatLines, HudFinalShader, regionOutlinePositions, type HudBackdrop } from "./hud-scene.js";
import { DEPTH_BLOOM, sceneTheme, type SceneTheme, type SceneThemeName } from "./scene-theme.js";
import {
  buildSphericalCellEdges,
  buildSphericalCellSourceSectorGeometry,
  buildSphericalCellSheetGeometry,
  healpixPixelFromSceneDirection,
  sphericalCellBoundary,
  TRIANGLES_PER_SPHERICAL_CELL_SHEET,
  type SphericalCellSheetGeometryInput,
} from "./spherical-cell-geometry.js";

export type SurveyLayerInteractionMode = "inspect" | "region";
export type SurveyLayerOverlapPickingMode = "cell" | "component";
export type { SurveyLayerLayoutMode };

export interface SurveyLayerSelection {
  kind: "coverage-region";
  nside: number;
  pixels: number[];
  surveyIds: string[];
  releaseIds: string[];
  assetIds: string[];
  artifacts: SurveyFootprint[];
  coverageCounts: Array<{ surveyId: string; cellCount: number }>;
  assetCoverageCounts: Array<{ assetId: string; cellCount: number }>;
  workspaceLayers: WorkspaceCoverageMembership[];
  centerRaDeg: number;
  centerDecDeg: number;
  angularRadiusDeg: number;
  emptyCellCount: number;
  notice?: string;
}

export interface SurveyLayerInspection {
  kind: "coverage-cell";
  nside: number;
  pixel: number;
  surveyIds: string[];
  releaseIds: string[];
  assetIds: string[];
  workspaceLayers: WorkspaceCoverageMembership[];
  artifacts: SurveyFootprint[];
  pointerRaDeg: number;
  pointerDecDeg: number;
  centerRaDeg: number;
  centerDecDeg: number;
  workspaceAvailable: boolean;
}

export interface SurveyLayerHover extends Omit<SurveyLayerInspection, "kind"> {
  clientX: number;
  clientY: number;
  selectableInRegion: boolean;
}

export interface SurveyLayerContextMenu {
  clientX: number;
  clientY: number;
  nside: number;
  pixels: number[];
  surveyIds: string[];
  releaseIds?: string[];
  assetIds: string[];
  /** Overlap component under the pointer, when `overlapContextMenu` is enabled. */
  componentId?: string;
  /** Public source ids of the covered footprints, when `sourceIdForFootprint` is set. */
  sourceIds?: string[];
}

export interface SurveyLayerOverlapComponent {
  id: string;
  order: number;
  cells: number[];
  sourceIds?: string[];
  areaDeg2?: number;
}

export interface SurveyLayerOverlapHover {
  component: SurveyLayerOverlapComponent;
  clientX: number;
  clientY: number;
}

/** Find real NESTED membership at exactly the supplied order; never project or infer cells. */
export function overlapComponentAtPixel(
  components: readonly SurveyLayerOverlapComponent[],
  order: number,
  pixel: number,
): SurveyLayerOverlapComponent | null {
  if (!Number.isInteger(order) || order < 0 || !Number.isSafeInteger(pixel) || pixel < 0 || pixel >= 12 * 4 ** order) return null;
  return components.find((component) => component.order === order && component.cells.includes(pixel)) ?? null;
}

/** Optional behaviour. Every option defaults to the Assets public-site behaviour. */
export interface SurveyLayerViewerOptions {
  /** Map a footprint to a stable public source id reported in context menus. */
  sourceIdForFootprint?: (footprint: SurveyFootprint) => string | null | undefined;
  /** Open the context menu in overlap mode, scoped to the component under the pointer. */
  overlapContextMenu?: boolean;
  /** Component tooltip target, only in overlap mode with component picking enabled.
   * Receives null when the pointer leaves the component or interaction clears it. */
  onOverlapHover?: (hover: SurveyLayerOverlapHover | null) => void;
  /** Double-click drill-down: when set, double-clicking a cell selects it and
   * reports the region (same payload as the context menu) instead of
   * focusing or fanning out the cell. Leave unset to keep the default. */
  onDrillDown?: (region: SurveyLayerContextMenu) => void;
  /** Opt-in rectangle interaction only. Drafts may be null while degenerate;
   * cancel reports the restored committed rectangle. Commit/cancel exit drawing.
   * Programmatic setRectangleSelection does not emit this callback. */
  onRectangleChange?: (rectangle: SkyRectangle | null, phase: SkyRectangleChangePhase) => void;
}

export interface SurveyLayerOverlapCoverage {
  nside: number;
  pixels: readonly number[];
  components: readonly SurveyLayerOverlapComponent[];
}

/** Return the camera pose that keeps the celestial sphere at the orbit centre. */
export function recenteredOrbitPose(
  cameraPosition: THREE.Vector3,
  orbitTarget: THREE.Vector3,
): { cameraPosition: THREE.Vector3; orbitTarget: THREE.Vector3 } {
  const offset = cameraPosition.clone().sub(orbitTarget);
  return {
    cameraPosition: offset.lengthSq() > 1e-9 ? offset : cameraPosition.clone(),
    orbitTarget: new THREE.Vector3(),
  };
}

export interface WorkspaceCoverageLayer {
  /** Explicit key. Keys starting with `moc:` get their own visibility toggle
   * (`setVisibleWorkspaceLayerKeys`) instead of following asset visibility. */
  key?: string;
  layerId?: string;
  assetId?: string;
  assetIds?: string[];
  assetName?: string;
  status?: string;
  surveyId?: string;
  releaseId?: string;
  productId?: string;
  modality?: string;
  artifactId?: string;
  source?: "connector" | "asset" | "combined" | "unassigned" | "conflict";
  message?: string;
  color?: string;
  nside: number;
  pixels: number[];
  /** Drawn and inspectable, but not offered as available data. */
  preview?: boolean;
}

export interface WorkspaceCoverageMembership {
  key: string;
  assetId?: string;
  assetIds: string[];
  assetName?: string;
  status?: string;
  surveyId?: string;
  releaseId?: string;
  productId?: string;
  modality?: string;
  source?: WorkspaceCoverageLayer["source"];
  message?: string;
}

export interface SurveyDrillCell {
  nside: number;
  pixel: number;
  count: number;
  layers: Array<{
    key: string;
    assetId?: string;
    surveyId?: string;
    releaseId?: string;
    product?: string;
    modality?: string;
    label?: string;
    color?: string;
    count: number;
  }>;
}

export interface SurveyLayerDrillEvent {
  nside: number;
  pixel: number;
  additive: boolean;
  doubleClick: boolean;
}

export interface SurveyObjectPoint {
  objectId?: string;
  raDeg: number;
  decDeg: number;
  assetId?: string;
  surveyId?: string;
  releaseId?: string;
  product?: string;
  modality?: string;
  attributes?: Record<string, unknown>;
  label?: string;
  color?: string;
  count?: number;
  overlapCount?: number;
  overlapAssetIds?: string[];
}

export interface SurveyLayerState {
  nside: number;
  sourceNside: number;
  cameraDistance: number;
  effectiveFovDeg: number;
  cameraPosition: [number, number, number];
  coverageViewDirection: [number, number, number];
  coverageViewRadiusRad: number;
  outerRadius: number;
  surveyCount: number;
  releaseCount: number;
  occupiedCellCount: number;
  visibleCellCount: number;
  selectedCellCount: number;
  selectedPixels: number[];
  selectionAnchor: {
    xRatio: number;
    yRatio: number;
    visible: boolean;
    bounds: { leftRatio: number; rightRatio: number; topRatio: number; bottomRatio: number };
  } | null;
  visibleSurveyIds: string[];
  visibleAssetIds: string[];
  visibleWorkspaceLayerKeys: string[];
  explodedPixel: number | null;
  explodedLayerCount: number;
  layerOrder: string[];
  layerDepths: LayerDepth[];
  layoutMode: SurveyLayerLayoutMode;
  interactionMode: SurveyLayerInteractionMode;
  focusedSurveyId: string | null;
  /** ICRS point under the centre of the rendered view, when it hits the sky. */
  viewCenter: { raDeg: number; decDeg: number; raScreenSign: 1 | -1 } | null;
  /** Angle between the centre view ray and the local sky normal at its hit point. */
  viewTiltDeg: number | null;
  /** Camera height above the outermost shell, in sphere radii. */
  viewAltitude: number;
}

export interface SurveyLayerCameraPose {
  position: [number, number, number];
  target: [number, number, number];
  up: [number, number, number];
  fov: number;
}

interface CellRecord {
  pixel: number;
}

interface LayerMesh extends THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
  userData: {
    layerKey?: string;
    assetId?: string;
    surveyId?: string;
    records: CellRecord[];
    drill?: boolean;
  };
}

type PointerCoordinates = Pick<PointerEvent, "clientX" | "clientY">;
type OverlapComponentChange = (component: SurveyLayerOverlapComponent) => void;

interface FragmentTransition {
  root: THREE.Group;
  startedAt: number;
  durationMs: number;
  direction: "in" | "out";
  meshMaterials: THREE.MeshBasicMaterial[];
  lineMaterials: THREE.LineBasicMaterial[];
  meshOpacity: number;
  lineOpacity: number;
}

interface ExplodedFragment {
  root: THREE.Group;
  material: THREE.MeshBasicMaterial;
  lineMaterial: THREE.LineBasicMaterial;
  fromScale: number;
}

interface ExplosionLayerEntry {
  key: string;
  nside: number;
  pixel: number;
  color: THREE.Color;
  sourceRadius: number;
}

interface ExplosionTransition {
  startedAt: number;
  durationMs: number;
  direction: "in" | "out";
  fragments: ExplodedFragment[];
}

interface CameraTransition {
  startedAt: number;
  durationMs: number;
  fromCamera: THREE.Vector3;
  toCamera: THREE.Vector3;
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromShift: number;
  toShift: number;
}

interface CameraPose {
  camera: THREE.Vector3;
  target: THREE.Vector3;
}

const BASE_COLOR = new THREE.Color("#2c3792");
// Overlap and selection colours follow the active scene theme.
const OVERLAP_COLOR = new THREE.Color("#ff8fb0");
/** Cells sampled to bound an overlap component's on-screen outline. */
const OVERLAP_ANCHOR_SAMPLE_CELLS = 600;
const SELECTION_COLOR = new THREE.Color("#f01951");
const SELECTION_EDGE_COLOR = new THREE.Color("#f6f6ff");
// Additive blending turns the dark sky into a light table; paper uses normal.
let additiveCoverage = true;
const coverageBlending = (): THREE.Blending => additiveCoverage ? THREE.AdditiveBlending : THREE.NormalBlending;

/** Keep each survey's hue, adjusting lightness so it reads as neon on the
 * dark sky and as ink on the daytime paper. */
export function hudSurveyColor(color: THREE.Color, theme: SceneThemeName): THREE.Color {
  const hsl = { h: 0, s: 0, l: 0 };
  color.getHSL(hsl);
  if (theme === "dark") return new THREE.Color().setHSL(hsl.h, Math.max(hsl.s, 0.82), THREE.MathUtils.clamp(hsl.l, 0.6, 0.7));
  return new THREE.Color().setHSL(hsl.h, Math.max(hsl.s, 0.8), THREE.MathUtils.clamp(hsl.l, 0.34, 0.46));
}
const WORKSPACE_COLOR = new THREE.Color("#8d97ff");
// The opening shot is a close, cropped glimpse of the layered globe. The
// tighter field keeps the shell geometry legible while the pose below moves
// its centre beyond the upper-left of the viewport.
const HOME_FOV_DEG = 24;
const COVERAGE_OPACITY = 0.38;
const COVERAGE_EDGE_OPACITY = 0.34;
const OVERLAP_SURVEY_OPACITY = 0.12;
const OVERLAP_FILL_OPACITY = 0.06;
const OVERLAP_EDGE_OPACITY = 0.14;
// Keep surrounding layers subdued while the selected region remains readable.
const DIMMED_OPACITY = 0.2;
const DIMMED_EDGE_OPACITY = 0.1;
const EXPLODED_OPACITY = 0.58;
const EXPLODED_LAYER_STEP = 0.18;
/** The innermost exploded sheet never collapses through the sphere centre. */
const MINIMUM_EXPLODED_RADIUS = 0.05;
const DRILL_RENDER_ORDER = 10_000;
const EXPLOSION_RENDER_ORDER = 11_000;
const SELECTION_RENDER_ORDER = 12_000;
const LABEL_RENDER_ORDER = 14_000;
const OBJECT_RENDER_ORDER = 15_000;
const DATA_VIEW_CAMERA_FOV_DEG = 48;
// Tactical data view: the camera hovers low over the sphere and the projection
// window is shifted upward, so the surface recedes toward a visible horizon
// while the orbit still pivots on the globe centre.
const TACTICAL_VIEW_SHIFT = 0.5;
const TACTICAL_VIEW_DISTANCE = 1.68;
const GLOBE_UP = new THREE.Vector3(0, 1, 0);
const TACTICAL_VIEW_DIRECTION = (() => {
  const point = raDecToCartesian(196, 23);
  return new THREE.Vector3(point.x, point.y, point.z).normalize();
})();

/** The globe's centered data view is deliberately wide enough to show context. */
export const CENTERED_DATA_FOV_DEG = 115;

export function cameraDistanceForEffectiveFov(
  outerRadius: number,
  cameraFovDeg = DATA_VIEW_CAMERA_FOV_DEG,
  effectiveFovDeg = CENTERED_DATA_FOV_DEG,
): number {
  const radius = Number.isFinite(outerRadius) && outerRadius > 0 ? outerRadius : 1;
  const cameraHalfFov = THREE.MathUtils.clamp(
    THREE.MathUtils.degToRad(cameraFovDeg) / 2,
    THREE.MathUtils.degToRad(0.5),
    THREE.MathUtils.degToRad(89.5),
  );
  const effectiveHalfFov = THREE.MathUtils.clamp(
    THREE.MathUtils.degToRad(effectiveFovDeg) / 2,
    THREE.MathUtils.degToRad(0.5),
    THREE.MathUtils.degToRad(89.5),
  );
  return Math.max(radius * 1.002, radius * Math.tan(effectiveHalfFov) / Math.tan(cameraHalfFov));
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (!(child instanceof THREE.Mesh || child instanceof THREE.Points || child instanceof THREE.LineSegments || child instanceof THREE.Sprite)) return;
    child.geometry.dispose();
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    materials.forEach((material) => {
      if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
      material.dispose();
    });
  });
}

function releaseWebglContext(renderer: THREE.WebGLRenderer): void {
  renderer.getContext().getExtension("WEBGL_lose_context")?.loseContext();
}

export function disposeRenderer(renderer: THREE.WebGLRenderer, releaseContext = true): void {
  renderer.dispose();
  if (releaseContext) releaseWebglContext(renderer);
}

/** Some drivers return null for unsupported precision queries. Three.js calls
 * this method while constructing a renderer, so choose a conservative shader
 * precision before it can dereference that null result. */
export function rendererPrecision(canvas: HTMLCanvasElement): "highp" | "mediump" | "lowp" {
  const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  if (!context || typeof context.getShaderPrecisionFormat !== "function") return "lowp";
  try {
    const highVertex = context.getShaderPrecisionFormat(context.VERTEX_SHADER, context.HIGH_FLOAT);
    const highFragment = context.getShaderPrecisionFormat(context.FRAGMENT_SHADER, context.HIGH_FLOAT);
    if ((highVertex?.precision ?? 0) > 0 && (highFragment?.precision ?? 0) > 0) return "highp";
    const mediumVertex = context.getShaderPrecisionFormat(context.VERTEX_SHADER, context.MEDIUM_FLOAT);
    const mediumFragment = context.getShaderPrecisionFormat(context.FRAGMENT_SHADER, context.MEDIUM_FLOAT);
    if ((mediumVertex?.precision ?? 0) > 0 && (mediumFragment?.precision ?? 0) > 0) return "mediump";
  } catch { /* fall through to the universally supported low precision */ }
  return "lowp";
}

function clearGroup(group: THREE.Group): void {
  for (const child of [...group.children]) {
    group.remove(child);
    disposeObject(child);
  }
}

function easeInOut(progress: number): number {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - ((-2 * progress + 2) ** 3) / 2;
}

function cameraUpForDirection(direction: THREE.Vector3): THREE.Vector3 {
  const reference = Math.abs(direction.y) < 0.9
    ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(1, 0, 0);
  const up = reference.addScaledVector(direction, -reference.dot(direction));
  return up.normalize();
}

/** Look at a sky direction while the orbit pivot stays at the sphere centre,
 * so dragging after a focus still rotates the whole globe freely. */
function focusCameraPose(direction: THREE.Vector3, distance: number): CameraPose {
  return { camera: direction.clone().multiplyScalar(distance), target: new THREE.Vector3() };
}

export function cameraDistanceForAngularRadius(angularRadius: number, outerRadius: number): number {
  const safeRadius = Math.max(0, Math.min(Math.PI / 2, angularRadius));
  const desiredHalfView = THREE.MathUtils.clamp(
    Math.max(safeRadius * 1.5, THREE.MathUtils.degToRad(8)),
    THREE.MathUtils.degToRad(8),
    THREE.MathUtils.degToRad(20),
  );
  const surfaceRadius = outerRadius * Math.tan(safeRadius);
  const surfaceGap = THREE.MathUtils.clamp(
    surfaceRadius / Math.tan(desiredHalfView),
    outerRadius * 0.08,
    outerRadius * 1.4,
  );
  return outerRadius + surfaceGap;
}

function overlapComponentsForPixels(pixels: readonly number[], nside: number): SurveyLayerOverlapComponent[] {
  const pending = new Set(pixels);
  const result: SurveyLayerOverlapComponent[] = [];
  while (pending.size) {
    const start = pending.values().next().value as number;
    const queue = [start];
    const cells: number[] = [];
    pending.delete(start);
    while (queue.length) {
      const pixel = queue.pop()!;
      cells.push(pixel);
      for (const neighbour of sideNeighbours(nside, pixel)) {
        if (pending.delete(neighbour)) queue.push(neighbour);
      }
    }
    cells.sort((left, right) => left - right);
    result.push({ id: `C${String(result.length + 1).padStart(2, "0")}`, order: Math.round(Math.log2(nside)), cells });
  }
  return result;
}

export function largestConnectedPixelComponent(pixels: readonly number[], nside: number): number[] {
  const uniquePixels = [...new Set(pixels)];
  if (uniquePixels.length <= 1) return uniquePixels;
  const components = overlapComponentsForPixels(uniquePixels, nside);
  const largest = components.reduce<SurveyLayerOverlapComponent | undefined>((current, candidate) => (
    !current || candidate.cells.length > current.cells.length ? candidate : current
  ), undefined);
  return [...(largest?.cells ?? uniquePixels)];
}

function artifactKey(artifact: SurveyFootprint): string {
  return `${surveySourceIdentity(artifact)}:${artifact.label}`;
}

export function sourceVariantColor(base: THREE.Color, index: number, count: number): THREE.Color {
  if (count <= 1) return base.clone();
  const hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  const position = THREE.MathUtils.clamp(index, 0, count - 1) / (count - 1);
  const lightness = THREE.MathUtils.lerp(0.2, 0.7, position);
  return base.clone().setHSL(hsl.h, Math.max(0.78, hsl.s), lightness);
}

export function workspaceAssetColor(key: string): string {
  const palette = ["#5965c7", "#f01951", "#8d97ff", "#a674d6", "#5caeff", "#d95f90", "#b06cf0", "#ed6d70"];
  let hash = 2166136261;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return palette[(hash >>> 0) % palette.length]!;
}

function deterministicWorkspaceColor(key: string): THREE.Color {
  return new THREE.Color(workspaceAssetColor(key));
}

function fragmentMaterial(opacity = COVERAGE_OPACITY): THREE.MeshBasicMaterial {
  return applyCellRim(new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity,
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: false,
    blending: coverageBlending(),
    toneMapped: false,
  }));
}

function compactCount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}K`;
  return String(Math.round(value));
}

function shortLayerLabel(value: string): string {
  const normalized = value.replace(/^asset:/, "");
  return normalized.length > 12 ? `${normalized.slice(0, 10)}..` : normalized;
}

function countLabelSprite(text: string, position: THREE.Vector3, depthTest = true, scale = 1): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 192;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  context.clearRect(0, 0, canvas.width, canvas.height);
  const palette = sceneTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark").label;
  // Chamfered HUD plate: clipped top-right corner and an accent tick.
  const plate = new Path2D();
  plate.moveTo(10, 10);
  plate.lineTo(166, 10);
  plate.lineTo(182, 26);
  plate.lineTo(182, 54);
  plate.lineTo(10, 54);
  plate.closePath();
  context.fillStyle = palette.fill;
  context.strokeStyle = palette.stroke;
  context.lineWidth = 2;
  context.fill(plate);
  context.stroke(plate);
  context.fillStyle = palette.accent;
  context.fillRect(10, 10, 5, 44);
  context.fillStyle = palette.text;
  context.font = '700 23px "Atlas Mono", "Atlas Sans CJK", monospace';
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, canvas.width / 2 + 2, canvas.height / 2 + 1);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest, depthWrite: false, toneMapped: false }));
  sprite.position.copy(position);
  sprite.scale.set(0.15 * scale, 0.05 * scale, 1);
  sprite.renderOrder = LABEL_RENDER_ORDER;
  return sprite;
}

export class SurveyLayerViewer {
  readonly #canvas: HTMLCanvasElement;
  #manifest: SurveyFootprintManifest;
  readonly #scene = new THREE.Scene();
  readonly #camera = new THREE.PerspectiveCamera(48, 1, 0.015, 24);
  #projectionSize = { width: 1, height: 1 };
  #layerRadiusRange = { min: LAYER_RADIUS_MIN, max: LAYER_RADIUS_MAX };
  #appliedShiftY = 0;
  readonly #renderer: THREE.WebGLRenderer;
  readonly #composer: EffectComposer;
  readonly #bloomPass: UnrealBloomPass;
  readonly #finalPass: ShaderPass;
  readonly #starField: THREE.Points;
  readonly #controls: OrbitControls;
  readonly #lineResolution = new THREE.Vector2(1, 1);
  readonly #hudBackdrop: HudBackdrop;
  readonly #hudOutlineGroup = new THREE.Group();
  #hudOutlineKey = "";
  #theme: SceneThemeName = document.documentElement.dataset.theme === "light" ? "light" : "dark";
  #palette: SceneTheme = sceneTheme(this.#theme);
  #bloomStrength = 0.4;
  #interactionQualityActive = false;
  #basePixelRatio = 1;
  #backgroundColor: number | null = null;
  readonly #raycaster = new THREE.Raycaster();
  readonly #pointer = new THREE.Vector2();
  readonly #coverageGroup = new THREE.Group();
  readonly #workspaceCoverageGroup = new THREE.Group();
  readonly #retiredGroup = new THREE.Group();
  readonly #selectionGroup = new THREE.Group();
  readonly #rectangleGroup = new THREE.Group();
  #rectangleOutlineKey = "";
  #rectangleDrawing = false;
  #rectangleSelection: SkyRectangle | null = null;
  #rectangleDraft: SkyRectangle | null = null;
  #rectanglePointer: { id: number; start: EquatorialCoordinate; unwrappedRa: number } | null = null;
  readonly #navigationPointers = new Set<number>();
  #rectangleDoubleClickUntil = 0;
  readonly #explosionGroup = new THREE.Group();
  readonly #overlapLabelGroup = new THREE.Group();
  #selectionBox: { height: number } | null = null;
  readonly #overlapSelectionGroup = new THREE.Group();
  readonly #drillGroup = new THREE.Group();
  readonly #objectPointGroup = new THREE.Group();
  readonly #skyDepth = new SkyDepthLayer();
  #skyDepthData: SkyDepthResponse | null = null;
  #onSkyDepthPick: ((item: SkyDepthAggregate) => void) | null = null;
  readonly #resizeObserver: ResizeObserver;
  readonly #onSelection: (selection: SurveyLayerSelection | null) => void;
  readonly #onHover: (hover: SurveyLayerHover | null) => void;
  readonly #onInspection: (inspection: SurveyLayerInspection | null) => void;
  readonly #onStateChange: (state: SurveyLayerState) => void;
  readonly #onContextMenu: (menu: SurveyLayerContextMenu) => void;
  readonly #onObjectPoint?: (point: SurveyObjectPoint) => void;
  readonly #onOverlapComponent?: OverlapComponentChange;
  readonly #options: SurveyLayerViewerOptions;
  #model: SurveyLayerModel;
  readonly #colorBySurvey = new Map<string, THREE.Color>();
  readonly #selectedPixels = new Set<number>();
  readonly #visibleSurveyIds = new Set<string>();
  readonly #visibleAssetIds = new Set<string>();
  readonly #visibleWorkspaceLayerKeys = new Set<string>();
  readonly #layerMeshes: LayerMesh[] = [];
  readonly #coverageEdgeMaterials: THREE.LineBasicMaterial[] = [];
  readonly #coverageSourceMaterials: THREE.MeshBasicMaterial[] = [];
  readonly #meshBySurvey = new Map<string, LayerMesh>();
  #workspaceLayers = new Map<string, WorkspaceCoverageLayer>();
  #layerOrder: string[] = [];
  readonly #fragmentTransitions: FragmentTransition[] = [];
  #layoutMode: SurveyLayerLayoutMode = "layers";
  #interactionMode: SurveyLayerInteractionMode = "inspect";
  #focusedSurveyId: string | null = null;
  #homeScrollProgress = 0;
  /** 1 on the tactical data view; 0 after a focus so the focused cell sits
   * at the viewport centre instead of below the shifted horizon. */
  #viewShiftWeight = 1;
  #renderQueued = false;
  #pointerStart: { x: number; y: number } | null = null;
  #clickTimer: ReturnType<typeof setTimeout> | null = null;
  #interactionMesh: LayerMesh | null = null;
  #cameraTransition: CameraTransition | null = null;
  #selectionCoreMaterial: THREE.Material | null = null;
  #selectionGlowMaterial: THREE.Material | null = null;
  #selectionBracketMaterial: THREE.Material | null = null;
  #explosionTransition: ExplosionTransition | null = null;
  #explodedFragments: ExplodedFragment[] = [];
  #explodedPixel: number | null = null;
  #explodedNside: number | null = null;
  #drillNside = 16;
  #drillCells = new Map<number, SurveyDrillCell>();
  #drillFocusActive = false;
  #focusedAssetId: string | null = null;
  #overlapMode = false;
  #overlapPickingMode: SurveyLayerOverlapPickingMode = "cell";
  #overlapHoverActive = false;
  #overlapNside: number | null = null;
  #overlapPixels: number[] | null = null;
  #renderedOverlapPixels: readonly number[] = [];
  #overlapPixelSet = new Set<number>();
  #overlapComponents: SurveyLayerOverlapComponent[] = [];
  #activeOverlapComponentId: string | null = null;
  #overlapAnchorCache: { key: string; center: THREE.Vector3; boundary: THREE.Vector3[] } | null = null;
  #activeOverlapHighlight: OverlapHighlight | null = null;
  #viewportRightInset = 0;
  #disposed = false;
  #renderFrame: number | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    manifest: SurveyFootprintManifest,
    surveys: readonly GlobeSurvey[],
    onSelection: (selection: SurveyLayerSelection | null) => void,
    onHover: (hover: SurveyLayerHover | null) => void,
    onInspection: (inspection: SurveyLayerInspection | null) => void,
    onContextMenu: (menu: SurveyLayerContextMenu) => void,
    onStateChange: (state: SurveyLayerState) => void,
    onObjectPoint?: (point: SurveyObjectPoint) => void,
    onOverlapComponent?: OverlapComponentChange,
    options: SurveyLayerViewerOptions = {},
  ) {
    this.#canvas = canvas;
    this.#manifest = manifest;
    this.#onSelection = onSelection;
    this.#onHover = onHover;
    this.#onInspection = onInspection;
    this.#onContextMenu = onContextMenu;
    this.#onStateChange = onStateChange;
    this.#onObjectPoint = onObjectPoint;
    this.#onOverlapComponent = onOverlapComponent;
    this.#options = options;
    this.#model = buildSurveyLayerModel(surveys, manifest);
    surveys.forEach((survey) => this.#colorBySurvey.set(survey.id, new THREE.Color(surveyColorFor(survey.id, survey.color))));

    const highResolutionViewport = window.innerWidth * window.innerHeight >= 3_000_000;
    this.#renderer = new THREE.WebGLRenderer({ canvas, antialias: !highResolutionViewport, powerPreference: "high-performance", precision: rendererPrecision(canvas) });
    this.#basePixelRatio = Math.min(window.devicePixelRatio, 1.35);
    this.#renderer.setPixelRatio(this.#basePixelRatio);
    this.#renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.#renderer.debug.checkShaderErrors = true;

    this.#composer = new EffectComposer(this.#renderer);
    this.#composer.addPass(new RenderPass(this.#scene, this.#camera));
    // The high threshold keeps bloom focused on the white selection core.
    this.#bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), this.#bloomStrength, 0.4, 0.85);
    this.#composer.addPass(this.#bloomPass);
    // Vignette, grain and scanlines are achromatic, so measured chroma holds.
    // They run before OutputPass: a screen-facing ShaderPass after it would
    // encode sRGB a second time and lift the black sky into a haze.
    this.#finalPass = new ShaderPass(HudFinalShader);
    this.#composer.addPass(this.#finalPass);
    this.#composer.addPass(new OutputPass());

    this.#controls = new OrbitControls(this.#camera, canvas);
    this.#controls.enablePan = false;
    this.#controls.enableDamping = true;
    this.#controls.dampingFactor = 0.07;
    this.#controls.minDistance = 0.002;
    this.#controls.maxDistance = 7.5;
    this.#controls.addEventListener("change", this.#handleControlsChange);
    this.#controls.addEventListener("start", this.#handleControlsStart);
    this.#controls.addEventListener("end", this.#handleControlsEnd);
    this.#starField = this.#backgroundStars();
    this.#hudBackdrop = buildHudBackdrop(this.#lineResolution, this.#palette);
    this.#hudOutlineGroup.name = "hud-outlines";
    this.#scene.add(this.#hudBackdrop.group, this.#hudOutlineGroup);
    this.#scene.add(this.#starField, this.#coverageGroup, this.#workspaceCoverageGroup, this.#drillGroup, this.#objectPointGroup, this.#retiredGroup, this.#selectionGroup, this.#rectangleGroup, this.#explosionGroup, this.#overlapSelectionGroup, this.#overlapLabelGroup, this.#skyDepth.group);
    this.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
    this.#canvas.addEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.addEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.addEventListener("dblclick", this.#handleDoubleClick);
    this.#canvas.addEventListener("contextmenu", this.#handleContextMenu);
    this.#canvas.addEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.addEventListener("pointerleave", this.#handlePointerLeave);
    this.#canvas.addEventListener("pointercancel", this.#handlePointerCancel);
    this.#canvas.addEventListener("lostpointercapture", this.#handleLostPointerCapture);
    window.addEventListener("keydown", this.#handleRectangleKeyDown, true);
    window.addEventListener("blur", this.#handleRectangleBlur);
    this.#rectangleGroup.name = "sky-rectangle";
    this.#resizeObserver = new ResizeObserver(() => this.#resize());
    this.#resizeObserver.observe(canvas.parentElement ?? canvas);
    this.focusData();
    this.#resize();
  }

  get webglVersion(): string {
    return this.#renderer.capabilities.isWebGL2 ? "WEBGL2" : "WEBGL1";
  }

  /** Replace a complete coverage batch without resetting the renderer or camera. */
  updateCoverage(manifest: SurveyFootprintManifest, surveys: readonly GlobeSurvey[], visibleSurveyIds: Iterable<string>, overlap?: SurveyLayerOverlapCoverage): void {
    const previousNside = this.#manifest.nside;
    const selected = new Set(this.#selectedPixels);
    this.#manifest = manifest;
    this.#model = buildSurveyLayerModel(surveys, manifest);
    this.#colorBySurvey.clear();
    surveys.forEach((survey) => this.#colorBySurvey.set(survey.id, new THREE.Color(surveyColorFor(survey.id, survey.color))));
    this.#visibleSurveyIds.clear();
    for (const id of visibleSurveyIds) this.#visibleSurveyIds.add(id);
    if (previousNside !== manifest.nside) {
      this.#selectedPixels.clear();
      // Preserve a selection only through cells present in the new geometry.
      // In particular, never synthesize finer coverage from a selected parent.
      const ratio = (manifest.nside / previousNside) ** 2;
      const parents = ratio < 1 ? new Set([...selected].map((pixel) => Math.floor(pixel * ratio))) : selected;
      for (const pixel of this.#model.coverageByPixel.keys()) {
        if (parents.has(ratio > 1 ? Math.floor(pixel / ratio) : pixel)) this.#selectedPixels.add(pixel);
      }
      this.#drillCells.clear();
      clearGroup(this.#drillGroup);
      clearGroup(this.#objectPointGroup);
      for (const [key, layer] of this.#workspaceLayers) if (layer.nside !== manifest.nside) this.#workspaceLayers.delete(key);
      this.#onInspection(null);
    }
    if (overlap) this.#assignOverlapCoverage(overlap.nside, overlap.pixels, overlap.components);
    this.#layerOrder = this.#normalizedLayerOrder();
    this.#rebuildVisible(false);
  }

  get cameraPose(): SurveyLayerCameraPose {
    return {
      position: [this.#camera.position.x, this.#camera.position.y, this.#camera.position.z],
      target: [this.#controls.target.x, this.#controls.target.y, this.#controls.target.z],
      up: [this.#camera.up.x, this.#camera.up.y, this.#camera.up.z],
      fov: this.#camera.fov,
    };
  }

  restoreCameraPose(pose: SurveyLayerCameraPose): void {
    this.setRectangleDrawing(false);
    this.#clearOverlapHover();
    this.#camera.position.set(...pose.position);
    this.#controls.target.set(...pose.target);
    this.#camera.up.set(...pose.up);
    this.#camera.fov = pose.fov;
    this.#camera.updateProjectionMatrix();
    this.#controls.update();
    this.#emitState();
    this.#requestRender();
  }

  setTheme(theme: "light" | "dark"): void {
    const changed = theme !== this.#theme;
    this.#canvas.dataset.theme = theme;
    this.#theme = theme;
    this.#palette = sceneTheme(theme);
    additiveCoverage = this.#palette.additiveCoverage;
    OVERLAP_COLOR.setHex(this.#palette.overlap);
    SELECTION_COLOR.setHex(this.#palette.selection);
    SELECTION_EDGE_COLOR.setHex(this.#palette.selectionEdge);
    cellRimUniforms.rimCore.value = this.#palette.rimCore;
    cellRimUniforms.rimGain.value = this.#palette.rimGain;
    cellRimUniforms.fillGain.value = this.#palette.fillGain;
    cellRimUniforms.edgeGain.value = this.#palette.edgeGain;
    this.#renderer.setClearColor(this.#backgroundColor ?? this.#palette.background, 1);
    (this.#starField.material as THREE.PointsMaterial).color.setHex(this.#palette.stars);
    (this.#starField.material as THREE.PointsMaterial).opacity = this.#palette.starOpacity;
    this.#hudBackdrop.setTheme(this.#palette);
    this.#skyDepth.ink = theme === "light"
      ? { line: "#3b3d48", axis: "#5c5e68", label: "#3b3d48" }
      : { line: "#f6f6ff", axis: "#8fbbcd", label: "#d0e5ed" };
    this.#applyPostTheme();
    if (changed && this.#skyDepthData) this.setSkyDepth(this.#skyDepthData, this.#onSkyDepthPick ?? undefined);
    if (changed) {
      // Survey colours, blending and outline glows are baked per theme.
      this.#hudOutlineKey = "";
      this.#rebuildVisible(false);
    }
    if (this.#overlapMode) this.#rebuildOverlapLabels();
    if (this.#drillCells.size) this.setDrillCells([...this.#drillCells.values()], this.#drillNside);
    if (this.#selectedPixels.size) this.#renderSelectionRegion();
    this.#requestRender();
  }

  /** Overlap regions are marked by a static boundary only: the common
   * result outlines in the theme overlap colour, the active component in
   * the selection colour with a halo on the dark sky. */
  #overlapStyle(active: boolean): OverlapHighlightStyle {
    const dark = this.#palette.additiveCoverage;
    return {
      color: active ? this.#palette.selection : this.#palette.overlap,
      width: active ? 2.6 : 1.8,
      glowWidth: dark ? (active ? 10 : 7) : 0,
      glowOpacity: dark ? (active ? 0.28 : 0.16) : 0,
    };
  }

  #surveyColor(surveyId: string): THREE.Color {
    return hudSurveyColor(this.#colorBySurvey.get(surveyId) ?? BASE_COLOR, this.#theme);
  }

  #depthActive(): boolean {
    return Boolean(this.#skyDepth.layout?.items.length);
  }

  /** Bloom and screen grade follow the theme; sky depth keeps the measured
   * pre-HUD bloom response and a quiet backdrop. */
  #applyPostTheme(): void {
    const depth = this.#depthActive();
    // The paper sky sits above any bloom threshold, so depth bloom is dark-only.
    const bloom = depth && this.#palette.additiveCoverage ? DEPTH_BLOOM : this.#palette.bloom;
    this.#bloomStrength = bloom.strength;
    this.#bloomPass.strength = bloom.strength;
    this.#bloomPass.radius = bloom.radius;
    this.#bloomPass.threshold = bloom.threshold;
    this.#bloomPass.enabled = !this.#interactionQualityActive && bloom.strength > 0;
    const final = this.#finalPass.uniforms;
    final.vignette!.value = depth ? 0 : this.#palette.final.vignette;
    // Flat, neutral fills while depth is measured: on the black sky any
    // tinted fill adds static chroma that masks the out-of-range fade.
    cellRimUniforms.rimCore.value = depth ? 1 : this.#palette.rimCore;
    cellRimUniforms.rimGain.value = depth ? 1 : this.#palette.rimGain;
    cellRimUniforms.fillGain.value = depth ? 1 : this.#palette.fillGain;
    cellRimUniforms.edgeGain.value = depth ? 1 : this.#palette.edgeGain;
    cellRimUniforms.desaturate.value = depth ? 1 : 0;
    final.grain!.value = depth ? 0 : this.#palette.final.grain;
    final.scanlines!.value = depth ? 0 : this.#palette.final.scanlines;
    this.#hudBackdrop.setQuiet(depth);
    // Measured depth view matches the pre-HUD sky: no opaque body.
    this.#hudBackdrop.group.visible = !(depth && this.#palette.additiveCoverage);
    this.#renderer.setClearColor(this.#backgroundColor ?? (depth && this.#palette.additiveCoverage ? 0x25282d : this.#palette.background), 1);
    // Tinted background stars would add static chroma to depth captures.
    const stars = this.#starField.material as THREE.PointsMaterial;
    stars.color.setHex(depth ? 0x71808b : this.#palette.stars);
    stars.opacity = depth ? 0.18 : this.#palette.starOpacity;
    // Depth contrast is measured on the canvas: keep the selection's chromatic
    // glow as thin as the pre-HUD outline and drop its fill there.
    const fill = this.#selectionGroup.getObjectByName("selection-fill");
    if (fill) fill.visible = !depth;
    for (const name of ["selection-box", "selection-box-glow"]) {
      const part = this.#selectionGroup.getObjectByName(name);
      if (part) part.visible = !depth;
    }
    const glow = this.#selectionGroup.getObjectByName("selection-glow") as (THREE.Object3D & { material: LineMaterial }) | undefined;
    if (glow) glow.material.linewidth = depth ? 1 : this.#palette.additiveCoverage ? 14 : 6;
  }

  /** Region outlines: wide additive glow, a bright edge and a white core on
   * the dark sky; a single ink edge on the daytime paper. */
  #rebuildHudOutlines(depths: readonly LayerDepth[]): void {
    const entries = depths
      .filter((depth) => depth.key.startsWith("public-survey:"))
      .map((depth) => ({ surveyId: depth.key.slice("public-survey:".length), radius: depth.radius }))
      .filter(({ surveyId }) => (this.#model.pixelsBySurvey.get(surveyId)?.length ?? 0) > 0);
    const key = `${this.#theme}:${this.#manifest.nside}:${entries.map(({ surveyId, radius }) => `${surveyId}@${radius.toFixed(4)}#${this.#model.pixelsBySurvey.get(surveyId)!.length}`).join(",")}`;
    if (key === this.#hudOutlineKey) return;
    this.#hudOutlineKey = key;
    clearGroup(this.#hudOutlineGroup);
    const palette = this.#palette;
    entries.forEach(({ surveyId, radius }) => {
      const positions = regionOutlinePositions(this.#manifest.nside, this.#model.pixelsBySurvey.get(surveyId)!, radius + 0.0025);
      if (!positions.length) return;
      const color = this.#surveyColor(surveyId);
      const root = new THREE.Group();
      root.userData.hudSurveyId = surveyId;
      if (palette.outlineGlowWidth > 0) root.add(fatLines(positions, color, palette.outlineGlowWidth, palette.outlineGlowOpacity, this.#lineResolution, { additive: true, renderOrder: SELECTION_RENDER_ORDER - 4 }));
      root.add(fatLines(positions, color, palette.outlineWidth, 0.95, this.#lineResolution, { additive: palette.additiveCoverage, renderOrder: SELECTION_RENDER_ORDER - 3 }));
      if (palette.outlineCoreOpacity > 0) root.add(fatLines(positions, 0xffffff, 0.9, palette.outlineCoreOpacity, this.#lineResolution, { additive: true, renderOrder: SELECTION_RENDER_ORDER - 2 }));
      this.#hudOutlineGroup.add(root);
    });
  }

  #applyHudOutlineOpacity(): void {
    const dimmed = this.#drillFocusActive || this.#selectedPixels.size > 0 || this.#explodedPixel != null;
    const scale = this.#overlapMode ? 0.45 : dimmed ? 0.55 : 1;
    this.#hudOutlineGroup.visible = !this.#depthActive();
    this.#hudOutlineGroup.children.forEach((root) => {
      const surveyId = root.userData.hudSurveyId as string;
      const focus = this.#focusedSurveyId && this.#focusedSurveyId !== surveyId ? 0.45 : 1;
      const detail = cellRimUniforms.cellDetail.value;
      root.children.forEach((line, index) => {
        const material = (line as THREE.Mesh).material as LineMaterial;
        const glow = index === 0 && this.#palette.outlineGlowWidth > 0;
        const core = index === root.children.length - 1 && this.#palette.outlineCoreOpacity > 0;
        const base = glow ? this.#palette.outlineGlowOpacity : core ? this.#palette.outlineCoreOpacity : 0.95;
        // Fixed-pixel outlines would merge into hot blobs once the globe is small.
        const fade = glow || core ? 0.15 + 0.85 * detail : 0.55 + 0.45 * detail;
        material.opacity = base * scale * focus * fade;
        if (glow) material.linewidth = this.#palette.outlineGlowWidth * (0.4 + 0.6 * detail);
        else if (!core) material.linewidth = this.#palette.outlineWidth * (0.6 + 0.4 * detail);
      });
    });
  }

  /** Shift the projection so focused sky remains centred beside a right drawer. */
  setViewportRightInset(insetPixels: number): void {
    const width = Math.max(1, Math.round(this.#canvas.getBoundingClientRect().width));
    const next = THREE.MathUtils.clamp(Number.isFinite(insetPixels) ? insetPixels : 0, 0, width * 0.8);
    if (Math.abs(next - this.#viewportRightInset) < 0.5) return;
    this.#viewportRightInset = next;
    this.#applyProjection(width, Math.max(1, Math.round(this.#canvas.getBoundingClientRect().height)));
    this.#requestRender();
  }

  setBackgroundColor(color: string | null): void {
    if (color === null) {
      this.#backgroundColor = null;
      this.setTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");
      return;
    }
    const parsed = new THREE.Color(color);
    this.#backgroundColor = parsed.getHex();
    this.#renderer.setClearColor(parsed, 1);
    this.#requestRender();
  }

  get state(): SurveyLayerState {
    const visibleCells = new Set<number>();
    this.#visibleSurveyIds.forEach((surveyId) => {
      this.#model.pixelsBySurvey.get(surveyId)?.forEach((pixel) => visibleCells.add(pixel));
    });
    this.#workspaceLayers.forEach((layer) => {
      if (this.#workspaceLayerVisible(layer)) layer.pixels.forEach((pixel) => visibleCells.add(pixel));
    });
    return {
      nside: this.#overlapMode ? this.#overlapNside ?? this.#manifest.nside : this.#manifest.nside,
      sourceNside: this.#manifest.nside,
      cameraDistance: this.#camera.position.length(),
      effectiveFovDeg: this.#effectiveSkyFovDeg(),
      cameraPosition: [this.#camera.position.x, this.#camera.position.y, this.#camera.position.z],
      coverageViewDirection: this.#camera.position.clone().normalize().toArray() as [number, number, number],
      coverageViewRadiusRad: this.#coverageViewRadiusRad(),
      outerRadius: this.#outerRadius,
      surveyCount: this.#model.slots.length,
      releaseCount: new Set(this.#manifest.footprints.map((footprint) => footprint.releaseId)).size,
      occupiedCellCount: new Set([
        ...this.#model.coverageByPixel.keys(),
        ...Array.from(this.#workspaceLayers.values()).filter((layer) => this.#workspaceLayerVisible(layer)).flatMap((layer) => layer.pixels),
      ]).size,
      visibleCellCount: this.#overlapMode ? this.#overlapPixels?.length ?? 0 : visibleCells.size,
      selectedCellCount: this.#selectedPixels.size,
      selectedPixels: [...this.#selectedPixels].sort((left, right) => left - right),
      selectionAnchor: this.#selectionAnchor(),
      visibleSurveyIds: [...this.#visibleSurveyIds],
      visibleAssetIds: [...this.#visibleAssetIds],
      visibleWorkspaceLayerKeys: [...this.#visibleWorkspaceLayerKeys],
      explodedPixel: this.#explodedPixel,
      explodedLayerCount: this.#explodedPixel == null ? 0 : this.#explodedFragments.length,
      layerOrder: this.#normalizedLayerOrder(),
      layerDepths: this.#displayDepths(),
      layoutMode: this.#layoutMode,
      interactionMode: this.#interactionMode,
      focusedSurveyId: this.#focusedSurveyId,
      ...this.#viewCenterState(),
    };
  }

  /** Downsampled visible coverage for the 2D overview map, nearest parent cells first. */
  minimapCells(limit = 1800): Array<{ surveyId: string; color: string; direction: [number, number, number] }> {
    const result: Array<{ surveyId: string; color: string; direction: [number, number, number] }> = [];
    const nside = this.#manifest.nside;
    const visible = [...this.#visibleSurveyIds];
    const total = visible.reduce((sum, id) => sum + (this.#model.pixelsBySurvey.get(id)?.length ?? 0), 0);
    let parentNside = nside;
    while (parentNside > 1 && total / ((nside / parentNside) ** 2) > limit) parentNside /= 2;
    const ratio = (nside / parentNside) ** 2;
    for (const surveyId of visible) {
      const color = `#${this.#surveyColor(surveyId).getHexString()}`;
      const parents = new Set((this.#model.pixelsBySurvey.get(surveyId) ?? []).map((pixel) => Math.floor(pixel / ratio)));
      for (const parent of parents) {
        const direction = this.#pixelDirectionAt(parentNside, [parent]);
        result.push({ surveyId, color, direction: [direction.x, direction.y, direction.z] });
      }
    }
    return result;
  }

  #viewCenterState(): Pick<SurveyLayerState, "viewCenter" | "viewTiltDeg" | "viewAltitude"> {
    const radius = this.#outerRadius;
    const viewAltitude = Math.max(0, this.#camera.position.length() / radius - 1);
    this.#camera.updateMatrixWorld(true);
    const origin = this.#camera.position.clone();
    const ray = new THREE.Vector3(0, 0, 0.5).unproject(this.#camera).sub(origin).normalize();
    const b = origin.dot(ray);
    const c = origin.lengthSq() - radius * radius;
    const discriminant = b * b - c;
    if (discriminant < 0) return { viewCenter: null, viewTiltDeg: null, viewAltitude };
    const distance = -b - Math.sqrt(discriminant);
    if (distance < 0) return { viewCenter: null, viewTiltDeg: null, viewAltitude };
    const hit = origin.addScaledVector(ray, distance);
    const normal = hit.clone().normalize();
    const center = cartesianToRaDec(normal);
    const east = raDecToCartesian(center.raDeg + 1, center.decDeg, radius);
    const projectedEast = new THREE.Vector3(east.x, east.y, east.z).project(this.#camera);
    const projectedCenter = hit.clone().project(this.#camera);
    return {
      viewCenter: { ...center, raScreenSign: projectedEast.x >= projectedCenter.x ? 1 : -1 },
      viewTiltDeg: THREE.MathUtils.radToDeg(ray.clone().negate().angleTo(normal)),
      viewAltitude,
    };
  }

  setDrillCells(cells: readonly SurveyDrillCell[], nside: number): void {
    if (!Number.isInteger(nside) || nside < this.#manifest.nside) return;
    this.#drillNside = nside;
    // Keep zero-count children as wireframe cells. They are part of the
    // selected HEALPix subdivision and must remain pickable for the next
    // double-click, even though they do not get a numeric label.
    const visible = cells.filter((cell) => Number.isInteger(cell.pixel) && cell.pixel >= 0 && cell.pixel < 12 * nside ** 2);
    this.#drillCells = new Map(visible.map((cell) => [cell.pixel, cell]));
    clearGroup(this.#drillGroup);
    if (!visible.length) {
      this.#requestRender();
      return;
    }
    const cellsInput = visible.map((cell) => ({
      nside,
      pixel: cell.pixel,
      radius: Math.max(1.006, this.#outerRadius + 0.006),
      color: this.#drillCellColor(cell),
      inset: nside === this.#manifest.nside ? 0.018 : 0.006,
    }));
    const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cellsInput), applyCellRim(new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: nside === this.#manifest.nside ? 0.2 : 0.3,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: false,
      blending: coverageBlending(),
      toneMapped: false,
    }))) as LayerMesh;
    mesh.userData = { layerKey: "__drill__", records: visible.map((cell) => ({ pixel: cell.pixel })), drill: true };
    mesh.renderOrder = DRILL_RENDER_ORDER;
    const edges = new THREE.LineSegments(buildSphericalCellEdges(cellsInput), new THREE.LineBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.8,
      depthTest: true,
      depthWrite: false,
      toneMapped: false,
    }));
    edges.renderOrder = DRILL_RENDER_ORDER + 1;
    this.#drillGroup.add(mesh, edges);
    // Labels are deliberately sparse. Counts remain available in the inspector;
    // the canvas only annotates a few high-resolution, high-count cells.
    const labelRadius = Math.max(1.012, this.#outerRadius + 0.012);
    const labels = nside >= 64
      ? visible.filter((cell) => cell.count > 0).sort((left, right) => right.count - left.count).slice(0, 8)
      : [];
    labels.forEach((cell) => {
      const layerText = cell.layers
        .filter((layer) => layer.count > 0)
        .map((layer) => `${shortLayerLabel(layer.label ?? (layer.assetId ? "用户资产" : layer.surveyId ? "巡天" : "图层"))}:${compactCount(layer.count)}`)
        .join("  ");
      const label = countLabelSprite(`${compactCount(cell.count)}${layerText ? `  ${layerText}` : ""}`, this.#pixelDirectionAt(nside, [cell.pixel]).multiplyScalar(labelRadius));
      this.#drillGroup.add(label);
    });
    this.#requestRender();
  }

  clearDrillCells(): void {
    this.#drillCells.clear();
    clearGroup(this.#drillGroup);
    this.#requestRender();
  }

  setDrillFocus(active: boolean): void {
    if (this.#drillFocusActive === active) return;
    this.#drillFocusActive = active;
    this.#applyFocus();
  }

  setObjectPoints(points: readonly SurveyObjectPoint[]): void {
    clearGroup(this.#objectPointGroup);
    const valid = points.filter((point) => Number.isFinite(point.raDeg) && Number.isFinite(point.decDeg));
    if (!valid.length) {
      this.#requestRender();
      return;
    }
    const radius = Math.max(1.018, this.#outerRadius + 0.018);
    const positions = new Float32Array(valid.length * 3);
    const colors = new Float32Array(valid.length * 3);
    valid.forEach((point, index) => {
      const position = raDecToCartesian(point.raDeg, point.decDeg, radius);
      positions.set([position.x, position.y, position.z], index * 3);
      const color = point.color
        ? new THREE.Color(point.color)
        : point.assetId
        ? new THREE.Color(workspaceAssetColor(point.assetId))
        : point.surveyId ? this.#colorBySurvey.get(point.surveyId) ?? BASE_COLOR : SELECTION_COLOR;
      colors.set([color.r, color.g, color.b], index * 3);
    });
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    const material = new THREE.PointsMaterial({ size: 0.014, sizeAttenuation: true, vertexColors: true, transparent: true, opacity: 0.95, depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const objectCloud = new THREE.Points(geometry, material);
    objectCloud.renderOrder = OBJECT_RENDER_ORDER;
    objectCloud.userData = { objectCount: valid.length, points: valid };
    this.#objectPointGroup.add(objectCloud);
    this.#requestRender();
  }

  clearObjectPoints(): void {
    clearGroup(this.#objectPointGroup);
    this.#requestRender();
  }

  focusDrillCell(nside: number, pixel: number): void {
    const direction = this.#pixelDirectionAt(nside, [pixel]);
    const distance = this.#outerRadius + 0.36;
    const targetRadius = Math.max(0.001, this.#outerRadius - 0.004);
    this.#startCameraTransition(
      direction.clone().multiplyScalar(distance),
      direction.clone().multiplyScalar(targetRadius),
      620,
    );
  }

  focusCell(nside: number, pixel: number): void {
    const direction = this.#pixelDirectionAt(nside, [pixel]);
    const angularRadius = Math.max(...sphericalCellBoundary(nside, pixel, 1).map((corner) => direction.angleTo(corner)));
    const outer = this.#outerRadius;
    const distance = cameraDistanceForAngularRadius(angularRadius, outer);
    const pose = focusCameraPose(direction, distance);
    this.#startCameraTransition(pose.camera, pose.target, 720, GLOBE_UP, 0);
  }

  focusSelection(): void {
    if (this.#overlapMode) {
      const component = this.#overlapComponents.find((entry) => entry.id === this.#activeOverlapComponentId)
        ?? this.#overlapComponents[0];
      if (component) this.focusPixels(2 ** component.order, component.cells);
      else if (this.#overlapNside !== null) this.focusPixels(this.#overlapNside, this.#overlapPixels ?? []);
      return;
    }
    const pixels = [...this.#selectedPixels];
    if (!pixels.length) return;
    if (pixels.length === 1) {
      this.focusCell(this.#manifest.nside, pixels[0]!);
      return;
    }
    const direction = this.#pixelDirection(pixels);
    let angularRadius = 0;
    for (const pixel of pixels) {
      for (const corner of sphericalCellBoundary(this.#manifest.nside, pixel, 1)) {
        angularRadius = Math.max(angularRadius, direction.angleTo(corner));
      }
    }
    const outer = this.#outerRadius;
    const halfFov = Math.max(THREE.MathUtils.degToRad(4), angularRadius * 1.35);
    const fitDistance = outer / Math.tan(Math.min(Math.PI / 3, halfFov * 1.25));
    const distance = THREE.MathUtils.clamp(Math.max(outer * 1.55, fitDistance), outer * 1.55, outer * 2.8);
    const pose = focusCameraPose(direction, distance);
    this.#startCameraTransition(pose.camera, pose.target, 720, GLOBE_UP, 0);
  }

  focusPixels(nside: number, pixels: readonly number[]): void {
    if (!pixels.length) return;
    const pose = this.#pixelFocusPose(nside, pixels);
    this.#startCameraTransition(pose.camera, pose.target, 720, GLOBE_UP, 0);
  }

  setSkyDepth(data: SkyDepthResponse | null, onPick?: (item: SkyDepthAggregate) => void): SkyDepthLayout | null {
    this.#skyDepthData = data; this.#onSkyDepthPick = onPick ?? null;
    this.#skyDepth.clear();
    delete this.#canvas.dataset.depthPoints; delete this.#canvas.dataset.depthRepresented;
    delete this.#canvas.dataset.depthFrames; delete this.#canvas.dataset.depthFrameHeights;
    delete this.#canvas.dataset.depthRangeMin; delete this.#canvas.dataset.depthRangeMax;
    delete this.#canvas.dataset.depthRangeIn; delete this.#canvas.dataset.depthRangeFaded; delete this.#canvas.dataset.depthRangeFrames;
    const layout = data ? this.#skyDepth.setData(data, this.#outerRadius + .014) : null;
    this.#skyDepth.setPixelRatio(this.#renderer.getPixelRatio());
    this.#selectionGroup.visible = true;
    if (layout) {
      this.#canvas.dataset.depthPoints = String(layout.items.length);
      this.#canvas.dataset.depthRepresented = String(layout.items.reduce((sum, item) => sum + item.voxel.count, 0));
      this.#canvas.dataset.depthFrames = String(layout.frames.length);
      this.#canvas.dataset.depthFrameHeights = JSON.stringify(layout.frames.map(frame => Number(frame.height.toFixed(6))));
      this.#canvas.dataset.depthRangeFrames = "2";
      this.setSkyDepthRange(layout.range);
    }
    this.#applyFocus(); this.#requestRender();
    return layout;
  }

  setSkyDepthRange(range: readonly [number, number]) {
    const result = this.#skyDepth.setRange(range);
    if (!result) return null;
    this.#canvas.dataset.depthRangeMin = String(result.range[0]);
    this.#canvas.dataset.depthRangeMax = String(result.range[1]);
    this.#canvas.dataset.depthRangeIn = String(result.inRange);
    this.#canvas.dataset.depthRangeFaded = String(result.faded);
    this.#requestRender();
    return result;
  }

  focusSkyDepth(): void {
    const pose = this.#skyDepth.focusPose();
    if (pose) this.#startCameraTransition(pose.camera, pose.target, 720, pose.up);
  }

  #pixelFocusPose(nside: number, pixels: readonly number[]): CameraPose {
    const direction = this.#pixelDirectionAt(nside, pixels);
    let angularRadius = 0;
    for (const pixel of pixels) for (const corner of sphericalCellBoundary(nside, pixel, 1)) angularRadius = Math.max(angularRadius, direction.angleTo(corner));
    const outer = this.#outerRadius;
    const distance = cameraDistanceForAngularRadius(angularRadius, outer);
    return focusCameraPose(direction, distance);
  }

  focusAsset(assetId: string): void {
    const layer = [...this.#workspaceLayers.values()].find((candidate) => this.#workspaceLayerAssetIds(candidate).includes(assetId));
    if (!layer || !this.#visibleAssetIds.has(assetId) || !layer.pixels.length) return;
    this.#focusedAssetId = assetId;
    this.#applyFocus();
    const direction = this.#pixelDirectionAt(layer.nside, layer.pixels);
    this.#startCameraTransition(
      direction.clone().multiplyScalar(this.#outerRadius + 0.36),
      direction.clone().multiplyScalar(Math.max(0.001, this.#outerRadius - 0.004)),
      680,
    );
  }

  get #outerRadius(): number {
    const radii = this.#displayDepths().map((entry) => entry.radius);
    const explodedOuter = this.#explodedPixel == null
      ? 1
      : Math.max(1, ...this.#explodedFragments.map((fragment) => fragment.root.userData.targetRadius ?? 1));
    return Math.max(1, explodedOuter, ...radii);
  }

  #effectiveSkyFovDeg(): number {
    const distance = this.#camera.position.distanceTo(this.#controls.target);
    const halfSpan = Math.atan((distance * Math.tan(THREE.MathUtils.degToRad(this.#camera.fov) / 2)) / Math.max(0.001, this.#outerRadius));
    return Math.max(0.01, Math.min(180, THREE.MathUtils.radToDeg(halfSpan * 2)));
  }

  #coverageViewRadiusRad(camera = this.#camera): number {
    const distance = camera.position.length();
    const radius = this.#outerRadius;
    if (distance <= radius + 0.003) return Math.PI;

    camera.updateMatrixWorld(true);
    // The projection shifts the sky into the pane beside the drawer. Exclude
    // the covered canvas strip when computing the source-loading footprint.
    const width = Math.max(1, this.#canvas.getBoundingClientRect().width);
    const right = 1 - 2 * Math.min(this.#viewportRightInset, width) / width;
    const corners = [[-1, -1], [-1, 1], [right, -1], [right, 1]] as const;
    const inward = camera.position.clone().negate().normalize();
    const maxRayOffset = Math.max(...corners.map(([x, y]) => {
      const ray = new THREE.Vector3(x, y, 0.5).unproject(camera).sub(camera.position).normalize();
      return inward.angleTo(ray);
    }));
    const shellRadius = radius + 0.003;
    const apparentRadius = Math.asin(Math.min(1, shellRadius / distance));
    if (maxRayOffset >= apparentRadius) return Math.min(Math.PI / 2, Math.acos(shellRadius / distance) + 0.003);
    // The camera ray's angle is measured at the observer. Subtract it from
    // the opposite sine-rule angle to obtain the cap on the sphere itself.
    return Math.min(Math.PI / 2, Math.max(0, Math.asin(Math.min(1, distance / shellRadius * Math.sin(maxRayOffset))) - maxRayOffset) + 0.003);
  }

  setVisibleSurveys(surveyIds: Iterable<string>): void {
    const hadNoVisibleSurveys = this.#visibleSurveyIds.size === 0;
    const available = new Set(this.#model.slots.filter((slot) => slot.hasFootprint).map((slot) => slot.surveyId));
    this.#workspaceLayers.forEach((layer) => {
      if (!this.#workspaceLayerAssetIds(layer).length && layer.pixels.length) available.add(layer.surveyId ?? "__unassigned__");
    });
    const next = new Set([...surveyIds].filter((surveyId) => available.has(surveyId)));
    if (next.size === this.#visibleSurveyIds.size && [...next].every((surveyId) => this.#visibleSurveyIds.has(surveyId))) return;
    this.#visibleSurveyIds.clear();
    next.forEach((surveyId) => this.#visibleSurveyIds.add(surveyId));
    if (this.#focusedSurveyId && !this.#visibleSurveyIds.has(this.#focusedSurveyId)) this.#focusedSurveyId = null;
    if (hadNoVisibleSurveys) this.#focusedAssetId = null;
    this.#pruneSelection();
    this.#rebuildVisible(true);
    // The first selected layer opens the canonical centered data view. A
    // directional survey focus is still available through the explicit focus
    // action, but selecting a layer should not strand the user in a narrow
    // footprint-only frame.
    if (hadNoVisibleSurveys && next.size === 1) this.focusData();
  }

  setOverlapMode(active: boolean): void {
    if (this.#overlapMode === active) return;
    this.setRectangleDrawing(false);
    if (active && this.#clickTimer) {
      clearTimeout(this.#clickTimer);
      this.#clickTimer = null;
    }
    this.#overlapMode = active;
    this.#clearOverlapHover();
    if (active && this.#overlapPickingMode === "component") this.#clearCellPickingState();
    // Overlap is a co-registered view, not an additional exploded layer.
    // Keep every selected survey on the unit sphere and restore the normal
    // radial presentation when the mode is dismissed.
    this.#layoutMode = active ? "overlap" : "layers";
    if (!active) {
      this.#overlapNside = null;
      this.#overlapPixels = null;
      this.#overlapPixelSet.clear();
      this.#overlapComponents = [];
      this.#activeOverlapComponentId = null;
      clearGroup(this.#overlapSelectionGroup);
      this.#activeOverlapHighlight = null;
    }
    this.#rebuildVisible(true);
    if (!active) this.#restoreGlobeOrbitTarget();
  }

  /** Opt in to whole-component clicks/hover while overlap mode is active.
   * Does not focus, move the camera, or change the inspect/region interaction mode. */
  setOverlapPickingMode(mode: SurveyLayerOverlapPickingMode): void {
    if (this.#disposed || this.#overlapPickingMode === mode) return;
    this.setRectangleDrawing(false);
    this.#overlapPickingMode = mode;
    this.#clearOverlapHover();
    if (mode === "component") this.#clearCellPickingState();
    if (this.#overlapMode) this.#rebuildOverlapLabels();
    this.#emitState();
    this.#requestRender();
  }

  #clearCellPickingState(): void {
    if (this.#clickTimer) clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    this.#pointerStart = null;
    this.#onHover(null);
    this.#onInspection(null);
    this.#clearExplosion(false);
    this.#clearSelection();
  }

  #clearOverlapHover(): void {
    if (!this.#overlapHoverActive) return;
    this.#overlapHoverActive = false;
    this.#options.onOverlapHover?.(null);
  }

  setOverlapCells(nside: number, pixels: readonly number[]): void {
    if (!Number.isInteger(nside) || nside < 1) return;
    this.#overlapNside = nside;
    this.#overlapPixels = [...new Set(pixels)].sort((left, right) => left - right);
    this.#overlapPixelSet = new Set(this.#overlapPixels);
    if (this.#overlapMode) this.#rebuildVisible(true);
  }

  setOverlapComponents(components: readonly SurveyLayerOverlapComponent[]): void {
    this.#clearOverlapHover();
    this.#overlapAnchorCache = null;
    this.#overlapComponents = components
      .filter((component) => Number.isInteger(component.order) && component.order >= 0 && Array.isArray(component.cells) && component.cells.length > 0)
      .map((component) => ({ ...component, cells: [...new Set(component.cells)].sort((left, right) => left - right) }));
    if (!this.#overlapComponents.some((component) => component.id === this.#activeOverlapComponentId)) this.#activeOverlapComponentId = null;
    if (this.#overlapMode) this.#rebuildVisible(true);
  }

  setOverlapCoverage(nside: number, pixels: readonly number[], components: readonly SurveyLayerOverlapComponent[]): void {
    this.#assignOverlapCoverage(nside, pixels, components);
    if (this.#overlapMode) this.#rebuildVisible(false);
  }

  #assignOverlapCoverage(nside: number, pixels: readonly number[], components: readonly SurveyLayerOverlapComponent[]): void {
    this.#clearOverlapHover();
    this.#overlapAnchorCache = null;
    this.#overlapNside = nside;
    this.#overlapPixels = [...new Set(pixels)].sort((left, right) => left - right);
    this.#overlapPixelSet = new Set(this.#overlapPixels);
    this.#overlapComponents = components.map((component) => ({ ...component, cells: [...component.cells] }));
    clearGroup(this.#overlapSelectionGroup);
    this.#activeOverlapHighlight = null;
    if (!components.some((component) => component.id === this.#activeOverlapComponentId)) this.#activeOverlapComponentId = null;
  }

  setActiveOverlapComponent(componentId: string | null): void {
    this.#activeOverlapComponentId = componentId;
    clearGroup(this.#overlapSelectionGroup);
    this.#activeOverlapHighlight = null;
    if (this.#overlapMode && componentId) {
      const component = this.#overlapComponents.find((candidate) => candidate.id === componentId);
      const nside = component ? 2 ** component.order : this.#overlapNside ?? this.#manifest.nside;
      if (component?.cells.length) {
        const radius = Math.max(1.025, this.#outerRadius + 0.028);
        const highlight = buildOverlapHighlight(component.cells.map((pixel) => ({
          nside,
          pixel,
          radius,
          color: SELECTION_COLOR,
          inset: nside === this.#manifest.nside ? 0.016 : 0.006,
        })), SELECTION_RENDER_ORDER + 2, 0.05, this.#lineResolution, this.#overlapStyle(true));
        this.#activeOverlapHighlight = highlight;
        this.#overlapSelectionGroup.add(highlight.root);
      }
    }
    if (this.#overlapMode) this.#rebuildOverlapLabels();
    this.#requestRender();
  }

  setVisibleAssets(assetIds: Iterable<string>): void {
    const next = new Set([...assetIds].filter((assetId) => typeof assetId === "string" && assetId.length > 0));
    if (next.size === this.#visibleAssetIds.size && [...next].every((assetId) => this.#visibleAssetIds.has(assetId))) return;
    this.#visibleAssetIds.clear();
    next.forEach((assetId) => this.#visibleAssetIds.add(assetId));
    this.#pruneSelection();
    this.#rebuildVisible(true);
  }
  setVisibleWorkspaceLayerKeys(keys: Iterable<string>): void {
    const next = new Set([...keys].filter((key) => typeof key === "string" && key.length > 0));
    if (next.size === this.#visibleWorkspaceLayerKeys.size && [...next].every((key) => this.#visibleWorkspaceLayerKeys.has(key))) return;
    this.#visibleWorkspaceLayerKeys.clear();
    next.forEach((key) => this.#visibleWorkspaceLayerKeys.add(key));
    this.#pruneSelection();
    this.#rebuildVisible(true);
  }

  /** Fly to an overlap component of the current overlap view. */
  focusOverlapComponent(componentId: string): void {
    const component = this.#overlapComponents.find((candidate) => candidate.id === componentId);
    if (!component || !this.#overlapMode) return;
    this.focusPixels(2 ** component.order, component.cells);
  }


  setLayerOrder(keys: Iterable<string>): void {
    const next = normalizeLayerOrder(this.#knownLayerKeys(), keys, []);
    if (next.length === this.#layerOrder.length && next.every((key, index) => key === this.#layerOrder[index])) return;
    this.#layerOrder = next;
    this.#rebuildVisible(true);
  }

  setWorkspaceCoverage(layer: WorkspaceCoverageLayer | null): void {
    this.#workspaceLayers.clear();
    if (layer && layer.nside === this.#manifest.nside) {
      const key = layer.key ?? (layer.surveyId ?? "__unassigned__");
      const pixels = layer.pixels.filter((pixel) => Number.isInteger(pixel) && pixel >= 0 && pixel < 12 * this.#manifest.nside ** 2);
      this.#workspaceLayers.set(key, { ...layer, key, pixels: [...new Set(pixels)].sort((left, right) => left - right) });
    }
    this.#layerOrder = this.#normalizedLayerOrder();
    this.#rebuildVisible(true);
  }

  setWorkspaceCoverageLayers(layers: readonly WorkspaceCoverageLayer[], nside: number): void {
    this.#workspaceLayers.clear();
    if (nside === this.#manifest.nside) {
      layers.forEach((layer, index) => {
        const key = layer.key ?? `${layer.surveyId ?? "__unassigned__"}:${layer.releaseId ?? ""}:${index}`;
        const pixels = layer.pixels.filter((pixel) => Number.isInteger(pixel) && pixel >= 0 && pixel < 12 * this.#manifest.nside ** 2);
        this.#workspaceLayers.set(key, { ...layer, key, nside, pixels: [...new Set(pixels)].sort((left, right) => left - right) });
      });
    }
    this.#layerOrder = this.#normalizedLayerOrder();
    this.#rebuildVisible(true);
  }

  clearRegionSelection(): void {
    this.#clearSelection();
    this.#clearExplosion(true);
    this.#onInspection(null);
  }

  setRegionSelection(pixels: Iterable<number>): void {
    const maximum = 12 * this.#manifest.nside ** 2;
    const next = [...new Set(pixels)].filter((pixel) => Number.isInteger(pixel) && pixel >= 0 && pixel < maximum);
    this.#selectedPixels.clear();
    next.forEach((pixel) => this.#selectedPixels.add(pixel));
    this.#renderSelectionRegion();
    this.#emitSelection();
    const pixel = next[0];
    const membership = pixel === undefined ? undefined : visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds);
    if (pixel !== undefined && membership) this.#presentInspection(this.#manifest.nside, pixel, membership, this.#workspaceMembershipAt(pixel).layers.length > 0, this.#pixelDirectionAt(this.#manifest.nside, [pixel]), false);
    else this.#onInspection(null);
  }

  soloSurvey(surveyId: string): void {
    this.setVisibleSurveys([surveyId]);
    this.focusSurvey(surveyId);
  }

  setLayoutMode(mode: SurveyLayerLayoutMode): void {
    if (this.#layoutMode === mode) return;
    this.setRectangleDrawing(false);
    this.#layoutMode = mode;
    this.#rebuildVisible(true);
  }

  /** Opt-in RA/Dec drag selection. Commit or any cancellation automatically
   * restores navigation and leaves this mode. Existing cell selections persist. */
  setRectangleDrawing(enabled: boolean): void {
    if (this.#disposed || this.#rectangleDrawing === enabled) return;
    if (!enabled) {
      this.#finishRectangle(false);
      return;
    }
    this.#rectangleDrawing = true;
    this.#cameraTransition = null;
    this.#controls.enabled = false;
    // End any pre-existing OrbitControls gesture using its normal cancel path.
    // This also clears its tracked pointers/capture without private internals.
    for (const pointerId of this.#navigationPointers) {
      this.#canvas.dispatchEvent(new PointerEvent("pointercancel", { pointerId }));
    }
    this.#navigationPointers.clear();
    this.#stopOrbitInertia();
    if (this.#interactionQualityActive) this.#handleControlsEnd();
    this.#pointerStart = null;
    if (this.#clickTimer) clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    this.#clearOverlapHover();
    this.#onHover(null);
    this.#onInspection(null);
    this.#canvas.dataset.rectangleDrawing = "true";
    this.#requestRender();
  }

  /** Set a numeric outline only; no callback or coverage selection is emitted.
   * Cancels/disarms any current drag silently. Invalid bounds throw RangeError. */
  setRectangleSelection(rectangle: SkyRectangle | null): void {
    if (this.#disposed) return;
    const validated = rectangle === null ? null : validateSkyRectangle(rectangle);
    if (this.#rectangleDrawing) this.#finishRectangle(false, false);
    this.#rectangleSelection = validated;
    this.#syncRectangleOutline();
    this.#requestRender();
  }

  #stopOrbitInertia(): void {
    // One undamped update consumes pending deltas. Restore the exact pose before
    // synchronizing again, so stopping inertia neither jumps nor replays it later.
    const position = this.#camera.position.clone();
    const target = this.#controls.target.clone();
    const damping = this.#controls.enableDamping;
    const autoRotate = this.#controls.autoRotate;
    this.#controls.removeEventListener("change", this.#handleControlsChange);
    try {
      this.#controls.enableDamping = false;
      this.#controls.autoRotate = false;
      this.#controls.update();
      this.#camera.position.copy(position);
      this.#controls.target.copy(target);
      this.#controls.update();
    } finally {
      this.#controls.enableDamping = damping;
      this.#controls.autoRotate = autoRotate;
      this.#controls.addEventListener("change", this.#handleControlsChange);
    }
  }

  #finishRectangle(commit: boolean, notify = true): void {
    const pointer = this.#rectanglePointer;
    if (commit && this.#rectangleDraft) this.#rectangleSelection = { ...this.#rectangleDraft };
    this.#rectanglePointer = null;
    this.#rectangleDraft = null;
    this.#rectangleDrawing = false;
    this.#pointerStart = null;
    delete this.#canvas.dataset.rectangleDrawing;
    // Invalidate before releasing: lostpointercapture can run synchronously.
    if (pointer && this.#canvas.hasPointerCapture(pointer.id)) this.#canvas.releasePointerCapture(pointer.id);
    this.#controls.enabled = rectangleNavigationEnabled(this.#homeScrollProgress, this.#cameraTransition !== null, false);
    this.#rectangleDoubleClickUntil = performance.now() + 400;
    this.#syncRectangleOutline();
    this.#requestRender();
    if (notify) this.#options.onRectangleChange?.(this.#rectangleSelection ? { ...this.#rectangleSelection } : null, commit ? "commit" : "cancel");
  }

  #rectanglePoint(event: PointerCoordinates): EquatorialCoordinate | null {
    const bounds = this.#canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0
      || event.clientX < bounds.left || event.clientX > bounds.left + bounds.width
      || event.clientY < bounds.top || event.clientY > bounds.top + bounds.height) return null;
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#camera.updateMatrixWorld(true);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const point = this.#intersectUnitSphere(this.#raycaster.ray);
    return point ? cartesianToRaDec(point) : null;
  }

  #updateRectangleDraft(event: PointerCoordinates): boolean {
    const pointer = this.#rectanglePointer;
    if (!pointer) return false;
    const point = this.#rectanglePoint(event);
    if (point) {
      pointer.unwrappedRa = unwrapRectangleRa(pointer.unwrappedRa, point.raDeg);
      this.#rectangleDraft = rectangleFromDrag(pointer.start, pointer.unwrappedRa, point.decDeg);
    } else this.#rectangleDraft = null;
    this.#syncRectangleOutline();
    this.#requestRender();
    this.#options.onRectangleChange?.(this.#rectangleDraft ? { ...this.#rectangleDraft } : null, "draft");
    return point !== null && this.#rectangleDraft !== null;
  }

  #syncRectangleOutline(): void {
    const rectangle = this.#rectanglePointer ? this.#rectangleDraft : this.#rectangleSelection;
    const camera = this.#camera.position;
    const key = JSON.stringify([rectangle, camera.x, camera.y, camera.z, this.#theme]);
    if (key === this.#rectangleOutlineKey) return;
    this.#rectangleOutlineKey = key;
    clearGroup(this.#rectangleGroup);
    if (!rectangle) return;
    const positions = rectangleOutlinePositions(rectangle, camera);
    if (!positions.length) return;
    // Neutral ink matches HUD text in both themes, independent of survey colour.
    // Explicit unit-sphere horizon clipping prevents any back-side bleed even
    // when the opaque backdrop is scaled beneath a separated survey shell.
    this.#rectangleGroup.add(fatLines(positions, this.#palette.selectionEdge, 2, 0.95, this.#lineResolution,
      { depthTest: false, renderOrder: SELECTION_RENDER_ORDER + 4 }));
  }

  setInteractionMode(mode: SurveyLayerInteractionMode): void {
    if (this.#interactionMode === mode) return;
    this.setRectangleDrawing(false);
    this.#clearOverlapHover();
    this.#interactionMode = mode;
    this.#clearExplosion(false);
    this.#onInspection(null);
    if (mode === "inspect") this.#clearSelection();
    this.#emitState();
  }

  focusSurvey(surveyId: string): void {
    const pixels = this.#model.pixelsBySurvey.get(surveyId)?.length
      ? this.#model.pixelsBySurvey.get(surveyId)
      : [...this.#workspaceLayers.values()].filter((layer) => layer.surveyId === surveyId).flatMap((layer) => layer.pixels);
    if (!pixels?.length || !this.#visibleSurveyIds.has(surveyId)) return;
    this.#focusedSurveyId = surveyId;
    this.#applyFocus();
    const direction = this.#pixelDirection(
      largestConnectedPixelComponent(pixels, this.#manifest.nside),
    );
    const outer = this.#outerRadius;
    const tangent = Math.abs(direction.y) > 0.9
      ? new THREE.Vector3(1, 0, 0)
      : new THREE.Vector3(0, 1, 0).cross(direction).normalize();
    const target = direction.clone().multiplyScalar(outer * 0.16);
    const destination = direction.clone().multiplyScalar(outer * 2.75).addScaledVector(tangent, outer * 0.32);
    this.#startCameraTransition(destination, target, 680);
  }

  reset(): void {
    this.setRectangleDrawing(false);
    this.setRectangleSelection(null);
    this.#cameraTransition = null;
    this.focusData();
  }

  clearTransientState(): void {
    this.setRectangleDrawing(false);
    this.setRectangleSelection(null);
    this.#clearOverlapHover();
    this.#cameraTransition = null;
    this.#pointerStart = null;
    if (this.#clickTimer) clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    this.#focusedSurveyId = null;
    this.#focusedAssetId = null;
    this.#selectedPixels.clear();
    this.#drillFocusActive = false;
    this.#drillCells.clear();
    this.#clearExplosion(false);
    clearGroup(this.#selectionGroup);
    this.#selectionCoreMaterial = null;
    this.#selectionGlowMaterial = null;
    clearGroup(this.#drillGroup);
    clearGroup(this.#objectPointGroup);
    this.#onHover(null);
    this.#onInspection(null);
    this.#onSelection(null);
    this.#applyFocus();
    this.#emitState();
    this.#requestRender();
  }

  focusData(): void {
    this.setRectangleDrawing(false);
    this.#clearOverlapHover();
    this.#cameraTransition = null;
    this.#homeScrollProgress = 1;
    this.#viewShiftWeight = 1;
    const viewDirection = this.#dataViewDirection();
    this.#camera.position.copy(viewDirection.multiplyScalar(this.#dataViewDistance()));
    this.#controls.target.set(0, 0, 0);
    this.#camera.fov = DATA_VIEW_CAMERA_FOV_DEG;
    this.#camera.updateProjectionMatrix();
    this.#camera.up.set(0, 1, 0);
    this.#controls.enabled = true;
    this.#controls.minDistance = 0.002;
    this.#controls.update();
    this.#emitState();
    this.#requestRender();
  }

  #restoreGlobeOrbitTarget(): void {
    // Overlap focus already pivots on the globe centre; keep the camera where
    // the user left it so the coverage drawn for this view stays current.
    if (this.#controls.target.lengthSq() < 1e-12) return;
    // Older focus paths change both camera and orbit target. Rebase the camera
    // position around the old target before restoring the globe centre so the
    // next drag cannot keep orbiting the previously selected cell.
    this.#cameraTransition = null;
    const pose = recenteredOrbitPose(this.#camera.position, this.#controls.target);
    const direction = pose.cameraPosition.lengthSq() > 1e-9
      ? pose.cameraPosition.normalize()
      : this.#dataViewDirection();
    this.#camera.fov = DATA_VIEW_CAMERA_FOV_DEG;
    this.#camera.updateProjectionMatrix();
    this.#startCameraTransition(
      direction.multiplyScalar(this.#dataViewDistance()),
      pose.orbitTarget,
      520,
    );
  }

  setHomePresentation(): void {
    this.setRectangleDrawing(false);
    this.#cameraTransition = null;
    this.#homeScrollProgress = 0;
    this.#viewShiftWeight = 1;
    this.#applyHomeScrollPose();
    this.#controls.minDistance = 0.002;
    this.#emitState();
    this.#requestRender();
  }

  setHomeScrollProgress(progress: number): void {
    this.setRectangleDrawing(false);
    this.#homeScrollProgress = THREE.MathUtils.clamp(progress, 0, 1);
    this.#cameraTransition = null;
    this.#applyHomeScrollPose();
    this.#emitState();
    this.#requestRender();
  }

  transitionToDataPresentation(durationMs = 900): void {
    this.#homeScrollProgress = 1;
    this.#camera.fov = DATA_VIEW_CAMERA_FOV_DEG;
    this.#camera.updateProjectionMatrix();
    const radius = this.#outerRadius;
    this.#startCameraTransition(
      this.#dataViewDirection().multiplyScalar(this.#dataViewDistance()),
      new THREE.Vector3(),
      durationMs,
      undefined,
      1,
    );
  }

  #dataViewDirection(): THREE.Vector3 {
    return TACTICAL_VIEW_DIRECTION.clone();
  }

  #dataViewDistance(): number {
    return this.#outerRadius * TACTICAL_VIEW_DISTANCE;
  }

  /** Fraction of the viewport height by which the tactical view looks above the globe centre. */
  #tacticalShift(): number {
    if (this.#homeScrollProgress < 1) return 0;
    const radius = this.#outerRadius;
    const centred = 1 - THREE.MathUtils.smoothstep(this.#controls.target.length(), radius * 0.02, radius * 0.3);
    const close = 1 - THREE.MathUtils.smoothstep(this.#camera.position.length() / radius, 2.2, 4.2);
    return TACTICAL_VIEW_SHIFT * this.#viewShiftWeight * centred * close;
  }

  #homePresentationPose(): CameraPose {
    const radius = this.#outerRadius;
    const bounds = this.#canvas.getBoundingClientRect();
    const aspect = bounds.height > 0 ? bounds.width / bounds.height : 1.6;
    const viewDirection = new THREE.Vector3(1.18, 0.78, 1.46).normalize();
    // The hero is a partial, layered object rather than a centered globe. Keep
    // enough distance for the shells to read as separate surfaces, then move
    // the whole camera frame so the projected centre sits beyond the upper
    // left edge without changing the three-quarter viewing direction.
    const portrait = aspect < 1;
    const distance = radius * (portrait ? 2.55 : 2.35);
    const camera = viewDirection.clone().multiplyScalar(distance);
    const forward = viewDirection.clone().negate();
    const upReference = Math.abs(forward.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
    const right = new THREE.Vector3().crossVectors(forward, upReference).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();
    const fovTangent = Math.tan(THREE.MathUtils.degToRad(HOME_FOV_DEG) / 2);
    const horizontalNdc = portrait
      ? 2.5
      : THREE.MathUtils.clamp(1.92 + (2.4 - aspect) * 0.08, 1.92, 2.05);
    const verticalNdc = portrait ? 2.35 : 1.92;
    const frameShift = right.clone()
      .multiplyScalar(distance * fovTangent * aspect * horizontalNdc)
      .addScaledVector(up, -distance * fovTangent * verticalNdc);
    camera.add(frameShift);
    const target = viewDirection.clone().multiplyScalar(radius * 0.12).add(frameShift);
    return { camera, target };
  }

  #applyHomeScrollPose(): void {
    this.#clearOverlapHover();
    const progress = this.#homeScrollProgress;
    const home = this.#homePresentationPose();
    const dataDirection = this.#dataViewDirection();
    const data = {
      camera: dataDirection.multiplyScalar(this.#dataViewDistance()),
      target: new THREE.Vector3(),
    };
    this.#camera.position.lerpVectors(home.camera, data.camera, progress);
    this.#controls.target.lerpVectors(home.target, data.target, progress);
    this.#camera.fov = THREE.MathUtils.lerp(HOME_FOV_DEG, 48, progress);
    this.#camera.updateProjectionMatrix();
    this.#camera.up.copy(progress < 0.5 ? cameraUpForDirection(new THREE.Vector3(1.18, 0.78, 1.46).normalize()) : new THREE.Vector3(0, 1, 0));
    this.#controls.enabled = rectangleNavigationEnabled(progress, this.#cameraTransition !== null, this.#rectangleDrawing);
    this.#controls.update();
  }

  dispose(options: { releaseContext?: boolean } = {}): void {
    if (this.#disposed) return;
    this.setRectangleDrawing(false);
    this.#disposed = true;
    this.#clearOverlapHover();
    this.#cameraTransition = null;
    if (this.#renderFrame !== null) cancelAnimationFrame(this.#renderFrame);
    this.#renderFrame = null;
    this.#renderQueued = false;
    if (this.#clickTimer) clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    this.#resizeObserver.disconnect();
    this.#controls.removeEventListener("change", this.#handleControlsChange);
    this.#controls.removeEventListener("start", this.#handleControlsStart);
    this.#controls.removeEventListener("end", this.#handleControlsEnd);
    this.#controls.dispose();
    this.#canvas.removeEventListener("pointerdown", this.#handlePointerDown);
    this.#canvas.removeEventListener("pointerup", this.#handlePointerUp);
    this.#canvas.removeEventListener("dblclick", this.#handleDoubleClick);
    this.#canvas.removeEventListener("contextmenu", this.#handleContextMenu);
    this.#canvas.removeEventListener("pointermove", this.#handlePointerMove);
    this.#canvas.removeEventListener("pointerleave", this.#handlePointerLeave);
    this.#canvas.removeEventListener("pointercancel", this.#handlePointerCancel);
    this.#canvas.removeEventListener("lostpointercapture", this.#handleLostPointerCapture);
    window.removeEventListener("keydown", this.#handleRectangleKeyDown, true);
    window.removeEventListener("blur", this.#handleRectangleBlur);
    this.#skyDepth.clear();
    disposeObject(this.#scene);
    disposeRenderer(this.#renderer, options.releaseContext !== false);
  }

  #rebuildVisible(animated: boolean): void {
    this.#onHover(null);
    this.#clearOverlapHover();
    this.#clearExplosion(false);
    if (!animated) {
      this.#fragmentTransitions.length = 0;
      clearGroup(this.#retiredGroup);
    }
    this.#retireCoverage(animated);
    const depths = this.#displayDepths();
    const depthByKey = new Map(depths.map((depth) => [depth.key, depth]));
    depths.forEach((depth) => {
      if (!depth.key.startsWith("public-survey:")) return;
      this.#buildSurveyLayer(depth.key.slice("public-survey:".length), depth.radius, animated, depth.renderOrder);
    });
    if (this.#overlapMode) this.#buildOverlapLayer(animated);
    this.#rebuildWorkspaceCoverage(depthByKey);
    this.#rebuildHudOutlines(depths);
    this.#fitBackdrop();
    this.#buildInteractionLayer();
    this.#controls.minDistance = 0.002;
    this.#keepCameraOutside();
    this.#renderSelectionRegion();
    if (this.#skyDepthData && Math.abs((this.#skyDepth.layout?.surfaceRadius ?? 0) - this.#outerRadius - .014) > .0001) this.setSkyDepth(this.#skyDepthData, this.#onSkyDepthPick ?? undefined);
    this.#applyFocus();
    this.#emitState();
    this.#requestRender();
  }

  /** Keep the opaque sky body just beneath the innermost drawn surface. */
  #fitBackdrop(): void {
    const radii = [1, ...this.#displayDepths().map((depth) => depth.radius)];
    this.#explodedFragments.forEach((fragment) => radii.push(fragment.root.userData.sourceRadius ?? 1, fragment.root.userData.targetRadius ?? 1));
    this.#hudBackdrop.group.scale.setScalar(Math.max(0.05, Math.min(...radii) - 0.004));
  }

  #buildSurveyLayer(surveyId: string, radius: number, animated: boolean, renderOrder = 4): void {
    const pixels = this.#model.pixelsBySurvey.get(surveyId) ?? [];
    if (!pixels.length) return;
    const color = this.#surveyColor(surveyId);
    const visibleSurveyCount = [...this.#visibleSurveyIds]
      .filter((visibleSurveyId) => (this.#model.pixelsBySurvey.get(visibleSurveyId)?.length ?? 0) > 0)
      .length;
    const singleSurveySourceMode = !this.#overlapMode && visibleSurveyCount === 1;
    const sourceIdentities = singleSurveySourceMode ? this.#model.sourceIdentitiesBySurvey.get(surveyId) ?? [] : [];
    const sourceIndexByIdentity = new Map(sourceIdentities.map((identity, index) => [identity, index]));
    const sourceColor = (identity: string): THREE.Color => sourceVariantColor(color, sourceIndexByIdentity.get(identity) ?? 0, Math.max(1, sourceIdentities.length));
    const cells = pixels.map((pixel) => {
      const sources = this.#model.sourcesBySurveyPixel.get(surveyId)?.get(pixel) ?? [];
      return this.#cellInput(pixel, radius, singleSurveySourceMode && sources.length ? sourceColor(sources[0]!.identity) : color);
    });
    let sourceGeometry: THREE.BufferGeometry | undefined;
    if (singleSurveySourceMode) {
      const sourceCells = pixels.flatMap((pixel) => {
        const sources = (this.#model.sourcesBySurveyPixel.get(surveyId)?.get(pixel) ?? [])
          .filter((source, index, values) => values.findIndex((candidate) => candidate.identity === source.identity) === index);
        if (sources.length < 2) return [];
        return [{
          nside: this.#manifest.nside,
          pixel,
          radius: radius + 0.002,
          colors: sources.map((source) => sourceColor(source.identity)),
          inset: 0,
        }];
      });
      if (sourceCells.length) sourceGeometry = buildSphericalCellSourceSectorGeometry(sourceCells);
    }
    this.#addFragmentLayer(
      surveyId,
      pixels,
      cells,
      animated,
      renderOrder,
      undefined,
      sourceGeometry,
    );
  }

  #buildOverlapLayer(animated: boolean): void {
    const counts = overlapCountByPixel(this.#model, this.#visibleSurveyIds);
    const selectedSurveys = [...this.#visibleSurveyIds];
    if (selectedSurveys.length < 2) return;
    const nside = this.#overlapNside ?? this.#manifest.nside;
    const pixels = this.#overlapPixels ?? [...counts.entries()].filter(([, count]) => count === selectedSurveys.length).map(([pixel]) => pixel).sort((left, right) => left - right);
    this.#renderedOverlapPixels = pixels;
    if (!pixels.length) return;
    // Lift the common cells above the co-registered survey surfaces so the
    // filled result remains visible without exposing the far hemisphere.
    const overlapRadius = Math.max(1.02, this.#outerRadius + 0.012);
    const cells = pixels.map((pixel) => ({ nside, pixel, radius: overlapRadius, color: OVERLAP_COLOR, inset: 0 }));
    if (cells.length) this.#addFragmentLayer("__overlap__", pixels, cells, animated, SELECTION_RENDER_ORDER - 1);
    this.#rebuildOverlapLabels(nside, pixels, overlapRadius);
  }

  #rebuildOverlapLabels(nside = this.#overlapNside ?? this.#manifest.nside, pixels = this.#renderedOverlapPixels, overlapRadius = Math.max(1.02, this.#outerRadius + 0.012)): void {
    clearGroup(this.#overlapLabelGroup);
    if (!this.#overlapMode || !pixels.length) return;
    const components = this.#overlapPickingMode === "component" || (this.#overlapComponents.length && this.#overlapComponents[0]!.order === Math.round(Math.log2(nside)))
      ? this.#overlapComponents
      : overlapComponentsForPixels(pixels, nside);
    components.forEach((component) => {
      if (component.id === this.#activeOverlapComponentId || !component.cells.length) return;
      const labelScale = 2 ** -Math.max(0, component.order - 4);
      const labelNside = this.#overlapPickingMode === "component" ? 2 ** component.order : nside;
      const label = countLabelSprite(component.id, this.#pixelDirectionAt(labelNside, component.cells).multiplyScalar(overlapRadius + 0.025), true, labelScale);
      label.userData = { overlapComponent: component };
      this.#overlapLabelGroup.add(label);
    });
  }

  #buildInteractionLayer(): void {
    if (this.#interactionMesh) {
      this.#scene.remove(this.#interactionMesh);
      disposeObject(this.#interactionMesh);
      this.#interactionMesh = null;
    }
    const pixels = [...new Set([
      ...overlapCountByPixel(this.#model, this.#visibleSurveyIds).keys(),
      ...Array.from(this.#workspaceLayers.values()).filter((layer) => this.#workspaceLayerVisible(layer)).flatMap((layer) => layer.pixels),
    ])].sort((left, right) => left - right);
    if (!pixels.length) return;
    const cells = pixels.map((pixel) => ({
      nside: this.#manifest.nside,
      pixel,
      radius: 1,
      color: BASE_COLOR,
      inset: 0,
    }));
    const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false, depthWrite: false, toneMapped: false });
    const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), material) as LayerMesh;
    mesh.userData = { surveyId: "__interaction__", records: pixels.map((pixel) => ({ pixel })) };
    mesh.renderOrder = -1;
    this.#interactionMesh = mesh;
    this.#scene.add(mesh);
  }

  #rebuildWorkspaceCoverage(depthByKey = new Map(this.#displayDepths().map((depth) => [depth.key, depth]))): void {
    clearGroup(this.#workspaceCoverageGroup);
    this.#workspaceDisplayLayers(depthByKey).forEach(({ layer, radius, color, renderOrder }) => {
      if (!layer.pixels.length) return;
      const cells = layer.pixels.map((pixel) => ({ nside: this.#manifest.nside, pixel, radius, color, inset: 0.018 }));
      const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry(cells), applyCellRim(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.14, side: THREE.DoubleSide, depthTest: true, depthWrite: false, blending: coverageBlending(), toneMapped: false }))) as LayerMesh;
      mesh.userData = {
        layerKey: layer.key,
        assetId: this.#workspaceLayerAssetIds(layer)[0],
        records: layer.pixels.map((pixel) => ({ pixel })),
      };
      mesh.renderOrder = renderOrder;
      const edges = new THREE.LineSegments(buildSphericalCellEdges(cells), new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.3, depthTest: true, depthWrite: false, toneMapped: false }));
      edges.renderOrder = renderOrder + 1;
      this.#workspaceCoverageGroup.add(mesh, edges);
    });
    this.#requestRender();
  }

  #workspaceLayerVisible(layer: WorkspaceCoverageLayer): boolean {
    const key = this.#workspaceLayerKey(layer);
    // Explicit MOC layers have their own visibility toggle even when the
    // coverage payload records the source asset as well.
    if (key.startsWith("moc:")) return this.#visibleWorkspaceLayerKeys.has(key);
    const assetIds = this.#workspaceLayerAssetIds(layer);
    if (assetIds.length) return assetIds.some((assetId) => this.#visibleAssetIds.has(assetId));
    return this.#visibleSurveyIds.has(layer.surveyId ?? "__unassigned__");
  }

  #workspaceLayerAssetIds(layer: WorkspaceCoverageLayer): string[] {
    return [...new Set([...(layer.assetIds ?? []), ...(layer.assetId ? [layer.assetId] : [])])].sort();
  }

  #workspaceLayerKey(layer: WorkspaceCoverageLayer): string {
    if (layer.key?.startsWith("moc:")) return layer.key;
    const assetId = this.#workspaceLayerAssetIds(layer)[0];
    if (assetId) return `asset:${assetId}`;
    if (layer.artifactId) return `moc:${layer.artifactId}`;
    if (layer.key) return layer.key;
    if (layer.layerId) return `workspace:${layer.layerId}`;
    if (layer.surveyId) return `workspace:${layer.surveyId}`;
    return "workspace-unassigned";
  }

  #knownLayerKeys(): string[] {
    return [
      ...this.#model.slots.filter((slot) => slot.hasFootprint).map((slot) => `public-survey:${slot.surveyId}`),
      ...[...this.#workspaceLayers.values()].map((layer) => this.#workspaceLayerKey(layer)),
    ];
  }

  #defaultLayerOrder(): string[] {
    return this.#knownLayerKeys();
  }

  #normalizedLayerOrder(): string[] {
    return normalizeLayerOrder(this.#knownLayerKeys(), this.#layerOrder, this.#defaultLayerOrder());
  }

  #visibleLayerKeys(): string[] {
    const keys: string[] = [];
    this.#model.slots.forEach((slot) => {
      if (slot.hasFootprint && this.#visibleSurveyIds.has(slot.surveyId)) keys.push(`public-survey:${slot.surveyId}`);
    });
    this.#workspaceLayers.forEach((layer) => {
      if (this.#workspaceLayerVisible(layer) && layer.pixels.length) keys.push(this.#workspaceLayerKey(layer));
    });
    return keys;
  }

  #displayDepths(): LayerDepth[] {
    const order = this.#normalizedLayerOrder();
    const visible = this.#visibleLayerKeys();
    return visibleLayerDepths(order, visible, this.#layoutMode, this.#layerRadiusRange);
  }

  /** Radial band used to separate survey shells in layer mode. */
  setLayerRadiusRange(min: number, max: number): void {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return;
    if (this.#layerRadiusRange.min === min && this.#layerRadiusRange.max === max) return;
    this.#layerRadiusRange = { min, max };
    this.#rebuildVisible(false);
  }

  #visibleWorkspaceLayerAssetIds(layer: WorkspaceCoverageLayer): string[] {
    return this.#workspaceLayerAssetIds(layer).filter((assetId) => this.#visibleAssetIds.has(assetId));
  }

  #workspaceDisplayLayers(depthByKey = new Map(this.#displayDepths().map((depth) => [depth.key, depth]))): Array<{ layer: WorkspaceCoverageLayer; radius: number; color: THREE.Color; renderOrder: number }> {
    return [...this.#workspaceLayers.values()]
      .filter((layer) => this.#workspaceLayerVisible(layer) && layer.pixels.length)
      .map((layer) => {
      const key = this.#workspaceLayerKey(layer);
      const depth = depthByKey.get(key);
      if (!depth) return null;
      const assetIds = this.#workspaceLayerAssetIds(layer);
      const color = layer.color
        ? new THREE.Color(layer.color)
        : assetIds.length
          ? deterministicWorkspaceColor(assetIds[0]!)
          : layer.surveyId ? this.#colorBySurvey.get(layer.surveyId) ?? WORKSPACE_COLOR : WORKSPACE_COLOR;
      return { layer, radius: depth.radius, color, renderOrder: depth.renderOrder };
    }).filter((entry): entry is { layer: WorkspaceCoverageLayer; radius: number; color: THREE.Color; renderOrder: number } => entry !== null);
  }

  #drillCellColor(cell: SurveyDrillCell): THREE.Color {
    const dominant = [...cell.layers].sort((left, right) => right.count - left.count)[0];
    if (dominant?.color) return new THREE.Color(dominant.color);
    if (dominant?.assetId) return deterministicWorkspaceColor(dominant.assetId);
    if (dominant?.surveyId) return this.#surveyColor(dominant.surveyId);
    const ratio = Math.min(1, cell.count / Math.max(1, ...[...this.#drillCells.values()].map((candidate) => candidate.count)));
    return BASE_COLOR.clone().lerp(OVERLAP_COLOR, ratio);
  }

  #objectPointAt(event: PointerCoordinates): SurveyObjectPoint | null {
    const intersections = this.#raycaster.intersectObjects([this.#objectPointGroup], true);
    const hit = intersections.find((candidate) => candidate.object instanceof THREE.Points);
    if (!hit || hit.index == null) return null;
    const points = hit.object.userData.points as SurveyObjectPoint[] | undefined;
    return points?.[hit.index] ?? null;
  }

  #workspaceAvailableAt(pixel: number): boolean {
    return [...this.#workspaceLayers.values()].some((layer) => !layer.preview && this.#workspaceLayerVisible(layer) && layer.pixels.includes(pixel));
  }

  #workspaceInteractiveAt(pixel: number): boolean {
    return [...this.#workspaceLayers.values()].some((layer) => this.#workspaceLayerVisible(layer) && layer.pixels.includes(pixel));
  }

  #workspaceMembershipAt(pixel: number): { surveyIds: string[]; releaseIds: string[]; assetIds: string[]; layers: WorkspaceCoverageMembership[] } {
    const layers = [...this.#workspaceLayers.values()].filter((layer) => this.#workspaceLayerVisible(layer) && layer.pixels.includes(pixel));
    return {
      surveyIds: [...new Set(layers.map((layer) => layer.surveyId).filter((value): value is string => Boolean(value)))].sort(),
      releaseIds: [...new Set(layers.map((layer) => layer.releaseId).filter((value): value is string => Boolean(value)))].sort(),
      assetIds: [...new Set(layers.flatMap((layer) => this.#visibleWorkspaceLayerAssetIds(layer)))].sort(),
      layers: layers.map((layer) => {
        const assetIds = this.#visibleWorkspaceLayerAssetIds(layer);
        return {
          key: layer.key ?? layer.surveyId ?? "__unassigned__",
          assetId: layer.assetId && assetIds.includes(layer.assetId) ? layer.assetId : assetIds.length === 1 ? assetIds[0] : undefined,
          assetIds,
          assetName: layer.assetName,
          status: layer.status,
          surveyId: layer.surveyId,
          releaseId: layer.releaseId,
          productId: layer.productId,
          modality: layer.modality,
          source: layer.source,
          message: layer.message,
        };
      }).sort((left, right) => left.key.localeCompare(right.key)),
    };
  }

  #cellInput(pixel: number, radius: number, color: THREE.Color): SphericalCellSheetGeometryInput {
    return {
      nside: this.#manifest.nside,
      pixel,
      radius,
      color,
      // The base surface must remain continuous. Source variants are a
      // separate, slightly lifted overlay and must never create holes.
      inset: 0,
    };
  }

  #addFragmentLayer(
    surveyId: string,
    pixels: number[],
    cells: SphericalCellSheetGeometryInput[],
    animated: boolean,
    renderOrder = 4,
    customGeometry?: THREE.BufferGeometry,
    overlayGeometry?: THREE.BufferGeometry,
  ): void {
    const root = new THREE.Group();
    root.scale.setScalar(animated ? 0.94 : 1);
    const isOverlap = surveyId === "__overlap__";
    const meshOpacity = isOverlap ? OVERLAP_FILL_OPACITY : COVERAGE_OPACITY;
    const lineOpacity = isOverlap ? OVERLAP_EDGE_OPACITY : COVERAGE_EDGE_OPACITY;
    let material: THREE.MeshBasicMaterial;
    let overlayMaterial: THREE.MeshBasicMaterial | null = null;
    let mesh: LayerMesh;
    const transitionLineMaterials: THREE.LineBasicMaterial[] = [];
    if (!isOverlap) {
      material = fragmentMaterial();
      material.opacity = animated ? 0 : meshOpacity;
      mesh = new THREE.Mesh(customGeometry ?? buildSphericalCellSheetGeometry(cells), material) as LayerMesh;
      mesh.userData = { surveyId, records: pixels.map((pixel) => ({ pixel })) };
      mesh.renderOrder = renderOrder;
      overlayMaterial = overlayGeometry ? fragmentMaterial() : null;
      if (overlayMaterial && overlayGeometry) {
        this.#coverageSourceMaterials.push(overlayMaterial);
        overlayMaterial.opacity = animated ? 0 : meshOpacity;
        const overlay = new THREE.Mesh(overlayGeometry, overlayMaterial);
        overlay.renderOrder = renderOrder + 1;
        root.add(overlay);
      }
      const lineMaterial = applyNeutralDepth(new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: animated ? 0 : lineOpacity, depthTest: true, depthWrite: false, blending: coverageBlending(), toneMapped: false }));
      this.#coverageEdgeMaterials.push(lineMaterial);
      const edges = new THREE.LineSegments(buildSphericalCellEdges(cells), lineMaterial);
      edges.renderOrder = renderOrder + 1;
      root.add(mesh, edges);
      transitionLineMaterials.push(lineMaterial);
    } else {
      const highlight = buildOverlapHighlight(cells, renderOrder, animated ? 0 : meshOpacity, this.#lineResolution, this.#overlapStyle(false));
      material = highlight.meshMaterial;
      mesh = highlight.mesh as LayerMesh;
      mesh.userData = { surveyId, records: pixels.map((pixel) => ({ pixel })) };
      root.add(...highlight.root.children);
    }
    this.#coverageGroup.add(root);
    this.#layerMeshes.push(mesh);
    if (surveyId !== "__overlap__") this.#meshBySurvey.set(surveyId, mesh);
    if (animated) {
      this.#fragmentTransitions.push({
        root,
        startedAt: performance.now(),
        durationMs: 430,
        direction: "in",
        meshMaterials: [material, ...(overlayMaterial ? [overlayMaterial] : [])],
        lineMaterials: transitionLineMaterials,
        meshOpacity,
        lineOpacity,
      });
    }
  }

  #retireCoverage(animated: boolean): void {
    this.#layerMeshes.length = 0;
    this.#coverageEdgeMaterials.length = 0;
    this.#coverageSourceMaterials.length = 0;
    this.#renderedOverlapPixels = [];
    clearGroup(this.#overlapLabelGroup);
    this.#meshBySurvey.clear();
    for (const root of [...this.#coverageGroup.children] as THREE.Group[]) {
      this.#coverageGroup.remove(root);
      if (!animated) {
        disposeObject(root);
        continue;
      }
      this.#retiredGroup.add(root);
      const meshMaterials: THREE.MeshBasicMaterial[] = [];
      const lineMaterials: THREE.LineBasicMaterial[] = [];
      root.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) meshMaterials.push(child.material);
        if (child instanceof THREE.LineSegments && child.material instanceof THREE.LineBasicMaterial) lineMaterials.push(child.material);
      });
      this.#fragmentTransitions.push({
        root,
        startedAt: performance.now(),
        durationMs: 260,
        direction: "out",
        meshMaterials,
        lineMaterials,
        meshOpacity: root.getObjectByProperty("type", "Mesh")?.userData?.surveyId === "__overlap__" ? OVERLAP_FILL_OPACITY : COVERAGE_OPACITY,
        lineOpacity: root.getObjectByProperty("type", "Mesh")?.userData?.surveyId === "__overlap__" ? OVERLAP_EDGE_OPACITY : COVERAGE_EDGE_OPACITY,
      });
    }
  }

  #applyFocus(): void {
    for (const [surveyId, mesh] of this.#meshBySurvey) {
      mesh.material.opacity = this.#skyDepth.layout?.items.length ? .055 : this.#overlapMode
        ? OVERLAP_SURVEY_OPACITY
        : this.#focusedSurveyId === surveyId
        ? 0.52
        : this.#drillFocusActive || this.#selectedPixels.size > 0 || this.#explodedPixel != null
        ? DIMMED_OPACITY
        : COVERAGE_OPACITY;
    }
    this.#workspaceCoverageGroup.traverse((child) => {
      if (!(child instanceof THREE.Mesh) || !(child.material instanceof THREE.MeshBasicMaterial)) return;
      const assetId = child.userData.assetId;
      child.material.opacity = this.#focusedAssetId && assetId === this.#focusedAssetId
        ? 0.42
        : this.#drillFocusActive || this.#selectedPixels.size > 0 || this.#explodedPixel != null
        ? DIMMED_OPACITY
        : 0.14;
    });
    const edgeOpacity = this.#skyDepth.layout?.items.length ? .065 : this.#overlapMode ? OVERLAP_EDGE_OPACITY : this.#drillFocusActive || this.#selectedPixels.size > 0 || this.#explodedPixel != null ? DIMMED_EDGE_OPACITY : COVERAGE_EDGE_OPACITY;
    this.#coverageEdgeMaterials.forEach((material) => { material.opacity = edgeOpacity; });
    this.#coverageSourceMaterials.forEach(material => { material.opacity = this.#skyDepth.layout?.items.length ? .055 : COVERAGE_OPACITY; });
    // Depth view reverts coverage to normal blending, as before the HUD, so
    // the dimmed sky stays neutral behind the measured points.
    const blending = this.#depthActive() ? THREE.NormalBlending : coverageBlending();
    this.#coverageGroup.traverse((child) => {
      const material = (child as THREE.Mesh).material as THREE.Material | undefined;
      if (material && !Array.isArray(material) && material.blending !== blending && ((child as THREE.Mesh).isMesh || (child as THREE.LineSegments).isLineSegments)) material.blending = blending;
    });
    this.#applyHudOutlineOpacity();
    this.#applyPostTheme();
    this.#requestRender();
  }

  #pickCell(event: PointerCoordinates): { pixel: number; nside: number; membership: CoverageCellMembership | null; workspaceAvailable: boolean; workspaceInteractive: boolean; point: THREE.Vector3 } | null {
    const bounds = this.#canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    const renderedHit = this.#raycaster.intersectObjects([this.#drillGroup, this.#workspaceCoverageGroup], true).find((hit) => {
      const object = hit.object as Partial<LayerMesh>;
      return Boolean(object.userData?.records?.length);
    });
    let renderedPixel: number | undefined;
    let renderedNside = this.#drillNside;
    if (renderedHit) {
      const object = renderedHit.object as LayerMesh;
      const records = object.userData.records;
      const record = records[Math.max(0, Math.floor((renderedHit.faceIndex ?? 0) / 2))] ?? records[0];
      renderedPixel = record?.pixel;
      if (object.userData.drill) renderedNside = this.#drillNside;
      else renderedNside = [...this.#workspaceLayers.values()].find((layer) => layer.key === object.userData.layerKey)?.nside ?? this.#manifest.nside;
    }
    // Angular picking keeps inset gaps selectable, while a rendered shell hit preserves
    // the actual asset or drill cell beneath the pointer.
    const unitPoint = this.#intersectUnitSphere(this.#raycaster.ray);
    if (this.#overlapMode && this.#overlapNside !== null && this.#overlapPixels !== null) {
      if (!unitPoint && !renderedHit) return null;
      const point = unitPoint ?? renderedHit!.point.clone().normalize();
      const pixel = healpixPixelFromSceneDirection(this.#overlapNside, point);
      if (!this.#overlapPixelSet.has(pixel)) return null;
      const membership = this.#overlapNside === this.#manifest.nside
        ? visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds)
        : null;
      return { pixel, nside: this.#overlapNside, membership, workspaceAvailable: false, workspaceInteractive: false, point };
    }
    if (!unitPoint && !renderedHit) return null;
    const point = unitPoint ?? renderedHit!.point.clone().normalize();
    const nside = renderedPixel == null ? this.#manifest.nside : renderedNside;
    const pixel = renderedPixel ?? healpixPixelFromSceneDirection(nside, point);
    const membership = nside === this.#manifest.nside ? visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds) : null;
    const workspaceAvailable = nside === this.#manifest.nside && this.#workspaceAvailableAt(pixel);
    const workspaceInteractive = nside === this.#manifest.nside && this.#workspaceInteractiveAt(pixel);
    const drillAvailable = nside === this.#drillNside && this.#drillCells.has(pixel);
    if (!membership && !workspaceInteractive && !drillAvailable && this.#interactionMode !== "region") {
      // A layer drawn off the unit sphere can sit under the pointer while the
      // unit-sphere ray lands in an uncovered neighbour; fall back to the shell.
      const shell = this.#pickShellCell();
      if (!shell) return null;
      const shellMembership = shell.nside === this.#manifest.nside ? visibleCoverageAtPixel(this.#model, shell.pixel, this.#visibleSurveyIds) : null;
      const shellAvailable = shell.nside === this.#manifest.nside && this.#workspaceAvailableAt(shell.pixel);
      const shellInteractive = shell.nside === this.#manifest.nside && this.#workspaceInteractiveAt(shell.pixel);
      if (!shellMembership && !shellInteractive) return null;
      return { ...shell, membership: shellMembership, workspaceAvailable: shellAvailable, workspaceInteractive: shellInteractive };
    }
    return { pixel, nside, membership, workspaceAvailable: workspaceAvailable || drillAvailable, workspaceInteractive: workspaceInteractive || drillAvailable, point };
  }

  /** Nearest drawn coverage cell under the current ray, intersected at each layer's own radius. */
  #pickShellCell(): { pixel: number; nside: number; point: THREE.Vector3 } | null {
    this.#scene.updateMatrixWorld(true);
    let best: { pixel: number; nside: number; point: THREE.Vector3 } | null = null;
    let nearest = Infinity;
    const vertex = new THREE.Vector3();
    for (const group of [this.#workspaceCoverageGroup, this.#coverageGroup]) {
      group.traverse((object) => {
        const mesh = object as Partial<LayerMesh> & THREE.Object3D;
        const records = mesh.userData?.records;
        if (!(object instanceof THREE.Mesh) || !object.visible || !records?.length || mesh.userData?.drill) return;
        const position = object.geometry.getAttribute("position");
        if (!position?.count) return;
        const radius = vertex.fromBufferAttribute(position, 0).applyMatrix4(object.matrixWorld).length();
        const point = this.#intersectSphere(this.#raycaster.ray, radius);
        if (!point) return;
        const distance = point.distanceTo(this.#raycaster.ray.origin);
        if (distance >= nearest) return;
        const layerKey = mesh.userData?.layerKey;
        const nside = layerKey ? [...this.#workspaceLayers.values()].find((layer) => layer.key === layerKey)?.nside ?? this.#manifest.nside : this.#manifest.nside;
        const pixel = healpixPixelFromSceneDirection(nside, point);
        if (!records.some((record) => record.pixel === pixel)) return;
        best = { pixel, nside, point: point.normalize() };
        nearest = distance;
      });
    }
    return best;
  }

  #pickObject(event: PointerCoordinates): SurveyObjectPoint | null {
    const bounds = this.#canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    return this.#objectPointAt(event);
  }

  #pickOverlapComponent(event: PointerCoordinates): SurveyLayerOverlapComponent | null {
    const bounds = this.#canvas.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return null;
    this.#pointer.set(((event.clientX - bounds.left) / bounds.width) * 2 - 1, -((event.clientY - bounds.top) / bounds.height) * 2 + 1);
    this.#raycaster.setFromCamera(this.#pointer, this.#camera);
    this.#scene.updateMatrixWorld(true);
    const hit = this.#raycaster.intersectObjects([this.#overlapLabelGroup], true)[0];
    const label = hit?.object.userData.overlapComponent as SurveyLayerOverlapComponent | undefined;
    // Keep legacy label-only picking (including generated labels) by default.
    if (this.#overlapPickingMode === "cell") return label ?? null;
    const component = label && this.#overlapComponents.find((entry) => entry.id === label.id && entry.order === label.order);
    if (component) return component;
    // Hit the actual drawn sheets, including the active component's higher
    // surface and any in-flight layer scale. A guessed sphere shifts fine-cell
    // membership and misses the active fill at the limb.
    const active = this.#overlapComponents.find((entry) => entry.id === this.#activeOverlapComponentId);
    const activeMesh = active ? this.#activeOverlapHighlight?.mesh : null;
    const surfaces: THREE.Object3D[] = this.#layerMeshes.filter((mesh) => mesh.userData.surveyId === "__overlap__");
    if (activeMesh) surfaces.push(activeMesh);
    // The backdrop disables its normal raycast for cell picking. Check its
    // opaque body explicitly so only surfaces visible in front of it can win.
    const occluders: THREE.Intersection[] = [];
    this.#hudBackdrop.group.traverse((object) => {
      if (object instanceof THREE.Mesh && !Array.isArray(object.material) && object.material.depthWrite && !object.material.transparent) {
        THREE.Mesh.prototype.raycast.call(object, this.#raycaster, occluders);
      }
    });
    const foregroundDistance = Math.min(...occluders.map((hit) => hit.distance));
    for (const surface of this.#raycaster.intersectObjects(surfaces, false)) {
      if (!surface.object.visible || surface.faceIndex == null || foregroundDistance < surface.distance) continue;
      const recordIndex = Math.floor(surface.faceIndex / TRIANGLES_PER_SPHERICAL_CELL_SHEET);
      if (surface.object === activeMesh && active) {
        const pixel = active.cells[recordIndex];
        if (pixel !== undefined) return overlapComponentAtPixel([active], active.order, pixel);
        continue;
      }
      const record = (surface.object as LayerMesh).userData.records[recordIndex];
      if (!record) continue;
      const order = Math.round(Math.log2(this.#overlapNside ?? this.#manifest.nside));
      // At the rendered order use the hit triangle's real cell, not a curved
      // HEALPix boundary approximation. Other orders still need exact membership
      // in their supplied cells, evaluated at this rendered hit's direction.
      for (const componentOrder of new Set(this.#overlapComponents.map((entry) => entry.order))) {
        if (!Number.isInteger(componentOrder) || componentOrder < 0) continue;
        const pixel = componentOrder === order ? record.pixel : healpixPixelFromSceneDirection(2 ** componentOrder, surface.point);
        const member = overlapComponentAtPixel(this.#overlapComponents, componentOrder, pixel);
        if (member) return member;
      }
    }
    return null;
  }

  #intersectUnitSphere(ray: THREE.Ray): THREE.Vector3 | null {
    return this.#intersectSphere(ray, 1);
  }

  #intersectSphere(ray: THREE.Ray, radius: number): THREE.Vector3 | null {
    const origin = ray.origin;
    const direction = ray.direction;
    const a = direction.lengthSq();
    if (a === 0) return null;
    const b = 2 * origin.dot(direction);
    const c = origin.lengthSq() - radius * radius;
    const discriminant = b * b - 4 * a * c;
    if (discriminant < 0) return null;
    const sqrt = Math.sqrt(discriminant);
    const tNear = (-b - sqrt) / (2 * a);
    const tFar = (-b + sqrt) / (2 * a);
    const t = tNear > 1e-5 ? tNear : tFar > 1e-5 ? tFar : null;
    if (t == null) return null;
    return origin.clone().addScaledVector(direction, t);
  }

  #inspect(event: PointerCoordinates): void {
    const hit = this.#pickCell(event);
    if (!hit?.membership && !hit?.workspaceInteractive) {
      this.#clearExplosion(true);
      this.#onInspection(null);
      this.#emitState();
      return;
    }
    if (this.#explodedPixel === hit.pixel && this.#explodedNside === hit.nside) {
      this.#clearExplosion(true);
      this.#onInspection(null);
      this.#emitState();
      return;
    }
    this.#presentInspection(hit.nside, hit.pixel, hit.membership ?? { surveyIds: [], releaseIds: [], artifacts: [] }, hit.workspaceAvailable, hit.point, false);
    if (hit.membership && hit.membership.surveyIds.length > 1) {
      this.#explodeInspection(hit.nside, hit.pixel, hit.membership, false);
    }
    this.#emitState();
  }

  #presentInspection(nside: number, pixel: number, membership: CoverageCellMembership, workspaceAvailable: boolean, point: THREE.Vector3, rotateCamera: boolean): void {
    this.#clearExplosion(false);
    const pointer = cartesianToRaDec(point);
    const center = cartesianToRaDec(this.#pixelDirectionAt(nside, [pixel]));
    const workspace = nside === this.#manifest.nside ? this.#workspaceMembershipAt(pixel) : { surveyIds: [], releaseIds: [], assetIds: [], layers: [] };
    this.#onInspection({
      kind: "coverage-cell",
      nside,
      pixel,
      surveyIds: [...new Set([...membership.surveyIds, ...workspace.surveyIds])].sort(),
      releaseIds: [...new Set([...membership.releaseIds, ...workspace.releaseIds])].sort(),
      assetIds: workspace.assetIds,
      workspaceLayers: workspace.layers,
      artifacts: membership.artifacts,
      pointerRaDeg: pointer.raDeg,
      pointerDecDeg: pointer.decDeg,
      centerRaDeg: center.raDeg,
      centerDecDeg: center.decDeg,
      workspaceAvailable,
    });
    void rotateCamera;
  }

  #select(event: PointerCoordinates, additive: boolean): void {
    const hit = this.#pickCell(event);
    if (!hit) return;
    this.#onHover(null);
    if (!additive) {
      this.#selectedPixels.clear();
      this.#selectedPixels.add(hit.pixel);
    } else if (this.#selectedPixels.has(hit.pixel)) this.#selectedPixels.delete(hit.pixel);
    else this.#selectedPixels.add(hit.pixel);
    this.#renderSelectionRegion();
    this.#emitSelection();
  }

  #renderSelectionRegion(): void {
    clearGroup(this.#selectionGroup);
    this.#selectionCoreMaterial = null;
    this.#selectionGlowMaterial = null;
    this.#selectionBracketMaterial = null;
    this.#selectionBox = null;
    delete this.#canvas.dataset.selectionVolume;
    delete this.#canvas.dataset.selectionDepthKeys;
    delete this.#canvas.dataset.selectionDepthRadii;
    delete this.#canvas.dataset.selectionEdgeLayers;
    this.#applyFocus();
    if (!this.#selectedPixels.size) return;
    const selected = [...this.#selectedPixels];
    const radius = this.#outerRadius + .014;
    // Target lock: magenta glow and a crisp edge around the selected region,
    // plus corner brackets on each cell while the selection stays small.
    const outline = regionOutlinePositions(this.#manifest.nside, selected, radius);
    const additive = this.#palette.additiveCoverage;
    const glowEdges = fatLines(outline, SELECTION_COLOR, additive ? 14 : 6, 0.42, this.#lineResolution, { additive, depthTest: false, renderOrder: SELECTION_RENDER_ORDER });
    const coreEdges = fatLines(outline, SELECTION_EDGE_COLOR, 2.2, 0.96, this.#lineResolution, { depthTest: false, renderOrder: SELECTION_RENDER_ORDER + 1 });
    this.#selectionCoreMaterial = coreEdges.material;
    this.#selectionGlowMaterial = glowEdges.material;
    const fill = new THREE.Mesh(
      buildSphericalCellSheetGeometry(selected.map((pixel) => ({ nside: this.#manifest.nside, pixel, radius: radius - 0.001, color: SELECTION_COLOR }))),
      applyCellRim(new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: additive ? 0.9 : 0.32, side: THREE.DoubleSide, depthTest: false, depthWrite: false, blending: coverageBlending(), toneMapped: false })),
    );
    fill.renderOrder = SELECTION_RENDER_ORDER - 1;
    fill.raycast = () => undefined;
    fill.name = "selection-fill";
    glowEdges.name = "selection-glow";
    this.#selectionGroup.add(fill, glowEdges, coreEdges);
    {
      // Target box: the selected region as a prism standing on the sky,
      // top outline, vertical edges at each boundary corner and a glow.
      const height = Math.min(0.12, 1.4 / Math.sqrt(12 * this.#manifest.nside ** 2) + 0.02);
      const top = regionOutlinePositions(this.#manifest.nside, selected, radius + height);
      const posts: number[] = [];
      const seen = new Set<string>();
      for (let index = 0; index < outline.length; index += 3) {
        const point = new THREE.Vector3(outline[index]!, outline[index + 1]!, outline[index + 2]!);
        const key = `${point.x.toFixed(5)},${point.y.toFixed(5)},${point.z.toFixed(5)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (seen.size > 64) break;
        const lifted = point.clone().multiplyScalar((radius + height) / radius);
        posts.push(point.x, point.y, point.z, lifted.x, lifted.y, lifted.z);
      }
      const box = fatLines([...top, ...posts], SELECTION_EDGE_COLOR, 1.6, 0.9, this.#lineResolution, { depthTest: false, renderOrder: SELECTION_RENDER_ORDER + 2 });
      const boxGlow = fatLines([...top, ...posts], SELECTION_COLOR, additive ? 8 : 4, 0.35, this.#lineResolution, { additive, depthTest: false, renderOrder: SELECTION_RENDER_ORDER + 1 });
      boxGlow.name = "selection-box-glow";
      box.name = "selection-box";
      // Depth contrast is measured on the canvas; the box is chrome, not data.
      boxGlow.visible = box.visible = !this.#depthActive();
      this.#selectionGroup.add(boxGlow, box);
      this.#selectionBox = { height };
    }
    if (selected.length <= 24) {
      const brackets = selected.flatMap((pixel) => cellBracketPositions(this.#manifest.nside, pixel, radius + 0.001));
      const bracketLines = fatLines(brackets, this.#palette.bracket, 3.4, 1, this.#lineResolution, { depthTest: false, renderOrder: SELECTION_RENDER_ORDER + 2 });
      this.#selectionBracketMaterial = bracketLines.material;
      this.#selectionGroup.add(bracketLines);
    }
    this.#canvas.dataset.selectionVolume = "outline";
    this.#canvas.dataset.selectionDepthKeys = "";
    this.#canvas.dataset.selectionDepthRadii = "";
    this.#canvas.dataset.selectionEdgeLayers = "1";

    this.#requestRender();
  }

  /** Direction and sampled outline of the active overlap component; cached because the anchor is read every frame. */
  #overlapAnchorGeometry(): { center: THREE.Vector3; boundary: THREE.Vector3[] } | null {
    if (!this.#overlapMode || !this.#activeOverlapComponentId) return null;
    const component = this.#overlapComponents.find((entry) => entry.id === this.#activeOverlapComponentId);
    if (!component?.cells.length) return null;
    const key = `${component.id}:${component.order}:${component.cells.length}:${component.cells[0]}:${component.cells[component.cells.length - 1]}`;
    if (this.#overlapAnchorCache?.key === key) return this.#overlapAnchorCache;
    const nside = 2 ** component.order;
    const center = this.#pixelDirectionAt(nside, component.cells);
    // Bounds only need the outline's extent, so a bounded sample of cells is enough.
    const stride = Math.max(1, Math.ceil(component.cells.length / OVERLAP_ANCHOR_SAMPLE_CELLS));
    const boundary = component.cells.filter((_, index) => index % stride === 0)
      .flatMap((pixel) => sphericalCellBoundary(nside, pixel, 1));
    this.#overlapAnchorCache = { key, center, boundary };
    return this.#overlapAnchorCache;
  }

  #selectionAnchor(): SurveyLayerState["selectionAnchor"] {
    // Component picking gives the active region sole ownership of the anchor,
    // even if an app separately sets a cell selection through the public API.
    const componentPicking = this.#overlapMode && this.#overlapPickingMode === "component";
    const overlap = componentPicking || !this.#selectedPixels.size ? this.#overlapAnchorGeometry() : null;
    if ((componentPicking || !this.#selectedPixels.size) && !overlap) return null;
    // Anchor on the sky surface itself; exploded fragments rise above it.
    const surfaceRadius = this.#outerRadius + .014;
    const radius = surfaceRadius + (overlap ? 0 : this.#selectionBox?.height ?? 0);
    const world = (overlap ? overlap.center.clone() : this.#pixelDirection(this.#selectedPixels)).multiplyScalar(radius);
    const projected = world.clone().project(this.#camera);
    const forward = new THREE.Vector3();
    this.#camera.getWorldDirection(forward);
    const boundaryDirections = overlap ? overlap.boundary : [...this.#selectedPixels]
      .flatMap((pixel) => sphericalCellBoundary(this.#manifest.nside, pixel, 1));
    const projectedBounds = [Math.max(0.05, surfaceRadius - 0.02), radius]
      .flatMap((sampleRadius) => boundaryDirections.map((point) => point.clone().multiplyScalar(sampleRadius).project(this.#camera)));
    const leftRatio = projectedBounds.length ? Math.min(...projectedBounds.map((point) => (point.x + 1) / 2)) : (projected.x + 1) / 2;
    const rightRatio = projectedBounds.length ? Math.max(...projectedBounds.map((point) => (point.x + 1) / 2)) : (projected.x + 1) / 2;
    const topRatio = projectedBounds.length ? Math.min(...projectedBounds.map((point) => (1 - point.y) / 2)) : (1 - projected.y) / 2;
    const bottomRatio = projectedBounds.length ? Math.max(...projectedBounds.map((point) => (1 - point.y) / 2)) : (1 - projected.y) / 2;
    return {
      xRatio: (projected.x + 1) / 2,
      yRatio: (1 - projected.y) / 2,
      visible: world.clone().sub(this.#camera.position).dot(forward) > 0 && projected.z >= -1 && projected.z <= 1,
      bounds: { leftRatio, rightRatio, topRatio, bottomRatio },
    };
  }

  #emitSelection(notice?: string): void {
    if (!this.#selectedPixels.size) {
      this.#onSelection(null);
      return;
    }
    const surveyIds = new Set<string>();
    const releaseIds = new Set<string>();
    const assetIds = new Set<string>();
    const artifacts = new Map<string, SurveyFootprint>();
    const workspaceLayers = new Map<string, WorkspaceCoverageMembership>();
    const coverageCounts = new Map<string, number>();
    const assetCoverageCounts = new Map<string, number>();
    let emptyCellCount = 0;
    for (const pixel of this.#selectedPixels) {
      const membership = visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds);
      const workspace = this.#workspaceMembershipAt(pixel);
      workspace.surveyIds.forEach((surveyId) => surveyIds.add(surveyId));
      workspace.releaseIds.forEach((releaseId) => releaseIds.add(releaseId));
      workspace.assetIds.forEach((assetId) => {
        assetIds.add(assetId);
        assetCoverageCounts.set(assetId, (assetCoverageCounts.get(assetId) ?? 0) + 1);
      });
      workspace.layers.forEach((layer) => workspaceLayers.set(layer.key, layer));
      workspace.surveyIds.forEach((surveyId) => coverageCounts.set(surveyId, (coverageCounts.get(surveyId) ?? 0) + 1));
      if (!membership && !workspace.layers.length) {
        emptyCellCount += 1;
        continue;
      }
      membership?.surveyIds.forEach((surveyId) => surveyIds.add(surveyId));
      membership?.surveyIds.forEach((surveyId) => coverageCounts.set(surveyId, (coverageCounts.get(surveyId) ?? 0) + 1));
      membership?.releaseIds.forEach((releaseId) => releaseIds.add(releaseId));
      membership?.artifacts.forEach((artifact) => artifacts.set(artifactKey(artifact), artifact));
    }
    const direction = this.#pixelDirection(this.#selectedPixels);
    const center = cartesianToRaDec(direction);
    let angularRadiusDeg = 0;
    for (const pixel of this.#selectedPixels) {
      for (const corner of sphericalCellBoundary(this.#manifest.nside, pixel, 1)) {
        angularRadiusDeg = Math.max(angularRadiusDeg, THREE.MathUtils.radToDeg(direction.angleTo(corner)));
      }
    }
    this.#onSelection({
      kind: "coverage-region",
      nside: this.#manifest.nside,
      pixels: [...this.#selectedPixels].sort((left, right) => left - right),
      surveyIds: [...surveyIds].sort(),
      releaseIds: [...releaseIds].sort(),
      assetIds: [...assetIds].sort(),
      artifacts: [...artifacts.values()].sort((left, right) => artifactKey(left).localeCompare(artifactKey(right))),
      coverageCounts: [...coverageCounts].map(([surveyId, cellCount]) => ({ surveyId, cellCount })).sort((left, right) => left.surveyId.localeCompare(right.surveyId)),
      assetCoverageCounts: [...assetCoverageCounts].map(([assetId, cellCount]) => ({ assetId, cellCount })).sort((left, right) => left.assetId.localeCompare(right.assetId)),
      workspaceLayers: [...workspaceLayers.values()].sort((left, right) => left.key.localeCompare(right.key)),
      centerRaDeg: center.raDeg,
      centerDecDeg: center.decDeg,
      angularRadiusDeg,
      emptyCellCount,
      notice,
    });
    this.#emitState();
  }

  #pruneSelection(): void {
    this.#renderSelectionRegion();
    this.#emitSelection();
  }

  #clearSelection(): void {
    this.#selectedPixels.clear();
    clearGroup(this.#selectionGroup);
    this.#selectionCoreMaterial = null;
    this.#selectionGlowMaterial = null;
    this.#selectionBracketMaterial = null;
    this.#applyFocus();
    this.#onSelection(null);
    this.#emitState();
    this.#requestRender();
  }

  #explodeInspection(nside: number, pixel: number, membership: CoverageCellMembership, rotateCamera: boolean): void {
    this.#clearExplosion(false);
    this.#explodedPixel = pixel;
    this.#explodedNside = nside;
    const depths = new Map(this.#displayDepths().map((depth) => [depth.key, depth]));
    const entries: ExplosionLayerEntry[] = [];
    for (const surveyId of membership.surveyIds) {
      if (!this.#visibleSurveyIds.has(surveyId)) continue;
      entries.push({
        key: `public-survey:${surveyId}`,
        nside,
        pixel,
        color: this.#surveyColor(surveyId),
          sourceRadius: depths.get(`public-survey:${surveyId}`)?.radius ?? 1,
      });
    }
    if (nside === this.#manifest.nside) {
      this.#workspaceDisplayLayers(depths)
        .filter(({ layer }) => !layer.preview && layer.pixels.includes(pixel))
        .forEach(({ layer, radius, color }) => entries.push({
          key: layer.key ?? layer.assetId ?? layer.surveyId ?? "workspace",
          nside,
          pixel,
          color,
          sourceRadius: radius,
        }));
    }
    const drillCell = this.#drillCells.get(pixel);
    if (drillCell && drillCell.nside === nside) {
      const existingKeys = new Set(entries.map((entry) => entry.key));
      for (const layer of drillCell.layers.filter((candidate) => candidate.count > 0)) {
        const key = layer.key || layer.assetId || layer.surveyId || `cell:${pixel}`;
        if (existingKeys.has(key)) continue;
        const color = layer.assetId
          ? deterministicWorkspaceColor(layer.assetId)
          : layer.surveyId ? this.#colorBySurvey.get(layer.surveyId) ?? BASE_COLOR : BASE_COLOR;
        entries.push({ key, nside, pixel, color, sourceRadius: Math.max(1.006, this.#outerRadius + 0.006) });
        existingKeys.add(key);
      }
    }
    // Fan out in display order: the first layer in the order is outermost,
    // as it is on the globe itself.
    const order = this.#normalizedLayerOrder();
    const rank = (key: string) => { const index = order.indexOf(key); return index < 0 ? order.length : index; };
    entries.sort((left, right) => rank(left.key) - rank(right.key));
    const midpoint = (entries.length - 1) / 2;
    const step = Math.min(EXPLODED_LAYER_STEP, (1 - MINIMUM_EXPLODED_RADIUS) / Math.max(1, midpoint));
    this.#explodedFragments = entries.map((entry, index) => {
      const targetRadius = 1 + (midpoint - index) * step;
      const root = new THREE.Group();
      root.scale.setScalar(entry.sourceRadius / targetRadius);
      root.userData.sourceRadius = entry.sourceRadius;
      root.userData.targetRadius = targetRadius;
      const cell: SphericalCellSheetGeometryInput = {
        nside: entry.nside,
        pixel: entry.pixel,
        radius: targetRadius,
        color: entry.color,
        inset: entry.nside === this.#manifest.nside ? 0.018 : 0.006,
      };
      const material = fragmentMaterial(0);
      const mesh = new THREE.Mesh(buildSphericalCellSheetGeometry([cell]), material);
      mesh.renderOrder = EXPLOSION_RENDER_ORDER + index * 2;
      mesh.userData = { layerKey: entry.key };
      const lineMaterial = new THREE.LineBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        depthTest: true,
        depthWrite: false,
        toneMapped: false,
      });
      const edges = new THREE.LineSegments(buildSphericalCellEdges([cell]), lineMaterial);
      edges.renderOrder = EXPLOSION_RENDER_ORDER + index * 2 + 1;
      root.add(mesh, edges);
      this.#explosionGroup.add(root);
      return { root, material, lineMaterial, fromScale: entry.sourceRadius / targetRadius };
    });
    this.#setCoverageOpacity(true);
    this.#fitBackdrop();
    this.#explosionTransition = {
      startedAt: performance.now(),
      durationMs: 620,
      direction: "in",
      fragments: this.#explodedFragments,
    };
    const direction = this.#pixelDirectionAt(nside, [pixel]);
    const outer = this.#outerRadius;
    const distance = Math.max(this.#camera.position.length(), outer + 0.18);
    const destination = direction.clone().multiplyScalar(distance);
    this.#controls.minDistance = 0.002;
    if (rotateCamera) this.#startCameraTransition(destination, new THREE.Vector3(0, 0, 0), 620);
    this.#requestRender();
  }

  #clearExplosion(animated: boolean): void {
    if (this.#explodedPixel == null && !this.#explosionGroup.children.length) {
      return;
    }
    this.#explodedPixel = null;
    this.#explodedNside = null;
    this.#setCoverageOpacity(false);
    if (animated && this.#explodedFragments.length) {
      this.#explosionTransition = {
        startedAt: performance.now(),
        durationMs: 360,
        direction: "out",
        fragments: this.#explodedFragments,
      };
    } else {
      this.#explosionTransition = null;
      this.#explodedFragments = [];
      clearGroup(this.#explosionGroup);
      this.#fitBackdrop();
    }
    this.#applyFocus();
    this.#requestRender();
  }

  #setCoverageOpacity(dimmed: boolean): void {
    const restore = (group: THREE.Group, meshOpacity: number, edgeOpacity: number): void => {
      group.traverse((child) => {
        const overlap = child instanceof THREE.Mesh && child.userData.surveyId === "__overlap__";
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) child.material.opacity = dimmed ? DIMMED_OPACITY : overlap ? OVERLAP_FILL_OPACITY : meshOpacity;
        if (child instanceof THREE.LineSegments && child.material instanceof THREE.LineBasicMaterial) child.material.opacity = dimmed ? DIMMED_EDGE_OPACITY : overlap ? OVERLAP_EDGE_OPACITY : edgeOpacity;
      });
    };
    restore(this.#coverageGroup, COVERAGE_OPACITY, COVERAGE_EDGE_OPACITY);
    restore(this.#workspaceCoverageGroup, 0.14, 0.68);
    restore(this.#drillGroup, 0.3, 0.8);
  }

  #pixelDirection(pixels: Iterable<number>): THREE.Vector3 {
    return this.#pixelDirectionAt(this.#manifest.nside, pixels);
  }

  #pixelDirectionAt(nside: number, pixels: Iterable<number>): THREE.Vector3 {
    const direction = new THREE.Vector3();
    for (const pixel of pixels) {
      const boundary = sphericalCellBoundary(nside, pixel, 1);
      const center = boundary.reduce((sum, point) => sum.add(point), new THREE.Vector3()).normalize();
      direction.add(center);
    }
    return direction.lengthSq() > 0 ? direction.normalize() : new THREE.Vector3(1, 0, 0);
  }

  #startCameraTransition(destination: THREE.Vector3, target: THREE.Vector3, durationMs: number, up?: THREE.Vector3, shiftWeight = this.#viewShiftWeight): void {
    this.setRectangleDrawing(false);
    this.#clearOverlapHover();
    this.#controls.enabled = false;
    if (up) this.#camera.up.copy(up);
    this.#cameraTransition = {
      startedAt: performance.now(),
      durationMs,
      fromCamera: this.#camera.position.clone(),
      toCamera: destination,
      fromTarget: this.#controls.target.clone(),
      toTarget: target,
      fromShift: this.#viewShiftWeight,
      toShift: shiftWeight,
    };
    this.#requestRender();
  }

  #advanceCameraTransition(now: number): void {
    const transition = this.#cameraTransition;
    if (!transition) return;
    const progress = Math.min(1, (now - transition.startedAt) / transition.durationMs);
    const eased = easeInOut(progress);
    this.#camera.position.lerpVectors(transition.fromCamera, transition.toCamera, eased);
    this.#controls.target.lerpVectors(transition.fromTarget, transition.toTarget, eased);
    this.#viewShiftWeight = THREE.MathUtils.lerp(transition.fromShift, transition.toShift, eased);
    this.#keepCameraOutside();
    if (progress < 1) return;
    this.#cameraTransition = null;
    this.#controls.enabled = !this.#rectangleDrawing;
    this.#controls.update();
    this.#emitState();
  }

  #advanceFragmentTransitions(now: number): void {
    for (let index = this.#fragmentTransitions.length - 1; index >= 0; index -= 1) {
      const transition = this.#fragmentTransitions[index]!;
      const progress = Math.min(1, (now - transition.startedAt) / transition.durationMs);
      const eased = easeInOut(progress);
      const opacity = transition.direction === "in" ? eased : 1 - eased;
      transition.root.scale.setScalar(transition.direction === "in" ? THREE.MathUtils.lerp(0.94, 1, eased) : THREE.MathUtils.lerp(1, 0.96, eased));
      const dimmed = this.#overlapMode || this.#selectedPixels.size > 0 || this.#explodedPixel != null;
      const meshOpacity = this.#skyDepth.layout?.items.length ? .055 : dimmed && transition.meshOpacity < 0.5 ? DIMMED_OPACITY : transition.meshOpacity;
      const lineOpacity = this.#skyDepth.layout?.items.length ? .065 : dimmed && transition.lineOpacity < 0.5 ? DIMMED_EDGE_OPACITY : transition.lineOpacity;
      transition.meshMaterials.forEach((material) => { material.opacity = opacity * meshOpacity; });
      transition.lineMaterials.forEach((material) => { material.opacity = opacity * lineOpacity; });
      if (progress < 1) continue;
      this.#fragmentTransitions.splice(index, 1);
      if (transition.direction === "out") {
        this.#retiredGroup.remove(transition.root);
        disposeObject(transition.root);
      }
    }
  }

  #advanceExplosionTransition(now: number): void {
    const transition = this.#explosionTransition;
    if (!transition) return;
    const progress = Math.min(1, (now - transition.startedAt) / transition.durationMs);
    const eased = easeInOut(progress);
    transition.fragments.forEach((fragment) => {
      const scale = transition.direction === "in"
        ? THREE.MathUtils.lerp(fragment.fromScale, 1, eased)
        : THREE.MathUtils.lerp(1, fragment.fromScale, eased);
      fragment.root.scale.setScalar(scale);
      fragment.material.opacity = (transition.direction === "in" ? eased : 1 - eased) * EXPLODED_OPACITY;
      fragment.lineMaterial.opacity = (transition.direction === "in" ? eased : 1 - eased) * 0.96;
    });
    if (progress < 1) return;
    this.#explosionTransition = null;
    if (transition.direction === "out") {
      this.#explodedFragments = [];
      clearGroup(this.#explosionGroup);
      this.#fitBackdrop();
    }
  }

  #advanceSelectionAnimation(now: number): void {
    if (!this.#selectionCoreMaterial || !this.#selectionGlowMaterial) return;
    const pulse = 0.5 + 0.5 * Math.sin(now * 0.004);
    this.#selectionCoreMaterial.opacity = 0.88 + pulse * 0.12;
    this.#selectionGlowMaterial.opacity = 0.28 + pulse * 0.38;
    if (this.#selectionBracketMaterial) this.#selectionBracketMaterial.opacity = 0.62 + pulse * 0.38;
  }

  #backgroundStars(): THREE.Points {
    const positions = new Float32Array(750 * 3);
    for (let index = 0; index < 750; index += 1) {
      const z = 1 - (2 * (index + 0.5)) / 750;
      const radius = Math.sqrt(1 - z * z);
      const phi = index * Math.PI * (3 - Math.sqrt(5));
      positions.set([Math.cos(phi) * radius * 7, z * 7, Math.sin(phi) * radius * 7], index * 3);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({ color: 0x71808b, size: 0.006, transparent: true, opacity: 0.28 }));
  }

  readonly #handleControlsChange = (): void => {
    this.#clearOverlapHover();
    this.#keepCameraOutside();
    this.#emitState();
    this.#requestRender();
  };

  readonly #handleControlsStart = (): void => {
    this.#clearOverlapHover();
    this.#interactionQualityActive = true;
    this.#canvas.dataset.dragging = "true";
    this.#bloomPass.enabled = false;
    this.#finalPass.enabled = false;
    this.#renderer.setPixelRatio(Math.min(1, this.#basePixelRatio));
    this.#skyDepth.setPixelRatio(this.#renderer.getPixelRatio());
    this.#composer.setSize(Math.max(1, Math.round(this.#canvas.clientWidth)), Math.max(1, Math.round(this.#canvas.clientHeight)));
  };

  readonly #handleControlsEnd = (): void => {
    this.#interactionQualityActive = false;
    delete this.#canvas.dataset.dragging;
    this.#finalPass.enabled = true;
    this.#applyPostTheme();
    this.#renderer.setPixelRatio(this.#basePixelRatio);
    this.#composer.setSize(Math.max(1, Math.round(this.#canvas.clientWidth)), Math.max(1, Math.round(this.#canvas.clientHeight)));
    this.#skyDepth.setPixelRatio(this.#renderer.getPixelRatio());
    this.#requestRender();
  };

  #keepCameraOutside(): void {
    const minimumRadius = this.#outerRadius + 0.002;
    if (this.#camera.position.length() >= minimumRadius) return;
    if (this.#camera.position.lengthSq() === 0) this.#camera.position.set(minimumRadius, 0, 0);
    else this.#camera.position.setLength(minimumRadius);
  }

  readonly #handlePointerDown = (event: PointerEvent): void => {
    if (this.#rectangleDrawing) {
      if (event.button !== 0 || this.#rectanglePointer) return;
      const start = this.#rectanglePoint(event);
      if (!start) return;
      event.preventDefault();
      this.#rectanglePointer = { id: event.pointerId, start, unwrappedRa: start.raDeg };
      this.#rectangleDraft = null;
      try {
        this.#canvas.setPointerCapture(event.pointerId);
      } catch {
        this.#finishRectangle(false);
        return;
      }
      this.#updateRectangleDraft(event);
      return;
    }
    if (this.#controls.enabled) this.#navigationPointers.add(event.pointerId);
    if (event.button !== 0) return;
    this.#pointerStart = { x: event.clientX, y: event.clientY };
    this.#clearOverlapHover();
  };

  readonly #handlePointerUp = (event: PointerEvent): void => {
    this.#navigationPointers.delete(event.pointerId);
    if (this.#rectangleDrawing) {
      if (event.pointerId !== this.#rectanglePointer?.id) return;
      event.preventDefault();
      const valid = this.#updateRectangleDraft(event);
      // The draft callback may synchronously cancel or replace the selection.
      if (this.#rectangleDrawing) this.#finishRectangle(valid);
      return;
    }
    if (event.button !== 0) return;
    if (!this.#pointerStart) return;
    const distance = Math.hypot(event.clientX - this.#pointerStart.x, event.clientY - this.#pointerStart.y);
    this.#pointerStart = null;
    if (distance >= 5) return;
    if (this.#clickTimer) clearTimeout(this.#clickTimer);
    const click = {
      clientX: event.clientX,
      clientY: event.clientY,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
    };
    if (this.#overlapMode && this.#overlapPickingMode === "component") {
      const component = this.#pickOverlapComponent(click);
      if (component) this.#onOverlapComponent?.(component);
      return;
    }
    const aggregate = click.ctrlKey || click.metaKey ? null : this.#skyDepth.pick(click.clientX, click.clientY, this.#camera, this.#canvas.getBoundingClientRect());
    if (aggregate) { this.#onSkyDepthPick?.(aggregate); return; }
    if (this.#overlapMode) {
      const component = this.#pickOverlapComponent(click);
      if (component) {
        this.#onOverlapComponent?.(component);
        return;
      }
      const hit = this.#pickCell(click);
      if (hit) {
        // Lock the target box on the clicked cell; selection lives at display order.
        if (hit.nside === this.#manifest.nside) {
          this.#selectedPixels.clear();
          this.#selectedPixels.add(hit.pixel);
          this.#renderSelectionRegion();
          this.#emitState();
        }
        this.#presentInspection(hit.nside, hit.pixel, hit.membership ?? {
          surveyIds: [...this.#visibleSurveyIds],
          releaseIds: [],
          artifacts: [],
        }, hit.workspaceAvailable, hit.point, false);
      }
      return;
    }
    this.#clickTimer = setTimeout(() => {
      this.#clickTimer = null;
      const object = this.#pickObject(click);
      if (object) {
        this.#onObjectPoint?.(object);
        return;
      }
      const additive = click.ctrlKey || click.metaKey;
      this.#select(click, additive);
      if (!additive) this.#inspect(click);
    }, 220);
  };

  readonly #handleDoubleClick = (event: MouseEvent): void => {
    if (this.#rectangleDrawing || performance.now() < this.#rectangleDoubleClickUntil) return;
    if (event.button !== 0) return;
    if (this.#skyDepth.pick(event.clientX, event.clientY, this.#camera, this.#canvas.getBoundingClientRect())) return;
    if (this.#overlapMode) return;
    if (this.#clickTimer) clearTimeout(this.#clickTimer);
    this.#clickTimer = null;
    const hit = this.#pickCell(event);
    if (!hit) return;
    if (this.#options.onDrillDown && hit.nside === this.#manifest.nside) {
      this.#clearExplosion(false);
      this.#options.onDrillDown(this.#regionPayload(event, hit.pixel));
      return;
    }
    if (hit.membership && hit.membership.surveyIds.length > 1) {
      this.#presentInspection(hit.nside, hit.pixel, hit.membership, hit.workspaceAvailable, hit.point, true);
      this.#explodeInspection(hit.nside, hit.pixel, hit.membership, true);
      return;
    }
    this.focusCell(hit.nside, hit.pixel);
  };

  readonly #handlePointerMove = (event: PointerEvent): void => {
    if (this.#rectangleDrawing) {
      if (event.pointerId === this.#rectanglePointer?.id) {
        event.preventDefault();
        this.#updateRectangleDraft(event);
      }
      return;
    }
    if (this.#overlapMode) {
      this.#onHover(null);
      if (this.#overlapPickingMode === "component") {
        if (this.#cameraTransition || this.#interactionQualityActive || event.buttons !== 0 || this.#pointerStart) {
          this.#clearOverlapHover();
          return;
        }
        const component = this.#pickOverlapComponent(event);
        if (component) {
          this.#overlapHoverActive = true;
          this.#options.onOverlapHover?.({ component, clientX: event.clientX, clientY: event.clientY });
        } else this.#clearOverlapHover();
      }
      return;
    }
    if (this.#pointerStart && Math.hypot(event.clientX - this.#pointerStart.x, event.clientY - this.#pointerStart.y) >= 5) return;
    const hit = this.#pickCell(event);
    if (!hit) {
      this.#onHover(null);
      return;
    }
    const pointer = cartesianToRaDec(hit.point);
    const center = cartesianToRaDec(this.#pixelDirectionAt(hit.nside, [hit.pixel]));
    const workspace = hit.nside === this.#manifest.nside ? this.#workspaceMembershipAt(hit.pixel) : { surveyIds: [], releaseIds: [], assetIds: [], layers: [] };
    this.#onHover({
      nside: hit.nside,
      pixel: hit.pixel,
      surveyIds: [...new Set([...(hit.membership?.surveyIds ?? []), ...workspace.surveyIds])].sort(),
      releaseIds: [...new Set([...(hit.membership?.releaseIds ?? []), ...workspace.releaseIds])].sort(),
      assetIds: workspace.assetIds,
      workspaceLayers: workspace.layers,
      artifacts: hit.membership?.artifacts ?? [],
      pointerRaDeg: pointer.raDeg,
      pointerDecDeg: pointer.decDeg,
      centerRaDeg: center.raDeg,
      centerDecDeg: center.decDeg,
      workspaceAvailable: hit.workspaceAvailable,
      clientX: event.clientX,
      clientY: event.clientY,
        selectableInRegion: true,
    });
  };

  readonly #handlePointerLeave = (): void => {
    this.#onHover(null);
    this.#clearOverlapHover();
  };
  readonly #handlePointerCancel = (event: PointerEvent): void => {
    this.#navigationPointers.delete(event.pointerId);
    if (this.#rectangleDrawing && event.pointerId === this.#rectanglePointer?.id) this.#finishRectangle(false);
    this.#pointerStart = null;
    this.#clearOverlapHover();
  };
  readonly #handleLostPointerCapture = (event: PointerEvent): void => {
    this.#navigationPointers.delete(event.pointerId);
    if (this.#rectangleDrawing && event.pointerId === this.#rectanglePointer?.id) this.#finishRectangle(false);
  };
  readonly #handleRectangleKeyDown = (event: KeyboardEvent): void => {
    if (!this.#rectangleDrawing || event.key !== "Escape") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.#finishRectangle(false);
  };
  readonly #handleRectangleBlur = (): void => {
    if (this.#rectangleDrawing) this.#finishRectangle(false);
  };
  readonly #handleContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    if (this.#rectangleDrawing) return;
    if (this.#overlapMode && !this.#options.overlapContextMenu) return;
    if (this.#overlapMode && this.#overlapPickingMode === "component") {
      const component = this.#pickOverlapComponent(event);
      if (component) this.#onContextMenu(this.#contextMenuPayload(event, component.cells, 2 ** component.order, component));
      return;
    }
    const hit = this.#pickCell(event);
    if (!hit || hit.nside !== this.#manifest.nside) {
      this.#onHover(null);
      return;
    }
    this.#onContextMenu(this.#regionPayload(event, hit.pixel));
  };

  /** Select `pixel` if it is not already selected, then describe the selected
   * region (or the overlap component under the pointer). */
  #regionPayload(event: MouseEvent, pixel: number): SurveyLayerContextMenu {
    if (!this.#selectedPixels.has(pixel)) {
      this.#selectedPixels.clear();
      this.#selectedPixels.add(pixel);
      this.#renderSelectionRegion();
      this.#emitSelection();
    }
    const overlapComponent = this.#overlapMode ? this.#pickOverlapComponent(event) : null;
    return this.#contextMenuPayload(event, overlapComponent?.cells ?? this.#selectedPixels, overlapComponent ? 2 ** overlapComponent.order : this.#manifest.nside, overlapComponent);
  }

  #contextMenuPayload(event: PointerCoordinates, pixels: Iterable<number>, nside: number, overlapComponent: SurveyLayerOverlapComponent | null): SurveyLayerContextMenu {
    const region = [...pixels];
    const sourceIdFor = this.#options.sourceIdForFootprint;
    const surveyIds = new Set<string>();
    const releaseIds = new Set<string>();
    const assetIds = new Set<string>();
    const sourceIds = new Set<string>();
    // Numeric pixel ids at different orders are unrelated. Without matching
    // coverage metadata, report the component and its supplied source ids only.
    for (const pixel of nside === this.#manifest.nside ? region : []) {
      const membership = visibleCoverageAtPixel(this.#model, pixel, this.#visibleSurveyIds);
      const workspace = this.#workspaceMembershipAt(pixel);
      if (sourceIdFor) membership?.artifacts.forEach((artifact) => { const id = sourceIdFor(artifact); if (id) sourceIds.add(id); });
      membership?.surveyIds.forEach((surveyId) => surveyIds.add(surveyId));
      membership?.releaseIds.forEach((releaseId) => releaseIds.add(releaseId));
      workspace.surveyIds.forEach((surveyId) => surveyIds.add(surveyId));
      workspace.releaseIds.forEach((releaseId) => releaseIds.add(releaseId));
      workspace.assetIds.forEach((assetId) => assetIds.add(assetId));
    }
    return {
      clientX: event.clientX,
      clientY: event.clientY,
      nside,
      pixels: overlapComponent ? region : region.sort((left, right) => left - right),
      surveyIds: [...surveyIds].sort(),
      releaseIds: [...releaseIds].sort(),
      assetIds: [...assetIds].sort(),
      ...(sourceIdFor ? { sourceIds: overlapComponent?.sourceIds?.filter((id) => id.startsWith("public:")) ?? [...sourceIds].sort() } : {}),
      ...(overlapComponent ? { componentId: overlapComponent.id } : {}),
    };
  }

  #emitState(): void {
    this.#onStateChange(this.state);
  }

  #resize(): void {
    const bounds = this.#canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(bounds.width));
    const height = Math.max(1, Math.round(bounds.height));
    this.#renderer.setSize(width, height, false);
    this.#basePixelRatio = Math.min(window.devicePixelRatio, 1.35);
    this.#renderer.setPixelRatio(this.#interactionQualityActive ? Math.min(1, this.#basePixelRatio) : this.#basePixelRatio);
    this.#skyDepth.setPixelRatio(this.#renderer.getPixelRatio());
    this.#composer.setSize(width, height);
    const ratio = this.#renderer.getPixelRatio();
    this.#lineResolution.set(width * ratio, height * ratio);
    this.#finalPass.uniforms.resolution!.value.set(width * ratio, height * ratio);
    this.#applyProjection(width, height);
    if (this.#homeScrollProgress < 1 && !this.#cameraTransition) this.#applyHomeScrollPose();
    this.#requestRender();
  }

  #applyProjection(width: number, height: number): void {
    this.#clearOverlapHover();
    this.#camera.aspect = width / height;
    this.#projectionSize = { width, height };
    const shiftY = -Math.round(this.#tacticalShift() * height * 2) / 2;
    this.#appliedShiftY = shiftY;
    if (this.#viewportRightInset > 0 || shiftY !== 0) {
      this.#camera.setViewOffset(width, height, this.#viewportRightInset / 2, shiftY, width, height);
    } else {
      this.#camera.clearViewOffset();
      this.#camera.updateProjectionMatrix();
    }
  }

  #syncTacticalProjection(): void {
    const { width, height } = this.#projectionSize;
    const shiftY = -Math.round(this.#tacticalShift() * height * 2) / 2;
    if (shiftY !== this.#appliedShiftY) this.#applyProjection(width, height);
  }

  /** Fade rims, per-cell edges and dark-sky bloom once the displayed cells
   * are only a few pixels wide, so a dense order seen from afar reads as a
   * translucent shell rather than a saturated white globe. */
  #syncCellDetail(): void {
    let detail = 1;
    if (!this.#depthActive()) {
      const nside = this.#overlapMode ? this.#overlapNside ?? this.#manifest.nside : this.#manifest.nside;
      const cellAngle = Math.sqrt(4 * Math.PI / (12 * nside * nside));
      const surfaceDistance = Math.max(0.05, this.#camera.position.length() - this.#outerRadius);
      const fov = THREE.MathUtils.degToRad(this.#camera.getEffectiveFOV());
      const pixelsPerUnit = this.#projectionSize.height / (2 * Math.tan(fov / 2) * surfaceDistance);
      const cellPixels = cellAngle * this.#outerRadius * pixelsPerUnit;
      detail = THREE.MathUtils.smoothstep(cellPixels, 5, 22);
    }
    // Additive layers sum: give each one a shrinking share once several
    // overlap so the stack stays coloured. Depth keeps its measured response.
    let stacked = 0;
    this.#visibleSurveyIds.forEach((surveyId) => { if (this.#model.pixelsBySurvey.get(surveyId)?.length) stacked += 1; });
    const stackGain = this.#palette.additiveCoverage && !this.#depthActive() && stacked > 1 ? 1 / Math.sqrt(stacked) : 1;
    if (Math.abs(cellRimUniforms.stackGain.value - stackGain) > 0.002) cellRimUniforms.stackGain.value = stackGain;
    cellRimUniforms.limbFade.value = this.#palette.additiveCoverage && !this.#depthActive() ? 1 : 0;
    if (Math.abs(cellRimUniforms.cellDetail.value - detail) > 0.002) {
      cellRimUniforms.cellDetail.value = detail;
      this.#applyHudOutlineOpacity();
    }
    if (this.#palette.additiveCoverage && !this.#depthActive()) {
      this.#bloomPass.strength = this.#bloomStrength * (0.4 + 0.6 * detail) * (0.55 + 0.45 * stackGain);
    }
  }

  #requestRender(): void {
    if (this.#disposed) return;
    if (this.#renderQueued) return;
    this.#renderQueued = true;
    this.#renderFrame = requestAnimationFrame((now) => {
      this.#renderFrame = null;
      this.#renderQueued = false;
      if (this.#disposed) return;
      this.#advanceCameraTransition(now);
      this.#advanceFragmentTransitions(now);
      this.#advanceExplosionTransition(now);
      this.#advanceSelectionAnimation(now);
      const moving = this.#controls.enabled && this.#controls.update();
      this.#keepCameraOutside();
      this.#syncTacticalProjection();
      this.#syncCellDetail();
      this.#syncRectangleOutline();
      this.#composer.render();
      if (moving || this.#cameraTransition || this.#fragmentTransitions.length || this.#explosionTransition || this.#selectionGlowMaterial) this.#requestRender();
    });
  }
}
