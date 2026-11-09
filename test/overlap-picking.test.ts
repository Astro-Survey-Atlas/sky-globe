import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import test, { type TestContext } from "node:test";
import * as THREE from "three";

import { healpixPixelFromSceneDirection, sphericalCellCenter } from "../src/spherical-cell-geometry.js";
import { SkyDepthLayer } from "../src/sky-depth-layer.js";
import type { SurveyFootprintManifest } from "../src/survey-footprints.js";
import type { SurveyLayerContextMenu, SurveyLayerOverlapComponent, SurveyLayerOverlapHover, SurveyLayerViewerOptions } from "../src/survey-layer-viewer.js";

// Only replace GPU/DOM infrastructure. The viewer, raycaster, membership,
// geometry, public methods and registered pointer handlers run unchanged.
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const threeUrl = import.meta.resolve("three");
const hudUrl = new URL("../src/hud-scene.ts", import.meta.url).href;
const controlsUrl = moduleUrl(`
  import { EventDispatcher, Vector3 } from ${JSON.stringify(threeUrl)};
  export class OrbitControls extends EventDispatcher {
    target = new Vector3(); enabled = true;
    constructor(camera) { super(); this.camera = camera; globalThis.__overlapTestControls = this; }
    update() { this.camera.lookAt(this.target); this.camera.updateMatrixWorld(true); return false; }
    dispose() {}
  }
`);
const rendererUrl = moduleUrl(`
  export * from ${JSON.stringify(threeUrl)};
  export class WebGLRenderer {
    debug = {}; capabilities = { isWebGL2: true }; ratio = 1;
    setPixelRatio(value) { this.ratio = value; }
    getPixelRatio() { return this.ratio; }
    setSize() {} setClearColor() {} dispose() {}
  }
`);
const hudStubUrl = moduleUrl(`
  export * from ${JSON.stringify(hudUrl)};
  import { Group, Mesh, MeshBasicMaterial, SphereGeometry } from ${JSON.stringify(threeUrl)};
  export function buildHudBackdrop() {
    const group = new Group();
    const body = new Mesh(new SphereGeometry(0.997, 128, 96), new MeshBasicMaterial());
    body.raycast = () => undefined;
    group.add(body);
    return { group, setTheme() {}, setQuiet() {} };
  }
`);
const passesUrl = moduleUrl(`
  import { UniformsUtils } from ${JSON.stringify(threeUrl)};
  export class EffectComposer { addPass() {} setSize() {} render() {} }
  export class RenderPass { constructor(scene) { globalThis.__overlapTestScene = scene; } }
  export class UnrealBloomPass {}
  export class OutputPass {}
  export class ShaderPass { constructor(shader) { this.uniforms = UniformsUtils.clone(shader.uniforms); } }
`);
const canStubRenderer = typeof nodeModule.registerHooks === "function";
const hooks = canStubRenderer ? nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.endsWith("/src/survey-layer-viewer.ts")) {
      const url = specifier === "three" ? rendererUrl
        : specifier.endsWith("/OrbitControls.js") ? controlsUrl
        : specifier.includes("/postprocessing/") ? passesUrl
        : specifier === "./hud-scene.js" ? hudStubUrl : null;
      if (url) return { url, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
}) : null;
const { SurveyLayerViewer, overlapComponentAtPixel } = await import("../src/survey-layer-viewer.js");
hooks?.deregister();
// registerHooks was added in Node 22.15; keep pure tests usable on earlier Node 22.
const viewerTest = (name: string, fn: (t: TestContext) => void) => test(name, {
  skip: canStubRenderer ? false : "headless viewer stubs require Node >=22.15",
}, fn);

