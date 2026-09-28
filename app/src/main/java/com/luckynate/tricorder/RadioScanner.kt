package com.luckynate.tricorder

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.net.wifi.ScanResult
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.rtt.RangingRequest
import android.net.wifi.rtt.RangingResult
import android.net.wifi.rtt.RangingResultCallback
import android.net.wifi.rtt.WifiRttManager
import android.os.SystemClock
import android.telephony.CellInfo
import android.telephony.CellInfoCdma
import android.telephony.CellInfoGsm
import android.telephony.CellInfoLte
import android.telephony.CellInfoNr
import android.telephony.CellInfoTdscdma
import android.telephony.CellInfoWcdma
import android.telephony.TelephonyManager
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap

class RadioScanner(private val context: Context) {
    data class ObserverPose(
        val latitude: Double?,
        val longitude: Double?,
        val accuracy: Float?
    )

    private data class RttObservation(
        val bssid: String,
        val distanceMeters: Double,
        val stdDevMeters: Double,
        val rssi: Int,
        val timestampNanos: Long,
        val pose: ObserverPose?
    )

    private val packageManager = context.packageManager
    private val wifiRttManager = context.getSystemService(WifiRttManager::class.java)
    private val wifiAwareManager = context.getSystemService(WifiAwareManager::class.java)
    private val telephonyManager = context.getSystemService(TelephonyManager::class.java)
    private val latestRtt = ConcurrentHashMap<String, RttObservation>()
    private val latestCells = ConcurrentHashMap<String, JSONObject>()

    @Volatile private var running = false
    @Volatile private var rttInFlight = false
    @Volatile private var cellInFlight = false
    @Volatile private var lastRttRequestNanos = 0L
    @Volatile private var lastCellRequestNanos = 0L

    fun start() {
        running = true
        requestCellUpdateIfDue()
    }

    fun stop() {
        running = false
        rttInFlight = false
        cellInFlight = false
    }

    fun frame(scanResults: List<ScanResult>, pose: ObserverPose?): JSONObject {
        if (running) {
            requestRttIfDue(scanResults, pose)
            requestCellUpdateIfDue()
        }
        return JSONObject().apply {
            put("rtt", rttFrame())
            put("cellular", cellularFrame())
            put("capabilities", capabilities())
        }
    }

    private fun requestRttIfDue(scanResults: List<ScanResult>, pose: ObserverPose?) {
        if (!running || rttInFlight || !hasNearbyWifiPermission()) return
        val manager = wifiRttManager ?: return
        if (!manager.isAvailable) return

        val now = SystemClock.elapsedRealtimeNanos()
        if (lastRttRequestNanos != 0L && now - lastRttRequestNanos < RTT_INTERVAL_NANOS) return

        val responders = scanResults
            .filter { it.is80211mcResponder }
            .sortedByDescending { it.level }
            .take(RangingRequest.getMaxPeers())
        if (responders.isEmpty()) return

        val request = RangingRequest.Builder().addAccessPoints(responders).build()
        lastRttRequestNanos = now
        rttInFlight = true
        try {
            manager.startRanging(request, context.mainExecutor, object : RangingResultCallback() {
                override fun onRangingFailure(code: Int) {
                    rttInFlight = false
                }

                override fun onRangingResults(results: MutableList<RangingResult>) {
                    val capturedAt = SystemClock.elapsedRealtimeNanos()
                    results.forEach { result ->
                        if (result.status != RangingResult.STATUS_SUCCESS) return@forEach
                        val bssid = result.macAddress?.toString()?.lowercase() ?: return@forEach
                        latestRtt[bssid] = RttObservation(
                            bssid = bssid,
                            distanceMeters = result.distanceMm / 1000.0,
                            stdDevMeters = result.distanceStdDevMm / 1000.0,
                            rssi = result.rssi,
                            timestampNanos = capturedAt,
                            pose = pose
                        )
                    }
                    rttInFlight = false
                }
            })
        } catch (_: SecurityException) {
            rttInFlight = false
        } catch (_: Exception) {
            rttInFlight = false
        }
    }

    private fun rttFrame(): JSONArray {
        val output = JSONArray()
        val now = SystemClock.elapsedRealtimeNanos()
        latestRtt.entries.removeIf { now - it.value.timestampNanos > RTT_STALE_NANOS }
        latestRtt.values.sortedBy { it.bssid }.forEach { observation ->
            output.put(JSONObject().apply {
                put("bssid", observation.bssid)
                put("distanceMeters", observation.distanceMeters)
                put("distanceStdDevMeters", observation.stdDevMeters)
                put("rssi", observation.rssi)
                put("timestamp", observation.timestampNanos / 1_000_000L)
                put("ageMs", ((now - observation.timestampNanos) / 1_000_000L).coerceAtLeast(0L))
                observation.pose?.let { pose ->
                    pose.latitude?.let { put("latitude", it) }
                    pose.longitude?.let { put("longitude", it) }
                    pose.accuracy?.let { put("accuracy", it) }
                }
            })
        }
        return output
    }

    private fun requestCellUpdateIfDue() {
        if (!running || cellInFlight || !hasFineLocationPermission()) return
        val manager = telephonyManager ?: return
        if (!packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY_RADIO_ACCESS)) return

