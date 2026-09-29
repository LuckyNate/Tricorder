package com.luckynate.tricorder

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.location.GnssStatus
import android.location.LocationManager
import android.nfc.NfcAdapter
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

class DeviceSensorBridge(
    private val activity: Activity,
    private val sensorManager: SensorManager,
    private val locationManager: LocationManager,
    private val onCatalog: (JSONArray) -> Unit,
    private val onFrame: (JSONArray) -> Unit,
    private val onGnss: (JSONObject) -> Unit,
    private val onNfc: (JSONObject) -> Unit
) : SensorEventListener {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val latest = ConcurrentHashMap<Int, SensorEventSnapshot>()
    private var running = false
    private var gnssRegistered = false
    private val nfcAdapter: NfcAdapter? by lazy { NfcAdapter.getDefaultAdapter(activity) }

    private data class SensorEventSnapshot(
        val sensor: Sensor,
        val values: FloatArray,
        val accuracy: Int,
        val timestampNanos: Long
    )

    private val frameLoop = object : Runnable {
        override fun run() {
            if (!running) return
            emitFrame()
            mainHandler.postDelayed(this, 100L)
        }
    }

    private val gnssCallback = object : GnssStatus.Callback() {
        override fun onSatelliteStatusChanged(status: GnssStatus) {
            val satellites = JSONArray()
            var used = 0
            for (index in 0 until status.satelliteCount) {
                val inFix = status.usedInFix(index)
                if (inFix) used += 1
                satellites.put(JSONObject().apply {
                    put("svid", status.getSvid(index))
                    put("constellation", constellationName(status.getConstellationType(index)))
                    put("azimuth", status.getAzimuthDegrees(index))
                    put("elevation", status.getElevationDegrees(index))
                    put("cn0", status.getCn0DbHz(index))
                    put("usedInFix", inFix)
                    if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
                        put("hasCarrierFrequency", status.hasCarrierFrequencyHz(index))
                        if (status.hasCarrierFrequencyHz(index)) put("carrierFrequencyHz", status.getCarrierFrequencyHz(index))
                    }
                })
            }
            onGnss(JSONObject().apply {
                put("satelliteCount", status.satelliteCount)
                put("usedInFix", used)
                put("satellites", satellites)
                put("timestamp", System.currentTimeMillis())
            })
        }
    }

    fun start() {
        if (running) return
        running = true
        val sensors = sensorManager.getSensorList(Sensor.TYPE_ALL)
        sensors.forEach { sensor ->
            if (sensor.type != Sensor.TYPE_ROTATION_VECTOR) {
                sensorManager.registerListener(this, sensor, SensorManager.SENSOR_DELAY_GAME)
            }
        }
        onCatalog(catalog(sensors))
        startGnss()
        startNfc()
        mainHandler.removeCallbacks(frameLoop)
        mainHandler.post(frameLoop)
    }

    fun stop() {
        running = false
        mainHandler.removeCallbacks(frameLoop)
        sensorManager.unregisterListener(this)
        latest.clear()
        if (gnssRegistered) {
            try { locationManager.unregisterGnssStatusCallback(gnssCallback) } catch (_: Exception) {}
            gnssRegistered = false
        }
        try { nfcAdapter?.disableReaderMode(activity) } catch (_: Exception) {}
    }

    override fun onSensorChanged(event: SensorEvent?) {
        val sample = event ?: return
        latest[sample.sensor.type] = SensorEventSnapshot(
            sample.sensor,
            sample.values.copyOf(),
            sample.accuracy,
            sample.timestamp
        )
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun emitFrame() {
        if (latest.isEmpty()) return
        val frame = JSONArray()
        latest.values.sortedBy { it.sensor.type }.forEach { sample ->
            frame.put(JSONObject().apply {
                put("type", sample.sensor.type)
                put("typeName", sensorTypeName(sample.sensor.type))
                put("name", sample.sensor.name)
                put("vendor", sample.sensor.vendor)
                put("accuracy", sample.accuracy)
                put("timestampNanos", sample.timestampNanos)
                put("ageMs", ((SystemClock.elapsedRealtimeNanos() - sample.timestampNanos) / 1_000_000L).coerceAtLeast(0L))
                put("values", JSONArray().apply { sample.values.forEach { put(it.toDouble()) } })
                put("unit", unitFor(sample.sensor.type))
            })
        }
        onFrame(frame)
    }

    private fun catalog(sensors: List<Sensor>): JSONArray = JSONArray().apply {
        sensors.sortedBy { it.type }.forEach { sensor ->
            put(JSONObject().apply {
                put("type", sensor.type)
                put("typeName", sensorTypeName(sensor.type))
                put("name", sensor.name)
                put("vendor", sensor.vendor)
                put("version", sensor.version)
                put("maxRange", sensor.maximumRange)
                put("resolution", sensor.resolution)
                put("powerMa", sensor.power)
                put("minDelayUs", sensor.minDelay)
                put("unit", unitFor(sensor.type))
                put("wakeUp", if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.LOLLIPOP) sensor.isWakeUpSensor else false)
            })
        }
    }

    private fun startGnss() {
        if (activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) return
        try {
            locationManager.registerGnssStatusCallback(gnssCallback, mainHandler)
            gnssRegistered = true
        } catch (_: Exception) {}
    }

    private fun startNfc() {
        val adapter = nfcAdapter ?: return
        if (!adapter.isEnabled) return
        try {
            adapter.enableReaderMode(
                activity,
                { tag ->
                    onNfc(JSONObject().apply {
                        put("id", tag.id?.joinToString("") { byte -> "%02x".format(byte.toInt() and 0xff) } ?: "")
                        put("techList", JSONArray(tag.techList.toList()))
                        put("timestamp", System.currentTimeMillis())
                    })
                },
                NfcAdapter.FLAG_READER_NFC_A or
                    NfcAdapter.FLAG_READER_NFC_B or
                    NfcAdapter.FLAG_READER_NFC_F or
                    NfcAdapter.FLAG_READER_NFC_V or
                    NfcAdapter.FLAG_READER_NFC_BARCODE,
                null
            )
        } catch (_: Exception) {}
    }

    private fun constellationName(type: Int): String = when (type) {
        GnssStatus.CONSTELLATION_GPS -> "GPS"
        GnssStatus.CONSTELLATION_GLONASS -> "GLONASS"
        GnssStatus.CONSTELLATION_GALILEO -> "GALILEO"
        GnssStatus.CONSTELLATION_BEIDOU -> "BEIDOU"
        GnssStatus.CONSTELLATION_QZSS -> "QZSS"
        GnssStatus.CONSTELLATION_SBAS -> "SBAS"
        GnssStatus.CONSTELLATION_IRNSS -> "IRNSS"
        else -> "UNKNOWN"
    }

    private fun sensorTypeName(type: Int): String = when (type) {
        Sensor.TYPE_ACCELEROMETER -> "ACCELEROMETER"
        Sensor.TYPE_MAGNETIC_FIELD -> "MAGNETIC FIELD"
        Sensor.TYPE_GYROSCOPE -> "GYROSCOPE"
        Sensor.TYPE_LIGHT -> "AMBIENT LIGHT"
        Sensor.TYPE_PRESSURE -> "BAROMETER"
        Sensor.TYPE_PROXIMITY -> "PROXIMITY"
        Sensor.TYPE_GRAVITY -> "GRAVITY"
        Sensor.TYPE_LINEAR_ACCELERATION -> "LINEAR ACCELERATION"
        Sensor.TYPE_ROTATION_VECTOR -> "ROTATION VECTOR"
        Sensor.TYPE_RELATIVE_HUMIDITY -> "HUMIDITY"
        Sensor.TYPE_AMBIENT_TEMPERATURE -> "AMBIENT TEMPERATURE"
        Sensor.TYPE_STEP_COUNTER -> "STEP COUNTER"
        Sensor.TYPE_STEP_DETECTOR -> "STEP DETECTOR"
        Sensor.TYPE_SIGNIFICANT_MOTION -> "SIGNIFICANT MOTION"
        Sensor.TYPE_GAME_ROTATION_VECTOR -> "GAME ROTATION"
        Sensor.TYPE_GEOMAGNETIC_ROTATION_VECTOR -> "GEOMAGNETIC ROTATION"
        Sensor.TYPE_STATIONARY_DETECT -> "STATIONARY DETECT"
        Sensor.TYPE_MOTION_DETECT -> "MOTION DETECT"
        Sensor.TYPE_ACCELEROMETER_UNCALIBRATED -> "ACCELEROMETER UNCALIBRATED"
        Sensor.TYPE_GYROSCOPE_UNCALIBRATED -> "GYROSCOPE UNCALIBRATED"
        Sensor.TYPE_MAGNETIC_FIELD_UNCALIBRATED -> "MAGNETIC FIELD UNCALIBRATED"
        else -> if (type >= Sensor.TYPE_DEVICE_PRIVATE_BASE) "VENDOR SENSOR $type" else "SENSOR $type"
    }

    private fun unitFor(type: Int): String = when (type) {
        Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_GRAVITY, Sensor.TYPE_LINEAR_ACCELERATION, Sensor.TYPE_ACCELEROMETER_UNCALIBRATED -> "m/s²"
        Sensor.TYPE_MAGNETIC_FIELD, Sensor.TYPE_MAGNETIC_FIELD_UNCALIBRATED -> "µT"
        Sensor.TYPE_GYROSCOPE, Sensor.TYPE_GYROSCOPE_UNCALIBRATED -> "rad/s"
        Sensor.TYPE_LIGHT -> "lux"
        Sensor.TYPE_PRESSURE -> "hPa"
        Sensor.TYPE_PROXIMITY -> "cm"
        Sensor.TYPE_RELATIVE_HUMIDITY -> "%"
        Sensor.TYPE_AMBIENT_TEMPERATURE -> "°C"
        Sensor.TYPE_STEP_COUNTER -> "steps"
        else -> ""
    }
}
