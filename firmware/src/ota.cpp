#include "ota.h"
#include "sensors.h"
#include "actuators.h"
#include "network.h"
#include "config.h"
#include "certificates.h"
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include "nvs_flash.h"
#include "nvs.h"
#include <mbedtls/sha256.h>
#include <ctype.h>

// Helper status tracking
static bool otaRunning = false;
static int otaProgressPercent = 0;

struct PendingOTADef {
    bool pending;
    bool maintenanceOverride;
    uint8_t stationaryChecks;
    String url;
    String version;
    String sha256;
    size_t size;
};

static PendingOTADef pendingOTA = {false, false, 0, "", "", "", 0};
static bool startPendingOTA();

static bool isHexSha256(const String &value) {
    if (value.length() != 64) return false;
    for (size_t i = 0; i < value.length(); i++) {
        if (!isxdigit(static_cast<unsigned char>(value[i]))) return false;
    }
    return true;
}

static bool isTrustedFirmwareUrl(const String &url) {
    const String trustedPrefix =
        String(SUPABASE_URL) + "/storage/v1/object/public/firmware/";
    return url.startsWith(trustedPrefix)
        && url.indexOf('\r') < 0
        && url.indexOf('\n') < 0;
}

static bool parseVersion(const String &version, int &major, int &minor, int &patch) {
    const char *start = version.c_str();
    if (*start == 'v' || *start == 'V') start++;

    // Accept "1", "1.1" and "1.1.0" alike, filling the missing places with 0.
    // Requiring all three used to make a two-part version unparseable, and an
    // unparseable version is treated as "not newer" — so publishing a release
    // named 1.1 would have silently rejected every OTA with
    // "downgrade_or_same_version" and no clue as to why.
    major = minor = patch = 0;
    const int fields = sscanf(start, "%d.%d.%d", &major, &minor, &patch);
    return fields >= 1;
}

static bool isVersionNewer(const String &candidate, const String &current) {
    int cMajor, cMinor, cPatch;
    int rMajor, rMinor, rPatch;
    if (!parseVersion(candidate, cMajor, cMinor, cPatch)
        || !parseVersion(current, rMajor, rMinor, rPatch)) {
        return false;
    }
    if (cMajor != rMajor) return cMajor > rMajor;
    if (cMinor != rMinor) return cMinor > rMinor;
    return cPatch > rPatch;
}

static void setOTAStatus(const String &status, int progress, const String &lastError = "") {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    sharedTelemetry.ota_status = status;
    sharedTelemetry.ota_progress = progress;
    sharedTelemetry.ota_last_error = lastError;
    xSemaphoreGive(stateMutex);
}

static void reportOTAStage(const String &stage, const String &message, int progress, const String &version = "") {
    String detail = "{\"stage\":\"" + stage + "\",\"message\":\"" + message + "\",\"progress\":" + String(progress);
    if (version.length() > 0) {
        detail += ",\"version\":\"" + version + "\"";
    }
    detail += "}";

    Serial.printf("[OTA] %s (%d%%)%s%s\n",
                  message.c_str(),
                  progress,
                  version.length() > 0 ? " version " : "",
                  version.length() > 0 ? version.c_str() : "");
    reportSafetyEvent("OTA_STAGE", detail);
}

static void enterOTAMaintenanceMode(const String &version) {
    xSemaphoreTake(stateMutex, portMAX_DELAY);
    sharedTelemetry.power_state = false;
    sharedTelemetry.locked_state = true;
    sharedTelemetry.session_state = "LOCKED";
    sharedTelemetry.time_left_s = 0;
    sharedTelemetry.ota_status = "preparing";
    sharedTelemetry.ota_progress = 0;
    sharedTelemetry.ota_last_error = "";
    xSemaphoreGive(stateMutex);

    // Keep ESP32/WiFi alive, but close the wheelchair actuation system.
    // Motion relay is locked and power state is off until the OTA completes.
    setMotionRelay(false);
    buzzerWrite(false);
    updateRGBLED(0, 0, 0);
    applyActuatorStates();

    reportOTAStage("system_closed", "All system closed for firmware update", 0, version);
}

