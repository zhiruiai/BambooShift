import Foundation

struct DesktopFailure: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) { self.code = code; self.message = message }
}

struct DisplayGeometry: Codable, Equatable {
    let id: UInt32
    let x: Double
    let y: Double
    let logicalWidth: Double
    let logicalHeight: Double
    let pixelWidth: Int
    let pixelHeight: Int
    var frameWidth: Int { fittedSize().0 }
    var frameHeight: Int { fittedSize().1 }
    var token: String { "\(id):\(x):\(y):\(logicalWidth):\(logicalHeight):\(pixelWidth):\(pixelHeight)" }
    func fittedSize() -> (Int, Int) {
        let scale = min(1.0, 1600.0 / Double(max(1, pixelWidth)), 1000.0 / Double(max(1, pixelHeight)))
        return (max(1, Int((Double(pixelWidth) * scale).rounded(.down))), max(1, Int((Double(pixelHeight) * scale).rounded(.down))))
    }
    func point(_ px: Double, _ py: Double, frame: DesktopFrame) throws -> (Double, Double) {
        guard frame.displayId == id, frame.geometryToken == token, frame.width == frameWidth, frame.height == frameHeight else {
            throw DesktopFailure("STALE_FRAME", "屏幕布局已改变，请刷新截图后重试。")
        }
        guard px.isFinite, py.isFinite, px >= 0, py >= 0, px < Double(frame.width), py < Double(frame.height) else {
            throw DesktopFailure("INVALID_COORDINATES", "点击位置超出主屏截图。")
        }
        return (x + px / Double(frame.width) * logicalWidth, y + py / Double(frame.height) * logicalHeight)
    }
}

struct DesktopFrame: Codable {
    let displayId: UInt32
    let geometryToken: String
    let width: Int
    let height: Int
}

struct DesktopInput: Decodable {
    let type: String
    let x: Double?
    let y: Double?
    let toX: Double?
    let toY: Double?
    let button: String?
    let clickCount: Int?
    let text: String?
    let key: String?
    let deltaY: Double?
    let deltaX: Double?
    let durationMs: Double?
}

struct KeyStroke {
    let code: UInt16
    let modifiers: Set<String>
}

// macOS virtual key codes from the installed HIToolbox Events.h SDK header.
let desktopKeyCodes: [String: UInt16] = [
    "a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,
    "1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"=":24,"9":25,"7":26,"-":27,"8":28,"0":29,
    "]":30,"o":31,"u":32,"[":33,"i":34,"p":35,"enter":36,"l":37,"j":38,"'":39,"k":40,";":41,"\\":42,",":43,"/":44,"n":45,"m":46,".":47,
    "tab":48,"space":49,"`":50,"backspace":51,"escape":53,"home":115,"pageup":116,"delete":117,"end":119,"pagedown":121,
    "arrowleft":123,"arrowright":124,"arrowdown":125,"arrowup":126,
    "f1":122,"f2":120,"f3":99,"f4":118,"f5":96,"f6":97,"f7":98,"f8":100,"f9":101,"f10":109,"f11":103,"f12":111
]

func parseDesktopKey(_ raw: String) throws -> KeyStroke {
    guard !raw.isEmpty, raw.utf8.count <= 100 else { throw DesktopFailure("INVALID_KEY", "按键名称无效。") }
    let parts = raw.lowercased().split(separator: "+", omittingEmptySubsequences: false).map(String.init)
    guard let last = parts.last, let code = desktopKeyCodes[last] else { throw DesktopFailure("INVALID_KEY", "不支持此按键。") }
    var modifiers = Set<String>()
    for part in parts.dropLast() {
        switch part {
        case "controlormeta", "meta", "command": modifiers.insert("command")
        case "control": modifiers.insert("control")
        case "alt", "option": modifiers.insert("option")
        case "shift": modifiers.insert("shift")
        default: throw DesktopFailure("INVALID_KEY", "不支持此组合键修饰符。")
        }
    }
    guard parts.count <= 5 else { throw DesktopFailure("INVALID_KEY", "组合键过长。") }
    return KeyStroke(code: code, modifiers: modifiers)
}

func validateDesktopInput(_ input: DesktopInput) throws {
    switch input.type {
    case "click", "drag":
        guard let x = input.x, let y = input.y, x.isFinite, y.isFinite, x >= 0, y >= 0 else { throw DesktopFailure("INVALID_INPUT", "缺少有效的截图坐标。") }
        if input.type == "click" {
            guard ["left", "right"].contains(input.button ?? "left"), [1, 2].contains(input.clickCount ?? 1) else { throw DesktopFailure("INVALID_INPUT", "鼠标按键或点击次数无效。") }
        } else {
            guard let x = input.toX, let y = input.toY, x.isFinite, y.isFinite, x >= 0, y >= 0,
                  (input.durationMs ?? 400).isFinite, (100...2000).contains(input.durationMs ?? 400) else { throw DesktopFailure("INVALID_INPUT", "拖动目标或时长无效（100–2000 毫秒）。") }
        }
    case "type":
        guard let text = input.text, !text.isEmpty, text.utf16.count <= 20000, !text.contains("\0") else { throw DesktopFailure("INVALID_INPUT", "输入文字必须为 1–20000 个字符，且不含空字符。") }
    case "key": _ = try parseDesktopKey(input.key ?? "")
    case "scroll":
        guard let y = input.deltaY, y.isFinite, abs(y) <= 4000, (input.deltaX ?? 0).isFinite, abs(input.deltaX ?? 0) <= 4000 else { throw DesktopFailure("INVALID_INPUT", "滚动距离必须在 ±4000 像素内。") }
    default: throw DesktopFailure("INVALID_INPUT", "不支持此桌面操作。")
    }
}
