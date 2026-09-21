import Foundation

actor DesktopInputLease {
    private var holder: UUID?

    func acquire() throws -> UUID {
        guard holder == nil else {
            throw DesktopDriverError.nativeDriverUnavailable("Another native desktop input sequence is already active.")
        }
        let token = UUID()
        holder = token
        return token
    }

    func release(_ token: UUID) {
        if holder == token { holder = nil }
    }
}

final class InputCancellationState: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    func reset() { lock.withLock { value = false } }
    func cancel() { lock.withLock { value = true } }
    func isCancelled() -> Bool { lock.withLock { value } }
}
