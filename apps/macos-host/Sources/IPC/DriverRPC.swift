import Foundation

struct DriverRPCErrorPayload: Codable, Sendable, Equatable {
    let code: String
    let message: String
}

enum DriverRPC {
    static func success(id: Any, result: Any) throws -> Data {
        try JSONSerialization.data(withJSONObject: ["jsonrpc": "2.0", "id": id, "result": result], options: [])
    }

    static func failure(id: Any, code: String, message: String) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "jsonrpc": "2.0",
            "id": id,
            "error": ["code": -32000, "message": message, "data": ["code": code]]
        ], options: [])
    }

    static func jsonObject<T: Encodable>(_ value: T) throws -> Any {
        let encoder = JSONEncoder()
        encoder.keyEncodingStrategy = .convertToSnakeCase
        let data = try encoder.encode(value)
        return try JSONSerialization.jsonObject(with: data)
    }
}
