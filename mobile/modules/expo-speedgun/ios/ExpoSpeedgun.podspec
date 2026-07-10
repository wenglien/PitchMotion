require 'json'

package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))

Pod::Spec.new do |s|
  s.name           = 'ExpoSpeedgun'
  s.version        = package['version']
  s.summary        = 'On-device baseball pitch analysis pipeline'
  s.description    = 'Expo native module for offline YOLO ball detection, tracking, speed calculation, and overlay generation'
  s.author         = package['author']
  s.license        = package['license']
  s.homepage       = 'https://github.com/user/speedgun-mobile'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: 'https://github.com/user/speedgun-mobile.git', tag: s.version.to_s }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.dependency 'MediaPipeTasksVision'

  s.source_files = '*.swift', '*.metal'
  s.resources = '../Resources/best_baseball.mlmodelc', '../Resources/pose_landmarker_full.task', '../Resources/pose_landmarker_heavy.task'

  s.frameworks = 'CoreML', 'Vision', 'AVFoundation', 'CoreImage', 'Accelerate', 'CoreGraphics', 'Metal', 'MetalKit'
end
