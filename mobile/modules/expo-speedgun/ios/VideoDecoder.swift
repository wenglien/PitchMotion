import AVFoundation
import CoreVideo

/// Extracts frames from a video file using AVAssetReader.
/// Handles iPhone rotation metadata automatically via preferredTransform.
final class VideoDecoder {
    let asset: AVAsset
    let videoTrack: AVAssetTrack
    let fps: Int          // nominalFrameRate — playback/display fps, used for frame count & progress
    let captureFps: Int   // true capture fps — 1/minFrameDuration; equals fps for normal video,
                          // higher for slo-mo (e.g. 240 for iPhone 240fps slo-mo)
    let displayWidth: Int
    let displayHeight: Int
    let totalFrames: Int
    let duration: Double
    let naturalSize: CGSize

    private var reader: AVAssetReader?
    // AVAssetReaderTrackOutput delivers frames at naturalSize (sensor orientation).
    // For iPhone portrait recordings the natural pixels are landscape with a 90°
    // preferredTransform — without applying that transform, downstream code
    // would receive landscape frames while expecting portrait. Use
    // AVAssetReaderVideoCompositionOutput to bake the rotation into the output.
    private var output: AVAssetReaderOutput?
    // Retain the last sample buffer so the CVPixelBuffer it owns stays alive
    // until the next call to nextFrame(). Without this, the CVPixelBuffer returned
    // by CMSampleBufferGetImageBuffer() becomes a dangling pointer the moment
    // sampleBuffer goes out of scope (it is unretained / +0).
    private var lastSampleBuffer: CMSampleBuffer?

    init(url: URL) throws {
        asset = AVAsset(url: url)

        guard let track = asset.tracks(withMediaType: .video).first else {
            throw SpeedgunError.videoLoadFailed("No video track found")
        }
        videoTrack = track

        // fps: use nominalFrameRate (playback/display rate, correct for normal video).
        // For iPhone slo-mo (captured at 240fps, played at 30fps), nominalFrameRate = 30.
        // This keeps totalFrames and progress calculation accurate.
        let nominalFPS = track.nominalFrameRate
        fps = max(1, Int(round(nominalFPS)))

        // captureFps: true capture rate derived from minFrameDuration.
        // For normal video minFrameDuration ≈ 1/fps, so captureFps == fps.
        // For iPhone slo-mo minFrameDuration = 1/240s → captureFps = 240.
        // This is what BallSpeedCalculator needs for correct real-world time.
        let minDur = track.minFrameDuration
        let minDurSecs = (minDur.isValid && !minDur.isIndefinite && minDur.seconds > 0)
            ? minDur.seconds : 0.0
        let rawCaptureFps = minDurSecs > 0
            ? Int(round(1.0 / minDurSecs))
            : fps
        // Must be >= fps (capture can't be slower than playback); cap at 960fps (iPhone max slo-mo)
        captureFps = max(fps, min(rawCaptureFps, 960))

        // Handle rotation: preferredTransform rotates the natural size
        let transform = track.preferredTransform
        let size = track.naturalSize
        let transformedSize = size.applying(transform)
        displayWidth = Int(abs(transformedSize.width))
        displayHeight = Int(abs(transformedSize.height))
        naturalSize = CGSize(width: displayWidth, height: displayHeight)

        duration = CMTimeGetSeconds(asset.duration)
        totalFrames = max(1, Int(round(duration * Double(fps))))
    }

    // MARK: - HDR Detection & Conversion

