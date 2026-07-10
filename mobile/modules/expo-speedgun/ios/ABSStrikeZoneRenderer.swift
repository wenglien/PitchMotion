import CoreGraphics
import Foundation
import UIKit

enum ABSCalibrationMode: String {
    case twoD = "2d"
    case threeD = "3d"
}

struct ABSCameraParameters {
    let matrix: [[Double]]
    let distCoeffs: [Double]
    let rvec: [Double]
    let tvec: [Double]
}

struct ABSStrikeZone3D {
    let center: [Double]
    let width: Double
    let height: Double
    let depth: Double
}

struct ABSStrikeZone2D {
    let left: Double
    let right: Double
    let top: Double
    let bottom: Double
}

struct ABSCalibration {
    let mode: ABSCalibrationMode
    let zone2D: ABSStrikeZone2D?
    let depthOffset: CGPoint
    let zone3D: ABSStrikeZone3D?
    let camera: ABSCameraParameters?

    static func parse(_ raw: Any?) throws -> ABSCalibration? {
        guard let raw else { return nil }
        if raw is NSNull { return nil }

        let object: [String: Any]
        if let text = raw as? String {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { return nil }
            guard let data = trimmed.data(using: .utf8) else {
                throw SpeedgunError.invalidConfiguration("ABS calibration string must be UTF-8 JSON")
            }
            let parsed = try JSONSerialization.jsonObject(with: data)
            guard let dict = parsed as? [String: Any] else {
                throw SpeedgunError.invalidConfiguration("ABS calibration JSON root must be an object")
            }
            object = dict
        } else if let dict = raw as? [String: Any] {
            object = dict
        } else {
            throw SpeedgunError.invalidConfiguration("absCalibration must be a JSON object or JSON string")
        }

        guard let modeRaw = object["mode"] as? String,
              let mode = ABSCalibrationMode(rawValue: modeRaw) else {
            throw SpeedgunError.invalidConfiguration("ABS mode must be '2d' or '3d'")
        }
        guard let zone = object["zone"] as? [String: Any] else {
            throw SpeedgunError.invalidConfiguration("ABS calibration missing zone object")
        }

        switch mode {
        case .twoD:
            let zone2D = try parseZone2D(zone)
            let offsetDict = object["depth_offset"] as? [String: Any]
            let dx = number(offsetDict?["x"]) ?? 40.0
            let dy = number(offsetDict?["y"]) ?? -30.0
            return ABSCalibration(
                mode: .twoD,
                zone2D: zone2D,
                depthOffset: CGPoint(x: dx, y: dy),
                zone3D: nil,
                camera: nil
            )

        case .threeD:
            let center = try numberArray(zone["center"], count: 3, name: "zone.center")
            guard let width = number(zone["width"]),
                  let height = number(zone["height"]),
                  let depth = number(zone["depth"]),
                  width > 0, height > 0, depth > 0 else {
                throw SpeedgunError.invalidConfiguration("3D ABS zone requires positive width, height, and depth")
            }
            guard let cameraDict = object["camera"] as? [String: Any] else {
                throw SpeedgunError.invalidConfiguration("3D ABS calibration missing camera object")
            }
            let matrixRaw = cameraDict["matrix"] ?? cameraDict["camera_matrix"]
            let matrix = try matrix3x3(matrixRaw, name: "camera.matrix")
            let rvec = try numberArray(cameraDict["rvec"], count: 3, name: "camera.rvec")
            let tvec = try numberArray(cameraDict["tvec"], count: 3, name: "camera.tvec")
            let distCoeffs: [Double]
            if let rawDistCoeffs = cameraDict["dist_coeffs"] ?? cameraDict["distCoeffs"] {
                distCoeffs = try numberArray(
                    rawDistCoeffs,
                    allowedCounts: [4, 5, 8, 12, 14],
                    name: "camera.dist_coeffs"
                )
            } else {
                distCoeffs = [0, 0, 0, 0]
            }

            return ABSCalibration(
                mode: .threeD,
                zone2D: nil,
                depthOffset: .zero,
                zone3D: ABSStrikeZone3D(center: center, width: width, height: height, depth: depth),
                camera: ABSCameraParameters(matrix: matrix, distCoeffs: distCoeffs, rvec: rvec, tvec: tvec)
            )
        }
    }

