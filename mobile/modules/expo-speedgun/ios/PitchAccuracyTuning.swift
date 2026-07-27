import Foundation

/// Centralizes the knobs we tune while improving pitch-location accuracy.
/// Keeping these out of the pipeline body makes calibration changes easier to
/// review and safer to compare across test clips.
enum PitchAccuracyTuning {
    static let minBatterHeightM = 1.0
    static let maxBatterHeightM = 2.4

    static let minStrikeZoneHeightNorm = 0.08
    static let maxStrikeZoneHeightNorm = 0.45

    static let autoZonePoseWeightX = 0.75
    static let autoZoneTailWeightX = 0.35
    static let autoZoneTailWeightY = 0.35
    static let autoZonePoseMidYWeight = 0.08

    static let plateFitLookbackSeconds = 0.18
    static let plateFitMinLookbackFrames = 18
    static let plateFitMaxLookbackFrames = 48
    static let plateFitMaxSamples = 10
    static let plateFitMaxHorizonSeconds = 0.50
    static let plateConfidenceHorizonSeconds = 0.35

    static let plateXFitRmseWidthRatio = 0.018
    static let plateYFitRmseHeightRatio = 0.018
    static let plateFitQualityDiagRatio = 0.018
}
