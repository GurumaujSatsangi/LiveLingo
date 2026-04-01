import { EventEmitter } from 'events';

/**
 * VoiceActivityDetector (VAD with Silence Detection)
 * 
 * Segments audio based on voice activity and silence pauses.
 * Emits chunks when silence is detected or max duration is reached.
 * Provides natural segmentation aligned with speech patterns.
 */
class VoiceActivityDetector extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.sampleRate = options.sampleRate || 16000;
    this.channels = options.channels || 1;
    this.bytesPerSample = 2; // 16-bit = 2 bytes
    
    // VAD parameters for silence detection
    this.energyThreshold = options.energyThreshold || 0.02; // Energy level to detect voice
    this.silenceDurationMs = options.silenceDurationMs || 400; // Silence timeout before emit
    this.minChunkDurationMs = options.minChunkDurationMs || 500; // Min chunk duration (OPTIMIZED)
    this.maxChunkDurationMs = options.maxChunkDurationMs || 800; // Max chunk duration before force emit (OPTIMIZED)
    this.forceFallbackTimerMs = options.forceFallbackTimerMs || 500; // Force emit timer for micro-batching
    
    // Frame-based processing
    this.frameSize = options.frameSize || 512; // samples per frame (32ms @ 16kHz)
    const frameSizeBytes = this.frameSize * this.bytesPerSample;
    
    // Internal state
    this.accumulatingBuffer = Buffer.alloc(0);
    this.chunkStartTime = null;
    this.silenceStartTime = null;
    this.lastEmitTime = null; // Track timer for force-emit fallback
    this.sequenceId = 0;
    
    // Stats
    this.bytesProcessed = 0;
    this.chunksEmitted = 0;
    this.framesProcessed = 0;
    
    console.log(
      `🎙️  VoiceActivityDetector initialized (VAD: silence=${this.silenceDurationMs}ms, ` +
      `force_emit=${this.forceFallbackTimerMs}ms, max=${this.maxChunkDurationMs}ms, ` +
      `energy_threshold=${this.energyThreshold}, frame=${this.frameSize})`
    );
  }

  /**
   * Process incoming audio data (PCM s16le)
   * Accumulate and process in frame chunks for VAD
   */
  processAudio(audioChunk) {
    if (!Buffer.isBuffer(audioChunk) || audioChunk.length === 0) {
      return;
    }

    // Add to accumulator
    this.accumulatingBuffer = Buffer.concat([
      this.accumulatingBuffer,
      audioChunk,
    ]);

    this.bytesProcessed += audioChunk.length;

    const frameSizeBytes = this.frameSize * this.bytesPerSample;

    // Process available complete frames
    while (this.accumulatingBuffer.length >= frameSizeBytes) {
      const frameBuffer = this.accumulatingBuffer.slice(0, frameSizeBytes);
      this.accumulatingBuffer = this.accumulatingBuffer.slice(frameSizeBytes);

      this.processFrame(frameBuffer);
    }
  }

  /**
   * Analyze a single frame and detect voice activity
   */
  processFrame(frameBuffer) {
    const now = Date.now();
    
    if (!this.chunkStartTime) {
      this.chunkStartTime = now;
    }

    const energy = this.calculateEnergy(frameBuffer);
    const hasVoice = energy > this.energyThreshold;

    if (hasVoice) {
      // Voice detected - reset silence timer
      this.silenceStartTime = null;
    } else {
      // Silence detected
      if (this.silenceStartTime === null) {
        this.silenceStartTime = now;
      }
    }

    const chunkDuration = now - this.chunkStartTime;
    const silenceDuration = this.silenceStartTime ? now - this.silenceStartTime : 0;
    const timeSinceLastEmit = this.lastEmitTime ? now - this.lastEmitTime : chunkDuration;

    // Emit chunk if:
    // 1. Silence long enough AND chunk has min duration (natural pause detection)
    // 2. OR time-based fallback (force emit for micro-batching)
    // 3. OR chunk exceeds max duration (hard limit)
    if (
      (silenceDuration >= this.silenceDurationMs && chunkDuration >= this.minChunkDurationMs) ||
      timeSinceLastEmit >= this.forceFallbackTimerMs ||
      chunkDuration >= this.maxChunkDurationMs
    ) {
      this.emitChunk(now);
    }

    this.framesProcessed++;
  }

  /**
   * Calculate energy level of audio frame (0-1 normalized)
   */
  calculateEnergy(frameBuffer) {
    let sum = 0;
    const sampleCount = frameBuffer.length / 2; // 16-bit samples

    for (let i = 0; i < frameBuffer.length; i += 2) {
      // Read 16-bit signed integer (little-endian)
      const sample = frameBuffer.readInt16LE(i);
      sum += Math.abs(sample);
    }

    const average = sum / sampleCount;
    // Normalize to 0-1 range (16-bit max is 32768)
    return average / 32768;
  }

  /**
   * Force flush any pending audio
   */
  flush() {
    if (this.accumulatingBuffer.length > 0) {
      const chunk = {
        sequenceId: this.sequenceId++,
        buffer: Buffer.from(this.accumulatingBuffer),
        timestamp: Date.now(),
        startTime: this.chunkStartTime || Date.now(),
        endTime: Date.now(),
        durationMs: (Date.now() - (this.chunkStartTime || Date.now())),
        sampleCount: this.accumulatingBuffer.length / 2,
      };

      this.emit('chunk', chunk);
      this.chunksEmitted++;

      this.accumulatingBuffer = Buffer.alloc(0);
      this.chunkStartTime = null;
      this.silenceStartTime = null;

      console.log(
        `📦 VAD flush chunk #${chunk.sequenceId}: ${chunk.durationMs}ms`
      );
    }
  }

  /**
   * Emit accumulated chunk and reset state
   */
  emitChunk(timestamp) {
    const chunkBuffer = Buffer.from(this.accumulatingBuffer);
    
    if (chunkBuffer.length === 0) {
      return;
    }

    const duration = timestamp - this.chunkStartTime;
    const bufferSize = this.accumulatingBuffer.length;

    const chunk = {
      sequenceId: this.sequenceId++,
      buffer: chunkBuffer,
      durationMs: duration,
      timestamp,
      startTime: this.chunkStartTime,
      endTime: timestamp,
      bytes: bufferSize,
    };

    this.emit('chunk', chunk);
    this.chunksEmitted++;

    // Reset state for next chunk
    this.accumulatingBuffer = Buffer.alloc(0);
    this.chunkStartTime = null;
    this.silenceStartTime = null;

    console.log(
      `📦 VAD chunk #${chunk.sequenceId}: ${chunk.durationMs}ms, ${chunk.bytes} bytes`
    );
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      framesProcessed: this.framesProcessed,
      chunksEmitted: this.chunksEmitted,
      bytesProcessed: this.bytesProcessed,
      pendingBufferSize: this.accumulatingBuffer.length,
      activePendingChunkMs: this.chunkStartTime ? Date.now() - this.chunkStartTime : 0,
    };
  }
}

export default VoiceActivityDetector;
