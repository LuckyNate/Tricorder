package com.luckynate.tricorder

import android.Manifest
import android.app.Activity
import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.SensorManager
import android.location.LocationManager
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebView

class TricorderApplication : Application(), Application.ActivityLifecycleCallbacks {
    private var activeActivity: Activity? = null
    private var bridge: DeviceSensorBridge? = null

    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(this)
    }

    override fun onActivityResumed(activity: Activity) {
        if (activity !is MainActivity) return
        activeActivity = activity
        val webView = findWebView(activity.window?.decorView) ?: return

        installMediaPermissionBridge(activity, webView)
        ensureAudioPermission(activity)

        val sensors = activity.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val locations = activity.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        bridge?.stop()
        bridge = DeviceSensorBridge(
            activity,
            sensors,
            locations,
            { payload -> evaluate(webView, "window.Tricorder&&window.Tricorder.onHardwareSensorCatalog&&window.Tricorder.onHardwareSensorCatalog($payload);") },
            { payload -> evaluate(webView, "window.Tricorder&&window.Tricorder.onHardwareSensorFrame&&window.Tricorder.onHardwareSensorFrame($payload);") },
            { payload -> evaluate(webView, "window.Tricorder&&window.Tricorder.onGnssFrame&&window.Tricorder.onGnssFrame($payload);") },
            { payload -> evaluate(webView, "window.Tricorder&&window.Tricorder.onNfcTag&&window.Tricorder.onNfcTag($payload);") }
        ).also { it.start() }
    }

    override fun onActivityPaused(activity: Activity) {
        if (activity !== activeActivity) return
        bridge?.stop()
        bridge = null
        activeActivity = null
    }

    private fun installMediaPermissionBridge(activity: Activity, webView: WebView) {
        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest?) {
                val pending = request ?: return
                val granted = mutableListOf<String>()
                if (
                    pending.resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
                    activity.checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
                ) {
                    granted += PermissionRequest.RESOURCE_VIDEO_CAPTURE
                }
                if (
                    pending.resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) &&
                    activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                ) {
                    granted += PermissionRequest.RESOURCE_AUDIO_CAPTURE
                }
                activity.runOnUiThread {
                    if (granted.isNotEmpty()) pending.grant(granted.toTypedArray()) else pending.deny()
                }
            }
        }
    }

    private fun ensureAudioPermission(activity: Activity) {
        if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            activity.requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), AUDIO_PERMISSION_REQUEST)
        }
    }

    private fun evaluate(webView: WebView, script: String) {
        webView.post { webView.evaluateJavascript(script, null) }
    }

    private fun findWebView(view: View?): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findWebView(view.getChildAt(index))?.let { return it }
            }
        }
        return null
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {}
    override fun onActivityStarted(activity: Activity) {}
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) {}
    override fun onActivityStopped(activity: Activity) {}
    override fun onActivityDestroyed(activity: Activity) {}

    companion object {
        private const val AUDIO_PERMISSION_REQUEST = 1002
    }
}
