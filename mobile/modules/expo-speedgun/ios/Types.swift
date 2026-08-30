import Foundation
import CoreGraphics

// MARK: - Constants

let MS_TO_KMH: Double = 3.6
let KMH_TO_MPH: Double = 0.621371
let MLB_MOUND_DISTANCE_M: Double = 18.44
let MIN_MANUAL_MOUND_DISTANCE_M: Double = 3.0
let MAX_MANUAL_MOUND_DISTANCE_M: Double = 30.0

// Strike-zone bounds in display-normalized coordinates for MLB-style umpire POV.
// Keep these in sync with research/vision/get_pitch_frames_yolov8.py and the React
// StrikeZone defaults so analysis, overlay, and result charts agree.
let STRIKE_ZONE_X_MIN: Double = 0.33
let STRIKE_ZONE_X_MAX: Double = 0.67
let STRIKE_ZONE_Y_MIN: Double = 0.59
let STRIKE_ZONE_Y_MAX: Double = 0.83
let ABS_STRIKE_ZONE_WIDTH_M: Double = 0.4318
let ABS_STRIKE_ZONE_BOTTOM_RATIO: Double = 0.27
let ABS_STRIKE_ZONE_TOP_RATIO: Double = 0.535
let LEGACY_STRIKE_ZONE_HEIGHT_M: Double = 0.58
let ABS_STRIKE_ZONE_RULE: String = "MLB_ABS_2026"

let DEFAULT_STRIKE_ZONE: [String: Double] = [
    "x_min": STRIKE_ZONE_X_MIN,
    "x_max": STRIKE_ZONE_X_MAX,
    "y_min": STRIKE_ZONE_Y_MIN,
    "y_max": STRIKE_ZONE_Y_MAX,
]

// MARK: - Detection Filter Constants (from research/vision/get_pitch_frames_yolov8.py)

let MAX_AREA_RATIO: Double = 0.015
let MAX_ASPECT_RATIO: Double = 4.0
let MIN_CONFIDENCE: Double = 0.05
let BOTTOM_EXCLUSION: Double = 0.05
let TOP_EXCLUSION: Double = 0.02

// Phase 1 detection
let P1_IMGSZ_SEARCH: Int = 640
let P1_IMGSZ_FLIGHT: Int = 1280
let P1_STRIDE_SEARCH: Int = 3
let P1_STRIDE_FLIGHT: Int = 1
let P1_CONSECUTIVE_BALL_THRESHOLD: Int = 3

// Catch extension
let CATCH_EXTRAP_LARGE_AREA_PX2: Double = 12000
let CATCH_EXTENSION_MAX_FRAMES: Int = 40
let CATCH_EXTENSION_MIN_CONF: Double = 0.05
let CATCH_EXTENSION_AREA_DECAY: Double = 0.8
let CATCH_EXTENSION_MAX_JUMP: Double = 600.0
let CATCH_EXTENSION_LARGE_AREA_JUMP: Double = 2000.0
let CATCH_EXTENSION_LARGE_AREA_THRESHOLD: Double = 3000.0

// Static false positive filter
let HC_STATIC_MIN_PERSIST: Int = 6
let HC_STATIC_RADIUS: Double = 150.0
let HC_STATIC_MIN_CONF: Double = 0.35

// Distance estimation from pose shoulder width
// Average adult male biacromial (shoulder-to-shoulder) width ≈ 0.44m
// Combined pitcher+catcher distance: pitcher-to-plate = mound distance (e.g. 18.44m)
// but camera-to-pitcher varies. We estimate camera-to-pitcher from shoulder pixel width,
// then add a fixed pitcher-to-plate offset derived from the aspect ratio of the scene.
let SHOULDER_WIDTH_M: Double = 0.44       // average biacromial breadth
let IPHONE_FOCAL_LENGTH_PX_1080: Double = 1580.0  // ~28mm equiv on 1080p iPhone wide cam
let BASEBALL_DIAMETER_M: Double = 0.074   // regulation baseball: 73–75mm
// Scaling factor to convert camera-to-pitcher distance to total pitch distance.
// Empirically: camera is ~1.5–3m behind the catcher; pitcher mound is ~18m from plate.
// We model: pitchDist ≈ camToPitcher × PITCH_DIST_SCALE_FACTOR
// Tuned so that at typical backyard distances (~5–8m cam-to-pitcher) we get ~10–14m pitch dist.
let POSE_DIST_MIN_M: Double = 3.0   // clamp estimated distance to sane range (backyard ≥3m)
let POSE_DIST_MAX_M: Double = 25.0

