CC ?= cc
CFLAGS ?= -std=c11 -O2 -Wall -Wextra -Wpedantic
CPPFLAGS ?=
LDFLAGS ?=
BUILD_DIR := build

.PHONY: all clean test
all: $(BUILD_DIR)/x11-helper $(BUILD_DIR)/x11-probe

$(BUILD_DIR):
	mkdir -p $(BUILD_DIR)

$(BUILD_DIR)/x11-helper: native/x11_helper.c | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) $< -o $@ $(LDFLAGS) -lX11 -lpng -ldl

$(BUILD_DIR)/x11-probe: native/x11_probe.c | $(BUILD_DIR)
	$(CC) $(CPPFLAGS) $(CFLAGS) $< -o $@ $(LDFLAGS) -lX11

clean:
	rm -rf $(BUILD_DIR)