test("exact-order membership preserves identity and metadata, never projects cells", () => {
  const coarse: SurveyLayerOverlapComponent = { id: "coarse", order: 4, cells: [7, 12], sourceIds: ["public:fixture"], areaDeg2: 1.25 };
  const fine: SurveyLayerOverlapComponent = { id: "fine", order: 5, cells: [7, 49] };
  const components = [coarse, fine];
  assert.equal(overlapComponentAtPixel(components, 4, 7), coarse);
  assert.equal(overlapComponentAtPixel(components, 5, 7), fine);
  assert.equal(overlapComponentAtPixel(components, 5, 48), null, "a declared O4 parent must not invent O5 children");
  assert.equal(overlapComponentAtPixel([fine], 4, 12), null, "an O5 child must not invent O4 membership");
  assert.equal(overlapComponentAtPixel(components, 6, 7), null);
  assert.equal(overlapComponentAtPixel([], 4, 7), null);
  assert.equal(overlapComponentAtPixel(components, 4, 8), null);
  for (const [order, pixel] of [[-1, 7], [4.5, 7], [4, -1], [4, 7.5], [4, NaN], [4, 12 * 4 ** 4]]) {
    assert.equal(overlapComponentAtPixel(components, order!, pixel!), null);
  }
});

class TestCanvas extends EventTarget {
  dataset: Record<string, string> = {};
  width = 800;
  height = 600;
  clientWidth = 800;
  clientHeight = 600;
  parentElement = null;
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  getContext() {
    return new Proxy({}, { get: (_target, key) => key === "measureText" ? () => ({ width: 20 }) : () => undefined });
  }
}

function fixture(t: TestContext, options: SurveyLayerViewerOptions = {}, explicitOverlap = true) {
  const restoreGlobals: Array<() => void> = [];
  const globalStub = (name: string, value: unknown) => {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restoreGlobals.push(() => { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); });
  };
  globalStub("document", { documentElement: { dataset: { theme: "dark" } }, createElement: () => new TestCanvas() });
  globalStub("window", { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 });
  globalStub("ResizeObserver", class { observe() {} disconnect() {} });
  let nextFrame: FrameRequestCallback | null = null;
  globalStub("requestAnimationFrame", (callback: FrameRequestCallback) => { nextFrame = callback; return 1; });
  globalStub("cancelAnimationFrame", () => { nextFrame = null; });
  const frame = (now = performance.now()) => {
    assert.ok(nextFrame, "a render frame must be queued");
    const callback = nextFrame;
    nextFrame = null;
    callback(now);
  };
  globalStub("Path2D", class { moveTo() {} lineTo() {} closePath() {} });
  globalStub("__overlapTestControls", null);
  globalStub("__overlapTestScene", null);
  const canvas = new TestCanvas();
  const picks: SurveyLayerOverlapComponent[] = [];
  const hovers: Array<SurveyLayerOverlapHover | null> = [];
  const inspections: unknown[] = [];
  const selections: unknown[] = [];
  const cellHovers: unknown[] = [];
  const objectPicks: unknown[] = [];
  const menus: SurveyLayerContextMenu[] = [];
  const footprint = {
    surveyId: "s", releaseId: "r", product: "p", label: "fixture", nside: 16, pixels: [100, 101, 102],
    quality: "moc", retrievedAt: "2026-01-01T00:00:00Z", notes: "synthetic fixture",
  };
  const manifest = {
    schemaVersion: 1, generatedAt: footprint.retrievedAt, coordinateFrame: "ICRS", nside: 16,
    footprints: [footprint, { ...footprint, surveyId: "t" }],
  } as SurveyFootprintManifest;
  const viewer = new SurveyLayerViewer(
    canvas as unknown as HTMLCanvasElement, manifest, [{ id: "s" }, { id: "t" }],
    value => selections.push(value), value => cellHovers.push(value), value => inspections.push(value),
    value => menus.push(value), () => undefined, value => objectPicks.push(value), value => picks.push(value),
    { ...options, onOverlapHover: value => hovers.push(value) },
  );
  const controls = (globalThis as unknown as { __overlapTestControls: THREE.EventDispatcher<{ start: {}; end: {}; change: {} }> & { camera: THREE.PerspectiveCamera; update(): boolean } }).__overlapTestControls;
  t.after(() => { viewer.dispose({ releaseContext: false }); restoreGlobals.reverse().forEach(restore => restore()); });
  viewer.setVisibleSurveys(["s", "t"]);
  const component: SurveyLayerOverlapComponent = { id: "C01", order: 4, cells: [100, 101], sourceIds: ["public:fixture"], areaDeg2: 2 };
  if (explicitOverlap) viewer.setOverlapCoverage(16, [100, 101, 102], [component]);
  let pointerX = 400;
  let pointerY = 300;
  const aim = (order: number, pixel: number) => {
    const direction = sphericalCellCenter(2 ** order, pixel, 1);
    viewer.restoreCameraPose({ position: direction.clone().multiplyScalar(3).toArray() as [number, number, number], target: [0, 0, 0], up: [0, 1, 0], fov: 48 });
    viewer.setViewportRightInset(0);
    const camera = (controls as unknown as { camera: THREE.PerspectiveCamera }).camera;
    const projected = direction.clone().project(camera);
    pointerX = (projected.x + 1) * 400;
    pointerY = (1 - projected.y) * 300;
  };
  const pointer = (type: string, x = pointerX, y = pointerY, extras: Record<string, unknown> = {}) => {
    const event = new Event(type);
    Object.assign(event, { button: 0, buttons: type === "pointerdown" ? 1 : 0, clientX: x, clientY: y, ctrlKey: false, metaKey: false, ...extras });
    canvas.dispatchEvent(event);
  };
  const click = (x = pointerX, y = pointerY, extras: Record<string, unknown> = {}) => { pointer("pointerdown", x, y, extras); pointer("pointerup", x, y, extras); };
  const coordinates = () => ({ clientX: pointerX, clientY: pointerY });
  const scene = () => (globalThis as unknown as { __overlapTestScene: THREE.Scene }).__overlapTestScene;
  const labels = () => {
    const groups = scene().children.filter((object): object is THREE.Group => object instanceof THREE.Group);
    return groups.flatMap(group => group.children).filter(object => object instanceof THREE.Sprite && object.userData.overlapComponent);
  };
  return { viewer, canvas, controls, manifest, component, picks, hovers, inspections, selections, cellHovers, objectPicks, menus, aim, pointer, click, coordinates, labels, scene, frame };
}

