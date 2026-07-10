import Foundation
import CoreGraphics

// MARK: - Pitch Features
//
// Deeply-optimised feature set for rule-based pitch classification.
//   - Trajectory is smoothed (moving average, window 3) before measurement to
//     reduce detection jitter.
//   - Break is measured both overall AND separately for the early (0–40 %)
//     vs late (60–100 %) portions of the flight, giving us a "late-break
//     ratio" — the key discriminator between fastball and breaking pitches.
//   - Direction-change is computed with proper 360° wrap correction.
//   - Linearity (R²) is computed internally when not supplied upstream.
//   - Velocity drop uses (release → average) relative ratio, independent of
//     the absolute km/h (crucial for amateur radar noise).

struct PitchFeatures {
    // ── Speed ──
    var speedKmh: Double = 0
    var speedDropRatio: Double = 0

    // ── Overall break (signed deviation from straight start→end line) ──
    var lateralBreak: Double = 0       // + = right, − = left
    var verticalBreak: Double = 0      // + = down, − = up (image coords)
    var breakMagnitude: Double = 0     // sqrt(lateral² + vertical²)
    var breakAngleDeg: Double = 0

    // ── Temporal break (early vs late flight) ──
    var earlyBreakX: Double = 0        // max |dev_x| in first 40 %
    var lateBreakX: Double = 0         // max |dev_x| in last  40 %
    var earlyBreakY: Double = 0
    var lateBreakY: Double = 0
    var lateBreakRatio: Double = 1.0   // late / early total — > 1 means late-breaking

    // ── Curvature (quadratic coefficients) ──
    var curveCoefX: Double = 0
    var curveCoefY: Double = 0

    // ── Directional change (wrap-corrected, absolute degrees) ──
    var directionChangeDeg: Double = 0

    // ── Trajectory linearity (R² of straight-line fit, 1.0 = perfect line) ──
    var trajectoryLinearity: Double = 1.0

    // ── Meta ──
    var nTrajectoryPoints: Int = 0
    var hasReliableSpeed: Bool = false
}

final class PitchFeatureExtractor {
    let frameWidth: Int
    let frameHeight: Int
    let fps: Int

    init(frameWidth: Int, frameHeight: Int, fps: Int = 120) {
        self.frameWidth = frameWidth
        self.frameHeight = frameHeight
        self.fps = fps
    }

