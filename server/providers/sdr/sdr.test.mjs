import test from 'node:test';
import assert from 'node:assert/strict';

import { createSdrProxyMiddleware } from './catalog.js';
import { buildSdrCatalog } from './normalize.js';
import {
  parseAirspy,
  parseKiwiList,
  parseReceiverBook,
  parseUberSdr,
} from './sources.js';

const RECEIVERBOOK = `<!doctype html><script>var receivers = [{"label":"Example site","location":{"coordinates":[0.8,44.8]},"receivers":[{"label":"Kiwi A","version":"1.902","type":"KiwiSDR","url":"http://radio.example.org:8073/"},{"label":"VHF box","type":"OpenWebRX","url":"http://radio.example.org:8074/"}]}];</script>`;

const KIWI = `// list
var kiwisdr_com = [
 { "name":"Kiwi A", "url":"http://radio.example.org:80", "gps":"(44.8, 0.8)", "bands":"0-30000000", "users":"1", "users_max":"4", "status":"active", "offline":"no" },
];`;

const AIRSPY = JSON.stringify({
  servers: [
    {
      ownerName: 'Test owner',
      deviceType: 'AirspyHF+',
      antennaLocation: { lat: 44.8, long: 0.8 },
      minimumFrequency: 0,
      maximumFrequency: 31_000_000,
      currentClientCount: 0,
      maxClients: 2,
      online: true,
      streamingHost: '203.0.113.9',
      streamingPort: 5555,
    },
  ],
});

const UBERSDR = JSON.stringify({
  instances: [
    {
      callsign: 'N0CALL',
      name: 'Test',
      location: 'Testville',
      latitude: 44.8,
      longitude: 0.8,
      public_url: 'http://uber.example.org/',
      max_clients: 10,
      available_clients: 8,
      is_online: true,
      tuning_range: '0-30000000',
      tls: false,
    },
  ],
});

test('parsers accept the published shapes, including the Kiwi trailing comma', () => {
  assert.equal(parseReceiverBook(RECEIVERBOOK).length, 1);
  assert.equal(parseKiwiList(KIWI).length, 1);
  assert.equal(parseAirspy(AIRSPY).length, 1);
  assert.equal(parseUberSdr(UBERSDR).length, 1);
});

test('catalog merges a proxy alias but keeps two ports on one host apart', () => {
  const records = buildSdrCatalog({
    receiverbook: parseReceiverBook(RECEIVERBOOK),
    kiwi: parseKiwiList(KIWI),
    airspy: parseAirspy(AIRSPY),
    ubersdr: parseUberSdr(UBERSDR),
  });
  assert.equal(records.length, 4);
  const kiwi = records.find((record) => record.platform === 'kiwi');
  assert.equal(kiwi.url, 'http://radio.example.org:8073/');
  assert.deepEqual(kiwi.sources, ['kiwi_linkfanel', 'receiverbook']);
  const openwebrx = records.find((record) => record.platform === 'openwebrx');
  assert.equal(openwebrx.url, 'http://radio.example.org:8074/');
});

test('only http Kiwi and OpenWebRX records are playable; WebSDR/SpyServer are not', () => {
  const records = buildSdrCatalog({
    receiverbook: parseReceiverBook(RECEIVERBOOK),
    kiwi: parseKiwiList(KIWI),
    airspy: parseAirspy(AIRSPY),
    ubersdr: parseUberSdr(UBERSDR),
  });
  assert.equal(
    records.find((record) => record.platform === 'kiwi').playable,
    true,
  );
  assert.equal(
    records.find((record) => record.platform === 'openwebrx').playable,
    true,
  );
  assert.equal(
    records.find((record) => record.platform === 'spyserver').playable,
    false,
  );
  assert.equal(
    records.find((record) => record.platform === 'spyserver').embed,
    'blocked',
  );
});

function response(body) {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain' },
  });
}

function request(url) {
  const state = { statusCode: 200, headers: {}, body: '' };
  const res = {
    set statusCode(value) {
      state.statusCode = value;
    },
    setHeader(name, value) {
      state.headers[name.toLowerCase()] = value;
    },
    end(body) {
      state.body = body;
    },
  };
  return { req: { url }, res, state };
}

test('middleware serves a filtered, bounded receiver page', async () => {
  const bodies = {
    'https://www.receiverbook.de/map': RECEIVERBOOK,
    'http://rx.linkfanel.net/kiwisdr_com.js': KIWI,
    'https://airspy.com/directory/status.json': AIRSPY,
    'https://instances.ubersdr.org/api/instances?conditions=true': UBERSDR,
  };
  const fetchImpl = async (url) => {
    assert.ok(bodies[url], `unexpected fetch ${url}`);
    return response(bodies[url]);
  };
  const middleware = createSdrProxyMiddleware({ fetchImpl });
  const first = request('/receivers?playable=1&limit=2');
  await middleware(first.req, first.res, () => assert.fail('next called'));
  assert.equal(first.state.statusCode, 200);
  const body = JSON.parse(first.state.body);
  assert.equal(body.total, 2);
  assert.equal(body.receivers.length, 2);
  assert.equal(body.truncated, false);
  assert.equal(body.counts.kiwi, 1);
  assert.equal(body.counts.openwebrx, 1);

  const second = request('/receivers?platform=kiwi');
  await middleware(second.req, second.res, () => assert.fail('next called'));
  const filtered = JSON.parse(second.state.body);
  assert.equal(filtered.total, 1);
  assert.equal(filtered.receivers[0].platform, 'kiwi');

  const third = request('/receivers?waterfall=1');
  await middleware(third.req, third.res, () => assert.fail('next called'));
  const waterfall = JSON.parse(third.state.body);
  assert.equal(waterfall.total, 2);
  assert.deepEqual(
    waterfall.receivers.map((record) => record.platform).sort(),
    ['kiwi', 'openwebrx'],
  );
  assert.ok(waterfall.receivers.every((record) => record.waterfall === true));
});
