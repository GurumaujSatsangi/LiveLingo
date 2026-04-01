/**
 * LiveLingo - REFACTORED for LOW-LATENCY STREAMING
 * 
 * Real-time translation pipeline with <3 second end-to-end latency
 * 
 * Architecture:
 * 1. FFmpeg stream ingestion (direct pipe, no files)
 * 2. Voice Activity Detection (VAD) for dynamic segmentation  
 * 3. Event-driven processing queue (no polling)
 * 4. Parallel workers: STT → Translation → TTS
 * 5. Timestamp-based sync (removes static VIDEO_SYNC_DELAY_SEC)
 * 6. Direct IVS streaming (real-time buffers)
 */

import express from 'express';
import http from 'http';
import dotenv from 'dotenv';
import ffmpegPath from 'ffmpeg-static';
import ivsSdk from '@aws-sdk/client-ivs';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { SarvamAIClient } from 'sarvamai';
import OpenAI from 'openai';

// Import new streaming components
import StreamingAudioIngester from './StreamingAudioIngester.js';
import VoiceActivityDetector from './VoiceActivityDetector.js';
import ProcessingQueue from './ProcessingQueue.js';
import ParallelPipeline from './ParallelPipeline.js';
import STTWorker from './STTWorker.js';
import TranslationWorker from './TranslationWorker.js';
import TTSWorker from './TTSWorker.js';
import LatencyMonitor from './LatencyMonitor.js';
import AudioMixer from './AudioMixer.js';
import IVSTranslatorStreamer from './ivsTranslatorStreamer.js';
import StreamSessionManager from './StreamSessionManager.js';

const { IvsClient, GetStreamCommand } = ivsSdk;

dotenv.config();

const app = express();
const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ============================================
// CONFIGURATION
// ============================================

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('view engine', 'ejs');

// Streaming pipeline configuration
const STREAM_ENABLED = String(process.env.ENABLE_STREAMING_PIPELINE || 'true').toLowerCase() === 'true';
const VAD_SILENCE_DURATION_MS = Number(process.env.VAD_SILENCE_DURATION_MS || 400);
const VAD_MAX_CHUNK_DURATION_MS = Number(process.env.VAD_MAX_CHUNK_DURATION_MS || 1500);
const VAD_ENERGY_THRESHOLD = Number(process.env.VAD_ENERGY_THRESHOLD || 0.02);

// Pipeline parallelism
const STT_CONCURRENCY = Number(process.env.STT_CONCURRENCY || 2);
const TRANSLATION_CONCURRENCY = Number(process.env.TRANSLATION_CONCURRENCY || 3);
const TTS_CONCURRENCY = Number(process.env.TTS_CONCURRENCY || 2);
const MAX_QUEUE_SIZE = Number(process.env.MAX_QUEUE_SIZE || 50);

// API clients
const sarvamClient = process.env.SARVAM_API_KEY
  ? new SarvamAIClient({ apiSubscriptionKey: process.env.SARVAM_API_KEY })
  : null;
const openaiClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;
const elevenlabsClient = process.env.ELEVENLABS_API_KEY
  ? new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY })
  : null;

// Session management
const sessionManager = new StreamSessionManager();

// Playback URLs
const DEFAULT_PLAYBACK_BASE_URL = 'https://a7936abd8b67.ap-south-1.playback.live-video.net';

function normalizePlaybackBaseUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return DEFAULT_PLAYBACK_BASE_URL;

  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;

  try {
    const parsed = new URL(withProtocol);
    const pathname = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '');
    return `${parsed.origin}${pathname}`;
  } catch (err) {
    console.warn(`⚠️  Invalid playback base URL: ${value}. Using default.`);
    return DEFAULT_PLAYBACK_BASE_URL;
  }
}

const PLAYBACK_BASE_URL = normalizePlaybackBaseUrl(
  process.env.CLOUDFRONT_PLAYBACK_BASE_URL || process.env.PLAYBACK_BASE_URL
);

