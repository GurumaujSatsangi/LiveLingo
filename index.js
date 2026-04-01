import express from "express";
import http from "http";
import dotenv from "dotenv";
import { WebSocketServer } from "ws";
import GeminiLiveIvsOrchestrator from "./gemini/GeminiLiveIvsOrchestrator.js";

dotenv.config();

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

function formatNum(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "n/a";
  }
  return value.toFixed(1);
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
  if (!channelPath) return "";
  if (/^https?:\/\//i.test(channelPath)) return channelPath;

  const base = normalizePlaybackBaseUrl(
    process.env.CLOUDFRONT_PLAYBACK_BASE_URL || process.env.PLAYBACK_BASE_URL || DEFAULT_PLAYBACK_BASE_URL
  );
  const normalizedPath = channelPath.startsWith("/") ? channelPath : `/${channelPath}`;
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

function attachOrchestratorListeners(instance) {
  instance.on("started", (event) => {
    console.log(
      `${nowIso()} [startup] session=${event.sessionId} model=${process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview"}`
    );
  });

  instance.on("segment-broadcast", (event) => {
    console.log(
      `${nowIso()} [segment] id=${event.segmentId} reason=${event.reason} durationMs=${event.durationMs} bytes=${event.bytes}`
    );
  });

  instance.on("segment-first-audio", (event) => {
    console.log(`${nowIso()} [latency] lang=${event.languageCode} firstAudioMs=${event.latencyMs}`);
  });

  instance.on("reconnecting", (event) => {
    console.warn(
      `${nowIso()} [reconnect] lang=${event.languageCode} attempt=${event.attempt} delayMs=${event.delay}`
    );
  });

  instance.on("warning", (message) => {
    console.warn(`${nowIso()} [warning] ${message}`);
  });

  instance.on("error", (err) => {
    console.error(`${nowIso()} [error] ${err.message}`);
  });

  instance.on("metrics", (stats) => {
    const hi = stats.languages?.["hi-IN"];
    const ta = stats.languages?.["ta-IN"];
    const bn = stats.languages?.["bn-IN"];

    const line = [
      `${nowIso()} [metrics]`,
      `uptimeSec=${(stats.uptimeMs / 1000).toFixed(1)}`,
      `segments=${stats.segmentsBroadcast}`,
      `dropped=${stats.segmentsDroppedByLag}`,
      `vadSegments=${stats.vad.segmentsEmitted}`,
      `hiQ=${hi?.segmentQueueDepth ?? 0}`,
      `taQ=${ta?.segmentQueueDepth ?? 0}`,
      `bnQ=${bn?.segmentQueueDepth ?? 0}`,
      `hiAudioKB=${((hi?.geminiAudioBytes ?? 0) / 1024).toFixed(1)}`,
      `taAudioKB=${((ta?.geminiAudioBytes ?? 0) / 1024).toFixed(1)}`,
      `bnAudioKB=${((bn?.geminiAudioBytes ?? 0) / 1024).toFixed(1)}`,
      `hiFirstMs=${formatNum(hi?.firstAudioLatencyMsAvg)}`,
      `taFirstMs=${formatNum(ta?.firstAudioLatencyMsAvg)}`,
      `bnFirstMs=${formatNum(bn?.firstAudioLatencyMsAvg)}`,
    ].join(" ");

    console.log(line);
  });
}

function createOrchestrator() {
  const instance = new GeminiLiveIvsOrchestrator({
    hlsUrl: process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL,
    geminiApiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview",
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
  res.json({
    status: "ok",
    port: PORT,
    orchestratorRunning,
    transcripts: transcriptEntries.length,
  });
});

app.post("/orchestrator/start", async (req, res) => {
  try {
    await startOrchestrator();
    pushTranscriptEntry({
      at: nowIso(),
      sourceText: "Gemini pipeline started",
      translations: { hindi: { text: "Gemini pipeline started" } },
    });
    res.json({ started: true });
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
      console.log(`${nowIso()} [startup] Gemini orchestrator auto-started`);
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
