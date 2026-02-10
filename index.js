import express from 'express';
import ejs from 'ejs';
import dotenv from 'dotenv';
import session from 'express-session';
import { spawn } from "child_process";
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


app.listen(process.env.PORT,()=>{
    console.log("Running on http://localhost:3000");
})