function buildPlaybackUrl(langPath) {
  if (!langPath) return null;
  if (/^https?:\/\//i.test(langPath)) return langPath;
  return `${PLAYBACK_BASE_URL}${langPath}`;
}

const PLAYBACK_URLS = {
  original: buildPlaybackUrl(process.env.AWS_IVS_PLAYBACK_URL || process.env.LIVESTREAM_HLS_URL),
};

// ============================================
// STREAMING PIPELINE COMPONENTS
// ============================================

let audioIngester = null;
let vadDetector = null;
let processingQueue = null;
let pipeline = null;
let latencyMonitor = null;
let sttWorker = null;
let translationWorker = null;
let ttsWorker = null;
let audioMixer = null;
let ivsStreamer = null;

/**
 * Initialize the complete streaming pipeline
 */
async function initializeStreamingPipeline() {
  if (!STREAM_ENABLED) {
    console.log('⏭️  Streaming pipeline disabled');
    return;
  }

  try {
    console.log('🚀 Initializing streaming pipeline...');

    // 1. Audio Ingestion
    audioIngester = new StreamingAudioIngester({
      hlsUrl: PLAYBACK_URLS.original,
      sampleRate: 16000,
      channels: 1,
      maxBufferSize: 256000,
      maxRestartAttempts: 5,
    });

    // 2. Voice Activity Detection
    vadDetector = new VoiceActivityDetector({
      sampleRate: 16000,
      channels: 1,
      silenceDurationMs: VAD_SILENCE_DURATION_MS,
      maxChunkDurationMs: VAD_MAX_CHUNK_DURATION_MS,
      energyThreshold: VAD_ENERGY_THRESHOLD,
    });

    // 3. Processing Queue
    processingQueue = new ProcessingQueue({
      maxQueueSize: MAX_QUEUE_SIZE,
      chunkTimeoutMs: 30000,
      cleanupIntervalMs: 5000,
    });

    // 4. Worker initialization
    latencyMonitor = new LatencyMonitor({ windowSize: 100 });

    sttWorker = new STTWorker({
      openaiClient,
      concurrency: STT_CONCURRENCY,
      maxRetries: 2,
    });

    translationWorker = new TranslationWorker({
      sarvamClient,
      openaiClient,
      targetLanguage: 'hi-IN', // Default Hindi
      concurrency: TRANSLATION_CONCURRENCY,
      contextWindowSize: 5,
    });

    ttsWorker = new TTSWorker({
      elevenlabsClient,
      sarvamClient,
      targetLanguage: 'hi-IN',
      concurrency: TTS_CONCURRENCY,
      elevenlabsVoiceId: process.env.ELEVENLABS_SOURCE_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb',
    });

    // 5. Audio Mixer (for blending original + translated)
    audioMixer = new AudioMixer({
      sampleRate: 16000,
      originalVolumeScale: 0.4, // Reduce original to 40%
      translatedVolumeScale: 1.0, // Full translated volume
      maxBufferSize: 160000,
    });

    // 6. Parallel Pipeline Orchestrator
    pipeline = new ParallelPipeline({
      sttWorker,
      translationWorker,
      ttsWorker,
      queue: processingQueue,
      latencyMonitor,
      maxQueueDepth: MAX_QUEUE_SIZE,
      checkIntervalMs: 100,
    });

    // 7. Single IVS Streamer (mixed audio goes here)
    ivsStreamer = new IVSTranslatorStreamer({
      language: 'hindi',
      sourceVideoUrl: PLAYBACK_URLS.original,
    });

    // Connect components with event handlers
    connectPipelineEvents();

    console.log('✅ Streaming pipeline initialized successfully');

  } catch (err) {
    console.error(`❌ Failed to initialize streaming pipeline: ${err.message}`);
    throw err;
  }
}

/**
 * Connect pipeline components with event handlers
 */
function connectPipelineEvents() {
  if (!audioIngester || !vadDetector || !pipeline || !audioMixer || !ivsStreamer) return;

  // Audio → VAD (for transcription)
  audioIngester.on('audio-data', (chunk) => {
    vadDetector.processAudio(chunk);
    // Also feed original audio to mixer
    audioMixer.addOriginalAudio(chunk);
  });

  // VAD → Queue
  vadDetector.on('chunk', (chunk) => {
    processingQueue.enqueue(chunk);
  });

  // Pipeline TTS Output → Audio Mixer
  pipeline.on('audio-ready', async (audioData) => {
    const { sequenceId, audioBuffer } = audioData;
    
    // Send TTS output to mixer
    audioMixer.addTranslatedAudio(audioBuffer);

    // Extract and stream mixed audio periodically
    const mixedAudio = audioMixer.mixAudio();
    if (mixedAudio.length > 0) {
      ivsStreamer.enqueueAudioChunk(mixedAudio, { seq: sequenceId });
    }
    
    if (latencyMonitor) {
      latencyMonitor.recordStreamTime(sequenceId, Date.now());
    }

    console.log(
      `🎵 Mixed audio ready: seq=${sequenceId}, ` +
      `tts=${audioBuffer.length}B, mixed=${mixedAudio.length}B`
    );
  });

  console.log('✅ Pipeline events connected');
}

/**
 * Start streaming
 */
async function startStreaming() {
  if (!audioIngester || !pipeline) {
    console.error('❌ Streaming pipeline not initialized');
    return;
  }

  try {
    console.log('▶️  Starting audio streaming...');

    // Start IVS streamer (mixed audio)
    const session = sessionManager.getOrCreateSession();
    
    await ivsStreamer.startStream(session.sessionId);
    sessionManager.markStreamActive(session.sessionId, 'hindi');

    // Start audio ingestion
    await audioIngester.start();

    // Start pipeline processing
    pipeline.start();

    // Start periodic monitoring
    const monitoringInterval = setInterval(() => {
      const stats = pipeline.getStats();
      const mixerStats = audioMixer?.getStats() || {};
      console.log(
        `📊 Pipeline: queue=${stats.queueDepth}, completed=${stats.chunksCompleted}, ` +
        `mixer_orig=${mixerStats.originalBuffer}B, mixer_trs=${mixerStats.translatedBuffer}B`
      );
    }, 5000);

    // Periodic latency reporting
    const latencyInterval = setInterval(() => {
      latencyMonitor?.logMetrics();
    }, 10000);

    console.log('✅ Streaming started');

    return { monitoringInterval, latencyInterval };
  } catch (err) {
    console.error(`❌ Failed to start streaming: ${err.message}`);
    throw err;
  }
}

/**
 * Stop streaming gracefully
 */
async function stopStreaming() {
  console.log('⏹️  Stopping streaming...');

  try {
    if (pipeline) await pipeline.stop();
    if (audioIngester) await audioIngester.stop();
    if (ivsStreamer) await ivsStreamer.stopStream();
    if (vadDetector) vadDetector.flush();
    if (audioMixer) audioMixer.flush();

    console.log('✅ Streaming stopped');
  } catch (err) {
    console.error(`⚠️  Error stopping streaming: ${err.message}`);
  }
}

// ============================================
// EXPRESS ROUTES
// ============================================

app.get('/', async (req, res) => {
  const streamUrls = {
    original: PLAYBACK_URLS.original,
  };

  res.render('home.ejs', {
    streamUrls,
    playbackBaseUrl: PLAYBACK_BASE_URL,
    initialLanguage: 'original',
    webrtcWhepUrls: {},
    streamOptions: [
      { language: 'original', label: 'English', badge: 'Original' },
      { language: 'hindi', label: 'Hindi', badge: 'AI Voice 01' },
    ],
  });
});

app.get('/dashboard', (req, res) => {
  res.render('dashboard.ejs', {
    streamURL: PLAYBACK_URLS.original,
    testMode: process.env.TEST_MODE === 'true',
  });
});

app.get('/health', (req, res) => {
  const pipelineStats = pipeline?.getStats() || {};
  const ingesterStats = audioIngester?.getStats() || {};
  const vadStats = vadDetector?.getStats() || {};
  
  res.json({
    status: STREAM_ENABLED ? 'streaming' : 'disabled',
    pipeline: pipelineStats,
    ingester: ingesterStats,
    vad: vadStats,
    latency: latencyMonitor?.getReport(),
  });
});

app.get('/pipeline/status', (req, res) => {
  if (!pipeline) {
    return res.status(503).json({ error: 'Pipeline not initialized' });
  }

  const stats = pipeline.getStats();
  pipeline.logStatus();
  
  res.json(stats);
});

app.post('/stream/start', async (req, res) => {
  try {
    await initializeStreamingPipeline();
    const timers = await startStreaming();
    
    res.json({
      status: 'started',
      message: 'Streaming pipeline started',
      features: [
        'Real-time audio ingestion (no files)',
        'Dynamic VAD segmentation',
        'Event-driven queue (no polling)',
        'Parallel STT→Translation→TTS',
        'Live metrics tracking',
      ],
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/stream/stop', async (req, res) => {
  try {
    await stopStreaming();
    
    res.json({
      status: 'stopped',
      message: 'Streaming pipeline stopped',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/metrics', (req, res) => {
  if (!latencyMonitor) {
    return res.status(503).json({ error: 'Metrics not available' });
  }

  res.json(latencyMonitor.getReport());
});

app.use(express.static('public'));

// ============================================
// SERVER STARTUP
// ============================================

const PORT = process.env.PORT || 3000;

httpServer.listen(PORT, async () => {
  console.log(`\n🚀 LiveLingo Streaming Server running on http://localhost:${PORT}`);
  console.log(`📊 Streaming pipeline: ${STREAM_ENABLED ? 'ENABLED' : 'DISABLED'}`);
  
  if (STREAM_ENABLED) {
    console.log(`\nConfiguration:`);
    console.log(`  • VAD silence timeout: ${VAD_SILENCE_DURATION_MS}ms`);
    console.log(`  • VAD max chunk: ${VAD_MAX_CHUNK_DURATION_MS}ms`);
    console.log(`  • STT concurrency: ${STT_CONCURRENCY}`);
    console.log(`  • Translation concurrency: ${TRANSLATION_CONCURRENCY}`);
    console.log(`  • TTS concurrency: ${TTS_CONCURRENCY}`);
    console.log(`  • Max queue size: ${MAX_QUEUE_SIZE}`);
    
    // Auto-start streaming if enabled
    if (String(process.env.AUTO_START_STREAM || 'false').toLowerCase() === 'true') {
      console.log(`\n⏰ Auto-starting stream in 2 seconds...`);
      setTimeout(async () => {
        try {
          await initializeStreamingPipeline();
          await startStreaming();
        } catch (err) {
          console.error(`❌ Auto-start failed: ${err.message}`);
        }
      }, 2000);
    }
  }

  console.log(`\n📚 Available endpoints:`);
  console.log(`  GET  http://localhost:${PORT}/           - Main dashboard`);
  console.log(`  GET  http://localhost:${PORT}/health     - Health check`);
  console.log(`  GET  http://localhost:${PORT}/pipeline/status - Pipeline details`);
  console.log(`  GET  http://localhost:${PORT}/metrics    - Latency metrics`);
  console.log(`  POST http://localhost:${PORT}/stream/start - Start streaming`);
  console.log(`  POST http://localhost:${PORT}/stream/stop  - Stop streaming\n`);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n🛑 SIGTERM received, shutting down gracefully...');
  await stopStreaming();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n🛑 SIGINT received, shutting down gracefully...');
  await stopStreaming();
  process.exit(0);
});

export { app, httpServer, sessionManager, latencyMonitor };
