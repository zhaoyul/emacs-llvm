import Foundation

#if os(macOS)
final class MacOSDesktopDriver: @unchecked Sendable, DesktopDriver {
    private let permissionsManager = PermissionManager()
    private let processLocator = EmacsProcessLocator()
    private let focusManager = FocusManager()
    private let lease = DesktopInputLease()
    private let cancellation = InputCancellationState()
    private let captureService = ScreenCaptureService()

    func capabilities() async throws -> DriverCapabilities {
        let accessibility = permissionsManager.accessibilityTrusted()
        DriverCapabilities(
            protocolVersion: "1.0",
            nativeKeyboard: accessibility,
            windowFocus: accessibility,
            windowCapture: permissionsManager.screenRecordingGranted(),
            frontmostQuery: true,
            accessibilityTrusted: accessibility,
            screenRecordingGranted: permissionsManager.screenRecordingGranted()
        )
    }

    func permissions() async -> [PermissionState] { permissionsManager.states() }
    func frontmostApplication() async throws -> ApplicationInfo { try await processLocator.frontmost() }

    func focusEmacs(_ target: NativeTarget, options: FocusOptions) async throws -> FocusResult {
        try await focusManager.focus(target, options: options)
    }

    func sendKeySequence(_ sequence: NativeSequence, target: NativeTarget, focusOptions: FocusOptions) async throws -> InputResult {
        guard permissionsManager.accessibilityTrusted() else { throw DesktopDriverError.accessibilityNotGranted }
        let leaseToken = try await lease.acquire()
        cancellation.reset()
        let monitor = UserInterferenceMonitor()
        var focus: FocusResult?
        var restored = false
        do {
            focus = try await focusManager.focus(target, options: focusOptions)
            let verified = try await processLocator.frontmost()
            guard verified.pid == target.pid else {
                throw DesktopDriverError.frontmostMismatch(expected: target.pid, actual: verified.pid)
            }
            try monitor.start()
            let injector = CGEventInjector()
            let sent = try await injector.send(sequence, monitor: monitor, cancellation: cancellation)
            try await Task.sleep(for: .milliseconds(80))
            if monitor.detected() { throw DesktopDriverError.userInterference }
            if cancellation.isCancelled() { throw DesktopDriverError.nativeDriverUnavailable("Native input sequence was cancelled.") }
            monitor.stop()
            if focusOptions.restoreFrontmost { restored = await focusManager.restore(focus?.previousFrontmost) }
            await lease.release(leaseToken)
            return InputResult(
                sentEvents: sent,
                cancelled: false,
                userInterferenceDetected: false,
                restoredPreviousApplication: restored,
                previousFrontmost: focus?.previousFrontmost
            )
        } catch {
            let interference = monitor.detected()
            monitor.stop()
            _ = await focusManager.restore(focus?.previousFrontmost)
            await lease.release(leaseToken)
            if interference { throw DesktopDriverError.userInterference }
            throw error
        }
    }

    func restoreApplication(_ application: ApplicationInfo) async -> Bool {
        await focusManager.restore(application)
    }

    func captureEmacs(_ target: NativeTarget, options: CaptureOptions) async throws -> CaptureResult {
        try await captureService.capture(target: target, options: options)
    }

    func cancelAll() async { cancellation.cancel() }
}
#endif
