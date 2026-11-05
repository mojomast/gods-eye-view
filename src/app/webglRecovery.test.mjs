import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCameraPose,
  createLiveViewer,
  installContextLossListener,
  readCameraPose,
  readGlRecoverFlag,
  recreateBoundViewer,
  releaseWebGlContext,
  waitForFirstFrame,
} from './webglRecovery.js';

function fakeViewer(pose) {
  const listeners = new Set();
  let destroyed = false;
  const events = [];
  const camera = {
    positionWC: {
      x: pose.x,
      y: pose.y,
      z: pose.z,
      constructor: class Cartesian3 {
        constructor(x, y, z) {
          this.x = x;
          this.y = y;
          this.z = z;
        }
      },
    },
    heading: pose.heading,
    pitch: pose.pitch,
    roll: pose.roll,
    cancelFlight() {
      events.push('cancel');
    },
    setView(options) {
      events.push('setView');
      camera.positionWC = options.destination;
      camera.heading = options.orientation.heading;
      camera.pitch = options.orientation.pitch;
      camera.roll = options.orientation.roll;
    },
  };
  const viewer = {
    container: { id: 'cesiumContainer' },
    camera,
    events,
    scene: {
      context: {
        _gl: {
          getExtension(name) {
            events.push(name);
            return {
              loseContext() {
                events.push('lose');
              },
            };
          },
        },
      },
      postRender: {
        addEventListener(fn) {
          listeners.add(fn);
          return () => listeners.delete(fn);
        },
      },
      requestRender() {},
    },
    isDestroyed: () => destroyed,
    destroy() {
      events.push('destroy');
      destroyed = true;
    },
    resize() {},
    render() {
      events.push('render');
      for (const fn of listeners) fn();
    },
  };
  return viewer;
}

test('readGlRecoverFlag accepts the embed-friendly switch values', () => {
  assert.equal(readGlRecoverFlag(true), true);
  assert.equal(readGlRecoverFlag(false), false);
  assert.equal(readGlRecoverFlag('1'), true);
  assert.equal(readGlRecoverFlag('off'), false);
  assert.equal(readGlRecoverFlag('maybe'), undefined);
  assert.equal(readGlRecoverFlag(undefined), undefined);
});

test('a live viewer proxy follows the slot', () => {
  const first = { camera: { heading: 1 }, id: 'a' };
  const { slot, proxy } = createLiveViewer(first);
  assert.equal(proxy.camera.heading, 1);
  assert.equal(proxy.__gevLiveSlot, slot);
  slot.current = { camera: { heading: 2 }, id: 'b' };
  assert.equal(proxy.id, 'b');
  proxy.marker = 'kept';
  assert.equal(slot.current.marker, 'kept');
});

test('recreate releases the context before destroy and restores the camera', async () => {
  const previous = fakeViewer({
    x: 1,
    y: 2,
    z: 3,
    heading: 0.4,
    pitch: -0.2,
    roll: 0.1,
  });
  const order = [];
  let created = null;
  const binding = {
    getViewer: () => previous,
    async prepare() {
      order.push('prepare');
    },
    async createViewer() {
      order.push('create');
      created = fakeViewer({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 });
      return created;
    },
    async rebind(next) {
      order.push('rebind');
      assert.equal(next, created);
    },
  };
  const next = await recreateBoundViewer(binding, {
    viewer: previous,
    container: previous.container,
  });
  assert.equal(next, created);
  assert.deepEqual(order, ['prepare', 'create', 'rebind']);
  assert.ok(previous.events.indexOf('lose') < previous.events.indexOf('destroy'));
  assert.equal(created.camera.heading, 0.4);
  assert.equal(created.camera.pitch, -0.2);
  assert.equal(created.camera.roll, 0.1);
  assert.equal(created.camera.positionWC.x, 1);
  assert.equal(created.camera.positionWC.y, 2);
  assert.equal(created.camera.positionWC.z, 3);
  assert.ok(created.events.includes('render'));
});

test('a second recreate shares the in-flight promise', async () => {
  const previous = fakeViewer({
    x: 4,
    y: 5,
    z: 6,
    heading: 1,
    pitch: -1,
    roll: 0,
  });
  let creates = 0;
  const binding = {
    getViewer: () => previous,
    async createViewer() {
      creates += 1;
      return fakeViewer({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 });
    },
  };
  const first = recreateBoundViewer(binding);
  const second = recreateBoundViewer(binding);
  assert.equal(first, second);
  await first;
  assert.equal(creates, 1);
});

test('the camera pose round-trips through the helpers', () => {
  const viewer = fakeViewer({
    x: 9,
    y: 8,
    z: 7,
    heading: 0.3,
    pitch: -0.5,
    roll: 0.2,
  });
  const pose = readCameraPose(viewer);
  const next = fakeViewer({ x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0 });
  assert.equal(applyCameraPose(next, pose), true);
  assert.equal(next.camera.heading, 0.3);
  assert.equal(releaseWebGlContext(viewer), true);
  assert.ok(viewer.events.includes('lose'));
});

test('waitForFirstFrame resolves the viewer after postRender', async () => {
  const viewer = fakeViewer({ x: 1, y: 1, z: 1, heading: 0, pitch: 0, roll: 0 });
  assert.equal(await waitForFirstFrame(viewer), viewer);
});

test('automatic recovery stops on the third loss inside the window', async () => {
  let created = 0;
  const windowRef = new EventTarget();
  const remove = installContextLossListener({
    windowRef,
    enabled: () => true,
    busy: () => false,
    recreateViewer: async () => {
      created += 1;
    },
    now: () => 1_000,
  });
  for (let i = 0; i < 4; i++) {
    const event = new Event('webglcontextlost', { cancelable: true });
    windowRef.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(created, 2);
  remove();
});
