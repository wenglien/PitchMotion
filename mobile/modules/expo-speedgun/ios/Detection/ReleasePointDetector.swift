import Foundation
import CoreGraphics

/// Multi-signal release point detector.
/// Simplified port of research/vision/release_point_detector.py
/// Uses: S0 (release pose template), S1 (wrist speed peak), S2 (elbow extension), S3 (foot contact), S4 (arm angular velocity)
final class ReleasePointDetector {
    let fps: Int
    private var poseHistory: [PoseLandmarks?] = []
    private var frameCount = 0

    // Constants (from Python)
    let MIN_FRAMES_FOR_DETECTION = 10
    let WRIST_SPEED_MULT = 1.5
    let FOOT_STABLE_SEC = 0.10
    let FOOT_VEL_MULT = 0.25
    let S1_ADVANCE_SEC = 0.008
    let S1_DEFAULT_WEIGHT = 0.4
    let S2_DEFAULT_WEIGHT = 0.3
    let S4_DEFAULT_WEIGHT = 0.35
    let S1S2_AGREEMENT_SEC = 0.15
    let S4S1_AGREEMENT_SEC = 0.20
    let S2_DOWNWEIGHTED = 0.1
    let S4_DOWNWEIGHTED = 0.1
    let SINGLE_SIGNAL_MAX_CONF = 0.6
    let S3_CONFIDENCE_BOOST = 1.2
    let MIN_POSE_VALID_RATIO = 0.30
    let POSE_QUALITY_FULL_CONF_RATIO = 0.60
    let BALL_MAX_LEAD_SEC = 0.30
    let FOOT_WINDOW_START_SEC = 0.08
    let FOOT_WINDOW_END_SEC = 0.45
    let TEMPLATE_MAX_LEAD_SEC = 0.55
    let TEMPLATE_MIN_CONFIDENCE = 0.72

    init(fps: Int) {
        self.fps = max(1, fps)
    }

    func addFrame(_ landmarks: PoseLandmarks?) {
        poseHistory.append(landmarks)
        frameCount += 1
    }

    /// Detect release point. Returns (frameIndex, confidence) or nil.
    func detect(firstBallFrame: Int? = nil) -> (frameIndex: Int, confidence: Double)? {
        guard frameCount >= MIN_FRAMES_FOR_DETECTION else { return nil }

        let validPoseFrames = poseHistory.filter { $0 != nil }.count
        let validPoseRatio = poseHistory.isEmpty ? 0.0 : Double(validPoseFrames) / Double(poseHistory.count)
        guard validPoseRatio >= MIN_POSE_VALID_RATIO else {
            NSLog("[ReleasePointDetector] Pose quality too low: %.0f%% valid frames (%d/%d)",
                  validPoseRatio * 100, validPoseFrames, poseHistory.count)
            return nil
        }

        // Determine throwing hand (left or right) from wrist movement
        let isRightHanded = inferThrowingHand()

        // Extract wrist positions for the throwing hand
        var wristPositions: [(frameIdx: Int, point: CGPoint)] = []
        var elbowPositions: [(frameIdx: Int, point: CGPoint)] = []
        var shoulderPositions: [(frameIdx: Int, point: CGPoint)] = []
        var anklePositions: [(frameIdx: Int, point: CGPoint)] = []

        for (i, landmarks) in poseHistory.enumerated() {
            guard let lm = landmarks else { continue }
            let frameIdx = lm.frameIndex >= 0 ? lm.frameIndex : i
            let wrist = isRightHanded ? lm.rightWrist : lm.leftWrist
            let elbow = isRightHanded ? lm.rightElbow : lm.leftElbow
            let shoulder = isRightHanded ? lm.rightShoulder : lm.leftShoulder
            // Lead ankle (opposite of throwing hand)
            let ankle = isRightHanded ? lm.leftAnkle : lm.rightAnkle

            if let w = wrist { wristPositions.append((frameIdx, w)) }
            if let e = elbow { elbowPositions.append((frameIdx, e)) }
            if let s = shoulder { shoulderPositions.append((frameIdx, s)) }
            if let a = ankle { anklePositions.append((frameIdx, a)) }
        }

        guard wristPositions.count >= MIN_FRAMES_FOR_DETECTION else { return nil }

        // S0: pose template from the provided reference image:
        // throwing wrist high above shoulder, arm extended, wrist outside torso.
        let s0 = detectReleasePoseTemplate(isRightHanded: isRightHanded, firstBallFrame: firstBallFrame)

        // In the mobile pipeline we have the first ball frame, so pose release
        // must match the explicit release-pose template.  Do not let generic
        // motion peaks turn the cocking/load position into a release frame.
        if firstBallFrame != nil, s0 == nil {
            NSLog("[ReleasePointDetector] No valid release-pose template; rejecting pose release")
            return nil
        }

        // S1: Wrist speed peak
        let s1 = detectWristSpeedPeak(wristPositions)

        // S2: Elbow extension (arm nearly straight)
        let s2 = detectElbowExtension(elbowPositions, wristPositions, shoulderPositions)

        // S3: Foot contact (lead foot lands)
        let s3 = detectFootContact(anklePositions)

        // S4: Arm angular velocity peak
        let s4 = detectArmAngularVelocityPeak(shoulderPositions, wristPositions)

        // Fuse signals
        return fuseSignals(
            s0: s0,
            s1: s1,
            s2: s2,
            s3: s3,
            s4: s4,
            firstBallFrame: firstBallFrame,
            validPoseRatio: validPoseRatio
        )
    }

