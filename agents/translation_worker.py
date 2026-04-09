#!/usr/bin/env python3
"""
LiveKit translation worker for one language lane.

Usage example:
python agents/translation_worker.py --target-language Hindi --room translation-hi

Required env:
- LIVEKIT_URL
- LIVEKIT_API_KEY
- LIVEKIT_API_SECRET
- OPENROUTER_API_KEY
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from dataclasses import dataclass

from livekit.agents import Agent, AgentSession, AutoSubscribe, JobContext, JobRequest, WorkerOptions, cli
from livekit.plugins.openai.realtime import RealtimeModel
from livekit.plugins import silero

OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
OPENROUTER_MODEL = "qwen/qwen3.6-plus"


@dataclass
class WorkerConfig:
    target_language: str
    room_name: str


def build_system_instruction(target_language: str) -> str:
    return (f"You are a professional interpreter. Translate English audio to {target_language} accurately. Output only the translated text.")

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="LiveKit + OpenRouter translation lane worker")
    parser.add_argument(
        "--target-language",
        required=True,
        choices=["Hindi", "Bengali", "Tamil"],
        help="Target language for this lane",
    )
    parser.add_argument(
        "--room",
        required=True,
        help="LiveKit room this worker is dedicated to (example: translation-hi)",
    )
    return parser.parse_args()


def _load_config_from_env() -> WorkerConfig:
    target_language = os.getenv("TRANSLATION_TARGET_LANGUAGE", "").strip()
    room_name = os.getenv("TRANSLATION_ROOM_NAME", "").strip()

    if not target_language:
        raise RuntimeError("TRANSLATION_TARGET_LANGUAGE is required")
    if not room_name:
        raise RuntimeError("TRANSLATION_ROOM_NAME is required")

    return WorkerConfig(target_language=target_language, room_name=room_name)


async def entrypoint(ctx: JobContext):
    """Main entrypoint for the translation worker."""
    cfg = _load_config_from_env()

    await ctx.connect()

    if ctx.room.name != cfg.room_name:
        ctx.shutdown(f"room mismatch: expected {cfg.room_name}, got {ctx.room.name}")
        return

    siliconflow_key = os.getenv("OPENROUTER_API_KEY", "").strip()
    if not siliconflow_key:
        raise RuntimeError("OPENROUTER_API_KEY is required")

    import aiohttp
    http_session = aiohttp.ClientSession(
        headers={
            "HTTP-Referer": "http://localhost:3000",
            "X-Title": "LiveLingo Project"
        }
    )

    model = RealtimeModel(
        api_key=siliconflow_key,
        base_url=OPENROUTER_BASE_URL,    
        model=OPENROUTER_MODEL,
        modalities=["audio", "text"],     
        temperature=0.1,
        http_session=http_session
    )

    agent = Agent(
        instructions=build_system_instruction(cfg.target_language)
    )

    # Implement Skip-on-Lag
    session = AgentSession(
        vad=silero.VAD.load(),
        llm=model,
    )
    # Optional logic to discard frames if the queue builds up
    # In some LiveKit agents versions, skip-on-lag logic might vary, 
    # but normally the pipeline handles queue truncation on newer VAD frames.
    
    await session.start(agent=agent, room=ctx.room)

    room_disconnected = asyncio.Future[None]()

    @ctx.room.on("disconnected")
    def _on_room_disconnected(*_: object) -> None:
        if not room_disconnected.done():
            room_disconnected.set_result(None)

    await room_disconnected


def main() -> None:
    args = parse_args()

    os.environ["TRANSLATION_TARGET_LANGUAGE"] = args.target_language
    os.environ["TRANSLATION_ROOM_NAME"] = args.room

    if not os.getenv("LIVEKIT_URL"):
        raise RuntimeError("LIVEKIT_URL is required")
    if not os.getenv("LIVEKIT_API_KEY"):
        raise RuntimeError("LIVEKIT_API_KEY is required")
    if not os.getenv("LIVEKIT_API_SECRET"):
        raise RuntimeError("LIVEKIT_API_SECRET is required")

    # livekit.agents CLI parses argv internally. Since this script already consumes
    # custom args (--target-language, --room), reset argv to avoid parse collisions.
    sys.argv = [sys.argv[0], "start"]

    worker_port = int(os.getenv("WORKER_PORT", "8081"))
    target_room = args.room

    async def request_fnc(request: JobRequest) -> None:
        print(f"Received request: {request.room.name} at {target_room}", flush=True)
        if request.room.name != target_room:
            await request.reject(terminate=False)
            return
        await request.accept()

    cli.run_app(
        WorkerOptions(
            entrypoint_fnc=entrypoint,
            request_fnc=request_fnc,
            port=worker_port,
            agent_name=target_room,
        )
    )


if __name__ == "__main__":
    main()
