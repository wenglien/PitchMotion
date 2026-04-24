import Foundation
import CoreGraphics

/// Computes ball speed from trajectory data with air resistance model.
/// Port of src/ball_speed_calculator.py
final class BallSpeedCalculator {
    let fps: Int
    let videoWidth: Int
    let videoHeight: Int
    let theoreticalDistance: Double?
    let strideCorrectionM: Double
    var pixelsPerMeter: Double?
    var nearY: Int?
    var farY: Int?

    var effectiveDistance: Double? {
        guard let d = theoreticalDistance else { return nil }
        return max(d - strideCorrectionM, 1.0)
    }

    init(
        fps: Int,
        videoWidth: Int,
        videoHeight: Int,
        theoreticalDistance: Double? = nil,
        strideCorrectionM: Double? = nil
    ) {
        self.fps = max(1, fps)
        self.videoWidth = videoWidth
        self.videoHeight = videoHeight
        self.theoreticalDistance = theoreticalDistance
        self.strideCorrectionM = strideCorrectionM ?? DEFAULT_STRIDE_CORRECTION
    }

    // MARK: - Perspective Correction

    func applyPerspectiveCorrection(point: CGPoint) -> Double {
        guard let ny = nearY, let fy = farY, fy != ny else { return 1.0 }
        let t = clamp(Double(point.y - CGFloat(ny)) / Double(fy - ny), min: 0, max: 1)
        return PERSPECTIVE_NEAR_FACTOR - (PERSPECTIVE_RANGE * t)
    }

    // MARK: - Flight Time Estimation

    private func estimateFramesElapsed(
        releaseFrameIdx: Int?,
        firstBallFrameIdx: Int?
    ) -> Double {
        let fallback = max(1.0, (RELEASE_FALLBACK_SEC * Double(fps)).rounded())
        let maxPreFrames = max(1.0, (MAX_PRE_DETECT_SEC * Double(fps)).rounded())

        if let release = releaseFrameIdx, let first = firstBallFrameIdx, first > release {
            let raw = Double(max(1, first - release))
            if raw > maxPreFrames {
                return fallback
            }
            return raw
        }
        return fallback
    }

    private func estimateFlightTime(
        numTrajectoryPoints: Int,
        releaseFrameIdx: Int?,
        firstBallFrameIdx: Int?,
        lastBallFrameIdx: Int?
    ) -> Double {
        var rawTime: Double?

        // Priority 1: pose release → last endpoint (which may be audio catch or YOLO last).
        // releaseFrameIdx has already been validated by SpeedgunPipeline to be within
        // MAX_PRE_DETECT_SEC before firstBallFrame, so this is safe.
        if let release = releaseFrameIdx, let last = lastBallFrameIdx, last > release {
            rawTime = Double(last - release) / Double(fps)
        }

        // Priority 2: firstBallFrame + pre-detection offset → last endpoint.
        // Used when pose release is not available.
        if rawTime == nil, let first = firstBallFrameIdx, let last = lastBallFrameIdx, last > first {
            let detFrames = Double(last - first)
            let preFrames = estimateFramesElapsed(
                releaseFrameIdx: releaseFrameIdx,
                firstBallFrameIdx: first
            )
            rawTime = max(1.0, detFrames + preFrames) / Double(fps)
        }

        // Last resort: trajectory point count
        if rawTime == nil {
            rawTime = Double(max(1, numTrajectoryPoints)) / Double(fps)
        }

        let time0 = rawTime ?? MIN_FLIGHT_TIME_SEC
        return clampFlightTime(time0, distance: effectiveDistance)
    }

    private func clampFlightTime(_ raw: Double, distance: Double?) -> Double {
        var time = max(raw, MIN_FLIGHT_TIME_SEC)
        if let dist = distance {
            let maxFlightTime = dist / MIN_REASONABLE_SPEED_MS
            let minFlightTime = dist / MAX_REASONABLE_SPEED_MS
            if time > maxFlightTime { time = maxFlightTime }
            else if time < minFlightTime { time = minFlightTime }
        }
        return time
    }

    // MARK: - Time-to-Contact (TTC) Estimation

