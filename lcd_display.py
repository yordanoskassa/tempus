"""ST7789V LCD display driver for VetrView.

Fetches the MJPEG stream from VetrView backend and renders
detection results on the ST7789V LCD connected via SPI GPIO.

Run this on the Pi:
    pip install spidev RPi.GPIO Pillow requests
    python lcd_display.py
"""

import struct
import time

import RPi.GPIO as GPIO
import spidev
from PIL import Image
import requests

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

# MADCTL rotation values
ROTATIONS = {
    0: 0x00,
    90: 0x60,
    180: 0xC0,
    270: 0xA0,
}


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
        self._command(INVON)   # ST7789 needs inversion on
        self._command(NORON)
        time.sleep(0.01)
        self._command(DISPON)
        time.sleep(0.1)
        GPIO.output(BL_PIN, GPIO.HIGH)  # Backlight on

    def set_window(self, x0, y0, x1, y1):
        self._command(CASET, [
            (x0 >> 8) & 0xFF, x0 & 0xFF,
            (x1 >> 8) & 0xFF, x1 & 0xFF,
        ])
        self._command(RASET, [
            (y0 >> 8) & 0xFF, y0 & 0xFF,
            (y1 >> 8) & 0xFF, y1 & 0xFF,
        ])

    def display(self, image):
        """Send a PIL Image to the LCD."""
        if LCD_ROTATION in (90, 270):
            img = image.resize((LCD_HEIGHT, LCD_WIDTH), Image.LANCZOS)
        else:
            img = image.resize((LCD_WIDTH, LCD_HEIGHT), Image.LANCZOS)

        img = img.convert("RGB")
        w, h = img.size

        # Convert to RGB565
        pixels = img.tobytes()
        rgb565 = bytearray(w * h * 2)
        for i in range(0, len(pixels), 3):
            r, g, b = pixels[i], pixels[i + 1], pixels[i + 2]
            color = ((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)
            j = (i // 3) * 2
            rgb565[j] = (color >> 8) & 0xFF
            rgb565[j + 1] = color & 0xFF

        self.set_window(0, 0, w - 1, h - 1)
        self._command(RAMWR)
        GPIO.output(DC_PIN, GPIO.HIGH)

        # Send in chunks (SPI buffer limit)
        chunk = 4096
        for start in range(0, len(rgb565), chunk):
            self.spi.writebytes2(rgb565[start:start + chunk])

    def off(self):
        GPIO.output(BL_PIN, GPIO.LOW)
        GPIO.cleanup()
        self.spi.close()


def stream_to_lcd():
    lcd = ST7789()
    print(f"LCD initialized ({LCD_WIDTH}x{LCD_HEIGHT})")
    print(f"Connecting to {VETRVIEW_HOST}/qnx/stream ...")

    while True:
        try:
            resp = requests.get(
                f"{VETRVIEW_HOST}/qnx/stream",
                stream=True,
                timeout=10,
            )
            buf = b""
            for chunk in resp.iter_content(chunk_size=4096):
                buf += chunk
                # Find JPEG boundaries
                start = buf.find(b"\xff\xd8")
                end = buf.find(b"\xff\xd9")
                if start != -1 and end != -1 and end > start:
                    jpeg = buf[start:end + 2]
                    buf = buf[end + 2:]
                    try:
                        from io import BytesIO
                        img = Image.open(BytesIO(jpeg))
                        lcd.display(img)
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
