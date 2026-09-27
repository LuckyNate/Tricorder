package com.luckynate.tricorder

import android.Manifest
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.SensorManager
import android.location.Location
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

class BluetoothScanner(private val context: Context) {
    private data class Observation(
        val address: String,
        val name: String,
        val rssi: Int,
        val timestampNanos: Long
    )

    private val bluetoothManager = context.getSystemService(BluetoothManager::class.java)
    private val latest = LinkedHashMap<String, Observation>()
    private var scanning = false

    private val callback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            record(result)
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            results.forEach(::record)
        }
    }

    fun hasPermission(): Boolean {
        return context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
            context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
    }

    fun start() {
        if (scanning || !hasPermission()) return
        val adapter = bluetoothManager?.adapter ?: return
        if (!adapter.isEnabled) return
        val scanner = adapter.bluetoothLeScanner ?: return
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        try {
            scanner.startScan(null, settings, callback)
            scanning = true
        } catch (_: SecurityException) {
        }
    }

    fun stop() {
        if (!scanning || !hasPermission()) {
            scanning = false
            return
        }
        try {
            bluetoothManager?.adapter?.bluetoothLeScanner?.stopScan(callback)
        } catch (_: SecurityException) {
        }
        scanning = false
    }

    fun frame(
        location: Location?,
        heading: Float?,
        headingAccuracy: Int,
        headingSource: String
    ): JSONArray {
        val output = JSONArray()
        val now = SystemClock.elapsedRealtimeNanos()
        val staleBefore = now - 30_000_000_000L

        val iterator = latest.entries.iterator()
        while (iterator.hasNext()) {
            val observation = iterator.next().value
            if (observation.timestampNanos < staleBefore) {
                iterator.remove()
                continue
            }

            val sampleLocation = location ?: continue
            output.put(JSONObject().apply {
                put("address", observation.address)
                put("name", observation.name)
                put("rssi", observation.rssi)
                put("timestamp", observation.timestampNanos / 1_000_000L)
                put("latitude", sampleLocation.latitude)
                put("longitude", sampleLocation.longitude)
                put("accuracy", sampleLocation.accuracy)
                heading?.let { put("heading", it) }
                put("headingSource", headingSource)
                put("headingAccuracy", headingAccuracy)
            })
        }

        return output
    }

    private fun record(result: ScanResult) {
        if (!hasPermission() || isAutomotive(result)) return

        try {
            val device = result.device ?: return
            val address = device.address ?: return
            val name = result.scanRecord?.deviceName ?: device.name ?: "Bluetooth"
            latest[address.lowercase()] = Observation(
                address = address.lowercase(),
                name = name,
                rssi = result.rssi,
                timestampNanos = result.timestampNanos
            )
        } catch (_: SecurityException) {
        }
    }

    private fun isAutomotive(result: ScanResult): Boolean {
        try {
            val deviceClass = result.device?.bluetoothClass?.deviceClass
            if (deviceClass == BluetoothClass.Device.AUDIO_VIDEO_CAR_AUDIO) return true

            val name = (result.scanRecord?.deviceName ?: result.device?.name ?: "").lowercase()
            if (name.isBlank()) return false

            return AUTOMOTIVE_NAME_HINTS.any { hint -> name.contains(hint) }
        } catch (_: SecurityException) {
            return false
        }
    }

    companion object {
        private val AUTOMOTIVE_NAME_HINTS = listOf(
            "android auto",
            "carplay",
            "car audio",
            "hands-free",
            "handsfree",
            "infotainment",
            "vehicle",
            "uconnect",
            "mylink"
        )
    }
}
