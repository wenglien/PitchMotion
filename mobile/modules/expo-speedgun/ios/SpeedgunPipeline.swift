import AVFoundation
import Accelerate
import CoreVideo
import Foundation

/// Main pipeline orchestrator. Wires all stages together.
/// Port of src/pipelines/yolov8_pipeline.py + get_pitch_frames_yolov8.py
final class SpeedgunPipeline {
    private let progressCallback: (PipelineProgress) -> Void
    private let AUDIO_CATCH_MIN_OFFSET_SEC = 0.10
    private let AUDIO_CATCH_MAX_OFFSET_SEC = 1.50
    private let AUDIO_CATCH_VISUAL_MAX_DIVERGENCE_SEC = 0.75

    init(progressCallback: @escaping (PipelineProgress) -> Void) {
        self.progressCallback = progressCallback
    }

    func analyze(
        videoUri: String,
        moundDistance: Double,
        strideCorrectionM: Double?,
        confThreshold: Double,
        pitcherHeightM: Double? = nil,
        strikeZone: [String: Double]? = nil
    ) async throws -> [String: Any] {
        // Resolve URI to file URL
        let videoURL: URL
        if videoUri.hasPrefix("file://") {
            guard let u = URL(string: videoUri) else {
                throw SpeedgunError.videoLoadFailed("Invalid file URI: \(videoUri)")
            }
            videoURL = u
        } else if videoUri.hasPrefix("/") {
            videoURL = URL(fileURLWithPath: videoUri)
        } else if videoUri.hasPrefix("ph://") {
            // Photos library asset — need to export first
            throw SpeedgunError.videoLoadFailed("Photos library assets not yet supported. Please use a file path.")
        } else {
            videoURL = URL(string: videoUri) ?? URL(fileURLWithPath: videoUri)
        }

        guard FileManager.default.fileExists(atPath: videoURL.path) else {
            throw SpeedgunError.videoLoadFailed("File not found: \(videoURL.path)")
        }
        let manualStrikeZone = strikeZone != nil
        var resolvedStrikeZone = resolveStrikeZone(strikeZone)

        // Stage 1: Video Setup
        reportProgress("setup", 0.02, "Loading video...")

        // ── HDR→SDR conversion: iPhone HLG/Dolby Vision causes washed-out frames ──
        var effectiveURL = videoURL
        var sdrTempURL: URL?
        let probeDecoder = try VideoDecoder(url: videoURL)
        if probeDecoder.isHDR {
            reportProgress("setup", 0.02, "HDR video detected, converting to SDR...")
            NSLog("[SpeedgunPipeline] HDR detected — starting SDR conversion")
            if let sdrURL = await VideoDecoder.convertHDRtoSDR(sourceURL: videoURL) {
                effectiveURL = sdrURL
                sdrTempURL = sdrURL
                reportProgress("setup", 0.03, "HDR→SDR conversion complete")
            } else {
                reportProgress("setup", 0.03, "HDR→SDR conversion failed, using original")
                NSLog("[SpeedgunPipeline] HDR→SDR conversion failed, proceeding with original")
            }
        }

        let decoder = try VideoDecoder(url: effectiveURL)
        let displayWidth = decoder.displayWidth
        let displayHeight = decoder.displayHeight
        let fps = decoder.fps
        let totalFrames = decoder.totalFrames

        // Optical-flow interpolation:
        // ENABLED  for normal/high-fps video (captureFps < 120): doubles frame density,
        //          reducing per-frame ball displacement and improving YOLO detection.
        //          30fps → 60fps effective, 60fps → 120fps effective.
        // DISABLED for slo-mo video (captureFps >= 120): frames already extremely dense
        //          (240fps real = 7.5px/frame ball movement). Synthesising mid-frames wastes
        //          CPU, adds near-identical YOLO passes, and doubles the static-FP counter
        //          tick rate — making the real ball look "static" even faster.
        let useInterpolation = decoder.captureFps < 120
        let interpolator: FrameInterpolator? = useInterpolation ? (try? FrameInterpolator()) : nil

        // effectiveFps       — display/playback fps after interpolation (frame count & progress)
        // effectiveCaptureFps — true capture fps after interpolation (speed calculation & timing)
        // For normal 30fps:   effectiveFps=60, effectiveCaptureFps=60  (interp on,  same)
        // For slo-mo 240fps:  effectiveFps=30, effectiveCaptureFps=240 (interp off, differ by 8×)
        let effectiveFps         = useInterpolation ? fps * 2               : fps
        let effectiveCaptureFps  = useInterpolation ? decoder.captureFps * 2 : decoder.captureFps
        let effectiveTotalFrames = useInterpolation ? totalFrames * 2        : totalFrames

        // Log slo-mo detection
        let slowMotionFactor = decoder.captureFps / decoder.fps
        if slowMotionFactor > 1 {
            NSLog("[SpeedgunPipeline] Slo-mo detected: nominalFps=%d captureFps=%d slowMotionFactor=%dx interpolation=OFF effectiveCaptureFps=%d",
                  fps, decoder.captureFps, slowMotionFactor, effectiveCaptureFps)
        }

        let interpStr = useInterpolation ? "interp=2x" : "interp=OFF(slo-mo)"
        let captureFpsStr = decoder.captureFps != fps ? " captureFps=\(decoder.captureFps)" : ""
        reportProgress("setup", 0.04, "Video: \(displayWidth)x\(displayHeight) @ \(fps)fps\(captureFpsStr) → \(effectiveFps)fps (\(interpStr)), \(effectiveTotalFrames) frames")

        // Initialize components
        let yolo = try YOLODetector()
        let poseEstimator = PoseEstimator()
        let releaseDetector = ReleasePointDetector(fps: effectiveCaptureFps)

        // Stage 2: Phase 1 Detection
        reportProgress("detecting", 0.05, "Starting ball detection...")
        try decoder.startReading()

        var rawDetections: [RawDetection] = []
        var frameInfos: [FrameInfo] = []
        var frameIndex = 0          // counts effective frames (incl. interpolated)
        var ballDetectedCount = 0        // total number of frames where ball was seen
        // Run pose ~30 times per second in REAL time (not playback time).
        // Release timing is sensitive to pose sampling: at 120fps, the old
        // 10/s cadence only checked every 12 frames, which could miss the
        // release window and make the detected release appear late.
        // Must use effectiveFps (display fps) here because frameIndex increments at effectiveFps rate.
        // But we want ~30 poses per second of REAL time, so divide by effectiveCaptureFps.
        // For normal 30fps: effectiveCaptureFps=60 → every 2 frames.
        // For 120fps: effectiveCaptureFps=120 → every 4 frames.
        // For slo-mo 240fps: effectiveCaptureFps=240 → every 8 frames.
        let poseEveryN = max(1, Int(round(Double(effectiveCaptureFps) / 30.0)))
        // stride=1: every real frame goes through YOLO; interpolated frames always run YOLO too
        let yoloStride = 1
        var lastPose: PoseLandmarks? = nil
        var prevPixelBuffer: CVPixelBuffer? = nil   // kept for interpolation

        // Static FP tracking
        var staticDetections: [Int: [(cx: Double, cy: Double, area: Double, count: Int)]] = [:]

        // Dynamic static-FP radius: must scale by effectiveCaptureFps (real capture rate),
        // NOT effectiveFps (display rate). For slo-mo, effectiveFps=30 but effectiveCaptureFps=240.
        //
        // Physics: at 90mph (40m/s) pitching 18.44m, ball moves X px in 6 effective frames:
        //   Normal 30fps (effectiveCaptureFps=60):  40 * (6/60)  * (720/18.44) ≈ 156px  → OK near threshold
        //   Slo-mo 240fps (effectiveCaptureFps=240): 40 * (6/240) * (720/18.44) ≈  39px  → far below 150px!
        // Without scaling, slo-mo ball (39px movement) is incorrectly flagged as static.
        // With scaling: radius = 150 * (240/60) = 600px → 39px < 600px → not static ✓
        let dynamicStaticRadius = HC_STATIC_RADIUS * max(1.0, Double(effectiveCaptureFps) / 60.0)
        // Scale static-FP persistence threshold with real capture fps too:
        // at 120fps effective, a truly-static object is visible 2× more often in the same
        // wall-clock window than at 60fps — without scaling, a swaying fence-post etc. that
        // happened to persist for 6 frames (0.05s at 120fps) could wrongly kill a real ball
        // detection. Scale so the threshold stays ~0.1s of real time.
        let dynamicStaticMinPersist = max(HC_STATIC_MIN_PERSIST,
            Int(round(Double(HC_STATIC_MIN_PERSIST) * Double(effectiveCaptureFps) / 60.0)))

        // 4K detection target size: larger canvas so the ball isn't sub-pixel after scaling.
        // 1080p portrait (1080×1920): scale=0.667, ball ~30px in letterbox — good at 1280.
        // 4K portrait (2160×3840):    letterbox scale at 2560 = 2560/3840 = 0.667 → ball ~30px.
        //                             (was 1920 → scale 0.5 → ball ~20px, borderline sub-pixel for YOLO.)
        // 4K landscape (3840×2160):   also 2560 → equal treatment.
        let is4K = displayWidth > 2000 || displayHeight > 2000
        let yoloTargetSize = is4K ? 2560 : 1280
        if is4K {
            NSLog("[SpeedgunPipeline] 4K video detected (%dx%d) — using YOLO targetSize=%d",
                  displayWidth, displayHeight, yoloTargetSize)
        }

        /// Process one CVPixelBuffer (real or interpolated) through pose + YOLO
        func processFrame(_ pixelBuffer: CVPixelBuffer, isInterpolated: Bool) {
            var fi = FrameInfo(frameIndex: frameIndex)

            // Pose: skip on interpolated frames (pose doesn't change between adjacent frames)
            if !isInterpolated && frameIndex % poseEveryN == 0 {
                let pose = poseEstimator.detect(
                    pixelBuffer: pixelBuffer,
                    frameIndex: frameIndex,
                    displayWidth: displayWidth,
                    displayHeight: displayHeight
                )
                if pose != nil { lastPose = pose }
                releaseDetector.addFrame(pose)
            } else if !isInterpolated {
                releaseDetector.addFrame(nil)
            }
            fi.poseLandmarks = lastPose

            // YOLO: stride applies only to real frames; always run on interpolated
            var dets: [BallDetection] = []
            let runYolo = isInterpolated || (frameIndex % yoloStride == 0)
            if runYolo {
                dets = yolo.detectHighRes(
                    pixelBuffer: pixelBuffer,
                    frameIndex: frameIndex,
                    displayWidth: displayWidth,
                    displayHeight: displayHeight,
                    confThreshold: confThreshold,
                    targetSize: yoloTargetSize
                )
                dets = filterStaticFP(dets: dets, staticTracker: &staticDetections,
                                      frameIndex: frameIndex, staticRadius: dynamicStaticRadius,
                                      minPersist: dynamicStaticMinPersist)
            }

            // Kalman ROI recovery
            if dets.isEmpty, let roi = yolo.kalmanROI(displayWidth: displayWidth, displayHeight: displayHeight) {
                dets = yolo.detectInROI(
                    pixelBuffer: pixelBuffer,
                    roi: roi,
                    frameIndex: frameIndex,
                    displayWidth: displayWidth,
                    displayHeight: displayHeight,
                    confThreshold: KALMAN_ROI_MIN_CONF
                )
            }

            rawDetections.append(RawDetection(frameIndex: frameIndex, detections: dets))

            if let best = dets.max(by: { $0.confidence < $1.confidence }) {
                fi.ballInFrame = true
                fi.ballCenter = best.center
                fi.ballColor = (255, 30, 30)
                fi.ballArea = best.area
                yolo.kalmanUpdate(cx: best.cx, cy: best.cy)
                ballDetectedCount += 1
            }

            frameInfos.append(fi)
            frameIndex += 1

            if frameIndex % 10 == 0 {
                let pct = 0.05 + 0.50 * Double(frameIndex) / Double(max(1, effectiveTotalFrames))
                reportProgress("detecting", pct, "Frame \(frameIndex)/\(effectiveTotalFrames)")
            }
        }

        // Diagnostic: log first-frame attempt so we know if nextFrame() ever yields
        do {
            let readerStatus = decoder.readerStatus
            NSLog("[SpeedgunPipeline] Detection loop start — readerStatus=%d totalFrames=%d effectiveTotalFrames=%d",
                  readerStatus.rawValue, totalFrames, effectiveTotalFrames)
        }

        // Always use 1280px high-res detection (full flight mode from frame 0)
        while let pixelBuffer = decoder.nextFrame() {
            autoreleasepool {
                // If interpolation is on and we have a previous frame, insert the mid-frame first.
                // If interpolate() fails (e.g. Metal error), insert a blank slot to keep
                // frameIndex in sync with effectiveFps (every real frame = 2 effective frames).
                if useInterpolation, let prev = prevPixelBuffer {
                    if let interp = interpolator,
                       let midFrame = interp.interpolate(frameA: prev, frameB: pixelBuffer) {
                        processFrame(midFrame, isInterpolated: true)
                    } else {
                        // Interpolation failed: advance frameIndex by 1 to stay in sync
                        frameInfos.append(FrameInfo(frameIndex: frameIndex))
                        rawDetections.append(RawDetection(frameIndex: frameIndex, detections: []))
                        frameIndex += 1
                    }
                }

                // Process the real frame
                processFrame(pixelBuffer, isInterpolated: false)

                // Keep reference for next iteration's interpolation
                prevPixelBuffer = pixelBuffer
            }

            // Early stop disabled: always scan the full video to avoid missing the ball.
        }

        NSLog("[SpeedgunPipeline] Detection loop ended — frameIndex=%d ballDetectedCount=%d", frameIndex, ballDetectedCount)
        decoder.stopReading()

        // YOLO detection summary
        let yoloFramesProcessed = frameIndex
        let yoloRawDetectionFrames = rawDetections.filter { !$0.detections.isEmpty }.count
        let yoloTotalDetections = rawDetections.reduce(0) { $0 + $1.detections.count }
        let yoloBallInFrameCount = frameInfos.filter { $0.ballInFrame }.count
        NSLog("[SpeedgunPipeline] YOLO summary: processed=%d raw_det_frames=%d total_dets=%d ball_in_frame=%d",
              yoloFramesProcessed, yoloRawDetectionFrames, yoloTotalDetections, yoloBallInFrameCount)

        // Stage 3: Phase 1.5 Gap Fill (polynomial interpolation)
        reportProgress("tracking", 0.56, "Filling trajectory gaps...")
        fillLostTracking(frameInfos: &frameInfos, maxGapFrames: 30, fps: effectiveFps)

        // Stage 4: Phase 2 SORT Tracking
        // Scale maxAge by effectiveCaptureFps to give ~0.5s of REAL-TIME gap tolerance.
        // Must use effectiveCaptureFps (not effectiveFps) — for slo-mo they differ:
        //   effectiveFps=30 → maxAge=15 (0.5s playback = 0.0625s real at 240fps) ← WRONG
        //   effectiveCaptureFps=240 → maxAge=120 (0.5s real) ← CORRECT
        // Scaling table:
        //   Normal 30fps:  effectiveCaptureFps=60  → maxAge=30  (0.5s real)
        //   Normal 120fps: effectiveCaptureFps=240 → maxAge=120 (0.5s real)
        //   Slo-mo 240fps: effectiveCaptureFps=240 → maxAge=120 (0.5s real)
        reportProgress("tracking", 0.58, "Running SORT tracker...")
        let effectiveMaxAge = max(10, Int(round(Double(effectiveCaptureFps) * 0.5)))
        let sortTracker = SORTTracker(maxAge: effectiveMaxAge, minHits: 1, iouThreshold: 0.1)
        var tracks: [Int: [TrackPoint]] = [:]

        for rd in rawDetections {
            let dets = rd.detections.map { d in
                (d.x1, d.y1, d.x2, d.y2, d.confidence)
            }
            let results = sortTracker.update(detections: dets)
            for r in results {
                let trackId = Int(r.4)
                let cx = (r.0 + r.2) / 2
                let cy = (r.1 + r.3) / 2
                let area = (r.2 - r.0) * (r.3 - r.1)
                let point = TrackPoint(frameIndex: rd.frameIndex, cx: cx, cy: cy, area: area, trackId: trackId)
                tracks[trackId, default: []].append(point)
            }
        }

        // Find best track (longest, with most vertical movement)
        let minTrackPoints = effectiveFps >= 60 ? 1 : 3
        let bestTrack = selectBestTrack(tracks: tracks, frameHeight: displayHeight, minPoints: minTrackPoints)

        // Update frameInfos from best track.
        // Strategy: use SORT track points as the authoritative positions for
        // frames that SORT covered. For frames outside the SORT track window
        // (i.e. before the first SORT point or after the last), clear them to
        // eliminate pre-pitch hand/arm false positives that Phase-1 detected.
        if let track = bestTrack {
            let sortFirstFrame = track.map { $0.frameIndex }.min() ?? 0
            let sortLastFrame  = track.map { $0.frameIndex }.max() ?? 0

            // 1. Clear all Phase-1 / gap-fill detections OUTSIDE the SORT window.
            //    This removes pre-pitch FPs (hand/arm blobs seen before ball release).
            for i in 0..<frameInfos.count {
                let fid = frameInfos[i].frameIndex
                if fid < sortFirstFrame || fid > sortLastFrame {
                    frameInfos[i].ballInFrame = false
                    frameInfos[i].ballLostTracking = false
                }
            }

            // 2. Overwrite positions for frames the SORT track explicitly covers.
            //    Keep gap-fill points inside the window — they help speed calc.
            for tp in track {
                if tp.frameIndex < frameInfos.count {
                    frameInfos[tp.frameIndex].ballInFrame = true
                    frameInfos[tp.frameIndex].ballCenter = CGPoint(x: tp.cx, y: tp.cy)
                    frameInfos[tp.frameIndex].ballLostTracking = false
                    if tp.area > 0 { frameInfos[tp.frameIndex].ballArea = tp.area }
                }
            }
        }
        // If bestTrack is nil, fall back to Phase-1 detections as-is (gap-fill already applied).

        reportProgress("tracking", 0.63, "Track selection complete")

        // Stage 5: Speed Calculation + Classification
        reportProgress("calculating", 0.65, "Calculating speed...")

        // Resolve actual pitching distance with explicit priority:
        //   1. User-entered moundDistance (> 0)          → "manual"
        //   2. Pose-based estimate from shoulder/body    → "pose_estimated"
        //   3. MLB default 18.44m (WARNING — inaccurate) → "default"
        // For backyard / short-distance scenes (5–10m) the default is WILDLY wrong
        // (~2× speed overestimate), so we surface a user-facing warning in SpeedInfo.
        var resolvedDistance: Double
        var distanceSource: String
        var distanceWarning: String? = nil
        if moundDistance > 0 {
            resolvedDistance = moundDistance
            distanceSource = "manual"
        } else if let est = estimatePitchingDistance(
            frameInfos: frameInfos,
            displayWidth: displayWidth,
            displayHeight: displayHeight,
            pitcherHeightM: pitcherHeightM
        ) {
            resolvedDistance = est
            distanceSource = "pose_estimated"
            distanceWarning = "距離自動估算為 \(String(format: "%.1f", est))m；建議於設定中自行量測輸入以提高準確度"
            NSLog("[SpeedgunPipeline] Distance auto-estimated from pose: %.2f m", est)
        } else {
            resolvedDistance = MLB_MOUND_DISTANCE_M
            distanceSource = "default"
            distanceWarning = "未設定投打距離，預設為 MLB 18.44m。球速可能嚴重失真，請於設定輸入實際距離"
            NSLog("[SpeedgunPipeline] ⚠️ No manual distance & pose estimate failed — falling back to MLB 18.44m")
        }

        // Use effectiveCaptureFps (true capture rate × 2) for correct real-world time.
        // For normal video effectiveCaptureFps == effectiveFps.
        // For slo-mo (e.g. 240fps captured at 30fps nominal), effectiveCaptureFps = 480
        // while effectiveFps = 60 — using effectiveFps here would make speed 8× too slow.
        // Stride correction (1.7m default) models the ball leaving the pitcher's hand
        // ~1.7m closer to the plate than the rubber, *given a real pitching stride*.
        // It only makes sense for the "manual" source (user measured rubber-to-plate).
        // For "pose_estimated" the value is already cam-to-pitcher direct geometry
        // (no rubber → second subtraction would double-count). For "default" 18.44m
        // the user hasn't even confirmed they're at MLB distance, so we shouldn't
        // bake in a stride that may not exist.
        let applyStride = (distanceSource == "manual")
        let speedCalculatorResolved = BallSpeedCalculator(
            fps: effectiveCaptureFps,
            videoWidth: displayWidth,
            videoHeight: displayHeight,
            theoreticalDistance: resolvedDistance,
            strideCorrectionM: strideCorrectionM,
            applyStrideCorrection: applyStride
        )

        // Build trajectory points
        let firstBallFrame = frameInfos.firstIndex(where: { $0.ballInFrame })
        let lastBallFrame  = frameInfos.lastIndex(where: { $0.ballInFrame })
        let trajectoryPoints: [CGPoint] = frameInfos
            .filter { $0.ballInFrame }
            .map { $0.ballCenter }
        let trajectorySamples: [BallTrajectorySample] = frameInfos
            .filter { $0.ballInFrame }
            .map {
                BallTrajectorySample(
                    frameIndex: $0.frameIndex,
                    point: $0.ballCenter,
                    isSynthetic: $0.ballLostTracking
                )
            }

        // Detect release point from pose signals, constrained by the first
        // reliable ball frame to avoid scene-dependent windup false peaks.
        let releaseResult = releaseDetector.detect(firstBallFrame: firstBallFrame)

        // Validate pose release:
        // 1. Confidence must be ≥ 0.5 (multi-signal agreement, not single weak signal)
        // 2. Must fall before firstBallFrame (ball can't be detected before release)
        // 3. Must be within MAX_PRE_DETECT_SEC before firstBallFrame in REAL time
        //    — prevents far-too-early arm-windup frames from inflating flight time
        // NOTE: all frame indices (result.frameIndex, firstBallFrame) are in effective-capture
        // space, so the correct fps to convert to real seconds is effectiveCaptureFps.
        // Using effectiveFps here would make gapSec 8× too large for slo-mo (240fps captured
        // at 30fps nominal) → every valid release would be rejected.
        let POSE_RELEASE_MIN_CONFIDENCE = 0.5
        let validatedReleaseFrame: Int? = {
            guard let result = releaseResult,
                  result.confidence >= POSE_RELEASE_MIN_CONFIDENCE,
                  let first = firstBallFrame else { return nil }
            let gapSec = Double(first - result.frameIndex) / Double(effectiveCaptureFps)
            guard gapSec >= 0 && gapSec <= MAX_PRE_DETECT_SEC else {
                NSLog("[SpeedgunPipeline] Pose release REJECTED: frame=%d conf=%.2f gap=%.3fs (max=%.2fs)",
                      result.frameIndex, result.confidence, gapSec, MAX_PRE_DETECT_SEC)
                return nil
            }
            NSLog("[SpeedgunPipeline] Pose release accepted: frame=%d conf=%.2f gap=%.3fs",
                  result.frameIndex, result.confidence, gapSec)
            return result.frameIndex
        }()

        // Detect catch impact from audio as the first-priority flight endpoint.
        // Search after release/first-ball timing; visual last frame is only a sanity reference.
        // NOTE: detectCatchImpact buckets audio samples by video frame index using fps.
        // Must use effectiveCaptureFps so the returned frameIdx is in effective-capture
        // space (matching lastBallFrame, firstBallFrame, etc.).
        // Using effectiveFps (8× smaller for slo-mo) makes the audio catch index 8× too
        // small → always rejected by the cf > last guard below.
        let audioSearchAnchorFrame = validatedReleaseFrame ?? firstBallFrame ?? lastBallFrame ?? 0
        let rawCatchFrame = detectCatchImpact(
            asset: AVAsset(url: effectiveURL),
            fps: effectiveCaptureFps,
            searchAfterFrame: audioSearchAnchorFrame,
            visualReferenceFrame: lastBallFrame
        )
        // Prefer audio when it passes basic timing checks. The visual endpoint can be
        // wrong when tracking survives on blur/hand/mitt artifacts, so it must not
        // be required to occur before the audio catch.
        let validatedCatchFrame: Int? = {
            guard let cf = rawCatchFrame else { return nil }
            if let first = firstBallFrame, cf <= first { return nil }
            let sinceAnchorSec = Double(cf - audioSearchAnchorFrame) / Double(effectiveCaptureFps)
            guard sinceAnchorSec >= AUDIO_CATCH_MIN_OFFSET_SEC,
                  sinceAnchorSec <= AUDIO_CATCH_MAX_OFFSET_SEC else { return nil }
            return cf
        }()

        if let rel = validatedReleaseFrame {
            NSLog("[SpeedgunPipeline] Validated release frame: %d (%.3fs real)",
                  rel, Double(rel)/Double(effectiveCaptureFps))
        }
        if let cf = validatedCatchFrame {
            NSLog("[SpeedgunPipeline] Validated audio catch frame: %d (%.3fs real, anchor=%d)",
                  cf, Double(cf)/Double(effectiveCaptureFps), audioSearchAnchorFrame)
        } else {
            NSLog("[SpeedgunPipeline] No valid audio catch frame — using YOLO lastFrame endpoint")
        }

        let fallbackReleaseFrame: Int? = firstBallFrame.map {
            max(0, $0 - Int(round(RELEASE_FALLBACK_SEC * Double(effectiveCaptureFps))))
        }
        let releaseMarkerFrame = validatedReleaseFrame ?? fallbackReleaseFrame
        let releaseMarkerSource = validatedReleaseFrame != nil ? "pose" : (fallbackReleaseFrame != nil ? "fallback" : nil)
        let releaseMarkerPoint = estimateReleaseMarkerPoint(
            frameInfos: frameInfos,
            releaseFrame: releaseMarkerFrame,
            firstBallFrame: firstBallFrame
        )

        var speedInfo: SpeedInfo
        if trajectoryPoints.count >= 2 {
            speedInfo = speedCalculatorResolved.calculateSpeedDetailed(
                trajectoryPoints: trajectoryPoints,
                frameInfos: frameInfos,
                releasePoint: releaseMarkerPoint,
                releaseFrameIdx: validatedReleaseFrame,
                firstBallFrameIdx: firstBallFrame,
                lastBallFrameIdx: validatedCatchFrame ?? lastBallFrame
            )

            if !manualStrikeZone {
                resolvedStrikeZone = estimateAutoStrikeZone(
                    frameInfos: frameInfos,
                    displayWidth: displayWidth,
                    displayHeight: displayHeight,
                    lastBallFrame: lastBallFrame
                )
                NSLog(
                    "[SpeedgunPipeline] Auto strike-zone calibration: x=%.3f-%.3f y=%.3f-%.3f",
                    resolvedStrikeZone["x_min"] ?? STRIKE_ZONE_X_MIN,
                    resolvedStrikeZone["x_max"] ?? STRIKE_ZONE_X_MAX,
                    resolvedStrikeZone["y_min"] ?? STRIKE_ZONE_Y_MIN,
                    resolvedStrikeZone["y_max"] ?? STRIKE_ZONE_Y_MAX
                )
            }

            // Set catch point + derive plate location (raw frame-normalized 0-1)
            // plateXNorm: 0 = left frame edge, 1 = right frame edge
            // plateYNorm: 0 = top frame edge,  1 = bottom frame edge
            // Use extrapolated plate position for better accuracy
            let platePos = estimatePlatePosition(
                frameInfos: frameInfos,
                displayWidth: displayWidth,
                displayHeight: displayHeight,
                lastBallFrame: lastBallFrame,
                plateZone: resolvedStrikeZone
            )
            if let pos = platePos {
                speedInfo.catchPoint = pos
                let xNorm = Double(pos.x) / Double(displayWidth)
                let yNorm = Double(pos.y) / Double(displayHeight)
                speedInfo.plateXNorm = xNorm
                speedInfo.plateYNorm = yNorm
                let loc = strikeZoneLocation(xNorm: xNorm, yNorm: yNorm, plateZone: resolvedStrikeZone)
                speedInfo.pitchLocX = loc.x
                speedInfo.pitchLocY = loc.y
                speedInfo.isStrike = loc.isStrike
                speedInfo.plateZone = resolvedStrikeZone
            }

            // Attach distance source / warning for UI surface
            speedInfo.distanceSource = distanceSource
            speedInfo.distanceWarning = distanceWarning
            speedInfo.releaseFrameIdx = releaseMarkerFrame
            speedInfo.releaseFrameSource = releaseMarkerSource
            speedInfo.releasePoint = releaseMarkerPoint
            speedInfo.firstBallFrameIdx = firstBallFrame
            speedInfo.catchFrameIdx = validatedCatchFrame ?? lastBallFrame
            if distanceSource == "pose_estimated" {
                speedInfo.estimatedDistanceM = resolvedDistance
            }

            // Pitch classification
            reportProgress("calculating", 0.68, "Classifying pitch type...")
            let featureExtractor = PitchFeatureExtractor(
                frameWidth: displayWidth, frameHeight: displayHeight, fps: effectiveCaptureFps
            )
            if let features = featureExtractor.extract(trajectory: trajectoryPoints, speedInfo: speedInfo) {
                let classifier = RuleBasedPitchClassifier()
                let (pitchType, confidence, _) = classifier.classify(features)
                speedInfo.pitchType = pitchType
                speedInfo.pitchConfidence = confidence
            }

            // Ball displacement (break) + spin-rate estimation
            reportProgress("calculating", 0.69, "Analyzing break & spin...")
            let kinematics = BallKinematicsAnalyzer().analyze(
                trajectory: trajectoryPoints,
                samples: trajectorySamples,
                speedInfo: speedInfo,
                frameWidth: displayWidth,
                frameHeight: displayHeight,
                zone: (
                    xMin: resolvedStrikeZone["x_min"] ?? STRIKE_ZONE_X_MIN,
                    xMax: resolvedStrikeZone["x_max"] ?? STRIKE_ZONE_X_MAX,
                    yMin: resolvedStrikeZone["y_min"] ?? STRIKE_ZONE_Y_MIN,
                    yMax: resolvedStrikeZone["y_max"] ?? STRIKE_ZONE_Y_MAX
                )
            )
            if kinematics.breakConfidence > 0.05 {
                speedInfo.horizontalBreakCm = kinematics.horizontalBreakCm
                speedInfo.verticalBreakCm = kinematics.verticalBreakCm
                speedInfo.inducedVerticalBreakCm = kinematics.inducedVerticalBreakCm
                speedInfo.totalBreakCm = kinematics.totalBreakCm
                speedInfo.breakAngleDeg = kinematics.breakAngleDeg
                speedInfo.breakConfidence = kinematics.breakConfidence
            }
        } else {
            speedInfo = SpeedInfo()
            speedInfo.error = "No ball detected in video"
        }

        reportProgress("calculating", 0.70, "Speed calculation complete")

        // Stage 6: Overlay Generation
        reportProgress("overlay", 0.71, "Generating overlay video...")
        let overlayURL = generateOverlayURL()
        // #region agent log
        DebugLogger.log(
            hypothesisId: "H5",
            location: "SpeedgunPipeline.swift:262",
            message: "Entering overlay stage",
            data: [
                "video_path": videoURL.path,
                "overlay_path": overlayURL.path,
                "frame_infos": frameInfos.count,
                "trajectory_points": trajectoryPoints.count,
            ]
        )
        // #endregion

        do {
            let overlayGen = OverlayGenerator(outputScale: DEFAULT_OUTPUT_SCALE)
            try overlayGen.generate(
                sourceURL: effectiveURL,
                frameInfos: frameInfos,
                speedInfo: speedInfo,
                outputURL: overlayURL,
                interpFactor: useInterpolation ? 2 : 1,
                progressCallback: { [weak self] pct, detail in
                    self?.reportProgress("overlay", 0.71 + pct * 0.24, detail)
                }
            )
            // #region agent log
            DebugLogger.log(
                hypothesisId: "H4",
                location: "SpeedgunPipeline.swift:286",
                message: "Overlay stage returned success",
                data: [
                    "overlay_exists": FileManager.default.fileExists(atPath: overlayURL.path),
                    "overlay_bytes": ((try? FileManager.default.attributesOfItem(atPath: overlayURL.path)[.size] as? NSNumber)?.int64Value ?? -1),
                ]
            )
            // #endregion
        } catch {
            // Overlay failure is non-fatal
            reportProgress("overlay", 0.95, "Overlay generation failed: \(error.localizedDescription)")
            // #region agent log
            DebugLogger.log(
                hypothesisId: "H5",
                location: "SpeedgunPipeline.swift:298",
                message: "Overlay stage failed but pipeline continues",
                data: [
                    "error": error.localizedDescription,
                    "overlay_exists": FileManager.default.fileExists(atPath: overlayURL.path),
                ]
            )
            // #endregion
        }

        // Stage 7: Done
        reportProgress("done", 1.0, "Analysis complete")

        // Build result dictionary
        // JS bridge expects: { speed_info: {...}, overlay_uri: "...", job_id: "...", ... }
        var result: [String: Any] = [:]
        result["speed_info"] = speedInfo.toDictionary()
        result["job_id"] = "offline_\(Int(Date().timeIntervalSince1970))"
        if FileManager.default.fileExists(atPath: overlayURL.path) {
            result["overlay_uri"] = overlayURL.absoluteString
        }
        // #region agent log
        DebugLogger.log(
            hypothesisId: "H5",
            location: "SpeedgunPipeline.swift:308",
            message: "Result payload assembled",
            data: [
                "overlay_uri": overlayURL.absoluteString,
                "overlay_exists": FileManager.default.fileExists(atPath: overlayURL.path),
            ]
        )
        // #endregion
        result["trajectory_count"] = trajectoryPoints.count

        // Sampled trajectory points normalised to video frame (x: 0-1 left→right, y: 0-1 top→bottom)
        if !trajectoryPoints.isEmpty && displayWidth > 0 && displayHeight > 0 {
            let maxSamples = 24
            let step = max(1, trajectoryPoints.count / maxSamples)
            var sampled: [[String: Double]] = []
            var idx = 0
            while idx < trajectoryPoints.count {
                let pt = trajectoryPoints[idx]
                sampled.append(["x": Double(pt.x) / Double(displayWidth),
                                "y": Double(pt.y) / Double(displayHeight)])
                idx += step
            }
            // Always include the last point
            if let last = trajectoryPoints.last {
                let lx = Double(last.x) / Double(displayWidth)
                let ly = Double(last.y) / Double(displayHeight)
                if sampled.last?["x"] != lx || sampled.last?["y"] != ly {
                    sampled.append(["x": lx, "y": ly])
                }
            }
            result["trajectory_points_norm"] = sampled
        }

        result["total_frames"] = effectiveTotalFrames
        result["fps"] = effectiveFps   // effective fps after interpolation (60 if source was 30)
        result["video_width"] = displayWidth
        result["video_height"] = displayHeight
        // YOLO detection stats for debug display
        result["yolo_frames_processed"] = yoloFramesProcessed
        result["yolo_raw_detection_frames"] = yoloRawDetectionFrames
        result["yolo_total_detections"] = yoloTotalDetections
        result["yolo_ball_in_frame_count"] = yoloBallInFrameCount

        // Clean up temporary SDR file
        if let sdrURL = sdrTempURL {
            try? FileManager.default.removeItem(at: sdrURL)
        }

        return result
    }

