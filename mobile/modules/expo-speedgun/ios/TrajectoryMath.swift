import Foundation

struct QuadraticFit {
    let a: Double
    let b: Double
    let c: Double
    let rmse: Double
}

func evaluateQuadratic(_ fit: QuadraticFit, _ t: Double) -> Double {
    fit.a * t * t + fit.b * t + fit.c
}

func weightedQuadraticFit(ts: [Double], values: [Double], weights: [Double]) -> QuadraticFit? {
    guard ts.count == values.count,
          values.count == weights.count,
          ts.count >= 4,
          ts.allSatisfy(\.isFinite),
          values.allSatisfy(\.isFinite),
          weights.allSatisfy({ $0.isFinite && $0 >= 0 }) else { return nil }

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
    guard qa.isFinite, qb.isFinite, qc.isFinite, rmse.isFinite else { return nil }
    return QuadraticFit(a: qa, b: qb, c: qc, rmse: rmse)
}
