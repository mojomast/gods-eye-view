// src/ui/radioPanelActions.test.mjs — the Radio panel's controls call
// RadioControls through the radio store, and a refused station tag puts the
// select back on the tag the directory keeps.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { useRadioStore } from './stores/radio.js';
import RadioPanel from './views/panels/RadioPanel.vue';

let publicSdrFetchStubDepth = 0;
let publicSdrFetchRoot = null;

function stubPublicSdrDirectory(t) {
  if (publicSdrFetchStubDepth === 0) publicSdrFetchRoot = globalThis.fetch;
  publicSdrFetchStubDepth += 1;
  const stub = async (input, init) => {
    const url = String(
      typeof input === 'string' ? input : (input?.url ?? input),
    );
    if (url.includes('/api/sdr/')) {
      return new Response(JSON.stringify({ receivers: [], stale: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return publicSdrFetchRoot.call(globalThis, input, init);
  };
  globalThis.fetch = stub;
  t.after(() => {
    publicSdrFetchStubDepth -= 1;
    if (publicSdrFetchStubDepth === 0) {
      globalThis.fetch = publicSdrFetchRoot;
      publicSdrFetchRoot = null;
    }
  });
}

function mount(t, { filter = (tag) => tag } = {}) {
  stubPublicSdrDirectory(t);
  document.body.replaceChildren();
  const pinia = createPinia();
  const calls = [];
  useRadioStore(pinia).connect(
    new Proxy(
      {},
      {
        get:
          (_, name) =>
          (...args) => {
            calls.push([name, ...args]);
            return name === 'setRadioFilter' ? filter(...args) : undefined;
          },
      },
    ),
  );
  const app = createApp(RadioPanel).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  t.after(() => app.unmount());
  return calls;
}
const $ = (id) => document.getElementById(id);
const pickTag = (tag) => {
  const select = $('radio-filter');
  select.disabled = false;
  const option = document.createElement('option');
  option.value = tag;
  select.append(option);
  select.value = tag;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return select.value;
};

test('the panel’s Enable, transport and volume call RadioControls', (t) => {
  const calls = mount(t);
  for (const id of [
    'radio-enable-btn',
    'radio-prev-btn',
    'radio-play-btn',
    'radio-next-btn',
    'radio-stop-btn',
  ]) {
    $(id).disabled = false;
    $(id).click();
  }
  $('radio-volume').disabled = false;
  $('radio-volume').value = '35';
  $('radio-volume').dispatchEvent(new Event('input', { bubbles: true }));
  assert.deepEqual(calls, [
    ['toggleRadio', 'panel'],
    ['cycleRadio', -1],
    ['toggleRadioPlayback'],
    ['cycleRadio', 1],
    ['stopRadio'],
    ['setRadioVolume', 35],
  ]);
});

test('an accepted station tag stays picked', (t) => {
  const calls = mount(t);
  assert.equal(pickTag('jazz'), 'jazz');
  assert.deepEqual(calls, [['setRadioFilter', 'jazz']]);
});

test('a refused station tag puts the select back on the kept tag', (t) => {
  mount(t, { filter: () => 'all' });
  assert.equal(pickTag('jazz'), 'all');
});
