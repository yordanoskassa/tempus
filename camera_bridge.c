/*
 * QNX Camera TCP Bridge
 * Captures NV12 frames from the camera and streams them over TCP.
 * Each frame is preceded by a 32-byte header:
 *   [magic:4][width:4][height:4][stride:4][uv_offset:4][uv_stride:4][format:4][size:4]
 * All values are network byte order (big-endian).
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <signal.h>
#include <errno.h>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <camera/camera_api.h>

#define PORT 8765
#define MAGIC 0x514E5846  /* "QNXF" */

static int client_fd = -1;
static volatile int running = 1;

static void sighandler(int sig) {
    (void)sig;
    running = 0;
}

static void vf_callback(camera_handle_t handle, camera_buffer_t *buf, void *arg) {
    (void)handle;
    (void)arg;

    if (client_fd < 0 || buf == NULL)
        return;

    uint32_t width = buf->framedesc.nv12.width;
    uint32_t height = buf->framedesc.nv12.height;
    uint32_t stride = buf->framedesc.nv12.stride;
    uint32_t uv_offset = buf->framedesc.nv12.uv_offset;
    uint32_t uv_stride = buf->framedesc.nv12.uv_stride;
    /* Calculate actual NV12 data size: Y plane + UV plane */
    uint32_t size = uv_offset + uv_stride * (height / 2);

    /* Build header */
    uint32_t header[8];
    header[0] = htonl(MAGIC);
    header[1] = htonl(width);
    header[2] = htonl(height);
    header[3] = htonl(stride);
    header[4] = htonl(uv_offset);
    header[5] = htonl(uv_stride);
    header[6] = htonl(0);  /* format: 0 = NV12 */
    header[7] = htonl(size);

    /* Send header + frame data */
    if (write(client_fd, header, 32) != 32) {
        close(client_fd);
        client_fd = -1;
        return;
    }
    uint32_t sent = 0;
    while (sent < size) {
        ssize_t n = write(client_fd, (uint8_t*)buf->framebuf + sent, size - sent);
        if (n <= 0) {
            close(client_fd);
            client_fd = -1;
            return;
        }
        sent += n;
    }
}

int main(int argc, char **argv) {
    int unit = 1;
    if (argc > 1) unit = atoi(argv[1]);

    signal(SIGINT, sighandler);
    signal(SIGTERM, sighandler);
    signal(SIGPIPE, SIG_IGN);

    /* Open camera */
    camera_handle_t cam;
    camera_error_t err = camera_open((camera_unit_t)unit, CAMERA_MODE_RW, &cam);
    if (err != CAMERA_EOK) {
        fprintf(stderr, "camera_open failed: %d\n", err);
        return 1;
    }

    /* Configure viewfinder for NV12 callback */
    camera_set_vf_property(cam, CAMERA_IMGPROP_FORMAT, CAMERA_FRAMETYPE_NV12);
    camera_set_vf_property(cam, CAMERA_IMGPROP_WIDTH, 1280);
    camera_set_vf_property(cam, CAMERA_IMGPROP_HEIGHT, 720);
    camera_set_vf_property(cam, CAMERA_IMGPROP_FRAMERATE, 15.0);

    /* Start viewfinder with callback */
    err = camera_start_viewfinder(cam, vf_callback, NULL, NULL);
    if (err != CAMERA_EOK) {
        fprintf(stderr, "camera_start_viewfinder failed: %d\n", err);
        camera_close(cam);
        return 1;
    }

    /* TCP server */
    int server_fd = socket(AF_INET, SOCK_STREAM, 0);
    int opt = 1;
    setsockopt(server_fd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr = {0};
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = INADDR_ANY;
    addr.sin_port = htons(PORT);

    if (bind(server_fd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        fprintf(stderr, "bind failed: %s\n", strerror(errno));
        camera_stop_viewfinder(cam);
        camera_close(cam);
        return 1;
    }
    listen(server_fd, 2);
    printf("Camera bridge listening on port %d (NV12 1280x720@15fps)\n", PORT);
    fflush(stdout);

    while (running) {
        struct sockaddr_in caddr;
        socklen_t clen = sizeof(caddr);
        int fd = accept(server_fd, (struct sockaddr*)&caddr, &clen);
        if (fd < 0) {
            if (errno == EINTR) continue;
            break;
        }
        int nodelay = 1;
        setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &nodelay, sizeof(nodelay));

        printf("Client connected\n");
        fflush(stdout);
        client_fd = fd;

        /* Wait until client disconnects */
        while (client_fd >= 0 && running) {
            usleep(100000);
        }
        printf("Client disconnected\n");
        fflush(stdout);
    }

    camera_stop_viewfinder(cam);
    camera_close(cam);
    close(server_fd);
    return 0;
}