    /// Estimate total flight time using ball area growth rate (optical looming).
    ///
    /// In a catcher-POV video the ball approaches the camera, so its projected
    /// area A(t) grows as  A ∝ 1/(d-v*t)².  Near contact the looming rate
    /// dA/dt ≈ 2*A*v/d  →  TTC ≈ 2*A / (dA/dt).
    ///
    /// We fit a linear regression to A(t) over the observed track to get a
    /// stable dA/dt, then use TTC from the first detected frame as total flight
    /// time (from release ≈ firstFrame − preFrames).
    ///
    /// Returns nil if area data is insufficient or the estimate is implausible.
    /// TTC estimate along with a status string explaining success/failure reason.
    /// Status: "used" | "fallback_samples" | "fallback_growth" | "fallback_slope" | "fallback_range"
    func estimateTTCWithStatus(frameInfos: [FrameInfo]) -> (Double?, String) {
        // Collect (frameIndex, area) pairs with valid area
        let samples = frameInfos.filter { $0.ballInFrame && $0.ballArea > 4 }
                                .map { (Double($0.frameIndex), $0.ballArea) }
        // Lowered from ≥4 → ≥3 (short backyard clips at high fps have few growth samples)
        guard samples.count >= 3 else {
            NSLog("[BallSpeedCalculator] TTC fallback: insufficient area samples (%d<3)", samples.count)
            return (nil, "fallback_samples")
        }

        // Require area to be generally growing (approaching camera).
        // Lowered from 1.5× → 1.2× to catch shorter / partially-occluded approaches.
        let firstArea = samples.first!.1
        let lastArea  = samples.last!.1
        guard lastArea > firstArea * 1.2 else {
            NSLog("[BallSpeedCalculator] TTC fallback: area growth %.2f× < 1.2× (first=%.0f last=%.0f)",
                  lastArea/max(firstArea,1), firstArea, lastArea)
            return (nil, "fallback_growth")
        }

        // Linear regression: A = slope * t + intercept
        let ts = samples.map { $0.0 }
        let as_ = samples.map { $0.1 }
        let n = Double(samples.count)
        let meanT = ts.reduce(0, +) / n
        let meanA = as_.reduce(0, +) / n
        var num = 0.0, den = 0.0
        for i in 0..<samples.count {
            num += (ts[i] - meanT) * (as_[i] - meanA)
            den += (ts[i] - meanT) * (ts[i] - meanT)
        }
        guard den > 0 else { return (nil, "fallback_slope") }
        let slope = num / den   // px²/frame

        guard slope > 0 else {
            NSLog("[BallSpeedCalculator] TTC fallback: non-positive slope %.2f", slope)
            return (nil, "fallback_slope")
        }

        // TTC from first detection: TTC_frames = 2 * A_first / slope  (looming formula)
        let ttcFrames = 2.0 * firstArea / slope
        let ttcSec = ttcFrames / Double(fps)

        // Sanity: TTC should be 0.15s–2.0s for realistic pitching distances
        // (lowered lower bound from 0.2s to allow short backyard distances)
        guard ttcSec >= 0.15 && ttcSec <= 2.0 else {
            NSLog("[BallSpeedCalculator] TTC fallback: ttc=%.3fs outside [0.15,2.0]s", ttcSec)
            return (nil, "fallback_range")
        }

        NSLog("[BallSpeedCalculator] TTC estimate: %.3fs (slope=%.1f px²/frame, firstArea=%.0f px², n=%d)",
              ttcSec, slope, firstArea, samples.count)
        return (ttcSec, "used")
    }

    /// Back-compat wrapper — drops the status string.
    func estimateTTC(frameInfos: [FrameInfo]) -> Double? {
        return estimateTTCWithStatus(frameInfos: frameInfos).0
    }

    // MARK: - Trajectory Quality

    private func computeTrajectoryLinearity(_ points: [CGPoint]) -> Double {
        guard points.count >= 3 else { return 0 }

        let xs = points.map { Double($0.x) }
        let ys = points.map { Double($0.y) }
        let t = (0..<points.count).map { Double($0) }

        let cxCoeffs = polyfit(t, xs, degree: 1)
        let cyCoeffs = polyfit(t, ys, degree: 1)

        var sumSq = 0.0
        for i in 0..<points.count {
            let predX = polyval(cxCoeffs, t[i])
            let predY = polyval(cyCoeffs, t[i])
            let dx = xs[i] - predX
            let dy = ys[i] - predY
            sumSq += dx * dx + dy * dy
        }
        let rmse = sqrt(sumSq / Double(points.count))
        let diag = sqrt(Double(videoWidth * videoWidth + videoHeight * videoHeight))
        return (rmse / (diag + 1e-6)).rounded(toPlaces: 4)
    }

    // MARK: - Main Speed Calculation

