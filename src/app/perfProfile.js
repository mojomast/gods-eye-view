/**
 * Opt-in viewer and 3D-tile limits. Null from the resolver means the caller
 * keeps the existing defaults (60 fps, MSAA 4, the Google tileset cache).
 */

/**
 * Apply tileset cache and screen-space error settings. Returns a remover for
 * the moving-camera error bump.
 */
export function applyTilesetPerformance(viewer, tileset, profile) {
  if (!profile || !tileset) return () => {};
  if (Number.isFinite(profile.cacheBytes))
    tileset.cacheBytes = profile.cacheBytes;
  if (Number.isFinite(profile.maximumCacheOverflowBytes))
    tileset.maximumCacheOverflowBytes = profile.maximumCacheOverflowBytes;
  if (typeof profile.dynamicScreenSpaceError === 'boolean')
    tileset.dynamicScreenSpaceError = profile.dynamicScreenSpaceError;
  if (typeof profile.foveatedScreenSpaceError === 'boolean')
    tileset.foveatedScreenSpaceError = profile.foveatedScreenSpaceError;
  const settled = profile.maximumScreenSpaceError;
  const moving = profile.movingScreenSpaceError;
  if (Number.isFinite(settled)) tileset.maximumScreenSpaceError = settled;
  const camera = viewer?.camera;
  if (
    !camera?.moveStart ||
    !Number.isFinite(settled) ||
    !Number.isFinite(moving)
  )
    return () => {};
  const onStart = () => {
    tileset.maximumScreenSpaceError = moving;
  };
  const onEnd = () => {
    tileset.maximumScreenSpaceError = settled;
  };
  camera.moveStart.addEventListener(onStart);
  camera.moveEnd.addEventListener(onEnd);
  return () => {
    camera.moveStart.removeEventListener(onStart);
    camera.moveEnd.removeEventListener(onEnd);
    if (Number.isFinite(settled)) tileset.maximumScreenSpaceError = settled;
  };
}
