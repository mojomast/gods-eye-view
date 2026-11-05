import { createStandaloneApplication } from './standalone/application.js';
import { describeError } from './standalone/errors.js';
import { t } from './i18n/index.js';
import { setEmbedVisibility } from './app/embed.js';
import { loadClientConfig } from './runtimeConfig.js';

// Build-time env is the fallback. config.json, GEV_RUNTIME_CONFIG and a
// gev:config postMessage override it (see docs/EMBEDDING.md). A visibility
// message queued before startup pauses work before layers begin polling.
const application = createStandaloneApplication({
  loadConfig: async () => {
    const config = await loadClientConfig({ env: import.meta.env });
    if (typeof config.hostVisible === 'boolean')
      setEmbedVisibility(config.hostVisible);
    const perf = config.profile
      ? config.perf === 'embed'
        ? 'embed'
        : 'custom'
      : null;
    if (globalThis.window) globalThis.window.__GEV_STARTUP_PERF__ = perf;
    return config;
  },
  allowQaRegistration: import.meta.env.DEV,
});

application.start().catch((error) => {
  console.error("God's Eye View initialization failed:", error);
  const loaderStatus = document.querySelector('#loading-screen .loader-status');
  loaderStatus.textContent = t('Error: {message}', {
    message: describeError(error),
  });
  loaderStatus.style.color = '#ff4444';
});

export { application };
