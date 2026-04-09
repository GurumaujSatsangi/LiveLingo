import express from "express";
import http from "http";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { WebSocketServer } from "ws";
import axios from "axios";
import ffmpegPath from "ffmpeg-static";
import { SarvamAIClient } from "sarvamai";
import pkg from "wavefile";
import StreamingAudioIngester from "./StreamingAudioIngester.js";
import VadSegmenter from "./VadSegmenter.js";
import IVSTranslatorStreamer from "./ivsTranslatorStreamer.js";

const { WaveFile } = pkg;

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);
const transcriptWss = new WebSocketServer({ server: httpServer, path: "/ws/transcripts" });

const transcriptEntries = [];
const MAX_TRANSCRIPT_ENTRIES = 20;
const DEFAULT_PLAYBACK_BASE_URL = "https://a7936abd8b67.ap-south-1.playback.live-video.net";
const PORT = Number(process.env.PORT || 3000);

let orchestrator = null;
let orchestratorRunning = false;

function nowIso() {
  return new Date().toISOString();
}

function formatViewerCount(viewerCount) {
  if (!Number.isFinite(viewerCount) || viewerCount < 0) return "--";
  if (viewerCount < 1000) return String(viewerCount);
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
    .format(viewerCount)
    .toLowerCase();
}

function normalizePlaybackBaseUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) return DEFAULT_PLAYBACK_BASE_URL;

  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(withProtocol);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.origin}${pathname}`;
  } catch {
    return DEFAULT_PLAYBACK_BASE_URL;
  }
}

function buildPlaybackUrl(channelPath) {
  const rawPath = String(channelPath || "").trim();
  if (!rawPath) return "";

  if (/^\/\//.test(rawPath)) {
    return `https:${rawPath}`;
  }

  if (/^https?:\/\//i.test(rawPath)) {
    try {
      return new URL(rawPath).toString();
    } catch {
      return "";
    }
  }

  const base = normalizePlaybackBaseUrl(
    process.env.CLOUDFRONT_PLAYBACK_BASE_URL || process.env.PLAYBACK_BASE_URL || DEFAULT_PLAYBACK_BASE_URL
  );
  const normalizedPath = rawPath.startsWith("/") ? rawPath : `/${rawPath}`;
  return `${base}${normalizedPath}`;
}

function getStreamUrls() {
  return {
    original: buildPlaybackUrl(process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL || ""),
    hindi: buildPlaybackUrl(process.env.AWS_IVS_PLAYBACK_URL_HINDI || ""),
    bangla: buildPlaybackUrl(process.env.AWS_IVS_PLAYBACK_URL_BANGLA || ""),
    tamil: buildPlaybackUrl(process.env.AWS_IVS_PLAYBACK_URL_TAMIL || ""),
  };
}

function getWhepUrls() {
  return {
    original: String(process.env.WEBRTC_WHEP_URL_ORIGINAL || "").trim(),
    hindi: String(process.env.WEBRTC_WHEP_URL_HINDI || "").trim(),
    bangla: String(process.env.WEBRTC_WHEP_URL_BANGLA || "").trim(),
    tamil: String(process.env.WEBRTC_WHEP_URL_TAMIL || "").trim(),
  };
}

function pushTranscriptEntry(entry) {
  transcriptEntries.push(entry);
  if (transcriptEntries.length > MAX_TRANSCRIPT_ENTRIES) {
    transcriptEntries.splice(0, transcriptEntries.length - MAX_TRANSCRIPT_ENTRIES);
  }

  const payload = JSON.stringify({ type: "transcript-new", entry });
  for (const client of transcriptWss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

const LANE_CONFIG = [
  { laneKey: "hindi", languageCode: "hi-IN", targetLanguage: "Hindi" },
  { laneKey: "bangla", languageCode: "bn-IN", targetLanguage: "Bengali" },
  { laneKey: "tamil", languageCode: "ta-IN", targetLanguage: "Tamil" },
];

class SarvamIvsOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();

    this.hlsUrl = options.hlsUrl || process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL || "";
    this.maxSegmentQueueMs = Number(options.maxSegmentQueueMs || process.env.LIVEKIT_MAX_QUEUE_MS || 500);
    this.useSourceVideoForTranslated =
      String(options.useSourceVideoForTranslated ?? process.env.IVS_TRANSLATED_USE_SOURCE_VIDEO ?? "false").toLowerCase() ===
      "true";
    this.ffmpegThreadQueueSize = Number(options.ffmpegThreadQueueSize || process.env.FFMPEG_THREAD_QUEUE_SIZE || 4096);
    this.ttsOutputSampleRate = Number(options.ttsOutputSampleRate || process.env.SARVAM_TTS_OUTPUT_RATE || 24000);
    this.sttModel = options.sttModel || process.env.SARVAM_STT_MODEL || "saaras:v3";
    this.translateModel = options.translateModel || process.env.SARVAM_TRANSLATE_MODEL || "sarvam-translate:v1";
    this.ttsModel = options.ttsModel || process.env.SARVAM_TTS_MODEL || "bulbul:v3";
    this.sarvamApiKey = options.sarvamApiKey || process.env.SARVAM_API_KEY || "";
    this.sarvamClient = this.sarvamApiKey ? new SarvamAIClient({ apiSubscriptionKey: this.sarvamApiKey }) : null;
    this.defaultTtsSpeaker = options.defaultTtsSpeaker || process.env.SARVAM_TTS_SPEAKER || "kabir";

    this.ingester = new StreamingAudioIngester({
      hlsUrl: this.hlsUrl,
      sampleRate: 16000,
      channels: 1,
      retainBuffer: false,
      maxRestartAttempts: Number(process.env.LIVEKIT_INGESTER_MAX_RESTARTS || 50),
      restartDelay: Number(process.env.LIVEKIT_INGESTER_RESTART_DELAY_MS || 1500),
      ffmpegThreadQueueSize: this.ffmpegThreadQueueSize,
    });

    this.vadSegmenter = new VadSegmenter({
      sampleRate: 16000,
      channels: 1,
      frameMs: Number(process.env.LIVEKIT_VAD_FRAME_MS || 20),
      energyThreshold: Number(process.env.LIVEKIT_VAD_ENERGY_THRESHOLD || 0.016),
      silenceMs: Number(process.env.LIVEKIT_VAD_SILENCE_MS || 220),
    });

    this.started = false;
    this.stopping = false;
    this.sessionId = `sarvam_live_${Date.now()}`;
    this.stats = {
      startedAt: 0,
      chunksSeen: 0,
      segmentsBroadcast: 0,
      segmentsDroppedByLag: 0,
      segmentsTranscribed: 0,
      segmentsFailed: 0,
      sttMsTotal: 0,
      translationMsTotal: 0,
      ttsMsTotal: 0,
    };

    this.laneReady = new Map();
    this.laneProcessingQueues = new Map();
    this.laneStreamers = new Map();
    this.laneSequence = new Map();

    this.onIngesterAudioData = null;
    this.onIngesterFatalError = null;
    this.onVadSegment = null;
    this.onVadEvent = null;

    this.metricsTimer = null;
    this.metricsIntervalMs = Number(process.env.LIVEKIT_METRICS_INTERVAL_MS || 5000);

    this.bindEvents();
  }

  bindEvents() {
    this.onIngesterAudioData = (chunk) => {
      if (this.stopping) return;
      this.stats.chunksSeen += 1;
      this.vadSegmenter.processAudio(chunk);
    };
    this.ingester.on("audio-data", this.onIngesterAudioData);

    this.onIngesterFatalError = (err) => {
      this.emit("error", new Error(`Audio ingester fatal error: ${err.message}`));
    };
    this.ingester.on("fatal-error", this.onIngesterFatalError);

    this.onVadSegment = (segment) => {
      if (this.stopping) return;
      this.broadcastSegment(segment).catch((err) => {
        this.emit("error", err);
      });
    };
    this.vadSegmenter.on("segment", this.onVadSegment);

    this.onVadEvent = (event) => {
      this.emit("warning", `VAD ${event.type} reason=${event.reason}`);
    };
    this.vadSegmenter.on("vad-event", this.onVadEvent);
  }

  isLaneReady(languageCode) {
    const streamer = this.laneStreamers.get(languageCode);
    return Boolean(this.laneReady.get(languageCode) && streamer?.getStatus()?.isRunning);
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  validateConfig() {
    if (!this.hlsUrl) {
      throw new Error("Missing HLS input URL. Set AWS_IVS_PLAYBACK_URL or LIVESTREAM_HLS_URL");
    }

    if (!this.sarvamApiKey) {
      throw new Error("Missing SARVAM_API_KEY");
    }

    if (!ffmpegPath) {
      throw new Error("ffmpeg-static binary not found");
    }
  }

  async start() {
    if (this.started) return;
    this.validateConfig();
    this.stopping = false;

    for (const lane of LANE_CONFIG) {
      await this.startLaneInfra(lane);
    }

    await this.ingester.start();
    this.stats.startedAt = Date.now();
    this.startMetrics();
    this.started = true;

    this.emit("started", {
      sessionId: this.sessionId,
      hlsUrl: this.hlsUrl,
      lanes: LANE_CONFIG,
      provider: "Sarvam+AWSIVS",
    });
  }

  async startLaneInfra(lane) {
    this.laneReady.set(lane.languageCode, false);

    const streamer = new IVSTranslatorStreamer({
      language: lane.laneKey,
      sourceVideoUrl: this.useSourceVideoForTranslated ? this.hlsUrl : "",
      inputSampleRate: this.ttsOutputSampleRate,
      videoSyncDelaySec: Number(process.env.VIDEO_SYNC_DELAY_SEC || 0),
      maxMissingSequenceWaitMs: Number(process.env.IVS_MAX_MISSING_SEQUENCE_WAIT_MS || 120),
      ffmpegThreadQueueSize: this.ffmpegThreadQueueSize,
      translatedAudioGain: Number(process.env.TRANSLATED_AUDIO_GAIN || 1.6),
    });

    try {
      await streamer.startStream(this.sessionId);
      this.laneStreamers.set(lane.languageCode, streamer);
      this.laneSequence.set(lane.languageCode, 1);
    } catch (err) {
      this.laneReady.set(lane.languageCode, false);
      throw err;
    }

    this.laneReady.set(lane.languageCode, true);
  }

  decodeSarvamAudioBase64(maybeBase64) {
    if (!maybeBase64 || typeof maybeBase64 !== "string") {
      return Buffer.alloc(0);
    }

    const cleanBase64 = maybeBase64.includes(",")
      ? maybeBase64.slice(maybeBase64.indexOf(",") + 1)
      : maybeBase64;

    return Buffer.from(cleanBase64, "base64");
  }

  detectAudioFormat(audioBuffer) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 4) {
      return "unknown";
    }

    if (audioBuffer.slice(0, 4).toString("ascii") === "RIFF" && audioBuffer.slice(8, 12).toString("ascii") === "WAVE") {
      return "wav";
    }

    if (audioBuffer.slice(0, 3).toString("ascii") === "ID3") {
      return "mp3";
    }

    if (audioBuffer.slice(0, 4).toString("ascii") === "OggS") {
      return "ogg";
    }

    if (audioBuffer.slice(0, 4).toString("ascii") === "fLaC") {
      return "flac";
    }

    if (audioBuffer[0] === 0xff && (audioBuffer[1] & 0xe0) === 0xe0) {
      return "mp3";
    }

    return "pcm16le";
  }

  pcm16ToWavBuffer(pcmBuffer, sampleRate = 16000) {
    const alignedLength = pcmBuffer.length - (pcmBuffer.length % 2);
    const pcmSlice = pcmBuffer.subarray(0, alignedLength);
    const wav = new WaveFile();
    wav.fromScratch(
      1,
      sampleRate,
      "16",
      new Int16Array(pcmSlice.buffer, pcmSlice.byteOffset, pcmSlice.length / 2)
    );
    return Buffer.from(wav.toBuffer());
  }

  async transcodeToPcm16Mono(buffer, { inputFormat = "wav", inputSampleRate = 24000, outputSampleRate = 24000 } = {}) {
    const args = ["-loglevel", "error"];
    if (inputFormat === "pcm16le") {
      args.push("-f", "s16le", "-ar", String(inputSampleRate), "-ac", "1", "-i", "pipe:0");
    } else {
      args.push("-i", "pipe:0");
    }

    args.push("-f", "s16le", "-ac", "1", "-ar", String(outputSampleRate), "pipe:1");

    return new Promise((resolve, reject) => {
      const proc = spawn(ffmpegPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      const outChunks = [];
      let stderr = "";

      proc.stdout.on("data", (data) => outChunks.push(data));
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(outChunks));
          return;
        }
        reject(new Error(`FFmpeg transcode failed with code ${code}: ${stderr.trim()}`));
      });

      proc.stdin.end(buffer);
    });
  }

  extractSarvamTextTranslation(response) {
    if (!response) return "";

    const candidateFields = [
      response.translated_text,
      response.translatedText,
      response.translation,
      response.output_text,
      response.outputText,
      response.text,
    ];

    for (const value of candidateFields) {
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }

    if (typeof response === "string") {
      return response.trim();
    }

    return "";
  }

  async transcribeSegmentToEnglish(segmentPcm16) {
    const wavFileBuffer = this.pcm16ToWavBuffer(segmentPcm16, 16000);
    const sttRes = await this.sarvamClient.speechToText.transcribe({
      file: wavFileBuffer,
      model: this.sttModel,
      mode: "transcribe",
    });

    return String(sttRes?.transcript || "").trim();
  }

  async translateEnglishToTarget(englishText, languageCode) {
    const translated = await this.sarvamClient.text.translate({
      input: englishText,
      source_language_code: "en-IN",
      target_language_code: languageCode,
      model: this.translateModel,
    });

    return this.extractSarvamTextTranslation(translated) || englishText;
  }

  async synthesizeLaneTts(text, lane) {
    const explicitLaneSpeaker = process.env[`SARVAM_TTS_SPEAKER_${lane.laneKey.toUpperCase()}`] || "";
    const fallbackSpeakers = String(process.env.SARVAM_TTS_SPEAKER_FALLBACKS || "anushka")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const speakerCandidates = Array.from(new Set([
      explicitLaneSpeaker,
      this.defaultTtsSpeaker,
      ...fallbackSpeakers,
    ].filter(Boolean)));

    let lastError = null;
    for (const speaker of speakerCandidates) {
      try {
        const ttsRes = await axios.post(
          "https://api.sarvam.ai/text-to-speech",
          {
            inputs: [text],
            target_language_code: lane.languageCode,
            speaker,
            pace: Number(process.env.SARVAM_TTS_PACE || 1),
            speech_sample_rate: this.ttsOutputSampleRate,
            enable_preprocessing: true,
            model: this.ttsModel,
          },
          {
            headers: {
              "api-subscription-key": this.sarvamApiKey,
            },
          }
        );

        const encodedAudio = ttsRes?.data?.audios?.[0] || "";
        const audioBuffer = this.decodeSarvamAudioBase64(encodedAudio);
        const sampleRate = Number(ttsRes?.data?.sample_rate || ttsRes?.data?.sampleRate || this.ttsOutputSampleRate);
        return { audioBuffer, sampleRate, speaker };
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error("Sarvam TTS request failed");
  }

  formatHttpError(err) {
    const status = err?.response?.status;
    const statusText = err?.response?.statusText;
    const responseData = err?.response?.data;
    let details = "";

    if (responseData) {
      if (typeof responseData === "string") {
        details = responseData;
      } else {
        try {
          details = JSON.stringify(responseData);
        } catch {
          details = String(responseData);
        }
      }
    }

    const base = status ? `HTTP ${status}${statusText ? ` ${statusText}` : ""}` : String(err?.message || err);
    return details ? `${base} | ${details}` : base;
  }

  enqueueSegmentForLane(lane, payload) {
    const key = lane.languageCode;
    const previous = this.laneProcessingQueues.get(key) || Promise.resolve();
    const queued = previous
      .catch(() => {
        // Keep queue alive even if a previous async write failed.
      })
      .then(() => this.processSegmentForLane(lane, payload));

    this.laneProcessingQueues.set(key, queued);
    return queued;
  }

  async processSegmentForLane(lane, payload) {
    if (!this.isLaneReady(lane.languageCode)) {
      return { lane: lane.laneKey, ok: false, reason: "lane-not-ready" };
    }

    const streamer = this.laneStreamers.get(lane.languageCode);
    if (!streamer) {
      return { lane: lane.laneKey, ok: false, reason: "missing-streamer" };
    }

    let translatedText = "";
    let translationMs = 0;
    try {
      const translateStart = Date.now();
      translatedText = await this.translateEnglishToTarget(payload.englishText, lane.languageCode);
      translationMs = Date.now() - translateStart;
    } catch (err) {
      this.stats.segmentsFailed += 1;
      const reason = this.formatHttpError(err);
      this.emit("warning", `Lane translation failed lane=${lane.languageCode}: ${reason}`);
      return { lane: lane.laneKey, ok: false, reason };
    }

    let ttsResult = null;
    let ttsMs = 0;
    try {
      const ttsStart = Date.now();
      ttsResult = await this.synthesizeLaneTts(translatedText, lane);
      ttsMs = Date.now() - ttsStart;
    } catch (err) {
      this.stats.segmentsFailed += 1;
      const reason = this.formatHttpError(err);
      this.emit("warning", `Lane TTS failed lane=${lane.languageCode}: ${reason}`);
      return { lane: lane.laneKey, ok: false, reason };
    }

    try {
      const detectedFormat = this.detectAudioFormat(ttsResult.audioBuffer);
      const pcm24k = await this.transcodeToPcm16Mono(ttsResult.audioBuffer, {
        inputFormat: detectedFormat,
        inputSampleRate: ttsResult.sampleRate,
        outputSampleRate: this.ttsOutputSampleRate,
      });

      if (!pcm24k.length) {
        return { lane: lane.laneKey, ok: false, reason: "empty-tts" };
      }

      const nextSeq = this.laneSequence.get(lane.languageCode) || 1;
      const queued = await streamer.sendTranslatedAudioChunk(pcm24k, { seq: nextSeq });
      if (queued) {
        this.laneSequence.set(lane.languageCode, nextSeq + 1);
      }

      this.stats.translationMsTotal += translationMs;
      this.stats.ttsMsTotal += ttsMs;

      return {
        lane: lane.laneKey,
        ok: Boolean(queued),
        translatedText,
        translationMs,
        ttsMs,
        bytes: pcm24k.length,
        speaker: ttsResult.speaker,
      };
    } catch (err) {
      this.stats.segmentsFailed += 1;
      const reason = this.formatHttpError(err);
      this.emit("warning", `Lane audio processing failed lane=${lane.languageCode}: ${reason}`);
      return { lane: lane.laneKey, ok: false, reason };
    }
  }

  async broadcastSegment(segment) {
    if (!segment?.buffer || !Buffer.isBuffer(segment.buffer)) {
      return;
    }

    const lagMs = Date.now() - segment.emittedAt;
    if (lagMs > this.maxSegmentQueueMs) {
      this.stats.segmentsDroppedByLag += 1;
      this.emit("warning", `Dropping segment ${segment.segmentId} lag=${lagMs}ms > ${this.maxSegmentQueueMs}ms`);
      return;
    }

    if (this.stopping) {
      return;
    }

    let englishText = "";
    const sttStart = Date.now();
    try {
      englishText = await this.transcribeSegmentToEnglish(segment.buffer);
    } catch (err) {
      this.stats.segmentsFailed += 1;
      this.emit("error", new Error(`Sarvam STT failed for segment ${segment.segmentId}: ${err.message}`));
      return;
    }
    const sttMs = Date.now() - sttStart;
    this.stats.sttMsTotal += sttMs;

    if (!englishText) {
      return;
    }

    this.stats.segmentsTranscribed += 1;

    this.stats.segmentsBroadcast += 1;

    const laneResults = await Promise.all(
      LANE_CONFIG.map((lane) => this.enqueueSegmentForLane(lane, { segment, englishText }))
    );

    const translations = {};
    for (const result of laneResults) {
      if (result?.lane && result.translatedText) {
        translations[result.lane] = { text: result.translatedText };
      }
    }

    pushTranscriptEntry({
      at: nowIso(),
      sourceText: englishText,
      translations,
    });

    this.emit("segment-broadcast", {
      segmentId: segment.segmentId,
      durationMs: segment.durationMs,
      bytes: segment.buffer.length,
      reason: segment.reason,
      sttMs,
    });
  }

  startMetrics() {
    if (this.metricsTimer) return;

    this.metricsTimer = setInterval(() => {
      this.emit("metrics", this.getStats());
    }, this.metricsIntervalMs);
  }

  stopMetrics() {
    if (!this.metricsTimer) return;
    clearInterval(this.metricsTimer);
    this.metricsTimer = null;
  }

  getStats() {
    const lanes = {};

    for (const lane of LANE_CONFIG) {
      const streamer = this.laneStreamers.get(lane.languageCode);
      lanes[lane.languageCode] = {
        laneKey: lane.laneKey,
        targetLanguage: lane.targetLanguage,
        streamer: streamer ? streamer.getStreamingStats() : null,
      };
    }

    return {
      sessionId: this.sessionId,
      provider: "Sarvam+AWSIVS",
      uptimeMs: this.stats.startedAt ? Date.now() - this.stats.startedAt : 0,
      ...this.stats,
      ingester: this.ingester.getStats(),
      vad: this.vadSegmenter.getStats(),
      lanes,
    };
  }

  async stop() {
    if (!this.started) return;
    this.stopping = true;

    this.stopMetrics();

    // Stop source ingest first so no new PCM arrives during teardown.
    await this.ingester.stop();

    // Prevent late VAD emissions from entering broadcast while shutting down.
    if (this.onVadSegment) {
      this.vadSegmenter.off("segment", this.onVadSegment);
    }

    // Optional flush for internal cleanup; no segment listener remains at this point.
    this.vadSegmenter.flush("shutdown_flush");

    // Allow in-flight lane requests to settle before disconnecting streamers.
    await Promise.allSettled(Array.from(this.laneProcessingQueues.values()));
    await this.sleep(200);

    for (const lane of LANE_CONFIG) {
      this.laneReady.set(lane.languageCode, false);
    }

    this.laneReady.clear();
    this.laneProcessingQueues.clear();
    this.laneSequence.clear();

    for (const streamer of this.laneStreamers.values()) {
      await streamer.stopStream();
    }
    this.laneStreamers.clear();

    this.started = false;
    this.stopping = false;
    this.emit("stopped", { sessionId: this.sessionId });
  }
}

function attachOrchestratorListeners(instance) {
  instance.on("started", (event) => {
    console.log(`${nowIso()} [startup] session=${event.sessionId} provider=Sarvam+AWSIVS`);
  });

  instance.on("segment-broadcast", (event) => {
    console.log(
      `${nowIso()} [segment] id=${event.segmentId} reason=${event.reason} durationMs=${event.durationMs} bytes=${event.bytes}`
    );
  });

  instance.on("warning", (message) => {
    console.warn(`${nowIso()} [warning] ${message}`);
  });

  instance.on("error", (err) => {
    console.error(`${nowIso()} [error] ${err.message}`);
  });

  instance.on("metrics", (stats) => {
    const hi = stats.lanes?.["hi-IN"]?.streamer;
    const ta = stats.lanes?.["ta-IN"]?.streamer;
    const bn = stats.lanes?.["bn-IN"]?.streamer;

    const line = [
      `${nowIso()} [metrics]`,
      `provider=Sarvam+AWSIVS`,
      `uptimeSec=${(stats.uptimeMs / 1000).toFixed(1)}`,
      `segments=${stats.segmentsBroadcast}`,
      `dropped=${stats.segmentsDroppedByLag}`,
      `sttAvgMs=${stats.segmentsTranscribed > 0 ? (stats.sttMsTotal / stats.segmentsTranscribed).toFixed(1) : "0.0"}`,
      `hiQ=${hi?.queueLength ?? 0}`,
      `taQ=${ta?.queueLength ?? 0}`,
      `bnQ=${bn?.queueLength ?? 0}`,
    ].join(" ");

    console.log(line);
  });
}

function createOrchestrator() {
  const orchestratorHlsUrl = buildPlaybackUrl(process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL || "");
  const instance = new SarvamIvsOrchestrator({
    hlsUrl: orchestratorHlsUrl,
  });
  attachOrchestratorListeners(instance);
  return instance;
}

async function startOrchestrator() {
  if (orchestratorRunning) return;
  orchestrator = createOrchestrator();
  await orchestrator.start();
  orchestratorRunning = true;
}

async function stopOrchestrator() {
  if (!orchestratorRunning || !orchestrator) return;
  await orchestrator.stop();
  orchestrator = null;
  orchestratorRunning = false;
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");
app.use(express.static("public"));

transcriptWss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "transcript-init", entries: transcriptEntries }));
});

app.get("/", (req, res) => {
  const streamUrls = getStreamUrls();
  const streamOptions = [
    { language: "original", label: "English", badge: "Original" },
    { language: "hindi", label: "Hindi", badge: "AI Voice 01" },
    { language: "bangla", label: "Bangla", badge: "AI Voice 02" },
    { language: "tamil", label: "Tamil", badge: "AI Voice 03" },
  ];

  res.render("home.ejs", {
    streamUrls,
    webrtcWhepUrls: getWhepUrls(),
    useWebrtcTranslatedAudio: String(process.env.USE_WEBRTC_TRANSLATED_AUDIO || "false").toLowerCase() === "true",
    streamOptions,
    playbackBaseUrl: normalizePlaybackBaseUrl(
      process.env.CLOUDFRONT_PLAYBACK_BASE_URL || process.env.PLAYBACK_BASE_URL || DEFAULT_PLAYBACK_BASE_URL
    ),
    viewerLocation: "Unknown Location",
    initialLanguage: "original",
    initialLiveViewerCount: 0,
    initialLiveViewerCountLabel: formatViewerCount(0),
  });
});

app.get("/dashboard", (req, res) => {
  const streamUrls = getStreamUrls();
  res.render("dashboard.ejs", {
    streamURL: streamUrls.original,
    testMode: String(process.env.TEST_MODE || "false").toLowerCase() === "true",
  });
});

app.get("/create-new-livestream", (req, res) => {
  res.render("new-live-stream.ejs");
});

app.post("/create-new-livestream", (req, res) => {
  res.json({ created: true, payload: req.body || {} });
});

app.get("/api/ivs/live-viewers", (req, res) => {
  const language = String(req.query.language || "original").toLowerCase();
  res.json({
    language,
    viewerCount: 0,
    viewerCountLabel: formatViewerCount(0),
  });
});

app.get("/health", (req, res) => {
  const stats = orchestrator ? orchestrator.getStats() : null;
  res.json({
    status: "ok",
    port: PORT,
    orchestratorRunning,
    provider: "Sarvam+AWSIVS",
    transcripts: transcriptEntries.length,
    stats,
  });
});

app.post("/orchestrator/start", async (req, res) => {
  try {
    await startOrchestrator();
    pushTranscriptEntry({
      at: nowIso(),
      sourceText: "Sarvam STT+Translate+TTS pipeline started",
      translations: { hindi: { text: "Sarvam STT+Translate+TTS pipeline started" } },
    });
    res.json({ started: true, provider: "Sarvam+AWSIVS" });
  } catch (err) {
    res.status(500).json({ started: false, error: err.message });
  }
});

app.post("/orchestrator/stop", async (req, res) => {
  try {
    await stopOrchestrator();
    res.json({ stopped: true });
  } catch (err) {
    res.status(500).json({ stopped: false, error: err.message });
  }
});

httpServer.listen(PORT, async () => {
  console.log(`${nowIso()} [http] UI server listening on http://localhost:${PORT}`);

  const autoStart = String(process.env.AUTO_START_ORCHESTRATOR || "true").toLowerCase() === "true";
  if (autoStart) {
    try {
      await startOrchestrator();
      console.log(`${nowIso()} [startup] Sarvam+AWSIVS orchestrator auto-started`);
    } catch (err) {
      console.error(`${nowIso()} [startup-error] ${err.message}`);
    }
  }
});

async function shutdown(signal) {
  console.log(`\n${nowIso()} [shutdown] Caught ${signal}`);
  try {
    await stopOrchestrator();
  } catch {
    // Best effort shutdown.
  }
  process.exit(0);
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
});