viewerTest("component body clicks bypass depth, objects and cell inspection; empty sky is inert", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("C01"); // Active components have no label: this must hit the body.
  f.aim(4, 100);
  const depthPick = t.mock.method(SkyDepthLayer.prototype, "pick", () => { throw Error("component clicks must bypass depth picking"); });
  f.inspections.length = 0;
  f.selections.length = 0;
  const before = f.viewer.cameraPose;
  f.click();
  f.click(undefined, undefined, { ctrlKey: true });
  f.click(undefined, undefined, { metaKey: true });
  assert.equal(f.picks.length, 3);
  assert.deepEqual(f.picks[0], f.component);
  assert.equal(depthPick.mock.callCount(), 0);
  assert.equal(f.viewer.state.selectedCellCount, 0);
  assert.deepEqual(f.inspections, []);
  assert.deepEqual(f.selections, []);
  assert.deepEqual(f.objectPicks, []);
  assert.deepEqual(f.viewer.cameraPose, before);
  f.aim(4, 102); // Drawn overlap pixel that belongs to no supplied component.
  f.click();
  f.aim(4, 900); // Uncovered direction.
  f.click();
  f.click(50, 50); // Ray misses the sphere.
  assert.equal(f.picks.length, 3);
});

viewerTest("component picking uses each real component order, not the display order", t => {
  const f = fixture(t);
  const component = { id: "fine", order: 5, cells: [401], sourceIds: ["public:fine"] };
  f.viewer.setOverlapCoverage(16, [100], [component]);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("fine");
  f.aim(5, 401);
  f.click();
  assert.deepEqual(f.picks, [component]);
  f.aim(5, 400); // Same O4 parent, but not an actual component cell.
  f.click();
  assert.equal(f.picks.length, 1);
});

