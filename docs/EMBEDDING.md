# Embedding God's Eye View

`?embed=1` shows the globe without the app's own panels. A host can also load
the page into itself and set `globalThis.GEV_EMBED_INLINE = true` before the
module runs (the panel build does this). Framing is a separate decision: pages
are not framable unless `GEV_EMBED_FRAME_ANCESTORS` names the parent. See
[TOOLS.md](TOOLS.md) for `gev:view`.

Set `globalThis.GEV_EMBED_FULL_UI = true` before the app loads to keep the full
interface instead of the clean globe. Unset, or any value other than `true`,
keeps the panels hidden. View messages, visibility, config, and `gev:recreate`
still apply either way.

Client keys and the embed performance profile can be supplied without rebuilding.
Build-time `GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`, `MAPILLARY_CLIENT_TOKEN`
and `PHOTON_URL` remain the fallback. Later sources override a field only when
they set it. These values are visible to the page. Do not commit real keys.
`public/config.example.json` has placeholders; `public/config.json` is gitignored.

## config.json

Fetched from `config.json` next to the page (`public/config.json` in dev, the
site root after `vite build`). A missing file, a non-JSON body, or a failed
fetch (including a sandboxed frame whose origin cannot read it) is ignored.

```json
{
  "googleMapsApiKey": "YOUR_GOOGLE_MAPS_BROWSER_KEY",
  "cesiumIonToken": "YOUR_CESIUM_ION_TOKEN",
  "photonUrl": "https://photon.example.com/api/",
  "mapillaryToken": "MLY|YOUR_MAPILLARY_CLIENT_TOKEN"
}
```

`photonUrl: ""` (or `"off"`) disables Photon. Omitting it leaves the build-time
setting, which itself defaults to the public Photon endpoint. Env-style names
(`GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN`, `MAPILLARY_CLIENT_TOKEN`,
`PHOTON_URL`) are accepted too.

## Injected config

A script that runs before `/src/main.js` may set:

```js
window.GEV_RUNTIME_CONFIG = {
  googleMapsApiKey: 'YOUR_GOOGLE_MAPS_BROWSER_KEY',
  cesiumIonToken: 'YOUR_CESIUM_ION_TOKEN',
  photonUrl: 'https://photon.example.com/api/',
  mapillaryToken: 'MLY|YOUR_MAPILLARY_CLIENT_TOKEN',
};
```

## postMessage `gev:config`

```js
iframe.contentWindow.postMessage({
  type: 'gev:config',
  googleMapsApiKey: 'YOUR_GOOGLE_MAPS_BROWSER_KEY',
  cesiumIonToken: 'YOUR_CESIUM_ION_TOKEN',
  photonUrl: 'https://photon.example.com/api/',
  mapillaryToken: 'MLY|YOUR_MAPILLARY_CLIENT_TOKEN',
}, '*');
```

A nested `config` object is accepted. The sender must be the frame itself
(an injected script) or its parent. The app answers
`{ type: 'gev:config-applied', ok: true, perf: 'embed' | 'custom' | null }`
when the message is applied (`custom` is a numeric knob without the embed
bundle; the answer never includes keys), or
`{ ok: false, error: 'already-applied' }` if the viewer has already been
created. A message applied during startup is acknowledged when the embed
listener starts.

Timing: module evaluation finishes before the frame's load event, and viewer
setup waits for this message only when asked.

- `?waitForConfig=1` or `window.GEV_WAIT_FOR_CONFIG = true` waits up to 2 seconds.
- `?configWaitMs=1500` waits that long (0–10000).
- Otherwise the app does not block. Post the message before load (as soon as
  `contentWindow` exists), or set `GEV_RUNTIME_CONFIG`, or ship `config.json`.

`public/embed-boot.js` queues `gev:config`, `gev:visibility`, and `gev:recreate`
until the app listens, so a message sent while the module is still starting is
not lost.

## Visibility

A hidden document pauses the render loop, HUD timers and feed polls, including
an inline embed. A covered pane whose document still looks visible pauses when
the host says so:

```js
iframe.contentWindow.postMessage({ type: 'gev:visibility', visible: false }, '*');
```

`visible: true` resumes. It also overrides a document the browser reports as
hidden, which some panel hosts do while the pane is on screen. While that
override is set and animation frames have stopped, the inline panel keeps
drawing from a timer. The app answers:

```js
{ type: 'gev:visibility-applied', visible: false }
```

`visible` in the answer is the effective state. Omit the message and the
document's own visibility is used. A message queued before the viewer exists is
applied at startup; post again after `{ type: 'gev:ready' }` if you need the
acknowledgement.

## Replacing a lost WebGL context

Cesium cannot restore GPU resources after `webglcontextlost`. The supported
recovery destroys the viewer and creates another in the same container, then
rebinds the layers, map stack, visual style, camera listeners, embed view
reporting, visibility pause, performance profile, and voice runner. The camera
pose is kept. The promise resolves to the new viewer when its first frame has
rendered.

```js
const viewer = await iframe.contentWindow.__godsEyeView.recreateViewer({
  container,
  viewer: previous,
});
```

`container` and `viewer` are optional. The same request is a message, answered
like `gev:config` and `gev:visibility`:

```js
iframe.contentWindow.postMessage({ type: 'gev:recreate' }, '*');
// { type: 'gev:recreate-applied', ok: true }
```

`ok: false` carries `error` (`unavailable` or `recreate-failed`). The hook is
always installed. The page also handles `webglcontextlost` itself when
`glRecover` is on (`?glRecover=1`, `"glRecover": true` in config, or the same
field on `gev:config`). That switch is off unless set, so a standalone page
does not rebuild on its own. After three losses inside 20 seconds, automatic
recovery stops; an explicit `recreateViewer()` or `gev:recreate` still runs.
The context is released with `WEBGL_lose_context.loseContext()` before
`viewer.destroy()`.

## Performance profile

Ordinary sessions are unchanged. Opt in with `?perf=embed`, `"perf": "embed"`
in config, or the same field on `gev:config` / `GEV_RUNTIME_CONFIG`. The profile:

| Knob | Embed default |
| --- | --- |
| 3D tile `cacheBytes` | 384 MB |
| `maximumCacheOverflowBytes` | 128 MB |
| `targetFrameRate` | 30 |
| `msaaSamples` | 2 |
| screen-space error | 16, raised to 24 while the camera is moving |
| dynamic and foveated screen-space error | on |
| `preserveDrawingBuffer` | off (screenshots render, then read in the same turn) |

Override any of them in the same config or query (`tilesCacheMb` 64–2048,
`maximumCacheOverflowMb` 0–1024, `targetFrameRate` 1–60, `msaaSamples` 1, 2 or
4, `maximumScreenSpaceError`, `movingScreenSpaceError`). A number without
`perf=embed` changes only that knob. `perf=default` keeps the normal viewer.

## View state

`get_current_view_state` (and the World Packet it returns) includes
`camera.headingDeg`, `camera.pitchDeg` and `camera.rollDeg` in degrees, plus
the enabled `layers` list it already returned. Missing orientation is `null`.

## Screenshots

The default viewer keeps `preserveDrawingBuffer` so a capture can read the
canvas after the frame. `perf=embed` turns it off. Captures then call
`viewer.render()` and read the canvas before yielding. A hidden document, or a
host `visible: false`, does not render a frame for a capture.
