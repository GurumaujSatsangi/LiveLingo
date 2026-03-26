import express from "express";
import http from "http";
import dotenv from "dotenv";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import ivsSdk from "@aws-sdk/client-ivs";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { WebSocketServer } from "ws";
import fs from "fs";
import path from "path";
import { SarvamAIClient } from "sarvamai";
import OpenAI from "openai";
import wavefilePkg from "wavefile";
import IVSTranslatorStreamer from "./ivsTranslatorStreamer.js";
import StreamSessionManager from "./StreamSessionManager.js";

const { WaveFile } = wavefilePkg;
const { IvsClient, GetStreamCommand } = ivsSdk;

dotenv.config();

const app = express();

// Middleware
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");

const SEGMENT_FOLDER = "./audio_chunks";
const TRANSLATED_AUDIO_FOLDER = "./translated_audio";
const SAMPLE_FOLDER = "./sample";
const MAX_RESTART_RETRIES = 5;
const CHUNK_SCAN_INTERVAL_MS = 400;
const MAX_CHUNK_RETRIES = 2;
const TARGET_CHUNK_DURATION_SEC = 2;
const DUBBING_BATCH_SIZE = 1;
const MIN_ACCEPTABLE_CHUNK_DURATION_SEC = 1.7;
const SHORT_CHUNK_SKIP_AGE_MS = 8 * 1000;
const USE_DIRECT_ELEVENLABS_DUBBING =
  String(process.env.USE_DIRECT_ELEVENLABS_DUBBING || "false").toLowerCase() === "true";
const DIRECT_DUBBING_CHUNK_DURATION_SEC = Number(process.env.DIRECT_DUBBING_CHUNK_DURATION_SEC || 1);
const PCM_SAMPLE_RATE = 16000;
const PCM_BYTES_PER_SAMPLE = 2;
const PCM_FRAME_BYTES = 640;
const SESSION_SAMPLE_TARGET_SEC = 7;
const SESSION_SAMPLE_INPUT_CHUNKS = 4;
const ELEVENLABS_DUBBING_MAX_WAIT_MS = Number(process.env.ELEVENLABS_DUBBING_MAX_WAIT_MS || 45000);
const ELEVENLABS_DUBBING_POLL_MS = Number(process.env.ELEVENLABS_DUBBING_POLL_MS || 1200);
const ELEVENLABS_TARGET_LANG = "hi";
const ELEVENLABS_SOURCE_VOICE_ID = process.env.ELEVENLABS_SOURCE_VOICE_ID || "JBFqnCBsd6RMkjVDRZzb";
const ELEVENLABS_SOURCE_MODEL_ID = process.env.ELEVENLABS_SOURCE_MODEL_ID || "eleven_multilingual_v2";
const ELEVENLABS_DUBBING_WATERMARK =
  String(process.env.ELEVENLABS_DUBBING_WATERMARK || "true").toLowerCase() !== "false";
const WRITE_TRANSLATED_AUDIO_FILES =
  String(process.env.WRITE_TRANSLATED_AUDIO_FILES || "true").toLowerCase() !== "false";
const SARVAM_TTS_TARGET_LANGUAGE = process.env.SARVAM_TTS_TARGET_LANGUAGE || "hi-IN";
const SARVAM_TTS_SPEAKER = process.env.SARVAM_TTS_SPEAKER || "karun";
const SARVAM_TTS_MODEL = process.env.SARVAM_TTS_MODEL || "bulbul:v2";
const SARVAM_TTS_SAMPLE_RATE = Number(process.env.SARVAM_TTS_SAMPLE_RATE || 16000);
const SARVAM_TTS_OUTPUT_CODEC = process.env.SARVAM_TTS_OUTPUT_CODEC || "wav";
const USE_EXTERNAL_REALTIME_PIPELINE =
  String(process.env.USE_EXTERNAL_REALTIME_PIPELINE || "false").toLowerCase() === "true";
const REALTIME_PIPELINE_BASE_URL = String(process.env.REALTIME_PIPELINE_BASE_URL || "http://localhost:4010").replace(
  /\/$/,
  ""
);
const REALTIME_PIPELINE_OUTPUT_SECRET = process.env.REALTIME_PIPELINE_OUTPUT_SECRET || "";
const REALTIME_CAPTURE_CHUNK_DURATION_SEC = Number(
  process.env.REALTIME_CAPTURE_CHUNK_DURATION_SEC || TARGET_CHUNK_DURATION_SEC
);
const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE;
let restartAttempts = 0;
let lastRestartTime = 0;

const sarvamClient = process.env.SARVAM_API_KEY
  ? new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY })
  : null;
const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const elevenlabsClient = process.env.ELEVENLABS_API_KEY
  ? new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
  : null;

// Initialize Session Manager
const sessionManager = new StreamSessionManager();

const SOURCE_VIDEO_URL = process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL || "";
const VIDEO_SYNC_DELAY_SEC = Number(process.env.VIDEO_SYNC_DELAY_SEC || 6);
const DEFAULT_PLAYBACK_BASE_URL = "https://a7936abd8b67.ap-south-1.playback.live-video.net";
function normalizePlaybackBaseUrl(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return DEFAULT_PLAYBACK_BASE_URL;
  }

  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(withProtocol);
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
    return `${parsed.origin}${pathname}`;
  } catch (err) {
    console.warn(
      `⚠️  Invalid CLOUDFRONT_PLAYBACK_BASE_URL/PLAYBACK_BASE_URL: ${value}. Falling back to default.`
    );
    return DEFAULT_PLAYBACK_BASE_URL;
  }
}

const PLAYBACK_BASE_URL = normalizePlaybackBaseUrl(
  process.env.CLOUDFRONT_PLAYBACK_BASE_URL || process.env.PLAYBACK_BASE_URL || DEFAULT_PLAYBACK_BASE_URL
);

function getPlaybackPathFromChannelArn(channelArn) {
  const arn = String(channelArn || "").trim();
  if (!arn) {
    return "";
  }

  const match = arn.match(/^arn:aws:ivs:([a-z0-9-]+):(\d+):channel\/([A-Za-z0-9_-]+)$/i);
  if (!match) {
    return "";
  }

  const [, region, accountId, channelId] = match;
  return `/api/video/v1/${region}.${accountId}.channel.${channelId}.m3u8`;
}

const LEGACY_PLAYBACK_CHANNEL_PATHS = {
  original: "/api/video/v1/ap-south-1.281851731848.channel.UqVC4zjntu05.m3u8",
  hindi: "/api/video/v1/ap-south-1.281851731848.channel.dAAx194gnHFl.m3u8",
};

const ARN_DERIVED_PLAYBACK_CHANNEL_PATHS = {
  original: getPlaybackPathFromChannelArn(process.env.AWS_IVS_CHANNEL_ARN_ORIGINAL || process.env.AWS_IVS_CHANNEL_ARN),
  hindi: getPlaybackPathFromChannelArn(process.env.AWS_IVS_CHANNEL_ARN_HINDI),
  bangla: getPlaybackPathFromChannelArn(process.env.AWS_IVS_CHANNEL_ARN_BANGLA),
  tamil: getPlaybackPathFromChannelArn(process.env.AWS_IVS_CHANNEL_ARN_TAMIL),
};

const PLAYBACK_CHANNEL_PATHS = {
  original:
    process.env.PLAYBACK_CHANNEL_PATH_ORIGINAL ||
    process.env.AWS_IVS_PLAYBACK_URL_ORIGINAL ||
    process.env.AWS_IVS_PLAYBACK_URL ||
    process.env.LIVESTREAM_HLS_URL ||
    ARN_DERIVED_PLAYBACK_CHANNEL_PATHS.original ||
    LEGACY_PLAYBACK_CHANNEL_PATHS.original,
  hindi:
    process.env.PLAYBACK_CHANNEL_PATH_HINDI ||
    process.env.AWS_IVS_PLAYBACK_URL_HINDI ||
    ARN_DERIVED_PLAYBACK_CHANNEL_PATHS.hindi ||
    process.env.AWS_IVS_PLAYBACK_URL ||
    process.env.LIVESTREAM_HLS_URL ||
    LEGACY_PLAYBACK_CHANNEL_PATHS.hindi,
  bangla:
    process.env.PLAYBACK_CHANNEL_PATH_BANGLA ||
    process.env.AWS_IVS_PLAYBACK_URL_BANGLA ||
    ARN_DERIVED_PLAYBACK_CHANNEL_PATHS.bangla ||
    process.env.AWS_IVS_PLAYBACK_URL ||
    process.env.LIVESTREAM_HLS_URL ||
    "",
  tamil:
    process.env.PLAYBACK_CHANNEL_PATH_TAMIL ||
    process.env.AWS_IVS_PLAYBACK_URL_TAMIL ||
    ARN_DERIVED_PLAYBACK_CHANNEL_PATHS.tamil ||
    process.env.AWS_IVS_PLAYBACK_URL ||
    process.env.LIVESTREAM_HLS_URL ||
    "",
};

const WEBRTC_WHEP_URLS = {
  original: String(process.env.WEBRTC_WHEP_URL_ORIGINAL || "").trim(),
  hindi: String(process.env.WEBRTC_WHEP_URL_HINDI || "").trim(),
  bangla: String(process.env.WEBRTC_WHEP_URL_BANGLA || "").trim(),
  tamil: String(process.env.WEBRTC_WHEP_URL_TAMIL || "").trim(),
};
const USE_WEBRTC_TRANSLATED_AUDIO =
  String(process.env.USE_WEBRTC_TRANSLATED_AUDIO || "false").toLowerCase() === "true";

const IVS_REGION = process.env.AWS_REGION || process.env.AWS_IVS_REGION || "ap-south-1";
const IVS_CHANNEL_ARNS = {
  original: process.env.AWS_IVS_CHANNEL_ARN_ORIGINAL || process.env.AWS_IVS_CHANNEL_ARN || "",
  hindi: process.env.AWS_IVS_CHANNEL_ARN_HINDI || "",
  bangla: process.env.AWS_IVS_CHANNEL_ARN_BANGLA || "",
  tamil: process.env.AWS_IVS_CHANNEL_ARN_TAMIL || "",
};
const LOCATION_LOOKUP_TIMEOUT_MS = Number(process.env.LOCATION_LOOKUP_TIMEOUT_MS || 2000);
const IP_GEO_ENDPOINT = process.env.IP_GEO_ENDPOINT || "https://ipapi.co";

const ivsClient = new IvsClient({ region: IVS_REGION });

