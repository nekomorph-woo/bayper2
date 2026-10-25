import AppKit
import CoreGraphics

// 隔离根目录只接受 /tmp 或 /private/tmp 下的 bayper-window-spike-*。
var rootPath = ""

func resolveRoot() -> String? {
    guard let raw = ProcessInfo.processInfo.environment["BAYPER_WINDOW_ROOT"] else { return nil }
    let prefixes = ["/tmp/bayper-window-spike-", "/private/tmp/bayper-window-spike-"]
    return prefixes.contains { raw.hasPrefix($0) } ? raw : nil
}

func frontmostPid() -> pid_t {
    NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1
}

func appendJSONL(_ record: [String: Any]) {
    guard !rootPath.isEmpty else { return }
    var entry = record
    entry["ts"] = ISO8601DateFormatter().string(from: Date())
    do {
        let data = try JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys])
        let path = (rootPath as NSString).appendingPathComponent("oracle.jsonl")
        if !FileManager.default.fileExists(atPath: path) {
            FileManager.default.createFile(atPath: path, contents: nil)
        }
        guard let handle = FileHandle(forWritingAtPath: path) else {
            FileHandle.standardError.write(Data("打开 oracle.jsonl 失败\n".utf8))
            return
        }
        defer { try? handle.close() }
        _ = try handle.seekToEnd()
        try handle.write(contentsOf: data + Data("\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("写 oracle.jsonl 失败: \(error)\n".utf8))
    }
}

// 棋盘底板负责接收真实鼠标点击，并把计数与 keyWindow 状态画在顶部。
final class BoardView: NSView {
    var counter = 0

    override var acceptsFirstResponder: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let tile: CGFloat = 40
        let columns = Int(ceil(bounds.width / tile))
        let rows = Int(ceil(bounds.height / tile))
        for row in 0..<rows {
            for column in 0..<columns {
                let shade: CGFloat = (row + column).isMultiple(of: 2) ? 0.78 : 0.55
                NSColor(calibratedWhite: shade, alpha: 1).setFill()
                NSBezierPath(rect: NSRect(x: CGFloat(column) * tile, y: CGFloat(row) * tile, width: tile, height: tile)).fill()
            }
        }
        let keyWindow = window?.isKeyWindow ?? false
        let text = "counter=\(counter)  keyWindow=\(keyWindow)  frontmostPid=\(frontmostPid())"
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 20, weight: .semibold),
            .foregroundColor: NSColor.black,
            .backgroundColor: NSColor(calibratedWhite: 1, alpha: 0.8),
        ]
        (text as NSString).draw(at: NSPoint(x: 16, y: bounds.height - 36), withAttributes: attributes)
    }

    override func mouseDown(with event: NSEvent) {
        counter += 1
        let point = convert(event.locationInWindow, from: nil)
        appendJSONL([
            "event": "click",
            "x": Double(point.x),
            "y": Double(point.y),
            "windowKey": window?.isKeyWindow ?? false,
            "frontmostPid": Int(frontmostPid()),
            "counter": counter,
        ])
        needsDisplay = true
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate {
    private var window: NSWindow!
    private var board: BoardView!
    private var heartbeat: Timer?
    private var commandTimer: Timer?
    private var lastCommandSeq = 0
    private var lastBadCommand = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 独立测试底板允许主动激活，便于确认它持有输入焦点。
        NSApp.activate(ignoringOtherApps: true)
        let frame = NSRect(x: 0, y: 0, width: 800, height: 600)
        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Bayper Click Target"
        window.center()
        window.collectionBehavior = [.fullScreenPrimary]
        board = BoardView(frame: frame)
        board.autoresizingMask = [.width, .height]
        window.contentView = board
        window.delegate = self
        window.makeKeyAndOrderFront(nil)

        // 空间切换通知由 NSWorkspace 自己的通知中心发出，不是进程内的 default 中心。
        NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.activeSpaceDidChangeNotification,
            object: nil,
            queue: .main
        ) { _ in
            appendJSONL(["event": "activeSpaceDidChange", "frontmostPid": Int(frontmostPid())])
        }

        heartbeat = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.board.needsDisplay = true
            appendJSONL([
                "event": "heartbeat",
                "frontmostPid": Int(frontmostPid()),
                "windowKey": self.window.isKeyWindow,
                "isFullScreen": self.window.styleMask.contains(.fullScreen),
            ])
        }

        // 可选控制文件只驱动自有底板，不是模拟输入，也不发送 CGEvent。
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.pollBoardCommand()
        }
        RunLoop.main.add(timer, forMode: .common)
        commandTimer = timer

        appendJSONL([
            "event": "startup",
            "pid": Int(ProcessInfo.processInfo.processIdentifier),
            "frontmostPid": Int(frontmostPid()),
            "windowKey": window.isKeyWindow,
        ])

        // GUI 底板最多运行 20 分钟，便于人工做 Space 操作，同时避免遗留窗口。
        DispatchQueue.main.asyncAfter(deadline: .now() + 20 * 60) {
            appendJSONL(["event": "timeout-terminate", "frontmostPid": Int(frontmostPid())])
            NSApp.terminate(nil)
        }
    }

    // 只接受本进程 control 文件；seq 递增才执行，避免重复触发。
    private func pollBoardCommand() {
        let path = (rootPath as NSString).appendingPathComponent("board-command.json")
        guard let data = FileManager.default.contents(atPath: path) else { return }
        let raw = String(decoding: data, as: UTF8.self)
        if raw == lastBadCommand { return }
        guard let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            lastBadCommand = raw
            appendJSONL(["event": "command-parse-failed", "raw": raw])
            return
        }
        lastBadCommand = ""
        guard let seq = command["seq"] as? Int, seq > lastCommandSeq else { return }
        lastCommandSeq = seq

        if let fullscreen = command["fullscreen"] as? Bool {
            // 只在目标状态与当前状态不同时切换，重复 true/false 不会反向。
            if window.styleMask.contains(.fullScreen) != fullscreen {
                window.toggleFullScreen(nil)
            }
            // 实际进入/退出全屏以 windowDidEnter/ExitFullScreen 事件为准，这里只记录已发出切换。
            appendJSONL([
                "event": "board-command",
                "seq": seq,
                "action": "fullscreen",
                "value": fullscreen,
                "isFullScreen": window.styleMask.contains(.fullScreen),
                "frontmostPid": Int(frontmostPid()),
            ])
        }
        if command["active"] as? Bool == true {
            NSApp.activate(ignoringOtherApps: true)
            appendJSONL([
                "event": "board-command",
                "seq": seq,
                "action": "active",
                "windowKey": window.isKeyWindow,
                "frontmostPid": Int(frontmostPid()),
            ])
        }
        if command["quit"] as? Bool == true {
            appendJSONL(["event": "board-command", "seq": seq, "action": "quit", "frontmostPid": Int(frontmostPid())])
            NSApp.terminate(nil)
        }
    }

    func windowDidBecomeKey(_ notification: Notification) {
        logWindow("windowDidBecomeKey")
    }

    func windowDidResignKey(_ notification: Notification) {
        logWindow("windowDidResignKey")
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        logWindow("windowDidEnterFullScreen")
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        logWindow("windowDidExitFullScreen")
    }

    private func logWindow(_ event: String) {
        appendJSONL([
            "event": event,
            "frontmostPid": Int(frontmostPid()),
            "windowKey": window.isKeyWindow,
            "isFullScreen": window.styleMask.contains(.fullScreen),
        ])
    }
}

