import Foundation

#if os(macOS)
import CoreGraphics

final class CGEventInjector: @unchecked Sendable {
    private let source: CGEventSource?

    init() {
        source = CGEventSource(stateID: .hidSystemState)
    }

    func send(_ sequence: NativeSequence, monitor: UserInterferenceMonitor, cancellation: InputCancellationState) async throws -> Int {
        guard let source else { throw DesktopDriverError.nativeDriverUnavailable("Unable to create a CGEventSource.") }
        var sent = 0
        var pressedModifiers: [ModifierDescriptor] = []
        do {
            for logical in sequence.events {
                try checkAbort(monitor: monitor, cancellation: cancellation)
                let repeatCount = max(1, min(logical.repeatCount ?? 1, 100))
                for _ in 0..<repeatCount {
                    try checkAbort(monitor: monitor, cancellation: cancellation)
                    sent += try sendOne(logical, source: source, pressedModifiers: &pressedModifiers)
                }
                let delay = max(0, min(logical.delayAfterMilliseconds ?? 0, 10_000))
                if delay > 0 { try await Task.sleep(for: .milliseconds(delay)) }
            }
            return sent
        } catch {
            releaseModifiers(pressedModifiers, source: source)
            throw error
        }
    }

    private func sendOne(_ logical: NativeKeyEvent, source: CGEventSource, pressedModifiers: inout [ModifierDescriptor]) throws -> Int {
        switch logical.kind.lowercased() {
        case "text":
            guard let text = logical.text, !text.isEmpty else { return 0 }
            return try sendUnicode(text, source: source)
        case "key_press":
            let modifiers = try ModifierMap.descriptors(logical.modifiers)
            let flags = ModifierMap.flags(modifiers)
            var sent = 0
            for modifier in modifiers where !pressedModifiers.contains(modifier) {
                try postKey(modifier.keyCode, down: true, flags: flagsForPressed(pressedModifiers + [modifier]), source: source)
                pressedModifiers.append(modifier)
                sent += 1
            }
            let code = try VirtualKeyMap.resolve(key: logical.key, code: logical.code)
            try postKey(code, down: true, flags: flags, source: source); sent += 1
            try postKey(code, down: false, flags: flags, source: source); sent += 1
            for modifier in modifiers.reversed() {
                if let index = pressedModifiers.lastIndex(of: modifier) { pressedModifiers.remove(at: index) }
                try postKey(modifier.keyCode, down: false, flags: flagsForPressed(pressedModifiers), source: source)
                sent += 1
            }
            return sent
        case "key_down", "key_up":
            let modifiers = try ModifierMap.descriptors(logical.modifiers)
            let code = try VirtualKeyMap.resolve(key: logical.key, code: logical.code)
            try postKey(code, down: logical.kind.lowercased() == "key_down", flags: ModifierMap.flags(modifiers), source: source)
            return 1
        default:
            throw DesktopDriverError.invalidArgument("Unsupported native event kind \(logical.kind).")
        }
    }

    private func sendUnicode(_ text: String, source: CGEventSource) throws -> Int {
        let units = Array(text.utf16)
        guard !units.isEmpty else { return 0 }
        var sent = 0
        var offset = 0
        while offset < units.count {
            let end = min(units.count, offset + 32)
            let chunk = Array(units[offset..<end])
            guard let down = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: true),
                  let up = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: false) else {
                throw DesktopDriverError.nativeDriverUnavailable("Unable to create Unicode CGEvent.")
            }
            chunk.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
            tagAndPost(down)
            tagAndPost(up)
            sent += 2
            offset = end
        }
        return sent
    }

    private func postKey(_ keyCode: CGKeyCode, down: Bool, flags: CGEventFlags, source: CGEventSource) throws {
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down) else {
            throw DesktopDriverError.nativeDriverUnavailable("Unable to create keyboard CGEvent for key code \(keyCode).")
        }
        event.flags = flags
        tagAndPost(event)
    }

    private func tagAndPost(_ event: CGEvent) {
        event.setIntegerValueField(.eventSourceUserData, value: UserInterferenceMonitor.injectedEventTag)
        event.post(tap: .cghidEventTap)
    }

    private func flagsForPressed(_ modifiers: [ModifierDescriptor]) -> CGEventFlags { ModifierMap.flags(modifiers) }

    private func releaseModifiers(_ modifiers: [ModifierDescriptor], source: CGEventSource) {
        var remaining = modifiers
        for modifier in modifiers.reversed() {
            if let index = remaining.lastIndex(of: modifier) { remaining.remove(at: index) }
            try? postKey(modifier.keyCode, down: false, flags: ModifierMap.flags(remaining), source: source)
        }
    }

    private func checkAbort(monitor: UserInterferenceMonitor, cancellation: InputCancellationState) throws {
        if cancellation.isCancelled() { throw DesktopDriverError.nativeDriverUnavailable("Native input sequence was cancelled.") }
        if monitor.detected() { throw DesktopDriverError.userInterference }
    }
}
#endif
