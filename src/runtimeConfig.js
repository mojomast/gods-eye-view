/**
 * Client settings that can change without a rebuild.
 *
 * Build-time `import.meta.env` stays the fallback. A `config.json` beside the
 * page, `window.GEV_RUNTIME_CONFIG`, and a `gev:config` postMessage override
 * it, in that order (a later source wins a field only when it sets one).
 * Keys are client-exposed either way: nothing here makes them secret.
 */

export const CONFIG_MESSAGE = 'gev:config';
export const VISIBILITY_MESSAGE = 'gev:visibility';

const EMBED_CACHE_MB = 384;
const EMBED_OVERFLOW_MB = 128;

/** Defaults for `perf=embed`. Ordinary sessions do not use these. */
export const EMBED_PERFORMANCE_DEFAULTS = Object.freeze({
  cacheBytes: EMBED_CACHE_MB * 1024 * 1024,
  maximumCacheOverflowBytes: EMBED_OVERFLOW_MB * 1024 * 1024,
  targetFrameRate: 30,
  msaaSamples: 2,
  maximumScreenSpaceError: 16,
  movingScreenSpaceError: 24,
  dynamicScreenSpaceError: true,
  foveatedScreenSpaceError: true,
  preserveDrawingBuffer: false,
});

const KEY_ALIASES = Object.freeze({
  googleMapsApiKey: ['googleMapsApiKey', 'GOOGLE_MAPS_API_KEY', 'googleApiKey'],
  cesiumIonToken: ['cesiumIonToken', 'CESIUM_ION_TOKEN', 'cesiumToken'],
  mapillaryToken: ['mapillaryToken', 'MAPILLARY_CLIENT_TOKEN'],
  photonUrl: ['photonUrl', 'PHOTON_URL'],
});

const NUMBER_LIMITS = Object.freeze({
  tilesCacheMb: [64, 2048],
  maximumCacheOverflowMb: [0, 1024],
  targetFrameRate: [1, 60],
  maximumScreenSpaceError: [2, 64],
  movingScreenSpaceError: [2, 64],
});

function clean(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || '';
}

function present(raw, names) {
  if (!raw || typeof raw !== 'object') return undefined;
  for (const name of names) {
    if (Object.hasOwn(raw, name)) return raw[name];
  }
  return undefined;
}

/**
 * Browser-safe Photon endpoint. Matches `photonEndpointSetting` in
 * `build/vite.js`: unset stays unset, empty/off disables, only https remains.
 * @param {unknown} value
 * @returns {string|null|undefined}
 */
