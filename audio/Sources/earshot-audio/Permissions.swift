import AVFoundation
import Foundation

/// Microphone uses the public AVCaptureDevice API. System audio capture
/// (kTCCServiceAudioCapture) has no public request API, and creating a process
/// tap does NOT prompt — it silently delivers nothing. So we ask TCC directly,
/// the same way Apple's AudioCap sample does.
enum Permissions {
    enum State: String {
        case granted, denied, notDetermined = "not_determined", unknown
    }

    private typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int
    private typealias Request = @convention(c) (CFString, CFDictionary?, @escaping @convention(block) (Bool) -> Void) -> Void
    private static let service = "kTCCServiceAudioCapture" as CFString
    private static let tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW)

    static func microphone() -> State {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .authorized: return .granted
        case .notDetermined: return .notDetermined
        default: return .denied
        }
    }

    static func requestMicrophone() async -> State {
        if microphone() == .notDetermined { _ = await AVCaptureDevice.requestAccess(for: .audio) }
        return microphone()
    }

    static func systemAudio() -> State {
        guard let tcc, let symbol = dlsym(tcc, "TCCAccessPreflight") else { return .unknown }
        switch unsafeBitCast(symbol, to: Preflight.self)(service, nil) {
        case 0: return .granted
        case 1: return .denied
        default: return .notDetermined
        }
    }

    static func requestSystemAudio() async -> State {
        guard systemAudio() == .notDetermined, let tcc, let symbol = dlsym(tcc, "TCCAccessRequest") else { return systemAudio() }
        let request = unsafeBitCast(symbol, to: Request.self)
        let _: Bool = await withCheckedContinuation { continuation in
            request(service, nil) { granted in continuation.resume(returning: granted) }
        }
        return systemAudio()
    }

    static func report() -> [String: Any] {
        ["type": "permissions", "microphone": microphone().rawValue, "systemAudio": systemAudio().rawValue]
    }
}
