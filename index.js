import express from 'express';
import ejs from 'ejs';
import dotenv from 'dotenv';
import session from 'express-session';

dotenv.config();

const app = express();

app.get("/",async (req,res)=>{
    res.render("home.ejs");
})

app.get("/dashboard",async (req,res)=>{
    res.render("dashboard.ejs");
})
app.listen(process.env.PORT,()=>{
    console.log("Running on http://localhost:3000");
})