import AVFoundation
import Flutter
import UIKit

final class VoiceBridge: NSObject, AVSpeechSynthesizerDelegate {
  private let memo = VoiceMemoPlayer()
  private var channel: FlutterMethodChannel?
  private var recorder: VoiceRecorder?
  private let synthesizer = AVSpeechSynthesizer()
  private var playback: (AVSpeechUtterance, FlutterResult)?
  private var observer: NSObjectProtocol?
  private var interruption: NSObjectProtocol?

  override init() {
    super.init()
    synthesizer.delegate = self
    observer = NotificationCenter.default.addObserver(
      forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.stop() }
    interruption = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
    ) { [weak self] note in
      if note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt ==
        AVAudioSession.InterruptionType.began.rawValue {
        self?.stop(failed: true)
      }
    }
  }

  deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    if let interruption { NotificationCenter.default.removeObserver(interruption) }
    channel?.setMethodCallHandler(nil)
  }

  func attach(to messenger: FlutterBinaryMessenger) {
    channel?.setMethodCallHandler(nil)
    let channel = FlutterMethodChannel(name: "com.openbot.client/voice", binaryMessenger: messenger)
    self.channel = channel
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else {
        result(FlutterError(code: "voice_unavailable", message: nil, details: nil))
        return
      }
      let args = call.arguments as? [String: Any] ?? [:]
      switch call.method {
      case "prepare":
        self.prepare(playback: args["playback"] as? Bool == true, result: result)
      case "record":
        self.record(
          automatic: args["automatic"] as? Bool == true,
          seconds: args["seconds"] as? Int ?? 0, result: result
        )
      case "finish":
        self.recorder?.stop(cancelled: false)
        result(nil)
      case "speak":
        self.speak(
          text: args["text"] as? String ?? "",
          language: args["language"] as? String ?? "", result: result
        )
      case "memoPlay", "memoPause", "memoResume", "memoStop", "memoStatus":
        self.handleMemo(call.method, args: args, result: result)
      case "stop":
        self.stop()
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  private func handleMemo(_ method: String, args: [String: Any], result: FlutterResult) {
    guard let id = args["id"] as? String, id.count == 36 else {
      result(FlutterError(code: "voice_memo_playback", message: nil, details: nil))
      return
    }
    do {
      switch method {
      case "memoPlay":
        guard recorder == nil, playback == nil, UIApplication.shared.applicationState == .active,
          let wav = args["wav"] as? FlutterStandardTypedData,
          (46...2097152).contains(wav.data.count) else { throw VoiceMemoBridgeError.unavailable }
        try memo.play(id: id, wav: wav.data)
        result(nil)
      case "memoPause":
        try memo.pause(id: id)
        result(nil)
      case "memoResume":
        guard UIApplication.shared.applicationState == .active else {
          throw VoiceMemoBridgeError.unavailable
        }
        try memo.resume(id: id)
        result(nil)
      case "memoStop":
        memo.stop(id: id)
        result(nil)
      default:
        result(memo.status(id: id))
      }
    } catch {
      result(FlutterError(code: "voice_memo_playback", message: nil, details: nil))
    }
  }

  private func prepare(playback: Bool, result: @escaping FlutterResult) {
    let reply: (Bool) -> Void = { granted in
      DispatchQueue.main.async {
        if !granted {
          result(FlutterError(code: "voice_permission", message: nil, details: nil))
        } else if playback && AVSpeechSynthesisVoice(language: "en-US") == nil &&
          AVSpeechSynthesisVoice(language: "zh-CN") == nil {
          result(FlutterError(code: "voice_output", message: nil, details: nil))
        } else {
          result(nil)
        }
      }
    }
    if #available(iOS 17.0, *) {
      AVAudioApplication.requestRecordPermission(completionHandler: reply)
    } else {
      AVAudioSession.sharedInstance().requestRecordPermission(reply)
    }
  }

  private func record(automatic: Bool, seconds: Int, result: @escaping FlutterResult) {
    guard AVAudioSession.sharedInstance().recordPermission == .granted else {
      result(FlutterError(code: "voice_permission", message: nil, details: nil))
      return
    }
    guard recorder == nil, playback == nil, (1...60).contains(seconds) else {
      result(FlutterError(code: "voice_record", message: nil, details: nil))
      return
    }
    memo.stop()
    let next = VoiceRecorder(automatic: automatic, seconds: seconds) { [weak self] bytes, failed in
      self?.recorder = nil
      if failed {
        result(FlutterError(code: "voice_record", message: nil, details: nil))
      } else if let bytes {
        result(FlutterStandardTypedData(bytes: bytes))
      } else {
        result(nil)
      }
    }
    recorder = next
    do {
      try next.start()
    } catch {
      next.stop(cancelled: true, failed: true)
    }
  }

  private func speak(text: String, language: String, result: @escaping FlutterResult) {
    let locale = language == "zh" ? "zh-CN" : "en-US"
    guard !text.isEmpty, text.utf16.count <= 6000, recorder == nil, playback == nil,
      let voice = AVSpeechSynthesisVoice(language: locale) else {
      result(FlutterError(code: "voice_output", message: nil, details: nil))
      return
    }
    memo.stop()
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    playback = (utterance, result)
    synthesizer.speak(utterance)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
    finish(utterance)
  }

  func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
    finish(utterance)
  }

  private func finish(_ utterance: AVSpeechUtterance) {
    DispatchQueue.main.async { [weak self] in
      guard let self, let active = self.playback, active.0 === utterance else { return }
      self.playback = nil
      active.1(nil)
    }
  }

  private func stop(failed: Bool = false) {
    memo.stop()
    recorder?.stop(cancelled: true, failed: failed)
    let active = playback
    playback = nil
    synthesizer.stopSpeaking(at: .immediate)
    active?.1(failed ? FlutterError(code: "voice_output", message: nil, details: nil) : nil)
  }
}

private enum VoiceMemoBridgeError: Error {
  case unavailable
}
