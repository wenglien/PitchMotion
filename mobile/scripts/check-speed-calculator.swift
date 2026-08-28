import CoreGraphics
import Foundation

@main
struct SpeedCalculatorCheck {
    static func main() {
        let calculator = BallSpeedCalculator(
            fps: 120,
            videoWidth: 1920,
            videoHeight: 1080,
            theoreticalDistance: 18.44,
            strideCorrectionM: 1.7
        )
        let points = [CGPoint(x: 100, y: 300), CGPoint(x: 900, y: 700)]

        func result(lastBallTimeS: Double) -> SpeedInfo {
            calculator.calculateSpeedDetailed(
                trajectoryPoints: points,
                releaseTimeS: 0,
                firstBallTimeS: 0.05,
                lastBallTimeS: lastBallTimeS,
                ballSizePreSeconds: 0.05
            )
        }

        let invalidFast = result(lastBallTimeS: 0.20)
        let invalidSlow = result(lastBallTimeS: 0.28)
        precondition(invalidFast.physicsClamped && invalidSlow.physicsClamped)
        precondition(invalidFast.releaseSpeedKmh != nil && invalidSlow.releaseSpeedKmh != nil)

        let plausibleFast = result(lastBallTimeS: 0.42)
        let plausibleSlow = result(lastBallTimeS: 0.50)
        precondition(!plausibleFast.physicsClamped && !plausibleSlow.physicsClamped)
        precondition((plausibleFast.releaseSpeedKmh ?? 0) > (plausibleSlow.releaseSpeedKmh ?? 0))

        let lowFpsCalculator = BallSpeedCalculator(
            fps: 30,
            videoWidth: 1920,
            videoHeight: 1080,
            theoreticalDistance: 18.44,
            strideCorrectionM: 1.7
        )
        let lowFpsResult = lowFpsCalculator.calculateSpeedDetailed(
            trajectoryPoints: points,
            releaseTimeS: 0,
            firstBallTimeS: 0.05,
            lastBallTimeS: 0.42,
            ballSizePreSeconds: 0.05
        )
        precondition(abs((plausibleFast.releaseSpeedKmh ?? 0) - (lowFpsResult.releaseSpeedKmh ?? 0)) < 0.001)

        let shortDistanceCalculator = BallSpeedCalculator(
            fps: 120,
            videoWidth: 2160,
            videoHeight: 3840,
            theoreticalDistance: 15,
            strideCorrectionM: 0.8
        )
        let loomingSamples: [(Double, Double)] = [
            (0.0, 69.4444444444),
            (0.1, 82.6446280992),
            (0.2, 100.0),
        ]
        let frameInfos = loomingSamples.enumerated().map { index, sample -> FrameInfo in
            var frame = FrameInfo(frameIndex: index, captureTimeS: sample.0)
            frame.ballInFrame = true
            frame.ballArea = sample.1
            return frame
        }
        func resultWithLongTTC(lastBallTimeS: Double) -> SpeedInfo {
            shortDistanceCalculator.calculateSpeedDetailed(
                trajectoryPoints: points,
                frameInfos: frameInfos,
                releaseTimeS: 0,
                firstBallTimeS: 0.05,
                lastBallTimeS: lastBallTimeS,
                ballSizePreSeconds: 0.05
            )
        }
        let capturedFast = resultWithLongTTC(lastBallTimeS: 0.80)
        let capturedSlow = resultWithLongTTC(lastBallTimeS: 0.82)
        precondition(!capturedFast.physicsClamped && !capturedSlow.physicsClamped)
        precondition((capturedFast.flightTimeS ?? 0) < (capturedSlow.flightTimeS ?? 0))
        precondition((capturedFast.releaseSpeedKmh ?? 0) > (capturedSlow.releaseSpeedKmh ?? 0))

        var realFrame = FrameInfo(frameIndex: 0, captureTimeS: 0)
        realFrame.ballInFrame = true
        var interpolatedA = FrameInfo(frameIndex: 1, captureTimeS: 0.01, isInterpolated: true)
        interpolatedA.ballInFrame = true
        var interpolatedB = FrameInfo(frameIndex: 2, captureTimeS: 0.02, isInterpolated: true)
        interpolatedB.ballInFrame = true
        let fallbackTiming = selectTimingObservations([realFrame, interpolatedA, interpolatedB])
        precondition(fallbackTiming.count == 3 && fallbackTiming.contains(where: { $0.isInterpolated }))

        var secondRealFrame = FrameInfo(frameIndex: 3, captureTimeS: 0.03)
        secondRealFrame.ballInFrame = true
        let realTiming = selectTimingObservations([realFrame, interpolatedA, secondRealFrame])
        precondition(realTiming.count == 2 && !realTiming.contains(where: { $0.isInterpolated }))

        let singleton = TrackPoint(frameIndex: 0, cx: 900, cy: 900, area: 100, trackId: 1)
        let coherent = (0..<5).map {
            TrackPoint(frameIndex: $0, cx: Double(100 + $0 * 20), cy: Double(200 + $0 * 30), area: 100, trackId: 2)
        }
        let selected = selectBestPitchTrack(
            tracks: [1: [singleton], 2: coherent],
            frameWidth: 1920,
            frameHeight: 1080
        )
        precondition(selected?.map(\.trackId) == [2, 2, 2, 2, 2])

        let jumping = (0..<5).map {
            TrackPoint(
                frameIndex: $0,
                cx: $0 == 2 ? 900 : Double(100 + $0 * 20),
                cy: $0 == 2 ? 50 : Double(200 + $0 * 30),
                area: 100,
                trackId: 3
            )
        }
        let cleaned = filterTrackOutliers(jumping, frameDiagonal: hypot(1920, 1080))
        precondition(cleaned.count == 4 && !cleaned.contains(where: { $0.frameIndex == 2 }))

        let tracker = SORTTracker(maxAge: 5, minHits: 1, iouThreshold: 0.1, maxCenterDistance: 100)
        let trackedFirst = tracker.update(detections: [
            (90, 90, 110, 110, 0.9),
            (295, 295, 305, 305, 0.8),
        ])
        let firstBallId = trackedFirst.min(by: {
            abs((($0.0 + $0.2) / 2) - 300) < abs((($1.0 + $1.2) / 2) - 300)
        })?.4
        let trackedSecond = tracker.update(detections: [
            (90, 90, 110, 110, 0.9),
            (345, 325, 355, 335, 0.8),
        ])
        let secondBallId = trackedSecond.min(by: {
            abs((($0.0 + $0.2) / 2) - 350) < abs((($1.0 + $1.2) / 2) - 350)
        })?.4
        precondition(firstBallId == secondBallId, "fast ball track fragmented when another object had IOU overlap")

        print("speed calculator checks passed")
    }
}