static void failOTA(const String &reason, const String &message, const String &version = "", int code = 0) {
    setOTAStatus("failed", otaProgressPercent, message);

    String detail = "{\"reason\":\"" + reason + "\"";
    if (code != 0) detail += ",\"code\":" + String(code);
    if (version.length() > 0) detail += ",\"version\":\"" + version + "\"";
    detail += "}";

    reportSafetyEvent("OTA_FAIL", detail);
    reportOTAStage("failed", message, otaProgressPercent, version);
}

bool isOTABusy() {
    return otaRunning;
}

int getOTAPercent() {
    return otaProgressPercent;
}

// Task handles for high-water mark reporting
TaskHandle_t otaDownloadTaskHandle = NULL;
TaskHandle_t otaSchedulerTaskHandle = NULL;
TaskHandle_t otaValWatchdogTaskHandle = NULL;

void getOTATaskHighWaterMarks(unsigned int &downloadWatermark, unsigned int &schedulerWatermark, unsigned int &watchdogWatermark) {
    downloadWatermark = (otaDownloadTaskHandle != NULL) ? uxTaskGetStackHighWaterMark(otaDownloadTaskHandle) : 9999;
    schedulerWatermark = (otaSchedulerTaskHandle != NULL) ? uxTaskGetStackHighWaterMark(otaSchedulerTaskHandle) : 9999;
    watchdogWatermark = (otaValWatchdogTaskHandle != NULL) ? uxTaskGetStackHighWaterMark(otaValWatchdogTaskHandle) : 9999;
}

static uint8_t readNVSBootState() {
    nvs_handle_t handle;
    uint8_t state = 0;
    if (nvs_open("ota_nvs", NVS_READWRITE, &handle) == ESP_OK) {
        nvs_get_u8(handle, "boot_state", &state);
        nvs_close(handle);
    }
    return state;
}

static void writeNVSBootState(uint8_t state) {
    nvs_handle_t handle;
    if (nvs_open("ota_nvs", NVS_READWRITE, &handle) == ESP_OK) {
        nvs_set_u8(handle, "boot_state", state);
        nvs_commit(handle);
        nvs_close(handle);
    }
}

// Did the operator authorise this update despite a known sensor fault?
//
// The post-boot self-test requires areSafetySensorsHealthy(), and a
// maintenance override does not survive a reboot — so a chair with a dead
// probe would download and flash correctly, fail to validate, and roll back
// every time. That makes a broken chair the one chair that cannot be repaired
// over the air, which is backwards. Persisting the operator's decision across
// the reboot is what closes that gap; the rest of the self-test (heap, mutex,
// version match) still has to pass.
static bool readNVSSensorWaiver() {
    nvs_handle_t handle;
    uint8_t waived = 0;
    if (nvs_open("ota_nvs", NVS_READWRITE, &handle) == ESP_OK) {
        nvs_get_u8(handle, "sensor_waiver", &waived);
        nvs_close(handle);
    }
    return waived == 1;
}

static void writeNVSSensorWaiver(bool waived) {
    nvs_handle_t handle;
    if (nvs_open("ota_nvs", NVS_READWRITE, &handle) == ESP_OK) {
        nvs_set_u8(handle, "sensor_waiver", waived ? 1 : 0);
        nvs_commit(handle);
        nvs_close(handle);
    }
}

static uint8_t readNVSBootAttempts() {
    nvs_handle_t handle;
    uint8_t attempts = 0;
    if (nvs_open("ota_nvs", NVS_READWRITE, &handle) == ESP_OK) {
        nvs_get_u8(handle, "boot_attempts", &attempts);
        nvs_close(handle);
    }
    return attempts;
}

static void writeNVSBootAttempts(uint8_t attempts) {
    nvs_handle_t handle;
    if (nvs_open("ota_nvs", NVS_READWRITE, &handle) == ESP_OK) {
        nvs_set_u8(handle, "boot_attempts", attempts);
        nvs_commit(handle);
        nvs_close(handle);
    }
}

static void writeNVSTargetVersion(const String &version) {
    nvs_handle_t handle;
    if (nvs_open("ota_nvs", NVS_READWRITE, &handle) == ESP_OK) {
        nvs_set_str(handle, "target_ver", version.c_str());
        nvs_commit(handle);
        nvs_close(handle);
    }
}

static String readNVSTargetVersion() {
    nvs_handle_t handle;
    char value[32] = {0};
    size_t length = sizeof(value);
    if (nvs_open("ota_nvs", NVS_READONLY, &handle) == ESP_OK) {
        nvs_get_str(handle, "target_ver", value, &length);
        nvs_close(handle);
    }
    return String(value);
}

