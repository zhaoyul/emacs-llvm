import Foundation

#if os(macOS)
import Network

private actor DriverAuthorizationState {
    private var authorized = false

    func authorize() { authorized = true }
    func isAuthorized() -> Bool { authorized }
}

/// Per-connection mutable framing state. Network.framework receive callbacks are
/// @Sendable in Swift 6, so keeping the framer behind a lock avoids capturing and
/// mutating a local value across concurrency domains.
private final class DriverConnectionContext: @unchecked Sendable {
    let connection: NWConnection
    let authorization = DriverAuthorizationState()
    private var framer = ContentLengthFramer()
    private let lock = NSLock()

    init(connection: NWConnection) {
        self.connection = connection
    }

    func push(_ data: Data) throws -> [Data] {
        lock.lock()
        defer { lock.unlock() }
        return try framer.push(data)
    }
}

final class DriverIPCServer: @unchecked Sendable {
    private let driver: any DesktopDriver
    private let queue = DispatchQueue(label: "com.emacsoperator.driver.ipc")
    private var listener: NWListener?
    private var runtime: DriverRuntime?
    private var heartbeat: DispatchSourceTimer?
    private let startedAt = ISO8601DateFormatter().string(from: Date())

    init(driver: any DesktopDriver) { self.driver = driver }

    func start() throws {
        let runtime = try DriverRuntime.create()
        self.runtime = runtime

        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
        let listener = try NWListener(using: parameters)
        self.listener = listener

        listener.stateUpdateHandler = { [weak self, weak listener] state in
            guard let self, let listener else { return }
            switch state {
            case .ready:
                guard let port = listener.port?.rawValue else { return }
                do {
                    try runtime.writeRecord(port: port, startedAt: self.startedAt)
                    self.startHeartbeat(port: port)
                } catch {
                    self.stop()
                }
            case .failed:
                self.stop()
            default:
                break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener.start(queue: queue)
    }

    func stop() {
        heartbeat?.cancel()
        heartbeat = nil
        listener?.cancel()
        listener = nil
        runtime?.cleanup()
        runtime = nil
        Task { [driver] in await driver.cancelAll() }
    }

    private func startHeartbeat(port: UInt16) {
        heartbeat?.cancel()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 5, repeating: 5)
        timer.setEventHandler { [weak self] in
            guard let self, let runtime = self.runtime else { return }
            try? runtime.writeRecord(port: port, startedAt: self.startedAt)
        }
        heartbeat = timer
        timer.resume()
    }

    private func accept(_ connection: NWConnection) {
        let context = DriverConnectionContext(connection: connection)
        connection.start(queue: queue)
        receiveNext(context: context)
    }

    private func receiveNext(context: DriverConnectionContext) {
        context.connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) { [weak self] data, _, complete, error in
            guard let self else {
                context.connection.cancel()
                return
            }

            if let data, !data.isEmpty {
                do {
                    for body in try context.push(data) {
                        self.handle(body, context: context)
                    }
                } catch {
                    context.connection.cancel()
                    return
                }
            }

            if complete || error != nil {
                context.connection.cancel()
                return
            }
            self.receiveNext(context: context)
        }
    }

    /// Keep JSONSerialization values inside the Task. `Any` and `[String: Any]`
    /// are intentionally not captured across the Swift-concurrency boundary.
    private func handle(_ body: Data, context: DriverConnectionContext) {
        Task { [weak self] in
            guard let self else { return }

            var responseID: Any = NSNull()
            do {
                guard let request = try JSONSerialization.jsonObject(with: body) as? [String: Any],
                      let method = request["method"] as? String else {
                    throw DesktopDriverError.invalidArgument("Malformed driver RPC request.")
                }

                responseID = request["id"] ?? NSNull()
                let params = request["params"] as? [String: Any] ?? [:]
                let result: Any

                if method == "driver.initialize" {
                    guard let token = params["token"] as? String, token == self.runtime?.token else {
                        throw DesktopDriverError.invalidArgument("Driver token is invalid.")
                    }
                    await context.authorization.authorize()
                    result = try DriverRPC.jsonObject(try await self.driver.capabilities())
                } else {
                    guard await context.authorization.isAuthorized() else {
                        throw DesktopDriverError.invalidArgument("Driver connection is not initialized.")
                    }
                    result = try await self.dispatch(method: method, params: params)
                }

                self.send(try DriverRPC.success(id: responseID, result: result), context: context)
            } catch let error as DesktopDriverError {
                self.send(
                    (try? DriverRPC.failure(id: responseID, code: error.stableCode, message: error.description)) ?? Data(),
                    context: context
                )
            } catch {
                self.send(
                    (try? DriverRPC.failure(id: responseID, code: "E_INTERNAL", message: error.localizedDescription)) ?? Data(),
                    context: context
                )
            }
        }
    }

