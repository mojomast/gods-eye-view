const DEFAULT_PORTS = new Set([80, 443]);
const PLATFORM_TYPES = {
  KiwiSDR: 'kiwi',
  OpenWebRX: 'openwebrx',
  WebSDR: 'websdr',
};

function text(value) {
  return String(value ?? '').trim();
}

function cleanName(value) {
  return text(value)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\\+"/g, '"')
    .replace(/\\+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

/** Return `{lat, lon}` only for a usable point. */
function position(lat, lon) {
  const a = finite(lat);
  const b = finite(lon);
  if (a === null || b === null) return null;
  if (a < -90 || a > 90 || b < -180 || b > 180) return null;
  if (a === 0 && b === 0) return null;
  return { lat: Math.round(a * 1e5) / 1e5, lon: Math.round(b * 1e5) / 1e5 };
}

function urlParts(value) {
  const raw = text(value);
  if (!raw) return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!/^https?:$/.test(url.protocol)) return null;
    if (!url.hostname) return null;
    const port = url.port
      ? Number(url.port)
      : url.protocol === 'https:'
        ? 443
        : 80;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return {
      href: url.href,
      host: url.hostname.toLowerCase(),
      port,
    };
  } catch {
    return null;
  }
}

function endpoint(value) {
  const parts = urlParts(value);
  return parts ? `${parts.host}:${parts.port}` : null;
}

function hostOf(value) {
  return urlParts(value)?.host ?? null;
}

function portOf(value) {
  return urlParts(value)?.port ?? null;
}

/** Parse "0-30000000" or [low, high]; require 0 <= low < high. */
function bandRange(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const low = finite(value[0]);
    const high = finite(value[1]);
    return low !== null && high !== null && low >= 0 && low < high
      ? [low, high]
      : null;
  }
  const match = /^\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*$/.exec(
    text(value),
  );
  if (!match) return null;
  const low = Number(match[1]);
  const high = Number(match[2]);
  return low >= 0 && low < high ? [low, high] : null;
}

function makeRecord(platform, name, url, lat, lon, extra = {}) {
  const parts = urlParts(url);
  const point = position(lat, lon);
  if (!parts || !point) return null;
  const record = {
    id: `${platform}:${parts.host}:${parts.port}`,
    platform,
    name: cleanName(name).slice(0, 240) || parts.host,
    lat: point.lat,
    lon: point.lon,
    url: parts.href,
    playable: false,
    waterfall: false,
    embed: 'unknown',
    sources: [],
  };
  for (const [key, value] of Object.entries(extra)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    record[key] = value;
  }
  record.playable =
    (platform === 'kiwi' || platform === 'openwebrx') &&
    parts.href.startsWith('http://');
  // Both native clients consume the receiver's own waterfall stream.
  record.waterfall = record.playable;
  if (platform === 'websdr' || platform === 'spyserver')
    record.embed = 'blocked';
  else if (platform === 'openwebrx') record.embed = 'allowed';
  return record;
}

function integer(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.round(number)) : null;
}

export function normalizeReceiverBook(sites) {
  const out = [];
  for (const site of sites ?? []) {
    const coordinates = site?.location?.coordinates;
    const lon = Array.isArray(coordinates) ? coordinates[0] : null;
    const lat = Array.isArray(coordinates) ? coordinates[1] : null;
    for (const receiver of site?.receivers ?? []) {
      const platform =
        PLATFORM_TYPES[receiver?.type] ??
        (text(receiver?.type).toLowerCase() || 'other');
      if (!['kiwi', 'openwebrx', 'websdr'].includes(platform)) continue;
      const record = makeRecord(
        platform,
        receiver?.label || site?.label,
        receiver?.url || site?.url,
        lat,
        lon,
        {
          site: cleanName(site?.label),
          version: text(receiver?.version) || null,
          sources: ['receiverbook'],
        },
      );
      if (record) out.push(record);
    }
  }
  return out;
}

export function normalizeKiwi(rows) {
  const out = [];
  for (const row of rows ?? []) {
    const gps = /\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*\)/.exec(text(row?.gps));
    const record = makeRecord(
      'kiwi',
      row?.name || row?.loc,
      row?.url,
      gps?.[1],
      gps?.[2],
      {
        site: cleanName(row?.loc),
        owner: cleanName(row?.name) || null,
        bandsHz: bandRange(row?.bands),
        users: integer(row?.users),
        usersMax: integer(row?.users_max),
        online: text(row?.status) === 'active' && text(row?.offline) === 'no',
        hardware: cleanName(row?.sdr_hw) || null,
        antenna: cleanName(row?.antenna) || null,
        grid: text(row?.grid) || null,
        snr: text(row?.snr) || null,
        lastSeen: text(row?.updated) || null,
        sources: ['kiwi_linkfanel'],
      },
    );
    if (record) out.push(record);
  }
  return out;
}

