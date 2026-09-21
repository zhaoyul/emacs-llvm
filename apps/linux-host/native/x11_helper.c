#define _POSIX_C_SOURCE 200809L
#include <X11/Xatom.h>
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <png.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#define MAX_EVENTS 4096
#define MAX_LINE 262144
#define MAX_MODIFIERS 16
#define MAX_HELD_KEYS 128
#define MAX_CAPTURE_SOURCE_DIMENSION 32768
#define MAX_CAPTURE_SOURCE_PIXELS 67108864ULL

typedef int (*XTestFakeKeyEventFn)(Display *, unsigned int, int, unsigned long);
typedef int (*XTestQueryExtensionFn)(Display *, int *, int *, int *, int *);

typedef struct {
    void *handle;
    XTestFakeKeyEventFn fake_key;
    XTestQueryExtensionFn query;
} XTestAPI;

typedef struct {
    Window window;
    pid_t pid;
    char title[1024];
    char name[256];
} AppInfo;

typedef struct {
    KeyCode code;
    bool pressed;
} HeldKey;

typedef struct {
    HeldKey items[MAX_HELD_KEYS];
    size_t count;
} HeldKeys;

static volatile sig_atomic_t sequence_cancel_requested = 0;
static volatile sig_atomic_t sequence_target_lost = 0;
static volatile sig_atomic_t sequence_focus_lost = 0;
static volatile sig_atomic_t trapped_x11_error = 0;

static int trap_x11_error(Display *display, XErrorEvent *event) {
    (void)display;
    (void)event;
    trapped_x11_error = 1;
    return 0;
}

static void on_sequence_cancel(int signal_number) {
    (void)signal_number;
    sequence_cancel_requested = 1;
}

static void install_sequence_cancel_handlers(void) {
    struct sigaction action;
    memset(&action, 0, sizeof(action));
    action.sa_handler = on_sequence_cancel;
    sigemptyset(&action.sa_mask);
    action.sa_flags = 0;
    sigaction(SIGTERM, &action, NULL);
    sigaction(SIGINT, &action, NULL);
}

static void json_string(const char *value) {
    const unsigned char *p = (const unsigned char *)(value ? value : "");
    putchar('"');
    while (*p) {
        unsigned char c = *p++;
        switch (c) {
            case '"': fputs("\\\"", stdout); break;
            case '\\': fputs("\\\\", stdout); break;
            case '\b': fputs("\\b", stdout); break;
            case '\f': fputs("\\f", stdout); break;
            case '\n': fputs("\\n", stdout); break;
            case '\r': fputs("\\r", stdout); break;
            case '\t': fputs("\\t", stdout); break;
            default:
                if (c < 0x20) printf("\\u%04x", c);
                else putchar((int)c);
        }
    }
    putchar('"');
}

static int fail(const char *code, const char *message) {
    fputs("{\"ok\":false,\"code\":", stdout);
    json_string(code);
    fputs(",\"message\":", stdout);
    json_string(message);
    fputs("}\n", stdout);
    fflush(stdout);
    return 1;
}

static void sleep_ms(unsigned long ms) {
    struct timespec ts;
    ts.tv_sec = (time_t)(ms / 1000UL);
    ts.tv_nsec = (long)((ms % 1000UL) * 1000000UL);
    while (nanosleep(&ts, &ts) == -1 && errno == EINTR) {}
}

static bool sequence_sleep_ms(unsigned long ms) {
    struct timespec ts;
    ts.tv_sec = (time_t)(ms / 1000UL);
    ts.tv_nsec = (long)((ms % 1000UL) * 1000000UL);
    while (!sequence_cancel_requested && nanosleep(&ts, &ts) == -1 && errno == EINTR) {}
    return sequence_cancel_requested == 0;
}

static bool parse_long(const char *text, long *out) {
    if (!text || !*text) return false;
    char *end = NULL;
    errno = 0;
    long value = strtol(text, &end, 0);
    if (errno || !end || *end) return false;
    *out = value;
    return true;
}

static const char *arg_value(int argc, char **argv, const char *name) {
    for (int i = 2; i + 1 < argc; ++i) {
        if (strcmp(argv[i], name) == 0) return argv[i + 1];
    }
    return NULL;
}

static bool has_arg(int argc, char **argv, const char *name) {
    for (int i = 2; i < argc; ++i) if (strcmp(argv[i], name) == 0) return true;
    return false;
}

static bool load_xtest(Display *display, XTestAPI *api, char *error, size_t error_size) {
    memset(api, 0, sizeof(*api));
    const char *candidates[] = {"libXtst.so.6", "libXtst.so", NULL};
    for (size_t i = 0; candidates[i]; ++i) {
        api->handle = dlopen(candidates[i], RTLD_NOW | RTLD_LOCAL);
        if (api->handle) break;
    }
    if (!api->handle) {
        snprintf(error, error_size, "Unable to load libXtst: %s", dlerror() ? dlerror() : "not installed");
        return false;
    }
    void *fake_symbol = dlsym(api->handle, "XTestFakeKeyEvent");
    void *query_symbol = dlsym(api->handle, "XTestQueryExtension");
    memcpy(&api->fake_key, &fake_symbol, sizeof(fake_symbol));
    memcpy(&api->query, &query_symbol, sizeof(query_symbol));
    if (!api->fake_key || !api->query) {
        snprintf(error, error_size, "libXtst does not export the XTest API.");
        memset(api, 0, sizeof(*api));
        return false;
    }
    int event_base = 0, error_base = 0, major = 0, minor = 0;
    if (!api->query(display, &event_base, &error_base, &major, &minor)) {
        snprintf(error, error_size, "The X server does not advertise the XTEST extension.");
        memset(api, 0, sizeof(*api));
        return false;
    }
    return true;
}

static void unload_xtest(XTestAPI *api) {
    /* Xlib may retain extension hooks that point into libXtst until the Display
       is closed. The helper is a short-lived process, so keep libXtst loaded
       and let process teardown reclaim it instead of creating a use-after-dlclose. */
    (void)api;
}

