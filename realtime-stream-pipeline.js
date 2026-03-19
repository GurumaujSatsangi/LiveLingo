import express from "express";
import { EventEmitter } from "events";

const PORT = Number(process.env.REALTIME_PIPELINE_PORT || 4010);
const STT_CONCURRENCY = Number(process.env.STT_CONCURRENCY || 2); // Keep low to avoid response disorder.
const TEXT_BATCH_SIZE = Number(process.env.TEXT_BATCH_SIZE || 3); // Buffer 2-3 chunks for better sentence flow.
const TEXT_BATCH_MAX_WAIT_MS = Number(process.env.TEXT_BATCH_MAX_WAIT_MS || 1200);
const JITTER_BUFFER_CHUNKS = Number(process.env.JITTER_BUFFER_CHUNKS || 2);
const MISSING_CHUNK_TIMEOUT_MS = Number(process.env.MISSING_CHUNK_TIMEOUT_MS || 2500);
const MIN_CHUNK_SEC = 0.9;
const MAX_CHUNK_SEC = 2.2;
const HINDI_OUTPUT_WEBHOOK_URL = process.env.HINDI_OUTPUT_WEBHOOK_URL || "http://localhost:3000/pipeline/output/hindi";
const PIPELINE_OUTPUT_SECRET = process.env.REALTIME_PIPELINE_OUTPUT_SECRET || "";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowIso() {
  return new Date().toISOString();
}

async function postTranslatedAudioToHindiIvs(event) {
  if (!HINDI_OUTPUT_WEBHOOK_URL) {
    return;
  }

  const headers = {
    "Content-Type": "application/json",
  };

  if (PIPELINE_OUTPUT_SECRET) {
    headers["x-pipeline-secret"] = PIPELINE_OUTPUT_SECRET;
  }

  const response = await fetch(HINDI_OUTPUT_WEBHOOK_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      seqId: event.seqId,
      startTime: event.startTime,
      endTime: event.endTime,
      text: event.text,
      sentence: event.sentence,
      audioBase64: event.audioBase64,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text();
    throw new Error(`Hindi IVS webhook failed (${response.status}): ${bodyText}`);
  }
}

function splitBufferIntoEqualParts(buffer, parts) {
  if (!Buffer.isBuffer(buffer) || parts <= 1) {
    return [buffer];
  }

  const size = Math.ceil(buffer.length / parts);
  const result = [];
  for (let i = 0; i < parts; i++) {
    const start = i * size;
    const end = Math.min(buffer.length, start + size);
    result.push(buffer.slice(start, end));
  }

  while (result.length < parts) {
    result.push(Buffer.alloc(0));
  }

  return result;
}

class AsyncQueue {
  constructor(concurrency = 1) {
    this.concurrency = Math.max(1, concurrency);
    this.running = 0;
    this.queue = [];
  }

  add(task) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.runNext();
    });
  }

  runNext() {
    if (this.running >= this.concurrency) {
      return;
    }

    const item = this.queue.shift();
    if (!item) {
      return;
    }

    this.running += 1;

    (async () => {
      try {
        const value = await item.task();
        item.resolve(value);
      } catch (err) {
        item.reject(err);
      } finally {
        this.running -= 1;
        this.runNext();
      }
    })();
  }

  getStats() {
    return {
      queued: this.queue.length,
      running: this.running,
      concurrency: this.concurrency,
    };
  }
}

async function withRetry(label, fn, maxRetries = 2, baseDelayMs = 200) {
  let attempt = 0;
  while (attempt <= maxRetries) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) {
        throw err;
      }
      const backoff = baseDelayMs * Math.pow(2, attempt);
      console.warn(`${nowIso()} [retry] ${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${err.message}`);
      await sleep(backoff);
      attempt += 1;
    }
  }

  throw new Error(`Unexpected retry loop exit for ${label}`);
}

// --------------------
// Mockable API layer
// Replace these with real Sarvam SDK calls in production.
// --------------------

