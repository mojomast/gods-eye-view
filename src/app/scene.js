import { createApplicationOperations } from './operations.js';
import * as Cesium from 'cesium';
import {
  createApplicationViewer,
  installTrackpadPinchZoom,
} from '../app/viewer.js';
import { registerDataCredits } from '../data/dataCredits.js';
import { configureCreditKeyboardAccess } from '../creditKeyboard.js';
import { MapStackController } from '../mapStackController.js';
import { loadPhotorealisticTileset } from '../mapStartup.js';
import { initLogoGaze } from '../logoGaze.js';
import {
  uninstallRenderGovernor,
  governorRequestRender,
} from '../renderGovernor.js';
import { describeError } from './errors.js';
import { onLocaleChange, t } from '../i18n/index.js';
import { applyTilesetPerformance } from './perfProfile.js';

/** Construct the application globe using the caller's local configuration. */
export async function createApplicationScene({
  requestServices,
  googleApiKey,
  googleTokens = null,
  cesiumToken,
  profile = null,
  glRecover = false,
  credits,
  MapController = MapStackController,
  mapOptions = {},
  loaderStatus,
  signal,
  defer,
}) {
  const operations = createApplicationOperations({
    requests: requestServices,
    signal,
  });
  defer(initLogoGaze());
  const previousKey = window.__GOOGLE_MAPS_API_KEY__;
  if (googleApiKey) {
    window.__GOOGLE_MAPS_API_KEY__ = googleApiKey;
    defer(() => {
      if (window.__GOOGLE_MAPS_API_KEY__ !== googleApiKey) return;
      if (previousKey === undefined) delete window.__GOOGLE_MAPS_API_KEY__;
      else window.__GOOGLE_MAPS_API_KEY__ = previousKey;
    });
  }
  loaderStatus.textContent = t('Configuring viewer...');
  // Provider attribution stays visible, including clean-view and recording.
  const creditContainer = document.createElement('div');
  creditContainer.id = 'cesium-credits';
  document.body.appendChild(creditContainer);
  defer(() => creditContainer.remove());
  const globe = { viewer: null, tileset: null };
  let removePinch = () => {};
  let removeTilesetPerf = () => {};
  const mountViewer = (container) => {
    const next = createApplicationViewer({
      container,
      creditContainer,
      msaaSamples: profile?.msaaSamples,
      preserveDrawingBuffer: profile?.preserveDrawingBuffer,
      targetFrameRate: profile?.targetFrameRate,
    });
    removePinch();
    removePinch = installTrackpadPinchZoom(next);
    registerDataCredits(next, credits);
    return next;
  };
  globe.viewer = mountViewer('cesiumContainer');
  defer(() => {
    removePinch();
    removeTilesetPerf();
    uninstallRenderGovernor(globe.viewer);
    if (globe.viewer && !globe.viewer.isDestroyed()) globe.viewer.destroy();
  });
  configureCreditKeyboardAccess(document);
  defer(onLocaleChange(() => configureCreditKeyboardAccess(document)));
  loaderStatus.textContent =
    googleApiKey || googleTokens || cesiumToken
      ? t('Loading Google 3D Tiles...')
      : t('Loading the keyless globe...');
  const photoreal = await loadPhotorealisticTileset(Cesium, {
    googleApiKey,
    googleTokens,
    cesiumToken,
  });
  globe.tileset = photoreal.tileset;
  const tileset = globe.tileset;
  const viewer = globe.viewer;
  // A provider can finish after cancellation; retain ownership of its result.
  defer(() => {
    const current = globe.tileset;
    if (current && !current.isDestroyed()) {
      if (!globe.viewer.scene.primitives.remove(current)) current.destroy();
    }
  });
  signal.throwIfAborted();
  if (tileset) {
    removeTilesetPerf = applyTilesetPerformance(viewer, tileset, profile);
    viewer.scene.primitives.add(tileset);
    // NOTE: Cesium World Terrain intentionally disabled — conflicts with Google 3D Tiles at high zoom.
    // Google Photorealistic 3D Tiles provide their own terrain/elevation.
    viewer.scene.globe.show = false;
    console.info(`[Init] Google 3D Tiles loaded via ${photoreal.route}.`);
  } else {
    if (photoreal.errors.length) {
      const tileError = photoreal.errors.at(-1);
      console.warn(
        '[Init] Google 3D Tiles unavailable, using the keyless globe:',
        tileError,
      );
      const tileErrorDetail = describeError(tileError);
      loaderStatus.textContent = t(
        'Google 3D Tiles unavailable ({detail}). Loading the keyless globe...',
        {
          detail: tileErrorDetail,
        },
      );
    }
    viewer.scene.globe.show = true;
  }

  loaderStatus.textContent = t('Initializing systems...');

  const mapStackController = new MapController(viewer, {
    requestRender: governorRequestRender,
    ...mapOptions,
    googleTileset: tileset,
    cesiumToken,
    initialStack: tileset ? 'photoreal' : 'esri-imagery',
    // Task 5 (height-datum fix): rebroadcast stack changes as a window
    // CustomEvent so data layers (CCTV per-regime ground resolution) can
    // react without coupling MapStackController to layer modules. Fires on
    // 'switching'/'ready'/'error'; listeners derive the surface regime from
    // live scene state, so intermediate emissions are harmless.
    onChange: (state) => {
      window.dispatchEvent(
        new CustomEvent('gev:map-stack-changed', { detail: state }),
      );
    },
    onError: (message) => console.warn('[MapStack]', message),
  });
  defer(() => mapStackController.destroy());
  await mapStackController.setStack(tileset ? 'photoreal' : 'esri-imagery', {
    silent: true,
  });

  signal.throwIfAborted();

  /**
   * Build a viewer in the same container after the previous one is destroyed.
   * The photoreal tileset is a GPU resource, so it is loaded again.
   */
  function releaseViewerInput() {
    removePinch();
    removePinch = () => {};
    removeTilesetPerf();
    removeTilesetPerf = () => {};
  }

  async function createReplacementViewer({ container } = {}) {
    const previousTileset = globe.tileset;
    const host = container || globe.viewer?.container || 'cesiumContainer';
    const next = mountViewer(host);
    const replacement = await loadPhotorealisticTileset(Cesium, {
      googleApiKey,
      googleTokens,
      cesiumToken,
    });
    const nextTileset = replacement.tileset || null;
    removeTilesetPerf();
    removeTilesetPerf = () => {};
    if (nextTileset) {
      try {
        nextTileset.enableCollision = true;
      } catch {
        // Collision is optional on a tileset that has not finished loading.
      }
      next.scene.primitives.add(nextTileset);
      next.scene.globe.show = false;
      removeTilesetPerf = applyTilesetPerformance(next, nextTileset, profile);
    } else {
      next.scene.globe.show = true;
    }
    globe.tileset = nextTileset;
    globe.viewer = next;
    mapStackController.replaceSuppliedTileset(previousTileset, nextTileset);
    await mapStackController.retargetViewer(next);
    return next;
  }

  return {
    globe,
    get viewer() {
      return globe.viewer;
    },
    get tileset() {
      return globe.tileset;
    },
    mapStackController,
    operations,
    glRecover: glRecover === true,
    releaseViewerInput,
    createReplacementViewer,
  };
}
