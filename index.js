import express from "express";
import http from "http";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { EventEmitter } from "events";
import { WebSocketServer } from "ws";
import { AccessToken } from "livekit-server-sdk";
import {
  Room,
  RoomEvent,
  TrackKind,
  AudioSource,
  AudioFrame,
  LocalAudioTrack,
  TrackSource,
} from "@livekit/rtc-node";
import StreamingAudioIngester from "./StreamingAudioIngester.js";
import VadSegmenter from "./VadSegmenter.js";
import IVSTranslatorStreamer from "./ivsTranslatorStreamer.js";

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
  { laneKey: "hindi", languageCode: "hi-IN", targetLanguage: "Hindi", roomName: "translation-hi" },
  { laneKey: "bangla", languageCode: "bn-IN", targetLanguage: "Bengali", roomName: "translation-bn" },
  { laneKey: "tamil", languageCode: "ta-IN", targetLanguage: "Tamil", roomName: "translation-ta" },
];

class LiveKitSiliconOrchestrator extends EventEmitter {
  constructor(options = {}) {
    super();

    this.hlsUrl = options.hlsUrl || process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL || "";
    this.livekitUrl = options.livekitUrl || process.env.LIVEKIT_URL || "";
    this.livekitApiKey = options.livekitApiKey || process.env.LIVEKIT_API_KEY || "";
    this.livekitApiSecret = options.livekitApiSecret || process.env.LIVEKIT_API_SECRET || "";
    this.pythonBin = options.pythonBin || process.env.PYTHON_BIN || path.resolve(__dirname, ".venv", "Scripts", "python.exe");
    this.workerScript = options.workerScript || path.resolve(__dirname, "agents", "translation_worker.py");
    this.maxLiveKitQueueMs = Number(options.maxLiveKitQueueMs || process.env.LIVEKIT_MAX_QUEUE_MS || 500);
    this.liveKitAudioQueueMs = Number(options.liveKitAudioQueueMs || process.env.LIVEKIT_AUDIO_QUEUE_SIZE_MS || 15000);
    this.liveKitConnectRetries = Number(options.liveKitConnectRetries || process.env.LIVEKIT_CONNECT_RETRIES || 4);
    this.liveKitConnectRetryDelayMs = Number(
      options.liveKitConnectRetryDelayMs || process.env.LIVEKIT_CONNECT_RETRY_DELAY_MS || 1500
    );
    this.useSourceVideoForTranslated =
      String(options.useSourceVideoForTranslated ?? process.env.IVS_TRANSLATED_USE_SOURCE_VIDEO ?? "false").toLowerCase() ===
      "true";

    this.ingester = new StreamingAudioIngester({
      hlsUrl: this.hlsUrl,
      sampleRate: 16000,
      channels: 1,
      retainBuffer: false,
      maxRestartAttempts: Number(process.env.LIVEKIT_INGESTER_MAX_RESTARTS || 50),
      restartDelay: Number(process.env.LIVEKIT_INGESTER_RESTART_DELAY_MS || 1500),
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
    this.sessionId = `silicon_live_${Date.now()}`;
    this.stats = {
      startedAt: 0,
      chunksSeen: 0,
      segmentsBroadcast: 0,
      segmentsDroppedByLag: 0,
    };

    this.workers = new Map();
    this.laneRooms = new Map();
    this.laneAudioSources = new Map();
    this.laneLocalTracks = new Map();
    this.laneReady = new Map();
    this.laneCaptureQueues = new Map();
    this.laneStreamers = new Map();
    this.laneSubscribedTrackSid = new Map();
    this.captureFramePaceMs = Number(options.captureFramePaceMs || process.env.LIVEKIT_CAPTURE_PACE_MS || 2);

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

  isRoomConnected(room) {
    if (!room) return false;

    const state = String(room.connectionState || room.state || "").toLowerCase();
    if (state === "connected") return true;
    if (state === "reconnecting" || state === "connecting" || state === "disconnected") return false;

    // Fallback for SDK variants that don't expose a normalized state string.
    return Boolean(room.localParticipant && !room.isDisconnected);
  }

  isLaneReady(languageCode) {
    const room = this.laneRooms.get(languageCode);
    const source = this.laneAudioSources.get(languageCode);
    return Boolean(this.laneReady.get(languageCode) && room && source && this.isRoomConnected(room));
  }

  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async waitForTrackPublicationReady(publication, room, languageCode, timeoutMs = 2500) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (this.stopping) {
        throw new Error(`Lane initialization interrupted during shutdown lane=${languageCode}`);
      }

      const published = Boolean(publication?.trackSid || publication?.sid);
      if (published && this.isRoomConnected(room)) {
        return;
      }

      await this.sleep(50);
    }

    throw new Error(`Track publication was not confirmed lane=${languageCode} within ${timeoutMs}ms`);
  }

  validateConfig() {
    if (!this.hlsUrl) {
      throw new Error("Missing HLS input URL. Set AWS_IVS_PLAYBACK_URL or LIVESTREAM_HLS_URL");
    }

    if (!this.livekitUrl || !this.livekitApiKey || !this.livekitApiSecret) {
      throw new Error("Missing LiveKit credentials. Set LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET");
    }

    if (!process.env.SILICONFLOW_API_KEY) {
      throw new Error("Missing SILICONFLOW_API_KEY");
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
      provider: "LiveKit+SiliconFlow",
    });
  }

