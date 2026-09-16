import Foundation
import AVFoundation

@main
struct CheckVideoDecoder {
    static func main() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let validURL = directory.appendingPathComponent("valid.mp4")
        try writeVideo(to: validURL)
        let valid = try VideoDecoder(url: validURL)
        try valid.startReading()
        defer { valid.stopReading() }
        var count = 0
        while let _ = try valid.nextFrame() { count += 1 }
        precondition(count > 0, "Valid video must decode")
        let eof = try valid.nextFrame()
        precondition(eof == nil, "EOF must remain EOF")

        // Preserve the MP4 metadata and destroy only encoded sample data.
        var bytes = try Data(contentsOf: validURL)
        var offset = 0
        var corrupted = false
        while offset + 8 <= bytes.count {
            var size = bytes[offset..<(offset + 4)].reduce(0) { ($0 << 8) | Int($1) }
            let header = size == 1 ? 16 : 8
            precondition(offset + header <= bytes.count)
            if size == 1 { size = bytes[(offset + 8)..<(offset + 16)].reduce(0) { ($0 << 8) | Int($1) } }
            if size == 0 { size = bytes.count - offset }
            precondition(size >= header && offset + size <= bytes.count)
            if bytes[(offset + 4)..<(offset + 8)] == Data("mdat".utf8) {
                bytes.replaceSubrange((offset + header)..<(offset + size), with: repeatElement(UInt8(0), count: size - header))
                corrupted = true
            }
            offset += size
        }
        precondition(corrupted)
        let corruptURL = directory.appendingPathComponent("corrupt.mp4")
        try bytes.write(to: corruptURL)
        let corrupt = try VideoDecoder(url: corruptURL)
        try corrupt.startReading()
        defer { corrupt.stopReading() }
        var rejected = false
        do {
            while let _ = try corrupt.nextFrame() {}
        } catch {
            rejected = true
        }
        precondition(rejected, "Corrupt video must throw, not silently finish analysis")
        print("video decoder checks passed (\(count) valid frames; corrupt video rejected)")

        #if canImport(UIKit)
        let overlayURL = directory.appendingPathComponent("overlay.mp4")
        let overlay = OverlayGenerator()
        try overlay.generate(sourceURL: validURL, frameInfos: [], speedInfo: nil, outputURL: overlayURL)
        precondition(FileManager.default.fileExists(atPath: overlayURL.path))
        let rendered = try VideoDecoder(url: overlayURL)
        try rendered.startReading()
        defer { rendered.stopReading() }
        var renderedCount = 0
        while let _ = try rendered.nextFrame() { renderedCount += 1 }
        precondition(renderedCount == count, "Overlay must preserve every frame")
        rejected = false
        do {
            try overlay.generate(sourceURL: corruptURL, frameInfos: [], speedInfo: nil, outputURL: overlayURL)
        } catch { rejected = true }
        precondition(rejected, "Corrupt overlay input must not report success")
        precondition(!FileManager.default.fileExists(atPath: overlayURL.path), "Failed overlay must be removed")
        print("overlay checks passed (valid export decoded; corrupt export rejected and removed)")
        #endif
    }

    static func writeVideo(to url: URL) throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 64, AVVideoHeightKey: 64,
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        precondition(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        var buffer: CVPixelBuffer?
        precondition(CVPixelBufferCreate(nil, 64, 64, kCVPixelFormatType_32BGRA, nil, &buffer) == kCVReturnSuccess)
        let pixelBuffer = buffer!
        CVPixelBufferLockBaseAddress(pixelBuffer, [])
        memset(CVPixelBufferGetBaseAddress(pixelBuffer), 0, CVPixelBufferGetDataSize(pixelBuffer))
        CVPixelBufferUnlockBaseAddress(pixelBuffer, [])
        for frame in 0..<10 {
            let deadline = Date().addingTimeInterval(10)
            while !input.isReadyForMoreMediaData {
                precondition(writer.status == .writing && Date() < deadline, "Fixture writer stalled")
                Thread.sleep(forTimeInterval: 0.01)
            }
            precondition(adaptor.append(pixelBuffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 10)))
        }
        input.markAsFinished()
        let finished = DispatchSemaphore(value: 0)
        writer.finishWriting { finished.signal() }
        precondition(finished.wait(timeout: .now() + 10) == .success && writer.status == .completed)
    }
}
