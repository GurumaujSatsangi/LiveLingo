import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';
import WebSocket from 'ws'; // Import added for WebSockets
import { GoogleGenerativeAI } from '@google/generative-ai'; 
import pkg from 'wavefile';
const { WaveFile } = pkg;

// Load environment variables
dotenv.config({ path: '.env.test' });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SARVAM_API_KEY = process.env.SARVAM_API_KEY;
const INPUT_AUDIO_DIR = process.env.INPUT_AUDIO_DIR || './test_audio';
const OUTPUT_DIR = process.env.OUTPUT_DIR || './output';

if (!fs.existsSync(INPUT_AUDIO_DIR)) {
    fs.mkdirSync(INPUT_AUDIO_DIR, { recursive: true });
}
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// ---------------------------------------------------------
// Benchmarking Logic
// ---------------------------------------------------------
async function runGeminiEndToEnd(audioBuffer, segmentId) {
    return new Promise((resolve, reject) => {
        const startTime = Date.now();
        console.log(`[Path 1] Sending Segment ${segmentId} to Gemini Live (End-to-End)...`);

        if (!GEMINI_API_KEY || GEMINI_API_KEY === 'AIzaSyCWtcGWm0t2B1ndXwwt6khlWfu3EKMimu0') {
             console.log("[Path 1] Mocking websocket due to missing/default GEMINI_API_KEY");
             setTimeout(() => {
                const timeToFirstByte = Date.now() - startTime;
                const pcmData = Buffer.alloc(16000 * 2);
                resolve({ path: 'Gemini E2E', segmentId, sttMs: '-', llmMs: '-', ttsMs: '-', totalMs: timeToFirstByte });
             }, 800);
             return;
        }

        const HOST = "generativelanguage.googleapis.com";
        const WS_URL = `wss://${HOST}/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;
        
        const ws = new WebSocket(WS_URL);
        let timeToFirstByte = null;
        let pcmChunks = [];

        ws.on('open', () => {
            // 1. Send the Setup Message
            const setupMessage = {
                setup: {
                    model: "models/gemini-2.0-flash-exp",
                    generationConfig: {
                        responseModalities: ["AUDIO"]
                    }
                }
            };
            ws.send(JSON.stringify(setupMessage));
            
            // 2. Send the Audio Chunk as base64 encoded clientContent
            const clientContentMessage = {
                clientContent: {
                    turns: [{
                        role: "user",
                        parts: [{
                            inlineData: {
                                mimeType: "audio/pcm;rate=16000",
                                data: audioBuffer.toString('base64')
                            }
                        }]
                    }],
                    turnComplete: true
                }
            };
            ws.send(JSON.stringify(clientContentMessage));
        });

        ws.on('message', (data) => {
            const response = JSON.parse(data.toString());
            
            // If the server sends model content...
            if (response.serverContent?.modelTurn) {
                // Record Time To First Byte immediately if not done yet
                if (timeToFirstByte === null) {
                    timeToFirstByte = Date.now() - startTime;
                }

                const parts = response.serverContent.modelTurn.parts;
                for (const part of parts) {
                    if (part.inlineData?.data) {
                        pcmChunks.push(Buffer.from(part.inlineData.data, 'base64'));
                    }
                }
            }

            // Close connection when turn is fully complete
            if (response.serverContent?.turnComplete) {
                ws.close();
            }
        });

        ws.on('close', () => {
            // Fallback if no audio arrived
            if (timeToFirstByte === null) timeToFirstByte = Date.now() - startTime;

            // Optional: Compile output audio
            const finalAudioBuffer = pcmChunks.length > 0 
                ? Buffer.concat(pcmChunks) 
                : Buffer.alloc(16000 * 2);

            const outputWav = new WaveFile();
            outputWav.fromScratch(1, 24000, '16', finalAudioBuffer); // Gemini typically returns 24kHz standard audio
            
            const timestamp = Date.now();
            const outPath = path.join(OUTPUT_DIR, `path1_gemini_${timestamp}.wav`);
            fs.writeFileSync(outPath, outputWav.toBuffer());

            resolve({
                path: 'Gemini E2E',
                segmentId,
                sttMs: '-',
                llmMs: '-',
                ttsMs: '-',
                totalMs: timeToFirstByte,
            });
        });

        ws.on('error', (err) => {
            console.error("[Path 1] WebSocket Error:", err);
            ws.close();
            reject(err);
        });
    });
}

async function runSarvamCascaded(audioBuffer, segmentId) {
    const startTime = Date.now();
    console.log(`[Path 2] Sending Segment ${segmentId} to Sarvam (Cascaded)...`);

    // Step A: Speech-to-Text (Sarvam)
    const sttStartTime = Date.now();
    let transcript = "Simulated translated text";
    /*
    // Actual API Call structure (In-Memory, no disk I/O):
    const formData = new FormData();
    // Using a Buffer directly to avoid disk writes
    formData.append('file', new Blob([audioBuffer]), 'chunk.wav');
    formData.append('model', 'saaras:v1');
    const sttRes = await axios.post('https://api.sarvam.ai/speech-to-text-translate', formData, {
        headers: { 'api-subscription-key': SARVAM_API_KEY }
    });
    transcript = sttRes.data.transcript;
    */
    await new Promise(resolve => setTimeout(resolve, 400)); // Mock STT
    const sttTime = Date.now() - sttStartTime;

    // Step B: Lightweight LLM (Verification/Translation)
    const llmStartTime = Date.now();
    let verifiedText = transcript;
    await new Promise(resolve => setTimeout(resolve, 300)); // Mock LLM
    const llmTime = Date.now() - llmStartTime;

    // Step C: Text-to-Speech (Sarvam Bulbul v3)
    const ttsStartTime = Date.now();
    /*
    const ttsRes = await axios.post('https://api.sarvam.ai/text-to-speech', {
        inputs: [verifiedText],
        target_language_code: 'hi-IN',
        speaker: 'meera',
        pitch: 0,
        pace: 1.0,
        loudness: 1.5,
        speech_sample_rate: 8000,
        enable_preprocessing: true,
        model: 'bulbul:v1'
    }, {
        headers: { 'api-subscription-key': SARVAM_API_KEY }
    });
    // const audioOutput = Buffer.from(ttsRes.data.audios[0], 'base64');
    */
    await new Promise(resolve => setTimeout(resolve, 500)); // Mock TTS
    
    const pcmData = Buffer.alloc(16000 * 2); // 1 sec of dummy 16kHz 16-bit PCM
    const outputWav = new WaveFile();
    outputWav.fromScratch(1, 16000, '16', pcmData);
    
    const timestamp = Date.now();
    const outPath = path.join(OUTPUT_DIR, `path2_sarvam_${timestamp}.wav`);
    fs.writeFileSync(outPath, outputWav.toBuffer());
    
    const ttsTime = Date.now() - ttsStartTime;
    
    const totalMs = Date.now() - startTime;
    return {
        path: 'Sarvam Cascaded',
        segmentId,
        sttMs: sttTime,
        llmMs: llmTime,
        ttsMs: ttsTime,
        totalMs: totalMs,
    };
}

// ---------------------------------------------------------
// Main Benchmark Runner
// ---------------------------------------------------------
async function runBenchmark() {
    console.log("Starting Latency Benchmark...");
    
    // Read all audio files from the input directory
    const files = fs.readdirSync(INPUT_AUDIO_DIR).filter(f => f.endsWith('.wav'));
    
    if (files.length === 0) {
        console.log(`\nNo .wav files found in ${INPUT_AUDIO_DIR}. Please add your 5-min, 10-min, etc. audio files there.`);
        return;
    }

    for (const fileName of files) {
        console.log(`\n======================================================`);
        console.log(`Processing Audio File: ${fileName}`);
        console.log(`======================================================`);
        
        const filePath = path.join(INPUT_AUDIO_DIR, fileName);
        const fileBuffer = fs.readFileSync(filePath);
        
        // Mocking VAD logic: In reality, you'd process `fileBuffer` thru a VAD stream.
        // As the VAD emits `speech_segment` events (in-memory Buffers), we send them
        // DIRECTLY over the wire without writing to or reading from disk.
        const dummySegments = [
            { id: 1, buffer: fileBuffer.slice(0, Math.min(10000, fileBuffer.length)) },
            { id: 2, buffer: fileBuffer.slice(10000, Math.min(20000, fileBuffer.length)) }
        ];

        for (const segment of dummySegments) {
            console.log(`\n--- File: ${fileName} | Segment ${segment.id} ---`);
            
            const geminiResult = await runGeminiEndToEnd(segment.buffer, segment.id);
            const sarvamResult = await runSarvamCascaded(segment.buffer, segment.id);
            
            console.log('\n| Path | Segment ID | STT (ms) | LLM (ms) | TTS (ms) | Total E2E (ms) |');
            console.log('|------|------------|----------|----------|----------|----------------|');
            console.log(`| ${geminiResult.path.padEnd(14)} | ${String(geminiResult.segmentId).padEnd(10)} | ${String(geminiResult.sttMs).padEnd(8)} | ${String(geminiResult.llmMs).padEnd(8)} | ${String(geminiResult.ttsMs).padEnd(8)} | ${String(geminiResult.totalMs).padEnd(14)} |`);
            console.log(`| ${sarvamResult.path.padEnd(14)} | ${String(sarvamResult.segmentId).padEnd(10)} | ${String(sarvamResult.sttMs).padEnd(8)} | ${String(sarvamResult.llmMs).padEnd(8)} | ${String(sarvamResult.ttsMs).padEnd(8)} | ${String(sarvamResult.totalMs).padEnd(14)} |`);
        }
    }
}

runBenchmark().catch(console.error);
