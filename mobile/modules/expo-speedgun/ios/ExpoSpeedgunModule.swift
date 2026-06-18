import ExpoModulesCore

public final class ExpoSpeedgunModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoSpeedgun")

        Events("onProgress")

        AsyncFunction("analyzeVideoOffline") { [weak self] (videoUri: String, options: [String: Any]) -> [String: Any] in
            guard let self = self else {
                return ["error": "Module deallocated"]
            }

            // Distance: 0 (or missing) → auto-estimate from pose; >0 → user manual.
            // Do NOT silently fall back to MLB 18.44m here — SpeedgunPipeline.analyze()
            // handles the auto-estimate → default fallback chain and surfaces a warning.
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