export function normalizeAirspy(servers) {
  const out = [];
  for (const server of servers ?? []) {
    const location = server?.antennaLocation ?? {};
    const host = text(server?.streamingHost);
    const port = integer(server?.streamingPort);
    if (!host || !port) continue;
    const record = makeRecord(
      'spyserver',
      `${text(server?.ownerName) || 'SpyServer'} · ${text(server?.deviceType)}`,
      `http://${host}:${port}`,
      location.lat,
      location.long,
      {
        owner: cleanName(server?.ownerName) || null,
        hardware: text(server?.deviceType) || null,
        online: Boolean(server?.online),
        users: integer(server?.currentClientCount),
        usersMax: integer(server?.maxClients),
        bandsHz: bandRange([
          server?.minimumFrequency,
          server?.maximumFrequency,
        ]),
        host,
        port,
        sources: ['airspy'],
      },
    );
    if (record) out.push(record);
  }
  return out;
}

export function normalizeUberSdr(instances) {
  const out = [];
  for (const instance of instances ?? []) {
    const max = integer(instance?.max_clients);
    const available = integer(instance?.available_clients);
    const record = makeRecord(
      'ubersdr',
      `${text(instance?.callsign) || text(instance?.name)} · ${text(instance?.location)}`,
      instance?.public_url,
      instance?.latitude,
      instance?.longitude,
      {
        owner: cleanName(instance?.callsign) || null,
        hardware: text(instance?.cpu_model) || null,
        online: instance?.is_online ?? null,
        users:
          max !== null && available !== null
            ? Math.max(0, max - available)
            : null,
        usersMax: max,
        bandsHz: bandRange(instance?.tuning_range),
        snr: finite(instance?.avg_band_snr),
        tls: Boolean(instance?.tls),
        sources: ['ubersdr'],
      },
    );
    if (record) out.push(record);
  }
  return out;
}

export function haversineKm(a, b) {
  const rad = (value) => (value * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

function nameTokens(value) {
  return new Set(
    cleanName(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((token) => token.length > 1),
  );
}

function nameSimilar(a, b) {
  const left = cleanName(a).toLowerCase();
  const right = cleanName(b).toLowerCase();
  if (!left || !right) return false;
  if (left.includes(right) || right.includes(left)) return true;
  const x = nameTokens(left);
  const y = nameTokens(right);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const token of x) if (y.has(token)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.5;
}

function sameReceiver(a, b) {
  if (a.platform !== b.platform) return false;
  if (hostOf(a.url) !== hostOf(b.url)) return false;
  const pa = portOf(a.url);
  const pb = portOf(b.url);
  const aDefault = DEFAULT_PORTS.has(pa);
  const bDefault = DEFAULT_PORTS.has(pb);
  if (aDefault === bDefault) return false;
  if (haversineKm(a, b) > 5) return false;
  return nameSimilar(a.name, b.name);
}

function mergeRows(left, right) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    if (key === 'id' || key === 'platform') continue;
    const current = merged[key];
    if (
      current === null ||
      current === undefined ||
      current === '' ||
      (Array.isArray(current) && current.length === 0)
    )
      merged[key] = value;
  }
  merged.sources = [
    ...new Set([...(left.sources ?? []), ...(right.sources ?? [])]),
  ].sort();
  const port = portOf(merged.url) ?? 0;
  const rightPort = portOf(right.url) ?? 0;
  if (rightPort > port && !DEFAULT_PORTS.has(rightPort)) merged.url = right.url;
  const parts = urlParts(merged.url);
  if (parts) merged.id = `${merged.platform}:${parts.host}:${parts.port}`;
  merged.playable =
    (merged.platform === 'kiwi' || merged.platform === 'openwebrx') &&
    merged.url.startsWith('http://');
  merged.waterfall = merged.playable;
  return merged;
}

/** Merge directory rows into one receiver per physical radio. */
export function mergeReceivers(rows) {
  const byEndpoint = new Map();
  for (const row of rows) {
    const current = byEndpoint.get(row.id);
    byEndpoint.set(row.id, current ? mergeRows(current, row) : row);
  }

  const groups = new Map();
  for (const row of byEndpoint.values()) {
    const key = `${row.platform}:${hostOf(row.url) ?? row.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const merged = [];
  for (const group of groups.values()) {
    const clusters = [];
    for (const row of group) {
      const match = clusters.find((cluster) => sameReceiver(cluster, row));
      if (match) {
        Object.assign(match, mergeRows(match, row));
        continue;
      }
      clusters.push({ ...row });
    }
    merged.push(...clusters);
  }

  return merged.sort(
    (a, b) =>
      a.platform.localeCompare(b.platform) ||
      a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
  );
}

export function buildSdrCatalog(payload) {
  const rows = [
    ...normalizeReceiverBook(payload?.receiverbook),
    ...normalizeKiwi(payload?.kiwi),
    ...normalizeAirspy(payload?.airspy),
    ...normalizeUberSdr(payload?.ubersdr),
  ];
  return mergeReceivers(rows);
}
