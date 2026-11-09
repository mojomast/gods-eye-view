"use strict";
class OpenWebRXAudioProcessor extends AudioWorkletProcessor {
    bufferSize;
    audioBuffer;
    inPos = 0;
    outPos = 0;
    samplesProcessed = 0;
    constructor(options) {
        super(options);
        const processorOptions = options?.processorOptions;
        const requestedSize = processorOptions?.maxBufferSize ?? 0;
        this.bufferSize = Math.max(128, Math.round(requestedSize / 128) * 128);
        this.audioBuffer = new Float32Array(this.bufferSize);
        this.port.addEventListener('message', (event) => {
            if (typeof event.data === 'string') {
                const json = JSON.parse(event.data);
                if (json.cmd === 'getStats')
                    this.reportStats();
                return;
            }
            const chunk = event.data;
            if (this.inPos + chunk.length <= this.bufferSize) {
                this.audioBuffer.set(chunk, this.inPos);
            }
            else {
                const remaining = this.bufferSize - this.inPos;
                this.audioBuffer.set(chunk.subarray(0, remaining), this.inPos);
                this.audioBuffer.set(chunk.subarray(remaining));
            }
            this.inPos = (this.inPos + chunk.length) % this.bufferSize;
        });
        this.port.addEventListener('messageerror', console.error);
        this.port.start();
    }
    process(_inputs, outputs) {
        if (this.remaining() < 128) {
            outputs[0].forEach(output => output.fill(0));
            return true;
        }
        outputs[0].forEach((output) => {
            output.set(this.audioBuffer.subarray(this.outPos, this.outPos + 128));
        });
        this.outPos = (this.outPos + 128) % this.bufferSize;
        this.samplesProcessed += 128;
        return true;
    }
    remaining() {
        const mod = (this.inPos - this.outPos) % this.bufferSize;
        return mod >= 0 ? mod : mod + this.bufferSize;
    }
    reportStats() {
        this.port.postMessage(JSON.stringify({
            buffersize: this.remaining(),
            samplesProcessed: this.samplesProcessed,
        }));
        this.samplesProcessed = 0;
    }
}
registerProcessor('openwebrx-audio-processor', OpenWebRXAudioProcessor);
//# sourceMappingURL=openwebrx-audio-processor.js.map