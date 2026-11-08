import AVFoundation
import CoreMedia
import Foundation
import Speech

/// One speaker channel ("me" = microphone, "them" = system audio). Converts
/// whatever the source delivers into the analyzer's format, writes it to a WAV
/// for later replay, and streams it through an on-device SpeechTranscriber.
final class Channel: @unchecked Sendable {
    /// When set (`--chunks`), utterances are cut into WAVs here for Whisper/Parakeet
    /// and Apple's own results are only emitted as live previews.
    nonisolated(unsafe) static var chunkDir: URL?
    let speaker: String
    private var chunker: Chunker?
    let format: AVAudioFormat
    private let transcriber: SpeechTranscriber
    private let analyzer: SpeechAnalyzer
    private let stream: AsyncStream<AnalyzerInput>
    private let continuation: AsyncStream<AnalyzerInput>.Continuation
    private var converter: AVAudioConverter?
    private var file: AVAudioFile?
    private var resultsTask: Task<Void, Never>?
    private let sessionStart: Date
    private var offset: Double?
    private let levelLock = NSLock()
    private var peak: Float = 0
    private(set) var buffersReceived = 0
    private(set) var heardSignal = false

    static func makeTranscriber(locale: Locale, volatile: Bool) -> SpeechTranscriber {
        SpeechTranscriber(locale: locale,
                          transcriptionOptions: [],
                          reportingOptions: volatile ? [.volatileResults] : [],
                          attributeOptions: [.audioTimeRange])
    }

    static func ensureAssets(locale: Locale) async throws -> Locale {
        guard let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            throw NSError(domain: "earshot", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Speech model does not support \(locale.identifier)"])
        }
        let probe = makeTranscriber(locale: supported, volatile: false)
        if await AssetInventory.status(forModules: [probe]) == .installed { return supported }
        if let request = try await AssetInventory.assetInstallationRequest(supporting: [probe]) {
            Output.status("downloading speech model", ["locale": supported.identifier])
            try await request.downloadAndInstall()
            Output.status("speech model installed", ["locale": supported.identifier])
        }
        return supported
    }

