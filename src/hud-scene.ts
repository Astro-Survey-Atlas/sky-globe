import * as THREE from "three";
import { LineSegments2 } from "three/addons/lines/LineSegments2.js";
import { LineSegmentsGeometry } from "three/addons/lines/LineSegmentsGeometry.js";
import { LineMaterial } from "three/addons/lines/LineMaterial.js";

import { raDecToCartesian } from "./coordinates.js";
import type { SceneTheme } from "./scene-theme.js";
import { REFERENCE_ASTERISMS, REFERENCE_OBJECTS } from "./sky-reference.js";
import { sphericalCellBoundary } from "./spherical-cell-geometry.js";

/** Pixel-width lines share one resolution vector owned by the viewer. */
export function fatLines(
  positions: readonly number[],
  color: THREE.ColorRepresentation,
  width: number,
  opacity: number,
  resolution: THREE.Vector2,
  options: { additive?: boolean; depthTest?: boolean; renderOrder?: number } = {},
): LineSegments2 {
  const geometry = new LineSegmentsGeometry().setPositions(positions as number[]);
  const material = new LineMaterial({
    color,
    linewidth: width,
    transparent: true,
    opacity,
    depthTest: options.depthTest ?? true,
    depthWrite: false,
    blending: options.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    toneMapped: false,
  });
  material.uniforms.resolution!.value = resolution;
  const line = new LineSegments2(geometry, material);
  line.renderOrder = options.renderOrder ?? 0;
  // Decorative lines must never intercept cell picking.
  line.raycast = () => undefined;
  return line;
}

const edgeKey = (point: THREE.Vector3): string => `${point.x.toFixed(6)},${point.y.toFixed(6)},${point.z.toFixed(6)}`;

/** Outer boundary of a set of HEALPix cells: edges shared by two cells cancel. */
export function regionOutlinePositions(nside: number, pixels: Iterable<number>, radius: number): number[] {
  const edges = new Map<string, [THREE.Vector3, THREE.Vector3] | null>();
  for (const pixel of pixels) {
    const boundary = sphericalCellBoundary(nside, pixel, radius);
    boundary.forEach((start, index) => {
      const end = boundary[(index + 1) % boundary.length]!;
      const a = edgeKey(start);
      const b = edgeKey(end);
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      edges.set(key, edges.has(key) ? null : [start, end]);
    });
  }
  const positions: number[] = [];
  for (const edge of edges.values()) if (edge) positions.push(edge[0].x, edge[0].y, edge[0].z, edge[1].x, edge[1].y, edge[1].z);
  return positions;
}

/** Short target-lock brackets at every corner of a cell. */
export function cellBracketPositions(nside: number, pixel: number, radius: number, fraction = 0.28): number[] {
  const boundary = sphericalCellBoundary(nside, pixel, radius);
  const positions: number[] = [];
  boundary.forEach((corner, index) => {
    for (const neighbour of [boundary[(index + 1) % 4]!, boundary[(index + 3) % 4]!]) {
      const tip = corner.clone().lerp(neighbour, fraction).normalize().multiplyScalar(radius);
      positions.push(corner.x, corner.y, corner.z, tip.x, tip.y, tip.z);
    }
  });
  return positions;
}

function vector(raDeg: number, decDeg: number, radius: number): THREE.Vector3 {
  const point = raDecToCartesian(raDeg, decDeg, radius);
  return new THREE.Vector3(point.x, point.y, point.z);
}

