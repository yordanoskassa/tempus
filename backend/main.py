import asyncio
import json
import os
import subprocess
import threading
import time
from datetime import datetime, timezone

from dotenv import load_dotenv
import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response, StreamingResponse
from websockets.asyncio.client import connect as ws_connect

from detector import Detector, decode_frame

load_dotenv()

app = FastAPI(title="VetrView - Cell Component Detection")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:5174",
        "http://127.0.0.1:5174",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

detector = Detector()

# Analytics cache for /alerts and /report endpoints
_last_analytics = {}
_last_analytics_lock = threading.Lock()

# Pi Camera via SSH
PI_SSH_HOST = os.getenv("PI_SSH_HOST", "pi@raspberrypi.local")
PI_CAMERA_WIDTH = int(os.getenv("PI_CAMERA_WIDTH", "1280"))
PI_CAMERA_HEIGHT = int(os.getenv("PI_CAMERA_HEIGHT", "720"))

pi_frame = None
pi_frame_lock = threading.Lock()
pi_camera_connected = False
_pi_process = None
_pi_reader_thread = None


def _pi_camera_reader(proc: subprocess.Popen):
    """Read MJPEG stream from SSH pipe and decode frames."""
    global pi_frame, pi_camera_connected
    buf = b""
    pi_camera_connected = True
    try:
        while proc.poll() is None:
            chunk = proc.stdout.read(8192)
            if not chunk:
                break
            buf += chunk
            # Parse MJPEG: find JPEG start (FFD8) and end (FFD9) markers
            while True:
                start = buf.find(b"\xff\xd8")
                if start == -1:
                    buf = b""
                    break
                end = buf.find(b"\xff\xd9", start + 2)
                if end == -1:
                    # Keep from start marker onward, wait for more data
                    buf = buf[start:]
                    break
                jpeg_data = buf[start:end + 2]
                buf = buf[end + 2:]
                # Decode JPEG to BGR frame
                arr = np.frombuffer(jpeg_data, dtype=np.uint8)
                frame = cv2.imdecode(arr, cv2.IMREAD_COLOR)
                if frame is not None:
                    with pi_frame_lock:
                        pi_frame = frame
    except Exception:
        pass
    finally:
        pi_camera_connected = False


def start_pi_camera() -> str:
    """SSH to Pi and start camera stream. Returns error string or empty on success."""
    global _pi_process, _pi_reader_thread, pi_camera_connected, pi_frame

    if _pi_process and _pi_process.poll() is None:
        return ""  # Already running

    # rpicam-vid outputs MJPEG to stdout over SSH
    cmd = [
        "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
        PI_SSH_HOST,
        f"rpicam-vid -t 0 --codec mjpeg --width {PI_CAMERA_WIDTH} --height {PI_CAMERA_HEIGHT} --framerate 15 -o -"
    ]

    try:
        _pi_process = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
    except Exception as e:
        return f"Failed to start SSH: {e}"

    # Wait briefly for connection to establish or fail
    time.sleep(2)
    if _pi_process.poll() is not None:
        stderr = _pi_process.stderr.read().decode(errors="replace").strip()
        _pi_process = None
        return f"SSH connection failed: {stderr}"

    # Start reader thread
    _pi_reader_thread = threading.Thread(target=_pi_camera_reader, args=(_pi_process,), daemon=True)
    _pi_reader_thread.start()

    # Wait for first frame (up to 8 seconds)
    deadline = time.time() + 8
    while time.time() < deadline:
        with pi_frame_lock:
            if pi_frame is not None:
                return ""
        time.sleep(0.2)

    # Timed out waiting for frames
    if not pi_camera_connected:
        stop_pi_camera()
        return "Connected to Pi but no frames received — is the camera attached?"
    return ""


