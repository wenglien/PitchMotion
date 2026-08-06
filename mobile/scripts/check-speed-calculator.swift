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

        print("speed calculator checks passed")
    }
}