static bool get_window_pid(Display *display, Window window, pid_t *pid) {
    Atom atom = XInternAtom(display, "_NET_WM_PID", True);
    if (atom == None) return false;
    Atom actual_type = None;
    int actual_format = 0;
    unsigned long item_count = 0, bytes_after = 0;
    unsigned char *data = NULL;
    int status = XGetWindowProperty(display, window, atom, 0, 1, False, XA_CARDINAL,
                                    &actual_type, &actual_format, &item_count, &bytes_after, &data);
    if (status != Success || !data || item_count < 1 || actual_format != 32) {
        if (data) XFree(data);
        return false;
    }
    unsigned long raw = *(unsigned long *)data;
    XFree(data);
    *pid = (pid_t)raw;
    return true;
}

static void get_process_name(pid_t pid, char *buffer, size_t size) {
    snprintf(buffer, size, "pid-%ld", (long)pid);
    char path[128];
    snprintf(path, sizeof(path), "/proc/%ld/comm", (long)pid);
    FILE *file = fopen(path, "r");
    if (!file) return;
    if (fgets(buffer, (int)size, file)) {
        size_t length = strlen(buffer);
        while (length && (buffer[length - 1] == '\n' || buffer[length - 1] == '\r')) buffer[--length] = '\0';
    }
    fclose(file);
}

static void get_window_title(Display *display, Window window, char *buffer, size_t size) {
    buffer[0] = '\0';
    Atom net_name = XInternAtom(display, "_NET_WM_NAME", True);
    Atom utf8 = XInternAtom(display, "UTF8_STRING", True);
    if (net_name != None && utf8 != None) {
        Atom actual_type = None;
        int actual_format = 0;
        unsigned long item_count = 0, bytes_after = 0;
        unsigned char *data = NULL;
        if (XGetWindowProperty(display, window, net_name, 0, 4096, False, utf8,
                               &actual_type, &actual_format, &item_count, &bytes_after, &data) == Success && data) {
            size_t copy = item_count < size - 1 ? item_count : size - 1;
            memcpy(buffer, data, copy);
            buffer[copy] = '\0';
            XFree(data);
            if (buffer[0]) return;
        }
    }
    char *legacy = NULL;
    if (XFetchName(display, window, &legacy) && legacy) {
        snprintf(buffer, size, "%s", legacy);
        XFree(legacy);
    }
}

static bool title_matches(const char *candidate, const char *requested) {
    return !requested || !*requested || (candidate && strstr(candidate, requested) != NULL);
}

static bool window_is_viewable(Display *display, Window window) {
    XWindowAttributes attrs;
    return XGetWindowAttributes(display, window, &attrs) && attrs.map_state == IsViewable;
}

static bool find_window_recursive(Display *display, Window current, pid_t pid, const char *title,
                                  int depth, Window *result) {
    if (depth > 32) return false;
    pid_t candidate_pid = 0;
    char candidate_title[1024];
    if (get_window_pid(display, current, &candidate_pid) && candidate_pid == pid && window_is_viewable(display, current)) {
        get_window_title(display, current, candidate_title, sizeof(candidate_title));
        if (title_matches(candidate_title, title)) {
            *result = current;
            return true;
        }
    }
    Window root = 0, parent = 0, *children = NULL;
    unsigned int count = 0;
    if (!XQueryTree(display, current, &root, &parent, &children, &count)) return false;
    bool found = false;
    for (unsigned int i = 0; i < count && !found; ++i) {
        found = find_window_recursive(display, children[i], pid, title, depth + 1, result);
    }
    if (children) XFree(children);
    return found;
}

static bool is_descendant(Display *display, Window child, Window ancestor);

static bool window_exists(Display *display, Window window) {
    if (window == None || window == PointerRoot) return false;
    XErrorHandler previous = XSetErrorHandler(trap_x11_error);
    trapped_x11_error = 0;
    XWindowAttributes attrs;
    int status = XGetWindowAttributes(display, window, &attrs);
    XSync(display, False);
    bool exists = status != 0 && trapped_x11_error == 0;
    XSetErrorHandler(previous);
    return exists;
}

static bool target_has_focus(Display *display, Window target) {
    if (!window_exists(display, target)) {
        sequence_target_lost = 1;
        return false;
    }
    Window focused = None;
    int revert = 0;
    XGetInputFocus(display, &focused, &revert);
    (void)revert;
    if (focused == target) return true;
    if (!window_exists(display, focused)) {
        sequence_focus_lost = 1;
        return false;
    }
    if (is_descendant(display, focused, target)) return true;
    sequence_focus_lost = 1;
    return false;
}

static bool parse_window_identifier(const char *text, Window *window) {
    if (!text || !*text) return false;
    char *end = NULL;
    errno = 0;
    unsigned long raw = strtoul(text, &end, 0);
    if (errno || !end || *end) return false;
    *window = (Window)raw;
    return true;
}

static bool find_target_window(Display *display, pid_t pid, const char *title, const char *identifier, Window *result) {
    Window direct = None;
    if (parse_window_identifier(identifier, &direct) && window_exists(display, direct)) {
        pid_t direct_pid = 0;
        char direct_title[1024];
        get_window_title(display, direct, direct_title, sizeof(direct_title));
        if (get_window_pid(display, direct, &direct_pid) && direct_pid == pid && title_matches(direct_title, title)) {
            *result = direct;
            return true;
        }
    }
    return find_window_recursive(display, DefaultRootWindow(display), pid, title, 0, result);
}

static bool is_descendant(Display *display, Window child, Window ancestor) {
    if (child == ancestor) return true;
    Window current = child;
    for (int depth = 0; depth < 64 && current != None; ++depth) {
        Window root = 0, parent = 0, *children = NULL;
        unsigned int count = 0;
        if (!XQueryTree(display, current, &root, &parent, &children, &count)) return false;
        if (children) XFree(children);
        if (parent == ancestor) return true;
        if (parent == current || parent == root || parent == None) return false;
        current = parent;
    }
    return false;
}

static Window application_window_for(Display *display, Window window) {
    Window current = window;
    Window last_with_pid = None;
    for (int depth = 0; depth < 64 && current != None; ++depth) {
        pid_t pid = 0;
        if (get_window_pid(display, current, &pid)) last_with_pid = current;
        Window root = 0, parent = 0, *children = NULL;
        unsigned int count = 0;
        if (!XQueryTree(display, current, &root, &parent, &children, &count)) break;
        if (children) XFree(children);
        if (parent == None || parent == current || current == root) break;
        current = parent;
    }
    return last_with_pid != None ? last_with_pid : window;
}

