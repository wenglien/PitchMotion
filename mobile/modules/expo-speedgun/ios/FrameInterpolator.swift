import Foundation
import Metal
import MetalKit
import Vision
import CoreVideo
import Accelerate

/// Optical-flow-based frame interpolator.
///
/// For every pair of consecutive decoded frames (A, B) it synthesises one
/// intermediate frame at t = 0.5 using:
///   1. VNGenerateOpticalFlowRequest  → dense pixel-level flow A→B and B→A
///   2. Metal kernel (FrameInterpolator.metal) → forward+backward warp & blend
///
/// Usage:
///   let interp = try FrameInterpolator()
///   if let mid = interp.interpolate(frameA: bufA, frameB: bufB) {
///       // mid is a CVPixelBuffer at the same resolution as A/B
///   }
final class FrameInterpolator {

    // MARK: - Metal state
    private let device: MTLDevice
    private let commandQueue: MTLCommandQueue
    private let pipelineState: MTLComputePipelineState

    // MARK: - Reusable textures (lazily allocated per resolution)
    private var texA: MTLTexture?
    private var texB: MTLTexture?
    private var texFlowFwd: MTLTexture?   // A→B  RG32Float
    private var texFlowBwd: MTLTexture?   // B→A  RG32Float
    private var texOut: MTLTexture?
    private var outPixelBuffer: CVPixelBuffer?
    private var lastWidth  = 0
    private var lastHeight = 0

    // MARK: - Init

    init() throws {
        guard let dev = MTLCreateSystemDefaultDevice() else {
            throw FrameInterpolatorError.metalUnavailable
        }
        device = dev
        guard let queue = dev.makeCommandQueue() else {
            throw FrameInterpolatorError.metalUnavailable
        }
        commandQueue = queue

        // Load the Metal library bundled with the module
        let library: MTLLibrary
        // Try the module bundle first, fall back to main bundle
        if let bundleURL = Bundle(for: FrameInterpolator.self)
                .url(forResource: "FrameInterpolator", withExtension: "metallib"),
           let lib = try? dev.makeLibrary(URL: bundleURL) {
            library = lib
        } else if let lib = dev.makeDefaultLibrary() {
            library = lib
        } else {
            throw FrameInterpolatorError.shaderNotFound
        }

        guard let fn = library.makeFunction(name: "interpolateFrames") else {
            throw FrameInterpolatorError.shaderNotFound
        }
        pipelineState = try dev.makeComputePipelineState(function: fn)
    }

    // MARK: - Public API

    /// Synthesise one frame between `frameA` and `frameB`.
    /// Returns nil on any failure (falls through gracefully).
    func interpolate(frameA: CVPixelBuffer,
                     frameB: CVPixelBuffer,
                     time t: Float = 0.5) -> CVPixelBuffer? {
        interpolate(frameA: frameA, frameB: frameB, times: [t]).first
    }

    /// Synthesise multiple in-between frames. Optical flow is computed once for
    /// the pair, then reused for each requested interpolation time.
    func interpolate(frameA: CVPixelBuffer,
                     frameB: CVPixelBuffer,
                     times: [Float]) -> [CVPixelBuffer] {
        let validTimes = times
            .filter { $0 > 0 && $0 < 1 }
            .sorted()
        guard !validTimes.isEmpty else { return [] }

        let W = CVPixelBufferGetWidth(frameA)
        let H = CVPixelBufferGetHeight(frameA)

        // Reallocate textures if resolution changed
        if W != lastWidth || H != lastHeight {
            guard allocateTextures(width: W, height: H) else { return [] }
            lastWidth  = W
            lastHeight = H
        }

        // Copy pixel buffers → Metal textures (BGRA)
        guard copyPixelBuffer(frameA, to: texA!),
              copyPixelBuffer(frameB, to: texB!) else { return [] }

        // Compute optical flow A→B and B→A
        guard computeOpticalFlow(from: frameA, to: frameB, into: texFlowFwd!),
              computeOpticalFlow(from: frameB, to: frameA, into: texFlowBwd!) else { return [] }

        var outputs: [CVPixelBuffer] = []
        for t in validTimes {
            guard renderInterpolated(width: W, height: H, time: t),
                  let outBuf = makePixelBuffer(width: W, height: H) else {
                continue
            }
            copyTexture(texOut!, to: outBuf)
            outputs.append(outBuf)
        }
        return outputs
    }

    // MARK: - Private helpers

    private func allocateTextures(width W: Int, height H: Int) -> Bool {
        let bgraDesc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .bgra8Unorm, width: W, height: H, mipmapped: false)
        bgraDesc.usage = [.shaderRead, .shaderWrite]

        let flowDesc = MTLTextureDescriptor.texture2DDescriptor(
            pixelFormat: .rg32Float, width: W, height: H, mipmapped: false)
        flowDesc.usage = [.shaderRead, .shaderWrite]

