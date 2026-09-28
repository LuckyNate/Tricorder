package com.luckynate.tricorder

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.media.MediaRouter
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.net.wifi.p2p.WifiP2pDevice
import android.net.wifi.p2p.WifiP2pDeviceList
import android.net.wifi.p2p.WifiP2pManager
import android.os.Build
import android.os.Looper
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.InetAddress
import java.net.MulticastSocket
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

class NearbyNetworkScanner(private val context: Context) {
    private data class Observation(
        val id: String,
        val name: String,
        val source: String,
        val kind: String,
        val detail: String,
        val timestampNanos: Long,
        val persistent: Boolean = false
    )

    private val observations = ConcurrentHashMap<String, Observation>()
    private val nsdManager = context.getSystemService(NsdManager::class.java)
    private val wifiManager = context.applicationContext.getSystemService(WifiManager::class.java)
    private val p2pManager = context.getSystemService(WifiP2pManager::class.java)
    private val mediaRouter = context.getSystemService(MediaRouter::class.java)
    private var p2pChannel: WifiP2pManager.Channel? = null
    private var running = false
    private var p2pReceiverRegistered = false
    private var multicastLock: WifiManager.MulticastLock? = null
    private var ssdpSocket: MulticastSocket? = null
    private var ssdpThread: Thread? = null
    private val nsdListeners = LinkedHashMap<String, NsdManager.DiscoveryListener>()

    private val p2pReceiver = object : BroadcastReceiver() {
        override fun onReceive(receiverContext: Context?, intent: Intent?) {
            if (intent?.action != WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION) return
            requestP2pPeers()
        }
    }

    private val mediaRouterCallback = object : MediaRouter.SimpleCallback() {
        override fun onRouteAdded(router: MediaRouter?, info: MediaRouter.RouteInfo?) = refreshMediaRoutes()
        override fun onRouteChanged(router: MediaRouter?, info: MediaRouter.RouteInfo?) = refreshMediaRoutes()
        override fun onRouteRemoved(router: MediaRouter?, info: MediaRouter.RouteInfo?) = refreshMediaRoutes()
    }

    fun start() {
        if (running) return
        running = true
        acquireMulticastLock()
        startNsdDiscovery()
        startSsdp()
        startP2p()
        startMediaRoutes()
    }

    fun stop() {
        running = false
        stopNsdDiscovery()
        stopSsdp()
        stopP2p()
        stopMediaRoutes()
        try { multicastLock?.release() } catch (_: Exception) {}
        multicastLock = null
    }

    fun frame(): JSONArray {
        discoverP2pPeers()
        sendSsdpSearch()

        val output = JSONArray()
        val now = SystemClock.elapsedRealtimeNanos()
        val staleBefore = now - STALE_AFTER_NANOS
        val iterator = observations.entries.iterator()
        while (iterator.hasNext()) {
            val observation = iterator.next().value
            if (!observation.persistent && observation.timestampNanos < staleBefore) {
                observations.remove(observation.id, observation)
                continue
            }

            output.put(JSONObject().apply {
                put("id", observation.id)
                put("name", observation.name)
                put("source", observation.source)
                put("kind", observation.kind)
                put("detail", observation.detail)
                put("persistent", observation.persistent)
                put("timestamp", observation.timestampNanos / 1_000_000L)
                put("ageMs", ((now - observation.timestampNanos) / 1_000_000_000L).coerceAtLeast(0L) * 1000L)
            })
        }
        return output
    }

    private fun record(id: String, name: String, source: String, kind: String, detail: String = "", persistent: Boolean = false) {
        if (!running || id.isBlank()) return
        observations[id] = Observation(
            id = id,
            name = name.ifBlank { kind },
            source = source,
            kind = kind,
            detail = detail,
            timestampNanos = SystemClock.elapsedRealtimeNanos(),
            persistent = persistent
        )
    }

    private fun acquireMulticastLock() {
        try {
            multicastLock = wifiManager?.createMulticastLock("tricorder-discovery")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
        }
    }

