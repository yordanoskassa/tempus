import asyncio
import base64
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

from pathlib import Path
from detector import Detector, decode_frame

# Gemini (optional)
try:
    from google import genai
    from google.genai import types as genai_types
    _GENAI_AVAILABLE = True
except ImportError:
    _GENAI_AVAILABLE = False

load_dotenv()

app = FastAPI(title="Tempus - Hematology Cell Analysis")

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

PI_SSH_HOST = os.getenv("PI_SSH_HOST", "qnxuser@qnxpi27.local")
PI_SSH_PASS = os.getenv("PI_SSH_PASS", "qnxuser")
CAM_WIDTH = 640
CAM_HEIGHT = 480
CAM_FPS = 10

camera_frame = None
camera_frame_lock = threading.Lock()
camera_connected = False
_cam_proc = None
_receiver_thread = None
_stop_camera = threading.Event()
_camera_paused = threading.Event()  # When set, frames are read but not exposed

# Demo mode
BACKEND_DIR = Path(__file__).parent
DEMO_DIR = BACKEND_DIR / "demo_images"
_demo_mode = False
_demo_image_index = 0
_demo_images: list[Path] = sorted(
    p for p in DEMO_DIR.glob("*") if p.suffix.lower() in (".png", ".jpg", ".jpeg")
) if DEMO_DIR.exists() else []


def _kill_pi_camera_procs():
    """Kill any existing camera processes on the Pi."""
    cmd = [
        "sshpass", "-p", PI_SSH_PASS,
        "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
        PI_SSH_HOST,
        "slay -f cam_stream 2>/dev/null; slay -f camera_bridge 2>/dev/null; "
        "slay -f camera_example3_viewfinder 2>/dev/null",
    ]
    try:
        subprocess.run(cmd, timeout=15, capture_output=True)
        time.sleep(2)
    except Exception:
        pass


class FrameReader:
    """Reads length-prefixed JPEG frames from cam_stream."""

    def __init__(self, stream):
        self._stream = stream

    def read_frame(self):
        """Read next frame: 4-byte big-endian length + JPEG data."""
        hdr = self._read_exact(4)
        if not hdr:
            raise ConnectionError("Stream closed")
        size = int.from_bytes(hdr, "big")
        if size == 0 or size > 10_000_000:
            raise ConnectionError(f"Invalid frame size: {size}")
        data = self._read_exact(size)
        if not data:
            raise ConnectionError("Stream closed mid-frame")
        return data

    def _read_exact(self, n):
        buf = bytearray()
        while len(buf) < n:
            chunk = self._stream.read(n - len(buf))
            if not chunk:
                return None
            buf.extend(chunk)
        return bytes(buf)


def _center_crop_and_enhance(frame, crop_ratio=0.65):
    """Center-crop and sharpen frame to remove dark circular lens edges."""
    h, w = frame.shape[:2]
    cx, cy = w // 2, h // 2
    crop_w, crop_h = int(w * crop_ratio) // 2, int(h * crop_ratio) // 2
    cropped = frame[cy - crop_h:cy + crop_h, cx - crop_w:cx + crop_w]
    # Unsharp mask for sharpening
    gaussian = cv2.GaussianBlur(cropped, (0, 0), 2.0)
    sharpened = cv2.addWeighted(cropped, 1.5, gaussian, -0.5, 0)
    return sharpened


