import { useState, useRef, useCallback, useEffect } from "react";

const VOICE_WS_URL = "ws://localhost:8000/ws/voice";

export default function VoiceAgent() {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState("idle"); // idle | connecting | listening | agent_speaking
  const [transcript, setTranscript] = useState([]);
  const [error, setError] = useState(null);

  const wsRef = useRef(null);
  const micStreamRef = useRef(null);
  const processorRef = useRef(null);
  const audioCtxRef = useRef(null);
  const playbackCtxRef = useRef(null);
  const nextPlayTimeRef = useRef(0);

  const cleanup = useCallback(() => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((t) => t.stop());
      micStreamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (playbackCtxRef.current) {
      playbackCtxRef.current.close().catch(() => {});
      playbackCtxRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    nextPlayTimeRef.current = 0;
    setActive(false);
    setStatus("idle");
  }, []);

  const playAudioChunk = useCallback((pcmData) => {
    if (!playbackCtxRef.current) {
      playbackCtxRef.current = new AudioContext({ sampleRate: 24000 });
    }
    const ctx = playbackCtxRef.current;
    const int16 = new Int16Array(
      pcmData.buffer,
      pcmData.byteOffset,
      pcmData.byteLength / 2
    );
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 32768;
    }

    const buffer = ctx.createBuffer(1, float32.length, 24000);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);

    const now = ctx.currentTime;
    const startTime = Math.max(now, nextPlayTimeRef.current);
    source.start(startTime);
    nextPlayTimeRef.current = startTime + buffer.duration;
  }, []);

  const startVoice = useCallback(async () => {
    setError(null);
    setTranscript([]);
    setStatus("connecting");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      micStreamRef.current = stream;

      const ws = new WebSocket(VOICE_WS_URL);
      wsRef.current = ws;

      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        setActive(true);
        setStatus("listening");

        // Set up mic capture
        const audioCtx = new AudioContext({ sampleRate: 16000 });
        audioCtxRef.current = audioCtx;
        const source = audioCtx.createMediaStreamSource(stream);
        const processor = audioCtx.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (e) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          const float32 = e.inputBuffer.getChannelData(0);
          const int16 = new Int16Array(float32.length);
          for (let i = 0; i < float32.length; i++) {
            const s = Math.max(-1, Math.min(1, float32[i]));
            int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          ws.send(int16.buffer);
        };

        source.connect(processor);
        processor.connect(audioCtx.destination);
      };

      ws.onmessage = (e) => {
        if (e.data instanceof ArrayBuffer) {
          playAudioChunk(new Uint8Array(e.data));
          return;
        }

        try {
          const msg = JSON.parse(e.data);

          if (msg.error) {
            setError(msg.error);
            cleanup();
            return;
          }

          if (msg.type === "ConversationText") {
            setTranscript((prev) => [
              ...prev,
              { role: msg.role, text: msg.content },
            ]);
          } else if (msg.type === "AgentStartedSpeaking") {
            setStatus("agent_speaking");
          } else if (msg.type === "AgentAudioDone") {
            setStatus("listening");
          } else if (msg.type === "UserStartedSpeaking") {
            setStatus("listening");
            // Reset playback queue when user interrupts
            nextPlayTimeRef.current = 0;
            if (playbackCtxRef.current) {
              playbackCtxRef.current.close().catch(() => {});
              playbackCtxRef.current = null;
            }
          }
        } catch {
          // non-JSON text, ignore
        }
      };

      ws.onclose = () => {
        cleanup();
      };

      ws.onerror = () => {
        setError("WebSocket connection failed");
        cleanup();
      };
    } catch (err) {
      setError(err.message || "Mic access denied");
      cleanup();
    }
  }, [cleanup, playAudioChunk]);

  const endVoice = useCallback(() => {
    cleanup();
  }, [cleanup]);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const statusLabel =
    status === "idle"
      ? "Ready"
      : status === "connecting"
      ? "Connecting..."
      : status === "listening"
      ? "Listening"
      : "Agent speaking";

  const statusClass =
    status === "listening"
      ? "voice-status-listening"
      : status === "agent_speaking"
      ? "voice-status-speaking"
      : "";

  return (
    <div className="voice-panel">
      <h3>Voice Assistant</h3>

      {error && <div className="voice-error">{error}</div>}

      <div className="voice-controls">
        <button
          className={`voice-btn ${active ? "voice-btn-active" : ""}`}
          onClick={active ? endVoice : startVoice}
        >
          {active ? "End Voice" : "Start Voice"}
        </button>
        <div className={`voice-status ${statusClass}`}>
          <div className="voice-status-dot" />
          {statusLabel}
        </div>
      </div>

      {transcript.length > 0 && (
        <div className="voice-transcript">
          {transcript.map((entry, i) => (
            <div key={i} className={`voice-msg voice-msg-${entry.role}`}>
              <span className="voice-msg-role">
                {entry.role === "user" ? "You" : "Assistant"}
              </span>
              <span className="voice-msg-text">{entry.text}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
