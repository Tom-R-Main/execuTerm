import AppKit
import Bonsplit
import Foundation

/// Manages the execuTerm daemon process lifecycle — auto-start, health polling, and clean shutdown.
/// Modeled on `VSCodeServeWebController` but simpler: no generation tracking or pending-completion queues.
final class ExecuTermDaemonController {
    static let shared = ExecuTermDaemonController()

    private enum BrowserDestinationKind: String {
        case dashboard
        case verification
    }

    private struct BrowserDestination: Equatable {
        let kind: BrowserDestinationKind
        let urlString: String

        var url: URL? {
            URL(string: urlString)
        }
    }

    private struct DaemonStatusPayload: Decodable {
        let auth: DaemonAuthPayload?
    }

    private struct DaemonAuthPayload: Decodable {
        let status: String
        let verificationUri: String?
        let verificationUriComplete: String?
    }

    private let queue = DispatchQueue(label: "com.execufunction.executerm.daemon")
    private var process: Process?
    private var dashboardPort: Int?
    private var isStarting = false
    private var healthPollTimer: DispatchSourceTimer?
    private var authStatusPollTimer: DispatchSourceTimer?
    private var logFileHandle: FileHandle?
    private var dashboardOpenWorkItem: DispatchWorkItem?
    private var browserSurfaceId: UUID?
    private var browserWorkspaceId: UUID?
    private var currentBrowserDestination: BrowserDestination?
    private var isPollingAuthStatus = false
    private var lastKnownAuthStatus: String?
    private var launchTime: Date?
    private var hasAutoRestarted = false

    private static let healthPollInterval: TimeInterval = 0.5
    private static let healthTimeout: TimeInterval = 30
    private static let dashboardOpenRetryDelay: TimeInterval = 0.5
    private static let maxDashboardOpenAttempts = 10
    private static let authStatusPollInterval: TimeInterval = 1.0

    private init() {}

    private func trace(_ message: String) {
        NSLog("[ExecuTermDaemon] \(message)")
#if DEBUG
        dlog("executerm.daemon \(message)")
#endif
    }

    // MARK: - Public

    /// The dashboard URL if the daemon is running and healthy.
    var dashboardURL: URL? {
        queue.sync {
            guard let port = dashboardPort else { return nil }
            return Self.dashboardURL(for: port)
        }
    }

    private static func dashboardURL(for port: Int) -> URL? {
        URL(string: "http://127.0.0.1:\(port)/dashboard")
    }

    private func exfConfigDirectory() -> String {
        if let configured = ProcessInfo.processInfo.environment["EXF_CONFIG_DIR"], !configured.isEmpty {
            return configured
        }

        if let xdgConfigHome = ProcessInfo.processInfo.environment["XDG_CONFIG_HOME"], !xdgConfigHome.isEmpty {
            return (xdgConfigHome as NSString).appendingPathComponent("exf")
        }

        return NSString("~/.config/exf").expandingTildeInPath
    }

    /// Launch the daemon process and begin health polling.
    func start() {
        queue.async { [self] in
            guard !isStarting, process == nil else { return }
            isStarting = true

            guard let resolved = resolveDaemonPath() else {
                trace("Daemon binary not found — skipping daemon start")
                isStarting = false
                return
            }

            let proc = Process()
            proc.executableURL = resolved.executable
            proc.arguments = resolved.arguments
            proc.environment = daemonEnvironment()

            // Pipe stdout/stderr to log file
            let logHandle = openLogFile()
            self.logFileHandle = logHandle

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            proc.standardOutput = stdoutPipe
            proc.standardError = stderrPipe

            let outputHandler: (FileHandle) -> Void = { fileHandle in
                let data = fileHandle.availableData
                guard !data.isEmpty else { return }
                logHandle?.write(data)
            }
            stdoutPipe.fileHandleForReading.readabilityHandler = outputHandler
            stderrPipe.fileHandleForReading.readabilityHandler = outputHandler

            proc.terminationHandler = { [weak self] terminatedProcess in
                stdoutPipe.fileHandleForReading.readabilityHandler = nil
                stderrPipe.fileHandleForReading.readabilityHandler = nil
                self?.queue.async {
                    guard let self else { return }
                    let shouldAutoRestart = terminatedProcess.terminationStatus != 0
                        && !self.hasAutoRestarted
                        && self.process === terminatedProcess
                        && self.launchTime.map({ Date().timeIntervalSince($0) < 30 }) ?? false
                    if self.process === terminatedProcess {
                        self.process = nil
                        self.dashboardPort = nil
                    }
                    self.isStarting = false
                    self.cancelHealthPoll()
                    self.cancelAuthStatusPoll()
                    self.browserSurfaceId = nil
                    self.browserWorkspaceId = nil
                    self.currentBrowserDestination = nil
                    self.isPollingAuthStatus = false
                    self.lastKnownAuthStatus = nil
                    DispatchQueue.main.async {
                        self.cancelDashboardOpenRetry()
                    }
                    self.logFileHandle?.closeFile()
                    self.logFileHandle = nil
                    self.trace("Daemon process terminated status=\(terminatedProcess.terminationStatus)")
                    if shouldAutoRestart {
                        self.hasAutoRestarted = true
                        self.trace("Auto-restarting daemon after early exit (status=\(terminatedProcess.terminationStatus))")
                        self.queue.asyncAfter(deadline: .now() + 2.0) { [weak self] in
                            self?.start()
                        }
                    }
                }
            }

            do {
                try proc.run()
                self.process = proc
                self.launchTime = Date()
                self.trace("Daemon launched pid=\(proc.processIdentifier)")
                startHealthPoll()
            } catch {
                self.trace("Failed to launch daemon: \(error)")
                self.isStarting = false
                logHandle?.closeFile()
                self.logFileHandle = nil
            }
        }
    }

