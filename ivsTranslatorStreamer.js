import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import fs from "fs";
import path from "path";

/**
 * AWS IVS Translator Streamer
 * Streams translated audio chunks to AWS IVS RTMP endpoint with dummy video
 * Supports language-specific streaming with session management
 */
class IVSTranslatorStreamer {
  constructor(options = {}) {
    // Language identifier (e.g., 'hindi', 'bangla', 'tamil')
    this.language = options.language || 'english';
    
    // RTMP configuration - can be language-specific
    this.rtmpUrl = options.rtmpUrl || process.env[`AWS_IVS_INGEST_URL_${this.language.toUpperCase()}`] || process.env.AWS_IVS_INGEST_URL;
    this.streamKey = options.streamKey || process.env[`AWS_IVS_STREAM_KEY_${this.language.toUpperCase()}`] || process.env.AWS_IVS_STREAM_KEY;
    this.sourceVideoUrl = options.sourceVideoUrl || process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL || "";
    this.videoSyncDelaySec =
      typeof options.videoSyncDelaySec === "number"
        ? options.videoSyncDelaySec
        : Number(process.env.VIDEO_SYNC_DELAY_SEC || 6);
    
    // Session management
    this.currentSessionId = null;
    this.sessionStreams = new Map(); // Map of sessionId -> FFmpeg process

    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.reconnectDelay = options.reconnectDelay || 3000;

    this.ffmpeg = null;
    this.isRunning = false;
    this.isStopping = false;
    this.reconnectAttempts = 0;
    this.isHandlingError = false;
    this.pendingChunks = new Map(); // Map of seq -> PCM audio buffer
    this.nextSequenceToPlay = 1;
    this.autoSequenceCounter = 1;
    this.playbackTimer = null;
    this.playbackCursorMs = 0;
    this.maxFramesPerTick = Math.max(1, Number(options.maxFramesPerTick || process.env.IVS_MAX_FRAMES_PER_TICK || 8));
    this.currentChunk = null; // { seq, buffer, offset }
    this.lastAcceptedChunk = null;
    this.consecutiveDuplicateChunks = 0;
    this.duplicateChunksDropped = 0;
    this.nearDuplicateChunksDropped = 0;
    this.maxConsecutiveDuplicateChunks = Math.max(
      0,
      Number(options.maxConsecutiveDuplicateChunks ?? process.env.IVS_MAX_CONSECUTIVE_DUPLICATE_CHUNKS ?? 0)
    );
    this.audioFingerprintDedupeEnabled =
      String(options.audioFingerprintDedupeEnabled ?? process.env.IVS_AUDIO_FINGERPRINT_DEDUPE ?? "true").toLowerCase() !== "false";
    this.fingerprintBinCount = Math.max(
      8,
      Number(options.fingerprintBinCount || process.env.IVS_FINGERPRINT_BIN_COUNT || 12)
    );
    this.fingerprintWindowMs = Math.max(
      250,
      Number(options.fingerprintWindowMs || process.env.IVS_FINGERPRINT_WINDOW_MS || 2500)
    );
    this.fingerprintSimilarityThreshold = Math.min(
      0.9999,
      Math.max(0.9, Number(options.fingerprintSimilarityThreshold || process.env.IVS_FINGERPRINT_SIMILARITY || 0.992))
    );
    this.recentFingerprints = [];
    this.inputSampleRate = Math.max(8000, Number(options.inputSampleRate || process.env.IVS_TRANSLATED_PCM_RATE || 16000));
    this.frameDurationMs = 20;
    this.frameBytes = Math.floor((this.inputSampleRate * 2 * this.frameDurationMs) / 1000);
    this.waitingForDrain = false;
    this.fallbackPcmBuffer = null;
    this.fallbackOffset = 0;
    this.missingSequenceSince = null;
    this.maxMissingSequenceWaitMs = options.maxMissingSequenceWaitMs || 300;
    this.backgroundMusicEnabled =
      String(options.backgroundMusicEnabled ?? process.env.BGMUSIC_ENABLED ?? "true").toLowerCase() !== "false";
    this.backgroundMusicPath =
      options.backgroundMusicPath ||
      process.env.BGMUSIC_FILE_PATH ||
      process.env.BG_MUSIC_FILE_PATH ||
      "public/bgmusic.mp3";
    this.backgroundMusicVolume = Math.max(
      0,
      Math.min(1, Number(options.backgroundMusicVolume ?? process.env.BGMUSIC_VOLUME ?? 0.08))
    );
    this.translatedAudioGain = Math.max(
      0,
      Math.min(3, Number(options.translatedAudioGain ?? process.env.TRANSLATED_AUDIO_GAIN ?? 1.6))
    );
    this.backgroundMusicLoaded = false;
    this.backgroundMusicWarned = false;

    console.log(`🎯 IVS Translator Streamer initialized for: ${this.language.toUpperCase()}`);
  }

