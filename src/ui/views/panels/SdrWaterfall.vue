<script setup>
import {
  computed,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
} from 'vue';

import { SDR_MODES } from '../../sdrAudio.js';

const props = defineProps({
  audio: { type: Object, required: true },
  receiver: { type: Object, default: null },
});
const emit = defineEmits(['close']);

const SPECTRUM_H = 96;
const WF_W = 1024;
const WF_H = 360;
const MIN_W = 500;
const MIN_H = 360;
const GEOM_KEY = 'gev-sdr-waterfall-window-v2';

const panel = ref(null);
const plotBody = ref(null);
const spectrumCanvas = ref(null);
const waterfallCanvas = ref(null);

const config = ref(props.audio.getState()?.config ?? null);
const tuned = ref(props.audio.getState());
const hover = ref(null);
const dragDx = ref(0);
const panning = ref(false);
const frameCount = ref(0);
const fps = ref(0);
const paused = ref(false);
const averaging = ref(true);
const detailsOpen = ref(false);
const autoRangeOn = ref(true);
const floorDb = ref(-110);
const ceilingDb = ref(-20);
const contrast = ref(100);
const stepHz = ref(1000);
const note = ref('');

const spectrumBins = shallowRef(null);
const rows = [];
let spectrumCtx = null;
let waterfallCtx = null;
let waterfallImage = null;
let unsubState = null;
let unsubWaterfall = null;
let gesture = null;
let windowDrag = null;
let resizeDrag = null;
let fpsStart = 0;
let fpsFrames = 0;
const noiseDb = ref(0);
let resizeListener = null;

const pos = reactive({
  left: 0,
  top: 0,
  width: 520,
  height: 380,
});

const STOPS = [
  [0, 0, 8],
  [6, 10, 42],
  [10, 36, 104],
  [0, 80, 168],
  [0, 138, 188],
  [0, 186, 170],
  [80, 214, 120],
  [190, 226, 60],
  [252, 178, 32],
  [255, 92, 24],
  [255, 238, 206],
];
const PALETTE = new Uint8ClampedArray(256 * 4);
for (let i = 0; i < 256; i += 1) {
  const at = (i / 255) * (STOPS.length - 1);
  const a = Math.min(STOPS.length - 1, Math.floor(at));
  const b = Math.min(STOPS.length - 1, a + 1);
  const t = at - a;
  for (let c = 0; c < 3; c += 1)
    PALETTE[i * 4 + c] = Math.round(
      STOPS[a][c] + (STOPS[b][c] - STOPS[a][c]) * t,
    );
  PALETTE[i * 4 + 3] = 255;
}

function clamp(value, low, high) {
  return Math.min(high, Math.max(low, value));
}

function toDb(value) {
  const db = Number(value);
  if (config.value?.type === 'kiwisdr') return db > 127 ? db - 256 : db;
  return db;
}

/** Follow the receiver's noise floor; fixed windows wash out quiet Kiwis. */
function autoRange(bins) {
  const values = [];
  for (let i = 2; i < bins.length - 2; i += 1) values.push(toDb(bins[i]));
  values.sort((a, b) => a - b);
  const at = (fraction) =>
    values[Math.min(values.length - 1, Math.floor(values.length * fraction))];
  const cfgMin = Number(config.value?.waterfallMin);
  const cfgMax = Number(config.value?.waterfallMax);
  const hardFloor = Number.isFinite(cfgMin) ? cfgMin : -130;
  const hardCeiling = Number.isFinite(cfgMax) ? cfgMax : 0;
  let floor = Math.max(
    hardFloor,
    Math.min(at(0.05) - 2, hardCeiling - 24),
  );
  let ceiling = Math.min(
    hardCeiling,
    Math.max(at(0.995) + 8, values[values.length - 1] - 2, floor + 24),
  );
  if (!(ceiling > floor)) {
    floor = hardFloor;
    ceiling = hardCeiling;
  }
  return { floor, ceiling };
}

