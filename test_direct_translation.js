import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import OpenAI from "openai";
import dotenv from "dotenv";

dotenv.config();

/**
 * Direct Translation Test using Qwen3.5-Omni-Flash (SiliconFlow)
 * Extracts 10-second PCM chunks from a video, transcodes to base64 WAV,
 * sends them to the model, and saves the translated output audio.
 */

const INPUT_VIDEO = path.resolve(process.cwd(), "test_input.mp4");
const OUTPUT_DIR = path.resolve(process.cwd(), "translated_chunks");
const TARGET_LANGUAGE = "Hindi";
const CHUNK_DURATION_SEC = 10;
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

if (!OPENROUTER_API_KEY) {
  console.error("❌ OPENROUTER_API_KEY is not defined in .env");
  process.exit(1);
}

if (!fs.existsSync(INPUT_VIDEO)) {
  console.error(`❌ Input video not found at ${INPUT_VIDEO}`);
  process.exit(1);
}

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const openai = new OpenAI({
  apiKey: OPENROUTER_API_KEY,
  baseURL: OPENROUTER_BASE_URL,
  defaultHeaders: {
    "HTTP-Referer": "http://localhost:3000",
    "X-Title": "LiveLingo Project"
  }
});

async function translateChunk(chunkWavBuffer, chunkIndex) {
  const base64Audio = chunkWavBuffer.toString("base64");
  console.log(`🤖 Sending chunk ${chunkIndex} to Qwen3.5-Omni-Flash... (${base64Audio.length} bytes)`);

  const startTime = Date.now();
  try {
    const completion = await openai.chat.completions.create({
      model: "qwen/qwen3.6-plus",        
      modalities: ["text", "audio"],      
      audio: { voice: "alloy", format: "pcm16" }, // Adapts depending on SiliconFlow's exact required API config, though realtime prefers alloy mapping or direct voice options.
      messages: [
        {
          role: "system",
          content: `You are a professional interpreter. Translate English audio to ${TARGET_LANGUAGE} accurately. Output only the translated text.`,
        },
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: base64Audio,
                format: "wav", 
              },
            },
          ],
        },
      ],
      temperature: 0.1,
    });

    const latency = Date.now() - startTime;
    console.log(`⏱️ Chunk ${chunkIndex} translated in ${latency}ms`);

    // Check if the model returned audio data
    if (completion.choices?.[0]?.message?.audio?.data) {
      const outputBase64 = completion.choices[0].message.audio.data;
      const pcmBuffer = Buffer.from(outputBase64, "base64");

      const outputFileName = path.join(OUTPUT_DIR, `translated_chunk_${chunkIndex}.pcm`);
      fs.writeFileSync(outputFileName, pcmBuffer);
      console.log(`✅ Saved translated chunk to ${outputFileName}`);
    } else {
      console.warn(`⚠️  No audio output in response for chunk ${chunkIndex}`);
      console.log(`Text returned: ${completion.choices?.[0]?.message?.content || "None"}`);
    }
  } catch (err) {
    console.error(`❌ Error translating chunk ${chunkIndex}:`, err.message);
  }
}

async function extractAndTranslate() {
  console.log(`🎤 Extracting ${CHUNK_DURATION_SEC}-second WAV chunks from ${INPUT_VIDEO}...`);

  // Extract audio to stream, we use segment muxer to split it reliably
  const ffmpegArgs = [
    "-i", INPUT_VIDEO,
    "-f", "segment",
    "-segment_time", String(CHUNK_DURATION_SEC),
    "-c:a", "pcm_s16le",
    "-ar", "16000",
    "-ac", "1",
    "-vn", 
    path.join(OUTPUT_DIR, "source_chunk_%03d.wav"),
  ];

  const segmentFfmpeg = spawn(ffmpegPath, ffmpegArgs, { stdio: "inherit" });

  segmentFfmpeg.on("close", async (code) => {
    console.log(`🎬 FFmpeg segmentation completed (code ${code}). Reading raw chunks...`);

    const files = fs.readdirSync(OUTPUT_DIR)
      .filter(f => f.startsWith("source_chunk_") && f.endsWith(".wav"))
      .sort();

    console.log(`📦 Found ${files.length} chunks. Translating...`);

    for (let i = 0; i < files.length; i++) {
        const chunkPath = path.join(OUTPUT_DIR, files[i]);
        const wavBuffer = fs.readFileSync(chunkPath);
        await translateChunk(wavBuffer, i);
        // small delay between hits
        await new Promise(r => setTimeout(r, 1000));
    }

    console.log(`🏁 All chunks processed. Check the '${OUTPUT_DIR}' folder.`);
  });
}

extractAndTranslate();