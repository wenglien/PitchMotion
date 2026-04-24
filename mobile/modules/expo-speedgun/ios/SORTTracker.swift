import Foundation

// MARK: - Kalman Box Tracker (port from sort.py KalmanBoxTracker)

/// 7-state Kalman filter: [cx, cy, area, aspectRatio, vx, vy, vArea]
final class KalmanBoxTracker {
    static var count = 0

    let id: Int
    var timeSinceUpdate = 0
    var hits = 0
    var hitStreak = 0
    var age = 0

    // State: [cx, cy, s, r, vx, vy, vs] (7x1)
    private var x: [Double]
    // Covariance: 7x7
    private var P: [[Double]]

    // Fixed matrices
    private let F: [[Double]] // 7x7 state transition
    private let H: [[Double]] // 4x7 measurement
    private let R: [[Double]] // 4x4 measurement noise
    private let Q: [[Double]] // 7x7 process noise

    init(bbox: (Double, Double, Double, Double, Double)) {
        // bbox: (x1, y1, x2, y2, score)
        let (x1, y1, x2, y2, _) = bbox
        let w = x2 - x1
        let h = y2 - y1
        let cx = x1 + w / 2
        let cy = y1 + h / 2
        let s = w * h
        let r = w / max(h, 1e-6)

        self.id = KalmanBoxTracker.count
        KalmanBoxTracker.count += 1

        // Initialize state
        x = [cx, cy, s, r, 0, 0, 0]

        // State transition: constant velocity
        F = [
            [1, 0, 0, 0, 1, 0, 0],
            [0, 1, 0, 0, 0, 1, 0],
            [0, 0, 1, 0, 0, 0, 1],
            [0, 0, 0, 1, 0, 0, 0],
            [0, 0, 0, 0, 1, 0, 0],
            [0, 0, 0, 0, 0, 1, 0],
            [0, 0, 0, 0, 0, 0, 1],
        ]

        // Measurement matrix: observe [cx, cy, s, r]
        H = [
            [1, 0, 0, 0, 0, 0, 0],
            [0, 1, 0, 0, 0, 0, 0],
            [0, 0, 1, 0, 0, 0, 0],
            [0, 0, 0, 1, 0, 0, 0],
        ]

        // Measurement noise
        var r_mat = Self.identity(4)
        r_mat[2][2] = 10.0
        r_mat[3][3] = 10.0
        R = r_mat

        // Process noise
        var q = Self.identity(7)
        q[6][6] = 0.01
        for i in 4..<7 { q[i][i] = 0.01 }
        Q = q

        // Initial covariance
        var p = Self.identity(7)
        for i in 0..<7 { p[i][i] *= 10.0 }
        for i in 4..<7 { p[i][i] *= 100.0 }
        P = p
    }

    func predict() -> (Double, Double, Double, Double) {
        // x = F * x
        if x[6] + x[2] <= 0 { x[6] = 0 }
        let newX = Self.matVecMul(F, x)
        x = newX

        // P = F * P * F^T + Q
        let FP = Self.matMul(F, P)
        let FT = Self.transpose(F)
        let FPFt = Self.matMul(FP, FT)
        P = Self.matAdd(FPFt, Q)

        age += 1
        if timeSinceUpdate > 0 { hitStreak = 0 }
        timeSinceUpdate += 1

        return getState()
    }

    func update(bbox: (Double, Double, Double, Double, Double)) {
        let (x1, y1, x2, y2, _) = bbox
        let w = x2 - x1
        let h = y2 - y1
        let z = [x1 + w/2, y1 + h/2, w * h, w / max(h, 1e-6)]

        timeSinceUpdate = 0
        hits += 1
        hitStreak += 1

        // Kalman update
        // y = z - H * x
        let Hx = Self.matVecMul(H, x)
        let y = zip(z, Hx).map { $0.0 - $0.1 }

        // S = H * P * H^T + R
        let HP = Self.matMul(H, P)
        let HT = Self.transpose(H)
        let HPHt = Self.matMul(HP, HT)
        let S = Self.matAdd(HPHt, R)

        // K = P * H^T * S^-1
        let PHt = Self.matMul(P, HT)
        guard let SInv = Self.invert4x4(S) else { return }
        let K = Self.matMul(PHt, SInv)

        // x = x + K * y
        let Ky = Self.matVecMul(K, y)
        x = zip(x, Ky).map { $0.0 + $0.1 }

        // P = (I - K*H) * P
        let KH = Self.matMul(K, H)
        let I = Self.identity(7)
        let IKH = Self.matSub(I, KH)
        P = Self.matMul(IKH, P)
    }

