import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import axios from 'axios';
import dotenv from 'dotenv';
import WebSocket from 'ws';
import ffmpegPath from 'ffmpeg-static';
import pkg from 'wavefile';
const { WaveFile } = pkg;

dotenv.config({ path: '.env.test' });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const INPUT_AUDIO_DIR = process.env.INPUT_AUDIO_DIR || './test_audio';
const RESULTS_DIR = process.env.RESULTS_DIR || './benchmark_results';

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
    let transcript = "Simulated translated text."; // Default Mock
    let sttTime = 0;
    
    // -- Step A: STT --
    const sttStartTime = Date.now();
    
    // Build context string from last 2 sentences
    const promptContext = sarvamContextHistory.slice(-2).join(' ');
    
    if (SARVAM_API_KEY && SARVAM_API_KEY !== 'your_sarvam_api_key_here') {
        const wav = new WaveFile();
        wav.fromScratch(1, 16000, '16', new Int16Array(audioBuffer.buffer, audioBuffer.byteOffset, audioBuffer.length / 2));
        const wavFileBuffer = wav.toBuffer();

        const formData = new FormData();
        formData.append('file', new Blob([wavFileBuffer]), 'chunk.wav');
        formData.append('model', 'saaras:v2.5');
        if (promptContext) formData.append('prompt', promptContext);

        try {
            console.log(`[Path 2] Segment ${segmentId} -> Sending to Sarvam STT...`);
            const sttRes = await axios.post('https://api.sarvam.ai/speech-to-text-translate', formData, {
                headers: { 'api-subscription-key': SARVAM_API_KEY }
            });
            transcript = sttRes.data.transcript;
            console.log(`[Path 2] Segment ${segmentId} -> Translated String: "${transcript}"`);
        } catch (e) {
             console.error(`\n[Path 2] Sarvam STT failed for ${segmentId}:`, e?.response?.data || e.message);
        }
    } else {
        // Mock if no explicit API key
        await new Promise(r => setTimeout(r, 450));
    }
    
    const sttEndTime = Date.now();
    sttTime = sttEndTime - sttStartTime;

    // Update Context History
    if (transcript) {
        sarvamContextHistory.push(transcript);
        if (sarvamContextHistory.length > 5) sarvamContextHistory.shift(); 
    }

    // -- Step B: TTS --
    const ttsStartTime = Date.now();
    let audioOutput = Buffer.alloc(16000 * 2); // default mock 1s
    let ttsTime = 0;

    if (SARVAM_API_KEY && SARVAM_API_KEY !== 'your_sarvam_api_key_here') {
        try {
            const ttsRes = await axios.post('https://api.sarvam.ai/text-to-speech', {
                inputs: [transcript],
                target_language_code: 'hi-IN',
                speaker: 'kabir',
                pace: 1.0,
                speech_sample_rate: 8000,
                enable_preprocessing: true,
                model: 'bulbul:v3'
            }, {
                headers: { 'api-subscription-key': SARVAM_API_KEY }
            });
            audioOutput = Buffer.from(ttsRes.data.audios[0], 'base64');
            console.log(`[Path 2] Segment ${segmentId} -> TTS generated ${ttsRes.data.audios[0].length} base64 chars for Hindi output.`);
        } catch (e) {
             console.error(`\n[Path 2] Sarvam TTS failed for ${segmentId}:`, e?.response?.data || e.message);
        }
    } else {
        await new Promise(r => setTimeout(r, 350));
    }

    const ttsEndTime = Date.now();
    ttsTime = ttsEndTime - ttsStartTime;

    const p2_total = (sttEndTime - sttStartTime) + (ttsEndTime - ttsStartTime);
    console.log(`[Path 2] Segment ${segmentId} -> Cascaded Done. (STT: ${sttTime}ms, TTS: ${ttsTime}ms)`);

    return {
        totalMs: p2_total,
        transcript: transcript,
        sttMs: sttTime,
        ttsMs: ttsTime,
        audioBuffer: audioOutput
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
        
        const VAD_SEGMENT_THRESHOLD = 16000 * 2 * 3; // Approx 3 seconds of 16kHz 16-bit audio per segment

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
                console.log(`\n[VAD Trigger] Emitted Segment ${currentSegmentId} (${completeAudioBuffer.length} bytes). Processing...`);

                try {
                    // const geminiPromise = runGeminiPath(currentSegmentId, completeAudioBuffer, startSignalMs);
                    // const sarvamPromise = runSarvamPath(currentSegmentId, completeAudioBuffer, startSignalMs);
                    // const [geminiResult, sarvamResult] = await Promise.all([geminiPromise, sarvamPromise]);
                    const sarvamResult = await runSarvamPath(currentSegmentId, completeAudioBuffer, startSignalMs);

                    totalSttTimeMs += sarvamResult.sttMs;
                    totalTtsTimeMs += sarvamResult.ttsMs;
                    totalProcessingMs += sarvamResult.totalMs;

                    console.table([{
                        Segment: currentSegmentId,
                        "Sarvam STT (ms)": sarvamResult.sttMs,
                        "Sarvam TTS (ms)": sarvamResult.ttsMs,
                        "Sarvam Total (ms)": sarvamResult.totalMs
                    }]);

                    const ts = Date.now();
                    const basename = path.parse(filePath).name;
                    
                    // const gemFinalAudio = Buffer.concat(geminiResult.audioChunks);
                    // const wavGem = new WaveFile();
                    // wavGem.fromScratch(1, 24000, '16', gemFinalAudio.length > 0 ? gemFinalAudio : Buffer.alloc(16000*2));
                    // fs.writeFileSync(path.join(RESULTS_DIR, `${basename}_seg${currentSegmentId}_gemini_${ts}.wav`), wavGem.toBuffer());

                    const wavSarvam = new WaveFile();
                    wavSarvam.fromScratch(1, 8000, '16', sarvamResult.audioBuffer);
                    fs.writeFileSync(path.join(RESULTS_DIR, `${basename}_seg${currentSegmentId}_sarvam_${ts}.wav`), wavSarvam.toBuffer());
                        } catch (err) {
                            console.error(`\nError processing segment ${currentSegmentId}:`, err);
                        }
                    }
                }
                
                // End of stream reached
                console.log(`\nZero-Disk Stream finished processing data for ${filePath}`);
                
                const fileWallClockTime = Date.now() - fileStartTime;
                console.log(`\n=== File Summary for ${path.basename(filePath)} ===`);
                console.table([{
                    "Total STT Time (ms)": totalSttTimeMs,
                    "Total TTS Time (ms)": totalTtsTimeMs,
                    "Total Processing (ms)": totalProcessingMs,
                    "File Wall Clock (ms)": fileWallClockTime
                }]);
                
                resolve();

            } catch (err) {
                console.error("Error reading FFmpeg stream:", err);
                resolve();
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
    
    for (let i = 0; i < files.length; i++) {
        await processFile(files[i], i === files.length - 1);
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
