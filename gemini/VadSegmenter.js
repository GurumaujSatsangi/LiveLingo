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
    this.energyThreshold = Number(options.energyThreshold || process.env.GEMINI_VAD_ENERGY_THRESHOLD || 0.016);
    this.silenceMs = Number(options.silenceMs || process.env.GEMINI_VAD_SILENCE_MS || 400);
    this.maxBufferMs = 10000;

    this.frameBytes = Math.floor((this.sampleRate * this.channels * this.bytesPerSample * this.frameMs) / 1000);
    this.bytesPerSecond = this.sampleRate * this.channels * this.bytesPerSample;
    this.maxBufferBytes = this.bytesPerSecond * (this.maxBufferMs / 1000);

    // Main payload buffer. Every incoming PCM chunk is appended here.
    // This is the only source used when building emitted payloads.
    this.mainBuffer = Buffer.alloc(0);

    // Separate analysis buffer so we can evaluate VAD frame-by-frame.
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

    // Append incoming raw PCM to the main payload buffer.
    this.mainBuffer = Buffer.concat([this.mainBuffer, pcmChunk]);

    // Feed the same stream into the VAD frame analyzer.
    this.analysisPending = Buffer.concat([this.analysisPending, pcmChunk]);

    // Hard cutoff: as soon as we have >= 10 seconds, emit exactly 10 seconds.
    // This loop is intentional so oversized chunks are split cleanly without dropping stream data.
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

    // If there is no active speech, this is pure silence for VAD purposes.
    if (!this.speechActive) {
      this.stats.droppedSilenceFrames += 1;
      return;
    }

    // We were in speech and now we are seeing silence.
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

    // Critical flush: overwrite all bytes before dropping the reference.
    // This prevents stale PCM from being accidentally reused in a future payload.
    this.mainBuffer.fill(0);
    // Reinitialize to a brand-new empty Buffer so next writes start from clean memory.
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

    // Segment payload has already been copied to `segmentBuffer`, so emitting this event
    // cannot observe or mutate cleared storage from prior chunks.
    this.emit("segment", event);
  }

  emitFixedWindow(reason) {
    if (this.mainBuffer.length < this.maxBufferBytes) {
      return;
    }

    const segmentBuffer = Buffer.from(this.mainBuffer.slice(0, this.maxBufferBytes));
    const remainder = Buffer.from(this.mainBuffer.slice(this.maxBufferBytes));
    const emittedAt = Date.now();

    // Memory-clearing sequence for hard cutoff:
    // 1) Copy out exact payload window and exact remainder into independent Buffers.
    // 2) Zero out the entire previous backing store.
    // 3) Swap in a new Buffer that only contains unsent remainder bytes.
    // This guarantees sent bytes cannot leak into the next logical chunk.
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

    // Forced cutoff still emits a normal segment event. Next append continues into a new
    // main buffer containing only unsent remainder bytes from the same stream timeline.
    this.emit("segment", event);
  }

  flush(reason = "flush") {
    if (this.analysisPending.length > 0) {
      // Analysis-only tail. Clearing this prevents stale VAD state from surviving shutdown.
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
