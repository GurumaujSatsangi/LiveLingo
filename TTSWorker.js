import { EventEmitter } from 'events';

/**
 * TTSWorker
 * 
 * Handles text-to-speech conversion.
 * Supports ElevenLabs (premium) and Sarvam (Indian languages).
 * Processes multiple chunks concurrently.
 */
class TTSWorker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.elevenlabsClient = options.elevenlabsClient;
    this.sarvamClient = options.sarvamClient;
    this.targetLanguage = options.targetLanguage || 'hi-IN';
    this.concurrency = options.concurrency || 2;
    this.maxRetries = options.maxRetries || 2;
    this.retryDelayMs = options.retryDelayMs || 1000;
    
    // ElevenLabs config
    this.elevenlabsVoiceId = options.elevenlabsVoiceId || 'JBFqnCBsd6RMkjVDRZzb';
    this.elevenlabsModelId = options.elevenlabsModelId || 'eleven_multilingual_v2';
    
    // Sarvam config
    this.sarvamSpeaker = options.sarvamSpeaker || 'karun';
    this.sarvamModel = options.sarvamModel || 'bulbul:v2';
    
    // Task tracking
    this.activeTasks = new Map(); // sequenceId -> task
    this.completedResults = new Map(); // sequenceId -> result
    this.failedSequences = new Set();
    
    // Stats
    this.totalProcessed = 0;
    this.totalFailed = 0;
    
    console.log(`🔊 TTSWorker initialized (language: ${this.targetLanguage}, concurrency: ${this.concurrency})`);
  }

  /**
   * Process TTS for translated text
   */
  async processChunk(translationResult) {
    const sequenceId = translationResult.sequenceId;
    
    // Check if already processed
    if (this.completedResults.has(sequenceId) || this.failedSequences.has(sequenceId)) {
      return this.completedResults.get(sequenceId) || null;
    }

    // Check concurrency
    if (this.activeTasks.size >= this.concurrency) {
      throw new Error(`TTS worker at max concurrency (${this.concurrency})`);
    }

    // Create TTS task
    const task = this.synthesizeAudio(translationResult.text, sequenceId);
    this.activeTasks.set(sequenceId, task);

    try {
      const result = await task;
      
      this.completedResults.set(sequenceId, result);
      this.activeTasks.delete(sequenceId);
      this.totalProcessed++;

      this.emit('tts-complete', {
        sequenceId,
        audioBufferSize: result.audioBuffer.length,
        durationEstimateMs: result.durationEstimateMs,
        provider: result.provider,
        duration: Date.now() - result.startTime,
      });

      console.log(
        `✅ TTS chunk #${sequenceId}: ${result.audioBuffer.length} bytes (${result.provider})`
      );

      return result;
    } catch (error) {
      this.activeTasks.delete(sequenceId);
      this.failedSequences.add(sequenceId);
      this.totalFailed++;

      this.emit('tts-failed', {
        sequenceId,
        error: error.message,
      });

      console.error(`❌ TTS chunk #${sequenceId} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Synthesize audio from text
   */
  async synthesizeAudio(text, sequenceId, attemptNum = 0) {
    const startTime = Date.now();
    
    try {
      if (!text || text.trim().length === 0) {
        throw new Error('Empty text for TTS');
      }

      // Prefer ElevenLabs for higher quality, fallback to Sarvam
      let audioBuffer;
      let provider;

      if (this.elevenlabsClient) {
        try {
          audioBuffer = await this.synthesizeViaElevenLabs(text);
          provider = 'ElevenLabs';
        } catch (err) {
          console.warn(`⚠️  ElevenLabs TTS failed, trying Sarvam: ${err.message}`);
          
          if (this.sarvamClient) {
            audioBuffer = await this.synthesizeViaSarvam(text);
            provider = 'Sarvam';
          } else {
            throw err;
          }
        }
      } else if (this.sarvamClient) {
        audioBuffer = await this.synthesizeViaSarvam(text);
        provider = 'Sarvam';
      } else {
        throw new Error('No TTS service configured');
      }

      if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error('TTS returned empty audio buffer');
      }

      // Estimate duration from audio size (PCM 16kHz mono)
      const durationEstimateMs = (audioBuffer.length / 32000) * 1000;

      return {
        sequenceId,
        audioBuffer,
        provider,
        durationEstimateMs,
        startTime,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      // Retry with exponential backoff
      if (attemptNum < this.maxRetries) {
        const delayMs = this.retryDelayMs * Math.pow(2, attemptNum);
        console.warn(
          `⚠️  TTS retry for chunk #${sequenceId} in ${delayMs}ms: ${error.message}`
        );
        
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this.synthesizeAudio(text, sequenceId, attemptNum + 1);
      }

      throw error;
    }
  }

  /**
   * Synthesize via ElevenLabs
   */
  async synthesizeViaElevenLabs(text) {
    // ElevenLabs v3 API - text to speech
    const response = await this.elevenlabsClient.textToSpeech.convertAsStream({
      text,
      voice_id: this.elevenlabsVoiceId,
      model_id: this.elevenlabsModelId,
      output_format: 'pcm_16000', // 16kHz PCM
    });

    // Collect stream into buffer
    const chunks = [];
    for await (const chunk of response) {
      if (Buffer.isBuffer(chunk)) {
        chunks.push(chunk);
      }
    }

    return Buffer.concat(chunks);
  }

  /**
   * Synthesize via Sarvam AI
   */
  async synthesizeViaSarvam(text) {
    const response = await this.sarvamClient.textToSpeech.convert({
      text,
      target_language_code: this.targetLanguage,
      speaker: this.sarvamSpeaker,
      model: this.sarvamModel,
      speech_sample_rate: 16000,
      output_audio_codec: 'wav', // Sarvam returns WAV
    });

    const audioChunks = Array.isArray(response?.audios) ? response.audios : [];
    const firstAudio = audioChunks.find((entry) => typeof entry === 'string' && entry.length > 0);

    if (!firstAudio) {
      throw new Error('Sarvam TTS returned no audio data');
    }

    const wavBuffer = Buffer.from(firstAudio, 'base64');
    
    // Convert WAV to PCM (skip WAV header)
    const pcmBuffer = this.extractPcmFromWav(wavBuffer);
    return pcmBuffer;
  }

  /**
   * Extract PCM data from WAV file
   * Assumes standard WAV format
   */
  extractPcmFromWav(wavBuffer) {
    if (wavBuffer.length < 44) {
      throw new Error('Invalid WAV file (too short)');
    }

    // Find 'data' subchunk
    let dataOffset = 36;
    
    while (dataOffset < wavBuffer.length - 8) {
      if (wavBuffer.toString('utf8', dataOffset, dataOffset + 4) === 'data') {
        const dataSize = wavBuffer.readUInt32LE(dataOffset + 4);
        return wavBuffer.slice(dataOffset + 8, dataOffset + 8 + dataSize);
      }
      dataOffset += 4 + wavBuffer.readUInt32LE(dataOffset + 4);
    }

    // If 'data' chunk not found, return everything after standard header
    return wavBuffer.slice(44);
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

    console.log(`⏳ Waiting for ${tasks.length} TTS tasks to complete...`);
    
    try {
      await Promise.allSettled(tasks);
    } catch (err) {
      console.error(`⚠️  Error draining TTS tasks: ${err.message}`);
    }
  }

  /**
   * Stop worker
   */
  async stop() {
    await this.drain();
    this.activeTasks.clear();
    console.log('⏹️  TTSWorker stopped');
  }
}

export default TTSWorker;