function buildPlaybackUrl(channelPath) {
  if (!channelPath) {
    return null;
  }

  if (/^https?:\/\//i.test(channelPath)) {
    return channelPath;
  }

  const normalizedPath = channelPath.startsWith("/") ? channelPath : `/${channelPath}`;
  return `${PLAYBACK_BASE_URL}${normalizedPath}`;
}

function formatViewerCount(viewerCount) {
  if (!Number.isFinite(viewerCount) || viewerCount < 0) {
    return "--";
  }

  if (viewerCount < 1000) {
    return String(viewerCount);
  }

  const compact = Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(viewerCount);
  return compact.toLowerCase();
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").trim();
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const rawIp = req.socket?.remoteAddress || req.ip || "";
  return rawIp.replace(/^::ffff:/, "");
}

function isPrivateOrLocalIp(ipAddress) {
  if (!ipAddress) return true;
  return (
    ipAddress === "::1" ||
    ipAddress === "127.0.0.1" ||
    ipAddress.startsWith("10.") ||
    ipAddress.startsWith("192.168.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(ipAddress)
  );
}

async function fetchLocationForRequest(req) {
  const ipAddress = getClientIp(req);

  if (isPrivateOrLocalIp(ipAddress)) {
    return "Unknown Location";
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOCATION_LOOKUP_TIMEOUT_MS);

  try {
    const response = await fetch(`${IP_GEO_ENDPOINT}/${encodeURIComponent(ipAddress)}/json/`, {
      signal: controller.signal,
    });

    if (!response.ok) {
      return "Unknown Location";
    }

    const payload = await response.json();
    const city = String(payload.city || "").trim();
    const region = String(payload.region || payload.region_code || "").trim();
    const country = String(payload.country_name || payload.country || "").trim();
    const parts = [city, region, country].filter(Boolean);

    return parts.length ? parts.join(", ") : "Unknown Location";
  } catch (err) {
    return "Unknown Location";
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchLiveViewerCount(language) {
  const requestedLanguage = String(language || "original").toLowerCase();
  const channelArn = IVS_CHANNEL_ARNS[requestedLanguage];

  if (!channelArn) {
    return null;
  }

  try {
    const response = await ivsClient.send(new GetStreamCommand({ channelArn }));
    const viewerCount = response?.stream?.viewerCount;

    if (!Number.isFinite(viewerCount)) {
      return 0;
    }

    return viewerCount;
  } catch (err) {
    const isOffline =
      err?.name === "ResourceNotFoundException" ||
      err?.$metadata?.httpStatusCode === 404;

    if (!isOffline) {
      console.warn(`⚠️  Unable to fetch IVS viewers for ${requestedLanguage}: ${err.message}`);
    }

    return 0;
  }
}

function getActiveChunkDurationSec() {
  if (!USE_DIRECT_ELEVENLABS_DUBBING) {
    return TARGET_CHUNK_DURATION_SEC;
  }

  if (Number.isFinite(DIRECT_DUBBING_CHUNK_DURATION_SEC) && DIRECT_DUBBING_CHUNK_DURATION_SEC > 0) {
    return DIRECT_DUBBING_CHUNK_DURATION_SEC;
  }

  return 1;
}

function getActiveMinChunkDurationSec() {
  if (!USE_DIRECT_ELEVENLABS_DUBBING) {
    return MIN_ACCEPTABLE_CHUNK_DURATION_SEC;
  }

  return Math.max(0.8, getActiveChunkDurationSec() * 0.85);
}

function getActiveDubbingBatchSize() {
  return USE_DIRECT_ELEVENLABS_DUBBING ? 1 : DUBBING_BATCH_SIZE;
}

function createSilencePcmChunk(durationSec = getActiveChunkDurationSec()) {
  const fallbackDurationSec = getActiveChunkDurationSec();
  const safeDurationSec = Number.isFinite(durationSec) && durationSec > 0 ? durationSec : fallbackDurationSec;
  const sampleCount = Math.max(1, Math.round(safeDurationSec * PCM_SAMPLE_RATE));
  return Buffer.alloc(sampleCount * PCM_BYTES_PER_SAMPLE);
}

async function ensureConfiguredStreamsStarted(sessionId) {
  for (const pipeline of LANGUAGE_PIPELINES) {
    if (!pipeline.isConfigured()) {
      continue;
    }

    if (!sessionManager.isStreamActive(pipeline.language)) {
      console.log(`🎬 Starting ${pipeline.language} stream for session ${sessionId}`);
      const started = await pipeline.streamer.startStream(sessionId);
      if (started) {
        sessionManager.markStreamActive(sessionId, pipeline.language);
      }
    }
  }
}

async function enqueueSilenceForRunningStreams(sessionId, sequenceNumber) {
  const silencePcm = createSilencePcmChunk(getActiveChunkDurationSec());
  const runningPipelines = LANGUAGE_PIPELINES.filter(
    (pipeline) => pipeline.streamer && pipeline.streamer.isRunning
  );

  await Promise.allSettled(
    runningPipelines.map(async (pipeline) => {
      await pipeline.streamer.sendTranslatedAudioChunk(silencePcm, { seq: sequenceNumber });
      sessionManager.incrementChunkCount(sessionId, pipeline.language);
    })
  );
}

// Initialize IVS Translator Streamers for each language
const ivsStreamers = {
  hindi: new IVSTranslatorStreamer({
    language: "hindi",
    sourceVideoUrl: SOURCE_VIDEO_URL,
    videoSyncDelaySec: VIDEO_SYNC_DELAY_SEC,
  }),
};

const LANGUAGE_PIPELINES = [
  {
    language: "hindi",
    ttsLanguageCode: "hi-IN",
    streamer: ivsStreamers.hindi,
    isConfigured: () => Boolean(process.env.AWS_IVS_INGEST_URL_HINDI && process.env.AWS_IVS_STREAM_KEY_HINDI),
  },
];

const chunkQueue = [];
const queuedChunks = new Set();
const processedChunks = new Set();
const failedChunkRetries = new Map();
const chunkSequenceNumbers = new Map();
let nextChunkSequence = 1;
const transcriptResults = [];
let isChunkWorkerRunning = false;
let chunkScannerTimer;
let isSarvamProcessingChunk = false;
let dubbingReferenceSamplePath = null;
let isDubbingReferenceInitialized = false;
let dubbingReferenceSessionId = null;
let realtimePipelineTimelineSec = 0;
const hindiPipelineOutputBuffer = new Map();
let nextHindiPipelineSeqToSend = 1;

const httpServer = http.createServer(app);
const transcriptWebSocketPath = "/ws/transcripts";
const transcriptWss = new WebSocketServer({ server: httpServer, path: transcriptWebSocketPath });
const transcriptClients = new Set();

function sendWebSocketMessage(ws, payload) {
  if (!ws || ws.readyState !== 1) {
    return;
  }

  ws.send(JSON.stringify(payload));
}

function getLatestTranscriptEntries() {
  return transcriptResults
    .slice(-20)
    .filter((entry) => entry && (entry.sourceText || entry?.translations?.hindi?.text));
}

function broadcastTranscriptEntry(entry) {
  if (!entry) {
    return;
  }

  const payload = {
    type: "transcript-new",
    entry,
  };

  for (const client of transcriptClients) {
    sendWebSocketMessage(client, payload);
  }
}

transcriptWss.on("connection", (ws) => {
  transcriptClients.add(ws);

  sendWebSocketMessage(ws, {
    type: "transcript-init",
    entries: getLatestTranscriptEntries(),
  });

  ws.on("close", () => {
    transcriptClients.delete(ws);
  });

  ws.on("error", () => {
    transcriptClients.delete(ws);
  });
});

async function flushHindiPipelineOutputBuffer(sessionId, hindiStreamer) {
  const flushedSeqIds = [];

  while (hindiPipelineOutputBuffer.has(nextHindiPipelineSeqToSend)) {
    const pcmBuffer = hindiPipelineOutputBuffer.get(nextHindiPipelineSeqToSend);
    hindiPipelineOutputBuffer.delete(nextHindiPipelineSeqToSend);

    await hindiStreamer.sendTranslatedAudioChunk(pcmBuffer, { seq: nextHindiPipelineSeqToSend });
    sessionManager.incrementChunkCount(sessionId, "hindi");
    sessionManager.incrementChunkCount(sessionId, "source");

    flushedSeqIds.push(nextHindiPipelineSeqToSend);
    nextHindiPipelineSeqToSend += 1;
  }

  return flushedSeqIds;
}

// create folders if not exist
if (!fs.existsSync(SEGMENT_FOLDER)) {
  fs.mkdirSync(SEGMENT_FOLDER);
}
if (!fs.existsSync(TRANSLATED_AUDIO_FOLDER)) {
  fs.mkdirSync(TRANSLATED_AUDIO_FOLDER);
}
if (!fs.existsSync(SAMPLE_FOLDER)) {
  fs.mkdirSync(SAMPLE_FOLDER);
}

let ffmpeg;
let isFFmpegRunning = false;
let realtimeCaptureFfmpeg;
let realtimeCaptureBuffer = Buffer.alloc(0);
let nextRealtimeCaptureSequence = 1;
let isRealtimeCaptureFlushRunning = false;
let shouldStopRealtimeCapture = false;

async function processRealtimeCaptureBuffer() {
  if (isRealtimeCaptureFlushRunning) {
    return;
  }

  isRealtimeCaptureFlushRunning = true;
  const chunkDurationSec =
    Number.isFinite(REALTIME_CAPTURE_CHUNK_DURATION_SEC) && REALTIME_CAPTURE_CHUNK_DURATION_SEC > 0
      ? REALTIME_CAPTURE_CHUNK_DURATION_SEC
      : getActiveChunkDurationSec();
  const chunkBytes = Math.max(PCM_FRAME_BYTES, Math.round(chunkDurationSec * PCM_BYTES_PER_SECOND));

  try {
    while (realtimeCaptureBuffer.length >= chunkBytes) {
      const chunkPcmBuffer = realtimeCaptureBuffer.subarray(0, chunkBytes);
      realtimeCaptureBuffer = realtimeCaptureBuffer.subarray(chunkBytes);

      const sequenceNumber = nextRealtimeCaptureSequence++;
      await forwardPcmChunkToRealtimePipeline(chunkPcmBuffer, sequenceNumber, chunkDurationSec);
      sessionManager.incrementChunkCount(sessionManager.getCurrentSession().sessionId, "source");
    }
  } catch (err) {
    console.error(`❌ Realtime in-memory forwarding failed: ${err.message}`);
  } finally {
    isRealtimeCaptureFlushRunning = false;

    // If new data arrived while flushing, process again.
    if (realtimeCaptureBuffer.length >= chunkBytes) {
      void processRealtimeCaptureBuffer();
    }
  }
}

async function stopRealtimeAudioCapture() {
  shouldStopRealtimeCapture = true;
  isFFmpegRunning = false;

  if (realtimeCaptureFfmpeg && !realtimeCaptureFfmpeg.killed) {
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          realtimeCaptureFfmpeg.kill("SIGKILL");
        } catch {
          // Best effort kill.
        }
        resolve();
      }, 4000);

      realtimeCaptureFfmpeg.once("close", () => {
        clearTimeout(timeout);
        resolve();
      });

      try {
        realtimeCaptureFfmpeg.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        resolve();
      }
    });
  }

  realtimeCaptureFfmpeg = null;
  realtimeCaptureBuffer = Buffer.alloc(0);
  isRealtimeCaptureFlushRunning = false;
}

