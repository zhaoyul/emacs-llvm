import Foundation

#if os(macOS)
import CoreGraphics
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

struct ScreenCaptureService: Sendable {
    private let permissions = PermissionManager()

    func capture(target: NativeTarget, options: CaptureOptions) async throws -> CaptureResult {
        guard permissions.screenRecordingGranted() else { throw DesktopDriverError.screenCaptureNotGranted }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let candidates = content.windows.filter { window in
            guard let owner = window.owningApplication else { return false }
            return Int32(owner.processID) == target.pid
        }
        guard !candidates.isEmpty else { throw DesktopDriverError.windowNotFound(target.pid) }

        let selected: SCWindow
        if let identifier = target.windowIdentifier,
           let numeric = UInt32(identifier),
           let hit = candidates.first(where: { $0.windowID == numeric }) {
            selected = hit
        } else if let title = target.windowTitle,
                  let hit = candidates.first(where: { $0.title == title }) {
            selected = hit
        } else if let hit = candidates.first(where: { $0.windowLayer == 0 }) ?? candidates.first {
            selected = hit
        } else {
            throw DesktopDriverError.windowNotFound(target.pid)
        }

        let filter = SCContentFilter(desktopIndependentWindow: selected)
        let configuration = SCStreamConfiguration()
        configuration.showsCursor = options.includeCursor
        configuration.capturesAudio = false

        let scale = max(1.0, Double(filter.pointPixelScale))
        let nativeWidth = max(1, Int(Double(filter.contentRect.width) * scale))
        let nativeHeight = max(1, Int(Double(filter.contentRect.height) * scale))
        if let maxWidth = options.maxWidth, maxWidth > 0, nativeWidth > maxWidth {
            let ratio = Double(maxWidth) / Double(nativeWidth)
            configuration.width = maxWidth
            configuration.height = max(1, Int(Double(nativeHeight) * ratio))
        } else {
            configuration.width = nativeWidth
            configuration.height = nativeHeight
        }

        let image: CGImage
        do {
            image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
        } catch {
            if !permissions.screenRecordingGranted() { throw DesktopDriverError.screenCaptureNotGranted }
            throw DesktopDriverError.captureFailed(error.localizedDescription)
        }

        let store = try CaptureStore.create()
        store.cleanup()
        let output = store.nextPNGURL()
        guard let destination = CGImageDestinationCreateWithURL(output as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw DesktopDriverError.captureFailed("Unable to create PNG image destination.")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            throw DesktopDriverError.captureFailed("Unable to finalize PNG image.")
        }
        store.secure(output)
        return CaptureResult(path: output.path, width: image.width, height: image.height)
    }
}
#endif
