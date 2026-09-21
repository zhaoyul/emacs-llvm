#define _POSIX_C_SOURCE 200809L
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <errno.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static volatile sig_atomic_t running = 1;

static void on_signal(int signal_number) {
    (void)signal_number;
    running = 0;
}

static const char *arg_value(int argc, char **argv, const char *name) {
    for (int i = 1; i + 1 < argc; ++i) if (strcmp(argv[i], name) == 0) return argv[i + 1];
    return NULL;
}

static void json_string(FILE *out, const char *value) {
    const unsigned char *p = (const unsigned char *)(value ? value : "");
    fputc('"', out);
    while (*p) {
        unsigned char c = *p++;
        switch (c) {
            case '"': fputs("\\\"", out); break;
            case '\\': fputs("\\\\", out); break;
            case '\n': fputs("\\n", out); break;
            case '\r': fputs("\\r", out); break;
            case '\t': fputs("\\t", out); break;
            default:
                if (c < 0x20) fprintf(out, "\\u%04x", c);
                else fputc((int)c, out);
        }
    }
    fputc('"', out);
}

static void write_ready(const char *path, Window window, const char *title) {
    FILE *file = fopen(path, "w");
    if (!file) {
        fprintf(stderr, "Unable to create ready file %s: %s\n", path, strerror(errno));
        exit(3);
    }
    chmod(path, 0600);
    fprintf(file, "{\"pid\":%ld,\"window_identifier\":\"0x%lx\",\"title\":", (long)getpid(), window);
    json_string(file, title);
    fputs("}\n", file);
    fclose(file);
}

static void draw_probe(Display *display, Window window, GC gc, int width, int height, const char *title) {
    Colormap map = DefaultColormap(display, DefaultScreen(display));
    XColor exact, screen;
    unsigned long background = WhitePixel(display, DefaultScreen(display));
    unsigned long accent = BlackPixel(display, DefaultScreen(display));
    unsigned long secondary = BlackPixel(display, DefaultScreen(display));
    if (XAllocNamedColor(display, map, "#17324d", &screen, &exact)) background = screen.pixel;
    if (XAllocNamedColor(display, map, "#4cc9f0", &screen, &exact)) accent = screen.pixel;
    if (XAllocNamedColor(display, map, "#f72585", &screen, &exact)) secondary = screen.pixel;
    XSetForeground(display, gc, background);
    XFillRectangle(display, window, gc, 0, 0, (unsigned int)width, (unsigned int)height);
    XSetForeground(display, gc, accent);
    XFillRectangle(display, window, gc, 24, 28, (unsigned int)(width / 2 - 36), (unsigned int)(height - 56));
    XSetForeground(display, gc, secondary);
    XFillRectangle(display, window, gc, width / 2 + 12, 28, (unsigned int)(width / 2 - 36), (unsigned int)(height - 56));
    XSetForeground(display, gc, WhitePixel(display, DefaultScreen(display)));
    XDrawString(display, window, gc, 42, 58, title, (int)strlen(title));
    XDrawString(display, window, gc, 42, 82, "Emacs Operator Linux X11 probe", 31);
}

static void log_focus(FILE *log, const char *type, Window window) {
    fprintf(log, "{\"type\":");
    json_string(log, type);
    fprintf(log, ",\"window_identifier\":\"0x%lx\"}\n", window);
    fflush(log);
}

static void write_command_file(const char *path, const char *value) {
    if (!path || !*path) return;
    char temporary[4096];
    int written = snprintf(temporary, sizeof(temporary), "%s.%ld.tmp", path, (long)getpid());
    if (written < 0 || (size_t)written >= sizeof(temporary)) return;
    FILE *file = fopen(temporary, "w");
    if (!file) return;
    chmod(temporary, 0600);
    fputs(value, file);
    fputc('\n', file);
    if (fclose(file) != 0) {
        unlink(temporary);
        return;
    }
    if (rename(temporary, path) != 0) unlink(temporary);
}