    // MARK: - Signal Detection

    private func detectReleasePoseTemplate(
        isRightHanded: Bool,
        firstBallFrame: Int?
    ) -> (frameIdx: Int, confidence: Double)? {
        var scored: [(frameIdx: Int, score: Double, wristY: CGFloat)] = []

        for (historyIdx, landmarks) in poseHistory.enumerated() {
            guard let lm = landmarks else { continue }
            let frameIdx = lm.frameIndex >= 0 ? lm.frameIndex : historyIdx

            if let first = firstBallFrame {
                let maxLeadFrames = Int(round(TEMPLATE_MAX_LEAD_SEC * Double(fps)))
                guard frameIdx <= first, (first - frameIdx) <= maxLeadFrames else { continue }
            }

            let wrist = isRightHanded ? lm.rightWrist : lm.leftWrist
            let elbow = isRightHanded ? lm.rightElbow : lm.leftElbow
            let shoulder = isRightHanded ? lm.rightShoulder : lm.leftShoulder
            let otherShoulder = isRightHanded ? lm.leftShoulder : lm.rightShoulder
            let hip = isRightHanded ? lm.rightHip : lm.leftHip
            let otherHip = isRightHanded ? lm.leftHip : lm.rightHip
            // Release pose requires the pitcher's chest fully facing the catcher
            // (camera). Both shoulders AND both hips must be visible — without
            // both, we can't verify torso orientation, so reject the frame.
            guard let w = wrist, let e = elbow, let s = shoulder, let os = otherShoulder,
                  let h = hip, let oh = otherHip else { continue }

            let midHip = CGPoint(x: (h.x + oh.x) * 0.5, y: (h.y + oh.y) * 0.5)
            let shoulderWidth = max(1.0, euclideanDistance(s, os))
            let hipWidth = max(1.0, euclideanDistance(h, oh))
            let torsoScale = max(shoulderWidth * 1.8, euclideanDistance(s, midHip))
            guard torsoScale > 8 else { continue }

            // Chest/hip facing-camera checks. When the pitcher is sideways
            // (cocking phase), the shoulder line projects near-vertical with
            // small width; at full release the body has rotated chest-forward
            // so the shoulder/hip lines are near-horizontal and wide.
            let shoulderTilt = abs(Double(s.y - os.y)) / max(shoulderWidth, 1.0)
            let hipTilt = abs(Double(h.y - oh.y)) / max(hipWidth, 1.0)
            let hipOpenRatio = hipWidth / torsoScale
            let torsoCenterX = Double(s.x + os.x) * 0.5
            let elbowLateral = abs(Double(e.x) - torsoCenterX) / max(shoulderWidth, 1.0)

            let elbowAngle = elbowAngle2D(shoulder: s, elbow: e, wrist: w)
            let armLength = euclideanDistance(s, e) + euclideanDistance(e, w)
            let shoulderToWrist = euclideanDistance(s, w)
            let extensionRatio = shoulderToWrist / max(1.0, armLength)
            let upperArmX = Double(e.x - s.x)
            let upperArmY = Double(e.y - s.y)
            let forearmX = Double(w.x - e.x)
            let forearmY = Double(w.y - e.y)
            let upperArmLen = max(1.0, sqrt(upperArmX * upperArmX + upperArmY * upperArmY))
            let forearmLen = max(1.0, sqrt(forearmX * forearmX + forearmY * forearmY))
            let armDirectionContinuity = (upperArmX * forearmX + upperArmY * forearmY) / (upperArmLen * forearmLen)
            let chestX = Double(os.x - s.x)
            let chestY = Double(os.y - s.y)
            let chestLen = max(1.0, sqrt(chestX * chestX + chestY * chestY))
            let upperArmChestParallel = abs((upperArmX * chestX + upperArmY * chestY) / (upperArmLen * chestLen))
            let chestOpenRatio = shoulderWidth / torsoScale

            // Image coordinates: smaller y means higher in the frame.
            let wristAboveShoulder = Double(s.y - w.y) / torsoScale
            let wristAboveElbow = Double(e.y - w.y) / torsoScale
            let elbowAboveOrNearShoulder = Double(s.y - e.y) / torsoScale
            let outsideTorso = abs(Double(w.x - s.x)) / max(shoulderWidth, 1.0)
            let handSeparationFromHead = abs(Double(w.x - os.x)) / max(shoulderWidth, 1.0)

            guard wristAboveShoulder >= 0.22,
                  wristAboveElbow >= 0.03,
                  elbowAngle >= 130.0,
                  extensionRatio >= 0.74,
                  outsideTorso >= 0.42,
                  armDirectionContinuity >= 0.10,
                  chestOpenRatio >= 0.45,            // shoulders fully open toward camera (was 0.34)
                  upperArmChestParallel >= 0.62,
                  // Chest + hips must be turned to face the catcher (camera).
                  // Tilt = |vertical_delta| / segment_length: 0 means perfectly
                  // horizontal (camera-facing), ~1 means edge-on (sideways).
                  shoulderTilt <= 0.45,
                  hipTilt <= 0.50,
                  hipOpenRatio >= 0.30,              // hips visibly open across the torso
                  elbowLateral >= 0.55 else {        // throwing elbow lateral, not behind torso
                continue
            }

            var score = 0.0
            score += clamp((wristAboveShoulder - 0.22) / 0.45, min: 0.0, max: 1.0) * 0.28
            score += clamp((wristAboveElbow - 0.03) / 0.25, min: 0.0, max: 1.0) * 0.14
            score += clamp((elbowAngle - 130.0) / 45.0, min: 0.0, max: 1.0) * 0.20
            score += clamp((extensionRatio - 0.74) / 0.20, min: 0.0, max: 1.0) * 0.16
            score += clamp((outsideTorso - 0.42) / 0.95, min: 0.0, max: 1.0) * 0.10
            score += clamp((armDirectionContinuity - 0.10) / 0.65, min: 0.0, max: 1.0) * 0.08
            score += clamp((upperArmChestParallel - 0.62) / 0.30, min: 0.0, max: 1.0) * 0.03
            score += clamp((chestOpenRatio - 0.45) / 0.25, min: 0.0, max: 1.0) * 0.02
            // Reward pitchers whose chest+hip lines are squarely toward camera.
            score += clamp((0.45 - shoulderTilt) / 0.45, min: 0.0, max: 1.0) * 0.02
            score += clamp((0.50 - hipTilt) / 0.50, min: 0.0, max: 1.0) * 0.01
            score += clamp((elbowAboveOrNearShoulder + 0.05) / 0.40, min: 0.0, max: 1.0) * 0.02
            score += clamp((handSeparationFromHead - 0.35) / 0.90, min: 0.0, max: 1.0) * 0.01

            scored.append((frameIdx, score, w.y))
        }

        guard scored.count >= 3 else { return nil }

        // Prefer frames near the local highest throwing hand, matching the reference
        // pose where the ball is at/near the top of the arm slot.
        var boosted: [(frameIdx: Int, score: Double)] = []
        for i in 0..<scored.count {
            let lo = max(0, i - 2)
            let hi = min(scored.count - 1, i + 2)
            let localMinY = scored[lo...hi].map(\.wristY).min() ?? scored[i].wristY
            let highPointBoost = scored[i].wristY <= localMinY + 3.0 ? 0.10 : 0.0
            boosted.append((scored[i].frameIdx, min(1.0, scored[i].score + highPointBoost)))
        }

        guard let best = boosted.max(by: { $0.score < $1.score }),
              best.score >= TEMPLATE_MIN_CONFIDENCE else {
            return nil
        }

        NSLog("[ReleasePointDetector] Pose-template release frame=%d confidence=%.2f firstBall=%@",
              best.frameIdx, best.score, firstBallFrame.map { String($0) } ?? "nil")
        return (best.frameIdx, best.score)
    }

