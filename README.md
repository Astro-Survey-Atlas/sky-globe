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
- `onDrillDown(region)`: double-clicking a cell selects it and reports the
  region (same payload as the context menu) instead of focusing it. Assets
  leaves it unset; Workspace uses it to open Aladin.

User-asset layers (`setWorkspaceCoverageLayers`) support `preview` layers
(drawn and inspectable, never offered as available data) and `moc:` keys with
their own visibility (`setVisibleWorkspaceLayerKeys`). Apps may extend
`WorkspaceCoverageLayer` with their own fields; the globe ignores them.

License: Apache-2.0.
