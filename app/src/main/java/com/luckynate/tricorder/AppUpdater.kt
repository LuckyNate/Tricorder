package com.luckynate.tricorder

import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

class AppUpdater(
    context: Context,
    private val status: (String) -> Unit
) {
    private val appContext = context.applicationContext
    private val downloadManager = appContext.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
    private val handler = Handler(Looper.getMainLooper())
    private val prefs = appContext.getSharedPreferences("tricorder-updater", Context.MODE_PRIVATE)

    private var receiverRegistered = false
    private var lastCheckAt = 0L

    companion object {
        private const val UPDATE_API_URL = "https://api.github.com/repos/LuckyNate/Tricorder/releases/tags/latest"
        private const val CHECK_THROTTLE_MS = 30_000L
        private const val PREF_DOWNLOAD_ID = "downloadId"
        private const val PREF_VERSION_CODE = "versionCode"
        private const val PREF_FILE_NAME = "fileName"
        private val VERSION_CODE_PATTERN = Regex("(?m)^versionCode=(\\d+)\\s*$")
    }

    private val downloadReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) {
            if (intent?.action != DownloadManager.ACTION_DOWNLOAD_COMPLETE) return
            val completedId = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L)
            if (completedId == prefs.getLong(PREF_DOWNLOAD_ID, -1L)) {
                handleDownloadState(completedId, launchInstaller = true)
            }
        }
    }

    fun checkForUpdates() {
        ensureReceiver()

        val pendingVersion = prefs.getInt(PREF_VERSION_CODE, -1)
        if (pendingVersion > 0 && pendingVersion <= BuildConfig.VERSION_CODE) {
            clearPendingDownload()
        }

        val pendingId = prefs.getLong(PREF_DOWNLOAD_ID, -1L)
        if (pendingId > 0L) {
            if (handleDownloadState(pendingId, launchInstaller = true)) return
        }

        val now = android.os.SystemClock.elapsedRealtime()
        if (now - lastCheckAt < CHECK_THROTTLE_MS) return
        lastCheckAt = now

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
                val newestVersionCode = VERSION_CODE_PATTERN
                    .find(release.optString("body"))
                    ?.groupValues
                    ?.getOrNull(1)
                    ?.toIntOrNull()
                    ?: return@Thread

                if (newestVersionCode <= BuildConfig.VERSION_CODE) return@Thread

                val expectedName = "Tricorder-0.1.$newestVersionCode.apk"
                val assets = release.optJSONArray("assets") ?: return@Thread
                var downloadUrl: String? = null
                for (i in 0 until assets.length()) {
                    val asset = assets.optJSONObject(i) ?: continue
                    if (asset.optString("name") == expectedName) {
                        downloadUrl = asset.optString("browser_download_url").takeIf { it.isNotBlank() }
                        break
                    }
                }

                val exactUrl = downloadUrl ?: run {
                    postStatus("Update 0.1.$newestVersionCode is not ready yet")
                    return@Thread
                }

                startDownload(newestVersionCode, expectedName, exactUrl)
            } catch (_: Exception) {
                // Update checking is opportunistic; scanner operation continues normally.
            }
        }.start()
    }

    private fun startDownload(versionCode: Int, fileName: String, url: String) {
        val existingVersion = prefs.getInt(PREF_VERSION_CODE, -1)
        val existingId = prefs.getLong(PREF_DOWNLOAD_ID, -1L)
        if (existingVersion == versionCode && existingId > 0L) {
            handleDownloadState(existingId, launchInstaller = true)
            return
        }

        try {
            val request = DownloadManager.Request(Uri.parse(url))
                .setTitle("Tricorder 0.1.$versionCode")
                .setDescription("Downloading app update")
                .setMimeType("application/vnd.android.package-archive")
                .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                .setAllowedOverMetered(true)
                .setAllowedOverRoaming(true)
                .setDestinationInExternalFilesDir(appContext, Environment.DIRECTORY_DOWNLOADS, fileName)

            val id = downloadManager.enqueue(request)
            prefs.edit()
                .putLong(PREF_DOWNLOAD_ID, id)
                .putInt(PREF_VERSION_CODE, versionCode)
                .putString(PREF_FILE_NAME, fileName)
                .apply()

            postStatus("Downloading update 0.1.$versionCode — 0%")
            monitorDownload(id, versionCode)
        } catch (_: Exception) {
            postStatus("Update download could not start")
        }
    }

    private fun monitorDownload(id: Long, versionCode: Int) {
        handler.removeCallbacksAndMessages(null)
        handler.post(object : Runnable {
            override fun run() {
                val query = DownloadManager.Query().setFilterById(id)
                downloadManager.query(query)?.use { cursor ->
                    if (!cursor.moveToFirst()) return@use
                    val state = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    when (state) {
                        DownloadManager.STATUS_RUNNING,
                        DownloadManager.STATUS_PENDING,
                        DownloadManager.STATUS_PAUSED -> {
                            val downloaded = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR))
                            val total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES))
                            val percent = if (total > 0L) ((downloaded * 100L) / total).coerceIn(0L, 100L) else 0L
                            postStatus("Downloading update 0.1.$versionCode — $percent%")
                            handler.postDelayed(this, 500L)
                        }
                        DownloadManager.STATUS_SUCCESSFUL -> handleDownloadState(id, launchInstaller = true)
                        DownloadManager.STATUS_FAILED -> {
                            clearPendingDownload()
                            postStatus("Update download failed")
                        }
                    }
                }
            }
        })
    }

    private fun handleDownloadState(id: Long, launchInstaller: Boolean): Boolean {
        val query = DownloadManager.Query().setFilterById(id)
        try {
            downloadManager.query(query)?.use { cursor ->
                if (!cursor.moveToFirst()) {
                    clearPendingDownload()
                    return false
                }

                return when (cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))) {
                    DownloadManager.STATUS_SUCCESSFUL -> {
                        clearPendingDownload()
                        postStatus("Update downloaded — opening installer")
                        if (launchInstaller) launchInstaller(id)
                        true
                    }
                    DownloadManager.STATUS_FAILED -> {
                        clearPendingDownload()
                        false
                    }
                    else -> {
                        val versionCode = prefs.getInt(PREF_VERSION_CODE, -1)
                        if (versionCode > 0) monitorDownload(id, versionCode)
                        true
                    }
                }
            }
        } catch (_: Exception) {
            clearPendingDownload()
        }
        return false
    }

    private fun launchInstaller(id: Long) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !appContext.packageManager.canRequestPackageInstalls()) {
            postStatus("Allow Tricorder to install updates")
            val settingsIntent = Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${appContext.packageName}")
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            appContext.startActivity(settingsIntent)
            return
        }

        val uri = downloadManager.getUriForDownloadedFile(id) ?: run {
            postStatus("Downloaded update could not be opened")
            return
        }

        try {
            val installIntent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(uri, "application/vnd.android.package-archive")
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            appContext.startActivity(installIntent)
        } catch (_: Exception) {
            postStatus("Downloaded update could not be opened")
        }
    }

    private fun ensureReceiver() {
        if (receiverRegistered) return
        val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            appContext.registerReceiver(downloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            appContext.registerReceiver(downloadReceiver, filter)
        }
        receiverRegistered = true
    }

    private fun clearPendingDownload() {
        prefs.edit()
            .remove(PREF_DOWNLOAD_ID)
            .remove(PREF_VERSION_CODE)
            .remove(PREF_FILE_NAME)
            .apply()
    }

    private fun postStatus(message: String) {
        handler.post { status(message) }
    }
}