    // MARK: - Helpers

    private func resolveStrikeZone(_ override: [String: Double]?) -> [String: Double] {
        guard let override else { return DEFAULT_STRIKE_ZONE }
        let xMin = override["x_min"] ?? STRIKE_ZONE_X_MIN
        let xMax = override["x_max"] ?? STRIKE_ZONE_X_MAX
        let yMin = override["y_min"] ?? STRIKE_ZONE_Y_MIN
        let yMax = override["y_max"] ?? STRIKE_ZONE_Y_MAX
        guard xMin >= 0.0, xMin < xMax, xMax <= 1.0,
              yMin >= 0.0, yMin < yMax, yMax <= 1.0 else {
            return DEFAULT_STRIKE_ZONE
        }
        return [
            "x_min": xMin,
            "x_max": xMax,
            "y_min": yMin,
            "y_max": yMax,
        ]
    }

    private func estimateReleaseMarkerPoint(
        frameInfos: [FrameInfo],
        releaseFrame: Int?,
        firstBallFrame: Int?
    ) -> CGPoint? {
        guard let releaseFrame else { return nil }

        let poseSamples = frameInfos.compactMap { fi -> (frame: Int, pose: PoseLandmarks)? in
            guard let pose = fi.poseLandmarks else { return nil }
            return (fi.frameIndex, pose)
        }

        func throwingHandIsRight() -> Bool {
            var leftTravel = 0.0
            var rightTravel = 0.0
            var prevPoseFrame = -1
            var prevLeft: CGPoint?
            var prevRight: CGPoint?
            for sample in poseSamples {
                if sample.pose.frameIndex == prevPoseFrame { continue }
                prevPoseFrame = sample.pose.frameIndex
                if let pl = prevLeft, let cl = sample.pose.leftWrist {
                    leftTravel += hypot(Double(cl.x - pl.x), Double(cl.y - pl.y))
                }
                if let pr = prevRight, let cr = sample.pose.rightWrist {
                    rightTravel += hypot(Double(cr.x - pr.x), Double(cr.y - pr.y))
                }
                prevLeft = sample.pose.leftWrist
                prevRight = sample.pose.rightWrist
            }
            return rightTravel >= leftTravel
        }

        if let nearest = poseSamples.min(by: {
            abs($0.frame - releaseFrame) < abs($1.frame - releaseFrame)
        }) {
            let rightHanded = throwingHandIsRight()
            let preferred = rightHanded ? nearest.pose.rightWrist : nearest.pose.leftWrist
            if let preferred { return preferred }
            let wrists = [nearest.pose.leftWrist, nearest.pose.rightWrist].compactMap { $0 }
            if let higher = wrists.min(by: { $0.y < $1.y }) { return higher }
        }

        guard let firstBallFrame,
              let first = frameInfos.first(where: { $0.frameIndex >= firstBallFrame && $0.ballInFrame }) else {
            return nil
        }

        if let second = frameInfos.first(where: { $0.frameIndex > first.frameIndex && $0.ballInFrame }) {
            let dt = max(1, second.frameIndex - first.frameIndex)
            let back = CGFloat(max(1, first.frameIndex - releaseFrame)) / CGFloat(dt)
            return CGPoint(
                x: first.ballCenter.x - (second.ballCenter.x - first.ballCenter.x) * back,
                y: first.ballCenter.y - (second.ballCenter.y - first.ballCenter.y) * back
            )
        }

        return first.ballCenter
    }

