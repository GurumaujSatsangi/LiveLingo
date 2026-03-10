/**
 * Stream Session Manager
 * Manages livestream sessions to prevent creating multiple streams for the same session
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

    // Create new session
    const newSession = {
      sessionId: id,
      createdTime: Date.now(),
      lastActivityTime: Date.now(),
      chunkCount: 0,
      languages: {
        source: null, // Detected source language
        hindi: { streamActive: false, chunksSent: 0 },
        bangla: { streamActive: false, chunksSent: 0 },
        tamil: { streamActive: false, chunksSent: 0 },
      },
      activeStreams: {
        hindi: false,
        bangla: false,
        tamil: false,
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
   * End all sessions
   */
  endAllSessions() {
    console.log(`⏹️  Ending ${this.sessions.size} sessions`);
    this.sessions.clear();
    this.activeSession = null;
  }
}

export default StreamSessionManager;
