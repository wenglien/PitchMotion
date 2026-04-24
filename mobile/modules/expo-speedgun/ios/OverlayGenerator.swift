import AVFoundation
import Accelerate
import CoreGraphics
import UIKit

/// Generates overlay video with ball trajectory, speed info, and strike zone.
/// Port of src/generate_overlay.py
final class OverlayGenerator {
    let outputScale: Double

    init(outputScale: Double = 0.5) {
        self.outputScale = outputScale
    }

    func generate(
        sourceURL: URL,
        frameInfos: [FrameInfo],
        speedInfo: SpeedInfo?,
        outputURL: URL,
        interpFactor: Int = 2,
        progressCallback: ((Double, String) -> Void)? = nil
    ) throws {
        let asset = AVAsset(url: sourceURL)
        guard let videoTrack = asset.tracks(withMediaType: .video).first else {
            throw SpeedgunError.overlayGenerationFailed("No video track")
        }

        let naturalSize = videoTrack.naturalSize
        let transform = videoTrack.preferredTransform
        let transformedSize = naturalSize.applying(transform)
        let srcWidth = Int(abs(transformedSize.width))
        let srcHeight = Int(abs(transformedSize.height))
        let outWidth = Int(Double(srcWidth) * outputScale)
        let outHeight = Int(Double(srcHeight) * outputScale)

        // --- Video reader ---
        let videoReader = try AVAssetReader(asset: asset)
        let readerSettings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ]
        let readerOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: readerSettings)
        readerOutput.alwaysCopiesSampleData = false
        videoReader.add(readerOutput)

        try? FileManager.default.removeItem(at: outputURL)
        let writer = try AVAssetWriter(outputURL: outputURL, fileType: .mp4)

        let videoSettings: [String: Any] = [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: outWidth,
            AVVideoHeightKey: outHeight,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: outWidth * outHeight * 4,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ],
        ]
        let writerInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        writerInput.expectsMediaDataInRealTime = false

        let adaptor = AVAssetWriterInputPixelBufferAdaptor(
            assetWriterInput: writerInput,
            sourcePixelBufferAttributes: [
                kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
                kCVPixelBufferWidthKey as String: outWidth,
                kCVPixelBufferHeightKey as String: outHeight,
            ]
        )
        writer.add(writerInput)

        videoReader.startReading()
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)

        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let maxWaitLoops = 3000 // ~30s with 10ms sleep

        let smoothedTrajectory = buildSmoothedTrajectory(
            frameInfos: frameInfos,
            scale: outputScale,
            outWidth: outWidth,
            interpFactor: max(1, interpFactor)
        )
        let totalFrames = frameInfos.count
        // Pose temporal smoothing: pre-compute interpolated PoseLandmarks per real frame
        // so the skeleton no longer "freezes-then-jumps" every `poseEveryN` frames.
        let smoothedPoses = buildSmoothedPoses(
            frameInfos: frameInfos,
            interpFactor: max(1, interpFactor)
        )

        NSLog("[OverlayGenerator] Starting overlay: %dx%d → %dx%d, %d frames", srcWidth, srcHeight, outWidth, outHeight, totalFrames)
        progressCallback?(0.0, "Overlay init: \(srcWidth)x\(srcHeight) → \(outWidth)x\(outHeight), frames=\(totalFrames), audio=off")
        // #region agent log
        DebugLogger.log(
            hypothesisId: "H4",
            location: "OverlayGenerator.swift:117",
            message: "Overlay generator started",
            data: [
                "source_path": sourceURL.path,
                "output_path": outputURL.path,
                "src_width": srcWidth,
                "src_height": srcHeight,
                "out_width": outWidth,
                "out_height": outHeight,
                "total_frames": totalFrames,
                "audio_skipped": true,
            ]
        )
        // #endregion

        // Process video frames
        var frameIndex = 0
        var deferredError: Error?
        while let sampleBuffer = readerOutput.copyNextSampleBuffer() {
            autoreleasepool {
                guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
                let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)

                // Create output pixel buffer
                guard let pool = adaptor.pixelBufferPool else { return }
                var outBuffer: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(nil, pool, &outBuffer)
                guard let outputBuffer = outBuffer else { return }

                // Draw frame with overlays
                drawOverlayFrame(
                    source: pixelBuffer,
                    destination: outputBuffer,
                    frameIndex: frameIndex,
                    frameInfos: frameInfos,
                    smoothedTrajectory: smoothedTrajectory,
                    smoothedPoses: smoothedPoses,
                    speedInfo: speedInfo,
                    outWidth: outWidth,
                    outHeight: outHeight,
                    srcWidth: srcWidth,
                    srcHeight: srcHeight,
                    totalFrames: totalFrames,
                    colorSpace: colorSpace
                )

                // Wait for writer to be ready
                var videoWaitLoops = 0
                while !writerInput.isReadyForMoreMediaData {
                    videoWaitLoops += 1
                    if videoWaitLoops == 500 || videoWaitLoops == 2000 {
                        // #region agent log
                        DebugLogger.log(
                            hypothesisId: "H1",
                            location: "OverlayGenerator.swift:154",
                            message: "Video writer backpressure detected",
                            data: [
                                "frame_index": frameIndex,
                                "wait_loops": videoWaitLoops,
                                "writer_status": statusName(writer.status),
                                "writer_error": writer.error?.localizedDescription ?? "",
                            ]
                        )
                        // #endregion
                        progressCallback?(
                            min(0.94, Double(frameIndex) / Double(max(1, totalFrames))),
                            "Video writer backpressure at frame \(frameIndex) (wait=\(videoWaitLoops))"
                        )
                    }
                    if videoWaitLoops >= maxWaitLoops {
                        // #region agent log
                        DebugLogger.log(
                            hypothesisId: "H1",
                            location: "OverlayGenerator.swift:173",
                            message: "Video writer backpressure timeout",
                            data: [
                                "frame_index": frameIndex,
                                "wait_loops": videoWaitLoops,
                                "writer_status": statusName(writer.status),
                                "writer_error": writer.error?.localizedDescription ?? "",
                            ]
                        )
                        // #endregion
                        deferredError = SpeedgunError.overlayGenerationFailed("Video writer timeout at frame \(frameIndex)")
                        return
                    }
                    Thread.sleep(forTimeInterval: 0.01)
                }
                adaptor.append(outputBuffer, withPresentationTime: presentationTime)

                frameIndex += 1
                if frameIndex % 30 == 0 {
                    NSLog("[OverlayGenerator] Frame %d/%d", frameIndex, totalFrames)
                    let pct = Double(frameIndex) / Double(max(1, totalFrames))
                    progressCallback?(pct, "Encoding frame \(frameIndex)/\(totalFrames)")
                }
            }
            if let err = deferredError {
                throw err
            }
        }

        NSLog("[OverlayGenerator] Video done (%d frames), copying audio...", frameIndex)
        progressCallback?(0.95, "Video stream complete (\(frameIndex) frames), finalizing MP4")
        // #region agent log
        DebugLogger.log(
            hypothesisId: "H3",
            location: "OverlayGenerator.swift:181",
            message: "Video frame loop ended",
            data: [
                "processed_frames": frameIndex,
                "reader_status": statusName(videoReader.status),
                "reader_error": videoReader.error?.localizedDescription ?? "",
                "writer_status": statusName(writer.status),
                "writer_error": writer.error?.localizedDescription ?? "",
            ]
        )
        // #endregion

        // Audio intentionally skipped — overlay is visual-only

        writerInput.markAsFinished()

        // Finish writing
        let semaphore = DispatchSemaphore(value: 0)
        writer.finishWriting { semaphore.signal() }
        progressCallback?(0.98, "Finalizing MP4 container...")
        semaphore.wait()
        // #region agent log
        DebugLogger.log(
            hypothesisId: "H3",
            location: "OverlayGenerator.swift:243",
            message: "finishWriting completed",
            data: [
                "writer_status": statusName(writer.status),
                "writer_error": writer.error?.localizedDescription ?? "",
            ]
        )
        // #endregion

        videoReader.cancelReading()

        guard writer.status == .completed else {
            // #region agent log
            DebugLogger.log(
                hypothesisId: "H3",
                location: "OverlayGenerator.swift:257",
                message: "Overlay generation finishing with non-completed writer status",
                data: [
                    "writer_status": statusName(writer.status),
                    "writer_error": writer.error?.localizedDescription ?? "",
                ]
            )
            // #endregion
            throw SpeedgunError.overlayGenerationFailed(writer.error?.localizedDescription ?? "Unknown")
        }

        NSLog("[OverlayGenerator] Overlay complete: %@", outputURL.lastPathComponent)
        progressCallback?(1.0, "Overlay written: \(outputURL.lastPathComponent)")
        // #region agent log
        DebugLogger.log(
            hypothesisId: "H4",
            location: "OverlayGenerator.swift:271",
            message: "Overlay generation completed",
            data: [
                "output_exists": FileManager.default.fileExists(atPath: outputURL.path),
                "output_bytes": ((try? FileManager.default.attributesOfItem(atPath: outputURL.path)[.size] as? NSNumber)?.int64Value ?? -1),
            ]
        )
        // #endregion
    }

    // MARK: - Frame Drawing

    private func drawOverlayFrame(
        source: CVPixelBuffer,
        destination: CVPixelBuffer,
        frameIndex: Int,
        frameInfos: [FrameInfo],
        smoothedTrajectory: [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)],
        smoothedPoses: [PoseLandmarks?],
        speedInfo: SpeedInfo?,
        outWidth: Int,
        outHeight: Int,
        srcWidth: Int,
        srcHeight: Int,
        totalFrames: Int,
        colorSpace: CGColorSpace
    ) {
        CVPixelBufferLockBaseAddress(source, .readOnly)
        CVPixelBufferLockBaseAddress(destination, [])
        defer {
            CVPixelBufferUnlockBaseAddress(source, .readOnly)
            CVPixelBufferUnlockBaseAddress(destination, [])
        }

        // Use vImage to scale source → destination (much faster than CIImage→CGImage→CGContext)
        let srcW = CVPixelBufferGetWidth(source)
        let srcH = CVPixelBufferGetHeight(source)
        var srcBuffer = vImage_Buffer(
            data: CVPixelBufferGetBaseAddress(source),
            height: vImagePixelCount(srcH),
            width: vImagePixelCount(srcW),
            rowBytes: CVPixelBufferGetBytesPerRow(source)
        )
        var dstBuffer = vImage_Buffer(
            data: CVPixelBufferGetBaseAddress(destination),
            height: vImagePixelCount(outHeight),
            width: vImagePixelCount(outWidth),
            rowBytes: CVPixelBufferGetBytesPerRow(destination)
        )

        // Scale BGRA pixels directly — no CIImage/CGImage conversion needed
        if srcW == outWidth && srcH == outHeight {
            // Same size: direct memcpy (fastest path)
            if CVPixelBufferGetBytesPerRow(source) == CVPixelBufferGetBytesPerRow(destination) {
                memcpy(dstBuffer.data, srcBuffer.data, srcH * CVPixelBufferGetBytesPerRow(source))
            } else {
                vImageCopyBuffer(&srcBuffer, &dstBuffer, 4, vImage_Flags(kvImageNoFlags))
            }
        } else {
            vImageScale_ARGB8888(&srcBuffer, &dstBuffer, nil, vImage_Flags(kvImageNoFlags))
        }

        // Now create CGContext on the destination for overlay drawing
        let context = CGContext(
            data: CVPixelBufferGetBaseAddress(destination),
            width: outWidth,
            height: outHeight,
            bitsPerComponent: 8,
            bytesPerRow: CVPixelBufferGetBytesPerRow(destination),
            space: colorSpace,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        )

        guard let ctx = context else { return }

        // Flip context for normal drawing (CGContext is y-up by default)
        ctx.saveGState()
        ctx.translateBy(x: 0, y: CGFloat(outHeight))
        ctx.scaleBy(x: 1, y: -1)

        // Draw pose skeleton (bottom layer, under ball trail) — use temporally smoothed pose
        if frameIndex < smoothedPoses.count, let pose = smoothedPoses[frameIndex] {
            drawPoseSkeleton(ctx: ctx, pose: pose, scale: outputScale)
        }

        // Draw ball trajectory up to current frame (pre-smoothed, monotone)
        drawBallTrail(ctx: ctx, smoothedTrajectory: smoothedTrajectory, currentFrame: frameIndex, outWidth: outWidth, outHeight: outHeight)

        // Draw speed info text
        if let si = speedInfo, frameIndex > totalFrames / 2 {
            let alpha = min(1.0, Double(frameIndex - totalFrames/2) / 30.0)
            drawFullFrameStrikeZone(ctx: ctx, speedInfo: si, outWidth: outWidth, outHeight: outHeight, alpha: 0.45 + 0.35 * alpha)
            drawSpeedText(ctx: ctx, speedInfo: si, outWidth: outWidth, outHeight: outHeight, alpha: alpha)
            drawStrikeZone(ctx: ctx, speedInfo: si, outWidth: outWidth, outHeight: outHeight, alpha: alpha)
        }

        ctx.restoreGState()
    }

    private func buildSmoothedTrajectory(
        frameInfos: [FrameInfo],
        scale: Double,
        outWidth: Int,
        interpFactor: Int
    ) -> [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)] {

        let outHeight = Int(Double(outWidth) * 16.0 / 9.0) // approximate — used for span check only

        // FrameInfo.frameIndex is the EFFECTIVE frame index (real + interpolated slots).
        // For interpolated pipelines (normal fps), interpFactor=2 so real_k → effective 2k.
        // For slo-mo (≥120fps), interpolation is disabled → interpFactor=1, so real_k = effective_k.
        // The overlay loop counts REAL source frames; convert effective → real so
        // drawBallTrail's filter `$0.frameIndex <= currentFrame` matches the video timeline.
        let factor = max(1, interpFactor)
        func toRealFrame(_ effectiveIdx: Int) -> Int {
            return effectiveIdx / factor
        }

        // Helper to collect points from frameInfos with a flag filter
        func collect(includeGapFill: Bool) -> [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)] {
            var pts: [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)] = []
            for fi in frameInfos where fi.ballInFrame {
                if !includeGapFill && fi.ballLostTracking { continue }
                pts.append((toRealFrame(fi.frameIndex),
                            Double(fi.ballCenter.x) * scale,
                            Double(fi.ballCenter.y) * scale,
                            fi.ballColor.0, fi.ballColor.1, fi.ballColor.2))
            }
            return pts
        }

        // 1. Try real detections only first
        var raw = collect(includeGapFill: false)

        // Always prefer real detections + gap-fill over pose fallback.
        // Collect gap-fill points unconditionally so the trajectory has enough
        // points to smooth — gap-fill is already polynomial-interpolated and
        // lives inside the SORT window, so it is not pre-pitch FP noise.
        let allRaw = collect(includeGapFill: true)
        if allRaw.count > raw.count {
            raw = allRaw
        }

        NSLog("[OverlayGenerator] buildSmoothedTrajectory: raw=%d allRaw=%d (effectiveIdx÷2 → realFrame)",
              raw.count, allRaw.count)
        if let first = raw.first, let last = raw.last {
            NSLog("[OverlayGenerator] Trajectory real-frame range: %d → %d",
                  first.frameIndex, last.frameIndex)
        }

        // Only fall back to the pose-wrist Bézier arc when there are genuinely
        // no YOLO/gap-fill ball points at all (e.g. YOLO missed everything).
        // A sparse but real trajectory (≥ 2 pts) is always preferred.
        if raw.count < 2 {
            if let poseFallback = buildPoseWristFallback(
                frameInfos: frameInfos,
                scale: scale,
                outWidth: outWidth,
                outHeight: outHeight,
                interpFactor: factor
            ) {
                return poseFallback
            }
        }

        guard raw.count >= 2 else { return raw }

        // 2. Outlier filter — drop points jumping > 12% frame width per frame.
        //    Slightly looser than "real-only" mode to tolerate the larger frame-index
        //    gaps that gap-fill points can span.
        let maxJumpPerFrame = Double(outWidth) * 0.12
        var filtered: [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)] = [raw[0]]
        for i in 1..<raw.count {
            guard let prev = filtered.last else { break }
            let frameDelta = max(1, raw[i].frameIndex - prev.frameIndex)
            let dx = raw[i].x - prev.x
            let dy = raw[i].y - prev.y
            let distPerFrame = sqrt(dx*dx + dy*dy) / Double(frameDelta)
            if distPerFrame <= maxJumpPerFrame {
                filtered.append(raw[i])
            }
        }
        guard filtered.count >= 2 else { return filtered }

        // 3. Strong Gaussian smooth — 3 passes (radius=3, radius=2, radius=2).
        func gaussSmooth(
            _ pts: [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)],
            radius: Int
        ) -> [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)] {
            let sigma = Double(radius) / 2.0
            var weights = (0...(2*radius)).map { k -> Double in
                let d = Double(k - radius)
                return exp(-d*d / (2*sigma*sigma))
            }
            let wsum = weights.reduce(0, +)
            weights = weights.map { $0 / wsum }

            var out = pts
            let n = pts.count
            for i in 0..<n {
                var wx = 0.0, wy = 0.0, wt = 0.0
                for (ki, kw) in weights.enumerated() {
                    let j = i + ki - radius
                    guard j >= 0 && j < n else { continue }
                    wx += pts[j].x * kw
                    wy += pts[j].y * kw
                    wt += kw
                }
                out[i].x = wx / wt
                out[i].y = wy / wt
            }
            return out
        }
        var smoothed = gaussSmooth(filtered, radius: 3)
        smoothed = gaussSmooth(smoothed, radius: 2)
        smoothed = gaussSmooth(smoothed, radius: 2)

        // 4. Projection-monotone enforcement along dominant flight direction.
        if smoothed.count >= 4, let smoothedLast = smoothed.last {
            let dx0 = smoothedLast.x - smoothed[0].x
            let dy0 = smoothedLast.y - smoothed[0].y
            let len0 = sqrt(dx0*dx0 + dy0*dy0)
            if len0 > 1 {
                let dirX = dx0 / len0
                let dirY = dy0 / len0
                let tolerance = len0 * 0.03

                var maxProj = smoothed[0].x * dirX + smoothed[0].y * dirY
                for i in 1..<smoothed.count {
                    let proj = smoothed[i].x * dirX + smoothed[i].y * dirY
                    if proj < maxProj - tolerance {
                        let perpX = smoothed[i].x - proj * dirX
                        let perpY = smoothed[i].y - proj * dirY
                        smoothed[i].x = perpX + maxProj * dirX
                        smoothed[i].y = perpY + maxProj * dirY
                    } else {
                        maxProj = max(maxProj, proj)
                    }
                }
            }
        }

        // 5. Tail-kink trim: remove end-segment points that veer > 70° from
        //    the dominant direction (gap-fill artefacts causing L-shapes).
        return trimTailKinks(smoothed)
    }

    private func buildPoseWristFallback(
        frameInfos: [FrameInfo],
        scale: Double,
        outWidth: Int,
        outHeight: Int,
        interpFactor: Int
    ) -> [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)]? {

        let sc = scale

        // Find the first frame that has a throwing-wrist pose landmark.
        // Prefer the wrist that is higher in the frame (smaller y in display coords = smaller y*sc)
        // since the throwing arm is raised during release.
        var wristPt: CGPoint? = nil
        var wristFrameIdx: Int = 0

        let factor = max(1, interpFactor)
        for fi in frameInfos {
            guard let pose = fi.poseLandmarks else { continue }
            // Pick the higher wrist (smaller display y = higher in frame)
            let candidates = [pose.leftWrist, pose.rightWrist].compactMap { $0 }
            if let best = candidates.min(by: { $0.y < $1.y }) {
                wristPt = best
                wristFrameIdx = fi.frameIndex / factor
                break
            }
        }

        guard let wrist = wristPt else { return nil }

        // P0: throwing wrist (scaled to overlay coords)
        let p0x = Double(wrist.x) * sc
        let p0y = Double(wrist.y) * sc

        // P2: estimated catch point — frame centre x, 72% down from top
        let p2x = Double(outWidth) * 0.50
        let p2y = Double(outHeight) * 0.72

        // P1: Bézier control point — midpoint of P0→P2, lifted 15% of frame height
        // upward (smaller y) to create a natural downward arc for a pitched ball.
        let midX = (p0x + p2x) * 0.5
        let midY = (p0y + p2y) * 0.5
        let liftY = Double(outHeight) * 0.15
        let p1x = midX
        let p1y = midY - liftY

        // Sample 30 points along the Bézier t ∈ [0, 1]
        let nPts = 30
        // Spread frame indices from wristFrameIdx to end of video so the
        // trail animates forward through the clip like a real ball would.
        // lastFrameIdx from frameInfos is in effective space — convert to real.
        let lastEffectiveIdx = frameInfos.last?.frameIndex ?? (wristFrameIdx * factor + nPts)
        let lastFrameIdx = lastEffectiveIdx / factor
        let frameSpan = max(nPts, lastFrameIdx - wristFrameIdx)

        var result: [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)] = []
        for i in 0..<nPts {
            let t = Double(i) / Double(nPts - 1)
            let u = 1.0 - t
            // Quadratic Bézier
            let x = u*u*p0x + 2*u*t*p1x + t*t*p2x
            let y = u*u*p0y + 2*u*t*p1y + t*t*p2y
            let fIdx = wristFrameIdx + Int(Double(i) / Double(nPts - 1) * Double(frameSpan))
            result.append((fIdx, x, y, 255, 165, 0))  // orange = estimated
        }
        return result
    }

    // MARK: - Pose Temporal Smoothing

    /// MediaPipe pose runs only every ~poseEveryN frames (e.g. every 12 frames at 120fps).
    /// Between samples the pipeline copies `lastPose`, so the skeleton freezes for ~100ms
    /// and then JUMPS when the next sample lands. This produces visible jitter at high fps.
    ///
    /// We rebuild a per-real-frame pose series by (a) extracting the unique fresh
    /// detections (dedupe by `PoseLandmarks.frameIndex`), (b) linearly interpolating
    /// each landmark between adjacent detections, (c) applying a small 3-tap smoother
    /// to dampen residual noise.
    private func buildSmoothedPoses(
        frameInfos: [FrameInfo],
        interpFactor: Int
    ) -> [PoseLandmarks?] {
        let factor = max(1, interpFactor)
        // Real-frame count = effectiveTotalFrames / factor (rounded up for safety)
        let realFrameCount = (frameInfos.count + factor - 1) / factor
        guard realFrameCount > 0 else { return [] }

        // 1) Collect unique fresh poses keyed by effective frame where they were detected.
        //    `PoseLandmarks.frameIndex` stores that detection frame; duplicates mean "copied".
        var seenDetectionFrame: Int = -1
        var samples: [(realFrame: Int, pose: PoseLandmarks)] = []
        for fi in frameInfos {
            guard let pose = fi.poseLandmarks else { continue }
            if pose.frameIndex == seenDetectionFrame { continue }
            seenDetectionFrame = pose.frameIndex
            let realIdx = pose.frameIndex / factor
            samples.append((realIdx, pose))
        }

        var out = [PoseLandmarks?](repeating: nil, count: realFrameCount)
        guard !samples.isEmpty else { return out }

        // 2) Fill each real frame by linearly interpolating landmarks between
        //    the two nearest samples (extrapolate flat beyond the ends).
        func lerpPoint(_ a: CGPoint?, _ b: CGPoint?, _ t: CGFloat) -> CGPoint? {
            switch (a, b) {
            case let (a?, b?):
                return CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t)
            case (let a?, nil): return a
            case (nil, let b?): return b
            default: return nil
            }
        }
        func blend(_ a: PoseLandmarks, _ b: PoseLandmarks, _ t: CGFloat, atFrame f: Int) -> PoseLandmarks {
            return PoseLandmarks(
                frameIndex: f,
                leftShoulder:  lerpPoint(a.leftShoulder,  b.leftShoulder,  t),
                rightShoulder: lerpPoint(a.rightShoulder, b.rightShoulder, t),
                leftElbow:     lerpPoint(a.leftElbow,     b.leftElbow,     t),
                rightElbow:    lerpPoint(a.rightElbow,    b.rightElbow,    t),
                leftWrist:     lerpPoint(a.leftWrist,     b.leftWrist,     t),
                rightWrist:    lerpPoint(a.rightWrist,    b.rightWrist,    t),
                leftHip:       lerpPoint(a.leftHip,       b.leftHip,       t),
                rightHip:      lerpPoint(a.rightHip,      b.rightHip,      t),
                leftKnee:      lerpPoint(a.leftKnee,      b.leftKnee,      t),
                rightKnee:     lerpPoint(a.rightKnee,     b.rightKnee,     t),
                leftAnkle:     lerpPoint(a.leftAnkle,     b.leftAnkle,     t),
                rightAnkle:    lerpPoint(a.rightAnkle,    b.rightAnkle,    t)
            )
        }

        var sIdx = 0
        for f in 0..<realFrameCount {
            // Advance sIdx so samples[sIdx..sIdx+1] brackets f (when possible).
            while sIdx + 1 < samples.count && samples[sIdx + 1].realFrame <= f { sIdx += 1 }
            if samples.count == 1 || f <= samples.first!.realFrame {
                out[f] = samples.first!.pose
            } else if f >= samples.last!.realFrame {
                out[f] = samples.last!.pose
            } else {
                let a = samples[sIdx]
                let b = samples[min(sIdx + 1, samples.count - 1)]
                let span = max(1, b.realFrame - a.realFrame)
                let t = CGFloat(f - a.realFrame) / CGFloat(span)
                out[f] = blend(a.pose, b.pose, t, atFrame: f)
            }
        }

        // 3) Gentle 3-tap smoothing on each landmark channel to hide residual jitter.
        func smoothSeries(_ extract: (PoseLandmarks) -> CGPoint?) -> [CGPoint?] {
            var raw = out.map { $0.flatMap(extract) }
            var smoothed = raw
            for i in 1..<(raw.count - 1) {
                guard let a = raw[i - 1], let b = raw[i], let c = raw[i + 1] else { continue }
                smoothed[i] = CGPoint(
                    x: (a.x + 2 * b.x + c.x) / 4,
                    y: (a.y + 2 * b.y + c.y) / 4
                )
            }
            _ = raw
            return smoothed
        }
        if out.count >= 3 {
            let lsh = smoothSeries { $0.leftShoulder }
            let rsh = smoothSeries { $0.rightShoulder }
            let lel = smoothSeries { $0.leftElbow }
            let rel = smoothSeries { $0.rightElbow }
            let lwr = smoothSeries { $0.leftWrist }
            let rwr = smoothSeries { $0.rightWrist }
            let lhi = smoothSeries { $0.leftHip }
            let rhi = smoothSeries { $0.rightHip }
            let lkn = smoothSeries { $0.leftKnee }
            let rkn = smoothSeries { $0.rightKnee }
            let lan = smoothSeries { $0.leftAnkle }
            let ran = smoothSeries { $0.rightAnkle }
            for i in 0..<out.count {
                guard let p = out[i] else { continue }
                out[i] = PoseLandmarks(
                    frameIndex: p.frameIndex,
                    leftShoulder:  lsh[i], rightShoulder: rsh[i],
                    leftElbow:     lel[i], rightElbow:    rel[i],
                    leftWrist:     lwr[i], rightWrist:    rwr[i],
                    leftHip:       lhi[i], rightHip:      rhi[i],
                    leftKnee:      lkn[i], rightKnee:     rkn[i],
                    leftAnkle:     lan[i], rightAnkle:    ran[i]
                )
            }
        }

        return out
    }

    /// Remove points from the tail that form a sharp kink (>70°) relative to
    /// the dominant flight direction (computed from the full trajectory).
    private func trimTailKinks(
        _ pts: [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)]
    ) -> [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)] {
        guard pts.count >= 4 else { return pts }
        let n = pts.count

        let dx0 = pts[n - 1].x - pts[0].x
        let dy0 = pts[n - 1].y - pts[0].y
        let len0 = sqrt(dx0*dx0 + dy0*dy0)
        guard len0 > 1 else { return pts }
        let dirX = dx0 / len0
        let dirY = dy0 / len0

        let checkStart = max(1, Int(Double(n) * 0.60))
        let cosThreshold = cos(70.0 * .pi / 180.0)  // ~0.342

        var cutIndex = n
        for i in checkStart..<(n - 1) {
            let sdx = pts[i + 1].x - pts[i].x
            let sdy = pts[i + 1].y - pts[i].y
            let slen = sqrt(sdx*sdx + sdy*sdy)
            guard slen > 0.5 else { continue }
            let cosAngle = (sdx * dirX + sdy * dirY) / slen
            if cosAngle < cosThreshold {
                cutIndex = i + 1
                break
            }
        }

        return Array(pts[0..<cutIndex])
    }

    // MARK: - Ball Trail Drawing

    private func drawBallTrail(
        ctx: CGContext,
        smoothedTrajectory: [(frameIndex: Int, x: Double, y: Double, r: UInt8, g: UInt8, b: UInt8)],
        currentFrame: Int,
        outWidth: Int,
        outHeight: Int
    ) {
        // Slice trajectory up to current frame — strictly forward, never re-visits earlier points
        let visible = smoothedTrajectory.filter { $0.frameIndex <= currentFrame }
        guard visible.count >= 2 else { return }

        // Keep last 25 points for the visible trail window
        let trail = visible.count > 25 ? Array(visible.suffix(25)) : visible
        let n = trail.count
        let sc = max(0.5, Double(outWidth) / 1080.0)

        // Build Catmull-Rom spline through trail points for smooth curve rendering
        // Subdivide each segment into `steps` sub-points
        let steps = 6
        var spline: [(x: Double, y: Double)] = []
        for i in 0..<(n - 1) {
            let p0 = i > 0     ? trail[i - 1] : trail[i]
            let p1 = trail[i]
            let p2 = trail[i + 1]
            let p3 = i < n - 2 ? trail[i + 2] : trail[i + 1]
            for s in 0..<steps {
                let t = Double(s) / Double(steps)
                let t2 = t * t, t3 = t2 * t
                let x = 0.5 * ((2*p1.x) + (-p0.x + p2.x)*t
                    + (2*p0.x - 5*p1.x + 4*p2.x - p3.x)*t2
                    + (-p0.x + 3*p1.x - 3*p2.x + p3.x)*t3)
                let y = 0.5 * ((2*p1.y) + (-p0.y + p2.y)*t
                    + (2*p0.y - 5*p1.y + 4*p2.y - p3.y)*t2
                    + (-p0.y + 3*p1.y - 3*p2.y + p3.y)*t3)
                spline.append((x, y))
            }
        }
        // Add the final point
        if let last = trail.last { spline.append((last.x, last.y)) }
        let sn = spline.count
        guard sn >= 2 else { return }

        // Draw glow trail along spline
        for i in 1..<sn {
            let t = Double(i) / Double(sn)
            let fade = pow(t, 0.5)         // faster fade-in so head is brighter
            let alpha = CGFloat(fade)

            // Color: use the last trail point's colour (all red for now)
            let r = CGFloat(trail.last?.r ?? 255) / 255.0
            let g = CGFloat(trail.last?.g ?? 30)  / 255.0
            let b = CGFloat(trail.last?.b ?? 30)  / 255.0

            let coreW = CGFloat(max(2, Int((2.5 + t * 3.5) * sc)))

            // Outer glow first (drawn under core)
            let glowW = coreW + CGFloat(7 * sc)
            ctx.setStrokeColor(CGColor(red: r * 0.6, green: g * 0.6, blue: b * 0.6, alpha: alpha * 0.25))
            ctx.setLineWidth(glowW)
            ctx.setLineCap(.round)
            ctx.move(to: CGPoint(x: spline[i-1].x, y: spline[i-1].y))
            ctx.addLine(to: CGPoint(x: spline[i].x, y: spline[i].y))
            ctx.strokePath()

            // Core line
            ctx.setStrokeColor(CGColor(red: r, green: g, blue: b, alpha: alpha))
            ctx.setLineWidth(coreW)
            ctx.setLineCap(.round)
            ctx.move(to: CGPoint(x: spline[i-1].x, y: spline[i-1].y))
            ctx.addLine(to: CGPoint(x: spline[i].x, y: spline[i].y))
            ctx.strokePath()
        }

        // Ball head at last spline point
        if let head = spline.last {
            let headR = CGFloat(max(7, Int(10 * sc)))
            let r = CGFloat(trail.last?.r ?? 255) / 255.0
            let g = CGFloat(trail.last?.g ?? 30)  / 255.0
            let b = CGFloat(trail.last?.b ?? 30)  / 255.0

            // Halo
            let haloR = headR + CGFloat(max(8, Int(12 * sc)))
            ctx.setFillColor(CGColor(red: r, green: g, blue: b, alpha: 0.25))
            ctx.fillEllipse(in: CGRect(x: head.x - Double(haloR), y: head.y - Double(haloR),
                                       width: Double(haloR*2), height: Double(haloR*2)))
            // Core circle
            ctx.setFillColor(CGColor(red: r, green: g, blue: b, alpha: 1.0))
            ctx.fillEllipse(in: CGRect(x: head.x - Double(headR), y: head.y - Double(headR),
                                       width: Double(headR*2), height: Double(headR*2)))
            // White hotspot
            let hotR = CGFloat(max(2, Int(3 * sc)))
            ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.9))
            ctx.fillEllipse(in: CGRect(x: head.x - Double(hotR), y: head.y - Double(hotR),
                                       width: Double(hotR*2), height: Double(hotR*2)))
        }
    }

    // MARK: - Pose Skeleton

    private func drawPoseSkeleton(ctx: CGContext, pose: PoseLandmarks, scale: Double) {
        let sc = CGFloat(scale)

        // Scale landmark from display coords to overlay coords
        func pt(_ p: CGPoint?) -> CGPoint? {
            guard let p = p else { return nil }
            return CGPoint(x: p.x * sc, y: p.y * sc)
        }

        let lShoulder  = pt(pose.leftShoulder)
        let rShoulder  = pt(pose.rightShoulder)
        let lElbow     = pt(pose.leftElbow)
        let rElbow     = pt(pose.rightElbow)
        let lWrist     = pt(pose.leftWrist)
        let rWrist     = pt(pose.rightWrist)
        let lHip       = pt(pose.leftHip)
        let rHip       = pt(pose.rightHip)
        let lKnee      = pt(pose.leftKnee)
        let rKnee      = pt(pose.rightKnee)
        let lAnkle     = pt(pose.leftAnkle)
        let rAnkle     = pt(pose.rightAnkle)

        // Bone connections: (from, to)
        let bones: [(CGPoint?, CGPoint?)] = [
            // Shoulders
            (lShoulder, rShoulder),
            // Left arm
            (lShoulder, lElbow), (lElbow, lWrist),
            // Right arm
            (rShoulder, rElbow), (rElbow, rWrist),
            // Torso
            (lShoulder, lHip), (rShoulder, rHip), (lHip, rHip),
            // Left leg (with knee)
            (lHip, lKnee), (lKnee, lAnkle),
            // Right leg (with knee)
            (rHip, rKnee), (rKnee, rAnkle),
        ]

        let lineWidth = CGFloat(max(1.5, 2.5 * scale))
        let dotRadius = CGFloat(max(2.0, 3.5 * scale))

        // Draw bones
        ctx.setLineWidth(lineWidth)
        ctx.setLineCap(.round)
        for (a, b) in bones {
            guard let a = a, let b = b else { continue }
            // Black outline for contrast
            ctx.setStrokeColor(CGColor(red: 0, green: 0, blue: 0, alpha: 0.4))
            ctx.setLineWidth(lineWidth + CGFloat(1.5 * scale))
            ctx.move(to: a); ctx.addLine(to: b); ctx.strokePath()
            // Cyan bone line
            ctx.setStrokeColor(CGColor(red: 0.0, green: 0.9, blue: 0.9, alpha: 0.85))
            ctx.setLineWidth(lineWidth)
            ctx.move(to: a); ctx.addLine(to: b); ctx.strokePath()
        }

        // Draw joint dots
        let joints: [CGPoint?] = [lShoulder, rShoulder, lElbow, rElbow, lWrist, rWrist, lHip, rHip, lKnee, rKnee, lAnkle, rAnkle]
        for joint in joints {
            guard let j = joint else { continue }
            let r = dotRadius
            ctx.setFillColor(CGColor(red: 1.0, green: 1.0, blue: 0.2, alpha: 0.9))
            ctx.fillEllipse(in: CGRect(x: j.x - r, y: j.y - r, width: r*2, height: r*2))
        }
    }

    // MARK: - Speed Text

    private func drawSpeedText(
        ctx: CGContext,
        speedInfo: SpeedInfo,
        outWidth: Int,
        outHeight: Int,
        alpha: Double
    ) {
        guard let speedKmh = speedInfo.releaseSpeedKmh ?? speedInfo.initialSpeedKmh else { return }
        let mph = Int(round(speedKmh * KMH_TO_MPH))
        let text = "\(mph) mph"

        let fontSize = CGFloat(outWidth) * 0.06
        let font = UIFont.boldSystemFont(ofSize: fontSize)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font,
            .foregroundColor: UIColor.white.withAlphaComponent(CGFloat(alpha)),
            .strokeColor: UIColor.black.withAlphaComponent(CGFloat(alpha * 0.8)),
            .strokeWidth: -3.0,
        ]

        let attrStr = NSAttributedString(string: text, attributes: attrs)
        let textSize = attrStr.size()
        let x = CGFloat(outWidth) * 0.05
        // ctx is already y-flipped (y-up). UIKit draws y-down from the given origin,
        // so place text at outHeight * 0.92 to appear near the top-left in the video.
        let y = CGFloat(outHeight) * 0.92

        UIGraphicsPushContext(ctx)
        attrStr.draw(at: CGPoint(x: x, y: y))

        // Pitch type below speed text (further down in y-down = smaller y in y-up ctx)
        if let pitchType = speedInfo.pitchType, pitchType != "Unknown" {
            let typeAttrs: [NSAttributedString.Key: Any] = [
                .font: UIFont.boldSystemFont(ofSize: fontSize * 0.5),
                .foregroundColor: UIColor.yellow.withAlphaComponent(CGFloat(alpha)),
                .strokeColor: UIColor.black.withAlphaComponent(CGFloat(alpha * 0.8)),
                .strokeWidth: -2.0,
            ]
            let typeStr = NSAttributedString(string: pitchType, attributes: typeAttrs)
            typeStr.draw(at: CGPoint(x: x, y: y - textSize.height - 4))
        }

        UIGraphicsPopContext()
    }

    // MARK: - Strike Zone

    /// Draw the calibrated strike zone as a flat 2D plane in the video frame.
    private func drawFullFrameStrikeZone(
        ctx: CGContext,
        speedInfo: SpeedInfo,
        outWidth: Int,
        outHeight: Int,
        alpha: Double
    ) {
        let zone = speedInfo.plateZone ?? DEFAULT_STRIKE_ZONE
        let xMin = CGFloat((zone["x_min"] ?? STRIKE_ZONE_X_MIN) * Double(outWidth))
        let xMax = CGFloat((zone["x_max"] ?? STRIKE_ZONE_X_MAX) * Double(outWidth))
        let yMin = CGFloat((zone["y_min"] ?? STRIKE_ZONE_Y_MIN) * Double(outHeight))
        let yMax = CGFloat((zone["y_max"] ?? STRIKE_ZONE_Y_MAX) * Double(outHeight))
        let w = xMax - xMin
        let h = yMax - yMin
        guard w > 4, h > 4 else { return }

        ctx.saveGState()
        defer { ctx.restoreGState() }

        let sc = max(0.5, Double(outWidth) / 1080.0)
        let rect = CGRect(x: xMin, y: yMin, width: w, height: h)
        ctx.setFillColor(CGColor(red: 1.0, green: 0.84, blue: 0.29, alpha: 0.10 * alpha))
        ctx.fill(rect)

        ctx.setLineCap(.round)
        ctx.setStrokeColor(CGColor(red: 0.0, green: 0.0, blue: 0.0, alpha: 0.45 * alpha))
        ctx.setLineWidth(CGFloat(max(4.0, 5.0 * sc)))
        ctx.stroke(rect)

        ctx.setStrokeColor(CGColor(red: 1.0, green: 0.84, blue: 0.29, alpha: 0.95 * alpha))
        ctx.setLineWidth(CGFloat(max(2.0, 3.0 * sc)))
        ctx.stroke(rect)

        ctx.setStrokeColor(CGColor(red: 1.0, green: 0.84, blue: 0.29, alpha: 0.55 * alpha))
        ctx.setLineWidth(CGFloat(max(1.0, 1.5 * sc)))
        ctx.setLineDash(phase: 0, lengths: [CGFloat(8 * sc), CGFloat(6 * sc)])
        for t in [CGFloat(1.0 / 3.0), CGFloat(2.0 / 3.0)] {
            let x = rect.minX + rect.width * t
            ctx.move(to: CGPoint(x: x, y: rect.minY))
            ctx.addLine(to: CGPoint(x: x, y: rect.maxY))
            ctx.strokePath()

            let y = rect.minY + rect.height * t
            ctx.move(to: CGPoint(x: rect.minX, y: y))
            ctx.addLine(to: CGPoint(x: rect.maxX, y: y))
            ctx.strokePath()
        }
        ctx.setLineDash(phase: 0, lengths: [])
    }

    /// Draw a miniature strike zone in the bottom-right corner showing pitch location.
    private func drawStrikeZone(
        ctx: CGContext,
        speedInfo: SpeedInfo,
        outWidth: Int,
        outHeight: Int,
        alpha: Double
    ) {
        guard let xNorm = speedInfo.plateXNorm, let yNorm = speedInfo.plateYNorm else { return }

        // ctx is already in y-flipped space (y increases upward, origin bottom-left).
        // UIKit APIs (UIBezierPath, NSAttributedString.draw) also follow current CTM,
        // so they draw correctly in this flipped space as long as coordinates are expressed
        // in the same flipped system (y=0 is bottom, y=outHeight is top).
        // Place the strike zone box in the top-right: in flipped coords top = large y.
        ctx.saveGState()
        UIGraphicsPushContext(ctx)
        defer {
            UIGraphicsPopContext()
            ctx.restoreGState()
        }

        let sc = max(0.5, Double(outWidth) / 1080.0)

        // boxW:boxH must match StrikeZone.tsx zoneW:zoneH = (230-32-16):(270-24-36) = 182:210
        let boxW = CGFloat(130 * sc)
        let boxH = boxW * (210.0 / 182.0)
        let labelH = CGFloat(22 * sc)
        let totalH = boxH + labelH
        let margin = CGFloat(14 * sc)
        let boxX = CGFloat(outWidth) - boxW - margin
        // In flipped coords: top-right corner = (outWidth, outHeight).
        // Place box so its top (labelH) starts near the top of the frame.
        let boxY = CGFloat(outHeight) - totalH - margin

        // Background pill: covers label area + zone box
        let bgPath = UIBezierPath(roundedRect: CGRect(x: boxX - CGFloat(6*sc), y: boxY, width: boxW + CGFloat(12*sc), height: totalH), cornerRadius: CGFloat(8*sc))
        UIColor(white: 0, alpha: CGFloat(alpha * 0.55)).setFill()
        bgPath.fill()

        // Strike zone rectangle (below the label row)
        let zoneRect = CGRect(x: boxX, y: boxY + labelH, width: boxW, height: boxH)
        UIColor(red: 0.3, green: 0.6, blue: 1.0, alpha: CGFloat(alpha * 0.25)).setFill()
        UIBezierPath(roundedRect: zoneRect, cornerRadius: 2*sc).fill()
        UIColor(red: 0.3, green: 0.6, blue: 1.0, alpha: CGFloat(alpha * 0.8)).setStroke()
        let zonePath = UIBezierPath(roundedRect: zoneRect, cornerRadius: 2*sc)
        zonePath.lineWidth = CGFloat(1.5 * sc)
        zonePath.stroke()

        // Grid lines (thirds)
        UIColor(white: 1.0, alpha: CGFloat(alpha * 0.2)).setStroke()
        for t in [1.0/3.0, 2.0/3.0] {
            let vPath = UIBezierPath()
            vPath.move(to: CGPoint(x: zoneRect.minX + zoneRect.width * t, y: zoneRect.minY))
            vPath.addLine(to: CGPoint(x: zoneRect.minX + zoneRect.width * t, y: zoneRect.maxY))
            vPath.lineWidth = CGFloat(sc)
            vPath.setLineDash([CGFloat(2*sc), CGFloat(2*sc)], count: 2, phase: 0)
            vPath.stroke()

            let hPath = UIBezierPath()
            hPath.move(to: CGPoint(x: zoneRect.minX, y: zoneRect.minY + zoneRect.height * t))
            hPath.addLine(to: CGPoint(x: zoneRect.maxX, y: zoneRect.minY + zoneRect.height * t))
            hPath.lineWidth = CGFloat(sc)
            hPath.setLineDash([CGFloat(2*sc), CGFloat(2*sc)], count: 2, phase: 0)
            hPath.stroke()
        }

        // Home plate pentagon (below zone rect = larger y in UIKit y-down = zoneRect.maxY)
        let plateW = zoneRect.width * 0.7
        let plateH = CGFloat(8 * sc)
        let px = zoneRect.minX + (zoneRect.width - plateW) / 2
        let py = zoneRect.maxY + CGFloat(3 * sc)
        let platePath = UIBezierPath()
        platePath.move(to: CGPoint(x: px, y: py))
        platePath.addLine(to: CGPoint(x: px + plateW, y: py))
        platePath.addLine(to: CGPoint(x: px + plateW, y: py + plateH * 0.6))
        platePath.addLine(to: CGPoint(x: px + plateW / 2, y: py + plateH))
        platePath.addLine(to: CGPoint(x: px, y: py + plateH * 0.6))
        platePath.close()
        UIColor(white: 0.7, alpha: CGFloat(alpha * 0.4)).setFill()
        platePath.fill()
        UIColor(white: 0.7, alpha: CGFloat(alpha * 0.6)).setStroke()
        platePath.lineWidth = CGFloat(sc)
        platePath.stroke()

        // xNorm/yNorm are raw frame-normalized (0=frame edge, 1=frame edge).
        // Re-map to zone-relative [0,1] using the same boundaries as
        // SpeedgunPipeline and StrikeZone.tsx DEFAULT_ZONE.
        let zone = speedInfo.plateZone ?? DEFAULT_STRIKE_ZONE
        let zoneXMin = zone["x_min"] ?? STRIKE_ZONE_X_MIN
        let zoneXMax = zone["x_max"] ?? STRIKE_ZONE_X_MAX
        let zoneYMin = zone["y_min"] ?? STRIKE_ZONE_Y_MIN
        let zoneYMax = zone["y_max"] ?? STRIKE_ZONE_Y_MAX
        let xZoneNorm = (xNorm - zoneXMin) / (zoneXMax - zoneXMin)
        // UIKit in y-up CTM: CGRect.y is the visual top (UIKit internally applies an
        // additional flip), so zoneRect.minY = visual top = High, zoneRect.maxY = visual bottom = Low.
        // yNorm=yZoneMin(small) = High → yZoneNorm=0 → minY (visual top). No flip needed.
        let yZoneNorm = (yNorm - zoneYMin) / (zoneYMax - zoneYMin)

        // Map zone-relative into zoneRect pixels (allow ±20% overflow for near-misses)
        let dotX = zoneRect.minX + zoneRect.width  * CGFloat(clamp(xZoneNorm, min: -0.2, max: 1.2))
        let dotY = zoneRect.minY + zoneRect.height * CGFloat(clamp(yZoneNorm, min: -0.2, max: 1.2))

        // Strike: zone-relative coords within [0, 1]
        let isStrike = xZoneNorm >= 0.0 && xZoneNorm <= 1.0 && yZoneNorm >= 0.0 && yZoneNorm <= 1.0
        let dotColorR: CGFloat = isStrike ? 0.2 : 1.0
        let dotColorG: CGFloat = isStrike ? 0.85 : 0.25
        let dotColorB: CGFloat = isStrike ? 0.4 : 0.25

        let dotR = CGFloat(max(5, Int(7 * sc)))
        let haloR = dotR + CGFloat(4 * sc)
        // Halo
        UIColor(red: dotColorR, green: dotColorG, blue: dotColorB, alpha: CGFloat(alpha * 0.35)).setFill()
        UIBezierPath(ovalIn: CGRect(x: dotX - haloR, y: dotY - haloR, width: haloR*2, height: haloR*2)).fill()
        // Core dot
        UIColor(red: dotColorR, green: dotColorG, blue: dotColorB, alpha: CGFloat(alpha)).setFill()
        UIBezierPath(ovalIn: CGRect(x: dotX - dotR, y: dotY - dotR, width: dotR*2, height: dotR*2)).fill()
        // White centre
        let hotR = CGFloat(max(2, Int(3 * sc)))
        UIColor(white: 1.0, alpha: CGFloat(alpha * 0.9)).setFill()
        UIBezierPath(ovalIn: CGRect(x: dotX - hotR, y: dotY - hotR, width: hotR*2, height: hotR*2)).fill()

        // Label "STRIKE" or "BALL" — in the label row at top of the bg pill
        let label = isStrike ? "STRIKE" : "BALL"
        let labelColor = isStrike
            ? UIColor(red: 0.2, green: 0.85, blue: 0.4, alpha: CGFloat(alpha))
            : UIColor(red: 1.0, green: 0.35, blue: 0.35, alpha: CGFloat(alpha))
        let labelFont = UIFont.boldSystemFont(ofSize: CGFloat(max(9, Int(12 * sc))))
        let labelAttrs: [NSAttributedString.Key: Any] = [
            .font: labelFont,
            .foregroundColor: labelColor,
            .strokeColor: UIColor(white: 0, alpha: CGFloat(alpha * 0.7)),
            .strokeWidth: -2.0,
        ]
        let labelStr = NSAttributedString(string: label, attributes: labelAttrs)
        let labelSize = labelStr.size()
        // Center label in the labelH band at top of the bg pill
        let labelDrawY = boxY + (labelH - labelSize.height) / 2
        labelStr.draw(at: CGPoint(x: boxX + (boxW - labelSize.width) / 2, y: labelDrawY))
    }

    // MARK: - Helpers

    private func statusName(_ status: AVAssetReader.Status?) -> String {
        guard let status = status else { return "nil" }
        switch status {
        case .unknown: return "unknown"
        case .reading: return "reading"
        case .completed: return "completed"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        @unknown default: return "unknown_default"
        }
    }

    private func statusName(_ status: AVAssetWriter.Status) -> String {
        switch status {
        case .unknown: return "unknown"
        case .writing: return "writing"
        case .completed: return "completed"
        case .failed: return "failed"
        case .cancelled: return "cancelled"
        @unknown default: return "unknown_default"
        }
    }
}
