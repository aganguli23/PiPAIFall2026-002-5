"""Voice intake: the server side of the RealtimeVoiceChat (MIT, github.com/KoljaB/RealtimeVoiceChat) WebSocket protocol,
with RVC's local Whisper/LLM/Coqui stack swapped for cloud speech (option A) and the same Claude Sonnet 5.5 agent as chat.

Client -> server:  binary frames = 8-byte header (uint32 BE timestamp ms, uint32 BE flags; bit0 = TTS playing)
                   + 2048 int16 mono PCM samples at 24 kHz;  JSON {type: tts_start | tts_stop | clear_history | set_speed}
Server -> client:  JSON {type, content}: partial_user_request, final_user_request, partial_assistant_answer,
                   final_assistant_answer, tts_chunk (base64 int16 PCM 24 kHz), tts_interruption, stop_tts
                   + Lotwise extension {type: form_update, content: {fields, field_meta, missing, subject}}

Pipeline per utterance: energy VAD (end of speech) -> gpt-4o-mini-transcribe -> intake agent (streams text) ->
sentence chunker -> gpt-4o-mini-tts (pcm, streamed) -> tts_chunk. Seller speech while the assistant talks = barge-in."""
import asyncio
import base64
import io
import json
import logging
import math
import re
import struct
import wave
from array import array
from collections import deque

from fastapi import WebSocket, WebSocketDisconnect
from openai import AsyncOpenAI

from . import auth, db
from . import intake_agent as agent
from . import intake_fields as F
from . import usage
from .config import OPENAI_API_KEY, STT_MODEL, TTS_MODEL, TTS_VOICE

log = logging.getLogger("lotwise.voice")
RATE = 24000
STT_PROMPT = ("New York City real estate seller describing a property: development site, BBL, block and lot, zoning, FAR, "
              "air rights, ground lease, fee simple, DOB, rent-stabilized units, cap rate, Brooklyn, Queens, Bronx, Manhattan, Staten Island.")
TTS_STYLE = "Warm, clear and professional, like a helpful real estate analyst. Natural, brisk pace."
_oai: AsyncOpenAI | None = None


def oai() -> AsyncOpenAI | None:
    global _oai
    if _oai is None and OPENAI_API_KEY:
        _oai = AsyncOpenAI(api_key=OPENAI_API_KEY)
    return _oai


def enabled() -> bool:
    return bool(OPENAI_API_KEY) and agent.client() is not None


