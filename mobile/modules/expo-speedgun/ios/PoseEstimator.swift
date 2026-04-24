import Vision
import CoreVideo
import CoreGraphics

/// Apple Vision body pose estimator, replacing MediaPipe Pose.
final class PoseEstimator {
    private var isSupported: Bool = true

    func detect(
        pixelBuffer: CVPixelBuffer,
        frameIndex: Int,
        displayWidth: Int,
        displayHeight: Int
    ) -> PoseLandmarks? {
        guard isSupported else { return nil }

        let request = VNDetectHumanBodyPoseRequest()
        let roiX: CGFloat = 0.10
        let roiW: CGFloat = 0.80
        let roiY: CGFloat = 0.30   // bottom edge in Vision y-up coords (= top 70% of frame)
        let roiH: CGFloat = 0.70
        request.regionOfInterest = CGRect(x: roiX, y: roiY, width: roiW, height: roiH)

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        do {
            try handler.perform([request])
        } catch {
            // VNDetectHumanBodyPoseRequest requires Neural Engine (not available on Simulator).
            // Disable for the rest of this session to avoid repeated failures.
            NSLog("[PoseEstimator] not supported on this device, disabling: %@", error.localizedDescription)
            isSupported = false
            return nil
        }

        guard let results = request.results, let body = results.first else {
            return nil
        }

        func point(for jointName: VNHumanBodyPoseObservation.JointName) -> CGPoint? {
            guard let recognized = try? body.recognizedPoint(jointName),
                  recognized.confidence > 0.05 else {   // low threshold for occluded joints
                return nil
            }
            // Vision landmark location is normalised to the ROI rectangle.
            // Map back to full-frame normalised coords, then to display pixels.
            let fullNormX = roiX + recognized.location.x * roiW
            let fullNormY = roiY + recognized.location.y * roiH   // still y-up
            let x = CGFloat(displayWidth)  * fullNormX
            let y = CGFloat(displayHeight) * (1.0 - fullNormY)    // flip to y-down
            return CGPoint(x: x, y: y)
        }

        return PoseLandmarks(
            frameIndex: frameIndex,
            leftShoulder: point(for: .leftShoulder),
            rightShoulder: point(for: .rightShoulder),
            leftElbow: point(for: .leftElbow),
            rightElbow: point(for: .rightElbow),
            leftWrist: point(for: .leftWrist),
            rightWrist: point(for: .rightWrist),
            leftHip: point(for: .leftHip),
            rightHip: point(for: .rightHip),
            leftKnee: point(for: .leftKnee),
            rightKnee: point(for: .rightKnee),
            leftAnkle: point(for: .leftAnkle),
            rightAnkle: point(for: .rightAnkle)
        )
    }
}
