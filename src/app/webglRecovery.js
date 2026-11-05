/**
 * Replace a Viewer after its WebGL context is lost.
 *
 * Cesium cannot restore GPU resources on the lost context. The supported
 * recovery is to release the context, destroy the Viewer, and construct
 * another one in the same container, then point every holder at the new
 * one. The returned promise resolves to that viewer once its first frame
 * has rendered.
 */

const DEFAULT_LOSS_WINDOW_MS = 20_000;
const DEFAULT_LOSS_BUDGET = 3;

/** True for the embed-friendly `glRecover` switch. Absent is off. */
export function readGlRecoverFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) && value !== 0;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return undefined;
}

/**
 * A stand-in whose property reads and writes follow the current viewer.
 * Listeners installed on the real camera or canvas still need a fresh
 * `init` after the slot moves; call-time reads (`viewer.camera`,
 * `viewer.scene`) see the replacement.
 */
export function createLiveViewer(viewer) {
  const slot = { current: viewer };
  const proxy = new Proxy(slot, {
    get(target, prop) {
      if (prop === '__gevLiveSlot') return target;
      const current = target.current;
      if (current == null) return undefined;
      const value = current[prop];
      return typeof value === 'function' ? value.bind(current) : value;
    },
    set(target, prop, value) {
      if (prop === 'current') {
        target.current = value;
        return true;
      }
      if (target.current == null) return false;
      target.current[prop] = value;
      return true;
    },
    has(target, prop) {
      if (prop === '__gevLiveSlot') return true;
      return target.current != null && prop in target.current;
    },
  });
  return { slot, proxy };
}

/** The viewer a live proxy currently points at, or the object itself. */
export function liveViewerTarget(viewer) {
  return viewer?.__gevLiveSlot?.current || viewer;
}

/** Ask the browser to drop the GPU context before the viewer is destroyed. */
export function releaseWebGlContext(viewer) {
  try {
    const gl = viewer?.scene?.context?._gl;
    const extension = gl?.getExtension?.('WEBGL_lose_context');
    extension?.loseContext?.();
    return true;
  } catch {
    return false;
  }
}

/** Camera pose that can be applied to a new viewer. Null when there is none. */
export function readCameraPose(viewer) {
  const camera = viewer?.camera;
  const position = camera?.positionWC;
  if (!position || !Number.isFinite(position.x)) return null;
  if (!Number.isFinite(camera.heading) || !Number.isFinite(camera.pitch))
    return null;
  return {
    destination: { x: position.x, y: position.y, z: position.z },
    heading: camera.heading,
    pitch: camera.pitch,
    roll: Number.isFinite(camera.roll) ? camera.roll : 0,
  };
}

/** Put `pose` on `viewer`. Returns false when either is missing. */
export function applyCameraPose(viewer, pose) {
  const camera = viewer?.camera;
  const destination = pose?.destination;
  if (!camera?.setView || !destination || !Number.isFinite(destination.x))
    return false;
  const C3 = camera.positionWC?.constructor;
  const cartesian =
    typeof C3 === 'function'
      ? new C3(destination.x, destination.y, destination.z)
      : destination;
  try {
    camera.cancelFlight?.();
  } catch {
    // A destroyed flight is already stopped.
  }
  camera.setView({
    destination: cartesian,
    orientation: {
      heading: pose.heading,
      pitch: pose.pitch,
      roll: pose.roll || 0,
    },
  });
  return true;
}

/**
 * Resolve with `viewer` after `postRender`, kicking one frame so a paused
 * loop still settles. Rejects when the viewer is missing or render throws
 * before that frame.
 */
