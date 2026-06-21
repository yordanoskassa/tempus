/*
 * cam_stream - QNX Camera Module 3 JPEG streamer
 * Captures NV12 from camera, converts to I420, encodes JPEG with turbojpeg.
 * Each frame output: [4-byte big-endian length][JPEG data]
 *
 * Usage: cam_stream [-u unit] [-r fps] [-q quality]
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <arpa/inet.h>
#include <turbojpeg.h>
#include <camera/camera_api.h>

static volatile int running = 1;
static tjhandle tj_handle = NULL;
static int jpeg_quality = 70;
static int first_frame = 1;
static unsigned char *u_plane_buf = NULL;
static unsigned char *v_plane_buf = NULL;
static uint32_t uv_buf_size = 0;

static void sighandler(int sig) {
    (void)sig;
    running = 0;
}

static void vf_callback(camera_handle_t handle, camera_buffer_t *buf, void *arg) {
    (void)handle;
    (void)arg;

    if (!running || buf == NULL || buf->framebuf == NULL || tj_handle == NULL)
        return;

    uint32_t width = buf->framedesc.nv12.width;
    uint32_t height = buf->framedesc.nv12.height;
    uint32_t stride = buf->framedesc.nv12.stride;
    uint32_t uv_offset = buf->framedesc.nv12.uv_offset;
    uint32_t uv_stride = buf->framedesc.nv12.uv_stride;

    if (width == 0 || height == 0)
        return;

    if (first_frame) {
        fprintf(stderr, "Camera: %ux%u stride=%u uv_offset=%u uv_stride=%u\n",
                width, height, stride, uv_offset, uv_stride);
        first_frame = 0;
    }

    /* Allocate U/V de-interleave buffers if needed */
    uint32_t chroma_w = width / 2;
    uint32_t chroma_h = height / 2;
    uint32_t needed = chroma_w * chroma_h;
    if (needed > uv_buf_size) {
        free(u_plane_buf);
        free(v_plane_buf);
        u_plane_buf = (unsigned char *)malloc(needed);
        v_plane_buf = (unsigned char *)malloc(needed);
        if (!u_plane_buf || !v_plane_buf) return;
        uv_buf_size = needed;
    }

    /* De-interleave NV12 UV plane into separate U and V planes */
    const unsigned char *nv12_uv = (const unsigned char *)buf->framebuf + uv_offset;
    for (uint32_t row = 0; row < chroma_h; row++) {
        const unsigned char *src = nv12_uv + row * uv_stride;
        unsigned char *u_dst = u_plane_buf + row * chroma_w;
        unsigned char *v_dst = v_plane_buf + row * chroma_w;
        for (uint32_t col = 0; col < chroma_w; col++) {
            u_dst[col] = src[col * 2];
            v_dst[col] = src[col * 2 + 1];
        }
    }

    /* Compress I420 to JPEG */
    const unsigned char *y_plane = (const unsigned char *)buf->framebuf;
    const unsigned char *planes[3] = { y_plane, u_plane_buf, v_plane_buf };
    int strides[3] = { (int)stride, (int)chroma_w, (int)chroma_w };

    unsigned char *jpeg_buf = NULL;
    unsigned long jpeg_size = 0;

    int ret = tjCompressFromYUVPlanes(
        tj_handle,
        planes,
        (int)width,
        strides,
        (int)height,
        TJSAMP_420,
        &jpeg_buf,
        &jpeg_size,
        jpeg_quality,
        0
    );

    if (ret != 0 || jpeg_buf == NULL) {
        if (jpeg_buf) tjFree(jpeg_buf);
        return;
    }

    /* Write 4-byte length header then JPEG data */
    uint32_t len_net = htonl((uint32_t)jpeg_size);
    if (write(STDOUT_FILENO, &len_net, 4) != 4) {
        running = 0;
        tjFree(jpeg_buf);
        return;
    }

    size_t written = 0;
    while (written < jpeg_size && running) {
        ssize_t n = write(STDOUT_FILENO, jpeg_buf + written, jpeg_size - written);
        if (n <= 0) {
            running = 0;
            break;
        }
        written += n;
    }

    tjFree(jpeg_buf);
}

int main(int argc, char **argv) {
    int unit = 1;
    double fps = 15.0;

    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "-u") == 0 && i + 1 < argc) unit = atoi(argv[++i]);
        else if (strcmp(argv[i], "-r") == 0 && i + 1 < argc) fps = atof(argv[++i]);
        else if (strcmp(argv[i], "-q") == 0 && i + 1 < argc) jpeg_quality = atoi(argv[++i]);
    }

    signal(SIGINT, sighandler);
    signal(SIGTERM, sighandler);
    signal(SIGPIPE, sighandler);

    tj_handle = tjInitCompress();
    if (!tj_handle) {
        fprintf(stderr, "tjInitCompress failed\n");
        return 1;
    }

    camera_handle_t cam;
    camera_error_t err = camera_open((camera_unit_t)unit, CAMERA_MODE_RW, &cam);
    if (err != CAMERA_EOK) {
        fprintf(stderr, "camera_open failed: %d\n", err);
        tjDestroy(tj_handle);
        return 1;
    }

    camera_set_vf_property(cam, CAMERA_IMGPROP_FORMAT, CAMERA_FRAMETYPE_NV12);
    camera_set_vf_property(cam, CAMERA_IMGPROP_FRAMERATE, fps);

    err = camera_start_viewfinder(cam, vf_callback, NULL, NULL);
    if (err != CAMERA_EOK) {
        fprintf(stderr, "camera_start_viewfinder failed: %d\n", err);
        camera_close(cam);
        tjDestroy(tj_handle);
        return 1;
    }

    fprintf(stderr, "cam_stream: NV12->JPEG (q=%d) @ %.0f fps\n", jpeg_quality, fps);

    while (running) {
        usleep(100000);
    }

    camera_stop_viewfinder(cam);
    camera_close(cam);
    tjDestroy(tj_handle);
    free(u_plane_buf);
    free(v_plane_buf);
    return 0;
}