    func getState() -> (Double, Double, Double, Double) {
        // Convert [cx, cy, s, r] back to [x1, y1, x2, y2]
        let s = max(x[2], 1e-6)
        let r = max(x[3], 1e-6)
        let w = sqrt(s * r)
        let h = s / w
        return (x[0] - w/2, x[1] - h/2, x[0] + w/2, x[1] + h/2)
    }

    var center: (Double, Double) { (x[0], x[1]) }
    var area: Double { max(x[2], 0) }

    // MARK: - Matrix helpers (small matrices, no Accelerate needed)

    private static func identity(_ n: Int) -> [[Double]] {
        var m = Array(repeating: Array(repeating: 0.0, count: n), count: n)
        for i in 0..<n { m[i][i] = 1.0 }
        return m
    }

    private static func matVecMul(_ A: [[Double]], _ v: [Double]) -> [Double] {
        A.map { row in zip(row, v).reduce(0) { $0 + $1.0 * $1.1 } }
    }

    private static func matMul(_ A: [[Double]], _ B: [[Double]]) -> [[Double]] {
        let m = A.count, n = B[0].count, k = B.count
        var C = Array(repeating: Array(repeating: 0.0, count: n), count: m)
        for i in 0..<m {
            for j in 0..<n {
                for p in 0..<k {
                    C[i][j] += A[i][p] * B[p][j]
                }
            }
        }
        return C
    }

    private static func transpose(_ A: [[Double]]) -> [[Double]] {
        guard !A.isEmpty else { return A }
        let m = A.count, n = A[0].count
        var T = Array(repeating: Array(repeating: 0.0, count: m), count: n)
        for i in 0..<m { for j in 0..<n { T[j][i] = A[i][j] } }
        return T
    }

    private static func matAdd(_ A: [[Double]], _ B: [[Double]]) -> [[Double]] {
        zip(A, B).map { zip($0.0, $0.1).map { $0.0 + $0.1 } }
    }

    private static func matSub(_ A: [[Double]], _ B: [[Double]]) -> [[Double]] {
        zip(A, B).map { zip($0.0, $0.1).map { $0.0 - $0.1 } }
    }

    private static func invert4x4(_ m: [[Double]]) -> [[Double]]? {
        // Gauss-Jordan elimination for 4x4
        var A = m
        var I = identity(4)
        for col in 0..<4 {
            var pivot = col
            for row in (col+1)..<4 {
                if abs(A[row][col]) > abs(A[pivot][col]) { pivot = row }
            }
            if abs(A[pivot][col]) < 1e-12 { return nil }
            if pivot != col {
                A.swapAt(col, pivot)
                I.swapAt(col, pivot)
            }
            let scale = A[col][col]
            for j in 0..<4 { A[col][j] /= scale; I[col][j] /= scale }
            for row in 0..<4 where row != col {
                let factor = A[row][col]
                for j in 0..<4 {
                    A[row][j] -= factor * A[col][j]
                    I[row][j] -= factor * I[col][j]
                }
            }
        }
        return I
    }
}

// MARK: - IOU computation

func iouBatch(dets: [(Double, Double, Double, Double, Double)],
              trks: [(Double, Double, Double, Double)]) -> [[Double]] {
    // dets: [x1,y1,x2,y2,score], trks: [x1,y1,x2,y2]
    let nd = dets.count, nt = trks.count
    guard nd > 0 && nt > 0 else { return [] }

    var result = Array(repeating: Array(repeating: 0.0, count: nt), count: nd)
    for i in 0..<nd {
        for j in 0..<nt {
            let (dx1, dy1, dx2, dy2, _) = dets[i]
            let (tx1, ty1, tx2, ty2) = trks[j]
            let xx1 = max(dx1, tx1)
            let yy1 = max(dy1, ty1)
            let xx2 = min(dx2, tx2)
            let yy2 = min(dy2, ty2)
            let w = max(0, xx2 - xx1)
            let h = max(0, yy2 - yy1)
            let inter = w * h
            let areaD = (dx2 - dx1) * (dy2 - dy1)
            let areaT = (tx2 - tx1) * (ty2 - ty1)
            let union = areaD + areaT - inter
            result[i][j] = union > 0 ? inter / union : 0
        }
    }
    return result
}

