package dev.openbot.openbot_mobile

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.sqrt

internal class VoiceRecorder(
    private val automatic: Boolean,
    private val seconds: Int,
    private val complete: (ByteArray?, Boolean) -> Unit,
) {
    @Volatile private var finishRequested = false
    @Volatile private var cancelled = false
    @Volatile private var record: AudioRecord? = null

    fun start() {
        Thread({ capture() }, "openbot-voice-record").start()
    }

    fun finish() {
        finishRequested = true
    }

    fun cancel() {
        cancelled = true
        try {
            record?.stop()
        } catch (_: IllegalStateException) {
            // The capture thread owns release and may have already stopped.
        }
    }

    @SuppressLint("MissingPermission")
    private fun open(): Pair<AudioRecord, Int> {
        for (rate in listOf(16000, 48000, 44100)) {
            val minSize = AudioRecord.getMinBufferSize(
                rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
            )
            if (minSize <= 0) continue
            val next = try {
                AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    rate, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT,
                    maxOf(minSize * 2, rate / 5),
                )
            } catch (_: IllegalArgumentException) {
                continue
            }
            if (next.state == AudioRecord.STATE_INITIALIZED) return next to rate
            next.release()
        }
        throw IllegalStateException("Audio capture is unavailable")
    }

    private fun capture() {
        var failed = false
        var result: ByteArray? = null
        try {
            val (input, rate) = open()
            record = input
            if (cancelled) return
            input.startRecording()
            val chunk = ShortArray(rate / 50)
            val captured = VoiceCaptureBuffer(seconds)
            val converter = VoiceSampleConverter(rate)
            while (!finishRequested && !cancelled) {
                val count = input.read(chunk, 0, chunk.size, AudioRecord.READ_BLOCKING)
                if (count <= 0) {
                    if (cancelled) break
                    throw IllegalStateException("Audio capture ended")
                }
                val samples = converter.append(chunk, count)
                if (captured.append(samples, automatic)) break
            }
            if (!cancelled) result = captured.wave()
        } catch (_: RuntimeException) {
            failed = !cancelled
        } finally {
            val input = record
            record = null
            if (input != null) {
                try {
                    input.stop()
                } catch (_: IllegalStateException) {
                    // Audio routing can stop a recorder before release.
                }
                input.release()
            }
            complete(if (cancelled) null else result, failed)
        }
    }
}

private class VoiceSampleConverter(private val rate: Int) {
    private var phase = 0
    private var sum = 0
    private var window = 0

    fun append(input: ShortArray, count: Int): ShortArray {
        if (rate == 16000 && count == input.size) return input
        val converted = ShortArray(count * 16000 / rate + 1)
        var size = 0
        for (i in 0 until count) {
            sum += input[i].toInt()
            window++
            phase += 16000
            if (phase >= rate) {
                converted[size++] = (sum / window).toShort()
                phase -= rate
                sum = 0
                window = 0
            }
        }
        return converted.copyOf(size)
    }
}

private class VoiceCaptureBuffer(seconds: Int) {
    private val pcm = ByteArrayOutputStream()
    private val limit = seconds * 16000
    private var voiced = 0
    private var lastVoice = 0

    fun append(samples: ShortArray, automatic: Boolean): Boolean {
        val count = minOf(samples.size, limit - pcm.size() / 2)
        if (count <= 0) return true
        var energy = 0.0
        for (i in 0 until count) {
            val sample = samples[i].toInt()
            energy += sample.toDouble() * sample
            pcm.write(sample and 255)
            pcm.write((sample shr 8) and 255)
        }
        val length = pcm.size() / 2
        if (sqrt(energy / count) >= 330) {
            voiced += count
            lastVoice = length
        }
        return length >= limit || automatic &&
            (voiced >= 1600 && length - lastVoice >= 14400 ||
                voiced < 1600 && length >= 192000)
    }

    fun wave(): ByteArray? {
        if (voiced < 1600) return null
        val audio = pcm.toByteArray()
        return ByteBuffer.allocate(44 + audio.size).order(ByteOrder.LITTLE_ENDIAN)
            .put("RIFF".toByteArray(Charsets.US_ASCII)).putInt(36 + audio.size)
            .put("WAVEfmt ".toByteArray(Charsets.US_ASCII)).putInt(16)
            .putShort(1).putShort(1).putInt(16000).putInt(32000)
            .putShort(2).putShort(16)
            .put("data".toByteArray(Charsets.US_ASCII)).putInt(audio.size)
            .put(audio).array()
    }
}
