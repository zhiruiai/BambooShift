package dev.openbot.openbot_mobile

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.provider.OpenableColumns
import android.widget.Toast
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile
import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit

internal class InboundShareInbox(private val context: Context) {
    private val root = File(context.noBackupFilesDir, "inbound-shares")
    private val main = Handler(Looper.getMainLooper())
    private var channel: MethodChannel? = null

    fun attach(messenger: BinaryMessenger) {
        detach()
        channel = MethodChannel(messenger, "com.openbot.client/inbound-share").also { bridge ->
            bridge.setMethodCallHandler { call, result ->
                if (call.method !in listOf("peek", "read", "discard")) {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                disk.execute {
                    try {
                        val value = when (call.method) {
                            "peek" -> pending().firstNotNullOfOrNull { runCatching { describe(it) }.getOrNull() }
                            "read" -> read(
                                call.argument<String>("id"), call.argument<String>("fileId"),
                                call.argument<Int>("offset"), call.argument<Int>("length"),
                            )
                            else -> discard(call.argument<String>("id"))
                        }
                        main.post { result.success(value) }
                    } catch (_: Exception) {
                        main.post { result.error("share_unavailable", null, null) }
                    }
                }
            }
        }
    }

    fun detach() {
        channel?.setMethodCallHandler(null)
        channel = null
    }

    fun receive(intent: Intent) {
        try {
            ingress.execute {
                val saved = try {
                    receiveInBackground(intent)
                } catch (_: Exception) {
                    saveError("invalid")
                }
                main.post { shareAvailable(saved) }
            }
        } catch (_: RejectedExecutionException) {
            main.post { shareAvailable(false) }
        }
    }

    private fun shareAvailable(saved: Boolean) {
        if (!saved) Toast.makeText(context, R.string.inbound_share_not_saved, Toast.LENGTH_LONG).show()
        channel?.invokeMethod("available", null)
    }

    @Suppress("DEPRECATION")
    private fun receiveInBackground(intent: Intent): Boolean {
        if (pending().size >= MAX_PACKETS) return false
        val clip = intent.clipData
        val sharedText = (intent.getCharSequenceExtra(Intent.EXTRA_TEXT)
            ?: clip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text)?.toString()?.trim()
        val text = sharedText?.takeIf { it.isNotEmpty() && it.length <= MAX_TEXT }
        val streams = when (intent.action) {
            Intent.ACTION_SEND -> listOfNotNull(
                if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri::class.java)
                else intent.getParcelableExtra<Uri>(Intent.EXTRA_STREAM),
            )
            Intent.ACTION_SEND_MULTIPLE ->
                if (Build.VERSION.SDK_INT >= 33) intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri::class.java).orEmpty()
                else intent.getParcelableArrayListExtra<Uri>(Intent.EXTRA_STREAM).orEmpty()
            else -> return false
        }
        val uris = LinkedHashSet<Uri>()
        uris.addAll(streams.take(MAX_FILES + 1))
        if (clip != null) for (index in 0 until minOf(clip.itemCount, MAX_FILES + 1)) {
            clip.getItemAt(index).uri?.let(uris::add)
        }
        var error = if ((sharedText?.length ?: 0) > MAX_TEXT || uris.size > MAX_FILES || streams.size > MAX_FILES) "limit" else null
        return stage { draft ->
            val files = JSONArray()
            for (uri in uris.take(MAX_FILES)) {
                try {
                    files.put(copySharedFile(uri, draft))
                } catch (_: ShareLimitException) {
                    error = "limit"
                } catch (_: Exception) {
                    error = error ?: "invalid"
                }
            }
            if (files.length() == 0 && text == null) error = error ?: "invalid"
            JSONObject().put("text", text).put("files", files).put("error", error)
        }
    }

    private fun copySharedFile(uri: Uri, draft: File): JSONObject {
        val authority = requireNotNull(uri.authority)
        require(uri.scheme == "content" && '@' !in authority)
        val provider = context.packageManager.resolveContentProvider(authority, 0)
        require(provider?.packageName != context.packageName)
        require(
            context.checkUriPermission(uri, Process.myPid(), Process.myUid(), Intent.FLAG_GRANT_READ_URI_PERMISSION) ==
                PackageManager.PERMISSION_GRANTED,
        )

        val resolver = context.contentResolver
        var displayName: String? = null
        try {
            resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)
                ?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val nameColumn = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        if (nameColumn >= 0) displayName = cursor.getString(nameColumn)
                        val sizeColumn = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (sizeColumn >= 0 && cursor.getLong(sizeColumn) > MAX_FILE) throw ShareLimitException()
                    }
                }
        } catch (error: ShareLimitException) {
            throw error
        } catch (_: Exception) {
            // Some providers allow a stream but offer no document metadata.
        }
        val mime = runCatching { resolver.getType(uri) }.getOrNull()
            ?.takeIf { it.length <= 160 && mimePattern.matches(it) }
            ?: "application/octet-stream"
        val id = UUID.randomUUID().toString()
        val file = File(draft, id)
        val size = try {
            requireNotNull(resolver.openInputStream(uri)).use { input ->
                file.outputStream().use { output ->
                    var size = 0
                    val buffer = ByteArray(64 * 1024)
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        size += count
                        if (size > MAX_FILE) throw ShareLimitException()
                        output.write(buffer, 0, count)
                    }
                    size
                }
            }
        } catch (error: Exception) {
            file.delete()
            throw error
        }
        val name = displayName?.trim()?.takeIf { safeName.matches(it) && it !in listOf(".", "..") && !it.startsWith(".openbot-") }
            ?: "attachment"
        return JSONObject().put("id", id).put("name", name).put("type", mime).put("size", size)
    }

    private fun saveError(error: String): Boolean =
        try {
            stage { JSONObject().put("files", JSONArray()).put("error", error) }
        } catch (_: Exception) {
            false
        }

    private fun stage(makePacket: (File) -> JSONObject): Boolean {
        if (pending().size >= MAX_PACKETS) return false
        check(root.isDirectory || root.mkdirs())
        val id = UUID.randomUUID().toString()
        val draft = File(root, "draft-$id")
        check(draft.mkdir())
        try {
            val packet = makePacket(draft).put("id", id)
            File(draft, MANIFEST).writeText(packet.toString())
            check(draft.renameTo(File(root, id)))
            return true
        } finally {
            if (draft.exists()) draft.deleteRecursively()
        }
    }

    private fun pending(): List<File> {
        val now = System.currentTimeMillis()
        return root.listFiles().orEmpty().mapNotNull { directory ->
            val name = directory.name
            val draft = name.startsWith("draft-") && validId.matches(name.removePrefix("draft-"))
            if (!directory.isDirectory || (!draft && !validId.matches(name))) return@mapNotNull null
            if (now - directory.lastModified() > TTL) {
                directory.deleteRecursively()
                null
            } else directory.takeUnless { draft }
        }.sortedWith(compareBy<File> { it.lastModified() }.thenBy { it.name })
    }

    private fun manifest(directory: File): JSONObject? {
        val file = File(directory, MANIFEST)
        return if (file.isFile && file.length() <= 256 * 1024) JSONObject(file.readText()) else null
    }

    private fun describe(directory: File): Map<String, Any?>? {
        val value = manifest(directory) ?: return null
        val files = value.getJSONArray("files")
        return mapOf(
            "id" to directory.name,
            "text" to value.optString("text").ifBlank { null },
            "error" to value.optString("error").ifBlank { null },
            "files" to (0 until files.length()).map { index ->
                val file = files.getJSONObject(index)
                mapOf("id" to file.getString("id"), "name" to file.getString("name"),
                    "type" to file.getString("type"), "size" to file.getInt("size"))
            },
        )
    }

    private fun discard(id: String?): Boolean {
        require(id != null && validId.matches(id))
        val directory = File(root, id)
        return !directory.exists() || directory.deleteRecursively()
    }

    private fun read(id: String?, fileId: String?, offset: Int?, length: Int?): ByteArray {
        require(id != null && validId.matches(id) && fileId != null && validId.matches(fileId))
        require(offset != null && offset in 0..MAX_FILE && length != null && length in 0..64 * 1024)
        val directory = requireNotNull(pending().firstOrNull { it.name == id })
        val files = requireNotNull(manifest(directory)).getJSONArray("files")
        val item = requireNotNull((0 until files.length()).map(files::getJSONObject).firstOrNull { it.optString("id") == fileId })
        val size = item.getInt("size")
        require(size in 0..MAX_FILE && offset + length <= size)
        return ByteArray(length).also { bytes ->
            RandomAccessFile(File(directory, fileId), "r").use { file ->
                require(file.length() == size.toLong())
                file.seek(offset.toLong())
                file.readFully(bytes)
            }
        }
    }

    private class ShareLimitException : Exception()

    private companion object {
        const val MAX_TEXT = 30_000
        const val MAX_FILES = 4
        const val MAX_FILE = 10 * 1024 * 1024
        const val MAX_PACKETS = 4
        const val MANIFEST = "packet.json"
        const val TTL = 60 * 60 * 1000L
        val validId = Regex("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
        val safeName = Regex("[^/\\\\\\p{Cntrl}]{1,160}")
        val mimePattern = Regex("[A-Za-z0-9!#\\$&^_.+\\-]+/[A-Za-z0-9!#\\$&^_.+\\-]+")
        val disk = Executors.newSingleThreadExecutor()
        val ingress = ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, ArrayBlockingQueue(4))
    }
}
