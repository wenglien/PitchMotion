import Foundation
import AVFoundation
import CoreGraphics

struct PoseLandmark {
    let type: Int
    let x: CGFloat
    let y: CGFloat
    let visibility: CGFloat
}

struct PitchInfo {
    let releaseFrameIndex: Int
    let targetFrameIndex: Int
    let deltaTime: Double
    let speedKmh: Double
}

final class CameraViewModel: NSObject, ObservableObject {
    @Published var poseLandmarks: [PoseLandmark] = []
    @Published var ballBoxes: [CGRect] = []
    @Published var currentSpeedKmh: Double? = nil
    @Published var lastPitchInfo: PitchInfo? = nil
    @Published var frameSize: CGSize = .zero
    
    let captureSession = AVCaptureSession()
    private let videoOutput = AVCaptureVideoDataOutput()
    private let sessionQueue = DispatchQueue(label: "SpeedgunMobile.CameraSessionQueue")
    
    // 投手丘到本壘板距離（公尺），預設 18.44m（MLB）
    var pitchDistanceMeters: Double = 18.44
    // 跨步修正（公尺）：投手跨步 + 手臂伸展的距離，預設 1.7m
    var strideCorrection: Double = 1.7
    // 實際球飛行距離 = pitchDistanceMeters - strideCorrection
    var effectiveDistance: Double { max(pitchDistanceMeters - strideCorrection, 1.0) }
    
    private lazy var frameProcessor = FrameProcessor(
        pitchDistanceMeters: effectiveDistance
    )
    
    func startSession() {
        sessionQueue.async {
            self.configureSessionIfNeeded()
            if !self.captureSession.isRunning {
                self.captureSession.startRunning()
            }
        }
    }
    
    func stopSession() {
        sessionQueue.async {
            if self.captureSession.isRunning {
                self.captureSession.stopRunning()
            }
        }
    }
    
    private var isConfigured = false
    
    private func configureSessionIfNeeded() {
        guard !isConfigured else { return }
        captureSession.beginConfiguration()
        captureSession.sessionPreset = .high
        
        // 輸入（後鏡頭）
        guard let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
              let input = try? AVCaptureDeviceInput(device: device),
              captureSession.canAddInput(input) else {
            captureSession.commitConfiguration()
            return
        }
        captureSession.addInput(input)
        
        // 輸出
        videoOutput.setSampleBufferDelegate(self, queue: DispatchQueue(label: "SpeedgunMobile.VideoOutputQueue"))
        videoOutput.alwaysDiscardsLateVideoFrames = true
        if captureSession.canAddOutput(videoOutput) {
            captureSession.addOutput(videoOutput)
        }
        
        if let connection = videoOutput.connection(with: .video) {
            connection.videoOrientation = .portrait
        }
        
        captureSession.commitConfiguration()
        isConfigured = true
    }
}

extension CameraViewModel: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(_ output: AVCaptureOutput,
                       didOutput sampleBuffer: CMSampleBuffer,
                       from connection: AVCaptureConnection) {
        frameProcessor.process(sampleBuffer: sampleBuffer) { [weak self] result in
            guard let self = self else { return }
            DispatchQueue.main.async {
                self.poseLandmarks = result.poseLandmarks
                self.ballBoxes = result.ballBoxes
                self.currentSpeedKmh = result.currentSpeedKmh
                self.lastPitchInfo = result.lastPitchInfo
                self.frameSize = result.frameSize
            }
        }
    }
}

