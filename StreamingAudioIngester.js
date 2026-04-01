import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';
import { EventEmitter } from 'events';

/**
 * StreamingAudioIngester
 * 
 * Directly pipes audio from HLS stream via FFmpeg stdout
 * into memory buffers for real-time processing.
 * 
 * Eliminates file-based chunking and polling.
 * Maintains rolling buffer (~200-500ms frames).
 */
class StreamingAudioIngester extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.hlsUrl = options.hlsUrl || process.env.AWS_IVS_PLAYBACK_URL || '';
    this.sampleRate = options.sampleRate || 16000;
    this.channels = options.channels || 1; // Mono
    this.bitDepth = options.bitDepth || 16;
    this.retainBuffer =
      typeof options.retainBuffer === 'boolean'
        ? options.retainBuffer
        : String(process.env.STREAM_INGEST_RETAIN_BUFFER || 'true').toLowerCase() !== 'false';
    
    // Rolling buffer for PCM audio
    this.audioBuffer = Buffer.alloc(0);
    this.maxBufferSize = options.maxBufferSize || 256000; // ~8 seconds at 16kHz mono
    
    // FFmpeg process
    this.ffmpegProcess = null;
    this.isRunning = false;
    this.stopping = false;
    
    // Restart logic
    this.maxRestartAttempts = options.maxRestartAttempts || 5;
    this.restartAttempts = 0;
    this.restartDelay = options.restartDelay || 2000;
    this.lastRestartTime = 0;
    
    // Stats
    this.bytesReceived = 0;
    this.startTime = null;
    
    console.log('🎵 StreamingAudioIngester initialized for:', this.hlsUrl);
  }

  /**
   * Start streaming audio from HLS URL
   */
  async start() {
    if (this.isRunning && this.ffmpegProcess) {
      console.log('⏳ Audio streaming already running');
      return;
    }

    console.log('🚀 Starting audio stream from HLS...');
    this.stopping = false;

    const ffmpegArgs = [
      // Input settings
      '-loglevel', 'warning',
      '-live_start_index', '-1',
      '-fflags', '+nobuffer+fastseek',
      '-flags', 'low_delay',
      '-protocol_whitelist', 'file,http,https,tcp,tls,crypto,data',
      '-http_persistent', '1',
      '-http_multiple', '1',
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_on_network_error', '1',
      '-reconnect_delay_max', '2',
      '-i', this.hlsUrl,
      
      // Audio extraction
      '-map', '0:a:0',
      '-acodec', 'pcm_s16le',
      '-ar', String(this.sampleRate),
      '-ac', String(this.channels),
      
      // Raw PCM output to stdout
      '-f', 's16le',
      'pipe:1',
    ];

    try {
      this.ffmpegProcess = spawn(ffmpegPath, ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this.startTime = Date.now();
      this.bytesReceived = 0;

      this.ffmpegProcess.stdout.on('data', (chunk) => {
        if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;

        // Optional rolling retention for legacy consumers.
        if (this.retainBuffer) {
          this.audioBuffer = Buffer.concat([this.audioBuffer, chunk]);

          // Maintain max buffer size (drop old data if overflow)
          if (this.audioBuffer.length > this.maxBufferSize) {
            const overflow = this.audioBuffer.length - this.maxBufferSize;
            this.audioBuffer = this.audioBuffer.slice(overflow);
            console.warn(`⚠️  Audio buffer overflow, dropped ${overflow} bytes`);
          }
        }

        this.bytesReceived += chunk.length;

        // Emit raw audio for VAD processing
        this.emit('audio-data', chunk);
      });

      this.ffmpegProcess.stderr.on('data', (data) => {
        const message = data.toString().trim();
        if (message && !message.includes('frame=') && !message.includes('Last message')) {
          console.log(`🔊 FFmpeg (audio): ${message}`);
        }
      });

      this.ffmpegProcess.on('error', (err) => {
        console.error(`❌ FFmpeg process error: ${err.message}`);
        this.handleStreamError();
      });

      this.ffmpegProcess.on('close', (code) => {
        console.log(`⛔ FFmpeg audio stream closed with code ${code}`);
        this.isRunning = false;
        this.ffmpegProcess = null;

        if (!this.stopping && this.restartAttempts < this.maxRestartAttempts) {
          this.scheduleRestart();
        } else if (!this.stopping) {
          console.error(`❌ Max restart attempts (${this.maxRestartAttempts}) exceeded`);
          this.emit('fatal-error', new Error('Max audio stream restarts exceeded'));
        }
      });

      this.isRunning = true;
      this.restartAttempts = 0;
      this.emit('started');
      console.log('✅ Audio streaming started');

    } catch (err) {
      console.error(`❌ Failed to start audio stream: ${err.message}`);
      this.handleStreamError();
    }
  }

  /**
   * Stop audio streaming
   */
  async stop() {
    console.log('⏹️  Stopping audio stream...');
    this.stopping = true;
    
    if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
      try {
        this.ffmpegProcess.kill('SIGTERM');
      } catch (err) {
        console.error(`⚠️  Error killing FFmpeg: ${err.message}`);
      }
    }

    this.isRunning = false;
    this.ffmpegProcess = null;
    this.emit('stopped');
  }

  /**
   * Get current audio buffer (for VAD or debugging)
   */
  getBuffer() {
    return this.audioBuffer;
  }

  /**
   * Extract N bytes from buffer and advance position
   */
  consumeBytes(numBytes) {
    if (numBytes <= 0 || numBytes > this.audioBuffer.length) {
      return null;
    }

    const chunk = this.audioBuffer.slice(0, numBytes);
    this.audioBuffer = this.audioBuffer.slice(numBytes);
    return chunk;
  }

  /**
   * Peek at next N bytes without consuming
   */
  peekBytes(numBytes) {
    if (numBytes <= 0 || numBytes > this.audioBuffer.length) {
      return null;
    }
    return this.audioBuffer.slice(0, numBytes);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      isRunning: this.isRunning,
      bufferSize: this.audioBuffer.length,
      bufferDurationMs: (this.audioBuffer.length / (this.sampleRate * this.channels * 2)) * 1000,
      bytesReceived: this.bytesReceived,
      uptime: this.isRunning ? Date.now() - this.startTime : 0,
      restartAttempts: this.restartAttempts,
    };
  }

  /**
   * Handle stream errors
   */
  handleStreamError() {
    if (this.ffmpegProcess && !this.ffmpegProcess.killed) {
      try {
        this.ffmpegProcess.kill('SIGKILL');
      } catch (err) {
        // Ignore
      }
    }
    this.isRunning = false;
    this.ffmpegProcess = null;
  }

  /**
   * Schedule restart with backoff
   */
  scheduleRestart() {
    this.restartAttempts++;
    const delay = this.restartDelay * Math.pow(1.5, this.restartAttempts - 1);
    
    console.log(`🔄 Restarting audio stream in ${Math.round(delay / 1000)}s (attempt ${this.restartAttempts}/${this.maxRestartAttempts})...`);
    
    setTimeout(() => {
      this.start().catch((err) => {
        console.error(`❌ Restart failed: ${err.message}`);
      });
    }, delay);
  }
}

export default StreamingAudioIngester;
