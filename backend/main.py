import asyncio
import json
import os
import socket
import struct
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

QNX_CAMERA_HOST = os.getenv("QNX_CAMERA_HOST", "qnxpi27.local")
QNX_CAMERA_PORT = int(os.getenv("QNX_CAMERA_PORT", "8765"))
QNX_FRAME_MAGIC = 0x514E5846
qnx_frame = None
qnx_frame_lock = threading.Lock()
qnx_camera_connected = False


def _recv_exact(sock: socket.socket, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        chunk = sock.recv(size - len(chunks))
        if not chunk:
            raise ConnectionError("QNX camera bridge disconnected")
        chunks.extend(chunk)
    return bytes(chunks)


def _resolve_host(host: str, port: int, timeout: float = 3) -> tuple:
    """Resolve hostname with a timeout to avoid mDNS hangs."""
    socket.setdefaulttimeout(timeout)
    try:
        infos = socket.getaddrinfo(host, port, socket.AF_INET, socket.SOCK_STREAM)
        if infos:
            return infos[0][4]  # (ip, port)
    finally:
        socket.setdefaulttimeout(None)
    raise OSError(f"Cannot resolve {host}")


def _qnx_camera_receiver():
    """Keep the latest QNX Camera Module 3 frame in memory."""
    global qnx_frame, qnx_camera_connected
    while True:
        try:
            addr = _resolve_host(QNX_CAMERA_HOST, QNX_CAMERA_PORT, timeout=5)
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sock.settimeout(5)
            sock.connect(addr)
            sock.settimeout(10)
            qnx_camera_connected = True
            try:
                while True:
                    magic, width, height, stride, uv_offset, uv_stride, _format, size = struct.unpack(
                        "!8I", _recv_exact(sock, 32)
                    )
                    if magic != QNX_FRAME_MAGIC or not (0 < size < 32_000_000):
                        raise ValueError("Invalid QNX camera frame header")
                    raw = _recv_exact(sock, size)
                    y_size = stride * height
                    nv12_size = uv_offset + uv_stride * (height // 2)
                    if len(raw) >= nv12_size:
                        source = np.frombuffer(raw, dtype=np.uint8)
                        y = source[:y_size].reshape(height, stride)[:, :width]
                        uv = source[uv_offset:nv12_size].reshape(height // 2, uv_stride)[:, :width]
                        nv12 = np.vstack((y, uv))
                        frame = cv2.cvtColor(nv12, cv2.COLOR_YUV2BGR_NV12)
                    elif len(raw) >= y_size:
                        gray = np.frombuffer(raw[:y_size], dtype=np.uint8).reshape(height, stride)
                        frame = cv2.cvtColor(gray[:, :width], cv2.COLOR_GRAY2BGR)
                    else:
                        raise ValueError("Incomplete QNX camera frame")
                    with qnx_frame_lock:
                        qnx_frame = frame
            finally:
                sock.close()
        except Exception:
            qnx_camera_connected = False
            time.sleep(2)


threading.Thread(target=_qnx_camera_receiver, daemon=True).start()


@app.get("/health")
def health():
    return {"status": "ok", "qnx_camera_connected": qnx_camera_connected}


@app.post("/camera/start")
def camera_start():
    """Wait for the QNX camera connection to be established before responding."""
    if qnx_camera_connected:
        return {"status": "connected"}
    # Wait up to 15 seconds for the receiver thread to connect
    deadline = time.time() + 15
    while time.time() < deadline:
        if qnx_camera_connected:
            # Wait a bit more for the first frame
            frame_deadline = time.time() + 3
            while time.time() < frame_deadline:
                with qnx_frame_lock:
                    if qnx_frame is not None:
                        return {"status": "connected"}
                time.sleep(0.2)
            return {"status": "connected"}
        time.sleep(0.5)
    raise HTTPException(
        status_code=503,
        detail=f"Cannot reach QNX camera at {QNX_CAMERA_HOST}:{QNX_CAMERA_PORT} — check Pi is on and camera bridge is running",
    )


@app.get("/qnx/frame.jpg")
def qnx_frame_jpeg():
    with qnx_frame_lock:
        frame = None if qnx_frame is None else qnx_frame.copy()
    if frame is None:
        raise HTTPException(status_code=503, detail="Waiting for QNX camera")
    ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        raise HTTPException(status_code=500, detail="JPEG encoding failed")
    return Response(content=jpeg.tobytes(), media_type="image/jpeg")


@app.get("/qnx/stream")
def qnx_mjpeg_stream():
    def frames():
        while True:
            with qnx_frame_lock:
                frame = None if qnx_frame is None else qnx_frame.copy()
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
                if data_url == "qnx":
                    with qnx_frame_lock:
                        frame = None if qnx_frame is None else qnx_frame.copy()
                    if frame is None:
                        raise RuntimeError("Waiting for QNX camera frame")
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
