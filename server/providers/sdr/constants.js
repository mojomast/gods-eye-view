export const SDR_CACHE_MS = 45 * 60 * 1000;
export const SDR_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const SDR_FETCH_TIMEOUT_MS = 15_000;
export const SDR_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
export const SDR_RECEIVER_LIMIT = 4000;
export const SDR_DEFAULT_LIMIT = 500;
export const SDR_USER_AGENT = 'GodsEyeView/1.0 (SDR directory client)';

export const SDR_SOURCE_URLS = Object.freeze({
  receiverbook: 'https://www.receiverbook.de/map',
  kiwi: 'http://rx.linkfanel.net/kiwisdr_com.js',
  airspy: 'https://airspy.com/directory/status.json',
  ubersdr: 'https://instances.ubersdr.org/api/instances?conditions=true',
});

export const SDR_SOURCE_LABELS = Object.freeze({
  receiverbook: 'ReceiverBook',
  kiwi: 'KiwiSDR public list',
  airspy: 'Airspy Receiver Directory',
  ubersdr: 'UberSDR Instance Directory',
});
