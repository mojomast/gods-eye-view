import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EMBED_PERFORMANCE_DEFAULTS,
  configWaitMs,
  geospatialFromPhoton,
  loadClientConfig,
  mergeClientConfig,
  normalizeClientOverlay,
  overlayFromConfigMessage,
  photonEndpointSetting,
  readBuildTimeClientConfig,
  readSearchClientConfig,
  resolvePerformanceProfile,
} from './runtimeConfig.js';

test('build-time keys stay a fallback and blank values do not count', () => {
  const config = readBuildTimeClientConfig({
    GOOGLE_MAPS_API_KEY: ' google-key ',
    CESIUM_ION_TOKEN: '',
    MAPILLARY_CLIENT_TOKEN: 'MLY|token',
  });
  assert.equal(config.googleMapsApiKey, 'google-key');
  assert.equal(config.cesiumIonToken, '');
  assert.equal(config.mapillaryToken, 'MLY|token');
  assert.equal(config.photonUrl, undefined);
  assert.deepEqual(geospatialFromPhoton(config.photonUrl), {});
});

test('Photon accepts only https and treats empty as disabled', () => {
  assert.equal(photonEndpointSetting(undefined), undefined);
  assert.equal(photonEndpointSetting(''), null);
  assert.equal(photonEndpointSetting('off'), null);
  assert.equal(photonEndpointSetting('http://photon.example/api/'), null);
  assert.equal(
    photonEndpointSetting('https://user:pass@photon.example/api/'),
    null,
  );
  assert.equal(
    photonEndpointSetting('https://photon.example/api/'),
    'https://photon.example/api/',
  );
  assert.deepEqual(geospatialFromPhoton(null), { endpoints: { photon: null } });
});

test('a later source overrides only the fields it sets', () => {
  const merged = mergeClientConfig(
    {
      googleMapsApiKey: 'from-env',
      cesiumIonToken: 'from-env-ion',
      mapillaryToken: '',
      photonUrl: undefined,
      perf: null,
    },
    normalizeClientOverlay({
      cesiumIonToken: 'from-file',
      photonUrl: '',
      perf: 'embed',
      tilesCacheMb: 256,
      ignored: 'nope',
    }),
  );
  assert.equal(merged.googleMapsApiKey, 'from-env');
  assert.equal(merged.cesiumIonToken, 'from-file');
  assert.equal(merged.photonUrl, null);
  assert.equal(merged.perf, 'embed');
  assert.equal(merged.tilesCacheMb, 256);
  assert.equal(merged.ignored, undefined);
});

test('config messages accept env names and a nested config object', () => {
  const overlay = overlayFromConfigMessage({
    type: 'gev:config',
    config: { GOOGLE_MAPS_API_KEY: 'nested' },
    mapillaryToken: 'MLY|flat',
    perf: 'embed',
  });
  assert.equal(overlay.googleMapsApiKey, 'nested');
  assert.equal(overlay.mapillaryToken, 'MLY|flat');
  assert.equal(overlay.perf, 'embed');
  assert.equal(overlayFromConfigMessage({ type: 'gev:view' }), null);
});

test('the embed profile is opt-in and numeric knobs stay inside bounds', () => {
  assert.equal(resolvePerformanceProfile({ perf: null }), null);
  assert.equal(resolvePerformanceProfile({ perf: 'default' }), null);
  const embed = resolvePerformanceProfile({ perf: 'embed' });
  assert.equal(embed.cacheBytes, 384 * 1024 * 1024);
  assert.equal(embed.maximumCacheOverflowBytes, 128 * 1024 * 1024);
  assert.equal(embed.targetFrameRate, 30);
  assert.equal(embed.msaaSamples, 2);
  assert.equal(embed.preserveDrawingBuffer, false);
  assert.equal(embed.dynamicScreenSpaceError, true);
  assert.equal(embed.foveatedScreenSpaceError, true);
  assert.equal(embed.movingScreenSpaceError, 24);
  assert.deepEqual(embed, {
    ...EMBED_PERFORMANCE_DEFAULTS,
  });
  const capped = resolvePerformanceProfile({
    perf: 'embed',
    tilesCacheMb: 10,
    targetFrameRate: 500,
    msaaSamples: 3,
  });
  assert.equal(capped.cacheBytes, 64 * 1024 * 1024);
  assert.equal(capped.targetFrameRate, 60);
  assert.equal(capped.msaaSamples, 2, 'an invalid sample count does not apply');
  const onlyCache = resolvePerformanceProfile({ tilesCacheMb: 256 });
  assert.deepEqual(onlyCache, { cacheBytes: 256 * 1024 * 1024 });
});

test('glRecover is off unless the host sets it', () => {
  assert.equal(readSearchClientConfig('').glRecover, undefined);
  assert.equal(readSearchClientConfig('?glRecover=1').glRecover, true);
  assert.equal(readSearchClientConfig('?glRecover=off').glRecover, false);
  assert.equal(normalizeClientOverlay({ glRecover: 'yes' }).glRecover, true);
  assert.equal(
    mergeClientConfig({ glRecover: false }, { glRecover: true }).glRecover,
    true,
  );
  assert.equal(
    overlayFromConfigMessage({ type: 'gev:config', glRecover: false })
      .glRecover,
    false,
  );
});