    private func detectWristSpeedPeak(
        _ wristPos: [(frameIdx: Int, point: CGPoint)]
    ) -> (frameIdx: Int, confidence: Double)? {
        guard wristPos.count >= 5 else { return nil }

        // Calculate velocities using center difference
        var velocities: [(frameIdx: Int, speed: Double)] = []
        for i in 1..<(wristPos.count - 1) {
            let dt = Double(wristPos[i+1].frameIdx - wristPos[i-1].frameIdx) / Double(fps)
            guard dt > 0 else { continue }
            let dx = Double(wristPos[i+1].point.x - wristPos[i-1].point.x)
            let dy = Double(wristPos[i+1].point.y - wristPos[i-1].point.y)
            let speed = sqrt(dx*dx + dy*dy) / dt
            velocities.append((wristPos[i].frameIdx, speed))
        }

        guard !velocities.isEmpty else { return nil }

        // Search in latter 2/3 for peak
        let searchStart = velocities.count / 3
        let searchSlice = Array(velocities[searchStart...])
        guard let peak = searchSlice.max(by: { $0.speed < $1.speed }) else { return nil }

        let avgSpeed = velocities.map(\.speed).reduce(0, +) / Double(velocities.count)
        guard peak.speed > avgSpeed * WRIST_SPEED_MULT else { return nil }

        // Advance by S1_ADVANCE_SEC
        let advanceFrames = Int(round(S1_ADVANCE_SEC * Double(fps)))
        let releaseFrame = max(0, peak.frameIdx - advanceFrames)
        let confidence = min(1.0, peak.speed / (avgSpeed * 3.0))

        return (releaseFrame, confidence)
    }