    private func estimateAutoStrikeZone(
        frameInfos: [FrameInfo],
        displayWidth: Int,
        displayHeight: Int,
        lastBallFrame: Int?
    ) -> [String: Double] {
        guard displayWidth > 0, displayHeight > 0 else { return DEFAULT_STRIKE_ZONE }

        let zoneW = STRIKE_ZONE_X_MAX - STRIKE_ZONE_X_MIN
        let zoneH = STRIKE_ZONE_Y_MAX - STRIKE_ZONE_Y_MIN
        let defaultCX = (STRIKE_ZONE_X_MIN + STRIKE_ZONE_X_MAX) / 2.0
        let defaultCY = (STRIKE_ZONE_Y_MIN + STRIKE_ZONE_Y_MAX) / 2.0

        var poseCentersX: [Double] = []
        var poseMidY: [Double] = []
        for fi in frameInfos {
            guard let pose = fi.poseLandmarks else { continue }
            let xs = [pose.leftShoulder, pose.rightShoulder, pose.leftHip, pose.rightHip]
                .compactMap { $0?.x }
            if xs.count >= 2 {
                poseCentersX.append(Double(xs.reduce(0, +)) / Double(xs.count) / Double(displayWidth))
            }

            let ys = [pose.leftShoulder, pose.rightShoulder, pose.leftHip, pose.rightHip]
                .compactMap { $0?.y }
            if ys.count >= 2 {
                poseMidY.append(Double(ys.reduce(0, +)) / Double(ys.count) / Double(displayHeight))
            }
        }

        let poseCX = poseCentersX.isEmpty ? nil : median(poseCentersX)

        var tailXs: [Double] = []
        var tailYs: [Double] = []
        if let last = lastBallFrame, !frameInfos.isEmpty {
            let end = min(last, frameInfos.count - 1)
            let start = max(0, end - 15)
            if start <= end {
                for i in start...end {
                    let fi = frameInfos[i]
                    guard fi.ballInFrame && !fi.ballLostTracking else { continue }
                    tailXs.append(Double(fi.ballCenter.x) / Double(displayWidth))
                    tailYs.append(Double(fi.ballCenter.y) / Double(displayHeight))
                }
            }
        }
        let tailX = tailXs.isEmpty ? nil : median(tailXs)
        let tailY = tailYs.isEmpty ? nil : median(tailYs)

        let centerX: Double
        if let poseCX {
            centerX = 0.75 * poseCX + 0.25 * (tailX ?? defaultCX)
        } else if let tailX {
            centerX = 0.65 * defaultCX + 0.35 * tailX
        } else {
            centerX = defaultCX
        }

        var centerY = defaultCY
        if let tailY {
            centerY += 0.35 * (tailY - defaultCY)
        }
        if !poseMidY.isEmpty {
            centerY += 0.08 * (median(poseMidY) - 0.40)
        }

        let clampedX = clamp(centerX, min: zoneW / 2.0 + 0.02, max: 1.0 - zoneW / 2.0 - 0.02)
        let clampedY = clamp(centerY, min: zoneH / 2.0 + 0.02, max: 1.0 - zoneH / 2.0 - 0.02)

        return [
            "x_min": clampedX - zoneW / 2.0,
            "x_max": clampedX + zoneW / 2.0,
            "y_min": clampedY - zoneH / 2.0,
            "y_max": clampedY + zoneH / 2.0,
        ]
    }

