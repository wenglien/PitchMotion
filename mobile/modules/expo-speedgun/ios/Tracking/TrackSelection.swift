import Foundation

/// Prefer decoded camera observations, but keep optical-flow detections as a
/// last-resort timing source when fewer than two real frames saw the ball.
func selectTimingObservations(_ frames: [FrameInfo]) -> [FrameInfo] {
    let real = frames.filter {
        $0.ballInFrame && !$0.ballLostTracking && !$0.isInterpolated
    }
    if real.count >= 2 { return real }
    return frames.filter { $0.ballInFrame && !$0.ballLostTracking }
}

/// Remove an isolated tracker jump while preserving sustained curved motion.
func filterTrackOutliers(_ points: [TrackPoint], frameDiagonal: Double) -> [TrackPoint] {
    let sorted = points.sorted { $0.frameIndex < $1.frameIndex }
    guard sorted.count >= 3 else { return sorted }
    let baseTolerance = max(12.0, frameDiagonal * 0.018)

    return sorted.enumerated().compactMap { index, point in
        guard index > 0, index < sorted.count - 1 else { return point }
        let previous = sorted[index - 1]
        let next = sorted[index + 1]
        let span = next.frameIndex - previous.frameIndex
        guard span > 0 else { return point }
        let t = Double(point.frameIndex - previous.frameIndex) / Double(span)
        let expectedX = previous.cx + (next.cx - previous.cx) * t
        let expectedY = previous.cy + (next.cy - previous.cy) * t
        let deviation = hypot(point.cx - expectedX, point.cy - expectedY)
        let neighborTravel = hypot(next.cx - previous.cx, next.cy - previous.cy)
        return deviation > max(baseTolerance, neighborTravel * 0.75) ? nil : point
    }
}

/// Select the longest coherent moving SORT track. A singleton can never
/// produce speed, so it must not erase a usable Phase-1 trajectory.
func selectBestPitchTrack(
    tracks: [Int: [TrackPoint]],
    frameWidth: Int,
    frameHeight: Int,
    minPoints: Int = 2
) -> [TrackPoint]? {
    guard !tracks.isEmpty else { return nil }

    var bestTrack: [TrackPoint]?
    var bestScore = 0.0
    let diag = Double(frameWidth * frameWidth + frameHeight * frameHeight).squareRoot()

    for points in tracks.values {
        let sorted = filterTrackOutliers(points, frameDiagonal: diag)
        guard sorted.count >= max(2, minPoints),
              let first = sorted.first,
              let last = sorted.last else { continue }

        let displacement = hypot(last.cx - first.cx, last.cy - first.cy)
        var pathLength = 0.0
        var jumpPenalty = 0.0
        for index in 1..<sorted.count {
            let previous = sorted[index - 1]
            let current = sorted[index]
            let gap = max(1, current.frameIndex - previous.frameIndex)
            let step = hypot(current.cx - previous.cx, current.cy - previous.cy)
            pathLength += step
            let stepRatio = step / Double(gap) / max(1.0, diag)
            if stepRatio > 0.08 { jumpPenalty += (stepRatio - 0.08) * 8.0 }
        }

        let span = max(1, last.frameIndex - first.frameIndex + 1)
        let coverage = clamp(Double(sorted.count) / Double(span), min: 0.15, max: 1.0)
        let displacementRatio = displacement / max(1.0, diag)
        let pathRatio = pathLength / max(1.0, diag)
        let straightness = pathLength > 1 ? clamp(displacement / pathLength, min: 0.25, max: 1.0) : 0.25
        let motionScore = max(displacementRatio, pathRatio * 0.55)
        let staticPenalty = motionScore < 0.012 ? 0.25 : 1.0
        let score = Double(sorted.count)
            * max(motionScore, 0.01)
            * (0.55 + 0.45 * coverage)
            * (0.65 + 0.35 * straightness)
            * staticPenalty
            / max(1.0, 1.0 + jumpPenalty)

        if score > bestScore {
            bestScore = score
            bestTrack = sorted
        }
    }

    return bestTrack
}