// Roll back if the new image cannot pass its local safety self-test.
static void otaValidationTimeoutTask(void *pvParameters) {
    vTaskDelay(pdMS_TO_TICKS(OTA_VALIDATION_TIMEOUT_MS));
    
    if (readNVSBootState() == 1) {
        Serial.println("[OTA] Telemetry validation timeout reached! Rolling back new firmware...");
        // Best effort warning event upload before rollback reboot
        reportSafetyEvent("OTA_ROLLED_BACK", "{\"reason\":\"validation_timeout\"}");
        vTaskDelay(pdMS_TO_TICKS(1500));
        
        // Clear NVS state
        writeNVSBootState(0);
        writeNVSBootAttempts(0);
        
        // Point bootloader back to the other slot and reboot
        const esp_partition_t *update_partition = esp_ota_get_next_update_partition(NULL);
        if (update_partition != NULL) {
            esp_ota_set_boot_partition(update_partition);
        }
        esp_restart();
    } else {
        Serial.println("[OTA] Watchdog: App validated successfully. Watchdog exiting.");
    }
    otaValWatchdogTaskHandle = NULL;
    vTaskDelete(NULL);
}

void initOTA() {
    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_partition_t *boot = esp_ota_get_boot_partition();
    if (running && boot) {
        Serial.printf("[OTA] Running partition: %s, Configured boot partition: %s\n", running->label, boot->label);
    }
    const esp_partition_t *p0 = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_0, NULL);
    const esp_partition_t *p1 = esp_partition_find_first(ESP_PARTITION_TYPE_APP, ESP_PARTITION_SUBTYPE_APP_OTA_1, NULL);
    esp_ota_img_states_t s0, s1;
    if (p0 && esp_ota_get_state_partition(p0, &s0) == ESP_OK) {
        Serial.printf("[OTA] Partition app0 (%s) state: %d\n", p0->label, s0);
    }
    if (p1 && esp_ota_get_state_partition(p1, &s1) == ESP_OK) {
        Serial.printf("[OTA] Partition app1 (%s) state: %d\n", p1->label, s1);
    }

    // Custom NVS boot attempt and rollback tracking
    uint8_t boot_state = readNVSBootState();
    if (boot_state == 1) {
        uint8_t attempts = readNVSBootAttempts();
        Serial.printf("[OTA] App booted in validation mode. Attempt: %d\n", attempts);
        if (attempts > 1) {
            Serial.println("[OTA] Critical: App failed to validate on previous boot! Rolling back immediately...");
            const esp_partition_t *update_partition = esp_ota_get_next_update_partition(NULL);
            if (update_partition != NULL) {
                esp_ota_set_boot_partition(update_partition);
            }
            writeNVSBootState(0);
            writeNVSBootAttempts(0);
            esp_restart();
        } else {
            writeNVSBootAttempts(attempts + 1);
            Serial.printf(
                "[OTA] Starting %lu ms validation watchdog.\n",
                static_cast<unsigned long>(OTA_VALIDATION_TIMEOUT_MS)
            );
            if (
                xTaskCreatePinnedToCore(
                    otaValidationTimeoutTask,
                    "ota_val_watchdog",
                    8192,
                    NULL,
                    2,
                    &otaValWatchdogTaskHandle,
                    0
                ) != pdPASS
            ) {
                Serial.println("[OTA] Validation watchdog task creation failed.");
                esp_restart();
            }
        }
    } else {
        Serial.println("[OTA] App booted with active/verified firmware slot.");
    }

    // Task scheduler loop to process deferred updates when the wheelchair is fully stopped
    // Run on Core 0 at priority 1 (lowest)
    if (xTaskCreatePinnedToCore([](void *param) {
        while (true) {
            vTaskDelay(pdMS_TO_TICKS(2000));
            if (pendingOTA.pending && !otaRunning) {
                xSemaphoreTake(stateMutex, portMAX_DELAY);
                bool inMotion = sharedTelemetry.in_motion;
                String sessionState = sharedTelemetry.session_state;
                int batt = sharedTelemetry.batt_pct;
                bool battValid = sharedTelemetry.batt_valid;
                xSemaphoreGive(stateMutex);
#if ALLOW_UNVERIFIED_BATTERY_FOR_OTA
                (void)battValid;
#endif

                bool faults = isOTASafetyFaultActive();
                bool sessionReady = sessionState == "LOCKED" || sessionState == "IDLE";

                // An override genuinely overrides. This used to select the
                // LABEL ("override_waiting" vs "deferred") and then block
                // anyway, so the console offered "Force Maintenance Override &
                // Immediate Download" and delivered neither — a chair with a
                // dead probe waited for a condition that could never clear.
                // A live emergency still blocks, override or not.
                const bool emergency = isOTABlockingEmergency();
                if (emergency || (faults && !pendingOTA.maintenanceOverride)) {
                    pendingOTA.stationaryChecks = 0;
                    setOTAStatus(
                        pendingOTA.maintenanceOverride ? "override_waiting" : "deferred",
                        0,
                        emergency
                            ? "Emergency active — attend to the chair before updating"
                            : "Safety fault active — tick the override to update anyway"
                    );
                    continue;
                }

                if (batt < OTA_MIN_BATTERY_PCT) {
                    pendingOTA.stationaryChecks = 0;
                    setOTAStatus(
                        pendingOTA.maintenanceOverride ? "override_waiting" : "deferred",
                        0,
                        "Battery too low (<30%)"
                    );
                    continue;
                }
#if !ALLOW_UNVERIFIED_BATTERY_FOR_OTA
                if (!battValid) {
                    pendingOTA.stationaryChecks = 0;
                    setOTAStatus("deferred", 0, "Battery measurement unavailable");
                    continue;
                }
#endif

                if (inMotion) {
                    pendingOTA.stationaryChecks = 0;
                    setOTAStatus(
                        pendingOTA.maintenanceOverride ? "override_waiting" : "deferred",
                        0,
                        "Wheelchair is still moving"
                    );
                    continue;
                }

                if (!sessionReady && !pendingOTA.maintenanceOverride) {
                    pendingOTA.stationaryChecks = 0;
                    setOTAStatus("deferred", 0, "Active session must end before OTA");
                    continue;
                }

                pendingOTA.stationaryChecks++;
                if (pendingOTA.stationaryChecks < 2) {
                    // Always report, not just when overriding. This branch used
                    // to be silent on the normal path, so the console kept
                    // showing "idle 0%" while an update was in fact queued and
                    // progressing — indistinguishable from nothing happening,
                    // which is why the OTA looked broken.
                    setOTAStatus(
                        pendingOTA.maintenanceOverride ? "override_waiting" : "deferred",
                        0,
                        "Confirming the chair is stationary"
                    );
                    reportOTAStage(
                        "stationary_check",
                        "Confirming wheelchair remains stationary",
                        0,
                        pendingOTA.version
                    );
                    continue;
                }

                Serial.println("[OTA] Deferred OTA safety conditions met. Starting download...");
                startPendingOTA();
            }
        }
    }, "ota_scheduler", 4096, NULL, 1, &otaSchedulerTaskHandle, 0) != pdPASS) {
        Serial.println("[OTA] Scheduler task creation failed.");
        delay(1000);
        ESP.restart();
    }
}

