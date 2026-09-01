import CoreGraphics
import Foundation

/// Estimate the ball position at the plate using a recency-weighted tail fit.
/// We fit x(t) and y(t) independently with a quadratic over the final actual
/// YOLO detections. This preserves late horizontal movement while damping the
/// frame-to-frame bbox jitter that dominates near the glove.
func estimatePlatePosition(
    frameInfos: [FrameInfo],
    displayWidth: Int,
    displayHeight: Int,
    lastBallFrame: Int?,
    catchFrame: Int?,
    fps: Int,
    plateZone: [String: Double]
) -> (point: CGPoint, source: String, confidence: Double, fitErrorPx: Double?, extrapolatedFrames: Double)? {
    guard let last = lastBallFrame,
          frameInfos.indices.contains(last),
          displayWidth > 0,
          displayHeight > 0 else { return nil }

    // Collect actual detections only (not gap-filled synthetic points). The
    // lookback scales with capture fps so slow-mo gets enough real time.
    let maxLookback = min(
        max(
            PitchAccuracyTuning.plateFitMinLookbackFrames,
            Int(round(Double(max(1, fps)) * PitchAccuracyTuning.plateFitLookbackSeconds))
        ),
        PitchAccuracyTuning.plateFitMaxLookbackFrames
    )
    let maxSamples = PitchAccuracyTuning.plateFitMaxSamples
    var actualDetections: [(frameIdx: Int, x: Double, y: Double, area: Double)] = []
    let searchStart = max(0, last - maxLookback)
    for i in stride(from: last, through: searchStart, by: -1) {
        let fi = frameInfos[i]
        if fi.ballInFrame && !fi.ballLostTracking {
            actualDetections.insert((i, Double(fi.ballCenter.x), Double(fi.ballCenter.y), fi.ballArea), at: 0)
        }
        if actualDetections.count >= maxSamples { break }
    }

    guard actualDetections.count >= 2 else {
        return (frameInfos[last].ballCenter, "last_detection", 0.45, nil, 0)
    }

    let pLast = actualDetections[actualDetections.count - 1]
    let curX = pLast.x
    let curY = pLast.y

    var vxs: [Double] = []
    var vys: [Double] = []
    for i in 1..<actualDetections.count {
        let a = actualDetections[i - 1]
        let b = actualDetections[i]
        let df = Double(max(1, b.frameIdx - a.frameIdx))
        vxs.append((b.x - a.x) / df)
        vys.append((b.y - a.y) / df)
    }
    let vx = median(vxs)
    let vyLinear = median(vys)

    let ts = actualDetections.map { Double($0.frameIdx - pLast.frameIdx) }
    let xs = actualDetections.map { $0.x }
    let ys = actualDetections.map { $0.y }
    let medianArea = median(actualDetections.map { max($0.area, 1.0) })
    let weights = actualDetections.enumerated().map { idx, det -> Double in
        let recency = Double(idx + 1) / Double(actualDetections.count)
        let areaWeight = medianArea > 1 ? clamp(sqrt(max(det.area, 1.0) / medianArea), min: 0.75, max: 1.25) : 1.0
        return (0.45 + 0.55 * recency) * areaWeight
    }

    let xFit = actualDetections.count >= 4 ? weightedQuadraticFit(ts: ts, values: xs, weights: weights) : nil
    let yFit = actualDetections.count >= 4 ? weightedQuadraticFit(ts: ts, values: ys, weights: weights) : nil

    let diag = Double(displayWidth * displayWidth + displayHeight * displayHeight).squareRoot()
    let fitErrorPx = hypot(xFit?.rmse ?? 0, yFit?.rmse ?? 0)
    let fitQuality = clamp(
        1.0 - fitErrorPx / max(12.0, diag * PitchAccuracyTuning.plateFitQualityDiagRatio),
        min: 0.0,
        max: 1.0
    )

    let usableXFit = xFit.flatMap { fit in
        fit.rmse <= max(10.0, Double(displayWidth) * PitchAccuracyTuning.plateXFitRmseWidthRatio)
            ? fit
            : nil
    }
    let usableYFit = yFit.flatMap { fit in
        fit.b > 0.25
            && fit.a >= -0.08
            && fit.rmse <= max(12.0, Double(displayHeight) * PitchAccuracyTuning.plateYFitRmseHeightRatio)
            ? fit
            : nil
    }

    func extrapolated(_ tFrames: Double) -> CGPoint {
        let x = usableXFit.map { evaluateQuadratic($0, tFrames) } ?? (curX + vx * tFrames)
        let y = usableYFit.map { evaluateQuadratic($0, tFrames) } ?? (curY + vyLinear * tFrames)
        return CGPoint(
            x: clamp(x, min: 0.0, max: Double(displayWidth)),
            y: clamp(y, min: 0.0, max: Double(displayHeight))
        )
    }

    func confidence(for tFrames: Double, source: String) -> Double {
        let sampleScore = clamp(Double(actualDetections.count - 2) / 6.0, min: 0.25, max: 1.0)
        let horizonScore = clamp(
            1.0 - tFrames / max(1.0, Double(max(1, fps)) * PitchAccuracyTuning.plateConfidenceHorizonSeconds),
            min: 0.20,
            max: 1.0
        )
        let sourceBoost = source == "last_detection" ? 0.06 : (source == "extrapolated_audio" ? 0.10 : 0.0)
        return clamp(0.28 + 0.34 * fitQuality + 0.22 * sampleScore + 0.10 * horizonScore + sourceBoost, min: 0.25, max: 0.95)
    }

    let maxFrames = Double(max(1, fps)) * PitchAccuracyTuning.plateFitMaxHorizonSeconds

    if let cf = catchFrame, cf >= pLast.frameIdx {
        let t = min(Double(cf - pLast.frameIdx), maxFrames)
        if t <= 0 {
            return (CGPoint(x: curX, y: curY), "last_detection", confidence(for: 0, source: "last_detection"), fitErrorPx, 0)
        }
        return (extrapolated(t), "extrapolated_audio", confidence(for: t, source: "extrapolated_audio"), fitErrorPx, t)
    }

    let zoneYMin = plateZone["y_min"] ?? STRIKE_ZONE_Y_MIN
    let plateBandLo = zoneYMin * Double(displayHeight)

    if curY >= plateBandLo {
        return (CGPoint(x: curX, y: curY), "last_detection", confidence(for: 0, source: "last_detection"), fitErrorPx, 0)
    }

    let vyAtLast = usableYFit?.b ?? vyLinear
    let yAccel = usableYFit?.a ?? 0.0
    guard vyAtLast > 0.5 else {
        return (CGPoint(x: curX, y: curY), "last_detection", confidence(for: 0, source: "last_detection"), fitErrorPx, 0)
    }

    let drop = plateBandLo - curY
    let tCross: Double
    if yAccel > 1e-9 {
        tCross = (-vyAtLast + sqrt(vyAtLast * vyAtLast + 4 * yAccel * drop)) / (2 * yAccel)
    } else {
        tCross = drop / vyAtLast
    }
    guard tCross > 0, tCross <= maxFrames else {
        return (CGPoint(x: curX, y: curY), "last_detection", confidence(for: 0, source: "last_detection"), fitErrorPx, 0)
    }
    return (extrapolated(tCross), "extrapolated_band", confidence(for: tCross, source: "extrapolated_band"), fitErrorPx, tCross)
}
