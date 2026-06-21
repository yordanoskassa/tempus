from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from detector import Detector, decode_frame

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
                frame = decode_frame(data_url)
                detections = detector.detect(frame)
                await websocket.send_json({
                    "detections": detections,
                    "mode": detector.mode,
                })
            except Exception as e:
                await websocket.send_json({"error": str(e), "detections": []})
    except WebSocketDisconnect:
        pass
