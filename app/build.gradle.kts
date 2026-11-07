plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.developerye.dshm"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.developerye.dshm"
        minSdk = 26
        targetSdk = 34
        versionCode = 3
        versionName = "1.2.0"
    }

    signingConfigs {
        create("release") {
            // Personal sideloaded app: the keystore is committed so every CI build
            // is signed with the same key and can upgrade-install over the last APK.
            storeFile = rootProject.file("keystore.jks")
            storePassword = "dshmobile"
            keyAlias = "dshm"
            keyPassword = "dshmobile"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("META-INF/*.kotlin_module", "META-INF/*.version")
    }

    androidResources {
        // No PNG icon sets: v26 adaptive icons only, minSdk is 26.
        noCompress += listOf("woff2")
    }
}


