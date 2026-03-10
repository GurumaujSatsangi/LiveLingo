import express from "express";
import dotenv from "dotenv";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import path from "path";
import { SarvamAIClient } from "sarvamai";
import wavefilePkg from "wavefile";
import IVSTranslatorStreamer from "./ivsTranslatorStreamer.js";
import StreamSessionManager from "./StreamSessionManager.js";

const { WaveFile } = wavefilePkg;

dotenv.config();

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set("view engine", "ejs");

const SEGMENT_FOLDER = "./audio_chunks";
const TRANSLATED_AUDIO_FOLDER = "./translated_audio";
const HOLD_AUDIO_FILE = path.join("public", "speech.mp3");
const MAX_RESTART_RETRIES = 5;
const CHUNK_SCAN_INTERVAL_MS = 2000;
const MAX_CHUNK_RETRIES = 2;
const TARGET_CHUNK_DURATION_SEC = 4;
const MIN_ACCEPTABLE_CHUNK_DURATION_SEC = 3.5;
const SHORT_CHUNK_SKIP_AGE_MS = 8 * 1000;
const SARVAM_MAX_SEGMENT_SEC = 29;
let restartAttempts = 0;
let lastRestartTime = 0;

const sarvamClient = process.env.SARVAM_API_KEY
  ? new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY })
  : null;

// Initialize Session Manager
const sessionManager = new StreamSessionManager();

// Initialize IVS Translator Streamers for each language
const ivsStreamers = {
  hindi: new IVSTranslatorStreamer({ language: 'hindi' }),
  bangla: new IVSTranslatorStreamer({ language: 'bangla' }),
  tamil: new IVSTranslatorStreamer({ language: 'tamil' }),
};

const chunkQueue = [];
const queuedChunks = new Set();
const processedChunks = new Set();
const failedChunkRetries = new Map();
const chunkSequenceNumbers = new Map();
let nextChunkSequence = 1;
const transcriptResults = [];
let isChunkWorkerRunning = false;
let chunkScannerTimer;
let holdAudioPcmBuffer = null;
let isSarvamProcessingChunk = false;

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

function ffmpegCollectOutput(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
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
  });
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

async function splitChunkForSarvam(chunkPath) {
  const baseName = path.basename(chunkPath, path.extname(chunkPath));
  const splitPattern = path.join(SEGMENT_FOLDER, `${baseName}_sarvam_%03d.wav`);

  await ffmpegRun([
    "-i",
    chunkPath,
    "-f",
    "segment",
    "-segment_time",
    String(SARVAM_MAX_SEGMENT_SEC),
    "-c:a",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",
    splitPattern,
  ]);

  return fs
    .readdirSync(SEGMENT_FOLDER)
    .filter((file) => file.startsWith(`${baseName}_sarvam_`) && file.endsWith(".wav"))
    .sort()
    .map((file) => path.join(SEGMENT_FOLDER, file));
}

async function transcribeOneMinuteChunkWithSarvam(chunkPath) {
  const partFiles = await splitChunkForSarvam(chunkPath);
  if (partFiles.length === 0) {
    throw new Error(`No split parts generated for ${path.basename(chunkPath)}`);
  }

  const transcriptParts = [];
  let detectedLanguageCode = "auto";
  let lastResponse = null;

  try {
    for (const partPath of partFiles) {
      const sttResponse = await sarvamClient.speechToText.transcribe({
        file: fs.createReadStream(partPath),
        language_code: detectedLanguageCode === "auto" ? "unknown" : detectedLanguageCode,
      });

      lastResponse = sttResponse;
      const partText = extractTranscriptText(sttResponse).trim();
      if (partText) {
        transcriptParts.push(partText);
      }

      const responseLanguage = sttResponse?.language_code;
      if (typeof responseLanguage === "string" && /^[a-z]{2,3}-IN$/i.test(responseLanguage)) {
        detectedLanguageCode = responseLanguage;
      }
    }
  } finally {
    for (const partPath of partFiles) {
      try {
        fs.unlinkSync(partPath);
      } catch {
        // Ignore cleanup errors for temp files.
      }
    }
  }

  return {
    sourceText: transcriptParts.join(" ").trim(),
    sourceLanguageCode: detectedLanguageCode,
    sttResponse: lastResponse,
    partCount: partFiles.length,
  };
}

