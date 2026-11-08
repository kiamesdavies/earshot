import AVFoundation
import CoreAudio
import Foundation

/// Captures everything the Mac is playing (the other side of the call) with a
/// Core Audio process tap. No virtual audio driver needed; requires macOS 14.4+
/// and the "System Audio Recording" permission (NSAudioCaptureUsageDescription).
final class SystemTap {
    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private let queue = DispatchQueue(label: "earshot.systemtap", qos: .userInitiated)
    private(set) var callbacks = 0
    private(set) var emptyCallbacks = 0

    func start(onBuffer: @escaping (AVAudioPCMBuffer) -> Void) throws {
        let description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        description.uuid = UUID()
        description.name = "Earshot"
        description.muteBehavior = .unmuted
        description.isPrivate = true

        Output.debug("system tap: permission=\(Permissions.systemAudio().rawValue)")
        var status = AudioHardwareCreateProcessTap(description, &tapID)
        Output.debug("system tap: AudioHardwareCreateProcessTap -> \(status.fourCC), tapID=\(tapID)")
        guard status == noErr else { throw tapError("create process tap", status) }

        guard let outputUID = CA.defaultOutputDeviceUID() else {
            throw NSError(domain: "earshot", code: 3, userInfo: [NSLocalizedDescriptionKey: "No default output device"])
        }
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "Earshot Tap",
            kAudioAggregateDeviceUIDKey: "app.earshot.tap.\(UUID().uuidString)",
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapDriftCompensationKey: true,
                kAudioSubTapUIDKey: description.uuid.uuidString,
            ]],
        ]
        Output.debug("system tap: default output device uid=\(outputUID)")
        status = AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &aggregateID)
        Output.debug("system tap: AudioHardwareCreateAggregateDevice -> \(status.fourCC), aggregateID=\(aggregateID)")
        guard status == noErr else { throw tapError("create aggregate device", status) }

        guard var streamDescription: AudioStreamBasicDescription =
                CA.value(tapID, kAudioTapPropertyFormat, default: AudioStreamBasicDescription()),
              let format = AVAudioFormat(streamDescription: &streamDescription) else {
            throw NSError(domain: "earshot", code: 4, userInfo: [NSLocalizedDescriptionKey: "Could not read tap format"])
        }

        Output.debug("system tap: format sampleRate=\(format.sampleRate) channels=\(format.channelCount) interleaved=\(format.isInterleaved) common=\(format.commonFormat.rawValue)")
        status = AudioDeviceCreateIOProcIDWithBlock(&procID, aggregateID, queue) { [weak self] _, inputData, _, _, _ in
            guard let self else { return }
            self.callbacks += 1
            let buffers = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inputData))
            if self.callbacks == 1 {
                let shape = buffers.map { "\($0.mNumberChannels)ch/\($0.mDataByteSize)B" }.joined(separator: ", ")
                Output.debug("system tap: first callback has \(buffers.count) buffer(s): \(shape)")
            }
            guard let buffer = SystemTap.tapBuffer(buffers, format: format) else {
                self.emptyCallbacks += 1
                return
            }
            onBuffer(buffer)
        }
        Output.debug("system tap: AudioDeviceCreateIOProcIDWithBlock -> \(status.fourCC)")
        guard status == noErr else { throw tapError("create IO proc", status) }
        status = AudioDeviceStart(aggregateID, procID)
        Output.debug("system tap: AudioDeviceStart -> \(status.fourCC)")
        guard status == noErr else { throw tapError("start aggregate device", status) }
    }

    /// The aggregate's input is [sub-device inputs…, tap]. On a device that is
    /// both speaker and mic (a speakerphone, a headset) the mic's buffers come
    /// first, so take the last buffer — the tap — and copy it out.
    static func tapBuffer(_ buffers: UnsafeMutableAudioBufferListPointer, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let tap = buffers.last, let data = tap.mData, tap.mDataByteSize > 0 else { return nil }
        let bytesPerFrame = Int(format.streamDescription.pointee.mBytesPerFrame)
        guard bytesPerFrame > 0, Int(tap.mNumberChannels) == Int(format.channelCount) || !format.isInterleaved else { return nil }
        let frames = Int(tap.mDataByteSize) / bytesPerFrame
        guard frames > 0, let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)) else { return nil }
        out.frameLength = AVAudioFrameCount(frames)
        let dst = UnsafeMutableAudioBufferListPointer(out.mutableAudioBufferList)
        if format.isInterleaved || buffers.count == 1 {
            memcpy(dst[0].mData, data, Int(tap.mDataByteSize))
        } else {
            // Non-interleaved tap: one buffer per channel at the end of the list.
            let channels = Int(format.channelCount)
            for c in 0..<channels {
                let srcBuffer = buffers[buffers.count - channels + c]
                memcpy(dst[c].mData, srcBuffer.mData, Int(min(srcBuffer.mDataByteSize, dst[c].mDataByteSize)))
            }
        }
        return out
    }

    func stop() {
        if aggregateID != kAudioObjectUnknown {
            AudioDeviceStop(aggregateID, procID)
            if let procID { AudioDeviceDestroyIOProcID(aggregateID, procID) }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    private func tapError(_ step: String, _ status: OSStatus) -> NSError {
        NSError(domain: "earshot", code: Int(status),
                userInfo: [NSLocalizedDescriptionKey: "System audio: failed to \(step) (\(status.fourCC)). Check System Settings → Privacy & Security → Screen & System Audio Recording."])
    }
}
