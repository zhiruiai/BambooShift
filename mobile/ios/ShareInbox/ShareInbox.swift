import Foundation

struct SharedFile: Codable {
  let id: String
  let name: String
  let type: String
  let size: Int

  var arguments: [String: Any] { ["id": id, "name": name, "type": type, "size": size] }
}

struct SharedPacket: Codable {
  let id: String
  let text: String?
  let files: [SharedFile]
  let error: String?

  var arguments: [String: Any] {
    var value: [String: Any] = ["id": id, "files": files.map(\.arguments)]
    value["text"] = text
    value["error"] = error
    return value
  }
}

enum ShareInboxError: Error { case unavailable, invalid, limit, full }

struct ShareInbox {
  static let group = "group.dev.openbot.openbotMobile"
  static let maxFiles = 4
  static let maxText = 30_000
  static let maxFileSize = 10 * 1024 * 1024
  static let chunkSize = 64 * 1024
  private static let maxPackets = 4
  private static let expiry: TimeInterval = 60 * 60
  private static let manifest = "packet.json"
  private let fm = FileManager.default
  private let root: URL

  init() throws {
    guard let container = fm.containerURL(forSecurityApplicationGroupIdentifier: Self.group) else {
      throw ShareInboxError.unavailable
    }
    root = container.appendingPathComponent("inbound-shares", isDirectory: true)
  }

  init(root: URL) { self.root = root }

  func begin() throws -> ShareDraft {
    guard pending().count < Self.maxPackets else { throw ShareInboxError.full }
    try fm.createDirectory(at: root, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    var privateRoot = root
    var options = URLResourceValues()
    options.isExcludedFromBackup = true
    try privateRoot.setResourceValues(options)
    let id = UUID().uuidString.lowercased()
    let directory = root.appendingPathComponent("draft-" + id, isDirectory: true)
    try fm.createDirectory(at: directory, withIntermediateDirectories: false, attributes: Self.privateAttributes)
    return ShareDraft(id: id, directory: directory)
  }

  func publish(_ draft: ShareDraft, text: String?, files: [SharedFile], error: String?) throws {
    let lockURL = root.appendingPathComponent("publish.lock")
    let lock = open(lockURL.path, O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600)
    guard lock >= 0 else { throw ShareInboxError.unavailable }
    defer { close(lock) }
    guard flock(lock, LOCK_EX) == 0 else { throw ShareInboxError.unavailable }
    defer { flock(lock, LOCK_UN) }
    guard pending().count < Self.maxPackets else { throw ShareInboxError.full }
    let value = SharedPacket(id: draft.id, text: text, files: files, error: error)
    let manifest = draft.directory.appendingPathComponent(Self.manifest)
    let data = try JSONEncoder().encode(value)
    // The draft becomes visible only when its complete directory is renamed.
    #if os(iOS)
      try data.write(to: manifest, options: .completeFileProtection)
    #else
      try data.write(to: manifest)
    #endif
    try fm.moveItem(at: draft.directory, to: path(draft.id))
  }

  func peek() -> SharedPacket? {
    for directory in pending() {
      if let value = try? packet(in: directory) { return value }
    }
    return nil
  }

  func discard(id: String) throws -> Bool {
    guard Self.valid(id) else { throw ShareInboxError.invalid }
    do {
      try fm.removeItem(at: path(id))
    } catch let error as NSError where error.domain == NSCocoaErrorDomain && error.code == NSFileNoSuchFileError {
      return true
    }
    return true
  }

  func read(id: String, fileID: String, offset: Int, length: Int) throws -> Data {
    guard Self.valid(id), Self.valid(fileID), (0...Self.maxFileSize).contains(offset),
      (0...Self.chunkSize).contains(length), let directory = pending().first(where: { $0.lastPathComponent == id }),
      let file = try packet(in: directory).files.first(where: { $0.id == fileID }),
      (0...Self.maxFileSize).contains(file.size), offset + length <= file.size else {
      throw ShareInboxError.invalid
    }
    let url = directory.appendingPathComponent(fileID)
    let attributes = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard attributes.isRegularFile == true, attributes.isSymbolicLink != true, attributes.fileSize == file.size else {
      throw ShareInboxError.invalid
    }
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    try handle.seek(toOffset: UInt64(offset))
    if length == 0 { return Data() }
    guard let bytes = try handle.read(upToCount: length), bytes.count == length else {
      throw ShareInboxError.invalid
    }
    return bytes
  }

  private func path(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }

  private func packet(in directory: URL) throws -> SharedPacket {
    let url = directory.appendingPathComponent(Self.manifest)
    let values = try url.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true,
      let size = values.fileSize, size <= 256 * 1024 else { throw ShareInboxError.invalid }
    let packet = try JSONDecoder().decode(SharedPacket.self, from: Data(contentsOf: url))
    guard packet.id == directory.lastPathComponent else { throw ShareInboxError.invalid }
    return packet
  }

  private func pending() -> [URL] {
    let keys: Set<URLResourceKey> = [.isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey]
    let entries = (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: Array(keys))) ?? []
    return entries.compactMap { directory -> (URL, Date)? in
      let name = directory.lastPathComponent
      let draft = name.hasPrefix("draft-") && Self.valid(String(name.dropFirst(6)))
      guard draft || Self.valid(name), let values = try? directory.resourceValues(forKeys: keys),
        values.isDirectory == true, values.isSymbolicLink != true,
        let date = values.contentModificationDate else { return nil }
      if Date().timeIntervalSince(date) > Self.expiry {
        try? fm.removeItem(at: directory)
        return nil
      }
      return draft ? nil : (directory, date)
    }.sorted { left, right in
      left.1 == right.1 ? left.0.lastPathComponent < right.0.lastPathComponent : left.1 < right.1
    }.map { $0.0 }
  }

