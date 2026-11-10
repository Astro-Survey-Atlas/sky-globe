import { normalizeRa, raDecToCartesian, type CartesianCoordinate, type EquatorialCoordinate } from "./coordinates.js";

/** ICRS degrees. Increasing RA from start to end, wrapping through zero.
 * Only 0 → 360 denotes full RA; equivalent endpoints otherwise have zero width. */
export interface SkyRectangle {
  raStart: number;
  raEnd: number;
  decMin: number;
  decMax: number;
}

export type SkyRectangleChangePhase = "draft" | "commit" | "cancel";

/** Validate without swapping endpoints or silently wrapping numeric input. */
export function validateSkyRectangle(rectangle: SkyRectangle): SkyRectangle {
  const { raStart, raEnd, decMin, decMax } = rectangle;
  if (![raStart, raEnd, decMin, decMax].every(Number.isFinite)
    || raStart < 0 || raStart > 360 || raEnd < 0 || raEnd > 360
    || decMin < -90 || decMax > 90 || decMin >= decMax
    || rectangleRaSpan(rectangle) === 0) {
    throw new RangeError("Expected non-empty ICRS rectangle: RA in [0, 360], -90 ≤ decMin < decMax ≤ 90");
  }
  return { raStart, raEnd, decMin, decMax };
}

export function rectangleRaSpan(rectangle: SkyRectangle): number {
  return rectangle.raStart === 0 && rectangle.raEnd === 360
    ? 360 : normalizeRa(rectangle.raEnd - rectangle.raStart);
}

/** Follow the nearest continuous branch, including either direction across RA=0. */
export function unwrapRectangleRa(previousUnwrappedRa: number, nextRa: number): number {
  const difference = normalizeRa(nextRa) - normalizeRa(previousUnwrappedRa);
  let delta = normalizeRa(difference + 180) - 180;
  if (delta === -180 && difference > 0) delta = 180;
  return previousUnwrappedRa + delta;
}

/** Drag direction does not reverse the selected interval. RA is already unwrapped
 * along the pointer trajectory; a single pair of wrapped endpoints is insufficient. */
export function rectangleFromDrag(start: EquatorialCoordinate, unwrappedRa: number, decDeg: number): SkyRectangle | null {
  if (![start.raDeg, start.decDeg, unwrappedRa, decDeg].every(Number.isFinite)
    || Math.abs(start.decDeg) > 90 || Math.abs(decDeg) > 90) return null;
  const lowRa = Math.min(start.raDeg, unwrappedRa);
  const span = Math.abs(unwrappedRa - start.raDeg);
  const decMin = Math.min(start.decDeg, decDeg);
  const decMax = Math.max(start.decDeg, decDeg);
  if (span < 1e-10 || decMax - decMin < 1e-10) return null;
  return {
    raStart: span >= 360 ? 0 : normalizeRa(lowRa),
    raEnd: span >= 360 ? 360 : normalizeRa(lowRa + span),
    decMin,
    decMax,
  };
}

/** Controls are restored according to the live presentation, not a stale snapshot
 * taken while a camera transition temporarily disabled navigation. */
export function rectangleNavigationEnabled(homeProgress: number, transitioning: boolean, drawing: boolean): boolean {
  return homeProgress >= 0.999 && !transitioning && !drawing;
}

/** Sample actual parallels and meridians on the reference unit sphere. Output is
 * independent line segments, not geodesics joining the four corners. If supplied,
 * the camera clips each segment to the visible hemisphere (including its horizon).
 * This is a visual outline, not a spatial coverage approximation or data precision. */
export function rectangleOutlinePositions(rectangle: SkyRectangle, camera?: CartesianCoordinate): number[] {
  validateSkyRectangle(rectangle);
  const span = rectangleRaSpan(rectangle);
  const positions: number[] = [];
  const visibility = (point: CartesianCoordinate): number => camera
    ? camera.x * point.x + camera.y * point.y + camera.z * point.z - 1 : 1;
  const edge = (ra0: number, dec0: number, ra1: number, dec1: number): void => {
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(ra1 - ra0), Math.abs(dec1 - dec0)) / 0.5));
    const pointAt = (t: number) => raDecToCartesian(ra0 + (ra1 - ra0) * t, dec0 + (dec1 - dec0) * t);
    for (let step = 0; step < steps; step++) {
      let t0 = step / steps;
      let t1 = (step + 1) / steps;
      let a = pointAt(t0);
      let b = pointAt(t1);
      const aVisible = visibility(a) >= 0;
      const bVisible = visibility(b) >= 0;
      if (!aVisible && !bVisible) continue;
      if (aVisible !== bVisible) {
        // Bisect in RA/Dec, not along a straight chord or a great circle.
        for (let iteration = 0; iteration < 30; iteration++) {
          const mid = (t0 + t1) / 2;
          if ((visibility(pointAt(mid)) >= 0) === aVisible) t0 = mid;
          else t1 = mid;
        }
        const horizon = pointAt((t0 + t1) / 2);
        if (aVisible) b = horizon;
        else a = horizon;
      }
      if (Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) > 1e-12) {
        positions.push(a.x, a.y, a.z, b.x, b.y, b.z);
      }
    }
  };
  const end = rectangle.raStart + span;
  edge(rectangle.raStart, rectangle.decMin, end, rectangle.decMin);
  edge(rectangle.raStart, rectangle.decMax, end, rectangle.decMax);
  // Full-RA bands have no artificial seam/meridian boundary.
  if (span < 360) {
    edge(rectangle.raStart, rectangle.decMin, rectangle.raStart, rectangle.decMax);
    edge(end, rectangle.decMin, end, rectangle.decMax);
  }
  return positions;
}
