import base64
from pathlib import Path

import cv2
import numpy as np
from ultralytics import YOLO

BACKEND_DIR = Path(__file__).parent

# --- Colors ---

BLOOD_CELL_COLORS = {
    "Platelet": [200, 200, 0],
    "RBC": [255, 60, 60],
    "WBC": [60, 180, 255],
}

SHAPE_COLORS = {
    "Circle": [0, 220, 120],
    "Oval": [120, 200, 255],
    "Triangle": [255, 160, 0],
    "Rectangle": [180, 100, 255],
    "Square": [160, 80, 220],
    "Pentagon": [255, 120, 180],
    "Hexagon": [100, 255, 200],
    "Polygon": [200, 180, 100],
    "Irregular": [160, 160, 160],
}

MORPHOLOGY_COLORS = {
    "Normal": [80, 200, 80],
    "Sickle": [255, 80, 80],
    "Teardrop": [255, 160, 60],
    "Burr/Echinocyte": [220, 120, 255],
    "Spherocyte": [100, 180, 255],
    "Elliptocyte": [255, 200, 100],
    "Target": [200, 255, 100],
    "Acanthocyte": [255, 100, 160],
}

_coco_palette = [
    [255, 60, 60], [60, 180, 255], [60, 255, 60], [255, 200, 0],
    [255, 0, 255], [0, 255, 200], [200, 100, 255], [255, 150, 100],
]


def _coco_color(class_id: int) -> list[int]:
    return _coco_palette[class_id % len(_coco_palette)]


# --- Shape Analysis ---

def classify_geometric_shape(contour) -> str:
    """Classify a contour into a geometric shape name."""
    peri = cv2.arcLength(contour, True)
    approx = cv2.approxPolyDP(contour, 0.04 * peri, True)
    vertices = len(approx)

    area = cv2.contourArea(contour)
    if peri == 0:
        return "Irregular"
    circularity = 4 * np.pi * area / (peri * peri)

    if vertices == 3:
        return "Triangle"
    elif vertices == 4:
        x, y, w, h = cv2.boundingRect(approx)
        aspect = w / h if h > 0 else 1
        if 0.85 <= aspect <= 1.15:
            return "Square"
        return "Rectangle"
    elif vertices == 5:
        return "Pentagon"
    elif vertices == 6:
        return "Hexagon"
    elif circularity > 0.80:
        x, y, w, h = cv2.boundingRect(contour)
        aspect = w / h if h > 0 else 1
        if 0.85 <= aspect <= 1.15:
            return "Circle"
        return "Oval"
    elif vertices > 6:
        return "Polygon"
    return "Irregular"


def classify_cell_morphology(contour) -> str:
    """Classify RBC/cell morphology from contour shape metrics."""
    area = cv2.contourArea(contour)
    peri = cv2.arcLength(contour, True)
    if peri == 0 or area < 20:
        return "Normal"

    circularity = 4 * np.pi * area / (peri * peri)
    x, y, w, h = cv2.boundingRect(contour)
    aspect = w / h if h > 0 else 1
    hull = cv2.convexHull(contour)
    hull_area = cv2.contourArea(hull)
    solidity = area / hull_area if hull_area > 0 else 1

    # Elongated + low circularity = sickle
    if aspect > 2.2 and circularity < 0.4:
        return "Sickle"
    if (aspect > 1.8 or aspect < 0.55) and circularity < 0.5:
        return "Sickle"

    # Teardrop: elongated but more solid
    if 1.5 < aspect < 2.2 and circularity < 0.55 and solidity > 0.85:
        return "Teardrop"

    # Burr/Echinocyte: round-ish but spiky edges (low solidity)
    if circularity > 0.5 and solidity < 0.80:
        return "Burr/Echinocyte"

    # Acanthocyte: very irregular edges
    if solidity < 0.70:
        return "Acanthocyte"

    # Spherocyte: very round, high circularity, small
    if circularity > 0.90 and 0.9 <= aspect <= 1.1:
        return "Spherocyte"

    # Elliptocyte: oval-shaped
    if 1.3 < aspect < 1.8 and circularity > 0.55:
        return "Elliptocyte"

    # Target cell: round with central density (detected by contrast)
    # Approximated here by moderate circularity + high solidity
    if 0.70 < circularity < 0.85 and solidity > 0.92:
        return "Target"

    return "Normal"


