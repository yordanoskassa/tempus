import base64
import os
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

BACKEND_DIR = Path(__file__).parent

# Color palette for blood cell classes (BGR for OpenCV, but we send RGB to frontend)
BLOOD_CELL_COLORS = {
    "Platelet": [200, 200, 0],
    "RBC": [255, 60, 60],
    "WBC": [60, 180, 255],
}

# Color palette for general COCO detection (subset of common classes)
COCO_COLORS = {}
_palette = [
    [255, 60, 60], [60, 180, 255], [60, 255, 60], [255, 200, 0],
    [255, 0, 255], [0, 255, 200], [200, 100, 255], [255, 150, 100],
]


def _coco_color(class_id: int) -> list[int]:
    return _palette[class_id % len(_palette)]


class Detector:
    """YOLO-based object detector with two modes:

    - "general": YOLOv8n pre-trained on COCO (80 classes) for Mac camera testing
    - "blood_cell": Custom-trained model for Platelets, RBC, WBC
    """

    def __init__(self):
        self.mode = "general"
        self.models: dict[str, YOLO] = {}
        self.conf_threshold = 0.35

        # Load general model (always available)
        general_path = BACKEND_DIR / "yolov8n.pt"
        if general_path.exists():
            self.models["general"] = YOLO(str(general_path))

        # Load blood cell model if available
        blood_cell_path = BACKEND_DIR / "blood_cell_best.pt"
        if blood_cell_path.exists():
            self.models["blood_cell"] = YOLO(str(blood_cell_path))
            self.mode = "blood_cell"  # auto-select if available

    @property
    def current_model(self) -> YOLO | None:
        return self.models.get(self.mode)

    def set_mode(self, mode: str) -> bool:
        if mode in self.models:
            self.mode = mode
            return True
        return False

    def get_status(self) -> dict:
        return {
            "mode": self.mode,
            "available_modes": list(self.models.keys()),
            "conf_threshold": self.conf_threshold,
            "blood_cell_model_loaded": "blood_cell" in self.models,
        }

    def detect(self, frame: np.ndarray) -> list[dict]:
        model = self.current_model
        if model is None:
            return []

        results = model(frame, conf=self.conf_threshold, verbose=False)

        detections = []
        for result in results:
            boxes = result.boxes
            if boxes is None:
                continue

            for i in range(len(boxes)):
                # xyxy format: [x1, y1, x2, y2]
                x1, y1, x2, y2 = boxes.xyxy[i].cpu().numpy().astype(int)
                conf = float(boxes.conf[i].cpu().numpy())
                cls_id = int(boxes.cls[i].cpu().numpy())
                label = result.names[cls_id]

                w = x2 - x1
                h = y2 - y1

                if self.mode == "blood_cell":
                    color = BLOOD_CELL_COLORS.get(label, [200, 200, 200])
                else:
                    color = _coco_color(cls_id)

                detections.append({
                    "label": label,
                    "confidence": round(conf, 2),
                    "bbox": [int(x1), int(y1), int(w), int(h)],
                    "color": color,
                })

        return detections


def decode_frame(data_url: str) -> np.ndarray:
    """Decode a base64 data URL into an OpenCV image."""
    header, encoded = data_url.split(",", 1)
    raw = base64.b64decode(encoded)
    arr = np.frombuffer(raw, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)
