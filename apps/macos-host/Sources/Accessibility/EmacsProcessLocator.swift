import Foundation

#if os(macOS)
import AppKit

struct EmacsProcessLocator: Sendable {
    @MainActor
    func application(pid: Int32) throws -> NSRunningApplication {
        guard let app = NSRunningApplication(processIdentifier: pid_t(pid)), !app.isTerminated else {
            throw DesktopDriverError.processNotFound(pid)
        }
        return app
    }

    @MainActor
    func info(_ app: NSRunningApplication) -> ApplicationInfo {
        ApplicationInfo(
            pid: Int32(app.processIdentifier),
            bundleIdentifier: app.bundleIdentifier,
            name: app.localizedName
        )
    }

    @MainActor
    func frontmost() throws -> ApplicationInfo {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            throw DesktopDriverError.focusFailed("macOS did not report a frontmost application.")
        }
        return info(app)
    }
}
#else
struct EmacsProcessLocator: Sendable {}
#endif
