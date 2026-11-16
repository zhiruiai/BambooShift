import AppKit
import ApplicationServices
import CryptoKit
import Darwin
import Foundation

struct AccessibilityTarget: Encodable {
    let pid: pid_t
    let bundleId: String
    let name: String
}

struct AccessibilityRow: Encodable {
    let id: String
    let depth: Int
    let role: String
    let label: String
    let enabled: Bool
    let actions: [String]
    var elementToken: String? = nil
}

struct AccessibilitySnapshot: Encodable {
    let app: AccessibilityTarget
    let windowTitle: String
    let snapshotToken: String
    let elements: [AccessibilityRow]
    let truncated: Bool
}

private struct SnapshotIdentity: Encodable {
    let app: AccessibilityTarget
    let processStartedAt: TimeInterval?
    let window: CFHashCode
    let windowTitle: String
    let elements: [AccessibilityRow]
    let elementIdentities: [CFHashCode]
    let editableValueDigests: [Data?]
    let truncated: Bool
}

private struct ControlIdentity: Encodable {
    let app: AccessibilityTarget
    let processStartedAt: TimeInterval
    let window: CFHashCode
    let windowTitle: String
    let element: CFHashCode
    let identifier: String?
    let role: String
    let label: String
    let actions: [String]
    let editableValueDigest: Data?
}

private struct ObservedControl {
    let element: AXUIElement
    let row: AccessibilityRow
    let identifier: String?
    let editableValueDigest: Data?
    let hidesChildren: Bool
}

private struct ObservedWindow {
    let window: AXUIElement
    let snapshot: AccessibilitySnapshot
    let controls: [ObservedControl]
}

private struct AccessibilityWalk {
    static let maxElements = 200
    static let maxDepth = 18
    private let deadline = DispatchTime.now().uptimeNanoseconds + 2_800_000_000
    let pid: pid_t
    private(set) var controls: [ObservedControl] = []
    private(set) var truncated = false
    private var visited: Set<AXUIElement> = []

    init(pid: pid_t) { self.pid = pid }

    mutating func visit(_ element: AXUIElement, depth: Int) throws {
        guard DispatchTime.now().uptimeNanoseconds < deadline else {
            throw DesktopFailure("AX_UNAVAILABLE", "读取应用界面超时，请重试。")
        }
        guard controls.count < Self.maxElements, depth <= Self.maxDepth else {
            truncated = true
            return
        }
        var owner: pid_t = 0
        guard AXUIElementGetPid(element, &owner) == .success, owner == pid,
              visited.insert(element).inserted else { return }
        guard let control = Self.readControl(element, id: String(controls.count + 1), depth: depth) else {
            truncated = true
            return
        }
        controls.append(control)
        if control.hidesChildren { return }
        var count: CFIndex = 0
        guard AXUIElementGetAttributeValueCount(element, kAXChildrenAttribute as CFString, &count) == .success,
              count > 0 else { return }
        let limit = min(count, Self.maxElements - controls.count)
        guard depth < Self.maxDepth, limit > 0 else { truncated = true; return }
        if limit < count { truncated = true }
        var children: CFArray?
        guard AXUIElementCopyAttributeValues(element, kAXChildrenAttribute as CFString, 0, limit, &children) == .success,
              let children = children as? [AnyObject] else { truncated = true; return }
        for child in children {
            if let child = accessibilityElement(child) { try visit(child, depth: depth + 1) }
            if controls.count == Self.maxElements { truncated = true; break }
        }
    }