    /// Check if the video uses HDR (HLG / Dolby Vision / PQ).
    var isHDR: Bool {
        // Check format descriptions for HDR transfer functions or wide color primaries.
        // iPhone videos with Display P3 (Wide Color SDR) also need the same
        // AVVideoComposition color-space path to produce correct BT.709 BGRA pixels.
        for desc in videoTrack.formatDescriptions {
            let formatDesc = desc as! CMFormatDescription  // swiftlint:disable:this force_cast
            if let exts = CMFormatDescriptionGetExtensions(formatDesc) as? [String: Any] {
                // Check transfer function (HLG / PQ = true HDR)
                if let tf = exts[kCMFormatDescriptionExtension_TransferFunction as String] as? String {
                    let hdrTFs: Set<String> = [
                        kCMFormatDescriptionTransferFunction_SMPTE_ST_2084_PQ as String,
                        kCMFormatDescriptionTransferFunction_ITU_R_2100_HLG as String,
                    ]
                    if hdrTFs.contains(tf) { return true }
                }
                // Check color primaries: P3 or BT.2020 both need conversion to BT.709
                if let cp = exts[kCMFormatDescriptionExtension_ColorPrimaries as String] as? String {
                    let wideColorPrimaries: Set<String> = [
                        kCMFormatDescriptionColorPrimaries_DCI_P3 as String,
                        kCMFormatDescriptionColorPrimaries_ITU_R_2020 as String,
                    ]
                    if wideColorPrimaries.contains(cp) { return true }
                }
                // Check for 10-bit formats (p010, yuv420p10)
                if let bitsPerComponent = exts[kCMFormatDescriptionExtension_BitsPerComponent as String] as? Int,
                   bitsPerComponent >= 10 {
                    return true
                }
            }
            // Also check pixel format directly
            let pixelFormat = CMFormatDescriptionGetMediaSubType(formatDesc)
            // kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange = 'x420'
            // kCVPixelFormatType_420YpCbCr10BiPlanarFullRange = 'xf20'
            let hdrPixelFormats: Set<OSType> = [
                kCVPixelFormatType_420YpCbCr10BiPlanarVideoRange,
                kCVPixelFormatType_420YpCbCr10BiPlanarFullRange,
            ]
            if hdrPixelFormats.contains(pixelFormat) { return true }
        }
        return false
    }

    /// Convert an HDR video to SDR using AVAssetExportSession + AVVideoComposition
    /// with a CIFilter-based color space conversion.
    /// Returns the URL of the converted SDR file, or nil on failure.
    static func convertHDRtoSDR(sourceURL: URL) async -> URL? {
        let asset = AVAsset(url: sourceURL)
        guard let videoTrack = asset.tracks(withMediaType: .video).first else {
            NSLog("[VideoDecoder] HDR→SDR: no video track")
            return nil
        }

        let outputURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("speedgun_sdr_\(Int(Date().timeIntervalSince1970)).mp4")
        try? FileManager.default.removeItem(at: outputURL)

        // Build an AVVideoComposition that forces the output color space to BT.709 SDR.
        // This uses Core Image's automatic HDR→SDR tone mapping pipeline.
        let transform = videoTrack.preferredTransform
        let rawSize = videoTrack.naturalSize
        let txSize = rawSize.applying(transform)
        let outW = abs(txSize.width)
        let outH = abs(txSize.height)

        let composition = AVMutableVideoComposition(propertiesOf: asset)
        composition.renderSize = CGSize(width: outW, height: outH)
        // Force BT.709 SDR color space — this triggers proper HDR→SDR tone mapping
        composition.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        composition.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        composition.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2

        guard let exportSession = AVAssetExportSession(
            asset: asset,
            presetName: AVAssetExportPresetHighestQuality
        ) else {
            NSLog("[VideoDecoder] HDR→SDR: cannot create export session")
            return nil
        }

        exportSession.outputURL = outputURL
        exportSession.outputFileType = .mp4
        exportSession.shouldOptimizeForNetworkUse = false
        exportSession.videoComposition = composition

        await exportSession.export()

        switch exportSession.status {
        case .completed:
            NSLog("[VideoDecoder] HDR→SDR conversion succeeded: %@", outputURL.path)
            return outputURL
        case .failed:
            NSLog("[VideoDecoder] HDR→SDR conversion failed: %@",
                  exportSession.error?.localizedDescription ?? "unknown")
            return nil
        case .cancelled:
            NSLog("[VideoDecoder] HDR→SDR conversion cancelled")
            return nil
        default:
            return nil
        }
    }

    /// Start reading frames. Call nextFrame() repeatedly.
    func startReading() throws {
        let reader = try AVAssetReader(asset: asset)

        let outputSettings: [String: Any] = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ]

