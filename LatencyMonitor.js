/**
 * LatencyMonitor
 * 
 * Tracks end-to-end latency and per-stage metrics.
 * Provides observability for production debugging.
 */
class LatencyMonitor {
  constructor(options = {}) {
    this.chunkMetrics = new Map(); // sequenceId -> metrics
    this.windowSize = options.windowSize || 100; // Track last N chunks
    
    // Aggregates
    this.aggregates = {
      captureToVadMs: [],
      vadToQueueMs: [],
      queueToSttMs: [],
      sttLatencyMs: [],
      translationLatencyMs: [],
      ttsLatencyMs: [],
      endToEndLatencyMs: [],
    };
  }

  /**
   * Record chunk capture time (from FFmpeg ingestion)
   */
  recordCapture(sequenceId, timestamp) {
    if (!this.chunkMetrics.has(sequenceId)) {
      this.chunkMetrics.set(sequenceId, {});
    }
    
    const m = this.chunkMetrics.get(sequenceId);
    m.captureTime = timestamp;
  }

  /**
   * Record VAD segmentation time
   */
  recordVad(sequenceId, timestamp) {
    if (!this.chunkMetrics.has(sequenceId)) {
      this.chunkMetrics.set(sequenceId, {});
    }
    
    const m = this.chunkMetrics.get(sequenceId);
    m.vadTime = timestamp;

    if (m.captureTime) {
      const latency = timestamp - m.captureTime;
      this.pushAggregate('captureToVadMs', latency);
    }
  }

  /**
   * Record queue entry time
   */
  recordQueueEntry(sequenceId, timestamp) {
    if (!this.chunkMetrics.has(sequenceId)) {
      this.chunkMetrics.set(sequenceId, {});
    }
    
    const m = this.chunkMetrics.get(sequenceId);
    m.queueEntryTime = timestamp;

    if (m.vadTime) {
      const latency = timestamp - m.vadTime;
      this.pushAggregate('vadToQueueMs', latency);
    }
  }

  /**
   * Record STT processing start
   */
  recordSttStart(sequenceId, timestamp) {
    if (!this.chunkMetrics.has(sequenceId)) {
      this.chunkMetrics.set(sequenceId, {});
    }
    
    const m = this.chunkMetrics.get(sequenceId);
    m.sttStartTime = timestamp;

    if (m.queueEntryTime) {
      const latency = timestamp - m.queueEntryTime;
      this.pushAggregate('queueToSttMs', latency);
    }
  }

  /**
   * Record STT completion
   */
  recordSttComplete(sequenceId, timestamp) {
    if (!this.chunkMetrics.has(sequenceId)) {
      this.chunkMetrics.set(sequenceId, {});
    }
    
    const m = this.chunkMetrics.get(sequenceId);
    m.sttCompleteTime = timestamp;

    if (m.sttStartTime) {
      const latency = timestamp - m.sttStartTime;
      this.pushAggregate('sttLatencyMs', latency);
    }
  }

  /**
   * Record translation processing time
   */
  recordTranslation(sequenceId, startTime, endTime) {
    if (!this.chunkMetrics.has(sequenceId)) {
      this.chunkMetrics.set(sequenceId, {});
    }
    
    const m = this.chunkMetrics.get(sequenceId);
    m.translationStartTime = startTime;
    m.translationCompleteTime = endTime;

    const latency = endTime - startTime;
    this.pushAggregate('translationLatencyMs', latency);
  }

  /**
   * Record TTS processing time
   */
  recordTts(sequenceId, startTime, endTime) {
    if (!this.chunkMetrics.has(sequenceId)) {
      this.chunkMetrics.set(sequenceId, {});
    }
    
    const m = this.chunkMetrics.get(sequenceId);
    m.ttsStartTime = startTime;
    m.ttsCompleteTime = endTime;

    const latency = endTime - startTime;
    this.pushAggregate('ttsLatencyMs', latency);
  }

  /**
   * Record IVS stream time (when chunk reaches streamer)
   */
  recordStreamTime(sequenceId, timestamp) {
    if (!this.chunkMetrics.has(sequenceId)) {
      this.chunkMetrics.set(sequenceId, {});
    }
    
    const m = this.chunkMetrics.get(sequenceId);
    m.streamTime = timestamp;

    if (m.captureTime) {
      const e2e = timestamp - m.captureTime;
      this.pushAggregate('endToEndLatencyMs', e2e);
    }
  }

  /**
   * Push value to aggregate array (maintain window size)
   */
  pushAggregate(key, value) {
    if (!this.aggregates[key]) {
      this.aggregates[key] = [];
    }

    this.aggregates[key].push(value);
    
    // Keep only last windowSize values
    if (this.aggregates[key].length > this.windowSize) {
      this.aggregates[key].shift();
    }
  }

  /**
   * Calculate statistics for a metric array
   */
  calculateStats(values) {
    if (values.length === 0) {
      return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / sorted.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    return { avg, min, max, p50, p95, p99, count: sorted.length };
  }

  /**
   * Get overall metrics report
   */
  getReport() {
    return {
      captureToVad: this.calculateStats(this.aggregates.captureToVadMs),
      vadToQueue: this.calculateStats(this.aggregates.vadToQueueMs),
      queueToStt: this.calculateStats(this.aggregates.queueToSttMs),
      stt: this.calculateStats(this.aggregates.sttLatencyMs),
      translation: this.calculateStats(this.aggregates.translationLatencyMs),
      tts: this.calculateStats(this.aggregates.ttsLatencyMs),
      endToEnd: this.calculateStats(this.aggregates.endToEndLatencyMs),
    };
  }

  /**
   * Get metrics for a specific chunk
   */
  getChunkMetrics(sequenceId) {
    return this.chunkMetrics.get(sequenceId) || null;
  }

  /**
   * Log current metrics
   */
  logMetrics() {
    const report = this.getReport();
    
    console.log('\n📊 ===== LATENCY METRICS =====');
    
    if (report.endToEnd) {
      console.log(
        `⏱️  End-to-End: avg=${report.endToEnd.avg.toFixed(0)}ms, ` +
        `p50=${report.endToEnd.p50.toFixed(0)}ms, ` +
        `p95=${report.endToEnd.p95.toFixed(0)}ms (${report.endToEnd.count} chunks)`
      );
    }

    if (report.stt) {
      console.log(
        `🎤 STT: avg=${report.stt.avg.toFixed(0)}ms, ` +
        `p95=${report.stt.p95.toFixed(0)}ms`
      );
    }

    if (report.translation) {
      console.log(
        `🌐 Translation: avg=${report.translation.avg.toFixed(0)}ms, ` +
        `p95=${report.translation.p95.toFixed(0)}ms`
      );
    }

    if (report.tts) {
      console.log(
        `🔊 TTS: avg=${report.tts.avg.toFixed(0)}ms, ` +
        `p95=${report.tts.p95.toFixed(0)}ms`
      );
    }

    console.log('==============================\n');
  }

  /**
   * Clear all metrics
   */
  clear() {
    this.chunkMetrics.clear();
    for (const key in this.aggregates) {
      this.aggregates[key] = [];
    }
  }
}

export default LatencyMonitor;