// Speed calculator constants
let AIR_RESISTANCE_K: Double = 0.0024
let AIR_RESISTANCE_DECAY: Double = 0.01
let MAX_REASONABLE_SPEED_KMH: Double = 200
let RELEASE_FALLBACK_SEC: Double = 0.25   // YOLO often detects 0.2–0.3s after actual release in catcher POV
// Max gap between pose-based release frame and first ball detection.
// Raised to 0.70s (was 0.50s) for high-fps slo-mo: at 120fps the arm-extension
// window stretches in wall-clock time and tight gating rejected valid releases.
let MAX_PRE_DETECT_SEC: Double = 0.70
let MIN_PIXEL_DIST: Double = 10
let DEFAULT_STRIDE_CORRECTION: Double = 1.7
let MIN_FLIGHT_TIME_SEC: Double = 0.30
let MIN_REASONABLE_SPEED_MS: Double = 15.0  // ~54 km/h, lowest youth pitch
let MAX_REASONABLE_SPEED_MS: Double = 47.0  // ~169 km/h, MLB max

let PERSPECTIVE_NEAR_FACTOR: Double = 1.15
let PERSPECTIVE_RANGE: Double = 0.30

// Kalman ROI recovery
let KALMAN_ROI_SIZE: Int = 160
let KALMAN_ROI_MIN_CONF: Double = 0.03

// Overlay
let DEFAULT_OUTPUT_SCALE: Double = 0.75

// Synthetic trajectory completion for the analysis overlay. YOLO can miss the
// ball through motion blur or near the glove, so the overlay fills short visual
// gaps from the selected track instead of drawing a broken trail.
let TRAJECTORY_COMPLETION_MAX_GAP_SEC: Double = 0.90
let TRAJECTORY_ENDPOINT_MAX_SEC: Double = 0.35

// MARK: - Data Structures

/// Single ball detection from YOLO
struct BallDetection {
    let cx: Double          // center x in display coords
    let cy: Double          // center y in display coords
    let width: Double       // bbox width
    let height: Double      // bbox height
    let confidence: Double
    let area: Double        // bbox area in pixels²
    let frameIndex: Int

    var x1: Double { cx - width / 2 }
    var y1: Double { cy - height / 2 }
    var x2: Double { cx + width / 2 }
    var y2: Double { cy + height / 2 }
    var center: CGPoint { CGPoint(x: cx, y: cy) }
    var bbox: (Double, Double, Double, Double) { (x1, y1, x2, y2) }
}

/// Pose landmark positions for a single frame
struct PoseLandmarks {
    let frameIndex: Int
    let leftShoulder: CGPoint?
    let rightShoulder: CGPoint?
    let leftElbow: CGPoint?
    let rightElbow: CGPoint?
    let leftWrist: CGPoint?
    let rightWrist: CGPoint?
    let leftHip: CGPoint?
    let rightHip: CGPoint?
    let leftKnee: CGPoint?
    let rightKnee: CGPoint?
    let leftAnkle: CGPoint?
    let rightAnkle: CGPoint?

    /// Approximate index finger tip from wrist + offset
    var leftIndexTip: CGPoint? {
        guard let w = leftWrist, let e = leftElbow else { return nil }
        let dx = w.x - e.x
        let dy = w.y - e.y
        let len = sqrt(dx * dx + dy * dy)
        guard len > 1 else { return w }
        let scale: CGFloat = 0.3 // ~15cm / 50cm forearm
        return CGPoint(x: w.x + dx * scale, y: w.y + dy * scale)
    }

    var rightIndexTip: CGPoint? {
        guard let w = rightWrist, let e = rightElbow else { return nil }
        let dx = w.x - e.x
        let dy = w.y - e.y
        let len = sqrt(dx * dx + dy * dy)
        guard len > 1 else { return w }
        let scale: CGFloat = 0.3
        return CGPoint(x: w.x + dx * scale, y: w.y + dy * scale)
    }
}