    /// Strike-zone relative location in display-normalized catcher/umpire POV.
    private func strikeZoneLocation(
        xNorm: Double,
        yNorm: Double,
        plateZone: [String: Double]
    ) -> (x: Double, y: Double, isStrike: Bool) {
        let xMin = plateZone["x_min"] ?? STRIKE_ZONE_X_MIN
        let xMax = plateZone["x_max"] ?? STRIKE_ZONE_X_MAX
        let yMin = plateZone["y_min"] ?? STRIKE_ZONE_Y_MIN
        let yMax = plateZone["y_max"] ?? STRIKE_ZONE_Y_MAX
        let zoneW = xMax - xMin
        let zoneH = yMax - yMin
        let locX = zoneW > 0 ? (xNorm - xMin) / zoneW : 0.5
        let locY = zoneH > 0 ? (yNorm - yMin) / zoneH : 0.5
        return (
            x: locX,
            y: locY,
            isStrike: locX >= 0.0 && locX <= 1.0 && locY >= 0.0 && locY <= 1.0
        )
    }

    /// Estimate the ball position at the plate using trajectory extrapolation.
    /// Strategy:
    /// 1. Collect the last ≤5 actual YOLO-detected frames (ballLostTracking == false).
    /// 2. If ≥2 actual detections exist, extrapolate linearly to find where the ball
    ///    would cross the catcher/plate band.
    /// 3. If the extrapolated y is outside that band, use the frame closest
    ///    to that band instead.
    /// 4. Falls back to lastBallFrame if no extrapolation is possible.
    private func estimatePlatePosition(
        frameInfos: [FrameInfo],
        displayWidth: Int,
        displayHeight: Int,
        lastBallFrame: Int?,
        plateZone: [String: Double]
    ) -> CGPoint? {
        guard let last = lastBallFrame else { return nil }

        // --- Collect last N actual detections (not gap-filled synthetic points) ---
        // Raised from 8 → 15: at 120fps this is ~125ms of history; at 240fps ~62ms.
        // Also collect up to 7 (was 5) actual detections so median velocity is more stable
        // against the high per-frame bbox jitter in the final approach phase.
        let maxLookback = 15
        var actualDetections: [(frameIdx: Int, x: Double, y: Double)] = []
        let searchStart = max(0, last - maxLookback)
        for i in stride(from: last, through: searchStart, by: -1) {
            let fi = frameInfos[i]
            if fi.ballInFrame && !fi.ballLostTracking {
                actualDetections.insert((i, Double(fi.ballCenter.x), Double(fi.ballCenter.y)), at: 0)
            }
            if actualDetections.count >= 7 { break }
        }

        // Need at least 2 actual detections for linear extrapolation
        guard actualDetections.count >= 2 else {
            // Fallback: use lastBallFrame directly
            return frameInfos[last].ballCenter
        }

        // --- Compute MEDIAN per-frame velocity across consecutive pairs ---
        // Using only the last two points makes catch-point extrapolation highly sensitive
        // to 4K bbox jitter (±1px = ±50mph-equivalent motion at 120fps catcher-POV).
        // Median over up to 6 consecutive-pair deltas is much more stable.
        var vxs: [Double] = []
        var vys: [Double] = []
        for i in 1..<actualDetections.count {
            let a = actualDetections[i - 1]
            let b = actualDetections[i]
            let df = Double(max(1, b.frameIdx - a.frameIdx))
            vxs.append((b.x - a.x) / df)
            vys.append((b.y - a.y) / df)
        }
        let vx = median(vxs)
        let vy = median(vys)

        let p2 = actualDetections[actualDetections.count - 1]

        // The "plate band": ball should be near the calibrated strike-zone
        // height when it crosses the plate in catcher/umpire POV.
        let zoneYMin = plateZone["y_min"] ?? STRIKE_ZONE_Y_MIN
        let zoneYMax = plateZone["y_max"] ?? STRIKE_ZONE_Y_MAX
        let plateBandLo = zoneYMin * Double(displayHeight)
        let plateBandHi = zoneYMax * Double(displayHeight)

        // Current last-detection position
        let curX = p2.x
        let curY = p2.y

        // If ball is already in plate band, use it directly
        if curY >= plateBandLo && curY <= plateBandHi {
            return CGPoint(x: curX, y: curY)
        }

        // Extrapolate forward: find how many frames until ball reaches plateBandLo
        // (ball approaches lower in frame = increasing y in catcher-POV)
        if vy > 0.5 && curY < plateBandLo {
            // Ball still approaching — extrapolate to plateBandLo
            let framesToPlate = (plateBandLo - curY) / vy
            // Cap extrapolation to 0.5 seconds max. Use 120fps as worst-case bound so
            // high-fps slo-mo (where each frame = tiny real-time slice) doesn't over-limit.
            let fps = 120.0
            let maxFrames = fps * 0.5
            if framesToPlate > 0 && framesToPlate <= maxFrames {
                let extX = curX + vx * framesToPlate
                let extY = curY + vy * framesToPlate
                // Clamp to frame bounds
                let clampedX = clamp(extX, min: 0.0, max: Double(displayWidth))
                let clampedY = clamp(extY, min: plateBandLo, max: plateBandHi)
                return CGPoint(x: clampedX, y: clampedY)
            }
        }

        // Fallback: use last actual detection
        return CGPoint(x: curX, y: curY)
    }

