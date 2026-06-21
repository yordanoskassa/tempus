import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import "./App.css";
import VoiceAgent from "./VoiceAgent";

const WS_URL = "ws://localhost:8000/ws/detect";
const API_URL = "http://localhost:8000";
const FRAME_INTERVAL_MS = 100;

function useAnimatedValue(target, duration = 500) {
  const [val, setVal] = useState(target);
  const raf = useRef(null);
  useEffect(() => {
    const from = val;
    const t0 = performance.now();
    const tick = (now) => {
      const t = Math.min((now - t0) / duration, 1);
      setVal(from + (target - from) * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [target, duration]);
  return val;
}

const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ── Header ──

function HeaderBar({ backendConnected, qnxConnected, voiceActive, sessionElapsed, detecting, operationMode, setOperationMode, flaggedForReview }) {
  return (
    <div className="header-bar">
      <div className="header-brand">
        <h1>Vetr<span>View</span></h1>
        <span className="brand-sub">Laboratory</span>
      </div>
      <div className="header-center">
        <div className="conn-row">
          <div className={`conn-item ${qnxConnected ? "on" : ""}`}><div className="conn-dot" />QNX</div>
          <div className={`conn-item ${backendConnected ? "on" : ""}`}><div className="conn-dot" />Backend</div>
          <div className={`conn-item ${voiceActive ? "on" : ""}`}><div className="conn-dot" />Voice</div>
        </div>
        {detecting && <div className="session-timer">{fmt(sessionElapsed)}</div>}
        {flaggedForReview && <div className="header-flag">Flagged</div>}
      </div>
      <div className="header-right">
        <div className="mode-toggle">
          <button className={operationMode === "auto" ? "mode-active" : ""} onClick={() => setOperationMode("auto")}>Auto</button>
          <button className={operationMode === "review" ? "mode-active" : ""} onClick={() => setOperationMode("review")}>Review</button>
        </div>
      </div>
    </div>
  );
}

// ── Gauge with outer ring ──

function AbnormalGauge({ value, alertLevel }) {
  const r = 85;
  const rOuter = 95;
  const circ = 2 * Math.PI * r;
  const clamped = Math.min(Math.max(value, 0), 100);
  const offset = circ - (clamped / 100) * circ;
  const animated = useAnimatedValue(clamped);

  return (
    <div className="gauge-container">
      <div className="gauge-wrap">
        <svg viewBox="0 0 210 210" className="gauge-svg">
          {/* Outer decorative ring */}
          <circle className="gauge-ring-bg" cx="105" cy="105" r={rOuter} />
          {/* Main track */}
          <circle className="gauge-track" cx="105" cy="105" r={r} />
          {/* Fill arc */}
          <circle className={`gauge-fill level-${alertLevel}`} cx="105" cy="105" r={r} strokeDasharray={circ} strokeDashoffset={offset} />
        </svg>
        <div className="gauge-center">
          <span className="gauge-number">{animated.toFixed(1)}<span className="gauge-pct">%</span></span>
          <span className="gauge-label">Abnormal</span>
        </div>
      </div>
      <div className={`gauge-status level-${alertLevel}`}>
        {alertLevel === "normal" ? "Normal" : alertLevel === "warning" ? "Warning" : "Critical"}
      </div>
    </div>
  );
}

// ── Stats ──

function LiveStatsGrid({ analytics, fps, detecting, totalDetections, mode }) {
  const active = detecting && analytics;
  return (
    <div>
      <div className="section-label">Statistics</div>
      <div className="stats-grid">
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? totalDetections : "--"}</div>
          <div className="stat-lbl">Total</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? fps : "--"}</div>
          <div className="stat-lbl">FPS</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? (analytics?.cell_count ?? 0) : "--"}</div>
          <div className="stat-lbl">{mode === "blood_cell" ? "Cells" : "Objects"}</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? (analytics?.shape_count ?? 0) : "--"}</div>
          <div className="stat-lbl">Shapes</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? `${analytics?.inference_ms ?? 0}` : "--"}</div>
          <div className="stat-lbl">Latency ms</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? `${analytics?.coverage_pct ?? 0}%` : "--"}</div>
          <div className="stat-lbl">Coverage</div>
        </div>
      </div>
    </div>
  );
}

// ── Morphology ──