export function waitForFirstFrame(viewer, { timeoutMs = 5000 } = {}) {
  if (!viewer || viewer.isDestroyed?.())
    return Promise.reject(new Error('No viewer to render'));
  return new Promise((resolve, reject) => {
    let settled = false;
    let remove = () => {};
    const timer = setTimeout(() => finish(), timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        remove();
      } catch {
        // The listener is already gone with the scene.
      }
      if (error) reject(error);
      else resolve(viewer);
    };
    const scene = viewer.scene;
    if (typeof scene?.postRender?.addEventListener === 'function') {
      const remover = scene.postRender.addEventListener(() => finish());
      remove = typeof remover === 'function' ? remover : () => {};
    }
    try {
      viewer.resize?.();
      if (typeof viewer.render === 'function') viewer.render();
      else scene?.requestRender?.();
    } catch (error) {
      finish(error);
    }
  });
}

function viewerToReplace(getViewer, request) {
  const current = getViewer?.() || null;
  const requested = request?.viewer;
  if (requested && requested !== current && !requested.isDestroyed?.())
    return requested;
  return current;
}

/**
 * Destroy `request.viewer` (or the binding's current viewer) and create the
 * next one. Concurrent calls share one promise.
 *
 * @param {object} binding
 * @param {() => object} binding.getViewer
 * @param {(info: {container: *, previous: object|null, pose: object|null}) => Promise<object>|object} binding.createViewer
 * @param {(previous: object, pose: object|null) => Promise<void>|void} [binding.prepare]
 * @param {(next: object, previous: object|null, pose: object|null) => Promise<void>|void} [binding.rebind]
 * @param {{viewer?: object, container?: *}} [request]
 */
export function recreateBoundViewer(binding, request = {}) {
  if (binding.inflight) return binding.inflight;
  const run = async () => {
    const previous = viewerToReplace(binding.getViewer, request);
    const pose = readCameraPose(previous);
    const container =
      request?.container || previous?.container || binding.container || null;
    if (previous && !previous.isDestroyed?.()) {
      await binding.prepare?.(previous, pose);
      releaseWebGlContext(previous);
      try {
        if (!previous.isDestroyed?.()) previous.destroy();
      } catch (error) {
        console.warn('[WebGL] Viewer destroy failed:', error);
      }
    }
    const next = await binding.createViewer({ container, previous, pose });
    if (!next) throw new Error('Replacement viewer was not created');
    await binding.rebind?.(next, previous, pose);
    applyCameraPose(next, pose);
    await waitForFirstFrame(next);
    return next;
  };
  binding.inflight = run().finally(() => {
    binding.inflight = null;
  });
  return binding.inflight;
}

/**
 * Listen for `webglcontextlost` and recreate when `enabled()` is true.
 * Three losses inside the window stop automatic recovery; an explicit
 * `recreateViewer()` call is unaffected. Returns a remover.
 */
export function installContextLossListener({
  windowRef,
  enabled,
  busy,
  recreateViewer,
  lossWindowMs = DEFAULT_LOSS_WINDOW_MS,
  lossBudget = DEFAULT_LOSS_BUDGET,
  now = () => Date.now(),
} = {}) {
  if (!windowRef?.addEventListener || typeof recreateViewer !== 'function')
    return () => {};
  const losses = [];
  let stopped = false;
  const onLost = (event) => {
    if (!enabled?.()) return;
    event.preventDefault?.();
    // The release inside recreateViewer fires this event too. That loss is
    // already being handled.
    if (busy?.() || stopped) return;
    const at = now();
    while (losses.length && at - losses[0] > lossWindowMs) losses.shift();
    losses.push(at);
    // The third loss inside the window is the one that stops. The two before
    // it still rebuild.
    if (losses.length >= lossBudget) {
      stopped = true;
      console.warn(
        '[WebGL] Stopped rebuilding the viewer after repeated context losses',
      );
      return;
    }
    Promise.resolve(recreateViewer()).catch((error) => {
      console.warn('[WebGL] Could not rebuild the viewer:', error);
    });
  };
  windowRef.addEventListener('webglcontextlost', onLost, true);
  return () => {
    windowRef.removeEventListener('webglcontextlost', onLost, true);
  };
}
