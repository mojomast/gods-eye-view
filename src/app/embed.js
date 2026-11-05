/**
 * Embed mode and views in the running app.
 *
 * With `?embed=1` the app shows only the globe: clean view, with the HUD,
 * welcome and setup prompts hidden. A page that frames it changes what it
 * shows by posting `{ type: 'gev:view', id, view }`; the app applies the view
 * through its own actions and answers `{ type: 'gev:view-applied', id, ok,
 * steps }`. It announces `{ type: 'gev:ready' }` once it can take views.
 * `{ type: 'gev:visibility', visible }` pauses or resumes rendering, HUD
 * timers and feed polls. See docs/EMBEDDING.md.
 *
 * Annotations in a share link are drawn once the link has been restored,
 * embedded or not.
 */

import * as Cesium from 'cesium';
import { announceNavigationAuthority } from '../navigationPolicy.js';
import { annotationsFromParams, createView } from '../view/index.js';

const EMBED_VIEW_MESSAGE = 'gev:view';
const EMBED_APPLIED_MESSAGE = 'gev:view-applied';
const EMBED_READY_MESSAGE = 'gev:ready';
const EMBED_VISIBILITY_MESSAGE = 'gev:visibility';
const EMBED_VISIBILITY_APPLIED_MESSAGE = 'gev:visibility-applied';
const EMBED_CONFIG_MESSAGE = 'gev:config';
const EMBED_CONFIG_APPLIED_MESSAGE = 'gev:config-applied';

const FOLLOW_LAYERS = {
  aircraft: 'flights',
  military_aircraft: 'military',
  satellite: 'satellites',
};
const FOLLOW_ATTEMPTS = 20;
const FOLLOW_RETRY_MS = 1000;
const FLIGHT_SECONDS = 2;

/**
 * Whether this page shows the app embedded: `?embed=1` when another page
 * frames it, or inline when a panel page loads the app into itself and sets
 * `globalThis.GEV_EMBED_INLINE` first.
 */
export function isEmbedded(location = globalThis.location) {
  return (
    isEmbeddedInline() ||
    new URLSearchParams(location?.search || '').get('embed') === '1'
  );
}

/** Whether a panel page loaded the app into itself. */
export function isEmbeddedInline() {
  return globalThis.GEV_EMBED_INLINE === true;
}

/**
 * One host-visibility channel. Tests build their own; the page uses
 * {@link pageEmbedVisibility}. A message is authoritative: `false` pauses
 * even when the document looks visible, and `true` keeps working when a host
 * reports the page hidden while the pane is on screen.
 */
export function createEmbedVisibility() {
  let hostVisibility = null;
  const visibilityListeners = new Set();
  const visibilityTargets = new Set();
  const api = {
    get host() {
      return hostVisibility;
    },
    setHost(visible) {
      const next = visible == null ? null : Boolean(visible);
      if (next === hostVisibility) return false;
      hostVisibility = next;
      for (const listener of visibilityListeners) {
        try {
          listener();
        } catch {
          console.error('Embed visibility listener failed');
        }
      }
      for (const target of visibilityTargets) {
        for (const listener of target.listeners) {
          try {
            listener();
          } catch {
            console.error('Embed visibility listener failed');
          }
        }
      }
      return true;
    },
    subscribe(listener) {
      if (typeof listener !== 'function')
        throw new TypeError('Expected a visibility listener');
      visibilityListeners.add(listener);
      return () => visibilityListeners.delete(listener);
    },
    isSuspended(doc = globalThis.document) {
      if (hostVisibility === false) return true;
      if (hostVisibility === true) return false;
      return doc?.hidden === true;
    },
    panelAware(doc = globalThis.document) {
      const listeners = new Set();
      const target = {
        listeners,
        get hidden() {
          return api.isSuspended(doc);
        },
        get visibilityState() {
          return this.hidden ? 'hidden' : 'visible';
        },
        addEventListener(type, listener) {
          if (type !== 'visibilitychange' || typeof listener !== 'function')
            return;
          if (listeners.size === 0)
            doc?.addEventListener?.('visibilitychange', onDocument);
          listeners.add(listener);
          visibilityTargets.add(target);
        },
        removeEventListener(_type, listener) {
          listeners.delete(listener);
          if (listeners.size === 0) {
            visibilityTargets.delete(target);
            doc?.removeEventListener?.('visibilitychange', onDocument);
          }
        },
        disconnectDocument() {
          doc?.removeEventListener?.('visibilitychange', onDocument);
          visibilityTargets.delete(target);
          listeners.clear();
        },
      };
      const onDocument = () => {
        for (const listener of listeners) listener();
      };
      return target;
    },
  };
  return api;
}

