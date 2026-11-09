import { readResponseTextCapped } from '../common/http.js';
import {
  SDR_FETCH_TIMEOUT_MS,
  SDR_RESPONSE_MAX_BYTES,
  SDR_SOURCE_URLS,
  SDR_USER_AGENT,
} from './constants.js';

/** Fetch one directory as text with a timeout and a hard byte cap. */
async function fetchText(url, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SDR_FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: {
        Accept: 'text/html,application/javascript,application/json',
        'User-Agent': SDR_USER_AGENT,
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${url} returned ${response.status}`);
    return await readResponseTextCapped(response, SDR_RESPONSE_MAX_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

/** ReceiverBook embeds `var receivers = [...]` in its map page. */
export function parseReceiverBook(html) {
  const match = /var\s+receivers\s*=\s*(\[[\s\S]*?\]);/.exec(html);
  if (!match) throw new Error('ReceiverBook list not found');
  return JSON.parse(match[1]);
}

/** The linkfanel file is a JS array with a trailing comma before `]`. */
export function parseKiwiList(text) {
  const start = text.indexOf('[', text.indexOf('var kiwisdr_com'));
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) throw new Error('Kiwi list not found');
  const body = text.slice(start, end + 1).replace(/,\s*\]\s*$/, ']');
  return JSON.parse(body);
}

/** Airspy's directory is a JSON object with a `servers` array. */
export function parseAirspy(json) {
  const parsed = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(parsed?.servers))
    throw new Error('Airspy servers missing');
  return parsed.servers;
}

/** UberSDR's directory is `{ count, instances }`. */
export function parseUberSdr(json) {
  const parsed = typeof json === 'string' ? JSON.parse(json) : json;
  if (!Array.isArray(parsed?.instances))
    throw new Error('UberSDR instances missing');
  return parsed.instances;
}

const PARSERS = {
  receiverbook: parseReceiverBook,
  kiwi: parseKiwiList,
  airspy: parseAirspy,
  ubersdr: parseUberSdr,
};

/** Read and parse one directory. Returns `{ rows }` or `{ error }`. */
export async function fetchSdrSource(name, fetchImpl = globalThis.fetch) {
  const url = SDR_SOURCE_URLS[name];
  if (!url) throw new Error(`Unknown SDR source: ${name}`);
  const text = await fetchText(url, fetchImpl);
  const rows = PARSERS[name](text);
  if (!Array.isArray(rows)) throw new Error(`${name} did not return rows`);
  return rows;
}
