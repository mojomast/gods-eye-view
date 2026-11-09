import { OpenWebRXStream } from './stream.js';
export class OpenWebRX {
    host;
    port;
    constructor(opts) {
        this.host = opts.host;
        this.port = opts.port ?? 8073;
    }
    /** Open a combined audio + waterfall stream to this receiver. */
    connect(opts) {
        return new OpenWebRXStream(this.host, this.port, opts);
    }
}
//# sourceMappingURL=client.js.map