async function startRealtimeAudioCapture() {
  if (!USE_EXTERNAL_REALTIME_PIPELINE) {
    return;
  }

  if (realtimeCaptureFfmpeg && !realtimeCaptureFfmpeg.killed) {
    console.log("⏳ Realtime audio capture already running");
    return;
  }

  const streamURL = getStreamURL();
  if (!streamURL) {
    console.error("❌ Realtime audio capture requires AWS_IVS_PLAYBACK_URL or LIVESTREAM_HLS_URL");
    return;
  }

  if (!REALTIME_PIPELINE_BASE_URL) {
    console.error("❌ REALTIME_PIPELINE_BASE_URL is required for in-memory realtime capture");
    return;
  }

  shouldStopRealtimeCapture = false;
  console.log("🎧 Starting in-memory realtime audio capture (no disk chunks)...");

  const isAccessible = await validateStreamURL(streamURL);
  if (!isAccessible) {
    restartAttempts++;
    const delay = getBackoffDelay();

    if (restartAttempts > MAX_RESTART_RETRIES) {
      console.error(`❌ Max restart attempts (${MAX_RESTART_RETRIES}) exceeded for realtime audio capture`);
      return;
    }

    setTimeout(() => {
      if (!shouldStopRealtimeCapture) {
        void startRealtimeAudioCapture();
      }
    }, delay);
    return;
  }

  realtimeCaptureBuffer = Buffer.alloc(0);
  const ffmpegArgs = [
    "-loglevel",
    "warning",
    "-live_start_index",
    "-1",
    "-fflags",
    "+nobuffer+fastseek",
    "-flags",
    "low_delay",
    "-protocol_whitelist",
    "file,http,https,tcp,tls,crypto,data",
    "-http_persistent",
    "1",
    "-http_multiple",
    "1",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_delay_max",
    "2",
    "-i",
    streamURL,
    "-map",
    "0:a:0",
    "-acodec",
    "pcm_s16le",
    "-ar",
    String(PCM_SAMPLE_RATE),
    "-ac",
    "1",
    "-f",
    "s16le",
    "pipe:1",
  ];

  realtimeCaptureFfmpeg = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  realtimeCaptureFfmpeg.stdout.on("data", (data) => {
    if (!Buffer.isBuffer(data) || data.length === 0) {
      return;
    }

    realtimeCaptureBuffer = Buffer.concat([realtimeCaptureBuffer, data]);
    void processRealtimeCaptureBuffer();
  });

  realtimeCaptureFfmpeg.stderr.on("data", (data) => {
    const message = data.toString().trim();
    if (message && !message.includes("frame=") && !message.includes("Last message repeated")) {
      console.log(`🔊 Realtime capture FFmpeg: ${message}`);
    }
  });

  realtimeCaptureFfmpeg.on("error", (err) => {
    console.error(`❌ Realtime capture FFmpeg error: ${err.message}`);
  });

  realtimeCaptureFfmpeg.on("close", () => {
    realtimeCaptureFfmpeg = null;
    isFFmpegRunning = false;

    if (shouldStopRealtimeCapture) {
      return;
    }

    restartAttempts++;
    const delay = getBackoffDelay();
    if (restartAttempts <= MAX_RESTART_RETRIES) {
      setTimeout(() => {
        if (!shouldStopRealtimeCapture) {
          void startRealtimeAudioCapture();
        }
      }, delay);
    } else {
      console.error(`❌ Max restart attempts (${MAX_RESTART_RETRIES}) exceeded for realtime audio capture`);
    }
  });

  isFFmpegRunning = true;
  restartAttempts = 0;
}

function normalizeText(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.join(" ");
  return "";
}

function extractTranscriptText(response) {
  if (!response || typeof response !== "object") return "";

  return (
    normalizeText(response.translated_text) ||
    normalizeText(response.transcription) ||
    normalizeText(response.transcript) ||
    normalizeText(response.text) ||
    normalizeText(response.output_text) ||
    ""
  );
}

function ffmpegTranscodeBufferToOutput(inputBuffer, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks = [];
    let stderr = "";

    proc.stdout.on("data", (data) => chunks.push(data));
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks));
        return;
      }

      reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim()}`));
    });

    proc.stdin.on("error", () => {
      // Ignore stdin race errors on process termination; close handler will surface failures.
    });
    proc.stdin.end(inputBuffer);
  });
}

function ffmpegRun(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`FFmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getChunkFilesSortedByMtime() {
  if (!fs.existsSync(SEGMENT_FOLDER)) {
    return [];
  }

  return fs
    .readdirSync(SEGMENT_FOLDER)
    .filter((file) => file.endsWith(".wav") && !file.includes("_sarvam_"))
    .map((file) => {
      const fullPath = path.join(SEGMENT_FOLDER, file);
      const stats = fs.statSync(fullPath);
      return { fullPath, mtimeMs: stats.mtimeMs };
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .map((entry) => entry.fullPath);
}

function pickReferenceSampleChunkPath(fallbackChunkPath = null) {
  const chunkFiles = getChunkFilesSortedByMtime();

  if (chunkFiles.length > 0) {
    const middleIndex = Math.floor(chunkFiles.length / 2);
    return chunkFiles[middleIndex];
  }

  return fallbackChunkPath || null;
}





function getMiddleBiasedCandidates(paths) {
  if (!paths.length) {
    return [];
  }

  const middle = Math.floor(paths.length / 2);
  return paths
    .map((filePath, index) => ({ filePath, distance: Math.abs(index - middle) }))
    .sort((a, b) => a.distance - b.distance)
    .map((entry) => entry.filePath);
}

async function isAudioFileDecodable(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return false;
  }

  try {
    const stats = fs.statSync(filePath);
    if (stats.size <= 44) {
      return false;
    }

    const duration = getWavDurationSeconds(filePath);
    if (!Number.isFinite(duration) || duration <= 0.2) {
      return false;
    }

    await ffmpegRun([
      "-v",
      "error",
      "-i",
      filePath,
      "-t",
      "0.2",
      "-f",
      "null",
      "-",
    ]);

    return true;
  } catch {
    return false;
  }
}

async function pickValidSampleInputs(allChunks, fallbackChunkPath = null) {
  const middleBiased = getMiddleBiasedCandidates(allChunks);
  const selected = [];

  for (const candidate of middleBiased) {
    if (selected.length >= SESSION_SAMPLE_INPUT_CHUNKS) {
      break;
    }

    if (await isAudioFileDecodable(candidate)) {
      selected.push(candidate);
    }
  }

  if (!selected.length && fallbackChunkPath && (await isAudioFileDecodable(fallbackChunkPath))) {
    selected.push(fallbackChunkPath);
  }

  return selected;
}

function getAudioContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".wav") return "audio/wav";
  if (ext === ".mp3") return "audio/mpeg";
  if (ext === ".m4a") return "audio/mp4";
  if (ext === ".ogg") return "audio/ogg";
  return "audio/mpeg";
}

function buildStreamableFile(streamPath) {
  return {
    path: streamPath,
    filename: path.basename(streamPath),
    contentType: getAudioContentType(streamPath),
  };
}

async function concatAudioInputsToWav(inputPaths, outputPath, targetDurationSec = null) {
  if (!inputPaths.length) {
    throw new Error("No input paths provided for audio concatenation");
  }

  const args = [];
  for (const inputPath of inputPaths) {
    args.push("-i", inputPath);
  }

  const concatInputs = inputPaths.map((_, idx) => `[${idx}:a]`).join("");
  const filter = `${concatInputs}concat=n=${inputPaths.length}:v=0:a=1[aout]`;

  args.push(
    "-filter_complex",
    filter,
    "-map",
    "[aout]",
    "-ar",
    String(PCM_SAMPLE_RATE),
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le"
  );

  if (targetDurationSec && targetDurationSec > 0) {
    args.push("-t", String(targetDurationSec));
  }

  args.push(outputPath);

  await ffmpegRun(args);
}

async function buildSessionSampleClip(sessionId, fallbackChunkPath = null) {
  const allChunks = getChunkFilesSortedByMtime();
  const sampleInputs = await pickValidSampleInputs(allChunks, fallbackChunkPath);

  if (!sampleInputs.length) {
    return null;
  }

  const sampleOutputPath = path.join(SAMPLE_FOLDER, `session_${sessionId}_sample.wav`);
  await concatAudioInputsToWav(sampleInputs, sampleOutputPath, SESSION_SAMPLE_TARGET_SEC);
  return sampleOutputPath;
}

function splitPcmBufferIntoEqualParts(pcmBuffer, parts) {
  if (!pcmBuffer || parts <= 0) {
    return [];
  }

  const slices = [];
  const targetSize = Math.ceil(pcmBuffer.length / parts);

  for (let index = 0; index < parts; index++) {
    const start = index * targetSize;
    const end = Math.min(pcmBuffer.length, start + targetSize);
    const chunk = pcmBuffer.slice(start, end);

    const remainder = chunk.length % PCM_FRAME_BYTES;
    if (remainder === 0) {
      slices.push(chunk);
      continue;
    }

    const padded = Buffer.alloc(chunk.length + (PCM_FRAME_BYTES - remainder));
    chunk.copy(padded);
    slices.push(padded);
  }

  return slices;
}

function isWatermarkSubscriptionError(err) {
  const message = String(err?.message || "").toLowerCase();
  return (
    message.includes("watermark_not_allowed") ||
    message.includes("subscription_required") ||
    message.includes("dubbing without a watermark")
  );
}

