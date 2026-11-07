/**
 * @astro-survey-atlas/sky-globe — the three.js HEALPix coverage globe shared
 * by Astro Survey Atlas Assets and Workspace.
 *
 * The package is the rendering core only: data comes in (footprint manifests,
 * survey colors, overlap pixels, sky-depth results) and interaction events go
 * out through callbacks. Fetching, i18n and page panels stay in the apps.
 */
export * from "./coordinates.js";
export * from "./hud-scene.js";
export * from "./layer-order.js";
export * from "./overlap-highlight.js";
export * from "./scene-theme.js";
export * from "./sky-depth-layer.js";
export type * from "./sky-depth-types.js";
export * from "./sky-reference.js";
export * from "./spherical-cell-geometry.js";
export * from "./survey-colors.js";
export * from "./survey-footprints.js";
export * from "./survey-layer-model.js";
export * from "./survey-layer-viewer.js";
