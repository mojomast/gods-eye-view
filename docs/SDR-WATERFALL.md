# Public SDR waterfall

The **WATERFALL** button in the PUBLIC SDR card opens a floating spectrum and
waterfall window for the receiver that is currently playing. It is available
only when the receiver has published its waterfall configuration, which means a
native KiwiSDR or OpenWebRX stream is connected.

## Using it

1. Open **RADIO → PUBLIC SDR**.
2. Pick a receiver and press **LISTEN**.
3. Press **WATERFALL**.
4. Click the spectrum or waterfall to tune there. Drag left/right to pan,
   wheel to zoom around the pointer, or use the toolbar.
5. Drag the header to move the window, drag the bottom-right corner to resize
   it, or use `⤢` to maximize. The map stays live behind it — there is no
   backdrop.

The **MAP: AUDIO + WATERFALL ONLY** checkbox controls the globe layer. On (the
default) it shows only receivers that can play in the app and publish a
waterfall; off it shows the whole directory, including link-only receivers.
Clicking a playable receiver pin starts its stream and opens the waterfall
window immediately — no extra Listen press.

Closing the window does not stop audio. Selecting another receiver, stopping
audio, or hiding the pane closes the window and stops the stream.

## What is on screen

- **Spectrum** above the waterfall with a filled trace, dB grid and peak
  marker.
- **Waterfall** with a 360-frame history, contrast/gain control, averaging,
  pause and snapshot-to-PNG.
- **dB scale** on the left and a frequency axis underneath, both derived from
  the receiver's `viewCenterFreq` / `viewBandwidth`.
- **Passband and VFO marker** from the receiver's `lowCut` / `highCut`, so the
  demodulated slice is visible in the spectrum.
- **Stats** for tuned frequency, mode/filter, span/zoom, peak, SNR, S-meter,
  frame rate and total frames.
- **DETAILS** exposes receiver/site/users/coverage, centre, filter, FFT size,
  dB range, noise floor, frame rate, row count and the operator link.
- **Toolbar** for direct MHz entry, tuning step, mode, pan, zoom, center, full
  band, auto-range, averaging, contrast, pause and snapshot.
- **Keyboard**: `←`/`→` tune by the selected step, `+`/`-` zoom, `C` center,
  `Space` pause, `Esc` close.

## Data path

`sdrAudio.js` subscribes to `UniversalSDR`'s `onWaterfall` callback and forwards
raw frames to the view through `subscribeWaterfall`. The view also subscribes to
state so it can follow tuning and config changes.

- **KiwiSDR** uses a separate `W/F` WebSocket (`streams/waterfall.js`). The
  server sends 1024 bins per frame as **signed 8-bit dB** values. The transport
  stores them in a `Uint8Array`, so the view sign-extends each byte before
  colour mapping.
- **OpenWebRX** receives FFT frames on its main WebSocket as `Float32` dB
  values.

A fixed dB window is wrong for public receivers: quiet Kiwis sit near
`-110 dB` while noisy ones sit near `-80 dB`. The view auto-ranges each frame
using the 5th and 99.5th percentiles (with a minimum 24 dB span), clamped to the
receiver's advertised `waterfallMin` / `waterfallMax`. The ceiling is raised to
cover the strongest bin so the peak marker is never clipped.

The window keeps the last 360 **dB rows**, not RGBA rows: contrast and manual
range changes can recolour the whole history. New frames are painted by
shifting the existing image down one row and colouring only the top row; a full
history repaint happens only on a contrast or geometry change. Changing the view
centre or span clears the history because the old rows no longer share the new
frequency axis.

## Limits

The waterfall is a convenience view over the same single stream; it does not
add a second receiver connection. It does not make WebSDR, SpyServer, UberSDR or
https-only receivers playable — those remain **OPEN ↗** links. Some operators
limit waterfall channels even when audio is available; in that case the window
shows **WAITING FOR SPECTRUM** until frames arrive.

No autoplay is involved: audio and the window both require an explicit click,
except when a deep link (`?sdr=…&f=…&m=…&wf=1&play=1`) asks for a handoff and
the browser permits the stream to start.
