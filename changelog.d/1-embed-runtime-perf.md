- An embedded globe can load Google, Cesium, Photon, and Mapillary settings
  from `config.json` or a `gev:config` message, with build-time env as the
  fallback. A hidden pane, including an inline embed, pauses rendering, HUD
  timers, and feed polls; the host overrides that with
  `{ type: 'gev:visibility', visible }`. `perf=embed` caps the 3D tile cache,
  targets 30 fps, and lightens MSAA. View state includes camera heading, pitch,
  and roll (#1).