void markFirmwareValid() {
    if (readNVSBootState() != 1) return;

    const String expectedVersion = readNVSTargetVersion();
    // A waiver only excuses the sensor check — the image must still be the one
    // that was asked for, and the system must still be sound enough to run it.
    const bool sensorsWaived = readNVSSensorWaiver();
    const bool sensorsOk = areSafetySensorsHealthy() || sensorsWaived;
    const bool localSelfTestPassed =
        millis() >= 10000
        && sensorsOk
        && stateMutex != NULL
        && ESP.getFreeHeap() >= 50000
        && (expectedVersion.length() == 0 || expectedVersion == FW_VERSION);
    if (!localSelfTestPassed) {
        static uint32_t lastSelfTestLogMs = 0;
        if (millis() - lastSelfTestLogMs >= 5000) {
            Serial.printf(
                "[OTA] Validation pending: sensors=%d heap=%u expected=%s running=%s\n",
                areSafetySensorsHealthy() ? 1 : 0,
                static_cast<unsigned int>(ESP.getFreeHeap()),
                expectedVersion.c_str(),
                FW_VERSION
            );
            lastSelfTestLogMs = millis();
        }
        return;
    }

    // Keep standard Espressif verification API just in case
    const esp_partition_t *running = esp_ota_get_running_partition();
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(running, &state) == ESP_OK) {
        if (state == ESP_OTA_IMG_PENDING_VERIFY) {
            esp_ota_mark_app_valid_cancel_rollback();
        }
    }
    // Update custom NVS verification state
    uint8_t boot_state = readNVSBootState();
    if (boot_state == 1) {
        writeNVSBootState(0);
        writeNVSBootAttempts(0);
        // One update, one waiver. Clearing it here means the next OTA has to be
        // authorised on its own merits rather than inheriting this one's.
        if (sensorsWaived) {
            writeNVSSensorWaiver(false);
            Serial.println("[OTA] Validated with the operator's sensor waiver; waiver cleared.");
        }
        Serial.println("[OTA] New app validated successfully! Rollback cancelled.");
        setOTAStatus("success", 100);
        reportOTAStage("validated", "New firmware validated successfully", 100, String(FW_VERSION));
        reportSafetyEvent("OTA_SUCCESS", "{\"version\":\"" + String(FW_VERSION) + "\"}");
    }
}