    /// Stop the daemon process gracefully. Sends SIGTERM, escalates to SIGINT after 2s.
    func stop() {
        let (proc, logHandle): (Process?, FileHandle?) = queue.sync {
            cancelHealthPoll()
            cancelAuthStatusPoll()
            let p = self.process
            let lh = self.logFileHandle
            self.process = nil
            self.dashboardPort = nil
            self.isStarting = false
            self.logFileHandle = nil
            self.browserSurfaceId = nil
            self.browserWorkspaceId = nil
            self.currentBrowserDestination = nil
            self.isPollingAuthStatus = false
            self.lastKnownAuthStatus = nil
            return (p, lh)
        }

        DispatchQueue.main.async {
            self.cancelDashboardOpenRetry()
        }

        guard let proc, proc.isRunning else {
            logHandle?.closeFile()
            return
        }

        proc.terminate()
        trace("Sent SIGTERM to daemon pid=\(proc.processIdentifier)")

        // Escalate to SIGINT after 2 seconds if still running
        DispatchQueue.global().asyncAfter(deadline: .now() + 2.0) {
            if proc.isRunning {
                proc.interrupt()
                self.trace("Escalated to SIGINT for daemon pid=\(proc.processIdentifier)")
            }
            logHandle?.closeFile()
        }
    }

    // MARK: - Path Resolution

    private func resolveDaemonPath() -> (executable: URL, arguments: [String])? {
        // Release: bundled binary
        let bundledBinDir = Bundle.main.bundleURL
            .appendingPathComponent("Contents/Resources/bin", isDirectory: true)
        let bundledLauncher = bundledBinDir
            .appendingPathComponent("exf-terminal-daemon", isDirectory: false)
#if arch(arm64)
        let preferredBundledDaemon = bundledBinDir
            .appendingPathComponent("exf-terminal-daemon-arm64", isDirectory: false)
#elseif arch(x86_64)
        let preferredBundledDaemon = bundledBinDir
            .appendingPathComponent("exf-terminal-daemon-x64", isDirectory: false)
#else
        let preferredBundledDaemon = bundledLauncher
#endif

        if FileManager.default.isExecutableFile(atPath: preferredBundledDaemon.path) {
            return (executable: preferredBundledDaemon, arguments: [])
        }

        if FileManager.default.isExecutableFile(atPath: bundledLauncher.path) {
            return (executable: bundledLauncher, arguments: [])
        }

        // Dev: use tsx from the repo
        guard let repoRoot = ProcessInfo.processInfo.environment["EXECUTERM_REPO_ROOT"]
            ?? ProcessInfo.processInfo.environment["CMUXTERM_REPO_ROOT"] else {
            return nil
        }
        let tsxPath = URL(fileURLWithPath: repoRoot)
            .appendingPathComponent("daemon/node_modules/.bin/tsx", isDirectory: false)
        let entryPoint = URL(fileURLWithPath: repoRoot)
            .appendingPathComponent("daemon/src/index.ts", isDirectory: false)

        guard FileManager.default.isExecutableFile(atPath: tsxPath.path),
              FileManager.default.fileExists(atPath: entryPoint.path) else {
            return nil
        }

        return (executable: tsxPath, arguments: [entryPoint.path])
    }

    // MARK: - Environment

