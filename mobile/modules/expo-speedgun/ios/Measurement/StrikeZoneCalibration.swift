import CoreGraphics
import Foundation

private let plateZoneCenterM = 0.9

func absStrikeZoneHeightM(_ batterHeightM: Double?) -> Double? {
    guard let batterHeightM,
          batterHeightM >= PitchAccuracyTuning.minBatterHeightM,
          batterHeightM <= PitchAccuracyTuning.maxBatterHeightM else {
        return nil
    }
    return batterHeightM * (ABS_STRIKE_ZONE_TOP_RATIO - ABS_STRIKE_ZONE_BOTTOM_RATIO)
}

func strikeZoneSpan(batterHeightM: Double?) -> (width: Double, height: Double, absHeightM: Double?) {
    let zoneW = STRIKE_ZONE_X_MAX - STRIKE_ZONE_X_MIN
    let defaultH = STRIKE_ZONE_Y_MAX - STRIKE_ZONE_Y_MIN
    guard let absHeightM = absStrikeZoneHeightM(batterHeightM) else {
        return (zoneW, defaultH, nil)
    }
    let zoneH = clamp(
        defaultH * (absHeightM / LEGACY_STRIKE_ZONE_HEIGHT_M),
        min: PitchAccuracyTuning.minStrikeZoneHeightNorm,
        max: PitchAccuracyTuning.maxStrikeZoneHeightNorm
    )
    return (zoneW, zoneH, absHeightM)
}

func resolveStrikeZone(_ override: [String: Double]?, batterHeightM: Double? = nil) -> [String: Double] {
    guard let override else {
        let span = strikeZoneSpan(batterHeightM: batterHeightM)
        let cx = (STRIKE_ZONE_X_MIN + STRIKE_ZONE_X_MAX) / 2.0
        let cy = (STRIKE_ZONE_Y_MIN + STRIKE_ZONE_Y_MAX) / 2.0
        return [
            "x_min": cx - span.width / 2.0,
            "x_max": cx + span.width / 2.0,
            "y_min": cy - span.height / 2.0,
            "y_max": cy + span.height / 2.0,
        ]
    }
    let xMin = override["x_min"] ?? STRIKE_ZONE_X_MIN
    let xMax = override["x_max"] ?? STRIKE_ZONE_X_MAX
    let yMin = override["y_min"] ?? STRIKE_ZONE_Y_MIN
    let yMax = override["y_max"] ?? STRIKE_ZONE_Y_MAX
    guard xMin >= 0.0, xMin < xMax, xMax <= 1.0,
          yMin >= 0.0, yMin < yMax, yMax <= 1.0 else {
        return DEFAULT_STRIKE_ZONE
    }
    return [
        "x_min": xMin,
        "x_max": xMax,
        "y_min": yMin,
        "y_max": yMax,
    ]
}

