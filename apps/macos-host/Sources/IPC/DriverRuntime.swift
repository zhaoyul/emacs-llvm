import Foundation

#if os(macOS)
import Darwin
import Security
#else
import Glibc
#endif

struct DriverInstanceRecord: Codable, Sendable, Equatable {
    let protocolVersion: String
    let pid: Int32
    let host: String
    let port: UInt16
    let tokenFile: String
    let startedAt: String
    let heartbeatAt: String
}

struct DriverRuntime: Sendable {
    let directory: URL
    let tokenURL: URL
    let recordURL: URL
    let token: String

    static func create(environment: [String: String] = ProcessInfo.processInfo.environment) throws -> DriverRuntime {
        let directory: URL
        if let explicit = environment["EMACS_OPERATOR_DRIVER_RUNTIME_DIR"], !explicit.isEmpty {
            directory = URL(fileURLWithPath: explicit, isDirectory: true)
        } else {
            directory = FileManager.default.temporaryDirectory.appendingPathComponent("emacs-operator-driver-\(getuid())", isDirectory: true)
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        let tokenURL = directory.appendingPathComponent("token")
        let recordURL = directory.appendingPathComponent("driver.json")
        let token = try secureToken()
        try (token + "\n").write(to: tokenURL, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: tokenURL.path)
        return DriverRuntime(directory: directory, tokenURL: tokenURL, recordURL: recordURL, token: token)
    }

    func writeRecord(port: UInt16, startedAt: String) throws {
        let now = ISO8601DateFormatter().string(from: Date())
        let record = DriverInstanceRecord(
            protocolVersion: "1.0",
            pid: Int32(ProcessInfo.processInfo.processIdentifier),
            host: "127.0.0.1",
            port: port,
            tokenFile: tokenURL.path,
            startedAt: startedAt,
            heartbeatAt: now
        )
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        let data = try encoder.encode(record)
        let temporary = directory.appendingPathComponent(".driver-\(UUID().uuidString).json")
        try data.write(to: temporary, options: .atomic)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: temporary.path)
        _ = try? FileManager.default.replaceItemAt(recordURL, withItemAt: temporary)
        if !FileManager.default.fileExists(atPath: recordURL.path) {
            try FileManager.default.moveItem(at: temporary, to: recordURL)
        }
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: recordURL.path)
    }

    func cleanup() {
        try? FileManager.default.removeItem(at: recordURL)
        try? FileManager.default.removeItem(at: tokenURL)
    }

    private static func secureToken() throws -> String {
        #if os(macOS)
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw DesktopDriverError.nativeDriverUnavailable("Unable to generate secure host token.")
        }
        return bytes.map { String(format: "%02x", $0) }.joined()
        #else
        return UUID().uuidString.replacingOccurrences(of: "-", with: "") + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        #endif
    }
}
