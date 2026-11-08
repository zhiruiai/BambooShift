import AVFoundation

final class VoiceRecorder {
  private let engine = AVAudioEngine()
  private let buffer: VoiceCaptureBuffer
  private var stopped = false
  private var installed = false
  private let complete: (Data?, Bool) -> Void

  init(automatic: Bool, seconds: Int, complete: @escaping (Data?, Bool) -> Void) {
    self.buffer = VoiceCaptureBuffer(automatic: automatic, seconds: seconds)
    self.complete = complete
  }

  func start() throws {
    let session = AVAudioSession.sharedInstance()
    try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetooth])
    try session.setActive(true)
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.channelCount > 0, format.sampleRate >= 16000,
      format.commonFormat == .pcmFormatFloat32 else {
      throw VoiceRecorderError.unavailable
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] audio, _ in
      guard let self, let channel = audio.floatChannelData?[0] else { return }
      if self.buffer.append(channel, count: Int(audio.frameLength), rate: format.sampleRate) {
        DispatchQueue.main.async { [weak self] in self?.stop(cancelled: false) }
      }
    }
    installed = true
    engine.prepare()
    try engine.start()
  }

  func stop(cancelled: Bool, failed: Bool = false) {
    guard !stopped else { return }
    stopped = true
    if installed {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    complete(cancelled || failed ? nil : buffer.wave(), failed)
  }
}

private enum VoiceRecorderError: Error {
  case unavailable
}

private final class VoiceCaptureBuffer {
  private let lock = NSLock()
  private let automatic: Bool
  private let limit: Int
  private var pcm = Data()
  private var phase: Double = 0
  private var sum: Double = 0
  private var window = 0
  private var energy: Double = 0
  private var frameLength = 0
  private var voiced = 0
  private var lastVoice = 0
  private var ended = false

  init(automatic: Bool, seconds: Int) {
    self.automatic = automatic
    self.limit = seconds * 16000
  }

  func append(_ input: UnsafePointer<Float>, count: Int, rate: Double) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !ended else { return false }
    for index in 0..<count {
      let inputSample = input[index]
      sum += inputSample.isFinite ? Double(inputSample) : 0
      window += 1
      phase += 16000
      if phase < rate { continue }
      let sample = Int16(max(-32768, min(32767, sum / Double(window) * 32768)))
      sum = 0
      window = 0
      phase -= rate
      pcm.appendLittleEndian(sample)
      energy += Double(sample) * Double(sample)
      frameLength += 1
      let length = pcm.count / 2
      if frameLength == 320 {
        if sqrt(energy / Double(frameLength)) >= 330 {
          voiced += frameLength
          lastVoice = length
        }
        frameLength = 0
        energy = 0
      }
      if length >= limit || automatic &&
        (voiced >= 1600 && length - lastVoice >= 14400 ||
          voiced < 1600 && length >= 192000) {
        ended = true
        return true
      }
    }
    return false
  }

  func wave() -> Data? {
    lock.lock()
    defer { lock.unlock() }
    ended = true
    guard voiced >= 1600 else { return nil }
    var data = Data("RIFF".utf8)
    data.appendLittleEndian(UInt32(36 + pcm.count))
    data.append(Data("WAVEfmt ".utf8))
    data.appendLittleEndian(UInt32(16))
    data.appendLittleEndian(UInt16(1))
    data.appendLittleEndian(UInt16(1))
    data.appendLittleEndian(UInt32(16000))
    data.appendLittleEndian(UInt32(32000))
    data.appendLittleEndian(UInt16(2))
    data.appendLittleEndian(UInt16(16))
    data.append(Data("data".utf8))
    data.appendLittleEndian(UInt32(pcm.count))
    data.append(pcm)
    return data
  }
}

private extension Data {
  mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
    var word = value.littleEndian
    Swift.withUnsafeBytes(of: &word) { append(contentsOf: $0) }
  }
}
