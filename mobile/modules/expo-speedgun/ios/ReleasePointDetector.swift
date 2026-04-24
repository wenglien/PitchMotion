import Foundation
import CoreGraphics

/// Multi-signal release point detector.
/// Simplified port of src/release_point_detector.py
/// Uses: S1 (wrist speed peak), S2 (elbow extension), S3 (foot contact), S4 (arm angular velocity)
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

    init(fps: Int) {
        self.fps = max(1, fps)
    }

    func addFrame(_ landmarks: PoseLandmarks?) {
        poseHistory.append(landmarks)
        frameCount += 1
    }

    /// Detect release point. Returns (frameIndex, confidence) or nil.
    func detect() -> (frameIndex: Int, confidence: Double)? {
        guard frameCount >= MIN_FRAMES_FOR_DETECTION else { return nil }

        // Determine throwing hand (left or right) from wrist movement
        let isRightHanded = inferThrowingHand()

        // Extract wrist positions for the throwing hand
        var wristPositions: [(frameIdx: Int, point: CGPoint)] = []
        var elbowPositions: [(frameIdx: Int, point: CGPoint)] = []
        var shoulderPositions: [(frameIdx: Int, point: CGPoint)] = []
        var anklePositions: [(frameIdx: Int, point: CGPoint)] = []

        for (i, landmarks) in poseHistory.enumerated() {
            guard let lm = landmarks else { continue }
            let wrist = isRightHanded ? lm.rightWrist : lm.leftWrist
            let elbow = isRightHanded ? lm.rightElbow : lm.leftElbow
            let shoulder = isRightHanded ? lm.rightShoulder : lm.leftShoulder
            // Lead ankle (opposite of throwing hand)
            let ankle = isRightHanded ? lm.leftAnkle : lm.rightAnkle

            if let w = wrist { wristPositions.append((i, w)) }
            if let e = elbow { elbowPositions.append((i, e)) }
            if let s = shoulder { shoulderPositions.append((i, s)) }
            if let a = ankle { anklePositions.append((i, a)) }
        }

        guard wristPositions.count >= MIN_FRAMES_FOR_DETECTION else { return nil }

        // S1: Wrist speed peak
        let s1 = detectWristSpeedPeak(wristPositions)

        // S2: Elbow extension (arm nearly straight)
        let s2 = detectElbowExtension(elbowPositions, wristPositions, shoulderPositions)

        // S3: Foot contact (lead foot lands)
        let s3 = detectFootContact(anklePositions)

        // S4: Arm angular velocity peak
        let s4 = detectArmAngularVelocityPeak(shoulderPositions, wristPositions)

        // Fuse signals
        return fuseSignals(s1: s1, s2: s2, s3: s3, s4: s4)
    }

    // MARK: - Signal Detection

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
        let releaseFrame = peak.frameIdx + advanceFrames
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
        return (peak.frameIdx + advanceFrames, confidence)
    }

    // MARK: - Signal Fusion

    private func fuseSignals(
        s1: (frameIdx: Int, confidence: Double)?,
        s2: (frameIdx: Int, confidence: Double)?,
        s3: (frameIdx: Int, confidence: Double)?,
        s4: (frameIdx: Int, confidence: Double)?
    ) -> (frameIndex: Int, confidence: Double)? {
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

        // S3 confidence boost
        if let s3 = s3 {
            let s3Window = 0.08...0.45  // seconds after foot contact
            let releaseAfterFoot = Double(releaseFrame - s3.frameIdx) / Double(fps)
            if s3Window.contains(releaseAfterFoot) {
                confidence = min(1.0, confidence * S3_CONFIDENCE_BOOST)
            }
        }

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