async function sarvamSttTranslate(chunk) {
  // Simulate variable API latency.
  await sleep(120 + Math.floor(Math.random() * 350));

  // Simulate intermittent failures.
  if (Math.random() < 0.06) {
    throw new Error("STT temporary upstream failure");
  }

  const sampleWords = [
    "welcome",
    "to",
    "our",
    "live",
    "broadcast",
    "this",
    "is",
    "a",
    "real",
    "time",
    "translation",
    "demo",
  ];

  const tokenCount = 4 + (chunk.seqId % 4);
  const text = Array.from({ length: tokenCount }, (_, i) => sampleWords[(chunk.seqId + i) % sampleWords.length]).join(" ");

  // Treat this as the transcript from speech-to-text-translate endpoint.
  return {
    transcript: text,
    sourceLanguageCode: "auto",
    translatedText: text, // Endpoint could return translated text directly; mocked as English text here.
  };
}

async function translateText(text) {
  await sleep(40 + Math.floor(Math.random() * 100));
  if (Math.random() < 0.03) {
    throw new Error("Translation timeout");
  }
  return `[HI] ${text}`;
}

async function sarvamTts(text) {
  await sleep(180 + Math.floor(Math.random() * 280));
  if (Math.random() < 0.05) {
    throw new Error("TTS rate-limited");
  }

  // Mock audio bytes. Replace with real audio from Sarvam TTS.
  return Buffer.from(`AUDIO(${text})`, "utf8");
}

class RealtimePipeline extends EventEmitter {
  constructor() {
    super();

    this.sttQueue = new AsyncQueue(STT_CONCURRENCY);

    // Chunk ingress and STT output state.
    this.receivedChunkMeta = new Map();
    this.sttResultsBySeq = new Map();
    this.sttReadyAtBySeq = new Map();

    // TTS output state.
    this.outputAudioBySeq = new Map();
    this.outputMetaBySeq = new Map();

    // Ordering trackers.
    this.nextBatchSeqId = 1;
    this.nextExpectedSeqId = 1;

    this.highestReceivedSeqId = 0;
    this.highestOutputSeqId = 0;

    // Missing/gap handling.
    this.missingBatchSeqSince = null;
    this.missingOutputSeqSince = null;
    this.skippedSeqIds = new Set();

    // Background housekeeping.
    this.ticker = null;
  }

  start() {
    if (this.ticker) {
      return;
    }

    this.ticker = setInterval(() => {
      this.handleMissingChunkForBatch();
      this.handleMissingChunkForOutput();
      this.tryBuildTtsBatches();
      this.tryEmitOrderedAudio(false);
    }, 200);
  }

  stop() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  validateChunk(chunk) {
    if (!chunk || typeof chunk !== "object") {
      throw new Error("Chunk payload must be an object");
    }

    if (!Number.isInteger(chunk.seqId) || chunk.seqId <= 0) {
      throw new Error("seqId must be a positive integer");
    }

    if (typeof chunk.startTime !== "number" || typeof chunk.endTime !== "number") {
      throw new Error("startTime and endTime must be numbers");
    }

    if (chunk.endTime <= chunk.startTime) {
      throw new Error("endTime must be greater than startTime");
    }

    const durationSec = chunk.endTime - chunk.startTime;
    if (durationSec < MIN_CHUNK_SEC || durationSec > MAX_CHUNK_SEC) {
      console.warn(
        `${nowIso()} [chunk-warning] seq=${chunk.seqId} duration=${durationSec.toFixed(2)}s outside recommended ${MIN_CHUNK_SEC}-${MAX_CHUNK_SEC}s`
      );
    }

    if (!Buffer.isBuffer(chunk.pcmData) || chunk.pcmData.length === 0) {
      throw new Error("pcmData must be a non-empty Buffer");
    }
  }

  acceptChunk(chunk) {
    this.validateChunk(chunk);

    if (this.receivedChunkMeta.has(chunk.seqId) || this.sttResultsBySeq.has(chunk.seqId)) {
      console.warn(`${nowIso()} [duplicate] seq=${chunk.seqId} ignored`);
      return;
    }

    this.highestReceivedSeqId = Math.max(this.highestReceivedSeqId, chunk.seqId);
    this.receivedChunkMeta.set(chunk.seqId, {
      seqId: chunk.seqId,
      startTime: chunk.startTime,
      endTime: chunk.endTime,
      receivedAt: Date.now(),
    });

    this.emit("ingest", { seqId: chunk.seqId, startTime: chunk.startTime, endTime: chunk.endTime });

    this.sttQueue
      .add(() => this.processChunk(chunk))
      .catch((err) => {
        console.error(`${nowIso()} [process-error] seq=${chunk.seqId} ${err.message}`);
      });
  }