let dotTexture: THREE.Texture | null = null;
function glowDot(): THREE.Texture {
  if (dotTexture) return dotTexture;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 64;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(32, 32, 0, 32, 32, 32);
  gradient.addColorStop(0, "rgba(255,255,255,1)");
  gradient.addColorStop(0.2, "rgba(255,255,255,.85)");
  gradient.addColorStop(0.5, "rgba(255,255,255,.18)");
  gradient.addColorStop(1, "rgba(255,255,255,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  dotTexture = new THREE.CanvasTexture(canvas);
  dotTexture.colorSpace = THREE.SRGBColorSpace;
  return dotTexture;
}

/** A text plane lying tangent to the sphere, readable from outside with north up. */
function skyLabel(text: string, raDeg: number, decDeg: number, height: number, color: string, glow: string, opacity: number): THREE.Mesh {
  const fontPx = 96;
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d")!;
  const font = `700 ${fontPx}px "Atlas Mono", monospace`;
  context.font = font;
  const spacing = fontPx * 0.22;
  const width = [...text].reduce((sum, character) => sum + context.measureText(character).width + spacing, 0);
  canvas.width = Math.ceil(width + 64);
  canvas.height = fontPx + 64;
  context.font = font;
  context.textBaseline = "middle";
  const draw = (blur: number): void => {
    context.shadowColor = glow;
    context.shadowBlur = blur;
    context.fillStyle = color;
    let x = 32;
    for (const character of text) {
      context.fillText(character, x, canvas.height / 2);
      x += context.measureText(character).width + spacing;
    }
  };
  if (glow !== "rgba(255,255,255,0)") draw(22);
  draw(0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(height * (canvas.width / canvas.height), height),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity, depthWrite: false, toneMapped: false }),
  );
  const normal = vector(raDeg, decDeg, 1).normalize();
  const north = new THREE.Vector3(0, 1, 0).addScaledVector(normal, -normal.y);
  if (north.lengthSq() < 1e-6) north.set(1, 0, 0);
  north.normalize();
  const right = new THREE.Vector3().crossVectors(north, normal).normalize();
  mesh.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, north, normal));
  mesh.position.copy(normal.multiplyScalar(1.004));
  mesh.raycast = () => undefined;
  return mesh;
}

export interface HudBackdrop {
  group: THREE.Group;
  setTheme(theme: SceneTheme): void;
  /** Hide chromatic decoration (limb, grid, asterisms) while depth is measured. */
  setQuiet(quiet: boolean): void;
  dispose(): void;
}

/** Opaque sky body with a fresnel limb, graticule and reference asterisms.
 * Built on the unit sphere; the viewer scales it beneath the innermost layer. */
