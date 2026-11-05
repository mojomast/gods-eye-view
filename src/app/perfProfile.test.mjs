import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTilesetPerformance } from './perfProfile.js';
import { resolvePerformanceProfile } from '../runtimeConfig.js';

test('the embed profile caps the tileset cache and relaxes error while moving', () => {
  const profile = resolvePerformanceProfile({ perf: 'embed' });
  const listeners = { start: null, end: null };
  const tileset = {};
  const viewer = {
    camera: {
      moveStart: {
        addEventListener: (fn) => {
          listeners.start = fn;
        },
        removeEventListener() {
          listeners.start = null;
        },
      },
      moveEnd: {
        addEventListener: (fn) => {
          listeners.end = fn;
        },
        removeEventListener() {
          listeners.end = null;
        },
      },
    },
  };
  const release = applyTilesetPerformance(viewer, tileset, profile);
  assert.equal(tileset.cacheBytes, 384 * 1024 * 1024);
  assert.equal(tileset.maximumCacheOverflowBytes, 128 * 1024 * 1024);
  assert.equal(tileset.dynamicScreenSpaceError, true);
  assert.equal(tileset.foveatedScreenSpaceError, true);
  assert.equal(tileset.maximumScreenSpaceError, 16);
  listeners.start();
  assert.equal(tileset.maximumScreenSpaceError, 24);
  listeners.end();
  assert.equal(tileset.maximumScreenSpaceError, 16);
  release();
  assert.equal(listeners.start, null);
  assert.equal(tileset.maximumScreenSpaceError, 16);
});

test('no profile leaves a tileset untouched', () => {
  const tileset = { cacheBytes: 1536 * 1024 * 1024, maximumScreenSpaceError: 16 };
  const release = applyTilesetPerformance({}, tileset, null);
  assert.equal(tileset.cacheBytes, 1536 * 1024 * 1024);
  assert.equal(tileset.maximumScreenSpaceError, 16);
  release();
});
