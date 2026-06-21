import cv2
import numpy as np
import base64


def decode_frame(data_url: str) -> np.ndarray:
    """Decode a base64 data URL into an OpenCV image."""
    header, encoded = data_url.split(",", 1)
    raw = base64.b64decode(encoded)
    arr = np.frombuffer(raw, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)


def classify_contour(contour, img_area: float) -> dict | None:
    """Classify a contour as a cell component based on shape metrics."""
    area = cv2.contourArea(contour)
    if area < 80:
        return None

    perimeter = cv2.arcLength(contour, True)
    if perimeter == 0:
        return None

    circularity = 4 * np.pi * area / (perimeter * perimeter)
    x, y, w, h = cv2.boundingRect(contour)
    aspect_ratio = w / h if h > 0 else 1
    relative_size = area / img_area

    # Classification heuristics based on shape characteristics
    if relative_size > 0.15:
        label = "Cell Membrane"
        color = [0, 255, 0]
        confidence = min(0.6 + circularity * 0.3, 0.95)
    elif relative_size > 0.03 and circularity > 0.5:
        label = "Nucleus"
        color = [255, 100, 0]
        confidence = min(0.5 + circularity * 0.4, 0.92)
    elif relative_size > 0.005 and 0.3 < circularity < 0.8:
        label = "Mitochondria"
        color = [0, 200, 255]
        confidence = min(0.4 + (1 - abs(aspect_ratio - 1.8) / 3) * 0.4, 0.88)
    elif relative_size > 0.002 and circularity > 0.6:
        label = "Vesicle"
        color = [255, 0, 255]
        confidence = min(0.4 + circularity * 0.3, 0.85)
    elif relative_size > 0.001 and aspect_ratio > 2.5:
        label = "Endoplasmic Reticulum"
        color = [0, 150, 255]
        confidence = min(0.35 + (aspect_ratio / 5) * 0.3, 0.80)
    elif relative_size > 0.0005:
        label = "Ribosome"
        color = [200, 200, 0]
        confidence = 0.45
    else:
        return None

    return {
        "label": label,
        "confidence": round(confidence, 2),
        "bbox": [int(x), int(y), int(w), int(h)],
        "color": color,
    }


def detect_components(frame: np.ndarray) -> list[dict]:
    """Run cell component detection on a single frame."""
    h, w = frame.shape[:2]
    img_area = h * w

    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)

    # Enhance contrast with CLAHE
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    enhanced = clahe.apply(gray)

    # Reduce noise
    blurred = cv2.GaussianBlur(enhanced, (7, 7), 0)

    # Adaptive threshold to find structures
    thresh = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 10
    )

    # Morphological operations to clean up
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (3, 3))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, kernel, iterations=1)

    # Find contours
    contours, _ = cv2.findContours(thresh, cv2.RETR_TREE, cv2.CHAIN_APPROX_SIMPLE)

    detections = []
    for contour in contours:
        result = classify_contour(contour, img_area)
        if result:
            detections.append(result)

    # Deduplicate overlapping detections — keep higher confidence
    detections = _nms(detections, iou_threshold=0.4)

    return detections


def _iou(a: list[int], b: list[int]) -> float:
    """Compute IoU between two [x, y, w, h] bounding boxes."""
    ax1, ay1 = a[0], a[1]
    ax2, ay2 = a[0] + a[2], a[1] + a[3]
    bx1, by1 = b[0], b[1]
    bx2, by2 = b[0] + b[2], b[1] + b[3]

    ix1 = max(ax1, bx1)
    iy1 = max(ay1, by1)
    ix2 = min(ax2, bx2)
    iy2 = min(ay2, by2)

    inter = max(0, ix2 - ix1) * max(0, iy2 - iy1)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0


def _nms(detections: list[dict], iou_threshold: float) -> list[dict]:
    """Non-maximum suppression to remove overlapping boxes."""
    detections.sort(key=lambda d: d["confidence"], reverse=True)
    keep = []
    for det in detections:
        overlap = False
        for kept in keep:
            if _iou(det["bbox"], kept["bbox"]) > iou_threshold:
                overlap = True
                break
        if not overlap:
            keep.append(det)
    return keep