viewerTest("label hits resolve supplied components and preserve metadata", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.aim(4, 100);
  const [label] = f.labels();
  assert.ok(label);
  // Place the real sprite in empty canvas space: a hit here cannot be a body hit.
  const camera = (f.controls as unknown as { camera: THREE.PerspectiveCamera }).camera;
  const ndc = new THREE.Vector3(0.9, 0.9, 0.5).unproject(camera);
  const ray = ndc.sub(camera.position).normalize();
  label.position.copy(camera.position).addScaledVector(ray, 2);
  label.updateMatrixWorld(true);
  f.click(760, 30);
  assert.deepEqual(f.picks, [f.component]);
  f.pointer("pointermove", 760, 30);
  assert.deepEqual(f.hovers.at(-1), { component: f.component, clientX: 760, clientY: 30 });
  label.userData.overlapComponent = { id: "invented", order: 4, cells: [100] };
  f.click(760, 30);
  assert.equal(f.picks.length, 1, "unknown labels cannot invent a selectable component");
});

viewerTest("component setter retains source/area metadata and mode entry works before overlap opens", t => {
  const f = fixture(t);
  f.viewer.setOverlapComponents([f.component]);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setRegionSelection([102]);
  f.viewer.setOverlapMode(true);
  assert.deepEqual(f.viewer.state.selectedPixels, []);
  f.viewer.setActiveOverlapComponent("C01");
  f.aim(4, 100);
  f.click();
  assert.deepEqual(f.picks, [f.component]);
});

viewerTest("hover carries component metadata and clears on exit, cancel, drag, modes, updates and disposal", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("C01");
  f.aim(4, 100);
  const hover = () => { f.pointer("pointermove"); assert.deepEqual(f.hovers.at(-1), { component: f.component, ...f.coordinates() }); };
  hover();
  for (const type of ["pointerleave", "pointercancel"]) {
    f.pointer(type);
    assert.equal(f.hovers.at(-1), null);
    hover();
  }
  f.pointer("pointerdown");
  assert.equal(f.hovers.at(-1), null);
  f.pointer("pointermove", 450, 300, { buttons: 1 });
  assert.equal(f.hovers.at(-1), null);
  f.pointer("pointerup", 450, 300);
  assert.equal(f.picks.length, 0);
  hover();
  f.controls.dispatchEvent({ type: "start" });
  f.pointer("pointermove");
  assert.equal(f.hovers.at(-1), null);
  f.controls.dispatchEvent({ type: "end" });
  hover();
  f.viewer.setOverlapPickingMode("cell");
  assert.equal(f.hovers.at(-1), null);
  const count = f.hovers.length;
  f.pointer("pointermove");
  assert.equal(f.hovers.length, count, "legacy overlap mode must not emit component hover");
  f.viewer.setOverlapPickingMode("component");
  hover();
  f.viewer.setInteractionMode("region");
  assert.equal(f.hovers.at(-1), null);
  hover();
  f.aim(4, 900);
  f.pointer("pointermove");
  assert.equal(f.hovers.at(-1), null);
  f.aim(4, 100);
  hover();
  f.viewer.setOverlapCoverage(16, [100, 101], [f.component]);
  assert.equal(f.hovers.at(-1), null);
  hover();
  f.viewer.setOverlapMode(false);
  assert.equal(f.hovers.at(-1), null);
  f.viewer.setOverlapCoverage(16, [100, 101], [f.component]);
  f.viewer.setOverlapMode(true);
  f.viewer.setActiveOverlapComponent("C01");
  hover();
  f.viewer.dispose({ releaseContext: false });
  assert.equal(f.hovers.at(-1), null);
  const disposedCount = f.hovers.length;
  f.pointer("pointermove");
  assert.equal(f.hovers.length, disposedCount);
});