  resolveBackgroundMusicPath() {
    if (!this.backgroundMusicPath) {
      return null;
    }

    if (path.isAbsolute(this.backgroundMusicPath)) {
      return this.backgroundMusicPath;
    }

    return path.resolve(process.cwd(), this.backgroundMusicPath);
  }

  async transcodeBackgroundMusicToPcm(filePath) {
    return new Promise((resolve, reject) => {
      const args = [
        "-v",
        "error",
        "-stream_loop",
        "-1",
        "-i",
        filePath,
        "-t",
        "120",
        "-ac",
        "1",
        "-ar",
        String(this.inputSampleRate),
        "-filter:a",
        `volume=${this.backgroundMusicVolume.toFixed(3)}`,
        "-f",
        "s16le",
        "pipe:1",
      ];

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

        reject(new Error(`FFmpeg bg music transcode exited ${code}: ${stderr.trim()}`));
      });
    });
  }

  async ensureBackgroundMusicFallback() {
    if (!this.backgroundMusicEnabled || this.backgroundMusicLoaded) {
      return;
    }

    const bgMusicPath = this.resolveBackgroundMusicPath();
    if (!bgMusicPath || !fs.existsSync(bgMusicPath)) {
      if (!this.backgroundMusicWarned) {
        console.warn(
          `⚠️  Background music file not found for ${this.language.toUpperCase()}: ${bgMusicPath || "<empty>"}`
        );
        this.backgroundMusicWarned = true;
      }

      // Keep a continuous bed even when the file is missing.
      this.setFallbackAudio(this.buildSyntheticBackgroundPcm());
      this.backgroundMusicLoaded = true;
      console.log(`🎵 Using generated background bed for ${this.language.toUpperCase()} (file missing)`);
      return;
    }

    try {
      const pcmBuffer = await this.transcodeBackgroundMusicToPcm(bgMusicPath);
      if (!pcmBuffer || pcmBuffer.length === 0) {
        throw new Error("Transcoded PCM buffer is empty");
      }

      this.setFallbackAudio(pcmBuffer);
      this.backgroundMusicLoaded = true;
      console.log(
        `🎵 Background music enabled for ${this.language.toUpperCase()} from ${bgMusicPath} at volume ${this.backgroundMusicVolume}`
      );
    } catch (err) {
      if (!this.backgroundMusicWarned) {
        console.warn(`⚠️  Failed to enable background music [${this.language}]: ${err.message}`);
        this.backgroundMusicWarned = true;
      }

      // Fall back to a generated loop so output stays continuous.
      this.setFallbackAudio(this.buildSyntheticBackgroundPcm());
      this.backgroundMusicLoaded = true;
      console.log(`🎵 Using generated background bed for ${this.language.toUpperCase()} (transcode fallback)`);
    }
  }

  buildSyntheticBackgroundPcm(durationSec = 30) {
    const totalSamples = Math.max(1, Math.floor(this.inputSampleRate * durationSec));
    const buffer = Buffer.alloc(totalSamples * 2);
    const level = Math.max(0.04, this.backgroundMusicVolume);
    const amplitude = Math.floor(2600 * level);

    for (let i = 0; i < totalSamples; i += 1) {
      const t = i / this.inputSampleRate;
      const low = Math.sin(2 * Math.PI * 196 * t);
      const mid = Math.sin(2 * Math.PI * 262 * t);
      const shimmer = Math.sin(2 * Math.PI * 392 * t);
      let sample = Math.round((low * 0.5 + mid * 0.35 + shimmer * 0.15) * amplitude);

      if (sample > 32767) sample = 32767;
      if (sample < -32768) sample = -32768;
      buffer.writeInt16LE(sample, i * 2);
    }

    return buffer;
  }

  /**
   * Build the complete RTMPS URL
   */
  getStreamUrl() {
    if (!this.rtmpUrl || !this.streamKey) {
      console.error(
        `❌ AWS IVS configuration missing for ${this.language}. Set AWS_IVS_INGEST_URL_${this.language.toUpperCase()} and AWS_IVS_STREAM_KEY_${this.language.toUpperCase()}`
      );
      return null;
    }

    // Construct RTMPS URL with stream key
    const baseUrl = this.rtmpUrl.replace(/^rtmp:\/\//, "rtmps://");
    return `${baseUrl}${this.streamKey}`;
  }

  /**
   * Start FFmpeg process for a specific session
   * Reuses existing FFmpeg process if already running for this session
   */
  async startStream(sessionId = null) {
    this.isStopping = false;
    const session = sessionId || `session_${Date.now()}`;
    this.currentSessionId = session;

    // If stream already running for this session, reuse it
    if (this.isRunning && this.ffmpeg && !this.ffmpeg.killed) {
      console.log(`⏳ IVS ${this.language.toUpperCase()} streamer already running for session ${session}`);
      return true;
    }

    const streamUrl = this.getStreamUrl();
    if (!streamUrl) {
      return false;
    }

    console.log(`🚀 Starting IVS ${this.language.toUpperCase()} translator stream for session ${session}...`);

    // FFmpeg command to stream source video + translated audio to AWS IVS.
    const ffmpegArgs = [
      "-loglevel",
      "warning",
    ];

    const useSourceVideo = Boolean(this.sourceVideoUrl);
    if (useSourceVideo) {
      ffmpegArgs.push(
        "-thread_queue_size",
        "1024",
        "-itsoffset",
        String(Math.max(0, this.videoSyncDelaySec)),
        "-fflags",
        "+genpts+discardcorrupt",
        "-flags",
        "low_delay",
        "-reconnect",
        "1",
        "-reconnect_streamed",
        "1",
        "-reconnect_on_network_error",
        "1",
        "-reconnect_delay_max",
        "2",
        "-i",
        this.sourceVideoUrl
      );
    } else {
      // Fallback if source video is unavailable.
      ffmpegArgs.push("-f", "lavfi", "-i", "color=c=black:s=1280x720:d=2147483");
    }

    ffmpegArgs.push(
      // Audio input: read from stdin as PCM s16le
      "-f",
      "s16le",
      "-ar",
      String(this.inputSampleRate),
      "-ac",
      "1",
      "-thread_queue_size",
      "1024",
      "-i",
      "pipe:0"
    );

    if (useSourceVideo) {
      ffmpegArgs.push(
        // Keep input video quality/profile as-is where possible.
        "-map",
        "0:v:0",
        "-c:v",
        "copy"
      );
    } else {
      ffmpegArgs.push(
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-b:v",
        "2500k",
        "-maxrate",
        "3000k",
        "-bufsize",
        "6000k",
        "-pix_fmt",
        "yuv420p"
      );
    }

    ffmpegArgs.push(
      "-map",
      "1:a:0",

      // Audio codec settings
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",

      // Output format and settings
      "-f",
      "flv",
      "-flvflags",
      "no_duration_filesize", // Enable streaming mode
      "-fflags",
      "+discardcorrupt", // Discard corrupted frames

      // Network timeout
      "-rtmp_live",
      "live",
      // Output URL
      streamUrl,
    );

    try {
      this.ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Prevent unhandled stream errors (e.g. write EOF/EPIPE after RTMP disconnect).
      this.ffmpeg.stdin.on("error", (err) => {
        console.warn(`⚠️  FFmpeg stdin error [${this.language}]: ${err.message}`);
      });

      this.ffmpeg.on("error", (err) => {
        console.error(`❌ FFmpeg process error for ${this.language}: ${err.message}`);
        this.handleStreamError();
      });

      this.ffmpeg.on("close", (code) => {
        console.log(`⛔ FFmpeg ${this.language.toUpperCase()} closed with code ${code}`);
        this.isRunning = false;
        this.ffmpeg = null;
        this.handleStreamError();
      });

      // Log FFmpeg output
      this.ffmpeg.stdout.on("data", (data) => {
        const message = data.toString().trim();
        if (message && !message.includes("frame=")) {
          console.log(`📢 FFmpeg [${this.language.toUpperCase()}] stdout: ${message}`);
        }
      });

      this.ffmpeg.stderr.on("data", (data) => {
        const message = data.toString().trim();
        if (
          message &&
          !message.includes("frame=") &&
          !message.includes("speed=") &&
          !message.includes("Last message repeated")
        ) {
          console.log(`📢 FFmpeg [${this.language.toUpperCase()}] stderr: ${message}`);
        }
      });

      this.isRunning = true;
      this.reconnectAttempts = 0;
      await this.ensureBackgroundMusicFallback();
      this.startPlaybackLoop();
      console.log(`✅ IVS ${this.language.toUpperCase()} translator stream started for session ${session}: ${streamUrl}`);
      return true;
    } catch (err) {
      console.error(`❌ Failed to start IVS ${this.language} stream: ${err.message}`);
      return false;
    }
  }

  /**
   * Handle stream errors and reconnection
   */
  async handleStreamError() {
    if (this.isHandlingError) {
      return;
    }

    if (this.isStopping) {
      return;
    }

    this.isHandlingError = true;

    if (this.ffmpeg && !this.ffmpeg.killed) {
      try {
        this.ffmpeg.kill("SIGTERM");
      } catch (err) {
        console.error(`⚠️  Error killing FFmpeg [${this.language}]: ${err.message}`);
      }
    }

    this.isRunning = false;
    this.stopPlaybackLoop();

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      console.log(
        `🔄 Reconnecting IVS ${this.language} stream in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
      await this.startStream(this.currentSessionId);
    } else {
      console.error(
        `❌ Max reconnection attempts (${this.maxReconnectAttempts}) exceeded for IVS ${this.language} stream`
      );
    }

    this.isHandlingError = false;
  }

  /**
   * Set fallback PCM audio for gapless playout when translated chunks are not ready.
   */
  setFallbackAudio(pcmBuffer) {
    if (!pcmBuffer || !Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
      this.fallbackPcmBuffer = null;
      this.fallbackOffset = 0;
      return;
    }

    this.fallbackPcmBuffer = pcmBuffer;
    this.fallbackOffset = 0;
  }

  startPlaybackLoop() {
    if (this.playbackTimer) {
      return;
    }

    this.playbackCursorMs = Date.now();
    this.playbackTimer = setInterval(() => {
      this.playbackTick();
    }, Math.max(5, Math.floor(this.frameDurationMs / 2)));
  }

  stopPlaybackLoop() {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.currentChunk = null;
    this.waitingForDrain = false;
    this.missingSequenceSince = null;
    this.playbackCursorMs = 0;
  }

  playbackTick() {
    if (!this.isRunning || !this.ffmpeg || this.waitingForDrain) {
      return;
    }

    if (!this.ffmpeg.stdin || this.ffmpeg.stdin.destroyed || !this.ffmpeg.stdin.writable) {
      return;
    }

    const now = Date.now();
    if (!this.playbackCursorMs) {
      this.playbackCursorMs = now;
    }

    const elapsedMs = Math.max(0, now - this.playbackCursorMs);
    const framesDue = Math.max(1, Math.floor(elapsedMs / this.frameDurationMs));
    const framesToWrite = Math.min(this.maxFramesPerTick, framesDue);

    for (let i = 0; i < framesToWrite; i += 1) {
      const translatedFrame = this.getNextTranslatedFrame();
      const backgroundFrame = this.getBackgroundFrame();
      const frame = translatedFrame
        ? this.mixPcmFrames(translatedFrame, backgroundFrame)
        : backgroundFrame;
      const writeSuccess = this.ffmpeg.stdin.write(frame);

      this.playbackCursorMs += this.frameDurationMs;

      if (!writeSuccess) {
        this.waitingForDrain = true;
        this.ffmpeg.stdin.once("drain", () => {
          this.waitingForDrain = false;
        });
        break;
      }
    }

    // Avoid unbounded catch-up bursts if the event loop stalls for too long.
    const maxBacklogMs = this.frameDurationMs * this.maxFramesPerTick;
    if (now - this.playbackCursorMs > maxBacklogMs) {
      this.playbackCursorMs = now - maxBacklogMs;
    }
  }

  getNextTranslatedFrame() {
    // Load next in-order chunk when available.
    if (!this.currentChunk) {
      const nextBuffer = this.pendingChunks.get(this.nextSequenceToPlay);
      if (nextBuffer) {
        this.pendingChunks.delete(this.nextSequenceToPlay);
        this.currentChunk = {
          seq: this.nextSequenceToPlay,
          buffer: nextBuffer,
          offset: 0,
        };
        this.missingSequenceSince = null;
      } else {
        this.handlePotentialMissingSequence();
      }
    }

    if (!this.currentChunk) {
      return null;
    }

    const chunk = this.currentChunk;
    const remaining = chunk.buffer.length - chunk.offset;

    if (remaining <= this.frameBytes) {
      const tail = chunk.buffer.slice(chunk.offset);
      this.currentChunk = null;
      this.nextSequenceToPlay += 1;

      if (tail.length === this.frameBytes) {
        return tail;
      }

      return Buffer.concat([tail, Buffer.alloc(this.frameBytes - tail.length)]);
    }

    const frame = chunk.buffer.slice(chunk.offset, chunk.offset + this.frameBytes);
    chunk.offset += this.frameBytes;
    return frame;
  }

  mixPcmFrames(primaryFrame, backgroundFrame) {
    if (!backgroundFrame || backgroundFrame.length === 0) {
      return primaryFrame;
    }

    const mixed = Buffer.alloc(this.frameBytes);
    for (let offset = 0; offset < this.frameBytes; offset += 2) {
      const primarySample = primaryFrame.readInt16LE(offset);
      const backgroundSample = backgroundFrame.readInt16LE(offset);
      let value = Math.round(primarySample * this.translatedAudioGain) + backgroundSample;

      if (value > 32767) value = 32767;
      if (value < -32768) value = -32768;

      mixed.writeInt16LE(value, offset);
    }

    return mixed;
  }

  handlePotentialMissingSequence() {
    const hasFutureChunk = Array.from(this.pendingChunks.keys()).some(
      (seq) => seq > this.nextSequenceToPlay
    );

    if (!hasFutureChunk) {
      this.missingSequenceSince = null;
      return;
    }

    if (!this.missingSequenceSince) {
      this.missingSequenceSince = Date.now();
      return;
    }

    if (Date.now() - this.missingSequenceSince > this.maxMissingSequenceWaitMs) {
      console.warn(
        `⏭️  Skipping missing ${this.language.toUpperCase()} sequence ${this.nextSequenceToPlay} after wait timeout`
      );
      this.nextSequenceToPlay += 1;
      this.missingSequenceSince = null;
    }
  }

  getBackgroundFrame() {
    if (!this.fallbackPcmBuffer || this.fallbackPcmBuffer.length === 0) {
      return Buffer.alloc(this.frameBytes);
    }

    const source = this.fallbackPcmBuffer;
    const frame = Buffer.alloc(this.frameBytes);
    let copied = 0;

    while (copied < this.frameBytes) {
      const remainingFrame = this.frameBytes - copied;
      const remainingSource = source.length - this.fallbackOffset;
      const bytesToCopy = Math.min(remainingFrame, remainingSource);

      source.copy(frame, copied, this.fallbackOffset, this.fallbackOffset + bytesToCopy);
      copied += bytesToCopy;
      this.fallbackOffset = (this.fallbackOffset + bytesToCopy) % source.length;
    }

    return frame;
  }

  buildAudioFingerprint(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 160) {
      return null;
    }

    const sampleCount = Math.floor(buffer.length / 2);
    if (sampleCount <= 0) {
      return null;
    }

    const bins = new Array(this.fingerprintBinCount).fill(0);
    const counts = new Array(this.fingerprintBinCount).fill(0);
    let squaredSum = 0;
    let zeroCrossings = 0;
    let previousSample = 0;

    for (let i = 0; i < sampleCount; i += 1) {
      const sample = buffer.readInt16LE(i * 2);
      const normalized = sample / 32768;
      const absValue = Math.abs(normalized);
      const binIndex = Math.min(
        this.fingerprintBinCount - 1,
        Math.floor((i * this.fingerprintBinCount) / sampleCount)
      );

      bins[binIndex] += absValue;
      counts[binIndex] += 1;
      squaredSum += normalized * normalized;

      if (i > 0 && ((sample >= 0 && previousSample < 0) || (sample < 0 && previousSample >= 0))) {
        zeroCrossings += 1;
      }

      previousSample = sample;
    }

    for (let i = 0; i < bins.length; i += 1) {
      if (counts[i] > 0) {
        bins[i] /= counts[i];
      }
    }

    const rms = Math.sqrt(squaredSum / sampleCount);
    const zcr = sampleCount > 1 ? zeroCrossings / (sampleCount - 1) : 0;
    return [...bins, rms, zcr];
  }

  cosineSimilarity(vectorA, vectorB) {
    if (!vectorA || !vectorB || vectorA.length !== vectorB.length) {
      return 0;
    }

    let dot = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vectorA.length; i += 1) {
      const a = vectorA[i];
      const b = vectorB[i];
      dot += a * b;
      normA += a * a;
      normB += b * b;
    }

    if (normA <= 0 || normB <= 0) {
      return 0;
    }

    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  pruneOldFingerprints(nowMs) {
    if (this.recentFingerprints.length === 0) {
      return;
    }

    this.recentFingerprints = this.recentFingerprints.filter(
      (entry) => nowMs - entry.at <= this.fingerprintWindowMs
    );
  }

  shouldDropNearDuplicate(buffer, sequenceNumber) {
    if (!this.audioFingerprintDedupeEnabled) {
      return { drop: false, fingerprint: null };
    }

    const fingerprint = this.buildAudioFingerprint(buffer);
    if (!fingerprint) {
      return { drop: false, fingerprint: null };
    }

    const now = Date.now();
    this.pruneOldFingerprints(now);

    let bestSimilarity = 0;
    for (const entry of this.recentFingerprints) {
      const similarity = this.cosineSimilarity(fingerprint, entry.fingerprint);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
      }
    }

    if (bestSimilarity >= this.fingerprintSimilarityThreshold) {
      this.nearDuplicateChunksDropped += 1;
      if (this.nearDuplicateChunksDropped <= 5 || this.nearDuplicateChunksDropped % 25 === 0) {
        console.warn(
          `⚠️  Dropping near-duplicate ${this.language.toUpperCase()} audio chunk seq=${sequenceNumber} similarity=${bestSimilarity.toFixed(4)}`
        );
      }
      return { drop: true, fingerprint };
    }

    return { drop: false, fingerprint };
  }

  /**
   * Queue a translated PCM audio chunk by sequence number.
   */
  enqueueAudioChunk(buffer, options = {}) {
    if (!this.isRunning) {
      console.warn("⚠️  IVS stream not running, queuing audio chunk");
    }

    if (!Buffer.isBuffer(buffer)) {
      console.error("❌ Audio chunk must be a Buffer");
      return false;
    }

    const sequenceNumber =
      Number.isInteger(options.seq) && options.seq > 0
        ? options.seq
        : this.autoSequenceCounter++;

    if (sequenceNumber < this.nextSequenceToPlay) {
      console.warn(
        `⚠️  Dropping late ${this.language.toUpperCase()} sequence ${sequenceNumber}; next expected is ${this.nextSequenceToPlay}`
      );
      return false;
    }

    if (this.pendingChunks.has(sequenceNumber)) {
      console.warn(
        `⚠️  Duplicate ${this.language.toUpperCase()} sequence ${sequenceNumber} ignored`
      );
      return false;
    }

    // Prevent audible repeats when provider emits the exact same PCM chunk repeatedly.
    if (this.lastAcceptedChunk && this.lastAcceptedChunk.length === buffer.length && this.lastAcceptedChunk.equals(buffer)) {
      this.consecutiveDuplicateChunks += 1;
      if (this.consecutiveDuplicateChunks > this.maxConsecutiveDuplicateChunks) {
        this.duplicateChunksDropped += 1;
        if (this.duplicateChunksDropped <= 5 || this.duplicateChunksDropped % 25 === 0) {
          console.warn(
            `⚠️  Dropping repeated ${this.language.toUpperCase()} audio chunk seq=${sequenceNumber} repeats=${this.consecutiveDuplicateChunks}`
          );
        }
        return false;
      }
    } else {
      this.consecutiveDuplicateChunks = 0;
    }

    const nearDuplicateCheck = this.shouldDropNearDuplicate(buffer, sequenceNumber);
    if (nearDuplicateCheck.drop) {
      return false;
    }

    this.pendingChunks.set(sequenceNumber, buffer);
    this.lastAcceptedChunk = Buffer.from(buffer);
    if (nearDuplicateCheck.fingerprint) {
      this.recentFingerprints.push({
        at: Date.now(),
        seq: sequenceNumber,
        fingerprint: nearDuplicateCheck.fingerprint,
      });
      this.pruneOldFingerprints(Date.now());
    }
    return true;
  }

  /**
   * Send translated audio chunk to the stream
   * Public API function
   */
  async sendTranslatedAudioChunk(buffer, options = {}) {
    return this.enqueueAudioChunk(buffer, options);
  }

  /**
   * STREAMING API: Push audio frame for real-time processing
   * Designed for parallel pipeline integration.
   * 
   * Accepts audio chunk from pipeline and queues for playback.
   * Maintains strict ordering via sequenceId.
   */
  pushAudioFrame(audioData) {
    if (!audioData || !audioData.audioBuffer) {
      console.warn('⚠️  Invalid audio frame data');
      return false;
    }

    const { sequenceId, audioBuffer, provider } = audioData;
    
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
      console.warn(`⚠️  Empty audio buffer for sequence ${sequenceId}`);
      return false;
    }

    // Enqueue with explicit sequence number
    const success = this.enqueueAudioChunk(audioBuffer, { seq: sequenceId });
    
    if (success) {
      const status = this.getStatus();
      console.log(
        `📤 ${this.language.toUpperCase()} audio queued: seq=${sequenceId}, ` +
        `buffer=${audioBuffer.length}B, queue=${status.queueLength}, ` +
        `provider=${provider}`
      );
    }

    return success;
  }

  /**
   * STREAMING API: Batch push multiple audio frames at once
   * Useful for pipeline output batches.
   */
  pushAudioFrameBatch(audioDataArray) {
    let successCount = 0;
    let failureCount = 0;

    for (const audioData of audioDataArray) {
      if (this.pushAudioFrame(audioData)) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    console.log(
      `📦 Batch processed: ${successCount} success, ${failureCount} failed`
    );

    return { successCount, failureCount };
  }

  /**
   * STREAMING API: Get current buffer depth and latency estimates
   * Useful for backpressure monitoring.
   */
  getStreamingStats() {
    const stats = this.getStatus();
    const bufferDurationMs = (stats.queueLength * this.frameDurationMs);

    return {
      isRunning: stats.isRunning,
      queueLength: stats.queueLength,
      estimatedBufferDurationMs: bufferDurationMs,
      nextSequenceToPlay: stats.nextSequenceToPlay,
      isWaitingForDrain: this.waitingForDrain,
      duplicateChunksDropped: this.duplicateChunksDropped,
      nearDuplicateChunksDropped: this.nearDuplicateChunksDropped,
      fps: Math.round(1000 / this.frameDurationMs),
      bytesPerSecond: this.inputSampleRate * 2,
      language: this.language,
    };
  }

  /**
   * STREAMING API: Stop accepting new frames gracefully
   * Drain pipeline buffer before terminating.
   */
  async stopAcceptingFrames() {
    console.log(`⏸️  ${this.language} streamer stopping frame acceptance...`);
    
    // Wait for pending chunks to be consumed
    let attempts = 0;
    while (this.pendingChunks.size > 0 && attempts < 100) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      attempts++;
    }

    console.log(`✅ ${this.language} streamer drained (after ${attempts * 50}ms)`);
  }

  /**
   * STREAMING API: Resume a paused stream without restarting FFmpeg
   */
  async resume() {
    if (this.isRunning) {
      console.log(`✅ ${this.language} stream already running`);
      return true;
    }

    console.log(`▶️  Resuming ${this.language} stream...`);
    await this.ensureBackgroundMusicFallback();
    this.startPlaybackLoop();
    this.isRunning = true;
    return true;
  }

  /**
   * STREAMING API: Pause stream playback (pause playback timer)
   */
  async pause() {
    console.log(`⏸️  Pausing ${this.language} stream...`);
    this.stopPlaybackLoop();
    this.isRunning = false;
    return true;
  }

  /**
   * Stop the stream gracefully
   */
  async stopStream() {
    console.log(`🛑 Stopping IVS ${this.language.toUpperCase()} translator stream...`);

    this.isStopping = true;
    this.isRunning = false;
    this.stopPlaybackLoop();
    this.pendingChunks.clear();
    this.currentChunk = null;
    this.lastAcceptedChunk = null;
    this.consecutiveDuplicateChunks = 0;
    this.recentFingerprints = [];

    if (this.ffmpeg && !this.ffmpeg.killed) {
      try {
        // Close stdin to signal end of stream
        this.ffmpeg.stdin.end();

        // Wait for process to close with timeout
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            console.warn(`⚠️  FFmpeg [${this.language}] timeout, force killing...`);
            this.ffmpeg.kill("SIGKILL");
            resolve();
          }, 5000);

          this.ffmpeg.on("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        console.log(`✅ IVS ${this.language.toUpperCase()} translator stream stopped`);
      } catch (err) {
        console.error(`⚠️  Error stopping ${this.language} stream: ${err.message}`);
      }
    }
  }

  /**
   * Stop stream for a specific session
   */
  async stopStreamForSession(sessionId) {
    if (this.currentSessionId === sessionId) {
      await this.stopStream();
    }
  }

  /**
   * Get stream status
   */
  getStatus() {
    return {
      language: this.language,
      isRunning: this.isRunning,
      queueLength: this.pendingChunks.size,
      nextSequenceToPlay: this.nextSequenceToPlay,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      streamUrl: this.getStreamUrl(),
      sourceVideoUrl: this.sourceVideoUrl || null,
      videoSyncDelaySec: this.videoSyncDelaySec,
      currentSessionId: this.currentSessionId,
    };
  }
}

export default IVSTranslatorStreamer;