// Background OTA download and flash streaming task (Lowest task priority)
static void otaDownloadTask(void *pvParameters) {
    otaRunning = true;
    otaProgressPercent = 0;
    const uint32_t otaStartedAtMs = millis();

    String url = pendingOTA.url;
    String version = pendingOTA.version;
    String expectedSha256 = pendingOTA.sha256;
    expectedSha256.toLowerCase();
    size_t expectedSize = pendingOTA.size;

    setOTAStatus("downloading", 0);
    reportOTAStage("download_initiated", "Download initiated", 0, version);

    Serial.printf("[OTA] Starting stream OTA. Target URL: %s, version: %s\n", url.c_str(), version.c_str());

    const esp_partition_t *update_partition = esp_ota_get_next_update_partition(NULL);
    if (update_partition == NULL) {
        Serial.println("[OTA] Error: Update partition target not found!");
        failOTA("partition_not_found", "OTA partition not found", version);
        otaRunning = false;
        vTaskDelete(NULL);
        return;
    }

    HTTPClient http;
    WiFiClientSecure secureClient;
    secureClient.setCACert(GTS_ROOT_R4);
    if (!isTrustedFirmwareUrl(url) || !http.begin(secureClient, url)) {
        failOTA("untrusted_url", "Firmware URL is not trusted", version);
        otaRunning = false;
        otaDownloadTaskHandle = NULL;
        vTaskDelete(NULL);
        return;
    }
    http.setTimeout(HTTPS_TIMEOUT_MS);
    int httpCode = http.GET();
    if (httpCode != HTTP_CODE_OK) {
        Serial.printf("[OTA] HTTP GET Failed: %s\n", http.errorToString(httpCode).c_str());
        failOTA("network_issue", "Network issue while downloading firmware", version, httpCode);
        http.end();
        otaRunning = false;
        vTaskDelete(NULL);
        return;
    }

    int contentLength = http.getSize();
    if (expectedSize > 0 && contentLength > 0 && (size_t)contentLength != expectedSize) {
        Serial.printf("[OTA] Content-Length mismatch: got %d, expected %d\n", contentLength, expectedSize);
        failOTA("size_mismatch", "Firmware size mismatch", version);
        http.end();
        otaRunning = false;
        vTaskDelete(NULL);
        return;
    }

    const size_t targetSize = contentLength > 0
        ? static_cast<size_t>(contentLength)
        : expectedSize;
    if (targetSize == 0 || targetSize > update_partition->size) {
        failOTA("invalid_size", "Firmware size is missing or invalid", version);
        http.end();
        otaRunning = false;
        otaDownloadTaskHandle = NULL;
        vTaskDelete(NULL);
        return;
    }

    esp_ota_handle_t ota_handle = 0;
    esp_err_t err = esp_ota_begin(update_partition, targetSize, &ota_handle);
    if (err != ESP_OK) {
        Serial.printf("[OTA] esp_ota_begin failed: %s\n", esp_err_to_name(err));
        failOTA("ota_begin_fail", "OTA install could not start", version, (int)err);
        http.end();
        otaRunning = false;
        otaDownloadTaskHandle = NULL;
        vTaskDelete(NULL);
        return;
    }

    WiFiClient *stream = http.getStreamPtr();
    uint8_t buffer[8192];
    size_t total_written = 0;
    int lastReportedProgress = -5;
    bool streamFailed = false;
    mbedtls_sha256_context shaContext;
    mbedtls_sha256_init(&shaContext);
    if (mbedtls_sha256_starts_ret(&shaContext, 0) != 0) {
        failOTA("sha_init_failed", "Firmware integrity check could not start", version);
        esp_ota_abort(ota_handle);
        http.end();
        otaRunning = false;
        otaDownloadTaskHandle = NULL;
        mbedtls_sha256_free(&shaContext);
        vTaskDelete(NULL);
        return;
    }

    // Stream directly into flash (low RAM consumption)
    while (http.connected() && total_written < targetSize) {
        int available = stream->available();
        if (available > 0) {
            const size_t remaining = targetSize - total_written;
            const int read_len = stream->readBytes(
                buffer,
                min(
                    available,
                    static_cast<int>(min(remaining, sizeof(buffer)))
                )
            );
            if (read_len > 0) {
                esp_err_t write_err = esp_ota_write(ota_handle, buffer, read_len);
                if (write_err != ESP_OK) {
                    Serial.printf("[OTA] esp_ota_write failed: %s\n", esp_err_to_name(write_err));
                    failOTA("flash_write_fail", "Flash write failed", version);
                    streamFailed = true;
                    break;
                }
                if (
                    mbedtls_sha256_update_ret(
                        &shaContext,
                        buffer,
                        static_cast<size_t>(read_len)
                    ) != 0
                ) {
                    failOTA("sha_update_failed", "Firmware integrity check failed", version);
                    streamFailed = true;
                    break;
                }
                total_written += read_len;
                if (targetSize > 0) {
                    otaProgressPercent = (total_written * 100) / targetSize;
                    setOTAStatus("downloading", otaProgressPercent);

                    // Send periodic real progress updates without flooding the cloud.
                    if (otaProgressPercent >= lastReportedProgress + 5 || otaProgressPercent == 100) {
                        lastReportedProgress = otaProgressPercent;
                        const uint32_t elapsedMs = max(
                            static_cast<uint32_t>(1),
                            static_cast<uint32_t>(millis() - otaStartedAtMs)
                        );
                        const uint32_t bytesPerSecond = static_cast<uint32_t>(
                            total_written * 1000ULL / elapsedMs
                        );
                        const String progressDetail =
                            "{\"progress\":" + String(otaProgressPercent) +
                            ",\"bytes\":" + String(static_cast<unsigned int>(total_written)) +
                            ",\"total\":" + String(static_cast<unsigned int>(targetSize)) +
                            ",\"elapsed_ms\":" + String(elapsedMs) +
                            ",\"bytes_per_s\":" + String(bytesPerSecond) +
                            ",\"version\":\"" + version + "\"}";
                        reportSafetyEvent("OTA_PROGRESS", progressDetail);
                        Serial.printf(
                            "[OTA] Downloading %d%% | %u/%d bytes | %u B/s | %u ms\n",
                            otaProgressPercent,
                            static_cast<unsigned int>(total_written),
                            static_cast<unsigned int>(targetSize),
                            bytesPerSecond,
                            elapsedMs
                        );
                    }
                }
            }
        } else {
            // Only yield when the stream is EMPTY to maximize raw bandwidth throughput
            vTaskDelay(pdMS_TO_TICKS(5));
        }
    }

    http.end();
    uint8_t calculatedHash[32] = {0};
    const bool hashFinished =
        mbedtls_sha256_finish_ret(&shaContext, calculatedHash) == 0;
    mbedtls_sha256_free(&shaContext);

    String calculatedSha256;
    calculatedSha256.reserve(64);
    if (hashFinished) {
        for (uint8_t value : calculatedHash) {
            char hex[3];
            snprintf(hex, sizeof(hex), "%02x", value);
            calculatedSha256 += hex;
        }
    }

    if (
        !streamFailed
        && (
            !hashFinished
            || calculatedSha256.length() != 64
            || calculatedSha256 != expectedSha256
        )
    ) {
        Serial.printf(
            "[OTA] SHA-256 mismatch. expected=%s calculated=%s\n",
            expectedSha256.c_str(),
            calculatedSha256.c_str()
        );
        failOTA("sha256_mismatch", "Firmware integrity verification failed", version);
        streamFailed = true;
    }

    bool success = false;
    if (!streamFailed && total_written == targetSize) {
        setOTAStatus("installing", 95);
        reportOTAStage("downloaded", "Firmware downloaded", 100, version);
        reportOTAStage("installing", "Installing firmware image", 95, version);
        esp_err_t end_err = esp_ota_end(ota_handle);
        if (end_err == ESP_OK) {
            esp_err_t boot_err = esp_ota_set_boot_partition(update_partition);
            if (boot_err == ESP_OK) {
                success = true;
            } else {
                Serial.printf("[OTA] Failed to set boot partition: %s\n", esp_err_to_name(boot_err));
                failOTA("boot_target_swap_failed", "Boot target swap failed", version, (int)boot_err);
            }
        } else {
            Serial.printf("[OTA] esp_ota_end failed: %s\n", esp_err_to_name(end_err));
            failOTA("corrupted_firmware", "Firmware image verification failed", version, (int)end_err);
        }
    } else {
        Serial.println("[OTA] Download truncated or aborted!");
        esp_ota_abort(ota_handle);
        if (!streamFailed) {
            failOTA("download_aborted", "Download truncated or aborted", version);
        }
    }

    if (success) {
        Serial.printf(
            "[OTA] OTA upgrade complete! Rebooting after %lu ms event flush...\n",
            static_cast<unsigned long>(OTA_EVENT_FLUSH_MS)
        );
        writeNVSBootState(1);
        writeNVSBootAttempts(1);
        writeNVSTargetVersion(version);
        // Carry the operator's decision across the reboot. Recorded only when
        // the sensors are actually unhealthy right now, so a normal update on
        // a healthy chair never leaves a waiver behind.
        const bool needWaiver = pendingOTA.maintenanceOverride && !areSafetySensorsHealthy();
        writeNVSSensorWaiver(needWaiver);
        if (needWaiver) {
            Serial.println("[OTA] Recording operator sensor waiver for post-boot validation.");
        }
        setOTAStatus("rebooting", 100);
        reportOTAStage("installed", "Firmware installed", 100, version);
        reportOTAStage("reboot", "Rebooting into new firmware", 100, version);
        reportSafetyEvent("OTA_READY", "{\"version\":\"" + version + "\"}");
        vTaskDelay(pdMS_TO_TICKS(OTA_EVENT_FLUSH_MS));
        esp_restart();
    } else {
        otaRunning = false;
        otaDownloadTaskHandle = NULL;
    }

    vTaskDelete(NULL);
}

