import { UniversalSDR, WebAudioPcmPlayer } from './sdrLib.js';

/** Presets offered on the receiver card, in priority order. */
export const SDR_PRESETS = Object.freeze([
  { hz: 7_074_000, mode: 'usb', label: '40 m FT8' }, // i18n-ignore
  { hz: 14_074_000, mode: 'usb', label: '20 m FT8' }, // i18n-ignore
  { hz: 14_200_000, mode: 'usb', label: '20 m SSB' }, // i18n-ignore
  { hz: 3_800_000, mode: 'lsb', label: '80 m LSB' }, // i18n-ignore
  { hz: 121_500_000, mode: 'am', label: 'Airband 121.5' }, // i18n-ignore
  { hz: 156_800_000, mode: 'nfm', label: 'Marine 156.8' }, // i18n-ignore
  { hz: 6_070_000, mode: 'am', label: '49 m broadcast' }, // i18n-ignore
]);

export const SDR_MODES = Object.freeze([
  'usb',
  'lsb',
  'am',
  'nfm',
  'wfm',
  'cw',
]);

export function sdrEndpoint(record) {
  try {
    const url = new URL(record?.url || '');
    if (!/^https?:$/.test(url.protocol)) return null;
    const port = url.port
      ? Number(url.port)
      : url.protocol === 'https:'
        ? 443
        : 80;
    if (!url.hostname || !Number.isInteger(port)) return null;
    return { host: url.hostname, port };
  } catch {
    return null;
  }
}

export function sdrClientType(record) {
  if (record?.platform === 'kiwi') return 'kiwisdr';
  if (record?.platform === 'openwebrx') return 'openwebrx';
  return null;
}

export function coversFrequency(record, hz) {
  const range = record?.bandsHz;
  // ReceiverBook has no band data for OpenWebRX, so an unknown range is
  // allowed and the receiver's own onConfig reports a profile switch.
  if (!Array.isArray(range)) return record?.platform === 'openwebrx';
  return (
    Number.isFinite(range[0]) &&
    Number.isFinite(range[1]) &&
    hz >= range[0] &&
    hz <= range[1]
  );
}

/** The first preset the receiver covers, else the middle of its range. */
export function defaultTune(record) {
  for (const preset of SDR_PRESETS) {
    if (coversFrequency(record, preset.hz)) return { ...preset };
  }
  const range = record?.bandsHz;
  if (Array.isArray(range) && range[1] > range[0]) {
    const hz = Math.round(range[0] + (range[1] - range[0]) / 2);
    return { hz, mode: hz >= 30e6 ? 'nfm' : 'usb', label: 'Receiver centre' }; // i18n-ignore
  }
  return { hz: 14_074_000, mode: 'usb', label: '20 m FT8' }; // i18n-ignore
}

/** The receiver's own page, tuned where the platform supports it. */
export function receiverTuneUrl(record, hz, mode) {
  const base = String(record?.url || '');
  if (!base) return '';
  if (record.platform === 'kiwi') {
    return `${base}?f=${(hz / 1000).toFixed(3).replace(/\.?0+$/, '')}${mode}`;
  }
  if (record.platform === 'openwebrx') {
    return `${base}#freq=${Math.round(hz)},mod=${mode}`;
  }
  return base;
}

/**
 * One SDR stream at a time. The panel calls `play` from a click so the
 * AudioContext starts under a user gesture; nothing here autoplays.
 */
