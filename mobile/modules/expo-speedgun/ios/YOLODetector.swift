import CoreML
import Vision
import CoreVideo
import CoreGraphics
import Accelerate

/// CoreML-based YOLO26n ball detector.
/// Processes frames and returns ball detections.
final class YOLODetector {
    private let model: VNCoreMLModel
    private let modelInputSize: Int = 640

    // Phase 1 Kalman for ROI recovery (simple 4-state: cx, cy, vx, vy)
    private var kalmanState: [Double]? // [cx, cy, vx, vy]
    private var kalmanInitialized = false

    init() throws {
        // Find the compiled model in the app bundle
        // Use direct path lookup since Bundle.url(forResource:) can miss .mlmodelc directories
        let modelURL: URL

        let mainBundlePath = Bundle.main.bundlePath
        let directPath = (mainBundlePath as NSString).appendingPathComponent("best_baseball.mlmodelc")

        if FileManager.default.fileExists(atPath: directPath) {
            NSLog("[YOLODetector] Found mlmodelc at direct path: %@", directPath)
            modelURL = URL(fileURLWithPath: directPath)
        } else if let url = Bundle.main.url(forResource: "best_baseball", withExtension: "mlmodelc") {
            NSLog("[YOLODetector] Found mlmodelc via Bundle.main: %@", url.path)
            modelURL = url
        } else if let url = Bundle(for: YOLODetector.self).url(forResource: "best_baseball", withExtension: "mlmodelc") {
            NSLog("[YOLODetector] Found mlmodelc via class bundle: %@", url.path)
            modelURL = url
        } else {
            // Debug: list what's actually in the bundle
            let contents = (try? FileManager.default.contentsOfDirectory(atPath: mainBundlePath)) ?? []
            let relevant = contents.filter { $0.lowercased().contains("baseball") || $0.contains("mlmodel") || $0.contains("Models") }
            NSLog("[YOLODetector] Bundle path: %@", mainBundlePath)
            NSLog("[YOLODetector] Relevant contents: %@", relevant.description)
            NSLog("[YOLODetector] All contents count: %d", contents.count)
            throw SpeedgunError.modelLoadFailed("best_baseball model not found in bundle")
        }

        let config = MLModelConfiguration()
        config.computeUnits = .all // Use Neural Engine when available

        let mlModel = try MLModel(contentsOf: modelURL, configuration: config)
        model = try VNCoreMLModel(for: mlModel)
    }

    /// Detect balls in a full pixel buffer.
    /// Returns detections in display coordinates.
    func detect(
        pixelBuffer: CVPixelBuffer,
        frameIndex: Int,
        displayWidth: Int,
        displayHeight: Int,
        confThreshold: Double = 0.05
    ) -> [BallDetection] {
        var detections: [BallDetection] = []

        let request = VNCoreMLRequest(model: model) { request, error in
            guard error == nil,
                  let results = request.results as? [VNRecognizedObjectObservation] else {
                return
            }

            for obs in results {
                guard obs.confidence >= Float(confThreshold) else { continue }

                // VNRecognizedObjectObservation.boundingBox is in normalized coords
                // Origin is bottom-left, y-up (Vision convention)
                let bbox = obs.boundingBox
                let x = bbox.origin.x * CGFloat(displayWidth)
                let y = (1.0 - bbox.origin.y - bbox.size.height) * CGFloat(displayHeight)
                let w = bbox.size.width * CGFloat(displayWidth)
                let h = bbox.size.height * CGFloat(displayHeight)

                let cx = Double(x + w / 2)
                let cy = Double(y + h / 2)
                let width = Double(w)
                let height = Double(h)
                let area = width * height

                // Basic filters (matching Python pipeline)
                let areaRatio = area / Double(displayWidth * displayHeight)
                if areaRatio > MAX_AREA_RATIO { continue }

                let aspect = width > 0 && height > 0
                    ? max(width/height, height/width)
                    : 999.0
                if aspect > MAX_ASPECT_RATIO { continue }

                // Exclusion zones
                let yNorm = cy / Double(displayHeight)
                if yNorm > (1.0 - BOTTOM_EXCLUSION) { continue }
                if yNorm < TOP_EXCLUSION { continue }

                let det = BallDetection(
                    cx: cx, cy: cy,
                    width: width, height: height,
                    confidence: Double(obs.confidence),
                    area: area,
                    frameIndex: frameIndex
                )
                detections.append(det)
            }
        }

        request.imageCropAndScaleOption = .scaleFill

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        do {
            try handler.perform([request])
        } catch {
            NSLog("[YOLODetector] detect frame=%d error: %@", frameIndex, error.localizedDescription)
        }

        return detections
    }

