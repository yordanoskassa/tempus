import asyncio
import json
import os
import time

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from websockets.asyncio.client import connect as ws_connect

from detector import Detector, decode_frame

load_dotenv()

app = FastAPI(title="VetrView - Cell Component Detection")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)

detector = Detector()


@app.get("/health")
def health():
    return {"status": "ok"}


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

                await websocket.send_json({
                    "detections": detections,
                    "mode": detector.mode,
                    "analytics": analytics,
                })
            except Exception as e:
                await websocket.send_json({"error": str(e), "detections": []})
    except WebSocketDisconnect:
        pass


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