const spanKHz = computed(
  () =>
    Number(config.value?.viewBandwidth) ||
    Number(config.value?.bandwidth) ||
    0,
);
const startKHz = computed(
  () => Number(config.value?.viewCenterFreq || 0) - spanKHz.value / 2,
);
const tunedKHz = computed(() => Number(tuned.value?.frequency || 0) / 1000);
const tunedPct = computed(() => {
  if (!(spanKHz.value > 0)) return null;
  return ((tunedKHz.value - startKHz.value) / spanKHz.value) * 100;
});
const tunedInView = computed(
  () => tunedPct.value !== null && tunedPct.value >= 0 && tunedPct.value <= 100,
);
const passband = computed(() => {
  if (!(spanKHz.value > 0)) return null;
  const low = Number(config.value?.lowCut);
  const high = Number(config.value?.highCut);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
  const lowPct =
    ((tunedKHz.value + low / 1000 - startKHz.value) / spanKHz.value) * 100;
  const highPct =
    ((tunedKHz.value + high / 1000 - startKHz.value) / spanKHz.value) * 100;
  const left = clamp(Math.min(lowPct, highPct), 0, 100);
  const right = clamp(Math.max(lowPct, highPct), 0, 100);
  if (!(right > left)) return null;
  return { left, width: right - left };
});
const labels = computed(() => {
  if (!(spanKHz.value > 0)) return [];
  const digits = spanKHz.value < 1000 ? 4 : 3;
  return [0, 0.25, 0.5, 0.75, 1].map((f) =>
    ((startKHz.value + f * spanKHz.value) / 1000).toFixed(digits),
  );
});
const spanLabel = computed(() => {
  const span = spanKHz.value;
  if (!(span > 0)) return '—';
  return span >= 1000
    ? `${(span / 1000).toFixed(3)} MHz`
    : `${span.toFixed(1)} kHz`;
});
const filterLabel = computed(() => {
  const low = Number(config.value?.lowCut);
  const high = Number(config.value?.highCut);
  if (!Number.isFinite(low) || !Number.isFinite(high)) return '—';
  const a = Math.abs(low / 1000);
  const b = Math.abs(high / 1000);
  return `${Math.min(a, b).toFixed(2)}–${Math.max(a, b).toFixed(2)} kHz`;
});
const hoverMHz = computed(() => {
  if (hover.value === null || !(spanKHz.value > 0)) return null;
  return ((startKHz.value + hover.value * spanKHz.value) / 1000).toFixed(4);
});
const hoverDb = computed(() => {
  const bins = spectrumBins.value;
  if (!bins || hover.value === null) return null;
  const index = clamp(
    Math.round(hover.value * (bins.length - 1)),
    0,
    bins.length - 1,
  );
  return Math.round(bins[index]);
});
const hoverText = computed(() => {
  if (hoverMHz.value === null) return '';
  return `${hoverMHz.value} MHz${hoverDb.value === null ? '' : ` · ${hoverDb.value} dB`}`;
});
const peak = computed(() => {
  const bins = spectrumBins.value;
  if (!bins?.length) return null;
  let index = 0;
  let value = -Infinity;
  for (let i = 2; i < bins.length - 2; i += 1) {
    if (bins[i] > value) {
      value = bins[i];
      index = i;
    }
  }
  const fraction = index / (bins.length - 1);
  return {
    db: value,
    mhz: (startKHz.value + fraction * spanKHz.value) / 1000,
    fraction,
  };
});
const snrDb = computed(() =>
  peak.value ? Math.max(0, peak.value.db - noiseDb.value) : null,
);
const sMeter = computed(() => {
  const rssi = Number(tuned.value?.rssi);
  if (!Number.isFinite(rssi)) return '—';
  const units = Math.round((rssi + 121) / 6) + 1;
  if (units >= 9) return `S9+${Math.max(0, Math.round(rssi + 73))}`;
  return `S${clamp(units, 1, 9)}`;
});
const statusText = computed(() => {
  if (!config.value) return tuned.value?.status === 'connecting' ? 'CONNECTING' : 'NO STREAM';
  if (tuned.value?.status === 'error') return 'STREAM ERROR';
  if (paused.value) return 'PAUSED';
  if (!frameCount.value) return 'WAITING FOR SPECTRUM';
  return 'LIVE';
});
const statusClass = computed(() => ({
  live: tuned.value?.status === 'playing' && !paused.value && frameCount.value > 0,
  warning: tuned.value?.status === 'connecting' || paused.value,
  error: tuned.value?.status === 'error' || !config.value,
}));
const usersLabel = computed(() => {
  const receiver = props.receiver;
  if (!receiver) return '—';
  if (Number.isFinite(receiver.users) && Number.isFinite(receiver.usersMax))
    return `${receiver.users}/${receiver.usersMax}`;
  return receiver.online === false ? 'offline' : 'unknown';
});
const coverageLabel = computed(() => {
  const range = props.receiver?.bandsHz;
  if (!Array.isArray(range)) return 'unknown';
  return `${(range[0] / 1e6).toFixed(2)}–${(range[1] / 1e6).toFixed(1)} MHz`;
});
const operatorUrl = computed(() => {
  const url = String(props.receiver?.url || '');
  return /^https?:\/\//.test(url) ? url : '';
});
const frequencyLabel = computed(() =>
  ((tuned.value?.frequency || 0) / 1e6).toFixed(6),
);
const gainDb = computed(() => ({
  floor: Math.round(floorDb.value),
  ceiling: Math.round(ceilingDb.value),
}));
const windowStyle = computed(() => ({
  left: `${pos.left}px`,
  top: `${pos.top}px`,
  width: `${pos.width}px`,
  height: `${pos.height}px`,
}));

function clampGeometry() {
  const maxW = Math.max(320, window.innerWidth - 16);
  const maxH = Math.max(260, window.innerHeight - 16);
  pos.width = clamp(pos.width, Math.min(MIN_W, maxW), maxW);
  pos.height = clamp(pos.height, Math.min(MIN_H, maxH), maxH);
  pos.left = clamp(pos.left, 0, Math.max(0, window.innerWidth - pos.width));
  pos.top = clamp(pos.top, 0, Math.max(0, window.innerHeight - pos.height));
}

function defaultGeometry() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = clamp(Math.round(vw * 0.72), Math.min(MIN_W, vw - 16), vw - 16);
  const height = clamp(Math.round(vh * 0.88), Math.min(MIN_H, vh - 16), vh - 16);
  pos.width = width;
  pos.height = height;
  pos.left = Math.max(8, vw - width - 16);
  pos.top = Math.max(8, Math.min(64, vh - height - 8));
}

function loadGeometry() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(GEOM_KEY) || 'null');
    if (
      saved &&
      Number.isFinite(saved.left) &&
      Number.isFinite(saved.top) &&
      Number.isFinite(saved.width) &&
      Number.isFinite(saved.height)
    ) {
      Object.assign(pos, saved);
      clampGeometry();
      return;
    }
  } catch {
    /* sessionStorage can be unavailable */
  }
  defaultGeometry();
}

function saveGeometry() {
  try {
    sessionStorage.setItem(GEOM_KEY, JSON.stringify({ ...pos }));
  } catch {
    /* ignore */
  }
}

function beginWindowDrag(event) {
  if (event.button !== 0) return;
  if (event.target.closest('button,select,input,label,a')) return;
  event.preventDefault();
  windowDrag = {
    x: event.clientX,
    y: event.clientY,
    left: pos.left,
    top: pos.top,
  };
  window.addEventListener('pointermove', moveWindow);
  window.addEventListener('pointerup', endWindowDrag, { once: true });
}

function moveWindow(event) {
  if (!windowDrag) return;
  pos.left = clamp(
    windowDrag.left + event.clientX - windowDrag.x,
    0,
    Math.max(0, window.innerWidth - pos.width),
  );
  pos.top = clamp(
    windowDrag.top + event.clientY - windowDrag.y,
    0,
    Math.max(0, window.innerHeight - pos.height),
  );
}

