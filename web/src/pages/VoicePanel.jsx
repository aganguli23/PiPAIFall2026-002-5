// Voice intake: a React port of the RealtimeVoiceChat browser client (MIT, github.com/KoljaB/RealtimeVoiceChat; see
// public/voice/NOTICE.txt). Mic -> PCM worklet (24 kHz int16) -> 2048-sample frames with the 8-byte RVC header ->
// WebSocket -> server (cloud speech-to-text -> Claude Sonnet 5.5 -> cloud text-to-speech) -> tts_chunk -> playback worklet.
import { useEffect, useRef, useState } from "react";
import { api, wsUrl } from "../api.js";

const RATE = 24000, BATCH = 2048, HEADER = 8;
const WORKLETS = import.meta.env.BASE_URL + "voice/";

function b64ToInt16(b64) {
  const raw = atob(b64);
  const buf = new ArrayBuffer(raw.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < raw.length; i++) view[i] = raw.charCodeAt(i);
  return new Int16Array(buf);
}

export default function VoicePanel({ sid, compact, autoStart, onLive, onUser, onUserPartial, onAssistantPartial, onAssistant, onForm, onStop }) {
  const [status, setStatus] = useState(null);
  const [state, setState] = useState("idle"); // idle | starting | live | error
  const [msg, setMsg] = useState("");
  const r = useRef({});

  useEffect(() => { api.get("/voice/status").then(setStatus).catch(() => setStatus({ enabled: false })); return () => stop(); }, []);
  useEffect(() => { if (autoStart && status?.enabled && state === "idle" && !r.current.tried) { r.current.tried = true; start(); } }, [status]);
  useEffect(() => { onLive?.(state === "live"); }, [state]);

  const send = (o) => { const s = r.current.socket; if (s && s.readyState === WebSocket.OPEN) s.send(o); };

  const start = async () => {
    setState("starting");
    setMsg("");
    try {
      const ctx = new AudioContext({ sampleRate: RATE });
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      // A context created outside a tap (auto-start) can begin "suspended": nothing is recorded or played until resumed.
      if (ctx.state !== "running") await ctx.resume().catch(() => {});
      if (ctx.state !== "running") {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
        setState("idle");
        setMsg("Tap the mic to start talking.");
        return;
      }
      await ctx.audioWorklet.addModule(WORKLETS + "pcmWorkletProcessor.js");
      await ctx.audioWorklet.addModule(WORKLETS + "ttsPlaybackProcessor.js");
      const tts = new AudioWorkletNode(ctx, "tts-playback-processor");
      tts.connect(ctx.destination);
      const mic = new AudioWorkletNode(ctx, "pcm-worklet-processor");
      const socket = new WebSocket(wsUrl(`/ws/voice?sid=${sid}`));
      socket.binaryType = "arraybuffer";
      Object.assign(r.current, { ctx, stream, tts, mic, socket, playing: false, buf: null, off: 0 });

      tts.port.onmessage = ({ data }) => {
        if (data.type === "ttsPlaybackStarted" && !r.current.playing) { r.current.playing = true; send(JSON.stringify({ type: "tts_start" })); }
        if (data.type === "ttsPlaybackStopped" && r.current.playing) { r.current.playing = false; send(JSON.stringify({ type: "tts_stop" })); }
      };
      mic.port.onmessage = ({ data }) => {
        const inc = new Int16Array(data);
        let read = 0;
        while (read < inc.length) {
          const c = r.current;
          if (!c.buf) { c.buf = new ArrayBuffer(HEADER + BATCH * 2); c.view = new DataView(c.buf); c.pcm = new Int16Array(c.buf, HEADER); c.off = 0; }
          const n = Math.min(inc.length - read, BATCH - c.off);
          c.pcm.set(inc.subarray(read, read + n), c.off);
          c.off += n; read += n;
          if (c.off === BATCH) {
            c.view.setUint32(0, Date.now() & 0xffffffff, false);
            c.view.setUint32(4, c.playing ? 1 : 0, false);
            send(c.buf);
            c.buf = null;
          }
        }
      };
      socket.onopen = () => { ctx.createMediaStreamSource(stream).connect(mic); setState("live"); };
      socket.onmessage = ({ data }) => {
        let m; try { m = JSON.parse(data); } catch { return; }
        const c = m.content;
        if (m.type === "partial_user_request") onUserPartial?.(c);
        else if (m.type === "final_user_request") onUser?.(c);
        else if (m.type === "partial_assistant_answer") onAssistantPartial?.(c);
        else if (m.type === "final_assistant_answer") onAssistant?.(c);
        else if (m.type === "tts_chunk") tts.port.postMessage(b64ToInt16(c));
        else if (m.type === "tts_interruption" || m.type === "stop_tts") tts.port.postMessage({ type: "clear" });
        else if (m.type === "form_update") onForm?.(c);
      };
      socket.onclose = (e) => { if (e.code === 4401) setMsg("Please sign in again."); stop(); };
      socket.onerror = () => setMsg("Voice connection failed.");
    } catch (e) {
      setMsg(e.name === "NotAllowedError" ? "Microphone access was blocked. Allow it in your browser, or use the chat box."
        : `Voice could not start (${e.message}). Chrome, Edge or Safari work best; the chat box always works.`);
      stop();
      setState("error");
    }
  };

  function stop() {
    const c = r.current;
    try { c.mic?.disconnect(); c.tts?.disconnect(); } catch { /* already gone */ }
    c.stream?.getTracks().forEach((t) => t.stop());
    if (c.socket && c.socket.readyState <= 1) c.socket.close();
    if (c.ctx && c.ctx.state !== "closed") c.ctx.close();
    const was = !!c.socket;
    r.current = {};
    setState((s) => (s === "error" ? s : "idle"));
    if (was) onStop?.();
  }

  if (compact) {
    if (status && !status.enabled) return null;
    return (
      <>
        <button type="button" className={"ims-mic " + state} onClick={state === "live" ? stop : start} disabled={state === "starting"}
          aria-label={state === "live" ? "Stop talking" : "Talk instead of typing"} title={state === "live" ? "Stop voice" : "Talk instead of typing"}>
          {state === "live" ? <span className="ims-wave"><i /><i /><i /><i /></span>
            : <svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" /></svg>}
        </button>
        {msg && <div className="ims-voice-err">{msg}</div>}
      </>
    );
  }
  if (status && !status.enabled) return <div className="voice muted small">Voice isn't available right now; please use the chat.</div>;
  return (
    <div className={"voice " + state}>
      {state === "live" ? (
        <div className="row">
          <span className="pulse" /> <b>Listening.</b> <span className="muted small">Just talk; you can interrupt the assistant anytime.</span>
          <button className="secondary small" onClick={stop}>Stop voice</button>
        </div>
      ) : (
        <div className="row">
          <button className="primary small" onClick={start} disabled={state === "starting"}>{state === "starting" ? "Starting…" : "🎙 Talk instead of typing"}</button>
          <span className="muted small">Speech is transcribed and spoken by cloud services; the form fills in as you talk.</span>
        </div>
      )}
      {msg && <div className="error small">{msg}</div>}
    </div>
  );
}
