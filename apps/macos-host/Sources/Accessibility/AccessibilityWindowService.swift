import Foundation

#if os(macOS)
import ApplicationServices
import CoreGraphics

struct AccessibilityWindow: @unchecked Sendable {
    let element: AXUIElement
    let title: String?
    let identifier: String?
    let position: CGPoint?
    let size: CGSize?
}

struct AccessibilityWindowService: Sendable {
    private let permissions = PermissionManager()

    func windows(pid: Int32) throws -> [AccessibilityWindow] {
        guard permissions.accessibilityTrusted() else { throw DesktopDriverError.accessibilityNotGranted }
        let application = AXUIElementCreateApplication(pid_t(pid))
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value)
        guard error == .success, let raw = value as? [AXUIElement] else {
            throw DesktopDriverError.windowNotFound(pid)
        }
        return raw.map {
            AccessibilityWindow(
                element: $0,
                title: stringAttribute($0, kAXTitleAttribute),
                identifier: stringAttribute($0, kAXIdentifierAttribute),
                position: pointAttribute($0, kAXPositionAttribute),
                size: sizeAttribute($0, kAXSizeAttribute)
            )
        }
    }

    func selectWindow(pid: Int32, title: String?, identifier: String?) throws -> AccessibilityWindow {
        let candidates = try windows(pid: pid)

        // Some applications expose a stable AX identifier. Prefer it when it is
        // directly available.
        if let identifier, let hit = candidates.first(where: { $0.identifier == identifier }) {
            return hit
        }

        // Emacs exposes the graphical frame's `outer-window-id`. On macOS this
        // can be used as a window-server identifier on builds where the values
        // correspond. Resolve that CGWindowID to bounds and match the AX window
        // by geometry. If a particular Emacs build does not expose a compatible
        // ID, this branch simply falls through to the frame-title match.
        if let identifier, let numeric = UInt32(identifier),
           let bounds = windowServerBounds(windowID: CGWindowID(numeric), pid: pid),
           let hit = candidates.min(by: { geometryDistance($0, bounds) < geometryDistance($1, bounds) }),
           geometryDistance(hit, bounds) <= 8.0 {
            return hit
        }

        if let title, let hit = candidates.first(where: { $0.title == title }) {
            return hit
        }

        // Prefer the application's main/focused window instead of arbitrary
        // array order when no frame-specific hint is available.
        if let focused = focusedWindow(pid: pid),
           let hit = candidates.first(where: { CFEqual($0.element, focused) }) {
            return hit
        }

        if let hit = candidates.first { return hit }
        throw DesktopDriverError.windowNotFound(pid)
    }

    func raiseAndFocus(_ window: AccessibilityWindow, pid: Int32) throws {
        let raised = AXUIElementPerformAction(window.element, kAXRaiseAction as CFString)
        guard raised == .success else {
            throw DesktopDriverError.focusFailed("AXRaise failed with code \(raised.rawValue).")
        }
        _ = AXUIElementSetAttributeValue(window.element, kAXFocusedAttribute as CFString, kCFBooleanTrue)
        let application = AXUIElementCreateApplication(pid_t(pid))
        _ = AXUIElementSetAttributeValue(application, kAXFocusedWindowAttribute as CFString, window.element)
    }

    private func focusedWindow(pid: Int32) -> AXUIElement? {
        let application = AXUIElementCreateApplication(pid_t(pid))
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXFocusedWindowAttribute as CFString, &value) == .success,
              let value,
              CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
        return unsafeBitCast(value, to: AXUIElement.self)
    }

    private func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
        return value as? String
    }

    private func pointAttribute(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
              let raw,
              CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let value = unsafeBitCast(raw, to: AXValue.self)
        guard AXValueGetType(value) == .cgPoint else { return nil }
        var point = CGPoint.zero
        return AXValueGetValue(value, .cgPoint, &point) ? point : nil
    }

    private func sizeAttribute(_ element: AXUIElement, _ attribute: String) -> CGSize? {
        var raw: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute as CFString, &raw) == .success,
              let raw,
              CFGetTypeID(raw) == AXValueGetTypeID() else { return nil }
        let value = unsafeBitCast(raw, to: AXValue.self)
        guard AXValueGetType(value) == .cgSize else { return nil }
        var size = CGSize.zero
        return AXValueGetValue(value, .cgSize, &size) ? size : nil
    }

    private func windowServerBounds(windowID: CGWindowID, pid: Int32) -> CGRect? {
        guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], windowID) as? [[CFString: Any]] else { return nil }
        for window in info {
            guard (window[kCGWindowOwnerPID] as? NSNumber)?.int32Value == pid,
                  let dictionary = window[kCGWindowBounds] as? CFDictionary else { continue }
            var bounds = CGRect.zero
            if CGRectMakeWithDictionaryRepresentation(dictionary, &bounds) { return bounds }
        }
        return nil
    }

    private func geometryDistance(_ window: AccessibilityWindow, _ bounds: CGRect) -> CGFloat {
        guard let position = window.position, let size = window.size else { return .greatestFiniteMagnitude }
        return abs(position.x - bounds.origin.x)
            + abs(position.y - bounds.origin.y)
            + abs(size.width - bounds.size.width)
            + abs(size.height - bounds.size.height)
    }
}
#endif
