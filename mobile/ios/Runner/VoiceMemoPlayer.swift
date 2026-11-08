import AVFoundation

final class VoiceMemoPlayer: NSObject, AVAudioPlayerDelegate {
  private var player: AVAudioPlayer?
  private var owner: String?

  func play(id: String, wav: Data) throws {
    stop()
    let next = try AVAudioPlayer(data: wav)
    next.delegate = self
    player = next
    owner = id
    try resume(id: id)
  }

  func pause(id: String) throws {
    guard owner == id, let player else { throw MemoPlayerError.unavailable }
    player.pause()
    releaseSession()
  }

  func resume(id: String) throws {
    guard owner == id, let player else { throw MemoPlayerError.unavailable }
    let session = AVAudioSession.sharedInstance()
    do {
      try session.setCategory(.playback, mode: .spokenAudio)
      try session.setActive(true)
      if !player.play() { throw MemoPlayerError.unavailable }
    } catch {
      stop()
      throw error
    }
  }

  func status(id: String) -> [String: Any]? {
    guard owner == id, let player else { return nil }
    return ["playing": player.isPlaying, "positionMs": Int(player.currentTime * 1000)]
  }

  func stop(id: String? = nil) {
    guard (id == nil || id == owner), let player else { return }
    self.player = nil
    owner = nil
    player.stop()
    releaseSession()
  }

  private func releaseSession() {
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
    if self.player === player { stop() }
  }

  func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
    if self.player === player { stop() }
  }
}

private enum MemoPlayerError: Error {
  case unavailable
}