    func extract(trajectory: [CGPoint], speedInfo: SpeedInfo) -> PitchFeatures? {
        guard trajectory.count >= 4 else { return nil }

        // Smooth to suppress detection jitter (keep raw endpoints stable).
        let smoothed = smooth(trajectory, window: 3)
        let n = smoothed.count
        guard n >= 4 else { return nil }

        var f = PitchFeatures(nTrajectoryPoints: n)

        // ── Speed ──
        let release = speedInfo.releaseSpeedKmh ?? 0
        let initial = speedInfo.initialSpeedKmh ?? 0
        let average = speedInfo.averageSpeedKmh ?? 0
        f.speedKmh = [release, initial, average].first(where: { $0 > 0 }) ?? 0
        f.hasReliableSpeed = f.speedKmh >= 50 && f.speedKmh <= 200
        let base = initial > 0 ? initial : f.speedKmh
        let refAvg = average > 0 ? average : f.speedKmh
        if base > 1 {
            f.speedDropRatio = max(0, (base - refAvg) / base)
        }

        // ── Normalise to frame (0-1) ──
        let xs = smoothed.map { Double($0.x) / Double(frameWidth) }
        let ys = smoothed.map { Double($0.y) / Double(frameHeight) }
        let ts = (0..<n).map { Double($0) / Double(max(1, n - 1)) }

        // ── Overall break: deviation from start→end line ──
        let sx = xs[0], ex = xs[n - 1]
        let sy = ys[0], ey = ys[n - 1]
        var devX = [Double](repeating: 0, count: n)
        var devY = [Double](repeating: 0, count: n)
        var maxAbsDevX = 0.0, signedMaxDevX = 0.0
        var maxAbsDevY = 0.0, signedMaxDevY = 0.0
        for i in 0..<n {
            let lx = sx + ts[i] * (ex - sx)
            let ly = sy + ts[i] * (ey - sy)
            devX[i] = xs[i] - lx
            devY[i] = ys[i] - ly
            if abs(devX[i]) > maxAbsDevX { maxAbsDevX = abs(devX[i]); signedMaxDevX = devX[i] }
            if abs(devY[i]) > maxAbsDevY { maxAbsDevY = abs(devY[i]); signedMaxDevY = devY[i] }
        }
        f.lateralBreak = signedMaxDevX
        f.verticalBreak = signedMaxDevY
        f.breakMagnitude = sqrt(signedMaxDevX * signedMaxDevX + signedMaxDevY * signedMaxDevY)
        if abs(f.lateralBreak) > 1e-6 || abs(f.verticalBreak) > 1e-6 {
            f.breakAngleDeg = atan2(f.verticalBreak, f.lateralBreak) * 180.0 / .pi
        }

        // ── Temporal (early vs late) ──
        let earlyEnd = max(2, Int(Double(n) * 0.40))
        let lateStart = min(n - 2, Int(Double(n) * 0.60))
        f.earlyBreakX = maxAbs(devX[0..<earlyEnd])
        f.earlyBreakY = maxAbs(devY[0..<earlyEnd])
        if lateStart < n {
            f.lateBreakX = maxAbs(devX[lateStart..<n])
            f.lateBreakY = maxAbs(devY[lateStart..<n])
        }
        let earlyTotal = f.earlyBreakX + f.earlyBreakY + 1e-5
        let lateTotal = f.lateBreakX + f.lateBreakY + 1e-5
        f.lateBreakRatio = lateTotal / earlyTotal

        // ── Curvature ──
        let coefX = polyfit(ts, xs, degree: 2)
        let coefY = polyfit(ts, ys, degree: 2)
        if coefX.count >= 3 { f.curveCoefX = coefX[0] }
        if coefY.count >= 3 { f.curveCoefY = coefY[0] }

        // ── Direction change (mid-split + 360° wrap) ──
        if n >= 3 {
            let mid = n / 2
            let dx1 = xs[mid] - xs[0]
            let dy1 = ys[mid] - ys[0]
            let dx2 = xs[n - 1] - xs[mid]
            let dy2 = ys[n - 1] - ys[mid]
            // Only meaningful if both halves have enough length
            let len1 = hypot(dx1, dy1)
            let len2 = hypot(dx2, dy2)
            if len1 > 1e-4 && len2 > 1e-4 {
                let a1 = atan2(dy1, dx1) * 180.0 / .pi
                let a2 = atan2(dy2, dx2) * 180.0 / .pi
                var diff = a2 - a1
                while diff > 180 { diff -= 360 }
                while diff < -180 { diff += 360 }
                f.directionChangeDeg = abs(diff)
            }
        }

        // ── Linearity: prefer upstream, else compute R² ──
        if let lin = speedInfo.trajectoryLinearity, lin > 0 {
            f.trajectoryLinearity = lin
        } else {
            f.trajectoryLinearity = computeLinearityR2(xs: xs, ys: ys)
        }

        return f
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
            for j in lo...hi {
                sx += Double(pts[j].x)
                sy += Double(pts[j].y)
            }
            let c = Double(hi - lo + 1)
            out.append(CGPoint(x: sx / c, y: sy / c))
        }
        // Keep the true endpoints so break measured from start→end line remains anchored.
        if !out.isEmpty {
            out[0] = pts.first!
            out[out.count - 1] = pts.last!
        }
        return out
    }

    private func maxAbs(_ slice: ArraySlice<Double>) -> Double {
        var m = 0.0
        for v in slice { if abs(v) > m { m = abs(v) } }
        return m
    }

    private func computeLinearityR2(xs: [Double], ys: [Double]) -> Double {
        let n = xs.count
        guard n >= 3 else { return 1.0 }
        // Parametric linearity: fit y vs. arc-length index to account for both axes.
        // Equivalently: R² of least-squares line through (xs, ys) points.
        let mx = xs.reduce(0, +) / Double(n)
        let my = ys.reduce(0, +) / Double(n)
        var sxx = 0.0, syy = 0.0, sxy = 0.0
        for i in 0..<n {
            let dx = xs[i] - mx
            let dy = ys[i] - my
            sxx += dx * dx
            syy += dy * dy
            sxy += dx * dy
        }
        if sxx < 1e-9 || syy < 1e-9 { return 1.0 }
        let r = sxy / sqrt(sxx * syy)
        return max(0.0, min(1.0, r * r))
    }
}

