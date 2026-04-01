import { EventEmitter } from 'events';

/**
 * AudioMixer
 * 
 * Mixes original audio (with volume ducking) with translated TTS output.
 * Handles real-time PCM mixing for seamless audio blending.
 */
class AudioMixer extends EventEmitter {
  constructor(options = {}) {
    super();

    this.sampleRate = options.sampleRate || 16000;
    this.bytesPerSample = 2; // 16-bit
    this.originalVolumeScale = options.originalVolumeScale || 0.5; // Reduce original to 50%
    this.translatedVolumeScale = options.translatedVolumeScale || 1.0; // Full translated volume

    // Buffer management for sync
    this.originalBuffer = Buffer.alloc(0);
    this.translatedBuffer = Buffer.alloc(0);
    this.maxBufferSize = options.maxBufferSize || 160000; // ~5 seconds at 16kHz

    // Stats
    this.samplesProcessed = 0;
    this.samplesDropped = 0;

    console.log(
      `🎵 AudioMixer initialized (original: ${(this.originalVolumeScale * 100).toFixed(0)}%, ` +
      `translated: ${(this.translatedVolumeScale * 100).toFixed(0)}%)`
    );
  }

  /**
   * Receive original audio data
   */
  addOriginalAudio(audioBuffer) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      return;
    }

    // Buffer management - drop old data if buffer exceeds max size
    this.originalBuffer = Buffer.concat([this.originalBuffer, audioBuffer]);

    if (this.originalBuffer.length > this.maxBufferSize) {
      const excess = this.originalBuffer.length - this.maxBufferSize;
      this.samplesDropped += excess / this.bytesPerSample;
      this.originalBuffer = this.originalBuffer.slice(excess);
    }
  }

  /**
   * Receive translated (TTS) audio data
   */
  addTranslatedAudio(audioBuffer) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      return;
    }

    // Buffer management
    this.translatedBuffer = Buffer.concat([this.translatedBuffer, audioBuffer]);

    if (this.translatedBuffer.length > this.maxBufferSize) {
      const excess = this.translatedBuffer.length - this.maxBufferSize;
      this.samplesDropped += excess / this.bytesPerSample;
      this.translatedBuffer = this.translatedBuffer.slice(excess);
    }
  }

  /**
   * Mix available audio from both buffers
   * Returns mixed audio buffer
   */
  mixAudio() {
    // Determine the minimum available length
    const minLength = Math.min(this.originalBuffer.length, this.translatedBuffer.length);

    if (minLength === 0) {
      return Buffer.alloc(0);
    }

    // Create output buffer
    const outputBuffer = Buffer.alloc(minLength);

    // Mix sample by sample
    for (let i = 0; i < minLength; i += this.bytesPerSample) {
      // Read 16-bit samples
      const originalSample = this.originalBuffer.readInt16LE(i);
      const translatedSample = this.translatedBuffer.readInt16LE(i);

      // Apply volume scaling and mix
      const scaledOriginal = Math.round(originalSample * this.originalVolumeScale);
      const scaledTranslated = Math.round(translatedSample * this.translatedVolumeScale);
      const mixedSample = scaledOriginal + scaledTranslated;

      // Clipping to prevent overflow (16-bit limits)
      const clipped = Math.max(-32768, Math.min(32767, mixedSample));

      // Write mixed sample back
      outputBuffer.writeInt16LE(clipped, i);
    }

    // Remove consumed data from buffers
    this.originalBuffer = this.originalBuffer.slice(minLength);
    this.translatedBuffer = this.translatedBuffer.slice(minLength);

    // Update stats
    this.samplesProcessed += minLength / this.bytesPerSample;

    return outputBuffer;
  }

  /**
   * Get current buffer depths
   */
  getBufferDepth() {
    return {
      originalSamples: this.originalBuffer.length / this.bytesPerSample,
      translatedSamples: this.translatedBuffer.length / this.bytesPerSample,
      originalMs: (this.originalBuffer.length / this.bytesPerSample / this.sampleRate) * 1000,
      translatedMs: (this.translatedBuffer.length / this.bytesPerSample / this.sampleRate) * 1000,
    };
  }

  /**
   * Clear all buffers
   */
  flush() {
    this.originalBuffer = Buffer.alloc(0);
    this.translatedBuffer = Buffer.alloc(0);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      samplesProcessed: this.samplesProcessed,
      samplesDropped: this.samplesDropped,
      originalBuffer: this.getBufferDepth().originalSamples,
      translatedBuffer: this.getBufferDepth().translatedSamples,
      originalVolumeScale: this.originalVolumeScale,
      translatedVolumeScale: this.translatedVolumeScale,
    };
  }

  /**
   * Set volume scales dynamically
   */
  setVolumeScales(originalScale, translatedScale) {
    this.originalVolumeScale = Math.max(0, Math.min(1, originalScale));
    this.translatedVolumeScale = Math.max(0, Math.min(1, translatedScale));
    console.log(
      `🔊 AudioMixer volume updated: original=${(this.originalVolumeScale * 100).toFixed(0)}%, ` +
      `translated=${(this.translatedVolumeScale * 100).toFixed(0)}%`
    );
  }
}

export default AudioMixer;
