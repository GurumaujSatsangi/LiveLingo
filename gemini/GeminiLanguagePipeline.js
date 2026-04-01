import { EventEmitter } from "events";
import GeminiLiveClient from "./GeminiLiveClient.js";
import IVSTranslatorStreamer from "../ivsTranslatorStreamer.js";

/**
 * One language lane: Gemini Live session + IVS output stream.
 */
class GeminiLanguagePipeline extends EventEmitter {
  constructor(options = {}) {
    super();

    this.languageCode = options.languageCode;
    this.languageName = options.languageName;
    this.sourceVideoUrl = options.sourceVideoUrl || "";
    this.sessionId = options.sessionId || `gemini_${this.languageCode}_${Date.now()}`;
    this.maxSegmentQueue = Number(options.maxSegmentQueue || process.env.GEMINI_SEGMENT_QUEUE_MAX || 60);
    this.segmentFrameMs = Number(options.segmentFrameMs || process.env.GEMINI_SEND_FRAME_MS || 40);
    this.realtimeLatestOnly =
      String(options.realtimeLatestOnly ?? process.env.GEMINI_REALTIME_LATEST_ONLY ?? "true").toLowerCase() !== "false";
    this.maxSegmentAgeBeforeSendMs = Number(
      options.maxSegmentAgeBeforeSendMs || process.env.GEMINI_MAX_SEGMENT_AGE_BEFORE_SEND_MS || 2500
    );

    this.geminiClient = new GeminiLiveClient({
      apiKey: options.geminiApiKey,
      model: options.model,
      languageName: this.languageName,
      maxPendingMessages: options.maxPendingMessages,
      maxBufferedBytes: options.maxBufferedBytes,
      maxReconnectAttempts: options.maxReconnectAttempts,
      reconnectBaseDelayMs: options.reconnectBaseDelayMs,
      reconnectMaxDelayMs: options.reconnectMaxDelayMs,
    });

    this.ivsStreamer = new IVSTranslatorStreamer({
      language: options.ivsLanguageKey,
      sourceVideoUrl: this.sourceVideoUrl,
      inputSampleRate: 24000,
      maxReconnectAttempts: options.ivsMaxReconnectAttempts,
      reconnectDelay: options.ivsReconnectDelay,
      videoSyncDelaySec: Number(options.videoSyncDelaySec || process.env.VIDEO_SYNC_DELAY_SEC || 0),
    });

    this.segmentQueue = [];
    this.sendingLoopRunning = false;
    this.closed = false;
    this.lastNotReadyWarningAt = 0;
    this.turnWaitTimeoutMs = Number(options.turnWaitTimeoutMs || process.env.GEMINI_TURN_COMPLETE_TIMEOUT_MS || 1800);
    this.segmentDedupeWindowMs = Number(options.segmentDedupeWindowMs || process.env.GEMINI_SEGMENT_DEDUPE_WINDOW_MS || 8000);
    this.segmentDedupeSimilarity = Number(options.segmentDedupeSimilarity || process.env.GEMINI_SEGMENT_DEDUPE_SIMILARITY || 0.992);
    this.segmentFingerprintBins = Number(options.segmentFingerprintBins || process.env.GEMINI_SEGMENT_FINGERPRINT_BINS || 12);
    this.recentSegmentFingerprints = [];
    this.pendingTurnCompletion = null;

    this.outputSeq = 1;
    this.pendingLatency = [];

    this.stats = {
      segmentsEnqueued: 0,
      segmentsDropped: 0,
      segmentsDeduped: 0,
      segmentsDroppedStaleBeforeSend: 0,
      segmentsReplacedLatestOnly: 0,
      segmentsSkippedNoConnection: 0,
      segmentsSent: 0,
      geminiAudioPackets: 0,
      geminiAudioBytes: 0,
      firstAudioLatencyMsAvg: 0,
      reconnectEvents: 0,
    };

    this.bindGeminiEvents();
  }

