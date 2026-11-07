# @astro-survey-atlas/sky-globe

The three.js HEALPix coverage globe shared by Astro Survey Atlas Assets and
Workspace, plus the tactical HUD design tokens (`theme.css`).

The package is the rendering core: data goes in (footprint manifests, survey
colors, overlap pixels, sky-depth results) and interaction comes out through
callbacks. Fetching, i18n and page panels stay in each app.

- Runtime imports are limited to `three` (peer dependency), `healpixjs` and the
  package's own modules. `test/sky-globe-boundary.test.ts` in Assets enforces it.
- `sky-depth-types.ts` mirrors the Assets sky-depth wire types; the same test
  fails if they drift.
- `exports` points at TypeScript sources, which Vite, tsx and tsc consume directly.

## Options

`new SurveyLayerViewer(canvas, manifest, surveys, ...callbacks, options?)`. Every
option defaults to the Assets public-site behaviour:

- `sourceIdForFootprint(footprint)` adds public `sourceIds` to context menus.
- `overlapContextMenu: true` opens the context menu in overlap mode, scoped to
  the component under the pointer (`componentId`).

User-asset layers (`setWorkspaceCoverageLayers`) support `preview` layers
(drawn and inspectable, never offered as available data) and `moc:` keys with
their own visibility (`setVisibleWorkspaceLayerKeys`). Apps may extend
`WorkspaceCoverageLayer` with their own fields; the globe ignores them.

License: Apache-2.0.
