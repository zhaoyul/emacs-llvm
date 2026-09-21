import Foundation

#if os(macOS)
import CoreGraphics

enum VirtualKeyMap {
    private static let keys: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
        "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
        "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
        "return": 36, "enter": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
        ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
        "delete": 51, "backspace": 51, "escape": 53, "esc": 53,
        "command": 55, "cmd": 55, "shift": 56, "caps_lock": 57, "option": 58, "alt": 58, "control": 59, "ctrl": 59,
        "right_shift": 60, "right_option": 61, "right_control": 62, "fn": 63,
        "f17": 64, "keypad_decimal": 65, "keypad_multiply": 67, "keypad_plus": 69, "keypad_clear": 71,
        "volume_up": 72, "volume_down": 73, "mute": 74, "keypad_divide": 75, "keypad_enter": 76, "keypad_minus": 78,
        "f18": 79, "f19": 80, "keypad_equal": 81, "keypad_0": 82, "keypad_1": 83, "keypad_2": 84,
        "keypad_3": 85, "keypad_4": 86, "keypad_5": 87, "keypad_6": 88, "keypad_7": 89, "f20": 90,
        "keypad_8": 91, "keypad_9": 92,
        "f5": 96, "f6": 97, "f7": 98, "f3": 99, "f8": 100, "f9": 101, "f11": 103, "f13": 105,
        "f16": 106, "f14": 107, "f10": 109, "f12": 111, "f15": 113,
        "help": 114, "home": 115, "page_up": 116, "forward_delete": 117, "f4": 118, "end": 119,
        "f2": 120, "page_down": 121, "f1": 122, "left": 123, "arrow_left": 123, "right": 124, "arrow_right": 124,
        "down": 125, "arrow_down": 125, "up": 126, "arrow_up": 126
    ]

    private static let codeAliases: [String: String] = [
        "Enter": "return", "Escape": "escape", "Tab": "tab", "Space": "space", "Backspace": "delete", "Delete": "forward_delete",
        "ArrowLeft": "left", "ArrowRight": "right", "ArrowUp": "up", "ArrowDown": "down",
        "Home": "home", "End": "end", "PageUp": "page_up", "PageDown": "page_down",
        "Minus": "-", "Equal": "=", "BracketLeft": "[", "BracketRight": "]", "Backslash": "\\",
        "Semicolon": ";", "Quote": "'", "Backquote": "`", "Comma": ",", "Period": ".", "Slash": "/"
    ]

    static func resolve(key: String?, code: String?) throws -> CGKeyCode {
        if let code, !code.isEmpty {
            if code.hasPrefix("0x"), let value = UInt16(code.dropFirst(2), radix: 16) { return CGKeyCode(value) }
            if code.hasPrefix("Key"), code.count == 4, let char = code.last { return try resolve(key: String(char), code: nil) }
            if code.hasPrefix("Digit"), code.count == 6, let char = code.last { return try resolve(key: String(char), code: nil) }
            if code.hasPrefix("F"), Int(code.dropFirst()) != nil { return try resolve(key: code.lowercased(), code: nil) }
            if let alias = codeAliases[code] { return try resolve(key: alias, code: nil) }
        }
        if let key {
            let normalized = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased().replacingOccurrences(of: "-", with: "_")
            if let value = keys[normalized] { return value }
            if normalized.count == 1, let value = keys[normalized] { return value }
        }
        throw DesktopDriverError.invalidArgument("Unknown macOS virtual key: key=\(key ?? "nil") code=\(code ?? "nil").")
    }
}
#endif
