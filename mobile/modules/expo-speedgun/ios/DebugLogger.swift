import Foundation

enum DebugLogger {
    static func log(
        runId: String = "analysis",
        hypothesisId: String,
        location: String,
        message: String,
        data: [String: Any] = [:]
    ) {
        // Intentionally no-op in the app runtime. Keep call sites cheap while
        // preserving a single hook for temporary diagnostics.
    }
}
