import { EventEmitter } from 'events';

/**
 * ParallelPipeline
 * 
 * Orchestrates parallel processing: STT → Translation → TTS
 * 
 * Key responsibilities:
 * - Dispatch chunks to workers concurrently
 * - Maintain ordering via sequenceId
 * - Buffer results and emit in order
 * - Handle backpressure and timeouts
 */
class ParallelPipeline extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.sttWorker = options.sttWorker;
    this.translationWorker = options.translationWorker;
    this.ttsWorker = options.ttsWorker;
    this.queue = options.queue;
    this.latencyMonitor = options.latencyMonitor;
    
    // Ordering buffers
    this.sttResults = new Map(); // sequenceId -> result
    this.translationResults = new Map(); // sequenceId -> result
    this.ttsResults = new Map(); // sequenceId -> result
    
    // Progress tracking
    this.nextExpectedSeqId = 1;
    this.highestSeenSeqId = 0;
    
    // Config
    this.maxQueueDepth = options.maxQueueDepth || 20;
    this.orderingTimeoutMs = options.orderingTimeoutMs || 10000;
    
    // Stats
    this.pipelineStats = {
      chunksReceived: 0,
      chunksCompleted: 0,
      chunksFailed: 0,
    };
    
    // Processing loop
    this.isRunning = false;
    this.processingTimer = null;
    this.checkIntervalMs = options.checkIntervalMs || 100; // Check every 100ms
    
    console.log('⚙️  ParallelPipeline initialized');
  }

  /**
   * Start processing pipeline
   */
  start() {
    if (this.isRunning) {
      console.log('⏳ Pipeline already running');
      return;
    }

    console.log('🚀 Starting parallel pipeline...');
    this.isRunning = true;
    this.processingTimer = setInterval(() => {
      this.process().catch((err) => {
        console.error(`❌ Pipeline processing error: ${err.message}`);
      });
    }, this.checkIntervalMs);

    this.emit('started');
  }

  /**
   * Stop processing pipeline
   */
  async stop() {
    console.log('⏹️  Stopping pipeline...');
    
    this.isRunning = false;
    
    if (this.processingTimer) {
      clearInterval(this.processingTimer);
      this.processingTimer = null;
    }

    // Wait for all workers to drain
    if (this.sttWorker) await this.sttWorker.drain();
    if (this.translationWorker) await this.translationWorker.drain();
    if (this.ttsWorker) await this.ttsWorker.drain();

    this.emit('stopped');
  }

  /**
   * Main processing loop
   * - Dequeue chunks and dispatch to STT
   * - Monitor STT→Translation→TTS flow
   * - Emit ordered results
   */
  async process() {
    if (!this.isRunning) {
      return;
    }

    // Step 1: Dispatch queued chunks to STT
    this.dispatchToStt();

    // Step 2: Monitor post-STT flow and dispatch
    await this.monitorAndDispatch();

    // Step 3: Emit results in order
    this.emitOrderedResults();
  }

  /**
   * Dequeue chunks from queue and send to STT
   */
  dispatchToStt() {
    try {
      while (
        this.sttWorker &&
        this.sttWorker.getStats().activeRemain < this.sttWorker.concurrency &&
        this.queue.getDepth() > 0
      ) {
        const chunk = this.queue.dequeue();
        if (!chunk) break;

        this.pipelineStats.chunksReceived++;
        this.highestSeenSeqId = Math.max(this.highestSeenSeqId, chunk.sequenceId);

        if (this.latencyMonitor) {
          this.latencyMonitor.recordQueueEntry(chunk.sequenceId, Date.now());
          this.latencyMonitor.recordSttStart(chunk.sequenceId, Date.now());
        }

        // Fire and forget STT processing
        this.sttWorker
          .processChunk(chunk)
          .then((result) => {
            if (this.latencyMonitor) {
              this.latencyMonitor.recordSttComplete(chunk.sequenceId, Date.now());
            }
            this.sttResults.set(result.sequenceId, result);
          })
          .catch((error) => {
            this.queue.markFailed(chunk.sequenceId, error, true);
            console.error(`❌ STT failed for chunk #${chunk.sequenceId}: ${error.message}`);
          });
      }
    } catch (err) {
      console.error(`⚠️  Error dispatching to STT: ${err.message}`);
    }
  }

  /**
   * Monitor STT results and dispatch to Translation
   * Then Translation results to TTS
   */
  async monitorAndDispatch() {
    try {
      // Check for completed STT results
      for (const [seqId, sttResult] of this.sttResults.entries()) {
        // Skip if already dispatched to translation
        if (this.translationResults.has(seqId)) {
          continue;
        }

        // Check translation worker capacity
        if (
          this.translationWorker &&
          this.translationWorker.getStats().activeRemain >= this.translationWorker.concurrency
        ) {
          break;
        }

        // Dispatch to translation
        this.sttResults.delete(seqId);
        
        this.translationWorker
          .processChunk(sttResult)
          .then((result) => {
            if (this.latencyMonitor) {
              this.latencyMonitor.recordTranslation(
                seqId,
                Date.now() - result.duration,
                Date.now()
              );
            }
            this.translationResults.set(result.sequenceId, result);
          })
          .catch((error) => {
            console.error(`❌ Translation failed for chunk #${seqId}: ${error.message}`);
          });
      }

      // Check for completed Translation results
      for (const [seqId, translationResult] of this.translationResults.entries()) {
        // Skip if already dispatched to TTS
        if (this.ttsResults.has(seqId)) {
          continue;
        }

        // Check TTS worker capacity
        if (
          this.ttsWorker &&
          this.ttsWorker.getStats().activeRemain >= this.ttsWorker.concurrency
        ) {
          break;
        }

        // Dispatch to TTS
        this.translationResults.delete(seqId);
        
        this.ttsWorker
          .processChunk(translationResult)
          .then((result) => {
            if (this.latencyMonitor) {
              this.latencyMonitor.recordTts(
                seqId,
                Date.now() - result.duration,
                Date.now()
              );
            }
            this.ttsResults.set(result.sequenceId, result);
          })
          .catch((error) => {
            console.error(`❌ TTS failed for chunk #${seqId}: ${error.message}`);
          });
      }
    } catch (err) {
      console.error(`⚠️  Error monitoring dispatch: ${err.message}`);
    }
  }

  /**
   * Emit TTS results in sequenceId order
   */
  emitOrderedResults() {
    try {
      while (this.ttsResults.has(this.nextExpectedSeqId)) {
        const result = this.ttsResults.get(this.nextExpectedSeqId);
        this.ttsResults.delete(this.nextExpectedSeqId);

        if (this.latencyMonitor) {
          this.latencyMonitor.recordStreamTime(this.nextExpectedSeqId, Date.now());
        }

        this.emit('audio-ready', {
          sequenceId: this.nextExpectedSeqId,
          audioBuffer: result.audioBuffer,
          provider: result.provider,
        });

        this.queue.markSuccess(this.nextExpectedSeqId);
        this.pipelineStats.chunksCompleted++;

        console.log(`🎵 Pipeline output chunk #${this.nextExpectedSeqId} ready`);

        this.nextExpectedSeqId++;
      }
    } catch (err) {
      console.error(`⚠️  Error emitting ordered results: ${err.message}`);
    }
  }

  /**
   * Get pipeline statistics
   */
  getStats() {
    return {
      ...this.pipelineStats,
      queueDepth: this.queue?.getDepth() || 0,
      sttBuffered: this.sttResults.size,
      translationBuffered: this.translationResults.size,
      ttsBuffered: this.ttsResults.size,
      nextExpectedSeqId: this.nextExpectedSeqId,
      highestSeenSeqId: this.highestSeenSeqId,
      sttStats: this.sttWorker?.getStats(),
      translationStats: this.translationWorker?.getStats(),
      ttsStats: this.ttsWorker?.getStats(),
    };
  }

  /**
   * Log detailed pipeline status
   */
  logStatus() {
    const stats = this.getStats();
    
    console.log('\n📊 ===== PIPELINE STATUS =====');
    console.log(`Received: ${stats.chunksReceived}, Completed: ${stats.chunksCompleted}, Failed: ${stats.chunksFailed}`);
    console.log(`Queue depth: ${stats.queueDepth}/${this.maxQueueDepth}`);
    console.log(`Buffered - STT: ${stats.sttBuffered}, Translation: ${stats.translationBuffered}, TTS: ${stats.ttsBuffered}`);
    console.log(`Next expected: #${stats.nextExpectedSeqId}, Highest seen: #${stats.highestSeenSeqId}`);
    console.log(`STT: ${stats.sttStats?.activeRemain}/${stats.sttStats?.maxConcurrency} active`);
    console.log(`Translation: ${stats.translationStats?.activeRemain}/${stats.translationStats?.maxConcurrency} active`);
    console.log(`TTS: ${stats.ttsStats?.activeRemain}/${stats.ttsStats?.maxConcurrency} active`);
    console.log('==============================\n');
  }
}

export default ParallelPipeline;