    private func dispatch(method: String, params: [String: Any]) async throws -> Any {
        switch method {
        case "driver.capabilities":
            return try DriverRPC.jsonObject(try await driver.capabilities())
        case "driver.permissions":
            return try DriverRPC.jsonObject(await driver.permissions())
        case "driver.frontmost":
            return try DriverRPC.jsonObject(try await driver.frontmostApplication())
        case "driver.focus":
            guard let targetJSON = params["target"], JSONSerialization.isValidJSONObject(targetJSON) else {
                throw DesktopDriverError.invalidArgument("driver.focus requires target.")
            }
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let targetData = try JSONSerialization.data(withJSONObject: targetJSON)
            let target = try decoder.decode(NativeTarget.self, from: targetData)
            let options: FocusOptions
            if let optionsJSON = params["options"], JSONSerialization.isValidJSONObject(optionsJSON) {
                options = try decoder.decode(FocusOptions.self, from: JSONSerialization.data(withJSONObject: optionsJSON))
            } else {
                options = FocusOptions()
            }
            return try DriverRPC.jsonObject(try await driver.focusEmacs(target, options: options))
        case "driver.cancel_all":
            await driver.cancelAll()
            return ["cancelled": true]
        case "driver.restore_application":
            guard let applicationJSON = params["application"], JSONSerialization.isValidJSONObject(applicationJSON) else {
                throw DesktopDriverError.invalidArgument("driver.restore_application requires application.")
            }
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let application = try decoder.decode(ApplicationInfo.self, from: JSONSerialization.data(withJSONObject: applicationJSON))
            return ["restored": await driver.restoreApplication(application)]
        case "driver.key_sequence":
            guard let targetJSON = params["target"], JSONSerialization.isValidJSONObject(targetJSON),
                  let sequenceJSON = params["sequence"], JSONSerialization.isValidJSONObject(sequenceJSON) else {
                throw DesktopDriverError.invalidArgument("driver.key_sequence requires target and sequence.")
            }
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let target = try decoder.decode(NativeTarget.self, from: JSONSerialization.data(withJSONObject: targetJSON))
            let sequence = try decoder.decode(NativeSequence.self, from: JSONSerialization.data(withJSONObject: sequenceJSON))
            let options: FocusOptions
            if let optionsJSON = params["focus_options"], JSONSerialization.isValidJSONObject(optionsJSON) {
                options = try decoder.decode(FocusOptions.self, from: JSONSerialization.data(withJSONObject: optionsJSON))
            } else {
                options = FocusOptions()
            }
            return try DriverRPC.jsonObject(try await driver.sendKeySequence(sequence, target: target, focusOptions: options))
        case "driver.capture":
            guard let targetJSON = params["target"], JSONSerialization.isValidJSONObject(targetJSON) else {
                throw DesktopDriverError.invalidArgument("driver.capture requires target.")
            }
            let decoder = JSONDecoder()
            decoder.keyDecodingStrategy = .convertFromSnakeCase
            let target = try decoder.decode(NativeTarget.self, from: JSONSerialization.data(withJSONObject: targetJSON))
            let options: CaptureOptions
            if let optionsJSON = params["options"], JSONSerialization.isValidJSONObject(optionsJSON) {
                options = try decoder.decode(CaptureOptions.self, from: JSONSerialization.data(withJSONObject: optionsJSON))
            } else {
                options = CaptureOptions(maxWidth: nil, includeCursor: false)
            }
            return try DriverRPC.jsonObject(try await driver.captureEmacs(target, options: options))
        default:
            throw DesktopDriverError.invalidArgument("Unknown driver method \(method).")
        }
    }

    private func send(_ body: Data, context: DriverConnectionContext) {
        guard !body.isEmpty else { return }
        context.connection.send(content: ContentLengthFramer.encode(body), completion: .contentProcessed { _ in })
    }
}
#endif