def detect_shapes(frame: np.ndarray, min_area: int = 300) -> list[dict]:
    """Detect geometric shapes via contour analysis."""
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)
    blurred = cv2.GaussianBlur(enhanced, (7, 7), 0)

    thresh = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 31, 10,
    )
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel, iterations=1)

    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    shapes = []
    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area:
            continue

        shape_name = classify_geometric_shape(cnt)
        x, y, w, h = cv2.boundingRect(cnt)
        color = SHAPE_COLORS.get(shape_name, [160, 160, 160])

        peri = cv2.arcLength(cnt, True)
        circularity = 4 * np.pi * area / (peri * peri) if peri > 0 else 0

        shapes.append({
            "label": shape_name,
            "confidence": round(min(circularity + 0.3, 0.95), 2),
            "bbox": [int(x), int(y), int(w), int(h)],
            "color": color,
            "type": "shape",
        })

    # Simple NMS for shapes
    shapes.sort(key=lambda s: s["confidence"], reverse=True)
    keep = []
    for s in shapes:
        overlap = False
        for k in keep:
            if _iou(s["bbox"], k["bbox"]) > 0.4:
                overlap = True
                break
        if not overlap:
            keep.append(s)
    return keep


def analyze_cell_morphology(frame: np.ndarray, bbox: list[int]) -> dict:
    """Analyze morphology of a cell within a bounding box."""
    x, y, w, h = bbox
    fh, fw = frame.shape[:2]
    # Clamp to frame bounds
    x1 = max(0, x)
    y1 = max(0, y)
    x2 = min(fw, x + w)
    y2 = min(fh, y + h)
    roi = frame[y1:y2, x1:x2]

    if roi.size == 0:
        return {"morphology": "Normal", "morph_color": MORPHOLOGY_COLORS["Normal"]}

    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    if not contours:
        return {"morphology": "Normal", "morph_color": MORPHOLOGY_COLORS["Normal"]}

    largest = max(contours, key=cv2.contourArea)
    morph = classify_cell_morphology(largest)
    return {"morphology": morph, "morph_color": MORPHOLOGY_COLORS.get(morph, [200, 200, 200])}


def _iou(a: list[int], b: list[int]) -> float:
    ax1, ay1 = a[0], a[1]
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx1, by1 = b[0], b[1]
    bx2, by2 = b[0] + b[2], b[1] + b[3]
    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0


# --- Detector ---

class Detector:
    """YOLO + shape analysis detector.

    Modes:
    - "general": COCO 80-class detection + geometric shapes
    - "blood_cell": Platelet/RBC/WBC detection + cell morphology + geometric shapes
    """

    def __init__(self):
        self.mode = "general"
        self.models: dict[str, YOLO] = {}
        self.conf_threshold = 0.35
        self.shapes_enabled = True

        general_path = BACKEND_DIR / "yolov8n.pt"
        if general_path.exists():
            self.models["general"] = YOLO(str(general_path))

        blood_cell_path = BACKEND_DIR / "blood_cell_best.pt"
        if blood_cell_path.exists():
            self.models["blood_cell"] = YOLO(str(blood_cell_path))
            self.mode = "blood_cell"

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
            "shapes_enabled": self.shapes_enabled,
        }

    def detect(self, frame: np.ndarray) -> list[dict]:
        detections = []

        # --- YOLO detections ---
        model = self.current_model
        if model is not None:
            results = model(frame, conf=self.conf_threshold, verbose=False)
            for result in results:
                boxes = result.boxes
                if boxes is None:
                    continue
                for i in range(len(boxes)):
                    x1, y1, x2, y2 = boxes.xyxy[i].cpu().numpy().astype(int)
                    conf = float(boxes.conf[i].cpu().numpy())
                    cls_id = int(boxes.cls[i].cpu().numpy())
                    label = result.names[cls_id]
                    w, h = x2 - x1, y2 - y1

                    if self.mode == "blood_cell":
                        color = BLOOD_CELL_COLORS.get(label, [200, 200, 200])
                    else:
                        color = _coco_color(cls_id)

                    det = {
                        "label": label,
                        "confidence": round(conf, 2),
                        "bbox": [int(x1), int(y1), int(w), int(h)],
                        "color": color,
                        "type": "yolo",
                    }

                    # Add morphology analysis for blood cells
                    if self.mode == "blood_cell" and label in ("RBC", "WBC"):
                        morph_info = analyze_cell_morphology(frame, det["bbox"])
                        det["morphology"] = morph_info["morphology"]
                        det["morph_color"] = morph_info["morph_color"]

                    detections.append(det)

        # --- Shape detections ---
        if self.shapes_enabled:
            shapes = detect_shapes(frame)
            # Remove shapes that overlap with YOLO detections
            yolo_boxes = [d["bbox"] for d in detections]
            for shape in shapes:
                overlaps = any(_iou(shape["bbox"], yb) > 0.3 for yb in yolo_boxes)
                if not overlaps:
                    detections.append(shape)

        return detections


def decode_frame(data_url: str) -> np.ndarray:
    """Decode a base64 data URL into an OpenCV image."""
    header, encoded = data_url.split(",", 1)
    raw = base64.b64decode(encoded)
    arr = np.frombuffer(raw, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)