  bindGeminiEvents() {
    this.geminiClient.on("audio", (event) => {
      this.stats.geminiAudioPackets += 1;
      this.stats.geminiAudioBytes += event.audioBuffer.length;

      if (this.pendingLatency.length > 0) {
        const started = this.pendingLatency.shift();
        const latencyMs = Math.max(0, Date.now() - started);
        this.updateAvgLatency(latencyMs);
        this.emit("segment-first-audio", {
          languageCode: this.languageCode,
          latencyMs,
        });
      }

      this.ivsStreamer.enqueueAudioChunk(event.audioBuffer, { seq: this.outputSeq });
      this.outputSeq += 1;
    });

    this.geminiClient.on("reconnecting", (event) => {
      this.stats.reconnectEvents += 1;
      this.emit("reconnecting", {
        languageCode: this.languageCode,
        ...event,
      });
    });

    this.geminiClient.on("warning", (warning) => {
      this.emit("warning", `[${this.languageCode}] ${warning}`);
    });

    this.geminiClient.on("error", (err) => {
      this.emit("error", new Error(`[${this.languageCode}] Gemini error: ${err.message}`));
    });

    this.geminiClient.on("fatal", (err) => {
      this.emit("error", new Error(`[${this.languageCode}] Gemini fatal: ${err.message}`));
    });

    this.geminiClient.on("turn-complete", () => {
      if (this.pendingTurnCompletion) {
        this.pendingTurnCompletion.resolve(true);
        this.pendingTurnCompletion = null;
      }
    });
  }

  buildSegmentFingerprint(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 160) {
      return null;
    }

