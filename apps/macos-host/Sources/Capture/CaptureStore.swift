import Foundation

struct CaptureStore: Sendable {
    let directory: URL

    static func create(environment: [String: String] = ProcessInfo.processInfo.environment) throws -> CaptureStore {
        let directory: URL
        if let explicit = environment["EMACS_OPERATOR_CAPTURE_DIR"], !explicit.isEmpty {
            directory = URL(fileURLWithPath: explicit, isDirectory: true)
        } else {
            #if os(Windows)
            directory = FileManager.default.temporaryDirectory.appendingPathComponent("EmacsOperator-Captures", isDirectory: true)
            #else
            directory = FileManager.default.temporaryDirectory.appendingPathComponent("emacs-operator-captures-\(getuid())", isDirectory: true)
            #endif
        }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: directory.path)
        return CaptureStore(directory: directory)
    }

    func nextPNGURL() -> URL {
        directory.appendingPathComponent("capture-\(UUID().uuidString).png")
    }

    func secure(_ url: URL) {
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    func cleanup(olderThan seconds: TimeInterval = 600, now: Date = Date()) {
        guard let files = try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.contentModificationDateKey, .isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        for url in files where url.pathExtension.lowercased() == "png" {
            guard let values = try? url.resourceValues(forKeys: [.contentModificationDateKey, .isRegularFileKey]),
                  values.isRegularFile == true,
                  let modified = values.contentModificationDate,
                  now.timeIntervalSince(modified) > seconds else { continue }
            try? FileManager.default.removeItem(at: url)
        }
    }
}