// MARK: - Rule-Based Classifier (Gaussian-soft scoring)

/// Rule-based pitch classifier using smooth (Gaussian/sigmoid) feature
/// responses instead of hard thresholds, plus a margin-based confidence.
final class RuleBasedPitchClassifier {

    /// Returns (best type, confidence ∈ [0,1], per-class scores).
    func classify(_ features: PitchFeatures) -> (type: String, confidence: Double, scores: [String: Double]) {
        let scores: [String: Double] = [
            "Fastball":  scoreFastball(features),
            "Curveball": scoreCurveball(features),
            "Slider":    scoreSlider(features),
            "Changeup":  scoreChangeup(features),
        ]

        // Minimum quality gate
        guard features.nTrajectoryPoints >= 4 else {
            return ("Unknown", 0, scores)
        }

        // Pick top-1 and top-2 for margin-based confidence
        let sorted = scores.sorted { $0.value > $1.value }
        let best = sorted[0]
        let second = sorted.count > 1 ? sorted[1].value : 0.0

        // If no class scored high enough, give up — prevents false "Fastball".
        if best.value < 2.0 { return ("Unknown", 0, scores) }

        let totalPos = scores.values.reduce(0) { $0 + max(0, $1) } + 1e-6
        let softmaxish = max(0, best.value) / totalPos   // 0…1, relative dominance
        let margin = (best.value - second) / max(1e-6, best.value)  // 0…1, separation

        // Blend: dominance counts a bit more than margin.
        let confidence = max(0, min(1, 0.6 * softmaxish + 0.4 * margin))

        return (best.key, confidence, scores)
    }

    // MARK: - Soft response helpers

    /// Gaussian bump centred at `mean`, σ = `stdev`. Returns 0…1.
    private func bump(_ x: Double, mean: Double, stdev: Double) -> Double {
        let d = (x - mean) / max(1e-6, stdev)
        return exp(-0.5 * d * d)
    }

    /// Sigmoid response — 0.5 at `center`, smoothly saturating over `scale`.
    private func rise(_ x: Double, center: Double, scale: Double) -> Double {
        let z = (x - center) / max(1e-6, scale)
        return 1.0 / (1.0 + exp(-z))
    }

    // MARK: - Scoring Functions
    //
    // Each returns 0…~10. Targets are chosen so that a "textbook" pitch of the
    // given type scores ~7–9 while ambiguous cases land in 2–4 so that the
    // margin-based confidence stays honest.

    private func scoreFastball(_ f: PitchFeatures) -> Double {
        var s = 0.0
        let totalBreak = abs(f.lateralBreak) + abs(f.verticalBreak)

        // Very straight path (total break near 0)
        s += 3.0 * bump(totalBreak, mean: 0.02, stdev: 0.03)

        // High linearity
        s += 2.5 * bump(f.trajectoryLinearity, mean: 0.98, stdev: 0.05)

        // Low curvature
        let curveTotal = abs(f.curveCoefX) + abs(f.curveCoefY)
        s += 1.5 * bump(curveTotal, mean: 0.05, stdev: 0.18)

        // Low speed-drop ratio (no fade)
        s += 1.0 * bump(f.speedDropRatio, mean: 0.0, stdev: 0.08)

        // Speed prior (high): applies only if speed is reliable.
        if f.hasReliableSpeed {
            // ≥130 km/h starts to clearly favour fastball; peaks at 155.
            s += 2.5 * rise(f.speedKmh, center: 128, scale: 9)
        }

        // NOT late-breaking
        s += 1.0 * bump(f.lateBreakRatio, mean: 1.0, stdev: 0.8)

        // Small direction change
        s += 0.8 * bump(f.directionChangeDeg, mean: 0.0, stdev: 6.0)

        return s
    }

