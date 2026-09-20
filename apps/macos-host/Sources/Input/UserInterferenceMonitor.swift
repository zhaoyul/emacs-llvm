import Foundation

#if os(macOS)
import CoreGraphics

final class UserInterferenceMonitor: @unchecked Sendable {
    static let injectedEventTag: Int64 = 0x454D4143534F5052

    private let lock = NSLock()
    private var interference = false
    private var running = false
    private var tap: CFMachPort?
    private var runLoop: CFRunLoop?
    private var thread: Thread?
    private let ready = DispatchSemaphore(value: 0)

    func start() throws {
        lock.withLock { interference = false }
        let thread = Thread { [weak self] in self?.runEventTap() }
        thread.name = "EmacsOperator.UserInterferenceMonitor"
        self.thread = thread
        thread.start()
        guard ready.wait(timeout: .now() + 1.5) == .success, lock.withLock({ running }) else {
            stop()
            throw DesktopDriverError.nativeDriverUnavailable("Unable to create the macOS user-input event tap.")
        }
    }

    func stop() {
        let loop = lock.withLock { () -> CFRunLoop? in
            let value = runLoop
            running = false
            return value
        }
        if let loop { CFRunLoopStop(loop) }
        thread = nil
    }

    func detected() -> Bool { lock.withLock { interference } }

    private func runEventTap() {
        let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown]
        let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
        guard let tap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: { _, type, event, userInfo in
                guard let userInfo else { return Unmanaged.passUnretained(event) }
                let monitor = Unmanaged<UserInterferenceMonitor>.fromOpaque(userInfo).takeUnretainedValue()
                if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                    if let tap = monitor.lock.withLock({ monitor.tap }) { CGEvent.tapEnable(tap: tap, enable: true) }
                    return Unmanaged.passUnretained(event)
                }
                if event.getIntegerValueField(.eventSourceUserData) != UserInterferenceMonitor.injectedEventTag {
                    monitor.lock.withLock { monitor.interference = true }
                }
                return Unmanaged.passUnretained(event)
            },
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        ) else {
            ready.signal()
            return
        }
        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
            ready.signal()
            return
        }
        let loop = CFRunLoopGetCurrent()
        lock.withLock {
            self.tap = tap
            self.runLoop = loop
            self.running = true
        }
        CFRunLoopAddSource(loop, source, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        ready.signal()
        CFRunLoopRun()
        CFRunLoopRemoveSource(loop, source, .commonModes)
        lock.withLock {
            running = false
            self.tap = nil
            self.runLoop = nil
        }
    }
}
#else
final class UserInterferenceMonitor: @unchecked Sendable {
    static let injectedEventTag: Int64 = 0
    func start() throws {}
    func stop() {}
    func detected() -> Bool { false }
}
#endif