    func calculateSpeedDetailed(
        trajectoryPoints: [CGPoint],
        frameInfos: [FrameInfo] = [],
        releasePoint: CGPoint? = nil,
        releaseFrameIdx: Int? = nil,
        firstBallFrameIdx: Int? = nil,
        lastBallFrameIdx: Int? = nil
    ) -> SpeedInfo {
        guard trajectoryPoints.count >= 2 else {
            var info = SpeedInfo()
            info.error = "Not enough trajectory points (need >= 2)"
            return info
        }

        if theoreticalDistance != nil {
            return calculateTheoretical(
                trajectoryPoints: trajectoryPoints,
                frameInfos: frameInfos,
                releasePoint: releasePoint,
                releaseFrameIdx: releaseFrameIdx,
                firstBallFrameIdx: firstBallFrameIdx,
                lastBallFrameIdx: lastBallFrameIdx
            )
        }

        // Pixel-based fallback (rare case)
        var info = SpeedInfo()
        info.error = "Missing theoretical distance for speed calculation"
        return info
    }

    // MARK: - Theoretical Mode

    private func calculateTheoretical(
        trajectoryPoints: [CGPoint],
        frameInfos: [FrameInfo],
        releasePoint: CGPoint?,
        releaseFrameIdx: Int?,
        firstBallFrameIdx: Int?,
        lastBallFrameIdx: Int?
    ) -> SpeedInfo {
        let numFrames = trajectoryPoints.count
        guard let distance = effectiveDistance else {
            var info = SpeedInfo()
            info.error = "No effective distance"
            return info
        }

        // Try TTC (optical looming) first — most reliable for catcher-POV
        // where ball approaches camera and grows rapidly in final frames.
        let (ttcTime, ttcStatus) = estimateTTCWithStatus(frameInfos: frameInfos)

        let totalTime: Double
        if let ttc = ttcTime {
            // TTC gives time from first detection to contact.
            // Add pre-detection offset (release to firstBallFrame).
            let preFrames = estimateFramesElapsed(
                releaseFrameIdx: releaseFrameIdx,
                firstBallFrameIdx: firstBallFrameIdx
            )
            let rawTime = ttc + preFrames / Double(fps)
            totalTime = clampFlightTime(rawTime, distance: distance)
            NSLog("[BallSpeedCalculator] Using TTC: %.3fs + pre=%.3fs → total=%.3fs",
                  ttc, preFrames / Double(fps), totalTime)
        } else {
            totalTime = estimateFlightTime(
                numTrajectoryPoints: numFrames,
                releaseFrameIdx: releaseFrameIdx,
                firstBallFrameIdx: firstBallFrameIdx,
                lastBallFrameIdx: lastBallFrameIdx
            )
        }

        let avgSpeedMs = distance / totalTime
        let avgSpeedKmh = avgSpeedMs * MS_TO_KMH

        // Binary search for release speed using air resistance model
        // v(t) = v0 / (1 + k * v0 * t)
        let k = AIR_RESISTANCE_K

        func simulateAvgSpeed(_ v0: Double) -> Double {
            let dt = totalTime / 200.0
            var v = v0
            var totalDist = 0.0
            for _ in 0..<200 {
                totalDist += v * dt
                v = v / (1.0 + k * v * dt)
            }
            return totalDist / totalTime
        }

        var lo = avgSpeedMs
        var hi = avgSpeedMs * 1.20
        for _ in 0..<60 {
            let mid = (lo + hi) / 2.0
            if simulateAvgSpeed(mid) > avgSpeedMs {
                hi = mid
            } else {
                lo = mid
            }
        }
        var releaseSpeedMs = (lo + hi) / 2.0
        var releaseSpeedKmh = releaseSpeedMs * MS_TO_KMH

        var physicsClamped = false
        if releaseSpeedKmh > MAX_REASONABLE_SPEED_KMH {
            releaseSpeedKmh = MAX_REASONABLE_SPEED_KMH
            releaseSpeedMs = releaseSpeedKmh / MS_TO_KMH
            physicsClamped = true
        }

        let linearity = computeTrajectoryLinearity(trajectoryPoints)
        let qualityWarning = linearity > 0.03

        var info = SpeedInfo()
        info.releaseSpeedKmh = releaseSpeedKmh
        info.initialSpeedKmh = releaseSpeedKmh
        info.maxSpeedKmh = releaseSpeedKmh
        info.averageSpeedKmh = avgSpeedKmh
        info.totalDistanceM = distance
        info.effectiveDistanceM = distance
        info.moundDistanceM = theoreticalDistance
        info.strideCorrectionM = strideCorrectionM
        info.flightTimeS = totalTime
        info.numFrames = numFrames
        info.calculationMethod = (ttcTime != nil) ? "ttc" : "theoretical"
        info.ttcStatus = ttcStatus
        info.trajectoryLinearity = linearity
        info.trajectoryQualityWarning = qualityWarning
        info.physicsClamped = physicsClamped
        info.releasePoint = releasePoint
        return info
    }
}

// MARK: - Double Extension

extension Double {
    func rounded(toPlaces places: Int) -> Double {
        let multiplier = pow(10.0, Double(places))
        return (self * multiplier).rounded() / multiplier
    }
}