async function createDubbingJob(payload) {
  let useWatermark = ELEVENLABS_DUBBING_WATERMARK;

  try {
    return await elevenlabsClient.dubbing.create({
      ...payload,
      watermark: useWatermark,
    });
  } catch (err) {
    if (!useWatermark && isWatermarkSubscriptionError(err)) {
      console.warn("⚠️  ElevenLabs plan requires watermark for dubbing. Retrying with watermark enabled.");
      return elevenlabsClient.dubbing.create({
        ...payload,
        watermark: true,
      });
    }

    throw err;
  }
}

function resetDubbingReferenceForSession(sessionId) {
  if (dubbingReferenceSessionId === sessionId) {
    return;
  }

  dubbingReferenceSessionId = sessionId;
  dubbingReferenceSamplePath = null;
  isDubbingReferenceInitialized = false;
}

async function ensureDubbingReferenceSample(sessionId, currentChunkPath) {
  resetDubbingReferenceForSession(sessionId);

  if (isDubbingReferenceInitialized) {
    return;
  }

  if (!elevenlabsClient) {
    return;
  }

  try {
    dubbingReferenceSamplePath = await buildSessionSampleClip(sessionId, currentChunkPath);
  } catch (err) {
    console.error(`⚠️  Failed to build session sample clip: ${err.message}`);
    dubbingReferenceSamplePath = null;
  }

  if (!dubbingReferenceSamplePath || !fs.existsSync(dubbingReferenceSamplePath)) {
    console.warn("⚠️  Could not initialize ElevenLabs sample file for dubbing.");
    return;
  }

  try {
    // Prime the dubbing pipeline once using a mid-length source sample.
    await createDubbingJob({
      file: buildStreamableFile(dubbingReferenceSamplePath),
      sourceLang: ELEVENLABS_TARGET_LANG,
      targetLang: ELEVENLABS_TARGET_LANG,
      name: `livelingo_reference_${Date.now()}`,
      numSpeakers: 1,
      disableVoiceCloning: false,
    });

    isDubbingReferenceInitialized = true;
    console.log(
      `🎙️  ElevenLabs dubbing reference initialized with sample ${path.basename(dubbingReferenceSamplePath)}`
    );
  } catch (err) {
    console.error(`⚠️  ElevenLabs sample initialization failed: ${err.message}`);
  }
}

async function readStreamingResponseToBuffer(streamData) {
  if (!streamData) {
    return null;
  }

  if (Buffer.isBuffer(streamData)) {
    return streamData;
  }

  if (streamData instanceof Uint8Array) {
    return Buffer.from(streamData);
  }

  if (streamData instanceof ArrayBuffer) {
    return Buffer.from(streamData);
  }

  if (typeof streamData.arrayBuffer === "function") {
    const arrayBuffer = await streamData.arrayBuffer();
    return Buffer.from(arrayBuffer);
  }

  const chunks = [];
  for await (const chunk of streamData) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return chunks.length ? Buffer.concat(chunks) : null;
}

async function waitForDubAndFetchAudio(dubbingId, targetLangCode) {
  const deadline = Date.now() + ELEVENLABS_DUBBING_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    const dubMetadata = await elevenlabsClient.dubbing.get(dubbingId);
    const status = String(dubMetadata?.status || "").toLowerCase();

    if (status === "dubbed") {
      const audioResponse = await elevenlabsClient.dubbing.audio.get(dubbingId, targetLangCode);
      return readStreamingResponseToBuffer(audioResponse);
    }

    if (status === "failed" || status === "error") {
      throw new Error(`Dubbing failed for ${dubbingId}: ${dubMetadata?.error || "unknown error"}`);
    }

    await sleep(ELEVENLABS_DUBBING_POLL_MS);
  }

  throw new Error(`Timed out waiting for ElevenLabs dubbing result for ${dubbingId}`);
}

async function convertTextToSpeechWithElevenLabs(text, chunkName) {
  if (!text || !elevenlabsClient) {
    return { audioPath: null, audioBuffer: null };
  }

  try {
    const elevenAudio = await elevenlabsClient.textToSpeech.convert(ELEVENLABS_SOURCE_VOICE_ID, {
      text,
      modelId: ELEVENLABS_SOURCE_MODEL_ID,
    });

    const audioBuffer = await readStreamingResponseToBuffer(elevenAudio);
    if (!audioBuffer?.length) {
      return { audioPath: null, audioBuffer: null };
    }

    let outputPath = null;
    if (WRITE_TRANSLATED_AUDIO_FILES) {
      const baseName = path.basename(chunkName, path.extname(chunkName));
      outputPath = path.join(TRANSLATED_AUDIO_FOLDER, `${baseName}_hi_eleven_source.mp3`);
      fs.writeFileSync(outputPath, audioBuffer);
    }

    return { audioPath: outputPath, audioBuffer };
  } catch (err) {
    console.error(`❌ ElevenLabs source TTS failed for ${chunkName}: ${err.message}`);
    return { audioPath: null, audioBuffer: null };
  }
}

async function createDubbedAudioWithElevenLabs(sessionId, translatedText, chunkName, sourceChunkPath) {
  if (!translatedText || !elevenlabsClient) {
    return null;
  }

  await ensureDubbingReferenceSample(sessionId, sourceChunkPath);

  const sourceSpeech = await convertTextToSpeechWithElevenLabs(translatedText, chunkName);
  if (!sourceSpeech.audioBuffer) {
    return null;
  }

  const sourceBaseName = path.basename(chunkName, path.extname(chunkName));
  const sourceAudioPath = path.join(TRANSLATED_AUDIO_FOLDER, `${sourceBaseName}_hi_source.mp3`);
  const combinedInputPath = path.join(TRANSLATED_AUDIO_FOLDER, `${sourceBaseName}_hi_with_sample.wav`);
  fs.writeFileSync(sourceAudioPath, sourceSpeech.audioBuffer);

  try {
    let dubbingInputPath = sourceAudioPath;
    if (dubbingReferenceSamplePath && fs.existsSync(dubbingReferenceSamplePath)) {
      try {
        await concatAudioInputsToWav([dubbingReferenceSamplePath, sourceAudioPath], combinedInputPath);
        dubbingInputPath = combinedInputPath;
      } catch (err) {
        console.warn(
          `⚠️  Sample prepend failed for ${chunkName}. Continuing with source-only audio: ${err.message}`
        );
      }
    }

    const dubResponse = await createDubbingJob({
      file: buildStreamableFile(dubbingInputPath),
      sourceLang: ELEVENLABS_TARGET_LANG,
      targetLang: ELEVENLABS_TARGET_LANG,
      name: `${sourceBaseName}_hi_dub_${Date.now()}`,
      numSpeakers: 1,
      disableVoiceCloning: false,
    });

    const dubbingId = dubResponse?.dubbingId;
    if (!dubbingId) {
      return null;
    }

    const dubbedAudioBuffer = await waitForDubAndFetchAudio(dubbingId, ELEVENLABS_TARGET_LANG);
    if (!dubbedAudioBuffer?.length) {
      return null;
    }

    let outputPath = null;
    if (WRITE_TRANSLATED_AUDIO_FILES) {
      outputPath = path.join(TRANSLATED_AUDIO_FOLDER, `${sourceBaseName}_hi_dubbed.wav`);
      fs.writeFileSync(outputPath, dubbedAudioBuffer);
    }

    return {
      audioPath: outputPath,
      audioBuffer: dubbedAudioBuffer,
      dubbingId,
    };
  } finally {
    try {
      fs.unlinkSync(sourceAudioPath);
    } catch {
      // Best-effort cleanup for temp source speech files.
    }
    try {
      fs.unlinkSync(combinedInputPath);
    } catch {
      // Best-effort cleanup for temp concatenated input files.
    }
  }
}

async function createDubbedAudioFromSourceChunk(chunkName, sourceChunkPath) {
  if (!sourceChunkPath || !elevenlabsClient) {
    return null;
  }

  const sourceBaseName = path.basename(chunkName, path.extname(chunkName));
  const dubResponse = await createDubbingJob({
    file: buildStreamableFile(sourceChunkPath),
    targetLang: ELEVENLABS_TARGET_LANG,
    name: `${sourceBaseName}_hi_direct_${Date.now()}`,
    numSpeakers: 1,
    disableVoiceCloning: false,
  });

  const dubbingId = dubResponse?.dubbingId;
  if (!dubbingId) {
    return null;
  }

  const dubbedAudioBuffer = await waitForDubAndFetchAudio(dubbingId, ELEVENLABS_TARGET_LANG);
  if (!dubbedAudioBuffer?.length) {
    return null;
  }

  let outputPath = null;
  if (WRITE_TRANSLATED_AUDIO_FILES) {
    outputPath = path.join(TRANSLATED_AUDIO_FOLDER, `${sourceBaseName}_hi_direct_dubbed.wav`);
    fs.writeFileSync(outputPath, dubbedAudioBuffer);
  }

  return {
    audioPath: outputPath,
    audioBuffer: dubbedAudioBuffer,
    dubbingId,
  };
}

async function transcribeOneMinuteChunkWithWhisper(chunkPath) {
  if (!openaiClient) {
    throw new Error("OpenAI API key not configured. Set OPENAI_API_KEY.");
  }

  const transcriptParts = [];
  let detectedLanguageCode = "auto";
  let lastWhisperResponse = null;

  try {
    const audioStream = fs.createReadStream(chunkPath);
    const transcription = await openaiClient.audio.transcriptions.create({
      file: audioStream,
      model: "whisper-1",
      language: "en",
    });

    lastWhisperResponse = transcription;
    const fullText = (transcription?.text || "").trim();

    if (fullText) {
      transcriptParts.push(fullText);
      detectedLanguageCode = "en-IN";
    }
  } catch (err) {
    console.error(`❌ Whisper transcription failed for ${path.basename(chunkPath)}: ${err.message}`);
    throw err;
  }

  return {
    sourceText: transcriptParts.join(" ").trim(),
    sourceLanguageCode: detectedLanguageCode,
    sttResponse: lastWhisperResponse,
    partCount: 1,
  };
}

