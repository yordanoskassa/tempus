import { useState, useRef, useEffect, useCallback } from "react";
import "./App.css";
import VoiceAgent from "./VoiceAgent";

const WS_URL = "ws://localhost:8000/ws/detect";
const API_URL = "http://localhost:8000";
const FRAME_INTERVAL_MS = 100;

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
  const [analytics, setAnalytics] = useState(null);
  const [fps, setFps] = useState(0);
  const [mode, setMode] = useState("general");
  const [availableModes, setAvailableModes] = useState(["general"]);
  const [confidence, setConfidence] = useState(0.35);
  const [shapesEnabled, setShapesEnabled] = useState(true);
  const lastFrameTime = useRef(Date.now());

  useEffect(() => {
    fetch(`${API_URL}/status`)
      .then((r) => r.json())
      .then((data) => {
        setMode(data.mode);
        setAvailableModes(data.available_modes);
        setConfidence(data.conf_threshold);
        setShapesEnabled(data.shapes_enabled);
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

  const toggleShapes = async () => {
    const next = !shapesEnabled;
    setShapesEnabled(next);
    try {
      await fetch(`${API_URL}/shapes/${next}`, { method: "POST" });
    } catch {}
  };

  const startCamera = useCallback(async () => {
    setStreaming(true);
  }, []);

  useEffect(() => {
    // QNX frames are displayed by the MJPEG image below.
  }, [streaming]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
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
        if (data.analytics) setAnalytics(data.analytics);
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
      ws.send("qnx");
    };

    intervalRef.current = setInterval(sendFrame, FRAME_INTERVAL_MS);
    setDetecting(true);
  }, [detecting, streaming, connectWs]);

  // Draw overlays
  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    canvas.width = video.naturalWidth || 2304;
    canvas.height = video.naturalHeight || 1296;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (const det of detections) {
      const [x, y, w, h] = det.bbox;
      const [r, g, b] = det.color;
      const color = `rgb(${r}, ${g}, ${b})`;

      // Use dashed stroke for shapes, solid for YOLO
      if (det.type === "shape") {
        ctx.setLineDash([4, 4]);
      } else {
        ctx.setLineDash([]);
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      // Main label
      const label = `${det.label} ${Math.round(det.confidence * 100)}%`;
      ctx.font = "bold 11px sans-serif";
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 18, textWidth + 8, 18);
      ctx.fillStyle = "#000";
      ctx.fillText(label, x + 4, y - 5);

      // Morphology sub-label for blood cells
      if (det.morphology && det.morphology !== "Normal") {
        const mc = det.morph_color || [255, 255, 255];
        const morphColor = `rgb(${mc[0]}, ${mc[1]}, ${mc[2]})`;
        const morphLabel = det.morphology;
        const morphWidth = ctx.measureText(morphLabel).width;
        ctx.fillStyle = morphColor;
        ctx.fillRect(x, y + h, morphWidth + 8, 16);
        ctx.fillStyle = "#000";
        ctx.font = "bold 10px sans-serif";
        ctx.fillText(morphLabel, x + 4, y + h + 12);
      }
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

  // Separate summaries for YOLO, shapes, and morphology
  const yoloDets = detections.filter((d) => d.type === "yolo");
  const shapeDets = detections.filter((d) => d.type === "shape");

  const groupBy = (arr) =>
    arr.reduce((acc, d) => {
      acc[d.label] = acc[d.label] || { count: 0, color: d.color, maxConf: 0 };
      acc[d.label].count++;
      acc[d.label].maxConf = Math.max(acc[d.label].maxConf, d.confidence);
      return acc;
    }, {});

  const yoloSummary = groupBy(yoloDets);
  const shapeSummary = groupBy(shapeDets);

  // Morphology summary (only for blood cell mode)
  const morphSummary = {};
  for (const d of yoloDets) {
    if (d.morphology) {
      morphSummary[d.morphology] = morphSummary[d.morphology] || {
        count: 0,
        color: d.morph_color || [200, 200, 200],
      };
      morphSummary[d.morphology].count++;
    }
  }

  const totalDetections = detections.length;

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
              <img ref={videoRef} src={`${API_URL}/qnx/stream`} alt="QNX Camera Module 3" />
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
            <div className="toggle-row">
              <label>Shape Detection</label>
              <button
                className={`toggle-btn ${shapesEnabled ? "active" : ""}`}
                onClick={toggleShapes}
              >
                {shapesEnabled ? "ON" : "OFF"}
              </button>
            </div>
          </div>

          <div className="sidebar-section">
            <h3>Stats</h3>
            <div className="stats">
              <div className="stat-card">
                <div className="stat-value">{totalDetections}</div>
                <div className="stat-label">Total</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{detecting ? fps : 0}</div>
                <div className="stat-label">FPS</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{yoloDets.length}</div>
                <div className="stat-label">
                  {mode === "blood_cell" ? "Cells" : "Objects"}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{shapeDets.length}</div>
                <div className="stat-label">Shapes</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">
                  {analytics?.inference_ms ?? "—"}
                </div>
                <div className="stat-label">Latency (ms)</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">
                  {analytics?.coverage_pct ?? 0}%
                </div>
                <div className="stat-label">Coverage</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">
                  {analytics?.avg_cell_area ?? 0}
                </div>
                <div className="stat-label">Avg Area (px)</div>
              </div>
              <div className="stat-card highlight">
                <div className="stat-value">
                  {analytics?.abnormal_pct ?? 0}%
                </div>
                <div className="stat-label">Abnormal</div>
              </div>
            </div>
          </div>

          {/* Class Breakdown */}
          {analytics?.class_counts &&
            Object.keys(analytics.class_counts).length > 0 && (
              <div className="sidebar-section">
                <h3>Class Breakdown</h3>
                <div className="breakdown-list">
                  {Object.entries(analytics.class_counts).map(
                    ([cls, count]) => (
                      <div key={cls} className="breakdown-row">
                        <span className="breakdown-label">{cls}</span>
                        <span className="breakdown-value">{count}</span>
                        <div className="breakdown-bar-bg">
                          <div
                            className="breakdown-bar"
                            style={{
                              width: `${Math.min(
                                (count / (analytics.cell_count || 1)) * 100,
                                100
                              )}%`,
                            }}
                          />
                        </div>
                      </div>
                    )
                  )}
                </div>
              </div>
            )}

          {/* YOLO detections */}
          <div className="sidebar-section">
            <h3>{mode === "blood_cell" ? "Blood Cells" : "Objects"}</h3>
            <DetectionList summary={yoloSummary} detecting={detecting} />
          </div>

          {/* Shapes */}
          {shapesEnabled && (
            <div className="sidebar-section">
              <h3>Shapes</h3>
              <DetectionList summary={shapeSummary} detecting={detecting} />
            </div>
          )}

          {/* Cell Morphology */}
          {mode === "blood_cell" && Object.keys(morphSummary).length > 0 && (
            <div className="sidebar-section">
              <h3>Cell Morphology</h3>
              <ul className="detection-list">
                {Object.entries(morphSummary).map(([label, info]) => (
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
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="sidebar-section">
            <VoiceAgent />
          </div>
        </div>
      </div>

      <canvas ref={captureCanvasRef} style={{ display: "none" }} />
    </div>
  );
}

function DetectionList({ summary, detecting }) {
  if (Object.keys(summary).length === 0) {
    return (
      <p style={{ color: "#555", fontSize: 13 }}>
        {detecting ? "Analyzing..." : "Nothing detected yet"}
      </p>
    );
  }
  return (
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
  );
}

export default App;
