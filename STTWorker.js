import { EventEmitter } from 'events';

/**
 * STTWorker
 * 
 * Handles speech-to-text transcription in parallel.
 * Uses OpenAI Whisper API for transcription.
 * 
 * Can process multiple chunks concurrently while maintaining order via sequenceId.
 */
class STTWorker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.openaiClient = options.openaiClient;
    this.concurrency = options.concurrency || 2;
    this.maxRetries = options.maxRetries || 2;
    this.retryDelayMs = options.retryDelayMs || 500;
    
    // Task tracking
    this.activeTasks = new Map(); // sequenceId -> task
    this.completedResults = new Map(); // sequenceId -> result
    this.failedSequences = new Set();
    
    // Stats
    this.totalProcessed = 0;
    this.totalFailed = 0;
    
    console.log(`🎤 STTWorker initialized (concurrency: ${this.concurrency})`);
  }

  /**
   * Start transcription for a chunk
   * Returns promise that resolves when transcription is complete
   */
  async processChunk(chunk) {
    if (!this.openaiClient) {
      throw new Error('OpenAI client not configured');
    }

    const sequenceId = chunk.sequenceId;
    
    // Check if already processed
    if (this.completedResults.has(sequenceId) || this.failedSequences.has(sequenceId)) {
      return this.completedResults.get(sequenceId) || null;
    }

    // Check concurrency
    if (this.activeTasks.size >= this.concurrency) {
      throw new Error(`STT worker at max concurrency (${this.concurrency})`);
    }

    // Create transcription task
    const task = this.transcribeAudio(chunk);
    this.activeTasks.set(sequenceId, task);

    try {
      const result = await task;
      
      this.completedResults.set(sequenceId, result);
      this.activeTasks.delete(sequenceId);
      this.totalProcessed++;

      this.emit('transcription-complete', {
        sequenceId,
        text: result.text,
        language: result.language,
        confidence: result.confidence,
        duration: Date.now() - result.startTime,
      });

      console.log(
        `✅ STT chunk #${sequenceId}: "${result.text.substring(0, 60)}..."`
      );

      return result;
    } catch (error) {
      this.activeTasks.delete(sequenceId);
      this.failedSequences.add(sequenceId);
      this.totalFailed++;

      this.emit('transcription-failed', {
        sequenceId,
        error: error.message,
      });

      console.error(`❌ STT chunk #${sequenceId} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Transcribe audio buffer using OpenAI Whisper
   * With retry logic
   */
  async transcribeAudio(chunk, attemptNum = 0) {
    const startTime = Date.now();
    
    try {
      // Convert PCM buffer to WAV for Whisper API
      const wavBuffer = this.pcmToWav(chunk.buffer);

      // Create file-like object for Whisper API
      const file = new File(
        [wavBuffer],
        `chunk_${chunk.sequenceId}.wav`,
        { type: 'audio/wav' }
      );

      const transcription = await this.openaiClient.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        language: 'en', // Default to English, but model auto-detects
        temperature: 0,
      });

      const text = transcription.text || '';
      
      return {
        sequenceId: chunk.sequenceId,
        text: text.trim(),
        language: 'en', // Whisper doesn't return language reliably
        confidence: 0.95, // Whisper doesn't provide confidence
        startTime,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      // Retry with exponential backoff
      if (attemptNum < this.maxRetries) {
        const delayMs = this.retryDelayMs * Math.pow(2, attemptNum);
        console.warn(
          `⚠️  STT retry for chunk #${chunk.sequenceId} in ${delayMs}ms: ${error.message}`
        );
        
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this.transcribeAudio(chunk, attemptNum + 1);
      }

      throw error;
    }
  }

  /**
   * Convert PCM s16le to WAV format
   * Simple WAV header + PCM data
   */
  pcmToWav(pcmBuffer) {
    const sampleRate = 16000;
    const channels = 1;
    const bitDepth = 16;
    const bytesPerSample = bitDepth / 8;

    const dataSize = pcmBuffer.length;
    const fileSize = 36 + dataSize;

    // Create WAV header
    const header = Buffer.alloc(44);
    
    // RIFF header
    header.write('RIFF', 0);
    header.writeUInt32LE(fileSize, 4);
    header.write('WAVE', 8);

    // fmt subchunk
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // Subchunk1Size
    header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // ByteRate
    header.writeUInt16LE(channels * bytesPerSample, 32); // BlockAlign
    header.writeUInt16LE(bitDepth, 34); // BitsPerSample

    // data subchunk
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmBuffer]);
  }

  /**
   * Get worker statistics
   */
  getStats() {
    return {
      activeRemain: this.activeTasks.size,
      maxConcurrency: this.concurrency,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      completedCount: this.completedResults.size,
    };
  }

  /**
   * Wait for all active tasks to complete
   */
  async drain() {
    const tasks = Array.from(this.activeTasks.values());
    
    if (tasks.length === 0) {
      return;
    }

    console.log(`⏳ Waiting for ${tasks.length} STT tasks to complete...`);
    
    try {
      await Promise.allSettled(tasks);
    } catch (err) {
      console.error(`⚠️  Error draining STT tasks: ${err.message}`);
    }
  }

  /**
   * Stop worker
   */
  async stop() {
    await this.drain();
    this.activeTasks.clear();
    console.log('⏹️  STTWorker stopped');
  }
}

export default STTWorker;
