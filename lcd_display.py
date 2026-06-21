"""ST7789V LCD display driver for VetrView.

Fetches the MJPEG stream from VetrView backend and renders
detection results on the ST7789V LCD connected via SPI GPIO.

Run this on the Pi:
    pip install spidev RPi.GPIO numpy opencv-python-headless
    python lcd_display.py
"""

import time
import struct
from io import BytesIO
from urllib.request import urlopen

import numpy as np
import RPi.GPIO as GPIO
import spidev

# --- Config ---
VETRVIEW_HOST = "http://vetrview.local:8000"  # Mac running VetrView backend
LCD_WIDTH = 240
LCD_HEIGHT = 320
LCD_ROTATION = 0  # 0, 90, 180, 270

# GPIO pins (BCM numbering) — matches wiring guide
DC_PIN = 24
RST_PIN = 25
BL_PIN = 18
SPI_BUS = 0
SPI_DEVICE = 0
SPI_SPEED = 40_000_000  # 40 MHz

# --- ST7789V Commands ---
SWRESET = 0x01
SLPOUT = 0x11
COLMOD = 0x3A
MADCTL = 0x36
INVON = 0x21
NORON = 0x13
DISPON = 0x29
CASET = 0x2A
RASET = 0x2B
RAMWR = 0x2C

ROTATIONS = {
    0: 0x00,
    90: 0x60,
    180: 0xC0,
    270: 0xA0,
}


def _resize_nearest(img, src_h, src_w, dst_w, dst_h):
    """Resize RGB numpy array using nearest-neighbor (no Pillow needed)."""
    row_idx = (np.arange(dst_h) * src_h // dst_h).astype(int)
    col_idx = (np.arange(dst_w) * src_w // dst_w).astype(int)
    return img[row_idx][:, col_idx]


def _rgb_to_rgb565(rgb: np.ndarray) -> bytearray:
    """Convert HxWx3 uint8 RGB array to RGB565 big-endian bytes."""
    r = rgb[:, :, 0].astype(np.uint16)
    g = rgb[:, :, 1].astype(np.uint16)
    b = rgb[:, :, 2].astype(np.uint16)
    rgb565 = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
    return bytearray(rgb565.astype(">u2").tobytes())


class ST7789:
    def __init__(self):
        GPIO.setwarnings(False)
        GPIO.setmode(GPIO.BCM)
        GPIO.setup(DC_PIN, GPIO.OUT)
        GPIO.setup(RST_PIN, GPIO.OUT)
        GPIO.setup(BL_PIN, GPIO.OUT)

        self.spi = spidev.SpiDev()
        self.spi.open(SPI_BUS, SPI_DEVICE)
        self.spi.max_speed_hz = SPI_SPEED
        self.spi.mode = 0

        self._init_display()

    def _command(self, cmd, data=None):
        GPIO.output(DC_PIN, GPIO.LOW)
        self.spi.writebytes([cmd])
        if data:
            GPIO.output(DC_PIN, GPIO.HIGH)
            self.spi.writebytes2(data)

    def _reset(self):
        GPIO.output(RST_PIN, GPIO.HIGH)
        time.sleep(0.05)
        GPIO.output(RST_PIN, GPIO.LOW)
        time.sleep(0.05)
        GPIO.output(RST_PIN, GPIO.HIGH)
        time.sleep(0.15)

    def _init_display(self):
        self._reset()
        self._command(SWRESET)
        time.sleep(0.15)
        self._command(SLPOUT)
        time.sleep(0.5)
        self._command(COLMOD, [0x55])  # 16-bit RGB565
        self._command(MADCTL, [ROTATIONS.get(LCD_ROTATION, 0x00)])
        self._command(INVON)
        self._command(NORON)
        time.sleep(0.01)
        self._command(DISPON)
        time.sleep(0.1)
        GPIO.output(BL_PIN, GPIO.HIGH)

    def set_window(self, x0, y0, x1, y1):
        self._command(CASET, [
            (x0 >> 8) & 0xFF, x0 & 0xFF,
            (x1 >> 8) & 0xFF, x1 & 0xFF,
        ])
        self._command(RASET, [
            (y0 >> 8) & 0xFF, y0 & 0xFF,
            (y1 >> 8) & 0xFF, y1 & 0xFF,
        ])

    def display_rgb(self, rgb: np.ndarray):
        """Send an HxWx3 uint8 RGB numpy array to the LCD."""
        src_h, src_w = rgb.shape[:2]
        if LCD_ROTATION in (90, 270):
            dst_w, dst_h = LCD_HEIGHT, LCD_WIDTH
        else:
            dst_w, dst_h = LCD_WIDTH, LCD_HEIGHT

        resized = _resize_nearest(rgb, src_h, src_w, dst_w, dst_h)
        data = _rgb_to_rgb565(resized)

        self.set_window(0, 0, dst_w - 1, dst_h - 1)
        self._command(RAMWR)
        GPIO.output(DC_PIN, GPIO.HIGH)

        chunk = 4096
        for start in range(0, len(data), chunk):
            self.spi.writebytes2(data[start:start + chunk])

    def off(self):
        GPIO.output(BL_PIN, GPIO.LOW)
        GPIO.cleanup()
        self.spi.close()


def decode_jpeg_np(jpeg_bytes: bytes) -> np.ndarray:
    """Decode JPEG bytes to RGB numpy array using OpenCV or turbojpeg."""
    try:
        import cv2
        arr = np.frombuffer(jpeg_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is not None:
            return bgr[:, :, ::-1]  # BGR -> RGB
    except ImportError:
        pass

    # Fallback: minimal JPEG decode not available
    raise RuntimeError("Install opencv-python-headless: pip install opencv-python-headless")


def stream_to_lcd():
    lcd = ST7789()
    print(f"LCD initialized ({LCD_WIDTH}x{LCD_HEIGHT})")
    print(f"Connecting to {VETRVIEW_HOST}/camera/stream ...")

    while True:
        try:
            resp = urlopen(f"{VETRVIEW_HOST}/camera/stream", timeout=10)
            buf = b""
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                buf += chunk
                # Find JPEG frame boundaries
                start = buf.find(b"\xff\xd8")
                end = buf.find(b"\xff\xd9", start + 2 if start >= 0 else 0)
                if start != -1 and end != -1 and end > start:
                    jpeg = buf[start:end + 2]
                    buf = buf[end + 2:]
                    try:
                        rgb = decode_jpeg_np(jpeg)
                        lcd.display_rgb(rgb)
                    except Exception:
                        pass
        except KeyboardInterrupt:
            print("\nShutting down LCD")
            lcd.off()
            break
        except Exception as e:
            print(f"Connection lost: {e}, retrying...")
            time.sleep(2)


if __name__ == "__main__":
    stream_to_lcd()