static bool app_info_for_window(Display *display, Window window, AppInfo *info) {
    if (window == None || window == PointerRoot) return false;
    Window app_window = application_window_for(display, window);
    pid_t pid = 0;
    if (!get_window_pid(display, app_window, &pid)) return false;
    memset(info, 0, sizeof(*info));
    info->window = app_window;
    info->pid = pid;
    get_window_title(display, app_window, info->title, sizeof(info->title));
    get_process_name(pid, info->name, sizeof(info->name));
    return true;
}

static bool current_application(Display *display, AppInfo *info) {
    Window focused = None;
    int revert = 0;
    XGetInputFocus(display, &focused, &revert);
    (void)revert;
    return app_info_for_window(display, focused, info);
}

static void print_application(const AppInfo *info) {
    if (!info || info->pid <= 0) {
        fputs("null", stdout);
        return;
    }
    fputs("{\"pid\":", stdout);
    printf("%ld", (long)info->pid);
    fputs(",\"bundle_identifier\":null,\"name\":", stdout);
    json_string(info->name);
    fputs(",\"window_title\":", stdout);
    json_string(info->title);
    fputs(",\"window_identifier\":", stdout);
    char id[64];
    snprintf(id, sizeof(id), "0x%lx", info->window);
    json_string(id);
    putchar('}');
}

static void send_net_active(Display *display, Window window) {
    Atom active = XInternAtom(display, "_NET_ACTIVE_WINDOW", True);
    if (active == None) return;
    XEvent event;
    memset(&event, 0, sizeof(event));
    event.xclient.type = ClientMessage;
    event.xclient.window = window;
    event.xclient.message_type = active;
    event.xclient.format = 32;
    event.xclient.data.l[0] = 2;
    event.xclient.data.l[1] = CurrentTime;
    XSendEvent(display, DefaultRootWindow(display), False,
               SubstructureRedirectMask | SubstructureNotifyMask, &event);
}

static bool focus_window(Display *display, Window window, unsigned long timeout_ms) {
    XMapRaised(display, window);
    XRaiseWindow(display, window);
    send_net_active(display, window);
    XSetInputFocus(display, window, RevertToPointerRoot, CurrentTime);
    XSync(display, False);
    unsigned long elapsed = 0;
    while (elapsed <= timeout_ms) {
        Window focused = None;
        int revert = 0;
        XGetInputFocus(display, &focused, &revert);
        (void)revert;
        if (focused == window || is_descendant(display, focused, window)) return true;
        sleep_ms(10);
        elapsed += 10;
    }
    return false;
}

static KeySym named_keysym(const char *key, const char *code) {
    const char *value = (key && *key) ? key : code;
    if (!value || !*value) return NoSymbol;
    struct Mapping { const char *name; KeySym sym; };
    static const struct Mapping mappings[] = {
        {"enter", XK_Return}, {"return", XK_Return}, {"tab", XK_Tab},
        {"escape", XK_Escape}, {"esc", XK_Escape}, {"backspace", XK_BackSpace},
        {"delete", XK_Delete}, {"space", XK_space}, {"left", XK_Left},
        {"arrowleft", XK_Left}, {"right", XK_Right}, {"arrowright", XK_Right},
        {"up", XK_Up}, {"arrowup", XK_Up}, {"down", XK_Down},
        {"arrowdown", XK_Down}, {"home", XK_Home}, {"end", XK_End},
        {"pageup", XK_Page_Up}, {"page_up", XK_Page_Up}, {"pagedown", XK_Page_Down},
        {"page_down", XK_Page_Down}, {"insert", XK_Insert},
        {"control", XK_Control_L}, {"ctrl", XK_Control_L}, {"shift", XK_Shift_L},
        {"alt", XK_Alt_L}, {"meta", XK_Alt_L}, {"super", XK_Super_L},
        {"command", XK_Super_L}, {"hyper", XK_Hyper_L}, {"option", XK_Alt_L},
        {NULL, NoSymbol}
    };
    char lower[128];
    size_t len = strlen(value);
    if (len >= sizeof(lower)) len = sizeof(lower) - 1;
    for (size_t i = 0; i < len; ++i) lower[i] = (char)((value[i] >= 'A' && value[i] <= 'Z') ? value[i] + 32 : value[i]);
    lower[len] = '\0';
    if (strncmp(lower, "key", 3) == 0 && len == 4 && lower[3] >= 'a' && lower[3] <= 'z') return (KeySym)lower[3];
    if (strncmp(lower, "digit", 5) == 0 && len == 6 && lower[5] >= '0' && lower[5] <= '9') return (KeySym)lower[5];
    if (lower[0] == 'f' && lower[1] >= '1' && lower[1] <= '9') {
        long number = 0;
        if (parse_long(lower + 1, &number) && number >= 1 && number <= 24) return XK_F1 + (number - 1);
    }
    for (size_t i = 0; mappings[i].name; ++i) if (strcmp(lower, mappings[i].name) == 0) return mappings[i].sym;
    if (strlen(value) == 1) return (KeySym)(unsigned char)value[0];
    KeySym sym = XStringToKeysym(value);
    if (sym != NoSymbol) return sym;
    sym = XStringToKeysym(lower);
    return sym;
}

static KeySym modifier_keysym(const char *name) {
    if (!name) return NoSymbol;
    if (strcmp(name, "control") == 0) return XK_Control_L;
    if (strcmp(name, "shift") == 0) return XK_Shift_L;
    if (strcmp(name, "alt") == 0 || strcmp(name, "meta") == 0 || strcmp(name, "option") == 0) return XK_Alt_L;
    if (strcmp(name, "super") == 0 || strcmp(name, "command") == 0) return XK_Super_L;
    if (strcmp(name, "hyper") == 0) return XK_Hyper_L;
    return NoSymbol;
}

