package com.luckynate.tricorder

import android.content.Context
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

class StateStore(context: Context) {
    private val directory = File(context.filesDir, "state").apply { mkdirs() }
    private val primary = File(directory, "state.json")
    private val previous = File(directory, "state.previous.json")
    private val temporary = File(directory, "state.tmp.json")

    @Synchronized
    fun write(json: String): Boolean {
        if (!isValid(json)) return false
        return try {
            FileOutputStream(temporary, false).use { output ->
                output.write(json.toByteArray(Charsets.UTF_8))
                output.flush()
                output.fd.sync()
            }

            if (primary.exists()) {
                if (previous.exists()) previous.delete()
                if (!primary.renameTo(previous)) {
                    primary.copyTo(previous, overwrite = true)
                    primary.delete()
                }
            }

            if (!temporary.renameTo(primary)) {
                temporary.copyTo(primary, overwrite = true)
                temporary.delete()
            }
            true
        } catch (_: Exception) {
            temporary.delete()
            false
        }
    }

    @Synchronized
    fun readNewestValid(): String? {
        val candidates = listOf(primary, previous)
            .filter { it.isFile }
            .mapNotNull { file ->
                try {
                    val text = file.readText(Charsets.UTF_8)
                    val json = JSONObject(text)
                    if (json.optInt("schemaVersion", -1) != SCHEMA_VERSION) return@mapNotNull null
                    val savedAt = json.optLong("savedAt", 0L)
                    if (savedAt <= 0L) return@mapNotNull null
                    Triple(savedAt, file.lastModified(), text)
                } catch (_: Exception) {
                    null
                }
            }
            .sortedWith(compareByDescending<Triple<Long, Long, String>> { it.first }.thenByDescending { it.second })
        return candidates.firstOrNull()?.third
    }

    private fun isValid(json: String): Boolean {
        return try {
            val parsed = JSONObject(json)
            parsed.optInt("schemaVersion", -1) == SCHEMA_VERSION &&
                parsed.optLong("savedAt", 0L) > 0L &&
                parsed.optJSONObject("engine") != null
        } catch (_: Exception) {
            false
        }
    }

    companion object {
        const val SCHEMA_VERSION = 1
    }
}
