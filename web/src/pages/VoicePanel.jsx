// SKELETON voice panel. The first full draft replaces this with the RealtimeVoiceChat browser client
// (mic -> PCM worklet -> WebSocket -> cloud speech-to-text -> Claude Haiku -> cloud text-to-speech -> playback worklet).
import { useEffect, useState } from "react";
import { api } from "../api.js";

export default function VoicePanel() {
  const [status, setStatus] = useState(null);
  useEffect(() => { api.get("/voice/status").then(setStatus).catch(() => {}); }, []);
  return (
    <div className="voice placeholder">
      <b>Voice mode</b> — {status?.note || "checking…"} Use the chat box below for now.
    </div>
  );
}