const pageEmbedVisibility = createEmbedVisibility();

/** Last host visibility for this page, or null when the host has not said. */
export function embedHostVisibility() {
  return pageEmbedVisibility.host;
}

/**
 * Record a host visibility message and notify HUD, feed and render listeners.
 * `null` clears it so the document's own visibility applies again.
 * @param {boolean|null} visible
 * @returns {boolean} Whether the stored value changed.
 */
export function setEmbedVisibility(visible) {
  return pageEmbedVisibility.setHost(visible);
}

/** Hear host visibility changes. The listener is not invoked immediately. */
export function subscribeEmbedVisibility(listener) {
  return pageEmbedVisibility.subscribe(listener);
}

/**
 * Whether rendering, HUD timers and feed polls should stop.
 * The host message wins. With no message, a hidden document pauses, including
 * an inline embed. A host that falsely reports the page hidden while the pane
 * is showing posts `{ type: 'gev:visibility', visible: true }`.
 */
export function isBackgroundWorkSuspended(doc = globalThis.document) {
  return pageEmbedVisibility.isSuspended(doc);
}

/**
 * `doc`'s visibility for work that pauses in a hidden page, plus host messages.
 * Listeners hear both `visibilitychange` on `doc` and host messages.
 */
export function panelAwareVisibility(doc = globalThis.document) {
  return pageEmbedVisibility.panelAware(doc);
}

// A panel keeps drawing at about this rate when its host stops animation
// frames; see keepPanelRendering.
const PANEL_FRAME_MS = 33;
const MISSED_FRAMES_MS = 250;

/** A render error's details, including the plain objects workers report. */
function describeError(error) {
  if (error instanceof Error)
    return `${error.name}: ${error.message}\n${error.stack}`;
  try {
    return JSON.stringify(error, Object.getOwnPropertyNames(error ?? {}));
  } catch {
    return String(error);
  }
}

/**
 * Keep the globe drawing in an inline panel. Some hosts report a panel on
 * screen as hidden, which stops the browser's animation frames and with them
 * Cesium's render loop; while frames stop arriving, draw from a timer.
 * Returns a function that stops it.
 */
export function keepPanelRendering(
  viewer,
  {
    windowRef = globalThis.window,
    now = () => performance.now(),
    suspended = () => isBackgroundWorkSuspended(windowRef?.document),
  } = {},
) {
  let lastFrame = now();
  let frameRequest = null;
  const onFrame = () => {
    lastFrame = now();
    frameRequest = windowRef.requestAnimationFrame(onFrame);
  };
  frameRequest = windowRef.requestAnimationFrame(onFrame);
  // Cesium stops drawing after a render error, and so does the timer.
  // Report the error in full: workers report plain objects, which Cesium
  // prints as [object Object].
  let failed = false;
  const removeErrorListener = viewer.scene?.renderError?.addEventListener(
    (_scene, error) => {
      failed = true;
      console.error(
        "[God's Eye View panel] render error:",
        describeError(error),
      );
    },
  );
  const timer = windowRef.setInterval(() => {
    if (
      failed ||
      suspended() ||
      now() - lastFrame < MISSED_FRAMES_MS ||
      viewer.isDestroyed?.()
    )
      return;
    viewer.resize();
    viewer.render();
  }, PANEL_FRAME_MS);
  return () => {
    windowRef.clearInterval(timer);
    windowRef.cancelAnimationFrame(frameRequest);
    removeErrorListener?.();
  };
}

