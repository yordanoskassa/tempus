import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";

const WS_URL = "ws://localhost:8000/ws/detect";
const API_URL = "http://localhost:8000";
const FRAME_INTERVAL_MS = 200;

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const wsRef = useRef(null);
  const intervalRef = useRef(null);
  const streamRef = useRef(null);

  const [streaming, setStreaming] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [detections, setDetections] = useState([]);
  const [fps, setFps] = useState(0);
  const [mode, setMode] = useState("general");
  const [availableModes, setAvailableModes] = useState(["general"]);
  const [confidence, setConfidence] = useState(0.35);
  const lastFrameTime = useRef(Date.now());

  // Fetch backend status on mount
  useEffect(() => {
    fetch(`${API_URL}/status`)
      .then((r) => r.json())
      .then((data) => {
        setMode(data.mode);
        setAvailableModes(data.available_modes);
        setConfidence(data.conf_threshold);
      })
      .catch(() => {});
  }, []);

  const switchMode = async (newMode) => {
    try {
      const res = await fetch(`${API_URL}/mode/${newMode}`, { method: "POST" });
      const data = await res.json();
      if (data.success) setMode(data.mode);
    } catch {}
  };

  const updateConfidence = async (val) => {
    setConfidence(val);
    try {
      await fetch(`${API_URL}/confidence/${val}`, { method: "POST" });
    } catch {}
  };

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: false,
      });
      streamRef.current = stream;
      setStreaming(true);
    } catch (err) {
      console.error("Camera access denied:", err);
    }
  }, []);

  useEffect(() => {
    if (streaming && videoRef.current && streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
    }
  }, [streaming]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    clearInterval(intervalRef.current);
    setStreaming(false);
    setDetecting(false);
    setDetections([]);
  }, []);

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;

    const ws = new WebSocket(WS_URL);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      setDetecting(false);
    };
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.detections) {
        setDetections(data.detections);
        if (data.mode) setMode(data.mode);
        const now = Date.now();
        setFps(Math.round(1000 / (now - lastFrameTime.current)));
        lastFrameTime.current = now;
      }
    };
    wsRef.current = ws;
  }, []);

  const toggleDetection = useCallback(() => {
    if (detecting) {
      clearInterval(intervalRef.current);
      setDetecting(false);
      setDetections([]);
      return;
    }

    if (!streaming) return;
    connectWs();

    const sendFrame = () => {
      const video = videoRef.current;
      const ws = wsRef.current;
      if (!video || !ws || ws.readyState !== WebSocket.OPEN) return;
      if (!video.videoWidth || !video.videoHeight) return;

      const canvas = captureCanvasRef.current;
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0);
      const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
      ws.send(dataUrl);
    };

    intervalRef.current = setInterval(sendFrame, FRAME_INTERVAL_MS);
    setDetecting(true);
  }, [detecting, streaming, connectWs]);

  // Draw detection overlays
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const det of detections) {
      const [x, y, w, h] = det.bbox;
      const [r, g, b] = det.color;
      const color = `rgb(${r}, ${g}, ${b})`;

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);

      const label = `${det.label} ${Math.round(det.confidence * 100)}%`;
      ctx.font = "bold 11px sans-serif";
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 18, textWidth + 8, 18);

      ctx.fillStyle = "#000";
      ctx.fillText(label, x + 4, y - 5);
    }
  }, [detections]);

  useEffect(() => {
    return () => {
      clearInterval(intervalRef.current);
      wsRef.current?.close();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  const summary = detections.reduce((acc, d) => {
    acc[d.label] = acc[d.label] || { count: 0, color: d.color, maxConf: 0 };
    acc[d.label].count++;
    acc[d.label].maxConf = Math.max(acc[d.label].maxConf, d.confidence);
    return acc;
  }, {});

  return (
    <div className="app">
      <header>
        <h1>
          Vetr<span>View</span>
        </h1>
        <div className="status">
          <div className={`status-dot ${connected ? "connected" : ""}`} />
          {connected ? `Connected - ${mode}` : "Backend disconnected"}
        </div>
      </header>

      <div className="main-content">
        <div className="camera-panel">
          {streaming ? (
            <div className="video-container">
              <video ref={videoRef} autoPlay playsInline muted />
              <canvas ref={canvasRef} />
            </div>
          ) : (
            <div className="no-camera">
              <p>No camera feed</p>
              <button onClick={startCamera}>Start Camera</button>
            </div>
          )}
        </div>

        <div className="sidebar">
          <div className="sidebar-section">
            <h3>Controls</h3>
            <div className="controls">
              <button
                className={streaming ? "active" : ""}
                onClick={streaming ? stopCamera : startCamera}
              >
                {streaming ? "Stop Camera" : "Start Camera"}
              </button>
              <button
                className={detecting ? "active" : ""}
                onClick={toggleDetection}
                disabled={!streaming}
              >
                {detecting ? "Stop Detection" : "Detect"}
              </button>
            </div>
          </div>

          <div className="sidebar-section">
            <h3>Model</h3>
            <div className="controls">
              {availableModes.map((m) => (
                <button
                  key={m}
                  className={mode === m ? "active" : ""}
                  onClick={() => switchMode(m)}
                >
                  {m === "general" ? "General" : "Blood Cell"}
                </button>
              ))}
            </div>
            <div className="confidence-row">
              <label>Confidence: {Math.round(confidence * 100)}%</label>
              <input
                type="range"
                min="5"
                max="95"
                value={Math.round(confidence * 100)}
                onChange={(e) => updateConfidence(e.target.value / 100)}
              />
            </div>
          </div>

          <div className="sidebar-section">
            <h3>Stats</h3>
            <div className="stats">
              <div className="stat-card">
                <div className="stat-value">{detections.length}</div>
                <div className="stat-label">Detections</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{detecting ? fps : 0}</div>
                <div className="stat-label">FPS</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">
                  {Object.keys(summary).length}
                </div>
                <div className="stat-label">Types</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">
                  {detections.length > 0
                    ? Math.round(
                        (detections.reduce((s, d) => s + d.confidence, 0) /
                          detections.length) *
                          100
                      )
                    : 0}
                  %
                </div>
                <div className="stat-label">Avg Conf</div>
              </div>
            </div>
          </div>

          <div className="sidebar-section">
            <h3>Detected {mode === "blood_cell" ? "Cells" : "Objects"}</h3>
            {Object.keys(summary).length === 0 ? (
              <p style={{ color: "#555", fontSize: 13 }}>
                {detecting
                  ? "Analyzing..."
                  : "Start detection to see results"}
              </p>
            ) : (
              <ul className="detection-list">
                {Object.entries(summary).map(([label, info]) => (
                  <li key={label} className="detection-item">
                    <div className="detection-label">
                      <div
                        className="detection-color"
                        style={{
                          background: `rgb(${info.color[0]}, ${info.color[1]}, ${info.color[2]})`,
                        }}
                      />
                      {label}
                      {info.count > 1 && (
                        <span style={{ color: "#666" }}> x{info.count}</span>
                      )}
                    </div>
                    <span className="detection-confidence">
                      {Math.round(info.maxConf * 100)}%
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>

      <canvas ref={captureCanvasRef} style={{ display: "none" }} />
    </div>
  );
}

export default App;
