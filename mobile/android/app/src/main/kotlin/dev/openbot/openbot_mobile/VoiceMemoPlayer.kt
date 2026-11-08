package dev.openbot.openbot_mobile

import android.media.AudioAttributes
import android.media.MediaDataSource
import android.media.MediaPlayer
import io.flutter.plugin.common.MethodChannel

internal class VoiceMemoPlayer(
    private val attributes: AudioAttributes,
    private val acquireFocus: () -> Boolean,
    private val releaseFocus: () -> Unit,
) {
    private var player: MediaPlayer? = null
    private var source: MemorySource? = null
    private var owner: String? = null
    private var pending: MethodChannel.Result? = null
    private var focused = false

    fun play(id: String, wav: ByteArray, result: MethodChannel.Result) {
        stop()
        val stream = MemorySource(wav)
        val next = MediaPlayer()
        owner = id
        player = next
        source = stream
        pending = result
        try {
            next.setAudioAttributes(attributes)
            next.setDataSource(stream)
            next.setOnPreparedListener { prepared ->
                if (player !== prepared) return@setOnPreparedListener
                try {
                    if (!acquireFocus()) {
                        stop()
                        return@setOnPreparedListener
                    }
                    focused = true
                    prepared.start()
                    pending = null
                    result.success(null)
                } catch (_: RuntimeException) {
                    stop()
                }
            }
            next.setOnCompletionListener { if (player === it) stop() }
            next.setOnErrorListener { broken, _, _ ->
                if (player === broken) stop()
                true
            }
            next.prepareAsync()
        } catch (_: Exception) {
            stop()
        }
    }

    fun pause(id: String, result: MethodChannel.Result) = control(id, result) {
        it.pause()
        freeFocus()
    }

    fun resume(id: String, result: MethodChannel.Result) = control(id, result) {
        if (!focused) {
            check(acquireFocus())
            focused = true
        }
        it.start()
    }

    private fun control(id: String, result: MethodChannel.Result, action: (MediaPlayer) -> Unit) {
        val current = player
        if (owner != id || pending != null || current == null) {
            result.error("voice_memo_playback", null, null)
            return
        }
        try {
            action(current)
            result.success(null)
        } catch (_: RuntimeException) {
            stop()
            result.error("voice_memo_playback", null, null)
        }
    }

    fun status(id: String): Map<String, Any>? {
        val current = player
        if (owner != id || pending != null || current == null) return null
        return try {
            mapOf("playing" to current.isPlaying, "positionMs" to current.currentPosition)
        } catch (_: IllegalStateException) {
            stop()
            null
        }
    }

    fun stop(id: String? = null) {
        if (id != null && owner != id) return
        val current = player
        val data = source
        val reply = pending
        player = null
        source = null
        pending = null
        owner = null
        current?.release()
        data?.close()
        freeFocus()
        reply?.error("voice_memo_playback", null, null)
    }

    private fun freeFocus() {
        if (focused) releaseFocus()
        focused = false
    }

    private class MemorySource(bytes: ByteArray) : MediaDataSource() {
        @Volatile private var bytes: ByteArray? = bytes

        override fun getSize(): Long = bytes?.size?.toLong() ?: 0

        override fun readAt(position: Long, buffer: ByteArray, offset: Int, size: Int): Int {
            val data = bytes ?: return -1
            if (position < 0 || position >= data.size) return -1
            val start = position.toInt()
            val count = minOf(size, data.size - start)
            data.copyInto(buffer, offset, start, start + count)
            return count
        }

        override fun close() {
            bytes = null
        }
    }
}