    static func fromPlateZone(_ plateZone: [String: Double]) -> ABSCalibration {
        let zone = ABSStrikeZone2D(
            left: plateZone["x_min"] ?? STRIKE_ZONE_X_MIN,
            right: plateZone["x_max"] ?? STRIKE_ZONE_X_MAX,
            top: plateZone["y_min"] ?? STRIKE_ZONE_Y_MIN,
            bottom: plateZone["y_max"] ?? STRIKE_ZONE_Y_MAX
        )
        return ABSCalibration(
            mode: .twoD,
            zone2D: zone,
            depthOffset: CGPoint(x: 0.07, y: -0.11),
            zone3D: nil,
            camera: nil
        )
    }

    func normalizedPlateZone(sourceWidth: Int, sourceHeight: Int) -> [String: Double]? {
        guard mode == .twoD,
              let z = zone2D,
              sourceWidth > 0,
              sourceHeight > 0 else { return nil }

        let xMin = z.looksNormalized ? z.left : clamp(z.left / Double(sourceWidth), min: 0.0, max: 1.0)
        let xMax = z.looksNormalized ? z.right : clamp(z.right / Double(sourceWidth), min: 0.0, max: 1.0)
        let yMin = z.looksNormalized ? z.top : clamp(z.top / Double(sourceHeight), min: 0.0, max: 1.0)
        let yMax = z.looksNormalized ? z.bottom : clamp(z.bottom / Double(sourceHeight), min: 0.0, max: 1.0)
        guard xMin < xMax, yMin < yMax else { return nil }
        return ["x_min": xMin, "x_max": xMax, "y_min": yMin, "y_max": yMax]
    }

    private static func parseZone2D(_ zone: [String: Any]) throws -> ABSStrikeZone2D {
        if let left = number(zone["left"]),
           let right = number(zone["right"]),
           let top = number(zone["top"]),
           let bottom = number(zone["bottom"]) {
            guard left < right, top < bottom else {
                throw SpeedgunError.invalidConfiguration("2D ABS zone requires left < right and top < bottom")
            }
            return ABSStrikeZone2D(left: left, right: right, top: top, bottom: bottom)
        }

        let keys = ["top_left", "top_right", "bottom_right", "bottom_left"]
        let points = try keys.map { try numberArray(zone[$0], count: 2, name: "zone.\($0)") }
        let xs = points.map { $0[0] }
        let ys = points.map { $0[1] }
        guard let left = xs.min(), let right = xs.max(), let top = ys.min(), let bottom = ys.max(),
              left < right, top < bottom else {
            throw SpeedgunError.invalidConfiguration("2D ABS corner points form an invalid zone")
        }
        return ABSStrikeZone2D(left: left, right: right, top: top, bottom: bottom)
    }
}

final class ABSStrikeZoneRenderer {
    private let planeColor = UIColor(red: 1.0, green: 0.84, blue: 0.29, alpha: 1.0)
    private let glowColor = UIColor(red: 0.49, green: 0.83, blue: 0.99, alpha: 1.0)

    func render(
        ctx: CGContext,
        calibration: ABSCalibration,
        sourceWidth: Int,
        sourceHeight: Int,
        outputWidth: Int,
        outputHeight: Int,
        alpha: Double,
        showLabel: Bool = true
    ) {
        switch calibration.mode {
        case .twoD:
            guard let zone = calibration.zone2D else { return }
            let (plane, shadowOffset) = plane2DPoints(
                zone: zone,
                depthOffset: calibration.depthOffset,
                sourceWidth: sourceWidth,
                sourceHeight: sourceHeight,
                outputWidth: outputWidth,
                outputHeight: outputHeight
            )
            drawPlane(ctx: ctx, points: plane, shadowOffset: shadowOffset, alpha: alpha, showLabel: showLabel)

        case .threeD:
            guard let zone = calibration.zone3D, let camera = calibration.camera else { return }
            let projected = project3DPlane(
                zone: zone,
                camera: camera,
                sourceWidth: sourceWidth,
                sourceHeight: sourceHeight,
                outputWidth: outputWidth,
                outputHeight: outputHeight
            )
            guard projected.count == 4 else { return }
            drawPlane(ctx: ctx, points: projected, shadowOffset: CGPoint(x: 10, y: 14), alpha: alpha, showLabel: showLabel)
        }
    }

