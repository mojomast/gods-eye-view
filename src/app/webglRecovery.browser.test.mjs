import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const PAGE = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    html, body, #cesiumContainer { margin: 0; width: 100%; height: 100%; overflow: hidden; }
  </style>
  <script>window.CESIUM_BASE_URL = '/cesium/';</script>
  <script src="/cesium/Cesium.js"></script>
</head>
<body>
  <div id="cesiumContainer"></div>
  <script type="module">
    import { recreateBoundViewer } from '/src/app/webglRecovery.js';
    const options = {
      animation: false,
      baseLayer: false,
      baseLayerPicker: false,
      fullscreenButton: false,
      geocoder: false,
      homeButton: false,
      infoBox: false,
      navigationHelpButton: false,
      sceneModePicker: false,
      selectionIndicator: false,
      timeline: false,
      skyBox: false,
    };
    function poseOf(viewer) {
      const camera = viewer.camera;
      const position = camera.positionWC;
      return {
        x: position.x,
        y: position.y,
        z: position.z,
        heading: camera.heading,
        pitch: camera.pitch,
        roll: camera.roll,
      };
    }
    window.runRecovery = async () => {
      const container = document.getElementById('cesiumContainer');
      const viewer = new Cesium.Viewer(container, options);
      viewer.useDefaultRenderLoop = false;
      const destination = Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 1800);
      viewer.camera.setView({
        destination,
        orientation: { heading: 0.4, pitch: -0.6, roll: 0.15 },
      });
      viewer.render();
      const before = poseOf(viewer);
      const next = await recreateBoundViewer(
        {
          getViewer: () => viewer,
          createViewer() {
            const created = new Cesium.Viewer(container, options);
            created.useDefaultRenderLoop = false;
            return created;
          },
        },
        { viewer, container },
      );
      const after = poseOf(next);
      return {
        before,
        after,
        replaced: next !== viewer && !next.isDestroyed(),
        previousDestroyed: viewer.isDestroyed(),
      };
    };
  </script>
</body>
</html>`;

function contentType(file) {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript';
  if (file.endsWith('.css')) return 'text/css';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.wasm')) return 'application/wasm';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function startServer() {
  const cesiumRoot = path.join(root, 'node_modules/cesium/Build/Cesium');
  const missed = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://127.0.0.1');
      if (url.pathname === '/' || url.pathname === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(PAGE);
        return;
      }
      if (url.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      const file = url.pathname.startsWith('/cesium/')
        ? path.join(cesiumRoot, url.pathname.slice('/cesium/'.length))
        : path.join(root, decodeURIComponent(url.pathname));
      const resolved = path.resolve(file);
      const allowed =
        resolved.startsWith(`${cesiumRoot}${path.sep}`) ||
        resolved.startsWith(`${path.join(root, 'src')}${path.sep}`);
      if (!allowed) {
        missed.push(url.pathname);
        response.writeHead(404);
        response.end();
        return;
      }
      const body = await readFile(resolved);
      response.writeHead(200, { 'content-type': contentType(resolved) });
      response.end(body);
    } catch (error) {
      missed.push(`${request.url} (${error.code || error.message})`);
      response.writeHead(404);
      response.end();
    }
  });
  server.missed = missed;
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

test(
  'a forced WebGL context loss comes back with the camera kept',
  { timeout: 60_000 },
  async () => {
    const server = await startServer();
    const { port } = server.address();
    const browser = await puppeteer.launch({
      headless: true,
      executablePath:
        process.env.PUPPETEER_EXECUTABLE_PATH ||
        (await puppeteer.executablePath()),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--use-gl=angle',
        '--use-angle=swiftshader',
      ],
    });
    try {
      const page = await browser.newPage();
      const failed = [];
      page.on('pageerror', (error) => failed.push(String(error)));
      await page.goto(`http://127.0.0.1:${port}/`, {
        waitUntil: 'networkidle0',
        timeout: 30_000,
      });
      const result = await page.evaluate(() => window.runRecovery());
      assert.equal(
        failed.length,
        0,
        `${failed.join('\n')}\nmissed: ${server.missed.join(', ')}`,
      );
      assert.equal(result.replaced, true);
      assert.equal(result.previousDestroyed, true);
      for (const key of ['heading', 'pitch', 'roll'])
        assert.ok(
          Math.abs(result.after[key] - result.before[key]) < 1e-4,
          `${key} ${result.before[key]} -> ${result.after[key]}`,
        );
      for (const key of ['x', 'y', 'z'])
        assert.ok(
          Math.abs(result.after[key] - result.before[key]) < 1,
          `${key} ${result.before[key]} -> ${result.after[key]}`,
        );
    } finally {
      await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