async function convertAudioToPcm16kMono(audioBuffer, chunkName, languageCode) {
  if (!audioBuffer || !Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
    return null;
  }

  try {
    const pcmBuffer = await ffmpegTranscodeBufferToOutput(audioBuffer, [
      "-i",
      "pipe:0",
      "-f",
      "s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "pipe:1",
    ]);

    if (!pcmBuffer.length) {
      return null;
    }

    return pcmBuffer;
  } catch (err) {
    console.error(
      `❌ PCM conversion failed for ${chunkName} (${languageCode}): ${err.message}`
    );
    return null;
  }
}

async function convertTextToSpeechWithSarvam(text, chunkName) {
  if (!text || !sarvamClient) {
    return { audioPath: null, audioBuffer: null };
  }

  try {
    const ttsResponse = await sarvamClient.textToSpeech.convert({
      text,
      target_language_code: SARVAM_TTS_TARGET_LANGUAGE,
      speaker: SARVAM_TTS_SPEAKER,
      model: SARVAM_TTS_MODEL,
      speech_sample_rate: SARVAM_TTS_SAMPLE_RATE,
      output_audio_codec: SARVAM_TTS_OUTPUT_CODEC,
    });

    const audioChunks = Array.isArray(ttsResponse?.audios) ? ttsResponse.audios : [];
    const firstAudio = audioChunks.find((entry) => typeof entry === "string" && entry.length > 0);
    if (!firstAudio) {
      return { audioPath: null, audioBuffer: null };
    }

    const audioBuffer = Buffer.from(firstAudio, "base64");
    if (!audioBuffer.length) {
      return { audioPath: null, audioBuffer: null };
    }

    let outputPath = null;
    if (WRITE_TRANSLATED_AUDIO_FILES) {
      const baseName = path.basename(chunkName, path.extname(chunkName));
      outputPath = path.join(TRANSLATED_AUDIO_FOLDER, `${baseName}_hi_sarvam_tts.wav`);
      fs.writeFileSync(outputPath, audioBuffer);
    }

    return { audioPath: outputPath, audioBuffer };
  } catch (err) {
    console.error(`❌ Sarvam TTS failed for ${chunkName}: ${err.message}`);
    return { audioPath: null, audioBuffer: null };
  }
}

  async function translateTextToEnglish(inputText, sourceLanguageCode) {
    if (!inputText) return "";

    const normalizedSourceLanguage = /^[a-z]{2,3}-IN$/i.test(
      sourceLanguageCode || ""
    )
      ? sourceLanguageCode
      : "auto";

    const translationResponse = await sarvamClient.text.translate({
      input: inputText,
      source_language_code: normalizedSourceLanguage,
      target_language_code: "en-IN",
      model: "sarvam-translate:v1",
    });

    return normalizeText(translationResponse?.translated_text);
  }

  /**
   * Translate text to Hindi only.
   */
  async function translateToHindi(inputText, sourceLanguageCode) {
    if (!inputText) {
      return "";
    }

    const normalizedSourceLanguage = /^[a-z]{2,3}-IN$/i.test(
      sourceLanguageCode || ""
    )
      ? sourceLanguageCode
      : "auto";

    const response = await sarvamClient.text.translate({
      input: inputText,
      source_language_code: normalizedSourceLanguage,
      target_language_code: "hi-IN",
      model: "sarvam-translate:v1",
    });

    return normalizeText(response?.translated_text);
  }

function enqueueChunkForTranscription(filePath) {
  if (processedChunks.has(filePath) || queuedChunks.has(filePath)) {
    return;
  }

  if (!chunkSequenceNumbers.has(filePath)) {
    chunkSequenceNumbers.set(filePath, nextChunkSequence++);
  }

  queuedChunks.add(filePath);
  chunkQueue.push(filePath);
  processChunkQueue();
}

async function isChunkFileStable(filePath) {
  try {
    const first = fs.statSync(filePath);

    if (first.size <= 0) {
      return false;
    }

    const ageMs = Date.now() - first.mtimeMs;
    // If the file hasn't changed recently, skip the extra wait to reduce pickup latency.
    if (ageMs >= 250) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = fs.statSync(filePath);
    return first.size > 0 && first.size === second.size;
  } catch {
    return false;
  }
}

function estimateDurationFromFileSize(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const approxHeaderBytes = 44;
    const pcmBytesPerSecond = 16000 * 1 * 2; // 16kHz mono s16le
    const pcmPayloadBytes = Math.max(0, stats.size - approxHeaderBytes);
    return pcmPayloadBytes / pcmBytesPerSecond;
  } catch {
    return 0;
  }
}

function getWavDurationSeconds(filePath) {
  try {
    const wavBuffer = fs.readFileSync(filePath);
    const wav = new WaveFile(wavBuffer);

    const sampleRate = wav?.fmt?.sampleRate || 16000;
    const bitsPerSample = wav?.fmt?.bitsPerSample || 16;
    const numChannels = wav?.fmt?.numChannels || 1;
    const bytesPerSamplePerChannel = bitsPerSample / 8;
    const totalSamples =
      wav.data.samples.length / (bytesPerSamplePerChannel * numChannels);

    return totalSamples / sampleRate;
  } catch {
    // Fallback for partially written WAV headers or parse failures.
    return estimateDurationFromFileSize(filePath);
  }
}

function getChunkReadiness(filePath) {
  const durationSec = getWavDurationSeconds(filePath);
  const minChunkDurationSec = getActiveMinChunkDurationSec();

  if (durationSec >= minChunkDurationSec) {
    return { ready: true, durationSec, shouldSkip: false };
  }

  try {
    const stats = fs.statSync(filePath);
    const ageMs = Date.now() - stats.mtimeMs;

    if (ageMs > SHORT_CHUNK_SKIP_AGE_MS) {
      return { ready: false, durationSec, shouldSkip: true };
    }
  } catch {
    // Ignore stat errors and treat as not ready.
  }

  return { ready: false, durationSec, shouldSkip: false };
}

async function forwardChunkToRealtimePipeline(chunkPath, sequenceNumber) {
  if (!USE_EXTERNAL_REALTIME_PIPELINE) {
    return;
  }

  const chunkBuffer = fs.readFileSync(chunkPath);
  if (!chunkBuffer.length) {
    throw new Error(`Cannot forward empty chunk: ${path.basename(chunkPath)}`);
  }

  await forwardPcmChunkToRealtimePipeline(
    chunkBuffer,
    sequenceNumber,
    Math.max(0.05, getWavDurationSeconds(chunkPath))
  );
}

