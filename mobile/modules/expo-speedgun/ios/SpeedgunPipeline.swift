import AVFoundation
import Accelerate
import CoreVideo
import Foundation
import Vision

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
        batterHeightM: Double? = nil,
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
        let absZoneHeightM = absStrikeZoneHeightM(batterHeightM)
        var resolvedStrikeZone = resolveStrikeZone(strikeZone, batterHeightM: batterHeightM)

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

        // Camera focal length in pixels: prefer the per-video QuickTime metadata
        // (true recorded FOV incl. lens choice / zoom / stabilization crop) over
        // the tuned per-model constant. Read from probeDecoder — the original
        // file — because the HDR→SDR re-export may strip camera metadata.
        let metadataFocalPx = await probeDecoder.cameraFocalLengthPx()
        let cameraFocalLengthPx = metadataFocalPx
            ?? IPHONE_FOCAL_LENGTH_PX_1080 * Double(displayHeight) / 1080.0
        if metadataFocalPx == nil {
            NSLog("[SpeedgunPipeline] No focal-length metadata — fallback constant %.0fpx", cameraFocalLengthPx)
        }

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
        fillLostTracking(frameInfos: &frameInfos, maxGapFrames: 30, fps: effectiveCaptureFps)

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

            // 3. Reconstruct gaps inside the selected SORT track. SORT only emits
            //    frames that received an update, so low sensitivity or motion blur
            //    can leave holes even after the best trajectory is known.
            fillSelectedTrackGaps(
                frameInfos: &frameInfos,
                track: track,
                fps: effectiveCaptureFps,
                displayWidth: displayWidth,
                displayHeight: displayHeight
            )
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
            focalLengthPx: cameraFocalLengthPx,
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

        // Ball-size ranging for the pre-detect gap: physically-derived estimate of
        // the release → first-detection time, replacing the fixed 0.25s guess.
        let ballSizePreFrames = estimateBallSizePreDetectFrames(
            rawDetections: rawDetections,
            frameInfos: frameInfos,
            firstBallFrame: firstBallFrame,
            endpointFrame: validatedCatchFrame ?? lastBallFrame,
            focalLengthPx: cameraFocalLengthPx,
            flightDistanceM: speedCalculatorResolved.effectiveDistance ?? resolvedDistance,
            fps: effectiveCaptureFps,
            displayWidth: displayWidth
        )

        var speedInfo: SpeedInfo
        if trajectoryPoints.count >= 2 {
            speedInfo = speedCalculatorResolved.calculateSpeedDetailed(
                trajectoryPoints: trajectoryPoints,
                frameInfos: frameInfos,
                releasePoint: releaseMarkerPoint,
                releaseFrameIdx: validatedReleaseFrame,
                firstBallFrameIdx: firstBallFrame,
                lastBallFrameIdx: validatedCatchFrame ?? lastBallFrame,
                ballSizePreFrames: ballSizePreFrames
            )

            if !manualStrikeZone {
                resolvedStrikeZone = estimateAutoStrikeZone(
                    frameInfos: frameInfos,
                    displayWidth: displayWidth,
                    displayHeight: displayHeight,
                    lastBallFrame: lastBallFrame,
                    batterHeightM: batterHeightM
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
                catchFrame: validatedCatchFrame,
                fps: effectiveCaptureFps,
                plateZone: resolvedStrikeZone
            )
            if let plate = platePos {
                var pos = plate.point
                var source = plate.source
                var confidence = plate.confidence

                // Single Vision pass at the catch instant: catcher glove for the
                // catch-point cross-check + catcher body for the zone anchor.
                var catcherObs: CatcherObservation? = nil
                if let catchRefFrame = validatedCatchFrame ?? lastBallFrame {
                    catcherObs = detectCatcherObservation(
                        videoURL: effectiveURL,
                        catchFrame: catchRefFrame,
                        effectivePlaybackFps: effectiveFps,
                        displayWidth: displayWidth,
                        displayHeight: displayHeight,
                        near: pos
                    )
                }

                // Cross-check against the catcher's glove at the catch instant.
                // Agreement promotes confidence and refines the point; a large
                // divergence means the extrapolation likely drifted — keep it
                // (it has the time anchor) but flag low confidence.
                if let glove = catcherObs?.glovePoint {
                    speedInfo.glovePoint = glove
                    let diag = Double(displayWidth * displayWidth + displayHeight * displayHeight).squareRoot()
                    let divergence = hypot(Double(glove.x - pos.x), Double(glove.y - pos.y))
                    let maxBlendDist = 0.10 * diag
                    if divergence <= maxBlendDist {
                        let closeness = 1.0 - divergence / maxBlendDist
                        let gloveWeight = clamp(0.20 + 0.45 * closeness + 0.20 * (1.0 - confidence), min: 0.20, max: 0.75)
                        pos = CGPoint(
                            x: pos.x * CGFloat(1.0 - gloveWeight) + glove.x * CGFloat(gloveWeight),
                            y: pos.y * CGFloat(1.0 - gloveWeight) + glove.y * CGFloat(gloveWeight)
                        )
                        source += "+glove"
                        confidence = clamp(confidence + 0.18 * closeness, min: confidence, max: 0.95)
                        NSLog("[SpeedgunPipeline] Glove blended into plate point: divergence=%.0fpx weight=%.2f conf=%.2f",
                              divergence, gloveWeight, confidence)
                    } else {
                        confidence = min(confidence, 0.4)
                        NSLog("[SpeedgunPipeline] Glove diverges from extrapolated catch point: %.0fpx (%.1f%% of diag)",
                              divergence, 100.0 * divergence / diag)
                    }
                }

                // Anchor the strike zone to the detected catcher so the drawn
                // zone sits in front of him instead of at the pitcher-pose /
                // default position. Shoulder width gives the px-per-meter scale:
                //   zone width  = plate width (17 in = 0.4318 m)
                //   zone height = ABS 27% to 53.5% of measured batter height
                //   zone top    ≈ crouched catcher's shoulder height (~1.0 m)
                var zoneAnchoredToCatcher = false
                if !manualStrikeZone,
                   let bodyCX = catcherObs?.bodyCenterX,
                   let shoulderY = catcherObs?.shoulderY,
                   let shoulderW = catcherObs?.shoulderWidthPx {
                    let ppm = Double(shoulderW) / SHOULDER_WIDTH_M
                    let zoneWNorm = clamp(ABS_STRIKE_ZONE_WIDTH_M * ppm / Double(displayWidth), min: 0.10, max: 0.50)
                    let zoneHeightM = absZoneHeightM ?? LEGACY_STRIKE_ZONE_HEIGHT_M
                    let zoneHNorm = clamp(zoneHeightM * ppm / Double(displayHeight), min: 0.08, max: 0.45)
                    let cxNorm = clamp(
                        Double(bodyCX) / Double(displayWidth),
                        min: zoneWNorm / 2.0 + 0.02, max: 1.0 - zoneWNorm / 2.0 - 0.02
                    )
                    let cyNorm = clamp(
                        Double(shoulderY) / Double(displayHeight) + zoneHNorm / 2.0,
                        min: zoneHNorm / 2.0 + 0.02, max: 1.0 - zoneHNorm / 2.0 - 0.02
                    )
                    resolvedStrikeZone = [
                        "x_min": cxNorm - zoneWNorm / 2.0,
                        "x_max": cxNorm + zoneWNorm / 2.0,
                        "y_min": cyNorm - zoneHNorm / 2.0,
                        "y_max": cyNorm + zoneHNorm / 2.0,
                    ]
                    NSLog(
                        "[SpeedgunPipeline] Catcher-anchored strike zone: x=%.3f-%.3f y=%.3f-%.3f (shoulderW=%.0fpx, rule=%@)",
                        resolvedStrikeZone["x_min"] ?? 0, resolvedStrikeZone["x_max"] ?? 0,
                        resolvedStrikeZone["y_min"] ?? 0, resolvedStrikeZone["y_max"] ?? 0,
                        Double(shoulderW), absZoneHeightM != nil ? ABS_STRIKE_ZONE_RULE : "legacy"
                    )
                    zoneAnchoredToCatcher = true
                }

                // Fallback when no catcher body is visible — the common rig has
                // the phone mounted right behind the catcher, so only the top of
                // his head is in frame and Vision cannot find shoulders. Recover
                // the px-per-meter scale AT the plate plane from the ball's
                // known diameter (74 mm) in the last detections before the
                // catch, and pull the zone toward where the ball actually
                // arrives. Without this the zone is drawn mid-frame (default /
                // pitcher-pose position) while the catch happens near the bottom
                // of the frame — visually disconnected from the analyzed plate
                // location.
                if !manualStrikeZone, !zoneAnchoredToCatcher {
                    var catchAreas: [Double] = []
                    if let last = lastBallFrame, !frameInfos.isEmpty {
                        let end = min(last, frameInfos.count - 1)
                        let start = max(0, end - 12)
                        if start <= end {
                            for i in start...end {
                                let fi = frameInfos[i]
                                if fi.ballInFrame && !fi.ballLostTracking && fi.ballArea > 0 {
                                    catchAreas.append(fi.ballArea)
                                }
                            }
                        }
                    }
                    if catchAreas.count >= 3 {
                        let ballDiaPx = median(catchAreas).squareRoot()
                        let ppm = ballDiaPx / BASEBALL_DIAMETER_M
                        let zoneWNorm = clamp(ABS_STRIKE_ZONE_WIDTH_M * ppm / Double(displayWidth), min: 0.12, max: 0.55)
                        let zoneHeightM = absZoneHeightM ?? LEGACY_STRIKE_ZONE_HEIGHT_M
                        let zoneHNorm = clamp(zoneHeightM * ppm / Double(displayHeight), min: 0.10, max: 0.50)
                        let catchXNorm = Double(pos.x) / Double(displayWidth)
                        let catchYNorm = Double(pos.y) / Double(displayHeight)
                        let prevCX = ((resolvedStrikeZone["x_min"] ?? STRIKE_ZONE_X_MIN)
                                    + (resolvedStrikeZone["x_max"] ?? STRIKE_ZONE_X_MAX)) / 2.0
                        let prevCY = ((resolvedStrikeZone["y_min"] ?? STRIKE_ZONE_Y_MIN)
                                    + (resolvedStrikeZone["y_max"] ?? STRIKE_ZONE_Y_MAX)) / 2.0
                        // x: the plate sits on the camera→pitcher line, which the
                        // pose-based estimate already encodes — keep most of it.
                        // y: the default band is calibrated for mid-frame geometry
                        // and is meaningless at the near plane — let the catch
                        // area dominate so the zone lands where the ball arrives.
                        let cxNorm = clamp(
                            0.65 * prevCX + 0.35 * catchXNorm,
                            min: zoneWNorm / 2.0 + 0.02, max: 1.0 - zoneWNorm / 2.0 - 0.02
                        )
                        let cyNorm = clamp(
                            0.45 * prevCY + 0.55 * catchYNorm,
                            min: zoneHNorm / 2.0 + 0.02, max: 1.0 - zoneHNorm / 2.0 - 0.02
                        )
                        resolvedStrikeZone = [
                            "x_min": cxNorm - zoneWNorm / 2.0,
                            "x_max": cxNorm + zoneWNorm / 2.0,
                            "y_min": cyNorm - zoneHNorm / 2.0,
                            "y_max": cyNorm + zoneHNorm / 2.0,
                        ]
                        NSLog(
                            "[SpeedgunPipeline] Plate-plane strike zone from ball size: dia=%.0fpx ppm=%.0f x=%.3f-%.3f y=%.3f-%.3f rule=%@",
                            ballDiaPx, ppm,
                            resolvedStrikeZone["x_min"] ?? 0, resolvedStrikeZone["x_max"] ?? 0,
                            resolvedStrikeZone["y_min"] ?? 0, resolvedStrikeZone["y_max"] ?? 0,
                            absZoneHeightM != nil ? ABS_STRIKE_ZONE_RULE : "legacy"
                        )
                    }
                }

                speedInfo.catchPoint = pos
                speedInfo.catchPointSource = source
                speedInfo.catchPointConfidence = confidence
                speedInfo.plateFitErrorPx = plate.fitErrorPx
                speedInfo.plateExtrapolatedFrames = plate.extrapolatedFrames
                let xNorm = Double(pos.x) / Double(displayWidth)
                let yNorm = Double(pos.y) / Double(displayHeight)
                speedInfo.plateXNorm = xNorm
                speedInfo.plateYNorm = yNorm
                let loc = strikeZoneLocation(xNorm: xNorm, yNorm: yNorm, plateZone: resolvedStrikeZone)
                speedInfo.pitchLocX = loc.x
                speedInfo.pitchLocY = loc.y
                speedInfo.isStrike = loc.isStrike
                speedInfo.plateZone = resolvedStrikeZone
                if let absZoneHeightM = absZoneHeightM, let batterHeightM = batterHeightM {
                    speedInfo.batterHeightM = batterHeightM
                    speedInfo.strikeZoneWidthCm = ABS_STRIKE_ZONE_WIDTH_M * 100.0
                    speedInfo.strikeZoneHeightCm = absZoneHeightM * 100.0
                    speedInfo.strikeZoneRule = ABS_STRIKE_ZONE_RULE
                }
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
                strikeZoneHeightCm: absZoneHeightM.map { $0 * 100.0 },
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
                speedInfo.breakGravityDropCm = kinematics.gravityDropCm
                speedInfo.breakFitR2 = kinematics.breakFitR2
                speedInfo.breakEndpointSource = kinematics.breakEndpointSource
                speedInfo.breakSamples = kinematics.breakSamples
                speedInfo.breakActualSampleRatio = kinematics.breakActualSampleRatio
                speedInfo.breakCmPerPxX = kinematics.breakCmPerPxX
                speedInfo.breakCmPerPxY = kinematics.breakCmPerPxY
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

    private func absStrikeZoneHeightM(_ batterHeightM: Double?) -> Double? {
        guard let batterHeightM,
              batterHeightM >= 1.0,
              batterHeightM <= 2.4 else {
            return nil
        }
        return batterHeightM * (ABS_STRIKE_ZONE_TOP_RATIO - ABS_STRIKE_ZONE_BOTTOM_RATIO)
    }

    private func strikeZoneSpan(batterHeightM: Double?) -> (width: Double, height: Double, absHeightM: Double?) {
        let zoneW = STRIKE_ZONE_X_MAX - STRIKE_ZONE_X_MIN
        let defaultH = STRIKE_ZONE_Y_MAX - STRIKE_ZONE_Y_MIN
        guard let absHeightM = absStrikeZoneHeightM(batterHeightM) else {
            return (zoneW, defaultH, nil)
        }
        let zoneH = clamp(defaultH * (absHeightM / LEGACY_STRIKE_ZONE_HEIGHT_M), min: 0.08, max: 0.45)
        return (zoneW, zoneH, absHeightM)
    }

    private func resolveStrikeZone(_ override: [String: Double]?, batterHeightM: Double? = nil) -> [String: Double] {
        guard let override else {
            let span = strikeZoneSpan(batterHeightM: batterHeightM)
            let cx = (STRIKE_ZONE_X_MIN + STRIKE_ZONE_X_MAX) / 2.0
            let cy = (STRIKE_ZONE_Y_MIN + STRIKE_ZONE_Y_MAX) / 2.0
            return [
                "x_min": cx - span.width / 2.0,
                "x_max": cx + span.width / 2.0,
                "y_min": cy - span.height / 2.0,
                "y_max": cy + span.height / 2.0,
            ]
        }
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
        lastBallFrame: Int?,
        batterHeightM: Double? = nil
    ) -> [String: Double] {
        guard displayWidth > 0, displayHeight > 0 else { return DEFAULT_STRIKE_ZONE }

        let span = strikeZoneSpan(batterHeightM: batterHeightM)
        let zoneW = span.width
        let zoneH = span.height
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

    private struct QuadraticFit {
        let a: Double
        let b: Double
        let c: Double
        let rmse: Double
    }

    private func evaluateQuadratic(_ fit: QuadraticFit, _ t: Double) -> Double {
        fit.a * t * t + fit.b * t + fit.c
    }

    private func weightedQuadraticFit(ts: [Double], values: [Double], weights: [Double]) -> QuadraticFit? {
        guard ts.count == values.count, values.count == weights.count, ts.count >= 4 else { return nil }

        var s0 = 0.0, s1 = 0.0, s2 = 0.0, s3 = 0.0, s4 = 0.0
        var t0 = 0.0, t1 = 0.0, t2 = 0.0
        var weightSum = 0.0

        for i in 0..<ts.count {
            let w = max(0.001, weights[i])
            let x = ts[i]
            let y = values[i]
            let x2 = x * x
            s0 += w
            s1 += w * x
            s2 += w * x2
            s3 += w * x2 * x
            s4 += w * x2 * x2
            t0 += w * y
            t1 += w * y * x
            t2 += w * y * x2
            weightSum += w
        }

        // Normal equations for y = a*t^2 + b*t + c.
        let a11 = s4, a12 = s3, a13 = s2
        let a21 = s3, a22 = s2, a23 = s1
        let a31 = s2, a32 = s1, a33 = s0
        let det = a11 * (a22 * a33 - a23 * a32)
            - a12 * (a21 * a33 - a23 * a31)
            + a13 * (a21 * a32 - a22 * a31)
        guard abs(det) > 1e-9, weightSum > 0 else { return nil }

        let b1 = t2, b2 = t1, b3 = t0
        let qa = (b1 * (a22 * a33 - a23 * a32)
            - a12 * (b2 * a33 - a23 * b3)
            + a13 * (b2 * a32 - a22 * b3)) / det
        let qb = (a11 * (b2 * a33 - a23 * b3)
            - b1 * (a21 * a33 - a23 * a31)
            + a13 * (a21 * b3 - b2 * a31)) / det
        let qc = (a11 * (a22 * b3 - b2 * a32)
            - a12 * (a21 * b3 - b2 * a31)
            + b1 * (a21 * a32 - a22 * a31)) / det

        var err = 0.0
        for i in 0..<ts.count {
            let residual = values[i] - (qa * ts[i] * ts[i] + qb * ts[i] + qc)
            err += max(0.001, weights[i]) * residual * residual
        }
        let rmse = sqrt(err / weightSum)
        return QuadraticFit(a: qa, b: qb, c: qc, rmse: rmse)
    }

    /// Estimate the ball position at the plate using a recency-weighted tail fit.
    /// We fit x(t) and y(t) independently with a quadratic over the final actual
    /// YOLO detections. This preserves late horizontal movement while damping the
    /// frame-to-frame bbox jitter that dominates near the glove.
    private func estimatePlatePosition(
        frameInfos: [FrameInfo],
        displayWidth: Int,
        displayHeight: Int,
        lastBallFrame: Int?,
        catchFrame: Int?,
        fps: Int,
        plateZone: [String: Double]
    ) -> (point: CGPoint, source: String, confidence: Double, fitErrorPx: Double?, extrapolatedFrames: Double)? {
        guard let last = lastBallFrame else { return nil }

        // Collect actual detections only (not gap-filled synthetic points). The
        // lookback scales with capture fps so slow-mo gets enough real time.
        let maxLookback = min(max(18, Int(round(Double(max(1, fps)) * 0.18))), 48)
        let maxSamples = 10
        var actualDetections: [(frameIdx: Int, x: Double, y: Double, area: Double)] = []
        let searchStart = max(0, last - maxLookback)
        for i in stride(from: last, through: searchStart, by: -1) {
            let fi = frameInfos[i]
            if fi.ballInFrame && !fi.ballLostTracking {
                actualDetections.insert((i, Double(fi.ballCenter.x), Double(fi.ballCenter.y), fi.ballArea), at: 0)
            }
            if actualDetections.count >= maxSamples { break }
        }

        guard actualDetections.count >= 2 else {
            return (frameInfos[last].ballCenter, "last_detection", 0.45, nil, 0)
        }

        let pLast = actualDetections[actualDetections.count - 1]
        let curX = pLast.x
        let curY = pLast.y

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
        let vyLinear = median(vys)

        let ts = actualDetections.map { Double($0.frameIdx - pLast.frameIdx) }
        let xs = actualDetections.map { $0.x }
        let ys = actualDetections.map { $0.y }
        let medianArea = median(actualDetections.map { max($0.area, 1.0) })
        let weights = actualDetections.enumerated().map { idx, det -> Double in
            let recency = Double(idx + 1) / Double(actualDetections.count)
            let areaWeight = medianArea > 1 ? clamp(sqrt(max(det.area, 1.0) / medianArea), min: 0.75, max: 1.25) : 1.0
            return (0.45 + 0.55 * recency) * areaWeight
        }

        let xFit = actualDetections.count >= 4 ? weightedQuadraticFit(ts: ts, values: xs, weights: weights) : nil
        let yFit = actualDetections.count >= 4 ? weightedQuadraticFit(ts: ts, values: ys, weights: weights) : nil

        let diag = Double(displayWidth * displayWidth + displayHeight * displayHeight).squareRoot()
        let fitErrorPx = hypot(xFit?.rmse ?? 0, yFit?.rmse ?? 0)
        let fitQuality = clamp(1.0 - fitErrorPx / max(12.0, diag * 0.018), min: 0.0, max: 1.0)

        let useXFit = xFit != nil && (xFit!.rmse <= max(10.0, Double(displayWidth) * 0.018))
        let useYFit = yFit != nil
            && yFit!.b > 0.25
            && yFit!.a >= -0.08
            && yFit!.rmse <= max(12.0, Double(displayHeight) * 0.018)

        func extrapolated(_ tFrames: Double) -> CGPoint {
            let x = useXFit ? evaluateQuadratic(xFit!, tFrames) : curX + vx * tFrames
            let y = useYFit ? evaluateQuadratic(yFit!, tFrames) : curY + vyLinear * tFrames
            return CGPoint(
                x: clamp(x, min: 0.0, max: Double(displayWidth)),
                y: clamp(y, min: 0.0, max: Double(displayHeight))
            )
        }

        func confidence(for tFrames: Double, source: String) -> Double {
            let sampleScore = clamp(Double(actualDetections.count - 2) / 6.0, min: 0.25, max: 1.0)
            let horizonScore = clamp(1.0 - tFrames / max(1.0, Double(max(1, fps)) * 0.35), min: 0.20, max: 1.0)
            let sourceBoost = source == "last_detection" ? 0.06 : (source == "extrapolated_audio" ? 0.10 : 0.0)
            return clamp(0.28 + 0.34 * fitQuality + 0.22 * sampleScore + 0.10 * horizonScore + sourceBoost, min: 0.25, max: 0.95)
        }

        let maxFrames = Double(max(1, fps)) * 0.5

        if let cf = catchFrame, cf >= pLast.frameIdx {
            let t = min(Double(cf - pLast.frameIdx), maxFrames)
            if t <= 0 {
                return (CGPoint(x: curX, y: curY), "last_detection", confidence(for: 0, source: "last_detection"), fitErrorPx, 0)
            }
            return (extrapolated(t), "extrapolated_audio", confidence(for: t, source: "extrapolated_audio"), fitErrorPx, t)
        }

        let zoneYMin = plateZone["y_min"] ?? STRIKE_ZONE_Y_MIN
        let plateBandLo = zoneYMin * Double(displayHeight)

        if curY >= plateBandLo {
            return (CGPoint(x: curX, y: curY), "last_detection", confidence(for: 0, source: "last_detection"), fitErrorPx, 0)
        }

        let vyAtLast = useYFit ? yFit!.b : vyLinear
        let yAccel = useYFit ? yFit!.a : 0.0
        guard vyAtLast > 0.5 else {
            return (CGPoint(x: curX, y: curY), "last_detection", confidence(for: 0, source: "last_detection"), fitErrorPx, 0)
        }

        let drop = plateBandLo - curY
        let tCross: Double
        if yAccel > 1e-9 {
            tCross = (-vyAtLast + sqrt(vyAtLast * vyAtLast + 4 * yAccel * drop)) / (2 * yAccel)
        } else {
            tCross = drop / vyAtLast
        }
        guard tCross > 0, tCross <= maxFrames else {
            return (CGPoint(x: curX, y: curY), "last_detection", confidence(for: 0, source: "last_detection"), fitErrorPx, 0)
        }
        return (extrapolated(tCross), "extrapolated_band", confidence(for: tCross, source: "extrapolated_band"), fitErrorPx, tCross)
    }

    // MARK: - Catcher Detection (catch-point cross-check + strike-zone anchor)

    /// What the single-shot Vision pass at the catch frame found about the catcher.
    private struct CatcherObservation {
        /// Wrist nearest the extrapolated plate position (glove reference).
        var glovePoint: CGPoint?
        /// Shoulder-midpoint x of the largest foreground body (display px).
        var bodyCenterX: CGFloat?
        /// Shoulder-midpoint y of that body (display px).
        var shoulderY: CGFloat?
        /// Shoulder pixel width of that body — scale reference for the zone.
        var shoulderWidthPx: CGFloat?
    }

    /// Detect the catcher (glove wrist + shoulder anchor) around the catch frame.
    ///
    /// The main PoseEstimator is locked to the pitcher ROI, so this runs an
    /// independent single-shot Vision body-pose pass on the catch frame with a
    /// lower-frame ROI. Among all detected wrists, the one nearest the
    /// extrapolated plate position is taken as the glove reference — this
    /// rejects the batter's hands, which sit off to the side of the plate.
    /// The largest detected shoulder pair (foreground body = catcher) is also
    /// returned so the strike zone can be anchored to the catcher's position.
    ///
    /// Returns nil when neither a plausible wrist nor a catcher body is found
    /// (occluded catcher, no Neural Engine on Simulator, decode failure…).
    private func detectCatcherObservation(
        videoURL: URL,
        catchFrame: Int,
        effectivePlaybackFps: Int,
        displayWidth: Int,
        displayHeight: Int,
        near expected: CGPoint
    ) -> CatcherObservation? {
        guard catchFrame >= 0, effectivePlaybackFps > 0 else { return nil }

        let asset = AVAsset(url: videoURL)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        let halfFrame = CMTime(value: 1, timescale: CMTimeScale(max(2, effectivePlaybackFps * 2)))
        generator.requestedTimeToleranceBefore = halfFrame
        generator.requestedTimeToleranceAfter = halfFrame

        // Catcher ROI: lower 60% of the frame (Vision coords are y-up).
        let roiX: CGFloat = 0.05
        let roiY: CGFloat = 0.0
        let roiW: CGFloat = 0.90
        let roiH: CGFloat = 0.60

        let diag = Double(displayWidth * displayWidth + displayHeight * displayHeight).squareRoot()
        // A wrist farther than this from the expected catch point is someone
        // else's (batter/umpire) — reject it.
        let maxWristDistance = 0.30 * diag
        // A shoulder pair narrower than this is a background person (pitcher,
        // bystander) — only the foreground catcher qualifies as zone anchor.
        let minCatcherShoulderPx = 0.08 * Double(min(displayWidth, displayHeight))

        var result = CatcherObservation()
        var bestShoulderW: CGFloat = 0

        // Try the catch frame first, then small offsets in case of motion blur
        // or a momentarily occluded wrist.
        for offset in [0, -2, 2, -4, 4] {
            let frame = catchFrame + offset
            guard frame >= 0 else { continue }
            let time = CMTime(
                seconds: Double(frame) / Double(effectivePlaybackFps),
                preferredTimescale: 600
            )
            guard let cgImage = try? generator.copyCGImage(at: time, actualTime: nil) else { continue }

            let request = VNDetectHumanBodyPoseRequest()
            request.regionOfInterest = CGRect(x: roiX, y: roiY, width: roiW, height: roiH)
            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            guard (try? handler.perform([request])) != nil,
                  let observations = request.results, !observations.isEmpty else { continue }

            var bestWrist: CGPoint? = nil
            var bestDist = maxWristDistance
            for body in observations {
                // Vision landmark location is normalised to the ROI rectangle
                // (y-up); map back to full-frame display pixels (y-down).
                func displayPoint(_ joint: VNHumanBodyPoseObservation.JointName, minConfidence: Float) -> CGPoint? {
                    guard let pt = try? body.recognizedPoint(joint), pt.confidence > minConfidence else { return nil }
                    let fullNormX = roiX + pt.location.x * roiW
                    let fullNormY = roiY + pt.location.y * roiH
                    return CGPoint(
                        x: CGFloat(displayWidth) * fullNormX,
                        y: CGFloat(displayHeight) * (1.0 - fullNormY)
                    )
                }

                for joint in [VNHumanBodyPoseObservation.JointName.leftWrist, .rightWrist] {
                    guard let wrist = displayPoint(joint, minConfidence: 0.1) else { continue }
                    let dist = hypot(Double(wrist.x - expected.x), Double(wrist.y - expected.y))
                    if dist < bestDist {
                        bestDist = dist
                        bestWrist = wrist
                    }
                }

                if let ls = displayPoint(.leftShoulder, minConfidence: 0.2),
                   let rs = displayPoint(.rightShoulder, minConfidence: 0.2) {
                    let shoulderW = abs(ls.x - rs.x)
                    if Double(shoulderW) >= minCatcherShoulderPx, shoulderW > bestShoulderW {
                        bestShoulderW = shoulderW
                        result.bodyCenterX = (ls.x + rs.x) / 2
                        result.shoulderY = (ls.y + rs.y) / 2
                        result.shoulderWidthPx = shoulderW
                    }
                }
            }
            if let wrist = bestWrist {
                result.glovePoint = wrist
                NSLog("[SpeedgunPipeline] Catcher glove detected at frame %d (offset %d): (%.0f, %.0f), dist to extrapolation %.0fpx",
                      frame, offset, wrist.x, wrist.y, bestDist)
                return result
            }
        }
        if result.shoulderWidthPx != nil {
            NSLog("[SpeedgunPipeline] Catcher body found near catch frame %d (no glove wrist)", catchFrame)
            return result
        }
        NSLog("[SpeedgunPipeline] No catcher found near catch frame %d", catchFrame)
        return nil
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

    // MARK: - Ball-size Ranging (pre-detect gap)

    /// Estimate the pre-detect gap (release → first YOLO detection) in frames
    /// using the ball's pixel size at first detection.
    ///
    /// Pinhole model on the known baseball diameter (74mm):
    ///   camToBall = focalPx × 0.074 / ballPxDiameter
    /// The flight-distance model treats the camera as ≈ at the plate (mirroring
    /// estimatePitchingDistance's cam-to-pitcher geometry), so the ball has
    /// already flown (flightDistance − camToBall) metres before first detection
    /// while the detected window covers ~camToBall metres in (last − first)
    /// frames. Scaling that pace backwards gives the pre-detect time — a
    /// physically-derived replacement for the fixed RELEASE_FALLBACK_SEC guess.
    ///
    /// Returns nil when the ranging is unreliable (too few clean detections,
    /// sub-3px ball, or an implied distance outside the plausible flight range).
    private func estimateBallSizePreDetectFrames(
        rawDetections: [RawDetection],
        frameInfos: [FrameInfo],
        firstBallFrame: Int?,
        endpointFrame: Int?,
        focalLengthPx: Double,
        flightDistanceM: Double,
        fps: Int,
        displayWidth: Int
    ) -> Double? {
        guard let first = firstBallFrame, let last = endpointFrame, last > first,
              flightDistanceM > 1.0, focalLengthPx > 1.0 else { return nil }

        // Median min-side bbox diameter over the first few REAL detections.
        // min(width, height) resists motion-blur elongation of the bbox; the
        // nearest-to-accepted-center match rejects unrelated false positives
        // that share the frame with the real ball.
        let matchTolerance = max(50.0, Double(displayWidth) * 0.03)
        var diameters: [Double] = []
        var fid = first
        while fid < min(rawDetections.count, frameInfos.count, first + 20), diameters.count < 5 {
            defer { fid += 1 }
            let fi = frameInfos[fid]
            guard fi.ballInFrame, !fi.ballLostTracking else { continue }
            let cx = Double(fi.ballCenter.x)
            let cy = Double(fi.ballCenter.y)
            guard let det = rawDetections[fid].detections.min(by: {
                hypot($0.cx - cx, $0.cy - cy) < hypot($1.cx - cx, $1.cy - cy)
            }), hypot(det.cx - cx, det.cy - cy) <= matchTolerance else { continue }
            diameters.append(min(det.width, det.height))
        }
        guard diameters.count >= 3 else {
            NSLog("[SpeedgunPipeline] Ball-size ranging: too few clean detections (%d<3)", diameters.count)
            return nil
        }

        let pxDiameter = median(diameters)
        guard pxDiameter >= 3.0 else {
            NSLog("[SpeedgunPipeline] Ball-size ranging: ball too small (%.1fpx)", pxDiameter)
            return nil
        }

        let camToBall = focalLengthPx * BASEBALL_DIAMETER_M / pxDiameter
        // Plausibility: the first detection must lie inside the flight path —
        // not behind the camera and not farther than the pitcher.
        guard camToBall > flightDistanceM * 0.2, camToBall < flightDistanceM * 1.05 else {
            NSLog("[SpeedgunPipeline] Ball-size ranging: camToBall=%.1fm implausible for flight %.1fm",
                  camToBall, flightDistanceM)
            return nil
        }

        let flownPreM = max(0.0, flightDistanceM - camToBall)
        let detectSec = Double(last - first) / Double(max(1, fps))
        let preSec = detectSec * flownPreM / camToBall
        guard preSec <= MAX_PRE_DETECT_SEC else {
            NSLog("[SpeedgunPipeline] Ball-size ranging: preSec=%.2fs exceeds cap %.2fs",
                  preSec, MAX_PRE_DETECT_SEC)
            return nil
        }

        NSLog("[SpeedgunPipeline] Ball-size ranging: ballPx=%.1f camToBall=%.1fm flownPre=%.1fm → pre=%.3fs",
              pxDiameter, camToBall, flownPreM, preSec)
        return preSec * Double(max(1, fps))
    }

    // MARK: - Pose-based Distance Estimation

    /// Estimate the camera-to-pitcher distance from the shoulder width visible in pose landmarks.
    ///
    /// Uses the pinhole camera model: distance = focalLength * realWidth / pixelWidth
    ///
    /// Algorithm:
    /// 1. Collect shoulder pixel widths from all frames where both shoulders are detected.
    /// 2. Use the median (robust to outliers from frames where the pitcher is side-on).
    /// 3. Convert to camera-to-pitcher distance using the camera focal length
    ///    (metadata-derived when available, tuned constant otherwise).
    /// 4. Clamp result to [POSE_DIST_MIN_M, POSE_DIST_MAX_M].
    ///
    /// Returns nil if not enough pose data is available.
    private func estimatePitchingDistance(
        frameInfos: [FrameInfo],
        displayWidth: Int,
        displayHeight: Int,
        focalLengthPx: Double,
        pitcherHeightM: Double? = nil
    ) -> Double? {

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

    /// Fill holes after the best SORT track has been chosen.
    ///
    /// Phase-1 gap fill works on all candidate detections before we know which
    /// track is the pitch. This pass is stricter: it only interpolates between
    /// anchors from the selected track, so the overlay and downstream trajectory
    /// remain continuous without letting unrelated false positives bridge the
    /// path.
    private func fillSelectedTrackGaps(
        frameInfos: inout [FrameInfo],
        track: [TrackPoint],
        fps: Int,
        displayWidth: Int,
        displayHeight: Int
    ) {
        guard frameInfos.count >= 2 else { return }

        let anchors = Dictionary(grouping: track, by: { $0.frameIndex })
            .compactMap { frameIdx, points -> TrackPoint? in
                guard frameIdx >= 0 && frameIdx < frameInfos.count else { return nil }
                return points.max(by: { $0.area < $1.area })
            }
            .sorted { $0.frameIndex < $1.frameIndex }

        guard anchors.count >= 2 else { return }

        let maxGap = max(5, Int(round(Double(max(1, fps)) * 0.45)))

        func clampPoint(_ p: CGPoint) -> CGPoint {
            CGPoint(
                x: CGFloat(clamp(Double(p.x), min: 0.0, max: Double(displayWidth))),
                y: CGFloat(clamp(Double(p.y), min: 0.0, max: Double(displayHeight)))
            )
        }

        func point(_ tp: TrackPoint) -> CGPoint {
            CGPoint(x: tp.cx, y: tp.cy)
        }

        func catmullRom(_ p0: CGPoint, _ p1: CGPoint, _ p2: CGPoint, _ p3: CGPoint, _ t: Double) -> CGPoint {
            let t2 = t * t
            let t3 = t2 * t
            let x = 0.5 * (
                2.0 * Double(p1.x)
                + (Double(p2.x) - Double(p0.x)) * t
                + (2.0 * Double(p0.x) - 5.0 * Double(p1.x) + 4.0 * Double(p2.x) - Double(p3.x)) * t2
                + (-Double(p0.x) + 3.0 * Double(p1.x) - 3.0 * Double(p2.x) + Double(p3.x)) * t3
            )
            let y = 0.5 * (
                2.0 * Double(p1.y)
                + (Double(p2.y) - Double(p0.y)) * t
                + (2.0 * Double(p0.y) - 5.0 * Double(p1.y) + 4.0 * Double(p2.y) - Double(p3.y)) * t2
                + (-Double(p0.y) + 3.0 * Double(p1.y) - 3.0 * Double(p2.y) + Double(p3.y)) * t3
            )
            return clampPoint(CGPoint(x: x, y: y))
        }

        var filledCount = 0
        for i in 0..<(anchors.count - 1) {
            let prev = anchors[i]
            let next = anchors[i + 1]
            let gap = next.frameIndex - prev.frameIndex - 1
            if gap <= 0 || gap > maxGap { continue }

            let p0 = point(i > 0 ? anchors[i - 1] : prev)
            let p1 = point(prev)
            let p2 = point(next)
            let p3 = point((i + 2) < anchors.count ? anchors[i + 2] : next)
            let frameSpan = max(1, next.frameIndex - prev.frameIndex)
            let area = prev.area > 0 && next.area > 0 ? (prev.area + next.area) / 2.0 : max(prev.area, next.area)

            for frameIdx in (prev.frameIndex + 1)..<next.frameIndex {
                guard frameIdx >= 0 && frameIdx < frameInfos.count else { continue }
                if frameInfos[frameIdx].ballInFrame && !frameInfos[frameIdx].ballLostTracking {
                    continue
                }

                let t = Double(frameIdx - prev.frameIndex) / Double(frameSpan)
                let p = catmullRom(p0, p1, p2, p3, t)
                frameInfos[frameIdx].ballInFrame = true
                frameInfos[frameIdx].ballCenter = p
                frameInfos[frameIdx].ballColor = (255, 30, 30)
                frameInfos[frameIdx].ballLostTracking = true
                if area > 0 { frameInfos[frameIdx].ballArea = area }
                filledCount += 1
            }
        }

        if filledCount > 0 {
            NSLog("[SpeedgunPipeline] Selected-track gap fill: added %d synthetic frames across %d anchors",
                  filledCount, anchors.count)
        }
    }
}
