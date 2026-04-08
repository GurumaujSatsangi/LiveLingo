import { EventEmitter } from "events";

/**
 * Energy-based VAD segmenter for server-side chunking.
 * Emits speech segments when silence tail is detected or max duration is reached.
 */
class VadSegmenter extends EventEmitter {
  constructor(options = {}) {
    super();

    this.sampleRate = Number(options.sampleRate || 16000);
    this.channels = Number(options.channels || 1);
    this.bytesPerSample = 2;
    this.frameMs = Number(options.frameMs || 20);
    this.energyThreshold = Number(options.energyThreshold || process.env.LIVEKIT_VAD_ENERGY_THRESHOLD || 0.016);
    this.silenceMs = Number(options.silenceMs || process.env.LIVEKIT_VAD_SILENCE_MS || 400);
    this.maxBufferMs = 10000;

    this.frameBytes = Math.floor((this.sampleRate * this.channels * this.bytesPerSample * this.frameMs) / 1000);
    this.bytesPerSecond = this.sampleRate * this.channels * this.bytesPerSample;
    this.maxBufferBytes = this.bytesPerSecond * (this.maxBufferMs / 1000);

    this.mainBuffer = Buffer.alloc(0);
    this.analysisPending = Buffer.alloc(0);

    this.speechActive = false;
    this.trailingSilenceMs = 0;
    this.chunkStartAt = 0;
    this.segmentId = 1;

    this.stats = {
      framesSeen: 0,
      segmentsEmitted: 0,
      bytesSeen: 0,
      droppedSilenceFrames: 0,
      forcedHardCutoff: 0,
    };
  }

  processAudio(pcmChunk) {
    if (!Buffer.isBuffer(pcmChunk) || pcmChunk.length === 0) {
      return;
    }

    this.stats.bytesSeen += pcmChunk.length;
    if (this.mainBuffer.length === 0) {
      this.chunkStartAt = Date.now();
    }

    this.mainBuffer = Buffer.concat([this.mainBuffer, pcmChunk]);
    this.analysisPending = Buffer.concat([this.analysisPending, pcmChunk]);

    while (this.mainBuffer.length >= this.maxBufferBytes) {
      this.emitFixedWindow("hard_cutoff_10s");
    }

    while (this.analysisPending.length >= this.frameBytes) {
      const frame = this.analysisPending.slice(0, this.frameBytes);
      this.analysisPending = this.analysisPending.slice(this.frameBytes);
      this.processFrame(frame);
    }
  }

  processFrame(frame) {
    this.stats.framesSeen += 1;

    const energy = this.getFrameEnergy(frame);
    const hasVoice = energy >= this.energyThreshold;

    if (hasVoice) {
      this.speechActive = true;
      this.trailingSilenceMs = 0;
      return;
    }

    if (!this.speechActive) {
      this.stats.droppedSilenceFrames += 1;
      return;
    }

    this.trailingSilenceMs += this.frameMs;

    if (this.trailingSilenceMs >= this.silenceMs) {
      this.emit("vad-event", {
        type: "speech_end",
        reason: "silence",
        at: Date.now(),
      });
      this.emitCurrentBuffer("speech_end");
      this.speechActive = false;
      this.trailingSilenceMs = 0;
      return;
    }
  }

  emitCurrentBuffer(reason) {
    if (this.mainBuffer.length === 0) {
      return;
    }

    const segmentBuffer = Buffer.from(this.mainBuffer);
    const emittedAt = Date.now();
    const durationMs = Math.floor((segmentBuffer.length / this.bytesPerSecond) * 1000);

    this.mainBuffer.fill(0);
    this.mainBuffer = Buffer.alloc(0);

    const event = {
      segmentId: this.segmentId,
      reason,
      buffer: segmentBuffer,
      durationMs,
      frameMs: this.frameMs,
      emittedAt,
      startedAt: this.chunkStartAt || emittedAt,
    };

    this.segmentId += 1;
    this.stats.segmentsEmitted += 1;
    this.chunkStartAt = 0;

    this.emit("segment", event);
  }

  emitFixedWindow(reason) {
    if (this.mainBuffer.length < this.maxBufferBytes) {
      return;
    }

    const segmentBuffer = Buffer.from(this.mainBuffer.slice(0, this.maxBufferBytes));
    const remainder = Buffer.from(this.mainBuffer.slice(this.maxBufferBytes));
    const emittedAt = Date.now();

    this.mainBuffer.fill(0);
    this.mainBuffer = remainder;

    this.stats.forcedHardCutoff += 1;
    this.stats.segmentsEmitted += 1;

    const event = {
      segmentId: this.segmentId,
      reason,
      buffer: segmentBuffer,
      durationMs: this.maxBufferMs,
      frameMs: this.frameMs,
      emittedAt,
      startedAt: this.chunkStartAt || emittedAt,
    };

    this.segmentId += 1;
    this.chunkStartAt = Date.now();

    this.emit("segment", event);
  }

  flush(reason = "flush") {
    if (this.analysisPending.length > 0) {
      this.analysisPending.fill(0);
      this.analysisPending = Buffer.alloc(0);
    }

    if (this.mainBuffer.length > 0) {
      this.emitCurrentBuffer(reason);
    }

    this.speechActive = false;
    this.trailingSilenceMs = 0;
  }

  getFrameEnergy(frame) {
    let sum = 0;

    for (let i = 0; i < frame.length; i += 2) {
      const sample = frame.readInt16LE(i);
      sum += Math.abs(sample);
    }

    const sampleCount = frame.length / 2;
    const avg = sampleCount > 0 ? sum / sampleCount : 0;
    return avg / 32768;
  }

  getStats() {
    return {
      ...this.stats,
      bufferedBytes: this.mainBuffer.length,
      bufferedDurationMs: Math.floor((this.mainBuffer.length / this.bytesPerSecond) * 1000),
      speechActive: this.speechActive,
      frameBytes: this.frameBytes,
      maxBufferBytes: this.maxBufferBytes,
    };
  }
}

export default VadSegmenter;