import { createSdrProxyMiddleware } from './sdr/catalog.js';

export { createSdrProxyMiddleware, filterSdrReceivers } from './sdr/catalog.js';
export {
  buildSdrCatalog,
  mergeReceivers,
  normalizeAirspy,
  normalizeKiwi,
  normalizeReceiverBook,
  normalizeUberSdr,
} from './sdr/normalize.js';
export {
  parseAirspy,
  parseKiwiList,
  parseReceiverBook,
  parseUberSdr,
} from './sdr/sources.js';

/** Serve the merged public SDR directory at `/api/sdr`. */
export function sdrDirectoryProxy() {
  let middleware;
  const initialize = () => (middleware ||= createSdrProxyMiddleware());
  const install = (server) => {
    server.middlewares.use('/api/sdr', initialize());
  };
  return {
    name: 'sdr-directory',
    configureServer: install,
    configurePreviewServer: install,
  };
}
