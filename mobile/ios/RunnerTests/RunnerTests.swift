import XCTest
@testable import Runner

class RunnerTests: XCTestCase {
  func testShareIsInvisibleUntilPublishedAndCanBeReadInBoundedChunks() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: false)
    defer { try? FileManager.default.removeItem(at: folder) }
    let source = folder.appendingPathComponent("source.txt")
    try Data("hello".utf8).write(to: source)
    let inbox = ShareInbox(root: folder.appendingPathComponent("inbox"))
    let draft = try inbox.begin()
    let file = try draft.copy(source, name: "../escape", type: "text/plain")
    XCTAssertNil(inbox.peek())
    try inbox.publish(draft, text: "https://example.com/", files: [file], error: nil)
    XCTAssertEqual(inbox.peek()?.text, "https://example.com/")
    XCTAssertEqual(inbox.peek()?.files.first?.name, "attachment")
    XCTAssertEqual(try inbox.read(id: draft.id, fileID: file.id, offset: 1, length: 3), Data("ell".utf8))
    XCTAssertThrowsError(try inbox.read(id: draft.id, fileID: file.id, offset: 1, length: 5))
    XCTAssertThrowsError(try inbox.read(id: draft.id, fileID: "packet.json", offset: 0, length: 1))
    XCTAssertThrowsError(try inbox.discard(id: "../source.txt"))
    XCTAssertTrue(try inbox.discard(id: draft.id))
    XCTAssertTrue(try inbox.discard(id: draft.id))
    XCTAssertNil(inbox.peek())
  }

  func testInboxCapacityAndExpiryProtectLocalStorage() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    let inbox = ShareInbox(root: folder)
    defer { try? FileManager.default.removeItem(at: folder) }
    var published: [String] = []
    for index in 0..<4 {
      let draft = try inbox.begin()
      try inbox.publish(draft, text: String(index), files: [], error: nil)
      published.append(draft.id)
    }
    XCTAssertThrowsError(try inbox.begin())
    let oldest = folder.appendingPathComponent(published[0])
    try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -7200)], ofItemAtPath: oldest.path)
    XCTAssertNotNil(inbox.peek())
    XCTAssertFalse(FileManager.default.fileExists(atPath: oldest.path))
    let replacement = try inbox.begin()
    replacement.clean()
  }
}