export function createSdrAudio({ onState = () => {} } = {}) {
  let sdr = null;
  let player = null;
  let requested = null;
  let stopping = false;
  let lastRssiAt = 0;
  const state = {
    status: 'idle',
    receiver: null,
    frequency: null,
    mode: null,
    rssi: null,
    error: null,
    volume: 0.8,
    config: null,
  };
  let lastConfig = null;
  const stateListeners = new Set();
  const waterfallListeners = new Set();

  const emit = (patch = {}) => {
    Object.assign(state, patch);
    const snapshot = { ...state };
    onState(snapshot);
    for (const listener of [...stateListeners]) {
      try {
        listener(snapshot);
      } catch {
        /* a view must not break audio state */
      }
    }
  };

  const emitWaterfall = (frame) => {
    for (const listener of [...waterfallListeners]) {
      try {
        listener(frame, lastConfig);
      } catch {
        /* a view must not break the stream */
      }
    }
  };

  function ensurePlayer() {
    if (!player) {
      player = new WebAudioPcmPlayer({
        initialVolume: state.volume,
        maxQueueSeconds: 0.75,
      });
    }
    player.init();
  }

  function stop() {
    stopping = true;
    lastConfig = null;
    try {
      sdr?.close();
    } catch {
      /* already closed */
    }
    sdr = null;
    requested = null;
    try {
      player?.stop();
    } catch {
      /* no context yet */
    }
    emit({
      status: 'idle',
      receiver: null,
      frequency: null,
      mode: null,
      rssi: null,
      error: null,
      config: null,
    });
    emitWaterfall(null);
    stopping = false;
  }

  function fail(message) {
    emit({ status: 'error', error: message, rssi: null });
  }

  function play(record, options = {}) {
    const type = sdrClientType(record);
    const endpoint = sdrEndpoint(record);
    if (!type || !endpoint) {
      fail('This receiver cannot play in the app.');
      return;
    }
    if (!record.playable || !record.url.startsWith('http://')) {
      fail('This receiver needs https or a desktop client.');
      return;
    }
    const tune =
      options.frequency && Number.isFinite(options.frequency)
        ? {
            hz: options.frequency,
            mode: options.mode || defaultTune(record).mode,
          }
        : defaultTune(record);
    if (!coversFrequency(record, tune.hz)) {
      fail(`This receiver does not cover ${(tune.hz / 1e6).toFixed(3)} MHz.`);
      return;
    }

    stop();
    ensurePlayer();
    lastConfig = null;
    requested = { ...tune, record };
    emit({
      status: 'connecting',
      receiver: record,
      frequency: tune.hz,
      mode: tune.mode,
      rssi: null,
      error: null,
    });

    sdr = new UniversalSDR(type, {
      host: endpoint.host,
      port: endpoint.port,
      username: 'EyeOfHermes',
      onOpen: () => {
        if (requested?.record?.id !== record.id) return;
        emit({ status: 'playing', error: null });
      },
      onAudio: ({ samples, rssi }) => {
        if (requested?.record?.id !== record.id) return;
        try {
          player.play(samples);
        } catch (error) {
          fail(error instanceof Error ? error.message : String(error));
          return;
        }
        const at = Date.now();
        if (Number.isFinite(rssi) && at - lastRssiAt >= 250) {
          lastRssiAt = at;
          emit({ rssi });
        }
      },
      onConfig: (config) => {
        if (requested?.record?.id !== record.id) return;
        lastConfig = { ...config };
        emit({ config: lastConfig });
        const actual = Number(config?.frequency);
        if (
          Number.isFinite(actual) &&
          requested.frequency &&
          Math.abs(actual * 1000 - requested.frequency) > 1000
        ) {
          emit({
            frequency: actual * 1000,
            mode: config.mode || requested.mode,
            error: `Receiver switched to ${actual.toFixed(3)} kHz (${config.mode || 'auto'}).`,
          });
        }
      },
      onWaterfall: (frame) => {
        if (requested?.record?.id !== record.id) return;
        emitWaterfall(frame);
      },
      onError: (error) => {
        if (requested?.record?.id !== record.id) return;
        fail(error instanceof Error ? error.message : String(error));
      },
      onClose: () => {
        if (stopping || requested?.record?.id !== record.id) return;
        emit({
          status: 'error',
          rssi: null,
          error: 'The receiver closed the stream.',
        });
      },
    });
    sdr.connect({
      frequency: tune.hz / 1000,
      mode: tune.mode,
      compression: false,
      sampleRate: 12_000,
      zoom: type === 'kiwisdr' ? 6 : 0,
      centerFreq: tune.hz / 1000,
    });
  }

  function tuneWithMode(frequency, mode) {
    if (!sdr || !requested) return;
    if (!Number.isFinite(frequency)) return;
    const nextMode = mode || requested.mode;
    if (!coversFrequency(requested.record, frequency)) {
      fail(`This receiver does not cover ${(frequency / 1e6).toFixed(3)} MHz.`);
      return;
    }
    sdr.tune(frequency / 1000, nextMode);
    requested = { ...requested, hz: frequency, mode: nextMode };
    emit({ frequency, mode: nextMode, error: null });
  }

  function setZoom(zoom) {
    sdr?.setZoom?.(zoom);
  }

  function setWaterfallView(zoom, centerFreqKHz) {
    sdr?.setWaterfallView?.(zoom, centerFreqKHz);
  }

  function recenterWaterfall() {
    const center = requested?.frequency ? requested.frequency / 1000 : null;
    if (!center || !lastConfig) return;
    sdr?.setWaterfallView?.(lastConfig.zoom, center);
  }

  function subscribeState(listener) {
    if (typeof listener !== 'function') return () => {};
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  }

  function subscribeWaterfall(listener) {
    if (typeof listener !== 'function') return () => {};
    waterfallListeners.add(listener);
    return () => waterfallListeners.delete(listener);
  }

  function setVolume(percent) {
    const value = Math.min(1, Math.max(0, Number(percent) / 100));
    state.volume = value;
    try {
      player?.setVolume(value);
    } catch {
      /* no context yet */
    }
    emit({ volume: value });
  }

  function dispose() {
    stop();
    try {
      player?.ctx?.close?.();
    } catch {
      /* already closed */
    }
    player = null;
  }

  return {
    play,
    stop,
    tune: tuneWithMode,
    setZoom,
    setWaterfallView,
    recenterWaterfall,
    subscribeState,
    subscribeWaterfall,
    setVolume,
    dispose,
    getState: () => ({ ...state }),
  };
}
