import Foundation

enum PermissionStatus: String, Codable, Sendable {
    case unknown
    case notRequested = "not_requested"
    case denied
    case granted
    case restricted
}

struct DriverCapabilities: Codable, Sendable, Equatable {
    let protocolVersion: String
    let nativeKeyboard: Bool
    let windowFocus: Bool
    let windowCapture: Bool
    let frontmostQuery: Bool
    let accessibilityTrusted: Bool
    let screenRecordingGranted: Bool
}

struct PermissionState: Codable, Sendable, Equatable {
    let name: String
    let status: PermissionStatus
    let granted: Bool
}

struct ApplicationInfo: Codable, Sendable, Equatable {
    let pid: Int32
    let bundleIdentifier: String?
    let name: String?
}

struct NativeTarget: Codable, Sendable, Equatable {
    let pid: Int32
    let windowTitle: String?
    let windowIdentifier: String?
}

struct FocusOptions: Codable, Sendable, Equatable {
    let raiseWindow: Bool
    let restoreFrontmost: Bool
    let timeoutMilliseconds: Int

    init(raiseWindow: Bool = true, restoreFrontmost: Bool = true, timeoutMilliseconds: Int = 1500) {
        self.raiseWindow = raiseWindow
        self.restoreFrontmost = restoreFrontmost
        self.timeoutMilliseconds = timeoutMilliseconds
    }
}

struct FocusResult: Codable, Sendable, Equatable {
    let previousFrontmost: ApplicationInfo?
    let focusedApplication: ApplicationInfo
    let focusedWindowTitle: String?
    let verifiedFrontmost: Bool
}

struct NativeSequence: Codable, Sendable, Equatable {
    let events: [NativeKeyEvent]
}

struct NativeKeyEvent: Codable, Sendable, Equatable {
    let kind: String
    let key: String?
    let code: String?
    let text: String?
    let modifiers: [String]?
    let repeatCount: Int?
    let delayAfterMilliseconds: Int?
}

struct InputResult: Codable, Sendable, Equatable {
    let sentEvents: Int
    let cancelled: Bool
    let userInterferenceDetected: Bool
    let restoredPreviousApplication: Bool
    let previousFrontmost: ApplicationInfo?
}

struct CaptureOptions: Codable, Sendable, Equatable {
    let maxWidth: Int?
    let includeCursor: Bool
}

struct CaptureResult: Codable, Sendable, Equatable {
    let path: String
    let width: Int
    let height: Int
}

enum DesktopDriverError: Error, CustomStringConvertible, Sendable {
    case nativeDriverUnavailable(String)
    case accessibilityNotGranted
    case screenCaptureNotGranted
    case processNotFound(Int32)
    case windowNotFound(Int32)
    case focusFailed(String)
    case frontmostMismatch(expected: Int32, actual: Int32?)
    case userInterference
    case inputInjectionFailed(String)
    case captureFailed(String)
    case invalidArgument(String)

    var stableCode: String {
        switch self {
        case .nativeDriverUnavailable: return "E_NATIVE_DRIVER_UNAVAILABLE"
        case .accessibilityNotGranted: return "E_ACCESSIBILITY_NOT_GRANTED"
        case .screenCaptureNotGranted: return "E_SCREEN_CAPTURE_NOT_GRANTED"
        case .processNotFound, .windowNotFound: return "E_TARGET_NOT_FOUND"
        case .focusFailed: return "E_FOCUS_FAILED"
        case .frontmostMismatch: return "E_FRONTMOST_MISMATCH"
        case .userInterference: return "E_USER_INTERFERENCE"
        case .inputInjectionFailed: return "E_INPUT_INJECTION_FAILED"
        case .captureFailed: return "E_CAPTURE_FAILED"
        case .invalidArgument: return "E_INVALID_ARGUMENT"
        }
    }

    var description: String {
        switch self {
        case .nativeDriverUnavailable(let message): return message
        case .accessibilityNotGranted: return "Accessibility permission has not been granted."
        case .screenCaptureNotGranted: return "Screen Recording permission has not been granted."
        case .processNotFound(let pid): return "No running application exists for PID \(pid)."
        case .windowNotFound(let pid): return "No accessible target window exists for PID \(pid)."
        case .focusFailed(let message): return message
        case .frontmostMismatch(let expected, let actual): return "Expected frontmost PID \(expected), got \(actual.map(String.init) ?? "none")."
        case .userInterference: return "Human keyboard or mouse input was detected while native injection was active."
        case .inputInjectionFailed(let message): return message
        case .captureFailed(let message): return message
        case .invalidArgument(let message): return message
        }
    }
}

protocol DesktopDriver: Sendable {
    func capabilities() async throws -> DriverCapabilities
    func permissions() async -> [PermissionState]
    func frontmostApplication() async throws -> ApplicationInfo
    func focusEmacs(_ target: NativeTarget, options: FocusOptions) async throws -> FocusResult
    func sendKeySequence(_ sequence: NativeSequence, target: NativeTarget, focusOptions: FocusOptions) async throws -> InputResult
    func restoreApplication(_ application: ApplicationInfo) async -> Bool
    func captureEmacs(_ target: NativeTarget, options: CaptureOptions) async throws -> CaptureResult
    func cancelAll() async
}