async function forwardPcmChunkToRealtimePipeline(chunkBuffer, sequenceNumber, durationSec) {
  if (!USE_EXTERNAL_REALTIME_PIPELINE) {
    return;
  }

  if (!chunkBuffer || !chunkBuffer.length) {
    throw new Error(`Cannot forward empty PCM chunk for seq ${sequenceNumber}`);
  }

  const safeDurationSec = Math.max(0.05, Number(durationSec) || chunkBuffer.length / PCM_BYTES_PER_SECOND);
  const startTime = realtimePipelineTimelineSec;
  const endTime = startTime + safeDurationSec;
  realtimePipelineTimelineSec = endTime;

  const response = await fetch(`${REALTIME_PIPELINE_BASE_URL}/chunk`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      seqId: sequenceNumber,
      startTime,
      endTime,
      pcmBase64: chunkBuffer.toString("base64"),
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Realtime pipeline rejected seq ${sequenceNumber}: ${response.status} ${bodyText}`);
  }
}

function scanForNewChunks() {
  try {
    const files = fs
      .readdirSync(SEGMENT_FOLDER)
      .filter((file) => file.endsWith(".wav") && !file.includes("_sarvam_"))
      .sort();

    for (const file of files) {
      const fullPath = path.join(SEGMENT_FOLDER, file);
      enqueueChunkForTranscription(fullPath);
    }
  } catch (err) {
    console.error("⚠️  Chunk scan failed:", err.message);
  }
}

async function processChunkQueue() {
  const hasProcessorClient = USE_EXTERNAL_REALTIME_PIPELINE
    ? true
    : USE_DIRECT_ELEVENLABS_DUBBING
      ? Boolean(elevenlabsClient)
      : Boolean(sarvamClient);
  if (isChunkWorkerRunning || !hasProcessorClient) return;
  isChunkWorkerRunning = true;
  const activeChunkDurationSec = getActiveChunkDurationSec();
  const activeBatchSize = getActiveDubbingBatchSize();

  // Get or create current session
  const currentSession = sessionManager.getCurrentSession();
  const sessionId = currentSession.sessionId;

  while (chunkQueue.length > 0) {
    const batchChunkPaths = [];
    while (chunkQueue.length > 0 && batchChunkPaths.length < activeBatchSize) {
      const nextPath = chunkQueue.shift();
      queuedChunks.delete(nextPath);
      if (!processedChunks.has(nextPath)) {
        batchChunkPaths.push(nextPath);
      }
    }

    if (!batchChunkPaths.length) {
      continue;
    }

    const preparedResults = await Promise.allSettled(
      batchChunkPaths.map(async (chunkPath) => {
        const stable = await isChunkFileStable(chunkPath);
        if (!stable) {
          enqueueChunkForTranscription(chunkPath);
          return { status: "retry", chunkPath };
        }

        const readiness = getChunkReadiness(chunkPath);
        if (!readiness.ready) {
          if (readiness.shouldSkip) {
            console.warn(
              `⏭️  Skipping short stale chunk ${path.basename(chunkPath)} (${readiness.durationSec.toFixed(2)}s < ${activeChunkDurationSec}s)`
            );
            processedChunks.add(chunkPath);
            chunkSequenceNumbers.delete(chunkPath);
            failedChunkRetries.delete(chunkPath);
            return { status: "skipped", chunkPath };
          }

          console.log(
            `⏳ Waiting for full chunk ${path.basename(chunkPath)} (${readiness.durationSec.toFixed(2)}s / ${activeChunkDurationSec}s)`
          );
          enqueueChunkForTranscription(chunkPath);
          return { status: "retry", chunkPath };
        }

        if (USE_EXTERNAL_REALTIME_PIPELINE) {
          const sequenceNumber = chunkSequenceNumbers.get(chunkPath) || 0;
          await forwardChunkToRealtimePipeline(chunkPath, sequenceNumber);

          return {
            status: "bridged",
            chunkPath,
            chunkName: path.basename(chunkPath),
            sequenceNumber,
          };
        }

        if (USE_DIRECT_ELEVENLABS_DUBBING) {
          return {
            status: "direct-ready",
            chunkPath,
            chunkName: path.basename(chunkPath),
            sequenceNumber: chunkSequenceNumbers.get(chunkPath) || 0,
            sourceLanguageCode: "unknown",
            sourceText: "[direct dubbing mode: skipped STT/translation]",
            sttResponse: null,
            hindiTranslation: "[direct dubbed audio]",
          };
        }

        const transcriptionResult = await transcribeOneMinuteChunkWithWhisper(chunkPath);
        const sourceText = transcriptionResult.sourceText;
        const sourceLanguageCode = transcriptionResult.sourceLanguageCode || "auto";
        const sttResponse = transcriptionResult.sttResponse;
        const chunkName = path.basename(chunkPath);
        const sequenceNumber = chunkSequenceNumbers.get(chunkPath) || 0;

        sessionManager.setSourceLanguage(sessionId, sourceLanguageCode);
        console.log(
          `🧩 Chunk ${chunkName} (seq ${sequenceNumber}) split into ${transcriptionResult.partCount} STT part(s) for Sarvam limit`
        );

        if (!sourceText || sourceText === "[empty response]") {
          return {
            status: "empty",
            chunkPath,
            chunkName,
            sequenceNumber,
            sourceLanguageCode,
            sttResponse,
          };
        }

        const hindiTranslation = await translateToHindi(sourceText, "en-IN");

        return {
          status: "ready",
          chunkPath,
          chunkName,
          sequenceNumber,
          sourceLanguageCode,
          sourceText,
          sttResponse,
          hindiTranslation,
        };
      })
    );

    const readyChunks = [];
    for (let resultIndex = 0; resultIndex < preparedResults.length; resultIndex++) {
      const result = preparedResults[resultIndex];
      if (result.status === "rejected") {
        const failedChunkPath = batchChunkPaths[resultIndex];
        const retries = (failedChunkRetries.get(failedChunkPath) || 0) + 1;
        failedChunkRetries.set(failedChunkPath, retries);

        if (retries <= MAX_CHUNK_RETRIES) {
          console.error(
            `⚠️  Chunk STT/translate failed for ${path.basename(failedChunkPath)} (retry ${retries}/${MAX_CHUNK_RETRIES}): ${result.reason?.message || result.reason}`
          );
          enqueueChunkForTranscription(failedChunkPath);
        } else {
          console.error(
            `❌ Chunk STT/translate failed permanently for ${path.basename(failedChunkPath)}: ${result.reason?.message || result.reason}`
          );
          processedChunks.add(failedChunkPath);
          chunkSequenceNumbers.delete(failedChunkPath);
        }
        continue;
      }

      if (result.value.status === "empty") {
        if (result.value.sequenceNumber > 0) {
          await enqueueSilenceForRunningStreams(sessionId, result.value.sequenceNumber);
          sessionManager.incrementChunkCount(sessionId, "source");
        }

        processedChunks.add(result.value.chunkPath);
        chunkSequenceNumbers.delete(result.value.chunkPath);
        failedChunkRetries.delete(result.value.chunkPath);
        continue;
      }

      if (result.value.status === "ready") {
        readyChunks.push(result.value);
      }

      if (result.value.status === "direct-ready") {
        readyChunks.push(result.value);
      }

      if (result.value.status === "bridged") {
        processedChunks.add(result.value.chunkPath);
        chunkSequenceNumbers.delete(result.value.chunkPath);
        failedChunkRetries.delete(result.value.chunkPath);
        sessionManager.incrementChunkCount(sessionId, "source");
        console.log(
          `✅ Forwarded chunk [${result.value.chunkName}] [seq ${result.value.sequenceNumber}] to realtime pipeline`
        );
      }
    }

    if (!readyChunks.length) {
      continue;
    }

    await ensureConfiguredStreamsStarted(sessionId);
    readyChunks.sort((a, b) => a.sequenceNumber - b.sequenceNumber);

    const hindiPipeline = LANGUAGE_PIPELINES.find((pipeline) => pipeline.language === "hindi");
    const hindiStreamer = hindiPipeline?.streamer;
    if (!hindiStreamer || !hindiStreamer.isRunning) {
      for (const chunk of readyChunks) {
        if (chunk.sequenceNumber > 0) {
          const silencePcm = createSilencePcmChunk(activeChunkDurationSec);
          await enqueueSilenceForRunningStreams(sessionId, chunk.sequenceNumber);
          sessionManager.incrementChunkCount(sessionId, "hindi");
        }
      }
      continue;
    }

    try {
      isSarvamProcessingChunk = true;

      const groupedChunks = [];
      for (let i = 0; i < readyChunks.length; i += activeBatchSize) {
        groupedChunks.push(readyChunks.slice(i, i + activeBatchSize));
      }

      for (const group of groupedChunks) {
        if (USE_DIRECT_ELEVENLABS_DUBBING) {
          for (const chunk of group) {
            const ttsResult = await createDubbedAudioFromSourceChunk(chunk.chunkName, chunk.chunkPath);

            if (!ttsResult?.audioBuffer) {
              const silencePcm = createSilencePcmChunk(activeChunkDurationSec);
              await hindiStreamer.sendTranslatedAudioChunk(silencePcm, { seq: chunk.sequenceNumber });
              sessionManager.incrementChunkCount(sessionId, "hindi");
              sessionManager.incrementChunkCount(sessionId, "source");

              processedChunks.add(chunk.chunkPath);
              chunkSequenceNumbers.delete(chunk.chunkPath);
              failedChunkRetries.delete(chunk.chunkPath);
              continue;
            }

            const pcmBuffer = await convertAudioToPcm16kMono(
              ttsResult.audioBuffer,
              chunk.chunkName,
              "hi-IN"
            );

            if (!pcmBuffer?.length) {
              const silencePcm = createSilencePcmChunk(activeChunkDurationSec);
              await hindiStreamer.sendTranslatedAudioChunk(silencePcm, { seq: chunk.sequenceNumber });
              sessionManager.incrementChunkCount(sessionId, "hindi");
              sessionManager.incrementChunkCount(sessionId, "source");

              processedChunks.add(chunk.chunkPath);
              chunkSequenceNumbers.delete(chunk.chunkPath);
              failedChunkRetries.delete(chunk.chunkPath);
              continue;
            }

            await hindiStreamer.sendTranslatedAudioChunk(pcmBuffer, { seq: chunk.sequenceNumber });
            sessionManager.incrementChunkCount(sessionId, "hindi");
            sessionManager.incrementChunkCount(sessionId, "source");

            const transcriptEntry = {
              chunk: chunk.chunkName,
              sequenceNumber: chunk.sequenceNumber,
              sessionId: sessionId,
              sourceLanguageCode: chunk.sourceLanguageCode,
              sourceText: chunk.sourceText,
              translations: {
                hindi: {
                  text: chunk.hindiTranslation,
                  audioPath: ttsResult.audioPath,
                },
              },
              sttResponse: chunk.sttResponse,
              at: new Date().toISOString(),
            };

            transcriptResults.push(transcriptEntry);
            broadcastTranscriptEntry(transcriptEntry);

            processedChunks.add(chunk.chunkPath);
            chunkSequenceNumbers.delete(chunk.chunkPath);
            failedChunkRetries.delete(chunk.chunkPath);

            console.log(
              `✅ Processed chunk [${chunk.chunkName}] [seq ${chunk.sequenceNumber}] - Direct ElevenLabs Hindi dubbing`
            );
          }

          continue;
        }

        const joinedTranslation = group.map((chunk) => chunk.hindiTranslation).join(" ");
        const combinedChunkName = group.map((chunk) => chunk.chunkName.replace(/\.wav$/i, "")).join("_");
        const ttsResult = await convertTextToSpeechWithSarvam(joinedTranslation, combinedChunkName);

        if (!ttsResult?.audioBuffer) {
          for (const chunk of group) {
            const silencePcm = createSilencePcmChunk(activeChunkDurationSec);
            await hindiStreamer.sendTranslatedAudioChunk(silencePcm, { seq: chunk.sequenceNumber });
            sessionManager.incrementChunkCount(sessionId, "hindi");
          }
          continue;
        }

        let pcmBuffer = await convertAudioToPcm16kMono(
          ttsResult.audioBuffer,
          combinedChunkName,
          "hi-IN"
        );

        if (!pcmBuffer?.length) {
          for (const chunk of group) {
            const silencePcm = createSilencePcmChunk(activeChunkDurationSec);
            await hindiStreamer.sendTranslatedAudioChunk(silencePcm, { seq: chunk.sequenceNumber });
            sessionManager.incrementChunkCount(sessionId, "hindi");
          }
          continue;
        }

        const trimBytes = Math.floor(SESSION_SAMPLE_TARGET_SEC * PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE);
        if (dubbingReferenceSamplePath && pcmBuffer.length > trimBytes) {
          pcmBuffer = pcmBuffer.slice(trimBytes);
        }

        const pcmChunks = splitPcmBufferIntoEqualParts(pcmBuffer, group.length);

        for (let index = 0; index < group.length; index++) {
          const chunk = group[index];
          const pcmPart = pcmChunks[index] || createSilencePcmChunk(activeChunkDurationSec);

          await hindiStreamer.sendTranslatedAudioChunk(pcmPart, { seq: chunk.sequenceNumber });
          sessionManager.incrementChunkCount(sessionId, "hindi");
          sessionManager.incrementChunkCount(sessionId, "source");

          const transcriptEntry = {
            chunk: chunk.chunkName,
            sequenceNumber: chunk.sequenceNumber,
            sessionId: sessionId,
            sourceLanguageCode: chunk.sourceLanguageCode,
            sourceText: chunk.sourceText,
            translations: {
              hindi: {
                text: chunk.hindiTranslation,
                audioPath: ttsResult.audioPath,
              },
            },
            sttResponse: chunk.sttResponse,
            at: new Date().toISOString(),
          };

          transcriptResults.push(transcriptEntry);
          broadcastTranscriptEntry(transcriptEntry);

          processedChunks.add(chunk.chunkPath);
          chunkSequenceNumbers.delete(chunk.chunkPath);
          failedChunkRetries.delete(chunk.chunkPath);

          console.log(
            `✅ Processed chunk [${chunk.chunkName}] [seq ${chunk.sequenceNumber}] [${chunk.sourceLanguageCode}] - Sarvam STT-Translate + TTS`
          );
        }
      }
    } catch (err) {
      for (const chunk of readyChunks) {
        const retries = (failedChunkRetries.get(chunk.chunkPath) || 0) + 1;
        failedChunkRetries.set(chunk.chunkPath, retries);

        if (retries <= MAX_CHUNK_RETRIES) {
          console.error(
            `⚠️  Processing failed for ${path.basename(chunk.chunkPath)} (retry ${retries}/${MAX_CHUNK_RETRIES}): ${err.message}`
          );
          enqueueChunkForTranscription(chunk.chunkPath);
        } else {
          console.error(
            `❌ Processing failed permanently for ${path.basename(chunk.chunkPath)}: ${err.message}`
          );
          processedChunks.add(chunk.chunkPath);
          chunkSequenceNumbers.delete(chunk.chunkPath);
        }
      }
    } finally {
      if (transcriptResults.length > 100) {
        transcriptResults.splice(0, transcriptResults.length - 100);
      }
      isSarvamProcessingChunk = false;
    }
  }

  isChunkWorkerRunning = false;
}

function startChunkScanner() {
  if (USE_EXTERNAL_REALTIME_PIPELINE) {
    console.log("🧠 External realtime pipeline uses in-memory capture; chunk scanner skipped.");
    return;
  }

  if (!USE_DIRECT_ELEVENLABS_DUBBING && !sarvamClient) {
    if (USE_EXTERNAL_REALTIME_PIPELINE) {
      // Bridge mode does not require Sarvam credentials in this process.
    } else {
      console.warn("⚠️  SARVAM_API_KEY not set. Chunk transcription is disabled.");
      return;
    }
  }

  if (!USE_EXTERNAL_REALTIME_PIPELINE && USE_DIRECT_ELEVENLABS_DUBBING && !elevenlabsClient) {
    console.warn("⚠️  ELEVENLABS_API_KEY not set. Direct ElevenLabs chunk dubbing is disabled.");
    return;
  }

  if (chunkScannerTimer) {
    return;
  }

  // Catch up on any chunks that already exist and then poll for new ones.
  scanForNewChunks();
  chunkScannerTimer = setInterval(scanForNewChunks, CHUNK_SCAN_INTERVAL_MS);
  if (USE_EXTERNAL_REALTIME_PIPELINE) {
    console.log(`🧠 External realtime pipeline bridge started -> ${REALTIME_PIPELINE_BASE_URL}/chunk`);
  } else if (USE_DIRECT_ELEVENLABS_DUBBING) {
    console.log(`🧠 Direct ElevenLabs chunk dubbing scanner started (${getActiveChunkDurationSec()}s chunks -> Hindi)`);
  } else {
    console.log("🧠 Sarvam chunk transcription scanner started");
  }

  // Periodic cleanup of expired sessions (every 30 seconds)
  const sessionCleanupTimer = setInterval(() => {
    sessionManager.cleanupExpiredSessions();
  }, 30000);

  // Clean up timer on exit
  process.on("SIGINT", () => {
    clearInterval(sessionCleanupTimer);
  });
}

/**
 * Validate that the playback HLS URL is accessible.
 */
async function validateStreamURL(url) {
  try {
    let response = await fetch(url, {
      method: "HEAD",
    });

    // Some HLS/CDN endpoints return 404/405 to HEAD while GET is valid.
    if (response.status >= 400) {
      const getResponse = await fetch(url, {
        method: "GET",
        headers: {
          Range: "bytes=0-1024",
        },
      });
      console.log(
        `📡 Stream validation: HEAD ${response.status}, GET ${getResponse.status}`
      );
      response = getResponse;
    } else {
      console.log(`Stream validation: HEAD ${response.status}`);
    }

    if (response.status === 403) {
      console.error(
        "Access Denied (403): Check AWS IVS channel status and playback permissions"
      );
    }
    if (response.status === 404) {
      console.error(
        "Not Found (404): Check AWS_IVS_PLAYBACK_URL and confirm the IVS channel is currently live"
      );
    }
    return response.status < 400;
  } catch (err) {
    console.error(`Stream validation failed: ${err.message}`);
    return false;
  }
}

/**
 * Calculate exponential backoff time for FFmpeg restart
 */
function getBackoffDelay() {
  if (restartAttempts <= 0) return 0;
  const baseDelay = 3000; // 3 seconds
  const maxDelay = 60000; // 60 seconds max
  const delay = Math.min(baseDelay * Math.pow(2, restartAttempts - 1), maxDelay);
  return delay;
}

/**
 * Get the stream URL to use (test mode or AWS IVS)
 */
function getStreamURL() {
  // Test mode with public HLS stream
  if (process.env.TEST_MODE === "true") {
    console.log("🧪 TEST MODE: Using public demo HLS stream");
    // This test stream is generally stable and FFmpeg-compatible.
    return "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
  }
  return process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL;
}

/**
 * Start FFmpeg stream with HLS input
 * Includes authentication headers and proper error handling
 */
async function startAudioSegmentation() {
  if (USE_EXTERNAL_REALTIME_PIPELINE) {
    await startRealtimeAudioCapture();
    return;
  }

  // Check if already running
  if (isFFmpegRunning) {
    console.log("⏳ FFmpeg already running, skipping restart");
    return;
  }

  const streamURL = getStreamURL();
  
  if (!streamURL) {
    console.error(" No stream URL configured. Set AWS_IVS_PLAYBACK_URL or enable TEST_MODE=true");
    return;
  }

  // Validate URL before attempting
  console.log(` Validating stream URL...`);
  const isAccessible = await validateStreamURL(streamURL);

  if (!isAccessible) {
    restartAttempts++;
    const delay = getBackoffDelay();

    if (restartAttempts > MAX_RESTART_RETRIES) {
      console.error(
        ` Max restart attempts (${MAX_RESTART_RETRIES}) exceeded. Check your HLS URL.`
      );
      console.log(" Tips:");
      console.log("   1. For AWS IVS: Ensure the channel is ACTIVE and broadcasting");
      console.log("   2. Verify the playback URL in AWS IVS console");
      console.log("   3. Check if authentication is required");
      console.log("   4. Try TEST_MODE=true to test with a public stream");
      return;
    }

    console.log(
      ` Retrying in ${delay / 1000}s (attempt ${restartAttempts}/${MAX_RESTART_RETRIES})...`
    );
    lastRestartTime = Date.now();
    setTimeout(startAudioSegmentation, delay);
    return;
  }

  console.log(" Starting FFmpeg audio stream processing...");
  console.log(` Stream Source: ${streamURL}`);
  isFFmpegRunning = true;

  // Build FFmpeg command optimized for live HLS streams
  const ffmpegArgs = [
    "-loglevel",
    "info",

    // Live stream specific options - start from latest segment
    "-live_start_index",
    "-1",

    // Reduce buffering to minimize latency
    "-fflags",
    "+nobuffer+fastseek",
    "-flags",
    "low_delay",

    // Protocol whitelist for HTTPS
    "-protocol_whitelist",
    "file,http,https,tcp,tls,crypto,data",

    // HLS-specific options for live streams
    "-http_persistent",
    "1",
    "-http_multiple",
    "1",
    "-reconnect",
    "1",
    "-reconnect_streamed",
    "1",
    "-reconnect_on_network_error",
    "1",
    "-reconnect_delay_max",
    "2",

    // Input stream
    "-i",
    streamURL,

    // Map audio stream explicitly (select first audio stream)
    "-map",
    "0:a:0",

    // Audio codec and format for Speech-to-Text
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000", // 16kHz sample rate
    "-ac",
    "1", // Mono

    // Segmentation: low-latency chunking for near real-time translation.
    "-f",
    "segment",
    "-segment_time",
    String(getActiveChunkDurationSec()),
    "-segment_format",
    "wav",
    "-reset_timestamps",
    "1",
    "-strftime",
    "1",
    "-segment_list_flags",
    "+live",

    `${SEGMENT_FOLDER}/chunk_%Y%m%d_%H%M%S.wav`,
  ];

  ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Handle stdout (progress info)
  ffmpeg.stdout.on("data", (data) => {
    const message = data.toString().trim();
    if (message) {
      console.log(`📊 FFmpeg: ${message}`);
    }
  });

  // Handle stderr (warnings, errors and stream info)
  ffmpeg.stderr.on("data", (data) => {
    const message = data.toString().trim();
    
    // Filter out noisy/repeated messages
    if (
      message &&
      !message.includes("frame=") &&
      !message.includes("skipping") &&
      !message.includes("expired from playlists") &&
      !message.includes("timestamp discontinuity") &&
      !message.includes("Last message repeated")
    ) {
      // Show important stream info and errors
      if (
        message.includes("Stream #") ||
        message.includes("Audio:") ||
        message.includes("Duration:") ||
        message.includes("error") ||
        message.includes("Error") ||
        message.includes("Invalid") ||
        message.includes("No such")
      ) {
        console.log(`🔊 FFmpeg: ${message}`);
      }
    }
  });

  // Handle process errors
  ffmpeg.on("error", (err) => {
    console.error(` FFmpeg process error:`, err.message);
    isFFmpegRunning = false;
  });

  // Handle process exit/close
  ffmpeg.on("close", (code) => {
    isFFmpegRunning = false;

    if (code === 0) {
      console.log("✅ FFmpeg stream ended normally");
      restartAttempts = 0;
    } else {
      console.log(`⛔ FFmpeg exited with code ${code}`);
    }

    // Schedule restart with exponential backoff
    restartAttempts++;
    const delay = getBackoffDelay();

    if (restartAttempts <= MAX_RESTART_RETRIES) {
      console.log(
        ` Restarting in ${delay / 1000}s (attempt ${restartAttempts}/${MAX_RESTART_RETRIES})...`
      );
      lastRestartTime = Date.now();
      setTimeout(startAudioSegmentation, delay);
    } else {
      console.error(
        ` Max restart attempts (${MAX_RESTART_RETRIES}) exceeded. Stream is unavailable.`
      );
    }
  });
}

// ============================================
// EXPRESS SERVER
// ============================================

app.get("/", async (req, res) => {
  const streamUrls = {
    original: buildPlaybackUrl(PLAYBACK_CHANNEL_PATHS.original),
    hindi: buildPlaybackUrl(PLAYBACK_CHANNEL_PATHS.hindi),
    bangla: buildPlaybackUrl(PLAYBACK_CHANNEL_PATHS.bangla),
    tamil: buildPlaybackUrl(PLAYBACK_CHANNEL_PATHS.tamil),
  };

  const streamOptions = [
    { language: "original", label: "English", badge: "Original" },
    { language: "hindi", label: "Hindi", badge: "AI Voice 01" },
    { language: "bangla", label: "Bangla", badge: "AI Voice 02" },
    { language: "tamil", label: "Tamil", badge: "AI Voice 03" },
  ];

  const initialLanguage = "original";

  const [viewerLocation, liveViewerCount] = await Promise.all([
    fetchLocationForRequest(req),
    fetchLiveViewerCount(initialLanguage),
  ]);

  res.render("home.ejs", {
    streamUrls,
    webrtcWhepUrls: WEBRTC_WHEP_URLS,
    useWebrtcTranslatedAudio: USE_WEBRTC_TRANSLATED_AUDIO,
    streamOptions,
    playbackBaseUrl: PLAYBACK_BASE_URL,
    viewerLocation,
    initialLanguage,
    initialLiveViewerCount: Number.isFinite(liveViewerCount) ? liveViewerCount : 0,
    initialLiveViewerCountLabel: formatViewerCount(Number.isFinite(liveViewerCount) ? liveViewerCount : 0),
  });
});

app.get("/api/ivs/live-viewers", async (req, res) => {
  const language = String(req.query.language || "original").toLowerCase();
  const supportedLanguages = new Set(["original", "hindi", "bangla", "tamil"]);

  if (!supportedLanguages.has(language)) {
    return res.status(400).json({ error: "Unsupported language" });
  }

  const viewerCount = await fetchLiveViewerCount(language);

  res.json({
    language,
    viewerCount,
    viewerCountLabel: formatViewerCount(Number.isFinite(viewerCount) ? viewerCount : 0),
  });
});

app.get("/create-new-livestream", (req, res) => {
  res.render("new-live-stream.ejs");
});

app.get("/dashboard", (req, res) => {
  res.render("dashboard.ejs", {
    streamURL: getStreamURL(),
    testMode: process.env.TEST_MODE === "true",
  });
});

app.use(express.static("public"));

// Health check endpoint
app.get("/health", (req, res) => {
  let chunks = [];
  let chunkCount = 0;
  
  try {
    if (fs.existsSync(SEGMENT_FOLDER)) {
      chunks = fs.readdirSync(SEGMENT_FOLDER);
      chunkCount = chunks.length;
    }
  } catch (err) {
    console.error("Error reading chunks:", err);
  }
  
  res.json({
    status: isFFmpegRunning ? "streaming" : "idle",
    ffmpegRunning: isFFmpegRunning,
    sarvamBusy: isSarvamProcessingChunk,
    chunkCount: chunkCount,
    chunkQueueDepth: chunkQueue.length,
    transcriptCount: transcriptResults.length,
    nextChunkSequence,
    latestChunks: chunks.slice(-5), // Show last 5 chunks
    chunkFolder: SEGMENT_FOLDER,
  });
});

app.get("/transcripts", (req, res) => {
  res.json({
    total: transcriptResults.length,
    latest: transcriptResults.slice(-20),
  });
});

// Get IVS stream status for all languages
app.get("/ivs/status", (req, res) => {
  const statuses = {
    hindi: ivsStreamers.hindi.getStatus(),
    session: sessionManager.getCurrentSession(),
  };
  res.json(statuses);
});

// Get all sessions
app.get("/sessions", (req, res) => {
  res.json({
    activeSessions: sessionManager.getAllSessions(),
    currentSessionId: sessionManager.activeSession,
  });
});

app.post("/pipeline/output/hindi", async (req, res) => {
  try {
    const providedSecret = String(req.headers["x-pipeline-secret"] || "");
    if (REALTIME_PIPELINE_OUTPUT_SECRET && providedSecret !== REALTIME_PIPELINE_OUTPUT_SECRET) {
      return res.status(401).json({ error: "Unauthorized pipeline output request" });
    }

    const { seqId, audioBase64 } = req.body || {};
    const sequenceNumber = Number(seqId);
    if (!Number.isInteger(sequenceNumber) || sequenceNumber <= 0) {
      return res.status(400).json({ error: "seqId must be a positive integer" });
    }

    if (typeof audioBase64 !== "string" || !audioBase64.length) {
      return res.status(400).json({ error: "audioBase64 is required" });
    }

    const inputAudioBuffer = Buffer.from(audioBase64, "base64");
    if (!inputAudioBuffer.length) {
      return res.status(400).json({ error: "Decoded audio buffer is empty" });
    }

    const currentSession = sessionManager.getCurrentSession();
    const sessionId = currentSession.sessionId;
    await ensureConfiguredStreamsStarted(sessionId);

    const hindiStreamer = ivsStreamers.hindi;
    if (!hindiStreamer || !hindiStreamer.isRunning) {
      return res.status(503).json({ error: "Hindi IVS streamer is not running" });
    }

    const pcmBuffer = await convertAudioToPcm16kMono(inputAudioBuffer, `pipeline_${sequenceNumber}`, "hi-IN");
    if (!pcmBuffer?.length) {
      return res.status(422).json({ error: "Failed to convert translated audio to PCM" });
    }

    if (sequenceNumber < nextHindiPipelineSeqToSend) {
      return res.json({
        accepted: true,
        seqId: sequenceNumber,
        duplicate: true,
        nextExpectedSeqId: nextHindiPipelineSeqToSend,
      });
    }

    hindiPipelineOutputBuffer.set(sequenceNumber, pcmBuffer);
    const flushedSeqIds = await flushHindiPipelineOutputBuffer(sessionId, hindiStreamer);

    if (flushedSeqIds.length > 1) {
      console.log(
        `✅ Flushed contiguous Hindi chunks in order: ${flushedSeqIds[0]}..${flushedSeqIds[flushedSeqIds.length - 1]}`
      );
    }

    return res.json({
      accepted: true,
      seqId: sequenceNumber,
      bytes: pcmBuffer.length,
      flushedSeqIds,
      nextExpectedSeqId: nextHindiPipelineSeqToSend,
      bufferedCount: hindiPipelineOutputBuffer.size,
    });
  } catch (err) {
    console.error(`❌ Failed to push realtime pipeline output to Hindi IVS: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// Start IVS streams manually
app.post("/ivs/start", async (req, res) => {
  const session = sessionManager.getCurrentSession();
  const sessionId = session.sessionId;

  const startPromises = [
    ivsStreamers.hindi.startStream(sessionId),
  ];

  const results = await Promise.all(startPromises);
  const allSuccess = results.every((r) => r);

  if (allSuccess) {
    sessionManager.markStreamActive(sessionId, "hindi");
    res.json({
      message: "Hindi IVS stream started",
      sessionId: sessionId,
      statuses: {
        hindi: ivsStreamers.hindi.getStatus(),
      },
    });
  } else {
    res.status(400).json({ error: "Failed to start Hindi IVS stream" });
  }
});

// Stop IVS streams manually
app.post("/ivs/stop", async (req, res) => {
  const sessionId = sessionManager.activeSession;
  await Promise.all([
    ivsStreamers.hindi.stopStream(),
  ]);

  if (sessionId) {
    sessionManager.markStreamInactive(sessionId, "hindi");
  }

  res.json({ message: "Hindi IVS stream stopped" });
});

// Start stream manually
app.post("/stream/start", (req, res) => {
  const streamURL = getStreamURL();
  if (!streamURL) {
    return res.status(400).json({
      error: "No stream URL configured. Set AWS_IVS_PLAYBACK_URL or TEST_MODE=true",
    });
  }
  if (isFFmpegRunning) {
    return res.json({ message: "Stream already running" });
  }
  startAudioSegmentation();
  startChunkScanner();
  res.json({ message: "Stream start initiated", testMode: process.env.TEST_MODE === "true" });
});

// Stop stream manually
app.post("/stream/stop", (req, res) => {
  if (!isFFmpegRunning) {
    return res.json({ message: "Stream not running" });
  }

  if (USE_EXTERNAL_REALTIME_PIPELINE) {
    stopRealtimeAudioCapture();
    return res.json({ message: "Realtime in-memory audio bridge stopped" });
  }

  if (ffmpeg && !ffmpeg.killed) {
    ffmpeg.kill("SIGTERM");
    isFFmpegRunning = false;
  }
  res.json({ message: "Stream stopped" });
});

app.set("view engine", "ejs");

// Validate environment variables (warn but don't exit)
if (!getStreamURL() && process.env.TEST_MODE !== "true") {
  console.warn("⚠️  Warning: AWS_IVS_PLAYBACK_URL not set in .env");
  console.log(" Set AWS_IVS_PLAYBACK_URL when you have an active livestream");
  console.log(" Or set TEST_MODE=true to test with a public demo stream");
}

// Start server
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, async () => {
  console.log(
    `\n🚀 Server running on http://localhost:${PORT}`
  );
  console.log(`📁 Audio chunks saved to: ${SEGMENT_FOLDER}\n`);

  const streamURL = getStreamURL();
  
  // Start FFmpeg if URL is available (AWS IVS or test mode)
  if (streamURL) {
    if (process.env.TEST_MODE === "true") {
      console.log("🧪 TEST MODE enabled - using public demo stream");
    } else {
      console.log("🔗 Playback URL detected, attempting to connect...");
    }
    startAudioSegmentation();
    startChunkScanner();
  } else {
    console.log("⏸️  No stream URL configured. Server is ready for manual stream start.");
    console.log(" To start: Set AWS_IVS_PLAYBACK_URL or TEST_MODE=true in .env");
    startChunkScanner();
  }

  // Start IVS translator streams if configured
  const hindiConfigured = process.env.AWS_IVS_INGEST_URL_HINDI && process.env.AWS_IVS_STREAM_KEY_HINDI;

  if (hindiConfigured) {
    const session = sessionManager.getCurrentSession();
    const sessionId = session.sessionId;

    console.log("🎥 Starting IVS Hindi translator stream...");
    await ivsStreamers.hindi.startStream(sessionId);
    sessionManager.markStreamActive(sessionId, "hindi");
  } else {
    console.log("⏸️  AWS IVS Hindi translator stream not configured.");
    console.log(" To enable: Set AWS_IVS_INGEST_URL_HINDI and AWS_IVS_STREAM_KEY_HINDI in .env");
  }
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  if (USE_EXTERNAL_REALTIME_PIPELINE) {
    await stopRealtimeAudioCapture();
  }
  if (chunkScannerTimer) {
    clearInterval(chunkScannerTimer);
  }
  if (ffmpeg && !ffmpeg.killed) {
    ffmpeg.kill("SIGTERM");
  }
  // Stop all IVS streams
  await Promise.all([
    ivsStreamers.hindi.stopStream(),
  ]);
  // Cleanup expired sessions
  sessionManager.endAllSessions();
  process.exit(0);
});
