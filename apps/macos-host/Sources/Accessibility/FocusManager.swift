import Foundation

#if os(macOS)
import AppKit

struct FocusManager: Sendable {
    private let locator = EmacsProcessLocator()
    private let windows = AccessibilityWindowService()

    @MainActor
    func focus(_ target: NativeTarget, options: FocusOptions) async throws -> FocusResult {
        let previous = try? locator.frontmost()
        let app = try locator.application(pid: target.pid)
        guard app.activate(options: [.activateIgnoringOtherApps]) else {
            throw DesktopDriverError.focusFailed("NSRunningApplication.activate returned false for PID \(target.pid).")
        }
        let window = try windows.selectWindow(pid: target.pid, title: target.windowTitle, identifier: target.windowIdentifier)
        if options.raiseWindow { try windows.raiseAndFocus(window, pid: target.pid) }
        try await waitUntilFrontmost(pid: target.pid, timeoutMilliseconds: options.timeoutMilliseconds)
        return FocusResult(
            previousFrontmost: previous,
            focusedApplication: locator.info(app),
            focusedWindowTitle: window.title,
            verifiedFrontmost: true
        )
    }

    @MainActor
    func restore(_ application: ApplicationInfo?, timeoutMilliseconds: Int = 1200) async -> Bool {
        guard let application else { return true }
        guard let app = try? locator.application(pid: application.pid) else { return false }
        guard app.activate(options: [.activateIgnoringOtherApps]) else { return false }
        return (try? await waitUntilFrontmost(pid: application.pid, timeoutMilliseconds: timeoutMilliseconds)) != nil
    }

    @MainActor
    private func waitUntilFrontmost(pid: Int32, timeoutMilliseconds: Int) async throws {
        let deadline = ContinuousClock.now + .milliseconds(max(1, timeoutMilliseconds))
        var actual: ApplicationInfo?
        while ContinuousClock.now < deadline {
            actual = try? locator.frontmost()
            if actual?.pid == pid { return }
            try await Task.sleep(for: .milliseconds(25))
        }
        throw DesktopDriverError.frontmostMismatch(expected: pid, actual: actual?.pid)
    }
}
#endif