    private func detectElbowExtension(
        _ elbowPos: [(frameIdx: Int, point: CGPoint)],
        _ wristPos: [(frameIdx: Int, point: CGPoint)],
        _ shoulderPos: [(frameIdx: Int, point: CGPoint)]
    ) -> (frameIdx: Int, confidence: Double)? {
        guard elbowPos.count >= 5, wristPos.count >= 5, shoulderPos.count >= 5 else { return nil }

        // Build frame-indexed lookups
        var wristMap: [Int: CGPoint] = [:]
        for wp in wristPos { wristMap[wp.frameIdx] = wp.point }
        var shoulderMap: [Int: CGPoint] = [:]
        for sp in shoulderPos { shoulderMap[sp.frameIdx] = sp.point }

        // Calculate elbow angle at each frame
        var angles: [(frameIdx: Int, angle: Double)] = []
        for ep in elbowPos {
            guard let w = wristMap[ep.frameIdx], let s = shoulderMap[ep.frameIdx] else { continue }
            let angle = elbowAngle2D(shoulder: s, elbow: ep.point, wrist: w)
            angles.append((ep.frameIdx, angle))
        }

        guard !angles.isEmpty else { return nil }

        // Find max angle in latter 2/3
        let searchStart = angles.count / 3
        let searchSlice = Array(angles[searchStart...])
        guard let maxAngle = searchSlice.max(by: { $0.angle < $1.angle }) else { return nil }
        guard maxAngle.angle > 120 else { return nil } // Must be near-straight (>120°)

        return (maxAngle.frameIdx, min(1.0, (maxAngle.angle - 120) / 40))
    }

