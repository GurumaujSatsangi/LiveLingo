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
    this.segmentFrameMs = Number(options.segmentFrameMs || process.env.GEMINI_SEND_FRAME_MS || 100);

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

    this.outputSeq = 1;
    this.pendingLatency = [];

    this.stats = {
      segmentsEnqueued: 0,
      segmentsDropped: 0,
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

    this.stats.segmentsEnqueued += 1;

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
    await this.geminiClient.close();
    await this.ivsStreamer.stopStream();
    this.emit("stopped", { languageCode: this.languageCode });
  }
}

export default GeminiLanguagePipeline;
