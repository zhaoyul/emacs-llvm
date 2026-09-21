import Foundation

#if os(macOS)
import ApplicationServices
import CoreGraphics

struct PermissionManager: Sendable {
    func accessibilityTrusted(prompt: Bool = false) -> Bool {
        if prompt {
            // kAXTrustedCheckOptionPrompt is imported as shared mutable
            // CoreFoundation state under Swift 6 strict concurrency. The
            // underlying Accessibility option key is a stable API string.
            let options = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
            return AXIsProcessTrustedWithOptions(options)
        }
        return AXIsProcessTrusted()
    }

    func screenRecordingGranted() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    @discardableResult
    func requestScreenRecording() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    func states() -> [PermissionState] {
        let accessibility = accessibilityTrusted()
        let capture = screenRecordingGranted()
        return [
            PermissionState(name: "accessibility", status: accessibility ? .granted : .denied, granted: accessibility),
            PermissionState(name: "screen_recording", status: capture ? .granted : .denied, granted: capture)
        ]
    }
}
#else
struct PermissionManager: Sendable {
    func accessibilityTrusted(prompt: Bool = false) -> Bool { _ = prompt; return false }
    func screenRecordingGranted() -> Bool { false }
    @discardableResult func requestScreenRecording() -> Bool { false }
    func states() -> [PermissionState] { [] }
}
#endif
