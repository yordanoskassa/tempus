#!/usr/bin/env python3
"""MJPEG TCP streamer for QNX Pi.

Captures frames using GStreamer (videotestsrc or camera) and streams JPEG
over a TCP socket on port 8765. The Mac backend connects and reads JPEG
frames by finding FFD8/FFD9 boundaries.

Usage on Pi:
    python3 pi_streamer.py [--test]

    --test    Use test pattern instead of camera (for debugging)
"""
import socket
import subprocess
import sys
import threading
import time

HOST = "0.0.0.0"
PORT = 8765
WIDTH = 1280
HEIGHT = 720
FPS = 15


def gst_pipeline(use_test=False):
    """Return GStreamer pipeline command that outputs JPEG to stdout."""
    if use_test:
        src = f"videotestsrc ! video/x-raw,width={WIDTH},height={HEIGHT},framerate={FPS}/1"
    else:
        # Try wrappercamerabinsrc for QNX camera
        src = f"wrappercamerabinsrc ! videoconvert ! videoscale ! video/x-raw,width={WIDTH},height={HEIGHT},framerate={FPS}/1"

    return [
        "gst-launch-1.0", "-q",
        *src.split(" ! "),
        "!", "videoconvert",
        "!", "jpegenc", f"quality=80",
        "!", "fdsink", "fd=1",
    ]


def gst_pipeline_str(use_test=False):
    """Return GStreamer pipeline as a single shell command string."""
    if use_test:
        src = f"videotestsrc ! video/x-raw,width={WIDTH},height={HEIGHT},framerate={FPS}/1"
    else:
        src = f"wrappercamerabinsrc ! videoconvert ! videoscale ! video/x-raw,width={WIDTH},height={HEIGHT},framerate={FPS}/1"

    return f"gst-launch-1.0 -q {src} ! videoconvert ! jpegenc quality=80 ! fdsink fd=1"


def start_capture(use_test=False):
    """Start GStreamer and return the subprocess."""
    cmd = gst_pipeline_str(use_test)
    print(f"Starting: {cmd}")
    proc = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return proc


def handle_client(conn, addr, frame_lock, frame_holder, stop_event):
    """Send JPEG frames to connected client."""
    print(f"[+] Client connected: {addr}")
    try:
        while not stop_event.is_set():
            with frame_lock:
                jpeg = frame_holder[0]
            if jpeg is None:
                time.sleep(0.05)
                continue
            try:
                conn.sendall(jpeg)
            except (BrokenPipeError, ConnectionResetError, OSError):
                break
            time.sleep(1.0 / FPS)
    finally:
        print(f"[-] Client disconnected: {addr}")
        conn.close()


def reader_loop(proc, frame_lock, frame_holder, stop_event):
    """Read JPEG frames from GStreamer stdout."""
    buf = b""
    while not stop_event.is_set() and proc.poll() is None:
        chunk = proc.stdout.read(16384)
        if not chunk:
            break
        buf += chunk
        # Extract complete JPEG frames
        while True:
            start = buf.find(b"\xff\xd8")
            if start == -1:
                buf = b""
                break
            end = buf.find(b"\xff\xd9", start + 2)
            if end == -1:
                buf = buf[start:]
                break
            jpeg = buf[start:end + 2]
            buf = buf[end + 2:]
            with frame_lock:
                frame_holder[0] = jpeg

    stderr = proc.stderr.read().decode(errors="replace").strip()
    if stderr:
        print(f"GStreamer stderr: {stderr}")


def main():
    use_test = "--test" in sys.argv

    frame_lock = threading.Lock()
    frame_holder = [None]
    stop_event = threading.Event()

    # Start GStreamer capture
    proc = start_capture(use_test)
    time.sleep(1)
    if proc.poll() is not None:
        stderr = proc.stderr.read().decode(errors="replace")
        print(f"GStreamer failed to start: {stderr}")
        if not use_test:
            print("Retrying with test pattern...")
            proc = start_capture(use_test=True)
            time.sleep(1)
            if proc.poll() is not None:
                print("Test pattern also failed. Exiting.")
                sys.exit(1)

    # Start reader thread
    reader = threading.Thread(target=reader_loop, args=(proc, frame_lock, frame_holder, stop_event), daemon=True)
    reader.start()

    # Wait for first frame
    print("Waiting for first frame...")
    deadline = time.time() + 10
    while time.time() < deadline:
        with frame_lock:
            if frame_holder[0] is not None:
                break
        time.sleep(0.1)
    else:
        print("WARNING: No frames received yet, but starting server anyway.")

    # TCP server
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((HOST, PORT))
    server.listen(4)
    print(f"MJPEG streamer ready on {HOST}:{PORT}")

    try:
        while True:
            conn, addr = server.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            t = threading.Thread(target=handle_client, args=(conn, addr, frame_lock, frame_holder, stop_event), daemon=True)
            t.start()
    except KeyboardInterrupt:
        print("\nShutting down.")
    finally:
        stop_event.set()
        proc.terminate()
        server.close()


if __name__ == "__main__":
    main()
