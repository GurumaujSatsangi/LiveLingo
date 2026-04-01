import { EventEmitter } from 'events';

/**
 * TranslationWorker
 * 
 * Handles text translation with context awareness.
 * Maintains rolling context from recent transcriptions.
 * 
 * Targets: Hindi, Tamil, Bangla (via Sarvam or OpenAI)
 */
class TranslationWorker extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.sarvamClient = options.sarvamClient;
    this.openaiClient = options.openaiClient;
    this.targetLanguage = options.targetLanguage || 'hi-IN'; // Default Hindi
    this.concurrency = options.concurrency || 3;
    this.contextWindowSize = options.contextWindowSize || 5; // Keep last 5 texts for context
    this.maxRetries = options.maxRetries || 2;
    this.retryDelayMs = options.retryDelayMs || 500;
    
    // Task tracking
    this.activeTasks = new Map(); // sequenceId -> task
    this.completedResults = new Map(); // sequenceId -> result
    this.failedSequences = new Set();
    
    // Context
    this.recentTranscripts = []; // Circular buffer of recent text
    
    // Stats
    this.totalProcessed = 0;
    this.totalFailed = 0;
    
    const langName = this.getLanguageName(this.targetLanguage);
    console.log(`🌐 TranslationWorker initialized (language: ${langName}, concurrency: ${this.concurrency})`);
  }

  /**
   * Get human-readable language name
   */
  getLanguageName(langCode) {
    const names = {
      'hi-IN': 'Hindi',
      'ta-IN': 'Tamil',
      'bn-IN': 'Bangla',
    };
    return names[langCode] || langCode;
  }

  /**
   * Process translation for a chunk
   */
  async processChunk(transcriptionResult) {
    const sequenceId = transcriptionResult.sequenceId;
    
    // Check if already processed
    if (this.completedResults.has(sequenceId) || this.failedSequences.has(sequenceId)) {
      return this.completedResults.get(sequenceId) || null;
    }

    // Check concurrency
    if (this.activeTasks.size >= this.concurrency) {
      throw new Error(`Translation worker at max concurrency (${this.concurrency})`);
    }

    // Update context
    this.addToContext(transcriptionResult.text);

    // Create translation task
    const task = this.translateText(transcriptionResult.text, sequenceId);
    this.activeTasks.set(sequenceId, task);

    try {
      const result = await task;
      
      this.completedResults.set(sequenceId, result);
      this.activeTasks.delete(sequenceId);
      this.totalProcessed++;

      this.emit('translation-complete', {
        sequenceId,
        originalText: transcriptionResult.text,
        translatedText: result.text,
        targetLanguage: this.targetLanguage,
        duration: Date.now() - result.startTime,
      });

      console.log(
        `✅ Translation chunk #${sequenceId}: "${result.text.substring(0, 60)}..."`
      );

      return result;
    } catch (error) {
      this.activeTasks.delete(sequenceId);
      this.failedSequences.add(sequenceId);
      this.totalFailed++;

      this.emit('translation-failed', {
        sequenceId,
        error: error.message,
      });

      console.error(`❌ Translation chunk #${sequenceId} failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Translate text to target language with context
   */
  async translateText(text, sequenceId, attemptNum = 0) {
    const startTime = Date.now();
    
    try {
      // Build context string from recent transcripts
      const contextStr = this.recentTranscripts.slice(0, -1).join(' ');
      const prompt = contextStr 
        ? `Previous context: "${contextStr}"\n\nTranslate the following English text to ${this.getLanguageName(this.targetLanguage)}:\n"${text}"`
        : `Translate the following English text to ${this.getLanguageName(this.targetLanguage)}:\n"${text}"`;

      let translatedText;

      // Try Sarvam first if available, fallback to OpenAI
      if (this.sarvamClient) {
        translatedText = await this.translateViaSarvam(text);
      } else if (this.openaiClient) {
        translatedText = await this.translateViaOpenAI(text);
      } else {
        throw new Error('No translation service configured');
      }

      return {
        sequenceId,
        text: translatedText,
        targetLanguage: this.targetLanguage,
        hasContext: contextStr.length > 0,
        startTime,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      // Retry with exponential backoff
      if (attemptNum < this.maxRetries) {
        const delayMs = this.retryDelayMs * Math.pow(2, attemptNum);
        console.warn(
          `⚠️  Translation retry for chunk #${sequenceId} in ${delayMs}ms: ${error.message}`
        );
        
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this.translateText(text, sequenceId, attemptNum + 1);
      }

      throw error;
    }
  }

  /**
   * Translate via Sarvam AI
   */
  async translateViaSarvam(text) {
    try {
      const response = await this.sarvamClient.text.translate({
        input: text,
        source_language_code: 'en-IN',
        target_language_code: this.targetLanguage,
        model: 'sarvam-translate:v1',
      });

      return response.translated_text || text;
    } catch (err) {
      console.warn(`⚠️  Sarvam translation failed, trying OpenAI: ${err.message}`);
      
      if (this.openaiClient) {
        return this.translateViaOpenAI(text);
      }
      
      throw err;
    }
  }

  /**
   * Translate via OpenAI GPT
   */
  async translateViaOpenAI(text) {
    const langName = this.getLanguageName(this.targetLanguage);
    
    const response = await this.openaiClient.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: `You are a professional translator. Translate English text to ${langName}. Preserve tone and style. Reply ONLY with the translation, no explanations.`,
        },
        {
          role: 'user',
          content: text,
        },
      ],
      temperature: 0.3,
      max_tokens: 500,
    });

    return response.choices[0]?.message?.content || text;
  }

  /**
   * Add text to context window
   */
  addToContext(text) {
    this.recentTranscripts.push(text);
    
    // Keep only last contextWindowSize -entries
    if (this.recentTranscripts.length > this.contextWindowSize) {
      this.recentTranscripts.shift();
    }
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
      contextSize: this.recentTranscripts.length,
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

    console.log(`⏳ Waiting for ${tasks.length} translation tasks to complete...`);
    
    try {
      await Promise.allSettled(tasks);
    } catch (err) {
      console.error(`⚠️  Error draining translation tasks: ${err.message}`);
    }
  }

  /**
   * Stop worker
   */
  async stop() {
    await this.drain();
    this.activeTasks.clear();
    console.log('⏹️  TranslationWorker stopped');
  }
}

export default TranslationWorker;
