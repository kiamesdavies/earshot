import AVFoundation
import Foundation

/// Energy VAD that cuts one speaker's audio into utterances and writes each as
/// a 16 kHz mono 16-bit WAV for the Rust side to transcribe with Whisper or
/// Parakeet. An adaptive noise floor keeps it working on speakerphones and AGC.
final class Chunker {
    static let rate = 16_000.0
    private let speaker: String
    private let dir: URL
    private let sessionStart: Date
    private let format16k = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Chunker.rate, channels: 1, interleaved: false)!
    private var converter: AVAudioConverter?

    private let frameSize = 480 // 30 ms
    private var pending: [Float] = []
    private var preroll: [Float] = []
    private var chunk: [Float] = []
    private var chunkStart = 0 // sample index of chunk[0]
    private var samplesSeen = 0 // samples consumed into frames
    private var offset: Double?
    private var noise: Float = 0.003
    private var voicedRun = 0
    private var silentRun = 0
    private var inSpeech = false
    private var index = 0

    private let startFrames = 3 // 90 ms of voice to open
    private let endFrames = 25 // 750 ms of silence to close
    private let prerollFrames = 10
    private let maxSeconds = 25.0
    private let minSeconds = 0.4

    init(speaker: String, dir: URL, sessionStart: Date) {
        self.speaker = speaker
        self.dir = dir.appendingPathComponent("chunks")
        self.sessionStart = sessionStart
        try? FileManager.default.createDirectory(at: self.dir, withIntermediateDirectories: true)
    }

    /// `mono` is the loudest channel at the source rate (from Channel).
    func feed(_ mono: AVAudioPCMBuffer) {
        if offset == nil { offset = Date().timeIntervalSince(sessionStart) }
        if converter == nil || converter!.inputFormat != mono.format {
            converter = AVAudioConverter(from: mono.format, to: format16k)
        }
        guard let converter else { return }
        let capacity = AVAudioFrameCount(Double(mono.frameLength) * Chunker.rate / mono.format.sampleRate) + 64
        guard let out = AVAudioPCMBuffer(pcmFormat: format16k, frameCapacity: capacity) else { return }
        var supplied = false
        converter.convert(to: out, error: nil) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true
            status.pointee = .haveData
            return mono
        }
        guard out.frameLength > 0, let data = out.floatChannelData else { return }
        pending.append(contentsOf: UnsafeBufferPointer(start: data[0], count: Int(out.frameLength)))
        while pending.count >= frameSize {
            let frame = Array(pending[0..<frameSize])
            pending.removeFirst(frameSize)
            process(frame)
        }
    }

    private func process(_ frame: [Float]) {
        let frameStart = samplesSeen
        samplesSeen += frame.count
        var sum: Float = 0
        for v in frame { sum += v * v }
        let rms = (sum / Float(frame.count)).squareRoot()
        let voiced = rms > max(noise * 3.5, 0.006)
        if !voiced { noise = noise * 0.97 + rms * 0.03 }

        if !inSpeech {
            preroll.append(contentsOf: frame)
            if preroll.count > prerollFrames * frameSize { preroll.removeFirst(preroll.count - prerollFrames * frameSize) }
            voicedRun = voiced ? voicedRun + 1 : 0
            if voicedRun >= startFrames {
                inSpeech = true
                silentRun = 0
                chunk = preroll
                chunkStart = frameStart + frame.count - preroll.count
                preroll.removeAll()
            }
            return
        }

        chunk.append(contentsOf: frame)
        silentRun = voiced ? 0 : silentRun + 1
        if silentRun >= endFrames {
            // Keep ~200 ms of the trailing silence.
            let keep = chunk.count - (endFrames - 7) * frameSize
            emit(Array(chunk[0..<max(0, keep)]))
            reset()
        } else if Double(chunk.count) / Chunker.rate >= maxSeconds {
            emit(chunk)
            chunkStart += chunk.count
            chunk.removeAll()
            silentRun = 0
        }
    }

    private func reset() {
        inSpeech = false
        chunk.removeAll()
        voicedRun = 0
        silentRun = 0
    }

    func flush() {
        if inSpeech { emit(chunk) }
        reset()
    }

    private func emit(_ samples: [Float]) {
        let seconds = Double(samples.count) / Chunker.rate
        guard seconds >= minSeconds else { return }
        let id = "\(speaker)-c\(index)"
        index += 1
        let url = dir.appendingPathComponent("\(id).wav")
        do {
            try Chunker.writeWav(samples, to: url)
        } catch {
            Output.error("Could not write audio chunk: \(error.localizedDescription)")
            return
        }
        let start = (offset ?? 0) + Double(chunkStart) / Chunker.rate
        Output.emit(["type": "chunk", "speaker": speaker, "id": id, "start": start, "end": start + seconds, "path": url.path])
    }

    static func writeWav(_ samples: [Float], to url: URL) throws {
        var data = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        data.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes)
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1); u32(16_000); u32(32_000); u16(2); u16(16)
        data.append(contentsOf: Array("data".utf8)); u32(bytes)
        data.reserveCapacity(data.count + samples.count * 2)
        for s in samples {
            let v = Int16(max(-1, min(1, s)) * 32767)
            withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) }
        }
        try data.write(to: url)
    }
}