        let output: AVAssetReaderOutput
        let needsRotation = !videoTrack.preferredTransform.isIdentity
        if needsRotation {
            // Build a video composition that applies preferredTransform so the
            // delivered frames are oriented to match displayWidth × displayHeight.
            let composition = AVMutableVideoComposition()
            composition.renderSize = CGSize(width: displayWidth, height: displayHeight)
            composition.frameDuration = CMTime(value: 1, timescale: Int32(max(1, fps)))

            let instruction = AVMutableVideoCompositionInstruction()
            instruction.timeRange = CMTimeRange(start: .zero, duration: asset.duration)
            let layerInstruction = AVMutableVideoCompositionLayerInstruction(assetTrack: videoTrack)
            layerInstruction.setTransform(videoTrack.preferredTransform, at: .zero)
            instruction.layerInstructions = [layerInstruction]
            composition.instructions = [instruction]

            let compOutput = AVAssetReaderVideoCompositionOutput(
                videoTracks: [videoTrack],
                videoSettings: outputSettings
            )
            compOutput.videoComposition = composition
            compOutput.alwaysCopiesSampleData = false
            output = compOutput
        } else {
            let trackOutput = AVAssetReaderTrackOutput(track: videoTrack, outputSettings: outputSettings)
            trackOutput.alwaysCopiesSampleData = false
            output = trackOutput
        }

        guard reader.canAdd(output) else {
            throw SpeedgunError.videoLoadFailed("Cannot add video output to reader")
        }
        reader.add(output)

        guard reader.startReading() else {
            throw SpeedgunError.videoLoadFailed(reader.error?.localizedDescription ?? "Unknown reader error")
        }

        self.reader = reader
        self.output = output
        NSLog("[VideoDecoder] startReading OK — status=%d fps=%d captureFps=%d size=%dx%d",
              reader.status.rawValue,
              fps, captureFps,
              Int(abs(videoTrack.naturalSize.applying(videoTrack.preferredTransform).width)),
              Int(abs(videoTrack.naturalSize.applying(videoTrack.preferredTransform).height)))
    }

    /// Expose current reader status for diagnostics
    var readerStatus: AVAssetReader.Status {
        return reader?.status ?? .unknown
    }

    /// Get next frame as CVPixelBuffer. Returns nil when done.
    func nextFrame() -> CVPixelBuffer? {
        guard let output = output, let reader = reader else { return nil }
        guard reader.status == .reading else { return nil }

        if let sampleBuffer = output.copyNextSampleBuffer() {
            // Retain the sample buffer for the lifetime of this frame so the
            // CVPixelBuffer it vends (unretained +0) remains valid.
            lastSampleBuffer = sampleBuffer
            return CMSampleBufferGetImageBuffer(sampleBuffer)
        }
        lastSampleBuffer = nil
        // Log why reading stopped
        if reader.status == .failed {
            NSLog("[VideoDecoder] nextFrame — reader failed: %@",
                  reader.error?.localizedDescription ?? "unknown error")
        } else {
            NSLog("[VideoDecoder] nextFrame — reader status=%d (completed or cancelled)", reader.status.rawValue)
        }
        return nil
    }

    /// Check if the video has an audio track
    var hasAudioTrack: Bool {
        return !asset.tracks(withMediaType: .audio).isEmpty
    }

    /// Clean up
    func stopReading() {
        reader?.cancelReading()
        reader = nil
        output = nil
        lastSampleBuffer = nil
    }
}

// MARK: - Errors

enum SpeedgunError: LocalizedError {
    case videoLoadFailed(String)
    case modelLoadFailed(String)
    case noFramesExtracted
    case noBallDetected
    case insufficientTrajectory(Int)
    case overlayGenerationFailed(String)

    var errorDescription: String? {
        switch self {
        case .videoLoadFailed(let msg): return "Video load failed: \(msg)"
        case .modelLoadFailed(let msg): return "Model load failed: \(msg)"
        case .noFramesExtracted: return "No frames could be extracted from video"
        case .noBallDetected: return "No ball detected in video"
        case .insufficientTrajectory(let n): return "Insufficient trajectory points: \(n)"
        case .overlayGenerationFailed(let msg): return "Overlay generation failed: \(msg)"
        }
    }
}