        texA       = device.makeTexture(descriptor: bgraDesc)
        texB       = device.makeTexture(descriptor: bgraDesc)
        texOut     = device.makeTexture(descriptor: bgraDesc)
        texFlowFwd = device.makeTexture(descriptor: flowDesc)
        texFlowBwd = device.makeTexture(descriptor: flowDesc)

        guard texA != nil, texB != nil, texOut != nil,
              texFlowFwd != nil, texFlowBwd != nil else { return false }

        // Allocate output pixel buffer
        guard let buf = makePixelBuffer(width: W, height: H) else { return false }
        outPixelBuffer = buf
        return true
    }

    private func makePixelBuffer(width W: Int, height H: Int) -> CVPixelBuffer? {
        var pb: CVPixelBuffer?
        let status = CVPixelBufferCreate(
            kCFAllocatorDefault, W, H,
            kCVPixelFormatType_32BGRA,
            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary,
            &pb)
        guard status == kCVReturnSuccess else { return nil }
        return pb
    }

    /// Copy a BGRA CVPixelBuffer into an MTLTexture row-by-row via replaceRegion.
    private func copyPixelBuffer(_ buffer: CVPixelBuffer, to texture: MTLTexture) -> Bool {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return false }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        let W = CVPixelBufferGetWidth(buffer)
        let H = CVPixelBufferGetHeight(buffer)
        texture.replace(region: MTLRegionMake2D(0, 0, W, H),
                        mipmapLevel: 0,
                        withBytes: base,
                        bytesPerRow: bytesPerRow)
        return true
    }

    /// Copy an MTLTexture back into a BGRA CVPixelBuffer.
    private func copyTexture(_ texture: MTLTexture, to buffer: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(buffer)
        let W = texture.width
        let H = texture.height
        texture.getBytes(base,
                         bytesPerRow: bytesPerRow,
                         from: MTLRegionMake2D(0, 0, W, H),
                         mipmapLevel: 0)
    }

    /// Compute dense optical flow using VNGenerateOpticalFlowRequest and store
    /// the result (RG float pixel offsets) into `flowTexture`.
    private func computeOpticalFlow(from src: CVPixelBuffer,
                                    to dst: CVPixelBuffer,
                                    into flowTexture: MTLTexture) -> Bool {
        let W = CVPixelBufferGetWidth(src)
        let H = CVPixelBufferGetHeight(src)

        let request = VNGenerateOpticalFlowRequest(targetedCVPixelBuffer: dst)
        request.computationAccuracy = .medium   // fast enough for real-time pre-process
        request.outputPixelFormat = kCVPixelFormatType_TwoComponent32Float

        let handler = VNImageRequestHandler(cvPixelBuffer: src, options: [:])
        do {
            try handler.perform([request])
        } catch {
            NSLog("[FrameInterpolator] optical flow error: %@", error.localizedDescription)
            return false
        }

        // VNGenerateOpticalFlowRequest returns VNPixelBufferObservation (iOS 14+)
        guard let obs = request.results?.first as? VNPixelBufferObservation else { return false }

        // obs.pixelBuffer contains flow vectors in pixel units (TwoComponent32Float)
        let flowPx = obs.pixelBuffer   // TwoComponent32Float, same size as input
        CVPixelBufferLockBaseAddress(flowPx, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(flowPx, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(flowPx) else { return false }
        let bytesPerRow = CVPixelBufferGetBytesPerRow(flowPx)

        // VNOpticalFlowObservation gives offsets already in pixel units on recent iOS.
        // Copy directly into the RG32Float Metal texture.
        flowTexture.replace(region: MTLRegionMake2D(0, 0, W, H),
                            mipmapLevel: 0,
                            withBytes: base,
                            bytesPerRow: bytesPerRow)
        return true
    }

    /// Dispatch the Metal interpolation kernel and write to `texOut`.
    private func renderInterpolated(width W: Int, height H: Int, time: Float) -> Bool {
        guard let cmdBuf = commandQueue.makeCommandBuffer(),
              let encoder = cmdBuf.makeComputeCommandEncoder() else { return false }

        encoder.setComputePipelineState(pipelineState)
        encoder.setTexture(texA,       index: 0)
        encoder.setTexture(texB,       index: 1)
        encoder.setTexture(texFlowFwd, index: 2)
        encoder.setTexture(texFlowBwd, index: 3)
        encoder.setTexture(texOut,     index: 4)

        var t = time
        encoder.setBytes(&t, length: MemoryLayout<Float>.size, index: 0)

        let tgSize = MTLSize(width: 16, height: 16, depth: 1)
        let gridSize = MTLSize(
            width:  (W + 15) / 16,
            height: (H + 15) / 16,
            depth:  1)
        encoder.dispatchThreadgroups(gridSize, threadsPerThreadgroup: tgSize)
        encoder.endEncoding()

        cmdBuf.commit()
        cmdBuf.waitUntilCompleted()
        return cmdBuf.error == nil
    }
}

// MARK: - Errors
enum FrameInterpolatorError: Error {
    case metalUnavailable
    case shaderNotFound
}
