import Foundation
import os

/// Every message the sidecar sends is one JSON object per line on stdout.
/// The Tauri core parses these and forwards them to the UI. Everything except
/// high-rate levels/previews is also written to the macOS unified log:
///   log show --last 1h --info --predicate 'subsystem == "app.earshot.desktop"'
enum Output {
    private static let lock = NSLock()
    static let log = Logger(subsystem: "app.earshot.desktop", category: "audio")
    private static let quiet: Set<String> = ["level", "preview", "segment"]  // no call content in the system log

    static func emit(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return }
        let type = object["type"] as? String ?? ""
        if !quiet.contains(type), let line = String(data: data, encoding: .utf8) {
            if type == "error" { log.error("\(line, privacy: .public)") } else { log.notice("\(line, privacy: .public)") }
        }
        lock.lock()
        defer { lock.unlock() }
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }

    /// Diagnostics that only go to the unified log (and stderr, which the app saves to its log file).
    static func debug(_ message: String) {
        log.notice("\(message, privacy: .public)")
        FileHandle.standardError.write(Data("[audio] \(message)\n".utf8))
    }

    static func status(_ message: String, _ extra: [String: Any] = [:]) {
        emit(extra.merging(["type": "status", "message": message]) { a, _ in a })
    }

    static func error(_ message: String, fatal: Bool = false) {
        emit(["type": "error", "message": message, "fatal": fatal])
    }

    static func fail(_ message: String) -> Never {
        error(message, fatal: true)
        exit(1)
    }
}
