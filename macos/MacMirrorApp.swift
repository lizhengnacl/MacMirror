import AppKit
import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins

@main
enum MacMirrorMain {
  static func main() {
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
  }
}

private final class AppDelegate: NSObject, NSApplicationDelegate {
  private var window: NSWindow!
  private var statusLabel: NSTextField!
  private var urlField: NSTextField!
  private var qrImageView: NSImageView!
  private var copyButton: NSButton!
  private var openButton: NSButton!
  private var restartButton: NSButton!
  private var progress: NSProgressIndicator!
  private var logView: NSTextView!
  private var serverProcess: Process?
  private var stdoutPipe: Pipe?
  private var stderrPipe: Pipe?
  private var stdoutBuffer = ""
  private var accessURL: URL?

  func applicationDidFinishLaunching(_ notification: Notification) {
    installMenu()
    installApplicationIcon()
    createWindow()
    requestScreenCapturePermissionIfNeeded()
    startServer()
    NSApp.activate(ignoringOtherApps: true)
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    true
  }

  func applicationWillTerminate(_ notification: Notification) {
    stopServer()
  }

  private func installMenu() {
    let mainMenu = NSMenu()
    let appMenuItem = NSMenuItem()
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Quit MacMirror", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appMenuItem.submenu = appMenu
    mainMenu.addItem(appMenuItem)
    NSApp.mainMenu = mainMenu
  }

  private func installApplicationIcon() {
    guard let iconURL = Bundle.main.url(forResource: "MacMirror", withExtension: "icns"),
          let icon = NSImage(contentsOf: iconURL) else {
      return
    }
    NSApp.applicationIconImage = icon
  }

