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
    this.audioQueue = [];
    this.isProcessingQueue = false;
    this.isHandlingError = false;
    this.stdinBuffer = Buffer.alloc(0);

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
   * Queue an audio chunk for sending
   */
  enqueueAudioChunk(buffer) {
    if (!this.isRunning) {
      console.warn("⚠️  IVS stream not running, queuing audio chunk");
    }

    if (!Buffer.isBuffer(buffer)) {
      console.error("❌ Audio chunk must be a Buffer");
      return false;
    }

    this.audioQueue.push(buffer);
    this.processAudioQueue();
    return true;
  }

  /**
   * Process queued audio chunks sequentially
   */
  async processAudioQueue() {
    if (this.isProcessingQueue || this.audioQueue.length === 0) {
      return;
    }

    this.isProcessingQueue = true;

    while (this.audioQueue.length > 0) {
      const audioBuffer = this.audioQueue.shift();

      if (!this.isRunning || !this.ffmpeg) {
        console.warn(`⚠️  ${this.language.toUpperCase()} stream not running, skipping audio chunk`);
        this.isProcessingQueue = false;
        return;
      }

      if (!this.ffmpeg.stdin || this.ffmpeg.stdin.destroyed || !this.ffmpeg.stdin.writable) {
        console.warn(`⚠️  ${this.language.toUpperCase()} stdin not writable, skipping audio chunk`);
        this.isProcessingQueue = false;
        return;
      }

      try {
        // Write audio buffer to FFmpeg stdin
        const writeSuccess = this.ffmpeg.stdin.write(audioBuffer);

        if (!writeSuccess) {
          // Backpressure: wait for drain event
          await new Promise((resolve) => {
            this.ffmpeg.stdin.once("drain", resolve);
          });
        }

        console.log(`🔊 Sent ${this.language.toUpperCase()} translated audio chunk (${audioBuffer.length} bytes)`);
      } catch (err) {
        console.error(`❌ Error writing audio to FFmpeg [${this.language}]: ${err.message}`);
        this.handleStreamError();
        this.isProcessingQueue = false;
        return;
      }
    }

    this.isProcessingQueue = false;
  }

  /**
   * Send translated audio chunk to the stream
   * Public API function
   */
  async sendTranslatedAudioChunk(buffer) {
    return this.enqueueAudioChunk(buffer);
  }

  /**
   * Stop the stream gracefully
   */
  async stopStream() {
    console.log(`🛑 Stopping IVS ${this.language.toUpperCase()} translator stream...`);

    this.isRunning = false;

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
      queueLength: this.audioQueue.length,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      streamUrl: this.getStreamUrl(),
      currentSessionId: this.currentSessionId,
    };
  }
}

export default IVSTranslatorStreamer;
