# @astro-survey-atlas/sky-globe

The three.js HEALPix coverage globe shared by Astro Survey Atlas Assets and
Workspace, plus the tactical HUD design tokens (`theme.css`).

The package is the rendering core: data goes in (footprint manifests, survey
colors, overlap pixels, sky-depth results) and interaction comes out through
callbacks. Fetching, i18n and page panels stay in each app.

- Runtime imports are limited to `three` (peer dependency), `healpixjs` and the
  package's own modules. `test/sky-globe-boundary.test.ts` in Assets enforces it.
- `sky-depth-types.ts` mirrors the Assets sky-depth wire types; the same Assets
  test fails if they drift.
- `exports` points at TypeScript sources, which Vite, tsx and tsc consume directly.

## Install

Pin a release tag; there is no npm publication.

```sh
npm install "github:Astro-Survey-Atlas/sky-globe#v0.1.0" three@^0.185.1
```

```ts
import { SurveyLayerViewer } from "@astro-survey-atlas/sky-globe";
import "@astro-survey-atlas/sky-globe/theme.css";
```

The consumer must compile TypeScript (Vite, tsx or tsc with
`moduleResolution: "Bundler"`).

## Development

```sh
npm ci
npm run check   # tsc + node:test
```

Changes that alter API or appearance get a new minor tag; Assets and Workspace
upgrade together.

## Options

`new SurveyLayerViewer(canvas, manifest, surveys, ...callbacks, options?)`. Every
option defaults to the Assets public-site behaviour:

- `sourceIdForFootprint(footprint)` adds public `sourceIds` to context menus.
- `overlapContextMenu: true` opens the context menu in overlap mode, scoped to
  the component under the pointer (`componentId`).
- `onOverlapHover(hover)` receives `{ component, clientX, clientY }` or `null`
  for whole-component tooltips when component picking is enabled (see below).
  `component` is a `SurveyLayerOverlapComponent`, with its actual order, cells
  and any supplied source/area metadata; the app owns tooltip content.
- `onDrillDown(region)`: double-clicking a cell selects it and reports the
  region (same payload as the context menu) instead of focusing it. Assets
  leaves it unset; Workspace uses it to open Aladin.

User-asset layers (`setWorkspaceCoverageLayers`) support `preview` layers
(drawn and inspectable, never offered as available data) and `moc:` keys with
their own visibility (`setVisibleWorkspaceLayerKeys`). Apps may extend
`WorkspaceCoverageLayer` with their own fields; the globe ignores them.

## Overlap component picking (opt in)

`viewer.setOverlapPickingMode("cell" | "component")` defaults to `"cell"`:
existing overlap label clicks and single-cell inspection remain unchanged.
It is independent of `setInteractionMode("inspect" | "region")`.

In `"component"` mode, while `setOverlapMode(true)` is active:

- Left-clicking a label or a component's body invokes the existing constructor
  `onOverlapComponent(component)` callback. Only supplied overlap components
  can be picked, using NESTED membership at each component's actual order;
  no cell, depth or object selection/inspection runs. Empty sky does nothing.
- `options.onOverlapHover` reports the component under the pointer, including
  coordinates for positioning the app's tooltip. It clears on leaving/cancel,
  camera interaction/drag, mode changes, coverage rebuilds and disposal. Hover
  is suppressed while dragging; no synthetic cell hover is emitted.
- Entering component picking clears stale cell selection, inspection and hover
  without focusing or moving the camera. The active component set through
  `setActiveOverlapComponent(id)` owns `state.selectionAnchor`. Clicking reports
  a target; the app still decides whether to activate or focus it.

The exported `overlapComponentAtPixel(components, order, pixel)` helper returns
an exact-order member or `null`; it never projects parent/descendant cells.
`SurveyLayerOverlapPickingMode` and `SurveyLayerOverlapHover` are exported types.

## RA/Dec rectangles (opt in)

Rectangle drawing is **off by default** and independent of inspect/region and
cell/component selection. The app owns the draw button, numeric inputs and queries.

```ts
import type { SkyRectangle, SkyRectangleChangePhase } from "@astro-survey-atlas/sky-globe";

// In the constructor's options argument:
const options = {
  onRectangleChange(rectangle: SkyRectangle | null, phase: SkyRectangleChangePhase) {
    // "draft": update inputs; null means degenerate bounds or off-sphere.
    // "commit": valid rectangle; drawing has already exited.
    // "cancel": previous committed rectangle (or null); drawing has exited.
    // Do not echo drafts into setRectangleSelection: it disarms the drag.
  },
};

viewer.setRectangleDrawing(true);  // Explicitly arm a one-pointer drag.
viewer.setRectangleDrawing(false); // Cancel/disarm, restoring committed bounds.
viewer.setRectangleSelection({ raStart: 350, raEnd: 10, decMin: -5, decMax: 5 });
viewer.setRectangleSelection(null); // Clear the outline; no coverage selection.
```

- `SkyRectangle = { raStart: number; raEnd: number; decMin: number; decMax: number }`
  uses ICRS degrees. Numeric bounds must have RA in `[0, 360]` and
  `-90 ≤ decMin < decMax ≤ 90`. Increasing RA from start to end wraps through
  zero: `350 → 10` is narrow, `10 → 350` is wide, and only `0 → 360` is full RA.
  Equivalent endpoints otherwise mean zero width and are rejected.
- `setRectangleSelection(rectangle: SkyRectangle | null): void` validates and
  copies bounds, silently disarms any active drag, and changes only the outline.
  It never emits `onRectangleChange`; invalid bounds throw `RangeError` without
  changing the existing selection. Thus input changes cannot create callback loops.
- `setRectangleDrawing(enabled: boolean): void` clears pending click actions,
  freezes camera transition/inertia at the current pose, and disables navigation
  until commit or cancel. Drag RA unwraps continuously in either direction.
  Picking intersects the reference **unit sphere**, independent of survey shells,
  displayed HEALPix order, coverage membership, depth and overlap components.
- Only the active captured pointer can change the draft. Release off the sphere,
  a degenerate release, pointer cancellation/lost capture, Escape, window blur,
  disabling drawing or changing interaction/layout/overlap/camera mode cancels it.
  Committed bounds survive cancellation of a new draft. `reset()` and
  `clearTransientState()` clear the rectangle; disposal releases capture/listeners.
  Commit and cancel both restore controls according to the current presentation.
- The neutral outline samples constant-Dec parallels and RA meridians, clipped
  to the visible unit-sphere horizon; it is not a geodesic quadrilateral or a
  screen rectangle. Full-RA bands have no artificial seam. It communicates bounds,
  **not** a HEALPix approximation, data precision or coverage availability.

The exported pure helpers `validateSkyRectangle`, `rectangleRaSpan`,
`unwrapRectangleRa`, `rectangleFromDrag`, `rectangleNavigationEnabled` and
`rectangleOutlinePositions` are covered by headless tests. Viewer tests reuse real
rays/handlers with only GPU/DOM infrastructure stubbed.

## Selection anchor

`state.selectionAnchor` is the screen position and bounds an app uses to attach a
target callout. By default it follows selected cells; when none is selected in
overlap mode it follows the active overlap component (`setActiveOverlapComponent`).
Component picking instead gives that active component sole ownership of the
anchor, regardless of programmatic cell selections; without an active component
its anchor is `null`. Apps that draw a callout should keep gating it on their own
selection state (for example `selectedCellCount`) if they want cells only.

License: Apache-2.0.
