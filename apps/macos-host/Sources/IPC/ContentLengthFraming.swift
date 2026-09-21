import Foundation

enum ContentLengthFramingError: Error, Equatable {
    case missingContentLength
    case invalidContentLength
    case messageTooLarge(Int)
}

struct ContentLengthFramer: Sendable {
    private(set) var buffer = Data()
    let maximumMessageBytes: Int

    init(maximumMessageBytes: Int = 1_048_576) {
        self.maximumMessageBytes = maximumMessageBytes
    }

    mutating func push(_ data: Data) throws -> [Data] {
        buffer.append(data)
        var output: [Data] = []
        let delimiter = Data("\r\n\r\n".utf8)
        while let headerRange = buffer.range(of: delimiter) {
            let headerData = buffer.subdata(in: buffer.startIndex..<headerRange.lowerBound)
            guard let header = String(data: headerData, encoding: .ascii) else { throw ContentLengthFramingError.invalidContentLength }
            var contentLength: Int?
            for line in header.components(separatedBy: "\r\n") {
                let parts = line.split(separator: ":", maxSplits: 1, omittingEmptySubsequences: false)
                if parts.count == 2 && parts[0].trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "content-length" {
                    contentLength = Int(parts[1].trimmingCharacters(in: .whitespacesAndNewlines))
                }
            }
            guard let length = contentLength, length >= 0 else { throw ContentLengthFramingError.missingContentLength }
            guard length <= maximumMessageBytes else { throw ContentLengthFramingError.messageTooLarge(length) }
            let bodyStart = headerRange.upperBound
            guard buffer.count >= bodyStart + length else { break }
            output.append(buffer.subdata(in: bodyStart..<(bodyStart + length)))
            buffer.removeSubrange(buffer.startIndex..<(bodyStart + length))
        }
        return output
    }

    static func encode(_ data: Data) -> Data {
        var frame = Data("Content-Length: \(data.count)\r\nContent-Type: application/json\r\n\r\n".utf8)
        frame.append(data)
        return frame
    }
}
