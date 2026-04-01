import { EventEmitter } from 'events';

/**
 * ProcessingQueue
 * 
 * Event-driven, in-memory queue for audio chunks.
 * Replaces file-based polling (400ms interval).
 * 
 * Features:
 * - FIFO ordering with sequence tracking
 * - Backpressure handling (max queue size)
 * - Priority support (urgent chunks)
 * - Automatic timeout/retry cleanup
 */
class ProcessingQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.maxQueueSize = options.maxQueueSize || 50;
    this.chunkTimeoutMs = options.chunkTimeoutMs || 30000; // 30s max processing time
    this.cleanupIntervalMs = options.cleanupIntervalMs || 5000; // Cleanup every 5s
    
    // Queue storage
    this.queue = []; // Array of { chunk, state, enqueuedTime, attempts }
    this.processingMap = new Map(); // sequenceId -> processing state
    this.completedSet = new Set(); // Track completed chunks to avoid duplicates
    
    // Stats
    this.totalEnqueued = 0;
    this.totalProcessed = 0;
    this.totalFailed = 0;
    
    // Cleanup timer
    this.cleanupTimer = null;
    
    console.log('📋 ProcessingQueue initialized');
  }

  /**
   * Enqueue a chunk for processing
   */
  enqueue(chunk, options = {}) {
    // Check if already processed
    if (this.completedSet.has(chunk.sequenceId)) {
      console.warn(`⚠️  Duplicate chunk #${chunk.sequenceId} ignored`);
      return false;
    }

    // Check queue capacity
    if (this.queue.length >= this.maxQueueSize) {
      console.warn(`⚠️  Queue full (${this.queue.length}/${this.maxQueueSize}), dropping oldest chunk`);
      const dropped = this.queue.shift();
      this.completedSet.add(dropped.chunk.sequenceId);
      this.totalFailed++;
    }

    const item = {
      chunk,
      state: options.priority ? 'priority' : 'pending',
      enqueuedTime: Date.now(),
      attempts: 0,
      priority: options.priority || 0,
    };

    // Insert based on priority (higher priority first)
    if (options.priority) {
      let inserted = false;
      for (let i = 0; i < this.queue.length; i++) {
        if (this.queue[i].priority < options.priority) {
          this.queue.splice(i, 0, item);
          inserted = true;
          break;
        }
      }
      if (!inserted) {
        this.queue.push(item);
      }
    } else {
      this.queue.push(item);
    }

    this.processingMap.set(chunk.sequenceId, {
      state: 'queued',
      enqueuedTime: Date.now(),
    });

    this.totalEnqueued++;

    if (!this.cleanupTimer) {
      this.startCleanupTimer();
    }

    this.emit('chunk-enqueued', chunk.sequenceId);
    console.log(
      `✅ Chunk #${chunk.sequenceId} enqueued (queue size: ${this.queue.length}/${this.maxQueueSize})`
    );

    return true;
  }

  /**
   * Dequeue next chunk for processing
   */
  dequeue() {
    if (this.queue.length === 0) {
      return null;
    }

    const item = this.queue.shift();
    item.state = 'processing';
    item.attempts++;

    this.processingMap.set(item.chunk.sequenceId, {
      state: 'processing',
      enqueuedTime: item.enqueuedTime,
      dequeueTime: Date.now(),
      attempts: item.attempts,
    });

    console.log(
      `🔄 Dequeued chunk #${item.chunk.sequenceId} (attempt ${item.attempts}, queue depth: ${this.queue.length})`
    );

    return item.chunk;
  }

  /**
   * Mark chunk as successfully processed
   */
  markSuccess(sequenceId) {
    this.processingMap.set(sequenceId, {
      state: 'completed',
      completedTime: Date.now(),
    });
    this.completedSet.add(sequenceId);
    this.totalProcessed++;

    this.emit('chunk-completed', sequenceId);
    console.log(`✨ Chunk #${sequenceId} completed`);
  }

  /**
   * Mark chunk as failed (with optional retry)
   */
  markFailed(sequenceId, error, shouldRetry = true) {
    const item = this.queue.find((q) => q.chunk.sequenceId === sequenceId);

    if (!item) {
      console.warn(`⚠️  Chunk #${sequenceId} not found in queue`);
      return;
    }

    if (shouldRetry && item.attempts < 2) {
      // Re-enqueue for retry
      item.state = 'pending';
      this.queue.push(item);
      console.log(`🔄 Chunk #${sequenceId} re-queued for retry (${item.attempts} attempt)`);
      this.emit('chunk-retrying', sequenceId);
    } else {
      // Give up on chunk
      this.processingMap.set(sequenceId, {
        state: 'failed',
        error: error?.message,
        failedTime: Date.now(),
        attempts: item.attempts,
      });
      this.completedSet.add(sequenceId);
      this.totalFailed++;

      console.warn(`❌ Chunk #${sequenceId} failed after ${item.attempts} attempt(s): ${error?.message}`);
      this.emit('chunk-failed', sequenceId, error);
    }
  }

  /**
   * Get current queue depth
   */
  getDepth() {
    return this.queue.length;
  }

  /**
   * Get queue statistics
   */
  getStats() {
    return {
      queueDepth: this.queue.length,
      maxQueueSize: this.maxQueueSize,
      totalEnqueued: this.totalEnqueued,
      totalProcessed: this.totalProcessed,
      totalFailed: this.totalFailed,
      processingActive: this.processingMap.size,
    };
  }

  /**
   * Start cleanup timer to detect stalled chunks
   */
  startCleanupTimer() {
    if (this.cleanupTimer) {
      return;
    }

    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);

    console.log(`⏱️  Queue cleanup timer started (${this.cleanupIntervalMs}ms interval)`);
  }

  /**
   * Stop cleanup timer
   */
  stopCleanupTimer() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Cleanup: detect stalled/timeout chunks
   */
  cleanup() {
    const now = Date.now();
    let timeoutCount = 0;

    for (const [seqId, state] of this.processingMap.entries()) {
      if (state.state === 'processing') {
        const elapsed = now - state.dequeueTime;
        
        if (elapsed > this.chunkTimeoutMs) {
          console.warn(`⏰ Chunk #${seqId} processing timeout (${elapsed}ms)`);
          this.markFailed(seqId, new Error(`Timeout after ${elapsed}ms`), true);
          timeoutCount++;
        }
      }
    }

    if (timeoutCount > 0) {
      console.log(`⏰ Timeout cleanup: ${timeoutCount} chunk(s) re-queued`);
    }
  }

  /**
   * Stop all queue operations
   */
  stop() {
    this.stopCleanupTimer();
    this.queue = [];
    this.processingMap.clear();
    console.log('⏹️  ProcessingQueue stopped');
  }
}

export default ProcessingQueue;