    // MARK: - Catch Impact Detection (Audio)

    /// Analyse the audio track of the video to find the frame at which the ball
    /// hits the catcher's glove. The impact produces a sharp, short-lived RMS spike
    /// (loud transient) followed by rapid decay — characteristic of a leather smack.
    ///
    /// Algorithm:
    ///   1. Read PCM samples from the audio track via AVAssetReader.
    ///   2. Compute per-video-frame RMS (sum all audio samples that fall within
    ///      the video frame's time window).
    ///   3. Build a rolling baseline (median of a ±15 frame window) to adapt to
    ///      ambient noise levels (wind, crowd, etc.).
    ///   4. Find the frame with the highest RMS-to-baseline ratio that also
    ///      satisfies the transient criteria (spike then rapid decay within 3 frames).
    ///   5. Only search frames AFTER `searchAfterFrame` to skip the delivery grunt/
    ///      foot-plant sounds that occur before or during the throw.
    ///
    /// Returns the video frame index of the detected impact, or nil if no clear
    /// transient is found (video has no audio, or the catch is inaudible).
    private func detectCatchImpact(
        asset: AVAsset,
        fps: Int,
        searchAfterFrame: Int,
        visualReferenceFrame: Int? = nil
    ) -> Int? {
        guard let audioTrack = asset.tracks(withMediaType: .audio).first else {
            NSLog("[SpeedgunPipeline] No audio track — skipping catch detection")
            return nil
        }
        guard let videoTrack = asset.tracks(withMediaType: .video).first else {
            return nil
        }

        let videoStartSeconds = CMTimeGetSeconds(videoTrack.timeRange.start)
        let audioStartSeconds = CMTimeGetSeconds(audioTrack.timeRange.start)
        NSLog("[SpeedgunPipeline] Audio/video PTS starts: audio=%.4fs video=%.4fs delta=%.4fs",
              audioStartSeconds, videoStartSeconds, audioStartSeconds - videoStartSeconds)

        // Read raw PCM from the audio track
        guard let reader = try? AVAssetReader(asset: asset) else { return nil }
        let outputSettings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ]
        let audioOutput = AVAssetReaderTrackOutput(track: audioTrack, outputSettings: outputSettings)
        audioOutput.alwaysCopiesSampleData = false
        reader.add(audioOutput)
        guard reader.startReading() else { return nil }