        val now = SystemClock.elapsedRealtimeNanos()
        if (lastCellRequestNanos != 0L && now - lastCellRequestNanos < CELL_INTERVAL_NANOS) return
        lastCellRequestNanos = now
        cellInFlight = true
        try {
            manager.requestCellInfoUpdate(context.mainExecutor, object : TelephonyManager.CellInfoCallback() {
                override fun onCellInfo(cellInfo: MutableList<CellInfo>) {
                    recordCells(cellInfo)
                    cellInFlight = false
                }

                override fun onError(errorCode: Int, detail: Throwable?) {
                    cellInFlight = false
                }
            })
        } catch (_: SecurityException) {
            cellInFlight = false
        } catch (_: UnsupportedOperationException) {
            cellInFlight = false
        } catch (_: Exception) {
            cellInFlight = false
        }
    }

    private fun recordCells(cells: List<CellInfo>) {
        val now = SystemClock.elapsedRealtimeNanos()
        val seen = HashSet<String>()
        cells.forEach { cell ->
            val row = cellToJson(cell, now) ?: return@forEach
            val id = row.optString("id")
            if (id.isBlank()) return@forEach
            seen.add(id)
            latestCells[id] = row
        }
        latestCells.keys.filter { it !in seen }.forEach { latestCells.remove(it) }
    }

    private fun cellToJson(cell: CellInfo, now: Long): JSONObject? {
        val row = JSONObject()
        val id: String
        val technology: String
        val dbm: Int

        when (cell) {
            is CellInfoLte -> {
                val identity = cell.cellIdentity
                technology = "LTE"
                id = "lte:${identity.mccString.orEmpty()}:${identity.mncString.orEmpty()}:${identity.tac}:${identity.ci}"
                dbm = cell.cellSignalStrength.dbm
                row.put("pci", identity.pci)
                row.put("tac", identity.tac)
                row.put("cellId", identity.ci)
            }
            is CellInfoNr -> {
                val identity = cell.cellIdentity
                technology = "NR"
                id = "nr:${identity.mccString.orEmpty()}:${identity.mncString.orEmpty()}:${identity.tac}:${identity.nci}"
                dbm = cell.cellSignalStrength.dbm
                row.put("pci", identity.pci)
                row.put("tac", identity.tac)
                row.put("cellId", identity.nci)
            }
            is CellInfoWcdma -> {
                val identity = cell.cellIdentity
                technology = "WCDMA"
                id = "wcdma:${identity.mccString.orEmpty()}:${identity.mncString.orEmpty()}:${identity.lac}:${identity.cid}"
                dbm = cell.cellSignalStrength.dbm
                row.put("psc", identity.psc)
                row.put("lac", identity.lac)
                row.put("cellId", identity.cid)
            }
            is CellInfoTdscdma -> {
                val identity = cell.cellIdentity
                technology = "TD-SCDMA"
                id = "tdscdma:${identity.mccString.orEmpty()}:${identity.mncString.orEmpty()}:${identity.lac}:${identity.cid}"
                dbm = cell.cellSignalStrength.dbm
                row.put("cpid", identity.cpid)
                row.put("lac", identity.lac)
                row.put("cellId", identity.cid)
            }
            is CellInfoGsm -> {
                val identity = cell.cellIdentity
                technology = "GSM"
                id = "gsm:${identity.mccString.orEmpty()}:${identity.mncString.orEmpty()}:${identity.lac}:${identity.cid}"
                dbm = cell.cellSignalStrength.dbm
                row.put("arfcn", identity.arfcn)
                row.put("lac", identity.lac)
                row.put("cellId", identity.cid)
            }
            is CellInfoCdma -> {
                val identity = cell.cellIdentity
                technology = "CDMA"
                id = "cdma:${identity.systemId}:${identity.networkId}:${identity.basestationId}"
                dbm = cell.cellSignalStrength.dbm
                row.put("systemId", identity.systemId)
                row.put("networkId", identity.networkId)
                row.put("cellId", identity.basestationId)
            }
            else -> return null
        }

        row.put("id", id)
        row.put("technology", technology)
        row.put("name", "$technology cell")
        row.put("dbm", dbm)
        row.put("registered", cell.isRegistered)
        row.put("connectionStatus", cell.cellConnectionStatus)
        row.put("timestamp", now / 1_000_000L)
        row.put("ageMs", 0)
        return row
    }

    private fun cellularFrame(): JSONArray {
        val output = JSONArray()
        latestCells.values
            .sortedWith(compareByDescending<JSONObject> { it.optBoolean("registered") }.thenByDescending { it.optInt("dbm", -200) })
            .forEach(output::put)
        return output
    }

    private fun capabilities(): JSONObject {
        val rttSupported = packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_RTT)
        val awareSupported = packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)
        val uwbSupported = packageManager.hasSystemFeature(PackageManager.FEATURE_UWB)
        val cellularSupported = packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY_RADIO_ACCESS)
        return JSONObject().apply {
            put("wifiRttSupported", rttSupported)
            put("wifiRttAvailable", rttSupported && (wifiRttManager?.isAvailable == true))
            put("wifiAwareSupported", awareSupported)
            put("wifiAwareAvailable", awareSupported && (wifiAwareManager?.isAvailable == true))
            put("uwbSupported", uwbSupported)
            put("cellularSupported", cellularSupported)
            put("wifiAwareMode", "peer-session-required")
            put("uwbMode", "peer-session-required")
        }
    }

    private fun hasNearbyWifiPermission(): Boolean {
        return context.checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED
    }

    private fun hasFineLocationPermission(): Boolean {
        return context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    companion object {
        private const val RTT_INTERVAL_NANOS = 2_000_000_000L
        private const val RTT_STALE_NANOS = 15_000_000_000L
        private const val CELL_INTERVAL_NANOS = 10_000_000_000L
    }
}