const delay = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Fly the camera to a view's camera and resolve when the flight ends. */
function flyTo(viewer, camera) {
  announceNavigationAuthority('embed-view');
  return new Promise((resolve) => {
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        camera.lon,
        camera.lat,
        camera.altitude_m,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(camera.heading_deg),
        pitch: Cesium.Math.toRadians(camera.pitch_deg),
        roll: 0,
      },
      duration: FLIGHT_SECONDS,
      complete: () => resolve(true),
      cancel: () => resolve(false),
    });
  });
}

/**
 * Make the app show a view: style and map, exactly the view's layers,
 * annotations, the camera, and the followed entity. Each step runs through the
 * app's own actions (`run(name, args)`); a failed step is reported and the
 * rest still run. Resolves to the steps and whether each succeeded.
 */
export async function applyView(
  view,
  { viewer, dataManager, run, signal, retryMs = FOLLOW_RETRY_MS },
) {
  const steps = [];
  const act = async (name, args) => {
    let result = null;
    try {
      result = await run(name, args);
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    steps.push({
      step: name,
      ok: result?.ok !== false,
      ...(result?.error ? { error: result.error } : {}),
    });
    return result;
  };
  if (view.style) await act('set_visual_style', { style: view.style });
  if (view.map) await act('set_map_stack', { stack: view.map });
  const wanted = new Set(view.layers);
  for (const layer of dataManager.getAll()) {
    if (layer.enabled && !wanted.has(layer.id))
      await act('set_layer_visibility', { layerId: layer.id, enabled: false });
  }
  for (const layerId of view.layers) {
    if (!dataManager.isEnabled(layerId))
      await act('set_layer_visibility', { layerId, enabled: true });
  }
  if (!view.follow) await act('stop_tracking', {});
  // Annotations go first: drawing them may frame the marks, and the view's
  // own camera should have the last word.
  await act('clear_annotations', {});
  if (view.annotations.length)
    await act('annotate_map', { annotations: [...view.annotations] });
  if (!view.follow) {
    steps.push({ step: 'camera', ok: await flyTo(viewer, view.camera) });
    return steps;
  }
  // A followed entity owns the camera, and a camera flight would end the
  // follow, so fly to the view only while the entity is not there yet. It
  // appears once its layer has data; retry until then.
  const layerId = FOLLOW_LAYERS[view.follow.kind];
  const follow = async () => {
    try {
      return (
        (await run('track_entity', { query: view.follow.id, layerId }))?.ok ===
        true
      );
    } catch {
      return false;
    }
  };
  let followed = await follow();
  if (!followed) {
    steps.push({ step: 'camera', ok: await flyTo(viewer, view.camera) });
    for (let attempt = 1; attempt < FOLLOW_ATTEMPTS && !followed; attempt++) {
      if (signal?.aborted) break;
      await delay(retryMs, signal);
      followed = await follow();
    }
  }
  steps.push({ step: 'follow', ok: followed });
  if (followed && view.follow.cockpit)
    await act('control_cockpit', { action: 'enter', targetLayer: layerId });
  return steps;
}

/**
 * Install embed mode when the page asks for it, and draw any annotations the
 * opening link carries. Returns a function that removes the message handler.
 */
export function installViews({
  shell,
  viewer,
  dataManager,
  run,
  signal,
  location = globalThis.location,
  windowRef = globalThis.window,
}) {
  const ready = Promise.resolve(shell.initialRestorePromise).catch(() => {});
  const linked = annotationsFromParams(
    new URLSearchParams(String(location?.hash || '').replace(/^#/, '')),
  );
  if (linked.length)
    void ready.then(() => {
      if (!signal?.aborted) void run('annotate_map', { annotations: linked });
    });
  if (!isEmbedded(location)) return () => {};

  windowRef.document.body.classList.add('ui-embed');
  shell.setCleanView?.(true);
  const stopRendering = isEmbeddedInline()
    ? keepPanelRendering(viewer, { windowRef })
    : () => {};
  // A framing page talks to the app across frames; an inline panel shares
  // the page with it and talks through the page's own window.
  const peer = isEmbeddedInline() ? windowRef : windowRef.parent;
  // Answers go back only to the origin that asked. An inline panel posts to
  // its own window, and a sandboxed framing page has no origin to name.
  const post = (message, origin = '*') => {
    if (peer && (peer !== windowRef || isEmbeddedInline()))
      peer.postMessage(message, origin);
  };
  // Views apply one at a time, in the order they arrive.
  let queue = ready;
  const replyOriginFor = (event) =>
    isEmbeddedInline() || !event.origin || event.origin === 'null'
      ? '*'
      : event.origin;
  const onVisibility = (event) => {
    if (event.data?.type !== EMBED_VISIBILITY_MESSAGE) return false;
    if (!isEmbedMessageSource(event, windowRef)) return true;
    if (typeof event.data.visible !== 'boolean') return true;
    setEmbedVisibility(event.data.visible);
    post(
      {
        type: EMBED_VISIBILITY_APPLIED_MESSAGE,
        visible: !isBackgroundWorkSuspended(windowRef.document),
      },
      replyOriginFor(event),
    );
    return true;
  };
  const onLateConfig = (event) => {
    if (event.data?.type !== EMBED_CONFIG_MESSAGE) return false;
    if (!isEmbedMessageSource(event, windowRef)) return true;
    const consumed = windowRef.__GEV_APPLIED_CONFIG_EVENTS__?.has(event);
    post(
      consumed
        ? {
            type: EMBED_CONFIG_APPLIED_MESSAGE,
            ok: true,
            perf: windowRef.__GEV_STARTUP_PERF__ ?? null,
          }
        : {
            type: EMBED_CONFIG_APPLIED_MESSAGE,
            ok: false,
            error: 'already-applied',
          },
      replyOriginFor(event),
    );
    return true;
  };
  const onMessage = (event) => {
    if (onVisibility(event) || onLateConfig(event)) return;
    if (event.source !== peer || event.data?.type !== EMBED_VIEW_MESSAGE)
      return;
    const { id = null } = event.data;
    const replyOrigin = replyOriginFor(event);
    let view;
    try {
      view = createView(event.data.view);
    } catch (error) {
      post(
        {
          type: EMBED_APPLIED_MESSAGE,
          id,
          ok: false,
          error: error.message,
        },
        replyOrigin,
      );
      return;
    }
    queue = queue.then(async () => {
      if (signal?.aborted) return;
      const steps = await applyView(view, { viewer, dataManager, run, signal });
      post(
        {
          type: EMBED_APPLIED_MESSAGE,
          id,
          ok: steps.every((step) => step.ok),
          steps,
        },
        replyOrigin,
      );
    });
  };
  // The boot script queued messages until now. Own the listener from here.
  windowRef.__GEV_QUEUE_MESSAGES__ = false;
  const queued = Array.isArray(windowRef.__GEV_MESSAGE_QUEUE__)
    ? windowRef.__GEV_MESSAGE_QUEUE__.splice(0)
    : [];
  windowRef.addEventListener('message', onMessage);
  for (const event of queued) onMessage(event);
  void ready.then(() => {
    if (!signal?.aborted) post({ type: EMBED_READY_MESSAGE });
  });
  return () => {
    stopRendering();
    windowRef.removeEventListener('message', onMessage);
  };
}

function isEmbedMessageSource(event, windowRef) {
  const source = event?.source;
  if (!source || !windowRef) return false;
  return source === windowRef || source === windowRef.parent;
}