export function photonEndpointSetting(value) {
  if (value === undefined) return undefined;
  const text = String(value ?? '').trim();
  if (!text || ['off', 'none', 'disabled'].includes(text.toLowerCase()))
    return null;
  try {
    const url = new URL(text);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function clampNumber(value, min, max, { integer = false } = {}) {
  if (typeof value === 'boolean' || value == null || value === '')
    return undefined;
  const number =
    typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) return undefined;
  const clamped = Math.min(max, Math.max(min, number));
  return integer ? Math.round(clamped) : clamped;
}

function bytesFromMb(mb) {
  return Math.round(mb * 1024 * 1024);
}

/** Recognized fields from a config object. Unknown fields are ignored. */
export function normalizeClientOverlay(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const overlay = {};
  for (const [field, names] of Object.entries(KEY_ALIASES)) {
    const value = present(raw, names);
    if (value === undefined) continue;
    if (field === 'photonUrl') overlay.photonUrl = photonEndpointSetting(value);
    else {
      const text = clean(value);
      if (text) overlay[field] = text;
    }
  }
  const perf = present(raw, ['perf']);
  if (perf === 'embed' || perf === 'default') overlay.perf = perf;
  for (const [field, [min, max]] of Object.entries(NUMBER_LIMITS)) {
    const value = present(raw, [field]);
    if (value === undefined) continue;
    const number = clampNumber(value, min, max, {
      integer: field === 'targetFrameRate',
    });
    if (number !== undefined) overlay[field] = number;
  }
  const samples = present(raw, ['msaaSamples']);
  if (samples !== undefined) {
    const number = clampNumber(samples, 1, 4, { integer: true });
    if (number === 1 || number === 2 || number === 4)
      overlay.msaaSamples = number;
  }
  const preserve = present(raw, ['preserveDrawingBuffer']);
  if (typeof preserve === 'boolean') overlay.preserveDrawingBuffer = preserve;
  return overlay;
}

/** `gev:config` body, flat or under `config`. Null when it is not that message. */
export function overlayFromConfigMessage(data) {
  if (!data || data.type !== CONFIG_MESSAGE) return null;
  const nested =
    data.config &&
    typeof data.config === 'object' &&
    !Array.isArray(data.config)
      ? data.config
      : {};
  return normalizeClientOverlay({ ...nested, ...data });
}

export function readBuildTimeClientConfig(env = {}) {
  const photon = env.PHOTON_URL;
  return {
    googleMapsApiKey: clean(env.GOOGLE_MAPS_API_KEY),
    cesiumIonToken: clean(env.CESIUM_ION_TOKEN),
    mapillaryToken: clean(env.MAPILLARY_CLIENT_TOKEN),
    // undefined keeps public Photon; null disables; a string is the endpoint.
    photonUrl: photon === undefined ? undefined : photonEndpointSetting(photon),
    perf: null,
  };
}

export function readSearchClientConfig(search = '') {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  const raw = {};
  if (params.has('perf')) raw.perf = params.get('perf');
  for (const field of [...Object.keys(NUMBER_LIMITS), 'msaaSamples']) {
    if (params.has(field)) raw[field] = params.get(field);
  }
  if (params.has('preserveDrawingBuffer')) {
    const value = params.get('preserveDrawingBuffer');
    if (value === '0' || value === 'false') raw.preserveDrawingBuffer = false;
    if (value === '1' || value === 'true') raw.preserveDrawingBuffer = true;
  }
  return normalizeClientOverlay(raw);
}

/** How long to wait for `gev:config` before creating the viewer. */
export function configWaitMs({ search = '', windowRef } = {}) {
  const params = new URLSearchParams(String(search || '').replace(/^\?/, ''));
  if (params.has('configWaitMs')) {
    const value = Number(params.get('configWaitMs'));
    if (Number.isFinite(value))
      return Math.min(10_000, Math.max(0, Math.round(value)));
  }
  if (
    params.get('waitForConfig') === '1' ||
    windowRef?.GEV_WAIT_FOR_CONFIG === true
  )
    return 2000;
  return 0;
}

export function mergeClientConfig(base, overlay) {
  const next = { ...base };
  if (!overlay) return next;
  for (const field of [
    'googleMapsApiKey',
    'cesiumIonToken',
    'mapillaryToken',
  ]) {
    if (overlay[field]) next[field] = overlay[field];
  }
  if (Object.hasOwn(overlay, 'photonUrl')) next.photonUrl = overlay.photonUrl;
  if (overlay.perf) next.perf = overlay.perf;
  for (const field of [
    'tilesCacheMb',
    'maximumCacheOverflowMb',
    'targetFrameRate',
    'msaaSamples',
    'maximumScreenSpaceError',
    'movingScreenSpaceError',
    'preserveDrawingBuffer',
  ]) {
    if (overlay[field] !== undefined) next[field] = overlay[field];
  }
  return next;
}

/**
 * Place-search endpoints for the resolved Photon setting. Unset means the
 * public default (no override); null is the operator's "no Photon".
 */
export function geospatialFromPhoton(photonUrl) {
  return photonUrl === undefined ? {} : { endpoints: { photon: photonUrl } };
}

/** Viewer and tileset knobs. Null keeps today's defaults. */
export function resolvePerformanceProfile(config) {
  if (!config || config.perf === 'default') {
    // An explicit default still honors numeric overrides; it does not apply
    // the embed bundle.
  }
  const embed = config?.perf === 'embed';
  const knobs = {};
  const tilesCacheMb = clampNumber(config?.tilesCacheMb, 64, 2048);
  const overflowMb = clampNumber(config?.maximumCacheOverflowMb, 0, 1024);
  const frameRate = clampNumber(config?.targetFrameRate, 1, 60, {
    integer: true,
  });
  const settledError = clampNumber(config?.maximumScreenSpaceError, 2, 64);
  const movingError = clampNumber(config?.movingScreenSpaceError, 2, 64);
  if (tilesCacheMb != null) knobs.cacheBytes = bytesFromMb(tilesCacheMb);
  if (overflowMb != null)
    knobs.maximumCacheOverflowBytes = bytesFromMb(overflowMb);
  if (frameRate != null) knobs.targetFrameRate = frameRate;
  if (
    config?.msaaSamples === 1 ||
    config?.msaaSamples === 2 ||
    config?.msaaSamples === 4
  )
    knobs.msaaSamples = config.msaaSamples;
  if (settledError != null) knobs.maximumScreenSpaceError = settledError;
  if (movingError != null) knobs.movingScreenSpaceError = movingError;
  if (typeof config?.preserveDrawingBuffer === 'boolean')
    knobs.preserveDrawingBuffer = config.preserveDrawingBuffer;
  const explicit = Object.keys(knobs).length > 0;
  if (!embed && !explicit) return null;
  if (!embed) return knobs;
  return { ...EMBED_PERFORMANCE_DEFAULTS, ...knobs };
}

function injectedOverlay(windowRef) {
  const value = windowRef?.GEV_RUNTIME_CONFIG;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return normalizeClientOverlay(value);
}

export function isHostMessageSource(event, windowRef) {
  const source = event?.source;
  if (!source || !windowRef) return false;
  return source === windowRef || source === windowRef.parent;
}

function queuedEvents(windowRef, type) {
  const queue = windowRef?.__GEV_MESSAGE_QUEUE__;
  if (!Array.isArray(queue)) return [];
  return queue.filter((event) => event?.data?.type === type);
}

function latestVisibility(events) {
  let visible = null;
  for (const event of events) {
    if (typeof event?.data?.visible === 'boolean') visible = event.data.visible;
  }
  return visible;
}

function waitForConfigMessage({ windowRef, waitMs, pollMs = 50 }) {
  const queued = () => {
    const events = queuedEvents(windowRef, CONFIG_MESSAGE).filter((event) =>
      isHostMessageSource(event, windowRef),
    );
    return events.length ? events.at(-1) : null;
  };
  const already = queued();
  if (already || waitMs <= 0) return Promise.resolve(already);
  return new Promise((resolve) => {
    let timer;
    let poll;
    const finish = (event) => {
      windowRef.removeEventListener?.('message', onMessage);
      clearTimeout(timer);
      clearInterval(poll);
      resolve(event || null);
    };
    const onMessage = (event) => {
      if (event?.data?.type !== CONFIG_MESSAGE) return;
      if (!isHostMessageSource(event, windowRef)) return;
      finish(event);
    };
    // The boot script queues messages. A host with no boot script is heard
    // here. Both paths resolve once.
    if (!Array.isArray(windowRef?.__GEV_MESSAGE_QUEUE__))
      windowRef.addEventListener?.('message', onMessage);
    poll = setInterval(() => {
      const found = queued();
      if (found) finish(found);
      else if (injectedOverlay(windowRef)) finish(null);
    }, pollMs);
    timer = setTimeout(() => finish(queued()), waitMs);
  });
}

async function readConfigFile({ fetchImpl, pageUrl, timeoutMs }) {
  if (typeof fetchImpl !== 'function' || !pageUrl) return null;
  try {
    const url = new URL('config.json', pageUrl);
    const response = await fetchImpl(url, {
      cache: 'no-store',
      credentials: 'omit',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response?.ok) return null;
    const data = await response.json();
    return normalizeClientOverlay(data);
  } catch {
    return null;
  }
}

/**
 * Resolve client keys and performance knobs.
 * `hostVisible` is the last queued visibility message, if the boot script
 * caught one before the viewer existed. It is not removed from the queue;
 * embed setup acknowledges it later.
 */
export async function loadClientConfig({
  env = {},
  location,
  windowRef,
  fetchImpl,
  timeoutMs = 1500,
} = {}) {
  const page = location ?? globalThis.location;
  const view = windowRef ?? globalThis.window;
  const search = page?.search || '';
  let config = readBuildTimeClientConfig(env);
  const sources = ['env'];
  const file = await readConfigFile({
    fetchImpl: fetchImpl ?? globalThis.fetch,
    pageUrl: page?.href,
    timeoutMs,
  });
  if (file && Object.keys(file).length) {
    config = mergeClientConfig(config, file);
    sources.push('file');
  }
  const injected = injectedOverlay(view);
  if (injected && Object.keys(injected).length) {
    config = mergeClientConfig(config, injected);
    sources.push('injected');
  }
  const fromUrl = readSearchClientConfig(search);
  if (Object.keys(fromUrl).length) {
    config = mergeClientConfig(config, fromUrl);
    sources.push('url');
  }
  const message = await waitForConfigMessage({
    windowRef: view ?? {},
    waitMs: configWaitMs({ search, windowRef: view }),
  });
  const messageOverlay = overlayFromConfigMessage(message?.data);
  if (messageOverlay && Object.keys(messageOverlay).length) {
    config = mergeClientConfig(config, messageOverlay);
    sources.push('message');
    // Leave the event queued so embed setup can acknowledge it. A config
    // message that arrives after the viewer exists is a different event.
    if (view && message) {
      const applied = view.__GEV_APPLIED_CONFIG_EVENTS__ ?? new WeakSet();
      applied.add(message);
      view.__GEV_APPLIED_CONFIG_EVENTS__ = applied;
    }
  }
  const injectedLater = injectedOverlay(view);
  if (
    injectedLater &&
    injectedLater !== injected &&
    Object.keys(injectedLater).length
  ) {
    config = mergeClientConfig(config, injectedLater);
    if (!sources.includes('injected')) sources.push('injected');
  }
  return {
    ...config,
    geospatial: geospatialFromPhoton(config.photonUrl),
    profile: resolvePerformanceProfile(config),
    hostVisible: latestVisibility(
      queuedEvents(view, VISIBILITY_MESSAGE).filter((event) =>
        isHostMessageSource(event, view),
      ),
    ),
    sources,
  };
}