export function buildHudBackdrop(resolution: THREE.Vector2, theme: SceneTheme): HudBackdrop {
  const group = new THREE.Group();
  group.name = "hud-backdrop";
  const bodyUniforms = {
    bodyColor: { value: new THREE.Color(theme.body) },
    limbColor: { value: new THREE.Color(theme.limb) },
    limbStrength: { value: theme.limbStrength },
  };
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.997, 128, 96),
    new THREE.ShaderMaterial({
      uniforms: bodyUniforms,
      vertexShader: `varying vec3 vNormalView; varying vec3 vViewPosition;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewPosition = -mv.xyz;
          vNormalView = normalize(normalMatrix * normal);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `uniform vec3 bodyColor; uniform vec3 limbColor; uniform float limbStrength;
        varying vec3 vNormalView; varying vec3 vViewPosition;
        void main() {
          float facing = clamp(dot(normalize(vNormalView), normalize(vViewPosition)), 0.0, 1.0);
          float limb = pow(1.0 - facing, 3.0) * limbStrength;
          gl_FragColor = vec4(bodyColor + limbColor * limb, 1.0);
          #include <colorspace_fragment>
        }`,
      depthWrite: true,
      toneMapped: false,
    }),
  );
  body.renderOrder = -20;
  body.raycast = () => undefined;

  const grid: number[] = [];
  for (let ra = 0; ra < 360; ra += 10) for (let dec = -80; dec < 80; dec += 2) {
    const a = vector(ra, dec, 1.0005);
    const b = vector(ra, dec + 2, 1.0005);
    grid.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  for (let dec = -80; dec <= 80; dec += 10) for (let ra = 0; ra < 360; ra += 2) {
    const a = vector(ra, dec, 1.0005);
    const b = vector(ra + 2, dec, 1.0005);
    grid.push(a.x, a.y, a.z, b.x, b.y, b.z);
  }
  const gridGeometry = new THREE.BufferGeometry();
  gridGeometry.setAttribute("position", new THREE.Float32BufferAttribute(grid, 3));
  const gridMaterial = new THREE.LineBasicMaterial({ color: theme.grid, transparent: true, opacity: theme.gridOpacity, depthWrite: false, toneMapped: false });
  const graticule = new THREE.LineSegments(gridGeometry, gridMaterial);
  graticule.renderOrder = -19;
  graticule.raycast = () => undefined;

  const asterismLines: number[] = [];
  const starPositions: number[] = [];
  REFERENCE_ASTERISMS.forEach((asterism) => {
    asterism.lines.forEach(([from, to]) => {
      const a = vector(...asterism.stars[from]!, 1.003);
      const b = vector(...asterism.stars[to]!, 1.003);
      asterismLines.push(a.x, a.y, a.z, b.x, b.y, b.z);
    });
    Object.values(asterism.stars).forEach(([ra, dec]) => {
      const star = vector(ra, dec, 1.004);
      starPositions.push(star.x, star.y, star.z);
    });
  });
  const objectPositions: number[] = [];
  REFERENCE_OBJECTS.forEach((object) => {
    const point = vector(object.ra, object.dec, 1.004);
    objectPositions.push(point.x, point.y, point.z);
  });

  const decor = new THREE.Group();
  const rebuildDecor = (palette: SceneTheme): void => {
    for (const child of [...decor.children]) {
      decor.remove(child);
      child.traverse((node) => {
        if (node instanceof THREE.Mesh || node instanceof THREE.Points || node instanceof THREE.LineSegments) {
          node.geometry.dispose();
          const material = node.material as THREE.Material & { map?: THREE.Texture | null };
          if (material.map && material.map !== dotTexture) material.map.dispose();
          material.dispose();
        }
      });
    }
    const additive = palette.additiveCoverage;
    decor.add(fatLines(asterismLines, palette.constellation, 1.1, palette.constellationOpacity, resolution, { renderOrder: -18 }));
    const stars = new THREE.BufferGeometry();
    stars.setAttribute("position", new THREE.Float32BufferAttribute(starPositions, 3));
    const starPoints = new THREE.Points(stars, new THREE.PointsMaterial({
      color: additive ? 0xffffff : palette.constellation,
      map: glowDot(),
      size: 9,
      sizeAttenuation: false,
      transparent: true,
      opacity: additive ? 0.9 : 0.75,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
    }));
    starPoints.renderOrder = -17;
    starPoints.raycast = () => undefined;
    const objects = new THREE.BufferGeometry();
    objects.setAttribute("position", new THREE.Float32BufferAttribute(objectPositions, 3));
    const objectPoints = new THREE.Points(objects, new THREE.PointsMaterial({
      color: additive ? 0xff9a4a : 0xf01951,
      map: glowDot(),
      size: 16,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.9,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      toneMapped: false,
    }));
    objectPoints.renderOrder = -17;
    objectPoints.raycast = () => undefined;
    decor.add(starPoints, objectPoints);
    REFERENCE_ASTERISMS.forEach((asterism) => {
      const label = skyLabel(asterism.name, asterism.label[0], asterism.label[1], 0.04, palette.constellationLabel, palette.constellationLabelGlow, 0.78);
      label.renderOrder = -16;
      decor.add(label);
    });
    REFERENCE_OBJECTS.forEach((object) => {
      const label = skyLabel(object.name, object.ra + 2.6 / Math.max(0.2, Math.cos(object.dec * Math.PI / 180)), object.dec - 1.4, 0.02, additive ? "#ffc08a" : "#c70f3e", palette.constellationLabelGlow, 0.8);
      label.renderOrder = -16;
      decor.add(label);
    });
  };
  rebuildDecor(theme);
  group.add(body, graticule, decor);
  let limbStrength = theme.limbStrength;
  let quiet = false;

  return {
    group,
    setTheme(palette) {
      bodyUniforms.bodyColor.value.setHex(palette.body);
      bodyUniforms.limbColor.value.setHex(palette.limb);
      limbStrength = palette.limbStrength;
      bodyUniforms.limbStrength.value = quiet ? 0 : limbStrength;
      gridMaterial.color.setHex(palette.grid);
      gridMaterial.opacity = palette.gridOpacity;
      rebuildDecor(palette);
    },
    setQuiet(next) {
      quiet = next;
      graticule.visible = !next;
      decor.visible = !next;
      bodyUniforms.limbStrength.value = next ? 0 : limbStrength;
    },
    dispose() {
      rebuildDecor({ ...theme });
      body.geometry.dispose();
      (body.material as THREE.Material).dispose();
      gridGeometry.dispose();
      gridMaterial.dispose();
    },
  };
}

/** Final screen pass: vignette, film grain and faint scanlines. All effects
 * are per-pixel scalar (achromatic), so chroma ratios between captures hold. */
export const HudFinalShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    vignette: { value: 0.5 },
    grain: { value: 0.04 },
    scanlines: { value: 0.05 },
    resolution: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `uniform sampler2D tDiffuse; uniform float vignette; uniform float grain; uniform float scanlines; uniform vec2 resolution; varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb;
      float d = length(vUv - 0.5);
      color *= mix(1.0 - vignette, 1.0, smoothstep(0.95, 0.25, d));
      color *= 1.0 - scanlines * (0.5 + 0.5 * sin(vUv.y * resolution.y * 3.14159));
      color += (hash(vUv * resolution + 7.0) - 0.5) * grain;
      gl_FragColor = vec4(max(color, 0.0), texel.a);
    }`,
};

/** Shared "bright edge, dark core" response for HEALPix cell fills. */
export const cellRimUniforms = {
  rimCore: { value: 0.28 },
  rimGain: { value: 1.65 },
  fillGain: { value: 1 },
  /** 1 renders fills as neutral luminance (used behind measured depth). */
  desaturate: { value: 0 },
  /** Alpha gain for HEALPix cell edge lines; paper needs stronger ink. */
  edgeGain: { value: 1 },
  /** 1 while HEALPix cells are large on screen, 0 when they shrink to a few
   * pixels: rims and per-cell edges then fade so dense orders read as one
   * translucent shell instead of saturating towards white. */
  cellDetail: { value: 1 },
  /** Additive skies only: alpha share per layer, so several stacked surveys
   * stay coloured instead of summing to white. */
  stackGain: { value: 1 },
  /** 1 fades rims and edges seen edge-on at the limb, where many cells
   * project onto each pixel and additive lines would sum to a glare ring. */
  limbFade: { value: 0 },
};

const FACING_VERTEX = "vec4 hudWorld = modelMatrix * vec4(transformed, 1.0);\nvHudFacing = abs(dot(normalize(hudWorld.xyz), normalize(cameraPosition - hudWorld.xyz)));";
const FACING = "mix(1.0, smoothstep(0.02, 0.5, vHudFacing), limbFade)";

/** Patch a cell fill material to read the `cellUv` attribute written by the
 * spherical cell builders: (0.5, 0.5) at the cell centre, the unit square's
 * perimeter on the cell boundary. Geometry without the attribute reads as rim everywhere. */
export function applyCellRim<T extends THREE.Material>(material: T): T {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.rimCore = cellRimUniforms.rimCore;
    shader.uniforms.rimGain = cellRimUniforms.rimGain;
    shader.uniforms.fillGain = cellRimUniforms.fillGain;
    shader.uniforms.desaturate = cellRimUniforms.desaturate;
    shader.uniforms.cellDetail = cellRimUniforms.cellDetail;
    shader.uniforms.stackGain = cellRimUniforms.stackGain;
    shader.uniforms.limbFade = cellRimUniforms.limbFade;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute vec2 cellUv;\nvarying vec2 vCellUv;\nvarying float vHudFacing;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\nvCellUv = cellUv;\n${FACING_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float rimCore;\nuniform float rimGain;\nuniform float fillGain;\nuniform float desaturate;\nuniform float cellDetail;\nuniform float stackGain;\nuniform float limbFade;\nvarying vec2 vCellUv;\nvarying float vHudFacing;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        float cellRim = max(abs(vCellUv.x - 0.5), abs(vCellUv.y - 0.5)) * 2.0;
        float cellFacing = ${FACING};
        float cellCore = mix(max(rimCore, 0.45), rimCore, cellDetail);
        diffuseColor.a *= fillGain * stackGain * mix(0.55, 1.0, cellFacing) * mix(cellCore, 1.0, smoothstep(0.35, 1.0, cellRim) * cellDetail * cellFacing);
        diffuseColor.rgb *= mix(1.0, rimGain, smoothstep(0.72, 1.0, cellRim) * cellDetail * cellFacing);
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), desaturate);`,
      );
  };
  material.customProgramCacheKey = () => "hud-cell-rim-v4";
  return material;
}

/** Neutralise line colours with the shared depth desaturation uniform. */
export function applyNeutralDepth<T extends THREE.Material>(material: T): T {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.desaturate = cellRimUniforms.desaturate;
    shader.uniforms.edgeGain = cellRimUniforms.edgeGain;
    shader.uniforms.cellDetail = cellRimUniforms.cellDetail;
    shader.uniforms.stackGain = cellRimUniforms.stackGain;
    shader.uniforms.limbFade = cellRimUniforms.limbFade;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying float vHudFacing;")
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${FACING_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float desaturate;\nuniform float edgeGain;\nuniform float cellDetail;\nuniform float stackGain;\nuniform float limbFade;\nvarying float vHudFacing;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>\n\tdiffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))), desaturate);\n\tdiffuseColor.a = min(1.0, diffuseColor.a * edgeGain) * mix(0.1, 1.0, cellDetail) * stackGain * mix(0.2, 1.0, ${FACING});`,
      );
  };
  material.customProgramCacheKey = () => "hud-neutral-depth-v5";
  return material;
}