    /// Detect balls within a ROI (for Kalman-guided recovery)
    func detectInROI(
        pixelBuffer: CVPixelBuffer,
        roi: CGRect,  // in normalized coords (0-1)
        frameIndex: Int,
        displayWidth: Int,
        displayHeight: Int,
        confThreshold: Double = 0.03
    ) -> [BallDetection] {
        var detections: [BallDetection] = []

        let request = VNCoreMLRequest(model: model) { request, error in
            guard error == nil,
                  let results = request.results as? [VNRecognizedObjectObservation] else {
                return
            }

            for obs in results {
                guard obs.confidence >= Float(confThreshold) else { continue }

                let bbox = obs.boundingBox
                // Map from ROI-relative coords back to full-frame coords
                let fullX = (roi.origin.x + bbox.origin.x * roi.width) * CGFloat(displayWidth)
                let fullY = (1.0 - (roi.origin.y + bbox.origin.y * roi.height + bbox.size.height * roi.height)) * CGFloat(displayHeight)
                let w = bbox.size.width * roi.width * CGFloat(displayWidth)
                let h = bbox.size.height * roi.height * CGFloat(displayHeight)

                let cx = Double(fullX + w / 2)
                let cy = Double(fullY + h / 2)

                let det = BallDetection(
                    cx: cx, cy: cy,
                    width: Double(w), height: Double(h),
                    confidence: Double(obs.confidence),
                    area: Double(w * h),
                    frameIndex: frameIndex
                )
                detections.append(det)
            }
        }

        request.regionOfInterest = roi
        request.imageCropAndScaleOption = .scaleFill

        let handler = VNImageRequestHandler(cvPixelBuffer: pixelBuffer, options: [:])
        do {
            try handler.perform([request])
        } catch {
            NSLog("[YOLODetector] detectInROI frame=%d error: %@", frameIndex, error.localizedDescription)
        }

        return detections
    }

    // MARK: - Letterboxed detection

    /// Letterbox-resize pixelBuffer to the model input (preserving aspect ratio),
    /// run YOLO detection, then unpad coordinates back to display space.
    /// This matches Python YOLO's imgsz letterbox behaviour exactly.
    func detectHighRes(
        pixelBuffer: CVPixelBuffer,
        frameIndex: Int,
        displayWidth: Int,
        displayHeight: Int,
        confThreshold: Double = 0.05
    ) -> [BallDetection] {
        let targetSize = modelInputSize
        // Compute letterbox scale & padding (same as Python's letterbox())
        let srcW = Double(displayWidth)
        let srcH = Double(displayHeight)
        let tgt  = Double(targetSize)
        let scale = min(tgt / srcW, tgt / srcH)          // uniform scale that fits
        let scaledW = srcW * scale
        let scaledH = srcH * scale
        let padX = (tgt - scaledW) / 2.0                 // left pad in letterbox px
        let padY = (tgt - scaledH) / 2.0                 // top  pad in letterbox px

        guard let letterboxed = letterboxPixelBuffer(
            pixelBuffer,
            targetSize: targetSize,
            scaledWidth: Int(scaledW.rounded()),
            scaledHeight: Int(scaledH.rounded()),
            padX: Int(padX.rounded()),
            padY: Int(padY.rounded())
        ) else {
            return detect(
                pixelBuffer: pixelBuffer,
                frameIndex: frameIndex,
                displayWidth: displayWidth,
                displayHeight: displayHeight,
                confThreshold: confThreshold
            )
        }

        var detections: [BallDetection] = []

        let request = VNCoreMLRequest(model: model) { [padX, padY, scale, tgt] request, error in
            guard error == nil,
                  let results = request.results as? [VNRecognizedObjectObservation] else { return }

            for obs in results {
                guard obs.confidence >= Float(confThreshold) else { continue }

                // Vision bbox: normalized, origin bottom-left y-up on the letterbox canvas
                let bbox = obs.boundingBox
                // Convert to pixel coords in letterbox space
                let lbX1 = bbox.origin.x * tgt
                let lbY1 = (1.0 - bbox.origin.y - bbox.size.height) * tgt  // flip y
                let lbW  = bbox.size.width  * tgt
                let lbH  = bbox.size.height * tgt

                // Remove padding and reverse scale → original display coords
                let x1 = (lbX1 - padX) / scale
                let y1 = (lbY1 - padY) / scale
                let w  = lbW / scale
                let h  = lbH / scale

                let cx = x1 + w / 2
                let cy = y1 + h / 2
                let area = w * h

                // Basic filters
                let areaRatio = area / Double(displayWidth * displayHeight)
                if areaRatio > MAX_AREA_RATIO { continue }

                let aspect = w > 0 && h > 0 ? max(w/h, h/w) : 999.0
                if aspect > MAX_ASPECT_RATIO { continue }

                let yNorm = cy / Double(displayHeight)
                if yNorm > (1.0 - BOTTOM_EXCLUSION) { continue }
                if yNorm < TOP_EXCLUSION { continue }

                detections.append(BallDetection(
                    cx: cx, cy: cy,
                    width: w, height: h,
                    confidence: Double(obs.confidence),
                    area: area,
                    frameIndex: frameIndex
                ))
            }
        }

        // scaleFit so Vision doesn't distort our letterbox canvas
        request.imageCropAndScaleOption = .scaleFit
        let handler = VNImageRequestHandler(cvPixelBuffer: letterboxed, options: [:])
        do {
            try handler.perform([request])
        } catch {
            NSLog("[YOLODetector] detectHighRes frame=%d error: %@", frameIndex, error.localizedDescription)
        }

        return detections
    }

