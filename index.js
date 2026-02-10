import express from 'express';
import ejs from 'ejs';
import dotenv from 'dotenv';
import session from 'express-session';
import { spawn } from "child_process";
import ffmpegPath from "ffmpeg-static";
import { SarvamAIClient } from 'sarvamai';


dotenv.config();

const app = express();

const client = new SarvamAIClient({
    apiSubscriptionKey: process.env.SARVAM_API_KEY
});

app.get("/",async (req,res)=>{
    res.render("home.ejs");
})

app.get("/create-new-livestream",async(req,res)=>{
  res.render("new-live-stream.ejs");
})

app.get("/dashboard",async (req,res)=>{
    res.render("dashboard.ejs");
})


const ffmpeg = spawn(ffmpegPath, [
  "-reconnect", "1",
  "-reconnect_streamed", "1",
  "-reconnect_delay_max", "2",
  "-i", process.env.CLOUDINARY_LIVESTREAM_HLS_URL,
  "-vn",
  "-ar", "16000",
  "-ac", "1",
  "-f", "s16le",
  "pipe:1"
]);

ffmpeg.stdout.on("data", chunk => {
  console.log(chunk);
});

ffmpeg.stderr.on("data", err => {
  console.error("FFmpeg:", err.toString());
});

ffmpeg.on("close", code => {
  console.log("FFmpeg exited with code", code);
});



app.listen(process.env.PORT,()=>{
    console.log("Running on http://localhost:3000");
})