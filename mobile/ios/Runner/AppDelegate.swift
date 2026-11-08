import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  private var avatarCamera: FlutterMethodChannel?
  private let voice = VoiceBridge()
  private let shareQueue = DispatchQueue(label: "dev.openbot.share-inbox")
  private var shareChannel: FlutterMethodChannel?

  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    voice.attach(to: engineBridge.applicationRegistrar.messenger())
    avatarCamera?.setMethodCallHandler(nil)
    let camera = FlutterMethodChannel(
      name: "com.openbot.client/avatar-camera",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    avatarCamera = camera
    camera.setMethodCallHandler { call, result in
      guard call.method == "available" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result(UIImagePickerController.isSourceTypeAvailable(.camera))
    }
    let channel = FlutterMethodChannel(
      name: "com.openbot.client/inbound-share",
      binaryMessenger: engineBridge.applicationRegistrar.messenger()
    )
    shareChannel?.setMethodCallHandler(nil)
    shareChannel = channel
    channel.setMethodCallHandler { [shareQueue] call, result in
      guard ["peek", "read", "discard"].contains(call.method) else {
        result(FlutterMethodNotImplemented)
        return
      }
      shareQueue.async {
        let value: Any?
        do {
          let inbox = try ShareInbox()
          let arguments = call.arguments as? [String: Any] ?? [:]
          switch call.method {
          case "peek":
            value = inbox.peek()?.arguments
          case "discard":
            guard let id = arguments["id"] as? String else { throw ShareInboxError.invalid }
            value = try inbox.discard(id: id)
          default:
            guard let id = arguments["id"] as? String, let fileID = arguments["fileId"] as? String,
              let offset = arguments["offset"] as? Int, let length = arguments["length"] as? Int else {
              throw ShareInboxError.invalid
            }
            let bytes = try inbox.read(id: id, fileID: fileID, offset: offset, length: length)
            value = FlutterStandardTypedData(bytes: bytes)
          }
        } catch {
          value = call.method == "peek" ? nil : FlutterError(code: "share_unavailable", message: nil, details: nil)
        }
        DispatchQueue.main.async { result(value) }
      }
    }
  }
}
