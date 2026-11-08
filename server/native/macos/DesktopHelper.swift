import Foundation
import AppKit
import CoreGraphics
import ApplicationServices
import ScreenCaptureKit
import Darwin

private struct Request: Decodable {
    let op: String
    let enabled: Bool?
    let input: DesktopInput?
    let frame: DesktopFrame?
}

private func geometry(_ id: CGDirectDisplayID) -> DisplayGeometry {
    let rect = CGDisplayBounds(id)
    let mode = CGDisplayCopyDisplayMode(id)
    return DisplayGeometry(id: id, x: rect.origin.x, y: rect.origin.y,
                           logicalWidth: rect.width, logicalHeight: rect.height,
                           pixelWidth: mode?.pixelWidth ?? CGDisplayPixelsWide(id), pixelHeight: mode?.pixelHeight ?? CGDisplayPixelsHigh(id))
}

private func allDisplays() -> [DisplayGeometry] {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(32, &ids, &count) == .success else { return [] }
    return ids.prefix(Int(count)).map(geometry)
}

private func permissionStatus() -> (Bool, Bool) {
    // Preflight only. Never call CGRequestScreenCaptureAccess or AX prompt options.
    (CGPreflightScreenCaptureAccess(), AXIsProcessTrusted())
}

private func requireAuthorization(_ request: Request) throws {
    guard request.enabled == true else { throw DesktopFailure("DISABLED", "整机控制尚未由用户启用。") }
    let permissions = permissionStatus()
    guard permissions.0, permissions.1 else { throw DesktopFailure("PERMISSION_REQUIRED", "请在 macOS 系统设置中人工授予屏幕录制及辅助功能权限。") }
}

private func dictionary<T: Encodable>(_ value: T) throws -> Any {
    try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
}

// Both normal completion and SIGTERM release held inputs. No clipboard, shell, or AppleScript.
private final class InputState: @unchecked Sendable {
    private let lock = NSLock()
    private var mouse: (CGMouseButton, CGPoint)?
    private var key: CGKeyCode?
    private lazy var source = CGEventSource(stateID: .hidSystemState)

    func mouseEvent(_ type: CGEventType, at point: CGPoint, button: CGMouseButton = .left, count: Int = 1) throws {
        lock.lock(); defer { lock.unlock() }
        guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button) else { throw DesktopFailure("INPUT_FAILED", "无法创建鼠标事件。") }
        event.setIntegerValueField(.mouseEventClickState, value: Int64(count))
        if type == .leftMouseDown || type == .rightMouseDown || type == .leftMouseDragged { mouse = (button, point) }
        event.post(tap: .cghidEventTap)
        if type == .leftMouseUp || type == .rightMouseUp { mouse = nil }
    }
    func keyboard(code: CGKeyCode, flags: CGEventFlags = [], unicode: [UniChar]? = nil) throws {
        lock.lock(); defer { lock.unlock() }
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false) else { throw DesktopFailure("INPUT_FAILED", "无法创建键盘事件。") }
        down.flags = flags
        // A key-up without modifier flags avoids leaving modifier state in the event stream.
        up.flags = []
        if let unicode = unicode {
            unicode.withUnsafeBufferPointer { buffer in
                down.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
                up.keyboardSetUnicodeString(stringLength: buffer.count, unicodeString: buffer.baseAddress)
            }
        }
        key = code
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        key = nil
    }
    func releaseAll() {
        lock.lock(); defer { lock.unlock() }
        if let (button, point) = mouse {
            CGEvent(mouseEventSource: source, mouseType: button == .right ? .rightMouseUp : .leftMouseUp, mouseCursorPosition: point, mouseButton: button)?.post(tap: .cghidEventTap)
            mouse = nil
        }
        if let code = key {
            let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: false)
            event?.flags = []; event?.post(tap: .cghidEventTap); key = nil
        }
    }
}