def stop_pi_camera():
    """Stop the SSH camera process."""
    global _pi_process, pi_camera_connected, pi_frame
    if _pi_process:
        try:
            _pi_process.terminate()
            _pi_process.wait(timeout=5)
        except Exception:
            try:
                _pi_process.kill()
            except Exception:
                pass
        _pi_process = None
    pi_camera_connected = False
    with pi_frame_lock:
        pi_frame = None


@app.get("/health")
def health():
    return {"status": "ok", "camera_connected": pi_camera_connected}


@app.post("/camera/start")
def camera_start():
    """SSH to Pi, start camera, wait for first frame."""
    err = start_pi_camera()
    if err:
        raise HTTPException(status_code=503, detail=err)
    return {"status": "streaming", "resolution": [PI_CAMERA_WIDTH, PI_CAMERA_HEIGHT]}


@app.post("/camera/stop")
def camera_stop():
    """Stop Pi camera stream."""
    stop_pi_camera()
    return {"status": "stopped"}


@app.get("/camera/frame.jpg")
def camera_frame_jpeg():
    with pi_frame_lock:
        frame = None if pi_frame is None else pi_frame.copy()
    if frame is None:
        raise HTTPException(status_code=503, detail="Camera not streaming")
    ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        raise HTTPException(status_code=500, detail="JPEG encoding failed")
    return Response(content=jpeg.tobytes(), media_type="image/jpeg")


@app.get("/camera/stream")
def camera_mjpeg_stream():
    def frames():
        while True:
            with pi_frame_lock:
                frame = None if pi_frame is None else pi_frame.copy()
            if frame is not None:
                ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 75])
                if ok:
                    yield b"--frame\r\nContent-Type: image/jpeg\r\n\r\n" + jpeg.tobytes() + b"\r\n"
            time.sleep(0.1)
    return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame")


@app.get("/status")
def status():
    return detector.get_status()


@app.post("/mode/{mode}")
def set_mode(mode: str):
    ok = detector.set_mode(mode)
    return {"success": ok, **detector.get_status()}


@app.post("/confidence/{value}")
def set_confidence(value: float):
    detector.conf_threshold = max(0.05, min(0.95, value))
    return {"conf_threshold": detector.conf_threshold}


@app.post("/shapes/{enabled}")
def toggle_shapes(enabled: str):
    detector.shapes_enabled = enabled.lower() in ("true", "1", "on")
    return {"shapes_enabled": detector.shapes_enabled}


@app.websocket("/ws/detect")
async def detect_ws(websocket: WebSocket):
    """WebSocket endpoint for real-time frame detection.

    Client sends base64-encoded frames, server returns detection results.
    """
    await websocket.accept()
    try:
        while True:
            data_url = await websocket.receive_text()
            try:
                t0 = time.perf_counter()
                if data_url == "pi":
                    with pi_frame_lock:
                        frame = None if pi_frame is None else pi_frame.copy()
                    if frame is None:
                        raise RuntimeError("Camera not streaming")
                else:
                    frame = decode_frame(data_url)
                fh, fw = frame.shape[:2]
                detections = detector.detect(frame)
                inference_ms = round((time.perf_counter() - t0) * 1000, 1)

                # Compute analytics
                yolo_dets = [d for d in detections if d.get("type") == "yolo"]
                shape_dets = [d for d in detections if d.get("type") == "shape"]
                areas = [d["bbox"][2] * d["bbox"][3] for d in yolo_dets]
                frame_area = fw * fh

                analytics = {
                    "inference_ms": inference_ms,
                    "frame_size": [fw, fh],
                    "cell_count": len(yolo_dets),
                    "shape_count": len(shape_dets),
                    "avg_cell_area": round(sum(areas) / len(areas)) if areas else 0,
                    "min_cell_area": min(areas) if areas else 0,
                    "max_cell_area": max(areas) if areas else 0,
                    "coverage_pct": round(sum(areas) / frame_area * 100, 1) if frame_area else 0,
                }

                # Morphology breakdown
                morph_counts = {}
                for d in yolo_dets:
                    m = d.get("morphology", "N/A")
                    morph_counts[m] = morph_counts.get(m, 0) + 1
                analytics["morphology_counts"] = morph_counts

                # Per-class counts
                class_counts = {}
                for d in yolo_dets:
                    class_counts[d["label"]] = class_counts.get(d["label"], 0) + 1
                analytics["class_counts"] = class_counts

                # Per-shape counts
                shape_counts = {}
                for d in shape_dets:
                    shape_counts[d["label"]] = shape_counts.get(d["label"], 0) + 1
                analytics["shape_counts"] = shape_counts

                # Abnormality ratio
                normal = morph_counts.get("Normal", 0)
                total_morph = sum(morph_counts.values())
                analytics["abnormal_pct"] = round(
                    (total_morph - normal) / total_morph * 100, 1
                ) if total_morph > 0 else 0

                # Cache analytics for /alerts endpoint
                with _last_analytics_lock:
                    _last_analytics.update(analytics)

                await websocket.send_json({
                    "detections": detections,
                    "mode": detector.mode,
                    "analytics": analytics,
                })
            except Exception as e:
                await websocket.send_json({"error": str(e), "detections": []})
    except WebSocketDisconnect:
        pass


