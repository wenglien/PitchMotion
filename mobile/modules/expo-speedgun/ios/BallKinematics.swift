import Foundation
import CoreGraphics

// MARK: - BallKinematics
//
// Computes ball displacement analytics on top of the speed pipeline.
//
// ### Definition (MLB Statcast style)
//
// "Break" is the difference between where a pitch actually crosses the plate
// and where it would have crossed if it continued in a straight line from
// the release point at the release direction.  This is essentially the
// Statcast "horizontal break" / "vertical break" definition, and is the
// only displacement metric that has a clean physical meaning from a single
// catcher-view camera.
//
// The previous implementation measured the maximum perpendicular deviation
// of the whole trajectory from its start→end chord — that number is mostly
// *perspective foreshortening* rather than real spin-induced movement, and
// produced wildly inflated results (hundreds of cm).  This file replaces
// that approach with the extrapolation-based measurement.
//
// ### Pipeline
//
//   1. Smooth the pixel trajectory (small moving-average).
//   2. Fit a straight line to the FIRST ~25 % of the flight — the "release
//      direction" in the image.  At this moment the ball is still far from
//      the camera so image foreshortening over such a short window is
//      minimal.
//   3. Extrapolate that line to the final frame of the trajectory.
//   4. The 2-D vector from the extrapolated endpoint to the measured catch
//      point is the break in pixels, split into horizontal / vertical.
//   5. Pixel → cm via the strike-zone calibration (MLB 43.18 cm wide), using
//      the video-frame normalised zone bounds the app already knows about.
//   6. Induced vertical break subtracts the expected gravity-only drop over
//      the flight time.  `+` means the ball stayed up (rise, backspin /
//      fastball), `−` means it dropped more than gravity alone (curveball).
//   7. Hard clamp the result to the empirically observed range for baseball
//      (roughly ±80 cm for extreme pitches) so a bad video geometry cannot
//      produce 300-cm garbage values.

struct BallKinematics {
    // Raw image-frame break (+right for H, +down for V).
    var horizontalBreakCm: Double = 0
    var verticalBreakCm: Double = 0
    var totalBreakCm: Double = 0
    var breakAngleDeg: Double = 0           // 0° = pure +horiz, 90° = pure +down

    // MLB-style "induced" vertical break (+ = up / rise, − = drop below gravity).
    var inducedVerticalBreakCm: Double = 0

    var breakConfidence: Double = 0         // 0..1
}

final class BallKinematicsAnalyzer {

    // Strike-zone real-world width (MLB rule book — 17 inches).
    private static let STRIKE_ZONE_WIDTH_CM: Double = 43.18
    // Approximate strike-zone height used as an independent vertical scale.
    // MLB strike zone varies by batter height; 50 cm is a safe average.
    private static let STRIKE_ZONE_HEIGHT_CM: Double = 50.0

    private static let GRAVITY: Double = 9.81

    // Real-world plausibility bounds — MLB extremes are roughly:
    //   Horizontal break  : ±50 cm  (slider / screwball peaks)
    //   Induced vertical  : ±50 cm  (rise of a 2700 rpm 4-seam ≈ +40 cm,
    //                                 big-curveball drop-below-gravity ≈ −45 cm)
    // We clamp a little wider (80 cm) so the user can still see that an
    // outlier pitch is "off the chart" without the number being outright
    // absurd.
    private static let BREAK_CLAMP_CM: Double = 80.0