    private fun startNsdDiscovery() {
        val manager = nsdManager ?: return
        NSD_SERVICE_TYPES.forEach { type ->
            val listener = object : NsdManager.DiscoveryListener {
                override fun onDiscoveryStarted(serviceType: String?) {}
                override fun onStartDiscoveryFailed(serviceType: String?, errorCode: Int) {}
                override fun onStopDiscoveryFailed(serviceType: String?, errorCode: Int) {}
                override fun onDiscoveryStopped(serviceType: String?) {}
                override fun onServiceLost(serviceInfo: NsdServiceInfo?) {}
                override fun onServiceFound(serviceInfo: NsdServiceInfo?) {
                    val info = serviceInfo ?: return
                    val serviceName = info.serviceName ?: return
                    val serviceType = info.serviceType ?: type
                    record(
                        id = "mdns:${serviceType.lowercase()}:$serviceName",
                        name = serviceName,
                        source = "mdns",
                        kind = classifyService(serviceType),
                        detail = serviceType
                    )
                }
            }
            try {
                manager.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, listener)
                nsdListeners[type] = listener
            } catch (_: Exception) {
            }
        }
    }

    private fun stopNsdDiscovery() {
        val manager = nsdManager ?: return
        nsdListeners.values.forEach { listener ->
            try { manager.stopServiceDiscovery(listener) } catch (_: Exception) {}
        }
        nsdListeners.clear()
    }

    private fun classifyService(type: String): String {
        val normalized = type.lowercase()
        return when {
            "googlecast" in normalized || "airplay" in normalized || "raop" in normalized -> "cast"
            "ipp" in normalized || "printer" in normalized -> "printer"
            "spotify" in normalized -> "audio"
            "matter" in normalized || "hap" in normalized -> "smart-home"
            else -> "service"
        }
    }

    private fun startSsdp() {
        if (ssdpThread?.isAlive == true) return
        ssdpThread = thread(name = "Tricorder-SSDP", isDaemon = true) {
            try {
                val group = InetAddress.getByName(SSDP_ADDRESS)
                val socket = MulticastSocket(SSDP_PORT).apply {
                    reuseAddress = true
                    soTimeout = 1500
                    joinGroup(group)
                }
                ssdpSocket = socket
                sendSsdpSearch()
                val buffer = ByteArray(16 * 1024)
                while (running) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        socket.receive(packet)
                        parseSsdp(String(packet.data, packet.offset, packet.length, Charsets.UTF_8), packet.address?.hostAddress ?: "")
                    } catch (_: java.net.SocketTimeoutException) {
                    } catch (_: Exception) {
                    }
                }
                try { socket.leaveGroup(group) } catch (_: Exception) {}
                socket.close()
            } catch (_: Exception) {
            } finally {
                ssdpSocket = null
            }
        }
    }

    private fun stopSsdp() {
        try { ssdpSocket?.close() } catch (_: Exception) {}
        ssdpSocket = null
        ssdpThread = null
    }

    private fun sendSsdpSearch() {
        if (!running) return
        val socket = ssdpSocket ?: return
        val now = SystemClock.elapsedRealtimeNanos()
        if (lastSsdpSearchNanos != 0L && now - lastSsdpSearchNanos < SSDP_SEARCH_INTERVAL_NANOS) return
        lastSsdpSearchNanos = now
        val request = (
            "M-SEARCH * HTTP/1.1\r\n" +
                "HOST: $SSDP_ADDRESS:$SSDP_PORT\r\n" +
                "MAN: \"ssdp:discover\"\r\n" +
                "MX: 2\r\n" +
                "ST: ssdp:all\r\n\r\n"
            ).toByteArray(Charsets.UTF_8)
        try {
            val packet = DatagramPacket(request, request.size, InetAddress.getByName(SSDP_ADDRESS), SSDP_PORT)
            socket.send(packet)
        } catch (_: Exception) {
        }
    }

    @Volatile
    private var lastSsdpSearchNanos = 0L

    private fun parseSsdp(message: String, host: String) {
        val headers = LinkedHashMap<String, String>()
        message.lineSequence().drop(1).forEach { line ->
            val split = line.indexOf(':')
            if (split > 0) headers[line.substring(0, split).trim().lowercase()] = line.substring(split + 1).trim()
        }
        val usn = headers["usn"] ?: headers["location"] ?: host
        if (usn.isBlank()) return
        val st = headers["st"] ?: headers["nt"] ?: "UPnP/SSDP"
        val server = headers["server"].orEmpty()
        val location = headers["location"].orEmpty()
        val detail = listOf(st, server, location).filter { it.isNotBlank() }.joinToString(" | ")
        val friendly = when {
            server.isNotBlank() -> server.substringBefore(' ')
            host.isNotBlank() -> host
            else -> st
        }
        record("ssdp:$usn", friendly, "ssdp", "upnp", detail)
    }

    private fun startP2p() {
        val manager = p2pManager ?: return
        try {
            p2pChannel = manager.initialize(context, Looper.getMainLooper(), null)
            val filter = IntentFilter().apply {
                addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION)
                addAction(WifiP2pManager.WIFI_P2P_STATE_CHANGED_ACTION)
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                context.registerReceiver(p2pReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
            } else {
                @Suppress("DEPRECATION")
                context.registerReceiver(p2pReceiver, filter)
            }
            p2pReceiverRegistered = true
            discoverP2pPeers()
        } catch (_: Exception) {
        }
    }

    private fun stopP2p() {
        if (p2pReceiverRegistered) {
            try { context.unregisterReceiver(p2pReceiver) } catch (_: Exception) {}
            p2pReceiverRegistered = false
        }
        p2pChannel = null
    }

    private fun discoverP2pPeers() {
        val manager = p2pManager ?: return
        val channel = p2pChannel ?: return
        val now = SystemClock.elapsedRealtimeNanos()
        if (lastP2pDiscoveryNanos != 0L && now - lastP2pDiscoveryNanos < P2P_DISCOVERY_INTERVAL_NANOS) return
        lastP2pDiscoveryNanos = now
        try {
            manager.discoverPeers(channel, object : WifiP2pManager.ActionListener {
                override fun onSuccess() = requestP2pPeers()
                override fun onFailure(reason: Int) {}
            })
        } catch (_: SecurityException) {
        }
    }

    @Volatile
    private var lastP2pDiscoveryNanos = 0L

    private fun requestP2pPeers() {
        val manager = p2pManager ?: return
        val channel = p2pChannel ?: return
        try {
            manager.requestPeers(channel) { peers: WifiP2pDeviceList ->
                peers.deviceList.forEach(::recordP2pDevice)
            }
        } catch (_: SecurityException) {
        }
    }

    private fun recordP2pDevice(device: WifiP2pDevice) {
        val address = device.deviceAddress ?: return
        record(
            id = "p2p:${address.lowercase()}",
            name = device.deviceName ?: "Wi-Fi Direct device",
            source = "wifi-direct",
            kind = "peer",
            detail = "status=${device.status}"
        )
    }

    private fun startMediaRoutes() {
        val router = mediaRouter ?: return
        try {
            router.addCallback(MEDIA_ROUTE_TYPES, mediaRouterCallback, MediaRouter.CALLBACK_FLAG_PERFORM_ACTIVE_SCAN)
            refreshMediaRoutes()
        } catch (_: Exception) {
        }
    }

    private fun stopMediaRoutes() {
        try { mediaRouter?.removeCallback(mediaRouterCallback) } catch (_: Exception) {}
    }

    private fun refreshMediaRoutes() {
        val router = mediaRouter ?: return
        try {
            val defaultRoute = router.defaultRoute
            val currentIds = HashSet<String>()
            for (i in 0 until router.routeCount) {
                val route = router.getRouteAt(i)
                if (route == defaultRoute) continue
                val name = route.getName(context)?.toString() ?: "Media route"
                val description = route.description?.toString().orEmpty()
                val hasVideo = (route.supportedTypes and MediaRouter.ROUTE_TYPE_LIVE_VIDEO) != 0
                val id = "media:${name.lowercase()}:${route.supportedTypes}"
                currentIds.add(id)
                if (observations[id]?.detail == description) continue
                record(
                    id = id,
                    name = name,
                    source = "media-route",
                    kind = if (hasVideo) "cast" else "media",
                    detail = description,
                    persistent = true
                )
            }
            observations.keys.filter { it.startsWith("media:") && it !in currentIds }.forEach { observations.remove(it) }
        } catch (_: Exception) {
        }
    }

    companion object {
        private const val SSDP_ADDRESS = "239.255.255.250"
        private const val SSDP_PORT = 1900
        private const val STALE_AFTER_NANOS = 90_000_000_000L
        private const val SSDP_SEARCH_INTERVAL_NANOS = 10_000_000_000L
        private const val P2P_DISCOVERY_INTERVAL_NANOS = 15_000_000_000L
        private val MEDIA_ROUTE_TYPES = MediaRouter.ROUTE_TYPE_LIVE_AUDIO or MediaRouter.ROUTE_TYPE_LIVE_VIDEO

        private val NSD_SERVICE_TYPES = listOf(
            "_googlecast._tcp.",
            "_airplay._tcp.",
            "_raop._tcp.",
            "_spotify-connect._tcp.",
            "_ipp._tcp.",
            "_printer._tcp.",
            "_http._tcp.",
            "_https._tcp.",
            "_hap._tcp.",
            "_matter._tcp.",
            "_matterc._udp.",
            "_matterd._udp."
        )
    }
}
