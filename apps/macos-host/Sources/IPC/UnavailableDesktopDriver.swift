import Foundation

struct UnavailableDesktopDriver: DesktopDriver {
    func capabilities() async throws -> DriverCapabilities {
        DriverCapabilities(
            protocolVersion: "1.0",
            nativeKeyboard: false,
            windowFocus: false,
            windowCapture: false,
            frontmostQuery: false,
            accessibilityTrusted: false,
            screenRecordingGranted: false
        )
    }

    func permissions() async -> [PermissionState] { [] }

    func frontmostApplication() async throws -> ApplicationInfo {
        throw DesktopDriverError.nativeDriverUnavailable("Desktop driver is available only on macOS.")
    }

    func focusEmacs(_ target: NativeTarget, options: FocusOptions) async throws -> FocusResult {
        _ = target; _ = options
        throw DesktopDriverError.nativeDriverUnavailable("Window focus is unavailable on this platform.")
    }

    func sendKeySequence(_ sequence: NativeSequence, target: NativeTarget, focusOptions: FocusOptions) async throws -> InputResult {
        _ = sequence; _ = target; _ = focusOptions
        throw DesktopDriverError.nativeDriverUnavailable("Native keyboard input is unavailable on this platform/build.")
    }

    func restoreApplication(_ application: ApplicationInfo) async -> Bool { _ = application; return false }

    func captureEmacs(_ target: NativeTarget, options: CaptureOptions) async throws -> CaptureResult {
        _ = target; _ = options
        throw DesktopDriverError.nativeDriverUnavailable("Native capture is unavailable on this platform/build.")
    }

    func cancelAll() async {}
}
