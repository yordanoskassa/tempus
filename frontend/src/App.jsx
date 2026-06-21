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

function HeaderBar({ backendConnected, cameraConnected, voiceActive, sessionElapsed, detecting, operationMode, setOperationMode, flaggedForReview }) {
  return (
    <div className="header-bar">
      <div className="header-brand">
        <h1>Temp<span>us</span></h1>
        <span className="brand-sub">Hematology</span>
      </div>
      <div className="header-center">
        <div className="conn-row">
          <div className={`conn-item ${cameraConnected ? "on" : ""}`}><div className="conn-dot" />Camera</div>
          <div className={`conn-item ${backendConnected ? "on" : ""}`}><div className="conn-dot" />Backend</div>
          <div className={`conn-item ${voiceActive ? "on" : ""}`}><div className="conn-dot" />Voice</div>
        </div>
        {detecting && <div className="session-timer">{fmt(sessionElapsed)}</div>}
        {flaggedForReview && <div className="header-flag">Review Required</div>}
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

// ── Specimen Info ──

function SpecimenInfo({ sessionId, sessionElapsed, detecting, mode, snapshots, flagged }) {
  return (
    <div className="specimen-panel">
      <div className="section-label">Specimen</div>
      <div className="specimen-grid">
        <div className="specimen-field">
          <span className="specimen-key">Accession No.</span>
          <span className="specimen-val">{sessionId.slice(0, 10).toUpperCase()}</span>
        </div>
        <div className="specimen-field">
          <span className="specimen-key">Analysis Mode</span>
          <span className="specimen-val">{mode === "blood_cell" ? "CBC / Differential" : "General Cytology"}</span>
        </div>
        <div className="specimen-field">
          <span className="specimen-key">Elapsed</span>
          <span className="specimen-val mono">{fmt(sessionElapsed)}</span>
        </div>
        <div className="specimen-field">
          <span className="specimen-key">Status</span>
          <span className={`specimen-val ${detecting ? "specimen-active" : ""}`}>{detecting ? "Scanning" : "Idle"}</span>
        </div>
        <div className="specimen-field">
          <span className="specimen-key">Captures</span>
          <span className="specimen-val mono">{snapshots}</span>
        </div>
        <div className="specimen-field">
          <span className="specimen-key">Review</span>
          <span className={`specimen-val ${flagged ? "specimen-flagged" : ""}`}>{flagged ? "Flagged" : "None"}</span>
        </div>
      </div>
    </div>
  );
}

// ── Gauge ──

function AtypicalGauge({ value, alertLevel }) {
  const r = 85;
  const rOuter = 95;
  const circ = 2 * Math.PI * r;
  const clamped = Math.min(Math.max(value, 0), 100);
  const offset = circ - (clamped / 100) * circ;
  const animated = useAnimatedValue(clamped);
  const labels = { normal: "WNL", warning: "Borderline", critical: "Critical" };

  return (
    <div className="gauge-container">
      <div className="gauge-wrap">
        <svg viewBox="0 0 210 210" className="gauge-svg">
          <circle className="gauge-ring-bg" cx="105" cy="105" r={rOuter} />
          <circle className="gauge-track" cx="105" cy="105" r={r} />
          <circle className={`gauge-fill level-${alertLevel}`} cx="105" cy="105" r={r} strokeDasharray={circ} strokeDashoffset={offset} />
        </svg>
        <div className="gauge-center">
          <span className="gauge-number">{animated.toFixed(1)}<span className="gauge-pct">%</span></span>
          <span className="gauge-label">Dysmorphic</span>
        </div>
      </div>
      <div className={`gauge-status level-${alertLevel}`}>{labels[alertLevel]}</div>
    </div>
  );
}

// ── Stats ──

function LiveStatsGrid({ analytics, fps, detecting, totalDetections, mode }) {
  const active = detecting && analytics;
  return (
    <div>
      <div className="section-label">Live Metrics</div>
      <div className="stats-grid">
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? totalDetections : "--"}</div>
          <div className="stat-lbl">Detected</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? fps : "--"}</div>
          <div className="stat-lbl">FPS</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? (analytics?.cell_count ?? 0) : "--"}</div>
          <div className="stat-lbl">{mode === "blood_cell" ? "Cell Count" : "Objects"}</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? (analytics?.shape_count ?? 0) : "--"}</div>
          <div className="stat-lbl">Geometric</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? `${analytics?.inference_ms ?? 0}` : "--"}</div>
          <div className="stat-lbl">Latency ms</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? `${analytics?.coverage_pct ?? 0}%` : "--"}</div>
          <div className="stat-lbl">FOV Coverage</div>
        </div>
      </div>
    </div>
  );
}

