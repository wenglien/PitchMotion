import ExpoModulesCore
import Foundation

public final class ExpoSpeedgunModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoSpeedgun")

        Events("onProgress")

        AsyncFunction("analyzeVideoOffline") { [weak self] (videoUri: String, options: [String: Any]) -> [String: Any] in
            guard let self = self else {
                return ["error": "Module deallocated"]
            }

            // A manually measured rubber-to-plate distance is mandatory.  We do
            // not silently estimate or assume an MLB field: either would turn a
            // plausible-looking number into an unreliable speed result.
            let moundDistance = options["moundDistance"] as? Double ?? 0
            let strideCorrection = options["strideCorrectionM"] as? Double
            let confThreshold = options["confThreshold"] as? Double ?? 0.05
            let pitcherHeight = options["pitcherHeightM"] as? Double
            let batterHeight = options["batterHeightM"] as? Double
            let strikeZone = Self.parseStrikeZone(options["strikeZone"])

            let pipeline = SpeedgunPipeline { progress in
                self.sendEvent("onProgress", [
                    "stage": progress.stage,
                    "progress": progress.progress,
                    "message": progress.message,
                ])
            }

            do {
                let result = try await pipeline.analyze(
                    videoUri: videoUri,
                    moundDistance: moundDistance,
                    strideCorrectionM: strideCorrection,
                    confThreshold: confThreshold,
                    pitcherHeightM: pitcherHeight,
                    batterHeightM: batterHeight,
                    strikeZone: strikeZone
                )
                return result
            } catch {
                return ["error": error.localizedDescription]
            }
        }

        AsyncFunction("getVideoMetadata") { (videoUri: String) -> [String: Any] in
            do {
                let videoURL = try Self.resolveVideoURL(videoUri)
                let decoder = try VideoDecoder(url: videoURL)
                let targetAnalysisFps = 120
                let interpolationFactor = decoder.captureFps < targetAnalysisFps
                    ? max(2, min(4, Int(ceil(Double(targetAnalysisFps) / Double(max(1, decoder.captureFps))))))
                    : 1
                return [
                    "fps": decoder.fps,
                    "capture_fps": decoder.captureFps,
                    "effective_fps": decoder.fps * interpolationFactor,
                    "effective_capture_fps": decoder.captureFps * interpolationFactor,
                    "interpolation_factor": interpolationFactor,
                    "width": decoder.displayWidth,
                    "height": decoder.displayHeight,
                    "duration_s": decoder.duration,
                    "total_frames": decoder.totalFrames,
                ]
            } catch {
                return ["error": error.localizedDescription]
            }
        }
    }

    private static func resolveVideoURL(_ videoUri: String) throws -> URL {
        if videoUri.hasPrefix("file://") {
            guard let u = URL(string: videoUri) else {
                throw SpeedgunError.videoLoadFailed("Invalid file URI: \(videoUri)")
            }
            return u
        }
        if videoUri.hasPrefix("/") {
            return URL(fileURLWithPath: videoUri)
        }
        if videoUri.hasPrefix("ph://") {
            throw SpeedgunError.videoLoadFailed("Photos library assets not yet supported. Please use a file path.")
        }
        return URL(string: videoUri) ?? URL(fileURLWithPath: videoUri)
    }

    private static func parseStrikeZone(_ raw: Any?) -> [String: Double]? {
        guard let dict = raw as? [String: Any] else { return nil }
        let xMin = dict["xMin"] as? Double
        let xMax = dict["xMax"] as? Double
        let yMin = dict["yMin"] as? Double
        let yMax = dict["yMax"] as? Double
        guard let xMin, let xMax, let yMin, let yMax,
              xMin >= 0.0, xMin < xMax, xMax <= 1.0,
              yMin >= 0.0, yMin < yMax, yMax <= 1.0 else {
            return nil
        }
        return [
            "x_min": xMin,
            "x_max": xMax,
            "y_min": yMin,
            "y_max": yMax,
        ]
    }
}