    private func plane2DPoints(
        zone: ABSStrikeZone2D,
        depthOffset: CGPoint,
        sourceWidth: Int,
        sourceHeight: Int,
        outputWidth: Int,
        outputHeight: Int
    ) -> ([CGPoint], CGPoint) {
        let sx = Double(outputWidth) / Double(max(1, sourceWidth))
        let sy = Double(outputHeight) / Double(max(1, sourceHeight))

        let front: [CGPoint]
        if zone.looksNormalized {
            front = [
                CGPoint(x: CGFloat(zone.left * Double(outputWidth)), y: CGFloat(zone.top * Double(outputHeight))),
                CGPoint(x: CGFloat(zone.right * Double(outputWidth)), y: CGFloat(zone.top * Double(outputHeight))),
                CGPoint(x: CGFloat(zone.right * Double(outputWidth)), y: CGFloat(zone.bottom * Double(outputHeight))),
                CGPoint(x: CGFloat(zone.left * Double(outputWidth)), y: CGFloat(zone.bottom * Double(outputHeight))),
            ]
        } else {
            front = [
                CGPoint(x: CGFloat(zone.left * sx), y: CGFloat(zone.top * sy)),
                CGPoint(x: CGFloat(zone.right * sx), y: CGFloat(zone.top * sy)),
                CGPoint(x: CGFloat(zone.right * sx), y: CGFloat(zone.bottom * sy)),
                CGPoint(x: CGFloat(zone.left * sx), y: CGFloat(zone.bottom * sy)),
            ]
        }

        let dx = abs(depthOffset.x) <= 1.0
            ? depthOffset.x * CGFloat(outputWidth)
            : depthOffset.x * CGFloat(sx)
        let dy = abs(depthOffset.y) <= 1.0
            ? depthOffset.y * CGFloat(outputHeight)
            : depthOffset.y * CGFloat(sy)
        let shadowOffset = CGPoint(
            x: clamp(dx * 0.22, min: -18, max: 18),
            y: clamp(abs(dy) * 0.28 + 10, min: 10, max: 28)
        )
        return (front, shadowOffset)
    }

    private func project3DPlane(
        zone: ABSStrikeZone3D,
        camera: ABSCameraParameters,
        sourceWidth: Int,
        sourceHeight: Int,
        outputWidth: Int,
        outputHeight: Int
    ) -> [CGPoint] {
        let points = build3DPlanePoints(zone)
        let rotation = rodrigues(camera.rvec)
        let sx = Double(outputWidth) / Double(max(1, sourceWidth))
        let sy = Double(outputHeight) / Double(max(1, sourceHeight))

        let fx = camera.matrix[0][0] * sx
        let fy = camera.matrix[1][1] * sy
        let cx = camera.matrix[0][2] * sx
        let cy = camera.matrix[1][2] * sy
        let dist = camera.distCoeffs

        return points.compactMap { p in
            let xCam = rotation[0][0] * p[0] + rotation[0][1] * p[1] + rotation[0][2] * p[2] + camera.tvec[0]
            let yCam = rotation[1][0] * p[0] + rotation[1][1] * p[1] + rotation[1][2] * p[2] + camera.tvec[1]
            let zCam = rotation[2][0] * p[0] + rotation[2][1] * p[1] + rotation[2][2] * p[2] + camera.tvec[2]
            guard zCam > 1e-6 else { return nil }

            var x = xCam / zCam
            var y = yCam / zCam
            if dist.count >= 4 {
                let k1 = dist[0]
                let k2 = dist[1]
                let p1 = dist[2]
                let p2 = dist[3]
                let k3 = dist.count >= 5 ? dist[4] : 0.0
                let r2 = x * x + y * y
                let radial = 1.0 + k1 * r2 + k2 * r2 * r2 + k3 * r2 * r2 * r2
                let xDist = x * radial + 2.0 * p1 * x * y + p2 * (r2 + 2.0 * x * x)
                let yDist = y * radial + p1 * (r2 + 2.0 * y * y) + 2.0 * p2 * x * y
                x = xDist
                y = yDist
            }

            return CGPoint(x: CGFloat(fx * x + cx), y: CGFloat(fy * y + cy))
        }
    }

    private func drawPlane(ctx: CGContext, points: [CGPoint], shadowOffset: CGPoint, alpha: Double, showLabel: Bool) {
        guard points.count == 4 else { return }
        let a = CGFloat(clamp(alpha, min: 0.0, max: 1.0))

        ctx.saveGState()
        defer { ctx.restoreGState() }

        drawFloatingShadow(ctx, points: points, offset: shadowOffset, alpha: 0.22 * a)
        drawPlaneGlow(ctx, points: points, alpha: a)
        drawFaceFill(ctx, points: points, color: glowColor, alpha: 0.045 * a)
        drawFaceFill(ctx, points: points, color: planeColor, alpha: 0.045 * a)
        drawPlaneGuideLines(ctx, points: points, alpha: a)
        drawPolygon(ctx, points: points, color: planeColor, width: 4.5, alpha: 0.94 * a)
        drawCornerBrackets(ctx, front: points, alpha: a)

        if showLabel {
            drawLabel(ctx, front: points, alpha: a)
        }
    }

