import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import "./App.css";
import VoiceAgent from "./VoiceAgent";

const API_URL = "http://localhost:8000";

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

function HeaderBar({ backendConnected, cameraConnected, voiceActive, sessionElapsed, capturing, operationMode, setOperationMode, flaggedForReview, demoMode, toggleDemo }) {
  return (
    <div className="header-bar">
      <div className="header-brand">
        <svg className="brand-icon" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
          <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2.5"/>
          <circle cx="16" cy="16" r="6" fill="currentColor"/>
          <line x1="16" y1="2" x2="16" y2="8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <line x1="16" y1="24" x2="16" y2="30" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <line x1="2" y1="16" x2="8" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <line x1="24" y1="16" x2="30" y2="16" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </svg>
        <h1>Tempus</h1>
        <span className="brand-sub">Hematology</span>
      </div>
      <div className="header-center">
        <div className="conn-row">
          <div className={`conn-item ${cameraConnected ? "on" : ""}`}><div className="conn-dot" />Camera</div>
          <div className={`conn-item ${backendConnected ? "on" : ""}`}><div className="conn-dot" />Backend</div>
          <div className={`conn-item ${voiceActive ? "on" : ""}`}><div className="conn-dot" />Voice</div>
        </div>
        {capturing && <div className="session-timer">{fmt(sessionElapsed)}</div>}
        {flaggedForReview && <div className="header-flag">Review Required</div>}
      </div>
      <div className="header-right">
        <button className={`demo-btn ${demoMode ? "demo-active" : ""}`} onClick={toggleDemo}>Demo</button>
        <div className="mode-toggle">
          <button className={operationMode === "auto" ? "mode-active" : ""} onClick={() => setOperationMode("auto")}>Auto</button>
          <button className={operationMode === "review" ? "mode-active" : ""} onClick={() => setOperationMode("review")}>Review</button>
        </div>
      </div>
    </div>
  );
}

// ── Specimen Info ──

