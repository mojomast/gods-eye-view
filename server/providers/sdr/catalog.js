import { randomUUID } from 'node:crypto';

import {
  SDR_CACHE_MS,
  SDR_DEFAULT_LIMIT,
  SDR_RECEIVER_LIMIT,
  SDR_SOURCE_URLS,
  SDR_STALE_MS,
} from './constants.js';
import { buildSdrCatalog } from './normalize.js';
import { fetchSdrSource } from './sources.js';

const BANDS = {
  hf: [3e6, 30e6],
  vhf: [30e6, 300e6],
  uhf: [300e6, 3e9],
};

function numberParam(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function coversBand(record, low, high) {
  const range = record.bandsHz;
  return (
    Array.isArray(range) &&
    Number.isFinite(range[0]) &&
    Number.isFinite(range[1]) &&
    range[1] >= low &&
    range[0] <= high
  );
}

function available(record) {
  if (record.online === false) return false;
  if (
    Number.isFinite(record.usersMax) &&
    Number.isFinite(record.users) &&
    record.users >= record.usersMax
  )
    return false;
  return true;
}

export function filterSdrReceivers(records, search) {
  const platforms = new Set(
    String(search.get('platform') || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const band = BANDS[String(search.get('band') || '').toLowerCase()] ?? null;
  const query = String(search.get('q') || '')
    .trim()
    .toLowerCase();
  const onlyAvailable = search.get('available') === '1';
  const onlyPlayable = search.get('playable') === '1';
  const onlyWaterfall = search.get('waterfall') === '1';

  return records.filter((record) => {
    if (platforms.size && !platforms.has(record.platform)) return false;
    if (band && !coversBand(record, band[0], band[1])) return false;
    if (onlyAvailable && !available(record)) return false;
    if (onlyPlayable && !record.playable) return false;
    if (onlyWaterfall && !(record.waterfall ?? record.playable)) return false;
    if (query) {
      const haystack = [
        record.name,
        record.site,
        record.owner,
        record.hardware,
        record.platform,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
}

/**
 * Create the Connect middleware behind `/api/sdr`. One process-scoped catalog,
 * refreshed on demand, with each upstream isolated so one outage degrades only
 * that source's rows.
 */
export function createSdrProxyMiddleware({
  fetchImpl = globalThis.fetch,
  now = Date.now,
  ttlMs = SDR_CACHE_MS,
} = {}) {
  const instance = randomUUID();
  let generation = 0;
  let cache = null;
  let inflight = null;

  async function refresh() {
    const names = Object.keys(SDR_SOURCE_URLS);
    const results = await Promise.allSettled(
      names.map((name) => fetchSdrSource(name, fetchImpl)),
    );
    const payload = {};
    const failed = [];
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') payload[names[index]] = result.value;
      else failed.push(names[index]);
    });
    const records = buildSdrCatalog(payload);
    if (!records.length) {
      if (cache) {
        cache.stale = true;
        return cache;
      }
      throw new Error(
        `No SDR receivers returned (${failed.join(', ') || 'all sources'})`,
      );
    }
    generation += 1;
    cache = {
      instance,
      generation,
      updatedAt: new Date(now()).toISOString(),
      at: now(),
      stale: failed.length > 0,
      failed,
      records,
    };
    return cache;
  }

  async function catalog() {
    if (cache && now() - cache.at < ttlMs) return cache;
    if (!inflight)
      inflight = refresh().finally(() => {
        inflight = null;
      });
    return inflight;
  }

  return async function sdrMiddleware(req, res, next) {
    if (!/^\/receivers(?:[/?]|$)/.test(req.url || '')) {
      next();
      return;
    }
    try {
      const current = await catalog();
      const url = new URL(req.url, 'http://localhost');
      const limit = numberParam(
        url.searchParams.get('limit'),
        SDR_DEFAULT_LIMIT,
        1,
        SDR_RECEIVER_LIMIT,
      );
      const offset = numberParam(
        url.searchParams.get('offset'),
        0,
        0,
        SDR_RECEIVER_LIMIT,
      );
      const matched = filterSdrReceivers(current.records, url.searchParams);
      const counts = matched.reduce((counts, record) => {
        counts[record.platform] = (counts[record.platform] ?? 0) + 1;
        return counts;
      }, {});
      const page = matched.slice(offset, offset + limit);
      const body = JSON.stringify({
        instance: current.instance,
        generation: current.generation,
        updatedAt: current.updatedAt,
        stale: current.stale,
        failedSources: current.failed ?? [],
        total: matched.length,
        offset,
        truncated: offset + page.length < matched.length,
        counts,
        receivers: page,
      });
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'private, max-age=60');
      res.end(body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stale = cache && now() - cache.at <= SDR_STALE_MS ? cache : null;
      if (stale) {
        stale.stale = true;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'private, max-age=60');
        res.end(
          JSON.stringify({
            instance: stale.instance,
            generation: stale.generation,
            updatedAt: stale.updatedAt,
            stale: true,
            failedSources: stale.failed ?? [],
            total: stale.records.length,
            offset: 0,
            truncated: false,
            counts: {},
            receivers: stale.records.slice(0, SDR_DEFAULT_LIMIT),
            error: message,
          }),
        );
        return;
      }
      res.statusCode = 502;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: 'sdr_directory_unavailable',
          message,
        }),
      );
    }
  };
}