static bool find_keycode_for_keysym(Display *display, KeySym sym, KeyCode *code, bool *needs_shift) {
    int min_code = 0, max_code = 0, per = 0;
    XDisplayKeycodes(display, &min_code, &max_code);
    KeySym *mapping = XGetKeyboardMapping(display, (KeyCode)min_code, max_code - min_code + 1, &per);
    if (!mapping) return false;
    bool found = false;
    for (int key = min_code; key <= max_code && !found; ++key) {
        for (int level = 0; level < per; ++level) {
            if (mapping[(key - min_code) * per + level] == sym) {
                *code = (KeyCode)key;
                *needs_shift = (level % 2) == 1;
                found = true;
                break;
            }
        }
    }
    XFree(mapping);
    return found;
}

static KeyCode scratch_keycode(Display *display) {
    int min_code = 0, max_code = 0, per = 0;
    XDisplayKeycodes(display, &min_code, &max_code);
    KeySym *mapping = XGetKeyboardMapping(display, (KeyCode)min_code, max_code - min_code + 1, &per);
    if (!mapping) return (KeyCode)max_code;
    for (int key = max_code; key >= min_code; --key) {
        bool empty = true;
        for (int level = 0; level < per; ++level) {
            if (mapping[(key - min_code) * per + level] != NoSymbol) { empty = false; break; }
        }
        if (empty) {
            XFree(mapping);
            return (KeyCode)key;
        }
    }
    XFree(mapping);
    return (KeyCode)max_code;
}

static bool fake_key(XTestAPI *api, Display *display, KeyCode code, bool press) {
    if (!api->fake_key(display, code, press ? True : False, CurrentTime)) return false;
    XSync(display, False);
    return true;
}

static bool send_modifier_list(XTestAPI *api, Display *display, const char *mods, bool press,
                               KeyCode *codes, size_t *count, char *error, size_t error_size) {
    *count = 0;
    if (!mods || !*mods) return true;
    char *copy = strdup(mods);
    if (!copy) return false;
    char *save = NULL;
    char *token = strtok_r(copy, ",", &save);
    while (token) {
        if (*count >= MAX_MODIFIERS) {
            snprintf(error, error_size, "Too many modifiers.");
            free(copy);
            return false;
        }
        if (strcmp(token, "fn") == 0) {
            snprintf(error, error_size, "The fn modifier is not available through X11/XTest.");
            free(copy);
            return false;
        }
        KeySym sym = modifier_keysym(token);
        KeyCode code = sym == NoSymbol ? 0 : XKeysymToKeycode(display, sym);
        if (!code) {
            snprintf(error, error_size, "Unsupported modifier: %s", token);
            free(copy);
            return false;
        }
        codes[(*count)++] = code;
        token = strtok_r(NULL, ",", &save);
    }
    if (press) {
        size_t pressed = 0;
        for (; pressed < *count; ++pressed) {
            if (fake_key(api, display, codes[pressed], true)) continue;
            for (size_t i = pressed; i > 0; --i) (void)fake_key(api, display, codes[i - 1], false);
            snprintf(error, error_size, "Unable to press modifier keycode %u.", codes[pressed]);
            free(copy);
            return false;
        }
    } else {
        bool released = true;
        for (size_t i = *count; i > 0; --i) {
            if (!fake_key(api, display, codes[i - 1], false)) released = false;
        }
        if (!released) {
            snprintf(error, error_size, "Unable to release one or more modifiers.");
            free(copy);
            return false;
        }
    }
    free(copy);
    return true;
}

static bool held_add(HeldKeys *held, KeyCode code) {
    for (size_t i = 0; i < held->count; ++i) if (held->items[i].code == code && held->items[i].pressed) return false;
    if (held->count >= MAX_HELD_KEYS) return false;
    held->items[held->count++] = (HeldKey){.code = code, .pressed = true};
    return true;
}

static bool held_contains(const HeldKeys *held, KeyCode code) {
    for (size_t i = 0; i < held->count; ++i) {
        if (held->items[i].code == code && held->items[i].pressed) return true;
    }
    return false;
}

static bool held_remove(HeldKeys *held, KeyCode code) {
    for (size_t i = 0; i < held->count; ++i) {
        if (held->items[i].code == code && held->items[i].pressed) {
            held->items[i].pressed = false;
            return true;
        }
    }
    return false;
}

static void release_held(XTestAPI *api, Display *display, HeldKeys *held) {
    for (size_t i = held->count; i > 0; --i) {
        if (held->items[i - 1].pressed) fake_key(api, display, held->items[i - 1].code, false);
        held->items[i - 1].pressed = false;
    }
}

static bool send_existing_keysym(XTestAPI *api, Display *display, KeySym sym, bool press_only, bool release_only,
                                 char *error, size_t error_size, int *sent, HeldKeys *held) {
    KeyCode code = 0;
    bool auto_shift = false;
    if (!find_keycode_for_keysym(display, sym, &code, &auto_shift) || !code) {
        snprintf(error, error_size, "No X11 keycode is mapped to keysym 0x%lx.", sym);
        return false;
    }
    KeyCode shift = XKeysymToKeycode(display, XK_Shift_L);
    if (auto_shift && !press_only && !release_only && shift) { if (!fake_key(api, display, shift, true)) return false; ++*sent; }
    if (press_only) {
        if (held_contains(held, code) || held->count >= MAX_HELD_KEYS) {
            snprintf(error, error_size, "Duplicate or excessive key_down for keycode %u.", code);
            return false;
        }
        if (!fake_key(api, display, code, true)) return false;
        if (!held_add(held, code)) {
            (void)fake_key(api, display, code, false);
            snprintf(error, error_size, "Unable to track key_down for keycode %u.", code);
            return false;
        }
        ++*sent;
    } else if (release_only) {
        if (!held_contains(held, code)) { snprintf(error, error_size, "key_up has no matching key_down for keycode %u.", code); return false; }
        if (!fake_key(api, display, code, false)) return false;
        (void)held_remove(held, code);
        ++*sent;
    } else {
        if (!fake_key(api, display, code, true) || !fake_key(api, display, code, false)) return false;
        *sent += 2;
    }
    if (auto_shift && !press_only && !release_only && shift) { if (!fake_key(api, display, shift, false)) return false; ++*sent; }
    return true;
}

