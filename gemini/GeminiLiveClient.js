import { EventEmitter } from "events";
import WebSocket from "ws";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

/**
 * Thin WebSocket transport for Gemini Live API.
 * Maintains one persistent connection with queued sends and auto-reconnect.
 */
class GeminiLiveClient extends EventEmitter {
  constructor(options = {}) {
    super();

    this.apiKey = options.apiKey || process.env.GEMINI_API_KEY || "";
    this.model = options.model || process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview";
    this.languageName = options.languageName || "Hindi";
    this.responseModalities = options.responseModalities || ["AUDIO"];
    this.audioMimeType = options.audioMimeType || "audio/pcm;rate=16000";
    this.maxBufferedBytes = Number(options.maxBufferedBytes || process.env.GEMINI_MAX_WS_BUFFER_BYTES || 2_000_000);
    this.maxPendingMessages = Number(options.maxPendingMessages || process.env.GEMINI_MAX_PENDING_MESSAGES || 2000);
    this.maxReconnectAttempts = Number(options.maxReconnectAttempts || process.env.GEMINI_MAX_RECONNECT_ATTEMPTS || 30);
    this.reconnectBaseDelayMs = Number(options.reconnectBaseDelayMs || process.env.GEMINI_RECONNECT_BASE_DELAY_MS || 500);
    this.reconnectMaxDelayMs = Number(options.reconnectMaxDelayMs || process.env.GEMINI_RECONNECT_MAX_DELAY_MS || 8000);
    this.stableConnectionMs = Number(options.stableConnectionMs || process.env.GEMINI_STABLE_CONNECTION_MS || 8000);

    this.ws = null;
    this.connected = false;
    this.closing = false;
    this.sentSetup = false;
    this.pendingMessages = [];
    this.reconnectAttempt = 0;
    this.stableConnectionTimer = null;
    this.disableReconnect = false;
    this.connectionId = 0;
    this.lastQueueOverflowWarnAt = 0;

    this.totalAudioInBytes = 0;
    this.totalAudioOutBytes = 0;
    this.totalMessagesIn = 0;
    this.totalMessagesOut = 0;
    this.totalTurnComplete = 0;
  }

  buildSystemInstruction() {
    return `Translate all incoming speech into ${this.languageName}. Output only natural spoken ${this.languageName} audio, preserving speaker intent and tone.`;
  }

  buildUrl() {
    return `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(this.apiKey)}`;
  }

  buildSetupMessage() {
    return {
      setup: {
        model: `models/${this.model}`,
        generationConfig: {
          responseModalities: this.responseModalities,
        },
        systemInstruction: {
          parts: [{ text: this.buildSystemInstruction() }],
        },
      },
    };
  }

  async connect() {
    if (!this.apiKey) {
      throw new Error("GEMINI_API_KEY is required");
    }

    if (this.connected && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.CONNECTING) {
      return;
    }

    this.closing = false;

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(this.buildUrl());
      this.ws = ws;

      let settled = false;

      ws.on("open", async () => {
        this.connected = true;
        const currentConnectionId = ++this.connectionId;
        this.emit("connected");

        if (this.stableConnectionTimer) {
          clearTimeout(this.stableConnectionTimer);
        }

        // Reset reconnect backoff only after a stable connected period.
        this.stableConnectionTimer = setTimeout(() => {
          if (this.connected && currentConnectionId === this.connectionId) {
            this.reconnectAttempt = 0;
          }
        }, this.stableConnectionMs);

        try {
          await this.sendJson(this.buildSetupMessage(), true);
          if (!settled) {
            settled = true;
            resolve();
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            reject(err);
          }
        }
      });

      ws.on("message", (raw) => this.handleMessage(raw));

      ws.on("error", (err) => {
        this.emit("error", err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      ws.on("close", (code, reason) => {
        this.connected = false;
        this.sentSetup = false;
        if (this.stableConnectionTimer) {
          clearTimeout(this.stableConnectionTimer);
          this.stableConnectionTimer = null;
        }

        const closeReason = String(reason || "");
        this.emit("disconnected", { code, reason: closeReason });
        this.emit("warning", `Gemini socket closed code=${code} reason=${closeReason || "<empty>"}`);

        const permanentReason =
          closeReason.includes("Invalid JSON payload") ||
          closeReason.includes("is not found for API version") ||
          closeReason.includes("not supported for bidiGenerateContent") ||
          closeReason.includes("API key not valid") ||
          closeReason.includes("permission denied") ||
          closeReason.includes("PERMISSION_DENIED");

        if (permanentReason) {
          this.disableReconnect = true;
          this.emit("fatal", new Error(`Gemini permanent close reason: ${closeReason}`));
        }

        if (!settled) {
          settled = true;
          reject(new Error(`Gemini socket closed during connect (${code})`));
        }

        if (!this.closing && !this.disableReconnect) {
          this.scheduleReconnect().catch((err) => {
            this.emit("error", err);
          });
        }
      });
    });
  }

  async scheduleReconnect() {
    if (this.closing) {
      return;
    }

    if (this.disableReconnect) {
      return;
    }

    if (this.reconnectAttempt >= this.maxReconnectAttempts) {
      this.emit("fatal", new Error(`Gemini reconnect attempts exceeded (${this.maxReconnectAttempts})`));
      return;
    }

    const jitter = Math.floor(Math.random() * 120);
    const delay = Math.min(
      this.reconnectMaxDelayMs,
      this.reconnectBaseDelayMs * Math.pow(2, this.reconnectAttempt)
    ) + jitter;

    this.reconnectAttempt += 1;
    this.emit("reconnecting", { attempt: this.reconnectAttempt, delay });

    await sleep(delay);
    await this.connect();
  }

  handleMessage(raw) {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    const message = safeJsonParse(text);

    if (!message) {
      return;
    }

    this.totalMessagesIn += 1;

    if (message.setupComplete) {
      this.sentSetup = true;
      this.flushPendingMessages().catch((err) => {
        this.emit("error", err);
      });
      this.emit("warning", "Gemini setup complete");
      return;
    }

    if (message.error) {
      const code = Number(message.error.code || 0);
      const status = message.error.status || "UNKNOWN";
      const details = message.error.message || JSON.stringify(message.error);
      this.emit("error", new Error(`Gemini API error code=${code} status=${status} message=${details}`));

      // Permanent request/auth errors should not reconnect forever.
      if (code === 400 || code === 401 || code === 403 || code === 404) {
        this.disableReconnect = true;
        this.emit("fatal", new Error(`Gemini permanent error (${code}/${status}). Reconnect disabled until process restart.`));

        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          try {
            this.ws.close();
          } catch (err) {
            // ignore close failure
          }
        }
      }
      return;
    }

    const serverContent = message.serverContent;

    if (serverContent?.inputTranscription?.text) {
      this.emit("input-transcript", serverContent.inputTranscription.text);
    }

    if (serverContent?.outputTranscription?.text) {
      this.emit("output-transcript", serverContent.outputTranscription.text);
    }

    if (serverContent?.turnComplete === true) {
      this.totalTurnComplete += 1;
      this.emit("turn-complete", { receivedAt: Date.now() });
    }

    const parts = serverContent?.modelTurn?.parts || [];
    for (const part of parts) {
      const inlineData = part?.inlineData;
      if (!inlineData?.data) {
        continue;
      }

      const mimeType = inlineData.mimeType || "";
      const audioBuffer = Buffer.from(inlineData.data, "base64");

      this.totalAudioOutBytes += audioBuffer.length;
      this.emit("audio", {
        mimeType,
        audioBuffer,
        receivedAt: Date.now(),
      });
    }

    if (message.goAway?.timeLeft) {
      this.emit("warning", `Gemini session goAway: ${JSON.stringify(message.goAway)}`);
    }
  }