static bool startPendingOTA() {
    const bool maintenanceOverride = pendingOTA.maintenanceOverride;
    const String version = pendingOTA.version;

    pendingOTA.pending = false;
    pendingOTA.stationaryChecks = 0;

    enterOTAMaintenanceMode(version);
    if (maintenanceOverride) {
        reportOTAStage(
            "stationary_confirmed",
            "Wheelchair stationary. Starting firmware update",
            0,
            version
        );
    }

    const BaseType_t taskCreated = xTaskCreatePinnedToCore(
        otaDownloadTask, "ota_task", 20480, NULL, 1, &otaDownloadTaskHandle, 0
    );
    if (taskCreated != pdPASS) {
        otaDownloadTaskHandle = NULL;
        failOTA("task_start_failed", "OTA task could not start", version);
        return false;
    }

    reportSafetyEvent(
        "OTA_STARTED",
        "{\"target_version\":\"" + version +
            "\",\"maintenance_override\":" +
            String(maintenanceOverride ? "true" : "false") + "}"
    );
    return true;
}

bool handleOTACommand(
    const String &url,
    const String &version,
    size_t size,
    const String &sha256,
    bool maintenanceOverride
) {
    if (otaRunning) {
        Serial.println("[OTA] Rejected command: OTA task is actively downloading.");
        reportSafetyEvent("OTA_DEFERRED", "{\"reason\":\"already_in_progress\",\"target_version\":\"" + version + "\"}");
        return false;
    }

    // Refuse a no-op upgrade. This is reported through the same real device
    // event stream as every other OTA outcome, so the operator never sees a
    // browser-created "started" event without a matching device action.
    if (!isVersionNewer(version, FW_VERSION)) {
        Serial.println("[OTA] Rejected command: target version is not newer.");
        const String message = "Target firmware must be newer than v" + String(FW_VERSION);
        setOTAStatus("deferred", 0, message);
        reportOTAStage("skipped", message, 0, version);
        reportSafetyEvent("OTA_DEFERRED", "{\"reason\":\"downgrade_or_same_version\",\"target_version\":\"" + version + "\"}");
        return false;
    }

    if (!isTrustedFirmwareUrl(url)) {
        setOTAStatus("deferred", 0, "Untrusted firmware URL");
        reportSafetyEvent("OTA_DEFERRED", "{\"reason\":\"untrusted_url\"}");
        return false;
    }

    String normalizedSha256 = sha256;
    normalizedSha256.toLowerCase();
#if OTA_REQUIRE_SHA256
    if (!isHexSha256(normalizedSha256)) {
        setOTAStatus("deferred", 0, "Firmware SHA-256 is required");
        reportSafetyEvent("OTA_DEFERRED", "{\"reason\":\"sha256_required\"}");
        return false;
    }
#endif
    if (size == 0) {
        setOTAStatus("deferred", 0, "Firmware size is required");
        reportSafetyEvent("OTA_DEFERRED", "{\"reason\":\"size_required\"}");
        return false;
    }

    pendingOTA.url = url;
    pendingOTA.version = version;
    pendingOTA.sha256 = normalizedSha256;
    pendingOTA.size = size;
    pendingOTA.maintenanceOverride = maintenanceOverride;
    pendingOTA.stationaryChecks = 0;

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    bool inMotion = sharedTelemetry.in_motion;
    String sessionState = sharedTelemetry.session_state;
    int batt = sharedTelemetry.batt_pct;
    bool battValid = sharedTelemetry.batt_valid;
    xSemaphoreGive(stateMutex);
#if ALLOW_UNVERIFIED_BATTERY_FOR_OTA
    (void)battValid;
#endif

    bool faults = isOTASafetyFaultActive();
    bool sessionReady = sessionState == "LOCKED" || sessionState == "IDLE";

#if !ALLOW_UNVERIFIED_BATTERY_FOR_OTA
    if (!battValid) {
        setOTAStatus("deferred", 0, "Battery measurement unavailable");
        reportSafetyEvent("OTA_DEFERRED", "{\"reason\":\"battery_measurement_unavailable\"}");
        pendingOTA.pending = true;
        return true;
    }
#endif

    if (maintenanceOverride) {
        pendingOTA.pending = true;

        // Naming the actual blocker matters: "Safety fault active" for a
        // condition the override is meant to bypass is what made this look
        // stuck rather than waiting on something specific.
        String waitReason = "Confirming wheelchair is stationary";
        if (isOTABlockingEmergency()) {
            waitReason = "Emergency active — attend to the chair before updating";
        } else if (batt < OTA_MIN_BATTERY_PCT) {
            waitReason = "Battery too low (<30%)";
        } else if (inMotion) {
            waitReason = "Wheelchair is still moving";
        }

        setOTAStatus("override_waiting", 0, waitReason);
        reportSafetyEvent(
            "OTA_OVERRIDE_REQUESTED",
            "{\"target_version\":\"" + version +
                "\",\"previous_session_state\":\"" + sessionState + "\"}"
        );
        reportOTAStage(
            "override_waiting",
            "Maintenance override accepted. Waiting for a controlled stop",
            0,
            version
        );
        return true;
    }

    // Check wheelchair safety interlocks (only run when stationary, locked/idle, no alarms)
    if (inMotion || !sessionReady || faults) {
        Serial.println("[OTA] Safety interlocks active. Deferring OTA command.");
        const String reason = faults
            ? "Safety fault active"
            : inMotion
                ? "Wheelchair is still moving"
                : "Active session must end before OTA";
        setOTAStatus("deferred", 0, reason);
        pendingOTA.pending = true;

        reportSafetyEvent("OTA_DEFERRED", "{\"reason\":\"safety_interlocks\",\"target_version\":\"" + version + "\"}");
        return true;
    }

    // Enforce battery charge rule (>30% required to write to flash safely)
    if (batt < OTA_MIN_BATTERY_PCT) {
        Serial.println("[OTA] Battery level too low (<30%). Deferring OTA command.");
        setOTAStatus("deferred", 0, "Battery too low (<30%)");
        pendingOTA.pending = true;

        reportSafetyEvent("OTA_DEFERRED", "{\"reason\":\"battery_low\",\"target_version\":\"" + version + "\"}");
        return true;
    }

    return startPendingOTA();
}