static bool send_dynamic_unicode(XTestAPI *api, Display *display, uint32_t codepoint,
                                 char *error, size_t error_size, int *sent) {
    int per = 0;
    KeyCode scratch = scratch_keycode(display);
    KeySym *original = XGetKeyboardMapping(display, scratch, 1, &per);
    if (!original || per <= 0) {
        if (original) XFree(original);
        snprintf(error, error_size, "Unable to inspect X11 keyboard mapping.");
        return false;
    }
    KeySym *temporary = calloc((size_t)per, sizeof(KeySym));
    if (!temporary) { XFree(original); return false; }
    temporary[0] = codepoint <= 0xff ? (KeySym)codepoint : (KeySym)(0x01000000UL | codepoint);
    XChangeKeyboardMapping(display, scratch, per, temporary, 1);
    XSync(display, False);
    bool pressed = fake_key(api, display, scratch, true);
    bool released = pressed && fake_key(api, display, scratch, false);
    if (pressed && !released) (void)fake_key(api, display, scratch, false);
    bool ok = pressed && released;
    if (ok) {
        *sent += 2;
        /*
         * X11 key events carry a keycode, not a resolved keysym.  Restoring the
         * temporary mapping immediately is racy because a busy target client
         * may process the KeyPress after the server mapping has been restored.
         * Keep the Unicode mapping live for a short, bounded grace period.
         */
        XFlush(display);
        unsigned long hold_ms = 75;
        const char *configured = getenv("EMACS_OPERATOR_X11_UNICODE_HOLD_MS");
        long parsed_hold = 0;
        if (configured && parse_long(configured, &parsed_hold) && parsed_hold >= 0 && parsed_hold <= 500) {
            hold_ms = (unsigned long)parsed_hold;
        }
        if (hold_ms > 0) sleep_ms(hold_ms);
    }
    XChangeKeyboardMapping(display, scratch, per, original, 1);
    XSync(display, False);
    free(temporary);
    XFree(original);
    if (!ok) snprintf(error, error_size, "Unable to inject Unicode code point U+%04X.", codepoint);
    return ok;
}

static bool utf8_next(const unsigned char **cursor, const unsigned char *end, uint32_t *codepoint) {
    const unsigned char *s = *cursor;
    size_t remaining = (size_t)(end - s);
    if (remaining == 0 || !*s) return false;
    if (s[0] < 0x80) { *codepoint = s[0]; *cursor = s + 1; return true; }
    if (remaining >= 2 && (s[0] & 0xe0) == 0xc0 && (s[1] & 0xc0) == 0x80) {
        uint32_t cp = ((uint32_t)(s[0] & 0x1f) << 6) | (uint32_t)(s[1] & 0x3f);
        if (cp < 0x80) return false;
        *codepoint = cp; *cursor = s + 2; return true;
    }
    if (remaining >= 3 && (s[0] & 0xf0) == 0xe0 && (s[1] & 0xc0) == 0x80 && (s[2] & 0xc0) == 0x80) {
        uint32_t cp = ((uint32_t)(s[0] & 0x0f) << 12) | ((uint32_t)(s[1] & 0x3f) << 6) | (uint32_t)(s[2] & 0x3f);
        if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) return false;
        *codepoint = cp; *cursor = s + 3; return true;
    }
    if (remaining >= 4 && (s[0] & 0xf8) == 0xf0 && (s[1] & 0xc0) == 0x80 && (s[2] & 0xc0) == 0x80 && (s[3] & 0xc0) == 0x80) {
        uint32_t cp = ((uint32_t)(s[0] & 0x07) << 18) | ((uint32_t)(s[1] & 0x3f) << 12) |
                      ((uint32_t)(s[2] & 0x3f) << 6) | (uint32_t)(s[3] & 0x3f);
        if (cp < 0x10000 || cp > 0x10ffff) return false;
        *codepoint = cp; *cursor = s + 4; return true;
    }
    return false;
}

static bool send_text(XTestAPI *api, Display *display, Window target, const char *text, char *error, size_t error_size, int *sent) {
    const unsigned char *cursor = (const unsigned char *)text;
    const unsigned char *end = cursor + strlen(text);
    while (cursor < end) {
        if (sequence_cancel_requested) return true;
        if (!target_has_focus(display, target)) {
            snprintf(error, error_size, sequence_target_lost ? "Target X11 window disappeared during text injection." : "Target X11 window lost focus during text injection.");
            return false;
        }
        uint32_t cp = 0;
        const unsigned char *before = cursor;
        if (!utf8_next(&cursor, end, &cp)) {
            snprintf(error, error_size, "Invalid UTF-8 text at byte offset %ld.", (long)(before - (const unsigned char *)text));
            return false;
        }
        KeySym sym = cp == '\n' ? XK_Return : cp == '\t' ? XK_Tab : (cp <= 0xff ? (KeySym)cp : (KeySym)(0x01000000UL | cp));
        KeyCode code = 0;
        bool shift = false;
        HeldKeys local = {0};
        if (find_keycode_for_keysym(display, sym, &code, &shift) && code) {
            if (!send_existing_keysym(api, display, sym, false, false, error, error_size, sent, &local)) return false;
        } else if (!send_dynamic_unicode(api, display, cp, error, error_size, sent)) {
            return false;
        }
    }
    return true;
}

static int base64_value(unsigned char c) {
    if (c >= 'A' && c <= 'Z') return c - 'A';
    if (c >= 'a' && c <= 'z') return c - 'a' + 26;
    if (c >= '0' && c <= '9') return c - '0' + 52;
    if (c == '+') return 62;
    if (c == '/') return 63;
    return -1;
}