  private static func valid(_ id: String) -> Bool { UUID(uuidString: id)?.uuidString.lowercased() == id }

  fileprivate static var privateAttributes: [FileAttributeKey: Any] {
    var attributes: [FileAttributeKey: Any] = [.posixPermissions: 0o700]
    #if os(iOS)
      attributes[.protectionKey] = FileProtectionType.complete
    #endif
    return attributes
  }
}

struct ShareDraft {
  let id: String
  let directory: URL

  func copy(_ source: URL, name: String?, type: String) throws -> SharedFile {
    let resource = try source.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey, .fileSizeKey])
    guard source.isFileURL, resource.isRegularFile == true, resource.isSymbolicLink != true else {
      throw ShareInboxError.invalid
    }
    if let size = resource.fileSize, size > ShareInbox.maxFileSize { throw ShareInboxError.limit }
    let id = UUID().uuidString.lowercased()
    let output = directory.appendingPathComponent(id)
    let fm = FileManager.default
    var options = ShareInbox.privateAttributes
    options[.posixPermissions] = 0o600
    guard fm.createFile(atPath: output.path, contents: nil, attributes: options) else {
      throw ShareInboxError.unavailable
    }
    var keep = false
    defer { if !keep { try? fm.removeItem(at: output) } }
    let reader = try FileHandle(forReadingFrom: source)
    defer { try? reader.close() }
    let writer = try FileHandle(forWritingTo: output)
    defer { try? writer.close() }
    var size = 0
    while let data = try reader.read(upToCount: ShareInbox.chunkSize), !data.isEmpty {
      size += data.count
      guard size <= ShareInbox.maxFileSize else { throw ShareInboxError.limit }
      try writer.write(contentsOf: data)
    }
    keep = true
    let trimmed = (name ?? source.lastPathComponent).trimmingCharacters(in: .whitespacesAndNewlines)
    let bad = CharacterSet.controlCharacters.union(CharacterSet(charactersIn: "/\\"))
    let validName = !trimmed.isEmpty && trimmed.utf16.count <= 160 && trimmed != "." && trimmed != ".."
      && !trimmed.hasPrefix(".openbot-") && trimmed.rangeOfCharacter(from: bad) == nil
    return SharedFile(id: id, name: validName ? trimmed : "attachment", type: type, size: size)
  }

  func clean() { try? FileManager.default.removeItem(at: directory) }
}