    private func scoreCurveball(_ f: PitchFeatures) -> Double {
        var s = 0.0
        let absLat = abs(f.lateralBreak)
        let absVert = abs(f.verticalBreak)

        // Significant downward drop (y+ is down in image coords)
        //   Only counts genuine drop, not noise.
        if f.verticalBreak > 0 {
            s += 3.0 * rise(f.verticalBreak, center: 0.030, scale: 0.015)
        }

        // Vertical break >> lateral break
        let vl = absVert / max(absLat, 0.005)
        s += 2.0 * rise(vl, center: 1.1, scale: 0.45)

        // Strong vertical curvature
        s += 2.0 * rise(abs(f.curveCoefY), center: 0.22, scale: 0.12)

        // Clear direction change
        s += 2.0 * rise(f.directionChangeDeg, center: 10.0, scale: 4.5)

        // Late-breaking: curveballs drop hardest in the back half
        s += 1.5 * rise(f.lateBreakRatio, center: 1.5, scale: 0.5)

        // Late vertical travel should exceed early vertical travel
        let lateToEarlyY = f.lateBreakY / max(f.earlyBreakY, 1e-4)
        s += 1.0 * rise(lateToEarlyY, center: 1.3, scale: 0.5)

        // Speed prior (moderate-slow)
        if f.hasReliableSpeed {
            s += 2.0 * bump(f.speedKmh, mean: 115.0, stdev: 15.0)
        }

        // Penalty — if the path is extremely straight, curveball is unlikely.
        if f.trajectoryLinearity > 0.985 { s -= 1.5 }

        return s
    }

    private func scoreSlider(_ f: PitchFeatures) -> Double {
        var s = 0.0
        let absLat = abs(f.lateralBreak)
        let absVert = abs(f.verticalBreak)

        // Significant lateral break
        s += 3.0 * rise(absLat, center: 0.028, scale: 0.015)

        // Lateral > vertical (key slider trait)
        let lv = absLat / max(absVert, 0.005)
        s += 2.0 * rise(lv, center: 1.0, scale: 0.4)

        // Break angle is "horizontal-ish" — shallow absolute angle
        let absAngle = abs(f.breakAngleDeg)
        // Peak at ~15°, falls off past ~55°
        s += 1.5 * bump(absAngle, mean: 15.0, stdev: 20.0)

        // Lateral curvature
        s += 1.5 * rise(abs(f.curveCoefX), center: 0.15, scale: 0.10)

        // Moderate direction change (sliders have sharper late break than curves)
        s += 1.2 * bump(f.directionChangeDeg, mean: 14.0, stdev: 6.0)

        // Late-breaking too
        s += 1.0 * rise(f.lateBreakRatio, center: 1.3, scale: 0.4)

        // Late lateral travel dominates early lateral travel
        let lateToEarlyX = f.lateBreakX / max(f.earlyBreakX, 1e-4)
        s += 1.0 * rise(lateToEarlyX, center: 1.4, scale: 0.5)

        // Speed prior (moderate)
        if f.hasReliableSpeed {
            s += 1.5 * bump(f.speedKmh, mean: 128.0, stdev: 12.0)
        }

        // Penalty — sliders shouldn't drop like a curve.
        if f.verticalBreak > 0.05 && absLat < 0.015 { s -= 1.5 }

        return s
    }

    private func scoreChangeup(_ f: PitchFeatures) -> Double {
        var s = 0.0
        let totalBreak = abs(f.lateralBreak) + abs(f.verticalBreak)

        // Moderate break (not as straight as fastball, not as big as curve)
        s += 2.0 * bump(totalBreak, mean: 0.04, stdev: 0.035)

        // Linearity typically slightly below fastball
        s += 1.5 * bump(f.trajectoryLinearity, mean: 0.94, stdev: 0.05)

        // Distinct speed drop during flight (fade)
        s += 2.5 * bump(f.speedDropRatio, mean: 0.14, stdev: 0.06)

        // Moderate speed (usually 10–15 % slower than fastball).
        if f.hasReliableSpeed {
            s += 1.5 * bump(f.speedKmh, mean: 120.0, stdev: 12.0)
        }

        // Not strongly late-breaking
        s += 0.8 * bump(f.lateBreakRatio, mean: 1.1, stdev: 0.7)

        // Small direction change
        s += 0.8 * bump(f.directionChangeDeg, mean: 3.0, stdev: 5.0)

        return s
    }
}