/// Frame info for the tracking pipeline (mirrors Python FrameInfo)
struct FrameInfo {
    var ballInFrame: Bool
    var ballCenter: CGPoint  // (cx, cy) in display coords
    var ballColor: (UInt8, UInt8, UInt8) // RGB
    var ballLostTracking: Bool
    var frameIndex: Int
    /// Physical capture-time seconds from the first video sample. For slow-motion
    /// clips this differs from presentation/playback time.
    var captureTimeS: Double
    /// AVFoundation presentation timestamp seconds from the first video sample.
    /// Kept separately so audio can be aligned on the playback timeline.
    var presentationTimeS: Double
    /// True only for an optical-flow frame inserted between two decoded samples.
    /// These frames may help visual tracking but must never become timing evidence.
    var isInterpolated: Bool
    var poseLandmarks: PoseLandmarks?
    var ballArea: Double     // bbox area in px² (0 if unknown)

    init(
        frameIndex: Int,
        captureTimeS: Double = 0,
        presentationTimeS: Double = 0,
        isInterpolated: Bool = false
    ) {
        self.ballInFrame = false
        self.ballCenter = .zero
        self.ballColor = (255, 30, 30)
        self.ballLostTracking = false
        self.frameIndex = frameIndex
        self.captureTimeS = captureTimeS
        self.presentationTimeS = presentationTimeS
        self.isInterpolated = isInterpolated
        self.poseLandmarks = nil
        self.ballArea = 0
    }
}

/// Raw detection per frame (for Phase 2 / extension)
struct RawDetection {
    let frameIndex: Int
    let detections: [BallDetection]
}

/// SORT track result
struct TrackPoint {
    let frameIndex: Int
    let cx: Double
    let cy: Double
    let area: Double
    let trackId: Int
}

/// Speed calculation result (mirrors Python SpeedInfo)
struct SpeedInfo {
    var releaseSpeedKmh: Double?
    var initialSpeedKmh: Double?
    var maxSpeedKmh: Double?
    var averageSpeedKmh: Double?
    var totalDistanceM: Double?
    var effectiveDistanceM: Double?
    var moundDistanceM: Double?
    var strideCorrectionM: Double?
    var flightTimeS: Double?
    var numFrames: Int?
    var calculationMethod: String?
    var releasePoint: CGPoint?
    var catchPoint: CGPoint?
    var trajectoryLinearity: Double?
    var trajectoryQualityWarning: Bool?
    var error: String?
    var physicsClamped: Bool = false

    // Pitch classification
    var pitchType: String?
    var pitchConfidence: Double?

    // Pitch location
    var plateXNorm: Double?
    var plateYNorm: Double?
    var pitchLocX: Double?
    var pitchLocY: Double?
    var isStrike: Bool?
    var plateZone: [String: Double]?
    var batterHeightM: Double?
    var strikeZoneWidthCm: Double?
    var strikeZoneHeightCm: Double?
    var strikeZoneRule: String?

    // Ball displacement / break (cm)
    var horizontalBreakCm: Double?
    var verticalBreakCm: Double?           // image-frame; +down
    var inducedVerticalBreakCm: Double?    // MLB-style; +up (gravity removed)
    var totalBreakCm: Double?
    var breakAngleDeg: Double?
    var breakConfidence: Double?
    var breakGravityDropCm: Double?
    var breakFitR2: Double?
    var breakEndpointSource: String?
    var breakSamples: Int?
    var breakActualSampleRatio: Double?
    var breakCmPerPxX: Double?
    var breakCmPerPxY: Double?

    // Distance estimation
    var estimatedDistanceM: Double?   // non-nil when auto-estimated from pose
    var distanceSource: String?       // "manual" | "pose_estimated" | "default"
    var distanceWarning: String?      // user-facing warning when distance was auto-guessed
    var ttcStatus: String?            // "used" | "rejected_clamped" | "rejected_short_vs_endpoint" | "fallback_*"
    var flightTimeSource: String?     // "ttc" | "visual_endpoint" | "release_endpoint" | "point_count"
    var ttcFlightTimeS: Double?
    var visualFlightTimeS: Double?
    var releaseFrameIdx: Int?
    var releaseFrameSource: String?   // "pose" | "pose_refined" | "fallback"
    var firstBallFrameIdx: Int?
    var catchFrameIdx: Int?
    var releaseTimeS: Double?
    var firstBallTimeS: Double?
    var catchTimeS: Double?

    // Pre-detect gap (release → first YOLO detection) used in flight time
    var preDetectSec: Double?
    var preDetectSource: String?      // "pose" | "ball_size" | "fixed"

