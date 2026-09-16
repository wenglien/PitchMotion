#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
check_dir=$(mktemp -d)
trap 'rm -rf "$check_dir"' EXIT
core=modules/expo-speedgun/ios
sources=("$core/Support/VideoDecoder.swift" scripts/check-video-decoder.swift)
if [[ "${1:-macos}" == ios ]]; then
  sources+=("$core/Types.swift" "$core/Support/DebugLogger.swift"
    "$core/Rendering/TrajectoryMath.swift" "$core/Rendering/ABSStrikeZoneRenderer.swift"
    "$core/Rendering/OverlayGenerator.swift")
  xcrun --sdk iphonesimulator swiftc -suppress-warnings \
    -target "$(uname -m)-apple-ios18.5-simulator" \
    -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
    "${sources[@]}" -o "$check_dir/check"
  xcrun simctl spawn booted "$check_dir/check"
else
  xcrun swiftc -suppress-warnings "${sources[@]}" -o "$check_dir/check"
  "$check_dir/check"
fi
