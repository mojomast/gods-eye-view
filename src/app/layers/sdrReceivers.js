import { createSdrReceiversLayer } from '../../layers/sdrReceivers/index.js';
import { createSdrReceiversSource } from '../../layers/sdrReceivers/source.js';

/** Construct the public SDR receiver layer with its directory source. */
export function createApplicationSdrReceivers() {
  return createSdrReceiversLayer({ source: createSdrReceiversSource() });
}