    // Catch point provenance
    var catchPointSource: String?     // "last_detection" | "extrapolated_audio" | "extrapolated_band" (+"+glove" when blended)
    var catchPointConfidence: Double?
    var plateFitErrorPx: Double?
    var plateExtrapolatedFrames: Double?
    var glovePoint: CGPoint?          // catcher wrist near catch frame, when detected

    /// Convert to dictionary for JS bridge
    func toDictionary() -> [String: Any] {
        var dict: [String: Any] = [:]
        if let v = releaseSpeedKmh { dict["release_speed_kmh"] = v }
        if let v = initialSpeedKmh { dict["initial_speed_kmh"] = v }
        if let v = maxSpeedKmh { dict["max_speed_kmh"] = v }
        if let v = averageSpeedKmh { dict["average_speed_kmh"] = v }
        if let v = totalDistanceM { dict["total_distance_m"] = v }
        if let v = effectiveDistanceM { dict["effective_distance_m"] = v }
        if let v = moundDistanceM { dict["mound_distance_m"] = v }
        if let v = strideCorrectionM { dict["stride_correction_m"] = v }
        if let v = flightTimeS { dict["flight_time_s"] = v }
        if let v = numFrames { dict["num_frames"] = v }
        if let v = calculationMethod { dict["calculation_method"] = v }
        if let v = trajectoryLinearity { dict["trajectory_linearity"] = v }
        if let v = trajectoryQualityWarning { dict["trajectory_quality_warning"] = v }
        if let v = error { dict["error"] = v }
        dict["physics_clamped"] = physicsClamped
        if let v = pitchType { dict["pitch_type"] = v }
        if let v = pitchConfidence { dict["pitch_confidence"] = v }
        if let rp = releasePoint {
            dict["release_point"] = ["x": Int(rp.x), "y": Int(rp.y)]
        }
        if let cp = catchPoint {
            dict["catch_point"] = ["x": Int(cp.x), "y": Int(cp.y)]
        }
        if let v = plateXNorm { dict["plate_x_norm"] = v }
        if let v = plateYNorm { dict["plate_y_norm"] = v }
        if let v = pitchLocX { dict["pitch_loc_x"] = v }
        if let v = pitchLocY { dict["pitch_loc_y"] = v }
        if let v = isStrike { dict["is_strike"] = v }
        if let v = plateZone { dict["plate_zone"] = v }
        if let v = batterHeightM { dict["batter_height_m"] = v }
        if let v = strikeZoneWidthCm { dict["strike_zone_width_cm"] = v }
        if let v = strikeZoneHeightCm { dict["strike_zone_height_cm"] = v }
        if let v = strikeZoneRule { dict["strike_zone_rule"] = v }
        if let v = horizontalBreakCm { dict["horizontal_break_cm"] = v }
        if let v = verticalBreakCm { dict["vertical_break_cm"] = v }
        if let v = inducedVerticalBreakCm { dict["induced_vertical_break_cm"] = v }
        if let v = totalBreakCm { dict["total_break_cm"] = v }
        if let v = breakAngleDeg { dict["break_angle_deg"] = v }
        if let v = breakConfidence { dict["break_confidence"] = v }
        if let v = breakGravityDropCm { dict["break_gravity_drop_cm"] = v }
        if let v = breakFitR2 { dict["break_fit_r2"] = v }
        if let v = breakEndpointSource { dict["break_endpoint_source"] = v }
        if let v = breakSamples { dict["break_samples"] = v }
        if let v = breakActualSampleRatio { dict["break_actual_sample_ratio"] = v }
        if let v = breakCmPerPxX { dict["break_cm_per_px_x"] = v }
        if let v = breakCmPerPxY { dict["break_cm_per_px_y"] = v }
        if let v = estimatedDistanceM { dict["estimated_distance_m"] = v }
        if let v = distanceSource { dict["distance_source"] = v }
        if let v = distanceWarning { dict["distance_warning"] = v }
        if let v = ttcStatus { dict["ttc_status"] = v }
        if let v = flightTimeSource { dict["flight_time_source"] = v }
        if let v = ttcFlightTimeS { dict["ttc_flight_time_s"] = v }
        if let v = visualFlightTimeS { dict["visual_flight_time_s"] = v }
        if let v = releaseFrameIdx { dict["release_frame_idx"] = v }
        if let v = releaseFrameSource { dict["release_frame_source"] = v }
        if let v = firstBallFrameIdx { dict["first_ball_frame_idx"] = v }
        if let v = catchFrameIdx { dict["catch_frame_idx"] = v }
        if let v = releaseTimeS { dict["release_time_s"] = v }
        if let v = firstBallTimeS { dict["first_ball_time_s"] = v }
        if let v = catchTimeS { dict["catch_time_s"] = v }
        if let v = preDetectSec { dict["pre_detect_sec"] = v }
        if let v = preDetectSource { dict["pre_detect_source"] = v }
        if let v = catchPointSource { dict["catch_point_source"] = v }
        if let v = catchPointConfidence { dict["catch_point_confidence"] = v }
        if let v = plateFitErrorPx { dict["plate_fit_error_px"] = v }
        if let v = plateExtrapolatedFrames { dict["plate_extrapolated_frames"] = v }
        if let gp = glovePoint {
            dict["glove_point"] = ["x": Int(gp.x), "y": Int(gp.y)]
        }
        return dict
    }
}