@app.get("/alerts")
def get_alerts():
    """Return current alert level from cached analytics for remote monitoring."""
    with _last_analytics_lock:
        analytics = _last_analytics.copy()
    if not analytics:
        return {"alert_level": "normal", "abnormal_pct": 0, "message": "No data yet"}
    abnormal = analytics.get("abnormal_pct", 0)
    if abnormal > 30:
        level = "critical"
        message = f"CRITICAL: {abnormal}% abnormal cells detected — immediate review recommended"
    elif abnormal > 10:
        level = "warning"
        message = f"WARNING: {abnormal}% abnormal cells detected — monitor closely"
    else:
        level = "normal"
        message = f"Normal: {abnormal}% abnormal cells within acceptable range"
    return {
        "alert_level": level,
        "abnormal_pct": abnormal,
        "message": message,
        "cell_count": analytics.get("cell_count", 0),
        "morphology_counts": analytics.get("morphology_counts", {}),
        "class_counts": analytics.get("class_counts", {}),
    }


@app.post("/report")
async def generate_report(request: Request):
    """Generate a structured report from session data."""
    body = await request.json()
    session_id = body.get("session_id", "unknown")
    session_duration = body.get("session_duration", 0)
    snapshots_count = body.get("snapshots_count", 0)
    operation_mode = body.get("operation_mode", "auto")
    flagged = body.get("flagged_for_review", False)
    log_entries = body.get("log_entries", [])

    with _last_analytics_lock:
        analytics = _last_analytics.copy()

    abnormal = analytics.get("abnormal_pct", 0)
    morph = analytics.get("morphology_counts", {})
    classes = analytics.get("class_counts", {})
    cell_count = analytics.get("cell_count", 0)

    if abnormal > 30:
        alert_level = "critical"
    elif abnormal > 10:
        alert_level = "warning"
    else:
        alert_level = "normal"

    # Generate assessment text
    findings = []
    if cell_count > 0:
        findings.append(f"Analyzed {cell_count} cells in the field of view.")
    if morph:
        abnormal_types = {k: v for k, v in morph.items() if k != "Normal" and k != "N/A"}
        if abnormal_types:
            parts = [f"{v} {k}" for k, v in abnormal_types.items()]
            findings.append(f"Abnormal morphologies detected: {', '.join(parts)}.")
        normal_count = morph.get("Normal", 0)
        if normal_count > 0:
            findings.append(f"{normal_count} cells with normal morphology.")
    if classes:
        parts = [f"{v} {k}" for k, v in classes.items()]
        findings.append(f"Cell classification: {', '.join(parts)}.")

    assessment = " ".join(findings) if findings else "No significant findings."
    if alert_level == "critical":
        assessment += " RECOMMENDATION: Immediate review by certified technician required."
    elif alert_level == "warning":
        assessment += " RECOMMENDATION: Close monitoring advised; consider further analysis."

    report = {
        "report_id": f"VR-{session_id[:8].upper()}",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "session": {
            "id": session_id,
            "duration_seconds": session_duration,
            "operation_mode": operation_mode,
            "flagged_for_review": flagged,
            "snapshots_captured": snapshots_count,
            "log_entry_count": len(log_entries),
        },
        "analytics": {
            "cell_count": cell_count,
            "abnormal_pct": abnormal,
            "alert_level": alert_level,
            "morphology_counts": morph,
            "class_counts": classes,
            "coverage_pct": analytics.get("coverage_pct", 0),
            "avg_cell_area": analytics.get("avg_cell_area", 0),
        },
        "assessment": assessment,
    }
    return report