    private func detectFootContact(
        _ anklePos: [(frameIdx: Int, point: CGPoint)]
    ) -> (frameIdx: Int, confidence: Double)? {
        guard anklePos.count >= 5 else { return nil }

        // Calculate Y-velocity of ankle
        var yVelocities: [(frameIdx: Int, vy: Double)] = []
        for i in 1..<anklePos.count {
            let dt = Double(anklePos[i].frameIdx - anklePos[i-1].frameIdx) / Double(fps)
            guard dt > 0 else { continue }
            let vy = abs(Double(anklePos[i].point.y - anklePos[i-1].point.y)) / dt
            yVelocities.append((anklePos[i].frameIdx, vy))
        }

        guard !yVelocities.isEmpty else { return nil }

        let avgVY = yVelocities.map(\.vy).reduce(0, +) / Double(yVelocities.count)
        let threshold = avgVY * FOOT_VEL_MULT
        let stableFrames = Int(round(FOOT_STABLE_SEC * Double(fps)))

        // Find first sustained stable period (vy < threshold for stableFrames)
        let searchStart = yVelocities.count / 4 // skip early frames
        var count = 0
        for i in searchStart..<yVelocities.count {
            if yVelocities[i].vy < threshold {
                count += 1
                if count >= stableFrames {
                    return (yVelocities[i - stableFrames + 1].frameIdx, 0.7)
                }
            } else {
                count = 0
            }
        }

        return nil
    }

    private func detectArmAngularVelocityPeak(
        _ shoulderPos: [(frameIdx: Int, point: CGPoint)],
        _ wristPos: [(frameIdx: Int, point: CGPoint)]
    ) -> (frameIdx: Int, confidence: Double)? {
        guard shoulderPos.count >= 5, wristPos.count >= 5 else { return nil }

        var shoulderMap: [Int: CGPoint] = [:]
        for sp in shoulderPos { shoulderMap[sp.frameIdx] = sp.point }

        // Calculate arm angle (shoulder→wrist vector angle)
        var armAngles: [(frameIdx: Int, angle: Double)] = []
        for wp in wristPos {
            guard let s = shoulderMap[wp.frameIdx] else { continue }
            let angle = atan2(Double(wp.point.y - s.y), Double(wp.point.x - s.x))
            armAngles.append((wp.frameIdx, angle))
        }

        guard armAngles.count >= 3 else { return nil }

        // Calculate angular velocity
        var angVelocities: [(frameIdx: Int, av: Double)] = []
        for i in 1..<armAngles.count {
            let dt = Double(armAngles[i].frameIdx - armAngles[i-1].frameIdx) / Double(fps)
            guard dt > 0 else { continue }
            var dAngle = armAngles[i].angle - armAngles[i-1].angle
            // Wrap to [-pi, pi]
            while dAngle > .pi { dAngle -= 2 * .pi }
            while dAngle < -.pi { dAngle += 2 * .pi }
            angVelocities.append((armAngles[i].frameIdx, abs(dAngle / dt)))
        }

        guard !angVelocities.isEmpty else { return nil }

        // Search in latter 75%
        let searchStart = angVelocities.count / 4
        let searchSlice = Array(angVelocities[searchStart...])
        guard let peak = searchSlice.max(by: { $0.av < $1.av }) else { return nil }

        let avgAV = angVelocities.map(\.av).reduce(0, +) / Double(angVelocities.count)
        guard peak.av > avgAV * 1.5 else { return nil }

        let advanceFrames = Int(round(0.020 * Double(fps)))
        let confidence = min(1.0, peak.av / (avgAV * 3.0))
        return (max(0, peak.frameIdx - advanceFrames), confidence)
    }

