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

        print("speed calculator checks passed")
    }
}