// ── Trend Chart (SVG) ──

function TrendChart({ history }) {
  const W = 320, H = 120, PAD = 28;
  const plotW = W - PAD * 2, plotH = H - PAD - 10;

  if (history.length < 2) {
    return (
      <div className="chart-card">
        <div className="section-label">Cell Count Trend</div>
        <div className="chart-empty">Awaiting temporal data</div>
      </div>
    );
  }

  const maxCount = Math.max(...history.map(h => h.cellCount), 1);
  const points = history.map((h, i) => {
    const x = PAD + (i / (history.length - 1)) * plotW;
    const y = PAD + plotH - (h.cellCount / maxCount) * plotH;
    return `${x},${y}`;
  }).join(" ");

  const atypicalPoints = history.map((h, i) => {
    const x = PAD + (i / (history.length - 1)) * plotW;
    const y = PAD + plotH - (Math.min(h.atypicalPct, 100) / 100) * plotH;
    return `${x},${y}`;
  }).join(" ");

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map(frac => {
    const y = PAD + plotH * (1 - frac);
    return { y, label: Math.round(maxCount * frac) };
  });

  return (
    <div className="chart-card">
      <div className="section-label">Cell Count Trend</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="trend-svg">
        {gridLines.map((g, i) => (
          <g key={i}>
            <line x1={PAD} y1={g.y} x2={W - PAD} y2={g.y} className="grid-line" />
            <text x={PAD - 4} y={g.y + 3} className="grid-label">{g.label}</text>
          </g>
        ))}
        <polyline points={points} className="trend-line trend-cells" />
        <polyline points={atypicalPoints} className="trend-line trend-atypical" />
        <text x={W - PAD} y={PAD - 2} className="trend-legend legend-cells">Cells</text>
        <text x={W - PAD - 50} y={PAD - 2} className="trend-legend legend-atypical">Atypical %</text>
      </svg>
    </div>
  );
}

// ── Distribution Donut (SVG) ──

