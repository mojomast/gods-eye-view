<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useRadioStore } from '../../stores/radio.js';
import { usePanelChromeStore } from '../../stores/panelChrome.js';
import { subscribeSdrReceiver } from '../../../data/sdrSelection.js';
import SdrWaterfall from './SdrWaterfall.vue';
import {
  getSdrAudioWaterfallOnly,
  setSdrAudioWaterfallOnly,
} from '../../../data/sdrLayerFilter.js';
import {
  SDR_MODES,
  SDR_PRESETS,
  coversFrequency,
  createSdrAudio,
  defaultTune,
  receiverTuneUrl,
} from '../../sdrAudio.js';

const radio = useRadioStore();
const chrome = usePanelChromeStore();
const { view: radioView } = storeToRefs(radio);
const { panels } = storeToRefs(chrome);

const receivers = ref([]);
const loading = ref(true);
const loadError = ref(null);
const query = ref('');
const selectedId = ref('');
const volume = ref(80);
const state = ref(null);
const mapOn = ref(false);
const waterfallOpen = ref(false);
const audioWaterfallOnly = ref(getSdrAudioWaterfallOnly());
let unsubscribeSelection = null;

const audio = createSdrAudio({
  onState: (next) => {
    state.value = next;
    if (Number.isFinite(next.frequency) && next.frequency > 0)
      frequencyMHz.value = Number((next.frequency / 1e6).toFixed(4));
    if (next.mode) mode.value = next.mode;
  },
});

const frequencyMHz = ref(14.074);
const mode = ref('usb');

const selected = computed(
  () => receivers.value.find((receiver) => receiver.id === selectedId.value) ?? null,
);
const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase();
  const list = needle
    ? receivers.value.filter((receiver) =>
        [receiver.name, receiver.site, receiver.owner, receiver.platform]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(needle),
      )
    : receivers.value;
  return list.slice(0, 80);
});
const playing = computed(
  () => state.value?.status === 'playing' || state.value?.status === 'connecting',
);
const statusText = computed(() => {
  const current = state.value;
  if (!current) return 'No stream.';
  if (current.error) return current.error;
  if (current.status === 'error') return 'Stream failed.';
  if (current.status === 'connecting') return 'Connecting…';
  if (current.status === 'playing')
    return current.rssi == null
      ? 'Playing.'
      : `Playing · ${current.rssi.toFixed(0)} dBm`;
  return 'No stream.';
});
const openUrl = computed(() => {
  if (!selected.value) return '';
  const hz = Math.round(frequencyMHz.value * 1e6);
  return receiverTuneUrl(selected.value, hz, mode.value);
});
const coverageLabel = computed(() => {
  const range = selected.value?.bandsHz;
  if (!Array.isArray(range)) return 'coverage unknown';
  const low = range[0] < 1e6 ? `${Math.round(range[0] / 1e3)} kHz` : `${(range[0] / 1e6).toFixed(1)} MHz`;
  return `${low} – ${(range[1] / 1e6).toFixed(1)} MHz`;
});
const usersLabel = computed(() => {
  const receiver = selected.value;
  if (!receiver) return '';
  if (Number.isFinite(receiver.users) && Number.isFinite(receiver.usersMax))
    return `${receiver.users}/${receiver.usersMax} users`;
  if (receiver.online === false) return 'offline';
  return 'status unknown';
});

function platformLabel(platform) {
  return (
    {
      kiwi: 'KiwiSDR',
      openwebrx: 'OpenWebRX',
      websdr: 'WebSDR',
      spyserver: 'SpyServer',
      ubersdr: 'UberSDR',
    }[platform] ?? platform
  );
}

function selectReceiver() {
  const receiver = selected.value;
  if (!receiver) return;
  if (playing.value) audio.stop();
  const tune = defaultTune(receiver);
  frequencyMHz.value = Number((tune.hz / 1e6).toFixed(4));
  mode.value = tune.mode;
}

function applyPreset(preset) {
  frequencyMHz.value = Number((preset.hz / 1e6).toFixed(4));
  mode.value = preset.mode;
  if (playing.value) audio.tune(preset.hz, preset.mode);
}