def _draw_annotations(frame, detections):
    """Draw YOLO bounding boxes, labels, confidence, and morphology tags on a frame copy."""
    annotated = frame.copy()
    for det in detections:
        x, y, w, h = det["bbox"]
        color_bgr = det.get("color", [0, 255, 0])
        # OpenCV uses BGR tuples
        color = tuple(color_bgr)
        conf = det.get("confidence", 0)
        label = det.get("label", "")
        det_type = det.get("type", "yolo")

        if det_type == "shape":
            # Dashed rectangle for shape detections
            dash_len = 8
            # Top edge
            for i in range(x, x + w, dash_len * 2):
                cv2.line(annotated, (i, y), (min(i + dash_len, x + w), y), color, 2)
            # Bottom edge
            for i in range(x, x + w, dash_len * 2):
                cv2.line(annotated, (i, y + h), (min(i + dash_len, x + w), y + h), color, 2)
            # Left edge
            for i in range(y, y + h, dash_len * 2):
                cv2.line(annotated, (x, i), (x, min(i + dash_len, y + h)), color, 2)
            # Right edge
            for i in range(y, y + h, dash_len * 2):
                cv2.line(annotated, (x + w, i), (x + w, min(i + dash_len, y + h)), color, 2)
        else:
            # Solid rectangle for YOLO detections
            cv2.rectangle(annotated, (x, y), (x + w, y + h), color, 2)

        # Label + confidence tag
        tag = f"{label} {conf:.0%}"
        font = cv2.FONT_HERSHEY_SIMPLEX
        font_scale = 0.45
        thickness = 1
        (tw, th), baseline = cv2.getTextSize(tag, font, font_scale, thickness)
        # Background rectangle for label
        cv2.rectangle(annotated, (x, y - th - baseline - 4), (x + tw + 4, y), color, -1)
        # Text color: white or black depending on brightness
        brightness = sum(color_bgr) / 3
        text_color = (0, 0, 0) if brightness > 140 else (255, 255, 255)
        cv2.putText(annotated, tag, (x + 2, y - baseline - 2), font, font_scale, text_color, thickness, cv2.LINE_AA)

        # Morphology sub-label for abnormal cells
        morph = det.get("morphology")
        if morph and morph != "Normal":
            morph_color = tuple(det.get("morph_color", [255, 255, 255]))
            morph_tag = f"[{morph}]"
            (mw, mh), mb = cv2.getTextSize(morph_tag, font, font_scale, thickness)
            morph_y = y + h + mh + mb + 4
            cv2.rectangle(annotated, (x, y + h + 2), (x + mw + 4, morph_y + 2), morph_color, -1)
            morph_brightness = sum(det.get("morph_color", [255, 255, 255])) / 3
            morph_text_color = (0, 0, 0) if morph_brightness > 140 else (255, 255, 255)
            cv2.putText(annotated, morph_tag, (x + 2, morph_y - 2), font, font_scale, morph_text_color, thickness, cv2.LINE_AA)

    return annotated


def _pi_camera_reader():
    """SSH into Pi, run cam_stream piped to ffmpeg for MJPEG output."""
    global camera_frame, camera_connected, _cam_proc

    _kill_pi_camera_procs()

    # cam_stream outputs length-prefixed JPEG frames directly (no ffmpeg needed)
    remote_cmd = f"/home/qnxuser/cam_stream -u 1 -r {CAM_FPS} -q 70 2>/dev/null"
    cmd = [
        "sshpass", "-p", PI_SSH_PASS,
        "ssh", "-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=10",
        PI_SSH_HOST,
        remote_cmd,
    ]

    while not _stop_camera.is_set():
        try:
            print(f"[camera] Starting cam_stream+ffmpeg via SSH ({CAM_WIDTH}x{CAM_HEIGHT} MJPEG)...")
            _cam_proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=65536
            )

            # Wait briefly for process to start
            time.sleep(1)
            if _cam_proc.poll() is not None:
                print("[camera] cam_stream exited immediately")
                time.sleep(3)
                continue

            camera_connected = True
            print("[camera] Connected, reading JPEG frames...")
            reader = FrameReader(_cam_proc.stdout)
            warmup_done = False

            while not _stop_camera.is_set():
                jpeg_data = reader.read_frame()

                # Decode JPEG to BGR using OpenCV
                frame = cv2.imdecode(
                    np.frombuffer(jpeg_data, dtype=np.uint8), cv2.IMREAD_COLOR
                )
                if frame is None:
                    continue

                # Skip initial dark frames while auto-exposure settles
                if not warmup_done:
                    b_mean = frame[:, :, 0].mean()
                    r_mean = frame[:, :, 2].mean()
                    if r_mean < 20 and b_mean < 20:
                        continue
                    warmup_done = True
                    print("[camera] Auto-exposure settled, streaming frames")

                # Scale down from native 2304x1296 to target resolution
                if frame.shape[1] != CAM_WIDTH or frame.shape[0] != CAM_HEIGHT:
                    frame = cv2.resize(frame, (CAM_WIDTH, CAM_HEIGHT))

                # Center-crop and sharpen to remove dark circular lens edges
                frame = _center_crop_and_enhance(frame)

                # When paused, keep reading (keeps SSH alive) but don't expose frames
                if _camera_paused.is_set():
                    camera_connected = False
                    continue

                camera_connected = True
                with camera_frame_lock:
                    camera_frame = frame

        except ConnectionError:
            print("[camera] cam_stream disconnected")
        except Exception as e:
            print(f"[camera] Error: {e}")
        finally:
            camera_connected = False
            if _cam_proc:
                _cam_proc.terminate()
                try:
                    _cam_proc.wait(timeout=3)
                except Exception:
                    _cam_proc.kill()
                _cam_proc = None
            if not _stop_camera.is_set():
                print("[camera] Reconnecting in 3s...")
                time.sleep(3)

    camera_connected = False


