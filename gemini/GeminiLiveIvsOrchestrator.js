import { EventEmitter } from "events";
import StreamingAudioIngester from "../StreamingAudioIngester.js";
import VadSegmenter from "./VadSegmenter.js";
import GeminiLanguagePipeline from "./GeminiLanguagePipeline.js";

const DEFAULT_LANGUAGES = [
  { code: "hi-IN", name: "Hindi", ivsLanguageKey: "hindi" },
  { code: "ta-IN", name: "Tamil", ivsLanguageKey: "tamil" },
  { code: "bn-IN", name: "Bengali", ivsLanguageKey: "bangla" },
];

class GeminiLiveIvsOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();

    this.hlsUrl = options.hlsUrl || process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL || "";
    this.geminiApiKey = options.geminiApiKey || process.env.GEMINI_API_KEY || "";
    this.model = options.model || process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
    this.sampleRate = 16000;
    this.channels = 1;
    this.languages = options.languages || DEFAULT_LANGUAGES;

    this.metricsIntervalMs = Number(options.metricsIntervalMs || process.env.GEMINI_METRICS_INTERVAL_MS || 5000);
    this.maxBroadcastLagMs = Number(options.maxBroadcastLagMs || process.env.GEMINI_MAX_BROADCAST_LAG_MS || 2500);

    this.ingester = new StreamingAudioIngester({
      hlsUrl: this.hlsUrl,
      sampleRate: this.sampleRate,
      channels: this.channels,
      retainBuffer: false,
      maxBufferSize: Number(options.ingesterMaxBufferBytes || process.env.GEMINI_INGESTER_MAX_BUFFER_BYTES || 256000),
      maxRestartAttempts: Number(options.ingesterRestartAttempts || process.env.GEMINI_INGESTER_MAX_RESTARTS || 50),
      restartDelay: Number(options.ingesterRestartDelayMs || process.env.GEMINI_INGESTER_RESTART_DELAY_MS || 1500),
    });

    this.vad = new VadSegmenter({
      sampleRate: this.sampleRate,
      channels: this.channels,
      frameMs: Number(options.vadFrameMs || process.env.GEMINI_FRAME_MS || 20),
      silenceMs: Number(options.vadSilenceMs || process.env.GEMINI_VAD_SILENCE_MS || 400),
      maxChunkMs: Number(options.vadMaxChunkMs || process.env.GEMINI_MAX_CHUNK_MS || 5000),
      minSpeechMs: Number(options.vadMinChunkMs || process.env.GEMINI_MIN_CHUNK_MS || 250),
      energyThreshold: Number(options.vadEnergyThreshold || process.env.GEMINI_VAD_ENERGY_THRESHOLD || 0.016),
    });

    this.languagePipelines = new Map();
    this.metricsTimer = null;
    this.started = false;
    this.sessionId = `gemini_live_${Date.now()}`;

    this.stats = {
      startedAt: 0,
      audioChunksSeen: 0,
      segmentsBroadcast: 0,
      segmentsDroppedByLag: 0,
      totalSegmentBytes: 0,
    };

    this.bindEvents();
  }

  bindEvents() {
    this.ingester.on("audio-data", (chunk) => {
      this.stats.audioChunksSeen += 1;
      this.vad.processAudio(chunk);
    });

    this.ingester.on("fatal-error", (err) => {
      this.emit("error", new Error(`Audio ingester fatal error: ${err.message}`));
    });

    this.vad.on("segment", (segment) => {
      this.broadcastSegment(segment);
    });
  }

  buildLanguagePipelines() {
    for (const language of this.languages) {
      const pipeline = new GeminiLanguagePipeline({
        languageCode: language.code,
        languageName: language.name,
        ivsLanguageKey: language.ivsLanguageKey,
        sourceVideoUrl: this.hlsUrl,
        sessionId: this.sessionId,
        geminiApiKey: this.geminiApiKey,
        model: this.model,
      });

      pipeline.on("warning", (warning) => this.emit("warning", warning));
      pipeline.on("error", (err) => this.emit("error", err));
      pipeline.on("segment-first-audio", (event) => this.emit("segment-first-audio", event));
      pipeline.on("reconnecting", (event) => this.emit("reconnecting", event));

      this.languagePipelines.set(language.code, pipeline);
    }
  }

  async start() {
    if (this.started) {
      return;
    }

    if (!this.hlsUrl) {
      throw new Error("Missing HLS input URL. Set AWS_IVS_PLAYBACK_URL or LIVESTREAM_HLS_URL");
    }

    if (!this.geminiApiKey) {
      throw new Error("Missing GEMINI_API_KEY");
    }

    this.buildLanguagePipelines();

    for (const pipeline of this.languagePipelines.values()) {
      await pipeline.start();
    }

    await this.ingester.start();

    this.started = true;
    this.stats.startedAt = Date.now();
    this.startMetricsLogger();

    this.emit("started", {
      sessionId: this.sessionId,
      hlsUrl: this.hlsUrl,
      languages: this.languages,
    });
  }

  broadcastSegment(segment) {
    if (!segment?.buffer || !Buffer.isBuffer(segment.buffer)) {
      return;
    }

    const lagMs = Date.now() - segment.emittedAt;
    if (lagMs > this.maxBroadcastLagMs) {
      this.stats.segmentsDroppedByLag += 1;
      this.emit("warning", `Dropping segment ${segment.segmentId} because lag=${lagMs}ms > ${this.maxBroadcastLagMs}ms`);
      return;
    }

    this.stats.segmentsBroadcast += 1;
    this.stats.totalSegmentBytes += segment.buffer.length;

    for (const pipeline of this.languagePipelines.values()) {
      pipeline.enqueueSegment({
        ...segment,
        // Clone the audio buffer to avoid accidental mutation between pipelines.
        buffer: Buffer.from(segment.buffer),
      });
    }

    this.emit("segment-broadcast", {
      segmentId: segment.segmentId,
      durationMs: segment.durationMs,
      bytes: segment.buffer.length,
      reason: segment.reason,
    });
  }

  startMetricsLogger() {
    if (this.metricsTimer) {
      return;
    }

    this.metricsTimer = setInterval(() => {
      const stats = this.getStats();
      this.emit("metrics", stats);
    }, this.metricsIntervalMs);
  }

  stopMetricsLogger() {
    if (!this.metricsTimer) {
      return;
    }

    clearInterval(this.metricsTimer);
    this.metricsTimer = null;
  }

  getStats() {
    const languageStats = {};
    for (const [code, pipeline] of this.languagePipelines.entries()) {
      languageStats[code] = pipeline.getStats();
    }

    return {
      sessionId: this.sessionId,
      uptimeMs: this.stats.startedAt ? Date.now() - this.stats.startedAt : 0,
      ...this.stats,
      ingester: this.ingester.getStats(),
      vad: this.vad.getStats(),
      languages: languageStats,
    };
  }

  async stop() {
    if (!this.started) {
      return;
    }

    this.stopMetricsLogger();
    this.vad.flush("shutdown");
    await this.ingester.stop();

    for (const pipeline of this.languagePipelines.values()) {
      await pipeline.stop();
    }

    this.languagePipelines.clear();
    this.started = false;
    this.emit("stopped", { sessionId: this.sessionId });
  }
}

export default GeminiLiveIvsOrchestrator;
