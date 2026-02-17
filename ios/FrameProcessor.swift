import Foundation
import AVFoundation
import CoreGraphics

struct FrameProcessResult {
    let poseLandmarks: [PoseLandmark]
    let ballBoxes: [CGRect]
    let currentSpeedKmh: Double?
    let lastPitchInfo: PitchInfo?
    let frameSize: CGSize
}

/// FrameProcessor 負責：
/// 1. 把 CMSampleBuffer 丟給 Mediapipe Pose（需在 Xcode 內串接 MediaPipe SDK）取得關鍵點
/// 2. 把同一個 frame 丟給 CoreML YOLO 模型做球偵測
/// 3. 根據釋球點與目標點 frame index + fps 計算球速
///
/// 注意：pitchDistanceMeters 應傳入跨步修正後的「有效飛行距離」，
/// 而非投手丘到本壘板的原始距離（18.44m）。
/// 由 CameraViewModel 計算 effectiveDistance 後傳入。
final class FrameProcessor {
    private let pitchDistanceMeters: Double
    
    // 狀態
    private var frameIndex: Int = 0
    private var fps: Double = 30.0
    
    private var lastReleaseFrameIndex: Int?
    private var lastTargetFrameIndex: Int?
    private var lastPitchInfo: PitchInfo?
    
    init(pitchDistanceMeters: Double) {
        self.pitchDistanceMeters = pitchDistanceMeters
    }
    
    func process(sampleBuffer: CMSampleBuffer,
                 completion: @escaping (FrameProcessResult) -> Void) {
        frameIndex += 1
        
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            completion(FrameProcessResult(poseLandmarks: [],
                                          ballBoxes: [],
                                          currentSpeedKmh: nil,
                                          lastPitchInfo: lastPitchInfo,
                                          frameSize: .zero))
            return
        }
        
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if frameIndex > 1 {
            let prevTime = time - CMTime(value: 1, timescale: CMTimeScale(fps))
            let dt = time - prevTime
            if dt.seconds > 0 {
                fps = 1.0 / dt.seconds
            }
        }
        
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let frameSize = CGSize(width: width, height: height)
        
        // 1. 呼叫 Mediapipe Pose（此處留空實作，需在 Xcode 加入 MediaPipe）
        let poseLandmarks = runMediapipePose(on: pixelBuffer, frameSize: frameSize)
        
        // 2. 呼叫 CoreML YOLO 模型做球偵測（需在 Xcode 加入 mlmodel）
        let ballBoxes = runBallDetection(on: pixelBuffer, frameSize: frameSize)
        
        // 3. 更新釋球點 / 目標點，計算球速
        updateReleaseAndTarget(using: poseLandmarks, ballBoxes: ballBoxes)
        
        let currentSpeed = lastPitchInfo?.speedKmh
        
        let result = FrameProcessResult(poseLandmarks: poseLandmarks,
                                        ballBoxes: ballBoxes,
                                        currentSpeedKmh: currentSpeed,
                                        lastPitchInfo: lastPitchInfo,
                                        frameSize: frameSize)
        completion(result)
    }
    
    // MARK: - Mediapipe Pose placeholder
    
    private func runMediapipePose(on pixelBuffer: CVPixelBuffer,
                                  frameSize: CGSize) -> [PoseLandmark] {
        // TODO: 在 Xcode 中接入 MediaPipe iOS Pose solution，
        // 把輸出對應到 PoseLandmark 陣列，x/y 使用 [0,1] 相對座標
        return []
    }
    
    // MARK: - CoreML YOLO placeholder
    
    private func runBallDetection(on pixelBuffer: CVPixelBuffer,
                                  frameSize: CGSize) -> [CGRect] {
        // TODO: 在 Xcode 中匯入轉好的 mlmodel（例如 BaseballYOLO.mlmodel），
        // 利用 Vision 或 CoreML 直接推論，輸出歸一化 bounding boxes（0~1）
        return []
    }
    
    // MARK: - 釋球與目標偵測（簡化版規則）
    
    private func updateReleaseAndTarget(using poseLandmarks: [PoseLandmark],
                                        ballBoxes: [CGRect]) {
        // 這裡提供一個非常簡化的規則，你可以之後在 Xcode 裡再細調：
        // 1. 釋球點：球第一次出現在畫面，且不再貼近投球手腕附近
        // 2. 目標點：球中心 x 超過畫面寬度某一比例（例如 0.8）
        
        guard !ballBoxes.isEmpty else { return }
        
        let mainBall = ballBoxes[0]
        let ballCenterX = mainBall.midX
        
        let releaseAlreadySet = (lastReleaseFrameIndex != nil)
        
        if !releaseAlreadySet {
            if ballCenterX > 0.1 {
                lastReleaseFrameIndex = frameIndex
            }
        } else {
            if ballCenterX > 0.8 {
                lastTargetFrameIndex = frameIndex
            }
        }
        
        if let release = lastReleaseFrameIndex,
           let target = lastTargetFrameIndex,
           target > release {
            let deltaFrames = target - release
            let deltaTime = Double(deltaFrames) / fps
            let speedMs = pitchDistanceMeters / deltaTime
            let speedKmh = speedMs * 3.6
            let info = PitchInfo(releaseFrameIndex: release,
                                 targetFrameIndex: target,
                                 deltaTime: deltaTime,
                                 speedKmh: speedKmh)
            lastPitchInfo = info
            
            // 重置，準備下一球
            lastReleaseFrameIndex = nil
            lastTargetFrameIndex = nil
        }
    }
}

