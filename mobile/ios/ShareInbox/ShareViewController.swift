import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
  private let info = UILabel()
  private let activity = UIActivityIndicatorView(style: .medium)
  private let save = UIButton(type: .system)
  private let cancel = UIButton(type: .system)
  private var saved = false
  private var items: [NSExtensionItem] { extensionContext?.inputItems as? [NSExtensionItem] ?? [] }

  private func label(_ zh: String, _ en: String) -> String {
    Locale.preferredLanguages.first?.hasPrefix("zh") == true ? zh : en
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .systemBackground
    isModalInPresentation = true
    preferredContentSize = CGSize(width: 440, height: 260)

    let heading = UILabel()
    heading.text = label("分享到 MosoCrew", "Share to MosoCrew")
    heading.font = .preferredFont(forTextStyle: .title2)
    heading.adjustsFontForContentSizeCategory = true
    heading.numberOfLines = 0
    heading.accessibilityTraits = .header
    info.text = label("先保存到此设备。回到 MosoCrew 后选择会话和要加入草稿的内容。",
                      "Save the items on this device, then open MosoCrew to choose a chat and review the draft.")
    info.font = .preferredFont(forTextStyle: .body)
    info.textColor = .secondaryLabel
    info.adjustsFontForContentSizeCategory = true
    info.numberOfLines = 0
    save.configuration = .filled()
    save.setTitle(label("保存到 MosoCrew", "Save to MosoCrew"), for: .normal)
    save.addTarget(self, action: #selector(saveShare), for: .touchUpInside)
    cancel.setTitle(label("取消", "Cancel"), for: .normal)
    cancel.addTarget(self, action: #selector(cancelShare), for: .touchUpInside)
    let actions = UIStackView(arrangedSubviews: [cancel, save])
    actions.distribution = .fillEqually
    actions.spacing = 12
    let stack = UIStackView(arrangedSubviews: [heading, info, activity, actions])
    stack.axis = .vertical
    stack.spacing = 16
    let scroll = UIScrollView()
    scroll.translatesAutoresizingMaskIntoConstraints = false
    stack.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(scroll)
    scroll.addSubview(stack)
    NSLayoutConstraint.activate([
      scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      scroll.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
      scroll.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
      scroll.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor),
      stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 24),
      stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
      stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 24),
      stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -24),
      stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -48),
      actions.heightAnchor.constraint(greaterThanOrEqualToConstant: 44),
    ])
  }

  @objc private func cancelShare() {
    extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
  }

  @objc private func saveShare() {
    if saved {
      extensionContext?.completeRequest(returningItems: [], completionHandler: nil)
      return
    }
    save.isEnabled = false
    cancel.isEnabled = false
    activity.startAnimating()
    Task { @MainActor in
      do {
        try await stage()
        saved = true
        cancel.isHidden = true
        save.setTitle(label("完成", "Done"), for: .normal)
        info.text = label("已保存。打开 MosoCrew 后即可选择会话。", "Saved. Open MosoCrew to choose a chat.")
      } catch ShareInboxError.full {
        info.text = label("已有待处理的分享。请先打开 MosoCrew 处理这些项目。",
                          "Open MosoCrew and review your pending shares before adding another.")
      } catch ShareInboxError.limit {
        info.text = label("内容超过分享限制。每个文件最多 10 MB。", "This share is too large. Each file can be up to 10 MB.")
      } catch {
        info.text = label("无法保存此内容。你可以返回原应用重试。", "This content could not be saved. Try sharing it again.")
      }
      activity.stopAnimating()
      save.isEnabled = true
      cancel.isEnabled = true
      UIAccessibility.post(notification: .announcement, argument: info.text)
    }
  }

  private func stage() async throws {
    let inbox = try ShareInbox()
    let draft = try inbox.begin()
    defer { draft.clean() }
    let providers = items.flatMap { $0.attachments ?? [] }
    var text = ""
    var files: [SharedFile] = []
    let maxProviders = ShareInbox.maxFiles * 2
    var issue: String? = providers.count > maxProviders ? "limit" : nil
    func addText(_ value: String) throws {
      let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
      guard !trimmed.isEmpty, trimmed != text else { return }
      let next = text.isEmpty ? trimmed : text + "\n" + trimmed
      guard next.utf16.count <= ShareInbox.maxText else { throw ShareInboxError.limit }
      text = next
    }

    for provider in providers.prefix(maxProviders) {
      do {
        if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
          guard files.count < ShareInbox.maxFiles else { throw ShareInboxError.limit }
          files.append(try await loadFileURL(provider, draft: draft))
        } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
          let url = try await loadURL(provider, type: .url)
          guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
            ["http", "https"].contains(components.scheme?.lowercased() ?? ""),
            let host = components.host, !host.isEmpty, components.user == nil, components.password == nil else {
            throw ShareInboxError.invalid
          }
          try addText(url.absoluteString)
        } else if let type = fileType(provider) {
          guard files.count < ShareInbox.maxFiles else { throw ShareInboxError.limit }
          files.append(try await loadFile(provider, type: type, draft: draft))
        } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
          try addText(try await loadText(provider))
        } else {
          throw ShareInboxError.invalid
        }
      } catch ShareInboxError.limit {
        issue = "limit"
      } catch {
        issue = issue ?? "invalid"
      }
    }
    if text.isEmpty {
      for item in items.prefix(maxProviders) {
        do { try addText(item.attributedContentText?.string ?? "") }
        catch { issue = "limit" }
      }
    }
    guard !text.isEmpty || !files.isEmpty else {
      if issue == "limit" { throw ShareInboxError.limit }
      throw ShareInboxError.invalid
    }
    try inbox.publish(draft, text: text.isEmpty ? nil : text, files: files, error: issue)
  }

  private func fileType(_ provider: NSItemProvider) -> UTType? {
    let types = provider.registeredTypeIdentifiers.compactMap { UTType($0) }
    if let type = types.first(where: {
      $0 != .data && $0.conforms(to: .data) && !$0.conforms(to: .text) && !$0.conforms(to: .url)
    }) { return type }
    if let name = provider.suggestedName, !(name as NSString).pathExtension.isEmpty {
      return types.first { $0.conforms(to: .data) && !$0.conforms(to: .url) }
    }
    return types.first { $0 == .data && !provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) }
  }

  private func mime(_ type: UTType) -> String { type.preferredMIMEType ?? "application/octet-stream" }

  private func loadURL(_ provider: NSItemProvider, type: UTType) async throws -> URL {
    try await withCheckedThrowingContinuation { continuation in
      provider.loadItem(forTypeIdentifier: type.identifier, options: nil) { item, error in
        if let url = item as? URL { continuation.resume(returning: url) }
        else { continuation.resume(throwing: error ?? ShareInboxError.invalid) }
      }
    }
  }

  private func loadText(_ provider: NSItemProvider) async throws -> String {
    try await withCheckedThrowingContinuation { continuation in
      provider.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, error in
        if let text = item as? String {
          continuation.resume(returning: text)
        } else if let data = item as? Data, data.count <= ShareInbox.maxText * 4,
          let text = String(data: data, encoding: .utf8) {
          continuation.resume(returning: text)
        } else {
          continuation.resume(throwing: error ?? ShareInboxError.invalid)
        }
      }
    }
  }

  private func loadFileURL(_ provider: NSItemProvider, draft: ShareDraft) async throws -> SharedFile {
    try await withCheckedThrowingContinuation { continuation in
      provider.loadItem(forTypeIdentifier: UTType.fileURL.identifier, options: nil) { item, error in
        guard let url = item as? URL, url.isFileURL else {
          continuation.resume(throwing: error ?? ShareInboxError.invalid)
          return
        }
        let accessible = url.startAccessingSecurityScopedResource()
        defer { if accessible { url.stopAccessingSecurityScopedResource() } }
        let type = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType ?? "application/octet-stream"
        continuation.resume(with: Result { try draft.copy(url, name: url.lastPathComponent, type: type) })
      }
    }
  }

  private func loadFile(_ provider: NSItemProvider, type: UTType, draft: ShareDraft) async throws -> SharedFile {
    let name: String?
    if let suggested = provider.suggestedName, (suggested as NSString).pathExtension.isEmpty,
      let ext = type.preferredFilenameExtension {
      name = suggested + "." + ext
    } else {
      name = provider.suggestedName
    }
    let contentType = mime(type)
    return try await withCheckedThrowingContinuation { continuation in
      provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { temporaryURL, error in
        guard let temporaryURL else {
          continuation.resume(throwing: error ?? ShareInboxError.invalid)
          return
        }
        // Item-provider files exist only for the duration of this callback.
        continuation.resume(with: Result { try draft.copy(temporaryURL, name: name, type: contentType) })
      }
    }
  }
}
