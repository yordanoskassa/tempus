/*
 * cam_stream - QNX camera to stdout streamer
 * Writes raw NV12 frames to stdout for piping over SSH.
 * Each frame is exactly (width * height * 3 / 2) bytes.
 *
 * Usage: cam_stream -u 1 -w 640 -h 480 -r 15
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <camera/camera_api.h>

static volatile int running = 1;
static int frame_width = 640;
static int frame_height = 480;

static void sighandler(int sig) {
    (void)sig;
    running = 0;
}

static void vf_callback(camera_handle_t handle, camera_buffer_t *buf, void *arg) {
    (void)handle;
    (void)arg;

    if (!running || buf == NULL)
        return;

    uint32_t width = buf->framedesc.nv12.width;
    uint32_t height = buf->framedesc.nv12.height;
    uint32_t uv_offset = buf->framedesc.nv12.uv_offset;
    uint32_t uv_stride = buf->framedesc.nv12.uv_stride;
    uint32_t size = uv_offset + uv_stride * (height / 2);

    if (size == 0 || buf->framebuf == NULL)
        return;

    /* Write raw NV12 frame to stdout */
    size_t written = 0;
    while (written < size && running) {
        ssize_t n = write(STDOUT_FILENO, (uint8_t*)buf->framebuf + written, size - written);
        if (n <= 0) {
            running = 0;
            return;
        }
        written += n;
    }
}

int main(int argc, char **argv) {
    int unit = 1;
    double fps = 15.0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-u") == 0 && i + 1 < argc) unit = atoi(argv[++i]);
        else if (strcmp(argv[i], "-w") == 0 && i + 1 < argc) frame_width = atoi(argv[++i]);
        else if (strcmp(argv[i], "-h") == 0 && i + 1 < argc) frame_height = atoi(argv[++i]);
        else if (strcmp(argv[i], "-r") == 0 && i + 1 < argc) fps = atof(argv[++i]);
    }

    signal(SIGINT, sighandler);
    signal(SIGTERM, sighandler);
    signal(SIGPIPE, sighandler);

    camera_handle_t cam;
    camera_error_t err = camera_open((camera_unit_t)unit, CAMERA_MODE_RW, &cam);
    if (err != CAMERA_EOK) {
        fprintf(stderr, "camera_open failed: %d\n", err);
        return 1;
    }

    camera_set_vf_property(cam, CAMERA_IMGPROP_FORMAT, CAMERA_FRAMETYPE_NV12);
    camera_set_vf_property(cam, CAMERA_IMGPROP_WIDTH, frame_width);
    camera_set_vf_property(cam, CAMERA_IMGPROP_HEIGHT, frame_height);
    camera_set_vf_property(cam, CAMERA_IMGPROP_FRAMERATE, fps);

    err = camera_start_viewfinder(cam, vf_callback, NULL, NULL);
    if (err != CAMERA_EOK) {
        fprintf(stderr, "camera_start_viewfinder failed: %d\n", err);
        camera_close(cam);
        return 1;
    }

    fprintf(stderr, "Streaming %dx%d NV12 @%.0ffps to stdout\n", frame_width, frame_height, fps);

    while (running) {
        usleep(100000);
    }

    camera_stop_viewfinder(cam);
    camera_close(cam);
    return 0;
}
