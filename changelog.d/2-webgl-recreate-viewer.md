- A lost WebGL context can be replaced in place. `recreateViewer()` releases
  the context, destroys the viewer, and creates a new one in the same
  container, then rebinds layers, the map stack, visual style, camera
  listeners, embed view reporting, the visibility pause, the embed performance
  profile, and the voice runner. The promise resolves when the first frame
  renders. Hosts call `window.__godsEyeView.recreateViewer` or post
  `{ type: 'gev:recreate' }` and receive `{ type: 'gev:recreate-applied', ok }`.
  `glRecover` (query, config, or `gev:config`) makes the page do this on
  `webglcontextlost` (#2).