static char *base64_decode_text(const char *input) {
    if (!input || !*input) return strdup("");
    size_t length = strlen(input);
    if (length % 4U != 0U) return NULL;
    size_t padding = 0;
    if (length && input[length - 1] == '=') ++padding;
    if (length > 1 && input[length - 2] == '=') ++padding;
    size_t capacity = (length / 4U) * 3U - padding;
    unsigned char *out = malloc(capacity + 1U);
    if (!out) return NULL;
    size_t out_len = 0;
    for (size_t i = 0; i < length; i += 4U) {
        bool last = i + 4U == length;
        int a = base64_value((unsigned char)input[i]);
        int b = base64_value((unsigned char)input[i + 1U]);
        int c = input[i + 2U] == '=' ? -2 : base64_value((unsigned char)input[i + 2U]);
        int d = input[i + 3U] == '=' ? -2 : base64_value((unsigned char)input[i + 3U]);
        if (a < 0 || b < 0 || c == -1 || d == -1 || (!last && (c == -2 || d == -2)) ||
            (c == -2 && d != -2)) {
            free(out);
            return NULL;
        }
        uint32_t word = ((uint32_t)a << 18U) | ((uint32_t)b << 12U);
        if (c >= 0) word |= (uint32_t)c << 6U;
        if (d >= 0) word |= (uint32_t)d;
        out[out_len++] = (unsigned char)((word >> 16U) & 0xffU);
        if (c >= 0) out[out_len++] = (unsigned char)((word >> 8U) & 0xffU);
        if (d >= 0) out[out_len++] = (unsigned char)(word & 0xffU);
    }
    if (out_len != capacity) {
        free(out);
        return NULL;
    }
    out[out_len] = '\0';
    return (char *)out;
}

static bool split_fields(char *line, char **fields, size_t expected) {
    size_t count = 0;
    char *cursor = line;
    while (count < expected) {
        fields[count++] = cursor;
        char *tab = strchr(cursor, '\t');
        if (!tab) break;
        *tab = '\0';
        cursor = tab + 1;
    }
    return count == expected;
}

static bool execute_event(XTestAPI *api, Display *display, Window target, char **fields, int *sent,
                          HeldKeys *held, char *error, size_t error_size) {
    char *kind = fields[0];
    char *key = base64_decode_text(fields[1]);
    char *code = base64_decode_text(fields[2]);
    char *text = base64_decode_text(fields[3]);
    char *mods = base64_decode_text(fields[4]);
    long repeat = 0, delay = 0;
    bool parsed = key && code && text && mods && parse_long(fields[5], &repeat) && parse_long(fields[6], &delay);
    if (!parsed || repeat < 1 || repeat > 100 || delay < 0 || delay > 10000) {
        snprintf(error, error_size, "Malformed event record.");
        free(key); free(code); free(text); free(mods);
        return false;
    }
    bool ok = true;
    for (long iteration = 0; iteration < repeat && ok && !sequence_cancel_requested; ++iteration) {
        if (!target_has_focus(display, target)) {
            snprintf(error, error_size, sequence_target_lost ? "Target X11 window disappeared during native input." : "Target X11 window lost focus during native input.");
            ok = false;
            break;
        }
        if (strcmp(kind, "text") == 0) {
            if (!*text) { snprintf(error, error_size, "Text event is empty."); ok = false; break; }
            ok = send_text(api, display, target, text, error, error_size, sent);
            continue;
        }
        KeySym sym = named_keysym(key, code);
        if (sym == NoSymbol) {
            snprintf(error, error_size, "Unsupported X11 key: %s%s%s", key, (*key && *code) ? "/" : "", code);
            ok = false;
            break;
        }
        KeyCode mod_codes[MAX_MODIFIERS];
        size_t mod_count = 0;
        if (!send_modifier_list(api, display, mods, true, mod_codes, &mod_count, error, error_size)) { ok = false; break; }
        *sent += (int)mod_count;
        if (strcmp(kind, "key_press") == 0) ok = send_existing_keysym(api, display, sym, false, false, error, error_size, sent, held);
        else if (strcmp(kind, "key_down") == 0) ok = send_existing_keysym(api, display, sym, true, false, error, error_size, sent, held);
        else if (strcmp(kind, "key_up") == 0) ok = send_existing_keysym(api, display, sym, false, true, error, error_size, sent, held);
        else { snprintf(error, error_size, "Unsupported native event kind: %s", kind); ok = false; }
        size_t release_count = mod_count;
        if (!send_modifier_list(api, display, mods, false, mod_codes, &release_count, error, error_size)) ok = false;
        *sent += (int)release_count;
    }
    if (delay > 0 && !sequence_cancel_requested) (void)sequence_sleep_ms((unsigned long)delay);
    free(key); free(code); free(text); free(mods);
    return ok;
}

static int command_capabilities(Display *display) {
    XTestAPI xtest;
    char error[512];
    bool available = load_xtest(display, &xtest, error, sizeof(error));
    if (available) unload_xtest(&xtest);
    fputs("{\"ok\":true,\"display\":", stdout);
    json_string(DisplayString(display));
    printf(",\"xtest\":%s,\"window_focus\":true,\"window_capture\":true,\"frontmost_query\":true,\"unicode_dynamic_mapping\":true", available ? "true" : "false");
    if (!available) { fputs(",\"xtest_error\":", stdout); json_string(error); }
    fputs("}\n", stdout);
    return 0;
}

static int command_frontmost(Display *display) {
    AppInfo info;
    if (!current_application(display, &info)) return fail("E_TARGET_NOT_FOUND", "No focused X11 application window exposes _NET_WM_PID.");
    fputs("{\"ok\":true,\"application\":", stdout);
    print_application(&info);
    fputs("}\n", stdout);
    return 0;
}

static bool parse_target(int argc, char **argv, pid_t *pid, const char **title, const char **identifier, char *error, size_t error_size) {
    long raw_pid = 0;
    if (!parse_long(arg_value(argc, argv, "--pid"), &raw_pid) || raw_pid <= 0) {
        snprintf(error, error_size, "--pid must be a positive integer.");
        return false;
    }
    *pid = (pid_t)raw_pid;
    *title = arg_value(argc, argv, "--title");
    *identifier = arg_value(argc, argv, "--window-id");
    return true;
}

static int command_focus(Display *display, int argc, char **argv) {
    pid_t pid = 0;
    const char *title = NULL, *identifier = NULL;
    char error[512];
    if (!parse_target(argc, argv, &pid, &title, &identifier, error, sizeof(error))) return fail("E_INVALID_ARGUMENT", error);
    long timeout = 1500;
    const char *timeout_text = arg_value(argc, argv, "--timeout-ms");
    if (timeout_text && (!parse_long(timeout_text, &timeout) || timeout < 1 || timeout > 30000)) return fail("E_INVALID_ARGUMENT", "Invalid --timeout-ms.");
    Window target = None;
    if (!find_target_window(display, pid, title, identifier, &target)) return fail("E_TARGET_NOT_FOUND", "No matching X11 target window was found.");
    AppInfo previous = {0};
    bool has_previous = current_application(display, &previous);
    if (!focus_window(display, target, (unsigned long)timeout)) return fail("E_FOCUS_FAILED", "X11 focus verification timed out.");
    AppInfo focused = {0};
    if (!current_application(display, &focused) || focused.pid != pid) return fail("E_FRONTMOST_MISMATCH", "The focused X11 window does not belong to the requested PID.");
    fputs("{\"ok\":true,\"previous_frontmost\":", stdout);
    if (has_previous) print_application(&previous); else fputs("null", stdout);
    fputs(",\"focused_application\":", stdout);
    print_application(&focused);
    fputs(",\"focused_window_title\":", stdout);
    json_string(focused.title);
    fputs(",\"verified_frontmost\":true}\n", stdout);
    return 0;
}

