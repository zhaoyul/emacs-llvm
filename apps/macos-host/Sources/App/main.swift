import Foundation

#if os(macOS)
import AppKit

@MainActor
final class HostAppDelegate: NSObject, NSApplicationDelegate {
    private let driver = MacOSDesktopDriver()
    private lazy var server = DriverIPCServer(driver: driver)
    private let permissions = PermissionManager()
    private var statusItem: NSStatusItem?
    private var accessibilityItem: NSMenuItem?
    private var screenRecordingItem: NSMenuItem?
    private var serverItem: NSMenuItem?

    func applicationDidFinishLaunching(_ notification: Notification) {
        _ = notification
        NSApp.setActivationPolicy(.accessory)
        configureMenuBar()
        do {
            try server.start()
            serverItem?.title = "Driver RPC: running"
        } catch {
            serverItem?.title = "Driver RPC: failed"
            presentError("Unable to start local driver RPC: \(error.localizedDescription)")
        }
        refreshPermissionLabels()
    }

    func applicationWillTerminate(_ notification: Notification) {
        _ = notification
        server.stop()
    }

    private func configureMenuBar() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.title = "Emacs Operator"
        item.button?.toolTip = "Emacs Operator native host"

        let menu = NSMenu()
        let serverItem = NSMenuItem(title: "Driver RPC: starting", action: nil, keyEquivalent: "")
        serverItem.isEnabled = false
        menu.addItem(serverItem)
        self.serverItem = serverItem

        let accessibility = NSMenuItem(title: "Accessibility: checking", action: nil, keyEquivalent: "")
        accessibility.isEnabled = false
        menu.addItem(accessibility)
        self.accessibilityItem = accessibility

        let screen = NSMenuItem(title: "Screen Recording: checking", action: nil, keyEquivalent: "")
        screen.isEnabled = false
        menu.addItem(screen)
        self.screenRecordingItem = screen

        menu.addItem(.separator())
        let requestAccessibility = NSMenuItem(title: "Request Accessibility Permission", action: #selector(requestAccessibilityPermission), keyEquivalent: "")
        requestAccessibility.target = self
        menu.addItem(requestAccessibility)

        let requestCapture = NSMenuItem(title: "Request Screen Recording Permission", action: #selector(requestScreenRecordingPermission), keyEquivalent: "")
        requestCapture.target = self
        menu.addItem(requestCapture)

        let refresh = NSMenuItem(title: "Refresh Status", action: #selector(refreshStatus), keyEquivalent: "r")
        refresh.target = self
        menu.addItem(refresh)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Emacs Operator Host", action: #selector(quitHost), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)

        item.menu = menu
        statusItem = item
    }

    @objc private func requestAccessibilityPermission() {
        _ = permissions.accessibilityTrusted(prompt: true)
        refreshPermissionLabels()
    }

    @objc private func requestScreenRecordingPermission() {
        _ = permissions.requestScreenRecording()
        refreshPermissionLabels()
    }

    @objc private func refreshStatus() {
        refreshPermissionLabels()
    }

    @objc private func quitHost() {
        NSApp.terminate(nil)
    }

    private func refreshPermissionLabels() {
        let accessibility = permissions.accessibilityTrusted()
        let capture = permissions.screenRecordingGranted()
        accessibilityItem?.title = "Accessibility: \(accessibility ? "granted" : "not granted")"
        screenRecordingItem?.title = "Screen Recording: \(capture ? "granted" : "not granted")"
        statusItem?.button?.image = NSImage(systemSymbolName: accessibility ? "keyboard.badge.ellipsis" : "exclamationmark.triangle", accessibilityDescription: nil)
        statusItem?.button?.imagePosition = .imageLeading
    }

    private func presentError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = "Emacs Operator Host"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }
}

let application = NSApplication.shared
let delegate = HostAppDelegate()
application.delegate = delegate
application.run()
#else
print("EmacsOperatorHost desktop services are available only on macOS; protocol and framing tests remain portable.")
#endif
