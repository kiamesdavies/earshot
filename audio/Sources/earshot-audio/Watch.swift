import CoreAudio
import Foundation

/// Call detection: polls Core Audio's process list for other apps that are
/// currently pulling from an input device. A meeting app grabbing the mic is
/// the most reliable cross-app signal that a call has started (it is what
/// Granola-style "start notes?" prompts key off).
enum Watch {
    struct MicUser: Hashable {
        let pid: pid_t
        let bundleID: String
    }

    static func micUsers() -> [MicUser] {
        let ownPID = getpid()
        let parentPID = getppid()
        let processes = CA.objectList(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyProcessObjectList)
        return processes.compactMap { process in
            guard let running: UInt32 = CA.value(process, kAudioProcessPropertyIsRunningInput, default: 0),
                  running != 0 else { return nil }
            let pid: pid_t = CA.value(process, kAudioProcessPropertyPID, default: -1) ?? -1
            if pid == ownPID || pid == parentPID { return nil }
            return MicUser(pid: pid, bundleID: CA.string(process, kAudioProcessPropertyBundleID) ?? "")
        }
    }

    static func run(interval: TimeInterval) -> Never {
        var previous = Set<MicUser>()
        Output.status("watching", ["interval": interval])
        while true {
            let current = Set(micUsers())
            if current != previous {
                let apps = current.sorted { $0.pid < $1.pid }.map { ["pid": Int($0.pid), "bundleId": $0.bundleID] as [String: Any] }
                Output.emit(["type": "mic_users", "apps": apps])
                previous = current
            }
            Thread.sleep(forTimeInterval: interval)
        }
    }
}
