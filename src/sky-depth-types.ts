/** Wire types of the Assets sky-depth API, as consumed by the depth layer.
 * Kept structurally identical to `src/sky-depth.ts` in Assets; the
 * `sky-globe-boundary` test fails if the two drift apart. */
export type SkyDepthAxis = "distance" | "redshift";
export type SkyDepthMode = "points" | "bars" | "aggregate";
export interface SkyDepthSource { surveyId: string; releaseId: string; role?: "survey" | "reference" }
export interface SkyDepthQuery {
  order: number;
  cells: number[];
  sources: SkyDepthSource[];
  axis: SkyDepthAxis;
  mode: SkyDepthMode;
}
export interface SkyDepthPoint {
  objectId: string;
  raDeg: number;
  decDeg: number;
  redshift: number;
  redshiftError: number | null;
  redshiftFrame: string;
  distanceMpc: number | null;
  measurementErrorMpc: number | null;
  sourceRow?: number;
}
export interface SkyDepthVoxel {
  order: number;
  pixel: number;
  radialMin: number;
  radialMax: number;
  radialMean: number;
  count: number;
}
export interface SkyDepthCellExtent {
  order: number;
  pixel: number;
  radialMax: number;
  count: number;
}
export interface SkyDepthSourceResult extends SkyDepthSource {
  status: "available" | "redshift-only" | "empty" | "no-measurements" | "not-connected" | "unavailable";
  message?: string;
  label: string;
  selectedInputRows?: number;
  redshiftCount?: number;
  distanceCount?: number;
  selectedCount: number;
  mode: SkyDepthMode;
  points: SkyDepthPoint[];
  voxels: SkyDepthVoxel[];
  cellExtents?: SkyDepthCellExtent[];
  aggregationOrder?: number;
  radialRange?: [number, number];
  snapshotSha256?: string;
  scope?: { kind: "row-window"; rowStartInclusive: number; rowStopExclusive: number; catalogueRows: number; skyRegionComplete: false };
}
export interface SkyDepthResponse {
  schemaVersion: 1;
  coordinateFrame: "ICRS";
  ordering: "NESTED";
  query: SkyDepthQuery;
  sources: SkyDepthSourceResult[];
  distanceBasis: { kind: "redshift-space-comoving"; model: "Astropy Planck18"; unit: "Mpc"; peculiarVelocityCorrected: false; cmbFrameCorrected: false; uncertainty: "measurement-only" };
}
export interface SkyDepthExample {
  available: boolean;
  selection?: { order: number; cells: number[]; sources: SkyDepthSource[] };
  message?: string;
}