    static func readControl(_ element: AXUIElement, id: String, depth: Int) -> ObservedControl? {
        let attributes = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute,
                          kAXDescriptionAttribute, kAXPlaceholderValueAttribute, kAXEnabledAttribute,
                          kAXIdentifierAttribute]
        var attributesResult: CFArray?
        guard AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, [], &attributesResult) == .success,
              let values = attributesResult as? [Any], values.count == attributes.count,
              let role = values[0] as? String, !role.isEmpty else { return nil }
        let subrole = values[1] as? String
        let secure = isSecure(role: role, subrole: subrole)
        let enabled = (values[5] as? Bool) ?? true
        let value = enabled ? editableValue(element, role: role, subrole: subrole) : nil
        var label = ""
        if !secure {
            label = values[2...4].lazy.compactMap { value -> String? in
                guard let raw = value as? String else { return nil }
                let cleaned = accessibilityText(raw)
                return cleaned.isEmpty ? nil : cleaned
            }.first ?? ""
            if label == value.map(accessibilityText) { label = "" }
            // Editable values and password contents are excluded. Static text supplies visible labels.
            if label.isEmpty, role == kAXStaticTextRole {
                label = accessibilityText(attribute(element, kAXValueAttribute) as? String ?? "")
            }
        }
        var actionNames: CFArray?
        var actions: [String] = []
        if !secure && enabled && AXUIElementCopyActionNames(element, &actionNames) == .success &&
            (actionNames as? [String])?.contains(kAXPressAction) == true {
            actions.append("press")
        }
        if value != nil { actions.append("setText") }
        let row = AccessibilityRow(id: id, depth: depth, role: accessibilityText(role),
                                   label: secure ? "安全文本框" : label, enabled: enabled, actions: actions)
        return ObservedControl(element: element, row: row,
                               identifier: (values[6] as? String).map(accessibilityText),
                               editableValueDigest: value.map(valueDigest), hidesChildren: secure || value != nil)
    }
}

enum DesktopAccessibility {
    @MainActor static var ready: Bool { NSWorkspace.shared.frontmostApplication != nil && AXIsProcessTrusted() }

    @MainActor static func inspect(app selector: String?) throws -> AccessibilitySnapshot {
        let app: NSRunningApplication
        if let selector {
            guard !selector.isEmpty, selector.utf16.count <= 300,
                  !selector.unicodeScalars.contains(where: CharacterSet.controlCharacters.contains) else {
                throw DesktopFailure("INVALID_REQUEST", "应用名称或标识符无效。")
            }
            let matches = NSWorkspace.shared.runningApplications.filter {
                !$0.isTerminated && ($0.bundleIdentifier?.caseInsensitiveCompare(selector) == .orderedSame ||
                    $0.localizedName?.caseInsensitiveCompare(selector) == .orderedSame)
            }
            guard matches.count == 1, let result = matches.first else {
                throw DesktopFailure("AX_APP_UNAVAILABLE", "找不到唯一的运行中应用，请使用准确的应用标识符。")
            }
            app = result
        } else if let front = NSWorkspace.shared.frontmostApplication {
            app = front
        } else {
            throw DesktopFailure("AX_APP_UNAVAILABLE", "当前没有可操作的应用。")
        }
        let observed = try observe(app)
        if selector == nil, NSWorkspace.shared.frontmostApplication?.processIdentifier != app.processIdentifier {
            throw staleSnapshot()
        }
        return observed.snapshot
    }

    @MainActor static func press(pid: pid_t, bundleId: String, snapshotToken: String, elementId: String,
                                 elementToken: String?) throws {
        let target = try target(pid: pid, bundleId: bundleId, snapshotToken: snapshotToken,
                                elementId: elementId, elementToken: elementToken, action: "press")
        let result = AXUIElementPerformAction(target.element, kAXPressAction as CFString)
        if result == .cannotComplete {
            throw DesktopFailure("AX_PRESS_UNCONFIRMED", "应用未确认操作结果，请重新查看应用状态。")
        }
        guard result == .success else {
            throw DesktopFailure("AX_ACTION_UNAVAILABLE", "无法执行此控件操作，请刷新应用状态。")
        }
    }