        let channelCount: Int = {
            guard let rawDesc = audioTrack.formatDescriptions.first else { return 1 }
            let desc = rawDesc as! CMAudioFormatDescription
            guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc) else { return 1 }
            return max(1, Int(asbd.pointee.mChannelsPerFrame))
        }()
        let fallbackSampleRate: Double = {
            guard let rawDesc = audioTrack.formatDescriptions.first else { return 48_000.0 }
            let desc = rawDesc as! CMAudioFormatDescription
            guard let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
                  asbd.pointee.mSampleRate > 0 else { return 48_000.0 }
            return asbd.pointee.mSampleRate
        }()

        // Collect audio energy into video-frame buckets.  Use each audio
        // sample's time inside the buffer instead of the buffer start PTS; iOS
        // audio buffers can span multiple video frames, and assigning the whole
        // buffer to its first timestamp makes sharp impacts appear too early.
        let frameDuration = 1.0 / Double(max(1, fps))
        var frameRMS: [Int: (sumSq: Double, count: Int)] = [:]

        while let sampleBuffer = audioOutput.copyNextSampleBuffer() {
            autoreleasepool {
                guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
                let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
                let ptsSeconds = CMTimeGetSeconds(pts)
                let videoFrameIdx = Int(ptsSeconds / frameDuration)

                var dataLength = 0
                var dataPointer: UnsafeMutablePointer<CChar>?
                CMBlockBufferGetDataPointer(blockBuffer, atOffset: 0, lengthAtOffsetOut: nil,
                                            totalLengthOut: &dataLength, dataPointerOut: &dataPointer)
                guard let ptr = dataPointer, dataLength > 0 else { return }

                let sampleCount = dataLength / 2  // Int16 = 2 bytes
                let samples = UnsafeBufferPointer(start: ptr.withMemoryRebound(to: Int16.self, capacity: sampleCount) { $0 },
                                                  count: sampleCount)
                let audioFrameCount = max(1, sampleCount / channelCount)
                let duration = CMSampleBufferGetDuration(sampleBuffer)
                let durationSeconds = duration.isValid && !duration.isIndefinite && duration.seconds > 0
                    ? duration.seconds
                    : Double(audioFrameCount) / fallbackSampleRate
                let sampleStep = durationSeconds / Double(audioFrameCount)

                for audioFrame in 0..<audioFrameCount {
                    let relativeSeconds = (ptsSeconds - videoStartSeconds) + Double(audioFrame) * sampleStep
                    guard relativeSeconds >= 0 else { continue }
                    let videoFrameIdx = Int(floor(relativeSeconds / frameDuration))

                    var frameSumSq = 0.0
                    let base = audioFrame * channelCount
                    for ch in 0..<channelCount where base + ch < sampleCount {
                        let f = Double(samples[base + ch]) / 32768.0
                        frameSumSq += f * f
                    }
                    let existing = frameRMS[videoFrameIdx] ?? (0, 0)
                    frameRMS[videoFrameIdx] = (
                        existing.sumSq + frameSumSq / Double(channelCount),
                        existing.count + 1
                    )
                }
            }
        }
        reader.cancelReading()

        guard !frameRMS.isEmpty else { return nil }

        // Convert to per-frame RMS values, sorted by frame index
        let sortedFrames = frameRMS.keys.sorted()
        let rmsValues: [(frameIdx: Int, rms: Double)] = sortedFrames.compactMap { idx in
            guard let bucket = frameRMS[idx], bucket.count > 0 else { return nil }
            return (idx, sqrt(bucket.sumSq / Double(bucket.count)))
        }

        guard rmsValues.count >= 5 else { return nil }

        // Search from shortly after release/first-ball anchor. This makes audio
        // the primary endpoint while still skipping delivery/foot-plant sounds.
        let searchStart = searchAfterFrame + Int(round(AUDIO_CATCH_MIN_OFFSET_SEC * Double(fps)))
        let searchEnd = searchAfterFrame + Int(round(AUDIO_CATCH_MAX_OFFSET_SEC * Double(fps)))
        let candidates = rmsValues.filter { $0.frameIdx >= searchStart && $0.frameIdx <= searchEnd }
        guard candidates.count >= 3 else { return nil }

        // Build rolling baseline using a ±10 frame window median
        // This adapts to ambient noise so wind/crowd don't trigger false positives
        let windowHalf = 10
        func baselineRMS(at i: Int) -> Double {
            let lo = max(0, i - windowHalf)
            let hi = min(rmsValues.count - 1, i + windowHalf)
            let window = rmsValues[lo...hi].map { $0.rms }.sorted()
            return window[window.count / 2]  // median
        }

        // Find best transient: highest (rms / baseline) ratio that also decays quickly
        var bestFrame: Int? = nil
        var bestRatio = 0.0

        for (ci, candidate) in candidates.enumerated() {
            // Find index in full rmsValues array
            guard let fullIdx = rmsValues.firstIndex(where: { $0.frameIdx == candidate.frameIdx }) else { continue }
            let baseline = baselineRMS(at: fullIdx)
            guard baseline > 1e-6 else { continue }

            let ratio = candidate.rms / baseline

            // Must be at least 2.5× the local baseline to qualify as an impact
            guard ratio >= 2.5 else { continue }

            // Transient check: RMS must drop by at least 40% within the next 3 frames
            // (a real smack is very short; sustained noise like wind doesn't qualify)
            let nextEnd = min(ci + 4, candidates.count - 1)
            if nextEnd > ci {
                let peakRMS = candidate.rms
                let futureRMS = candidates[(ci+1)...nextEnd].map { $0.rms }
                let minFuture = futureRMS.min() ?? peakRMS
                let decayRatio = minFuture / peakRMS
                guard decayRatio <= 0.70 else { continue }  // must decay to ≤70% within 3 frames
            }

            if let visual = visualReferenceFrame {
                let earlyToleranceFrames = Int(round(0.08 * Double(fps)))
                guard candidate.frameIdx >= visual - earlyToleranceFrames else { continue }
                let diffSec = abs(Double(candidate.frameIdx - visual)) / Double(fps)
                guard diffSec <= AUDIO_CATCH_VISUAL_MAX_DIVERGENCE_SEC else { continue }
            }

            if ratio > bestRatio {
                bestRatio = ratio
                bestFrame = candidate.frameIdx
            }
        }

        if let frame = bestFrame {
            NSLog("[SpeedgunPipeline] Audio catch candidate accepted: frame=%d ratio=%.2f visualRef=%@",
                  frame, bestRatio, visualReferenceFrame.map { String($0) } ?? "nil")
        }
        return bestFrame
    }

    // MARK: - Pose-based Distance Estimation

    /// Estimate the camera-to-pitcher distance from the shoulder width visible in pose landmarks.
    ///
    /// Uses the pinhole camera model: distance = focalLength * realWidth / pixelWidth
    ///
    /// Algorithm:
    /// 1. Collect shoulder pixel widths from all frames where both shoulders are detected.
    /// 2. Use the median (robust to outliers from frames where the pitcher is side-on).
    /// 3. Convert to camera-to-pitcher distance using iPhone focal length at 1080p.
    /// 4. Clamp result to [POSE_DIST_MIN_M, POSE_DIST_MAX_M].
    ///
    /// Returns nil if not enough pose data is available.
    private func estimatePitchingDistance(
        frameInfos: [FrameInfo],
        displayWidth: Int,
        displayHeight: Int,
        pitcherHeightM: Double? = nil
    ) -> Double? {
        // Scale factor: landmarks are in display coords already
        // If video height ≠ 1080, scale focal length proportionally
        let scaleY = Double(displayHeight) / 1080.0
        let focalLengthPx = IPHONE_FOCAL_LENGTH_PX_1080 * scaleY

        // --- Primary: full-body height (nose/shoulder → ankle) when user supplied pitcher height ---
        // Shoulder width is noisy because the pitcher rotates during delivery (side-on frames
        // shrink biacromial width 2–3×). Vertical body height is far more robust to rotation.
        if let realHeight = pitcherHeightM, realHeight > 1.0, realHeight < 2.4 {
            var bodyPxHeights: [Double] = []
            for fi in frameInfos {
                guard let pose = fi.poseLandmarks else { continue }
                // Use highest reliable landmark (midpoint of shoulders) → lowest ankle.
                guard let ls = pose.leftShoulder, let rs = pose.rightShoulder else { continue }
                let topY = min(Double(ls.y), Double(rs.y))
                var bottomY: Double? = nil
                if let la = pose.leftAnkle { bottomY = max(bottomY ?? -.infinity, Double(la.y)) }
                if let ra = pose.rightAnkle { bottomY = max(bottomY ?? -.infinity, Double(ra.y)) }
                guard let bot = bottomY else { continue }
                let px = bot - topY
                // Shoulder→ankle is ~85% of standing height; rescale to full height px.
                let fullPx = px / 0.85
                let minPx = Double(displayHeight) * 0.05   // at least 5% frame height
                let maxPx = Double(displayHeight) * 0.95
                if fullPx >= minPx && fullPx <= maxPx {
                    bodyPxHeights.append(fullPx)
                }
            }
            if bodyPxHeights.count >= 5 {
                let medPx = median(bodyPxHeights)
                let rawDist = focalLengthPx * realHeight / medPx
                let clamped = clamp(rawDist, min: POSE_DIST_MIN_M, max: POSE_DIST_MAX_M)
                NSLog("[SpeedgunPipeline] Body-height pose dist: realH=%.2fm medPx=%.1f → raw=%.2fm clamped=%.2fm n=%d",
                      realHeight, medPx, rawDist, clamped, bodyPxHeights.count)
                return clamped
            }
            NSLog("[SpeedgunPipeline] Body-height samples insufficient (%d<5) — falling back to shoulder width",
                  bodyPxHeights.count)
        }

        // --- Fallback: shoulder width (biacromial 0.44m) ---
        var shoulderWidths: [Double] = []
        for fi in frameInfos {
            guard let pose = fi.poseLandmarks,
                  let ls = pose.leftShoulder,
                  let rs = pose.rightShoulder else { continue }

            let dx = Double(ls.x - rs.x)
            let dy = Double(ls.y - rs.y)
            let pxWidth = sqrt(dx * dx + dy * dy)

            let minPx = Double(displayWidth) * 0.02
            let maxPx = Double(displayWidth) * 0.60
            if pxWidth >= minPx && pxWidth <= maxPx {
                shoulderWidths.append(pxWidth)
            }
        }

        guard shoulderWidths.count >= 5 else {
            NSLog("[SpeedgunPipeline] Not enough shoulder width samples (%d) for pose distance", shoulderWidths.count)
            return nil
        }

        // Use the MAX (not median) because rotation during delivery collapses shoulder width
        // projectively — only the fully-square frames give the true biacromial size. Max is
        // a reasonable proxy in short clips; for longer clips prefer 90th-percentile.
        let topWidths = shoulderWidths.sorted(by: >).prefix(max(3, shoulderWidths.count / 3))
        let refWidth = topWidths.reduce(0, +) / Double(topWidths.count)
        guard refWidth > 1 else { return nil }

        let rawDist = focalLengthPx * SHOULDER_WIDTH_M / refWidth
        let clampedDist = clamp(rawDist, min: POSE_DIST_MIN_M, max: POSE_DIST_MAX_M)

        NSLog("[SpeedgunPipeline] Shoulder-width pose dist: ref=%.1fpx (top-1/3 mean of %d) → raw=%.2fm clamped=%.2fm",
              refWidth, shoulderWidths.count, rawDist, clampedDist)
        return clampedDist
    }

    private func reportProgress(_ stage: String, _ progress: Double, _ message: String) {
        progressCallback(PipelineProgress(stage: stage, progress: progress, message: message))
    }

    private func generateOverlayURL() -> URL {
        let tempDir = FileManager.default.temporaryDirectory
        let filename = "speedgun_overlay_\(Int(Date().timeIntervalSince1970)).mp4"
        return tempDir.appendingPathComponent(filename)
    }

    /// Select best SORT track: longest track with significant y-movement
    private func selectBestTrack(tracks: [Int: [TrackPoint]], frameHeight: Int, minPoints: Int = 3) -> [TrackPoint]? {
        guard !tracks.isEmpty else { return nil }

        var bestTrack: [TrackPoint]?
        var bestScore = 0.0

        for (_, points) in tracks {
            guard points.count >= minPoints else { continue }

            let ys = points.map { $0.cy }
            let yRange = (ys.max() ?? 0) - (ys.min() ?? 0)
            let yMovementRatio = yRange / Double(frameHeight)

            // Score: length × y-movement (penalize static tracks)
            let score = Double(points.count) * max(yMovementRatio, 0.01)

            if score > bestScore {
                bestScore = score
                bestTrack = points
            }
        }

        return bestTrack
    }

    /// Filter high-confidence static false positives.
    /// `staticRadius` should be scaled to effectiveFps so a moving ball is not
    /// falsely classified as static at high frame rates.
    /// `minPersist` should also be scaled with capture fps — at 120fps a static
    /// object takes 2× more frames to register as "static" over the same wall-clock window.
    private func filterStaticFP(
        dets: [BallDetection],
        staticTracker: inout [Int: [(cx: Double, cy: Double, area: Double, count: Int)]],
        frameIndex: Int,
        staticRadius: Double = HC_STATIC_RADIUS,
        minPersist: Int = HC_STATIC_MIN_PERSIST
    ) -> [BallDetection] {
        guard !dets.isEmpty else { return dets }

        var filtered: [BallDetection] = []
        for det in dets {
            // Only filter high-confidence detections
            if det.confidence >= HC_STATIC_MIN_CONF {
                let gridKey = Int(det.cx / staticRadius) * 10000 + Int(det.cy / staticRadius)
                var entries = staticTracker[gridKey] ?? []

                // Check if this is near an existing static detection
                var isStatic = false
                for (i, entry) in entries.enumerated() {
                    let dist = sqrt(pow(det.cx - entry.cx, 2) + pow(det.cy - entry.cy, 2))
                    let areaDiff = abs(det.area - entry.area) / max(entry.area, 1)
                    if dist < staticRadius && areaDiff < 0.3 {
                        entries[i].count += 1
                        if entries[i].count >= minPersist {
                            isStatic = true
                        }
                        break
                    }
                }

                if !isStatic {
                    // Add to tracker if new
                    if entries.isEmpty || !entries.contains(where: { sqrt(pow(det.cx - $0.cx, 2) + pow(det.cy - $0.cy, 2)) < staticRadius }) {
                        entries.append((cx: det.cx, cy: det.cy, area: det.area, count: 1))
                    }
                    staticTracker[gridKey] = entries
                    filtered.append(det)
                }
                // Static — skip this detection
            } else {
                filtered.append(det)
            }
        }
        return filtered
    }

    /// Fill missing ball positions using polynomial interpolation.
    /// Port of src/utils.py fill_lost_tracking()
    private func fillLostTracking(frameInfos: inout [FrameInfo], maxGapFrames: Int, fps: Int) {
        var maxGap = maxGapFrames
        if fps > 0 {
            let maxGapSeconds = 0.35
            maxGap = max(5, Int(Double(fps) * maxGapSeconds))
        }

        // Collect detected frames
        var detected: [(idx: Int, cx: Double, cy: Double)] = []
        for (i, fi) in frameInfos.enumerated() where fi.ballInFrame {
            detected.append((i, Double(fi.ballCenter.x), Double(fi.ballCenter.y)))
        }
        guard detected.count >= 2 else { return }

        let idxs = detected.map { Double($0.idx) }
        let cxs = detected.map { $0.cx }
        let cys = detected.map { $0.cy }

        let deg = min(2, detected.count - 1)
        let cxCoeffs = polyfit(idxs, cxs, degree: deg)
        let cyCoeffs = polyfit(idxs, cys, degree: deg)

        let detectedSet = Set(detected.map { $0.idx })
        let sorted = detected.map { $0.idx }.sorted()

        for i in 0..<(sorted.count - 1) {
            let prev = sorted[i]
            let next = sorted[i + 1]
            let gap = next - prev - 1
            if gap <= 0 || gap > maxGap { continue }

            for gapFid in (prev + 1)..<next {
                if detectedSet.contains(gapFid) { continue }
                let t = Double(gapFid)
                let estCx = Int(round(polyval(cxCoeffs, t)))
                let estCy = Int(round(polyval(cyCoeffs, t)))
                frameInfos[gapFid].ballInFrame = true
                frameInfos[gapFid].ballCenter = CGPoint(x: estCx, y: estCy)
                frameInfos[gapFid].ballColor = (255, 30, 30)
                frameInfos[gapFid].ballLostTracking = true
            }
        }
    }
}
