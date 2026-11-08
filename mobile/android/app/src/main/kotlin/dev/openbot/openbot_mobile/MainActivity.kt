package dev.openbot.openbot_mobile

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.provider.MediaStore
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

class MainActivity : FlutterActivity() {
    private var avatarCamera: MethodChannel? = null
    private val voice by lazy { VoiceBridge(this) }
    private val inboundShare by lazy { InboundShareInbox(applicationContext) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        if (savedInstanceState == null) receiveShare(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        receiveShare(intent)
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        inboundShare.attach(flutterEngine.dartExecutor.binaryMessenger)
        voice.attach(flutterEngine.dartExecutor.binaryMessenger)
        avatarCamera = MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            "com.openbot.client/avatar-camera",
        ).also { channel ->
            channel.setMethodCallHandler { call, result ->
                if (call.method == "available") {
                    val hasCamera = packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_ANY)
                    val canCapture = Intent(MediaStore.ACTION_IMAGE_CAPTURE).resolveActivity(packageManager) != null
                    result.success(hasCamera && canCapture)
                } else {
                    result.notImplemented()
                }
            }
        }
    }

    override fun cleanUpFlutterEngine(flutterEngine: FlutterEngine) {
        avatarCamera?.setMethodCallHandler(null)
        avatarCamera = null
        voice.detach()
        inboundShare.detach()
        super.cleanUpFlutterEngine(flutterEngine)
    }

    override fun onStart() {
        super.onStart()
        voice.setForeground(true)
    }

    override fun onStop() {
        voice.setForeground(false)
        super.onStop()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        voice.permissionResult(requestCode, grantResults)
    }

    private fun receiveShare(intent: Intent?) {
        if (intent?.action != Intent.ACTION_SEND && intent?.action != Intent.ACTION_SEND_MULTIPLE) return
        inboundShare.receive(requireNotNull(intent))
        setIntent(Intent(Intent.ACTION_MAIN))
    }
}
