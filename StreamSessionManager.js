/**
 * Stream Session Manager
 * Manages livestream sessions with timestamp-based sync for low-latency playback
 */
class StreamSessionManager {
  constructor() {
    this.sessions = new Map(); // Map of sessionId -> sessionData
    this.activeSession = null; // Current active session ID
    this.sessionTimeout = 5 * 60 * 1000; // 5 minutes inactivity timeout
  }

  /**
   * Create or retrieve active session
   */
  getOrCreateSession(sessionId = null) {
    // If no sessionId provided, use current timestamp to create one
    const id = sessionId || `session_${Date.now()}`;

    if (this.sessions.has(id)) {
      const session = this.sessions.get(id);
      // Update last activity
      session.lastActivityTime = Date.now();
      return session;
    }

    // Create new session with timestamp-based tracking
    const newSession = {
      sessionId: id,
      createdTime: Date.now(),
      startTimestamp: Date.now(), // Real-time timestamp for sync
      lastActivityTime: Date.now(),
      chunkCount: 0,
      
      // Timestamp tracking for low-latency sync (no static delay)
      timestampTracking: {
        firstAudioFrameTime: null,
        lastProcessedFrameTime: null,
        videoPlayheadTime: null,
        audioLatencyMs: 0,
      },
      
      languages: {
        source: null, // Detected source language
        hindi: { 
          streamActive: false, 
          chunksSent: 0,
          firstFrameTime: null,
          lastFrameTime: null,
        },
        bangla: { 
          streamActive: false, 
          chunksSent: 0,
          firstFrameTime: null,
          lastFrameTime: null,
        },
        tamil: { 
          streamActive: false, 
          chunksSent: 0,
          firstFrameTime: null,
          lastFrameTime: null,
        },
      },
      activeStreams: {
        hindi: false,
        bangla: false,
        tamil: false,
      },
      
      // Latency statistics
      latencyStats: {
        captureToVadMs: [],
        vadToQueueMs: [],
        queueToSttMs: [],
        sttLatencyMs: [],
        translationLatencyMs: [],
        ttsLatencyMs: [],
        endToEndLatencyMs: [],
      },
    };

    this.sessions.set(id, newSession);
    this.activeSession = id;

    console.log(`📌 New session created: ${id}`);
    return newSession;
  }

  /**
   * Get current active session
   */
  getCurrentSession() {
    if (!this.activeSession || !this.sessions.has(this.activeSession)) {
      return this.getOrCreateSession();
    }
    const session = this.sessions.get(this.activeSession);
    session.lastActivityTime = Date.now();
    return session;
  }

