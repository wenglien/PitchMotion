import Vision
import CoreVideo
import CoreGraphics
#if canImport(MediaPipeTasksVision)
import MediaPipeTasksVision
#endif

/// Body pose estimator. Prefer MediaPipe Pose Landmarker Heavy, then Full, with Apple Vision as a fallback.
final class PoseEstimator {
    private static let minimumLandmarkScore: Float = 0.10
    private static let pitcherRoiX: CGFloat = 0.10
    private static let pitcherRoiYDown: CGFloat = 0.00
    private static let pitcherRoiWidth: CGFloat = 0.80
    private static let pitcherRoiHeight: CGFloat = 0.68

    private var visionIsSupported: Bool = true
#if canImport(MediaPipeTasksVision)
    private var poseLandmarker: PoseLandmarker?
    private var activeModelName: String?
    private var mediaPipeIsSupported: Bool = true
    private var lastMediaPipeTimestampMs: Int = -1
#endif

    func detect(
        pixelBuffer: CVPixelBuffer,
        frameIndex: Int,
        displayWidth: Int,
        displayHeight: Int
    ) -> PoseLandmarks? {
        if let mediaPipePose = detectWithMediaPipe(
            pixelBuffer: pixelBuffer,
            frameIndex: frameIndex,
            displayWidth: displayWidth,
            displayHeight: displayHeight
        ) {
            return mediaPipePose
        }

        return detectWithVision(
            pixelBuffer: pixelBuffer,
            frameIndex: frameIndex,
            displayWidth: displayWidth,
            displayHeight: displayHeight
        )
    }

#if canImport(MediaPipeTasksVision)
    private func detectWithMediaPipe(
        pixelBuffer: CVPixelBuffer,
        frameIndex: Int,
        displayWidth: Int,
        displayHeight: Int
    ) -> PoseLandmarks? {
        guard mediaPipeIsSupported else { return nil }

        do {
            let landmarker = try getPoseLandmarker()
            let roi = Self.pitcherRoi()
            let inputBuffer = cropBGRA(pixelBuffer: pixelBuffer, roi: roi) ?? pixelBuffer
            let image = try MPImage(pixelBuffer: inputBuffer)
            let timestampMs = nextMediaPipeTimestampMs(for: frameIndex)
            let result = try landmarker.detect(
                videoFrame: image,
                timestampInMilliseconds: timestampMs
            )
            guard let landmarks = result.landmarks.first,
                  landmarks.count > 28 else {
                return nil
            }

            func point(at index: Int) -> CGPoint? {
                let landmark = landmarks[index]
                if let visibility = landmark.visibility?.floatValue,
                   visibility < Self.minimumLandmarkScore {
                    return nil
                }
                if let presence = landmark.presence?.floatValue,
                   presence < Self.minimumLandmarkScore {
                    return nil
                }
                guard landmark.x >= 0.0, landmark.x <= 1.0,
                      landmark.y >= 0.0, landmark.y <= 1.0 else {
                    return nil
                }
                let fullNormX = roi.minX + CGFloat(landmark.x) * roi.width
                let fullNormY = roi.minY + CGFloat(landmark.y) * roi.height
                return CGPoint(
                    x: CGFloat(displayWidth) * fullNormX,
                    y: CGFloat(displayHeight) * fullNormY
                )
            }

            let pose = PoseLandmarks(
                frameIndex: frameIndex,
                leftShoulder: point(at: 11),
                rightShoulder: point(at: 12),
                leftElbow: point(at: 13),
                rightElbow: point(at: 14),
                leftWrist: point(at: 15),
                rightWrist: point(at: 16),
                leftHip: point(at: 23),
                rightHip: point(at: 24),
                leftKnee: point(at: 25),
                rightKnee: point(at: 26),
                leftAnkle: point(at: 27),
                rightAnkle: point(at: 28)
            )
            return isPitcherPose(pose, displayWidth: displayWidth, displayHeight: displayHeight) ? pose : nil
        } catch {
            NSLog("[PoseEstimator] MediaPipe unavailable, falling back to Vision: %@", error.localizedDescription)
            mediaPipeIsSupported = false
            return nil
        }
    }

    private func getPoseLandmarker() throws -> PoseLandmarker {
        if let poseLandmarker {
            return poseLandmarker
        }

        let modelCandidates = ["pose_landmarker_heavy", "pose_landmarker_full"]
        guard let modelName = modelCandidates.first(where: {
            Bundle.main.path(forResource: $0, ofType: "task") != nil
        }),
        let modelPath = Bundle.main.path(forResource: modelName, ofType: "task") else {
            throw NSError(
                domain: "PoseEstimator",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "No MediaPipe pose_landmarker .task model found in app bundle"]
            )
        }

        let options = PoseLandmarkerOptions()
        let baseOptions = BaseOptions()
        baseOptions.modelAssetPath = modelPath
        options.baseOptions = baseOptions
        options.runningMode = .video
        options.numPoses = 1
        options.minPoseDetectionConfidence = 0.25
        options.minPosePresenceConfidence = 0.25
        options.minTrackingConfidence = 0.25
        options.shouldOutputSegmentationMasks = false

        let landmarker = try PoseLandmarker(options: options)
        poseLandmarker = landmarker
        activeModelName = modelName
        NSLog("[PoseEstimator] Using MediaPipe %@", modelName)
        return landmarker
    }

    private func nextMediaPipeTimestampMs(for frameIndex: Int) -> Int {
        let timestampMs = max(frameIndex, lastMediaPipeTimestampMs + 1)
        lastMediaPipeTimestampMs = timestampMs
        return timestampMs
    }
