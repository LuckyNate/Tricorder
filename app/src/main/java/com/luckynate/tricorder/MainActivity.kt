package com.luckynate.tricorder

import android.Manifest
import android.app.Activity
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient

class MainActivity : Activity(), LocationListener {
    private lateinit var webView: WebView
    private lateinit var locationManager: LocationManager

    companion object {
        private const val LOCATION_REQUEST = 1001
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
        requestLocationImmediately()
    }

    private fun requestLocationImmediately() {
        val fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)

        if (fine != PackageManager.PERMISSION_GRANTED && coarse != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(
                arrayOf(
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
                ),
                LOCATION_REQUEST
            )
        } else {
            startLocationUpdates()
        }
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == LOCATION_REQUEST) {
            if (grantResults.any { it == PackageManager.PERMISSION_GRANTED }) {
                startLocationUpdates()
            } else {
                sendStatus("Location permission denied")
            }
        }
    }

    private fun startLocationUpdates() {
        val fine = checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        val coarse = checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
        if (fine != PackageManager.PERMISSION_GRANTED && coarse != PackageManager.PERMISSION_GRANTED) return

        sendStatus("Finding location")

        listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER).forEach { provider ->
            try {
                if (locationManager.isProviderEnabled(provider)) {
                    locationManager.getLastKnownLocation(provider)?.let(::sendLocation)
                    locationManager.requestLocationUpdates(provider, 1000L, 1f, this)
                }
            } catch (_: Exception) {
            }
        }
    }

    override fun onLocationChanged(location: Location) {
        sendLocation(location)
    }

    override fun onProviderEnabled(provider: String) {
        startLocationUpdates()
    }

    override fun onProviderDisabled(provider: String) {
        sendStatus("Waiting for location service")
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
        if (::locationManager.isInitialized) requestLocationImmediately()
    }

    override fun onPause() {
        super.onPause()
        if (::locationManager.isInitialized) {
            try {
                locationManager.removeUpdates(this)
            } catch (_: Exception) {
            }
        }
    }
}