async function loadHoldAudioBuffer() {
  if (!fs.existsSync(HOLD_AUDIO_FILE)) {
    console.warn(
      `⚠️  Hold audio file not found: ${HOLD_AUDIO_FILE}. Waiting mode filler is disabled.`
    );
    return null;
  }

  try {
    const pcm = await ffmpegCollectOutput([
      "-i",
      HOLD_AUDIO_FILE,
      "-f",
      "s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "pipe:1",
    ]);

    console.log(`🎵 Loaded hold audio from ${HOLD_AUDIO_FILE}`);
    return pcm;
  } catch (err) {
    console.error(`❌ Failed to load hold audio ${HOLD_AUDIO_FILE}: ${err.message}`);
    return null;
  }
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
   * Translate text to Hindi, Bangla, and Tamil
   */
  async function translateToMultipleLanguages(inputText, sourceLanguageCode) {
    if (!inputText) {
      return {
        hindi: "",
        bangla: "",
        tamil: "",
      };
    }

    const normalizedSourceLanguage = /^[a-z]{2,3}-IN$/i.test(
      sourceLanguageCode || ""
    )
      ? sourceLanguageCode
      : "auto";

    const translations = {
      hindi: "",
      bangla: "",
      tamil: "",
    };

    try {
      // Translate to Hindi
      const hindiResponse = await sarvamClient.text.translate({
        input: inputText,
        source_language_code: normalizedSourceLanguage,
        target_language_code: "hi-IN",
        model: "sarvam-translate:v1",
      });
      translations.hindi = normalizeText(hindiResponse?.translated_text);
    } catch (err) {
      console.error(`⚠️  Hindi translation failed: ${err.message}`);
    }

    try {
      // Translate to Bangla
      const banglaResponse = await sarvamClient.text.translate({
        input: inputText,
        source_language_code: normalizedSourceLanguage,
        target_language_code: "bn-IN",
        model: "sarvam-translate:v1",
      });
      translations.bangla = normalizeText(banglaResponse?.translated_text);
    } catch (err) {
      console.error(`⚠️  Bangla translation failed: ${err.message}`);
    }

    try {
      // Translate to Tamil
      const tamilResponse = await sarvamClient.text.translate({
        input: inputText,
        source_language_code: normalizedSourceLanguage,
        target_language_code: "ta-IN",
        model: "sarvam-translate:v1",
      });
      translations.tamil = normalizeText(tamilResponse?.translated_text);
    } catch (err) {
      console.error(`⚠️  Tamil translation failed: ${err.message}`);
    }

    return translations;
  }

  async function convertTextToSpeech(text, chunkName, languageCode = "en-IN") {
    if (!text || !sarvamClient) return { audioPath: null, audioBuffer: null };

    try {
      const ttsResponse = await sarvamClient.textToSpeech.convert({
        text: text,
        target_language_code: languageCode,
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
        const langSuffix = languageCode.split("-")[0]; // Extract language code (e.g., 'hi' from 'hi-IN')
        const outputPath = path.join(TRANSLATED_AUDIO_FOLDER, `${baseName}_${langSuffix}.wav`);
        
        fs.writeFileSync(outputPath, audioBuffer);
        console.log(`🔊 TTS audio saved: ${outputPath}`);
        return { audioPath: outputPath, audioBuffer: audioBuffer };
      }
      return { audioPath: null, audioBuffer: null };
    } catch (err) {
      console.error(`❌ TTS conversion failed for ${chunkName} (${languageCode}): ${err.message}`);
      return { audioPath: null, audioBuffer: null };
    }
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
    await new Promise((resolve) => setTimeout(resolve, 700));
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

  if (durationSec >= MIN_ACCEPTABLE_CHUNK_DURATION_SEC) {
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
  if (isChunkWorkerRunning || !sarvamClient) return;
  isChunkWorkerRunning = true;

  // Get or create current session
  const currentSession = sessionManager.getCurrentSession();
  const sessionId = currentSession.sessionId;

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

    const readiness = getChunkReadiness(chunkPath);
    if (!readiness.ready) {
      if (readiness.shouldSkip) {
        console.warn(
          `⏭️  Skipping short stale chunk ${path.basename(chunkPath)} (${readiness.durationSec.toFixed(2)}s < ${TARGET_CHUNK_DURATION_SEC}s)`
        );
        processedChunks.add(chunkPath);
      } else {
        console.log(
          `⏳ Waiting for full chunk ${path.basename(chunkPath)} (${readiness.durationSec.toFixed(2)}s / ${TARGET_CHUNK_DURATION_SEC}s)`
        );
        enqueueChunkForTranscription(chunkPath);
      }
      continue;
    }

    try {
      isSarvamProcessingChunk = true;

      // Step 1: Transcribe low-latency chunk via <=30s Sarvam STT parts.
      const transcriptionResult = await transcribeOneMinuteChunkWithSarvam(chunkPath);
      const sourceText = transcriptionResult.sourceText;
      const sourceLanguageCode = transcriptionResult.sourceLanguageCode || "auto";
      const sttResponse = transcriptionResult.sttResponse;

      // Update session with detected language
      sessionManager.setSourceLanguage(sessionId, sourceLanguageCode);

      const chunkName = path.basename(chunkPath);
      const sequenceNumber = chunkSequenceNumbers.get(chunkPath) || 0;
      console.log(
        `🧩 Chunk ${chunkName} (seq ${sequenceNumber}) split into ${transcriptionResult.partCount} STT part(s) for Sarvam limit`
      );

      if (!sourceText || sourceText === "[empty response]") {
        console.log(`⏭️  Skipping empty transcription for ${chunkName}`);
        processedChunks.add(chunkPath);
        isSarvamProcessingChunk = false;
        continue;
      }

      // Step 2: Translate to all three languages
      console.log(`🔄 Translating "${sourceText.substring(0, 50)}..." from ${sourceLanguageCode} to Hindi, Bangla, Tamil...`);
      const translations = await translateToMultipleLanguages(sourceText, sourceLanguageCode);

      // Ensure streams are started for this session
      if (!sessionManager.isStreamActive("hindi") && translations.hindi) {
        console.log(`🎬 Starting Hindi stream for session ${sessionId}`);
        await ivsStreamers.hindi.startStream(sessionId);
        sessionManager.markStreamActive(sessionId, "hindi");
      }

      if (!sessionManager.isStreamActive("bangla") && translations.bangla) {
        console.log(`🎬 Starting Bangla stream for session ${sessionId}`);
        await ivsStreamers.bangla.startStream(sessionId);
        sessionManager.markStreamActive(sessionId, "bangla");
      }

      if (!sessionManager.isStreamActive("tamil") && translations.tamil) {
        console.log(`🎬 Starting Tamil stream for session ${sessionId}`);
        await ivsStreamers.tamil.startStream(sessionId);
        sessionManager.markStreamActive(sessionId, "tamil");
      }

      // Step 3: Convert translations to speech and send to IVS
      const translatedAudios = {};

      // Hindi
      if (translations.hindi) {
        const hindiTts = await convertTextToSpeech(translations.hindi, chunkName, "hi-IN");
        const hindiPcm = await convertAudioToPcm16kMono(hindiTts.audioBuffer, chunkName, "hi-IN");
        if (hindiPcm && ivsStreamers.hindi.isRunning) {
          await ivsStreamers.hindi.sendTranslatedAudioChunk(hindiPcm, { seq: sequenceNumber });
          sessionManager.incrementChunkCount(sessionId, "hindi");
          translatedAudios.hindi = {
            text: translations.hindi,
            audioPath: hindiTts.audioPath,
          };
        }
      }

      // Bangla
      if (translations.bangla) {
        const banglaTts = await convertTextToSpeech(translations.bangla, chunkName, "bn-IN");
        const banglaPcm = await convertAudioToPcm16kMono(banglaTts.audioBuffer, chunkName, "bn-IN");
        if (banglaPcm && ivsStreamers.bangla.isRunning) {
          await ivsStreamers.bangla.sendTranslatedAudioChunk(banglaPcm, { seq: sequenceNumber });
          sessionManager.incrementChunkCount(sessionId, "bangla");
          translatedAudios.bangla = {
            text: translations.bangla,
            audioPath: banglaTts.audioPath,
          };
        }
      }

      // Tamil
      if (translations.tamil) {
        const tamilTts = await convertTextToSpeech(translations.tamil, chunkName, "ta-IN");
        const tamilPcm = await convertAudioToPcm16kMono(tamilTts.audioBuffer, chunkName, "ta-IN");
        if (tamilPcm && ivsStreamers.tamil.isRunning) {
          await ivsStreamers.tamil.sendTranslatedAudioChunk(tamilPcm, { seq: sequenceNumber });
          sessionManager.incrementChunkCount(sessionId, "tamil");
          translatedAudios.tamil = {
            text: translations.tamil,
            audioPath: tamilTts.audioPath,
          };
        }
      }

      sessionManager.incrementChunkCount(sessionId, "source");

      transcriptResults.push({
        chunk: chunkName,
        sequenceNumber,
        sessionId: sessionId,
        sourceLanguageCode,
        sourceText,
        translations: translatedAudios,
        sttResponse,
        at: new Date().toISOString(),
      });

      if (transcriptResults.length > 100) {
        transcriptResults.shift();
      }

      processedChunks.add(chunkPath);
      chunkSequenceNumbers.delete(chunkPath);
      failedChunkRetries.delete(chunkPath);
      console.log(
        `✅ Processed chunk [${chunkName}] [seq ${sequenceNumber}] [${sourceLanguageCode}] - Translated to Hindi, Bangla, Tamil`
      );
      isSarvamProcessingChunk = false;
    } catch (err) {
      isSarvamProcessingChunk = false;
      const retries = (failedChunkRetries.get(chunkPath) || 0) + 1;
      failedChunkRetries.set(chunkPath, retries);

      if (retries <= MAX_CHUNK_RETRIES) {
        console.error(
          `⚠️  Processing failed for ${path.basename(chunkPath)} (retry ${retries}/${MAX_CHUNK_RETRIES}): ${err.message}`
        );
        enqueueChunkForTranscription(chunkPath);
      } else {
        console.error(
          `❌ Processing failed permanently for ${path.basename(chunkPath)}: ${err.message}`
        );
        processedChunks.add(chunkPath);
        chunkSequenceNumbers.delete(chunkPath);
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
    String(TARGET_CHUNK_DURATION_SEC),
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
    sarvamBusy: isSarvamProcessingChunk,
    holdAudioEnabled: Boolean(holdAudioPcmBuffer),
    holdAudioFile: HOLD_AUDIO_FILE,
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
    bangla: ivsStreamers.bangla.getStatus(),
    tamil: ivsStreamers.tamil.getStatus(),
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

// Start IVS streams manually
app.post("/ivs/start", async (req, res) => {
  const session = sessionManager.getCurrentSession();
  const sessionId = session.sessionId;

  const startPromises = [
    ivsStreamers.hindi.startStream(sessionId),
    ivsStreamers.bangla.startStream(sessionId),
    ivsStreamers.tamil.startStream(sessionId),
  ];

  const results = await Promise.all(startPromises);
  const allSuccess = results.every((r) => r);

  if (allSuccess) {
    sessionManager.markStreamActive(sessionId, "hindi");
    sessionManager.markStreamActive(sessionId, "bangla");
    sessionManager.markStreamActive(sessionId, "tamil");
    res.json({
      message: "All IVS streams started",
      sessionId: sessionId,
      statuses: {
        hindi: ivsStreamers.hindi.getStatus(),
        bangla: ivsStreamers.bangla.getStatus(),
        tamil: ivsStreamers.tamil.getStatus(),
      },
    });
  } else {
    res.status(400).json({ error: "Failed to start some IVS streams" });
  }
});

// Stop IVS streams manually
app.post("/ivs/stop", async (req, res) => {
  const sessionId = sessionManager.activeSession;
  await Promise.all([
    ivsStreamers.hindi.stopStream(),
    ivsStreamers.bangla.stopStream(),
    ivsStreamers.tamil.stopStream(),
  ]);

  if (sessionId) {
    sessionManager.markStreamInactive(sessionId, "hindi");
    sessionManager.markStreamInactive(sessionId, "bangla");
    sessionManager.markStreamInactive(sessionId, "tamil");
  }

  res.json({ message: "All IVS streams stopped" });
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
app.listen(PORT, async () => {
  console.log(
    `\n🚀 Server running on http://localhost:${PORT}`
  );
  console.log(`📁 Audio chunks saved to: ${SEGMENT_FOLDER}\n`);

  holdAudioPcmBuffer = await loadHoldAudioBuffer();
  if (holdAudioPcmBuffer) {
    ivsStreamers.hindi.setFallbackAudio(holdAudioPcmBuffer);
    ivsStreamers.bangla.setFallbackAudio(holdAudioPcmBuffer);
    ivsStreamers.tamil.setFallbackAudio(holdAudioPcmBuffer);
  }

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
  const banglaConfigured = process.env.AWS_IVS_INGEST_URL_BANGLA && process.env.AWS_IVS_STREAM_KEY_BANGLA;
  const tamilConfigured = process.env.AWS_IVS_INGEST_URL_TAMIL && process.env.AWS_IVS_STREAM_KEY_TAMIL;

  if (hindiConfigured || banglaConfigured || tamilConfigured) {
    const session = sessionManager.getCurrentSession();
    const sessionId = session.sessionId;

    if (hindiConfigured) {
      console.log("🎥 Starting IVS Hindi translator stream...");
      await ivsStreamers.hindi.startStream(sessionId);
      sessionManager.markStreamActive(sessionId, "hindi");
    } else {
      console.log("⏸️  AWS IVS Hindi translator stream not configured.");
    }

    if (banglaConfigured) {
      console.log("🎥 Starting IVS Bangla translator stream...");
      await ivsStreamers.bangla.startStream(sessionId);
      sessionManager.markStreamActive(sessionId, "bangla");
    } else {
      console.log("⏸️  AWS IVS Bangla translator stream not configured.");
    }

    if (tamilConfigured) {
      console.log("🎥 Starting IVS Tamil translator stream...");
      await ivsStreamers.tamil.startStream(sessionId);
      sessionManager.markStreamActive(sessionId, "tamil");
    } else {
      console.log("⏸️  AWS IVS Tamil translator stream not configured.");
    }
  } else {
    console.log("⏸️  AWS IVS translator streams not configured.");
    console.log(" To enable: Set AWS_IVS_INGEST_URL_* and AWS_IVS_STREAM_KEY_* in .env");
  }
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down gracefully...");
  if (chunkScannerTimer) {
    clearInterval(chunkScannerTimer);
  }
  if (ffmpeg && !ffmpeg.killed) {
    ffmpeg.kill("SIGTERM");
  }
  // Stop all IVS streams
  await Promise.all([
    ivsStreamers.hindi.stopStream(),
    ivsStreamers.bangla.stopStream(),
    ivsStreamers.tamil.stopStream(),
  ]);
  // Cleanup expired sessions
  sessionManager.endAllSessions();
  process.exit(0);
});
