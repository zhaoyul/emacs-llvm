import Foundation

#if os(macOS)
import ApplicationServices
import CoreGraphics

struct PermissionManager: Sendable {
    func accessibilityTrusted(prompt: Bool = false) -> Bool {
        if prompt {
            // Avoid Swift 6's concurrency rejection of the imported mutable
            // CoreFoundation global. This is the documented AX options key.
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
