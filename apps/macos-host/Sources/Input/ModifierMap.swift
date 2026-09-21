import Foundation

#if os(macOS)
import CoreGraphics

struct ModifierDescriptor: Sendable, Equatable {
    let name: String
    let keyCode: CGKeyCode
    let flag: CGEventFlags
}

enum ModifierMap {
    private static let order = ["control", "option", "shift", "command", "fn"]

    static func descriptors(_ modifiers: [String]?) throws -> [ModifierDescriptor] {
        var selected: [String: ModifierDescriptor] = [:]
        for raw in modifiers ?? [] {
            let normalized: String
            switch raw.lowercased() {
            case "control", "ctrl": normalized = "control"
            case "meta", "alt", "option": normalized = "option"
            case "super", "command", "cmd": normalized = "command"
            case "shift": normalized = "shift"
            case "fn", "function": normalized = "fn"
            case "hyper": throw DesktopDriverError.invalidArgument("macOS has no canonical physical Hyper modifier. Bind Hyper in Emacs and use internal_keys, or provide an explicit physical key mapping.")
            default: throw DesktopDriverError.invalidArgument("Unknown modifier \(raw).")
            }
            switch normalized {
            case "control": selected[normalized] = ModifierDescriptor(name: normalized, keyCode: 59, flag: .maskControl)
            case "option": selected[normalized] = ModifierDescriptor(name: normalized, keyCode: 58, flag: .maskAlternate)
            case "shift": selected[normalized] = ModifierDescriptor(name: normalized, keyCode: 56, flag: .maskShift)
            case "command": selected[normalized] = ModifierDescriptor(name: normalized, keyCode: 55, flag: .maskCommand)
            case "fn": selected[normalized] = ModifierDescriptor(name: normalized, keyCode: 63, flag: .maskSecondaryFn)
            default: break
            }
        }
        return order.compactMap { selected[$0] }
    }

    static func flags(_ descriptors: [ModifierDescriptor]) -> CGEventFlags {
        descriptors.reduce(into: CGEventFlags()) { $0.formUnion($1.flag) }
    }
}
#endif
