import Foundation
import Testing
@testable import EmacsOperatorHost

@Test func unavailableDriverReportsNoNativeCapabilities() async throws {
    let driver = UnavailableDesktopDriver()
    let capabilities = try await driver.capabilities()
    #expect(capabilities.nativeKeyboard == false)
    #expect(capabilities.windowFocus == false)
    #expect(capabilities.windowCapture == false)
    #expect(capabilities.frontmostQuery == false)
}

@Test func contentLengthFramerHandlesSplitUnicodeAndMultipleFrames() throws {
    let first = Data("{\"text\":\"你好 Emacs\"}".utf8)
    let second = Data("{\"n\":2}".utf8)
    let combined = ContentLengthFramer.encode(first) + ContentLengthFramer.encode(second)
    var framer = ContentLengthFramer()
    let pivot = max(1, combined.count / 3)
    #expect(try framer.push(combined.subdata(in: 0..<pivot)).isEmpty)
    let messages = try framer.push(combined.subdata(in: pivot..<combined.count))
    #expect(messages == [first, second])
}

@Test func contentLengthFramerRejectsOversizedBody() throws {
    var framer = ContentLengthFramer(maximumMessageBytes: 4)
    let message = Data("12345".utf8)
    #expect(throws: ContentLengthFramingError.messageTooLarge(5)) {
        try framer.push(ContentLengthFramer.encode(message))
    }
}

@Test func driverRuntimeWritesSnakeCaseRecordAndSecureToken() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("emacs-operator-swift-test-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let runtime = try DriverRuntime.create(environment: ["EMACS_OPERATOR_DRIVER_RUNTIME_DIR": root.path])
    defer { runtime.cleanup() }
    try runtime.writeRecord(port: 45678, startedAt: "2026-08-31T00:00:00Z")

    let raw = try JSONSerialization.jsonObject(with: Data(contentsOf: runtime.recordURL)) as? [String: Any]
    #expect(raw?["protocol_version"] as? String == "1.0")
    #expect(raw?["token_file"] as? String == runtime.tokenURL.path)
    #expect(raw?["heartbeat_at"] is String)
    #expect(raw?["protocolVersion"] == nil)

    let token = try String(contentsOf: runtime.tokenURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
    #expect(token.count == 64)
    #expect(token.allSatisfy { $0.isHexDigit })
}

@Test func captureStoreUsesPrivateDirectoryAndCleansStalePngs() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent("emacs-operator-capture-test-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let store = try CaptureStore.create(environment: ["EMACS_OPERATOR_CAPTURE_DIR": root.path])
    let stale = store.nextPNGURL()
    try Data("png".utf8).write(to: stale)
    try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1)], ofItemAtPath: stale.path)
    store.cleanup(olderThan: 10, now: Date(timeIntervalSince1970: 100))
    #expect(FileManager.default.fileExists(atPath: stale.path) == false)
}