function DistributionDonut({ classCounts }) {
  const size = 160, cx = 80, cy = 80, r = 55, strokeW = 20;
  const colors = { RBC: "#9F2F2D", WBC: "#1F6C9F", Platelet: "#956400" };

  const entries = Object.entries(classCounts || {});
  const total = entries.reduce((s, [, v]) => s + v, 0);

  if (total === 0) {
    return (
      <div className="chart-card">
        <div className="section-label">CBC Distribution</div>
        <div className="chart-empty">No cell data</div>
      </div>
    );
  }

  const circ = 2 * Math.PI * r;
  let offset = 0;
  const arcs = entries.map(([label, count]) => {
    const frac = count / total;
    const dash = frac * circ;
    const gap = circ - dash;
    const rot = offset;
    offset += frac * 360;
    return { label, count, frac, dash, gap, rot, color: colors[label] || "#1F6C9F" };
  });

  return (
    <div className="chart-card">
      <div className="section-label">CBC Distribution</div>
      <div className="donut-wrap">
        <svg viewBox={`0 0 ${size} ${size}`} className="donut-svg">
          <circle cx={cx} cy={cy} r={r} fill="none" stroke="var(--border)" strokeWidth={strokeW} />
          {arcs.map((a, i) => (
            <circle key={i} cx={cx} cy={cy} r={r} fill="none" stroke={a.color} strokeWidth={strokeW}
              strokeDasharray={`${a.dash} ${a.gap}`}
              transform={`rotate(${a.rot - 90} ${cx} ${cy})`}
              className="donut-arc" />
          ))}
          <text x={cx} y={cy - 4} textAnchor="middle" className="donut-total">{total}</text>
          <text x={cx} y={cy + 10} textAnchor="middle" className="donut-total-label">cells</text>
        </svg>
        <div className="donut-legend">
          {arcs.map(a => (
            <div key={a.label} className="donut-legend-item">
              <div className="donut-legend-dot" style={{ background: a.color }} />
              <span className="donut-legend-name">{a.label}</span>
              <span className="donut-legend-pct">{(a.frac * 100).toFixed(1)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Reference Ranges ──

function ReferenceRanges({ analytics, detecting }) {
  if (!detecting || !analytics) {
    return (
      <div>
        <div className="section-label">Reference Ranges</div>
        <div className="chart-empty">Awaiting analysis data</div>
      </div>
    );
  }

  const atypical = analytics.abnormal_pct || 0;
  const coverage = analytics.coverage_pct || 0;
  const cellCount = analytics.cell_count || 0;

  const ranges = [
    { label: "Atypical Morphology", value: atypical, unit: "%", min: 0, max: 50, refLow: 0, refHigh: 5, warn: 10, crit: 30 },
    { label: "FOV Coverage", value: coverage, unit: "%", min: 0, max: 100, refLow: 15, refHigh: 60, warn: null, crit: null },
    { label: "Cell Density", value: cellCount, unit: "", min: 0, max: Math.max(cellCount * 1.5, 100), refLow: 20, refHigh: 80, warn: null, crit: null },
  ];

  return (
    <div>
      <div className="section-label">Reference Ranges</div>
      <div className="ref-ranges">
        {ranges.map(r => {
          const pct = Math.min(((r.value - r.min) / (r.max - r.min)) * 100, 100);
          const refLowPct = ((r.refLow - r.min) / (r.max - r.min)) * 100;
          const refHighPct = ((r.refHigh - r.min) / (r.max - r.min)) * 100;
          let status = "normal";
          if (r.crit != null && r.value > r.crit) status = "critical";
          else if (r.warn != null && r.value > r.warn) status = "warning";
          return (
            <div key={r.label} className="ref-row">
              <div className="ref-header">
                <span className="ref-label">{r.label}</span>
                <span className={`ref-value ref-${status}`}>{typeof r.value === "number" ? r.value.toFixed(1) : r.value}{r.unit}</span>
              </div>
              <div className="ref-bar-track">
                <div className="ref-bar-range" style={{ left: `${refLowPct}%`, width: `${refHighPct - refLowPct}%` }} />
                <div className={`ref-bar-marker ref-${status}`} style={{ left: `${pct}%` }} />
              </div>
              <div className="ref-bar-labels">
                <span>{r.min}</span>
                <span>{r.max}{r.unit}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Morphology ──

function MorphologyBars({ morphologyCounts }) {
  if (!morphologyCounts || Object.keys(morphologyCounts).length === 0) return null;
  const colors = { Normal: "#346538", Sickle: "#9F2F2D", Teardrop: "#956400", Acanthocyte: "#b85c00", "Burr/Echinocyte": "#a04800", Spherocyte: "#9F2F2D", Elliptocyte: "#7c3aed", Target: "#6d28d9", "N/A": "#787774" };
  const medicalNames = { Normal: "Normocyte", Sickle: "Drepanocyte", Teardrop: "Dacrocyte", Acanthocyte: "Acanthocyte", "Burr/Echinocyte": "Echinocyte", Spherocyte: "Spherocyte", Elliptocyte: "Elliptocyte", Target: "Codocyte", "N/A": "Unclassified" };
  const sorted = Object.entries(morphologyCounts).sort((a, b) => b[1] - a[1]);
  const max = Math.max(...sorted.map(([, c]) => c), 1);
  const total = sorted.reduce((s, [, c]) => s + c, 0);
  return (
    <div>
      <div className="section-label">Morphology Differential</div>
      <div className="morph-section">
        {sorted.map(([label, count]) => (
          <div key={label} className="morph-row">
            <span className="morph-label">{medicalNames[label] || label}</span>
            <div className="morph-track">
              <div className="morph-fill" style={{ width: `${(count / max) * 100}%`, background: colors[label] || "#1F6C9F" }} />
            </div>
            <span className="morph-count">{count}</span>
            <span className="morph-pct">{total > 0 ? `${((count / total) * 100).toFixed(0)}%` : ""}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Classification Chips ──

function ClassBreakdownChips({ classCounts }) {
  if (!classCounts || Object.keys(classCounts).length === 0) return null;
  const colors = { RBC: "#9F2F2D", WBC: "#1F6C9F", Platelet: "#956400" };
  const names = { RBC: "Erythrocytes", WBC: "Leukocytes", Platelet: "Thrombocytes" };
  return (
    <div>
      <div className="section-label">Cell Classification</div>
      <div className="class-chips">
        {Object.entries(classCounts).map(([cls, count]) => (
          <div key={cls} className="class-chip">
            <div className="chip-dot" style={{ background: colors[cls] || "#1F6C9F" }} />
            <span className="chip-name">{names[cls] || cls}</span>
            <span className="chip-abbr">({cls})</span>
            <span className="chip-count">{count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Clinical Assessment ──

function ClinicalAssessment({ analytics, alertLevel, detecting }) {
  const text = useMemo(() => {
    if (!analytics || !detecting) return null;
    const p = [];
    const cells = analytics.cell_count || 0;
    const atypical = analytics.abnormal_pct || 0;
    const morph = analytics.morphology_counts || {};
    const classes = analytics.class_counts || {};
    if (cells > 0) p.push(`${cells} cells identified in the current field of view.`);
    const abn = Object.entries(morph).filter(([k]) => k !== "Normal" && k !== "N/A");
    if (abn.length > 0) {
      const medNames = { Sickle: "drepanocytes", Teardrop: "dacrocytes", Acanthocyte: "acanthocytes", "Burr/Echinocyte": "echinocytes", Spherocyte: "spherocytes", Elliptocyte: "elliptocytes", Target: "codocytes" };
      p.push(`Atypical morphologies: ${abn.map(([k, v]) => `${v} ${medNames[k] || k}`).join(", ")}.`);
    }
    const normal = morph.Normal || 0;
    if (normal > 0) p.push(`${normal} normocytes identified.`);
    if (Object.keys(classes).length > 0) {
      const cNames = { RBC: "erythrocytes", WBC: "leukocytes", Platelet: "thrombocytes" };
      p.push(`Differential: ${Object.entries(classes).map(([k, v]) => `${v} ${cNames[k] || k}`).join(", ")}.`);
    }
    if (atypical > 30) p.push("RECOMMENDATION: Immediate pathologist review required. Significant dysmorphic cell population detected.");
    else if (atypical > 10) p.push("RECOMMENDATION: Further evaluation advised. Elevated atypical morphology rate.");
    else if (cells > 0) p.push("Findings within normal limits. No significant morphological irregularities.");
    return p.join(" ");
  }, [analytics, detecting]);

  const levelLabels = { normal: "WNL", warning: "Borderline", critical: "Critical" };

  return (
    <div>
      <div className="section-label">Preliminary Assessment</div>
      <div className={`assessment-box level-${alertLevel}`}>
        {text ? (
          <>
            <div className="assessment-badge-row">
              <span className={`assessment-badge level-${alertLevel}`}>{levelLabels[alertLevel]}</span>
            </div>
            <p className="assessment-text">{text}</p>
          </>
        ) : (
          <p className="assessment-empty">Awaiting cytological analysis data</p>
        )}
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
      <div className="section-label">Audit Trail</div>
      {entries.length === 0 ? <div className="log-empty">No events recorded</div> : (
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
          {flaggedForReview ? "Remove Flag" : "Flag for Pathologist Review"}
        </button>
        <button className="action-btn" onClick={onSnapshot} disabled={!detecting}>
          Capture Field of View
          {snapshotCount > 0 && <span className="action-meta">{snapshotCount}</span>}
        </button>
        <button className={`action-btn ${reportGenerating ? "action-generating" : ""}`} onClick={onReport} disabled={reportGenerating}>
          {reportGenerating ? "Generating..." : "Generate Lab Report"}
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
          <div>
            <h2>{reportData.report_id || "Lab Report"}</h2>
            <span className="report-subtitle">Automated Cytology Report</span>
          </div>
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
  if (Object.keys(summary).length === 0) return <p style={{ color: "var(--text-faint)", fontSize: 12 }}>{detecting ? "Scanning..." : "No detections"}</p>;
  return (
    <ul className="detection-list">
      {Object.entries(summary).map(([label, info]) => (
        <li key={label} className="detection-item">
          <div className="detection-label">
            <div className="detection-color" style={{ background: `rgb(${info.color[0]},${info.color[1]},${info.color[2]})` }} />
            {label}{info.count > 1 && <span style={{ color: "var(--text-muted)" }}> x{info.count}</span>}
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
  const [cameraConnected, setCameraConnected] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [, setVoiceStatus] = useState("idle");
  const [showReportPreview, setShowReportPreview] = useState(false);
  const [analyticsHistory, setAnalyticsHistory] = useState([]);
  const [cameraLoading, setCameraLoading] = useState(false);

  const log = useCallback((msg, type = "info") => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setSessionLog((prev) => [...prev.slice(-200), { time, message: msg, type }]);
  }, []);

  useEffect(() => { fetch(`${API_URL}/status`).then(r => r.json()).then(d => { setMode(d.mode); setAvailableModes(d.available_modes); setConfidence(d.conf_threshold); setShapesEnabled(d.shapes_enabled); }).catch(() => {}); }, []);

  useEffect(() => {
    const poll = () => fetch(`${API_URL}/health`).then(r => r.json()).then(d => { setBackendConnected(d.status === "ok"); setCameraConnected(d.camera_connected === true); }).catch(() => { setBackendConnected(false); setCameraConnected(false); });
    poll(); const id = setInterval(poll, 5000); return () => clearInterval(id);
  }, []);

  useEffect(() => { if (!detecting) return; setSessionElapsed(0); const id = setInterval(() => setSessionElapsed(p => p + 1), 1000); return () => clearInterval(id); }, [detecting]);

  // Track analytics history for trend chart
  useEffect(() => {
    if (!analytics) return;
    setAnalyticsHistory(prev => [...prev.slice(-59), {
      ts: Date.now(),
      cellCount: analytics.cell_count || 0,
      atypicalPct: analytics.abnormal_pct || 0,
      inferenceMs: analytics.inference_ms || 0,
    }]);
  }, [analytics]);

  useEffect(() => {
    if (!analytics) return;
    const pct = analytics.abnormal_pct || 0;
    const lvl = pct > 30 ? "critical" : pct > 10 ? "warning" : "normal";
    setAlertLevel(prev => {
      if (prev !== lvl) {
        if (lvl === "critical") log(`Critical: ${pct}% dysmorphic cells detected`, "alert");
        else if (lvl === "warning" && prev !== "critical") log(`Borderline: ${pct}% atypical morphology`, "alert");
      }
      return lvl;
    });
  }, [analytics, log]);

  useEffect(() => {
    if (operationMode === "auto" && alertLevel === "critical" && !flaggedForReview) { setFlaggedForReview(true); log("Auto-flagged for pathologist review", "alert"); }
  }, [operationMode, alertLevel, flaggedForReview, log]);

  const switchMode = async (m) => { try { const r = await fetch(`${API_URL}/mode/${m}`, { method: "POST" }); const d = await r.json(); if (d.success) { setMode(d.mode); log(`Analysis mode: ${d.mode === "blood_cell" ? "CBC/Differential" : "General Cytology"}`, "action"); } } catch {} };
  const updateConfidence = async (v) => { setConfidence(v); try { await fetch(`${API_URL}/confidence/${v}`, { method: "POST" }); } catch {} };
  const toggleShapes = async () => { const n = !shapesEnabled; setShapesEnabled(n); try { await fetch(`${API_URL}/shapes/${n}`, { method: "POST" }); } catch {} };

  const startCamera = useCallback(async () => {
    setCameraLoading(true);
    log("Initializing microscope camera...", "action");
    try {
      const res = await fetch(`${API_URL}/camera/start`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Connection failed" }));
        log(`Camera error: ${err.detail}`, "alert");
        // Fallback: try streaming directly (for QNX backend)
        setStreaming(true);
        log("Camera feed active", "action");
        return;
      }
      setStreaming(true);
      log("Microscope camera connected", "action");
    } catch (e) {
      // Fallback for QNX-style backend without /camera/start
      setStreaming(true);
      log("Camera feed active", "action");
    } finally {
      setCameraLoading(false);
    }
  }, [log]);

  const stopCamera = useCallback(async () => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    clearInterval(intervalRef.current);
    setStreaming(false);
    setDetecting(false);
    setDetections([]);
    try { await fetch(`${API_URL}/camera/stop`, { method: "POST" }); } catch {}
    log("Camera stopped", "action");
  }, [log]);

  const connectWs = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) return;
    const ws = new WebSocket(WS_URL);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => { setConnected(false); setDetecting(false); };
    ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.detections) { setDetections(d.detections); if (d.mode) setMode(d.mode); if (d.analytics) setAnalytics(d.analytics); const now = Date.now(); setFps(Math.round(1000 / (now - lastFrameTime.current))); lastFrameTime.current = now; } };
    wsRef.current = ws;
  }, []);

  const toggleDetection = useCallback(() => {
    if (detecting) { clearInterval(intervalRef.current); setDetecting(false); setDetections([]); log("Analysis paused", "action"); return; }
    if (!streaming) return;
    connectWs();
    intervalRef.current = setInterval(() => { const ws = wsRef.current; if (!ws || ws.readyState !== WebSocket.OPEN) return; ws.send("pi"); }, FRAME_INTERVAL_MS);
    setDetecting(true); log("Cytological analysis started", "action");
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
    setReportGenerating(true); log("Generating lab report...", "action");
    try {
      const r = await fetch(`${API_URL}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId, session_duration: sessionElapsed, snapshots_count: snapshots.length, operation_mode: operationMode, flagged_for_review: flaggedForReview, log_entries: sessionLog.slice(-50) }) });
      const d = await r.json(); setReportData(d); setShowReportPreview(true); log(`Report ${d.report_id} generated`, "success");
    } catch (err) { log(`Report generation failed: ${err.message}`, "alert"); } finally { setReportGenerating(false); }
  }, [sessionId, sessionElapsed, snapshots, operationMode, flaggedForReview, sessionLog, log]);

  const captureSnapshot = useCallback(() => {
    const canvas = canvasRef.current, video = videoRef.current; if (!canvas || !video) return;
    const c = captureCanvasRef.current; c.width = video.naturalWidth || 2304; c.height = video.naturalHeight || 1296;
    const ctx = c.getContext("2d"); ctx.drawImage(video, 0, 0); ctx.drawImage(canvas, 0, 0);
    setSnapshots(prev => [...prev, { dataUrl: c.toDataURL("image/png"), timestamp: new Date().toISOString() }]);
    log(`FOV capture #${snapshots.length + 1} saved`, "success");
  }, [snapshots.length, log]);

  const toggleFlag = useCallback(() => { setFlaggedForReview(prev => { log(prev ? "Pathologist review flag removed" : "Flagged for pathologist review", prev ? "action" : "alert"); return !prev; }); }, [log]);

  const yoloDets = detections.filter(d => d.type === "yolo");
  const shapeDets = detections.filter(d => d.type === "shape");
  const grp = (arr) => arr.reduce((a, d) => { a[d.label] = a[d.label] || { count: 0, color: d.color, maxConf: 0 }; a[d.label].count++; a[d.label].maxConf = Math.max(a[d.label].maxConf, d.confidence); return a; }, {});

  return (
    <div className="dashboard">
      <HeaderBar backendConnected={backendConnected} cameraConnected={cameraConnected} voiceActive={voiceActive} sessionElapsed={sessionElapsed} detecting={detecting} operationMode={operationMode} setOperationMode={setOperationMode} flaggedForReview={flaggedForReview} />

      <div className="dashboard-body">
        <div className="panel-left">
          <div className="camera-section">
            {streaming ? (
              <div className="video-container">
                <img ref={videoRef} src={`${API_URL}/camera/stream`} alt="Microscope Field of View" />
                <canvas ref={canvasRef} />
              </div>
            ) : (
              <div className="no-camera">
                <p>{cameraLoading ? "Initializing..." : "No microscope feed"}</p>
                <p className="cam-hint">Connect the microscope camera to begin cytological analysis</p>
                <button onClick={startCamera} disabled={cameraLoading}>{cameraLoading ? "Connecting..." : "Start Camera"}</button>
              </div>
            )}
          </div>

          <div className="ctrl-section">
            <div className="section-label">Instrument Controls</div>
            <div className="ctrl-row">
              <button className={`ctrl-btn ${streaming ? "ctrl-active" : ""}`} onClick={streaming ? stopCamera : startCamera} disabled={cameraLoading}>{cameraLoading ? "Connecting..." : streaming ? "Stop" : "Start Camera"}</button>
              <button className={`ctrl-btn ${detecting ? "ctrl-active" : ""}`} onClick={toggleDetection} disabled={!streaming}>{detecting ? "Pause" : "Analyze"}</button>
            </div>
          </div>

          <div className="ctrl-section">
            <div className="section-label">Analysis Parameters</div>
            <div className="ctrl-row" style={{ marginBottom: 10 }}>
              {availableModes.map(m => <button key={m} className={`ctrl-btn ${mode === m ? "ctrl-active" : ""}`} onClick={() => switchMode(m)}>{m === "general" ? "General" : "CBC"}</button>)}
            </div>
            <div className="confidence-row">
              <label>Detection Threshold {Math.round(confidence * 100)}%</label>
              <input type="range" min="5" max="95" value={Math.round(confidence * 100)} onChange={e => updateConfidence(e.target.value / 100)} />
            </div>
            <div className="toggle-row">
              <label>Geometric Detection</label>
              <button className={`toggle-btn ${shapesEnabled ? "active" : ""}`} onClick={toggleShapes}>{shapesEnabled ? "On" : "Off"}</button>
            </div>
          </div>

          <div className="ctrl-section">
            <div className="section-label">{mode === "blood_cell" ? "Identified Cells" : "Detected Objects"}</div>
            <DetectionList summary={grp(yoloDets)} detecting={detecting} />
          </div>

          {shapesEnabled && Object.keys(grp(shapeDets)).length > 0 && (
            <div className="ctrl-section">
              <div className="section-label">Geometric Structures</div>
              <DetectionList summary={grp(shapeDets)} detecting={detecting} />
            </div>
          )}
        </div>

        <div className="panel-center">
          <AtypicalGauge value={analytics?.abnormal_pct ?? 0} alertLevel={alertLevel} />
          <LiveStatsGrid analytics={analytics} fps={fps} detecting={detecting} totalDetections={detections.length} mode={mode} />

          <div className="charts-row">
            <TrendChart history={analyticsHistory} />
            <DistributionDonut classCounts={analytics?.class_counts} />
          </div>

          {mode === "blood_cell" && <MorphologyBars morphologyCounts={analytics?.morphology_counts} />}
          <ReferenceRanges analytics={analytics} detecting={detecting} />
          <ClassBreakdownChips classCounts={analytics?.class_counts} />
          <ClinicalAssessment analytics={analytics} alertLevel={alertLevel} detecting={detecting} />
        </div>

        <div className="panel-right">
          <div className="panel-section">
            <SpecimenInfo sessionId={sessionId} sessionElapsed={sessionElapsed} detecting={detecting} mode={mode} snapshots={snapshots.length} flagged={flaggedForReview} />
          </div>
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
