import { ImaAdpcmDecoder } from '../adpcm.js';
import { SND_FLAG_COMPRESSED, SND_FLAG_STEREO, } from '../types.js';
// ─── BaseStream ──────────────────────────────────────────────────────────────
const KEEPALIVE_INTERVAL_MS = 1000;
const ascii = new TextDecoder('windows-1252');
const utf8 = new TextDecoder('utf-8');
export class BaseStream {
    host;
    port;
    _listeners = new Map();
    on(event, listener) {
        const list = this._listeners.get(event) ?? [];
        list.push(listener);
        this._listeners.set(event, list);
        return this;
    }
    off(event, listener) {
        const list = this._listeners.get(event) ?? [];
        this._listeners.set(event, list.filter(l => l !== listener));
        return this;
    }
    emit(event, ...args) {
        const list = this._listeners.get(event) ?? [];
        for (const listener of list)
            listener(...args);
    }
    ws = null;
    keepaliveTimer = null;
    closed = false;
    streamStarted = false;
    /** Default trigger: fire once auth is confirmed (badp=0). Subclasses may override. */
    isStreamReady(params) {
        return params['badp'] === '0';
    }
    constructor(host, port, streamType, password, username, 
    /** Optional pre-fetched VER timestamp. Pass from KiwiSDR to share one fetch across streams. */
    tsPromise) {
        this.host = host;
        this.port = port;
        const resolvedTsPromise = tsPromise ?? BaseStream._fetchTs(host, port);
        resolvedTsPromise.then(ts => {
            if (this.closed)
                return;
            const url = `ws://${host}:${port}/ws/kiwi/${ts}/${streamType}`;
            this._connect(url, password, username);
        });
    }
    static _fetchTs(host, port) {
        return fetch(`http://${host}:${port}/VER`)
            .then(r => r.json())
            .then(ver => ver.ts)
            .catch(() => Math.floor(Date.now() / 1000));
    }
    static _parseMsgBody(body) {
        const params = {};
        for (const token of body.trim().split(' ')) {
            if (!token)
                continue;
            const eq = token.indexOf('=');
            if (eq === -1) {
                params[token] = '';
            }
            else {
                params[token.slice(0, eq)] = token.slice(eq + 1);
            }
        }
        return params;
    }
    _connect(url, password, username) {
        console.log(`[fourscore-sdr] connecting to ${url}`);
        const ws = new WebSocket(url);
        this.ws = ws;
        ws.binaryType = 'arraybuffer';
        ws.addEventListener('open', () => {
            this.sendAuth(password);
            if (username)
                this.send(`SET ident_user=${username}`);
        });
        this.ws.addEventListener('message', (event) => {
            let buf;
            if (typeof event.data === 'string') {
                buf = new TextEncoder().encode(event.data);
            }
            else {
                buf = new Uint8Array(event.data);
            }
            if (buf.length < 3)
                return;
            const tag = ascii.decode(buf.subarray(0, 3));
            const body = buf.subarray(3);
            if (tag === 'MSG') {
                const params = BaseStream._parseMsgBody(utf8.decode(body));
                if ('badp' in params && params['badp'] !== '0') {
                    this.emit('error', new Error(`KiwiSDR rejected auth (badp=${params['badp']})`));
                    return;
                }
                if (!this.streamStarted && this.isStreamReady(params)) {
                    this.streamStarted = true;
                    this.onOpen();
                    this.send('SET keepalive');
                    this.keepaliveTimer = setInterval(() => this.send('SET keepalive'), KEEPALIVE_INTERVAL_MS);
                    this.emit('open');
                }
                this.onMsg(params);
                this.emit('msg', params);
            }
            else {
                this.onBinary(tag, body);
            }
        });
        this.ws.addEventListener('error', (_event) => {
            this.emit('error', new Error('WebSocket error'));
        });
        this.ws.addEventListener('close', (event) => {
            this.cleanup();
            this.emit('close', event.code, event.reason);
        });
    }
    send(msg) {
        if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(msg);
        }
    }
    sendAuth(password) {
        // KiwiSDR convention: use '#' to represent an empty/no password
        const p = password !== '' ? password : '#';
        this.send(`SET auth t=kiwi p=${p}`);
    }
    cleanup() {
        if (this.keepaliveTimer !== null) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
    }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        this.cleanup();
        this.ws?.close();
    }
}
// ─── AudioStream ─────────────────────────────────────────────────────────────
const DEFAULT_SAMPLE_RATE = 44100;
export class AudioStream extends BaseStream {
    opts;
    decoder = new ImaAdpcmDecoder();
    constructor(host, port, opts, tsPromise) {
        const password = opts.password ?? '';
        const username = opts.username ?? 'fourscore';
        super(host, port, 'SND', password, username, tsPromise);
        this.opts = {
            frequency: opts.frequency,
            mode: opts.mode ?? 'am',
            lowCut: opts.lowCut ?? -2700,
            highCut: opts.highCut ?? 2700,
            agc: opts.agc ?? true,
            agcHang: opts.agcHang ?? false,
            agcThresh: opts.agcThresh ?? -100,
            agcSlope: opts.agcSlope ?? 6,
            agcDecay: opts.agcDecay ?? 500,
            manGain: opts.manGain ?? 49,
            compression: opts.compression ?? true,
            squelch: opts.squelch ?? false,
            squelchMax: opts.squelchMax ?? 0,
            sampleRate: opts.sampleRate ?? DEFAULT_SAMPLE_RATE,
            password,
            username,
        };
    }
    /** Trigger as soon as sample_rate arrives — the very first MSG from the server. */
    isStreamReady(params) {
        return 'sample_rate' in params;
    }
    onOpen() {
        const o = this.opts;
        this.send(`SET mod=${o.mode} low_cut=${o.lowCut} high_cut=${o.highCut} freq=${o.frequency.toFixed(3)}`);
        this.send(`SET agc=${o.agc ? 1 : 0} hang=${o.agcHang ? 1 : 0} thresh=${o.agcThresh} slope=${o.agcSlope} decay=${o.agcDecay} manGain=${o.manGain}`);
        this.send(`SET compression=${o.compression ? 1 : 0}`);
        this.send(`SET squelch=${o.squelch ? 1 : 0} max=${o.squelchMax}`);
    }
    onMsg(params) {
        // Resend AR OK with the server's actual input rate if it differs from our initial guess
        if (params['audio_rate'] !== undefined) {
            this.send(`SET AR OK in=${params['audio_rate']} out=${this.opts.sampleRate}`);
        }
        // Server sends initial ADPCM state so the decoder is in sync
        if (params['audio_adpcm_state'] !== undefined) {
            const [idx, prev] = params['audio_adpcm_state'].split(',').map(Number);
            this.decoder.preset(idx, prev);
        }
    }
    onBinary(tag, body) {
        if (tag !== 'SND')
            return;
        if (body.length < 7)
            return;
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const flags = view.getUint8(0);
        const sequence = view.getUint32(1, true); // little-endian
        const smeter = view.getUint16(5, false); // big-endian
        const rssi = 0.1 * smeter - 127;
        let audioData = body.subarray(7);
        let gps;
        if (flags & SND_FLAG_STEREO) {
            // GPS timestamp is prepended to audio data in IQ/stereo mode
            if (audioData.length >= 10) {
                const gpsView = new DataView(audioData.buffer, audioData.byteOffset, audioData.byteLength);
                gps = {
                    lastGpsSolution: gpsView.getUint8(0),
                    seconds: gpsView.getUint32(2, true), // little-endian
                    nanoseconds: gpsView.getUint32(6, true), // little-endian
                };
                audioData = audioData.subarray(10);
            }
        }
        let samples;
        if (flags & SND_FLAG_COMPRESSED) {
            samples = this.decoder.decode(audioData);
        }
        else {
            // Raw 16-bit big-endian PCM
            const pcmView = new DataView(audioData.buffer, audioData.byteOffset, audioData.byteLength);
            samples = new Int16Array(audioData.length / 2);
            for (let i = 0; i < samples.length; i++) {
                samples[i] = pcmView.getInt16(i * 2, false); // big-endian
            }
        }
        const data = { samples, rssi, sequence, flags, gps };
        this.emit('smeter', rssi);
        this.emit('audio', data);
    }
    /** Retune to a new frequency without reopening the connection. */
    tune(frequency, mode, lowCut, highCut) {
        const m = mode ?? this.opts.mode;
        const lc = lowCut ?? this.opts.lowCut;
        const hc = highCut ?? this.opts.highCut;
        this.send(`SET mod=${m} low_cut=${lc} high_cut=${hc} freq=${frequency.toFixed(3)}`);
    }
    /** Adjust AGC settings on the fly. */
    setAgc(enabled, manGain) {
        const gain = manGain ?? this.opts.manGain;
        this.send(`SET agc=${enabled ? 1 : 0} hang=0 thresh=${this.opts.agcThresh} slope=${this.opts.agcSlope} decay=${this.opts.agcDecay} manGain=${gain}`);
    }
    /** Enable or disable squelch. */
    setSquelch(enabled, max) {
        const m = max ?? this.opts.squelchMax;
        this.send(`SET squelch=${enabled ? 1 : 0} max=${m}`);
    }
}
// ─── WaterfallStream ─────────────────────────────────────────────────────────
/** Number of FFT bins per waterfall frame */
const WF_BINS = 1024;
/** Number of tail samples to discard after ADPCM decompression */
const WF_ADPCM_TAIL = 10;
export class WaterfallStream extends BaseStream {
    opts;
    decoder = new ImaAdpcmDecoder();
    constructor(host, port, opts, tsPromise) {
        const password = opts.password ?? '';
        const username = opts.username ?? 'fourscore';
        super(host, port, 'W/F', password, username, tsPromise);
        this.opts = {
            zoom: opts.zoom ?? 0,
            centerFreq: opts.centerFreq ?? 14000,
            maxDb: opts.maxDb ?? 0,
            minDb: opts.minDb ?? -100,
            speed: opts.speed ?? 4,
            compression: opts.compression ?? false,
            interp: opts.interp ?? 0,
            password,
            username,
        };
    }
    /** Trigger when the server sends wf_setup, signalling the waterfall channel is ready. */
    isStreamReady(params) {
        return 'wf_setup' in params;
    }
    onOpen() {
        const o = this.opts;
        this.send(`SET send_dB=1`);
        this.send(`SET zoom=${o.zoom} cf=${o.centerFreq.toFixed(3)}`);
        this.send(`SET maxdb=${o.maxDb} mindb=${o.minDb}`);
        this.send(`SET wf_speed=${o.speed}`);
        this.send(`SET wf_comp=${o.compression ? 1 : 0}`);
        if (o.interp !== 0)
            this.send(`SET interp=${o.interp}`);
    }
    onMsg(_params) {
        // No MSG handling specific to waterfall
    }
    onBinary(tag, body) {
        if (tag !== 'W/F')
            return;
        if (body.length < 12)
            return;
        const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
        const xBin = view.getUint32(0, true); // little-endian
        const flagsRaw = view.getUint32(4, true); // little-endian
        const sequence = view.getUint32(8, true); // little-endian
        const raw = body.subarray(12);
        const zoom = flagsRaw & 0xff;
        const flags = (flagsRaw >> 8) & 0xff;
        let bins;
        if (this.opts.compression) {
            this.decoder.reset();
            const decoded = this.decoder.decode(raw);
            // Trim decompression tail and clamp to uint8
            const trimmed = decoded.subarray(0, Math.max(0, decoded.length - WF_ADPCM_TAIL));
            bins = Uint8Array.from(trimmed, v => Math.max(0, Math.min(255, v)));
        }
        else {
            bins = new Uint8Array(raw.buffer, raw.byteOffset, Math.min(raw.length, WF_BINS));
        }
        const data = { bins, sequence, xBin, zoom, flags };
        this.emit('waterfall', data);
    }
    /** Pan/zoom to a new center frequency and zoom level without reopening. */
    setView(zoom, centerFreq) {
        this.send(`SET zoom=${zoom} cf=${centerFreq.toFixed(3)}`);
    }
    /** Adjust the display dB range. */
    setDbRange(maxDb, minDb) {
        this.send(`SET maxdb=${maxDb} mindb=${minDb}`);
    }
    /** Set waterfall update speed (1-4 updates/sec). */
    setSpeed(speed) {
        this.send(`SET wf_speed=${speed}`);
    }
}
//# sourceMappingURL=stream.js.map