    // MARK: - Letterbox resize (preserve aspect ratio, pad with black)

    private func letterboxPixelBuffer(
        _ src: CVPixelBuffer,
        targetSize: Int,
        scaledWidth: Int,
        scaledHeight: Int,
        padX: Int,
        padY: Int
    ) -> CVPixelBuffer? {
        let srcW = CVPixelBufferGetWidth(src)
        let srcH = CVPixelBufferGetHeight(src)
        guard srcW > 0, srcH > 0 else { return nil }

        // Create target (black-filled) buffer
        var dst: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            targetSize, targetSize,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &dst
        )
        guard status == kCVReturnSuccess, let dstBuf = dst else { return nil }

        CVPixelBufferLockBaseAddress(src, .readOnly)
        CVPixelBufferLockBaseAddress(dstBuf, [])
        defer {
            CVPixelBufferUnlockBaseAddress(src, .readOnly)
            CVPixelBufferUnlockBaseAddress(dstBuf, [])
        }

        guard let srcBase = CVPixelBufferGetBaseAddress(src),
              let dstBase = CVPixelBufferGetBaseAddress(dstBuf) else { return nil }

        let dstRowBytes = CVPixelBufferGetBytesPerRow(dstBuf)

        // Zero-fill entire destination (black letterbox)
        memset(dstBase, 0, dstRowBytes * targetSize)

        // Step 1: scale src → scaledWidth×scaledHeight via vImage
        var scaledBuf: CVPixelBuffer?
        let scAttrs = attrs as CFDictionary
        guard CVPixelBufferCreate(kCFAllocatorDefault, scaledWidth, scaledHeight,
                                  kCVPixelFormatType_32BGRA, scAttrs, &scaledBuf) == kCVReturnSuccess,
              let scaledPB = scaledBuf else { return nil }

        CVPixelBufferLockBaseAddress(scaledPB, [])
        defer { CVPixelBufferUnlockBaseAddress(scaledPB, []) }
        guard let scaledBase = CVPixelBufferGetBaseAddress(scaledPB) else { return nil }

        var srcVImg = vImage_Buffer(
            data: srcBase,
            height: vImagePixelCount(srcH),
            width:  vImagePixelCount(srcW),
            rowBytes: CVPixelBufferGetBytesPerRow(src)
        )
        var scaledVImg = vImage_Buffer(
            data: scaledBase,
            height: vImagePixelCount(scaledHeight),
            width:  vImagePixelCount(scaledWidth),
            rowBytes: CVPixelBufferGetBytesPerRow(scaledPB)
        )
        let scErr = vImageScale_ARGB8888(&srcVImg, &scaledVImg, nil, vImage_Flags(kvImageHighQualityResampling))
        guard scErr == kvImageNoError else {
            NSLog("[YOLODetector] letterbox scale error: %d", scErr)
            return nil
        }