  async startLaneInfra(lane) {
    this.laneReady.set(lane.languageCode, false);

    const room = new Room();
    const token = await this.buildLaneToken(lane.roomName, `orchestrator-${lane.laneKey}-${Date.now()}`);

    this.laneRooms.set(lane.languageCode, room);

    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      if (participant?.identity === room.localParticipant?.identity) return;

      const trackSid = publication?.trackSid || publication?.sid || track?.sid;
      const alreadySubscribedSid = this.laneSubscribedTrackSid.get(lane.languageCode);
      if (alreadySubscribedSid && trackSid && alreadySubscribedSid === trackSid) {
        return;
      }

      if (trackSid) {
        this.laneSubscribedTrackSid.set(lane.languageCode, trackSid);
      }

      this.emit("warning", `Subscribed translated track lane=${lane.languageCode} identity=${participant.identity}`);
      streamer.subscribeToLiveKitTrack(track, {
        sampleRate: 24000,
        numChannels: 1,
      }).catch((err) => {
        this.emit("error", new Error(`Track consume failed lane=${lane.languageCode}: ${err.message}`));
      });
    });

    room.on(RoomEvent.Disconnected, () => {
      this.emit("warning", `LiveKit room disconnected lane=${lane.languageCode}`);
      this.laneReady.set(lane.languageCode, false);
      this.laneSubscribedTrackSid.delete(lane.languageCode);
    });

    await this.connectRoomWithRetry(room, token, lane.languageCode);

    const source = new AudioSource(16000, 1, this.liveKitAudioQueueMs);

    const localTrack = LocalAudioTrack.createAudioTrack(`source-${lane.laneKey}`, source);
    const publication = await room.localParticipant.publishTrack(localTrack, {
      source: TrackSource.SOURCE_MICROPHONE,
    });

    await this.waitForTrackPublicationReady(publication, room, lane.languageCode);

    this.laneAudioSources.set(lane.languageCode, source);
    this.laneLocalTracks.set(lane.languageCode, localTrack);

    const streamer = new IVSTranslatorStreamer({
      language: lane.laneKey,
      sourceVideoUrl: this.useSourceVideoForTranslated ? this.hlsUrl : "",
      inputSampleRate: 24000,
      videoSyncDelaySec: Number(process.env.VIDEO_SYNC_DELAY_SEC || 0),
      maxMissingSequenceWaitMs: Number(process.env.IVS_MAX_MISSING_SEQUENCE_WAIT_MS || 120),
    });

    try {
      await streamer.startStream(this.sessionId);
      this.laneStreamers.set(lane.languageCode, streamer);
    } catch (err) {
      this.laneReady.set(lane.languageCode, false);
      try {
        await room.disconnect();
      } catch {
        // Best effort cleanup.
      }
      throw err;
    }

    this.spawnWorker(lane);
    this.laneReady.set(lane.languageCode, true);
  }

  async connectRoomWithRetry(room, token, languageCode) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.liveKitConnectRetries; attempt += 1) {
      try {
        await room.connect(this.livekitUrl, token, {
          autoSubscribe: true,
          dynacast: false,
        });
        return;
      } catch (err) {
        lastError = err;
        const isLast = attempt >= this.liveKitConnectRetries;
        this.emit(
          "warning",
          `LiveKit connect failed lane=${languageCode} attempt=${attempt}/${this.liveKitConnectRetries}: ${err.message}`
        );

        if (isLast) {
          break;
        }

        await new Promise((resolve) => setTimeout(resolve, this.liveKitConnectRetryDelayMs));
      }
    }

    throw new Error(
      `LiveKit connect failed lane=${languageCode} after ${this.liveKitConnectRetries} attempts: ${lastError?.message || "unknown error"}`
    );
  }

  async buildLaneToken(roomName, identity) {
    const token = new AccessToken(this.livekitApiKey, this.livekitApiSecret, {
      identity,
      name: identity,
      ttl: "2h",
    });

    token.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: false,
    });

    return token.toJwt();
  }

  spawnWorker(lane) {
    const portMap = { "hi-IN": 8081, "bn-IN": 8082, "ta-IN": 8083 };
    const workerPort = portMap[lane.languageCode] || 8081;

    const args = [
      this.workerScript,
      "--target-language",
      lane.targetLanguage,
      "--room",
      lane.roomName,
    ];

    const child = spawn(this.pythonBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        WORKER_PORT: String(workerPort),
      },
    });

    child.stdout.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        this.emit("warning", `[worker:${lane.languageCode}] ${msg}`);
      }
    });

    child.stderr.on("data", (data) => {
      const msg = data.toString().trim();
      if (msg) {
        this.emit("warning", `[worker:${lane.languageCode}] ${msg}`);
      }
    });

    child.on("exit", (code, signal) => {
      this.emit("warning", `Worker exited lane=${lane.languageCode} code=${code} signal=${signal || ""}`);
      this.workers.delete(lane.languageCode);
    });

    this.workers.set(lane.languageCode, child);
  }

  async captureSegmentForLane(lane, segment) {
    const room = this.laneRooms.get(lane.languageCode);
    const source = this.laneAudioSources.get(lane.languageCode);

    if (!this.isLaneReady(lane.languageCode) || !room || !source) {
      return;
    }

    const frameBytes = 640; // 20ms @ 16kHz mono s16le
    let framesSincePause = 0;

    for (let offset = 0; offset < segment.buffer.length; offset += frameBytes) {
      if (this.stopping || !this.isLaneReady(lane.languageCode)) {
        return;
      }

      const chunk = segment.buffer.slice(offset, Math.min(offset + frameBytes, segment.buffer.length));
      const frame =
        chunk.length === frameBytes ? chunk : Buffer.concat([chunk, Buffer.alloc(frameBytes - chunk.length)]);

      const samplesPerChannel = frame.length / 2;
      const int16 = new Int16Array(samplesPerChannel);
      for (let i = 0; i < samplesPerChannel; i += 1) {
        int16[i] = frame.readInt16LE(i * 2);
      }

      try {
        await source.captureFrame(new AudioFrame(int16, 16000, 1, samplesPerChannel));
      } catch (err) {
        // Transient disconnect windows can throw InvalidState; drop frame and continue.
        if (err?.message?.includes("InvalidState")) {
          continue;
        }

        this.emit("error", new Error(`Frame capture error lane=${lane.languageCode}: ${err.message}`));
      }

      framesSincePause += 1;
      if (this.captureFramePaceMs > 0 && framesSincePause >= 5) {
        framesSincePause = 0;
        await this.sleep(this.captureFramePaceMs);
      }
    }
  }

  enqueueSegmentForLane(lane, segment) {
    const key = lane.languageCode;
    const previous = this.laneCaptureQueues.get(key) || Promise.resolve();
    const queued = previous
      .catch(() => {
        // Keep queue alive even if a previous async write failed.
      })
      .then(() => this.captureSegmentForLane(lane, segment));

    this.laneCaptureQueues.set(key, queued);
    return queued;
  }

  async broadcastSegment(segment) {
    if (!segment?.buffer || !Buffer.isBuffer(segment.buffer)) {
      return;
    }

    const lagMs = Date.now() - segment.emittedAt;
    if (lagMs > this.maxLiveKitQueueMs) {
      this.stats.segmentsDroppedByLag += 1;
      this.emit("warning", `Dropping segment ${segment.segmentId} lag=${lagMs}ms > ${this.maxLiveKitQueueMs}ms`);
      return;
    }

    if (this.stopping) {
      return;
    }

    this.stats.segmentsBroadcast += 1;

    await Promise.all(
      LANE_CONFIG.map((lane) => this.enqueueSegmentForLane(lane, segment))
    );

    this.emit("segment-broadcast", {
      segmentId: segment.segmentId,
      durationMs: segment.durationMs,
      bytes: segment.buffer.length,
      reason: segment.reason,
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
        room: lane.roomName,
        workerRunning: this.workers.has(lane.languageCode),
        streamer: streamer ? streamer.getStreamingStats() : null,
      };
    }

    return {
      sessionId: this.sessionId,
      provider: "LiveKit+SiliconFlow",
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

    // Allow in-flight captureFrame calls to settle before disconnecting rooms.
    await Promise.allSettled(Array.from(this.laneCaptureQueues.values()));
    await this.sleep(200);

    for (const lane of LANE_CONFIG) {
      this.laneReady.set(lane.languageCode, false);
    }

    for (const worker of this.workers.values()) {
      try {
        worker.kill("SIGTERM");
      } catch {
        // Best effort.
      }
    }
    this.workers.clear();

    for (const room of this.laneRooms.values()) {
      try {
        await room.disconnect();
      } catch {
        // Best effort.
      }
    }
    this.laneRooms.clear();
    this.laneAudioSources.clear();
    this.laneLocalTracks.clear();
    this.laneReady.clear();
    this.laneCaptureQueues.clear();
    this.laneSubscribedTrackSid.clear();

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
    console.log(`${nowIso()} [startup] session=${event.sessionId} provider=LiveKit+SiliconFlow`);
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
      `provider=LiveKit+SiliconFlow`,
      `uptimeSec=${(stats.uptimeMs / 1000).toFixed(1)}`,
      `segments=${stats.segmentsBroadcast}`,
      `dropped=${stats.segmentsDroppedByLag}`,
      `hiQ=${hi?.queueLength ?? 0}`,
      `taQ=${ta?.queueLength ?? 0}`,
      `bnQ=${bn?.queueLength ?? 0}`,
    ].join(" ");

    console.log(line);
  });
}

function createOrchestrator() {
  const orchestratorHlsUrl = buildPlaybackUrl(process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL || "");
  const instance = new LiveKitSiliconOrchestrator({
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
    provider: "LiveKit+SiliconFlow",
    transcripts: transcriptEntries.length,
    stats,
  });
});

app.post("/orchestrator/start", async (req, res) => {
  try {
    await startOrchestrator();
    pushTranscriptEntry({
      at: nowIso(),
      sourceText: "LiveKit + SiliconFlow pipeline started",
      translations: { hindi: { text: "LiveKit + SiliconFlow pipeline started" } },
    });
    res.json({ started: true, provider: "LiveKit+SiliconFlow" });
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
      console.log(`${nowIso()} [startup] LiveKit+SiliconFlow orchestrator auto-started`);
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
