import * as Cesium from 'cesium';

import {
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../../data/pickRegistry.js';
import { publishSdrReceiver } from '../../data/sdrSelection.js';
import {
  getSdrAudioWaterfallOnly,
  subscribeSdrAudioWaterfallOnly,
} from '../../data/sdrLayerFilter.js';

const PLATFORM_COLORS = Object.freeze({
  kiwi: '#67e8f9',
  openwebrx: '#c084fc',
  ubersdr: '#86efac',
  websdr: '#fbbf24',
  spyserver: '#94a3b8',
});

const PREFIX = 'sdr-receiver:';
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;

function colorFor(platform) {
  return Cesium.Color.fromCssColorString(
    PLATFORM_COLORS[platform] ?? '#9aa7b3',
  ).withAlpha(0.92);
}

/**
 * Public SDR receivers as globe pins. Static points; a click publishes the
 * receiver so the Radio panel can show it and offer Listen. The layer never
 * starts audio itself.
 */
export function createSdrReceiversLayer({ source } = {}) {
  if (typeof source?.getReceivers !== 'function')
    throw new TypeError('An SDR receiver source is required');

  let viewer = null;
  let dataSource = null;
  let handler = null;
  let request = null;
  let enabled = false;
  let loading = false;
  let count = 0;
  let lastUpdate = null;
  let lastError = null;
  let unsubscribeFilter = null;

  function onPick(movement) {
    if (!viewer || !dataSource) return;
    const picked = viewer.scene.pick(movement.position);
    const pickedId = resolvePickId(picked);
    if (!pickedId?.startsWith(PREFIX)) return;
    const entity = dataSource.entities.getById(pickedId);
    const record = entity?.properties?.sdrRecord?.getValue(
      Cesium.JulianDate.now(),
    );
    if (record) publishSdrReceiver(record, { play: record.playable === true });
  }

  function installHandler() {
    if (handler || !viewer) return;
    handler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
    handler.setInputAction(onPick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
    registerPickOwner('sdr-receivers', (pickedId) =>
      String(pickedId).startsWith(PREFIX),
    );
  }

  function removeHandler() {
    handler?.destroy();
    handler = null;
    unregisterPickOwner('sdr-receivers');
  }

  function render(records) {
    if (!dataSource) return;
    dataSource.entities.removeAll();
    for (const record of records) {
      if (
        !Number.isFinite(record.lat) ||
        !Number.isFinite(record.lon) ||
        !record.id
      )
        continue;
      dataSource.entities.add(
        new Cesium.Entity({
          id: `${PREFIX}${record.id}`,
          position: Cesium.Cartesian3.fromDegrees(record.lon, record.lat, 12),
          point: {
            pixelSize: 7,
            color: colorFor(record.platform),
            outlineColor: Cesium.Color.BLACK.withAlpha(0.55),
            outlineWidth: 1,
            heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
          properties: { sdrRecord: record },
        }),
      );
    }
  }

  function configureCluster() {
    if (!dataSource) return;
    const clustering = dataSource.clustering;
    clustering.enabled = true;
    clustering.pixelRange = 30;
    clustering.minimumClusterSize = 3;
    clustering.clusterEvent.addEventListener((entities, cluster) => {
      cluster.label.show = true;
      cluster.label.text = String(entities.length);
      cluster.label.font = '600 11px sans-serif';
      cluster.label.fillColor = Cesium.Color.WHITE;
      cluster.label.backgroundColor = Cesium.Color.BLACK.withAlpha(0.6);
      cluster.label.showBackground = true;
      cluster.label.pixelOffset = new Cesium.Cartesian2(0, -14);
      cluster.label.disableDepthTestDistance = Number.POSITIVE_INFINITY;
      cluster.billboard.show = false;
      cluster.point.show = false;
    });
  }

  async function update() {
    if (!enabled || !dataSource) return false;
    request?.abort();
    const current = new AbortController();
    request = current;
    loading = true;
    lastError = null;
    try {
      const records = await source.getReceivers({
        signal: current.signal,
        audioWaterfallOnly: getSdrAudioWaterfallOnly(),
      });
      if (current.signal.aborted || request !== current || !enabled)
        return false;
      render(records);
      count = dataSource.entities.values.length;
      lastUpdate = Date.now();
      return true;
    } catch (error) {
      if (current.signal.aborted || request !== current || !enabled)
        return false;
      lastError =
        error instanceof Error ? error.message : 'SDR directory unavailable'; // i18n-ignore
      return false;
    } finally {
      if (request === current) {
        request = null;
        loading = false;
      }
    }
  }

  return {
    id: 'sdr-receivers',
    name: 'Public SDR',
    icon: '📻',
    source: 'ReceiverBook · KiwiSDR · Airspy · UberSDR',
    updateInterval: REFRESH_INTERVAL_MS,

    init(nextViewer) {
      if (viewer) throw new Error('SDR layer is already initialized');
      viewer = nextViewer;
      dataSource = new Cesium.CustomDataSource('sdr-receivers');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      configureCluster();
      installHandler();
      unsubscribeFilter = subscribeSdrAudioWaterfallOnly(() => {
        if (enabled) void update();
        else count = 0;
      });
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      installHandler();
      if (!count) void update();
    },

    disable() {
      enabled = false;
      request?.abort();
      request = null;
      loading = false;
      if (dataSource) dataSource.show = false;
      removeHandler();
    },

    update,

    destroy() {
      this.disable();
      dataSource?.entities.removeAll();
      if (viewer && dataSource) viewer.dataSources.remove(dataSource, true);
      unsubscribeFilter?.();
      unsubscribeFilter = null;
      dataSource = null;
      viewer = null;
      count = 0;
      lastUpdate = null;
      lastError = null;
    },

    getStats() {
      return {
        count,
        loading,
        lastUpdate,
        error: lastError,
      };
    },
  };
}