    @MainActor static func setText(pid: pid_t, bundleId: String, snapshotToken: String, elementId: String,
                                   elementToken: String?, text: String) throws {
        let scalars = text.unicodeScalars
        guard (1...2_000).contains(scalars.count), !scalars.contains(where: { scalar in
            let code = scalar.value
            return (code < 32 && code != 9 && code != 10) || (127...159).contains(code)
        }) else {
            throw DesktopFailure("INVALID_REQUEST", "应用操作的输入文本无效。")
        }
        let target = try target(pid: pid, bundleId: bundleId, snapshotToken: snapshotToken,
                                elementId: elementId, elementToken: elementToken, action: "setText")
        guard let current = editableValue(target.element), valueDigest(current) == target.editableValueDigest,
              let window = focusedWindow(AXUIElementCreateApplication(pid)), CFEqual(window, target.window) else {
            throw staleSnapshot()
        }
        let result = AXUIElementSetAttributeValue(target.element, kAXValueAttribute as CFString, text as CFString)
        if result == .cannotComplete || result == .failure {
            throw unconfirmedText()
        }
        guard result == .success else {
            throw DesktopFailure("AX_ACTION_UNAVAILABLE", "无法填写此控件，请重新查看应用状态。")
        }
        guard editableValue(target.element)?.utf16.elementsEqual(text.utf16) == true else {
            throw unconfirmedText()
        }
    }

    @MainActor private static func target(pid: pid_t, bundleId: String, snapshotToken: String, elementId: String,
                                          elementToken: String?, action: String) throws
        -> (window: AXUIElement, element: AXUIElement, editableValueDigest: Data?) {
        guard pid > 0, bundleId.utf16.count <= 300,
              validDigest(snapshotToken), elementToken.map(validDigest) ?? true,
              let index = Int(elementId), (1...AccessibilityWalk.maxElements).contains(index), String(index) == elementId else {
            throw DesktopFailure("INVALID_REQUEST", "应用控件引用无效。")
        }
        guard let app = NSRunningApplication(processIdentifier: pid), !app.isTerminated,
              accessibilityText(app.bundleIdentifier ?? "") == bundleId else { throw staleSnapshot() }
        let current = try observe(app)
        let control: ObservedControl
        if let elementToken {
            let matches = current.snapshot.elements.indices.filter { current.snapshot.elements[$0].elementToken == elementToken }
            guard matches.count == 1, let match = matches.first else { throw staleSnapshot() }
            let found = current.controls[match]
            guard let refreshed = AccessibilityWalk.readControl(found.element, id: found.row.id, depth: found.row.depth),
                  !app.isTerminated, let window = focusedWindow(AXUIElementCreateApplication(pid)),
                  CFEqual(window, current.window),
                  try controlToken(refreshed, app: current.snapshot.app, started: app.launchDate?.timeIntervalSince1970,
                                   window: window, title: windowName(window)) == elementToken else { throw staleSnapshot() }
            control = refreshed
        } else {
            guard current.snapshot.snapshotToken == snapshotToken, index <= current.controls.count else {
                throw staleSnapshot()
            }
            control = current.controls[index - 1]
        }
        guard control.row.enabled, control.row.actions.contains(action) else {
            throw DesktopFailure("AX_ACTION_UNAVAILABLE", "此控件不支持所请求的操作。")
        }
        guard AXIsProcessTrusted() else {
            throw DesktopFailure("PERMISSION_REQUIRED", "请在 macOS 系统设置中授予辅助功能权限。")
        }
        return (current.window, control.element, control.editableValueDigest)
    }

    @MainActor private static func observe(_ app: NSRunningApplication) throws -> ObservedWindow {
        let pid = app.processIdentifier
        guard pid > 0, !app.isTerminated else { throw staleSnapshot() }
        // Bound IPC even when a third-party app's accessibility handler becomes unresponsive.
        AXUIElementSetMessagingTimeout(AXUIElementCreateSystemWide(), 0.25)
        let application = AXUIElementCreateApplication(pid)
        guard let window = focusedWindow(application) else {
            throw DesktopFailure("AX_WINDOW_UNAVAILABLE", "此应用没有可通过辅助功能读取的窗口。")
        }
        let title = windowName(window)
        var walk = AccessibilityWalk(pid: pid)
        try walk.visit(window, depth: 0)
        guard !walk.controls.isEmpty else {
            throw DesktopFailure("AX_UNAVAILABLE", "应用未提供可读取的控件。")
        }
        guard !app.isTerminated, let latest = focusedWindow(application), CFEqual(latest, window) else {
            throw staleSnapshot()
        }
        let bundleId = accessibilityText(app.bundleIdentifier ?? "")
        let name = accessibilityText(app.localizedName ?? "")
        let target = AccessibilityTarget(pid: pid, bundleId: bundleId,
                                         name: name.isEmpty ? "PID \(pid)" : name)
        let started = app.launchDate?.timeIntervalSince1970
        // Keep the legacy digest based on the original rows, without scoped tokens.
        let identity = SnapshotIdentity(app: target, processStartedAt: started,
                                        window: CFHash(window), windowTitle: title, elements: walk.controls.map(\.row),
                                        elementIdentities: walk.controls.map { CFHash($0.element) },
                                        editableValueDigests: walk.controls.map(\.editableValueDigest),
                                        truncated: walk.truncated)
        let rows = try walk.controls.map { control in
            var row = control.row
            row.elementToken = try controlToken(control, app: target, started: started, window: window, title: title)
            return row
        }
        let snapshot = AccessibilitySnapshot(app: target, windowTitle: title, snapshotToken: try encodedDigest(identity),
                                             elements: rows, truncated: walk.truncated)
        return ObservedWindow(window: window, snapshot: snapshot, controls: walk.controls)
    }
}