@main
private struct DesktopHelper {
    static let inputs = InputState()
    static func main() async {
        // This queue can release a held drag even while the command thread is sleeping.
        let queue = DispatchQueue(label: "com.openbot.desktop-helper.signals")
        let signals = [SIGTERM, SIGINT].map { number -> DispatchSourceSignal in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: queue)
            source.setEventHandler { inputs.releaseAll(); Darwin.exit(128 + number) }
            source.resume(); return source
        }
        defer { for source in signals { source.cancel() }; inputs.releaseAll() }
        do {
            var bytes = Data()
            while let chunk = try FileHandle.standardInput.read(upToCount: 8192), !chunk.isEmpty {
                bytes.append(chunk)
                guard bytes.count <= 128 * 1024 else { throw DesktopFailure("INVALID_REQUEST", "桌面请求过大。") }
            }
            let request = try JSONDecoder().decode(Request.self, from: bytes)
            let result = try await run(request)
            respond(["ok": true, "result": result])
        } catch let error as DesktopFailure {
            respond(["ok": false, "error": ["code": error.code, "message": error.message]])
        } catch {
            // Do not include typed text, app names, or screen contents in errors.
            respond(["ok": false, "error": ["code": "HELPER_ERROR", "message": "桌面操作失败，请检查权限与屏幕状态后重试。"]])
        }
    }
    static func respond(_ value: [String: Any]) {
        if let data = try? JSONSerialization.data(withJSONObject: value) { FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10])) }
    }
    static func run(_ request: Request) async throws -> [String: Any] {
        let primary = geometry(CGMainDisplayID())
        if request.op == "status" {
            let permissions = permissionStatus()
            let supported: Bool
            if #available(macOS 14.0, *) { supported = true } else { supported = false }
            let hasDisplay = primary.id != 0 && primary.logicalWidth > 0 && primary.logicalHeight > 0
            let available = supported && hasDisplay
            let reason = !supported ? "整机控制需要 macOS 14 或更新版本。" : (!hasDisplay ? "当前进程无法访问主显示器，请在已登录的 macOS 桌面会话中启动服务。" : (permissions.0 && permissions.1 ? "" : "请在系统设置 > 隐私与安全性中人工授予屏幕录制和辅助功能权限。"))
            return ["available": available, "authorized": available && permissions.0 && permissions.1,
                    "width": hasDisplay ? primary.frameWidth : 0, "height": hasDisplay ? primary.frameHeight : 0, "displayId": primary.id,
                    "permissions": ["screenRecording": permissions.0 ? "granted" : "denied", "accessibility": permissions.1 ? "granted" : "denied"],
                    "displays": try dictionary(allDisplays()),
                    "reason": reason]
        }
        try requireAuthorization(request)
        if request.op == "capture" {
            guard #available(macOS 14.0, *) else { throw DesktopFailure("UNSUPPORTED", "截图需要 macOS 14 或更新版本。") }
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first(where: { $0.displayID == primary.id }) else { throw DesktopFailure("NO_DISPLAY", "找不到主显示器。") }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.width = primary.frameWidth; configuration.height = primary.frameHeight
            configuration.showsCursor = true; configuration.capturesAudio = false
            let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: configuration)
            guard geometry(CGMainDisplayID()) == primary, image.width == primary.frameWidth, image.height == primary.frameHeight else { throw DesktopFailure("STALE_FRAME", "截图期间屏幕布局变化，请重试。") }
            guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]), png.count <= 8 * 1024 * 1024 else { throw DesktopFailure("CAPTURE_FAILED", "无法编码截图或图像过大。") }
            return ["png": png.base64EncodedString(), "width": image.width, "height": image.height, "capturedAt": ISO8601DateFormatter().string(from: Date()),
                    "displayId": primary.id, "geometryToken": primary.token]
        }
        guard request.op == "input", let input = request.input, let frame = request.frame else { throw DesktopFailure("INVALID_REQUEST", "桌面输入需要最近的主屏截图。") }
        try validateDesktopInput(input)
        _ = try primary.point(0, 0, frame: frame)
        try perform(input, primary: primary, frame: frame)
        return ["ok": true]
    }
    static func perform(_ input: DesktopInput, primary: DisplayGeometry, frame: DesktopFrame) throws {
        defer { inputs.releaseAll() }
        func point(_ x: Double?, _ y: Double?) throws -> CGPoint {
            let p = try primary.point(x ?? -1, y ?? -1, frame: frame)
            return CGPoint(x: p.0, y: p.1)
        }
        switch input.type {
        case "click":
            let location = try point(input.x, input.y), button: CGMouseButton = input.button == "right" ? .right : .left
            for count in 1...(input.clickCount ?? 1) {
                try inputs.mouseEvent(button == .right ? .rightMouseDown : .leftMouseDown, at: location, button: button, count: count)
                try inputs.mouseEvent(button == .right ? .rightMouseUp : .leftMouseUp, at: location, button: button, count: count)
                if count < (input.clickCount ?? 1) { Thread.sleep(forTimeInterval: 0.08) }
            }
        case "drag":
            let start = try point(input.x, input.y), end = try point(input.toX, input.toY)
            let duration = (input.durationMs ?? 400) / 1000, steps = max(6, Int(duration * 60))
            try inputs.mouseEvent(.leftMouseDown, at: start)
            for step in 1...steps {
                Thread.sleep(forTimeInterval: duration / Double(steps))
                let ratio = Double(step) / Double(steps)
                try inputs.mouseEvent(.leftMouseDragged, at: CGPoint(x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio))
            }
            try inputs.mouseEvent(.leftMouseUp, at: end)
        case "key":
            let stroke = try parseDesktopKey(input.key!)
            var flags: CGEventFlags = []
            if stroke.modifiers.contains("command") { flags.insert(.maskCommand) }
            if stroke.modifiers.contains("control") { flags.insert(.maskControl) }
            if stroke.modifiers.contains("option") { flags.insert(.maskAlternate) }
            if stroke.modifiers.contains("shift") { flags.insert(.maskShift) }
            try inputs.keyboard(code: stroke.code, flags: flags)
        case "type":
            // Chunk on Unicode scalars: never split a UTF-16 surrogate pair.
            var chunk: [UniChar] = []
            for scalar in input.text!.unicodeScalars {
                let units = Array(String(scalar).utf16)
                if chunk.count + units.count > 20 { try inputs.keyboard(code: 0, unicode: chunk); chunk = [] }
                chunk.append(contentsOf: units)
            }
            if !chunk.isEmpty { try inputs.keyboard(code: 0, unicode: chunk) }
        case "scroll":
            guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-(input.deltaY ?? 0)), wheel2: Int32(-(input.deltaX ?? 0)), wheel3: 0) else { throw DesktopFailure("INPUT_FAILED", "无法创建滚动事件。") }
            event.post(tap: .cghidEventTap)
        default: throw DesktopFailure("INVALID_INPUT", "不支持此桌面操作。")
        }
    }
}
