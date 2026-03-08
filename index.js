import express from "express";
import dotenv from "dotenv";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import path from "path";
import { SarvamAIClient } from "sarvamai";

dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");

const SEGMENT_FOLDER = "./audio_chunks";
const TRANSLATED_AUDIO_FOLDER = "./translated_audio";
const MAX_RESTART_RETRIES = 5;
const CHUNK_SCAN_INTERVAL_MS = 2000;
const MAX_CHUNK_RETRIES = 2;
let restartAttempts = 0;
let lastRestartTime = 0;

const sarvamClient = process.env.SARVAM_API_KEY
  ? new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY })
  : null;

const chunkQueue = [];
const queuedChunks = new Set();
const processedChunks = new Set();
const failedChunkRetries = new Map();
const transcriptResults = [];
let isChunkWorkerRunning = false;
let chunkScannerTimer;

// create folders if not exist
if (!fs.existsSync(SEGMENT_FOLDER)) {
  fs.mkdirSync(SEGMENT_FOLDER);
}
if (!fs.existsSync(TRANSLATED_AUDIO_FOLDER)) {
  fs.mkdirSync(TRANSLATED_AUDIO_FOLDER);
}

let ffmpeg;
let isFFmpegRunning = false;

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

  async function convertTextToSpeech(text, chunkName) {
    if (!text || !sarvamClient) return null;

    try {
      const ttsResponse = await sarvamClient.textToSpeech.convert({
        text: text,
        target_language_code: "en-IN",
        speaker: "anushka",
        pitch: 0,
        pace: 1.0,
        loudness: 1.5,
        speech_sample_rate: 16000,
        enable_preprocessing: true,
        model: "bulbul:v2",
      });

      if (ttsResponse && ttsResponse.audios && ttsResponse.audios.length > 0) {
        const audioBase64 = ttsResponse.audios[0];
        const audioBuffer = Buffer.from(audioBase64, "base64");
        
        // Generate output filename based on original chunk name
        const baseName = path.basename(chunkName, path.extname(chunkName));
        const outputPath = path.join(TRANSLATED_AUDIO_FOLDER, `${baseName}_translated.wav`);
        
        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`🔊 TTS audio saved: ${outputPath}`);
        return outputPath;
      }
      return null;
    } catch (err) {
      console.error(`❌ TTS conversion failed for ${chunkName}: ${err.message}`);
      return null;
    }
  }
function enqueueChunkForTranscription(filePath) {
  if (processedChunks.has(filePath) || queuedChunks.has(filePath)) {
    return;
  }
  queuedChunks.add(filePath);
  chunkQueue.push(filePath);
  processChunkQueue();
}

async function isChunkFileStable(filePath) {
  try {
    const first = fs.statSync(filePath);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const second = fs.statSync(filePath);
    return first.size > 0 && first.size === second.size;
  } catch {
    return false;
  }
}

function scanForNewChunks() {
  try {
    const files = fs
      .readdirSync(SEGMENT_FOLDER)
      .filter((file) => file.endsWith(".wav"))
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
  if (isChunkWorkerRunning || !sarvamClient) return;
  isChunkWorkerRunning = true;

  while (chunkQueue.length > 0) {
    const chunkPath = chunkQueue.shift();
    queuedChunks.delete(chunkPath);

    if (processedChunks.has(chunkPath)) {
      continue;
    }

    const stable = await isChunkFileStable(chunkPath);
    if (!stable) {
      enqueueChunkForTranscription(chunkPath);
      continue;
    }

    try {
        const sttResponse = await sarvamClient.speechToText.transcribe({
        file: fs.createReadStream(chunkPath),
          language_code: "unknown",
      });

        const sourceText = extractTranscriptText(sttResponse);
        const sourceLanguageCode = sttResponse?.language_code || "auto";
        const translatedText = await translateTextToEnglish(sourceText, sourceLanguageCode);

        const englishText = translatedText || "[empty response]";
      const chunkName = path.basename(chunkPath);

      // Convert translated English text to speech
      const audioPath = await convertTextToSpeech(englishText, chunkName);

      transcriptResults.push({
        chunk: chunkName,
          sourceLanguageCode,
          sourceText,
          englishText,
          text: englishText,
          sttResponse,
        translatedAudioPath: audioPath,
        at: new Date().toISOString(),
      });
      if (transcriptResults.length > 100) {
        transcriptResults.shift();
      }

      processedChunks.add(chunkPath);
      failedChunkRetries.delete(chunkPath);
        console.log(
          `📝 Sarvam (${chunkName}) [${sourceLanguageCode}] -> EN: ${englishText}`
        );
    } catch (err) {
      const retries = (failedChunkRetries.get(chunkPath) || 0) + 1;
      failedChunkRetries.set(chunkPath, retries);

      if (retries <= MAX_CHUNK_RETRIES) {
        console.error(
          `⚠️  Sarvam failed for ${path.basename(chunkPath)} (retry ${retries}/${MAX_CHUNK_RETRIES}): ${err.message}`
        );
        enqueueChunkForTranscription(chunkPath);
      } else {
        console.error(
          `❌ Sarvam failed permanently for ${path.basename(chunkPath)}: ${err.message}`
        );
        processedChunks.add(chunkPath);
      }
    }
  }

  isChunkWorkerRunning = false;
}

function startChunkScanner() {
  if (!sarvamClient) {
    console.warn("⚠️  SARVAM_API_KEY not set. Chunk transcription is disabled.");
    return;
  }

  if (chunkScannerTimer) {
    return;
  }

  // Catch up on any chunks that already exist and then poll for new ones.
  scanForNewChunks();
  chunkScannerTimer = setInterval(scanForNewChunks, CHUNK_SCAN_INTERVAL_MS);
  console.log("🧠 Sarvam chunk transcription scanner started");
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

    // Segmentation: 5-second chunks
    "-f",
    "segment",
    "-segment_time",
    "5",
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

app.get("/", (req, res) => {
  res.render("home.ejs");
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
    chunkCount: chunkCount,
    chunkQueueDepth: chunkQueue.length,
    transcriptCount: transcriptResults.length,
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
app.listen(PORT, () => {
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
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\n🛑 Shutting down gracefully...");
  if (chunkScannerTimer) {
    clearInterval(chunkScannerTimer);
  }
  if (ffmpeg && !ffmpeg.killed) {
    ffmpeg.kill("SIGTERM");
  }
  process.exit(0);
});
