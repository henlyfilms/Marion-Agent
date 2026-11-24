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

    @available(macOS 26, *)
    static func transcribe() async throws {
        let args = CommandLine.arguments
        let requested = args.count > 2 ? Locale(identifier: args[2]) : .current
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