/// Pipeline progress event
struct PipelineProgress {
    let stage: String
    let progress: Double  // 0.0-1.0
    let message: String
}

// MARK: - Helper Math

func euclideanDistance(_ a: CGPoint, _ b: CGPoint) -> Double {
    return sqrt(Double((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y)))
}

func clamp<T: Comparable>(_ value: T, min lo: T, max hi: T) -> T {
    return max(lo, min(hi, value))
}

/// Simple median for [Double]
func median(_ values: [Double]) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let n = sorted.count
    if n % 2 == 0 {
        return (sorted[n/2 - 1] + sorted[n/2]) / 2.0
    } else {
        return sorted[n/2]
    }
}

/// Polynomial evaluation: coeffs[0]*x^n + coeffs[1]*x^(n-1) + ... + coeffs[n]
func polyval(_ coeffs: [Double], _ x: Double) -> Double {
    var result = 0.0
    for c in coeffs {
        result = result * x + c
    }
    return result
}

/// Least squares polynomial fit (degree 1 or 2)
func polyfit(_ xs: [Double], _ ys: [Double], degree: Int) -> [Double] {
    let n = xs.count
    guard n > degree else { return Array(repeating: 0, count: degree + 1) }

    if degree == 1 {
        // Linear fit: y = a*x + b
        let sumX = xs.reduce(0, +)
        let sumY = ys.reduce(0, +)
        let sumXX = xs.reduce(0) { $0 + $1 * $1 }
        let sumXY = zip(xs, ys).reduce(0) { $0 + $1.0 * $1.1 }
        let nD = Double(n)
        let det = nD * sumXX - sumX * sumX
        guard abs(det) > 1e-12 else { return [0, sumY / nD] }
        let a = (nD * sumXY - sumX * sumY) / det
        let b = (sumY - a * sumX) / nD
        return [a, b]
    }

    if degree == 2 {
        // Quadratic fit: y = a*x² + b*x + c
        // Normal equations: X^T X * [a,b,c]^T = X^T y
        var S = Array(repeating: 0.0, count: 5)  // sum(x^0..x^4)
        var T = Array(repeating: 0.0, count: 3)  // sum(y*x^0..y*x^2)
        for i in 0..<n {
            let x = xs[i], y = ys[i]
            let x2 = x * x
            S[0] += 1
            S[1] += x
            S[2] += x2
            S[3] += x * x2
            S[4] += x2 * x2
            T[0] += y
            T[1] += y * x
            T[2] += y * x2
        }
        // Solve 3x3 system using Cramer's rule
        let a11 = S[4], a12 = S[3], a13 = S[2]
        let a21 = S[3], a22 = S[2], a23 = S[1]
        let a31 = S[2], a32 = S[1], a33 = S[0]
        let det = a11*(a22*a33-a23*a32) - a12*(a21*a33-a23*a31) + a13*(a21*a32-a22*a31)
        guard abs(det) > 1e-12 else { return polyfit(xs, ys, degree: 1) + [0] }

        let b1 = T[2], b2 = T[1], b3 = T[0]
        let a = (b1*(a22*a33-a23*a32) - a12*(b2*a33-a23*b3) + a13*(b2*a32-a22*b3)) / det
        let b = (a11*(b2*a33-a23*b3) - b1*(a21*a33-a23*a31) + a13*(a21*b3-b2*a31)) / det
        let c = (a11*(a22*b3-b2*a32) - a12*(a21*b3-b2*a31) + b1*(a21*a32-a22*a31)) / det
        return [a, b, c]
    }

    return Array(repeating: 0, count: degree + 1)
}