  async processChunk(chunk) {
    try {
      const stt = await withRetry(`stt(seq=${chunk.seqId})`, () => sarvamSttTranslate(chunk), 2, 180);

      this.sttResultsBySeq.set(chunk.seqId, {
        seqId: chunk.seqId,
        transcript: stt.transcript || "",
        translatedText: stt.translatedText || stt.transcript || "",
        sourceLanguageCode: stt.sourceLanguageCode || "auto",
      });
      this.sttReadyAtBySeq.set(chunk.seqId, Date.now());

      this.emit("stt", {
        seqId: chunk.seqId,
        transcript: stt.transcript || "",
      });

      this.tryBuildTtsBatches();
    } catch (err) {
      console.error(`${nowIso()} [chunk-failed] seq=${chunk.seqId} ${err.message}`);
      this.markSeqSkipped(chunk.seqId, "stt_failed");
    }
  }

  getContiguousSttSeqsFrom(startSeqId) {
    const seqs = [];
    let seq = startSeqId;

    while (this.sttResultsBySeq.has(seq)) {
      seqs.push(seq);
      seq += 1;
    }

    return seqs;
  }

  canFlushSmallBatch(availableSeqs) {
    if (availableSeqs.length === 0) {
      return false;
    }

    const firstSeq = availableSeqs[0];
    const firstReadyAt = this.sttReadyAtBySeq.get(firstSeq) || Date.now();
    return Date.now() - firstReadyAt >= TEXT_BATCH_MAX_WAIT_MS;
  }

  async tryBuildTtsBatches() {
    // Build as many ordered batches as possible.
    while (true) {
      const availableSeqs = this.getContiguousSttSeqsFrom(this.nextBatchSeqId);
      if (availableSeqs.length === 0) {
        return;
      }

      if (availableSeqs.length < TEXT_BATCH_SIZE && !this.canFlushSmallBatch(availableSeqs)) {
        return;
      }

      const batchSeqs = availableSeqs.slice(0, Math.min(TEXT_BATCH_SIZE, availableSeqs.length));
      const parts = batchSeqs.map((seqId) => this.sttResultsBySeq.get(seqId)?.translatedText || "").filter(Boolean);

      if (parts.length === 0) {
        for (const seqId of batchSeqs) {
          this.markSeqSkipped(seqId, "empty_transcript");
        }
        continue;
      }

      const combinedSentence = parts.join(" ").replace(/\s+/g, " ").trim();
      const batchStartSeq = batchSeqs[0];
      const batchEndSeq = batchSeqs[batchSeqs.length - 1];

      try {
        const translated = await withRetry(
          `translate(batch=${batchStartSeq}-${batchEndSeq})`,
          () => translateText(combinedSentence),
          2,
          120
        );

        const ttsAudio = await withRetry(
          `tts(batch=${batchStartSeq}-${batchEndSeq})`,
          () => sarvamTts(translated),
          2,
          200
        );

        const audioParts = splitBufferIntoEqualParts(ttsAudio, batchSeqs.length);

        for (let i = 0; i < batchSeqs.length; i++) {
          const seqId = batchSeqs[i];
          const meta = this.receivedChunkMeta.get(seqId);
          this.outputAudioBySeq.set(seqId, audioParts[i] || Buffer.alloc(0));
          this.outputMetaBySeq.set(seqId, {
            seqId,
            text: this.sttResultsBySeq.get(seqId)?.translatedText || "",
            sentence: translated,
            startTime: meta?.startTime,
            endTime: meta?.endTime,
            batchStartSeq,
            batchEndSeq,
          });
          this.highestOutputSeqId = Math.max(this.highestOutputSeqId, seqId);

          this.sttResultsBySeq.delete(seqId);
          this.sttReadyAtBySeq.delete(seqId);
        }

        this.nextBatchSeqId = batchEndSeq + 1;

        this.emit("batch", {
          batchStartSeq,
          batchEndSeq,
          sentence: translated,
        });
      } catch (err) {
        console.error(`${nowIso()} [batch-failed] ${batchStartSeq}-${batchEndSeq} ${err.message}`);
        for (const seqId of batchSeqs) {
          this.markSeqSkipped(seqId, "batch_failed");
        }
      }
    }
  }