def build_voice_settings() -> dict:
    """Build Deepgram Voice Agent Settings message with current detector context."""
    status = detector.get_status()
    context_lines = [
        f"Detection mode: {status.get('mode', 'general')}",
        f"Confidence threshold: {status.get('conf_threshold', 0.35)}",
        f"Available modes: {', '.join(status.get('available_modes', []))}",
    ]
    context = "\n".join(context_lines)

    return {
        "type": "SettingsConfiguration",
        "audio": {
            "input": {
                "encoding": "linear16",
                "sample_rate": 16000,
            },
            "output": {
                "encoding": "linear16",
                "sample_rate": 24000,
                "container": "none",
            },
        },
        "agent": {
            "listen": {"model": "nova-3"},
            "think": {
                "provider": {"type": "open_ai"},
                "model": "gpt-4o-mini",
                "instructions": (
                    "You are VetrView Assistant, a helpful voice assistant for a veterinary "
                    "microscopy lab. You help lab technicians understand cell detection results, "
                    "morphology findings, and answer questions about the analysis.\n\n"
                    "Current detector state:\n" + context + "\n\n"
                    "Keep answers concise and spoken-friendly. Use plain language. "
                    "If asked about results you don't have, say the user should run detection first."
                ),
            },
            "speak": {"model": "aura-2-theia-en"},
        },
    }


@app.websocket("/ws/voice")
async def voice_ws(websocket: WebSocket):
    """Bidirectional proxy between browser and Deepgram Voice Agent."""
    api_key = os.getenv("DEEPGRAM_API_KEY", "")
    if not api_key or api_key == "your_deepgram_api_key_here":
        await websocket.accept()
        await websocket.send_json({"error": "DEEPGRAM_API_KEY not configured"})
        await websocket.close()
        return

    await websocket.accept()

    dg_url = "wss://agent.deepgram.com/agent"
    dg_headers = {"Authorization": f"Token {api_key}"}

    try:
        async with ws_connect(dg_url, additional_headers=dg_headers) as dg_ws:
            # Send settings as first message
            settings = build_voice_settings()
            await dg_ws.send(json.dumps(settings))

            async def browser_to_deepgram():
                """Forward browser audio/text to Deepgram."""
                try:
                    while True:
                        msg = await websocket.receive()
                        if msg.get("bytes"):
                            await dg_ws.send(msg["bytes"])
                        elif msg.get("text"):
                            await dg_ws.send(msg["text"])
                except WebSocketDisconnect:
                    pass

            async def deepgram_to_browser():
                """Forward Deepgram responses to browser."""
                try:
                    async for msg in dg_ws:
                        if isinstance(msg, bytes):
                            await websocket.send_bytes(msg)
                        else:
                            await websocket.send_text(msg)
                except Exception:
                    pass

            await asyncio.gather(
                browser_to_deepgram(),
                deepgram_to_browser(),
            )
    except Exception as e:
        try:
            await websocket.send_json({"error": f"Deepgram connection failed: {str(e)}"})
        except Exception:
            pass
    finally:
        try:
            await websocket.close()
        except Exception:
            pass
