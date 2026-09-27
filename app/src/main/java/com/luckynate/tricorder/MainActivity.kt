package com.luckynate.tricorder

import android.Manifest
import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.ArrayDeque
import kotlin.math.PI
import kotlin.math.abs

class MainActivity : Activity(), LocationListener, SensorEventListener {
    private data class HeadingSample(
        val timestampNanos: Long,
        val heading: Float,
        val accuracy: Int,
        val source: String
    )

    private lateinit var webView: WebView
    private lateinit var locationManager: LocationManager
    private lateinit var wifiManager: WifiManager
    private lateinit var sensorManager: SensorManager
    private lateinit var bluetoothScanner: BluetoothScanner
    private val handler = Handler(Looper.getMainLooper())

    private var latestLocation: Location? = null
    private var latestHeadingDegrees: Float? = null
    private var smoothedHeadingDegrees: Float? = null
    private var headingAccuracy = SensorManager.SENSOR_STATUS_UNRELIABLE
    private var headingSource = "none"
    private val locationHistory = ArrayDeque<Location>()
    private val headingHistory = ArrayDeque<HeadingSample>()
    private var wifiReceiverRegistered = false
    private var lastUpdateCheckAt = 0L

    companion object {
        private const val SENSOR_PERMISSION_REQUEST = 1001
        private const val SENSOR_FRAME_INTERVAL_MS = 33L
        private const val MAX_LOCATION_HISTORY = 128
        private const val MAX_HEADING_HISTORY = 256
        private const val UPDATE_CHECK_THROTTLE_MS = 30_000L
        private const val UPDATE_API_URL = "https://api.github.com/repos/LuckyNate/Tricorder/releases/tags/latest"
        private val RELEASE_VERSION_CODE_PATTERN = Regex("(?m)^versionCode=(\\d+)\\s*$")
    }