static int command_restore(Display *display, int argc, char **argv) {
    pid_t pid = 0;
    const char *title = NULL, *identifier = NULL;
    char error[512];
    if (!parse_target(argc, argv, &pid, &title, &identifier, error, sizeof(error))) return fail("E_INVALID_ARGUMENT", error);
    Window target = None;
    if (!find_target_window(display, pid, title, identifier, &target)) return fail("E_TARGET_NOT_FOUND", "No matching X11 restore window was found.");
    if (!focus_window(display, target, 1500)) return fail("E_FOCUS_FAILED", "Unable to restore X11 focus.");
    fputs("{\"ok\":true,\"restored\":true}\n", stdout);
    return 0;
}

static int command_sequence(Display *display, int argc, char **argv) {
    sequence_cancel_requested = 0;
    sequence_target_lost = 0;
    sequence_focus_lost = 0;
    install_sequence_cancel_handlers();
    pid_t pid = 0;
    const char *title = NULL, *identifier = NULL;
    char error[1024];
    if (!parse_target(argc, argv, &pid, &title, &identifier, error, sizeof(error))) return fail("E_INVALID_ARGUMENT", error);
    const char *events_file = arg_value(argc, argv, "--events");
    if (!events_file || !*events_file) return fail("E_INVALID_ARGUMENT", "--events is required.");
    long timeout = 1500;
    const char *timeout_text = arg_value(argc, argv, "--timeout-ms");
    if (timeout_text && (!parse_long(timeout_text, &timeout) || timeout < 1 || timeout > 30000)) return fail("E_INVALID_ARGUMENT", "Invalid --timeout-ms.");
    bool restore = has_arg(argc, argv, "--restore");
    Window target = None;
    if (!find_target_window(display, pid, title, identifier, &target)) return fail("E_TARGET_NOT_FOUND", "No matching X11 target window was found.");
    AppInfo previous = {0};
    bool has_previous = current_application(display, &previous);
    if (!focus_window(display, target, (unsigned long)timeout)) return fail("E_FOCUS_FAILED", "X11 focus verification timed out before input injection.");
    XTestAPI xtest;
    if (!load_xtest(display, &xtest, error, sizeof(error))) return fail("E_NATIVE_DRIVER_UNAVAILABLE", error);
    FILE *file = fopen(events_file, "r");
    if (!file) { unload_xtest(&xtest); return fail("E_INVALID_ARGUMENT", "Unable to open the private event plan."); }
    char *line = malloc(MAX_LINE);
    if (!line) { fclose(file); unload_xtest(&xtest); return fail("E_INTERNAL", "Out of memory."); }
    HeldKeys held = {0};
    int sent = 0;
    int logical_events = 0;
    bool ok = true;
    while (!sequence_cancel_requested && fgets(line, MAX_LINE, file)) {
        size_t length = strlen(line);
        if (length && line[length - 1] == '\n') line[--length] = '\0';
        if (length && line[length - 1] == '\r') line[--length] = '\0';
        if (!length) continue;
        if (++logical_events > MAX_EVENTS) { snprintf(error, sizeof(error), "Event plan exceeds %d logical events.", MAX_EVENTS); ok = false; break; }
        char *fields[7];
        if (!split_fields(line, fields, 7)) { snprintf(error, sizeof(error), "Event plan line has the wrong field count."); ok = false; break; }
        if (!execute_event(&xtest, display, target, fields, &sent, &held, error, sizeof(error))) { ok = false; break; }
    }
    if (ferror(file)) { snprintf(error, sizeof(error), "Unable to read event plan."); ok = false; }
    fclose(file);
    free(line);
    if (held.count) {
        bool unbalanced = false;
        for (size_t i = 0; i < held.count; ++i) if (held.items[i].pressed) unbalanced = true;
        if (unbalanced) {
            release_held(&xtest, display, &held);
            if (!sequence_cancel_requested) {
                snprintf(error, sizeof(error), "Native key sequence ended with unbalanced key_down events; held keys were released.");
                ok = false;
            }
        }
    }
    bool restored = false;
    if (restore && has_previous && previous.window != None) restored = focus_window(display, previous.window, 1500);
    unload_xtest(&xtest);
    if (!ok) {
        if (sequence_target_lost) return fail("E_TARGET_NOT_FOUND", error);
        if (sequence_focus_lost) return fail("E_FRONTMOST_MISMATCH", error);
        return fail("E_INPUT_INJECTION_FAILED", error);
    }
    fputs("{\"ok\":true,\"sent_events\":", stdout);
    printf("%d", sent);
    fputs(",\"cancelled\":", stdout);
    fputs(sequence_cancel_requested ? "true" : "false", stdout);
    fputs(",\"user_interference_detected\":false,\"restored_previous_application\":", stdout);
    fputs(restored ? "true" : "false", stdout);
    fputs(",\"previous_frontmost\":", stdout);
    if (has_previous) print_application(&previous); else fputs("null", stdout);
    fputs("}\n", stdout);
    return 0;
}

static unsigned char component_from_mask(unsigned long pixel, unsigned long mask) {
    if (!mask) return 0;
    unsigned int shift = 0;
    while (((mask >> shift) & 1UL) == 0UL) ++shift;
    unsigned long max_value = mask >> shift;
    unsigned long value = (pixel & mask) >> shift;
    return (unsigned char)((value * 255UL + max_value / 2UL) / max_value);
}