viewerTest("entering component picking clears stale cells without moving the camera and anchors the active component", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setActiveOverlapComponent("C01");
  f.aim(4, 100);
  f.viewer.setRegionSelection([102]);
  assert.deepEqual(f.viewer.state.selectedPixels, [102]);
  const before = f.viewer.cameraPose;
  f.viewer.setOverlapPickingMode("component");
  assert.deepEqual(f.viewer.cameraPose, before);
  assert.deepEqual(f.viewer.state.selectedPixels, []);
  assert.equal(f.inspections.at(-1), null);
  assert.equal(f.cellHovers.at(-1), null);
  assert.equal(f.selections.at(-1), null);
  const anchor = f.viewer.state.selectionAnchor;
  assert.ok(anchor);
  f.viewer.setRegionSelection([102]);
  assert.deepEqual(f.viewer.state.selectionAnchor, anchor, "programmatic cell selection cannot steal the component anchor");
  f.viewer.setActiveOverlapComponent(null);
  assert.equal(f.viewer.state.selectionAnchor, null);
});

viewerTest("normal view retains cell click/hover even when component picking is configured", t => {
  const f = fixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.viewer.setOverlapPickingMode("component");
  f.aim(4, 100);
  f.pointer("pointermove");
  assert.equal((f.cellHovers.at(-1) as { pixel: number }).pixel, 100);
  assert.deepEqual(f.hovers, []);
  f.click();
  t.mock.timers.tick(221);
  assert.deepEqual(f.viewer.state.selectedPixels, [100]);
  assert.equal((f.inspections.at(-1) as { kind: string }).kind, "coverage-cell");
  assert.deepEqual(f.picks, []);
});

for (const [name, order, pixel, angle] of [["limb", 4, 100, 69.8], ["fine-order boundary", 9, 100 * 4 ** 5 + 17, 50]] as const) {
  viewerTest(`active rendered overlap ${name} is clickable and hoverable at its own surface`, t => {
    const f = fixture(t);
    const component = { id: "active", order, cells: [pixel] };
    f.viewer.setOverlapCoverage(16, [100], [component]);
    f.viewer.setOverlapMode(true);
    f.viewer.setOverlapPickingMode("component");
    f.viewer.setActiveOverlapComponent("active");
    let activeMesh: THREE.Mesh | undefined;
    f.scene().traverse(object => {
      if (object instanceof THREE.Mesh && object.material instanceof THREE.MeshBasicMaterial && object.material.opacity === 0.05) activeMesh = object;
    });
    assert.ok(activeMesh);
    f.scene().updateMatrixWorld(true);
    const position = activeMesh.geometry.getAttribute("position");
    const point = [0, 1, 2].reduce((sum, index) => sum.add(new THREE.Vector3().fromBufferAttribute(position, index)), new THREE.Vector3()).divideScalar(3).applyMatrix4(activeMesh.matrixWorld);
    const direction = point.clone().normalize();
    const tangent = new THREE.Vector3(0, 1, 0).cross(direction).normalize();
    const radians = THREE.MathUtils.degToRad(angle);
    const cameraPosition = direction.clone().multiplyScalar(3 * Math.cos(radians)).addScaledVector(tangent, 3 * Math.sin(radians));
    f.viewer.restoreCameraPose({ position: cameraPosition.toArray() as [number, number, number], target: [0, 0, 0], up: [0, 1, 0], fov: 48 });
    f.viewer.setViewportRightInset(0);
    const camera = f.controls.camera;
    const projected = point.clone().project(camera);
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(new THREE.Vector2(projected.x, projected.y), camera);
    assert.ok(raycaster.intersectObject(activeMesh).length, "the pointer hits the actual visible active fill");
    const oldPoint = raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1.02), new THREE.Vector3());
    if (name === "limb") assert.equal(oldPoint, null, "the lower overlap shell misses this visible limb");
    else assert.notEqual(healpixPixelFromSceneDirection(2 ** order, oldPoint!), pixel, "the lower shell maps to a different fine cell");
    const x = (projected.x + 1) * 400;
    const y = (1 - projected.y) * 300;
    f.click(x, y);
    assert.deepEqual(f.picks, [component]);
    f.pointer("pointermove", x, y);
    assert.deepEqual(f.hovers.at(-1), { component, clientX: x, clientY: y });
  });
}