function toggle() {
  if (playing.value) {
    audio.stop();
    return;
  }
  if (!selected.value) return;
  const hz = Math.round(frequencyMHz.value * 1e6);
  if (!coversFrequency(selected.value, hz)) {
    state.value = {
      status: 'error',
      error: `This receiver does not cover ${frequencyMHz.value.toFixed(3)} MHz.`,
    };
    return;
  }
  try {
    radio.act?.('stopRadio');
  } catch {
    /* the radio owner may not be connected yet */
  }
  try {
    audio.play(selected.value, { frequency: hz, mode: mode.value });
  } catch (error) {
    state.value = {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * A shareable receiver link: ?sdr=<id>&f=<MHz>&m=<mode>&wf=1&play=1.
 * Used by the globe and by "take me to this receiver" handoffs.
 */
function applyDeepLink() {
  let params;
  try {
    params = new URLSearchParams(window.location.search);
  } catch {
    return false;
  }
  const id = params.get('sdr');
  if (!id) return false;
  const receiver = receivers.value.find((entry) => entry.id === id);
  if (!receiver) return false;
  const fallback = defaultTune(receiver);
  const mhz = Number(params.get('f'));
  const requestedMode = String(params.get('m') || '').toLowerCase();
  frequencyMHz.value =
    Number.isFinite(mhz) && mhz > 0 ? mhz : fallback.hz / 1e6;
  mode.value = SDR_MODES.includes(requestedMode) ? requestedMode : fallback.mode;
  selectedId.value = receiver.id;
  const wantsWaterfall = params.get('wf') === '1';
  if (params.get('play') === '1' || wantsWaterfall) {
    // A deep link lands with the Radio panel collapsed, and the collapse
    // watcher stops any stream started in the same tick. Open the panel
    // first, then start the stream and the waterfall together.
    if (panels.value?.['radio-panel']?.collapsed === true)
      chrome.act('toggle', 'radio-panel');
    clearTimeout(deepLinkTimer);
    deepLinkTimer = setTimeout(() => {
      waterfallOpen.value = wantsWaterfall;
      try {
        audio.play(receiver, {
          frequency: Math.round(frequencyMHz.value * 1e6),
          mode: mode.value,
        });
      } catch {
        waterfallOpen.value = false;
        state.value = {
          status: 'error',
          error: 'Press Listen to start this receiver.',
        };
      }
    }, 80);
  }
  return true;
}

function onSelectChange() {
  waterfallOpen.value = false;
  selectReceiver();
}

function onWaterfallFilter(event) {
  const value = event.target.checked;
  audioWaterfallOnly.value = value;
  setSdrAudioWaterfallOnly(value);
}

function setVolume(event) {
  volume.value = Number(event.target.value);
  audio.setVolume(volume.value);
}

function toggleMap() {
  const manager = window.__godsEyeView?.dataManager;
  if (!manager?.toggle) return;
  const active =
    manager.isEffectivelyEnabled?.('sdr-receivers') === true;
  if (!active) manager.toggle('sdr-receivers', { origin: 'programmatic' });
  mapOn.value = !active;
}

watch(
  () => state.value?.status,
  (status) => {
    if (status === 'idle' || status === 'error') waterfallOpen.value = false;
  },
);

function onMapSelect(record, options = {}) {
  if (!record?.id) return;
  if (!receivers.value.some((receiver) => receiver.id === record.id))
    receivers.value = [record, ...receivers.value];
  query.value = '';
  selectedId.value = record.id;
  selectReceiver();
  if (options.play && record.playable) {
    // A globe click is an explicit listen gesture: start the stream and open
    // the waterfall at once instead of making the user press Listen.
    waterfallOpen.value = true;
    toggle();
  }
  if (panels.value?.['radio-panel']?.collapsed === true)
    chrome.act('toggle', 'radio-panel');
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(
    () =>
      document
        .getElementById('public-sdr-card')
        ?.scrollIntoView({ block: 'center' }),
    60,
  );
}

watch(
  () => radioView.value?.transport?.play?.active,
  (active) => {
    if (active && playing.value) audio.stop();
  },
);

watch(
  () => panels.value?.['radio-panel']?.collapsed,
  (collapsed) => {
    if (collapsed) audio.stop();
  },
);

let panelObserver = null;
let scrollTimer = null;
let directoryAbort = null;
let deepLinkTimer = null;

function onVisibility() {
  if (document.visibilityState === 'hidden') audio.stop();
}

function onMessage(event) {
  if (event?.data?.type === 'gev:visibility' && event.data.visible === false)
    audio.stop();
}

onMounted(async () => {
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('message', onMessage);
  unsubscribeSelection = subscribeSdrReceiver(onMapSelect);
  mapOn.value =
    window.__godsEyeView?.dataManager?.isEffectivelyEnabled?.(
      'sdr-receivers',
    ) === true;
  const radioPanel = document.getElementById('radio-panel');
  if (radioPanel) {
    panelObserver = new MutationObserver(() => {
      if (radioPanel.classList.contains('collapsed')) audio.stop();
    });
    panelObserver.observe(radioPanel, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
  directoryAbort?.abort();
  directoryAbort = new AbortController();
  try {
    const response = await fetch(
      '/api/sdr/receivers?playable=1&available=1&limit=500',
      { signal: directoryAbort.signal },
    );
    if (!response.ok) throw new Error(`Directory returned ${response.status}`);
    const body = await response.json();
    if (directoryAbort.signal.aborted) return;
    receivers.value = Array.isArray(body?.receivers) ? body.receivers : [];
    loadError.value = receivers.value.length ? null : 'No playable receivers.';
    if (!applyDeepLink()) {
      selectedId.value = receivers.value[0]?.id ?? '';
      selectReceiver();
    }
    if (body?.stale) loadError.value = 'Directory is stale; showing the last list.';
  } catch (error) {
    if (directoryAbort?.signal.aborted) return;
    loadError.value = error instanceof Error ? error.message : String(error);
  } finally {
    if (!directoryAbort?.signal.aborted) loading.value = false;
  }
});

onBeforeUnmount(() => {
  directoryAbort?.abort();
  directoryAbort = null;
  clearTimeout(scrollTimer);
  scrollTimer = null;
  clearTimeout(deepLinkTimer);
  deepLinkTimer = null;
  document.removeEventListener('visibilitychange', onVisibility);
  window.removeEventListener('message', onMessage);
  unsubscribeSelection?.();
  panelObserver?.disconnect();
  audio.dispose();
});
</script>

<template>
  <div
    id="public-sdr-card"
    class="public-sdr-card"
    role="group"
    aria-label="Public SDR receivers"
    translate="no"
  >
    <div class="public-sdr-heading">
      <strong>PUBLIC SDR</strong>
      <span :class="{ active: playing }">{{ state?.status?.toUpperCase() || 'IDLE' }}</span>
    </div>
    <p class="public-sdr-hint">
      Pick a public receiver, then Listen. Audio comes straight from the
      operator, who can see your IP.
    </p>
    <label class="public-sdr-filter">
      <input
        type="checkbox"
        :checked="audioWaterfallOnly"
        @change="onWaterfallFilter"
      />
      <span>MAP: AUDIO + WATERFALL ONLY</span>
    </label>
    <input
      v-model="query"
      class="gev-field"
      type="search"
      placeholder="Search name, place or platform"
      aria-label="Search public SDR receivers"
    />
    <select
      v-model="selectedId"
      class="gev-field public-sdr-list"
      size="6"
      aria-label="Public SDR receivers"
      @change="onSelectChange"
    >
      <option v-for="receiver in filtered" :key="receiver.id" :value="receiver.id">
        {{ receiver.name }} · {{ platformLabel(receiver.platform) }}
      </option>
    </select>
    <p v-if="loading" class="public-sdr-status">Loading directory…</p>
    <p v-else-if="!filtered.length" class="public-sdr-status">
      {{ loadError || 'No receivers match that search.' }}
    </p>
    <template v-if="selected">
      <div class="public-sdr-selected">
        <strong>{{ selected.name }}</strong>
        <span
          >{{ platformLabel(selected.platform) }} · {{ coverageLabel }} ·
          {{ usersLabel }}</span
        >
      </div>
      <div class="public-sdr-tune">
        <label>
          MHz
          <input
            v-model.number="frequencyMHz"
            class="gev-field"
            type="number"
            min="0"
            step="0.001"
            inputmode="decimal"
          />
        </label>
        <select v-model="mode" class="gev-field" aria-label="Demodulation mode">
          <option v-for="value in SDR_MODES" :key="value" :value="value">
            {{ value.toUpperCase() }}
          </option>
        </select>
      </div>
      <div class="public-sdr-presets" role="group" aria-label="Tuning presets">
        <button
          v-for="preset in SDR_PRESETS"
          :key="preset.label"
          type="button"
          @click="applyPreset(preset)"
        >
          {{ preset.label }}
        </button>
      </div>
      <div class="public-sdr-actions">
        <button id="public-sdr-listen" type="button" @click="toggle">
          {{ playing ? 'STOP' : 'LISTEN' }}
        </button>
        <button
          id="public-sdr-waterfall"
          type="button"
          :disabled="!state?.config"
          @click="waterfallOpen = true"
        >
          WATERFALL
        </button>
        <button id="public-sdr-map" type="button" @click="toggleMap">
          {{ mapOn ? 'MAP ON' : 'MAP' }}
        </button>
        <a
          class="public-sdr-open"
          :href="openUrl"
          target="_blank"
          rel="noopener noreferrer"
          >OPEN ↗</a
        >
        <label class="public-sdr-volume">
          VOL
          <input
            type="range"
            min="0"
            max="100"
            :value="volume"
            aria-label="Public SDR volume"
            @input="setVolume"
          />
        </label>
      </div>
    </template>
    <p
      id="public-sdr-status"
      class="public-sdr-status"
      :class="{ error: state?.status === 'error' }"
      role="status"
      aria-live="polite"
    >
      {{ statusText }}
    </p>
    <SdrWaterfall
      v-if="waterfallOpen"
      :audio="audio"
      :receiver="selected"
      @close="waterfallOpen = false"
    />
    <p class="public-sdr-attribution">
      Data: <a href="https://www.receiverbook.de/" target="_blank" rel="noopener noreferrer">ReceiverBook</a>
      · <a href="http://kiwisdr.com/public/" target="_blank" rel="noopener noreferrer">KiwiSDR</a>
      · <a href="https://airspy.com/directory/" target="_blank" rel="noopener noreferrer">Airspy</a>
      · <a href="https://instances.ubersdr.org/" target="_blank" rel="noopener noreferrer">UberSDR</a>.
      Kiwi and OpenWebRX play here; the rest open at the operator.
    </p>
  </div>
</template>

<style scoped>
.public-sdr-card {
  display: grid;
  gap: 6px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--ui-border, #2a2f35);
  font-size: 12px;
}
.public-sdr-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  letter-spacing: 0.08em;
}
.public-sdr-heading strong {
  font-size: 11px;
}
.public-sdr-heading span {
  color: var(--ui-text-tertiary, #8a949e);
  font-size: 10px;
}
.public-sdr-heading span.active {
  color: #54d17a;
}
.public-sdr-hint,
.public-sdr-status,
.public-sdr-attribution {
  margin: 0;
  color: var(--ui-text-tertiary, #8a949e);
  font-size: 11px;
  line-height: 1.35;
}
.public-sdr-status.error {
  color: #ff8b8b;
}
.public-sdr-filter {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--ui-text-tertiary, #8a949e);
  font-size: 9px;
  letter-spacing: 0.08em;
  cursor: pointer;
  user-select: none;
}
.public-sdr-filter input {
  width: 12px;
  height: 12px;
  margin: 0;
  accent-color: var(--ui-accent, #5ac8eb);
}
.public-sdr-list {
  min-height: 96px;
}
.public-sdr-selected {
  display: grid;
  gap: 2px;
}
.public-sdr-selected span {
  color: var(--ui-text-secondary, #b4bcc4);
  font-size: 11px;
}
.public-sdr-tune,
.public-sdr-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.public-sdr-tune label {
  display: flex;
  align-items: center;
  gap: 4px;
}
.public-sdr-tune input {
  width: 84px;
}
.public-sdr-presets {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.public-sdr-presets button,
.public-sdr-actions button,
.public-sdr-open {
  padding: 2px 6px;
  border: 1px solid var(--ui-border, #3a4149);
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 10px;
  text-decoration: none;
  cursor: pointer;
}
.public-sdr-actions button {
  font-weight: 600;
}
.public-sdr-open {
  margin-left: auto;
}
.public-sdr-volume {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 10px;
}
.public-sdr-volume input {
  width: 64px;
}
.public-sdr-attribution a {
  color: inherit;
}
</style>