    private val wifiScanReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action == WifiManager.SCAN_RESULTS_AVAILABLE_ACTION &&
                intent.getBooleanExtra(WifiManager.EXTRA_RESULTS_UPDATED, false)
            ) {
                sendWifiResults()
            }
        }
    }

    private val sensorFrameLoop = object : Runnable {
        override fun run() {
            sampleLocationFrame()
            updateMotionHeadingFallback()
            requestWifiScan()
            sendWifiResults()
            sendBluetoothResults()
            latestLocation?.let(::sendLocation)
            sendHeading()
            handler.postDelayed(this, SENSOR_FRAME_INTERVAL_MS)
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
        sensorManager = getSystemService(SENSOR_SERVICE) as SensorManager
        bluetoothScanner = BluetoothScanner(applicationContext)
        requestSensorPermissions()
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
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) != PackageManager.PERMISSION_GRANTED) {
            needed += Manifest.permission.BLUETOOTH_SCAN
        }
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) {
            needed += Manifest.permission.BLUETOOTH_CONNECT
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
        startHeadingUpdates()
        startWifiScanning()
        startBluetoothScanning()
        startSensorFrameLoop()
    }

    private fun hasLocationPermission(): Boolean {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasWifiPermission(): Boolean {
        return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasBluetoothPermission(): Boolean {
        return checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
            checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
    }

    private fun startLocationUpdates() {
        if (!hasLocationPermission()) return

        sendStatus("Finding location")

        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).forEach { provider ->
            try {
                if (locationManager.isProviderEnabled(provider)) {
                    locationManager.getLastKnownLocation(provider)?.let(::handleLocation)
                    locationManager.requestLocationUpdates(provider, 0L, 0f, this)
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun startHeadingUpdates() {
        sensorManager.unregisterListener(this)
        val rotationVector = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR)
        if (rotationVector != null) {
            sensorManager.registerListener(this, rotationVector, SensorManager.SENSOR_DELAY_GAME)
        }
    }

    override fun onSensorChanged(event: SensorEvent?) {
        if (event?.sensor?.type != Sensor.TYPE_ROTATION_VECTOR) return

        val rotation = FloatArray(9)
        val orientation = FloatArray(3)
        SensorManager.getRotationMatrixFromVector(rotation, event.values)
        SensorManager.getOrientation(rotation, orientation)

        var heading = (orientation[0] * 180f / PI.toFloat())
        if (heading < 0f) heading += 360f

        latestHeadingDegrees = heading
        headingSource = "orientation"
        recordHeadingSample(event.timestamp, heading, headingAccuracy, headingSource)
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {
        if (sensor?.type == Sensor.TYPE_ROTATION_VECTOR) {
            headingAccuracy = accuracy
        }
    }

    private fun recordHeadingSample(timestampNanos: Long, heading: Float, accuracy: Int, source: String) {
        headingHistory.addLast(HeadingSample(timestampNanos, heading, accuracy, source))
        while (headingHistory.size > MAX_HEADING_HISTORY) headingHistory.removeFirst()
    }

    private fun sampleLocationFrame() {
        if (!hasLocationPermission()) return

        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).forEach { provider ->
            try {
                if (locationManager.isProviderEnabled(provider)) {
                    locationManager.getLastKnownLocation(provider)?.let { location ->
                        val current = latestLocation
                        if (current == null || location.elapsedRealtimeNanos >= current.elapsedRealtimeNanos) {
                            handleLocation(location)
                        }
                    }
                }
            } catch (_: Exception) {
            }
        }
    }

    private fun updateMotionHeadingFallback() {
        if (headingSource == "orientation" && latestHeadingDegrees != null) return
        val location = latestLocation ?: return
        if (location.hasBearing() && location.speed >= 0.5f) {
            latestHeadingDegrees = ((location.bearing % 360f) + 360f) % 360f
            headingAccuracy = SensorManager.SENSOR_STATUS_ACCURACY_MEDIUM
            headingSource = "motion"
            recordHeadingSample(
                SystemClock.elapsedRealtimeNanos(),
                latestHeadingDegrees!!,
                headingAccuracy,
                headingSource
            )
        }
    }

    private fun handleLocation(location: Location) {
        val copy = Location(location)
        latestLocation = copy
        if (locationHistory.isEmpty() || copy.elapsedRealtimeNanos > locationHistory.peekLast().elapsedRealtimeNanos) {
            locationHistory.addLast(copy)
            while (locationHistory.size > MAX_LOCATION_HISTORY) locationHistory.removeFirst()
        }
    }

    private fun nearestLocation(timestampNanos: Long): Location? {
        var nearest: Location? = null
        var nearestDelta = Long.MAX_VALUE
        locationHistory.forEach { location ->
            val delta = abs(location.elapsedRealtimeNanos - timestampNanos)
            if (delta < nearestDelta) {
                nearest = location
                nearestDelta = delta
            }
        }
        return nearest ?: latestLocation
    }

    private fun nearestHeading(timestampNanos: Long): HeadingSample? {
        var nearest: HeadingSample? = null
        var nearestDelta = Long.MAX_VALUE
        headingHistory.forEach { sample ->
            val delta = abs(sample.timestampNanos - timestampNanos)
            if (delta < nearestDelta) {
                nearest = sample
                nearestDelta = delta
            }
        }
        return nearest
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
    }

    private fun startBluetoothScanning() {
        if (!hasBluetoothPermission()) return
        bluetoothScanner.start()
    }

    private fun startSensorFrameLoop() {
        handler.removeCallbacks(sensorFrameLoop)
        handler.post(sensorFrameLoop)
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
        if (!hasWifiPermission() || !hasLocationPermission()) return

        try {
            val observations = JSONArray()
            wifiManager.scanResults.forEach { result ->
                val sampleTimeNanos = result.timestamp * 1000L
                val location = nearestLocation(sampleTimeNanos) ?: return@forEach
                val heading = nearestHeading(sampleTimeNanos)

                observations.put(JSONObject().apply {
                    put("bssid", result.BSSID ?: "")
                    put("ssid", result.SSID ?: "")
                    put("rssi", result.level)
                    put("frequency", result.frequency)
                    put("timestamp", result.timestamp / 1000L)
                    put("latitude", location.latitude)
                    put("longitude", location.longitude)
                    put("accuracy", location.accuracy)
                    heading?.let {
                        put("heading", it.heading)
                        put("headingSource", it.source)
                        put("headingAccuracy", it.accuracy)
                    }
                })
            }

            val script = "window.Tricorder && window.Tricorder.onWifiScan($observations);"
            runOnUiThread { webView.evaluateJavascript(script, null) }
        } catch (_: SecurityException) {
            sendStatus("Wi-Fi scan permission unavailable")
        }
    }

    private fun sendBluetoothResults() {
        if (!hasBluetoothPermission()) return
        val observations = bluetoothScanner.frame(
            latestLocation,
            latestHeadingDegrees,
            headingAccuracy,
            headingSource
        )
        val script = "window.Tricorder && window.Tricorder.onBluetoothScan && window.Tricorder.onBluetoothScan($observations);"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun checkForUpdates() {
        val now = SystemClock.elapsedRealtime()
        if (now - lastUpdateCheckAt < UPDATE_CHECK_THROTTLE_MS) return
        lastUpdateCheckAt = now

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

                if (newestVersionCode > BuildConfig.VERSION_CODE) {
                    sendStatus("Update 0.1.$newestVersionCode available")
                }
            } catch (_: Exception) {
                // Updating is opportunistic; sensor operation continues normally if GitHub is unavailable.
            }
        }.start()
    }

    private fun sendLocation(location: Location) {
        val bearing = if (location.hasBearing()) location.bearing else Float.NaN
        val speed = if (location.hasSpeed()) location.speed else 0f
        val script = "window.Tricorder && window.Tricorder.onLocation(${location.latitude},${location.longitude},${location.accuracy},$bearing,$speed);"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun sendHeading() {
        val target = latestHeadingDegrees ?: return
        val current = smoothedHeadingDegrees
        val smoothed = if (current == null) {
            target
        } else {
            val delta = ((target - current + 540f) % 360f) - 180f
            (current + delta * 0.2f + 360f) % 360f
        }
        smoothedHeadingDegrees = smoothed

        val source = headingSource.replace("\\", "\\\\").replace("'", "\\'")
        val mapRotation = -smoothed
        val script = """
            (function(){
              const mapEl=document.getElementById('map');
              if(mapEl){
                mapEl.style.transformOrigin='50% 50%';
                mapEl.style.transform='rotate(${mapRotation}deg) scale(1.42)';
              }
              if(window.Tricorder && window.Tricorder.onHeading){
                window.Tricorder.onHeading($smoothed,$headingAccuracy,'$source');
              }
            })();
        """.trimIndent()
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun sendStatus(message: String) {
        val escaped = message.replace("\\", "\\\\").replace("'", "\\'")
        val script = "window.Tricorder && window.Tricorder.onStatus('$escaped');"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    override fun onResume() {
        super.onResume()
        checkForUpdates()
        if (
            ::locationManager.isInitialized &&
            ::wifiManager.isInitialized &&
            ::sensorManager.isInitialized &&
            ::bluetoothScanner.isInitialized
        ) {
            requestSensorPermissions()
        }
    }

    override fun onPause() {
        super.onPause()
        handler.removeCallbacks(sensorFrameLoop)
        if (::bluetoothScanner.isInitialized) {
            bluetoothScanner.stop()
        }
        if (::sensorManager.isInitialized) {
            sensorManager.unregisterListener(this)
        }
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