    /// Main entry point.
    func analyze(
        trajectory: [CGPoint],
        speedInfo: SpeedInfo,
        frameWidth: Int,
        frameHeight: Int,
        zone: (xMin: Double, xMax: Double, yMin: Double, yMax: Double) = (
            STRIKE_ZONE_X_MIN,
            STRIKE_ZONE_X_MAX,
            STRIKE_ZONE_Y_MIN,
            STRIKE_ZONE_Y_MAX
        )
    ) -> BallKinematics {
        var out = BallKinematics()

        // Need a reasonable amount of flight to fit + extrapolate reliably.
        guard trajectory.count >= 8,
              let flightTime = speedInfo.flightTimeS,
              flightTime > 0.18,
              flightTime < 1.5 else {
            return out
        }

        // 1. Smooth pixel trajectory.
        let smoothed = smooth(trajectory, window: 3)
        let n = smoothed.count
        let xs = smoothed.map { Double($0.x) }
        let ys = smoothed.map { Double($0.y) }

        // 2. Pixel → centimetre calibration at plate plane.
        let zoneWidthPx  = (zone.xMax - zone.xMin) * Double(frameWidth)
        let zoneHeightPx = (zone.yMax - zone.yMin) * Double(frameHeight)
        guard zoneWidthPx > 20, zoneHeightPx > 20 else { return out }
        let cmPerPxX = Self.STRIKE_ZONE_WIDTH_CM  / zoneWidthPx
        let cmPerPxY = Self.STRIKE_ZONE_HEIGHT_CM / zoneHeightPx

        // 3. Fit a line to the first ~25 % of the trajectory (at least 4
        // points, at most 12) — this approximates the ball's release
        // direction in the image.
        let refCount = max(4, min(12, Int(Double(n) * 0.25)))
        let refIdx = Array(0..<refCount)
        let refXs = refIdx.map { xs[$0] }
        let refYs = refIdx.map { ys[$0] }
        // Index acts as our parameter t (frames are evenly spaced in time).
        let refTs = refIdx.map { Double($0) }

        let (slopeX, interceptX, r2X) = linearFit(refTs, refXs)
        let (slopeY, interceptY, r2Y) = linearFit(refTs, refYs)

        // If the release direction is noisy (very low R² on BOTH axes) we
        // cannot trust the extrapolation.
        let dirR2 = max(r2X, r2Y)
        guard dirR2 > 0.40 else { return out }

        // 4. Extrapolate that line all the way to the final trajectory
        // point, which we treat as "catch / plate" position.
        let finalT = Double(n - 1)
        let predictedX = slopeX * finalT + interceptX
        let predictedY = slopeY * finalT + interceptY
        let catchX = xs[n - 1]
        let catchY = ys[n - 1]

        // 5. Deviation in pixels → cm (using independent X/Y scales so a
        // non-square aspect ratio in the zone doesn't bias one axis).
        let devPxX = catchX - predictedX          // +right
        let devPxY = catchY - predictedY          // +down
        let breakHCm = devPxX * cmPerPxX          // + = right, − = left
        let breakVCm = devPxY * cmPerPxY          // + = drop, − = rise

        // 6. Induced vertical break: subtract the expected gravity drop over
        // the full flight time.  A zero-spin ball that leaves the hand along
        // the release direction would still drop `0.5·g·t²` below that line
        // purely from gravity, so the Magnus-only component is:
        //
        //     induced_up = gravity_drop − observed_drop_below_line
        //
        // All in cm.
        let gravityDropCm = 0.5 * Self.GRAVITY * flightTime * flightTime * 100.0
        let inducedUpCm = gravityDropCm - breakVCm

        // 7. Clamp to empirically sensible range (±BREAK_CLAMP_CM).  Track
        // whether clamping was necessary so confidence can reflect it.
        let clampedH = clampD(breakHCm, -Self.BREAK_CLAMP_CM, Self.BREAK_CLAMP_CM)
        let clampedV = clampD(breakVCm, -Self.BREAK_CLAMP_CM, Self.BREAK_CLAMP_CM)
        let clampedInduced = clampD(inducedUpCm, -Self.BREAK_CLAMP_CM, Self.BREAK_CLAMP_CM)
        let wasClamped =
            abs(clampedH - breakHCm) > 0.1 ||
            abs(clampedV - breakVCm) > 0.1 ||
            abs(clampedInduced - inducedUpCm) > 0.1

        out.horizontalBreakCm = clampedH
        out.verticalBreakCm = clampedV
        out.inducedVerticalBreakCm = clampedInduced
        out.totalBreakCm = sqrt(clampedH * clampedH + clampedInduced * clampedInduced)
        if abs(clampedH) > 1e-3 || abs(clampedInduced) > 1e-3 {
            // + in chart-space: +H = right, +V = up (induced)
            out.breakAngleDeg = atan2(-clampedInduced, clampedH) * 180.0 / .pi
        }

        // 8. Confidence: combines the release-direction fit quality, the
        // number of trajectory points, flight-time reasonability, and
        // whether we had to clamp.
        let fitScore = clampD((dirR2 - 0.4) / 0.55, 0.0, 1.0) // r2 ∈ [0.4,0.95] → 0..1
        let ptScore  = clampD(Double(n - 8) / 12.0, 0.1, 1.0)
        let ftScore  = clampD(1.0 - abs(flightTime - 0.5) / 0.6, 0.2, 1.0)
        let clipMult: Double = wasClamped ? 0.55 : 1.0
        out.breakConfidence = clampD(
            (0.45 * fitScore + 0.3 * ptScore + 0.25 * ftScore) * clipMult,
            0.0, 1.0
        )

        return out
    }

    // MARK: - Helpers

    private func smooth(_ pts: [CGPoint], window: Int = 3) -> [CGPoint] {
        guard pts.count >= 3 else { return pts }
        let half = window / 2
        var out: [CGPoint] = []
        out.reserveCapacity(pts.count)
        for i in 0..<pts.count {
            let lo = max(0, i - half)
            let hi = min(pts.count - 1, i + half)
            var sx = 0.0, sy = 0.0
            for j in lo...hi { sx += Double(pts[j].x); sy += Double(pts[j].y) }
            let c = Double(hi - lo + 1)
            out.append(CGPoint(x: sx / c, y: sy / c))
        }
        if !out.isEmpty {
            out[0] = pts.first!
            out[out.count - 1] = pts.last!
        }
        return out
    }

    /// Simple OLS linear fit.  Returns (slope, intercept, R²).
    private func linearFit(_ xs: [Double], _ ys: [Double]) -> (Double, Double, Double) {
        let n = Double(xs.count)
        guard n > 1 else { return (0, 0, 0) }
        let mx = xs.reduce(0, +) / n
        let my = ys.reduce(0, +) / n
        var sxx = 0.0, sxy = 0.0, syy = 0.0
        for i in 0..<xs.count {
            let dx = xs[i] - mx
            let dy = ys[i] - my
            sxx += dx * dx
            sxy += dx * dy
            syy += dy * dy
        }
        guard sxx > 1e-9 else { return (0, my, 0) }
        let slope = sxy / sxx
        let intercept = my - slope * mx
        let r2: Double = {
            guard syy > 1e-9 else { return 1.0 } // constant Y → perfect fit trivially
            return max(0.0, 1.0 - (syy - slope * sxy) / syy)
        }()
        return (slope, intercept, r2)
    }

    private func clampD(_ v: Double, _ lo: Double, _ hi: Double) -> Double {
        return max(lo, min(hi, v))
    }
}
