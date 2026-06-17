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
    /// Whether to subtract strideCorrectionM from theoreticalDistance.
    /// Only true when the user manually entered the rubber-to-plate distance — for
    /// pose_estimated / default sources the geometry is direct cam-to-pitcher (or a
    /// rough fallback) and a second 1.7m subtraction would either double-count or
    /// guess a stride that wasn't actually thrown.
    let applyStrideCorrection: Bool
    var pixelsPerMeter: Double?
    var nearY: Int?
    var farY: Int?

    var effectiveDistance: Double? {
        guard let d = theoreticalDistance else { return nil }
        guard applyStrideCorrection else { return max(d, 1.0) }
        return max(d - strideCorrectionM, 1.0)
    }

    init(
        fps: Int,
        videoWidth: Int,
        videoHeight: Int,
        theoreticalDistance: Double? = nil,
        strideCorrectionM: Double? = nil,
        applyStrideCorrection: Bool = true
    ) {
        self.fps = max(1, fps)
        self.videoWidth = videoWidth
        self.videoHeight = videoHeight
        self.theoreticalDistance = theoreticalDistance
        self.strideCorrectionM = strideCorrectionM ?? DEFAULT_STRIDE_CORRECTION
        self.applyStrideCorrection = applyStrideCorrection
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
        firstBallFrameIdx: Int?,
        ballSizePreFrames: Double? = nil
    ) -> (frames: Double, source: String) {
        let fixedFallback = max(1.0, (RELEASE_FALLBACK_SEC * Double(fps)).rounded())
        let maxPreFrames = max(1.0, (MAX_PRE_DETECT_SEC * Double(fps)).rounded())

        // Ball-size ranging (pinhole model on the ball's pixel diameter) gives a
        // physically-derived pre-detect estimate; prefer it over the fixed 0.25s
        // guess whenever the pipeline could compute one.
        let fallback: Double
        let fallbackSource: String
        if let bs = ballSizePreFrames {
            fallback = clamp(bs, min: 0.0, max: maxPreFrames)
            fallbackSource = "ball_size"
        } else {
            fallback = fixedFallback
            fallbackSource = "fixed"
        }

        if let release = releaseFrameIdx, let first = firstBallFrameIdx, first > release {
            let raw = Double(max(1, first - release))
            if raw > maxPreFrames {
                NSLog("[BallSpeedCalculator] Pre-detect gap %.0f frames exceeds cap %.0f, using fallback %.0f (%@)",
                      raw, maxPreFrames, fallback, fallbackSource)
                return (fallback, fallbackSource)
            }
            // A pose release that lands too close to the first ball detection makes
            // flight time too short and inflates speed. Treat pose as a lower bound,
            // not as permission to use an unrealistically tiny pre-detect gap.
            if raw >= fallback {
                return (raw, "pose")
            }
            return (fallback, fallbackSource)
        }
        return (fallback, fallbackSource)
    }

    private func estimateFlightTime(
        numTrajectoryPoints: Int,
        releaseFrameIdx: Int?,
        firstBallFrameIdx: Int?,
        lastBallFrameIdx: Int?,
        ballSizePreFrames: Double? = nil,
        preDetectInfo: inout (sec: Double, source: String)?
    ) -> Double {
        var rawTime: Double?

        // Priority 1: first ball → endpoint + release-to-first compensation.
        // This is deliberately more stable than raw pose-release → endpoint:
        // when scene changes or pose jitters, release can land only a few frames
        // before the first ball detection, which shortens flight time and causes
        // 100+ mph spikes. Audio catch can still be the endpoint via lastBallFrameIdx.
        if let first = firstBallFrameIdx, let last = lastBallFrameIdx, last > first {
            let detFrames = Double(last - first)
            let (preFrames, preSource) = estimateFramesElapsed(
                releaseFrameIdx: releaseFrameIdx,
                firstBallFrameIdx: first,
                ballSizePreFrames: ballSizePreFrames
            )
            preDetectInfo = (preFrames / Double(fps), preSource)
            rawTime = max(1.0, detFrames + preFrames) / Double(fps)
            NSLog("[BallSpeedCalculator] Flight time: first(%d)->last(%d)=%.0f + pre=%.0f frames (%@) -> %.3fs",
                  first, last, detFrames, preFrames, preSource, rawTime ?? 0)
        }

        // Priority 2: raw release → endpoint only when no first-ball anchor exists.
        if rawTime == nil, let release = releaseFrameIdx, let last = lastBallFrameIdx, last > release {
            rawTime = Double(last - release) / Double(fps)
            NSLog("[BallSpeedCalculator] Flight time fallback: release(%d)->last(%d) -> %.3fs",
                  release, last, rawTime ?? 0)
        }

        // Last resort: trajectory point count
        if rawTime == nil {
            rawTime = Double(max(1, numTrajectoryPoints)) / Double(fps)
            NSLog("[BallSpeedCalculator] Flight time last-resort: points=%d fps=%d -> %.3fs",
                  numTrajectoryPoints, fps, rawTime ?? 0)
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
    /// area follows  A(t) = K / (d − v·t)².  Substituting y = 1/√A gives an
    /// exact linear relationship  y(t) = (d − v·t) / √K  with slope −v/√K and
    /// intercept d/√K.  The contact instant is the zero-crossing  t_contact = −b/m.
    ///
    /// Why 1/√A and not raw A:
    ///   A vs t is strongly convex near contact (∝ 1/(d−v·t)²), so a linear
    ///   regression of A vs t recovers the *average* dA/dt — much larger than
    ///   the instantaneous slope at t_first.  Plugging that into the closed-form
    ///   TTC = 2·A_first/(dA/dt|_{t_first}) systematically underestimates flight
    ///   time and inflates speed by ~30–50% on a typical 4× looming clip.
    ///   The 1/√A linearization is exact for the looming model, removing that bias.
    ///
    /// Returns nil if area data is insufficient or the estimate is implausible.
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

        // Robust linear fit of y = 1/√A against t (exact for A ∝ 1/(d−v·t)²).
        // Theil-Sen (median of pairwise slopes) instead of OLS: bbox areas are
        // heavy-tailed — motion-blur elongation and ball+hand/glove merged boxes
        // produce single-frame area spikes that an OLS fit lets dominate, while
        // the median slope ignores them up to ~29% contamination.
        let ts = samples.map { $0.0 }
        let ys = samples.map { 1.0 / sqrt(max($0.1, 1e-6)) }
        var pairSlopes: [Double] = []
        pairSlopes.reserveCapacity(samples.count * (samples.count - 1) / 2)
        for i in 0..<(samples.count - 1) {
            for j in (i + 1)..<samples.count where ts[j] != ts[i] {
                pairSlopes.append((ys[j] - ys[i]) / (ts[j] - ts[i]))
            }
        }
        guard !pairSlopes.isEmpty else { return (nil, "fallback_slope") }
        let slope = median(pairSlopes)  // d(1/√A)/dt; should be < 0 for approach
        let intercept = median((0..<samples.count).map { ys[$0] - slope * ts[$0] })

        // Approach means y is decreasing, so slope must be negative.
        guard slope < 0 else {
            NSLog("[BallSpeedCalculator] TTC fallback: non-negative inv-sqrt slope %.4g (ball not approaching)",
                  slope)
            return (nil, "fallback_slope")
        }

        // Zero-crossing of y(t) = slope·t + intercept is the modeled contact instant.
        let tContact = -intercept / slope
        let tFirst   = ts.first!
        let ttcFrames = tContact - tFirst

        guard ttcFrames > 0 else {
            NSLog("[BallSpeedCalculator] TTC fallback: non-positive ttcFrames=%.2f (tContact=%.2f, tFirst=%.2f)",
                  ttcFrames, tContact, tFirst)
            return (nil, "fallback_slope")
        }

        let ttcSec = ttcFrames / Double(fps)

        // Sanity: TTC should be 0.15s–2.0s for realistic pitching distances
        // (lowered lower bound from 0.2s to allow short backyard distances)
        guard ttcSec >= 0.15 && ttcSec <= 2.0 else {
            NSLog("[BallSpeedCalculator] TTC fallback: ttc=%.3fs outside [0.15,2.0]s", ttcSec)
            return (nil, "fallback_range")
        }

        NSLog("[BallSpeedCalculator] TTC estimate: %.3fs (invSqrtSlope=%.4g, tContact=%.2f, tFirst=%.2f, n=%d)",
              ttcSec, slope, tContact, tFirst, samples.count)
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
        lastBallFrameIdx: Int? = nil,
        ballSizePreFrames: Double? = nil
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
                lastBallFrameIdx: lastBallFrameIdx,
                ballSizePreFrames: ballSizePreFrames
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
        lastBallFrameIdx: Int?,
        ballSizePreFrames: Double? = nil
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

        var preDetectInfo: (sec: Double, source: String)? = nil
        let totalTime: Double
        if let ttc = ttcTime {
            // TTC gives time from first detection to contact.
            // Add pre-detection offset (release to firstBallFrame).
            let (preFrames, preSource) = estimateFramesElapsed(
                releaseFrameIdx: releaseFrameIdx,
                firstBallFrameIdx: firstBallFrameIdx,
                ballSizePreFrames: ballSizePreFrames
            )
            preDetectInfo = (preFrames / Double(fps), preSource)
            let rawTime = ttc + preFrames / Double(fps)
            totalTime = clampFlightTime(rawTime, distance: distance)
            NSLog("[BallSpeedCalculator] Using TTC: %.3fs + pre=%.3fs (%@) → total=%.3fs",
                  ttc, preFrames / Double(fps), preSource, totalTime)
        } else {
            totalTime = estimateFlightTime(
                numTrajectoryPoints: numFrames,
                releaseFrameIdx: releaseFrameIdx,
                firstBallFrameIdx: firstBallFrameIdx,
                lastBallFrameIdx: lastBallFrameIdx,
                ballSizePreFrames: ballSizePreFrames,
                preDetectInfo: &preDetectInfo
            )
        }

        let avgSpeedMs = distance / totalTime
        let avgSpeedKmh = avgSpeedMs * MS_TO_KMH

        // Release speed from the air resistance model v(t) = v0 / (1 + k·v0·t).
        // Integrating gives x(T) = ln(1 + k·v0·T)/k, so x(T) = D solves in closed
        // form — no simulation/binary search needed:
        //   v0 = (e^{k·D} − 1) / (k·T)
        let k = AIR_RESISTANCE_K
        var releaseSpeedMs = (exp(k * distance) - 1.0) / (k * totalTime)
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
        info.strideCorrectionM = applyStrideCorrection ? strideCorrectionM : 0
        info.flightTimeS = totalTime
        info.numFrames = numFrames
        info.calculationMethod = (ttcTime != nil) ? "ttc" : "theoretical"
        info.ttcStatus = ttcStatus
        info.preDetectSec = preDetectInfo?.sec
        info.preDetectSource = preDetectInfo?.source
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
