plugins {
    id("com.android.application")
}

val ciBuildNumber = System.getenv("GITHUB_RUN_NUMBER")?.toIntOrNull()
val signingStorePath = System.getenv("TRICORDER_KEYSTORE_PATH")
val signingStorePassword = System.getenv("TRICORDER_KEYSTORE_PASSWORD")
val signingKeyAlias = System.getenv("TRICORDER_KEY_ALIAS")
val signingKeyPassword = System.getenv("TRICORDER_KEY_PASSWORD")
val hasReleaseSigning = listOf(
    signingStorePath,
    signingStorePassword,
    signingKeyAlias,
    signingKeyPassword
).all { !it.isNullOrBlank() }

android {
    namespace = "com.luckynate.tricorder"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.luckynate.tricorder"
        minSdk = 33
        targetSdk = 36
        versionCode = ciBuildNumber ?: 1
        versionName = if (ciBuildNumber != null) "0.1.$ciBuildNumber" else "0.1.0"
    }

    signingConfigs {
        if (hasReleaseSigning) {
            create("release") {
                storeFile = file(signingStorePath!!)
                storePassword = signingStorePassword
                keyAlias = signingKeyAlias
                keyPassword = signingKeyPassword
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.17.0")
}
