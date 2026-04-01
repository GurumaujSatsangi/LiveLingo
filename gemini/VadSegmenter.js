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
    this.maxChunkMs = Number(options.maxChunkMs || process.env.GEMINI_MAX_CHUNK_MS || 5000);
    this.minSpeechMs = Number(options.minSpeechMs || process.env.GEMINI_MIN_CHUNK_MS || 250);

    this.frameBytes = Math.floor((this.sampleRate * this.channels * this.bytesPerSample * this.frameMs) / 1000);

    this.pending = Buffer.alloc(0);
    this.segmentBuffers = [];
    this.segmentDurationMs = 0;
    this.trailingSilenceMs = 0;
    this.segmentStartAt = 0;
    this.segmentId = 1;

    this.stats = {
      framesSeen: 0,
      segmentsEmitted: 0,
      bytesSeen: 0,
      droppedSilenceFrames: 0,
    };
  }

  processAudio(pcmChunk) {
    if (!Buffer.isBuffer(pcmChunk) || pcmChunk.length === 0) {
      return;
    }

    this.stats.bytesSeen += pcmChunk.length;
    this.pending = Buffer.concat([this.pending, pcmChunk]);

    while (this.pending.length >= this.frameBytes) {
      const frame = this.pending.slice(0, this.frameBytes);
      this.pending = this.pending.slice(this.frameBytes);
      this.processFrame(frame);
    }
  }

  processFrame(frame) {
    this.stats.framesSeen += 1;

    const energy = this.getFrameEnergy(frame);
    const hasVoice = energy >= this.energyThreshold;

    if (hasVoice) {
      if (this.segmentDurationMs === 0) {
        this.segmentStartAt = Date.now();
      }

      this.segmentBuffers.push(frame);
      this.segmentDurationMs += this.frameMs;
      this.trailingSilenceMs = 0;

      if (this.segmentDurationMs >= this.maxChunkMs) {
        this.emitSegment("max_duration");
      }
      return;
    }

    // If no active segment, drop pure silence frames.
    if (this.segmentDurationMs === 0) {
      this.stats.droppedSilenceFrames += 1;
      return;
    }

    // Keep trailing silence so Gemini receives natural pause boundaries.
    this.segmentBuffers.push(frame);
    this.segmentDurationMs += this.frameMs;
    this.trailingSilenceMs += this.frameMs;

    if (this.trailingSilenceMs >= this.silenceMs && this.segmentDurationMs >= this.minSpeechMs) {
      this.emitSegment("silence");
      return;
    }

    if (this.segmentDurationMs >= this.maxChunkMs) {
      this.emitSegment("max_duration");
    }
  }

  emitSegment(reason) {
    if (this.segmentBuffers.length === 0) {
      return;
    }

    const segmentBuffer = Buffer.concat(this.segmentBuffers);
    const event = {
      segmentId: this.segmentId,
      reason,
      buffer: segmentBuffer,
      durationMs: this.segmentDurationMs,
      frameMs: this.frameMs,
      emittedAt: Date.now(),
      startedAt: this.segmentStartAt,
    };

    this.segmentId += 1;
    this.stats.segmentsEmitted += 1;

    this.segmentBuffers = [];
    this.segmentDurationMs = 0;
    this.trailingSilenceMs = 0;
    this.segmentStartAt = 0;

    this.emit("segment", event);
  }

  flush(reason = "flush") {
    if (this.pending.length > 0) {
      this.segmentBuffers.push(this.pending);
      this.segmentDurationMs += Math.floor((this.pending.length / (this.sampleRate * this.channels * this.bytesPerSample)) * 1000);
      this.pending = Buffer.alloc(0);
    }

    if (this.segmentDurationMs >= this.minSpeechMs) {
      this.emitSegment(reason);
    }
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
      bufferedBytes: this.pending.length,
      activeSegmentMs: this.segmentDurationMs,
      frameBytes: this.frameBytes,
    };
  }
}

export default VadSegmenter;
