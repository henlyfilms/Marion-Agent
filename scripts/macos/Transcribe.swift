import AVFoundation
import Foundation
import Speech

@main
struct MarionTranscribe {
    static func main() async {
        if #available(macOS 26, *) {
            do {
                try await transcribe()
                return
            } catch {
                FileHandle.standardError.write(Data(error.localizedDescription.utf8))
            }
        } else {
            FileHandle.standardError.write(Data("Built-in dictation requires macOS 26.".utf8))
        }
        exit(1)
    }

    /// Arguments: `<audio.wav | --prepare> [locale] [--context <file>]`. The context file holds one hint per line
    /// (names, product terms, words from the text being written); the recogniser leans toward them.
    @available(macOS 26, *)
    static func transcribe() async throws {
        var args = Array(CommandLine.arguments)
        var contextFile: String?
        if let flag = args.firstIndex(of: "--context"), flag + 1 < args.count {
            contextFile = args[flag + 1]
            args.removeSubrange(flag...(flag + 1))
        }
        let requested = args.count > 2 && !args[2].isEmpty ? Locale(identifier: args[2]) : .current
        guard SpeechTranscriber.isAvailable,
              let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requested) else {
            throw NSError(domain: "MarionSpeech", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "On-device dictation is unavailable for this Mac or language."
            ])
        }
        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        if let installation = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
            try await installation.downloadAndInstall()
        }

        if args[1] == "--prepare" { return }
        let audio = try AVAudioFile(forReading: URL(fileURLWithPath: args[1]))
        let analyzer = SpeechAnalyzer(modules: [transcriber])
        if let contextFile,
           let text = try? String(contentsOfFile: contextFile, encoding: .utf8) {
            let hints = text.split(whereSeparator: \.isNewline).map { String($0) }.filter { !$0.isEmpty }
            if !hints.isEmpty {
                let context = AnalysisContext()
                context.contextualStrings[.general] = Array(hints.prefix(500))
                try? await analyzer.setContext(context) // hints are an extra: never fail the transcription over them
            }
        }
        async let words: String = readResults(transcriber)
        do {
            try await analyzer.start(inputAudioFile: audio, finishAfterFile: true)
            print(try await words)
        } catch {
            await analyzer.cancelAndFinishNow()
            throw error
        }
    }

    @available(macOS 26, *)
    static func readResults(_ transcriber: SpeechTranscriber) async throws -> String {
        var segments: [String] = []
        for try await result in transcriber.results where result.isFinal {
            segments.append(String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return segments.filter { !$0.isEmpty }.joined(separator: " ")
    }
}