// MARK: - Hungarian Assignment (simple O(n³) for small matrices)

func hungarianAssignment(costMatrix: [[Double]]) -> [(Int, Int)] {
    let n = costMatrix.count
    guard n > 0 else { return [] }
    let m = costMatrix[0].count
    guard m > 0 else { return [] }

    // For very small matrices (typical: 1-5), brute force greedy is fine
    // but let's implement a proper algorithm for correctness

    let size = max(n, m)
    // Pad to square
    var C = Array(repeating: Array(repeating: 0.0, count: size), count: size)
    for i in 0..<n { for j in 0..<m { C[i][j] = costMatrix[i][j] } }

    // Hungarian algorithm
    var u = Array(repeating: 0.0, count: size + 1)
    var v = Array(repeating: 0.0, count: size + 1)
    var p = Array(repeating: 0, count: size + 1)
    var way = Array(repeating: 0, count: size + 1)

    for i in 1...size {
        p[0] = i
        var j0 = 0
        var minv = Array(repeating: Double.infinity, count: size + 1)
        var used = Array(repeating: false, count: size + 1)

        repeat {
            used[j0] = true
            let i0 = p[j0]
            var delta = Double.infinity
            var j1 = 0

            for j in 1...size {
                if !used[j] {
                    let cur = C[i0-1][j-1] - u[i0] - v[j]
                    if cur < minv[j] {
                        minv[j] = cur
                        way[j] = j0
                    }
                    if minv[j] < delta {
                        delta = minv[j]
                        j1 = j
                    }
                }
            }

            for j in 0...size {
                if used[j] {
                    u[p[j]] += delta
                    v[j] -= delta
                } else {
                    minv[j] -= delta
                }
            }

            j0 = j1
        } while p[j0] != 0

        repeat {
            let j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
        } while j0 != 0
    }

    var result: [(Int, Int)] = []
    for j in 1...size {
        if p[j] > 0 && p[j] <= n && j <= m {
            result.append((p[j] - 1, j - 1))
        }
    }
    return result
}

// MARK: - SORT Tracker (port from sort.py Sort class)

final class SORTTracker {
    let maxAge: Int
    let minHits: Int
    let iouThreshold: Double
    private var trackers: [KalmanBoxTracker] = []
    private(set) var frameCount = 0

    init(maxAge: Int = 10, minHits: Int = 1, iouThreshold: Double = 0.1) {
        self.maxAge = maxAge
        self.minHits = minHits
        self.iouThreshold = iouThreshold
    }

    /// Process one frame's detections. Returns active tracks: [(x1,y1,x2,y2,trackId)]
    func update(detections: [(Double, Double, Double, Double, Double)]) -> [(Double, Double, Double, Double, Int)] {
        frameCount += 1

        // Predict locations of existing trackers
        var trks: [(Double, Double, Double, Double)] = []
        var toDelete: [Int] = []
        for (t, tracker) in trackers.enumerated() {
            let pos = tracker.predict()
            if pos.0.isNaN || pos.1.isNaN || pos.2.isNaN || pos.3.isNaN {
                toDelete.append(t)
            } else {
                trks.append(pos)
            }
        }
        for t in toDelete.reversed() {
            trackers.remove(at: t)
        }

        // Associate detections to trackers
        let (matched, unmatchedDets, _) = associateDetections(
            dets: detections,
            trks: trks,
            iouThreshold: iouThreshold
        )

        // Update matched trackers
        for (d, t) in matched {
            trackers[t].update(bbox: detections[d])
        }

        // Create new trackers for unmatched detections
        for d in unmatchedDets {
            let tracker = KalmanBoxTracker(bbox: detections[d])
            trackers.append(tracker)
        }

        // Collect active tracks
        var ret: [(Double, Double, Double, Double, Int)] = []
        var i = trackers.count
        for tracker in trackers.reversed() {
            i -= 1
            let d = tracker.getState()
            if tracker.timeSinceUpdate < 1 &&
               (tracker.hitStreak >= minHits || frameCount <= minHits) {
                ret.append((d.0, d.1, d.2, d.3, tracker.id + 1))
            }
            if tracker.timeSinceUpdate > maxAge {
                trackers.remove(at: i)
            }
        }

        return ret
    }

    /// Get all tracker histories for post-processing
    var allTrackers: [KalmanBoxTracker] { trackers }