func estimateAutoStrikeZone(
    frameInfos: [FrameInfo],
    displayWidth: Int,
    displayHeight: Int,
    lastBallFrame: Int?,
    batterHeightM: Double? = nil
) -> [String: Double] {
    guard displayWidth > 0, displayHeight > 0 else { return DEFAULT_STRIKE_ZONE }

    let span = strikeZoneSpan(batterHeightM: batterHeightM)
    let zoneW = span.width
    let zoneH = span.height
    let defaultCX = (STRIKE_ZONE_X_MIN + STRIKE_ZONE_X_MAX) / 2.0
    let defaultCY = (STRIKE_ZONE_Y_MIN + STRIKE_ZONE_Y_MAX) / 2.0

    var poseCentersX: [Double] = []
    var poseMidY: [Double] = []
    for fi in frameInfos {
        guard let pose = fi.poseLandmarks else { continue }
        let xs = [pose.leftShoulder, pose.rightShoulder, pose.leftHip, pose.rightHip]
            .compactMap { $0?.x }
        if xs.count >= 2 {
            poseCentersX.append(Double(xs.reduce(0, +)) / Double(xs.count) / Double(displayWidth))
        }

        let ys = [pose.leftShoulder, pose.rightShoulder, pose.leftHip, pose.rightHip]
            .compactMap { $0?.y }
        if ys.count >= 2 {
            poseMidY.append(Double(ys.reduce(0, +)) / Double(ys.count) / Double(displayHeight))
        }
    }

    let poseCX = poseCentersX.isEmpty ? nil : median(poseCentersX)

    var tailXs: [Double] = []
    var tailYs: [Double] = []
    if let last = lastBallFrame, !frameInfos.isEmpty {
        let end = min(last, frameInfos.count - 1)
        let start = max(0, end - 15)
        if start <= end {
            for i in start...end {
                let fi = frameInfos[i]
                guard fi.ballInFrame && !fi.ballLostTracking else { continue }
                tailXs.append(Double(fi.ballCenter.x) / Double(displayWidth))
                tailYs.append(Double(fi.ballCenter.y) / Double(displayHeight))
            }
        }
    }
    let tailX = tailXs.isEmpty ? nil : median(tailXs)
    let tailY = tailYs.isEmpty ? nil : median(tailYs)

    let centerX: Double
    if let poseCX {
        centerX = PitchAccuracyTuning.autoZonePoseWeightX * poseCX
            + (1.0 - PitchAccuracyTuning.autoZonePoseWeightX) * (tailX ?? defaultCX)
    } else if let tailX {
        centerX = (1.0 - PitchAccuracyTuning.autoZoneTailWeightX) * defaultCX
            + PitchAccuracyTuning.autoZoneTailWeightX * tailX
    } else {
        centerX = defaultCX
    }

    var centerY = defaultCY
    if let tailY {
        centerY += PitchAccuracyTuning.autoZoneTailWeightY * (tailY - defaultCY)
    }
    if !poseMidY.isEmpty {
        centerY += PitchAccuracyTuning.autoZonePoseMidYWeight * (median(poseMidY) - 0.40)
    }

    let clampedX = clamp(centerX, min: zoneW / 2.0 + 0.02, max: 1.0 - zoneW / 2.0 - 0.02)
    let clampedY = clamp(centerY, min: zoneH / 2.0 + 0.02, max: 1.0 - zoneH / 2.0 - 0.02)

    return [
        "x_min": clampedX - zoneW / 2.0,
        "x_max": clampedX + zoneW / 2.0,
        "y_min": clampedY - zoneH / 2.0,
        "y_max": clampedY + zoneH / 2.0,
    ]
}

/// Strike-zone relative location in display-normalized catcher/umpire POV.
func strikeZoneLocation(
    xNorm: Double,
    yNorm: Double,
    plateZone: [String: Double]
) -> (x: Double, y: Double, isStrike: Bool) {
    let xMin = plateZone["x_min"] ?? STRIKE_ZONE_X_MIN
    let xMax = plateZone["x_max"] ?? STRIKE_ZONE_X_MAX
    let yMin = plateZone["y_min"] ?? STRIKE_ZONE_Y_MIN
    let yMax = plateZone["y_max"] ?? STRIKE_ZONE_Y_MAX
    let zoneW = xMax - xMin
    let zoneH = yMax - yMin
    let locX = zoneW > 0 ? (xNorm - xMin) / zoneW : 0.5
    let locY = zoneH > 0 ? (yNorm - yMin) / zoneH : 0.5
    return (
        x: locX,
        y: locY,
        isStrike: locX >= 0.0 && locX <= 1.0 && locY >= 0.0 && locY <= 1.0
    )
}

/// Map normalised image coordinates to approximate lateral / height metres at the plate plane.
func worldCoordsFromNorm(
    xNorm: Double,
    yNorm: Double,
    zone: [String: Double],
    zoneWidthM: Double,
    zoneHeightM: Double
) -> (x: Double, y: Double) {
    let zoneCenterX = ((zone["x_min"] ?? STRIKE_ZONE_X_MIN) + (zone["x_max"] ?? STRIKE_ZONE_X_MAX)) / 2.0
    let zoneCenterY = ((zone["y_min"] ?? STRIKE_ZONE_Y_MIN) + (zone["y_max"] ?? STRIKE_ZONE_Y_MAX)) / 2.0
    let zoneNormW = max(0.05, (zone["x_max"] ?? STRIKE_ZONE_X_MAX) - (zone["x_min"] ?? STRIKE_ZONE_X_MIN))
    let zoneNormH = max(0.05, (zone["y_max"] ?? STRIKE_ZONE_Y_MAX) - (zone["y_min"] ?? STRIKE_ZONE_Y_MIN))
    let lateral = ((xNorm - zoneCenterX) / zoneNormW) * zoneWidthM
    let height = plateZoneCenterM + ((zoneCenterY - yNorm) / zoneNormH) * zoneHeightM
    return (lateral, height)
}