#else
    private func detectWithMediaPipe(
        pixelBuffer: CVPixelBuffer,
        frameIndex: Int,
        displayWidth: Int,
        displayHeight: Int
    ) -> PoseLandmarks? {
        return nil
    }
#endif

    private func detectWithVision(
        pixelBuffer: CVPixelBuffer,
        frameIndex: Int,
        displayWidth: Int,
        displayHeight: Int
    ) -> PoseLandmarks? {
        guard visionIsSupported else { return nil }

        let request = VNDetectHumanBodyPoseRequest()
        let roiX = Self.pitcherRoiX
        let roiW = Self.pitcherRoiWidth
        let roiH = Self.pitcherRoiHeight
        let roiY = 1.0 - (Self.pitcherRoiYDown + Self.pitcherRoiHeight)
        request.regionOfInterest = CGRect(x: roiX, y: roiY, width: roiW, height: roiH)

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        do {
            try handler.perform([request])
        } catch {
            // VNDetectHumanBodyPoseRequest requires Neural Engine (not available on Simulator).
            // Disable for the rest of this session to avoid repeated failures.
            NSLog("[PoseEstimator] not supported on this device, disabling: %@", error.localizedDescription)
            visionIsSupported = false
            return nil
        }

        guard let results = request.results, let body = results.first else {
            return nil
        }

        func point(for jointName: VNHumanBodyPoseObservation.JointName) -> CGPoint? {
            guard let recognized = try? body.recognizedPoint(jointName),
                  recognized.confidence > 0.05 else {   // low threshold for fallback-only occluded joints
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

        let pose = PoseLandmarks(
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
        return isPitcherPose(pose, displayWidth: displayWidth, displayHeight: displayHeight) ? pose : nil
    }

    private static func pitcherRoi() -> CGRect {
        CGRect(
            x: pitcherRoiX,
            y: pitcherRoiYDown,
            width: pitcherRoiWidth,
            height: pitcherRoiHeight
        )
    }

    private func isPitcherPose(_ pose: PoseLandmarks, displayWidth: Int, displayHeight: Int) -> Bool {
        let torsoPoints = [
            pose.leftShoulder,
            pose.rightShoulder,
            pose.leftHip,
            pose.rightHip,
        ].compactMap { $0 }

        guard torsoPoints.count >= 2 else { return false }

        let cx = torsoPoints.reduce(CGFloat(0)) { $0 + $1.x } / CGFloat(torsoPoints.count)
        let cy = torsoPoints.reduce(CGFloat(0)) { $0 + $1.y } / CGFloat(torsoPoints.count)
        let nx = cx / CGFloat(max(displayWidth, 1))
        let ny = cy / CGFloat(max(displayHeight, 1))

        let roi = Self.pitcherRoi()
        let xMargin: CGFloat = 0.05
        let yMargin: CGFloat = 0.08
        return nx >= roi.minX - xMargin &&
            nx <= roi.maxX + xMargin &&
            ny >= roi.minY &&
            ny <= roi.maxY + yMargin
    }

    private func cropBGRA(pixelBuffer: CVPixelBuffer, roi: CGRect) -> CVPixelBuffer? {
        guard CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA else {
            return nil
        }

        let sourceWidth = CVPixelBufferGetWidth(pixelBuffer)
        let sourceHeight = CVPixelBufferGetHeight(pixelBuffer)
        guard sourceWidth > 0, sourceHeight > 0 else { return nil }

        let x = max(0, min(sourceWidth - 1, Int((roi.minX * CGFloat(sourceWidth)).rounded(.down))))
        let y = max(0, min(sourceHeight - 1, Int((roi.minY * CGFloat(sourceHeight)).rounded(.down))))
        let maxX = max(x + 1, min(sourceWidth, Int((roi.maxX * CGFloat(sourceWidth)).rounded(.up))))
        let maxY = max(y + 1, min(sourceHeight, Int((roi.maxY * CGFloat(sourceHeight)).rounded(.up))))
        let cropWidth = maxX - x
        let cropHeight = maxY - y

        var cropped: CVPixelBuffer?
        let attrs: [CFString: Any] = [
            kCVPixelBufferCGImageCompatibilityKey: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey: true,
            kCVPixelBufferIOSurfacePropertiesKey: [:],
        ]
        guard CVPixelBufferCreate(
            kCFAllocatorDefault,
            cropWidth,
            cropHeight,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &cropped
        ) == kCVReturnSuccess,
        let dst = cropped else {
            return nil
        }

        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        CVPixelBufferLockBaseAddress(dst, [])
        defer {
            CVPixelBufferUnlockBaseAddress(dst, [])
            CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly)
        }

        guard let srcBase = CVPixelBufferGetBaseAddress(pixelBuffer),
              let dstBase = CVPixelBufferGetBaseAddress(dst) else {
            return nil
        }

        let srcBytesPerRow = CVPixelBufferGetBytesPerRow(pixelBuffer)
        let dstBytesPerRow = CVPixelBufferGetBytesPerRow(dst)
        let bytesPerPixel = 4
        let rowBytes = cropWidth * bytesPerPixel

        for row in 0..<cropHeight {
            let srcRow = srcBase.advanced(by: (y + row) * srcBytesPerRow + x * bytesPerPixel)
            let dstRow = dstBase.advanced(by: row * dstBytesPerRow)
            memcpy(dstRow, srcRow, rowBytes)
        }

        return dst
    }
}