test('url perf=embed opts in and waitForConfig chooses the wait', () => {
  assert.equal(readSearchClientConfig('?perf=embed').perf, 'embed');
  assert.equal(readSearchClientConfig('?welcome=0').perf, undefined);
  assert.equal(configWaitMs({ search: '' }), 0);
  assert.equal(configWaitMs({ search: '?waitForConfig=1' }), 2000);
  assert.equal(configWaitMs({ search: '?configWaitMs=250' }), 250);
  assert.equal(
    configWaitMs({ windowRef: { GEV_WAIT_FOR_CONFIG: true } }),
    2000,
  );
});

test('config.json and a host message override build-time keys', async () => {
  const windowRef = new EventTarget();
  windowRef.parent = windowRef;
  const fetches = [];
  const config = await loadClientConfig({
    env: {
      GOOGLE_MAPS_API_KEY: 'env-google',
      CESIUM_ION_TOKEN: 'env-ion',
      MAPILLARY_CLIENT_TOKEN: 'MLY|env',
    },
    location: { href: 'http://app.test/index.html', search: '?perf=embed' },
    windowRef,
    fetchImpl: async (url) => {
      fetches.push(String(url));
      return {
        ok: true,
        async json() {
          return {
            googleMapsApiKey: 'file-google',
            photonUrl: 'https://photon.example.test/api/',
            tilesCacheMb: 512,
          };
        },
      };
    },
  });
  assert.deepEqual(fetches, ['http://app.test/config.json']);
  assert.equal(config.googleMapsApiKey, 'file-google');
  assert.equal(config.cesiumIonToken, 'env-ion');
  assert.equal(config.mapillaryToken, 'MLY|env');
  assert.equal(config.photonUrl, 'https://photon.example.test/api/');
  assert.equal(config.profile.cacheBytes, 512 * 1024 * 1024);
  assert.equal(config.profile.targetFrameRate, 30);
  assert.deepEqual(config.sources, ['env', 'file', 'url']);
});

test('a missing config.json keeps the env fallback', async () => {
  const config = await loadClientConfig({
    env: { GOOGLE_MAPS_API_KEY: 'env-google' },
    location: { href: 'http://app.test/', search: '' },
    windowRef: {},
    fetchImpl: async () => {
      throw new Error('404');
    },
  });
  assert.equal(config.googleMapsApiKey, 'env-google');
  assert.equal(config.profile, null);
  assert.deepEqual(config.sources, ['env']);
});

test('gev:config from the embedding host wins, and other senders do not', async () => {
  const parent = new EventTarget();
  const windowRef = new EventTarget();
  windowRef.parent = parent;
  const pending = loadClientConfig({
    env: { GOOGLE_MAPS_API_KEY: 'env-google' },
    location: {
      href: 'http://app.test/',
      search: '?configWaitMs=400',
    },
    windowRef,
    fetchImpl: async () => ({ ok: false }),
  });
  const stranger = new EventTarget();
  // The fetch yields before the wait listens. Deliver after that.
  await new Promise((resolve) => setTimeout(resolve, 20));
  windowRef.dispatchEvent(
    Object.assign(new Event('message'), {
      source: stranger,
      data: { type: 'gev:config', googleMapsApiKey: 'stranger' },
    }),
  );
  windowRef.dispatchEvent(
    Object.assign(new Event('message'), {
      source: parent,
      data: {
        type: 'gev:config',
        config: { googleMapsApiKey: 'host-google', mapillaryToken: 'MLY|host' },
      },
    }),
  );
  const config = await pending;
  assert.equal(config.googleMapsApiKey, 'host-google');
  assert.equal(config.mapillaryToken, 'MLY|host');
  assert.ok(config.sources.includes('message'));
});

test('GEV_RUNTIME_CONFIG is read without waiting', async () => {
  const windowRef = {
    GEV_RUNTIME_CONFIG: {
      cesiumIonToken: 'injected-ion',
      perf: 'embed',
    },
  };
  const config = await loadClientConfig({
    env: { CESIUM_ION_TOKEN: 'env-ion' },
    location: { href: 'http://app.test/', search: '' },
    windowRef,
    fetchImpl: async () => ({ ok: false }),
  });
  assert.equal(config.cesiumIonToken, 'injected-ion');
  assert.equal(config.profile.msaaSamples, 2);
  assert.ok(config.sources.includes('injected'));
});

test('a queued visibility message is reported and left for embed setup', async () => {
  const parent = {};
  const windowRef = {
    parent,
    __GEV_MESSAGE_QUEUE__: [
      {
        source: parent,
        data: { type: 'gev:visibility', visible: false },
      },
      {
        source: {},
        data: { type: 'gev:visibility', visible: true },
      },
    ],
  };
  const config = await loadClientConfig({
    env: {},
    location: { href: 'http://app.test/', search: '' },
    windowRef,
    fetchImpl: async () => ({ ok: false }),
  });
  assert.equal(config.hostVisible, false);
  assert.equal(windowRef.__GEV_MESSAGE_QUEUE__.length, 2);
});