def _stop_camera_system():
    """Stop camera reader and SSH process."""
    global _cam_proc, _receiver_thread, camera_frame, camera_connected
    _stop_camera.set()
    if _cam_proc:
        _cam_proc.terminate()
        try:
            _cam_proc.wait(timeout=3)
        except Exception:
            _cam_proc.kill()
        _cam_proc = None
    if _receiver_thread:
        _receiver_thread.join(timeout=5)
        _receiver_thread = None
    camera_connected = False
    with camera_frame_lock:
        camera_frame = None
    _stop_camera.clear()


@app.get("/health")
def health():
    api_key = os.getenv("DEEPGRAM_API_KEY", "")
    voice_ok = bool(api_key and api_key != "your_deepgram_api_key_here")
    return {"status": "ok", "camera_connected": camera_connected, "voice_configured": voice_ok}


@app.post("/demo/toggle")
def demo_toggle():
    global _demo_mode
    _demo_mode = not _demo_mode
    return {"demo": _demo_mode, "image_count": len(_demo_images)}


@app.get("/voice/check")
def voice_check():
    """Check if voice assistant is properly configured."""
    api_key = os.getenv("DEEPGRAM_API_KEY", "")
    if not api_key or api_key == "your_deepgram_api_key_here":
        return {"configured": False, "error": "DEEPGRAM_API_KEY not set in .env"}
    return {"configured": True, "key_prefix": api_key[:8] + "..."}


@app.post("/camera/start")
def camera_start():
    """Start Pi camera via SSH cam_stream, or resume if paused."""
    global _receiver_thread, camera_frame, camera_connected

    # Demo mode: load first demo image as the live feed, no SSH
    if _demo_mode:
        if not _demo_images:
            raise HTTPException(status_code=503, detail="No demo images found in backend/demo_images/")
        frame = cv2.imread(str(_demo_images[0]))
        if frame is None:
            raise HTTPException(status_code=503, detail="Failed to read demo image")
        frame = cv2.resize(frame, (CAM_WIDTH, CAM_HEIGHT))
        with camera_frame_lock:
            camera_frame = frame
        camera_connected = True
        print("[camera] Demo mode: loaded first demo image as live feed")
        return {"status": "connected"}

    # If SSH thread is alive and we're just paused, resume instantly
    if _receiver_thread and _receiver_thread.is_alive() and _camera_paused.is_set():
        _camera_paused.clear()
        print("[camera] Resuming stream (SSH still alive)")
        # Wait briefly for first resumed frame
        deadline = time.time() + 3
        while time.time() < deadline:
            if camera_connected:
                with camera_frame_lock:
                    if camera_frame is not None:
                        return {"status": "connected"}
            time.sleep(0.1)
        return {"status": "connected"}

    # Already streaming?
    if camera_connected:
        with camera_frame_lock:
            if camera_frame is not None:
                return {"status": "connected"}

    # Start reader thread (handles SSH, cam_stream, and frame reading)
    if not _receiver_thread or not _receiver_thread.is_alive():
        _stop_camera.clear()
        _camera_paused.clear()
        _receiver_thread = threading.Thread(target=_pi_camera_reader, daemon=True)
        _receiver_thread.start()
        print("[camera] Camera reader thread started")

    # Wait for first frame
    deadline = time.time() + 15
    while time.time() < deadline:
        with camera_frame_lock:
            if camera_frame is not None:
                print("[camera] First frame received!")
                return {"status": "connected"}
        time.sleep(0.3)

    raise HTTPException(
        status_code=503,
        detail="Connected to Pi but no frames received — check camera or cam_stream binary",
    )


