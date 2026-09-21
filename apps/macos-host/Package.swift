// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "EmacsOperatorHost",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "EmacsOperatorHost", targets: ["EmacsOperatorHost"])],
    targets: [
        .executableTarget(name: "EmacsOperatorHost", path: "Sources"),
        .testTarget(name: "EmacsOperatorHostTests", dependencies: ["EmacsOperatorHost"], path: "Tests")
    ]
)
