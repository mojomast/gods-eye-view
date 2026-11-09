/** Fetch the playable public SDR receivers for the globe layer. */
export function createSdrReceiversSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  endpoint = '/api/sdr/receivers',
} = {}) {
  return {
    async getReceivers({ signal, audioWaterfallOnly = true } = {}) {
      signal?.throwIfAborted();
      const query = audioWaterfallOnly
        ? '?playable=1&waterfall=1&limit=2000'
        : '?limit=2000';
      const response = await fetchImpl(`${endpoint}${query}`, { signal });
      if (!response.ok)
        throw new Error(`SDR directory returned ${response.status}`);
      const body = await response.json();
      signal?.throwIfAborted();
      if (!Array.isArray(body?.receivers))
        throw new Error('SDR directory returned no receivers');
      return body.receivers;
    },
  };
}
