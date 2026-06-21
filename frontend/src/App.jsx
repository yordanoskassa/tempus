import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import "./App.css";
import VoiceAgent from "./VoiceAgent";

const WS_URL = "ws://localhost:8000/ws/detect";
const API_URL = "http://localhost:8000";
const FRAME_INTERVAL_MS = 100;

// ─── Utility: animated value hook ───
function useAnimatedValue(target, duration = 600) {
  const [display, setDisplay] = useState(target);
  const rafRef = useRef(null);
  const startRef = useRef({ value: target, time: 0 });

  useEffect(() => {
    const startVal = display;
    const startTime = performance.now();
    startRef.current = { value: startVal, time: startTime };

    const animate = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
      setDisplay(startVal + (target - startVal) * eased);
      if (progress < 1) rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, [target, duration]);

  return display;
}

// ─── Format elapsed time ───
function formatTime(seconds) {
  const m = Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ─── Generate session ID ───
function genSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ─── Sub-component: HeaderBar ───
function HeaderBar({
  backendConnected,
  qnxConnected,
  voiceActive,
  sessionElapsed,
  detecting,
  operationMode,
  setOperationMode,
  flaggedForReview,
}) {
  return (
    <div className="header-bar">
      <div className="header-brand">
        <h1>
          Vetr<span>View</span>
        </h1>
        <span className="brand-tag">Lab Dashboard</span>
      </div>

      <div className="header-center">
        <div className="conn-pills">
          <div className={`conn-pill ${qnxConnected ? "conn-active" : ""}`}>
            <div className="conn-dot" />
            QNX
          </div>
          <div className={`conn-pill ${backendConnected ? "conn-active" : ""}`}>
            <div className="conn-dot" />
            Backend
          </div>
          <div className={`conn-pill ${voiceActive ? "conn-active" : ""}`}>
            <div className="conn-dot" />
            Voice
          </div>
        </div>

        {detecting && (
          <div className="session-timer mono">{formatTime(sessionElapsed)}</div>
        )}

        {flaggedForReview && (
          <div className="flagged-banner">FLAGGED FOR REVIEW</div>
        )}
      </div>

      <div className="header-right">
        <div className="mode-toggle">
          <button
            className={operationMode === "auto" ? "mode-active" : ""}
            onClick={() => setOperationMode("auto")}
          >
            Auto
          </button>
          <button
            className={operationMode === "review" ? "mode-active" : ""}
            onClick={() => setOperationMode("review")}
          >
            Review
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-component: AbnormalGauge ───
function AbnormalGauge({ value, alertLevel }) {
  const radius = 80;
  const circumference = 2 * Math.PI * radius;
  const clampedValue = Math.min(Math.max(value, 0), 100);
  const strokeDashoffset = circumference - (clampedValue / 100) * circumference;
  const animatedVal = useAnimatedValue(clampedValue);

  return (
    <div className="gauge-container">
      <svg viewBox="0 0 200 200" className="gauge-svg">
        <circle className="gauge-track" cx="100" cy="100" r={radius} />
        <circle
          className={`gauge-fill gauge-${alertLevel}`}
          cx="100"
          cy="100"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
        />
      </svg>
      <div className="gauge-value">
        <span className="gauge-number mono">{animatedVal.toFixed(1)}</span>
        <span className="gauge-unit">%</span>
        <span className="gauge-label">Abnormal</span>
      </div>
      <div className={`gauge-alert-badge badge-${alertLevel}`}>
        {alertLevel === "normal"
          ? "Normal"
          : alertLevel === "warning"
          ? "Warning"
          : "Critical"}
      </div>
    </div>
  );
}

// ─── Sub-component: LiveStatsGrid ───
function LiveStatsGrid({ analytics, fps, detecting, totalDetections, mode }) {
  const yoloCount = analytics?.cell_count ?? 0;
  const shapeCount = analytics?.shape_count ?? 0;

  return (
    <div>
      <div className="section-title">Live Statistics</div>
      <div className="stats-grid">
        <div className="stat-card-v2">
          <div className="stat-val mono">{totalDetections}</div>
          <div className="stat-lbl">Total</div>
        </div>
        <div className="stat-card-v2">
          <div className="stat-val mono">{detecting ? fps : 0}</div>
          <div className="stat-lbl">FPS</div>
        </div>
        <div className="stat-card-v2">
          <div className="stat-val mono">{yoloCount}</div>
          <div className="stat-lbl">{mode === "blood_cell" ? "Cells" : "Objects"}</div>
        </div>
        <div className="stat-card-v2">
          <div className="stat-val mono">{shapeCount}</div>
          <div className="stat-lbl">Shapes</div>
        </div>
        <div className="stat-card-v2">
          <div className="stat-val mono">{analytics?.inference_ms ?? "—"}</div>
          <div className="stat-lbl">Latency ms</div>
        </div>
        <div className="stat-card-v2">
          <div className="stat-val mono">{analytics?.coverage_pct ?? 0}%</div>
          <div className="stat-lbl">Coverage</div>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-component: MorphologyBars ───
function MorphologyBars({ morphologyCounts, totalCells }) {
  if (!morphologyCounts || Object.keys(morphologyCounts).length === 0) return null;

  const morphColors = {
    Normal: "#00e676",
    Sickle: "#e63946",
    Teardrop: "#f4a261",
    Acanthocyte: "#ff6b6b",
    "Burr/Echinocyte": "#e76f51",
    Spherocyte: "#f4845f",
    Elliptocyte: "#ffb703",
    Target: "#fb8500",
    "N/A": "#556b8a",
  };

  const sorted = Object.entries(morphologyCounts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...sorted.map(([, c]) => c), 1);

  return (
    <div>
      <div className="section-title">Morphology</div>
      <div className="morph-bars">
        {sorted.map(([label, count]) => (
          <div key={label} className="morph-bar-item">
            <div className="morph-bar-header">
              <span className="morph-bar-label">{label}</span>
              <span className="morph-bar-count">{count}</span>
            </div>
            <div className="morph-bar-track">
              <div
                className="morph-bar-fill"
                style={{
                  width: `${(count / max) * 100}%`,
                  background: morphColors[label] || "#00b4d8",
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Sub-component: ClassBreakdownChips ───
function ClassBreakdownChips({ classCounts }) {
  if (!classCounts || Object.keys(classCounts).length === 0) return null;

  const classColors = {
    RBC: "#e63946",
    WBC: "#00b4d8",
    Platelet: "#f4a261",
  };

  return (
    <div>
      <div className="section-title">Class Breakdown</div>
      <div className="class-chips">
        {Object.entries(classCounts).map(([cls, count]) => (
          <div key={cls} className="class-chip">
            <div
              className="chip-dot"
              style={{ background: classColors[cls] || "#00b4d8" }}
            />
            <span>{cls}</span>
            <span className="chip-count">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Sub-component: AssessmentSummary ───
function AssessmentSummary({ analytics, alertLevel, detecting }) {
  const assessment = useMemo(() => {
    if (!analytics || !detecting) return null;

    const parts = [];
    const cellCount = analytics.cell_count || 0;
    const abnormal = analytics.abnormal_pct || 0;
    const morph = analytics.morphology_counts || {};
    const classes = analytics.class_counts || {};

    if (cellCount > 0) {
      parts.push(`Analyzing ${cellCount} cells in field of view.`);
    }

    const abnormalTypes = Object.entries(morph).filter(
      ([k]) => k !== "Normal" && k !== "N/A"
    );
    if (abnormalTypes.length > 0) {
      const desc = abnormalTypes.map(([k, v]) => `${v} ${k}`).join(", ");
      parts.push(`Abnormal morphologies: ${desc}.`);
    }

    if (Object.keys(classes).length > 0) {
      const desc = Object.entries(classes)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      parts.push(`Classification: ${desc}.`);
    }

    if (abnormal > 30) {
      parts.push("RECOMMENDATION: Immediate review by certified technician required.");
    } else if (abnormal > 10) {
      parts.push("RECOMMENDATION: Close monitoring advised.");
    }

    return parts.join(" ");
  }, [analytics, detecting]);

  return (
    <div>
      <div className="section-title">Assessment</div>
      <div className={`assessment-box assessment-${alertLevel}`}>
        {assessment ? (
          <p className="assessment-text">{assessment}</p>
        ) : (
          <p className="assessment-placeholder">
            Start detection to generate assessment...
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Sub-component: SessionLog ───
function SessionLog({ entries }) {
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries.length]);

  return (
    <div>
      <div className="section-title">Session Log</div>
      {entries.length === 0 ? (
        <div className="log-empty">No events yet</div>
      ) : (
        <div className="session-log" ref={scrollRef}>
          {entries.map((entry, i) => (
            <div key={i} className={`log-entry log-${entry.type || "info"}`}>
              <span className="log-time">{entry.time}</span>
              <span className="log-message">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Sub-component: QuickActions ───
function QuickActions({
  flaggedForReview,
  onFlag,
  onSnapshot,
  onReport,
  reportGenerating,
  detecting,
  snapshotCount,
}) {
  return (
    <div>
      <div className="section-title">Quick Actions</div>
      <div className="quick-actions">
        <button
          className={`action-btn ${flaggedForReview ? "action-flagged" : ""}`}
          onClick={onFlag}
        >
          <span className="action-icon">{flaggedForReview ? "\u2691" : "\u2690"}</span>
          {flaggedForReview ? "Unflag Review" : "Flag for Review"}
        </button>
        <button
          className="action-btn"
          onClick={onSnapshot}
          disabled={!detecting}
        >
          <span className="action-icon">{"\u2316"}</span>
          Capture Snapshot
          {snapshotCount > 0 && (
            <span className="snapshot-badge">{snapshotCount}</span>
          )}
        </button>
        <button
          className={`action-btn ${reportGenerating ? "action-generating" : ""}`}
          onClick={onReport}
          disabled={reportGenerating}
        >
          <span className="action-icon">{"\u2637"}</span>
          {reportGenerating ? "Generating..." : "Generate Report"}
        </button>
      </div>
    </div>
  );
}

// ─── Sub-component: ReportPreview ───
function ReportPreview({ reportData, onClose }) {
  if (!reportData) return null;
  return (
    <div className="report-overlay" onClick={onClose}>
      <div className="report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="report-modal-header">
          <h2>Report: {reportData.report_id || "—"}</h2>
          <button className="report-close-btn" onClick={onClose}>
            {"\u00d7"}
          </button>
        </div>
        <div className="report-body">
          <pre className="report-json">
            {JSON.stringify(reportData, null, 2)}
          </pre>
        </div>
      </div>
    </div>
  );
}

// ─── Sub-component: DetectionList ───
function DetectionList({ summary, detecting }) {
  if (Object.keys(summary).length === 0) {
    return (
      <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
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
              <span style={{ color: "var(--text-muted)" }}> x{info.count}</span>
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

// ═══════════════════════════════════════════════════════════════
// ─── Main App Component ───
// ═══════════════════════════════════════════════════════════════
function App() {
  // ─── Refs (preserved) ───
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const wsRef = useRef(null);
  const intervalRef = useRef(null);
  const streamRef = useRef(null);
  const lastFrameTime = useRef(Date.now());

  // ─── Original state (preserved) ───
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

  // ─── New dashboard state ───
  const [sessionStartTime, setSessionStartTime] = useState(null);
  const [sessionElapsed, setSessionElapsed] = useState(0);
  const [sessionLog, setSessionLog] = useState([]);
  const [sessionId] = useState(genSessionId);
  const [operationMode, setOperationMode] = useState("auto");
  const [alertLevel, setAlertLevel] = useState("normal");
  const [reportData, setReportData] = useState(null);
  const [reportGenerating, setReportGenerating] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [flaggedForReview, setFlaggedForReview] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [qnxConnected, setQnxConnected] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("idle");
  const [showReportPreview, setShowReportPreview] = useState(false);

  // ─── Log helper ───
  const addLogEntry = useCallback((message, type = "info") => {
    const now = new Date();
    const time = now.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    setSessionLog((prev) => [...prev.slice(-200), { time, message, type }]);
  }, []);

  // ─── Fetch initial status (preserved) ───
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

  // ─── Backend health poll (5s) ───
  useEffect(() => {
    const poll = () => {
      fetch(`${API_URL}/health`)
        .then((r) => r.json())
        .then((data) => {
          setBackendConnected(data.status === "ok");
          setQnxConnected(data.qnx_camera_connected === true);
        })
        .catch(() => {
          setBackendConnected(false);
          setQnxConnected(false);
        });
    };
    poll();
    const id = setInterval(poll, 5000);
    return () => clearInterval(id);
  }, []);

  // ─── Session timer ───
  useEffect(() => {
    if (!detecting) return;
    setSessionStartTime(Date.now());
    setSessionElapsed(0);
    const id = setInterval(() => {
      setSessionElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(id);
  }, [detecting]);

  // ─── Alert level computation ───
  useEffect(() => {
    if (!analytics) return;
    const abnormal = analytics.abnormal_pct || 0;
    let newLevel;
    if (abnormal > 30) newLevel = "critical";
    else if (abnormal > 10) newLevel = "warning";
    else newLevel = "normal";
    setAlertLevel((prev) => {
      if (prev !== newLevel) {
        if (newLevel === "critical") {
          addLogEntry(`ALERT: Abnormality ${abnormal}% exceeds critical threshold`, "alert");
        } else if (newLevel === "warning" && prev !== "critical") {
          addLogEntry(`Warning: Abnormality ${abnormal}% exceeds warning threshold`, "alert");
        }
      }
      return newLevel;
    });
  }, [analytics, addLogEntry]);

  // ─── Auto-flag when critical + auto mode ───
  useEffect(() => {
    if (operationMode === "auto" && alertLevel === "critical" && !flaggedForReview) {
      setFlaggedForReview(true);
      addLogEntry("Auto-flagged for review (critical threshold exceeded)", "alert");
    }
  }, [operationMode, alertLevel, flaggedForReview, addLogEntry]);

  // ─── Preserved: mode switching ───
  const switchMode = async (newMode) => {
    try {
      const res = await fetch(`${API_URL}/mode/${newMode}`, { method: "POST" });
      const data = await res.json();
      if (data.success) {
        setMode(data.mode);
        addLogEntry(`Switched to ${data.mode} mode`, "action");
      }
    } catch {}
  };

  // ─── Preserved: confidence ───
  const updateConfidence = async (val) => {
    setConfidence(val);
    try {
      await fetch(`${API_URL}/confidence/${val}`, { method: "POST" });
    } catch {}
  };

  // ─── Preserved: shape toggle ───
  const toggleShapes = async () => {
    const next = !shapesEnabled;
    setShapesEnabled(next);
    try {
      await fetch(`${API_URL}/shapes/${next}`, { method: "POST" });
    } catch {}
  };

  // ─── Preserved: camera ───
  const startCamera = useCallback(() => {
    setStreaming(true);
    addLogEntry("Camera feed started", "action");
  }, [addLogEntry]);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    clearInterval(intervalRef.current);
    setStreaming(false);
    setDetecting(false);
    setDetections([]);
    addLogEntry("Camera feed stopped", "action");
  }, [addLogEntry]);

  // ─── Preserved: WebSocket ───
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

  // ─── Preserved: detection toggle ───
  const toggleDetection = useCallback(() => {
    if (detecting) {
      clearInterval(intervalRef.current);
      setDetecting(false);
      setDetections([]);
      addLogEntry("Detection stopped", "action");
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
    addLogEntry("Detection started", "action");
  }, [detecting, streaming, connectWs, addLogEntry]);

  // ─── Preserved: draw overlays ───
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

      if (det.type === "shape") {
        ctx.setLineDash([4, 4]);
      } else {
        ctx.setLineDash([]);
      }

      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);

      const label = `${det.label} ${Math.round(det.confidence * 100)}%`;
      ctx.font = "bold 11px sans-serif";
      const textWidth = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(x, y - 18, textWidth + 8, 18);
      ctx.fillStyle = "#000";
      ctx.fillText(label, x + 4, y - 5);

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

  // ─── Cleanup on unmount ───
  useEffect(() => {
    return () => {
      clearInterval(intervalRef.current);
      wsRef.current?.close();
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
    };
  }, []);

  // ─── Generate report ───
  const generateReport = useCallback(async () => {
    setReportGenerating(true);
    addLogEntry("Generating report...", "action");
    try {
      const res = await fetch(`${API_URL}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: sessionId,
          session_duration: sessionElapsed,
          snapshots_count: snapshots.length,
          operation_mode: operationMode,
          flagged_for_review: flaggedForReview,
          log_entries: sessionLog.slice(-50),
        }),
      });
      const data = await res.json();
      setReportData(data);
      setShowReportPreview(true);
      addLogEntry(`Report generated: ${data.report_id}`, "success");
    } catch (err) {
      addLogEntry(`Report generation failed: ${err.message}`, "alert");
    } finally {
      setReportGenerating(false);
    }
  }, [sessionId, sessionElapsed, snapshots, operationMode, flaggedForReview, sessionLog, addLogEntry]);

  // ─── Capture snapshot ───
  const captureSnapshot = useCallback(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const capture = captureCanvasRef.current;
    capture.width = video.naturalWidth || 2304;
    capture.height = video.naturalHeight || 1296;
    const ctx = capture.getContext("2d");
    ctx.drawImage(video, 0, 0);
    ctx.drawImage(canvas, 0, 0);

    const dataUrl = capture.toDataURL("image/png");
    const timestamp = new Date().toISOString();
    setSnapshots((prev) => [...prev, { dataUrl, timestamp }]);
    addLogEntry(`Snapshot captured (#${snapshots.length + 1})`, "success");
  }, [snapshots.length, addLogEntry]);

  // ─── Flag toggle ───
  const toggleFlag = useCallback(() => {
    setFlaggedForReview((prev) => {
      const next = !prev;
      addLogEntry(
        next ? "Session flagged for review" : "Review flag removed",
        next ? "alert" : "action"
      );
      return next;
    });
  }, [addLogEntry]);

  // ─── Detection summaries (preserved logic) ───
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
  const totalDetections = detections.length;

  // ─── Render ───
  return (
    <div className="dashboard">
      <HeaderBar
        backendConnected={backendConnected}
        qnxConnected={qnxConnected}
        voiceActive={voiceActive}
        sessionElapsed={sessionElapsed}
        detecting={detecting}
        operationMode={operationMode}
        setOperationMode={setOperationMode}
        flaggedForReview={flaggedForReview}
      />

      <div className="dashboard-body">
        {/* ─── LEFT PANEL: Camera + Controls ─── */}
        <div className="panel-left panel-glass">
          <div className="camera-section">
            {streaming ? (
              <div className="video-container">
                <img
                  ref={videoRef}
                  src={`${API_URL}/qnx/stream`}
                  alt="QNX Camera Module 3"
                />
                <canvas ref={canvasRef} />
              </div>
            ) : (
              <div className="no-camera">
                <div className="no-camera-icon">{"\u23FA"}</div>
                <p>No camera feed</p>
                <button onClick={startCamera}>Start Camera</button>
              </div>
            )}
          </div>

          <div className="camera-controls">
            <div className="section-title">Controls</div>
            <div className="control-buttons">
              <button
                className={`ctrl-btn ${streaming ? "ctrl-active" : ""}`}
                onClick={streaming ? stopCamera : startCamera}
              >
                {streaming ? "Stop Camera" : "Start Camera"}
              </button>
              <button
                className={`ctrl-btn ${detecting ? "ctrl-active" : ""}`}
                onClick={toggleDetection}
                disabled={!streaming}
              >
                {detecting ? "Stop Detection" : "Detect"}
              </button>
            </div>
          </div>

          <div className="model-section">
            <div className="section-title">Model</div>
            <div className="model-buttons">
              {availableModes.map((m) => (
                <button
                  key={m}
                  className={`ctrl-btn ${mode === m ? "ctrl-active" : ""}`}
                  onClick={() => switchMode(m)}
                >
                  {m === "general" ? "General" : "Blood Cell"}
                </button>
              ))}
            </div>
            <div className="confidence-row">
              <label className="mono">
                Confidence: {Math.round(confidence * 100)}%
              </label>
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

          {/* Detection Lists */}
          <div className="camera-controls">
            <div className="section-title">
              {mode === "blood_cell" ? "Blood Cells" : "Objects"}
            </div>
            <DetectionList summary={yoloSummary} detecting={detecting} />
          </div>

          {shapesEnabled && Object.keys(shapeSummary).length > 0 && (
            <div className="camera-controls">
              <div className="section-title">Shapes</div>
              <DetectionList summary={shapeSummary} detecting={detecting} />
            </div>
          )}
        </div>

        {/* ─── CENTER PANEL: Analytics ─── */}
        <div className="panel-center panel-glass">
          <AbnormalGauge
            value={analytics?.abnormal_pct ?? 0}
            alertLevel={alertLevel}
          />

          <LiveStatsGrid
            analytics={analytics}
            fps={fps}
            detecting={detecting}
            totalDetections={totalDetections}
            mode={mode}
          />

          {mode === "blood_cell" && (
            <MorphologyBars
              morphologyCounts={analytics?.morphology_counts}
              totalCells={analytics?.cell_count || 0}
            />
          )}

          <ClassBreakdownChips classCounts={analytics?.class_counts} />

          <AssessmentSummary
            analytics={analytics}
            alertLevel={alertLevel}
            detecting={detecting}
          />
        </div>

        {/* ─── RIGHT PANEL: Voice + Log + Actions ─── */}
        <div className="panel-right panel-glass">
          <div className="panel-section">
            <VoiceAgent
              expanded
              onStatusChange={setVoiceStatus}
              onActiveChange={setVoiceActive}
            />
          </div>

          <div className="panel-section">
            <SessionLog entries={sessionLog} />
          </div>

          <div className="panel-section">
            <QuickActions
              flaggedForReview={flaggedForReview}
              onFlag={toggleFlag}
              onSnapshot={captureSnapshot}
              onReport={generateReport}
              reportGenerating={reportGenerating}
              detecting={detecting}
              snapshotCount={snapshots.length}
            />
          </div>
        </div>
      </div>

      {/* Report Preview Modal */}
      {showReportPreview && (
        <ReportPreview
          reportData={reportData}
          onClose={() => setShowReportPreview(false)}
        />
      )}

      <canvas ref={captureCanvasRef} style={{ display: "none" }} />
    </div>
  );
}

export default App;
