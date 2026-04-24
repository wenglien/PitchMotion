import Foundation

enum DebugLogger {
    private static let logPath = "/Users/wenglien/speedgun-mobile/.cursor/debug-cfe8be.log"
    private static let sandboxLogFilename = "debug-cfe8be.log"
    private static let sessionId = "cfe8be"
    private static let ingestURL = "http://127.0.0.1:7817/ingest/2f29f838-8dcb-4b7f-b65b-0aaee978ffe2"

    static func log(
        runId: String = "pre-fix",
        hypothesisId: String,
        location: String,
        message: String,
        data: [String: Any] = [:]
    ) {
        let payload: [String: Any] = [
            "sessionId": sessionId,
            "runId": runId,
            "hypothesisId": hypothesisId,
            "location": location,
            "message": message,
            "data": data,
            "timestamp": Int(Date().timeIntervalSince1970 * 1000),
        ]
        guard JSONSerialization.isValidJSONObject(payload),
              let jsonData = try? JSONSerialization.data(withJSONObject: payload) else {
            return
        }

        // #region agent log
        writeToFile(jsonData)
        postToIngest(jsonData)
        // #endregion
    }

    private static func writeToFile(_ jsonData: Data) {
        guard var line = String(data: jsonData, encoding: .utf8) else { return }
        line.append("\n")
        // Host workspace path (works only when file sandbox allows it)
        if let fp = fopen(logPath, "a") {
            fputs(line, fp)
            fclose(fp)
        }

        // Simulator/device sandbox tmp path (always available inside app)
        let sandboxPath = (NSTemporaryDirectory() as NSString).appendingPathComponent(sandboxLogFilename)
        if let fp = fopen(sandboxPath, "a") {
            fputs(line, fp)
            fclose(fp)
        }
    }

    private static func postToIngest(_ jsonData: Data) {
        guard let url = URL(string: ingestURL) else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue(sessionId, forHTTPHeaderField: "X-Debug-Session-Id")
        req.httpBody = jsonData
        URLSession.shared.dataTask(with: req) { _, _, _ in }.resume()
    }
}
