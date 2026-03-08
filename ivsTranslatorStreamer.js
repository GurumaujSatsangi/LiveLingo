import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";

/**
 * AWS IVS Translator Streamer
 * Streams translated audio chunks to AWS IVS RTMP endpoint with dummy video
 */
class IVSTranslatorStreamer {
  constructor(options = {}) {
    this.rtmpUrl = options.rtmpUrl || process.env.AWS_IVS_INGEST_URL;
    this.streamKey = options.streamKey || process.env.AWS_IVS_STREAM_KEY;
    this.maxReconnectAttempts = options.maxReconnectAttempts || 5;
    this.reconnectDelay = options.reconnectDelay || 3000;

    this.ffmpeg = null;
    this.isRunning = false;
    this.reconnectAttempts = 0;
    this.audioQueue = [];
    this.isProcessingQueue = false;
    this.stdinBuffer = Buffer.alloc(0);
  }

  /**
   * Build the complete RTMPS URL
   */
  getStreamUrl() {
    if (!this.rtmpUrl || !this.streamKey) {
      console.error(
        "❌ AWS IVS configuration missing. Set AWS_IVS_INGEST_URL and AWS_IVS_STREAM_KEY"
      );
      return null;
    }

    // Construct RTMPS URL with stream key
    const baseUrl = this.rtmpUrl.replace(/^rtmp:\/\//, "rtmps://");
    return `${baseUrl}/${this.streamKey}`;
  }

  /**
   * Start FFmpeg process with dummy video and audio from stdin
   */
  async startStream() {
    if (this.isRunning) {
      console.log("⏳ IVS streamer already running");
      return true;
    }

    const streamUrl = this.getStreamUrl();
    if (!streamUrl) {
      return false;
    }

    console.log("🚀 Starting IVS translator stream...");

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
      "-application",
      "rtmp",

      // Output URL
      streamUrl,
    ];

    try {
      this.ffmpeg = spawn(ffmpegPath, ffmpegArgs, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      this.ffmpeg.on("error", (err) => {
        console.error(`❌ FFmpeg process error: ${err.message}`);
        this.handleStreamError();
      });

      this.ffmpeg.on("close", (code) => {
        console.log(`⛔ FFmpeg closed with code ${code}`);
        this.isRunning = false;
        this.handleStreamError();
      });

      // Log FFmpeg output
      this.ffmpeg.stdout.on("data", (data) => {
        const message = data.toString().trim();
        if (message && !message.includes("frame=")) {
          console.log(`📢 FFmpeg stdout: ${message}`);
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
          console.log(`📢 FFmpeg stderr: ${message}`);
        }
      });

      this.isRunning = true;
      this.reconnectAttempts = 0;
      console.log(`✅ IVS translator stream started: ${streamUrl}`);
      return true;
    } catch (err) {
      console.error(`❌ Failed to start IVS stream: ${err.message}`);
      return false;
    }
  }

  /**
   * Handle stream errors and reconnection
   */
  async handleStreamError() {
    if (this.ffmpeg && !this.ffmpeg.killed) {
      try {
        this.ffmpeg.kill("SIGTERM");
      } catch (err) {
        console.error(`⚠️  Error killing FFmpeg: ${err.message}`);
      }
    }

    this.isRunning = false;

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
      console.log(
        `🔄 Reconnecting IVS stream in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
      await this.startStream();
    } else {
      console.error(
        `❌ Max reconnection attempts (${this.maxReconnectAttempts}) exceeded for IVS stream`
      );
    }
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
        console.warn("⚠️  Stream not running, skipping audio chunk");
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

        console.log(`🔊 Sent translated audio chunk (${audioBuffer.length} bytes) to IVS`);
      } catch (err) {
        console.error(`❌ Error writing audio to FFmpeg: ${err.message}`);
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
    console.log("🛑 Stopping IVS translator stream...");

    this.isRunning = false;

    if (this.ffmpeg && !this.ffmpeg.killed) {
      try {
        // Close stdin to signal end of stream
        this.ffmpeg.stdin.end();

        // Wait for process to close with timeout
        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            console.warn("⚠️  FFmpeg timeout, force killing...");
            this.ffmpeg.kill("SIGKILL");
            resolve();
          }, 5000);

          this.ffmpeg.on("close", () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        console.log("✅ IVS translator stream stopped");
      } catch (err) {
        console.error(`⚠️  Error stopping stream: ${err.message}`);
      }
    }
  }

  /**
   * Get stream status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      queueLength: this.audioQueue.length,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      streamUrl: this.getStreamUrl(),
    };
  }
}

export default IVSTranslatorStreamer;