@app.post("/camera/stop")
def camera_stop():
    """Pause camera streaming (keeps SSH alive for instant resume)."""
    global camera_connected, camera_frame

    if _demo_mode:
        camera_connected = False
        with camera_frame_lock:
            camera_frame = None
        print("[camera] Demo mode: stream stopped")
        return {"status": "stopped"}

    _camera_paused.set()
    camera_connected = False
    with camera_frame_lock:
        camera_frame = None
    print("[camera] Stream paused (SSH kept alive)")
    return {"status": "stopped"}


@app.post("/camera/disconnect")
def camera_disconnect():
    """Fully disconnect camera and tear down SSH."""
    _stop_camera_system()
    return {"status": "disconnected"}


@app.get("/camera/frame.jpg")
def camera_frame_jpeg():
    with camera_frame_lock:
        frame = None if camera_frame is None else camera_frame.copy()
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
            with camera_frame_lock:
                frame = None if camera_frame is None else camera_frame.copy()
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


def _compute_analytics(detections, fw, fh, inference_ms=0):
    """Extract analytics from detection results."""
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

    morph_counts = {}
    for d in yolo_dets:
        m = d.get("morphology", "N/A")
        morph_counts[m] = morph_counts.get(m, 0) + 1
    analytics["morphology_counts"] = morph_counts

    class_counts = {}
    for d in yolo_dets:
        class_counts[d["label"]] = class_counts.get(d["label"], 0) + 1
    analytics["class_counts"] = class_counts

    shape_counts = {}
    for d in shape_dets:
        shape_counts[d["label"]] = shape_counts.get(d["label"], 0) + 1
    analytics["shape_counts"] = shape_counts

    normal = morph_counts.get("Normal", 0)
    total_morph = sum(morph_counts.values())
    analytics["abnormal_pct"] = round(
        (total_morph - normal) / total_morph * 100, 1
    ) if total_morph > 0 else 0

    return analytics


def _call_gemini_analysis(jpeg_bytes, detections, analytics):
    """Send image + detection context to Gemini for natural-language analysis.

    Returns analysis text string, or None if unavailable.
    """
    api_key = os.getenv("GEMINI_API_KEY", "")
    if not api_key or not _GENAI_AVAILABLE:
        return None

    try:
        client = genai.Client(api_key=api_key)

        # Build context from detections
        cell_count = analytics.get("cell_count", 0)
        abnormal_pct = analytics.get("abnormal_pct", 0)
        morph = analytics.get("morphology_counts", {})
        classes = analytics.get("class_counts", {})

        context = (
            f"YOLO detection found {cell_count} cells. "
            f"Abnormal morphology: {abnormal_pct}%. "
            f"Morphology breakdown: {json.dumps(morph)}. "
            f"Class counts: {json.dumps(classes)}."
        )

        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[
                genai_types.Part.from_bytes(data=jpeg_bytes, mime_type="image/jpeg"),
                (
                    "You are a veterinary hematology assistant analyzing a microscope image. "
                    "The automated cell detection system has already run on this image. "
                    f"Detection results: {context}\n\n"
                    "Provide a concise clinical analysis (2-4 sentences) of what you see in this "
                    "microscope field. Comment on cell morphology, any abnormalities, and clinical "
                    "significance. Keep it professional and suitable for a lab report. "
                    "If the image is not a microscope slide, just describe what you see briefly."
                ),
            ],
        )
        return response.text
    except Exception as e:
        print(f"[gemini] Analysis failed: {e}")
        return None


