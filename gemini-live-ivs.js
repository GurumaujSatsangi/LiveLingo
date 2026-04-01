import dotenv from "dotenv";
import GeminiLiveIvsOrchestrator from "./gemini/GeminiLiveIvsOrchestrator.js";

dotenv.config();

function nowIso() {
  return new Date().toISOString();
}

function formatNum(value) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return "n/a";
  }
  return value.toFixed(1);
}

async function main() {
  const orchestrator = new GeminiLiveIvsOrchestrator({
    hlsUrl: process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL,
    geminiApiKey: process.env.GEMINI_API_KEY,
    model: process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview",
  });

  orchestrator.on("started", (event) => {
    console.log(`${nowIso()} [startup] session=${event.sessionId} model=${process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview"}`);
    console.log(`${nowIso()} [startup] languages=${event.languages.map((lang) => `${lang.code}:${lang.ivsLanguageKey}`).join(",")}`);
  });

  orchestrator.on("segment-broadcast", (event) => {
    console.log(
      `${nowIso()} [segment] id=${event.segmentId} reason=${event.reason} durationMs=${event.durationMs} bytes=${event.bytes}`
    );
  });

  orchestrator.on("segment-first-audio", (event) => {
    console.log(`${nowIso()} [latency] lang=${event.languageCode} firstAudioMs=${event.latencyMs}`);
  });

  orchestrator.on("reconnecting", (event) => {
    console.warn(
      `${nowIso()} [reconnect] lang=${event.languageCode} attempt=${event.attempt} delayMs=${event.delay}`
    );
  });

  orchestrator.on("warning", (message) => {
    console.warn(`${nowIso()} [warning] ${message}`);
  });

  orchestrator.on("error", (err) => {
    console.error(`${nowIso()} [error] ${err.message}`);
  });

  orchestrator.on("metrics", (stats) => {
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
      `hiAudioKB=${(((hi?.geminiAudioBytes ?? 0) / 1024)).toFixed(1)}`,
      `taAudioKB=${(((ta?.geminiAudioBytes ?? 0) / 1024)).toFixed(1)}`,
      `bnAudioKB=${(((bn?.geminiAudioBytes ?? 0) / 1024)).toFixed(1)}`,
      `hiFirstMs=${formatNum(hi?.firstAudioLatencyMsAvg)}`,
      `taFirstMs=${formatNum(ta?.firstAudioLatencyMsAvg)}`,
      `bnFirstMs=${formatNum(bn?.firstAudioLatencyMsAvg)}`,
    ].join(" ");

    console.log(line);
  });

  process.on("SIGINT", async () => {
    console.log(`\n${nowIso()} [shutdown] Caught SIGINT`);
    await orchestrator.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    console.log(`\n${nowIso()} [shutdown] Caught SIGTERM`);
    await orchestrator.stop();
    process.exit(0);
  });

  await orchestrator.start();
}

main().catch((err) => {
  console.error(`${nowIso()} [fatal] ${err.stack || err.message}`);
  process.exit(1);
});
