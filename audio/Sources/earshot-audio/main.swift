import AVFoundation
import Foundation

let usage = """
earshot-audio — audio sidecar for Earshot

  earshot-audio watch [--interval 1.0]
      Emit {"type":"mic_users"} whenever the set of other apps using the mic changes.

  earshot-audio capture --dir <path> [--locale en-US] [--no-system] [--no-aec] [--chunks]
      --chunks: also cut each utterance into <dir>/chunks/*.wav ({"type":"chunk"}) for an
      external engine, and report Apple's own results as {"type":"preview"}.
      Record mic ("me") and system audio ("them") to <dir>/me.m4a and <dir>/them.m4a (AAC),
      streaming on-device transcription as {"type":"segment"} lines. Stops on stdin EOF or SIGTERM.

  earshot-audio transcribe [--me file] [--them file] [--locale en-US]
      Offline transcription of recorded files, merged and sorted by start time.

  earshot-audio permissions [--request]
      Report (and optionally request) microphone and system-audio permission.

  earshot-audio assets [--locale en-US]
      Download the on-device speech model if needed.
"""

func option(_ name: String, in args: [String]) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

/// Keeps the capture running until stdin closes (the Tauri core dropping the
/// pipe) or the process is signalled, then finalizes transcripts and WAVs.
final class Capture {
    private let engine = AVAudioEngine()
    private let tap = SystemTap()
    private var me: Channel?
    private var them: Channel?
    private var levelTimer: DispatchSourceTimer?
    private var configObserver: NSObjectProtocol?

    func run(dir: URL, locale requested: Locale, system: Bool, aec: Bool) async {
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let locale = try await Channel.ensureAssets(locale: requested)
            let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
            Output.status("microphone permission", ["state": micStatus.rawValue])
            if micStatus == .notDetermined {
                guard await AVCaptureDevice.requestAccess(for: .audio) else { Output.fail("Microphone access denied") }
            } else if micStatus != .authorized {
                Output.fail("Microphone access denied. Enable it in System Settings → Privacy & Security → Microphone.")
            }
            let start = Date()
            Output.emit(["type": "started", "startedAt": ISO8601DateFormatter().string(from: start), "locale": locale.identifier])

            let me = try await Channel(speaker: "me", locale: locale, wavURL: dir.appendingPathComponent("me.m4a"), sessionStart: start)
            self.me = me
            Output.status("mic transcriber ready")
            let input = engine.inputNode
            if aec {
                // Voice processing cancels echo of what the speakers play, so the
                // other side isn't transcribed twice when not using headphones.
                do {
                    try input.setVoiceProcessingEnabled(true)
                    input.voiceProcessingOtherAudioDuckingConfiguration = .init(enableAdvancedDucking: false, duckingLevel: .min)
                } catch {
                    Output.error("Echo cancellation unavailable: \(error.localizedDescription)")
                }
            }
            let micFormat = input.outputFormat(forBus: 0)
            Output.debug("mic: device format sampleRate=\(micFormat.sampleRate) channels=\(micFormat.channelCount) aec=\(aec)")
            input.installTap(onBus: 0, bufferSize: 4096, format: micFormat) { buffer, _ in me.feed(buffer) }
            try engine.start()
            // Device changes (headphones in/out, voice processing settling) stop the
            // engine. Reinstall the tap with the new format and keep going.
            configObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in
                guard let self else { return }
                let input = self.engine.inputNode
                input.removeTap(onBus: 0)
                let format = input.outputFormat(forBus: 0)
                input.installTap(onBus: 0, bufferSize: 4096, format: format) { buffer, _ in me.feed(buffer) }
                do {
                    try self.engine.start()
                    Output.status("mic restarted", ["sampleRate": format.sampleRate, "channels": Int(format.channelCount)])
                } catch {
                    Output.error("Microphone stopped after an audio device change: \(error.localizedDescription)")
                }
            }
            Output.status("mic started", ["sampleRate": micFormat.sampleRate, "channels": Int(micFormat.channelCount)])

            if system {
                var systemState = Permissions.systemAudio()
                if systemState == .notDetermined { systemState = await Permissions.requestSystemAudio() }
                Output.emit(Permissions.report())
                if systemState == .denied {
                    Output.error("System audio access is off, so the other side won't be transcribed. Turn on Earshot under System Settings → Privacy & Security → Screen & System Audio Recording → System Audio Recording Only, then start a new session.")
                }
                let them = try await Channel(speaker: "them", locale: locale, wavURL: dir.appendingPathComponent("them.m4a"), sessionStart: start)
                self.them = them
                do {
                    try tap.start { buffer in them.feed(buffer) }
                } catch {
                    Output.error(error.localizedDescription)
                }
            }
            startLevels()
            Output.status("capturing", ["system": system, "aec": aec])
            DispatchQueue.global().asyncAfter(deadline: .now() + 5) { [weak self] in self?.checkSignal(system: system) }
        } catch {
            Output.fail(error.localizedDescription)
        }
    }

    /// Catch the two silent failures: a mic that delivers only zeros, and a
    /// system tap that delivers nothing (missing permission).
    private func checkSignal(system: Bool) {
        if let me, me.buffersReceived == 0 {
            Output.error("No audio is arriving from the microphone. Check the input device in System Settings → Sound.")
        } else if let me, !me.heardSignal {
            Output.error("The microphone is delivering pure silence — usually Microphone permission is off for Earshot (System Settings → Privacy & Security → Microphone).")
        }
        if system, let them, them.buffersReceived == 0 || (!them.heardSignal && Permissions.systemAudio() != .granted) {
            Output.error("No system audio is arriving. Allow Earshot under System Settings → Privacy & Security → Screen & System Audio Recording.")
        }
    }

    private func startLevels() {
        let timer = DispatchSource.makeTimerSource(queue: .global())
        timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
        var ticks = 0
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            Output.emit(["type": "level", "me": self.me?.takeLevel() ?? 0, "them": self.them?.takeLevel() ?? 0])
            ticks += 1
            if ticks % 20 == 0 {
                Output.debug("stats: me buffers=\(self.me?.buffersReceived ?? -1) signal=\(self.me?.heardSignal ?? false) | them buffers=\(self.them?.buffersReceived ?? -1) signal=\(self.them?.heardSignal ?? false) tapCallbacks=\(self.tap.callbacks) empty=\(self.tap.emptyCallbacks)")
            }
        }
        timer.resume()
        levelTimer = timer
    }

    func stop() async {
        levelTimer?.cancel()
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        tap.stop()
        async let a: Void = me?.finish() ?? ()
        async let b: Void = them?.finish() ?? ()
        _ = await (a, b)
        Output.emit(["type": "stopped"])
    }
}

