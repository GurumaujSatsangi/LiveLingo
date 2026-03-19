import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import { ElevenLabsClient } from "@elevenlabs/elevenlabs-js";

dotenv.config();

const targetLang = "es";
const defaultSourceFilePath = "C:/Users/gurum/Downloads/PM trimmed.mp3";

function parseSourcePathArg(rawArg) {
  if (!rawArg) {
    return defaultSourceFilePath;
  }

  const trimmed = String(rawArg).trim();

  // Allow users to paste quoted Windows paths directly.
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

const sourceFilePath = parseSourcePathArg(process.argv[2]);

const pollIntervalMs = Number(process.env.ELEVENLABS_DUBBING_POLL_MS || 1500);
const maxWaitMs = Number(process.env.ELEVENLABS_DUBBING_MAX_WAIT_MS || 180000);
const defaultWatermark =
  String(process.env.ELEVENLABS_DUBBING_WATERMARK || "true").toLowerCase() !== "false";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isWatermarkSubscriptionError(err) {
  const message = String(err?.message || "").toLowerCase();
  return (
    message.includes("watermark_not_allowed") ||
    message.includes("subscription_required") ||
    message.includes("dubbing without a watermark")
  );
}

async function createDubbingJob(elevenlabs, payload) {
  try {
    return await elevenlabs.dubbing.create({
      ...payload,
      watermark: defaultWatermark,
    });
  } catch (err) {
    if (!defaultWatermark && isWatermarkSubscriptionError(err)) {
      console.warn("Watermark is required for your plan. Retrying with watermark enabled.");
      return elevenlabs.dubbing.create({
        ...payload,
        watermark: true,
      });
    }

    throw err;
  }
}

async function toBuffer(streamData) {
  if (!streamData) return null;
  if (Buffer.isBuffer(streamData)) return streamData;
  if (streamData instanceof Uint8Array) return Buffer.from(streamData);
  if (streamData instanceof ArrayBuffer) return Buffer.from(streamData);

  if (typeof streamData.arrayBuffer === "function") {
    const ab = await streamData.arrayBuffer();
    return Buffer.from(ab);
  }

  const chunks = [];
  for await (const chunk of streamData) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return chunks.length ? Buffer.concat(chunks) : null;
}

async function main() {
  if (!process.env.ELEVENLABS_API_KEY) {
    throw new Error("ELEVENLABS_API_KEY is missing in environment.");
  }

  const elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });

  try {
    await fs.access(sourceFilePath);
  } catch {
    throw new Error(
      `Source file not found: ${sourceFilePath}\nRun like: node test-elevenlabs-dubbing.js \"C:/Users/gurum/Downloads/PM trimmed.mp3\"`
    );
  }

  const audioBuffer = await fs.readFile(sourceFilePath);
  const sourceBlob = new Blob([audioBuffer], { type: "audio/mpeg" });

  console.log(`Starting dubbing for: ${sourceFilePath}`);
  const dubbed = await createDubbingJob(elevenlabs, {
    file: sourceBlob,
    targetLang,
  });

  console.log(`Dubbing job created: ${dubbed.dubbingId}`);

  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    const metadata = await elevenlabs.dubbing.get(dubbed.dubbingId);
    const status = String(metadata?.status || "").toLowerCase();

    if (status === "dubbed") {
      console.log("Dubbing complete. Downloading dubbed audio...");
      const dubbedStream = await elevenlabs.dubbing.audio.get(dubbed.dubbingId, targetLang);
      const dubbedFileBuffer = await toBuffer(dubbedStream);

      if (!dubbedFileBuffer?.length) {
        throw new Error("Received empty dubbed audio from ElevenLabs.");
      }

      const outputDir = path.resolve("translated_audio");
      await fs.mkdir(outputDir, { recursive: true });

      const inputBase = path.basename(sourceFilePath, path.extname(sourceFilePath));
      const outputPath = path.join(outputDir, `${inputBase}_${targetLang}_dubbed.mp3`);
      await fs.writeFile(outputPath, dubbedFileBuffer);

      console.log(`Saved dubbed file to: ${outputPath}`);
      return;
    }

    if (status === "failed" || status === "error") {
      throw new Error(`Dubbing failed: ${metadata?.error || "unknown error"}`);
    }

    console.log(`Audio is still being dubbed... (status: ${status || "pending"})`);
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timed out after ${maxWaitMs}ms waiting for dubbing to complete.`);
}

main().catch((err) => {
  console.error("Dubbing test failed:", err.message);
  process.exit(1);
});