func validDigest(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy { (48...57).contains($0) || (97...102).contains($0) }
}

func encodedDigest<T: Encodable>(_ value: T) throws -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return SHA256.hash(data: try encoder.encode(value)).map { String(format: "%02x", $0) }.joined()
}

private func controlToken(_ control: ObservedControl, app: AccessibilityTarget, started: TimeInterval?,
                          window: AXUIElement, title: String) throws -> String? {
    let row = control.row
    guard row.enabled, !row.actions.isEmpty, let started else { return nil }
    return try encodedDigest(ControlIdentity(app: app, processStartedAt: started, window: CFHash(window),
        windowTitle: title, element: CFHash(control.element), identifier: control.identifier, role: row.role,
        label: row.label, actions: row.actions, editableValueDigest: control.editableValueDigest))
}

private func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

private func isSecure(role: String, subrole: String?) -> Bool {
    role == kAXSecureTextFieldSubrole || subrole == kAXSecureTextFieldSubrole
}

private func editableValue(_ element: AXUIElement, role: String, subrole: String?) -> String? {
    guard (role == kAXTextFieldRole || role == kAXTextAreaRole), !isSecure(role: role, subrole: subrole) else { return nil }
    var settable: DarwinBoolean = false
    guard AXUIElementIsAttributeSettable(element, kAXValueAttribute as CFString, &settable) == .success,
          settable.boolValue, let value = attribute(element, kAXValueAttribute) as? String, value.utf16.count <= 20_000
    else { return nil }
    return value
}

private func editableValue(_ element: AXUIElement) -> String? {
    guard let role = attribute(element, kAXRoleAttribute) as? String else { return nil }
    return editableValue(element, role: role, subrole: attribute(element, kAXSubroleAttribute) as? String)
}

private func valueDigest(_ value: String) -> Data {
    Data(SHA256.hash(data: Data(value.utf8)))
}

private func accessibilityElement(_ value: CFTypeRef?) -> AXUIElement? {
    guard let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return unsafeBitCast(value, to: AXUIElement.self)
}

private func focusedWindow(_ application: AXUIElement) -> AXUIElement? {
    accessibilityElement(attribute(application, kAXFocusedWindowAttribute)) ??
        accessibilityElement(attribute(application, kAXMainWindowAttribute))
}

private func windowName(_ window: AXUIElement) -> String {
    accessibilityText(attribute(window, kAXTitleAttribute) as? String ?? "")
}

func accessibilityText(_ value: String) -> String {
    let bounded = String(decoding: value.utf16.prefix(300), as: UTF16.self)
    return bounded.components(separatedBy: CharacterSet.controlCharacters).joined(separator: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
}

private func staleSnapshot() -> DesktopFailure {
    DesktopFailure("AX_STALE_SNAPSHOT", "应用窗口或控件已变化，请重新查看应用后操作。")
}

private func unconfirmedText() -> DesktopFailure {
    DesktopFailure("AX_TEXT_UNCONFIRMED", "应用未确认文本修改结果，请重新查看应用状态。")
}
