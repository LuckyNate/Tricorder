package com.luckynate.tricorder

import android.Manifest
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.wifi.aware.AttachCallback
import android.net.wifi.aware.DiscoverySessionCallback
import android.net.wifi.aware.PeerHandle
import android.net.wifi.aware.PublishConfig
import android.net.wifi.aware.PublishDiscoverySession
import android.net.wifi.aware.SubscribeConfig
import android.net.wifi.aware.SubscribeDiscoverySession
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.aware.WifiAwareSession
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pManager
import android.net.wifi.p2p.nsd.WifiP2pDnsSdServiceRequest
import android.net.wifi.rtt.WifiRttManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONArray
import org.json.JSONObject

class WifiPeerScanner(
    private val context: Context,
    private val emit: (String) -> Unit
) {
    private val handler = Handler(Looper.getMainLooper())
    private val p2pManager = context.getSystemService(Context.WIFI_P2P_SERVICE) as? WifiP2pManager
    private val p2pChannel = p2pManager?.initialize(context, Looper.getMainLooper(), null)
    private val awareManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.getSystemService(Context.WIFI_AWARE_SERVICE) as? WifiAwareManager
    } else null
    private val rttManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
        context.getSystemService(Context.WIFI_RTT_RANGING_SERVICE) as? WifiRttManager
    } else null

    private val peers = LinkedHashMap<String, JSONObject>()
    private val services = LinkedHashMap<String, JSONObject>()
    private val awarePeers = LinkedHashMap<String, JSONObject>()
    private var receiverRegistered = false
    private var running = false
    private var awareSession: WifiAwareSession? = null
    private var publishSession: PublishDiscoverySession? = null
    private var subscribeSession: SubscribeDiscoverySession? = null

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context?, intent: Intent?) {
            when (intent?.action) {
                WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION -> requestPeers()
                WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION -> emitFrame()
            }
        }
    }

    fun start() {
        if (running) return
        running = true
        startP2p()
        startAware()
        emitFrame()
    }

    fun stop() {
        running = false
        try { p2pManager?.stopPeerDiscovery(p2pChannel, null) } catch (_: Exception) {}
        try { p2pManager?.clearServiceRequests(p2pChannel, null) } catch (_: Exception) {}
        if (receiverRegistered) {
            try { context.unregisterReceiver(receiver) } catch (_: Exception) {}
            receiverRegistered = false
        }
        publishSession?.close()
        subscribeSession?.close()
        awareSession?.close()
        publishSession = null
        subscribeSession = null
        awareSession = null
    }

    private fun hasWifiPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            context.checkSelfPermission(Manifest.permission.NEARBY_WIFI_DEVICES) == PackageManager.PERMISSION_GRANTED
        } else {
            context.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
        }
    }

    private fun startP2p() {
        val manager = p2pManager ?: return
        val channel = p2pChannel ?: return
        if (!hasWifiPermission()) return

        if (!receiverRegistered) {
            val filter = IntentFilter().apply {
                addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
                addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    context.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
                } else {
                    @Suppress("DEPRECATION")
                    context.registerReceiver(receiver, filter)
                }
                receiverRegistered = true
            } catch (_: Exception) {}
        }

        try {
            manager.setDnsSdResponseListeners(
                channel,
                WifiP2pManager.DnsSdServiceResponseListener { instanceName, registrationType, device ->
                    val id = peerId(device)
                    val key = "$id:$registrationType:$instanceName"
                    services[key] = JSONObject().apply {
                        put("id", key)
                        put("peerId", id)
                        put("name", instanceName)
                        put("type", registrationType)
                        put("deviceName", device.deviceName ?: "Wi-Fi Direct peer")
                        put("timestamp", System.currentTimeMillis())
                    }
                    emitFrame()
                },
                WifiP2pManager.DnsSdTxtRecordListener { fullDomain, record, device ->
                    val id = peerId(device)
                    val key = "$id:$fullDomain"
                    services[key] = JSONObject().apply {
                        put("id", key)
                        put("peerId", id)
                        put("name", fullDomain)
                        put("type", "dns-sd")
                        put("deviceName", device.deviceName ?: "Wi-Fi Direct peer")
                        put("txt", JSONObject(record ?: emptyMap<String, String>()))
                        put("timestamp", System.currentTimeMillis())
                    }
                    emitFrame()
                }
            )
            manager.clearServiceRequests(channel, object : WifiP2pManager.ActionListener {
                override fun onSuccess() {
                    try {
                        val request = WifiP2pDnsSdServiceRequest.newInstance()
                        manager.addServiceRequest(channel, request, object : WifiP2pManager.ActionListener {
                            override fun onSuccess() {
                                try { manager.discoverServices(channel, null) } catch (_: Exception) {}
                            }
                            override fun onFailure(reason: Int) {}
                        })
                    } catch (_: Exception) {}
                }
                override fun onFailure(reason: Int) {}
            })
            manager.discoverPeers(channel, object : WifiP2pManager.ActionListener {
                override fun onSuccess() { requestPeers() }
                override fun onFailure(reason: Int) { emitFrame() }
            })
        } catch (_: SecurityException) {}
    }

    private fun requestPeers() {
        val manager = p2pManager ?: return
        val channel = p2pChannel ?: return
        if (!hasWifiPermission()) return
        try {
            manager.requestPeers(channel) { list ->
                peers.clear()
                list.deviceList.forEach { device ->
                    val id = peerId(device)
                    peers[id] = JSONObject().apply {
                        put("id", id)
                        put("name", device.deviceName?.takeIf { it.isNotBlank() } ?: "Wi-Fi Direct peer")
                        put("status", p2pStatus(device.status))
                        put("primaryDeviceType", device.primaryDeviceType ?: "")
                        put("secondaryDeviceType", device.secondaryDeviceType ?: "")
                        put("timestamp", System.currentTimeMillis())
                    }
                }
                emitFrame()
            }
        } catch (_: SecurityException) {}
    }

    private fun peerId(device: WifiP2pDevice): String {
        val address = try { device.deviceAddress } catch (_: Exception) { null }
        return address?.takeIf { it.isNotBlank() } ?: "p2p-${device.hashCode().toUInt().toString(16)}"
    }

    private fun p2pStatus(status: Int): String = when (status) {
        WifiP2pDevice.CONNECTED -> "connected"
        WifiP2pDevice.INVITED -> "invited"
        WifiP2pDevice.FAILED -> "failed"
        WifiP2pDevice.AVAILABLE -> "available"
        WifiP2pDevice.UNAVAILABLE -> "unavailable"
        else -> "unknown"
    }

    private fun startAware() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !hasWifiPermission()) return
        val manager = awareManager ?: return
        if (!manager.isAvailable) return
        try {
            manager.attach(object : AttachCallback() {
                override fun onAttached(session: WifiAwareSession) {
                    if (!running) {
                        session.close()
                        return
                    }
                    awareSession = session
                    startAwarePublish(session)
                    startAwareSubscribe(session)
                    emitFrame()
                }

                override fun onAttachFailed() {
                    emitFrame()
                }
            }, handler)
        } catch (_: SecurityException) {}
    }

    private fun startAwarePublish(session: WifiAwareSession) {
        val config = PublishConfig.Builder()
            .setServiceName(AWARE_SERVICE)
            .setPublishType(PublishConfig.PUBLISH_TYPE_UNSOLICITED)
            .setServiceSpecificInfo("Tricorder".toByteArray())
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && rttManager?.isAvailable == true) {
                    setRangingEnabled(true)
                }
            }
            .build()
        try {
            session.publish(config, object : DiscoverySessionCallback() {
                override fun onPublishStarted(session: PublishDiscoverySession) {
                    publishSession = session
                    emitFrame()
                }
            }, handler)
        } catch (_: SecurityException) {}
    }

    private fun startAwareSubscribe(session: WifiAwareSession) {
        val builder = SubscribeConfig.Builder()
            .setServiceName(AWARE_SERVICE)
            .setSubscribeType(SubscribeConfig.SUBSCRIBE_TYPE_PASSIVE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && rttManager?.isAvailable == true) {
            @Suppress("DEPRECATION")
            builder.setMaxDistanceMm(AWARE_RANGE_MM)
        }
        val config = builder.build()
        try {
            session.subscribe(config, object : DiscoverySessionCallback() {
                override fun onSubscribeStarted(session: SubscribeDiscoverySession) {
                    subscribeSession = session
                    emitFrame()
                }

                override fun onServiceDiscovered(
                    peerHandle: PeerHandle,
                    serviceSpecificInfo: ByteArray,
                    matchFilter: List<ByteArray>
                ) {
                    recordAware(peerHandle, null, serviceSpecificInfo)
                }

                override fun onServiceDiscoveredWithinRange(
                    peerHandle: PeerHandle,
                    serviceSpecificInfo: ByteArray,
                    matchFilter: List<ByteArray>,
                    distanceMm: Int
                ) {
                    recordAware(peerHandle, distanceMm, serviceSpecificInfo)
                }
            }, handler)
        } catch (_: SecurityException) {}
    }

    private fun recordAware(peerHandle: PeerHandle, distanceMm: Int?, info: ByteArray) {
        val id = "aware-${peerHandle.hashCode().toUInt().toString(16)}"
        awarePeers[id] = JSONObject().apply {
            put("id", id)
            put("name", info.toString(Charsets.UTF_8).ifBlank { "Wi-Fi Aware peer" })
            if (distanceMm != null && distanceMm >= 0) put("distanceMeters", distanceMm / 1000.0)
            put("timestamp", System.currentTimeMillis())
        }
        emitFrame()
    }

    private fun emitFrame() {
        if (!running) return
        val payload = JSONObject().apply {
            put("p2pSupported", p2pManager != null)
            put("awareSupported", awareManager != null)
            put("awareAvailable", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) awareManager?.isAvailable == true else false)
            put("rttAvailable", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) rttManager?.isAvailable == true else false)
            put("permission", hasWifiPermission())
            put("peers", JSONArray(peers.values.toList()))
            put("services", JSONArray(services.values.toList()))
            put("aware", JSONArray(awarePeers.values.toList()))
        }
        emit(payload.toString())
    }

    companion object {
        private const val AWARE_SERVICE = "tricorder-presence"
        private const val AWARE_RANGE_MM = 100_000
    }
}