static bool write_png(Display *display, Window window, const char *output, int max_width,
                      int *written_width, int *written_height, char *error, size_t error_size) {
    XWindowAttributes attrs;
    if (!XGetWindowAttributes(display, window, &attrs) || attrs.width <= 0 || attrs.height <= 0) {
        snprintf(error, error_size, "Unable to inspect target window dimensions.");
        return false;
    }
    uint64_t source_pixels = (uint64_t)(unsigned int)attrs.width * (uint64_t)(unsigned int)attrs.height;
    if (attrs.width > MAX_CAPTURE_SOURCE_DIMENSION || attrs.height > MAX_CAPTURE_SOURCE_DIMENSION ||
        source_pixels > MAX_CAPTURE_SOURCE_PIXELS) {
        snprintf(error, error_size, "Target window is too large to capture safely (%dx%d).", attrs.width, attrs.height);
        return false;
    }
    XImage *image = XGetImage(display, window, 0, 0, (unsigned int)attrs.width, (unsigned int)attrs.height, AllPlanes, ZPixmap);
    if (!image) { snprintf(error, error_size, "XGetImage failed for target window."); return false; }
    int out_width = attrs.width;
    int out_height = attrs.height;
    if (max_width > 0 && out_width > max_width) {
        out_height = (int)((long long)out_height * max_width / out_width);
        if (out_height < 1) out_height = 1;
        out_width = max_width;
    }
    int fd = open(output, O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd < 0) { XDestroyImage(image); snprintf(error, error_size, "Unable to create private capture file: %s", strerror(errno)); return false; }
    FILE *file = fdopen(fd, "wb");
    if (!file) { close(fd); unlink(output); XDestroyImage(image); snprintf(error, error_size, "fdopen failed for capture."); return false; }
    png_structp png = png_create_write_struct(PNG_LIBPNG_VER_STRING, NULL, NULL, NULL);
    png_infop info = png ? png_create_info_struct(png) : NULL;
    if (!png || !info) {
        if (png) png_destroy_write_struct(&png, NULL);
        fclose(file); unlink(output); XDestroyImage(image);
        snprintf(error, error_size, "Unable to allocate PNG encoder.");
        return false;
    }
    if (setjmp(png_jmpbuf(png))) {
        png_destroy_write_struct(&png, &info);
        fclose(file); unlink(output); XDestroyImage(image);
        snprintf(error, error_size, "libpng failed while writing capture.");
        return false;
    }
    png_init_io(png, file);
    png_set_IHDR(png, info, (png_uint_32)out_width, (png_uint_32)out_height, 8, PNG_COLOR_TYPE_RGB,
                 PNG_INTERLACE_NONE, PNG_COMPRESSION_TYPE_DEFAULT, PNG_FILTER_TYPE_DEFAULT);
    png_write_info(png, info);
    png_bytep row = malloc((size_t)out_width * 3U);
    if (!row) png_error(png, "out of memory");
    for (int y = 0; y < out_height; ++y) {
        int source_y = (int)((long long)y * attrs.height / out_height);
        for (int x = 0; x < out_width; ++x) {
            int source_x = (int)((long long)x * attrs.width / out_width);
            unsigned long pixel = XGetPixel(image, source_x, source_y);
            row[x * 3] = component_from_mask(pixel, image->red_mask);
            row[x * 3 + 1] = component_from_mask(pixel, image->green_mask);
            row[x * 3 + 2] = component_from_mask(pixel, image->blue_mask);
        }
        png_write_row(png, row);
    }
    free(row);
    png_write_end(png, NULL);
    png_destroy_write_struct(&png, &info);
    if (fclose(file) != 0) { unlink(output); XDestroyImage(image); snprintf(error, error_size, "Unable to finalize capture file."); return false; }
    chmod(output, 0600);
    XDestroyImage(image);
    *written_width = out_width;
    *written_height = out_height;
    return true;
}

static int command_capture(Display *display, int argc, char **argv) {
    pid_t pid = 0;
    const char *title = NULL, *identifier = NULL;
    char error[1024];
    if (!parse_target(argc, argv, &pid, &title, &identifier, error, sizeof(error))) return fail("E_INVALID_ARGUMENT", error);
    const char *output = arg_value(argc, argv, "--output");
    if (!output || output[0] != '/') return fail("E_INVALID_ARGUMENT", "--output must be an absolute path.");
    long max_width = 2048;
    const char *width_text = arg_value(argc, argv, "--max-width");
    if (width_text && (!parse_long(width_text, &max_width) || max_width < 1 || max_width > 8192)) return fail("E_INVALID_ARGUMENT", "Invalid --max-width.");
    Window target = None;
    if (!find_target_window(display, pid, title, identifier, &target)) return fail("E_TARGET_NOT_FOUND", "No matching X11 capture window was found.");
    int width = 0, height = 0;
    if (!write_png(display, target, output, (int)max_width, &width, &height, error, sizeof(error))) return fail("E_CAPTURE_FAILED", error);
    fputs("{\"ok\":true,\"path\":", stdout);
    json_string(output);
    printf(",\"width\":%d,\"height\":%d}\n", width, height);
    return 0;
}

int main(int argc, char **argv) {
    if (argc < 2) return fail("E_INVALID_ARGUMENT", "A command is required.");
    const char *display_name = getenv("DISPLAY");
    if (!display_name || !*display_name) return fail("E_NATIVE_DRIVER_UNAVAILABLE", "DISPLAY is not set.");
    Display *display = XOpenDisplay(NULL);
    if (!display) return fail("E_NATIVE_DRIVER_UNAVAILABLE", "Unable to open the X11 display.");
    int result = 0;
    if (strcmp(argv[1], "capabilities") == 0) result = command_capabilities(display);
    else if (strcmp(argv[1], "frontmost") == 0) result = command_frontmost(display);
    else if (strcmp(argv[1], "focus") == 0) result = command_focus(display, argc, argv);
    else if (strcmp(argv[1], "restore") == 0) result = command_restore(display, argc, argv);
    else if (strcmp(argv[1], "sequence") == 0) result = command_sequence(display, argc, argv);
    else if (strcmp(argv[1], "capture") == 0) result = command_capture(display, argc, argv);
    else result = fail("E_INVALID_ARGUMENT", "Unsupported X11 helper command.");
    XCloseDisplay(display);
    return result;
}