def _run_capture_pipeline():
    """Grab current Pi camera frame, run YOLO, compute analytics, call Gemini.

    Returns (detections, analytics, llm_analysis, image_b64) or raises.
    """
    global _demo_image_index

    if _demo_mode:
        # Demo path: load next demo image round-robin
        if not _demo_images:
            raise RuntimeError("No demo images available")
        img_path = _demo_images[_demo_image_index % len(_demo_images)]
        _demo_image_index += 1
        frame = cv2.imread(str(img_path))
        if frame is None:
            raise RuntimeError(f"Failed to read demo image: {img_path.name}")
        frame = cv2.resize(frame, (CAM_WIDTH, CAM_HEIGHT))
    else:
        with camera_frame_lock:
            frame = None if camera_frame is None else camera_frame.copy()
        if frame is None:
            raise RuntimeError("Camera not streaming")

    t0 = time.perf_counter()
    fh, fw = frame.shape[:2]
    detections = detector.detect(frame)
    inference_ms = round((time.perf_counter() - t0) * 1000, 1)

    analytics = _compute_analytics(detections, fw, fh, inference_ms)

    # Cache analytics
    with _last_analytics_lock:
        _last_analytics.update(analytics)

    # Encode raw frame as JPEG for Gemini (cleaner for vision analysis)
    ok, raw_jpeg_buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
    raw_jpeg_bytes = raw_jpeg_buf.tobytes() if ok else b""

    llm_analysis = _call_gemini_analysis(raw_jpeg_bytes, detections, analytics) if raw_jpeg_bytes else None

    # Draw annotations on a copy for the gallery/UI image
    annotated = _draw_annotations(frame, detections)
    ok, ann_jpeg_buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 85])
    ann_jpeg_bytes = ann_jpeg_buf.tobytes() if ok else b""
    image_b64 = base64.b64encode(ann_jpeg_bytes).decode("utf-8") if ann_jpeg_bytes else ""

    return detections, analytics, llm_analysis, image_b64