function SpecimenInfo({ sessionId, sessionElapsed, hasCaptures, mode, captureCount, flagged }) {
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
          <span className={`specimen-val ${hasCaptures ? "specimen-active" : ""}`}>{hasCaptures ? "Active" : "Idle"}</span>
        </div>
        <div className="specimen-field">
          <span className="specimen-key">Captures</span>
          <span className="specimen-val mono">{captureCount}</span>
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

function LiveStatsGrid({ analytics, mode }) {
  const active = !!analytics;
  return (
    <div>
      <div className="section-label">Capture Metrics</div>
      <div className="stats-grid">
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
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? `${analytics?.abnormal_pct ?? 0}%` : "--"}</div>
          <div className="stat-lbl">Atypical</div>
        </div>
        <div className="stat-cell">
          <div className={`stat-val ${!active ? "val-dim" : ""}`}>{active ? (analytics?.avg_cell_area ?? 0) : "--"}</div>
          <div className="stat-lbl">Avg Area</div>
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
        <div className="chart-empty">Awaiting capture data</div>
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

function ReferenceRanges({ analytics }) {
  if (!analytics) {
    return (
      <div>
        <div className="section-label">Reference Ranges</div>
        <div className="chart-empty">Awaiting capture data</div>
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

function ClinicalAssessment({ analytics, alertLevel, llmAnalysis }) {
  const text = useMemo(() => {
    if (!analytics) return null;
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
  }, [analytics]);

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
            {llmAnalysis && (
              <>
                <div className="section-label" style={{ marginTop: 16 }}>AI Analysis</div>
                <p className="assessment-text">{llmAnalysis}</p>
              </>
            )}
          </>
        ) : (
          <p className="assessment-empty">Capture a frame to begin cytological analysis</p>
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

function QuickActions({ flaggedForReview, onFlag, onReport, reportGenerating }) {
  return (
    <div>
      <div className="section-label">Actions</div>
      <div className="quick-actions">
        <button className={`action-btn ${flaggedForReview ? "action-flagged" : ""}`} onClick={onFlag}>
          {flaggedForReview ? "Remove Flag" : "Flag for Pathologist Review"}
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

// ── Captures Gallery ──

function CapturesGallery({ captures, onSelect }) {
  if (captures.length === 0) {
    return (
      <div className="captures-gallery-empty">
        <p>No captures yet</p>
        <p className="captures-hint">Click Capture or say "capture" to analyze the current field of view</p>
      </div>
    );
  }

  return (
    <div className="captures-gallery">
      {[...captures].reverse().map((cap) => (
        <div key={cap.id} className="capture-card" onClick={() => onSelect(cap)}>
          <img className="capture-thumb" src={`data:image/jpeg;base64,${cap.imageB64}`} alt="Capture" />
          <div className="capture-meta">
            <span className="capture-time">{new Date(cap.timestamp).toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
            <span className="capture-cell-count">{cap.analytics?.cell_count ?? 0} cells</span>
            <span className={`capture-alert-badge level-${cap.alertLevel}`}>{cap.alertLevel === "normal" ? "WNL" : cap.alertLevel === "warning" ? "BDL" : "CRIT"}</span>
          </div>
          {cap.llmAnalysis && (
            <p className="capture-analysis-preview">{cap.llmAnalysis.slice(0, 120)}{cap.llmAnalysis.length > 120 ? "..." : ""}</p>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Capture Detail Modal ──

function CaptureDetailModal({ capture, onClose }) {
  if (!capture) return null;

  const levelLabels = { normal: "WNL", warning: "Borderline", critical: "Critical" };

  return (
    <div className="capture-detail-overlay" onClick={onClose}>
      <div className="capture-detail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="report-header">
          <div>
            <h2>Capture Detail</h2>
            <span className="report-subtitle">{new Date(capture.timestamp).toLocaleString()}</span>
          </div>
          <button className="report-close" onClick={onClose}>{"\u00d7"}</button>
        </div>
        <div className="capture-detail-body">
          <img className="capture-detail-image" src={`data:image/jpeg;base64,${capture.imageB64}`} alt="Captured frame" />

          <div className="capture-detail-stats">
            <span className={`assessment-badge level-${capture.alertLevel}`}>{levelLabels[capture.alertLevel]}</span>
            <span className="capture-detail-stat">{capture.analytics?.cell_count ?? 0} cells</span>
            <span className="capture-detail-stat">{capture.analytics?.abnormal_pct ?? 0}% atypical</span>
            <span className="capture-detail-stat">{capture.analytics?.inference_ms ?? 0}ms</span>
          </div>

          {capture.analytics?.morphology_counts && Object.keys(capture.analytics.morphology_counts).length > 0 && (
            <div className="capture-detail-section">
              <div className="section-label">Morphology</div>
              <div className="capture-detail-chips">
                {Object.entries(capture.analytics.morphology_counts).map(([k, v]) => (
                  <span key={k} className="capture-detail-chip">{k}: {v}</span>
                ))}
              </div>
            </div>
          )}

          {capture.analytics?.class_counts && Object.keys(capture.analytics.class_counts).length > 0 && (
            <div className="capture-detail-section">
              <div className="section-label">Classification</div>
              <div className="capture-detail-chips">
                {Object.entries(capture.analytics.class_counts).map(([k, v]) => (
                  <span key={k} className="capture-detail-chip">{k}: {v}</span>
                ))}
              </div>
            </div>
          )}

          {capture.llmAnalysis && (
            <div className="capture-detail-section">
              <div className="section-label">AI Analysis</div>
              <p className="capture-detail-analysis">{capture.llmAnalysis}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Detection List ──

function DetectionList({ summary }) {
  if (Object.keys(summary).length === 0) return <p style={{ color: "var(--text-faint)", fontSize: 12 }}>No detections</p>;
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
  const streamRef = useRef(null);

  const [streaming, setStreaming] = useState(false);
  const [detections, setDetections] = useState([]);
  const [analytics, setAnalytics] = useState(null);
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
  const [flaggedForReview, setFlaggedForReview] = useState(false);
  const [backendConnected, setBackendConnected] = useState(false);
  const [cameraConnected, setCameraConnected] = useState(false);
  const [voiceActive, setVoiceActive] = useState(false);
  const [, setVoiceStatus] = useState("idle");
  const [showReportPreview, setShowReportPreview] = useState(false);
  const [analyticsHistory, setAnalyticsHistory] = useState([]);
  const [cameraLoading, setCameraLoading] = useState(false);
  const [demoMode, setDemoMode] = useState(false);

  // Capture workflow state
  const [captures, setCaptures] = useState([]);
  const [captureLoading, setCaptureLoading] = useState(false);
  const [centerTab, setCenterTab] = useState("metrics");
  const [selectedCapture, setSelectedCapture] = useState(null);
  const [llmAnalysis, setLlmAnalysis] = useState(null);

  const log = useCallback((msg, type = "info") => {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
    setSessionLog((prev) => [...prev.slice(-200), { time, message: msg, type }]);
  }, []);

  useEffect(() => { fetch(`${API_URL}/status`).then(r => r.json()).then(d => { setMode(d.mode); setAvailableModes(d.available_modes); setConfidence(d.conf_threshold); setShapesEnabled(d.shapes_enabled); }).catch(() => {}); }, []);

  useEffect(() => {
    const poll = () => fetch(`${API_URL}/health`).then(r => r.json()).then(d => { setBackendConnected(d.status === "ok"); setCameraConnected(d.camera_connected === true); }).catch(() => { setBackendConnected(false); setCameraConnected(false); });
    poll(); const id = setInterval(poll, 5000); return () => clearInterval(id);
  }, []);

  // Session timer starts when camera is streaming
  useEffect(() => { if (!streaming) return; setSessionElapsed(0); const id = setInterval(() => setSessionElapsed(p => p + 1), 1000); return () => clearInterval(id); }, [streaming]);

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

  const toggleDemo = async () => {
    try {
      const res = await fetch(`${API_URL}/demo/toggle`, { method: "POST" });
      const d = await res.json();
      setDemoMode(d.demo);
      log(d.demo ? "Demo mode enabled" : "Demo mode disabled", "action");
    } catch { log("Failed to toggle demo mode", "alert"); }
  };

  const startCamera = useCallback(async () => {
    setCameraLoading(true);
    log("Initializing microscope camera...", "action");
    try {
      const res = await fetch(`${API_URL}/camera/start`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Connection failed" }));
        log(`Camera error: ${err.detail}`, "alert");
        setStreaming(true);
        log("Camera feed active", "action");
        return;
      }
      setStreaming(true);
      log("Microscope camera connected", "action");
    } catch (e) {
      setStreaming(true);
      log("Camera feed active", "action");
    } finally {
      setCameraLoading(false);
    }
  }, [log]);

  const stopCamera = useCallback(async () => {
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    setStreaming(false);
    setDetections([]);
    try { await fetch(`${API_URL}/camera/stop`, { method: "POST" }); } catch {}
    log("Camera stopped", "action");
  }, [log]);

  // ── Capture handler ──
  const handleCapture = useCallback(async () => {
    if (captureLoading) return;
    setCaptureLoading(true);
    log("Capturing and analyzing frame...", "action");

    try {
      const res = await fetch(`${API_URL}/capture/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: "pi" }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Capture failed" }));
        log(`Capture error: ${err.detail}`, "alert");
        return;
      }
      const data = await res.json();
      const captureEntry = {
        id: uid(),
        timestamp: new Date().toISOString(),
        imageB64: data.image_b64,
        detections: data.detections,
        analytics: data.analytics,
        llmAnalysis: data.llm_analysis,
        alertLevel: data.alert_level,
      };

      setCaptures(prev => [...prev, captureEntry]);
      setDetections(data.detections);
      setAnalytics(data.analytics);
      setAlertLevel(data.alert_level);
      setLlmAnalysis(data.llm_analysis);
      setCenterTab("captures");

      const cellCount = data.analytics?.cell_count ?? 0;
      log(`Capture #${captures.length + 1}: ${cellCount} cells detected${data.llm_analysis ? " + AI analysis" : ""}`, "success");
    } catch (err) {
      log(`Capture failed: ${err.message}`, "alert");
    } finally {
      setCaptureLoading(false);
    }
  }, [captureLoading, captures.length, log]);

  // ── Voice capture result handler ──
  const handleVoiceCaptureResult = useCallback((msg) => {
    const captureEntry = {
      id: uid(),
      timestamp: new Date().toISOString(),
      imageB64: msg.image_b64,
      detections: msg.detections,
      analytics: msg.analytics,
      llmAnalysis: msg.llm_analysis,
      alertLevel: msg.alert_level,
    };

    setCaptures(prev => [...prev, captureEntry]);
    setDetections(msg.detections);
    setAnalytics(msg.analytics);
    setAlertLevel(msg.alert_level);
    setLlmAnalysis(msg.llm_analysis);
    setCenterTab("captures");

    const cellCount = msg.analytics?.cell_count ?? 0;
    log(`Voice capture: ${cellCount} cells detected${msg.llm_analysis ? " + AI analysis" : ""}`, "success");
  }, [log]);

  // Draw detections overlay
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

  useEffect(() => { return () => { if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop()); }; }, []);

  const generateReport = useCallback(async () => {
    setReportGenerating(true); log("Generating lab report...", "action");
    try {
      const r = await fetch(`${API_URL}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ session_id: sessionId, session_duration: sessionElapsed, snapshots_count: captures.length, operation_mode: operationMode, flagged_for_review: flaggedForReview, log_entries: sessionLog.slice(-50) }) });
      const d = await r.json(); setReportData(d); setShowReportPreview(true); log(`Report ${d.report_id} generated`, "success");
    } catch (err) { log(`Report generation failed: ${err.message}`, "alert"); } finally { setReportGenerating(false); }
  }, [sessionId, sessionElapsed, captures, operationMode, flaggedForReview, sessionLog, log]);

  const toggleFlag = useCallback(() => { setFlaggedForReview(prev => { log(prev ? "Pathologist review flag removed" : "Flagged for pathologist review", prev ? "action" : "alert"); return !prev; }); }, [log]);

  const yoloDets = detections.filter(d => d.type === "yolo");
  const shapeDets = detections.filter(d => d.type === "shape");
  const grp = (arr) => arr.reduce((a, d) => { a[d.label] = a[d.label] || { count: 0, color: d.color, maxConf: 0 }; a[d.label].count++; a[d.label].maxConf = Math.max(a[d.label].maxConf, d.confidence); return a; }, {});

  return (
    <div className="dashboard">
      <HeaderBar backendConnected={backendConnected} cameraConnected={cameraConnected} voiceActive={voiceActive} sessionElapsed={sessionElapsed} capturing={captures.length > 0} operationMode={operationMode} setOperationMode={setOperationMode} flaggedForReview={flaggedForReview} demoMode={demoMode} toggleDemo={toggleDemo} />

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
              <button
                className={`capture-btn ${captureLoading ? "loading" : ""}`}
                onClick={handleCapture}
                disabled={!streaming || captureLoading}
              >
                {captureLoading ? "Analyzing..." : "Capture"}
              </button>
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

          {detections.length > 0 && (
            <div className="ctrl-section">
              <div className="section-label">{mode === "blood_cell" ? "Last Capture Cells" : "Last Capture Objects"}</div>
              <DetectionList summary={grp(yoloDets)} />
            </div>
          )}

          {shapesEnabled && Object.keys(grp(shapeDets)).length > 0 && (
            <div className="ctrl-section">
              <div className="section-label">Geometric Structures</div>
              <DetectionList summary={grp(shapeDets)} />
            </div>
          )}
        </div>

        <div className="panel-center">
          <div className="center-tabs">
            <button
              className={`center-tab ${centerTab === "metrics" ? "active" : ""}`}
              onClick={() => setCenterTab("metrics")}
            >
              Metrics
            </button>
            <button
              className={`center-tab ${centerTab === "captures" ? "active" : ""}`}
              onClick={() => setCenterTab("captures")}
            >
              Captures ({captures.length})
            </button>
          </div>

          {centerTab === "metrics" ? (
            <>
              <AtypicalGauge value={analytics?.abnormal_pct ?? 0} alertLevel={alertLevel} />
              <LiveStatsGrid analytics={analytics} mode={mode} />

              <div className="charts-row">
                <TrendChart history={analyticsHistory} />
                <DistributionDonut classCounts={analytics?.class_counts} />
              </div>

              {mode === "blood_cell" && <MorphologyBars morphologyCounts={analytics?.morphology_counts} />}
              <ReferenceRanges analytics={analytics} />
              <ClassBreakdownChips classCounts={analytics?.class_counts} />
              <ClinicalAssessment analytics={analytics} alertLevel={alertLevel} llmAnalysis={llmAnalysis} />
            </>
          ) : (
            <CapturesGallery captures={captures} onSelect={setSelectedCapture} />
          )}
        </div>

        <div className="panel-right">
          <div className="panel-section">
            <SpecimenInfo sessionId={sessionId} sessionElapsed={sessionElapsed} hasCaptures={captures.length > 0} mode={mode} captureCount={captures.length} flagged={flaggedForReview} />
          </div>
          <div className="panel-section"><VoiceAgent expanded onStatusChange={setVoiceStatus} onActiveChange={setVoiceActive} onCaptureResult={handleVoiceCaptureResult} /></div>
          <div className="panel-section"><SessionLog entries={sessionLog} /></div>
          <div className="panel-section"><QuickActions flaggedForReview={flaggedForReview} onFlag={toggleFlag} onReport={generateReport} reportGenerating={reportGenerating} /></div>
        </div>
      </div>

      {showReportPreview && <ReportPreview reportData={reportData} onClose={() => setShowReportPreview(false)} />}
      {selectedCapture && <CaptureDetailModal capture={selectedCapture} onClose={() => setSelectedCapture(null)} />}
    </div>
  );
}

export default App;