    // MARK: - Signal Fusion

    private func fuseSignals(
        s0: (frameIdx: Int, confidence: Double)?,
        s1: (frameIdx: Int, confidence: Double)?,
        s2: (frameIdx: Int, confidence: Double)?,
        s3: (frameIdx: Int, confidence: Double)?,
        s4: (frameIdx: Int, confidence: Double)?,
        firstBallFrame: Int?,
        validPoseRatio: Double
    ) -> (frameIndex: Int, confidence: Double)? {
        if let s0 {
            var confidence = s0.confidence
            if let s1 {
                let diff = abs(Double(s0.frameIdx - s1.frameIdx)) / Double(fps)
                if diff <= S1S2_AGREEMENT_SEC { confidence = min(1.0, confidence + 0.08) }
            }
            if let s2 {
                let diff = abs(Double(s0.frameIdx - s2.frameIdx)) / Double(fps)
                if diff <= S1S2_AGREEMENT_SEC { confidence = min(1.0, confidence + 0.08) }
            }
            if let s3 {
                let windowStart = s3.frameIdx + Int(round(FOOT_WINDOW_START_SEC * Double(fps)))
                let windowEnd = s3.frameIdx + Int(round(FOOT_WINDOW_END_SEC * Double(fps)))
                if s0.frameIdx >= windowStart && s0.frameIdx <= windowEnd {
                    confidence = min(1.0, confidence + 0.05)
                }
            }
            if validPoseRatio < POSE_QUALITY_FULL_CONF_RATIO {
                confidence *= validPoseRatio / POSE_QUALITY_FULL_CONF_RATIO
            }
            NSLog("[ReleasePointDetector] Release frame=%d confidence=%.2f source=pose-template firstBall=%@",
                  s0.frameIdx, confidence, firstBallFrame.map { String($0) } ?? "nil")
            return (s0.frameIdx, confidence)
        }

        var candidates: [(frameIdx: Int, weight: Double, confidence: Double)] = []

        if let s1 = s1 { candidates.append((s1.frameIdx, S1_DEFAULT_WEIGHT, s1.confidence)) }
        if let s2 = s2 {
            var w = S2_DEFAULT_WEIGHT
            // Check S1-S2 agreement
            if let s1 = s1 {
                let diff = abs(Double(s1.frameIdx - s2.frameIdx)) / Double(fps)
                if diff > S1S2_AGREEMENT_SEC { w = S2_DOWNWEIGHTED }
            }
            candidates.append((s2.frameIdx, w, s2.confidence))
        }
        if let s4 = s4 {
            var w = S4_DEFAULT_WEIGHT
            if let s1 = s1 {
                let diff = abs(Double(s1.frameIdx - s4.frameIdx)) / Double(fps)
                if diff > S4S1_AGREEMENT_SEC { w = S4_DOWNWEIGHTED }
            }
            candidates.append((s4.frameIdx, w, s4.confidence))
        }

        guard !candidates.isEmpty else { return nil }

        // Foot contact is a scene-stable timing anchor. If any motion candidate
        // lands in the expected post-contact release window, discard the rest.
        if let s3 = s3 {
            let windowStart = s3.frameIdx + Int(round(FOOT_WINDOW_START_SEC * Double(fps)))
            let windowEnd = s3.frameIdx + Int(round(FOOT_WINDOW_END_SEC * Double(fps)))
            let filtered = candidates.filter { $0.frameIdx >= windowStart && $0.frameIdx <= windowEnd }
            if !filtered.isEmpty {
                candidates = filtered.map { ($0.frameIdx, $0.weight * S3_CONFIDENCE_BOOST, $0.confidence) }
            }
        }

        // Cross-check against the actual ball track. Release must happen before
        // the first reliable ball detection, but not far earlier in the delivery.
        if let first = firstBallFrame {
            let maxLeadFrames = Int(round(BALL_MAX_LEAD_SEC * Double(fps)))
            let filtered = candidates.filter {
                $0.frameIdx <= first && (first - $0.frameIdx) <= maxLeadFrames
            }
            if !filtered.isEmpty {
                candidates = filtered
            } else {
                NSLog("[ReleasePointDetector] Rejecting pose release: no candidate within %.2fs before first ball frame %d",
                      BALL_MAX_LEAD_SEC, first)
                return nil
            }
        }

        // Weighted average
        var totalWeight = 0.0
        var weightedFrame = 0.0
        var maxConf = 0.0
        for c in candidates {
            let w = c.weight * c.confidence
            weightedFrame += Double(c.frameIdx) * w
            totalWeight += w
            maxConf = max(maxConf, c.confidence)
        }

        guard totalWeight > 0 else { return nil }
        let releaseFrame = Int(round(weightedFrame / totalWeight))

        var confidence = maxConf
        if candidates.count == 1 {
            confidence = min(confidence, SINGLE_SIGNAL_MAX_CONF)
        }

        if validPoseRatio < POSE_QUALITY_FULL_CONF_RATIO {
            confidence *= validPoseRatio / POSE_QUALITY_FULL_CONF_RATIO
        }

        confidence = min(1.0, confidence)
        NSLog("[ReleasePointDetector] Release frame=%d confidence=%.2f candidates=%d firstBall=%@",
              releaseFrame, confidence, candidates.count,
              firstBallFrame.map { String($0) } ?? "nil")
        return (releaseFrame, confidence)
    }