@app.post("/capture/analyze")
async def capture_analyze(request: Request):
    """Capture a single frame, run detection + Gemini analysis."""
    body = await request.json()
    source = body.get("source", "pi")

    if source == "pi":
        try:
            detections, analytics, llm_analysis, image_b64 = _run_capture_pipeline()
        except RuntimeError as e:
            raise HTTPException(status_code=503, detail=str(e))
    else:
        # Accept base64-encoded image from browser
        image_data = body.get("image", "")
        if not image_data:
            raise HTTPException(status_code=400, detail="No image provided")
        frame = decode_frame(image_data)
        t0 = time.perf_counter()
        fh, fw = frame.shape[:2]
        detections = detector.detect(frame)
        inference_ms = round((time.perf_counter() - t0) * 1000, 1)
        analytics = _compute_analytics(detections, fw, fh, inference_ms)
        with _last_analytics_lock:
            _last_analytics.update(analytics)
        # Raw JPEG for Gemini
        ok, raw_jpeg_buf = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
        raw_jpeg_bytes = raw_jpeg_buf.tobytes() if ok else b""
        llm_analysis = _call_gemini_analysis(raw_jpeg_bytes, detections, analytics) if raw_jpeg_bytes else None
        # Annotated JPEG for gallery/UI
        annotated = _draw_annotations(frame, detections)
        ok, ann_jpeg_buf = cv2.imencode(".jpg", annotated, [cv2.IMWRITE_JPEG_QUALITY, 85])
        ann_jpeg_bytes = ann_jpeg_buf.tobytes() if ok else b""
        image_b64 = base64.b64encode(ann_jpeg_bytes).decode("utf-8") if ann_jpeg_bytes else ""

    # Compute alert level
    abnormal = analytics.get("abnormal_pct", 0)
    if abnormal > 30:
        alert_level = "critical"
    elif abnormal > 10:
        alert_level = "warning"
    else:
        alert_level = "normal"

    return {
        "detections": detections,
        "analytics": analytics,
        "llm_analysis": llm_analysis,
        "image_b64": image_b64,
        "alert_level": alert_level,
    }


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
                    with camera_frame_lock:
                        frame = None if camera_frame is None else camera_frame.copy()
                    if frame is None:
                        raise RuntimeError("Camera not streaming")
                else:
                    frame = decode_frame(data_url)
                fh, fw = frame.shape[:2]
                detections = detector.detect(frame)
                inference_ms = round((time.perf_counter() - t0) * 1000, 1)

                analytics = _compute_analytics(detections, fw, fh, inference_ms)

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
        "report_id": f"TX-{session_id[:8].upper()}",
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
        "type": "Settings",
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
            "language": "en",
            "listen": {
                "provider": {
                    "type": "deepgram",
                    "model": "nova-3",
                },
            },
            "think": {
                "provider": {
                    "type": "open_ai",
                    "model": "gpt-4o-mini",
                },
                "prompt": (
                    "You are Tempus Assistant, a helpful voice assistant for a veterinary "
                    "microscopy lab. You help lab technicians understand cell detection results, "
                    "morphology findings, and answer questions about the analysis.\n\n"
                    "Current detector state:\n" + context + "\n\n"
                    "You have a function called capture_and_analyze that captures and analyzes "
                    "the current microscope field of view. When the user asks you to capture, "
                    "analyze, take a snapshot, or examine the slide, call this function. "
                    "After calling it, summarize the results for the user in spoken-friendly language.\n\n"
                    "Keep answers concise and spoken-friendly. Use plain language. "
                    "If asked about results you don't have, suggest they capture the current view."
                ),
                "functions": [
                    {
                        "name": "capture_and_analyze",
                        "description": (
                            "Capture the current microscope field of view, run cell detection, "
                            "and analyze the image. Call this when the user asks to capture, "
                            "analyze, take a snapshot, or examine the current slide."
                        ),
                        "parameters": {
                            "type": "object",
                            "properties": {},
                            "required": [],
                        },
                    }
                ],
            },
            "speak": {
                "provider": {
                    "type": "deepgram",
                    "model": "aura-2-thalia-en",
                },
            },
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

    dg_url = "wss://agent.deepgram.com/v1/agent/converse"
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
                """Forward Deepgram responses to browser, intercepting function calls."""
                try:
                    async for msg in dg_ws:
                        if isinstance(msg, bytes):
                            await websocket.send_bytes(msg)
                        else:
                            # Check for FunctionCallRequest
                            try:
                                parsed = json.loads(msg)
                            except (json.JSONDecodeError, TypeError):
                                await websocket.send_text(msg)
                                continue

                            if (
                                parsed.get("type") == "FunctionCallRequest"
                                and parsed.get("function_name") == "capture_and_analyze"
                            ):
                                call_id = parsed.get("function_call_id", "")
                                print(f"[voice] Capture requested via voice (call_id={call_id})")

                                # Run capture pipeline
                                try:
                                    detections, analytics, llm_analysis, image_b64 = (
                                        await asyncio.to_thread(_run_capture_pipeline)
                                    )
                                    abnormal = analytics.get("abnormal_pct", 0)
                                    alert_level = (
                                        "critical" if abnormal > 30
                                        else "warning" if abnormal > 10
                                        else "normal"
                                    )

                                    # Build spoken summary for Deepgram
                                    cell_count = analytics.get("cell_count", 0)
                                    morph = analytics.get("morphology_counts", {})
                                    summary_parts = [f"I captured and analyzed the current field of view."]
                                    summary_parts.append(f"I detected {cell_count} cells.")
                                    if abnormal > 0:
                                        summary_parts.append(
                                            f"{abnormal}% show atypical morphology."
                                        )
                                    abn_types = {
                                        k: v for k, v in morph.items()
                                        if k not in ("Normal", "N/A")
                                    }
                                    if abn_types:
                                        parts = [f"{v} {k}" for k, v in abn_types.items()]
                                        summary_parts.append(
                                            f"Abnormal types: {', '.join(parts)}."
                                        )
                                    if llm_analysis:
                                        summary_parts.append(llm_analysis)
                                    spoken_result = " ".join(summary_parts)

                                    # Send FunctionCallResponse to Deepgram
                                    fn_response = {
                                        "type": "FunctionCallResponse",
                                        "function_call_id": call_id,
                                        "output": spoken_result,
                                    }
                                    await dg_ws.send(json.dumps(fn_response))

                                    # Send capture result to browser for UI update
                                    capture_msg = {
                                        "type": "capture_result",
                                        "detections": detections,
                                        "analytics": analytics,
                                        "llm_analysis": llm_analysis,
                                        "image_b64": image_b64,
                                        "alert_level": alert_level,
                                    }
                                    await websocket.send_text(json.dumps(capture_msg))

                                except Exception as e:
                                    print(f"[voice] Capture failed: {e}")
                                    fn_response = {
                                        "type": "FunctionCallResponse",
                                        "function_call_id": call_id,
                                        "output": f"Capture failed: {str(e)}",
                                    }
                                    await dg_ws.send(json.dumps(fn_response))
                            else:
                                # Forward other messages to browser
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