function endWindowDrag() {
  windowDrag = null;
  window.removeEventListener('pointermove', moveWindow);
  saveGeometry();
}

function beginResize(event) {
  if (event.button !== 0) return;
  event.preventDefault();
  resizeDrag = {
    x: event.clientX,
    y: event.clientY,
    width: pos.width,
    height: pos.height,
  };
  window.addEventListener('pointermove', moveResize);
  window.addEventListener('pointerup', endResize, { once: true });
}

function moveResize(event) {
  if (!resizeDrag) return;
  const maxW = Math.max(320, window.innerWidth - pos.left - 8);
  const maxH = Math.max(260, window.innerHeight - pos.top - 8);
  pos.width = clamp(
    resizeDrag.width + event.clientX - resizeDrag.x,
    Math.min(MIN_W, maxW),
    maxW,
  );
  pos.height = clamp(
    resizeDrag.height + event.clientY - resizeDrag.y,
    Math.min(MIN_H, maxH),
    maxH,
  );
}

function endResize() {
  resizeDrag = null;
  window.removeEventListener('pointermove', moveResize);
  saveGeometry();
}

function toggleMaximize() {
  if (pos.width >= window.innerWidth - 24 && pos.height >= window.innerHeight - 24) {
    defaultGeometry();
  } else {
    pos.left = 8;
    pos.top = 8;
    pos.width = window.innerWidth - 16;
    pos.height = window.innerHeight - 16;
  }
  saveGeometry();
}

function clearRows() {
  rows.length = 0;
  frameCount.value = 0;
  spectrumBins.value = null;
  noiseDb.value = 0;
  renderWaterfall();
  drawSpectrum();
}

function applyConfig(next) {
  if (!next) {
    config.value = null;
    clearRows();
    return;
  }
  const changed =
    !config.value ||
    next.viewCenterFreq !== config.value.viewCenterFreq ||
    next.viewBandwidth !== config.value.viewBandwidth ||
    next.zoom !== config.value.zoom;
  config.value = next;
  if (changed) clearRows();
}

function addFrame(frame) {
  if (!frame?.bins?.length) return;
  const bins = frame.bins;
  if (autoRangeOn.value) {
    const range = autoRange(bins);
    floorDb.value = range.floor;
    ceilingDb.value = range.ceiling;
  }
  const dbBins = new Float32Array(bins.length);
  const values = [];
  for (let i = 0; i < bins.length; i += 1) {
    const db = toDb(bins[i]);
    dbBins[i] = db;
    if (i > 1 && i < bins.length - 2) values.push(db);
  }
  values.sort((a, b) => a - b);
  noiseDb.value = values.length
    ? values[Math.floor(values.length * 0.2)]
    : floorDb.value;
  if (averaging.value && spectrumBins.value?.length === dbBins.length) {
    const smooth = new Float32Array(dbBins.length);
    for (let i = 0; i < dbBins.length; i += 1)
      smooth[i] = spectrumBins.value[i] * 0.68 + dbBins[i] * 0.32;
    spectrumBins.value = smooth;
  } else {
    spectrumBins.value = dbBins;
  }
  const row = new Float32Array(WF_W);
  for (let x = 0; x < WF_W; x += 1) {
    const index = Math.min(
      bins.length - 1,
      Math.round((x * (bins.length - 1)) / (WF_W - 1)),
    );
    row[x] = dbBins[index];
  }
  rows.unshift(row);
  if (rows.length > WF_H) rows.pop();
  paintWaterfallRow(row);
  frameCount.value += 1;
  fpsFrames += 1;
  const now = performance.now();
  if (!fpsStart) fpsStart = now;
  if (now - fpsStart >= 1000) {
    fps.value = Math.round((fpsFrames * 1000) / (now - fpsStart));
    fpsStart = now;
    fpsFrames = 0;
  }
  drawSpectrum();
}

function colorFor(db) {
  const floor = floorDb.value;
  const ceiling = ceilingDb.value;
  let t = (db - floor) / Math.max(1, ceiling - floor);
  t = clamp(t, 0, 1);
  t = Math.pow(t, 100 / Math.max(40, contrast.value));
  return Math.round(t * 255) * 4;
}

function paintWaterfallRow(row) {
  if (!waterfallCtx || !waterfallImage) return;
  const data = waterfallImage.data;
  // Slide the history down one row, then colour only the new top row.
  data.copyWithin(WF_W * 4, 0, (WF_H - 1) * WF_W * 4);
  for (let x = 0; x < WF_W; x += 1) {
    const color = colorFor(row[x]);
    data[x * 4] = PALETTE[color];
    data[x * 4 + 1] = PALETTE[color + 1];
    data[x * 4 + 2] = PALETTE[color + 2];
    data[x * 4 + 3] = 255;
  }
  waterfallCtx.putImageData(waterfallImage, 0, 0);
}

function renderWaterfall() {
  if (!waterfallCtx || !waterfallImage) return;
  const data = waterfallImage.data;
  data.fill(0);
  for (let y = 0; y < rows.length && y < WF_H; y += 1) {
    const row = rows[y];
    const base = y * WF_W * 4;
    for (let x = 0; x < WF_W; x += 1) {
      const color = colorFor(row[x]);
      data[base + x * 4] = PALETTE[color];
      data[base + x * 4 + 1] = PALETTE[color + 1];
      data[base + x * 4 + 2] = PALETTE[color + 2];
      data[base + x * 4 + 3] = 255;
    }
  }
  waterfallCtx.putImageData(waterfallImage, 0, 0);
}

