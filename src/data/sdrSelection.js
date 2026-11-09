const listeners = new Set();

/** Tell the Radio panel that a receiver was picked on the globe. */
export function publishSdrReceiver(record, options = {}) {
  if (!record?.id) return;
  for (const listener of [...listeners]) {
    try {
      listener(record, options);
    } catch {
      /* one panel listener must not break the pick */
    }
  }
}

/** Subscribe to globe picks; returns the unsubscribe function. */
export function subscribeSdrReceiver(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
