import {
  installContextLossListener,
  recreateBoundViewer,
} from './webglRecovery.js';
import { SceneDirector } from '../scenes/director.js';
import { initAnnotations } from '../annotations/index.js';
import { initDrawTool } from '../annotations/drawTool.js';
import { initGeoFileImport } from '../ui/geoFileImport.js';
import { useDisplayStore } from '../ui/stores/display.js';
import { applicationPinia } from '../ui/vueRuntime.js';
import { initImageryBoxTool } from '../ui/imageryBoxTool.js';
import { createRecentImageryPanel } from '../ui/recentImagery.js';
import { initGevVoiceCommands } from '../voice/gevRealtime.js';
import {
  installViews,
  isBackgroundWorkSuspended,
  subscribeEmbedVisibility,
} from './embed.js';
import { installScopeMask, destroyScopeMask } from '../scopeMask.js';
import { installLayerReleaseTrim } from '../sceneCommandRelease.js';
import {
  installRenderGovernor,
  getRenderGovernorDiagnostics,
  governorRequestRender,
  holdContinuousRender,
  releaseContinuousRender,
} from '../renderGovernor.js';

/** Attach scene tools, rendering listeners and the application debug handle. */
export function createApplicationTools({
  scene,
  controls,
  data,
  loadingScreen,
  placeSearch,
  voice = {},
  startChrome,
  onSceneDirector,
  sceneDataPacks,
  signal,
  defer,
}) {
  const globe = scene.globe || {
    viewer: scene.viewer,
    tileset: scene.tileset,
  };
  const { viewer, tileset, mapStackController, operations } = scene;
  const { styleManager, weatherEffects, cockpitCloudEffects } = controls;
  const { dataManager } = data;
  const sceneDirector = new SceneDirector(viewer, styleManager, dataManager, {
    dataPacks: sceneDataPacks,
    isMapStackAvailable: (id) =>
      mapStackController?.isStackAvailable(id) === true,
  });
  dataManager.layers
    .get('bhote-koshi-2026')
    ?.module.attachSceneController(sceneDirector);
  defer(() => sceneDirector.destroy());
  onSceneDirector?.(sceneDirector);
  const annotations = initAnnotations({
    viewer,
    tileset,
    placeSearch,
    resolver: operations.annotationResolver,
  });
  defer(() => {
    if (window.__gevAnnotations === annotations) delete window.__gevAnnotations;
    annotations.destroy();
  });
  const displayStore = useDisplayStore(applicationPinia());
  // The Display panel's controls answer through the store; returns the
  // disconnect.
  const connectDisplay = (actions) => {
    const token = displayStore.connect(actions);
    return () => displayStore.detach(token);
  };
  // UTILITIES ▸ Draw: the same whiteboard, drawn by hand. It claims the pointer
  // while a session is open, so its teardown belongs to the application
  // lifetime rather than to whoever last pressed the button. A row's fly-to
  // goes through the shell's navigation policy, as Import's does.
  const drawTool = initDrawTool({
    viewer,
    annotations,
    navigation: styleManager,
    publish: (view) => displayStore.publishDraw(view),
    connect: connectDisplay,
  });
  defer(() => drawTool?.destroy());
  // UTILITIES ▸ Import: the person's own GeoJSON/KML/KMZ/GPX files, each its
  // own data source. They live for the page session, so the application
  // lifetime removes them and the drop listeners on the viewer container.
  const geoFileImport = initGeoFileImport({
    viewer,
    navigation: styleManager,
    ground: operations.surface?.groundFloor,
    subscribeMapSource: (listener) => mapStackController?.subscribe?.(listener),
    publish: (view) => displayStore.publishGeoImport(view),
    connect: connectDisplay,
  });
  defer(() => geoFileImport?.destroy());
  // DATA ▸ Recent Imagery: the box tool claims the pointer like Draw and the
  // panel lives on the right rail, so both belong to the application
  // lifetime. The tileset lets the layer drape while the globe is hidden.
  const recentImagery = dataManager.layers.get('recent-imagery')?.module;
  let imageryBoxTool = null;
  let recentPanel = null;
  if (recentImagery) {
    recentImagery.attachTileset(tileset);
    imageryBoxTool = initImageryBoxTool({
      viewer,
      onBox: (box) => recentImagery.setBox(box),
      onCancel: (reason, message, box) => {
        if (message) recentImagery.reportBoxRefusal(message, box);
      },
      onActive: (active) => recentImagery.setToolActive(active),
      // The tool takes Escape in a capture listener, so the panel's order
      // (clear a preview before cancelling the tool) is applied here.
      onEscape: () => recentImagery.clearPreview(),
    });
    // The readout mounts in its rail body through the layer panel, like the
    // weather readout.
    data.presentation.attachRecentImagery((container) => {
      recentPanel = createRecentImageryPanel({
        container,
        viewer: globe.viewer,
        layer: recentImagery,
        tool: imageryBoxTool,
      });
      return recentPanel;
    });
    // The live gate's handle (scripts/qa-recent-imagery.mjs).
    const recentImageryHandle = { layer: recentImagery, tool: imageryBoxTool };
    window.__gevRecentImagery = recentImageryHandle;
    defer(() => {
      if (window.__gevRecentImagery === recentImageryHandle)
        delete window.__gevRecentImagery;
      data.presentation.attachRecentImagery(null);
      imageryBoxTool?.destroy();
    });
  }
  if (startChrome)
    defer(startChrome({ loadingScreen, styleManager, dataManager, signal }));
  // Idle render governor: flips the scene into requestRenderMode whenever
  // nothing animates per frame. Installed AFTER every module above has had
  // its chance to register pre-install holds. (perf wave 2)
  installRenderGovernor(viewer);
  // Cesium keeps a turned-off layer's draw commands (and so all its entities)
  // alive in reused per-pass arrays; trim them after each disable.
  let removeTrim = installLayerReleaseTrim({
    scene: viewer.scene,
    dataManager,
    requestRender: governorRequestRender,
  });
  defer(() => removeTrim());

  // Install the explicit scope mask used by the DISPLAY controls.
  installScopeMask(viewer);
  defer(() => destroyScopeMask());

  // The follow camera recomputes the tracked target's dead-reckon position
  // every frame — tracking anything is a per-frame animation. (perf wave 2)
  let removeTracking = () => {};
  const bindTracking = (target) => {
    removeTracking();
    removeTracking =
      target.trackedEntityChanged?.addEventListener(() => {
        if (target.trackedEntity) holdContinuousRender('tracked-entity');
        else releaseContinuousRender('tracked-entity');
      }) || (() => {});
  };
  bindTracking(viewer);

  // Hidden-state suspension (perf wave 2): when the window/tab is hidden,
  // stop the default render loop outright — a hidden canvas repaints for
  // nobody, and browser rAF throttling still lets throttled frames burn
  // GPU. Holder/data state is untouched, so return is seamless: restore
  // the loop, refresh the one DOM surface we gated, render a frame.
  const syncVisibilitySuspension = () => {
    // Document hidden pauses, including an inline embed. A host message wins:
    // visible:false pauses a covered pane, visible:true keeps drawing when the
    // host falsely reports the page hidden (see keepPanelRendering).
    const hidden = isBackgroundWorkSuspended(document);
    const current = globe.viewer;
    current.__gevBackgroundSuspended = hidden;
    current.useDefaultRenderLoop = !hidden;
    cockpitCloudEffects?.setSuspended?.(hidden);
    if (!hidden) {
      data.presentation.flushVisible();
      governorRequestRender('visibility-restore');
    }
  };
  document.addEventListener('visibilitychange', syncVisibilitySuspension);
  const removeEmbedVisibility = subscribeEmbedVisibility(
    syncVisibilitySuspension,
  );
  defer(() => {
    document.removeEventListener('visibilitychange', syncVisibilitySuspension);
    removeEmbedVisibility();
  });
  defer(() => {
    removeTracking();
    releaseContinuousRender('tracked-entity');
  });
  // Apply the CURRENT state too — bootstrap can complete while the tab is
  // already hidden, and waiting for the next transition would leave the
  // loop burning behind a hidden tab. (perf wave 2 fix)
  syncVisibilitySuspension();

  window.__godsEyeView = {
    viewer,
    styleManager,
    tileset,
    dataManager,
    sceneDirector,
    mapStackController,
    annotations,
    weatherEffects,
    cockpitCloudEffects,
    getRenderGovernorDiagnostics,
    surfaceServices: operations.surface,
    requestRender: governorRequestRender,
  };
  const debug = window.__godsEyeView;
  defer(() => {
    if (window.__godsEyeView === debug) delete window.__godsEyeView;
  });
  let voiceCommands;
  const binding = {
    getViewer: () => globe.viewer,
    prepare: async () => {
      scene.releaseViewerInput?.();
      uninstallRenderGovernor(globe.viewer);
      removeTrim();
      removeTrim = () => {};
      destroyScopeMask();
      controls.releaseZoom?.();
      removeTracking();
      removeTracking = () => {};
      await dataManager.detachForViewerSwap?.();
    },
    createViewer: (info) => scene.createReplacementViewer?.(info),
    rebind: async (next) => {
      styleManager.adoptViewer?.(next);
      sceneDirector.adoptViewer?.(next);
      await dataManager.attachToViewer?.(next);
      data.rebindCyberSonar?.(next);
      cockpitCloudEffects?.adoptViewer?.(next);
      controls.rebindZoom?.(next);
      annotations.rebindViewer?.(next, globe.tileset);
      await drawTool?.rebindViewer?.(next);
      geoFileImport?.rebindViewer?.(next);
      await imageryBoxTool?.rebindViewer?.(next);
      recentImagery?.attachTileset?.(globe.tileset);
      recentPanel?.rebindViewer?.(next);
      installRenderGovernor(next);
      removeTrim = installLayerReleaseTrim({
        scene: next.scene,
        dataManager,
        requestRender: governorRequestRender,
      });
      installScopeMask(next);
      bindTracking(next);
      voiceCommands?.rebindViewer?.(next);
      debug.viewer = next;
      debug.tileset = globe.tileset;
      syncVisibilitySuspension();
    },
  };
  const recreateViewer = (request) => recreateBoundViewer(binding, request);
  debug.recreateViewer = recreateViewer;
  defer(
    installContextLossListener({
      windowRef: window,
      enabled: () => scene.glRecover === true,
      busy: () => Boolean(binding.inflight),
      recreateViewer: () => recreateViewer(),
    }),
  );
  voiceCommands = initGevVoiceCommands({
    ...voice,
    floorServices: operations.surface.groundFloor,
    annotationResolver: operations.annotationResolver,
    searchNavigation: operations.searchAndFlyTo,
    signal,
    placeSearch,
    viewer,
    styleManager,
    dataManager,
    sceneDirector,
    annotations,
  });
  defer(() => {
    voiceCommands.stop({ removeUi: true });
    if (window.__gevVoiceCommands === voiceCommands)
      delete window.__gevVoiceCommands;
  });
  debug.voiceCommands = voiceCommands;
  const removeViews = installViews({
    shell: styleManager,
    viewer,
    getViewer: () => globe.viewer,
    recreateViewer: () => recreateViewer(),
    dataManager,
    run: (name, args) => voiceCommands.runner(name, args, { signal }),
    signal,
  });
  defer(removeViews);
  return { sceneDirector, annotations, voiceCommands };
}