class EnergyVAD:
    """Adaptive-noise-floor energy VAD over ~85 ms frames. Returns 'start' when speech begins and the utterance bytes
    when it ends (enough trailing silence)."""

    def __init__(self, start_frames=2, end_silence_ms=750, min_speech_ms=350, max_ms=30000, preroll=3):
        self.floor, self.in_speech, self.hot, self.silent = 150.0, False, 0, 0
        self.buf = bytearray()
        self.pre = deque(maxlen=preroll)
        self.start_frames, self.end_ms, self.min_ms, self.max_ms = start_frames, end_silence_ms, min_speech_ms, max_ms
        self.speech_ms = 0.0

    @staticmethod
    def rms(pcm: bytes) -> float:
        a = array("h", pcm[: len(pcm) // 2 * 2])
        return math.sqrt(sum(x * x for x in a) / len(a)) if a else 0.0

    def feed(self, pcm: bytes, tts_playing: bool):
        e = self.rms(pcm)
        ms = len(pcm) / 2 / RATE * 1000
        thresh = max(450.0, self.floor * 3.0) * (1.8 if tts_playing else 1.0)
        loud = e > thresh
        if not self.in_speech:
            self.pre.append(pcm)
            self.floor = 0.95 * self.floor + 0.05 * min(e, 3000) if not loud else self.floor
            self.hot = self.hot + 1 if loud else 0
            if self.hot >= self.start_frames:
                self.in_speech, self.silent, self.speech_ms = True, 0, 0.0
                self.buf = bytearray(b"".join(self.pre))
                return "start"
            return None
        self.buf += pcm
        self.speech_ms += ms
        self.silent = 0 if loud else self.silent + ms
        if self.silent >= self.end_ms or self.speech_ms >= self.max_ms:
            self.in_speech, self.hot = False, 0
            out, self.buf = bytes(self.buf), bytearray()
            self.pre.clear()
            return out if self.speech_ms - self.silent >= self.min_ms else None
        return None


def to_wav(pcm: bytes) -> bytes:
    bio = io.BytesIO()
    with wave.open(bio, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm)
    return bio.getvalue()


SENTENCE_END = re.compile(r"(.+?[.!?])(\s+|$)", re.S)


class VoiceSession:
    def __init__(self, ws: WebSocket, user: dict, sid: int):
        self.ws, self.user, self.sid = ws, user, sid
        self.vad = EnergyVAD()
        self.tts_playing = False
        self.task: asyncio.Task | None = None
        self.send_lock = asyncio.Lock()

    async def send(self, type_: str, content):
        async with self.send_lock:
            await self.ws.send_text(json.dumps({"type": type_, "content": content}, default=str))

    async def interrupt(self):
        if self.task and not self.task.done():
            self.task.cancel()
        await self.send("tts_interruption", None)
        await self.send("stop_tts", None)

    async def on_audio(self, data: bytes):
        if len(data) <= 8:
            return
        _, flags = struct.unpack(">II", data[:8])
        self.tts_playing = bool(flags & 1)                 # the client's per-frame flag is authoritative
        ev = self.vad.feed(data[8:], self.tts_playing)
        if ev == "start":
            if self.tts_playing or (self.task and not self.task.done()):
                await self.interrupt()                          # barge-in
            await self.send("partial_user_request", "…")
        elif isinstance(ev, (bytes, bytearray)):
            if self.task and not self.task.done():
                self.task.cancel()
            self.task = asyncio.create_task(self.respond(bytes(ev)))

    async def tts(self, sentence: str):
        await asyncio.to_thread(usage.record, self.user["id"], tts_chars=len(sentence))
        carry = b""
        async with oai().audio.speech.with_streaming_response.create(
                model=TTS_MODEL, voice=TTS_VOICE, input=sentence, response_format="pcm", instructions=TTS_STYLE) as resp:
            async for chunk in resp.iter_bytes(9600):
                chunk = carry + chunk
                cut = len(chunk) // 2 * 2
                carry = chunk[cut:]
                if cut:
                    await self.send("tts_chunk", base64.b64encode(chunk[:cut]).decode())

    async def respond(self, pcm: bytes):
        try:
            secs = len(pcm) / 2 / RATE
            await asyncio.to_thread(usage.record, self.user["id"], voice_sec=secs)
            block = await asyncio.to_thread(usage.voice_block, self.user["id"])
            if block:
                await self.send("final_assistant_answer", "That's today's limit for voice, so let's keep going in the "
                                                         "chat box. Just type your answer.")
                await self.ws.close(code=4429)
                return
            tr = await oai().audio.transcriptions.create(model=STT_MODEL, file=("speech.wav", to_wav(pcm), "audio/wav"),
                                                         language="en", prompt=STT_PROMPT)
            text = (tr.text or "").strip()
            if len(re.sub(r"\W", "", text)) < 2:
                await self.send("final_user_request", "")
                return
            await self.send("final_user_request", text)

            q: asyncio.Queue = asyncio.Queue()
            spoken = {"full": "", "pending": ""}

            async def speaker():
                while (s := await q.get()) is not None:
                    try:
                        await self.tts(s)
                    except Exception:
                        log.exception("tts failed")

            sp = asyncio.create_task(speaker())

            async def on_text(delta: str):
                spoken["full"] += delta
                spoken["pending"] += delta
                await self.send("partial_assistant_answer", spoken["full"])
                while (m := SENTENCE_END.match(spoken["pending"])) and len(m.group(1)) > 12:
                    await q.put(m.group(1).strip())
                    spoken["pending"] = spoken["pending"][m.end():]

            async def on_form(fields, meta, subject):
                await self.send("form_update", {"fields": fields, "missing": F.missing(fields), "subject": subject,
                                                "field_meta": {k: v for k, v in meta.items() if not k.startswith("_")}})

            s = await asyncio.to_thread(db.one, "SELECT * FROM intake_sessions WHERE id = %s", (self.sid,))
            out = await agent.run_turn(s, text, mode="voice", on_text=on_text, on_form=on_form)
            if spoken["pending"].strip():
                await q.put(spoken["pending"].strip())
            if not spoken["full"]:
                await q.put(out["text"])                     # fallback path produced text without streaming
            await q.put(None)
            from .routes_intake import save_turn
            await asyncio.to_thread(save_turn, self.sid, out)
            await self.send("final_assistant_answer", out["text"])
            await self.send("form_update", {"fields": out["fields"], "missing": F.missing(out["fields"]),
                                            "subject": out["subject"],
                                            "field_meta": {k: v for k, v in out["field_meta"].items() if not k.startswith("_")}})
            await sp
        except asyncio.CancelledError:
            raise
        except Exception:
            log.exception("voice turn failed")
            await self.send("final_assistant_answer", "Sorry, I had trouble with that. Could you say it again?")


async def voice_ws(ws: WebSocket):
    await ws.accept()
    user = await asyncio.to_thread(auth.user_for_token, ws.cookies.get("lotwise_session"))
    try:
        sid = int(ws.query_params.get("sid", "0"))
    except ValueError:
        sid = 0
    own = user and sid and await asyncio.to_thread(
        db.one, "SELECT id FROM intake_sessions WHERE id = %s AND user_id = %s", (sid, user["id"]))
    if not own:
        await ws.send_text(json.dumps({"type": "final_assistant_answer", "content": "Please sign in and start an intake first."}))
        await ws.close(code=4401)
        return
    block = await asyncio.to_thread(usage.voice_block, user["id"])
    if block:
        await ws.send_text(json.dumps({"type": "final_assistant_answer",
                                       "content": "Voice has reached today's limit. The chat box still works."}))
        await ws.close(code=4429)
        return
    if not enabled():
        await ws.send_text(json.dumps({"type": "final_assistant_answer", "content": "Voice is not configured on this server."}))
        await ws.close()
        return
    vs = VoiceSession(ws, user, sid)
    await asyncio.to_thread(db.run, "UPDATE intake_sessions SET mode = 'voice' WHERE id = %s RETURNING id", (sid,))
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if msg.get("bytes"):
                await vs.on_audio(msg["bytes"])
            elif msg.get("text"):
                try:
                    data = json.loads(msg["text"])
                except ValueError:
                    continue
                t = data.get("type")
                if t == "tts_start":
                    vs.tts_playing = True
                elif t == "tts_stop":
                    vs.tts_playing = False
    except WebSocketDisconnect:
        pass
    finally:
        if vs.task and not vs.task.done():
            vs.task.cancel()
