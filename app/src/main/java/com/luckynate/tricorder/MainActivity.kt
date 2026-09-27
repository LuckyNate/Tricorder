package com.luckynate.tricorder

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.core.content.FileProvider
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

class MainActivity : Activity(), LocationListener {
    private lateinit var webView: WebView
    private lateinit var locationManager: LocationManager
    private lateinit var wifiManager: WifiManager
    private val handler = Handler(Looper.getMainLooper())

    private var latestLocation: Location? = null
    private var wifiReceiverRegistered = false
    private var updateCheckStarted = false
    private var pendingUpdateFile: File? = null

    companion object {
        private const val SENSOR_PERMISSION_REQUEST = 1001
        private const val WIFI_SCAN_INTERVAL_MS = 15_000L
        private const val UPDATE_API_URL = "https://api.github.com/repos/LuckyNate/Tricorder/releases/tags/latest"
        private val RELEASE_VERSION_CODE_PATTERN = Regex("(?m)^versionCode=(\\d+)\\s*$")
    }

    private val wifiScanReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == WifiManager.SCAN_RESULTS_AVAILABLE_ACTION) {
                sendWifiResults()
            }
        }
    }

    private val wifiScanLoop = object : Runnable {
        override fun run() {
            requestWifiScan()
            handler.postDelayed(this, WIFI_SCAN_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            setBackgroundColor(0xFF07110D.toInt())
            webViewClient = WebViewClient()
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = true
            settings.allowContentAccess = false
            loadUrl("file:///android_asset/index.html")
        }
        setContentView(webView)

        locationManager = getSystemService(LOCATION_SERVICE) as LocationManager
        wifiManager = applicationContext.getSystemService(WIFI_SERVICE) as WifiManager
        requestSensorPermissions()
        checkForUpdatesOnce()
    }

    private fun requestSensorPermissions() {
        val needed = mutableListOf<String>()

        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            needed += Manifest.permission.ACCESS_FINE_LOCATION
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
            needed += Manifest.permission.ACCESS_COARSE_LOCATION
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) != PackageManager.PERMISSION_GRANTED
        ) {
            needed += Manifest.permission.NEARBY_WIFI_DEVICES
        }

        if (needed.isNotEmpty()) {
            requestPermissions(needed.toTypedArray(), SENSOR_PERMISSION_REQUEST)
        } else {
            startSensors()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == SENSOR_PERMISSION_REQUEST) {
            if (hasLocationPermission()) {
                startSensors()
            } else {
                sendStatus("Location permission denied")
            }
        }
    }

    private fun startSensors() {
        startLocationUpdates()
        startWifiScanning()
    }

    private fun hasLocationPermission(): Boolean {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasWifiPermission(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED
    }

    private fun startLocationUpdates() {
        if (!hasLocationPermission()) return

        sendStatus("Finding location")

        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).forEach { provider ->
            try {
                if (locationManager.isProviderEnabled(provider)) {
                    locationManager.getLastKnownLocation(provider)?.let(::handleLocation)
                    locationManager.requestLocationUpdates(provider, 1000L, 1f, this)
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun handleLocation(location: Location) {
        latestLocation = location
        sendLocation(location)
    }

    override fun onLocationChanged(location: Location) {
        handleLocation(location)
    }

    override fun onProviderEnabled(provider: String) {
        startLocationUpdates()
    }

    override fun onProviderDisabled(provider: String) {
        sendStatus("Waiting for location service")
    }

    private fun startWifiScanning() {
        if (!hasWifiPermission() || !hasLocationPermission()) return

        if (!wifiReceiverRegistered) {
            val filter = IntentFilter(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(wifiScanReceiver, filter, RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                registerReceiver(wifiScanReceiver, filter)
            }
            wifiReceiverRegistered = true
        }

        handler.removeCallbacks(wifiScanLoop)
        handler.post(wifiScanLoop)
        sendWifiResults()
    }

    private fun requestWifiScan() {
        if (!hasWifiPermission() || !hasLocationPermission()) return
        try {
            @Suppress("DEPRECATION")
            wifiManager.startScan()
        } catch (_: SecurityException) {
        }
    }

    private fun sendWifiResults() {
        val location = latestLocation ?: return
        if (!hasWifiPermission() || !hasLocationPermission()) return

        try {
            val observations = JSONArray()
            wifiManager.scanResults.forEach { result ->
                observations.put(JSONObject().apply {
                    put("bssid", result.BSSID ?: "")
                    put("ssid", result.SSID ?: "")
                    put("rssi", result.level)
                    put("frequency", result.frequency)
                    put("timestamp", System.currentTimeMillis())
                    put("latitude", location.latitude)
                    put("longitude", location.longitude)
                    put("accuracy", location.accuracy)
                })
            }

            val script = "window.Tricorder && window.Tricorder.onWifiScan($observations);"
            runOnUiThread { webView.evaluateJavascript(script, null) }
        } catch (_: SecurityException) {
            sendStatus("Wi-Fi scan permission unavailable")
        }
    }

    private fun checkForUpdatesOnce() {
        if (updateCheckStarted) return
        updateCheckStarted = true

        Thread {
            try {
                val connection = (URL(UPDATE_API_URL).openConnection() as HttpURLConnection).apply {
                    connectTimeout = 8_000
                    readTimeout = 12_000
                    requestMethod = "GET"
                    setRequestProperty("Accept", "application/vnd.github+json")
                    setRequestProperty("User-Agent", "Tricorder/${BuildConfig.VERSION_NAME}")
                }

                val body = connection.inputStream.bufferedReader().use { it.readText() }
                connection.disconnect()

                val release = JSONObject(body)
                val releaseNotes = release.optString("body")
                val newestVersionCode = RELEASE_VERSION_CODE_PATTERN
                    .find(releaseNotes)
                    ?.groupValues
                    ?.getOrNull(1)
                    ?.toIntOrNull()
                    ?: BuildConfig.VERSION_CODE

                val assets = release.getJSONArray("assets")
                var latestDownloadUrl: String? = null

                for (index in 0 until assets.length()) {
                    val asset = assets.getJSONObject(index)
                    if (asset.optString("name") == "Tricorder-latest.apk") {
                        latestDownloadUrl = asset.optString("browser_download_url")
                        break
                    }
                }

                if (newestVersionCode > BuildConfig.VERSION_CODE && !latestDownloadUrl.isNullOrBlank()) {
                    sendStatus("Update 0.1.$newestVersionCode found")
                    downloadUpdate(latestDownloadUrl!!, newestVersionCode)
                }
            } catch (_: Exception) {
                // Updating is opportunistic; sensor operation continues normally if GitHub is unavailable.
            }
        }.start()
    }

    private fun downloadUpdate(downloadUrl: String, versionCode: Int) {
        try {
            sendStatus("Downloading update 0.1.$versionCode")
            val updateDir = File(cacheDir, "updates").apply { mkdirs() }
            val apkFile = File(updateDir, "Tricorder-update.apk")

            val connection = (URL(downloadUrl).openConnection() as HttpURLConnection).apply {
                connectTimeout = 10_000
                readTimeout = 30_000
                instanceFollowRedirects = true
                setRequestProperty("User-Agent", "Tricorder/${BuildConfig.VERSION_NAME}")
            }

            connection.inputStream.use { input ->
                apkFile.outputStream().use { output -> input.copyTo(output) }
            }
            connection.disconnect()

            runOnUiThread { beginUpdateInstall(apkFile) }
        } catch (_: Exception) {
            sendStatus("Update download failed")
        }
    }

    private fun beginUpdateInstall(apkFile: File) {
        if (!apkFile.exists()) return

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !packageManager.canRequestPackageInstalls()) {
            pendingUpdateFile = apkFile
            sendStatus("Allow Tricorder to install updates")
            startActivity(
                Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:$packageName")
                )
            )
            return
        }

        launchPackageInstaller(apkFile)
    }

    private fun launchPackageInstaller(apkFile: File) {
        try {
            val uri = FileProvider.getUriForFile(
                this,
                "$packageName.fileprovider",
                apkFile
            )
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            sendStatus("Installing update")
            startActivity(intent)
        } catch (_: Exception) {
            sendStatus("Update installer unavailable")
        }
    }

    private fun sendLocation(location: Location) {
        val script = "window.Tricorder && window.Tricorder.onLocation(${location.latitude},${location.longitude},${location.accuracy});"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun sendStatus(message: String) {
        val escaped = message.replace("\\", "\\\\").replace("'", "\\'")
        val script = "window.Tricorder && window.Tricorder.onStatus('$escaped');"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    override fun onResume() {
        super.onResume()

        pendingUpdateFile?.let { apkFile ->
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || packageManager.canRequestPackageInstalls()) {
                pendingUpdateFile = null
                launchPackageInstaller(apkFile)
            }
        }

        if (::locationManager.isInitialized && ::wifiManager.isInitialized) requestSensorPermissions()
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(wifiScanLoop)
        if (::locationManager.isInitialized) {
            try {
                locationManager.removeUpdates(this)
            } catch (_: Exception) {
            }
        }
        if (wifiReceiverRegistered) {
            try {
                unregisterReceiver(wifiScanReceiver)
            } catch (_: Exception) {
            }
            wifiReceiverRegistered = false
        }
    }
}
