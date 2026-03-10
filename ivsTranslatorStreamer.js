import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

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
    
    // Session management
    this.currentSessionId = null;
    this.sessionStreams = new Map(); // Map of sessionId -> FFmpeg process

    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.reconnectDelay = options.reconnectDelay || 3000;

    this.ffmpeg = null;
    this.isRunning = false;
    this.reconnectAttempts = 0;
    this.isHandlingError = false;
    this.pendingChunks = new Map(); // Map of seq -> PCM audio buffer
    this.nextSequenceToPlay = 1;
    this.autoSequenceCounter = 1;
    this.playbackTimer = null;
    this.currentChunk = null; // { seq, buffer, offset }
    this.frameDurationMs = 20;
    this.frameBytes = 640; // 20ms @ 16kHz mono s16le => 16000 * 2 * 0.02
    this.waitingForDrain = false;
    this.fallbackPcmBuffer = null;
    this.fallbackOffset = 0;
    this.missingSequenceSince = null;
    this.maxMissingSequenceWaitMs = options.maxMissingSequenceWaitMs || 800;

    console.log(`🎯 IVS Translator Streamer initialized for: ${this.language.toUpperCase()}`);
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

    // FFmpeg command to stream dummy video + audio to AWS IVS
    const ffmpegArgs = [
      // Video input: black screen (1280x720)
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=1280x720:d=2147483", // ~24 days duration to keep stream continuous

      // Audio input: read from stdin as PCM s16le
      "-f",
      "s16le",
      "-ar",
      "16000",
      "-ac",
      "1",
      "-thread_queue_size",
      "1024",
      "-i",
      "pipe:0",

      // Video codec settings
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
      "yuv420p",

      // Audio codec settings
      "-c:a",
      "aac",
      "-b:a",
      "128k",
      "-ar",
      "44100",

      // Sync audio and video
      "-shortest",

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
    ];

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

    this.playbackTimer = setInterval(() => {
      this.playbackTick();
    }, this.frameDurationMs);
  }

  stopPlaybackLoop() {
    if (this.playbackTimer) {
      clearInterval(this.playbackTimer);
      this.playbackTimer = null;
    }
    this.currentChunk = null;
    this.waitingForDrain = false;
    this.missingSequenceSince = null;
  }

  playbackTick() {
    if (!this.isRunning || !this.ffmpeg || this.waitingForDrain) {
      return;
    }

    if (!this.ffmpeg.stdin || this.ffmpeg.stdin.destroyed || !this.ffmpeg.stdin.writable) {
      return;
    }

    const frame = this.getNextFrame();
    const writeSuccess = this.ffmpeg.stdin.write(frame);

    if (!writeSuccess) {
      this.waitingForDrain = true;
      this.ffmpeg.stdin.once("drain", () => {
        this.waitingForDrain = false;
      });
    }
  }

  getNextFrame() {
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
      return this.getFallbackFrame();
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

      const filler = this.getFallbackFrame();
      return Buffer.concat([tail, filler.slice(0, this.frameBytes - tail.length)]);
    }

    const frame = chunk.buffer.slice(chunk.offset, chunk.offset + this.frameBytes);
    chunk.offset += this.frameBytes;
    return frame;
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

  getFallbackFrame() {
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

    this.pendingChunks.set(sequenceNumber, buffer);
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
   * Stop the stream gracefully
   */
  async stopStream() {
    console.log(`🛑 Stopping IVS ${this.language.toUpperCase()} translator stream...`);

    this.isRunning = false;
    this.stopPlaybackLoop();
    this.pendingChunks.clear();
    this.currentChunk = null;

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
      currentSessionId: this.currentSessionId,
    };
  }
}

export default IVSTranslatorStreamer;