        // Step 2: copy scaled image into dst at (padX, padY)
        let scaledRowBytes = CVPixelBufferGetBytesPerRow(scaledPB)
        let bytesPerPixel = 4
        for row in 0..<scaledHeight {
            let dstRow = row + padY
            guard dstRow >= 0 && dstRow < targetSize else { continue }
            let srcPtr = scaledBase.advanced(by: row * scaledRowBytes)
            let dstPtr = dstBase.advanced(by: dstRow * dstRowBytes + padX * bytesPerPixel)
            let copyBytes = min(scaledWidth * bytesPerPixel, (targetSize - padX) * bytesPerPixel)
            memcpy(dstPtr, srcPtr, copyBytes)
        }

        return dstBuf
    }

    // MARK: - vImage pixel buffer resize

    /// Resize a CVPixelBuffer (BGRA) to targetWidth×targetHeight using vImage.
    private func resizePixelBuffer(_ src: CVPixelBuffer, targetWidth: Int, targetHeight: Int) -> CVPixelBuffer? {
        let srcWidth  = CVPixelBufferGetWidth(src)
        let srcHeight = CVPixelBufferGetHeight(src)
        guard srcWidth > 0, srcHeight > 0 else { return nil }

        // Allocate destination pixel buffer
        var dst: CVPixelBuffer?
        let attrs: [String: Any] = [
            kCVPixelBufferCGImageCompatibilityKey as String: true,
            kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        ]
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault,
            targetWidth, targetHeight,
            kCVPixelFormatType_32BGRA,
            attrs as CFDictionary,
            &dst
        )
        guard status == kCVReturnSuccess, let dstBuf = dst else { return nil }

        CVPixelBufferLockBaseAddress(src, .readOnly)
        CVPixelBufferLockBaseAddress(dstBuf, [])
        defer {
            CVPixelBufferUnlockBaseAddress(src, .readOnly)
            CVPixelBufferUnlockBaseAddress(dstBuf, [])
        }

        guard let srcBase = CVPixelBufferGetBaseAddress(src),
              let dstBase = CVPixelBufferGetBaseAddress(dstBuf) else { return nil }

        var srcBuf = vImage_Buffer(
            data: srcBase,
            height: vImagePixelCount(srcHeight),
            width:  vImagePixelCount(srcWidth),
            rowBytes: CVPixelBufferGetBytesPerRow(src)
        )
        var dstBufV = vImage_Buffer(
            data: dstBase,
            height: vImagePixelCount(targetHeight),
            width:  vImagePixelCount(targetWidth),
            rowBytes: CVPixelBufferGetBytesPerRow(dstBuf)
        )

        let err = vImageScale_ARGB8888(&srcBuf, &dstBufV, nil, vImage_Flags(kvImageHighQualityResampling))
        guard err == kvImageNoError else {
            NSLog("[YOLODetector] vImageScale error: %d", err)
            return nil
        }

        return dstBuf
    }

    // MARK: - Phase 1 Kalman for ROI prediction

    func kalmanReset() {
        kalmanState = nil
        kalmanInitialized = false
    }

    func kalmanUpdate(cx: Double, cy: Double) {
        if let state = kalmanState {
            // Simple update: blend prediction with measurement
            let alpha = 0.7
            let newCx = alpha * cx + (1 - alpha) * (state[0] + state[2])
            let newCy = alpha * cy + (1 - alpha) * (state[1] + state[3])
            let newVx = 0.5 * (cx - state[0]) + 0.5 * state[2]
            let newVy = 0.5 * (cy - state[1]) + 0.5 * state[3]
            kalmanState = [newCx, newCy, newVx, newVy]
        } else {
            kalmanState = [cx, cy, 0, 0]
        }
        kalmanInitialized = true
    }

    func kalmanPredict() -> CGPoint? {
        guard let state = kalmanState, kalmanInitialized else { return nil }
        return CGPoint(x: state[0] + state[2], y: state[1] + state[3])
    }

    /// Get ROI rect in normalized coords for Kalman-predicted position
    func kalmanROI(displayWidth: Int, displayHeight: Int) -> CGRect? {
        guard let predicted = kalmanPredict() else { return nil }

        let roiSize = Double(KALMAN_ROI_SIZE)
        let halfW = roiSize / Double(displayWidth) / 2
        let halfH = roiSize / Double(displayHeight) / 2
        let normX = Double(predicted.x) / Double(displayWidth)
        let normY = 1.0 - Double(predicted.y) / Double(displayHeight) // flip Y for Vision

        let x = max(0, normX - halfW)
        let y = max(0, normY - halfH)
        let w = min(1.0 - x, halfW * 2)
        let h = min(1.0 - y, halfH * 2)

        return CGRect(x: x, y: y, width: w, height: h)
    }
}
