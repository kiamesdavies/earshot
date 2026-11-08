import CoreAudio
import Foundation

/// Thin wrappers over the AudioObject property API.
enum CA {
    static func address(_ selector: AudioObjectPropertySelector,
                        scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal) -> AudioObjectPropertyAddress {
        AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: kAudioObjectPropertyElementMain)
    }

    static func value<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, default initial: T) -> T? {
        var addr = address(selector)
        var size = UInt32(MemoryLayout<T>.size)
        var value = initial
        let status = withUnsafeMutablePointer(to: &value) {
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0)
        }
        return status == noErr ? value : nil
    }

    static func objectList(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> [AudioObjectID] {
        var addr = address(selector)
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(object, &addr, 0, nil, &size) == noErr, size > 0 else { return [] }
        var list = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        guard AudioObjectGetPropertyData(object, &addr, 0, nil, &size, &list) == noErr else { return [] }
        return list
    }

    static func string(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) -> String? {
        var addr = address(selector)
        var ref: Unmanaged<CFString>?
        var size = UInt32(MemoryLayout<Unmanaged<CFString>?>.size)
        let status = withUnsafeMutablePointer(to: &ref) {
            AudioObjectGetPropertyData(object, &addr, 0, nil, &size, $0)
        }
        guard status == noErr, let ref else { return nil }
        return ref.takeRetainedValue() as String
    }

    static func defaultOutputDeviceUID() -> String? {
        guard let device: AudioDeviceID = value(AudioObjectID(kAudioObjectSystemObject),
                                                kAudioHardwarePropertyDefaultSystemOutputDevice,
                                                default: 0), device != 0 else { return nil }
        return string(device, kAudioDevicePropertyDeviceUID)
    }
}

extension OSStatus {
    var fourCC: String {
        let n = UInt32(bitPattern: self)
        let chars = [24, 16, 8, 0].map { Character(UnicodeScalar(UInt8((n >> $0) & 0xFF))) }
        return chars.allSatisfy { $0.isASCII && !$0.isWhitespace || $0 == " " } ? "'\(String(chars))' (\(self))" : "\(self)"
    }
}