viewerTest("rendered overlap body picking does not hit components hidden behind the opaque sky", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("C01");
  const position = sphericalCellCenter(16, 100, -3);
  f.viewer.restoreCameraPose({ position: position.toArray() as [number, number, number], target: [0, 0, 0], up: [0, 1, 0], fov: 48 });
  const projected = new THREE.Vector3().project(f.controls.camera);
  const x = (projected.x + 1) * 400;
  const y = (1 - projected.y) * 300;
  f.click(x, y);
  f.pointer("pointermove", x, y);
  assert.deepEqual(f.picks, []);
  assert.deepEqual(f.hovers, []);
});

viewerTest("component context menus report only the exact component without selecting cells", t => {
  const f = fixture(t, { overlapContextMenu: true, sourceIdForFootprint: () => "public:from-footprint" });
  // Numeric cell 100 also exists at manifest O4, but must not imply O5 membership.
  const component = { id: "fine", order: 5, cells: [100], sourceIds: ["public:component", "private:excluded"] };
  f.viewer.setOverlapCoverage(16, [100, 101, 102], [component]);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("fine");
  f.aim(5, 100);
  f.inspections.length = 0;
  f.selections.length = 0;
  f.pointer("contextmenu");
  assert.deepEqual(f.menus, [{ ...f.coordinates(), nside: 32, pixels: [100], componentId: "fine", surveyIds: [], releaseIds: [], assetIds: [], sourceIds: ["public:component"] }]);
  assert.equal(f.viewer.state.selectedCellCount, 0);
  assert.deepEqual(f.inspections, []);
  assert.deepEqual(f.selections, []);
  f.aim(4, 102); // Rendered overlap, but no actual supplied component.
  f.pointer("contextmenu");
  f.aim(4, 900);
  f.pointer("contextmenu");
  f.pointer("contextmenu", 50, 50);
  assert.equal(f.menus.length, 1);
  assert.equal(f.viewer.state.selectedCellCount, 0);
});

viewerTest("same-order component menus retain real memberships and default cell menus still select", t => {
  const f = fixture(t, { overlapContextMenu: true });
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("C01");
  f.aim(4, 100);
  f.pointer("contextmenu");
  assert.deepEqual(f.menus[0], { ...f.coordinates(), nside: 16, pixels: [100, 101], componentId: "C01", surveyIds: ["s", "t"], releaseIds: ["r"], assetIds: [] });
  assert.equal(f.viewer.state.selectedCellCount, 0);
  f.viewer.setOverlapPickingMode("cell");
  f.pointer("contextmenu");
  assert.deepEqual(f.viewer.state.selectedPixels, [100]);
  assert.deepEqual(f.menus[1]?.pixels, [100]);
});

viewerTest("generated overlap labels survive cell-component-cell toggles without supplied pixels", t => {
  const f = fixture(t, {}, false);
  f.viewer.setOverlapMode(true);
  const before = f.labels().map(label => label.userData.overlapComponent);
  assert.ok(before.length);
  f.viewer.setOverlapPickingMode("component");
  assert.deepEqual(f.labels(), [], "generated components are not selectable in component mode");
  f.viewer.setOverlapPickingMode("cell");
  assert.deepEqual(f.labels().map(label => label.userData.overlapComponent), before);
  f.aim(4, 100);
  const label = f.labels()[0]!;
  const projected = label.position.clone().project(f.controls.camera);
  f.click((projected.x + 1) * 400, (1 - projected.y) * 300);
  assert.deepEqual(f.picks, [before[0]]);
});