/// Streams recorded files through the live Channel path at real-time pace —
/// the same code as `capture`, minus the devices. Used to test streaming STT.
func simulate(files: [(String, URL)], locale requested: Locale) async {
    do {
        let locale = try await Channel.ensureAssets(locale: requested)
        let start = Date()
        Output.emit(["type": "started", "startedAt": ISO8601DateFormatter().string(from: start), "locale": locale.identifier])
        await withTaskGroup(of: Void.self) { group in
            for (speaker, url) in files {
                group.addTask {
                    do {
                        let file = try AVAudioFile(forReading: url)
                        let channel = try await Channel(speaker: speaker, locale: locale, wavURL: nil, sessionStart: start)
                        let chunk = AVAudioFrameCount(file.processingFormat.sampleRate / 10)
                        while file.framePosition < file.length,
                              let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: chunk) {
                            let remaining = AVAudioFrameCount(file.length - file.framePosition)
                            try file.read(into: buffer, frameCount: min(chunk, remaining))
                            channel.feed(buffer)
                            try await Task.sleep(nanoseconds: 100_000_000)
                        }
                        await channel.finish()
                    } catch {
                        Output.error("\(speaker): \(error.localizedDescription)")
                    }
                }
            }
        }
        Output.emit(["type": "stopped"])
    } catch {
        Output.fail(error.localizedDescription)
    }
}

func waitForStop() async {
    await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
        let once = NSLock()
        var resumed = false
        func resume() {
            once.lock(); defer { once.unlock() }
            if !resumed { resumed = true; continuation.resume() }
        }
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: .global())
            source.setEventHandler { resume() }
            source.resume()
            signalSources.append(source)
        }
        Thread.detachNewThread {
            while let line = readLine(strippingNewline: true) {
                if line.trimmingCharacters(in: .whitespaces) == "stop" { break }
            }
            resume()
        }
    }
}

nonisolated(unsafe) var signalSources: [DispatchSourceSignal] = []

let args = Array(CommandLine.arguments.dropFirst())
let locale = Locale(identifier: option("--locale", in: args) ?? Locale.current.identifier)

if args.contains("--chunks"), let dir = option("--dir", in: args) ?? option("--chunk-dir", in: args) {
    Channel.chunkDir = URL(fileURLWithPath: dir)
}

switch args.first {
case "watch":
    Watch.run(interval: Double(option("--interval", in: args) ?? "") ?? 1.0)

case "capture":
    guard let dir = option("--dir", in: args) else { Output.fail("capture needs --dir") }
    let capture = Capture()
    await capture.run(dir: URL(fileURLWithPath: dir), locale: locale,
                      system: !args.contains("--no-system"), aec: !args.contains("--no-aec"))
    await waitForStop()
    await capture.stop()
    exit(0)

case "transcribe":
    do {
        let resolved = try await Channel.ensureAssets(locale: locale)
        var segments: [[String: Any]] = []
        for speaker in ["me", "them"] {
            guard let path = option("--\(speaker)", in: args) else { continue }
            segments += try await FileTranscriber.transcribe(speaker: speaker, url: URL(fileURLWithPath: path), locale: resolved)
        }
        segments.sort { ($0["start"] as! Double) < ($1["start"] as! Double) }
        segments.forEach(Output.emit)
        exit(0)
    } catch {
        Output.fail(error.localizedDescription)
    }

case "simulate":
    let files = ["me", "them"].compactMap { speaker in option("--\(speaker)", in: args).map { (speaker, URL(fileURLWithPath: $0)) } }
    await simulate(files: files, locale: locale)
    exit(0)

case "permissions":
    if args.contains("--request") {
        _ = await Permissions.requestMicrophone()
        _ = await Permissions.requestSystemAudio()
    }
    Output.emit(Permissions.report())
    exit(0)

case "assets":
    do {
        let resolved = try await Channel.ensureAssets(locale: locale)
        Output.status("ready", ["locale": resolved.identifier])
        exit(0)
    } catch {
        Output.fail(error.localizedDescription)
    }

default:
    FileHandle.standardError.write(usage.data(using: .utf8)!)
    exit(args.isEmpty ? 0 : 2)
}