  canSendImmediately() {
    return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN && this.sentSetup;
  }

  async sendJson(payload, allowDuringSetup = false) {
    const serialized = JSON.stringify(payload);

    if (!allowDuringSetup && !this.canSendImmediately()) {
      this.queueSerializedMessage(serialized);
      return false;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      this.queueSerializedMessage(serialized);
      return false;
    }

    if (this.ws.bufferedAmount > this.maxBufferedBytes) {
      this.queueSerializedMessage(serialized);
      return false;
    }

    await new Promise((resolve, reject) => {
      this.ws.send(serialized, (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.totalMessagesOut += 1;
    return true;
  }

  queueSerializedMessage(serialized) {
    if (this.pendingMessages.length >= this.maxPendingMessages) {
      this.pendingMessages.shift();
      const now = Date.now();
      if (now - this.lastQueueOverflowWarnAt > 1500) {
        this.lastQueueOverflowWarnAt = now;
        this.emit("warning", `Gemini send queue full (${this.maxPendingMessages}), dropped oldest message`);
      }
    }

    this.pendingMessages.push(serialized);
  }

  async flushPendingMessages() {
    while (this.pendingMessages.length > 0 && this.canSendImmediately()) {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        return;
      }

      if (this.ws.bufferedAmount > this.maxBufferedBytes) {
        return;
      }

      const serialized = this.pendingMessages.shift();
      await new Promise((resolve, reject) => {
        this.ws.send(serialized, (err) => {
          if (err) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      this.totalMessagesOut += 1;
    }
  }

  async sendPcmChunk(pcmBuffer) {
    if (!Buffer.isBuffer(pcmBuffer) || pcmBuffer.length === 0) {
      return false;
    }

    // For realtime audio we prefer dropping over queueing to preserve low latency.
    if (!this.canSendImmediately()) {
      return false;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (this.ws.bufferedAmount > this.maxBufferedBytes) {
      return false;
    }

    this.totalAudioInBytes += pcmBuffer.length;

    await this.sendJson({
      realtimeInput: {
        audio: {
          data: pcmBuffer.toString("base64"),
          mimeType: this.audioMimeType,
        },
      },
    }, true);

    return true;
  }

  async sendAudioStreamEnd() {
    if (!this.canSendImmediately()) {
      return false;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }

    if (this.ws.bufferedAmount > this.maxBufferedBytes) {
      return false;
    }

    await this.sendJson(
      {
        realtimeInput: {
          audioStreamEnd: true,
        },
      },
      true
    );

    return true;
  }

  getStats() {
    return {
      connected: this.connected,
      reconnectAttempt: this.reconnectAttempt,
      pendingMessages: this.pendingMessages.length,
      bufferedAmount: this.ws?.bufferedAmount || 0,
      totalAudioInBytes: this.totalAudioInBytes,
      totalAudioOutBytes: this.totalAudioOutBytes,
      totalMessagesIn: this.totalMessagesIn,
      totalMessagesOut: this.totalMessagesOut,
      totalTurnComplete: this.totalTurnComplete,
    };
  }

  async close() {
    this.closing = true;
    this.disableReconnect = true;

    if (this.stableConnectionTimer) {
      clearTimeout(this.stableConnectionTimer);
      this.stableConnectionTimer = null;
    }

    if (!this.ws) {
      return;
    }

    await new Promise((resolve) => {
      try {
        this.ws.once("close", () => resolve());
        this.ws.close();
        setTimeout(resolve, 1000);
      } catch (err) {
        resolve();
      }
    });

    this.connected = false;
    this.sentSetup = false;
  }
}

export default GeminiLiveClient;
