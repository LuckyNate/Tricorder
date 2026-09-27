package com.luckynate.tricorder

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothClass
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.location.Location
import android.os.Build
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject

class BluetoothScanner(private val context: Context) {
    private data class Observation(
        val address: String,
        val name: String,
        val rssi: Int?,
        val timestampNanos: Long,
        val source: String,
        val confirmedNearby: Boolean
    )

    private val bluetoothManager = context.getSystemService(BluetoothManager::class.java)
    private val latest = LinkedHashMap<String, Observation>()
    private var bleScanning = false
    private var running = false
    private var classicReceiverRegistered = false

    private val bleCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            recordBle(result)
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            results.forEach(::recordBle)
        }
    }

    private val classicReceiver = object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context?, intent: Intent?) {
            when (intent?.action) {
                BluetoothDevice.ACTION_FOUND -> recordClassic(intent)
                BluetoothAdapter.ACTION_DISCOVERY_FINISHED -> if (running) ensureClassicDiscovery()
            }
        }
    }

    fun hasPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            context.checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN) == PackageManager.PERMISSION_GRANTED &&
                context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED
        } else {
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
                context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }
    }

    fun start() {
        if (running || !hasPermission()) return
        val adapter = bluetoothManager?.adapter ?: return
        if (!adapter.isEnabled) return

        running = true
        registerClassicReceiver()
        refreshBondedDevices(adapter)
        startBle(adapter)
        ensureClassicDiscovery()
    }

    fun stop() {
        running = false
        stopBle()

        try {
            bluetoothManager?.adapter?.takeIf { it.isDiscovering }?.cancelDiscovery()
        } catch (_: SecurityException) {
        }

        if (classicReceiverRegistered) {
            try {
                context.unregisterReceiver(classicReceiver)
            } catch (_: Exception) {
            }
            classicReceiverRegistered = false
        }
    }

    fun frame(
        location: Location?,
        heading: Float?,
        headingAccuracy: Int,
        headingSource: String
    ): JSONArray {
        val adapter = bluetoothManager?.adapter
        if (running && adapter != null) {
            refreshBondedDevices(adapter)
            startBle(adapter)
            ensureClassicDiscovery()
        }

        val output = JSONArray()
        val now = SystemClock.elapsedRealtimeNanos()
        val staleBefore = now - 30_000_000_000L

        val iterator = latest.entries.iterator()
        while (iterator.hasNext()) {
            val observation = iterator.next().value
            if (observation.source != SOURCE_BONDED && observation.timestampNanos < staleBefore) {
                iterator.remove()
                continue
            }

            val sampleLocation = location ?: continue
            output.put(JSONObject().apply {
                put("address", observation.address)
                put("name", observation.name)
                observation.rssi?.let { put("rssi", it) }
                put("timestamp", observation.timestampNanos / 1_000_000L)
                put("source", observation.source)
                put("confirmedNearby", observation.confirmedNearby)
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

    private fun registerClassicReceiver() {
        if (classicReceiverRegistered) return
        val filter = IntentFilter().apply {
            addAction(BluetoothDevice.ACTION_FOUND)
            addAction(BluetoothAdapter.ACTION_DISCOVERY_FINISHED)
        }
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(classicReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                context.registerReceiver(classicReceiver, filter)
            }
            classicReceiverRegistered = true
        } catch (_: Exception) {
        }
    }

    private fun startBle(adapter: BluetoothAdapter) {
        if (bleScanning || !running || !hasPermission()) return
        val scanner = adapter.bluetoothLeScanner ?: return
        val settings = ScanSettings.Builder()
            .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
            .build()
        try {
            scanner.startScan(null, settings, bleCallback)
            bleScanning = true
        } catch (_: SecurityException) {
        }
    }

    private fun stopBle() {
        if (!bleScanning || !hasPermission()) {
            bleScanning = false
            return
        }
        try {
            bluetoothManager?.adapter?.bluetoothLeScanner?.stopScan(bleCallback)
        } catch (_: SecurityException) {
        }
        bleScanning = false
    }

    private fun ensureClassicDiscovery() {
        if (!running || !hasPermission()) return
        val adapter = bluetoothManager?.adapter ?: return
        if (!adapter.isEnabled || adapter.isDiscovering) return
        try {
            adapter.startDiscovery()
        } catch (_: SecurityException) {
        }
    }

    private fun refreshBondedDevices(adapter: BluetoothAdapter) {
        if (!hasPermission()) return
        try {
            adapter.bondedDevices.orEmpty().forEach { device ->
                val name = device.name ?: "Bluetooth"
                if (isAutomotive(device, name)) return@forEach
                val address = device.address?.lowercase() ?: return@forEach
                val previous = latest[address]
                latest[address] = Observation(
                    address = address,
                    name = name,
                    rssi = previous?.rssi,
                    timestampNanos = previous?.timestampNanos ?: SystemClock.elapsedRealtimeNanos(),
                    source = previous?.source?.takeIf { it != SOURCE_BONDED } ?: SOURCE_BONDED,
                    confirmedNearby = previous?.confirmedNearby ?: false
                )
            }
        } catch (_: SecurityException) {
        }
    }

    private fun recordBle(result: ScanResult) {
        if (!hasPermission()) return
        try {
            val device = result.device ?: return
            val name = result.scanRecord?.deviceName ?: device.name ?: "Bluetooth"
            if (isAutomotive(device, name)) return
            val address = device.address?.lowercase() ?: return
            latest[address] = Observation(
                address = address,
                name = name,
                rssi = result.rssi,
                timestampNanos = result.timestampNanos,
                source = SOURCE_BLE,
                confirmedNearby = true
            )
        } catch (_: SecurityException) {
        }
    }

    private fun recordClassic(intent: Intent) {
        if (!hasPermission()) return
        try {
            val device = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE, BluetoothDevice::class.java)
            } else {
                @Suppress("DEPRECATION")
                intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE)
            } ?: return

            val name = device.name ?: "Bluetooth"
            if (isAutomotive(device, name)) return
            val address = device.address?.lowercase() ?: return
            val rssi = if (intent.hasExtra(BluetoothDevice.EXTRA_RSSI)) {
                intent.getShortExtra(BluetoothDevice.EXTRA_RSSI, Short.MIN_VALUE)
                    .takeIf { it != Short.MIN_VALUE }
                    ?.toInt()
            } else {
                null
            }

            latest[address] = Observation(
                address = address,
                name = name,
                rssi = rssi,
                timestampNanos = SystemClock.elapsedRealtimeNanos(),
                source = SOURCE_CLASSIC,
                confirmedNearby = true
            )
        } catch (_: SecurityException) {
        }
    }

    private fun isAutomotive(device: BluetoothDevice, name: String): Boolean {
        try {
            if (device.bluetoothClass?.deviceClass == BluetoothClass.Device.AUDIO_VIDEO_CAR_AUDIO) return true
            val normalized = name.lowercase()
            return normalized.isNotBlank() && AUTOMOTIVE_NAME_HINTS.any { hint -> normalized.contains(hint) }
        } catch (_: SecurityException) {
            return false
        }
    }

    companion object {
        private const val SOURCE_BLE = "ble"
        private const val SOURCE_CLASSIC = "classic"
        private const val SOURCE_BONDED = "bonded"

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
