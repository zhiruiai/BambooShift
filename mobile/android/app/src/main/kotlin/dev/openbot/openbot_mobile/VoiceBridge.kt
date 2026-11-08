package dev.openbot.openbot_mobile

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.util.Locale
import java.util.UUID

internal class VoiceBridge(private val activity: MainActivity) {
    private val main = Handler(Looper.getMainLooper())
    private var channel: MethodChannel? = null
    private var recorder: VoiceRecorder? = null
    private var recordResult: MethodChannel.Result? = null
    private var permission: Pair<Boolean, MethodChannel.Result>? = null
    private var initialization: MethodChannel.Result? = null
    private var tts: TextToSpeech? = null
    private var ready = false
    private var playback: Pair<String, MethodChannel.Result>? = null
    private var focusRequest: AudioFocusRequest? = null
    private var foreground = false
    private val stopping = mutableListOf<MethodChannel.Result>()
    private val audio by lazy { activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager }
    private val audioAttributes = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
    private val memo = VoiceMemoPlayer(audioAttributes, ::acquireFocus, ::releaseFocus)
    private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
        if (change < 0) {
            main.post {
                stopSpeech(failed = true)
                memo.stop()
            }
        }
    }
    private val permissionId = 4192

    fun attach(messenger: BinaryMessenger) {
        channel = MethodChannel(messenger, "com.openbot.client/voice").also { channel ->
            channel.setMethodCallHandler { call, result ->
                when (call.method) {
                    "prepare" -> prepare(call.argument<Boolean>("playback") == true, result)
                    "record" -> record(
                        call.argument<Boolean>("automatic") == true,
                        call.argument<Int>("seconds") ?: 0, result,
                    )
                    "finish" -> {
                        recorder?.finish()
                        result.success(null)
                    }
                    "speak" -> speak(
                        call.argument<String>("text").orEmpty(),
                        call.argument<String>("language").orEmpty(), result,
                    )
                    "memoPlay" -> {
                        val id = call.argument<String>("id")
                        val wav = call.argument<ByteArray>("wav")
                        if (!foreground || recorder != null || playback != null ||
                            id == null || id.length != 36 || wav == null || wav.size !in 46..2097152
                        ) {
                            result.error("voice_memo_playback", null, null)
                        } else {
                            memo.play(id, wav, result)
                        }
                    }
                    "memoPause" -> memo.pause(call.argument<String>("id").orEmpty(), result)
                    "memoResume" -> memo.resume(call.argument<String>("id").orEmpty(), result)
                    "memoStatus" -> result.success(memo.status(call.argument<String>("id").orEmpty()))
                    "memoStop" -> {
                        memo.stop(call.argument<String>("id").orEmpty())
                        result.success(null)
                    }
                    "stop" -> stop(result)
                    else -> result.notImplemented()
                }
            }
        }
    }

    private fun prepare(needsPlayback: Boolean, result: MethodChannel.Result) {
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            preparePlayback(needsPlayback, result)
        } else if (permission != null) {
            result.error("voice_permission", null, null)
        } else {
            permission = needsPlayback to result
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), permissionId)
        }
    }

    fun permissionResult(requestCode: Int, grantResults: IntArray) {
        if (requestCode != permissionId) return
        val (needsPlayback, result) = permission ?: return
        permission = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) {
            preparePlayback(needsPlayback, result)
        } else {
            result.error("voice_permission", null, null)
        }
    }

    private fun preparePlayback(needsPlayback: Boolean, result: MethodChannel.Result) {
        if (!needsPlayback || ready) {
            result.success(null)
            return
        }
        if (initialization != null) {
            result.error("voice_output", null, null)
            return
        }
        initialization = result
        tts?.shutdown()
        tts = TextToSpeech(activity.applicationContext) { status ->
            main.post {
                val reply = initialization
                initialization = null
                ready = status == TextToSpeech.SUCCESS &&
                    (offlineVoice("en") != null || offlineVoice("zh") != null)
                if (ready) {
                    tts?.setAudioAttributes(audioAttributes)
                    tts?.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
                        override fun onStart(utteranceId: String) = Unit
                        override fun onDone(utteranceId: String) = finishSpeech(utteranceId, false)
                        @Deprecated("Legacy Android TTS error callback")
                        override fun onError(utteranceId: String) = finishSpeech(utteranceId, true)
                        override fun onStop(utteranceId: String, interrupted: Boolean) =
                            finishSpeech(utteranceId, false)
                    })
                    reply?.success(null)
                } else {
                    reply?.error("voice_output", null, null)
                }
            }
        }
    }

    private fun offlineVoice(language: String): Voice? = tts?.voices?.firstOrNull {
        it.locale.language == Locale.forLanguageTag(language).language &&
            !it.isNetworkConnectionRequired && TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED !in it.features.orEmpty()
    }

    private fun record(automatic: Boolean, seconds: Int, result: MethodChannel.Result) {
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            result.error("voice_permission", null, null)
            return
        }
        if (!foreground || recorder != null || playback != null || seconds !in 1..60) {
            result.error("voice_record", null, null)
            return
        }
        memo.stop()
        recordResult = result
        val next = VoiceRecorder(automatic, seconds) { bytes, failed ->
            main.post {
                if (recordResult !== result) return@post
                recorder = null
                recordResult = null
                if (failed) result.error("voice_record", null, null) else result.success(bytes)
                completeStops()
            }
        }
        recorder = next
        next.start()
    }

    private fun speak(text: String, language: String, result: MethodChannel.Result) {
        val engine = tts
        val voice = offlineVoice(language)
        if (!foreground || !ready || engine == null || voice == null || recorder != null ||
            playback != null || text.isBlank() || text.length > TextToSpeech.getMaxSpeechInputLength()
        ) {
            result.error("voice_output", null, null)
            return
        }
        memo.stop()
        if (engine.setVoice(voice) != TextToSpeech.SUCCESS || !acquireFocus()) {
            result.error("voice_output", null, null)
            return
        }
        val id = UUID.randomUUID().toString()
        playback = id to result
        if (engine.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
            finishSpeech(id, true)
        }
    }

    private fun finishSpeech(id: String, failed: Boolean) {
        main.post {
            val (activeId, result) = playback ?: return@post
            if (id != activeId) return@post
            playback = null
            releaseFocus()
            if (failed) result.error("voice_output", null, null) else result.success(null)
        }
    }

    @Suppress("DEPRECATION")
    private fun acquireFocus(): Boolean {
        val granted = if (Build.VERSION.SDK_INT >= 26) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                .setAudioAttributes(audioAttributes)
                .setOnAudioFocusChangeListener(focusListener, main).build()
            val result = audio.requestAudioFocus(request)
            if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) focusRequest = request
            result
        } else {
            audio.requestAudioFocus(focusListener, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
        }
        return granted == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
    }

    @Suppress("DEPRECATION")
    private fun releaseFocus() {
        if (Build.VERSION.SDK_INT >= 26) {
            focusRequest?.let { audio.abandonAudioFocusRequest(it) }
            focusRequest = null
        } else {
            audio.abandonAudioFocus(focusListener)
        }
    }

    private fun stopSpeech(failed: Boolean = false) {
        val current = playback ?: return
        playback = null
        tts?.stop()
        releaseFocus()
        if (failed) current.second.error("voice_output", null, null)
        else current.second.success(null)
    }

    private fun completeStops() {
        val replies = stopping.toList()
        stopping.clear()
        replies.forEach { it.success(null) }
    }

    fun setForeground(active: Boolean) {
        foreground = active
        if (!active) stop()
    }

    fun stop(result: MethodChannel.Result? = null) {
        if (result != null) stopping.add(result)
        stopSpeech()
        memo.stop()
        val running = recorder
        if (running == null) completeStops() else running.cancel()
    }

    fun detach() {
        stop()
        channel?.setMethodCallHandler(null)
        channel = null
        permission?.second?.error("voice_permission", null, null)
        permission = null
        initialization?.error("voice_output", null, null)
        initialization = null
        ready = false
        tts?.shutdown()
        tts = null
    }
}