function MorphologyBars({ morphologyCounts }) {
  if (!morphologyCounts || Object.keys(morphologyCounts).length === 0) return null;
  const colors = { Normal: "#34d399", Sickle: "#f87171", Teardrop: "#fbbf24", Acanthocyte: "#fb923c", "Burr/Echinocyte": "#f97316", Spherocyte: "#fb7185", Elliptocyte: "#e879f9", Target: "#a78bfa", "N/A": "#475569" };
  const sorted = Object.entries(morphologyCounts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...sorted.map(([, c]) => c), 1);
  return (
    <div>
      <div className="section-label">Morphology</div>
      <div className="morph-section">
        {sorted.map(([label, count]) => (
          <div key={label} className="morph-row">
            <span className="morph-label">{label}</span>
            <div className="morph-track">
              <div className="morph-fill" style={{ width: `${(count / max) * 100}%`, background: colors[label] || "#22d3ee" }} />
            </div>
            <span className="morph-count">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Chips ──

function ClassBreakdownChips({ classCounts }) {
  if (!classCounts || Object.keys(classCounts).length === 0) return null;
  const colors = { RBC: "#f87171", WBC: "#22d3ee", Platelet: "#fbbf24" };
  return (
    <div>
      <div className="section-label">Classification</div>
      <div className="class-chips">
        {Object.entries(classCounts).map(([cls, count]) => (
          <div key={cls} className="class-chip">
            <div className="chip-dot" style={{ background: colors[cls] || "#22d3ee" }} />
            <span>{cls}</span>
            <span className="chip-count">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Assessment ──

function AssessmentSummary({ analytics, alertLevel, detecting }) {
  const text = useMemo(() => {
    if (!analytics || !detecting) return null;
    const p = [];
    const cells = analytics.cell_count || 0;
    const abnormal = analytics.abnormal_pct || 0;
    const morph = analytics.morphology_counts || {};
    const classes = analytics.class_counts || {};
    if (cells > 0) p.push(`${cells} cells in field of view.`);
    const abn = Object.entries(morph).filter(([k]) => k !== "Normal" && k !== "N/A");
    if (abn.length > 0) p.push(`Abnormal: ${abn.map(([k, v]) => `${v} ${k}`).join(", ")}.`);
    if (Object.keys(classes).length > 0) p.push(`Types: ${Object.entries(classes).map(([k, v]) => `${v} ${k}`).join(", ")}.`);
    if (abnormal > 30) p.push("Immediate review by certified technician required.");
    else if (abnormal > 10) p.push("Close monitoring advised.");
    return p.join(" ");
  }, [analytics, detecting]);

  return (
    <div>
      <div className="section-label">Assessment</div>
      <div className={`assessment-box level-${alertLevel}`}>
        {text ? <p className="assessment-text">{text}</p> : <p className="assessment-empty">Waiting for detection data</p>}
      </div>
    </div>
  );
}

// ── Log ──

function SessionLog({ entries }) {
  const ref = useRef(null);
  useEffect(() => { if (ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [entries.length]);
  return (
    <div>
      <div className="section-label">Session Log</div>
      {entries.length === 0 ? <div className="log-empty">No events yet</div> : (
        <div className="session-log" ref={ref}>
          {entries.map((e, i) => (
            <div key={i} className={`log-entry log-${e.type || "info"}`}>
              <span className="log-time">{e.time}</span>
              <span className="log-message">{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Actions ──

function QuickActions({ flaggedForReview, onFlag, onSnapshot, onReport, reportGenerating, detecting, snapshotCount }) {
  return (
    <div>
      <div className="section-label">Actions</div>
      <div className="quick-actions">
        <button className={`action-btn ${flaggedForReview ? "action-flagged" : ""}`} onClick={onFlag}>
          {flaggedForReview ? "Unflag Review" : "Flag for Review"}
        </button>
        <button className="action-btn" onClick={onSnapshot} disabled={!detecting}>
          Capture Snapshot
          {snapshotCount > 0 && <span className="action-meta">{snapshotCount}</span>}
        </button>
        <button className={`action-btn ${reportGenerating ? "action-generating" : ""}`} onClick={onReport} disabled={reportGenerating}>
          {reportGenerating ? "Generating..." : "Generate Report"}
        </button>
      </div>
    </div>
  );
}

// ── Report Modal ──

function ReportPreview({ reportData, onClose }) {
  if (!reportData) return null;
  return (
    <div className="report-overlay" onClick={onClose}>
      <div className="report-modal" onClick={(e) => e.stopPropagation()}>
        <div className="report-header">
          <h2>{reportData.report_id || "Report"}</h2>
          <button className="report-close" onClick={onClose}>{"\u00d7"}</button>
        </div>
        <div className="report-body">
          <pre className="report-json">{JSON.stringify(reportData, null, 2)}</pre>
        </div>
      </div>
    </div>
  );
}

// ── Detection List ──

function DetectionList({ summary, detecting }) {
  if (Object.keys(summary).length === 0) return <p style={{ color: "var(--text-3)", fontSize: 12 }}>{detecting ? "Analyzing..." : "No detections"}</p>;
  return (
    <ul className="detection-list">
      {Object.entries(summary).map(([label, info]) => (
        <li key={label} className="detection-item">
          <div className="detection-label">
            <div className="detection-color" style={{ background: `rgb(${info.color[0]},${info.color[1]},${info.color[2]})` }} />
            {label}{info.count > 1 && <span style={{ color: "var(--text-3)" }}> x{info.count}</span>}
          </div>
          <span className="detection-confidence">{Math.round(info.maxConf * 100)}%</span>
        </li>
      ))}
    </ul>
  );
}

// ══════════════════════════════════════
// ── App ──
// ══════════════════════════════════════

function App() {
  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const captureCanvasRef = useRef(null);
  const wsRef = useRef(null);
  const intervalRef = useRef(null);
  const streamRef = useRef(null);
  const lastFrameTime = useRef(Date.now());

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

  const [sessionElapsed, setSessionElapsed] = useState(0);
  const [sessionLog, setSessionLog] = useState([]);
  const [sessionId] = useState(uid);
  const [operationMode, setOperationMode] = useState("auto");
  const [alertLevel, setAlertLevel] = useState("normal");
  const [reportData, setReportData] = useState(null);
  const [reportGenerating, setReportGenerating] = useState(false);
  const [snapshots, setSnapshots] = useState([]);
  const [flaggedForReview, setFlaggedForReview] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [qnxConnected, setQnxConnected] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [, setVoiceStatus] = useState("idle");
  const [showReportPreview, setShowReportPreview] = useState(false);

  const log = useCallback((msg, type = "info") => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setSessionLog((prev) => [...prev.slice(-200), { time, message: msg, type }]);
  }, []);

  useEffect(() => { fetch(`${API_URL}/status`).then(r => r.json()).then(d => { setMode(d.mode); setAvailableModes(d.available_modes); setConfidence(d.conf_threshold); setShapesEnabled(d.shapes_enabled); }).catch(() => {}); }, []);

  useEffect(() => {
    const poll = () => fetch(`${API_URL}/health`).then(r => r.json()).then(d => { setBackendConnected(d.status === "ok"); setQnxConnected(d.qnx_camera_connected === true); }).catch(() => { setBackendConnected(false); setQnxConnected(false); });
    poll(); const id = setInterval(poll, 5000); return () => clearInterval(id);
  }, []);

  useEffect(() => { if (!detecting) return; setSessionElapsed(0); const id = setInterval(() => setSessionElapsed(p => p + 1), 1000); return () => clearInterval(id); }, [detecting]);

  useEffect(() => {
    if (!analytics) return;
    const pct = analytics.abnormal_pct || 0;
    const lvl = pct > 30 ? "critical" : pct > 10 ? "warning" : "normal";
    setAlertLevel(prev => {
      if (prev !== lvl) {
        if (lvl === "critical") log(`Alert: ${pct}% abnormal - critical`, "alert");
        else if (lvl === "warning" && prev !== "critical") log(`Warning: ${pct}% abnormal`, "alert");
      }
      return lvl;
    });
  }, [analytics, log]);

  useEffect(() => {
    if (operationMode === "auto" && alertLevel === "critical" && !flaggedForReview) { setFlaggedForReview(true); log("Auto-flagged for review", "alert"); }
  }, [operationMode, alertLevel, flaggedForReview, log]);

  const switchMode = async (m) => { try { const r = await fetch(`${API_URL}/mode/${m}`, { method: "POST" }); const d = await r.json(); if (d.success) { setMode(d.mode); log(`Mode: ${d.mode}`, "action"); } } catch {} };
  const updateConfidence = async (v) => { setConfidence(v); try { await fetch(`${API_URL}/confidence/${v}`, { method: "POST" }); } catch {} };
  const toggleShapes = async () => { const n = !shapesEnabled; setShapesEnabled(n); try { await fetch(`${API_URL}/shapes/${n}`, { method: "POST" }); } catch {} };

  const startCamera = useCallback(() => { setStreaming(true); log("Camera started", "action"); }, [log]);
  const stopCamera = useCallback(() => { if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; } clearInterval(intervalRef.current); setStreaming(false); setDetecting(false); setDetections([]); log("Camera stopped", "action"); }, [log]);

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => { setConnected(false); setDetecting(false); };
    ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.detections) { setDetections(d.detections); if (d.mode) setMode(d.mode); if (d.analytics) setAnalytics(d.analytics); const now = Date.now(); setFps(Math.round(1000 / (now - lastFrameTime.current))); lastFrameTime.current = now; } };
    wsRef.current = ws;
  }, []);

  const toggleDetection = useCallback(() => {
    if (detecting) { clearInterval(intervalRef.current); setDetecting(false); setDetections([]); log("Detection stopped", "action"); return; }
    if (!streaming) return;
    connectWs();
    intervalRef.current = setInterval(() => { const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return; ws.send("qnx"); }, FRAME_INTERVAL_MS);
    setDetecting(true); log("Detection started", "action");
  }, [detecting, streaming, connectWs, log]);

  useEffect(() => {
    const canvas = canvasRef.current, video = videoRef.current;
    if (!canvas || !video) return;
    canvas.width = video.naturalWidth || 2304;
    canvas.height = video.naturalHeight || 1296;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const det of detections) {
      const [x, y, w, h] = det.bbox;
      const [r, g, b] = det.color;
      const c = `rgb(${r},${g},${b})`;
      ctx.setLineDash(det.type === "shape" ? [4, 4] : []);
      ctx.strokeStyle = c; ctx.lineWidth = 2; ctx.strokeRect(x, y, w, h); ctx.setLineDash([]);
      const lbl = `${det.label} ${Math.round(det.confidence * 100)}%`;
      ctx.font = "bold 11px sans-serif";
      const tw = ctx.measureText(lbl).width;
      ctx.fillStyle = c; ctx.fillRect(x, y - 18, tw + 8, 18);
      ctx.fillStyle = "#000"; ctx.fillText(lbl, x + 4, y - 5);
      if (det.morphology && det.morphology !== "Normal") {
        const mc = det.morph_color || [255, 255, 255];
        ctx.fillStyle = `rgb(${mc[0]},${mc[1]},${mc[2]})`;
        const ml = det.morphology, mw = ctx.measureText(ml).width;
        ctx.fillRect(x, y + h, mw + 8, 16); ctx.fillStyle = "#000"; ctx.font = "bold 10px sans-serif"; ctx.fillText(ml, x + 4, y + h + 12);
      }
    }
  }, [detections]);

  useEffect(() => { return () => { clearInterval(intervalRef.current); wsRef.current?.close(); if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop()); }; }, []);

  const generateReport = useCallback(async () => {
    setReportGenerating(true); log("Generating report...", "action");
    try {
      const r = await fetch(`${API_URL}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId, session_duration: sessionElapsed, snapshots_count: snapshots.length, operation_mode: operationMode, flagged_for_review: flaggedForReview, log_entries: sessionLog.slice(-50) }) });
      const d = await r.json(); setReportData(d); setShowReportPreview(true); log(`Report: ${d.report_id}`, "success");
    } catch (err) { log(`Report failed: ${err.message}`, "alert"); } finally { setReportGenerating(false); }
  }, [sessionId, sessionElapsed, snapshots, operationMode, flaggedForReview, sessionLog, log]);

  const captureSnapshot = useCallback(() => {
    const canvas = canvasRef.current, video = videoRef.current; if (!canvas || !video) return;
    const c = captureCanvasRef.current; c.width = video.naturalWidth || 2304; c.height = video.naturalHeight || 1296;
    const ctx = c.getContext("2d"); ctx.drawImage(video, 0, 0); ctx.drawImage(canvas, 0, 0);
    setSnapshots(prev => [...prev, { dataUrl: c.toDataURL("image/png"), timestamp: new Date().toISOString() }]);
    log(`Snapshot #${snapshots.length + 1}`, "success");
  }, [snapshots.length, log]);

  const toggleFlag = useCallback(() => { setFlaggedForReview(prev => { log(prev ? "Review flag removed" : "Flagged for review", prev ? "action" : "alert"); return !prev; }); }, [log]);

  const yoloDets = detections.filter(d => d.type === "yolo");
  const shapeDets = detections.filter(d => d.type === "shape");
  const grp = (arr) => arr.reduce((a, d) => { a[d.label] = a[d.label] || { count: 0, color: d.color, maxConf: 0 }; a[d.label].count++; a[d.label].maxConf = Math.max(a[d.label].maxConf, d.confidence); return a; }, {});

  return (
    <div className="dashboard">
      <HeaderBar backendConnected={backendConnected} qnxConnected={qnxConnected} voiceActive={voiceActive} sessionElapsed={sessionElapsed} detecting={detecting} operationMode={operationMode} setOperationMode={setOperationMode} flaggedForReview={flaggedForReview} />

      <div className="dashboard-body">
        <div className="panel-left">
          <div className="camera-section">
            {streaming ? (
              <div className="video-container">
                <img ref={videoRef} src={`${API_URL}/qnx/stream`} alt="QNX Camera" />
                <canvas ref={canvasRef} />
              </div>
            ) : (
              <div className="no-camera">
                <p>No camera feed</p>
                <p className="cam-hint">Connect the QNX camera module to begin analysis</p>
                <button onClick={startCamera}>Start Camera</button>
              </div>
            )}
          </div>

          <div className="ctrl-section">
            <div className="section-label">Controls</div>
            <div className="ctrl-row">
              <button className={`ctrl-btn ${streaming ? "ctrl-active" : ""}`} onClick={streaming ? stopCamera : startCamera}>{streaming ? "Stop Camera" : "Start Camera"}</button>
              <button className={`ctrl-btn ${detecting ? "ctrl-active" : ""}`} onClick={toggleDetection} disabled={!streaming}>{detecting ? "Stop" : "Detect"}</button>
            </div>
          </div>

          <div className="ctrl-section">
            <div className="section-label">Model</div>
            <div className="ctrl-row" style={{ marginBottom: 10 }}>
              {availableModes.map(m => <button key={m} className={`ctrl-btn ${mode === m ? "ctrl-active" : ""}`} onClick={() => switchMode(m)}>{m === "general" ? "General" : "Blood Cell"}</button>)}
            </div>
            <div className="confidence-row">
              <label>Confidence {Math.round(confidence * 100)}%</label>
              <input type="range" min="5" max="95" value={Math.round(confidence * 100)} onChange={e => updateConfidence(e.target.value / 100)} />
            </div>
            <div className="toggle-row">
              <label>Shapes</label>
              <button className={`toggle-btn ${shapesEnabled ? "active" : ""}`} onClick={toggleShapes}>{shapesEnabled ? "On" : "Off"}</button>
            </div>
          </div>

          <div className="ctrl-section">
            <div className="section-label">{mode === "blood_cell" ? "Cells" : "Objects"}</div>
            <DetectionList summary={grp(yoloDets)} detecting={detecting} />
          </div>

          {shapesEnabled && Object.keys(grp(shapeDets)).length > 0 && (
            <div className="ctrl-section">
              <div className="section-label">Shapes</div>
              <DetectionList summary={grp(shapeDets)} detecting={detecting} />
            </div>
          )}
        </div>

        <div className="panel-center">
          <AbnormalGauge value={analytics?.abnormal_pct ?? 0} alertLevel={alertLevel} />
          <LiveStatsGrid analytics={analytics} fps={fps} detecting={detecting} totalDetections={detections.length} mode={mode} />
          {mode === "blood_cell" && <MorphologyBars morphologyCounts={analytics?.morphology_counts} />}
          <ClassBreakdownChips classCounts={analytics?.class_counts} />
          <AssessmentSummary analytics={analytics} alertLevel={alertLevel} detecting={detecting} />
        </div>

        <div className="panel-right">
          <div className="panel-section"><VoiceAgent expanded onStatusChange={setVoiceStatus} onActiveChange={setVoiceActive} /></div>
          <div className="panel-section"><SessionLog entries={sessionLog} /></div>
          <div className="panel-section"><QuickActions flaggedForReview={flaggedForReview} onFlag={toggleFlag} onSnapshot={captureSnapshot} onReport={generateReport} reportGenerating={reportGenerating} detecting={detecting} snapshotCount={snapshots.length} /></div>
        </div>
      </div>

      {showReportPreview && <ReportPreview reportData={reportData} onClose={() => setShowReportPreview(false)} />}
      <canvas ref={captureCanvasRef} style={{ display: "none" }} />
    </div>
  );
}

export default App;
