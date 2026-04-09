import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import dotenv from 'dotenv';
import { SarvamAIClient } from 'sarvamai';
import WebSocket from 'ws';
import ffmpegPath from 'ffmpeg-static';
import pkg from 'wavefile';
import XLSX from 'xlsx';
const { WaveFile } = pkg;

dotenv.config({ path: '.env.test' });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const INPUT_AUDIO_DIR = process.env.INPUT_AUDIO_DIR || './test_audio';
const RESULTS_DIR = process.env.RESULTS_DIR || './benchmark_results';
const BENCHMARK_CHUNK_MS = Math.max(500, Number(process.env.BENCHMARK_CHUNK_MS || 1200));
const SARVAM_PARALLEL_REQUESTS = Math.max(1, Number(process.env.SARVAM_PARALLEL_REQUESTS || 2));
const sarvamClient = SARVAM_API_KEY && SARVAM_API_KEY !== 'your_sarvam_api_key_here'
    ? new SarvamAIClient({ apiSubscriptionKey: SARVAM_API_KEY })
    : null;

if (!fs.existsSync(RESULTS_DIR)) {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
}
if (!fs.existsSync(INPUT_AUDIO_DIR)) {
    fs.mkdirSync(INPUT_AUDIO_DIR, { recursive: true });
}