    // MARK: - Helpers

    private func inferThrowingHand() -> Bool {
        // Right-handed by default; detect by comparing wrist travel distance
        var leftTravel = 0.0, rightTravel = 0.0
        var prevLeft: CGPoint?, prevRight: CGPoint?

        for landmarks in poseHistory {
            guard let lm = landmarks else { continue }
            if let pl = prevLeft, let cl = lm.leftWrist {
                leftTravel += euclideanDistance(pl, cl)
            }
            if let pr = prevRight, let cr = lm.rightWrist {
                rightTravel += euclideanDistance(pr, cr)
            }
            prevLeft = lm.leftWrist
            prevRight = lm.rightWrist
        }

        return rightTravel >= leftTravel
    }

    private func elbowAngle2D(shoulder: CGPoint, elbow: CGPoint, wrist: CGPoint) -> Double {
        let v1x = Double(shoulder.x - elbow.x)
        let v1y = Double(shoulder.y - elbow.y)
        let v2x = Double(wrist.x - elbow.x)
        let v2y = Double(wrist.y - elbow.y)
        let dot = v1x * v2x + v1y * v2y
        let mag1 = sqrt(v1x*v1x + v1y*v1y)
        let mag2 = sqrt(v2x*v2x + v2y*v2y)
        guard mag1 > 0 && mag2 > 0 else { return 0 }
        let cosAngle = clamp(dot / (mag1 * mag2), min: -1.0, max: 1.0)
        return acos(cosAngle) * 180.0 / .pi
    }
}