function drawSpectrum() {
  if (!spectrumCtx) return;
  const w = WF_W;
  const h = SPECTRUM_H;
  const ctx = spectrumCtx;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#03060f';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(96, 164, 202, 0.16)';
  ctx.lineWidth = 1;
  ctx.font = '10px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(142, 180, 202, 0.72)';
  for (let i = 0; i <= 4; i += 1) {
    const y = Math.round((i / 4) * (h - 1)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  for (let i = 0; i <= 4; i += 1) {
    const x = Math.round((i / 4) * (w - 1)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  const bins = spectrumBins.value;
  if (!bins?.length) {
    ctx.fillStyle = 'rgba(142, 180, 202, 0.65)';
    ctx.textAlign = 'center';
    ctx.fillText('WAITING FOR SPECTRUM', w / 2, h / 2 - 4);
    return;
  }
  const floor = floorDb.value;
  const span = Math.max(1, ceilingDb.value - floor);
  const yFor = (db) =>
    clamp(h - 2 - ((db - floor) / span) * (h - 5), 1, h - 1);
  const gradient = ctx.createLinearGradient(0, 0, 0, h);
  gradient.addColorStop(0, 'rgba(90, 220, 255, 0.38)');
  gradient.addColorStop(1, 'rgba(90, 220, 255, 0.02)');
  ctx.beginPath();
  ctx.moveTo(0, h);
  for (let x = 0; x < w; x += 1) {
    const index = Math.min(
      bins.length - 1,
      Math.round((x * (bins.length - 1)) / (w - 1)),
    );
    ctx.lineTo(x, yFor(bins[index]));
  }
  ctx.lineTo(w, h);
  ctx.closePath();
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.beginPath();
  for (let x = 0; x < w; x += 1) {
    const index = Math.min(
      bins.length - 1,
      Math.round((x * (bins.length - 1)) / (w - 1)),
    );
    const y = yFor(bins[index]);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = 'rgba(120, 232, 255, 0.92)';
  ctx.lineWidth = 1;
  ctx.stroke();
  const peakValue = peak.value;
  if (peakValue) {
    const x = peakValue.fraction * (w - 1);
    const y = yFor(peakValue.db);
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fillStyle = '#fff2b0';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 242, 176, 0.5)';
    ctx.beginPath();
    ctx.moveTo(x, y + 4);
    ctx.lineTo(x, h);
    ctx.stroke();
    ctx.fillStyle = '#fff2b0';
    ctx.textAlign = x > w * 0.75 ? 'right' : 'left';
    ctx.fillText(
      `${peakValue.db.toFixed(0)} dB · ${peakValue.mhz.toFixed(3)}`,
      clamp(x + (x > w * 0.75 ? -4 : 4), 4, w - 4),
      clamp(y - 5, 11, h - 4),
    );
  }
}

function onState(next) {
  tuned.value = next;
  applyConfig(next?.config);
}

function onWaterfall(frame, cfg) {
  if (cfg) applyConfig(cfg);
  if (!paused.value) addFrame(frame);
}

function fractionAt(event) {
  const rect = plotBody.value?.getBoundingClientRect();
  if (!rect?.width) return null;
  return clamp((event.clientX - rect.left) / rect.width, 0, 1);
}

function onPointerMove(event) {
  hover.value = fractionAt(event);
  if (gesture) {
    const dx = event.clientX - gesture.x;
    if (Math.abs(dx) > 3) {
      gesture.moved = true;
      panning.value = true;
    }
    dragDx.value = gesture.moved ? dx : 0;
  }
}

function onPointerDown(event) {
  if (event.button !== 0 || !config.value) return;
  event.preventDefault();
  const fraction = fractionAt(event);
  if (fraction === null) return;
  gesture = {
    x: event.clientX,
    fraction,
    center: Number(config.value.viewCenterFreq),
    width: plotBody.value.getBoundingClientRect().width,
    span: spanKHz.value,
    moved: false,
  };
  plotBody.value?.setPointerCapture?.(event.pointerId);
}

function onPointerUp(event) {
  if (!gesture) return;
  const g = gesture;
  gesture = null;
  dragDx.value = 0;
  if (!(spanKHz.value > 0)) return;
  if (g.moved) {
    const dx = event.clientX - g.x;
    const nextCenter = g.center - (dx / g.width) * g.span;
    props.audio.setWaterfallView(config.value?.zoom ?? 0, nextCenter);
    panning.value = false;
    return;
  }
  const fraction = fractionAt(event);
  if (fraction === null) return;
  const hz = Math.round((startKHz.value + fraction * spanKHz.value) * 1000);
  props.audio.tune(hz, tuned.value?.mode);
}

function onPointerLeave() {
  if (!gesture) hover.value = null;
}

function panLabel() {
  if (!gesture?.moved || !gesture.width) return '';
  return `PAN ${((dragDx.value / gesture.width) * gesture.span).toFixed(1)} kHz`;
}

function onWheel(event) {
  if (!config.value || !(spanKHz.value > 0)) return;
  const current = Number(config.value.zoom ?? 0);
  const next = clamp(current + (event.deltaY < 0 ? 1 : -1), 0, 14);
  if (next === current) return;
  const fraction = fractionAt(event) ?? 0.5;
  const cursor = startKHz.value + fraction * spanKHz.value;
  const nextSpan = spanKHz.value / 2 ** (next - current);
  const nextStart = cursor - fraction * nextSpan;
  props.audio.setWaterfallView(next, nextStart + nextSpan / 2);
}

function tuneBy(delta) {
  const hz = Math.round(tunedKHz.value * 1000 + delta);
  if (Number.isFinite(hz)) props.audio.tune(hz, tuned.value?.mode);
}

function onModeChange(event) {
  props.audio.tune(tuned.value?.frequency, event.target.value);
}

function onFrequencyInput(event) {
  const mhz = Number(event.target.value);
  if (!Number.isFinite(mhz) || mhz <= 0) return;
  props.audio.tune(Math.round(mhz * 1e6), tuned.value?.mode);
}

function zoomBy(delta) {
  const current = Number(config.value?.zoom ?? 0);
  props.audio.setZoom(clamp(current + delta, 0, 14));
}

function center() {
  props.audio.recenterWaterfall();
}

function fullBand() {
  props.audio.setZoom(0);
}

function panBy(direction) {
  if (!config.value || !(spanKHz.value > 0)) return;
  const delta = (spanKHz.value / 2) * 0.5 * direction;
  props.audio.setWaterfallView(
    config.value.zoom ?? 0,
    Number(config.value.viewCenterFreq) + delta,
  );
}

function togglePause() {
  paused.value = !paused.value;
  if (!paused.value) drawSpectrum();
}

function onAutoRange(event) {
  autoRangeOn.value = event.target.checked;
}

function onContrast() {
  renderWaterfall();
}

function snapshot() {
  try {
    const out = document.createElement('canvas');
    out.width = WF_W;
    out.height = SPECTRUM_H + WF_H;
    const ctx = out.getContext('2d');
    ctx.drawImage(spectrumCanvas.value, 0, 0);
    ctx.drawImage(waterfallCanvas.value, 0, SPECTRUM_H);
    const link = document.createElement('a');
    link.download = `sdr-${(props.receiver?.name || 'receiver')
      .replace(/[^a-z0-9]+/gi, '-')
      .slice(0, 40)}-${frequencyLabel.value}.png`;
    link.href = out.toDataURL('image/png');
    link.click();
    note.value = 'Snapshot saved.';
  } catch (error) {
    note.value = error instanceof Error ? error.message : 'Snapshot failed.';
  }
}

function onKey(event) {
  if (event.key === 'Escape') {
    emit('close');
    return;
  }
  if (event.target?.matches?.('input, select, textarea, button')) return;
  if (event.code === 'Space') {
    event.preventDefault();
    togglePause();
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault();
    zoomBy(1);
  } else if (event.key === '-') {
    event.preventDefault();
    zoomBy(-1);
  } else if (event.key.toLowerCase() === 'c') {
    center();
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault();
    tuneBy(-stepHz.value);
  } else if (event.key === 'ArrowRight') {
    event.preventDefault();
    tuneBy(stepHz.value);
  }
}

onMounted(() => {
  const snapshotState = props.audio.getState();
  tuned.value = snapshotState;
  config.value = snapshotState?.config ?? null;
  loadGeometry();
  resizeListener = () => clampGeometry();
  window.addEventListener('resize', resizeListener);
  spectrumCtx = spectrumCanvas.value.getContext('2d');
  waterfallCtx = waterfallCanvas.value.getContext('2d');
  waterfallImage = waterfallCtx.createImageData(WF_W, WF_H);
  unsubState = props.audio.subscribeState(onState);
  unsubWaterfall = props.audio.subscribeWaterfall(onWaterfall);
  window.addEventListener('keydown', onKey);
  drawSpectrum();
  panel.value?.focus?.({ preventScroll: true });
});

onBeforeUnmount(() => {
  unsubState?.();
  unsubWaterfall?.();
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('resize', resizeListener);
  window.removeEventListener('pointermove', moveWindow);
  window.removeEventListener('pointerup', endWindowDrag);
  window.removeEventListener('pointermove', moveResize);
  window.removeEventListener('pointerup', endResize);
  saveGeometry();
});
</script>

<template>
  <Teleport to="body">
    <section
      ref="panel"
      class="sdr-wf"
      :style="windowStyle"
      tabindex="-1"
      role="dialog"
      aria-modal="false"
      aria-label="SDR waterfall and spectrum"
      translate="no"
    >
      <header class="sdr-wf-head" @pointerdown="beginWindowDrag">
        <div class="sdr-wf-id">
          <span class="sdr-wf-dot" :class="statusClass"></span>
          <div>
            <strong>{{ receiver?.name || 'SDR receiver' }}</strong>
            <span>
              {{ receiver?.platform || 'PUBLIC SDR' }}
              <b v-if="spanKHz > 0">· {{ spanLabel }}</b>
              · {{ statusText }} · {{ fps }} fps
            </span>
          </div>
        </div>
        <div class="sdr-wf-head-actions" @pointerdown.stop>
          <button
            type="button"
            class="sdr-wf-chip"
            :class="{ active: detailsOpen }"
            :aria-expanded="String(detailsOpen)"
            @click="detailsOpen = !detailsOpen"
          >
            DETAILS
          </button>
          <button
            type="button"
            class="sdr-wf-chip"
            aria-label="Maximize or restore waterfall"
            @click="toggleMaximize"
          >
            ⤢
          </button>
          <button
            type="button"
            class="sdr-wf-close"
            aria-label="Close waterfall"
            @click="emit('close')"
          >
            ×
          </button>
        </div>
      </header>

      <div class="sdr-wf-stats">
        <div class="sdr-wf-stat sdr-wf-stat--freq">
          <span>TUNED</span>
          <strong>{{ frequencyLabel }}</strong>
          <em>MHz</em>
        </div>
        <div class="sdr-wf-stat">
          <span>MODE</span>
          <strong>{{ (tuned?.mode || 'usb').toUpperCase() }}</strong>
          <em>{{ filterLabel }}</em>
        </div>
        <div class="sdr-wf-stat">
          <span>SPAN</span>
          <strong>{{ spanLabel }}</strong>
          <em>Z{{ config?.zoom ?? 0 }}</em>
        </div>
        <div class="sdr-wf-stat">
          <span>PEAK</span>
          <strong>{{ peak ? peak.db.toFixed(0) : '—' }}</strong>
          <em>{{ peak ? `${peak.mhz.toFixed(3)} MHz` : 'dB' }}</em>
        </div>
        <div class="sdr-wf-stat">
          <span>SNR</span>
          <strong>{{ snrDb === null ? '—' : snrDb.toFixed(0) }}</strong>
          <em>dB</em>
        </div>
        <div class="sdr-wf-stat">
          <span>S-METER</span>
          <strong>{{ sMeter }}</strong>
          <em>{{ Number.isFinite(tuned?.rssi) ? `${tuned.rssi.toFixed(0)} dBm` : '—' }}</em>
        </div>
      </div>

      <div class="sdr-wf-plot">
        <div class="sdr-wf-db">
          <span>{{ gainDb.ceiling }}</span>
          <span>{{ Math.round((gainDb.ceiling + gainDb.floor) / 2) }}</span>
          <span>{{ gainDb.floor }}</span>
          <em>dB</em>
        </div>
        <div
          ref="plotBody"
          class="sdr-wf-plotbody"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
          @pointerleave="onPointerLeave"
          @wheel.prevent="onWheel"
        >
          <canvas
            ref="spectrumCanvas"
            class="sdr-wf-spectrum"
            :width="WF_W"
            :height="SPECTRUM_H"
          ></canvas>
          <canvas
            ref="waterfallCanvas"
            class="sdr-wf-waterfall"
            :width="WF_W"
            :height="WF_H"
          ></canvas>

          <div
            v-if="passband && tunedInView"
            class="sdr-wf-passband"
            :style="{ left: `${passband.left}%`, width: `${passband.width}%` }"
          ></div>
          <div
            v-if="tunedInView"
            class="sdr-wf-vfo"
            :style="{ left: `${tunedPct}%` }"
          >
            <i></i>
          </div>
          <div v-else-if="config" class="sdr-wf-offview">
            TUNED OUT OF VIEW
          </div>
          <div
            v-if="hover !== null"
            class="sdr-wf-cross"
            :style="{ left: `${hover * 100}%` }"
          ></div>
          <div v-if="hoverText" class="sdr-wf-hover">{{ hoverText }}</div>
          <div v-if="panning" class="sdr-wf-pan">{{ panLabel() }}</div>
          <div v-if="!config" class="sdr-wf-empty">
            {{
              receiver
                ? "Connecting to the receiver's spectrum…"
                : 'Start a receiver to see its spectrum.'
            }}
          </div>
          <div v-else-if="!frameCount" class="sdr-wf-empty">
            Waiting for the receiver's spectrum…
          </div>
        </div>
        <div class="sdr-wf-axis">
          <span v-for="label in labels" :key="label">{{ label }}</span>
        </div>
      </div>

      <div class="sdr-wf-toolbar">
        <div class="sdr-wf-group">
          <span class="sdr-wf-label">TUNE</span>
          <input
            class="sdr-wf-mhz"
            type="number"
            step="0.001"
            min="0"
            :value="Number(frequencyLabel)"
            aria-label="Tuned frequency in MHz"
            @change="onFrequencyInput"
          />
          <button type="button" aria-label="Tune down" @click="tuneBy(-stepHz)">
            ◀
          </button>
          <select v-model.number="stepHz" aria-label="Tuning step">
            <option :value="10">10 Hz</option>
            <option :value="100">100 Hz</option>
            <option :value="1000">1 kHz</option>
            <option :value="5000">5 kHz</option>
          </select>
          <button type="button" aria-label="Tune up" @click="tuneBy(stepHz)">
            ▶
          </button>
          <select
            :value="tuned?.mode || 'usb'"
            aria-label="Demodulation mode"
            @change="onModeChange"
          >
            <option v-for="value in SDR_MODES" :key="value" :value="value">
              {{ value.toUpperCase() }}
            </option>
          </select>
        </div>

        <div class="sdr-wf-group">
          <span class="sdr-wf-label">VIEW</span>
          <button type="button" aria-label="Pan left" @click="panBy(-1)">←</button>
          <button type="button" aria-label="Pan right" @click="panBy(1)">→</button>
          <button
            type="button"
            aria-label="Zoom out"
            :disabled="!config || config.zoom <= 0"
            @click="zoomBy(-1)"
          >
            −
          </button>
          <span class="sdr-wf-zoom">Z{{ config?.zoom ?? 0 }}</span>
          <button
            type="button"
            aria-label="Zoom in"
            :disabled="!config || config.zoom >= 14"
            @click="zoomBy(1)"
          >
            +
          </button>
          <button type="button" :disabled="!config" @click="center">
            CENTER
          </button>
          <button type="button" :disabled="!config" @click="fullBand">
            FULL
          </button>
        </div>

        <div class="sdr-wf-group sdr-wf-group--display">
          <label class="sdr-wf-check">
            <input
              type="checkbox"
              :checked="autoRangeOn"
              @change="onAutoRange"
            />
            AUTO
          </label>
          <label class="sdr-wf-check">
            <input v-model="averaging" type="checkbox" />
            AVG
          </label>
          <label class="sdr-wf-slider">
            CONTRAST
            <input
              v-model.number="contrast"
              type="range"
              min="50"
              max="200"
              step="5"
              @input="onContrast"
            />
          </label>
          <button type="button" :class="{ active: paused }" @click="togglePause">
            {{ paused ? 'RESUME' : 'PAUSE' }}
          </button>
          <button type="button" @click="snapshot">SNAPSHOT</button>
        </div>
      </div>

      <div v-if="detailsOpen" class="sdr-wf-details">
        <div><span>RECEIVER</span><b>{{ receiver?.name || '—' }}</b></div>
        <div><span>SITE</span><b>{{ receiver?.site || '—' }}</b></div>
        <div><span>USERS</span><b>{{ usersLabel }}</b></div>
        <div><span>COVERAGE</span><b>{{ coverageLabel }}</b></div>
        <div><span>CENTER</span><b>{{ config?.viewCenterFreq ?? '—' }} kHz</b></div>
        <div><span>FILTER</span><b>{{ filterLabel }}</b></div>
        <div><span>FFT</span><b>{{ config?.fftSize ?? '—' }} bins</b></div>
        <div><span>DB RANGE</span><b>{{ gainDb.floor }}…{{ gainDb.ceiling }} dB</b></div>
        <div><span>NOISE</span><b>{{ Math.round(noiseDb) }} dB</b></div>
        <div><span>FRAMES</span><b>{{ frameCount }}</b></div>
        <div><span>FRAME RATE</span><b>{{ fps }} fps · {{ statusText }}</b></div>
        <div v-if="receiver?.version"><span>VERSION</span><b>{{ receiver.version }}</b></div>
        <a v-if="operatorUrl" :href="operatorUrl" target="_blank" rel="noopener noreferrer">
          OPERATOR ↗
        </a>
      </div>

      <footer class="sdr-wf-foot">
        <span>Click to tune · drag to pan · wheel to zoom · Esc close</span>
        <span v-if="note">{{ note }}</span>
      </footer>

      <div
        class="sdr-wf-resize"
        aria-hidden="true"
        @pointerdown.stop.prevent="beginResize"
      ></div>
    </section>
  </Teleport>
</template>

<style scoped>
.sdr-wf {
  position: fixed;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  min-width: 320px;
  min-height: 260px;
  overflow: hidden;
  color: var(--foreground, #d8f3ff);
  background: var(--card, rgba(7, 16, 25, 0.96));
  background: color-mix(in srgb, var(--card, #071019) 94%, transparent);
  border: 1px solid var(--border, rgba(90, 200, 235, 0.4));
  border-radius: 3px;
  box-shadow:
    0 18px 60px rgba(0, 0, 0, 0.62),
    0 0 0 1px rgba(90, 200, 235, 0.08),
    0 0 40px rgba(20, 120, 160, 0.12);
  font-family: var(--font-mono, ui-monospace, monospace);
  backdrop-filter: blur(10px);
  outline: none;
}

.sdr-wf-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  background: linear-gradient(180deg, rgba(90, 200, 235, 0.1), transparent);
  border-bottom: 1px solid var(--border, rgba(90, 200, 235, 0.24));
  cursor: grab;
  touch-action: none;
  user-select: none;
}

.sdr-wf-head:active {
  cursor: grabbing;
}

.sdr-wf-id {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.sdr-wf-id > div {
  min-width: 0;
}

.sdr-wf-dot {
  width: 8px;
  height: 8px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: #5b6a78;
  box-shadow: 0 0 0 3px rgba(91, 106, 120, 0.16);
}

.sdr-wf-dot.live {
  background: #5dffb0;
  box-shadow: 0 0 9px rgba(93, 255, 176, 0.9);
}

.sdr-wf-dot.warning {
  background: #ffc857;
  box-shadow: 0 0 8px rgba(255, 200, 87, 0.7);
}

.sdr-wf-dot.error {
  background: #ff7171;
}

.sdr-wf-head strong {
  display: block;
  overflow: hidden;
  font-size: 12px;
  letter-spacing: 0.07em;
  text-overflow: ellipsis;
  text-transform: uppercase;
  white-space: nowrap;
}

.sdr-wf-head span {
  display: block;
  margin-top: 1px;
  color: var(--muted-foreground, #7f9aa8);
  font-size: 9px;
  letter-spacing: 0.13em;
  text-transform: uppercase;
}

.sdr-wf-head span b {
  color: var(--accent, #5ac8eb);
  font-weight: 500;
}

.sdr-wf-head-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 0 0 auto;
}

.sdr-wf-chip,
.sdr-wf-close {
  height: 24px;
  padding: 0 7px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--border, rgba(90, 200, 235, 0.35));
  cursor: pointer;
  font: inherit;
  font-size: 9px;
  letter-spacing: 0.06em;
}

.sdr-wf-chip.active {
  color: var(--accent, #5ac8eb);
  border-color: var(--accent, #5ac8eb);
}

.sdr-wf-close {
  width: 26px;
  padding: 0;
  font-size: 17px;
  line-height: 1;
}

.sdr-wf-chip:hover,
.sdr-wf-close:hover {
  color: var(--accent, #5ac8eb);
  border-color: var(--accent, #5ac8eb);
}

.sdr-wf-stats {
  display: flex;
  flex-wrap: nowrap;
  gap: 0;
  padding: 6px 8px 6px 10px;
  overflow: hidden;
  border-bottom: 1px solid rgba(90, 200, 235, 0.12);
}

.sdr-wf-stat {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-width: 0;
  padding: 0 7px;
  border-right: 1px solid rgba(90, 200, 235, 0.14);
}

.sdr-wf-stat:first-child {
  padding-left: 0;
}

.sdr-wf-stat:last-child {
  border-right: 0;
}

.sdr-wf-stat span {
  color: var(--muted-foreground, #7f9aa8);
  font-size: 8px;
  letter-spacing: 0.14em;
}

.sdr-wf-stat strong {
  margin-top: 1px;
  overflow: hidden;
  color: #e5fbff;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sdr-wf-stat em {
  color: var(--muted-foreground, #7f9aa8);
  font-size: 8px;
  font-style: normal;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.sdr-wf-stat--freq strong {
  color: var(--accent, #5ac8eb);
  font-size: 15px;
}

.sdr-wf-stat--status {
  min-width: 92px;
  border-right: 0;
}

.sdr-wf-stat--status span {
  color: #5dffb0;
}

.sdr-wf-plot {
  display: grid;
  grid-template-columns: 34px 1fr;
  grid-template-rows: 1fr 16px;
  flex: 1 1 auto;
  min-height: 170px;
  padding: 5px 8px 0;
}

.sdr-wf-db {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  grid-row: 1;
  padding: 4px 6px 4px 0;
  color: rgba(142, 180, 202, 0.8);
  font-size: 8px;
  letter-spacing: 0.02em;
  line-height: 1;
}

.sdr-wf-db em {
  align-self: flex-end;
  color: rgba(142, 180, 202, 0.5);
  font-style: normal;
}

.sdr-wf-plotbody {
  position: relative;
  display: grid;
  grid-template-rows: 96px 1fr;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #03060f;
  border: 1px solid rgba(90, 200, 235, 0.22);
  cursor: crosshair;
  touch-action: none;
}

.sdr-wf-spectrum,
.sdr-wf-waterfall {
  display: block;
  width: 100%;
  pointer-events: none;
}

.sdr-wf-spectrum {
  height: 96px;
  border-bottom: 1px solid rgba(90, 200, 235, 0.24);
}

.sdr-wf-waterfall {
  min-height: 0;
  height: 100%;
  image-rendering: auto;
}

.sdr-wf-axis {
  display: flex;
  grid-column: 2;
  justify-content: space-between;
  gap: 4px;
  padding-top: 3px;
  color: rgba(142, 180, 202, 0.82);
  font-size: 8px;
  letter-spacing: 0.02em;
}

.sdr-wf-passband {
  position: absolute;
  top: 0;
  bottom: 0;
  background: rgba(90, 200, 235, 0.12);
  border-left: 1px solid rgba(90, 200, 235, 0.55);
  border-right: 1px solid rgba(90, 200, 235, 0.55);
  pointer-events: none;
}

.sdr-wf-vfo {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: #ffd166;
  box-shadow: 0 0 7px rgba(255, 209, 102, 0.75);
  pointer-events: none;
}

.sdr-wf-vfo i {
  position: absolute;
  top: 0;
  left: -4px;
  width: 9px;
  height: 6px;
  background: #ffd166;
  clip-path: polygon(0 0, 100% 0, 50% 100%);
}

.sdr-wf-offview {
  position: absolute;
  top: 6px;
  right: 8px;
  padding: 1px 5px;
  color: #ffc857;
  background: rgba(0, 0, 0, 0.7);
  border: 1px solid rgba(255, 200, 87, 0.4);
  font-size: 8px;
  letter-spacing: 0.08em;
  pointer-events: none;
}

.sdr-wf-cross {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: rgba(235, 252, 255, 0.7);
  box-shadow: 0 0 6px rgba(235, 252, 255, 0.45);
  pointer-events: none;
}

.sdr-wf-hover {
  position: absolute;
  top: 6px;
  left: 8px;
  padding: 2px 5px;
  color: #eafcff;
  background: rgba(0, 0, 0, 0.7);
  font-size: 9px;
  letter-spacing: 0.04em;
  pointer-events: none;
}

.sdr-wf-pan {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  padding: 3px 8px;
  color: #031018;
  background: rgba(90, 200, 235, 0.9);
  font-size: 9px;
  letter-spacing: 0.08em;
  pointer-events: none;
}

.sdr-wf-empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  padding: 16px;
  color: var(--muted-foreground, #7f9aa8);
  background: rgba(3, 6, 15, 0.55);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-align: center;
  text-transform: uppercase;
  pointer-events: none;
}

.sdr-wf-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 10px;
  align-items: center;
  padding: 7px 8px 5px;
  border-top: 1px solid rgba(90, 200, 235, 0.12);
}

.sdr-wf-group {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 10px;
  border-right: 1px solid rgba(90, 200, 235, 0.14);
}

.sdr-wf-group:last-child {
  border-right: 0;
  padding-right: 0;
}

.sdr-wf-label {
  color: var(--muted-foreground, #7f9aa8);
  font-size: 8px;
  letter-spacing: 0.12em;
}

.sdr-wf-toolbar button,
.sdr-wf-toolbar select {
  height: 22px;
  padding: 0 6px;
  color: inherit;
  background: transparent;
  border: 1px solid var(--border, rgba(90, 200, 235, 0.32));
  cursor: pointer;
  font: inherit;
  font-size: 9px;
}

.sdr-wf-toolbar select,
.sdr-wf-mhz {
  padding: 0 3px;
  color: #d8f3ff;
  background: #0a1420;
}

.sdr-wf-mhz {
  width: 74px;
  height: 22px;
  border: 1px solid var(--border, rgba(90, 200, 235, 0.32));
  font: inherit;
  font-size: 10px;
}

.sdr-wf-toolbar button:hover:not(:disabled),
.sdr-wf-toolbar button.active {
  color: var(--accent, #5ac8eb);
  border-color: var(--accent, #5ac8eb);
}

.sdr-wf-toolbar button:disabled {
  opacity: 0.35;
  cursor: default;
}

.sdr-wf-zoom {
  min-width: 22px;
  color: var(--accent, #5ac8eb);
  font-size: 9px;
  text-align: center;
}

.sdr-wf-check,
.sdr-wf-slider {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--muted-foreground, #7f9aa8);
  font-size: 8px;
  letter-spacing: 0.06em;
  white-space: nowrap;
}

.sdr-wf-check input {
  width: 11px;
  height: 11px;
  margin: 0;
  accent-color: var(--accent, #5ac8eb);
}

.sdr-wf-slider input {
  width: 58px;
  height: 4px;
  accent-color: var(--accent, #5ac8eb);
}

.sdr-wf-details {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 4;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(125px, 1fr));
  gap: 5px 12px;
  max-height: 48%;
  padding: 8px 10px 12px;
  overflow: auto;
  border-top: 1px solid rgba(90, 200, 235, 0.28);
  background: rgba(4, 12, 20, 0.98);
  box-shadow: 0 -12px 30px rgba(0, 0, 0, 0.5);
}

.sdr-wf-details div {
  min-width: 0;
}

.sdr-wf-details span {
  display: block;
  color: var(--muted-foreground, #7f9aa8);
  font-size: 7px;
  letter-spacing: 0.12em;
}

.sdr-wf-details b {
  display: block;
  overflow: hidden;
  color: #d8f3ff;
  font-size: 9px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sdr-wf-details a {
  align-self: end;
  color: var(--accent, #5ac8eb);
  font-size: 8px;
  letter-spacing: 0.08em;
  text-decoration: none;
}

.sdr-wf-foot {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 10px;
  padding: 0 10px 6px;
  color: rgba(127, 154, 168, 0.7);
  font-size: 8px;
  letter-spacing: 0.04em;
}

.sdr-wf-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  z-index: 6;
  width: 15px;
  height: 15px;
  cursor: nwse-resize;
  background:
    linear-gradient(135deg, transparent 50%, rgba(90, 200, 235, 0.55) 50%)
      bottom right / 7px 7px no-repeat,
    linear-gradient(135deg, transparent 50%, rgba(90, 200, 235, 0.35) 50%)
      bottom right / 12px 12px no-repeat;
}
</style>
