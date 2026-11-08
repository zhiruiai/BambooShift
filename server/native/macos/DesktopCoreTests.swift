import Foundation

@main
struct DesktopCoreTests {
    static func main() throws {
        let retina = DisplayGeometry(id: 1, x: 0, y: 0, logicalWidth: 1512, logicalHeight: 982, pixelWidth: 3024, pixelHeight: 1964)
        assert(retina.frameWidth == 1539 && retina.frameHeight == 1000)
        let frame = DesktopFrame(displayId: 1, geometryToken: retina.token, width: retina.frameWidth, height: retina.frameHeight)
        let middle = try retina.point(Double(frame.width) / 2, 500, frame: frame)
        assert(middle.0 == 756 && middle.1 == 491)
        let offset = DisplayGeometry(id: 2, x: -1920, y: 300, logicalWidth: 1920, logicalHeight: 1080, pixelWidth: 1920, pixelHeight: 1080)
        let otherFrame = DesktopFrame(displayId: 2, geometryToken: offset.token, width: offset.frameWidth, height: offset.frameHeight)
        let origin = try offset.point(0, 0, frame: otherFrame)
        assert(origin.0 == -1920 && origin.1 == 300)
        expectFailure { _ = try retina.point(Double(frame.width), 0, frame: frame) }
        expectFailure { _ = try retina.point(-1, 0, frame: frame) }
        expectFailure { _ = try retina.point(0, 0, frame: otherFrame) }
        let shortcut = try parseDesktopKey("ControlOrMeta+Shift+L")
        let arrow = try parseDesktopKey("ArrowUp")
        assert(shortcut.modifiers == ["command", "shift"])
        assert(arrow.code == 126)
        expectFailure { _ = try parseDesktopKey("Shell+L") }
        expectFailure { _ = try parseDesktopKey("Meta+osascript") }
        for json in [#"{"type":"drag","x":0,"y":0,"toX":10,"toY":10,"durationMs":2001}"#, #"{"type":"scroll","deltaY":4001}"#, #"{"type":"click","x":0,"y":0,"button":"middle"}"#] {
            let input = try JSONDecoder().decode(DesktopInput.self, from: Data(json.utf8))
            expectFailure { try validateDesktopInput(input) }
        }
        print("DesktopCore: mapping, Retina scaling, stale frames, key and input bounds passed (no screen capture or input)")
    }
    static func expectFailure(_ action: () throws -> Void) {
        do { try action(); fatalError("Expected validation failure") } catch { }
    }
}
