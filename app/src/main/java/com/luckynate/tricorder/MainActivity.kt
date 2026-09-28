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
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.Surface
import android.webkit.WebResourceRequest
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
    private lateinit var nearbyNetworkScanner: NearbyNetworkScanner
    private lateinit var radioScanner: RadioScanner
    private lateinit var appUpdater: AppUpdater
    private val handler = Handler(Looper.getMainLooper())

    private var latestLocation: Location? = null
    private var latestGpsLocation: Location? = null
    private var latestNetworkLocation: Location? = null
    private var latestHeadingDegrees: Float? = null
    private var smoothedHeadingDegrees: Float? = null
    private var headingAccuracy = SensorManager.SENSOR_STATUS_UNRELIABLE
    private var headingSource = "none"
    private val locationHistory = ArrayDeque<Location>()
    private val headingHistory = ArrayDeque<HeadingSample>()
    private var wifiReceiverRegistered = false
    private var lastWifiScanAttemptMs = 0L
    private var lastBluetoothPayload: String? = null
    private var lastNetworkPayload: String? = null
    private var lastRadioPayload: String? = null
    private var lastRadioFrameAtMs = 0L
    private val availabilityStates = HashMap<String, String>()
    private var lastUpdateCheckAt = 0L

    companion object {
        private const val SENSOR_PERMISSION_REQUEST = 1001
        private const val SENSOR_FRAME_INTERVAL_MS = 33L
        private const val WIFI_SCAN_INTERVAL_MS = 30_000L
        private const val RADIO_FRAME_INTERVAL_MS = 1_000L
        private const val GPS_FRESH_NANOS = 30_000_000_000L
        private const val MAX_LOCATION_HISTORY = 128
        private const val MAX_HEADING_HISTORY = 256
        private const val UPDATE_CHECK_THROTTLE_MS = 30_000L
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

    private val sensorFrameLoop = object : Runnable {
        override fun run() {
            updateBestLocation()
            updateMotionHeadingFallback()
            requestWifiScan()
            sendBluetoothResults()
            sendNearbyNetworkResults()
            sendRadioResults()
            latestLocation?.let(::sendLocation)
            sendHeading()
            handler.postDelayed(this, SENSOR_FRAME_INTERVAL_MS)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        webView = WebView(this).apply {
            setBackgroundColor(0xFF07110D.toInt())
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                    val uri = request?.url ?: return false
                    val scheme = uri.scheme?.lowercase()
                    if (scheme == "http" || scheme == "https") {
                        return try {
                            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(uri.toString())))
                            true
                        } catch (_: Exception) {
                            false
                        }
                    }
                    return false
                }
            }
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
        bluetoothScanner = BluetoothScanner(applicationContext) {
            val now = SystemClock.elapsedRealtimeNanos()
            val location = latestLocation?.takeIf { abs(now - it.elapsedRealtimeNanos) <= 10_000_000_000L }
            val heading = headingHistory.peekLast()?.takeIf { abs(now - it.timestampNanos) <= 2_000_000_000L }
            BluetoothScanner.ObserverPose(
                location?.latitude, location?.longitude, location?.accuracy,
                heading?.heading, heading?.accuracy ?: headingAccuracy, heading?.source ?: "none",
                now
            )
        }
        nearbyNetworkScanner = NearbyNetworkScanner(applicationContext)
        radioScanner = RadioScanner(applicationContext)
        appUpdater = AppUpdater(this, ::sendStatus)
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
            startSensors()
            if (!hasLocationPermission()) sendStatus("Location unavailable; showing unresolved detections")
        }
    }

    private fun startSensors() {
        startLocationUpdates()
        startHeadingUpdates()
        startWifiScanning()
        startBluetoothScanning()
        startNearbyNetworkScanning()
        startRadioScanning()
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
        if (!hasLocationPermission()) {
            sendSensorAvailability("location", "permission unavailable")
            return
        }

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
        updateBestLocation()
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

        val rawRotation = FloatArray(9)
        val screenRotation = FloatArray(9)
        val orientation = FloatArray(3)
        SensorManager.getRotationMatrixFromVector(rawRotation, event.values)

        val displayRotation = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            display?.rotation ?: Surface.ROTATION_0
        } else {
            @Suppress("DEPRECATION")
            windowManager.defaultDisplay.rotation
        }

        val (axisX, axisY) = when (displayRotation) {
            Surface.ROTATION_90 -> SensorManager.AXIS_Y to SensorManager.AXIS_MINUS_X
            Surface.ROTATION_180 -> SensorManager.AXIS_MINUS_X to SensorManager.AXIS_MINUS_Y
            Surface.ROTATION_270 -> SensorManager.AXIS_MINUS_Y to SensorManager.AXIS_X
            else -> SensorManager.AXIS_X to SensorManager.AXIS_Y
        }

        if (!SensorManager.remapCoordinateSystem(rawRotation, axisX, axisY, screenRotation)) return
        SensorManager.getOrientation(screenRotation, orientation)

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

    private fun updateBestLocation() {
        val now = SystemClock.elapsedRealtimeNanos()
        val gps = latestGpsLocation
        val network = latestNetworkLocation
        val best = when {
            gps != null && now - gps.elapsedRealtimeNanos <= GPS_FRESH_NANOS -> gps
            network != null -> network
            else -> gps
        } ?: return

        val current = latestLocation
        if (current == null || best.provider != current.provider || best.elapsedRealtimeNanos != current.elapsedRealtimeNanos) {
            latestLocation = Location(best)
            recordLocationHistory(latestLocation!!)
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
        when (copy.provider) {
            LocationManager.GPS_PROVIDER -> {
                val currentGps = latestGpsLocation
                if (currentGps == null || copy.elapsedRealtimeNanos >= currentGps.elapsedRealtimeNanos) {
                    latestGpsLocation = copy
                }
            }
            LocationManager.NETWORK_PROVIDER -> {
                val currentNetwork = latestNetworkLocation
                if (currentNetwork == null || copy.elapsedRealtimeNanos >= currentNetwork.elapsedRealtimeNanos) {
                    latestNetworkLocation = copy
                }
            }
            else -> return
        }
        updateBestLocation()
    }

    private fun recordLocationHistory(location: Location) {
        if (locationHistory.isEmpty() || location.elapsedRealtimeNanos > locationHistory.peekLast().elapsedRealtimeNanos) {
            locationHistory.addLast(Location(location))
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
        if (!hasWifiPermission() || !hasLocationPermission()) {
            sendSensorAvailability("wifi", "permission unavailable")
            return
        }
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
        if (!wifiManager.isWifiEnabled) sendSensorAvailability("wifi", "Wi-Fi off")
        sendWifiResults()
        requestWifiScan()
    }

    private fun startBluetoothScanning() {
        if (!hasBluetoothPermission()) {
            sendSensorAvailability("bluetooth", "permission unavailable")
            return
        }
        bluetoothScanner.start()
    }

    private fun startNearbyNetworkScanning() {
        nearbyNetworkScanner.start()
    }

    private fun startRadioScanning() {
        radioScanner.start()
    }

    private fun startSensorFrameLoop() {
        handler.removeCallbacks(sensorFrameLoop)
        handler.post(sensorFrameLoop)
    }

    private fun requestWifiScan() {
        if (!hasWifiPermission() || !hasLocationPermission()) return
        if (!wifiManager.isWifiEnabled) {
            sendSensorAvailability("wifi", "Wi-Fi off")
            return
        }
        if (availabilityStates["wifi"] == "Wi-Fi off") sendSensorAvailability("wifi", "")
        val now = SystemClock.elapsedRealtime()
        if (lastWifiScanAttemptMs != 0L && now - lastWifiScanAttemptMs < WIFI_SCAN_INTERVAL_MS) return
        lastWifiScanAttemptMs = now
        try {
            @Suppress("DEPRECATION")
            if (!wifiManager.startScan()) sendSensorAvailability("wifi", "scan delayed; cached results")
            else sendSensorAvailability("wifi", "")
        } catch (_: SecurityException) {
            sendSensorAvailability("wifi", "permission unavailable")
        }
    }

    private fun sendWifiResults() {
        if (!hasWifiPermission() || !hasLocationPermission()) return

        try {
            val observations = JSONArray()
            wifiManager.scanResults.forEach { result ->
                val sampleTimeNanos = result.timestamp * 1000L
                val location = nearestLocation(sampleTimeNanos)
                val heading = nearestHeading(sampleTimeNanos)

                observations.put(JSONObject().apply {
                    put("bssid", result.BSSID ?: "")
                    put("ssid", result.SSID ?: "")
                    put("rssi", result.level)
                    put("frequency", result.frequency)
                    put("timestamp", result.timestamp / 1000L)
                    put("ageMs", ((SystemClock.elapsedRealtimeNanos() - sampleTimeNanos) / 1_000_000L).coerceAtLeast(0L))
                    location?.takeIf { abs(it.elapsedRealtimeNanos - sampleTimeNanos) <= 10_000_000_000L }?.let {
                        put("latitude", it.latitude)
                        put("longitude", it.longitude)
                        put("accuracy", it.accuracy)
                    }
                    heading?.takeIf { abs(it.timestampNanos - sampleTimeNanos) <= 2_000_000_000L }?.let {
                        put("heading", it.heading)
                        put("headingSource", it.source)
                        put("headingAccuracy", it.accuracy)
                    }
                })
            }

            val script = "window.Tricorder && window.Tricorder.onWifiScan($observations);"
            runOnUiThread { webView.evaluateJavascript(script, null) }
        } catch (_: SecurityException) {
            sendSensorAvailability("wifi", "permission unavailable")
        }
    }

    private fun sendBluetoothResults() {
        if (!hasBluetoothPermission()) return
        val observations = bluetoothScanner.frame()
        val payload = observations.toString()
        if (payload == lastBluetoothPayload) return
        lastBluetoothPayload = payload
        val script = "window.Tricorder && window.Tricorder.onBluetoothScan && window.Tricorder.onBluetoothScan($payload);"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun sendNearbyNetworkResults() {
        val observations = nearbyNetworkScanner.frame()
        val payload = observations.toString()
        if (payload == lastNetworkPayload) return
        lastNetworkPayload = payload
        val script = "window.Tricorder && window.Tricorder.onNearbyNetworkScan && window.Tricorder.onNearbyNetworkScan($payload);"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun sendRadioResults() {
        if (!::radioScanner.isInitialized) return
        val nowMs = SystemClock.elapsedRealtime()
        if (lastRadioFrameAtMs != 0L && nowMs - lastRadioFrameAtMs < RADIO_FRAME_INTERVAL_MS) return
        lastRadioFrameAtMs = nowMs

        val scanResults = try {
            if (hasWifiPermission() && hasLocationPermission()) wifiManager.scanResults else emptyList()
        } catch (_: SecurityException) {
            emptyList()
        }
        val location = latestLocation
        val pose = RadioScanner.ObserverPose(location?.latitude, location?.longitude, location?.accuracy)
        val payload = radioScanner.frame(scanResults, pose).toString()
        if (payload == lastRadioPayload) return
        lastRadioPayload = payload
        val script = "window.Tricorder && window.Tricorder.onRadioFrame && window.Tricorder.onRadioFrame($payload);"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun checkForUpdates() {
        if (::appUpdater.isInitialized) {
            appUpdater.checkForUpdates()
        }
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
        val script = "window.Tricorder && window.Tricorder.onHeading($smoothed,$headingAccuracy,'$source');"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun sendStatus(message: String) {
        val escaped = message.replace("\\", "\\\\").replace("'", "\\'")
        val script = "window.Tricorder && window.Tricorder.onStatus('$escaped');"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    private fun sendSensorAvailability(id: String, state: String) {
        if (availabilityStates[id] == state) return
        availabilityStates[id] = state
        val script = "window.Tricorder && window.Tricorder.onSensorAvailability && window.Tricorder.onSensorAvailability(${JSONObject.quote(id)},${JSONObject.quote(state)});"
        runOnUiThread { webView.evaluateJavascript(script, null) }
    }

    override fun onResume() {
        super.onResume()
        checkForUpdates()
        if (
            ::locationManager.isInitialized &&
            ::wifiManager.isInitialized &&
            ::sensorManager.isInitialized &&
            ::bluetoothScanner.isInitialized &&
            ::nearbyNetworkScanner.isInitialized &&
            ::radioScanner.isInitialized
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
        if (::nearbyNetworkScanner.isInitialized) {
            nearbyNetworkScanner.stop()
        }
        if (::radioScanner.isInitialized) {
            radioScanner.stop()
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
