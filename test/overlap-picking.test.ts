import assert from "node:assert/strict";
import * as nodeModule from "node:module";
import test, { type TestContext } from "node:test";
import * as THREE from "three";

import { healpixPixelFromSceneDirection, sphericalCellCenter } from "../src/spherical-cell-geometry.js";
import { SkyDepthLayer } from "../src/sky-depth-layer.js";
import { raDecToCartesian } from "../src/coordinates.js";
import type { SkyRectangle, SkyRectangleChangePhase } from "../src/sky-rectangle.js";
import type { SurveyFootprintManifest } from "../src/survey-footprints.js";
import type { SurveyLayerContextMenu, SurveyLayerOverlapComponent, SurveyLayerOverlapHover, SurveyLayerViewerOptions } from "../src/survey-layer-viewer.js";

// Only replace GPU/DOM infrastructure. The viewer, raycaster, membership,
// geometry, public methods and registered pointer handlers run unchanged.
const moduleUrl = (source: string) => `data:text/javascript,${encodeURIComponent(source)}`;
const threeUrl = import.meta.resolve("three");
const hudUrl = new URL("../src/hud-scene.ts", import.meta.url).href;
const controlsUrl = moduleUrl(`
  import { EventDispatcher, Vector3 } from ${JSON.stringify(threeUrl)};
  import { OrbitControls as RealOrbitControls } from ${JSON.stringify(import.meta.resolve("three/addons/controls/OrbitControls.js"))};
  export class OrbitControls extends EventDispatcher {
    target = new Vector3(); enabled = true;
    constructor(camera, canvas) {
      super();
      if (globalThis.__rectangleTestRealControls) {
        const controls = new RealOrbitControls(camera, canvas);
        controls.camera = camera;
        globalThis.__overlapTestControls = controls;
        return controls;
      }
      this.camera = camera; globalThis.__overlapTestControls = this;
    }
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
  style: Record<string, string> = {};
  ownerDocument = new EventTarget();
  getRootNode() { return this.ownerDocument; }
  width = 800;
  height = 600;
  clientWidth = 800;
  clientHeight = 600;
  parentElement = null;
  captured = new Set<number>();
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) {
    if (!this.captured.delete(id)) return;
    const event = new Event("lostpointercapture");
    Object.assign(event, { pointerId: id });
    this.dispatchEvent(event);
  }
  getBoundingClientRect() { return { left: 0, top: 0, width: this.width, height: this.height }; }
  getContext() {
    return new Proxy({}, { get: (_target, key) => key === "measureText" ? () => ({ width: 20 }) : () => undefined });
  }
}

function fixture(t: TestContext, options: SurveyLayerViewerOptions = {}, explicitOverlap = true, realControls = false, fixtureOptions: { noResizeObserver?: boolean } = {}) {
  const restoreGlobals: Array<() => void> = [];
  const globalStub = (name: string, value: unknown) => {
    const old = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    restoreGlobals.push(() => { if (old) Object.defineProperty(globalThis, name, old); else Reflect.deleteProperty(globalThis, name); });
  };
  globalStub("document", { documentElement: { dataset: { theme: "dark" } }, createElement: () => new TestCanvas() });
  globalStub("window", Object.assign(new EventTarget(), { innerWidth: 800, innerHeight: 600, devicePixelRatio: 1 }));
  globalStub("PointerEvent", class extends Event {
    pointerId: number;
    constructor(type: string, init: PointerEventInit = {}) { super(type); this.pointerId = init.pointerId ?? 0; }
  });
  const observers: Array<{ cb: () => void; disconnected: boolean }> = [];
  globalStub("ResizeObserver", fixtureOptions.noResizeObserver ? undefined : class {
    entry: { cb: () => void; disconnected: boolean } = { cb: () => undefined, disconnected: false };
    constructor(cb: () => void) { this.entry.cb = cb; observers.push(this.entry); }
    observe() {}
    disconnect() { this.entry.disconnected = true; }
  });
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
  globalStub("__rectangleTestRealControls", realControls);
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
  const controls = (globalThis as unknown as { __overlapTestControls: THREE.EventDispatcher<{ start: {}; end: {}; change: {} }> & { camera: THREE.PerspectiveCamera; enabled: boolean; enableDamping: boolean; autoRotate: boolean; target: THREE.Vector3; update(): boolean } }).__overlapTestControls;
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
    Object.assign(event, { pointerId: 1, pointerType: "mouse", button: 0, buttons: type === "pointerdown" ? 1 : 0, clientX: x, clientY: y, ctrlKey: false, metaKey: false, ...extras });
    canvas.dispatchEvent(event);
    if (realControls && (type === "pointermove" || type === "pointerup")) canvas.ownerDocument.dispatchEvent(event);
  };
  const click = (x = pointerX, y = pointerY, extras: Record<string, unknown> = {}) => { pointer("pointerdown", x, y, extras); pointer("pointerup", x, y, extras); };
  const coordinates = () => ({ clientX: pointerX, clientY: pointerY });
  const scene = () => (globalThis as unknown as { __overlapTestScene: THREE.Scene }).__overlapTestScene;
  const labels = () => {
    const groups = scene().children.filter((object): object is THREE.Group => object instanceof THREE.Group);
    return groups.flatMap(group => group.children).filter(object => object instanceof THREE.Sprite && object.userData.overlapComponent);
  };
  return { observers, viewer, canvas, controls, manifest, component, picks, hovers, inspections, selections, cellHovers, objectPicks, menus, aim, pointer, click, coordinates, labels, scene, frame };
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

// Rectangle tests reuse the renderer-only stubs above; rays, coordinates, public
// API methods and all registered viewer handlers are the actual implementation.
function rectangleFixture(t: TestContext, realControls = false) {
  const changes: Array<{ rectangle: SkyRectangle | null; phase: SkyRectangleChangePhase }> = [];
  const f = fixture(t, { onRectangleChange: (rectangle, phase) => changes.push({ rectangle, phase }) }, true, realControls);
  const aimRectangle = () => {
    const position = raDecToCartesian(0, 0, 5);
    f.viewer.restoreCameraPose({ position: [position.x, position.y, position.z], target: [0, 0, 0], up: [0, 1, 0], fov: 48 });
    f.viewer.setViewportRightInset(1);
    f.viewer.setViewportRightInset(0);
  };
  const coordinate = (ra: number, dec: number): [number, number] => {
    const point = raDecToCartesian(ra, dec);
    const projected = new THREE.Vector3(point.x, point.y, point.z).project(f.controls.camera);
    return [(projected.x + 1) * 400, (1 - projected.y) * 300];
  };
  const at = (type: string, ra: number, dec: number, extra: Record<string, unknown> = {}) => {
    const [x, y] = coordinate(ra, dec);
    assert.ok(x >= 0 && x <= 800 && y >= 0 && y <= 600, `${type}: RA ${ra}, Dec ${dec} projected to ${x}, ${y}`);
    f.pointer(type, x, y, extra);
  };
  const outline = () => f.scene().getObjectByName("sky-rectangle")!;
  aimRectangle();
  return { ...f, changes, aimRectangle, coordinate, at, outline };
}

const rectangleNear = (actual: SkyRectangle | null, expected: SkyRectangle) => {
  assert.ok(actual);
  for (const key of ["raStart", "raEnd", "decMin", "decMax"] as const) assert.ok(Math.abs(actual[key] - expected[key]) < 1e-7, `${key}: ${actual[key]} vs ${expected[key]}`);
};

viewerTest("rectangle drawing is opt-in, commits either drag direction across zero, then restores navigation", t => {
  const f = rectangleFixture(t);
  assert.equal(f.canvas.dataset.rectangleDrawing, undefined);
  assert.equal(f.controls.enabled, true);
  const expected = { raStart: 350, raEnd: 10, decMin: -5, decMax: 5 };
  for (const [startRa, startDec, endRa, endDec] of [[350, -5, 10, 5], [10, 5, 350, -5]]) {
    f.viewer.setRectangleDrawing(true);
    assert.equal(f.controls.enabled, false);
    f.at("pointerdown", startRa!, startDec!);
    assert.equal(f.canvas.hasPointerCapture(1), true);
    f.at("pointermove", 0, 0);
    f.at("pointermove", endRa!, endDec!);
    rectangleNear(f.changes.at(-1)!.rectangle, expected);
    assert.equal(f.changes.at(-1)!.phase, "draft");
    f.at("pointerup", endRa!, endDec!);
    assert.equal(f.changes.at(-1)!.phase, "commit");
    rectangleNear(f.changes.at(-1)!.rectangle, expected);
    assert.equal(f.canvas.hasPointerCapture(1), false);
    assert.equal(f.controls.enabled, true);
    assert.equal(f.canvas.dataset.rectangleDrawing, undefined);
    assert.equal(f.outline().children.length, 1);
  }
  assert.deepEqual(f.picks, []);
  assert.deepEqual(f.viewer.state.selectedPixels, []);
});

viewerTest("rectangle rays ignore coverage membership, shell offsets and overlap picking", t => {
  const f = rectangleFixture(t);
  const expected = { raStart: 350, raEnd: 10, decMin: -5, decMax: 5 };
  for (const mode of ["layers", "overlap"] as const) {
    if (mode === "overlap") {
      f.viewer.setOverlapMode(true);
      f.viewer.setOverlapPickingMode("component");
    }
    f.aimRectangle();
    f.viewer.setRectangleDrawing(true);
    f.at("pointerdown", 350, -5);
    f.at("pointerup", 10, 5);
    rectangleNear(f.changes.at(-1)!.rectangle, expected);
  }
  assert.deepEqual(f.picks, []);
  assert.deepEqual(f.objectPicks, []);
  assert.deepEqual(f.menus, []);
});

viewerTest("numeric rectangle updates are silent, preserve wide/full RA and reject invalid bounds atomically", t => {
  const f = rectangleFixture(t);
  const wide = { raStart: 10, raEnd: 350, decMin: -10, decMax: 10 };
  f.viewer.setRectangleSelection(wide);
  assert.equal(f.outline().children.length, 1);
  assert.deepEqual(f.changes, []);
  assert.throws(() => f.viewer.setRectangleSelection({ ...wide, decMin: 20 }), RangeError);
  assert.equal(f.outline().children.length, 1);
  f.viewer.setRectangleSelection({ ...wide, raStart: 0, raEnd: 360 });
  assert.equal(f.outline().children.length, 1);
  f.viewer.setRectangleDrawing(true);
  f.at("pointerdown", 350, -5);
  f.changes.length = 0;
  f.viewer.setRectangleSelection(wide);
  assert.deepEqual(f.changes, []);
  assert.equal(f.controls.enabled, true);
  assert.equal(f.canvas.hasPointerCapture(1), false);
  f.viewer.setRectangleSelection(null);
  assert.equal(f.outline().children.length, 0);
});

viewerTest("invalid or degenerate release cancels instead of inventing coordinates and restores old rectangle", t => {
  const f = rectangleFixture(t);
  const committed = { raStart: 345, raEnd: 15, decMin: -10, decMax: 10 };
  f.viewer.setRectangleSelection(committed);
  for (const release of ["off-sphere", "outside-canvas", "degenerate"] as const) {
    f.viewer.setRectangleDrawing(true);
    f.at("pointerdown", 350, -5);
    f.at("pointermove", 10, 5);
    if (release === "degenerate") f.at("pointerup", 350, -5);
    else f.pointer("pointerup", release === "off-sphere" ? 0 : -100, 0);
    assert.deepEqual(f.changes.at(-1), { rectangle: committed, phase: "cancel" });
    assert.equal(f.controls.enabled, true);
    assert.equal(f.outline().children.length, 1);
    assert.equal(f.canvas.hasPointerCapture(1), false);
  }
});

viewerTest("a second pointer cannot mutate, commit or cancel the active rectangle; leaving and reentering canvas works", t => {
  const f = rectangleFixture(t);
  f.viewer.setRectangleDrawing(true);
  f.at("pointerdown", 350, -5);
  const count = f.changes.length;
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) f.at(type, 20, 10, { pointerId: 2 });
  assert.equal(f.changes.length, count);
  assert.equal(f.canvas.hasPointerCapture(1), true);
  f.pointer("pointermove", -100, 100);
  assert.equal(f.changes.at(-1)!.rectangle, null);
  f.pointer("pointerleave");
  assert.equal(f.controls.enabled, false);
  f.at("pointerup", 10, 5);
  assert.equal(f.changes.at(-1)!.phase, "commit");
  rectangleNear(f.changes.at(-1)!.rectangle, { raStart: 350, raEnd: 10, decMin: -5, decMax: 5 });
});

for (const cancel of ["pointercancel", "lostpointercapture", "Escape", "blur", "disable", "interaction", "overlap", "picking", "layout", "reset", "clear", "focus", "dispose"] as const) {
  viewerTest(`rectangle ${cancel} cancels once, releases capture and restores controls`, t => {
    const f = rectangleFixture(t);
    f.viewer.setRectangleSelection({ raStart: 345, raEnd: 15, decMin: -10, decMax: 10 });
    f.viewer.setRectangleDrawing(true);
    f.at("pointerdown", 350, -5);
    f.at("pointermove", 10, 5);
    f.changes.length = 0;
    switch (cancel) {
      case "pointercancel": f.pointer("pointercancel"); break;
      case "lostpointercapture": f.canvas.releasePointerCapture(1); break;
      case "Escape": {
        const event = new Event("keydown", { cancelable: true });
        Object.assign(event, { key: "Escape" });
        window.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true);
        break;
      }
      case "blur": window.dispatchEvent(new Event("blur")); break;
      case "disable": f.viewer.setRectangleDrawing(false); break;
      case "interaction": f.viewer.setInteractionMode("region"); break;
      case "overlap": f.viewer.setOverlapMode(true); break;
      case "picking": f.viewer.setOverlapPickingMode("component"); break;
      case "layout": f.viewer.setLayoutMode("overlap"); break;
      case "reset": f.viewer.reset(); break;
      case "clear": f.viewer.clearTransientState(); break;
      case "focus": f.viewer.focusData(); break;
      case "dispose": f.viewer.dispose({ releaseContext: false }); break;
    }
    assert.equal(f.changes.length, 1);
    assert.equal(f.changes[0]!.phase, "cancel");
    assert.equal(f.canvas.hasPointerCapture(1), false);
    assert.equal(f.canvas.dataset.rectangleDrawing, undefined);
    assert.equal(f.controls.enabled, true);
    if (cancel === "reset" || cancel === "clear") assert.equal(f.outline().children.length, 0);
  });
}

viewerTest("drawing clears pending cell clicks, suppresses inspect/depth/menu/double-click, and leaves ordinary events unswallowed", t => {
  const f = rectangleFixture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  f.aim(4, 100);
  f.click(); // Cell action is waiting for the double-click timeout.
  f.viewer.setRectangleDrawing(true);
  t.mock.timers.tick(221);
  assert.deepEqual(f.viewer.state.selectedPixels, []);
  const fail = () => { throw Error("rectangle mode must bypass other picking"); };
  t.mock.method(SkyDepthLayer.prototype, "pick", fail);
  f.pointer("dblclick");
  f.pointer("contextmenu");
  f.pointer("pointermove");
  f.click(); // A degenerate rectangle cancels rather than selecting a cell.
  f.pointer("dblclick"); // Browser's trailing event must remain suppressed.
  assert.deepEqual(f.picks, []);
  assert.deepEqual(f.menus, []);
  assert.deepEqual(f.objectPicks, []);
  assert.equal(f.changes.at(-1)!.phase, "cancel");
  const escape = new Event("keydown", { cancelable: true });
  Object.assign(escape, { key: "Escape" });
  window.dispatchEvent(escape);
  assert.equal(escape.defaultPrevented, false);
  const ordinary = new Event("pointerdown", { cancelable: true });
  Object.assign(ordinary, { button: 0, pointerId: 1, clientX: 0, clientY: 0 });
  f.canvas.dispatchEvent(ordinary);
  assert.equal(ordinary.defaultPrevented, false);
});

viewerTest("entering drawing stops transitions and consumes inertia without changing pose or replaying it", t => {
  const f = rectangleFixture(t);
  f.viewer.transitionToDataPresentation();
  assert.equal(f.controls.enabled, false);
  let pendingInertia = true;
  const baseUpdate = f.controls.update.bind(f.controls);
  t.mock.method(f.controls, "update", () => {
    if (pendingInertia) {
      f.controls.camera.position.x += 0.1;
      if (!f.controls.enableDamping) pendingInertia = false;
    }
    return baseUpdate();
  });
  const pose = f.viewer.cameraPose;
  f.viewer.setRectangleDrawing(true);
  assert.deepEqual(f.viewer.cameraPose, pose);
  assert.equal(pendingInertia, false);
  f.frame(performance.now() + 5000);
  assert.deepEqual(f.viewer.cameraPose, pose);
  assert.equal(f.controls.enabled, false);
  f.viewer.setRectangleDrawing(false);
  f.controls.update();
  assert.deepEqual(f.viewer.cameraPose, pose);
  assert.equal(f.controls.enabled, true);
  f.viewer.setHomePresentation();
  assert.equal(f.controls.enabled, false);
  f.viewer.setRectangleDrawing(true);
  f.viewer.setRectangleDrawing(false);
  assert.equal(f.controls.enabled, false, "home presentation must not accidentally enable navigation");
});

viewerTest("real OrbitControls ends an active orbit and inertia, draws without rotating, then accepts fresh navigation", t => {
  const f = rectangleFixture(t, true);
  f.pointer("pointerdown", 400, 300);
  f.pointer("pointermove", 440, 320, { buttons: 1 });
  const pose = f.viewer.cameraPose;
  const nearPose = (expected: typeof pose) => {
    const actual = f.viewer.cameraPose;
    for (const key of ["position", "target", "up"] as const) for (let index = 0; index < 3; index++) {
      assert.ok(Math.abs(actual[key][index]! - expected[key][index]!) < 1e-12, `${key}[${index}] must not move`);
    }
    assert.equal(actual.fov, expected.fov);
  };
  f.viewer.setRectangleDrawing(true);
  nearPose(pose);
  assert.equal(f.canvas.hasPointerCapture(1), false, "old orbit capture must be released");
  f.frame();
  nearPose(pose);
  f.viewer.setRectangleDrawing(false);
  for (let iteration = 0; iteration < 4; iteration++) f.controls.update();
  nearPose(pose);
  f.aimRectangle();
  const before = f.viewer.cameraPose;
  f.viewer.setRectangleDrawing(true);
  f.at("pointerdown", 350, -5);
  f.at("pointermove", 0, 0, { buttons: 1 });
  f.at("pointerup", 10, 5);
  rectangleNear(f.changes.at(-1)!.rectangle, { raStart: 350, raEnd: 10, decMin: -5, decMax: 5 });
  assert.equal(f.changes.at(-1)!.phase, "commit");
  assert.deepEqual(f.viewer.cameraPose, before);
  f.pointer("pointerdown", 400, 300);
  f.pointer("pointermove", 440, 320, { buttons: 1 });
  f.pointer("pointerup", 440, 320);
  assert.notDeepEqual(f.viewer.cameraPose.position, before.position, "new ordinary orbit must work");
});

viewerTest("programmatic numeric outlines are horizon-clipped and update when camera moves", t => {
  const f = rectangleFixture(t);
  const rectangle = { raStart: 350, raEnd: 10, decMin: -5, decMax: 5 };
  f.viewer.setRectangleSelection(rectangle);
  assert.equal(f.outline().children.length, 1);
  const position = raDecToCartesian(180, 0, 3);
  f.viewer.restoreCameraPose({ position: [position.x, position.y, position.z], target: [0, 0, 0], up: [0, 1, 0], fov: 48 });
  f.frame();
  assert.equal(f.outline().children.length, 0);
  f.aimRectangle();
  f.frame();
  assert.equal(f.outline().children.length, 1);
});

function coverageWithCounter(f: ReturnType<typeof fixture>) {
  let calls = 0;
  const original = f.canvas.getBoundingClientRect.bind(f.canvas);
  f.canvas.getBoundingClientRect = () => { calls++; return original(); };
  f.viewer.restoreCameraPose({ position: [0, 0, 3], target: [0, 0, 0], up: [0, 1, 0], fov: 10 });
  return { calls: () => calls, radius: () => f.viewer.state.coverageViewRadiusRad };
}

viewerTest("coverage radius uses a cached canvas width that follows the observer", t => {
  const f = fixture(t);
  const c = coverageWithCounter(f);
  f.viewer.setViewportRightInset(300);
  const before = c.calls();
  const first = c.radius();
  c.radius(); c.radius();
  assert.equal(c.calls(), before, "state reads must not touch layout");
  assert.ok(Number.isFinite(first) && first > 0);
  f.canvas.width = 1200;
  f.observers.forEach(o => o.cb());
  const wide = c.radius();
  f.canvas.width = 800;
  f.observers.forEach(o => o.cb());
  assert.equal(c.radius(), first, "same width gives identical result");
  // Independent copy of the pre-cache formula, using the live rect width.
  const oldRadius = (width: number, inset: number) => {
    const camera = f.controls.camera;
    const distance = camera.position.length();
    camera.updateMatrixWorld(true);
    const right = 1 - 2 * Math.min(inset, width) / width;
    const inward = camera.position.clone().negate().normalize();
    const off = Math.max(...[[-1, -1], [-1, 1], [right, -1], [right, 1]].map(([x, y]) =>
      inward.angleTo(new THREE.Vector3(x, y, 0.5).unproject(camera).sub(camera.position).normalize())));
    const shell = f.viewer.state.outerRadius + 0.003;
    const apparent = Math.asin(Math.min(1, shell / distance));
    if (off >= apparent) return Math.min(Math.PI / 2, Math.acos(shell / distance) + 0.003);
    return Math.min(Math.PI / 2, Math.max(0, Math.asin(Math.min(1, distance / shell * Math.sin(off))) - off) + 0.003);
  };
  assert.ok(Math.abs(first - oldRadius(800, 300)) < 1e-9, `cached ${first} vs old ${oldRadius(800, 300)}`);
  assert.notEqual(wide, first, "a wider canvas changes the inset ratio");
});

viewerTest("resize observers are disconnected on dispose", t => {
  const f = fixture(t);
  assert.ok(f.observers.length > 0);
  f.viewer.dispose({ releaseContext: false });
  assert.ok(f.observers.every(o => o.disconnected));
});

viewerTest("coverage radius works without ResizeObserver and measures lazily once", t => {
  const f = fixture(t, {}, true, false, { noResizeObserver: true });
  const c = coverageWithCounter(f);
  f.viewer.setViewportRightInset(300);
  const before = c.calls();
  const a = c.radius();
  assert.equal(c.radius(), a);
  assert.equal(c.calls(), before);
});