  markSeqSkipped(seqId, reason) {
    this.skippedSeqIds.add(seqId);

    if (this.nextBatchSeqId === seqId) {
      this.nextBatchSeqId += 1;
    }

    if (this.nextExpectedSeqId === seqId) {
      this.nextExpectedSeqId += 1;
    }

    this.sttResultsBySeq.delete(seqId);
    this.sttReadyAtBySeq.delete(seqId);
    this.outputAudioBySeq.delete(seqId);
    this.outputMetaBySeq.delete(seqId);

    this.emit("skip", { seqId, reason });
    console.warn(`${nowIso()} [skip] seq=${seqId} reason=${reason}`);
  }

  handleMissingChunkForBatch() {
    const expected = this.nextBatchSeqId;

    if (this.sttResultsBySeq.has(expected) || this.skippedSeqIds.has(expected)) {
      this.missingBatchSeqSince = null;
      return;
    }

    // Only treat as missing if we have seen later chunks.
    if (this.highestReceivedSeqId < expected + 1) {
      this.missingBatchSeqSince = null;
      return;
    }

    if (!this.missingBatchSeqSince) {
      this.missingBatchSeqSince = Date.now();
      return;
    }

    if (Date.now() - this.missingBatchSeqSince > MISSING_CHUNK_TIMEOUT_MS) {
      this.markSeqSkipped(expected, "missing_before_batch");
      this.missingBatchSeqSince = null;
    }
  }

  handleMissingChunkForOutput() {
    const expected = this.nextExpectedSeqId;

    if (this.outputAudioBySeq.has(expected) || this.skippedSeqIds.has(expected)) {
      this.missingOutputSeqSince = null;
      return;
    }

    if (this.highestOutputSeqId < expected + 1) {
      this.missingOutputSeqSince = null;
      return;
    }

    if (!this.missingOutputSeqSince) {
      this.missingOutputSeqSince = Date.now();
      return;
    }

    if (Date.now() - this.missingOutputSeqSince > MISSING_CHUNK_TIMEOUT_MS) {
      this.markSeqSkipped(expected, "missing_before_output");
      this.missingOutputSeqSince = null;
    }
  }

  getContiguousReadyOutputCount() {
    let count = 0;
    let seq = this.nextExpectedSeqId;

    while (this.outputAudioBySeq.has(seq) || this.skippedSeqIds.has(seq)) {
      count += 1;
      seq += 1;
    }

    return count;
  }

  tryEmitOrderedAudio(forceFlush) {
    while (true) {
      const seqId = this.nextExpectedSeqId;

      if (this.skippedSeqIds.has(seqId)) {
        this.nextExpectedSeqId += 1;
        continue;
      }

      if (!this.outputAudioBySeq.has(seqId)) {
        return;
      }

      const contiguousReady = this.getContiguousReadyOutputCount();
      if (!forceFlush && contiguousReady <= JITTER_BUFFER_CHUNKS) {
        // Wait for a small jitter window to smooth playout order.
        return;
      }

      const audio = this.outputAudioBySeq.get(seqId);
      const meta = this.outputMetaBySeq.get(seqId);

      this.outputAudioBySeq.delete(seqId);
      this.outputMetaBySeq.delete(seqId);
      this.nextExpectedSeqId += 1;

      this.emit("audio", {
        seqId,
        startTime: meta?.startTime,
        endTime: meta?.endTime,
        text: meta?.text,
        sentence: meta?.sentence,
        audioBase64: audio.toString("base64"),
        audioBytes: audio?.length || 0,
      });
    }
  }

  flushAllAvailable() {
    this.tryBuildTtsBatches().finally(() => {
      this.tryEmitOrderedAudio(true);
    });
  }

  getStats() {
    return {
      nextBatchSeqId: this.nextBatchSeqId,
      nextExpectedSeqId: this.nextExpectedSeqId,
      highestReceivedSeqId: this.highestReceivedSeqId,
      highestOutputSeqId: this.highestOutputSeqId,
      sttQueue: this.sttQueue.getStats(),
      sttResultsBuffered: this.sttResultsBySeq.size,
      outputBuffered: this.outputAudioBySeq.size,
      skippedCount: this.skippedSeqIds.size,
    };
  }
}