    private func drawFloatingShadow(_ ctx: CGContext, points: [CGPoint], offset: CGPoint, alpha: CGFloat) {
        let shadow = points.map { CGPoint(x: $0.x + offset.x, y: $0.y + offset.y) }
        drawFaceFill(ctx, points: shadow, color: UIColor.black, alpha: alpha)
        drawPolygon(ctx, points: shadow, color: UIColor.black, width: 5.0, alpha: alpha * 0.55)
    }

    private func drawPlaneGlow(_ ctx: CGContext, points: [CGPoint], alpha: CGFloat) {
        drawPolygon(ctx, points: points, color: glowColor, width: 10.0, alpha: 0.16 * alpha)
        drawPolygon(ctx, points: points, color: glowColor, width: 7.0, alpha: 0.20 * alpha)
        drawPolygon(ctx, points: points, color: planeColor, width: 6.0, alpha: 0.18 * alpha)
    }

    private func drawPlaneGuideLines(_ ctx: CGContext, points: [CGPoint], alpha: CGFloat) {
        // MLB broadcast K-zone style: the ABS-sized strike-zone plane is split
        // into a 3x3 grid (nine cells). Use edge interpolation so the grid
        // follows the calibrated quadrilateral instead of assuming a flat screen
        // rectangle.
        for t in [CGFloat(1.0 / 3.0), CGFloat(2.0 / 3.0)] {
            let top = interpolate(points[0], points[1], t)
            let bottom = interpolate(points[3], points[2], t)
            strokeLine(ctx, from: top, to: bottom, color: glowColor, width: 1.35, alpha: 0.34 * alpha)

            let left = interpolate(points[0], points[3], t)
            let right = interpolate(points[1], points[2], t)
            strokeLine(ctx, from: left, to: right, color: glowColor, width: 1.35, alpha: 0.34 * alpha)
        }
    }

    private func interpolate(_ a: CGPoint, _ b: CGPoint, _ t: CGFloat) -> CGPoint {
        CGPoint(
            x: a.x + (b.x - a.x) * t,
            y: a.y + (b.y - a.y) * t
        )
    }

    private func drawFaceFill(_ ctx: CGContext, points: [CGPoint], color: UIColor, alpha: CGFloat) {
        guard let first = points.first else { return }
        ctx.setFillColor(color.withAlphaComponent(alpha).cgColor)
        ctx.beginPath()
        ctx.move(to: first)
        for p in points.dropFirst() {
            ctx.addLine(to: p)
        }
        ctx.closePath()
        ctx.fillPath()
    }

    private func drawPolygon(_ ctx: CGContext, points: [CGPoint], color: UIColor, width: CGFloat, alpha: CGFloat) {
        guard let first = points.first else { return }
        ctx.setStrokeColor(color.withAlphaComponent(alpha).cgColor)
        ctx.setLineWidth(width)
        ctx.setLineJoin(.round)
        ctx.setLineCap(.round)
        ctx.beginPath()
        ctx.move(to: first)
        for p in points.dropFirst() {
            ctx.addLine(to: p)
        }
        ctx.closePath()
        ctx.strokePath()
    }

    private func strokeLine(_ ctx: CGContext, from: CGPoint, to: CGPoint, color: UIColor, width: CGFloat, alpha: CGFloat) {
        ctx.setStrokeColor(color.withAlphaComponent(alpha).cgColor)
        ctx.setLineWidth(width)
        ctx.setLineCap(.round)
        ctx.beginPath()
        ctx.move(to: from)
        ctx.addLine(to: to)
        ctx.strokePath()
    }

