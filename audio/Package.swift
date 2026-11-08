// swift-tools-version: 6.0
import Foundation
import PackageDescription

// Embed an Info.plist in the binary so macOS privacy prompts have usage strings
// even if TCC attributes a request to the sidecar rather than Earshot.app.
let infoPlist = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Info.plist").path

let package = Package(
    name: "earshot-audio",
    platforms: [.macOS("26.0")],
    targets: [
        .executableTarget(
            name: "earshot-audio",
            path: "Sources/earshot-audio",
            swiftSettings: [.swiftLanguageMode(.v5)],
            linkerSettings: [.unsafeFlags(["-Xlinker", "-sectcreate", "-Xlinker", "__TEXT", "-Xlinker", "__info_plist", "-Xlinker", infoPlist])]
        ),
    ]
)
