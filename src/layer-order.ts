export type LayerOrderLayout = "overlap" | "layers";

export interface LayerDepth {
  key: string;
  radius: number;
  renderOrder: number;
}

// Overlap mode is a true co-registered view: every survey surface is drawn on
// the same unit sphere. Render order (rather than radial separation) keeps the
// transparent meshes deterministic and leaves the intersection highlighter
// visible above them.
const OVERLAP_DEPTH_STEP = 0;
// Keep the public survey surfaces visibly separated in the hero composition,
// while bounding the stack so a growing catalog can never cross radius zero.
export const LAYER_RADIUS_MIN = 0.88;
export const LAYER_RADIUS_MAX = 1.12;

export function normalizeLayerOrder(
  knownKeys: Iterable<string>,
  storedKeys: Iterable<string> = [],
  defaultKeys: Iterable<string> = [],
): string[] {
  const known = new Set(knownKeys);
  const ordered: string[] = [];
  const add = (key: string): void => {
    if (known.has(key) && !ordered.includes(key)) ordered.push(key);
  };
  for (const key of storedKeys) add(key);
  for (const key of defaultKeys) add(key);
  // Only add all known keys if defaultKeys was provided and non-empty
  const defaults = Array.isArray(defaultKeys) ? defaultKeys : [...defaultKeys];
  if (defaults.length > 0) {
    for (const key of known) add(key);
  }
  return ordered;
}

export function visibleLayerDepths(
  order: readonly string[],
  visibleKeys: Iterable<string>,
  layout: LayerOrderLayout,
  range: { min: number; max: number } = { min: LAYER_RADIUS_MIN, max: LAYER_RADIUS_MAX },
): LayerDepth[] {
  const visible = new Set(visibleKeys);
  const keys = order.filter((key) => visible.has(key));
  const span = range.max - range.min;
  return keys.map((key, index) => ({
    key,
    // The first list item is the front-most layer.
    radius: layout === "layers"
      ? keys.length <= 1 ? 1 : range.max - (index / (keys.length - 1)) * span
      : 1 + (keys.length - 1 - index) * OVERLAP_DEPTH_STEP,
    renderOrder: 2 + (keys.length - 1 - index) * 2,
  }));
}