  /**
   * Mark stream as active for a language
   */
  markStreamActive(sessionId, language) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.activeStreams[language] = true;
      session.languages[language].streamActive = true;
      console.log(`🟢 Stream marked active for ${language} in session ${sessionId}`);
    }
  }

  /**
   * Mark stream as inactive for a language
   */
  markStreamInactive(sessionId, language) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.activeStreams[language] = false;
      console.log(`🔴 Stream marked inactive for ${language} in session ${sessionId}`);
    }
  }

  /**
   * Check if a stream is active for a language in current session
   */
  isStreamActive(language) {
    const session = this.getCurrentSession();
    return session.activeStreams[language] || false;
  }

  /**
   * Update detected source language for session
   */
  setSourceLanguage(sessionId, languageCode) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.languages.source = languageCode;
      console.log(`🌐 Source language detected: ${languageCode} for session ${sessionId}`);
    }
  }

  /**
   * Increment chunk count for a language
   */
  incrementChunkCount(sessionId, language) {
    const session = this.sessions.get(sessionId);
    if (session) {
      if (language === "source") {
        session.chunkCount++;
      } else {
        session.languages[language].chunksSent++;
      }
    }
  }

  /**
   * Clean up expired sessions
   */
  cleanupExpiredSessions() {
    const now = Date.now();
    const expiredSessions = [];

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivityTime > this.sessionTimeout) {
        expiredSessions.push(sessionId);
      }
    }

    for (const sessionId of expiredSessions) {
      const session = this.sessions.get(sessionId);
      console.log(
        `🗑️  Cleaning up expired session: ${sessionId} (inactive for ${(now - session.lastActivityTime) / 1000}s)`
      );
      this.sessions.delete(sessionId);

      if (this.activeSession === sessionId) {
        // If active session expired, clear it
        this.activeSession = null;
      }
    }
  }

  /**
   * Get session statistics
   */
  getSessionStats(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      sessionId,
      uptime: Date.now() - session.createdTime,
      lastActivity: Date.now() - session.lastActivityTime,
      totalChunks: session.chunkCount,
      sourceLanguage: session.languages.source,
      languageStats: {
        hindi: session.languages.hindi,
        bangla: session.languages.bangla,
        tamil: session.languages.tamil,
      },
      activeStreams: session.activeStreams,
    };
  }

  /**
   * Get all active sessions
   */
  getAllSessions() {
    const sessions = [];
    for (const [sessionId, session] of this.sessions.entries()) {
      sessions.push(this.getSessionStats(sessionId));
    }
    return sessions;
  }

  /**
   * End a session
   */
  endSession(sessionId) {
    if (this.sessions.has(sessionId)) {
      const session = this.sessions.get(sessionId);
      console.log(`✅ Session ended: ${sessionId} (Total chunks: ${session.chunkCount})`);
      this.sessions.delete(sessionId);

      if (this.activeSession === sessionId) {
        this.activeSession = null;
      }
    }
  }

  /**
   * TIMESTAMP TRACKING: Record first audio frame time for sync
   */
  recordFirstAudioFrame(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && !session.timestampTracking.firstAudioFrameTime) {
      session.timestampTracking.firstAudioFrameTime = Date.now();
      console.log(`⏱️  First audio frame recorded for session ${sessionId}`);
    }
  }

  /**
   * TIMESTAMP TRACKING: Record language-specific frame times
   */
  recordLanguageFrame(sessionId, language, timestamp = Date.now()) {
    const session = this.sessions.get(sessionId);
    if (session && session.languages[language]) {
      const langData = session.languages[language];
      
      if (!langData.firstFrameTime) {
        langData.firstFrameTime = timestamp;
      }
      langData.lastFrameTime = timestamp;
      
      // Update last processed frame
      session.timestampTracking.lastProcessedFrameTime = timestamp;
    }
  }

  /**
   * TIMESTAMP TRACKING: Get current audio latency (time behind playhead)
   */
  getAudioLatencyMs(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.timestampTracking.lastProcessedFrameTime) {
      return 0;
    }

    // Latency = current time - last processed frame time
    const latency = Date.now() - session.timestampTracking.lastProcessedFrameTime;
    session.timestampTracking.audioLatencyMs = latency;
    return latency;
  }

  /**
   * LATENCY STATS: Record per-stage latency for a chunk
   */
  recordLatencyMetric(sessionId, stage, latencyMs) {
    const session = this.sessions.get(sessionId);
    if (session && session.latencyStats[stage]) {
      session.latencyStats[stage].push(latencyMs);
      
      // Keep only last 100 samples per stage
      if (session.latencyStats[stage].length > 100) {
        session.latencyStats[stage].shift();
      }
    }
  }

  /**
   * LATENCY STATS: Calculate statistics for a latency metric
   */
  calculateLatencyStats(values) {
    if (values.length === 0) {
      return null;
    }

    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const avg = sum / sorted.length;
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];

    return { avg, min, max, p50, p95, p99, count: sorted.length };
  }

  /**
   * LATENCY STATS: Get comprehensive latency report for session
   */
  getLatencyReport(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const report = {};
    
    for (const [stage, values] of Object.entries(session.latencyStats)) {
      report[stage] = this.calculateLatencyStats(values);
    }

    return {
      sessionId,
      timestamp: Date.now(),
      audioLatencyMs: session.timestampTracking.audioLatencyMs,
      metrics: report,
    };
  }

  /**
   * TIMESTAMP TRACKING: Reset session timestamps (for stream restart)
   */
  resetTimestamps(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.timestampTracking.firstAudioFrameTime = null;
      session.timestampTracking.lastProcessedFrameTime = null;
      session.timestampTracking.audioLatencyMs = 0;
      console.log(`🔄 Timestamps reset for session ${sessionId}`);
    }
  }

  /**
   * End all sessions
   */
  endAllSessions() {
    console.log(`⏹️  Ending ${this.sessions.size} sessions`);
    this.sessions.clear();
    this.activeSession = null;
  }
}

export default StreamSessionManager;