    private func drawCornerBrackets(_ ctx: CGContext, front: [CGPoint], alpha: CGFloat) {
        let minX = front.map(\.x).min() ?? 0
        let maxX = front.map(\.x).max() ?? 0
        let minY = front.map(\.y).min() ?? 0
        let maxY = front.map(\.y).max() ?? 0
        let len = min(maxX - minX, maxY - minY) * 0.16
        let corners: [(CGPoint, CGFloat, CGFloat)] = [
            (CGPoint(x: minX, y: minY), 1, 1),
            (CGPoint(x: maxX, y: minY), -1, 1),
            (CGPoint(x: maxX, y: maxY), -1, -1),
            (CGPoint(x: minX, y: maxY), 1, -1),
        ]
        ctx.setStrokeColor(UIColor.white.withAlphaComponent(0.85 * alpha).cgColor)
        ctx.setLineWidth(3.0)
        ctx.setLineCap(.round)
        ctx.beginPath()
        for (corner, sx, sy) in corners {
            ctx.move(to: corner)
            ctx.addLine(to: CGPoint(x: corner.x + len * sx, y: corner.y))
            ctx.move(to: corner)
            ctx.addLine(to: CGPoint(x: corner.x, y: corner.y + len * sy))
        }
        ctx.strokePath()
    }

    private func drawLabel(_ ctx: CGContext, front: [CGPoint], alpha: CGFloat) {
        guard alpha > 0.01 else { return }
        let x = front.map(\.x).min() ?? 0
        let y = max(12, (front.map(\.y).min() ?? 24) - 28)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: UIFont.boldSystemFont(ofSize: 16),
            .foregroundColor: planeColor.withAlphaComponent(alpha),
            .strokeColor: UIColor.black.withAlphaComponent(0.65 * alpha),
            .strokeWidth: -3.0,
        ]
        UIGraphicsPushContext(ctx)
        defer { UIGraphicsPopContext() }
        NSAttributedString(string: "ABS Strike Zone", attributes: attrs).draw(at: CGPoint(x: x, y: y))
    }

    private func build3DPlanePoints(_ zone: ABSStrikeZone3D) -> [[Double]] {
        let cx = zone.center[0]
        let cy = zone.center[1]
        let cz = zone.center[2]
        let hw = zone.width / 2.0
        let hh = zone.height / 2.0
        let left = cx - hw
        let right = cx + hw
        let top = cy + hh
        let bottom = cy - hh
        return [
            [left, top, cz],
            [right, top, cz],
            [right, bottom, cz],
            [left, bottom, cz],
        ]
    }

    private func rodrigues(_ rvec: [Double]) -> [[Double]] {
        let theta = sqrt(rvec[0] * rvec[0] + rvec[1] * rvec[1] + rvec[2] * rvec[2])
        guard theta > 1e-12 else {
            return [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        }
        let x = rvec[0] / theta
        let y = rvec[1] / theta
        let z = rvec[2] / theta
        let c = cos(theta)
        let s = sin(theta)
        let v = 1.0 - c
        return [
            [x * x * v + c, x * y * v - z * s, x * z * v + y * s],
            [y * x * v + z * s, y * y * v + c, y * z * v - x * s],
            [z * x * v - y * s, z * y * v + x * s, z * z * v + c],
        ]
    }
}

private extension ABSStrikeZone2D {
    var looksNormalized: Bool {
        [left, right, top, bottom].allSatisfy { $0 >= 0.0 && $0 <= 1.0 }
    }
}

private func number(_ value: Any?) -> Double? {
    let result: Double?
    if let v = value as? Double {
        result = v
    } else if let v = value as? Float {
        result = Double(v)
    } else if let v = value as? Int {
        result = Double(v)
    } else if let v = value as? NSNumber {
        result = v.doubleValue
    } else {
        result = nil
    }
    guard let result, result.isFinite else { return nil }
    return result
}

private func numberArray(_ value: Any?, count: Int, name: String) throws -> [Double] {
    let values = try numberArray(value, allowedCounts: [count], name: name)
    return values
}

private func numberArray(_ value: Any?, allowedCounts: Set<Int>, name: String) throws -> [Double] {
    guard let raw = value as? [Any], allowedCounts.contains(raw.count) else {
        throw SpeedgunError.invalidConfiguration("\(name) must contain \(allowedCounts.sorted()) numeric values")
    }
    let values = raw.compactMap(number)
    guard values.count == raw.count else {
        throw SpeedgunError.invalidConfiguration("\(name) values must be numeric")
    }
    return values
}

private func matrix3x3(_ value: Any?, name: String) throws -> [[Double]] {
    guard let rows = value as? [Any], rows.count == 3 else {
        throw SpeedgunError.invalidConfiguration("\(name) must be a 3x3 matrix")
    }
    return try rows.map { row in
        try numberArray(row, count: 3, name: name)
    }
}
