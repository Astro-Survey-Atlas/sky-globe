import assert from "node:assert/strict";
import test from "node:test";

import {
  cartesianToRaDec,
  healpixPixelFromSceneDirection,
  normalizeLayerOrder,
  normalizeSurveyFootprintManifest,
  pixelCenter,
  raDecToCartesian,
  sphericalCellCenter,
  surveyColorFor,
} from "../src/index.js";

test("RA/Dec survives a round trip through scene coordinates", () => {
  for (const [ra, dec] of [[0, 0], [10.25, 20.5], [359.75, -42.25], [180, 89.5]] as const) {
    const back = cartesianToRaDec(raDecToCartesian(ra, dec));
    assert.ok(Math.abs(back.raDeg - ra) < 1e-9, `ra ${ra} -> ${back.raDeg}`);
    assert.ok(Math.abs(back.decDeg - dec) < 1e-9, `dec ${dec} -> ${back.decDeg}`);
  }
});

test("a cell centre picks its own NESTED pixel", () => {
  for (const nside of [1, 16, 256]) {
    for (const pixel of [0, 7, 12 * nside * nside - 1]) {
      assert.equal(healpixPixelFromSceneDirection(nside, sphericalCellCenter(nside, pixel, 1)), pixel);
    }
  }
});

test("pixelCenter agrees with the scene-space cell centre", () => {
  const center = pixelCenter(4, 1702 % (12 * 16 * 16));
  const scene = cartesianToRaDec(sphericalCellCenter(16, 1702 % (12 * 16 * 16), 1));
  assert.ok(Math.abs(center.raDeg - scene.raDeg) < 1e-6);
  assert.ok(Math.abs(center.decDeg - scene.decDeg) < 1e-6);
});

test("layer order keeps stored known keys and drops unknown ones", () => {
  assert.deepEqual(normalizeLayerOrder(["a", "b", "c"], ["c", "x", "a"], []), ["c", "a"]);
  // With a default order, every remaining known key is appended.
  assert.deepEqual(normalizeLayerOrder(["a", "b", "c"], ["c", "x"], ["a"]), ["c", "a", "b"]);
});

test("survey colours prefer the catalogue colour and fall back deterministically", () => {
  assert.equal(surveyColorFor("euclid", "#D95F59"), "#d95f59");
  assert.equal(surveyColorFor("euclid", "#376b9b"), surveyColorFor("euclid"));
  assert.match(surveyColorFor("unknown-survey"), /^#[0-9a-f]{6}$/);
});

test("footprint manifests reject cells outside the declared NSIDE", () => {
  const footprint = {
    surveyId: "s", releaseId: "r", product: "p", label: "l", nside: 1, pixels: [0, 11],
    quality: "moc", retrievedAt: "2026-01-01T00:00:00Z", notes: "fixture",
  };
  const manifest = { schemaVersion: 1, generatedAt: "2026-01-01T00:00:00Z", coordinateFrame: "ICRS", nside: 1, footprints: [footprint] };
  assert.equal(normalizeSurveyFootprintManifest(manifest).footprints.length, 1);
  assert.throws(() => normalizeSurveyFootprintManifest({ ...manifest, footprints: [{ ...footprint, pixels: [12] }] }));
});
