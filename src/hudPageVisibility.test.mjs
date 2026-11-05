// The HUD's periodic timers stop while the page is hidden, including an inline
// panel. The host resumes them with a visibility message.
//
// hud.js imports `mgrs`, which Node's ESM loader cannot read named exports
// from, so a module hook swaps it for a stub before the import (the same
// setup as hudAltitudeDatum.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hudReadouts } from './testSupport/hudReadouts.mjs';
import { registerHooks } from 'node:module';

const MGRS_STUB_URL = 'gev-test-stub:mgrs';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs') return { url: MGRS_STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === MGRS_STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source: 'export function forward() { return "10SEG55776339"; }\nexport default { forward };\n',
      };
    }
    return next(url, context);
  },
});

const { IntelHUD } = await import('./hud.js');
const { setEmbedVisibility } = await import('./app/embed.js');

function installHiddenPage() {
  const { elements, publish } = hudReadouts();
  const previousDocument = globalThis.document;
  globalThis.document = {
    hidden: true,
    visibilityState: 'hidden',
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const viewer = {
    camera: {
      pitch: -Math.PI / 2,
      positionCartographic: { latitude: 0.7, longitude: -1.2, height: 500 },
      computeViewRectangle: () => undefined,
      moveStart: { addEventListener() {}, removeEventListener() {} },
      moveEnd: { addEventListener() {}, removeEventListener() {} },
    },
  };
  return {
    alt: () => elements.get('hud-alt').textContent,
    viewer,
    publish,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    },
  };
}

test('the HUD readout pauses while hidden, including inline, until the host shows it', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const page = installHiddenPage();
  let hud;
  try {
    hud = new IntelHUD(page.viewer, { publish: page.publish });
    hud._visible = true;

    t.mock.timers.tick(250);
    assert.equal(
      page.alt(),
      'ALT: --m   SUN: --° EL',
      'a hidden page does not run the telemetry timer',
    );

    globalThis.GEV_EMBED_INLINE = true;
    t.mock.timers.tick(250);
    assert.equal(
      page.alt(),
      'ALT: --m   SUN: --° EL',
      'an inline panel pauses while its document is hidden',
    );

    setEmbedVisibility(true);
    t.mock.timers.tick(250);
    assert.match(
      page.alt(),
      /^ALT: 500m/,
      'the host can resume the readout while the document stays hidden',
    );
  } finally {
    setEmbedVisibility(null);
    delete globalThis.GEV_EMBED_INLINE;
    hud?.destroy();
    page.restore();
  }
});
