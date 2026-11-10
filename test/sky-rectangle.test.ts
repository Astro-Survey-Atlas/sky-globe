import assert from "node:assert/strict";
import test from "node:test";
import { cartesianToRaDec, raDecToCartesian } from "../src/coordinates.js";
import { rectangleFromDrag, rectangleNavigationEnabled, rectangleOutlinePositions, rectangleRaSpan, unwrapRectangleRa, validateSkyRectangle, type SkyRectangle } from "../src/sky-rectangle.js";

const crossing: SkyRectangle = { raStart: 350, raEnd: 10, decMin: -5, decMax: 15 };
const near = (actual: number, expected: number, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);

test("numeric bounds preserve crossing, wide, full RA, poles and caller ownership", () => {
  const validated = validateSkyRectangle(crossing);
  assert.deepEqual(validated, crossing);
  assert.notEqual(validated, crossing);
  near(rectangleRaSpan(validated), 20);
  near(rectangleRaSpan(validateSkyRectangle({ ...crossing, raStart: 10, raEnd: 350 })), 340);
  near(rectangleRaSpan(validateSkyRectangle({ raStart: 0, raEnd: 360, decMin: -90, decMax: 90 })), 360);
  near(rectangleRaSpan(validateSkyRectangle({ ...crossing, raStart: 360, raEnd: 10 })), 10);
  for (const rectangle of [
    { ...crossing, raStart: -1 }, { ...crossing, raEnd: 361 },
    { ...crossing, raStart: 10 }, { ...crossing, raStart: 360, raEnd: 0 },
    { ...crossing, decMin: 15 }, { ...crossing, decMin: 20 },
    { ...crossing, decMin: -91 }, { ...crossing, decMax: 91 },
    { ...crossing, raStart: NaN }, { ...crossing, decMax: Infinity },
  ]) assert.throws(() => validateSkyRectangle(rectangle), RangeError);
});

test("continuous RA unwrapping crosses zero in both directions without a 340-degree jump", () => {
  for (const [start, sequence, expected] of [
    [350, [355, 0, 5, 10], 370],
    [10, [5, 0, 355, 350], -10],
    [350, [5, 355, 0, 10], 370], // reverse course across the seam
    [10, [350, 10, 350], -10],
  ] as const) {
    let ra: number = start;
    for (const next of sequence) ra = unwrapRectangleRa(ra, next);
    near(ra, expected);
  }
  near(unwrapRectangleRa(0, 180), 180);
  near(unwrapRectangleRa(180, 0), 0);
});

test("drag endpoints select the same rectangle in either direction, including wide continuous trajectories", () => {
  assert.deepEqual(rectangleFromDrag({ raDeg: 350, decDeg: 15 }, 370, -5), crossing);
  assert.deepEqual(rectangleFromDrag({ raDeg: 10, decDeg: -5 }, -10, 15), crossing);
  assert.deepEqual(rectangleFromDrag({ raDeg: 10, decDeg: 15 }, 350, -5), { ...crossing, raStart: 10, raEnd: 350 });
  assert.deepEqual(rectangleFromDrag({ raDeg: 20, decDeg: 15 }, 380, -5), { ...crossing, raStart: 0, raEnd: 360 });
  assert.equal(rectangleFromDrag({ raDeg: 10, decDeg: 0 }, 10, 5), null);
  assert.equal(rectangleFromDrag({ raDeg: 10, decDeg: 0 }, 15, 0), null);
  assert.equal(rectangleFromDrag({ raDeg: 10, decDeg: 0 }, NaN, 5), null);
  assert.equal(rectangleFromDrag({ raDeg: 10, decDeg: 0 }, 15, 91), null);
});

test("sampled rectangle follows constant-Dec parallels and constant-RA meridians, not corner geodesics", () => {
  const rectangle = { raStart: 10, raEnd: 150, decMin: 30, decMax: 60 };
  const positions = rectangleOutlinePositions(rectangle);
  assert.ok(positions.length > 1000);
  for (let i = 0; i < positions.length; i += 3) {
    const point = { x: positions[i]!, y: positions[i + 1]!, z: positions[i + 2]! };
    near(Math.hypot(point.x, point.y, point.z), 1);
    const { raDeg, decDeg } = cartesianToRaDec(point);
    assert.ok([Math.abs(decDeg - 30), Math.abs(decDeg - 60), Math.abs(raDeg - 10), Math.abs(raDeg - 150)].some(delta => delta < 1e-7));
  }
  assert.ok(positions.some((_, i) => i % 3 === 1 && Math.abs(positions[i]! - Math.sin(Math.PI / 3)) < 1e-9));
});

test("wide and full RA outlines do not take shortcuts or add an artificial full-RA seam", () => {
  const wide = rectangleOutlinePositions({ raStart: 10, raEnd: 350, decMin: -20, decMax: 20 });
  assert.ok(wide.some((_, i) => i % 3 === 0 && Math.abs(cartesianToRaDec({ x: wide[i]!, y: wide[i + 1]!, z: wide[i + 2]! }).raDeg - 180) < 1e-7));
  const full = rectangleOutlinePositions({ raStart: 0, raEnd: 360, decMin: -20, decMax: 20 });
  assert.equal(full.length, 2 * 720 * 6);
  for (let i = 0; i < full.length; i += 3) near(Math.abs(cartesianToRaDec({ x: full[i]!, y: full[i + 1]!, z: full[i + 2]! }).decDeg), 20);
});

test("outline clipping hides rear hemisphere and clips crossing segments at the true unit-sphere horizon", () => {
  const cameraDirection = raDecToCartesian(0, 0, 3);
  const rectangle = { raStart: 250, raEnd: 110, decMin: -10, decMax: 10 };
  const visible = rectangleOutlinePositions(rectangle, cameraDirection);
  assert.ok(visible.length > 0);
  assert.ok(visible.length < rectangleOutlinePositions(rectangle).length);
  let horizonPoints = 0;
  for (let i = 0; i < visible.length; i += 3) {
    const dot = cameraDirection.x * visible[i]! + cameraDirection.y * visible[i + 1]! + cameraDirection.z * visible[i + 2]!;
    assert.ok(dot >= 1 - 1e-9, `rear point leaked: ${dot}`);
    if (Math.abs(dot - 1) < 1e-8) horizonPoints++;
  }
  assert.ok(horizonPoints >= 4);
  assert.deepEqual(rectangleOutlinePositions({ raStart: 170, raEnd: 190, decMin: -10, decMax: 10 }, cameraDirection), []);
});

test("controls restore from current presentation, transition and drawing state", () => {
  assert.equal(rectangleNavigationEnabled(1, false, false), true);
  assert.equal(rectangleNavigationEnabled(0.5, false, false), false);
  assert.equal(rectangleNavigationEnabled(1, true, false), false);
  assert.equal(rectangleNavigationEnabled(1, false, true), false);
  assert.equal(rectangleNavigationEnabled(0, true, true), false);
});