  private func createWindow() {
    window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 500, height: 650),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered,
      defer: false
    )
    window.title = "MacMirror"
    window.minSize = NSSize(width: 420, height: 560)

    let content = NSView()
    content.wantsLayer = true
    content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
    window.contentView = content

    let stack = NSStackView()
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 16
    stack.translatesAutoresizingMaskIntoConstraints = false
    content.addSubview(stack)

    let titleLabel = label("MacMirror", size: 26, weight: .semibold)
    titleLabel.alignment = .center

    statusLabel = label("Starting local mirror service...", size: 14, weight: .regular)
    statusLabel.textColor = .secondaryLabelColor
    statusLabel.alignment = .center

    progress = NSProgressIndicator()
    progress.style = .spinning
    progress.controlSize = .regular
    progress.startAnimation(nil)

    let qrHolder = NSView()
    qrHolder.wantsLayer = true
    qrHolder.layer?.backgroundColor = NSColor.white.cgColor
    qrHolder.layer?.cornerRadius = 12
    qrHolder.translatesAutoresizingMaskIntoConstraints = false

    qrImageView = NSImageView()
    qrImageView.imageScaling = .scaleProportionallyUpOrDown
    qrImageView.translatesAutoresizingMaskIntoConstraints = false
    qrHolder.addSubview(qrImageView)

    urlField = NSTextField(labelWithString: "")
    urlField.alignment = .center
    urlField.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
    urlField.textColor = .secondaryLabelColor
    urlField.lineBreakMode = .byTruncatingMiddle
    urlField.isSelectable = true

    let buttonRow = NSStackView()
    buttonRow.orientation = .horizontal
    buttonRow.alignment = .centerY
    buttonRow.spacing = 10

    copyButton = button("Copy URL", action: #selector(copyURL))
    openButton = button("Open", action: #selector(openURL))
    restartButton = button("Restart", action: #selector(restartServer))
    copyButton.isEnabled = false
    openButton.isEnabled = false

    buttonRow.addArrangedSubview(copyButton)
    buttonRow.addArrangedSubview(openButton)
    buttonRow.addArrangedSubview(restartButton)

    let logTitle = label("Logs", size: 12, weight: .medium)
    logTitle.textColor = .secondaryLabelColor
    logTitle.alignment = .left

    logView = NSTextView()
    logView.isEditable = false
    logView.isSelectable = true
    logView.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
    logView.textColor = .secondaryLabelColor
    logView.backgroundColor = .clear
    logView.textContainerInset = NSSize(width: 10, height: 10)

    let scrollView = NSScrollView()
    scrollView.hasVerticalScroller = true
    scrollView.drawsBackground = true
    scrollView.backgroundColor = NSColor.textBackgroundColor.withAlphaComponent(0.35)
    scrollView.documentView = logView
    scrollView.translatesAutoresizingMaskIntoConstraints = false

    stack.addArrangedSubview(titleLabel)
    stack.addArrangedSubview(statusLabel)
    stack.addArrangedSubview(progress)
    stack.addArrangedSubview(qrHolder)
    stack.addArrangedSubview(urlField)
    stack.addArrangedSubview(buttonRow)
    stack.addArrangedSubview(logTitle)
    stack.addArrangedSubview(scrollView)

    NSLayoutConstraint.activate([
      stack.topAnchor.constraint(equalTo: content.topAnchor, constant: 24),
      stack.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -24),
      stack.bottomAnchor.constraint(equalTo: content.bottomAnchor, constant: -24),

      qrHolder.widthAnchor.constraint(equalToConstant: 320),
      qrHolder.heightAnchor.constraint(equalToConstant: 320),
      qrImageView.topAnchor.constraint(equalTo: qrHolder.topAnchor, constant: 18),
      qrImageView.leadingAnchor.constraint(equalTo: qrHolder.leadingAnchor, constant: 18),
      qrImageView.trailingAnchor.constraint(equalTo: qrHolder.trailingAnchor, constant: -18),
      qrImageView.bottomAnchor.constraint(equalTo: qrHolder.bottomAnchor, constant: -18),

      urlField.widthAnchor.constraint(equalTo: stack.widthAnchor),
      logTitle.widthAnchor.constraint(equalTo: stack.widthAnchor),
      scrollView.widthAnchor.constraint(equalTo: stack.widthAnchor),
      scrollView.heightAnchor.constraint(greaterThanOrEqualToConstant: 110)
    ])

    window.center()
    window.makeKeyAndOrderFront(nil)
  }

  private func label(_ text: String, size: CGFloat, weight: NSFont.Weight) -> NSTextField {
    let field = NSTextField(labelWithString: text)
    field.font = .systemFont(ofSize: size, weight: weight)
    field.lineBreakMode = .byWordWrapping
    field.maximumNumberOfLines = 0
    return field
  }

  private func button(_ title: String, action: Selector) -> NSButton {
    let button = NSButton(title: title, target: self, action: action)
    button.bezelStyle = .rounded
    return button
  }

  private func startServer() {
    resetReadyState()

    guard let runtimeURL = Bundle.main.resourceURL?.appendingPathComponent("App"),
          FileManager.default.fileExists(atPath: runtimeURL.appendingPathComponent("src/server.js").path) else {
      showError("Bundled MacMirror runtime is missing.")
      return
    }

    guard let nodePath = findNode() else {
      showError("Node.js was not found. Install Node.js 18 or newer, then reopen MacMirror.")
      return
    }

    do {
      let resourcesURL = Bundle.main.resourceURL!
      let supportURL = try applicationSupportURL()
      let process = Process()
      let stdout = Pipe()
      let stderr = Pipe()
      var environment = ProcessInfo.processInfo.environment

      environment["PATH"] = extendedPath(nodePath: nodePath, existing: environment["PATH"])
      environment["MACMIRROR_BUILD_DIR"] = supportURL.appendingPathComponent("bin", isDirectory: true).path
      environment["MACMIRROR_NO_TERMINAL_QR"] = "1"
      environment["MACMIRROR_PERMISSION_TARGET"] = "MacMirror.app"
      environment["MACMIRROR_REQUEST_SCREEN_CAPTURE_PERMISSION"] = "0"
      setHelperEnvironment(
        &environment,
        key: "MACMIRROR_CAPTURE_BINARY",
        url: resourcesURL.appendingPathComponent("bin/MacMirrorH264Capture")
      )
      setHelperEnvironment(
        &environment,
        key: "MACMIRROR_INPUT_BINARY",
        url: resourcesURL.appendingPathComponent("bin/MacMirrorInput")
      )

      process.executableURL = URL(fileURLWithPath: nodePath)
      process.arguments = [runtimeURL.appendingPathComponent("src/server.js").path, "--port", "0"]
      process.currentDirectoryURL = runtimeURL
      process.environment = environment
      process.standardOutput = stdout
      process.standardError = stderr
      process.terminationHandler = { [weak self] process in
        DispatchQueue.main.async {
          self?.handleServerExit(process)
        }
      }

      attach(stdout, isStdout: true)
      attach(stderr, isStdout: false)

      serverProcess = process
      stdoutPipe = stdout
      stderrPipe = stderr
      try process.run()
      appendLog("Started Node service with \(nodePath)\n")
    } catch {
      showError("Failed to start MacMirror: \(error.localizedDescription)")
    }
  }

  private func stopServer() {
    stdoutPipe?.fileHandleForReading.readabilityHandler = nil
    stderrPipe?.fileHandleForReading.readabilityHandler = nil

    if let process = serverProcess, process.isRunning {
      process.terminate()
    }

    serverProcess = nil
    stdoutPipe = nil
    stderrPipe = nil
  }

  private func resetReadyState() {
    accessURL = nil
    stdoutBuffer = ""
    urlField.stringValue = ""
    qrImageView.image = nil
    statusLabel.stringValue = "Starting local mirror service..."
    statusLabel.textColor = .secondaryLabelColor
    copyButton?.isEnabled = false
    openButton?.isEnabled = false
    progress?.isHidden = false
    progress?.startAnimation(nil)
  }

  private func requestScreenCapturePermissionIfNeeded() {
    if CGPreflightScreenCaptureAccess() {
      return
    }

    appendLog("Requesting Screen Recording permission for MacMirror.app...\n")
    _ = CGRequestScreenCaptureAccess()
  }

  private func attach(_ pipe: Pipe, isStdout: Bool) {
    pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      guard !data.isEmpty, let text = String(data: data, encoding: .utf8) else {
        return
      }

      DispatchQueue.main.async {
        self?.handleOutput(text, isStdout: isStdout)
      }
    }
  }

  private func handleOutput(_ text: String, isStdout: Bool) {
    appendLog(text)

    guard isStdout else {
      return
    }

    stdoutBuffer += text
    while let newlineRange = stdoutBuffer.range(of: "\n") {
      let line = String(stdoutBuffer[..<newlineRange.lowerBound]).trimmingCharacters(in: .whitespacesAndNewlines)
      stdoutBuffer.removeSubrange(...newlineRange.lowerBound)
      if line.hasPrefix("URL: ") {
        let value = String(line.dropFirst(5)).trimmingCharacters(in: .whitespacesAndNewlines)
        showReady(urlString: value)
      }
    }
  }

  private func showReady(urlString: String) {
    guard let url = URL(string: urlString) else {
      return
    }

    accessURL = url
    urlField.stringValue = urlString
    qrImageView.image = makeQRCodeImage(text: urlString)
    statusLabel.stringValue = "Scan with a phone on the same Wi-Fi network."
    statusLabel.textColor = .labelColor
    copyButton.isEnabled = true
    openButton.isEnabled = true
    progress.stopAnimation(nil)
    progress.isHidden = true
  }

  private func showError(_ message: String) {
    statusLabel.stringValue = message
    statusLabel.textColor = .systemRed
    progress?.stopAnimation(nil)
    progress?.isHidden = true
    appendLog("\(message)\n")
  }

  private func handleServerExit(_ process: Process) {
    guard serverProcess === process else {
      return
    }

    progress?.stopAnimation(nil)
    progress?.isHidden = true
    if accessURL == nil {
      statusLabel.stringValue = "MacMirror stopped before it produced a URL."
      statusLabel.textColor = .systemRed
    } else {
      statusLabel.stringValue = "MacMirror stopped. Restart to create a new QR code."
      statusLabel.textColor = .systemOrange
    }
    copyButton.isEnabled = accessURL != nil
    openButton.isEnabled = accessURL != nil
  }

  private func appendLog(_ text: String) {
    let clean = text.replacingOccurrences(of: "\u{001B}", with: "")
    let combined = logView.string + clean
    logView.string = combined.count > 12000 ? String(combined.suffix(12000)) : combined
    logView.scrollToEndOfDocument(nil)
  }

  private func makeQRCodeImage(text: String) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"

    let colorFilter = CIFilter.falseColor()
    colorFilter.inputImage = filter.outputImage
    colorFilter.color0 = CIColor.black
    colorFilter.color1 = CIColor.white

    guard let output = colorFilter.outputImage else {
      return nil
    }

    let scaled = output.transformed(by: CGAffineTransform(scaleX: 12, y: 12))
    let rep = NSCIImageRep(ciImage: scaled)
    let qr = NSImage(size: rep.size)
    qr.addRepresentation(rep)

    let image = NSImage(size: NSSize(width: 320, height: 320))
    image.lockFocus()
    NSColor.white.setFill()
    NSRect(origin: .zero, size: image.size).fill()
    qr.draw(in: NSRect(x: 24, y: 24, width: 272, height: 272))
    image.unlockFocus()
    return image
  }

  private func applicationSupportURL() throws -> URL {
    let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    let url = base.appendingPathComponent("MacMirror", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private func setHelperEnvironment(_ environment: inout [String: String], key: String, url: URL) {
    if FileManager.default.isExecutableFile(atPath: url.path) {
      environment[key] = url.path
    }
  }

  private func extendedPath(nodePath: String, existing: String?) -> String {
    let nodeDirectory = URL(fileURLWithPath: nodePath).deletingLastPathComponent().path
    let entries = [
      nodeDirectory,
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/opt/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
      existing ?? ""
    ]
    return entries.filter { !$0.isEmpty }.joined(separator: ":")
  }

  private func findNode() -> String? {
    let candidates = [
      "/opt/homebrew/bin/node",
      "/usr/local/bin/node",
      "/opt/local/bin/node",
      "/usr/bin/node"
    ]

    for candidate in candidates where FileManager.default.isExecutableFile(atPath: candidate) {
      return candidate
    }

    return shellOutput(["-lc", "command -v node"])
  }

  private func shellOutput(_ arguments: [String]) -> String? {
    let process = Process()
    let pipe = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/zsh")
    process.arguments = arguments
    process.standardOutput = pipe
    process.standardError = Pipe()

    do {
      try process.run()
      process.waitUntilExit()
      guard process.terminationStatus == 0 else {
        return nil
      }
      let data = pipe.fileHandleForReading.readDataToEndOfFile()
      let output = String(data: data, encoding: .utf8)?
        .trimmingCharacters(in: .whitespacesAndNewlines)
      return output?.isEmpty == false ? output : nil
    } catch {
      return nil
    }
  }

  @objc private func copyURL() {
    guard let accessURL else {
      return
    }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(accessURL.absoluteString, forType: .string)
    statusLabel.stringValue = "URL copied. Scan or share it with a phone on the same Wi-Fi network."
  }

  @objc private func openURL() {
    guard let accessURL else {
      return
    }
    NSWorkspace.shared.open(accessURL)
  }

  @objc private func restartServer() {
    stopServer()
    startServer()
  }
}