    const bins = Math.max(8, this.segmentFingerprintBins);
    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount <= 0) {
      return null;
    }

    const energyBins = new Array(bins).fill(0);
    const counts = new Array(bins).fill(0);
    let squaredSum = 0;

    for (let i = 0; i < sampleCount; i += 1) {
      const sample = buffer.readInt16LE(i * 2) / 32768;
      const absValue = Math.abs(sample);
      const bin = Math.min(bins - 1, Math.floor((i * bins) / sampleCount));

      energyBins[bin] += absValue;
      counts[bin] += 1;
      squaredSum += sample * sample;
    }

    for (let i = 0; i < bins; i += 1) {
      if (counts[i] > 0) {
        energyBins[i] /= counts[i];
      }
    }

    const rms = Math.sqrt(squaredSum / sampleCount);
    return [...energyBins, rms];
  }

  cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) {
      return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA <= 0 || normB <= 0) {
      return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  pruneRecentSegmentFingerprints(now) {
    this.recentSegmentFingerprints = this.recentSegmentFingerprints.filter(
      (entry) => now - entry.at <= this.segmentDedupeWindowMs
    );
  }

  shouldDropDuplicateSegment(segmentEvent) {
    const fingerprint = this.buildSegmentFingerprint(segmentEvent.buffer);
    if (!fingerprint) {
      return false;
    }

    const now = Date.now();
    this.pruneRecentSegmentFingerprints(now);

    let best = 0;
    for (const entry of this.recentSegmentFingerprints) {
      const similarity = this.cosineSimilarity(fingerprint, entry.fingerprint);
      if (similarity > best) {
        best = similarity;
      }
    }

    if (best >= this.segmentDedupeSimilarity) {
      this.stats.segmentsDeduped += 1;
      this.emit(
        "warning",
        `[${this.languageCode}] Dropped near-duplicate source segment ${segmentEvent.segmentId} similarity=${best.toFixed(4)}`
      );
      return true;
    }

    this.recentSegmentFingerprints.push({
      at: now,
      segmentId: segmentEvent.segmentId,
      fingerprint,
    });
    return false;
  }

  waitForTurnCompletion(segmentId) {
    if (this.pendingTurnCompletion) {
      this.pendingTurnCompletion.resolve(false);
      this.pendingTurnCompletion = null;
    }

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (this.pendingTurnCompletion) {
          this.pendingTurnCompletion = null;
          this.emit(
            "warning",
            `[${this.languageCode}] turn-complete timeout for segment ${segmentId}; continuing to keep stream realtime`
          );
          resolve(false);
        }
      }, this.turnWaitTimeoutMs);

      this.pendingTurnCompletion = {
        resolve: (completed) => {
          clearTimeout(timeout);
          resolve(completed);
        },
      };
    });
  }

  updateAvgLatency(valueMs) {
    if (this.stats.firstAudioLatencyMsAvg <= 0) {
      this.stats.firstAudioLatencyMsAvg = valueMs;
      return;
    }

    this.stats.firstAudioLatencyMsAvg = Math.round((this.stats.firstAudioLatencyMsAvg * 0.85) + (valueMs * 0.15));
  }

  async start() {
    await this.ivsStreamer.startStream(this.sessionId);
    await this.geminiClient.connect();
    this.emit("started", { languageCode: this.languageCode });
  }

  enqueueSegment(segmentEvent) {
    if (this.closed) {
      return false;
    }

    if (!segmentEvent?.buffer || !Buffer.isBuffer(segmentEvent.buffer) || segmentEvent.buffer.length === 0) {
      return false;
    }

    if (this.shouldDropDuplicateSegment(segmentEvent)) {
      return false;
    }

    this.stats.segmentsEnqueued += 1;

    if (this.realtimeLatestOnly && this.segmentQueue.length > 0) {
      // Meet-like policy: keep only the newest unsent speech slice to stay current.
      this.stats.segmentsReplacedLatestOnly += this.segmentQueue.length;
      this.segmentQueue = [];
    }

    if (this.segmentQueue.length >= this.maxSegmentQueue) {
      this.segmentQueue.shift();
      this.stats.segmentsDropped += 1;
      this.emit("warning", `[${this.languageCode}] Segment queue overflow, dropped oldest segment`);
    }

    this.segmentQueue.push(segmentEvent);

    if (!this.sendingLoopRunning) {
      this.runSendingLoop().catch((err) => {
        this.emit("error", err);
      });
    }

    return true;
  }

  async runSendingLoop() {
    if (this.sendingLoopRunning) {
      return;
    }

    this.sendingLoopRunning = true;

    try {
      while (!this.closed) {
        const segment = this.segmentQueue.shift();
        if (!segment) {
          break;
        }

        await this.sendSegmentToGemini(segment);
      }
    } finally {
      this.sendingLoopRunning = false;

      if (this.segmentQueue.length > 0 && !this.closed) {
        this.runSendingLoop().catch((err) => this.emit("error", err));
      }
    }
  }

  async sendSegmentToGemini(segment) {
    if (segment?.emittedAt && Date.now() - segment.emittedAt > this.maxSegmentAgeBeforeSendMs) {
      this.stats.segmentsDroppedStaleBeforeSend += 1;
      this.emit(
        "warning",
        `[${this.languageCode}] Dropping stale segment ${segment.segmentId} before Gemini send to stay realtime`
      );
      return;
    }

    if (!this.geminiClient.canSendImmediately()) {
      this.stats.segmentsSkippedNoConnection += 1;
      const now = Date.now();
      if (now - this.lastNotReadyWarningAt > 2000) {
        this.lastNotReadyWarningAt = now;
        this.emit("warning", `[${this.languageCode}] Gemini not ready; dropping segment ${segment.segmentId}`);
      }
      return;
    }

    const frames = this.sliceIntoFrames(segment.buffer, this.segmentFrameMs, 16000);

    let pushedLatencyMarker = false;

    for (const frame of frames) {
      // Keep chunks in 20ms slices to reduce head-of-line blocking.
      if (!pushedLatencyMarker) {
        this.pendingLatency.push(Date.now());
        pushedLatencyMarker = true;
      }

      const sent = await this.geminiClient.sendPcmChunk(frame);
      if (!sent) {
        this.stats.segmentsSkippedNoConnection += 1;
        if (pushedLatencyMarker) {
          this.pendingLatency.pop();
        }
        return;
      }
    }

    // Segment-oriented workflow: explicitly mark stream-end so model flushes a spoken response.
    const streamEndSent = await this.geminiClient.sendAudioStreamEnd();
    if (!streamEndSent) {
      if (pushedLatencyMarker) {
        this.pendingLatency.pop();
      }
      this.stats.segmentsSkippedNoConnection += 1;
      return;
    }

    await this.waitForTurnCompletion(segment.segmentId);

    this.stats.segmentsSent += 1;
    this.emit("segment-sent", {
      languageCode: this.languageCode,
      segmentId: segment.segmentId,
      durationMs: segment.durationMs,
      bytes: segment.buffer.length,
    });
  }

  sliceIntoFrames(buffer, frameMs, sampleRate) {
    const frameBytes = Math.floor((sampleRate * 2 * frameMs) / 1000);
    const frames = [];

    for (let offset = 0; offset < buffer.length; offset += frameBytes) {
      const chunk = buffer.slice(offset, Math.min(buffer.length, offset + frameBytes));
      if (chunk.length < frameBytes) {
        frames.push(Buffer.concat([chunk, Buffer.alloc(frameBytes - chunk.length)]));
      } else {
        frames.push(chunk);
      }
    }

    return frames;
  }

  getStats() {
    return {
      languageCode: this.languageCode,
      languageName: this.languageName,
      segmentQueueDepth: this.segmentQueue.length,
      outputSeq: this.outputSeq,
      ...this.stats,
      gemini: this.geminiClient.getStats(),
      ivs: this.ivsStreamer.getStreamingStats(),
    };
  }

  async stop() {
    this.closed = true;
    this.segmentQueue = [];
    this.recentSegmentFingerprints = [];
    if (this.pendingTurnCompletion) {
      this.pendingTurnCompletion.resolve(false);
      this.pendingTurnCompletion = null;
    }
    await this.geminiClient.close();
    await this.ivsStreamer.stopStream();
    this.emit("stopped", { languageCode: this.languageCode });
  }
}

export default GeminiLanguagePipeline;
