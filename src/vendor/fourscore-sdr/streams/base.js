import { parseMsgBody } from '../utils/msg.js';
import { EventEmitter } from '../utils/events.js';
const KEEPALIVE_INTERVAL_MS = 1000;
const ascii = new TextDecoder('windows-1252');
const utf8 = new TextDecoder('utf-8');
export class BaseStream extends EventEmitter {
    host;
    port;
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
        super();
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
                const params = parseMsgBody(utf8.decode(body));
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
//# sourceMappingURL=base.js.map