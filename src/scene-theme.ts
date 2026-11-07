/** Per-theme palette for the tactical HUD globe.
 *
 * Survey colours stay owned by the catalog; this palette only covers the
 * scene chrome (background, body, grid, rim lighting, selection and bloom)
 * and how strongly survey cells glow in each theme. */
export type SceneThemeName = "light" | "dark";

export interface SceneTheme {
  background: number;
  body: number;
  limb: number;
  limbStrength: number;
  grid: number;
  gridOpacity: number;
  stars: number;
  starOpacity: number;
  constellation: number;
  constellationOpacity: number;
  constellationLabel: string;
  constellationLabelGlow: string;
  /** Additive fills read as light on the dark sky; normal blending on paper. */
  additiveCoverage: boolean;
  /** Fill alpha multiplier at a cell centre; edges use the full opacity. */
  rimCore: number;
  /** Colour gain applied towards a cell edge. */
  rimGain: number;
  /** Fill alpha multiplier; additive fills need far less than normal ones. */
  fillGain: number;
  /** Alpha gain for the thin per-cell edge lines. */
  edgeGain: number;
  outlineWidth: number;
  outlineGlowWidth: number;
  outlineGlowOpacity: number;
  outlineCoreOpacity: number;
  overlap: number;
  overlapFlow: number;
  selection: number;
  selectionEdge: number;
  bracket: number;
  label: { fill: string; stroke: string; text: string; accent: string };
  bloom: { strength: number; radius: number; threshold: number };
  final: { vignette: number; grain: number; scanlines: number };
}

export const SCENE_THEMES: Record<SceneThemeName, SceneTheme> = {
  dark: {
    background: 0x010104,
    body: 0x030309,
    limb: 0x5b66ff,
    limbStrength: 0.14,
    grid: 0x5b66d8,
    gridOpacity: 0.09,
    stars: 0x9aa0d8,
    starOpacity: 0.5,
    constellation: 0xffb4c8,
    constellationOpacity: 0.32,
    constellationLabel: "#f4f4ff",
    constellationLabelGlow: "rgba(200,205,255,.85)",
    additiveCoverage: true,
    // Flat cells as in the v3 design: no centre-to-edge gradient inside a cell.
    rimCore: 1,
    rimGain: 1,
    fillGain: 0.3,
    edgeGain: 1,
    outlineWidth: 2.2,
    outlineGlowWidth: 10,
    outlineGlowOpacity: 0.12,
    outlineCoreOpacity: 0.32,
    overlap: 0xff8fb0,
    overlapFlow: 0xffffff,
    selection: 0xf01951,
    selectionEdge: 0xffffff,
    bracket: 0xffffff,
    label: { fill: "rgba(6,6,18,.82)", stroke: "rgba(255,46,99,.9)", text: "#f4f4ff", accent: "#ff2e63" },
    bloom: { strength: 0.6, radius: 0.22, threshold: 0.62 },
    final: { vignette: 0.5, grain: 0.012, scanlines: 0.05 },
  },
  light: {
    background: 0xeef0f6,
    // Paper-white body; the outline alone defines the edge, as in the design.
    body: 0xf7f8fc,
    limb: 0x2c3792,
    limbStrength: 0.06,
    grid: 0x2c3792,
    gridOpacity: 0.36,
    stars: 0x2c3792,
    starOpacity: 0.3,
    constellation: 0x2c3792,
    constellationOpacity: 0.42,
    constellationLabel: "#1a1c33",
    constellationLabelGlow: "rgba(255,255,255,0)",
    additiveCoverage: false,
    rimCore: 1,
    rimGain: 1,
    fillGain: 0.28,
    edgeGain: 2.6,
    outlineWidth: 2.2,
    outlineGlowWidth: 0,
    outlineGlowOpacity: 0,
    outlineCoreOpacity: 0,
    overlap: 0xf01951,
    overlapFlow: 0x2c3792,
    selection: 0xf01951,
    selectionEdge: 0x1a1c33,
    bracket: 0xf01951,
    label: { fill: "rgba(255,255,255,.9)", stroke: "rgba(240,25,81,.85)", text: "#15162e", accent: "#e0124b" },
    bloom: { strength: 0, radius: 0, threshold: 1 },
    final: { vignette: 0.1, grain: 0.006, scanlines: 0 },
  },
};

/** Bloom used while sky depth is shown: its range contrast is measured on
 * the captured canvas, so keep the pre-HUD response there. */
export const DEPTH_BLOOM = { strength: 0.4, radius: 0.4, threshold: 0.85 } as const;

export function sceneTheme(theme: SceneThemeName): SceneTheme {
  return SCENE_THEMES[theme];
}
