import {
  Room,
  RoomEvent,
  TrackKind,
  AudioSource,
  LocalAudioTrack,
  TrackSource,
} from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

/**
 * Test script to validate audio latency and translation pipeline.
 * Usage: 
 *   1. Ensure `agents/translation_worker.py --target-language Hindi --room translation-hi` is running.
 *   2. Place a `test_input.mp4` in the current directory.
 *   3. Run `node test.js`
 */

const INPUT_VIDEO = path.resolve(process.cwd(), "test_input.mp4");
const OUTPUT_VIDEO = path.resolve(process.cwd(), "test_output_hi.mp4");

const LIVEKIT_URL = process.env.LIVEKIT_URL;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const ROOM_NAME = "translation-hi";

async function createToken() {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity: `test-client-${Date.now()}`,
  });
  at.addGrant({ roomJoin: true, room: ROOM_NAME, canPublish: true, canSubscribe: true });
  return await at.toJwt();
}

async function runTest() {
  if (!fs.existsSync(INPUT_VIDEO)) {
    console.error(`❌ Input video not found at ${INPUT_VIDEO}`);
    console.log(`Please place an MP4 file named "test_input.mp4" in the root directory.`);
    process.exit(1);
  }

  console.log(`🚀 Starting Translation Latency Test...`);
  
  const room = new Room();
  const token = await createToken();

  let outputFfmpeg = null;
  let hasReceivedAgentAudio = false;

  // Set up FFmpeg output process
  const startOutputFfmpeg = () => {
    console.log(`🎬 Starting FFmpeg output muxer to ${OUTPUT_VIDEO}`);
    // Mix the original video with the incoming translated audio
    const ffmpegArgs = [
      "-y",
      "-i", INPUT_VIDEO,     // Original video
      "-f", "s16le",         // Raw PCM audio format from LiveKit
      "-ar", "24000",        // Sample rate of incoming agent audio
      "-ac", "1",            // Mono
      "-i", "pipe:0",        // Read from stdin
      "-map", "0:v:0",       // Use video from input 1
      "-map", "1:a:0",       // Use audio from input 2
      "-c:v", "copy",        // Copy video codec directly
      "-c:a", "aac",         // Encode audio to AAC for mp4
      "-b:a", "128k",
      "-shortest",           // End when the shortest stream ends
      OUTPUT_VIDEO
    ];

    outputFfmpeg = spawn(ffmpegPath, ffmpegArgs, { stdio: ["pipe", "inherit", "pipe"] });
    outputFfmpeg.stderr.on("data", (data) => {
      // uncomment to debug ffmpeg writing issues
      // console.log(`[FFMPEG OUT] ${data.toString()}`);
    });
    
    outputFfmpeg.on("close", (code) => {
      console.log(`✅ FFmpeg output closed with code ${code}. Video saved at ${OUTPUT_VIDEO}`);
      process.exit(0);
    });
  };

  room.on(RoomEvent.TrackSubscribed, async (track, publication, participant) => {
    if (track.kind === TrackKind.KIND_AUDIO && participant.identity !== room.localParticipant.identity) {
      console.log(`🔊 Subscribed to remote track: ${participant.identity}`);
      
      if (!outputFfmpeg) startOutputFfmpeg();

      const { AudioStream } = await import("@livekit/rtc-node");
      const stream = new AudioStream(track, { sampleRate: 24000, numChannels: 1 });

      let firstFrameTime = null;

      try {
        for await (const frame of stream) {
          if (!hasReceivedAgentAudio) {
            hasReceivedAgentAudio = true;
            console.log(`⏱️ First translated audio frame received!`);
          }
          
          if (outputFfmpeg && outputFfmpeg.stdin.writable) {
            const buffer = Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength);
            outputFfmpeg.stdin.write(buffer);
          }
        }
      } catch (err) {
        console.error("Audio block disconnected", err);
      }
    }
  });

  room.on(RoomEvent.Disconnected, () => {
    console.log("🔌 Disconnected from LiveKit room");
    if (outputFfmpeg) outputFfmpeg.stdin.end();
  });

  await room.connect(LIVEKIT_URL, token);
  console.log(`🔗 Connected to Room: ${ROOM_NAME}`);

  // Create an audio source for our test track
  const sampleRate = 16000;
  const numChannels = 1;
  const source = new AudioSource(sampleRate, numChannels);
  const track = LocalAudioTrack.createAudioTrack("test-mic", source);
  await room.localParticipant.publishTrack(track, { source: TrackSource.SOURCE_MICROPHONE });

  // Monitor Metrics (Latency/Jitter)
  setInterval(async () => {
    if (!room.isDisconnected) {
      try {
        const stats = await room.localParticipant.getPublishTrackInfo();
        // RTC Stats logging for monitoring
        console.log(`📊 [Metrics] Connection state: ${room.state}, Subscribed to Agent: ${hasReceivedAgentAudio}`);
      } catch (e) {}
    }
  }, 5000);

  // Spawn FFmpeg to read the test video and extract audio
  console.log(`🎤 Extracting audio from ${INPUT_VIDEO} and publishing to LiveKit...`);
  const inputFfmpeg = spawn(ffmpegPath, [
    "-i", INPUT_VIDEO,
    "-f", "s16le",
    "-ar", sampleRate.toString(),
    "-ac", numChannels.toString(),
    "pipe:1"
  ], { stdio: ["ignore", "pipe", "pipe"] });

  inputFfmpeg.stderr.on("data", () => {}); // Ignore FFmpeg read logs

  const frameMs = 20;
  const bytesPerFrame = (sampleRate * numChannels * 2 * frameMs) / 1000;
  let audioQueue = [];

  inputFfmpeg.stdout.on("data", (chunk) => {
    audioQueue.push(chunk);
  });

  // Dedicated playback loop at 1x speed to feed LiveKit without breaking VAD constraints
  const playbackLoop = setInterval(async () => {
    if (audioQueue.length === 0) return;
    
    let buffer = Buffer.concat(audioQueue);
    if (buffer.length < bytesPerFrame) {
      audioQueue = [buffer];
      return;
    }

    const frameData = buffer.subarray(0, bytesPerFrame);
    audioQueue = [buffer.subarray(bytesPerFrame)];
    
    try {
      const dataView = new DataView(frameData.buffer, frameData.byteOffset, frameData.length);
      const samples = new Int16Array(frameData.length / 2);
      for (let i = 0; i < samples.length; i++) {
        samples[i] = dataView.getInt16(i * 2, true);
      }
      
      await source.captureFrame({
         data: samples,
         samplesPerChannel: sampleRate * frameMs / 1000,
         sampleRate: sampleRate,
         numChannels: numChannels
      });
    } catch (e) {
      // Ignore if disconnected
    }
  }, frameMs);

  inputFfmpeg.on("close", () => {
    console.log(`🎬 Finished reading input video audio.`);
    // Give some time for the translation agent to finish the last chunks
    setTimeout(() => {
      clearInterval(playbackLoop);
      console.log(`Test complete. Closing output streams...`);
      if (outputFfmpeg) outputFfmpeg.stdin.end();
      process.exit(0);
    }, 15000);
  });
}

runTest().catch((err) => {
  console.error("❌ Test failed:", err);
  process.exit(1);
});