const pipeline = new RealtimePipeline();
pipeline.start();

pipeline.on("ingest", (event) => {
  console.log(`${nowIso()} [ingest] seq=${event.seqId} ${event.startTime.toFixed(2)}-${event.endTime.toFixed(2)}s`);
});

pipeline.on("stt", (event) => {
  console.log(`${nowIso()} [stt] seq=${event.seqId} text=\"${event.transcript}\"`);
});

pipeline.on("batch", (event) => {
  console.log(`${nowIso()} [batch] ${event.batchStartSeq}-${event.batchEndSeq} sentence=\"${event.sentence}\"`);
});

pipeline.on("audio", (event) => {
  console.log(
    `${nowIso()} [output] seq=${event.seqId} bytes=${event.audioBytes} window=${event.startTime?.toFixed(2)}-${event.endTime?.toFixed(2)} text=\"${event.text}\"`
  );

  postTranslatedAudioToHindiIvs(event).catch((err) => {
    console.error(`${nowIso()} [output-webhook-error] seq=${event.seqId} ${err.message}`);
  });
});

// --------------------
// Express API
// --------------------

const app = express();
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    stats: pipeline.getStats(),
  });
});

app.post("/chunk", (req, res) => {
  try {
    const { seqId, startTime, endTime, pcmBase64 } = req.body || {};

    if (typeof pcmBase64 !== "string" || pcmBase64.length === 0) {
      return res.status(400).json({ error: "pcmBase64 is required" });
    }

    const chunk = {
      seqId: Number(seqId),
      startTime: Number(startTime),
      endTime: Number(endTime),
      pcmData: Buffer.from(pcmBase64, "base64"),
    };

    pipeline.acceptChunk(chunk);
    return res.json({ accepted: true, seqId: chunk.seqId });
  } catch (err) {
    return res.status(400).json({ accepted: false, error: err.message });
  }
});

app.post("/flush", async (_req, res) => {
  pipeline.flushAllAvailable();
  res.json({ ok: true });
});

// --------------------
// Sample out-of-order input simulation
// --------------------

function createSimulatedChunk(seqId, durationSec, startTime) {
  const samples = Math.floor(16000 * durationSec);
  const pcmData = Buffer.alloc(samples * 2, seqId % 255);

  return {
    seqId,
    startTime,
    endTime: startTime + durationSec,
    pcmData,
  };
}

async function runSimulation() {
  const chunks = [];
  let timeCursor = 0;

  for (let seqId = 1; seqId <= 18; seqId++) {
    const duration = 1 + ((seqId % 3) * 0.25);
    chunks.push(createSimulatedChunk(seqId, duration, timeCursor));
    timeCursor += duration;
  }

  // Simulate missing and corrupted chunks.
  const filtered = chunks.filter((c) => c.seqId !== 7);
  filtered.push({ ...createSimulatedChunk(12, 1.2, 12.5), pcmData: Buffer.alloc(0) });

  // Shuffle to emulate out-of-order arrival.
  const shuffled = [...filtered].sort(() => Math.random() - 0.5);

  for (const chunk of shuffled) {
    await sleep(40 + Math.floor(Math.random() * 180));

    try {
      pipeline.acceptChunk(chunk);
    } catch (err) {
      console.warn(`${nowIso()} [simulate] dropped seq=${chunk.seqId} reason=${err.message}`);
    }
  }

  // Force flush after simulation ingress finishes.
  await sleep(2000);
  pipeline.flushAllAvailable();
}

app.post("/simulate", async (_req, res) => {
  runSimulation().catch((err) => {
    console.error(`${nowIso()} [simulate-error] ${err.message}`);
  });

  res.json({ started: true });
});

app.listen(PORT, () => {
  console.log(`${nowIso()} Realtime pipeline server listening on http://localhost:${PORT}`);
  console.log(`${nowIso()} Endpoints: GET /health, POST /chunk, POST /flush, POST /simulate`);
  console.log(`${nowIso()} Queue concurrency=${STT_CONCURRENCY}, textBatch=${TEXT_BATCH_SIZE}, jitterBuffer=${JITTER_BUFFER_CHUNKS}`);
});