    private func daemonEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let socketPath = SocketControlSettings.socketPath()
        env["EXECUTERM_SOCKET_PATH"] = socketPath
        env["CMUX_SOCKET_PATH"] = socketPath  // backwards compat
        env["EXECUTERM_LAUNCHED_BY_APP"] = "1"
        // Ensure PATH is inherited for node/tsx discovery in dev
        return env
    }

    // MARK: - Health Polling

    private func startHealthPoll() {
        cancelHealthPoll()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        let startTime = Date()
        timer.schedule(
            deadline: .now() + Self.healthPollInterval,
            repeating: Self.healthPollInterval
        )
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            if Date().timeIntervalSince(startTime) > Self.healthTimeout {
                self.trace("Health poll timed out after \(Self.healthTimeout)s")
                self.cancelHealthPoll()
                self.isStarting = false
                return
            }
            self.checkHealth()
        }
        healthPollTimer = timer
        timer.resume()
    }

    private func cancelHealthPoll() {
        healthPollTimer?.cancel()
        healthPollTimer = nil
    }

    private func startAuthStatusPoll(port: Int) {
        cancelAuthStatusPoll()
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(
            deadline: .now() + Self.authStatusPollInterval,
            repeating: Self.authStatusPollInterval
        )
        timer.setEventHandler { [weak self] in
            self?.pollAuthStatus(port: port)
        }
        authStatusPollTimer = timer
        timer.resume()
    }

    private func cancelAuthStatusPoll() {
        authStatusPollTimer?.cancel()
        authStatusPollTimer = nil
    }

    private func checkHealth() {
        // Read port from daemon state file
        guard let port = readDaemonPort() else { return }

        let url = URL(string: "http://127.0.0.1:\(port)/health")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 2

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self,
                  error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200 else {
                return
            }
            self.queue.async {
                self.onDaemonReady(port: port)
            }
        }.resume()
    }

    private func pollAuthStatus(port: Int) {
        guard !isPollingAuthStatus else { return }
        isPollingAuthStatus = true

        let url = URL(string: "http://127.0.0.1:\(port)/api/status")!
        var request = URLRequest(url: url)
        request.timeoutInterval = 2

        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            guard let self else { return }
            defer {
                self.queue.async {
                    self.isPollingAuthStatus = false
                }
            }

            guard error == nil,
                  let httpResponse = response as? HTTPURLResponse,
                  httpResponse.statusCode == 200,
                  let data,
                  let payload = try? JSONDecoder().decode(DaemonStatusPayload.self, from: data) else {
                return
            }

            self.queue.async {
                self.handleAuthStatus(payload.auth, port: port)
            }
        }.resume()
    }

    private func readDaemonPort() -> Int? {
        let stateFilePath = (exfConfigDirectory() as NSString).appendingPathComponent("terminal-state.json")
        guard let data = FileManager.default.contents(atPath: stateFilePath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let port = json["hookServerPort"] as? Int,
              port > 0 else {
            return nil
        }
        return port
    }

    // MARK: - Dashboard

    private func onDaemonReady(port: Int) {
        guard isStarting else { return }
        dashboardPort = port
        isStarting = false
        cancelHealthPoll()
        trace("Daemon ready on port \(port)")

        startAuthStatusPoll(port: port)
        pollAuthStatus(port: port)
    }

    private func handleAuthStatus(_ auth: DaemonAuthPayload?, port: Int) {
        guard let auth else {
            lastKnownAuthStatus = nil
            maybeOpenDashboardFallback(port: port)
            return
        }

        lastKnownAuthStatus = auth.status

        if auth.status == "device_flow",
           let rawURL = auth.verificationUriComplete ?? auth.verificationUri,
           let verificationURL = URL(string: rawURL) {
            showBrowserDestination(
                BrowserDestination(kind: .verification, urlString: verificationURL.absoluteString)
            )
            return
        }

        if auth.status == "authenticated",
           let dashboardURL = Self.dashboardURL(for: port) {
            showBrowserDestination(
                BrowserDestination(kind: .dashboard, urlString: dashboardURL.absoluteString)
            )
            return
        }

        maybeOpenDashboardFallback(port: port)
    }

    private func maybeOpenDashboardFallback(port: Int) {
        guard currentBrowserDestination == nil,
              let dashboardURL = Self.dashboardURL(for: port) else {
            return
        }
        showBrowserDestination(
            BrowserDestination(kind: .dashboard, urlString: dashboardURL.absoluteString)
        )
    }

    private func showBrowserDestination(_ destination: BrowserDestination) {
        guard currentBrowserDestination != destination else { return }
        guard destination.url != nil else { return }

        DispatchQueue.main.async {
            self.cancelDashboardOpenRetry()
            self.attemptBrowserOpen(destination: destination, attempt: 1)
        }
    }

    @MainActor
    private func attemptBrowserOpen(destination: BrowserDestination, attempt: Int) {
        guard let targetURL = destination.url else { return }

        guard let appDelegate = AppDelegate.shared else {
            scheduleDashboardOpenRetry(destination: destination, nextAttempt: attempt + 1)
            return
        }

        guard let tabManager = appDelegate.tabManager else {
            scheduleDashboardOpenRetry(destination: destination, nextAttempt: attempt + 1)
            return
        }

        let tabCount = tabManager.tabs.count
        let selectedTabId = tabManager.selectedTabId
        let windowCount = NSApp.windows.count

        guard tabCount > 0 else {
            scheduleDashboardOpenRetry(destination: destination, nextAttempt: attempt + 1)
            return
        }

        guard selectedTabId != nil else {
            scheduleDashboardOpenRetry(destination: destination, nextAttempt: attempt + 1)
            return
        }

        guard windowCount > 0 else {
            scheduleDashboardOpenRetry(destination: destination, nextAttempt: attempt + 1)
            return
        }

        if let browserSurfaceId,
           let browserWorkspaceId,
           let workspace = tabManager.tabs.first(where: { $0.id == browserWorkspaceId }),
           let browserPanel = workspace.browserPanel(for: browserSurfaceId) {
            if tabManager.selectedTabId != browserWorkspaceId {
                tabManager.selectedTabId = browserWorkspaceId
            }
            workspace.focusPanel(browserSurfaceId)
            browserPanel.navigate(to: targetURL)
            currentBrowserDestination = destination
            trace("Browser navigated kind=\(destination.kind.rawValue) url=\(targetURL.absoluteString)")
            if destination.kind == .dashboard,
               lastKnownAuthStatus == "authenticated" {
                cancelAuthStatusPoll()
            }
            return
        }

        let openedSurfaceId = appDelegate.openBrowserAndFocusAddressBar(url: targetURL, insertAtEnd: true)

        if openedSurfaceId == nil {
            scheduleDashboardOpenRetry(destination: destination, nextAttempt: attempt + 1)
        } else {
            browserSurfaceId = openedSurfaceId
            browserWorkspaceId = tabManager.selectedTabId
            currentBrowserDestination = destination
            trace("Browser opened kind=\(destination.kind.rawValue) url=\(targetURL.absoluteString)")

            // Give the dashboard workspace a recognizable sidebar label
            if destination.kind == .dashboard,
               let wsId = browserWorkspaceId,
               let workspace = tabManager.tabs.first(where: { $0.id == wsId }) {
                workspace.setCustomTitle("execuTerm")
            }

            if destination.kind == .dashboard,
               lastKnownAuthStatus == "authenticated" {
                cancelAuthStatusPoll()
            }
            cancelDashboardOpenRetry()
        }
    }

    @MainActor
    private func scheduleDashboardOpenRetry(destination: BrowserDestination, nextAttempt: Int) {
        guard nextAttempt <= Self.maxDashboardOpenAttempts else {
            trace("Browser auto-open gave up kind=\(destination.kind.rawValue) after \(Self.maxDashboardOpenAttempts) attempts")
            cancelDashboardOpenRetry()
            return
        }

        cancelDashboardOpenRetry()

        let workItem = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.attemptBrowserOpen(destination: destination, attempt: nextAttempt)
        }
        dashboardOpenWorkItem = workItem

        DispatchQueue.main.asyncAfter(deadline: .now() + Self.dashboardOpenRetryDelay, execute: workItem)
    }

    @MainActor
    private func cancelDashboardOpenRetry() {
        dashboardOpenWorkItem?.cancel()
        dashboardOpenWorkItem = nil
    }

    // MARK: - Logging

    private func openLogFile() -> FileHandle? {
        let logDir = exfConfigDirectory()
        let logPath = (logDir as NSString).appendingPathComponent("daemon.log")

        do {
            try FileManager.default.createDirectory(
                atPath: logDir,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            NSLog("[ExecuTermDaemon] Failed to create log directory: \(error)")
            return nil
        }

        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil,
                                           attributes: [.posixPermissions: 0o600])
        }

        guard let handle = FileHandle(forWritingAtPath: logPath) else {
            NSLog("[ExecuTermDaemon] Failed to open log file at \(logPath)")
            return nil
        }
        handle.seekToEndOfFile()
        return handle
    }
}
