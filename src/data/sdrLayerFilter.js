const listeners = new Set();

let audioWaterfallOnly = true;

/** Whether the map layer should hide receivers without native audio + waterfall. */
export function getSdrAudioWaterfallOnly() {
  return audioWaterfallOnly;
}

/** Toggle the map filter; the layer and the card share this setting. */
export function setSdrAudioWaterfallOnly(value) {
  const next = Boolean(value);
  if (next === audioWaterfallOnly) return;
  audioWaterfallOnly = next;
  for (const listener of [...listeners]) {
    try {
      listener(audioWaterfallOnly);
    } catch {
      /* a view must not break the toggle */
    }
  }
}

/** Subscribe to filter changes; returns the unsubscribe function. */
export function subscribeSdrAudioWaterfallOnly(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