static void log_key(FILE *log, XKeyEvent *event, bool press, const char *command_file) {
    char text[128] = {0};
    KeySym keysym = NoSymbol;
    int text_length = XLookupString(event, text, (int)sizeof(text) - 1, &keysym, NULL);
    if (text_length < 0) text_length = 0;
    text[text_length] = '\0';
    const char *name = XKeysymToString(keysym);
    uint32_t unicode = 0;
    if ((keysym & 0xff000000UL) == 0x01000000UL) unicode = (uint32_t)(keysym & 0x00ffffffUL);
    else if (keysym <= 0xffUL) unicode = (uint32_t)keysym;
    fputs("{\"type\":", log);
    json_string(log, press ? "key_press" : "key_release");
    fprintf(log, ",\"keycode\":%u,\"keysym_code\":%lu,\"keysym_name\":", event->keycode, (unsigned long)keysym);
    json_string(log, name ? name : "");
    fprintf(log, ",\"state\":%u,\"control\":%s,\"shift\":%s,\"alt\":%s,\"unicode\":%u,\"text\":",
            event->state,
            (event->state & ControlMask) ? "true" : "false",
            (event->state & ShiftMask) ? "true" : "false",
            (event->state & Mod1Mask) ? "true" : "false",
            unicode);
    json_string(log, text);
    fputs("}\n", log);
    fflush(log);
    if (press && (event->state & ControlMask) &&
        (keysym == XK_a || keysym == XK_A)) {
        write_command_file(command_file, "fake-command");
    }
}

int main(int argc, char **argv) {
    const char *title = arg_value(argc, argv, "--title");
    const char *log_path = arg_value(argc, argv, "--log");
    const char *ready_path = arg_value(argc, argv, "--ready");
    const char *command_file = arg_value(argc, argv, "--command-file");
    if (!title || !log_path || !ready_path) {
        fprintf(stderr, "Usage: x11-probe --title TITLE --log FILE --ready FILE [--command-file FILE]\n");
        return 64;
    }
    Display *display = XOpenDisplay(NULL);
    if (!display) {
        fprintf(stderr, "Unable to open DISPLAY.\n");
        return 2;
    }
    signal(SIGTERM, on_signal);
    signal(SIGINT, on_signal);
    int screen = DefaultScreen(display);
    Window root = RootWindow(display, screen);
    const int width = 640, height = 360;
    Window window = XCreateSimpleWindow(display, root, 40, 40, width, height, 1,
                                        BlackPixel(display, screen), WhitePixel(display, screen));
    XStoreName(display, window, title);
    Atom utf8 = XInternAtom(display, "UTF8_STRING", False);
    Atom net_name = XInternAtom(display, "_NET_WM_NAME", False);
    XChangeProperty(display, window, net_name, utf8, 8, PropModeReplace,
                    (const unsigned char *)title, (int)strlen(title));
    Atom pid_atom = XInternAtom(display, "_NET_WM_PID", False);
    unsigned long pid = (unsigned long)getpid();
    XChangeProperty(display, window, pid_atom, XA_CARDINAL, 32, PropModeReplace,
                    (const unsigned char *)&pid, 1);
    XClassHint hint = {.res_name = "emacs-operator-probe", .res_class = "EmacsOperatorProbe"};
    XSetClassHint(display, window, &hint);
    XSelectInput(display, window, ExposureMask | KeyPressMask | KeyReleaseMask | FocusChangeMask | StructureNotifyMask);
    XMapWindow(display, window);
    XFlush(display);

    FILE *log = fopen(log_path, "a");
    if (!log) {
        fprintf(stderr, "Unable to open log %s: %s\n", log_path, strerror(errno));
        XDestroyWindow(display, window);
        XCloseDisplay(display);
        return 3;
    }
    chmod(log_path, 0600);
    setvbuf(log, NULL, _IOLBF, 0);
    GC gc = XCreateGC(display, window, 0, NULL);
    write_ready(ready_path, window, title);
    fprintf(log, "{\"type\":\"ready\",\"pid\":%ld,\"window_identifier\":\"0x%lx\"}\n", (long)getpid(), window);
    fflush(log);

    while (running) {
        while (XPending(display)) {
            XEvent event;
            XNextEvent(display, &event);
            if (event.type == Expose) draw_probe(display, window, gc, width, height, title);
            else if (event.type == FocusIn) log_focus(log, "focus_in", window);
            else if (event.type == FocusOut) log_focus(log, "focus_out", window);
            else if (event.type == MappingNotify) XRefreshKeyboardMapping(&event.xmapping);
            else if (event.type == KeyPress) log_key(log, &event.xkey, true, command_file);
            else if (event.type == KeyRelease) log_key(log, &event.xkey, false, command_file);
            else if (event.type == DestroyNotify) running = 0;
        }
        struct timespec delay = {.tv_sec = 0, .tv_nsec = 10000000L};
        nanosleep(&delay, NULL);
    }
    XFreeGC(display, gc);
    fclose(log);
    XDestroyWindow(display, window);
    XCloseDisplay(display);
    return 0;
}