// ------------------------------------------------------------------
// Global Configuration & State
// ------------------------------------------------------------------
let sarvamContextHistory = []; // Keeps the last 2 transcribed sentences
const HOST = "generativelanguage.googleapis.com";
const WS_URL = `wss://${HOST}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
let geminiWs = null;

// Track the promise for Gemini response parsing
let geminiResponseResolver = null;
let t1_first_byte = null;
let currentGeminiPcmChunks = [];

// ------------------------------------------------------------------
// Real-time Display Table formatter
// ------------------------------------------------------------------
function printTableHeader() {
    console.log(`\n| Segment | Path 1 TTFB (ms) | Path 2 TTFB (ms) | Diff (ms) | Speedup |`);
    console.log(`|---------|------------------|------------------|-----------|---------|`);
}

function printTableRow(segmentId, p1Ms, p2Ms) {
    const diff = p2Ms - p1Ms;
    const speedup = p1Ms > 0 ? (p2Ms / p1Ms).toFixed(2) : 'N/A';
    console.log(`| ${String(segmentId).padEnd(7)} | ${String(p1Ms).padEnd(16)} | ${String(p2Ms).padEnd(16)} | ${String(diff).padEnd(9)} | ${String(speedup + 'x').padEnd(7)} |`);
}

function decodeSarvamAudioBase64(maybeBase64) {
    if (!maybeBase64 || typeof maybeBase64 !== 'string') {
        return Buffer.alloc(0);
    }

    const cleanBase64 = maybeBase64.includes(',')
        ? maybeBase64.slice(maybeBase64.indexOf(',') + 1)
        : maybeBase64;

    return Buffer.from(cleanBase64, 'base64');
}

function detectAudioFormat(audioBuffer) {
    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < 4) {
        return 'unknown';
    }

    if (audioBuffer.slice(0, 4).toString('ascii') === 'RIFF' && audioBuffer.slice(8, 12).toString('ascii') === 'WAVE') {
        return 'wav';
    }

    if (audioBuffer.slice(0, 3).toString('ascii') === 'ID3') {
        return 'mp3';
    }

    if (audioBuffer.slice(0, 4).toString('ascii') === 'OggS') {
        return 'ogg';
    }

    if (audioBuffer.slice(0, 4).toString('ascii') === 'fLaC') {
        return 'flac';
    }

    if (audioBuffer[0] === 0xff && (audioBuffer[1] & 0xe0) === 0xe0) {
        return 'mp3';
    }

    return 'pcm16le';
}

function saveSarvamAudioSegment({ filePath, segmentId, audioBuffer, sampleRate, explicitFormat }) {
    if (!fs.existsSync(RESULTS_DIR)) {
        fs.mkdirSync(RESULTS_DIR, { recursive: true });
    }

    const basename = path.parse(filePath).name;
    const ts = Date.now();
    const detectedFormat = explicitFormat && explicitFormat !== 'unknown' ? explicitFormat : detectAudioFormat(audioBuffer);

    if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length === 0) {
        const emptyPath = path.join(RESULTS_DIR, `${basename}_seg${segmentId}_sarvam_${ts}.wav`);
        const fallbackWav = new WaveFile();
        fallbackWav.fromScratch(1, sampleRate || 8000, '16', new Int16Array(0));
        fs.writeFileSync(emptyPath, fallbackWav.toBuffer());
        return emptyPath;
    }

    if (detectedFormat === 'wav' || detectedFormat === 'mp3' || detectedFormat === 'ogg' || detectedFormat === 'flac') {
        const outPath = path.join(RESULTS_DIR, `${basename}_seg${segmentId}_sarvam_${ts}.${detectedFormat}`);
        fs.writeFileSync(outPath, audioBuffer);
        return outPath;
    }

    const alignedLength = audioBuffer.length - (audioBuffer.length % 2);
    const pcmSlice = audioBuffer.subarray(0, alignedLength);
    const wavSarvam = new WaveFile();
    wavSarvam.fromScratch(
        1,
        sampleRate || 8000,
        '16',
        new Int16Array(pcmSlice.buffer, pcmSlice.byteOffset, pcmSlice.length / 2)
    );

    const wavPath = path.join(RESULTS_DIR, `${basename}_seg${segmentId}_sarvam_${ts}.wav`);
    fs.writeFileSync(wavPath, wavSarvam.toBuffer());
    return wavPath;
}

function containsDevanagari(text) {
    return /[\u0900-\u097F]/.test(String(text || ''));
}

function extractSarvamTextTranslation(response) {
    if (!response) {
        return '';
    }

    const candidateFields = [
        response.translated_text,
        response.translatedText,
        response.translation,
        response.output_text,
        response.outputText,
        response.text,
    ];

    for (const value of candidateFields) {
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }

    if (typeof response === 'string') {
        return response.trim();
    }

    return '';
}

async function translateEnglishTranscriptToHindi(englishTranscript, segmentId) {
    const trimmed = String(englishTranscript || '').trim();
    if (!trimmed) {
        return '';
    }

    if (containsDevanagari(trimmed)) {
        return trimmed;
    }

    if (!sarvamClient) {
        return trimmed;
    }

    try {
        const result = await sarvamClient.text.translate({
            input: trimmed,
            source_language_code: 'en-IN',
            target_language_code: 'hi-IN',
            model: 'sarvam-translate:v1',
        });
        const hindiText = extractSarvamTextTranslation(result);
        if (hindiText) {
            console.log(`[Path 2] Segment ${segmentId} -> Hindi transcript generated.`);
            return hindiText;
        }
    } catch (err) {
        console.warn(`\n[Path 2] Sarvam text translation failed for segment ${segmentId}: ${err?.message || err}`);
    }

    return trimmed;
}

function computeNetworkSpeedMbps(transferredBytes, latencyMs) {
    const bytes = Number(transferredBytes || 0);
    const ms = Number(latencyMs || 0);
    if (bytes <= 0 || ms <= 0) {
        return 0;
    }

    return Number(((bytes * 8) / (ms / 1000) / 1_000_000).toFixed(3));
}

// ------------------------------------------------------------------
// Path 1: Persistent Gemini WebSocket Implementation
// ------------------------------------------------------------------
function initGeminiWebSocket() {
    return new Promise((resolve, reject) => {
        if (!GEMINI_API_KEY || GEMINI_API_KEY === 'your_gemini_api_key_here') {
            console.log("\n[WARN] Using Mock Gemini WS (API key missing or default).");
            geminiWs = {
                mock: true,
                send: (data) => {
                    const parsed = JSON.parse(data);
                    if (parsed.clientContent && geminiResponseResolver) {
                        setTimeout(() => {
                            t1_first_byte = Date.now();
                            const dummyAudio = Buffer.alloc(16000 * 2); // 1 sec
                            currentGeminiPcmChunks.push(dummyAudio);
                            geminiResponseResolver({ timeToFirstByte: t1_first_byte });
                        }, 600); // 600ms mock TTFB
                    }
                }
            };
            return resolve();
        }

        console.log("Connecting to Gemini Live WebSocket...");
        geminiWs = new WebSocket(WS_URL);

        geminiWs.on('open', () => {
            const setupMessage = {
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    systemInstruction: {
                        parts: [{ text: "You are a professional interpreter. Please translate the user's English audio directly into Hindi. Respond ONLY with the translated speech, no extra commentary." }]
                    },
                    generationConfig: { responseModalities: ["AUDIO"] }
                }
            };
            geminiWs.send(JSON.stringify(setupMessage));
            console.log("[Gemini WS] Connected and sent setup message with translation instructions.");
            resolve();
        });

        geminiWs.on('message', (data) => {
            const response = JSON.parse(data.toString());
            
            if (response.error) {
                 console.error("\n[Gemini API Error] ", response.error);
                 if (geminiResponseResolver) {
                     geminiResponseResolver({ timeToFirstByte: Date.now() }); // fake resolve so it doesn't hang
                 }
            }

            if (response.serverContent?.modelTurn) {
                if (t1_first_byte === null) {
                    t1_first_byte = Date.now();
                    if (geminiResponseResolver) {
                        geminiResponseResolver({ timeToFirstByte: t1_first_byte });
                    }
                }
                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData?.data) {
                        currentGeminiPcmChunks.push(Buffer.from(part.inlineData.data, 'base64'));
                    }
                }
            }
        });

        geminiWs.on('error', (err) => {
            console.error("\n[!] Gemini WS Context Error:", err?.message || err);
            if (geminiResponseResolver) geminiResponseResolver({ timeToFirstByte: Date.now() });
            resolve(); // safely resolve the init lock
        });

        geminiWs.on('close', () => {
            console.log("\nGemini WS Closed.");
            if (geminiResponseResolver) geminiResponseResolver({ timeToFirstByte: Date.now() });
            resolve(); // cleanly pass through if google denies socket instantly
        });
    });
}

async function runGeminiPath(segmentId, audioBuffer, t1_start) {
    if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) {
        console.log(`\n[Path 1] Segment ${segmentId} -> Reconnecting to Gemini Live WS...`);
        await initGeminiWebSocket();
    }
    
    t1_first_byte = null;
    currentGeminiPcmChunks = [];

    const promise = new Promise((resolve) => {
        geminiResponseResolver = resolve;
    });

    const clientContentMessage = {
        clientContent: {
            turns: [{
                role: "user",
                parts: [{
                    text: "Translate this English audio into Hindi spoken word:",
                },{
                    inlineData: { mimeType: "audio/pcm;rate=16000", data: audioBuffer.toString('base64') }
                }]
            }],
            turnComplete: true
        }
    };
    
    console.log(`[Path 1] Segment ${segmentId} -> Requesting E2E Translation via WebSockets...`);
    try {
        geminiWs.send(JSON.stringify(clientContentMessage));
    } catch (e) {
        console.error(`\n[Path 1] Failed to send Segment ${segmentId} to Gemini WS:`, e.message);
        geminiResponseResolver({ timeToFirstByte: Date.now() });
    }

    // Wait until the first byte arrives back from the WS.
    const result = await promise;
    const p1_ttfb = result.timeToFirstByte - t1_start;
    
    // Cleanup reference
    geminiResponseResolver = null;
    
    console.log(`[Path 1] Segment ${segmentId} -> E2E Translation done. Received ${currentGeminiPcmChunks.length} audio chunks.`);
    return {
        ttfb: p1_ttfb,
        audioChunks: currentGeminiPcmChunks
    };
}

// ------------------------------------------------------------------
// Path 2: Sarvam Cascaded Implementation
// ------------------------------------------------------------------
async function runSarvamPath(segmentId, audioBuffer, t2_start) {
    let englishTranscript = "Simulated translated text."; // Default Mock
    let hindiTranscript = "सिम्युलेटेड अनुवादित पाठ।";
    let sttTime = 0;
    let translationTime = 0;
    let audioOutputFormat = 'unknown';
    let audioSampleRate = 8000;
    let sttInputBytes = 0;
    let ttsOutputBytes = 0;
    
    // -- Step A: STT --
    const sttStartTime = Date.now();
    
    // Build context string from last 2 sentences
    const promptContext = sarvamContextHistory.slice(-2).join(' ');
    
    if (sarvamClient) {
        const wav = new WaveFile();
        wav.fromScratch(1, 16000, '16', new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2));
        const wavFileBuffer = wav.toBuffer();
        sttInputBytes = wavFileBuffer.length;

        try {
            console.log(`[Path 2] Segment ${segmentId} -> Sending to Sarvam STT (transcribe)...`);
            const sttRes = await sarvamClient.speechToText.transcribe({
                file: wavFileBuffer,
                model: 'saaras:v3',
                mode: 'transcribe',
            });
            englishTranscript = String(sttRes?.transcript || '').trim();
            console.log(`[Path 2] Segment ${segmentId} -> English transcript: "${englishTranscript}"`);
        } catch (e) {
             console.error(`\n[Path 2] Sarvam STT failed for ${segmentId}:`, e?.message || e);
        }
    } else {
        // Mock if no explicit API key
        await new Promise(r => setTimeout(r, 450));
    }
    
    const sttEndTime = Date.now();
    sttTime = sttEndTime - sttStartTime;

    const translationStartTime = Date.now();
    hindiTranscript = await translateEnglishTranscriptToHindi(englishTranscript, segmentId);
    translationTime = Date.now() - translationStartTime;

    // Update Context History
    if (englishTranscript) {
        sarvamContextHistory.push(englishTranscript);
        if (sarvamContextHistory.length > 5) sarvamContextHistory.shift(); 
    }

    // -- Step B: TTS --
    const ttsStartTime = Date.now();
    let audioOutput = Buffer.alloc(16000 * 2); // default mock 1s
    let ttsTime = 0;

    if (sarvamClient) {
        try {
            const ttsRes = await axios.post('https://api.sarvam.ai/text-to-speech', {
                inputs: [hindiTranscript],
                target_language_code: 'hi-IN',
                speaker: 'kabir',
                pace: 1.0,
                speech_sample_rate: 8000,
                enable_preprocessing: true,
                model: 'bulbul:v3'
            }, {
                headers: { 'api-subscription-key': SARVAM_API_KEY }
            });
            audioOutput = decodeSarvamAudioBase64(ttsRes.data?.audios?.[0]);
            ttsOutputBytes = audioOutput.length;
            audioSampleRate = Number(ttsRes.data?.sample_rate || ttsRes.data?.sampleRate || 8000);
            audioOutputFormat = detectAudioFormat(audioOutput);
            console.log(`[Path 2] Segment ${segmentId} -> TTS generated ${ttsRes.data.audios?.[0]?.length || 0} base64 chars for Hindi output.`);
        } catch (e) {
             console.error(`\n[Path 2] Sarvam TTS failed for ${segmentId}:`, e?.response?.data || e.message);
        }
    } else {
        await new Promise(r => setTimeout(r, 350));
    }

    const ttsEndTime = Date.now();
    ttsTime = ttsEndTime - ttsStartTime;

    const p2_total = (sttEndTime - sttStartTime) + translationTime + (ttsEndTime - ttsStartTime);
    const networkMbps = computeNetworkSpeedMbps(sttInputBytes + ttsOutputBytes, sttTime + translationTime + ttsTime);
    console.log(`[Path 2] Segment ${segmentId} -> Cascaded Done. (STT: ${sttTime}ms, Translate: ${translationTime}ms, TTS: ${ttsTime}ms)`);

    return {
        totalMs: p2_total,
        englishTranscript,
        hindiTranscript,
        sttMs: sttTime,
        translationMs: translationTime,
        ttsMs: ttsTime,
        audioBuffer: audioOutput,
        audioFormat: audioOutputFormat,
        audioSampleRate,
        sttInputBytes,
        ttsOutputBytes,
        networkMbps,
    };
}

// ------------------------------------------------------------------
// Core Zero-Disk FFmpeg & VAD Simulation Engine
// ------------------------------------------------------------------
function processFile(filePath, isLastFile) {
    return new Promise((resolve) => {
        console.log(`\nSpawning FFmpeg zero-disk PCM stream for: ${filePath} ...`);
        
        const fileStartTime = Date.now();
        let totalSttTimeMs = 0;
        let totalTtsTimeMs = 0;
        let totalProcessingMs = 0;
        const segmentLatencyRows = [];
        const queuedTasks = [];
        const inFlight = new Set();
        
        // PCM s16le, 16kHz, mono
        const ffmpegProcess = spawn(ffmpegPath, [
            '-i', filePath,
            '-f', 's16le',
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            'pipe:1' 
        ]);

        let vadBuffer = [];
        let vadByteCount = 0;
        let segmentId = 1;
        
        const VAD_SEGMENT_THRESHOLD = Math.floor(16000 * 2 * (BENCHMARK_CHUNK_MS / 1000));

        const enqueueSegmentTask = async (taskFactory) => {
            while (inFlight.size >= SARVAM_PARALLEL_REQUESTS) {
                await Promise.race(inFlight);
            }

            let taskPromise;
            taskPromise = taskFactory().finally(() => {
                inFlight.delete(taskPromise);
            });

            inFlight.add(taskPromise);
            queuedTasks.push(taskPromise);
        };

        const scheduleSegment = async (segmentBuffer, currentSegmentId, startSignalMs) => {
            await enqueueSegmentTask(async () => {
                console.log(`\n[VAD Trigger] Emitted Segment ${currentSegmentId} (${segmentBuffer.length} bytes). Processing...`);

                try {
                    const sarvamResult = await runSarvamPath(currentSegmentId, segmentBuffer, startSignalMs);

                    totalSttTimeMs += sarvamResult.sttMs;
                    totalTtsTimeMs += sarvamResult.ttsMs;
                    totalProcessingMs += sarvamResult.totalMs;

                    console.table([{
                        Segment: currentSegmentId,
                        "Sarvam STT (ms)": sarvamResult.sttMs,
                        "Sarvam TTS (ms)": sarvamResult.ttsMs,
                        "Sarvam Total (ms)": sarvamResult.totalMs
                    }]);

                    const savedAudioPath = saveSarvamAudioSegment({
                        filePath,
                        segmentId: currentSegmentId,
                        audioBuffer: sarvamResult.audioBuffer,
                        sampleRate: sarvamResult.audioSampleRate,
                        explicitFormat: sarvamResult.audioFormat,
                    });

                    segmentLatencyRows.push({
                        file_name: path.basename(filePath),
                        segment_id: currentSegmentId,
                        chunk_ms: Math.round((segmentBuffer.length / (16000 * 2)) * 1000),
                        english_transcript: sarvamResult.englishTranscript || '',
                        hindi_transcript: sarvamResult.hindiTranscript || '',
                        network_mbps: sarvamResult.networkMbps,
                        stt_ms: sarvamResult.sttMs,
                        translation_ms: sarvamResult.translationMs,
                        tts_ms: sarvamResult.ttsMs,
                        total_latency_ms: sarvamResult.totalMs,
                        saved_audio_path: savedAudioPath,
                        processed_at_iso: new Date().toISOString(),
                    });
                } catch (err) {
                    console.error(`\nError processing segment ${currentSegmentId}:`, err);
                }
            });
        };

        printTableHeader();

        (async () => {
            try {
                for await (const chunk of ffmpegProcess.stdout) {
                    vadBuffer.push(chunk);
                    vadByteCount += chunk.length;

                    if (vadByteCount >= VAD_SEGMENT_THRESHOLD) {
                        const currentSegmentId = segmentId++;
                        const completeAudioBuffer = Buffer.concat(vadBuffer);
                        
                        vadBuffer = [];
                        vadByteCount = 0;
                        
                        const startSignalMs = Date.now();
                        await scheduleSegment(completeAudioBuffer, currentSegmentId, startSignalMs);
                    }
                }

                if (vadByteCount > 0 && vadBuffer.length > 0) {
                    const finalSegmentId = segmentId++;
                    const finalBuffer = Buffer.concat(vadBuffer);
                    await scheduleSegment(finalBuffer, finalSegmentId, Date.now());
                    vadBuffer = [];
                    vadByteCount = 0;
                }

                await Promise.allSettled(queuedTasks);
                
                // End of stream reached
                console.log(`\nZero-Disk Stream finished processing data for ${filePath}`);
                
                const fileWallClockTime = Date.now() - fileStartTime;
                console.log(`\n=== File Summary for ${path.basename(filePath)} ===`);
                console.table([{
                    "Total STT Time (ms)": totalSttTimeMs,
                    "Total TTS Time (ms)": totalTtsTimeMs,
                    "Total Processing (ms)": totalProcessingMs,
                    "File Wall Clock (ms)": fileWallClockTime,
                    "Chunk Size (ms)": BENCHMARK_CHUNK_MS,
                    "Sarvam Parallel Requests": SARVAM_PARALLEL_REQUESTS,
                }]);
                
                resolve({
                    filePath,
                    rows: segmentLatencyRows,
                    summary: {
                        totalSttTimeMs,
                        totalTtsTimeMs,
                        totalProcessingMs,
                        fileWallClockTime,
                    },
                });

            } catch (err) {
                console.error("Error reading FFmpeg stream:", err);
                resolve({ filePath, rows: [], summary: null });
            }
        })();

        ffmpegProcess.on('close', (code) => {
            // Note: resolve() is called after for-await completes to ensure all segments finish.
            // console.log(`FFmpeg process exited with code ${code}`);
        });
    });
}

async function startBenchmark() {
    console.log("Initializing Benchmark Engine...");
    
    // Connect to WebSocket before data starts streaming
    // await initGeminiWebSocket();

    const files = fs.readdirSync(INPUT_AUDIO_DIR)
        .filter(f => f.endsWith('.wav') || f.endsWith('.mp4') || f.endsWith('.mp3'))
        .map(f => path.join(INPUT_AUDIO_DIR, f));

    if (files.length === 0) {
        console.warn(`\n[!] Warning: No audio files found in ${INPUT_AUDIO_DIR}.`);
        process.exit(1);
    }

    const allRows = [];
    
    for (let i = 0; i < files.length; i++) {
        const result = await processFile(files[i], i === files.length - 1);
        if (result?.rows?.length) {
            allRows.push(...result.rows);
        }
    }

    if (allRows.length > 0) {
        allRows.sort((a, b) => {
            if (a.file_name === b.file_name) {
                return Number(a.segment_id) - Number(b.segment_id);
            }
            return String(a.file_name).localeCompare(String(b.file_name));
        });

        const workbook = XLSX.utils.book_new();
        const worksheet = XLSX.utils.json_to_sheet(allRows);
        XLSX.utils.book_append_sheet(workbook, worksheet, 'segment_latency');

        const excelPath = path.join(RESULTS_DIR, `segment_latency_${Date.now()}.xlsx`);
        XLSX.writeFile(workbook, excelPath);
        console.log(`\n📊 Segment latency Excel saved to: ${excelPath}`);
    } else {
        console.log('\nℹ️ No segment latency rows to write to Excel.');
    }
    
    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
        geminiWs.close();
    }
    process.exit(0);
}

// Ensure clean exit
process.on('SIGINT', () => {
    if (geminiWs) geminiWs.close();
    process.exit();
});

startBenchmark().catch(console.error);