    private func associateDetections(
        dets: [(Double, Double, Double, Double, Double)],
        trks: [(Double, Double, Double, Double)],
        iouThreshold: Double
    ) -> (matched: [(Int, Int)], unmatchedDets: [Int], unmatchedTrks: [Int]) {
        guard !trks.isEmpty else {
            return ([], Array(0..<dets.count), [])
        }
        guard !dets.isEmpty else {
            return ([], [], Array(0..<trks.count))
        }

        let nd = dets.count, nt = trks.count
        let iouMatrix = iouBatch(dets: dets, trks: trks)

        // Check if IOU-based matching is viable (any IOU > threshold)
        let maxIOU = iouMatrix.flatMap { $0 }.max() ?? 0
        var matchedIndices: [(Int, Int)]

        if maxIOU >= iouThreshold {
            // Normal IOU-based matching
            var simpleMatch = true
            for i in 0..<nd {
                var count = 0
                for j in 0..<nt { if iouMatrix[i][j] > iouThreshold { count += 1 } }
                if count > 1 { simpleMatch = false; break }
            }
            if simpleMatch {
                for j in 0..<nt {
                    var count = 0
                    for i in 0..<nd { if iouMatrix[i][j] > iouThreshold { count += 1 } }
                    if count > 1 { simpleMatch = false; break }
                }
            }

            if simpleMatch {
                matchedIndices = []
                for i in 0..<nd {
                    for j in 0..<nt {
                        if iouMatrix[i][j] > iouThreshold {
                            matchedIndices.append((i, j))
                        }
                    }
                }
            } else {
                let negIOU = iouMatrix.map { $0.map { -$0 } }
                matchedIndices = hungarianAssignment(costMatrix: negIOU)
            }

            var matchedDets = Set<Int>()
            var matchedTrks = Set<Int>()
            var matches: [(Int, Int)] = []
            for (d, t) in matchedIndices {
                if d < nd && t < nt && iouMatrix[d][t] >= iouThreshold {
                    matches.append((d, t))
                    matchedDets.insert(d)
                    matchedTrks.insert(t)
                }
            }
            let unmatchedDets = (0..<nd).filter { !matchedDets.contains($0) }
            let unmatchedTrks = (0..<nt).filter { !matchedTrks.contains($0) }
            return (matches, unmatchedDets, unmatchedTrks)

        } else {
            // IOU all zero (tiny ball, 4K/120fps). Fall back to centre-distance matching.
            // Max allowed distance: 2× the diagonal of the detection bbox, capped at 300px.
            var distMatrix = Array(repeating: Array(repeating: Double.infinity, count: nt), count: nd)
            for i in 0..<nd {
                let (dx1, dy1, dx2, dy2, _) = dets[i]
                let dcx = (dx1 + dx2) / 2, dcy = (dy1 + dy2) / 2
                let dDiag = sqrt((dx2-dx1)*(dx2-dx1) + (dy2-dy1)*(dy2-dy1))
                let maxDist = max(dDiag * 2.0, 50.0)   // at least 50px tolerance
                for j in 0..<nt {
                    let (tx1, ty1, tx2, ty2) = trks[j]
                    let tcx = (tx1 + tx2) / 2, tcy = (ty1 + ty2) / 2
                    let dist = sqrt((dcx-tcx)*(dcx-tcx) + (dcy-tcy)*(dcy-tcy))
                    distMatrix[i][j] = dist <= maxDist ? dist : Double.infinity
                }
            }

            // Greedy nearest-neighbour assignment (sufficient for 1–3 dets/trks)
            var matchedDets = Set<Int>()
            var matchedTrks = Set<Int>()
            var matches: [(Int, Int)] = []

            // Flatten & sort by distance
            var candidates: [(Double, Int, Int)] = []
            for i in 0..<nd {
                for j in 0..<nt {
                    if distMatrix[i][j] < Double.infinity {
                        candidates.append((distMatrix[i][j], i, j))
                    }
                }
            }
            candidates.sort { $0.0 < $1.0 }
            for (_, d, t) in candidates {
                if !matchedDets.contains(d) && !matchedTrks.contains(t) {
                    matches.append((d, t))
                    matchedDets.insert(d)
                    matchedTrks.insert(t)
                }
            }

            let unmatchedDets = (0..<nd).filter { !matchedDets.contains($0) }
            let unmatchedTrks = (0..<nt).filter { !matchedTrks.contains($0) }
            return (matches, unmatchedDets, unmatchedTrks)
        }
    }
}