// 只读观察指定 PID 的窗口元数据，不读取标题或内容，也不申请录屏权限。
func runObserve(pids: [Int32]) {
    let targets = Set(pids.map { Int($0) })
    let onscreen = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
    let all = (CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]]) ?? []

    func describe(_ entry: [String: Any]) -> [String: Any] {
        [
            "ownerPid": entry[kCGWindowOwnerPID as String] as? Int ?? -1,
            "windowNumber": entry[kCGWindowNumber as String] as? Int ?? -1,
            "layer": entry[kCGWindowLayer as String] as? Int ?? -1,
            "bounds": entry[kCGWindowBounds as String] as? [String: Any] ?? [:],
            "alpha": entry[kCGWindowAlpha as String] as? Double ?? 0,
        ]
    }

    func matching(_ list: [[String: Any]]) -> [[String: Any]] {
        list.filter { entry in
            guard let owner = entry[kCGWindowOwnerPID as String] as? Int else { return false }
            return targets.contains(owner)
        }.map(describe)
    }

    let output: [String: Any] = [
        "frontmostPid": Int(frontmostPid()),
        "pids": pids.map { Int($0) },
        "onscreen": matching(onscreen),
        "all": matching(all),
    ]
    do {
        let data = try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys])
        FileHandle.standardOutput.write(data + Data("\n".utf8))
    } catch {
        FileHandle.standardError.write(Data("观察结果序列化失败: \(error)\n".utf8))
        exit(1)
    }
}

let arguments = Array(CommandLine.arguments.dropFirst())
if let observeIndex = arguments.firstIndex(of: "--observe") {
    runObserve(pids: arguments[(observeIndex + 1)...].compactMap { Int32($0) })
} else if let resolved = resolveRoot() {
    rootPath = resolved
    let app = NSApplication.shared
    let delegate = AppDelegate()
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
} else {
    FileHandle.standardError.write(Data("BAYPER_WINDOW_ROOT 无效或未注入\n".utf8))
    exit(1)
}