viewerTest("component label context menus need no underlying coverage cell", t => {
  const f = fixture(t, { overlapContextMenu: true });
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.aim(4, 100);
  const label = f.labels()[0]!;
  const camera = f.controls.camera;
  const ray = new THREE.Vector3(0.9, 0.9, 0.5).unproject(camera).sub(camera.position).normalize();
  label.position.copy(camera.position).addScaledVector(ray, 2);
  f.pointer("contextmenu", 760, 30);
  assert.equal(f.menus[0]?.componentId, "C01");
  assert.deepEqual(f.menus[0]?.pixels, [100, 101]);
  assert.equal(f.viewer.state.selectedCellCount, 0);
});

viewerTest("restoring a camera pose clears component hover without controls start", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("C01");
  f.aim(4, 100);
  f.pointer("pointermove");
  assert.ok(f.hovers.at(-1));
  f.aim(4, 900);
  assert.equal(f.hovers.at(-1), null);
});

viewerTest("drawer projection changes clear component hover without camera controls", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("C01");
  f.aim(4, 100);
  f.pointer("pointermove");
  assert.ok(f.hovers.at(-1));
  f.viewer.setViewportRightInset(200);
  assert.equal(f.hovers.at(-1), null);
});

viewerTest("programmatic data and home camera poses also clear component hover", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("C01");
  for (const changePose of [() => f.viewer.focusData(), () => f.viewer.setHomePresentation(), () => f.viewer.setHomeScrollProgress(0.5)]) {
    f.aim(4, 100);
    f.pointer("pointermove");
    assert.ok(f.hovers.at(-1));
    changePose();
    assert.equal(f.hovers.at(-1), null);
  }
});

viewerTest("focus transitions clear component hover and suppress it while the camera moves", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("C01");
  f.aim(4, 100);
  f.pointer("pointermove");
  assert.ok(f.hovers.at(-1));
  f.viewer.focusOverlapComponent("C01");
  assert.equal(f.hovers.at(-1), null);
  f.pointer("pointermove");
  assert.equal(f.hovers.at(-1), null);
  f.frame(performance.now() + 100);
  assert.equal(f.hovers.at(-1), null);
});

viewerTest("post-drag damping camera changes clear newly reacquired component hover", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setOverlapPickingMode("component");
  f.viewer.setActiveOverlapComponent("C01");
  f.aim(4, 100);
  f.controls.dispatchEvent({ type: "start" });
  f.controls.dispatchEvent({ type: "end" });
  f.pointer("pointermove");
  assert.ok(f.hovers.at(-1));
  t.mock.method(f.controls, "update", () => {
    f.controls.camera.position.multiplyScalar(1.001);
    f.controls.dispatchEvent({ type: "change" });
    return true;
  });
  f.frame();
  assert.equal(f.hovers.at(-1), null);
});

viewerTest("default overlap cell inspection and inspect/region API remain available", t => {
  const f = fixture(t);
  f.viewer.setOverlapMode(true);
  f.viewer.setActiveOverlapComponent("C01");
  f.aim(4, 100);
  f.click();
  assert.deepEqual(f.viewer.state.selectedPixels, [100]);
  assert.equal((f.inspections.at(-1) as { kind: string }).kind, "coverage-cell");
  assert.deepEqual(f.picks, []);
  assert.deepEqual(f.hovers, []);
  f.viewer.setInteractionMode("region");
  assert.equal(f.viewer.state.interactionMode, "region");
  f.viewer.setOverlapPickingMode("component");
  assert.equal(f.viewer.state.interactionMode, "region");
  f.viewer.setOverlapPickingMode("cell");
  f.viewer.setInteractionMode("inspect");
  assert.equal(f.viewer.state.interactionMode, "inspect");
  f.click();
  assert.deepEqual(f.viewer.state.selectedPixels, [100]);
});