    init(speaker: String, locale: Locale, wavURL: URL?, sessionStart: Date) async throws {
        self.speaker = speaker
        self.sessionStart = sessionStart
        if let dir = Channel.chunkDir { chunker = Chunker(speaker: speaker, dir: dir, sessionStart: sessionStart) }
        transcriber = Channel.makeTranscriber(locale: locale, volatile: true)
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw NSError(domain: "earshot", code: 2, userInfo: [NSLocalizedDescriptionKey: "No analyzer audio format"])
        }
        self.format = format
        analyzer = SpeechAnalyzer(modules: [transcriber],
                                  options: .init(priority: .userInitiated, modelRetention: .processLifetime))
        (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .unbounded)
        if let wavURL {
            // AAC at 32 kbps mono: ~14 MB per hour instead of ~115 MB for 16-bit WAV.
            let aac: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: format.sampleRate,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 32_000,
            ]
            file = try AVAudioFile(forWriting: wavURL, settings: aac,
                                   commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        }
        try await analyzer.prepareToAnalyze(in: format)
        try await analyzer.start(inputSequence: stream)
        startResults()
    }

    private func startResults() {
        let speaker = self.speaker
        resultsTask = Task { [weak self] in
            var index = 0
            do {
                for try await result in self!.transcriber.results {
                    guard let self else { return }
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    if text.isEmpty { continue }
                    let offset = self.offset ?? 0
                    Output.emit([
                        "type": Channel.chunkDir == nil ? "segment" : "preview",
                        "speaker": speaker,
                        "id": "\(speaker)-\(index)",
                        "text": text,
                        "start": result.range.start.seconds + offset,
                        "end": result.range.end.seconds + offset,
                        "final": result.isFinal,
                    ])
                    if result.isFinal { index += 1 }
                }
            } catch {
                Output.error("\(speaker) transcription stopped: \(error.localizedDescription)")
            }
        }
    }

    /// Called on the audio thread. The source buffer is only valid for the
    /// duration of this call, so conversion has to happen synchronously.
    func feed(_ source: AVAudioPCMBuffer) {
        if offset == nil { offset = Date().timeIntervalSince(sessionStart) }
        buffersReceived += 1
        guard let buffer = Channel.loudestChannel(source) else { return }
        trackLevel(buffer)
        chunker?.feed(buffer)
        if converter == nil || converter!.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: format)
            converter?.primeMethod = .none
        }
        guard let converter else { return }
        let ratio = format.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 64
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: converted, error: &error) { _, status in
            if supplied {
                status.pointee = .noDataNow
                return nil
            }
            supplied = true
            status.pointee = .haveData
            return buffer
        }
        if let error {
            Output.error("\(speaker) conversion failed: \(error.localizedDescription)")
            return
        }
        guard converted.frameLength > 0 else { return }
        try? file?.write(from: converted)
        continuation.yield(AnalyzerInput(buffer: converted))
    }

    private func trackLevel(_ buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        var maxValue: Float = 0
        for i in 0..<frames { maxValue = max(maxValue, abs(data[0][i])) }
        levelLock.lock()
        peak = max(peak, maxValue)
        if maxValue > 0 { heardSignal = true }
        levelLock.unlock()
    }

    /// Mono float copy of the loudest channel. Voice-processing input on macOS
    /// arrives as 3-5 channels, and AVAudioConverter's default downmix of those
    /// to mono is silent — so pick the channel that actually carries signal.
    static func loudestChannel(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let channels = Int(buffer.format.channelCount)
        let frames = Int(buffer.frameLength)
        guard frames > 0, let mono = AVAudioFormat(standardFormatWithSampleRate: buffer.format.sampleRate, channels: 1),
              let out = AVAudioPCMBuffer(pcmFormat: mono, frameCapacity: AVAudioFrameCount(frames)) else { return nil }
        out.frameLength = AVAudioFrameCount(frames)
        let dst = out.floatChannelData![0]
        if let src = buffer.floatChannelData {
            let interleaved = buffer.format.isInterleaved
            let stride = interleaved ? channels : 1
            var best = 0
            var bestEnergy: Float = -1
            for c in 0..<channels {
                var energy: Float = 0
                for i in Swift.stride(from: 0, to: frames, by: 4) {
                    let v = interleaved ? src[0][i * stride + c] : src[c][i]
                    energy += v * v
                }
                if energy > bestEnergy { bestEnergy = energy; best = c }
            }
            for i in 0..<frames { dst[i] = interleaved ? src[0][i * stride + best] : src[best][i] }
        } else if let src = buffer.int16ChannelData {
            for i in 0..<frames { dst[i] = Float(src[0][i * (buffer.format.isInterleaved ? channels : 1)]) / 32768 }
        } else {
            return nil
        }
        return out
    }

    /// Returns the peak level since the last call and resets it.
    func takeLevel() -> Float {
        levelLock.lock()
        defer { peak = 0; levelLock.unlock() }
        return peak
    }

    func finish() async {
        chunker?.flush()
        continuation.finish()
        do {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        } catch {
            Output.error("\(speaker) finalize failed: \(error.localizedDescription)")
        }
        await resultsTask?.value
        file = nil
    }
}

/// Offline transcription of a recorded file, used by the replay harness.
enum FileTranscriber {
    static func transcribe(speaker: String, url: URL, locale: Locale) async throws -> [[String: Any]] {
        let file = try AVAudioFile(forReading: url)
        let transcriber = Channel.makeTranscriber(locale: locale, volatile: false)
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let collect = Task { () -> [[String: Any]] in
            var segments: [[String: Any]] = []
            for try await result in transcriber.results where result.isFinal {
                let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                if text.isEmpty { continue }
                segments.append([
                    "type": "segment",
                    "speaker": speaker,
                    "id": "\(speaker)-\(segments.count)",
                    "text": text,
                    "start": result.range.start.seconds,
                    "end": result.range.end.seconds,
                    "final": true,
                ])
            }
            return segments
        }
        if let last = try await analyzer.analyzeSequence(from: file) {
            try await analyzer.finalizeAndFinish(through: last)
        } else {
            await analyzer.cancelAndFinishNow()
        }
        return try await collect.value
    }
}
