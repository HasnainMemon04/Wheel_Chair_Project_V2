#include "network.h"
#include "sensors.h"
#include "actuators.h"
#include "config.h"
#include "wifi_portal.h"
#include "ota.h"
#include "certificates.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <WiFiClientSecure.h>
#include <ArduinoJson.h>
#include <mbedtls/md.h>
#include <algorithm>
#include <vector>
#include <time.h>
#include <sys/time.h>
#include "esp_sntp.h"
#include <lwip/dns.h>
#include <Preferences.h>
#include <SPIFFS.h>
#include <esp_heap_caps.h>

// Global connection state
volatile bool wifiConnected = false;

// Active WiFi credentials (loaded from NVS, or config.h defaults, or the AP portal).
// These replace the compile-time WIFI_SSID/WIFI_PASS at runtime so the device can be
// re-provisioned in the field without reflashing.
static String activeSSID;
static String activePASS;

// Task handles for diagnostic high-water mark reporting
extern TaskHandle_t sensorPollTaskHandle;
extern TaskHandle_t tempTaskHandle;
extern TaskHandle_t gpsTaskHandle;
extern TaskHandle_t safetySupervisorTaskHandle;
extern TaskHandle_t networkTaskHandle;
extern TaskHandle_t uploadTelemetryTaskHandle;

// CPU Load tracking tick counters
extern volatile uint64_t idleTicksCore0;
extern volatile uint64_t idleTicksCore1;

// Shared Secure client and serialization mutex to prevent memory starvation
WiFiClientSecure secureClient;
HTTPClient httpClient; // Global reused HTTP client to enable keep-alive
SemaphoreHandle_t wifiClientMutex = NULL;

// Decoupled safety event queue structure.
// Keep enough inline storage for the largest hardware diagnostic snapshot.
// reportSafetyEvent() still refuses to enqueue anything that would not fit,
// because truncating a JSON object would corrupt the cloud jsonb contract.
struct SafetyEvent {
    char eventType[32];
    char detailJson[1280];
    uint32_t queuedAtMs;
    uint64_t capturedAtMs;
};
QueueHandle_t safetyEventQueue = NULL;

// Cache of recently processed command IDs to deduplicate incoming backlogs
static std::vector<String> processedCmdIds;
static Preferences networkPreferences;
static bool eventFsReady = false;
static uint32_t persistedEventReadOffset = 0;
static const char *EVENT_OUTBOX_PATH = "/event_outbox.bin";

static bool appendPersistedEvent(const SafetyEvent &event) {
    if (!eventFsReady) return false;
    File file = SPIFFS.open(EVENT_OUTBOX_PATH, FILE_APPEND);
    if (!file) return false;
    const size_t written = file.write(
        reinterpret_cast<const uint8_t *>(&event),
        sizeof(SafetyEvent)
    );
    file.close();
    return written == sizeof(SafetyEvent);
}

static bool peekPersistedEvent(SafetyEvent &event) {
    if (!eventFsReady || !SPIFFS.exists(EVENT_OUTBOX_PATH)) return false;
    File file = SPIFFS.open(EVENT_OUTBOX_PATH, FILE_READ);
    if (!file) return false;
    if (persistedEventReadOffset + sizeof(SafetyEvent) > file.size()) {
        file.close();
        SPIFFS.remove(EVENT_OUTBOX_PATH);
        persistedEventReadOffset = 0;
        networkPreferences.putUInt("event_offset", 0);
        return false;
    }
    file.seek(persistedEventReadOffset);
    const size_t read = file.read(
        reinterpret_cast<uint8_t *>(&event),
        sizeof(SafetyEvent)
    );
    file.close();
    return read == sizeof(SafetyEvent);
}

static void markPersistedEventUploaded() {
    persistedEventReadOffset += sizeof(SafetyEvent);
    networkPreferences.putUInt("event_offset", persistedEventReadOffset);

    File file = SPIFFS.open(EVENT_OUTBOX_PATH, FILE_READ);
    const bool complete =
        !file || persistedEventReadOffset + sizeof(SafetyEvent) > file.size();
    if (file) file.close();
    if (complete) {
        SPIFFS.remove(EVENT_OUTBOX_PATH);
        persistedEventReadOffset = 0;
        networkPreferences.putUInt("event_offset", 0);
    }
}

static void loadProcessedCommandIds() {
    processedCmdIds.clear();
    processedCmdIds.reserve(20);
    for (uint8_t i = 0; i < 20; i++) {
        const String key = "cmd_" + String(i);
        if (!networkPreferences.isKey(key.c_str())) continue;
        const String id = networkPreferences.getString(key.c_str(), "");
        if (id.length() > 0) processedCmdIds.push_back(id);
    }
}

static bool wasCommandProcessed(const String &id) {
    for (const auto &processedId : processedCmdIds) {
        if (processedId == id) return true;
    }
    return false;
}

static void rememberProcessedCommand(const String &id) {
    if (id.length() == 0 || wasCommandProcessed(id)) return;
    const uint8_t slot = (
        networkPreferences.isKey("cmd_slot")
            ? networkPreferences.getUChar("cmd_slot", 0)
            : 0
    ) % 20;
    networkPreferences.putString(("cmd_" + String(slot)).c_str(), id);
    networkPreferences.putUChar("cmd_slot", (slot + 1) % 20);
    if (processedCmdIds.size() >= 20) processedCmdIds.erase(processedCmdIds.begin());
    processedCmdIds.push_back(id);
}

// ---------------- Real wall-clock time via SNTP ----------------
// The device used to fabricate timestamps from uptime plus a hard-coded epoch offset, which
// corrupted latency metrics, event ordering, and drifted into the future.
// Now: SNTP syncs after WiFi connects (UTC), re-syncs hourly, and every
// timestamped upload is gated on timeIsSynced() — we NEVER send a made-up
// epoch. If not yet synced, `ts` is omitted and the ingest Edge Function
// stamps the row server-side with now().
static bool sntpConfigured = false;

static void configureSNTP() {
    if (sntpConfigured) return;
    sntpConfigured = true;
    // Re-sync every hour so long-running devices don't drift.
    sntp_set_sync_interval(3600 * 1000);
    configTime(0, 0, "pool.ntp.org", "time.nist.gov"); // UTC, no DST offset
    Serial.println("[Time] SNTP configured (UTC, pool.ntp.org, hourly re-sync).");
}

// Any epoch before 2023-01-01 means SNTP has not completed a sync yet.
static bool timeIsSynced() {
    return time(nullptr) > 1672531200;
}

static uint64_t currentEpochMs() {
    if (!timeIsSynced()) return 0;

    timeval now;
    gettimeofday(&now, nullptr);
    return static_cast<uint64_t>(now.tv_sec) * 1000ULL
        + static_cast<uint64_t>(now.tv_usec / 1000);
}

// Local command representation for parsing
struct LocalCommand {
    String id;
    String cmd;
    String reqId;
    int duration_s;
    int time_left;
    float radius;
    double lat;
    double lng;
    bool use_current_location;
    String ota_url;
    String ota_version;
    String ota_sha256;
    size_t ota_size;
    bool ota_maintenance_override;
    int override_minutes;   // MAINT_OVERRIDE grant length
    bool alreadyProcessed;
};

static int commandPriority(const String &cmd) {
    // Freeing a chair by hand outranks everything: it is the action taken when
    // somebody is trapped or a chair is blocking an exit, and it must not sit
    // behind a queued OTA or geofence write.
    if (cmd == "EMERGENCY_UNLOCK" || cmd == "EMERGENCY_LOCK") return -1;
    // Cutting main power outranks even the brake release: it is the broadest
    // stop available, and it must not queue behind anything.
    if (cmd == "EMERGENCY_POWER_OFF") return -2;
    if (cmd == "EMERGENCY_POWER_ON") return -1;
    if (cmd == "SOS" || cmd == "POWER_OFF") return 0;
    if (cmd == "LOCK" || cmd == "END_SESSION") return 1;
    if (cmd == "CLEAR_SOS" || cmd == "CLEAR_TAMPER") return 2;
    if (cmd == "POWER_ON") return 3;
    if (cmd == "UNLOCK") return 4;
    if (cmd == "SET_GEOFENCE") return 5;
    if (cmd == "OTA") return 6;
    return 4;
}

// HMAC calculation using ESP32's mbedtls
String calculateHMAC(const String &payload, const String &key) {
    byte hmacResult[32];
    mbedtls_md_context_t ctx;
    mbedtls_md_type_t md_type = MBEDTLS_MD_SHA256;

    mbedtls_md_init(&ctx);
    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md_type);
    if (
        info == nullptr
        || mbedtls_md_setup(&ctx, info, 1) != 0
        || mbedtls_md_hmac_starts(
            &ctx,
            reinterpret_cast<const unsigned char *>(key.c_str()),
            key.length()
        ) != 0
        || mbedtls_md_hmac_update(
            &ctx,
            reinterpret_cast<const unsigned char *>(payload.c_str()),
            payload.length()
        ) != 0
        || mbedtls_md_hmac_finish(&ctx, hmacResult) != 0
    ) {
        mbedtls_md_free(&ctx);
        return "";
    }
    mbedtls_md_free(&ctx);

    String hmacStr;
    hmacStr.reserve(64);
    for (int i = 0; i < 32; i++) {
        char str[3];
        sprintf(str, "%02x", hmacResult[i]);
        hmacStr += str;
    }
    return hmacStr;
}

void initNetwork() {
    Serial.println("[Network] Initializing WiFi...");
    WiFi.mode(WIFI_MODE_STA);
    WiFi.disconnect();

    // Reset the previous temporary network (Gemnet-BB) once, then load the
    // original configured network. The token prevents subsequent reboots from
    // overwriting credentials entered later through the provisioning portal.
    resetSavedWiFiCredsOnce("restore-config-default-2026-07-18");

    // Load WiFi credentials: NVS-saved first, else config.h defaults.
    bool haveSaved = loadSavedWiFiCreds(activeSSID, activePASS);
    Serial.printf("[Network] Using %s WiFi creds. SSID: %s\n",
                  haveSaved ? "saved (NVS)" : "default (config.h)", activeSSID.c_str());

    secureClient.setCACert(GTS_ROOT_R4);

    // Bound the TLS handshake. This is the single biggest cause of a chair
    // vanishing from the console for a long stretch.
    //
    // WiFiClientSecure defaults handshake_timeout to 120000ms — two minutes —
    // and httpClient.setTimeout() does NOT cover it: that is the read timeout,
    // applied only once a session exists. So a handshake that stalls (which is
    // what happens when keep-alive lapses on a flaky link) sat inside
    // wifiClientMutex for up to two minutes, blocking telemetry, events, acks
    // and OTA alike. The chair looked disconnected because, as far as the
    // uplink was concerned, it was.
    //
    // The argument is in SECONDS (the API multiplies by 1000). A handshake to a
    // reachable host completes in well under a second; five is generous and
    // caps the damage at a few missed heartbeats instead of a blackout.
    secureClient.setHandshakeTimeout(5);

    // Enable keep-alive on the global HTTP client
    httpClient.setReuse(true);

    // Create the mutex to serialize all HTTPS transactions
    wifiClientMutex = xSemaphoreCreateMutex();
    if (wifiClientMutex == NULL) {
        Serial.println("[Fatal] Could not create HTTPS client mutex.");
        delay(1000);
        ESP.restart();
    }

    // Decoupled queue for safety supervisor / OTA events (non-blocking writes).
    // A complete OTA sends every major stage plus 5% download updates. Keep the
    // full timeline buffered while HTTPS uploads drain it on a weak connection.
    safetyEventQueue = xQueueCreate(40, sizeof(SafetyEvent));
    if (safetyEventQueue == NULL) {
        Serial.println("[Fatal] Could not create safety event queue.");
        delay(1000);
        ESP.restart();
    }

    if (!networkPreferences.begin("network_state", false)) {
        Serial.println("[Fatal] Could not open durable network state.");
        delay(1000);
        ESP.restart();
    }
    loadProcessedCommandIds();
    persistedEventReadOffset = networkPreferences.isKey("event_offset")
        ? networkPreferences.getUInt("event_offset", 0)
        : 0;
    eventFsReady = SPIFFS.begin(true);
    Serial.printf(
        "[Network] TLS verification enabled; durable outbox: %s; command journal: %u IDs.\n",
        eventFsReady ? "ready" : "unavailable",
        static_cast<unsigned int>(processedCmdIds.size())
    );
}

// WiFi Monitor Task: connect with saved creds; after repeated failures open the
// AP config portal ("WheelchairSetup") to capture new creds, then retry forever.
void networkTask(void *pvParameters) {
    uint32_t backoffMs = 2000;
    const uint32_t maxBackoffMs = 60000;

    // How long to keep failing before we open the AP config portal.
    // Each connect attempt below waits up to 10s, so ~3 failed attempts ≈ 30s.
    const int failuresBeforePortal = 3;
    int consecutiveFailures = 0;

    Serial.println("[Tasks] WiFi Task started.");

    while (true) {
        if (WiFi.status() != WL_CONNECTED) {
            wifiConnected = false;
            Serial.printf("[Network] WiFi not connected. Connecting to SSID: %s...\n", activeSSID.c_str());
            WiFi.mode(WIFI_STA);
            WiFi.begin(activeSSID.c_str(), activePASS.c_str());

            // Wait up to 10s for connection
            int retries = 0;
            while (WiFi.status() != WL_CONNECTED && retries < 20) {
                vTaskDelay(pdMS_TO_TICKS(500));
                retries++;
            }

            if (WiFi.status() == WL_CONNECTED) {
                wifiConnected = true;
                backoffMs = 2000;            // Reset backoff
                consecutiveFailures = 0;     // Reset failure counter

                Serial.printf(
                    "[Network] Connected. IP: %s | DNS: %s\n",
                    WiFi.localIP().toString().c_str(),
                    WiFi.dnsIP().toString().c_str()
                );
                configureSNTP();             // Start real wall-clock sync (idempotent)
            } else {
                consecutiveFailures++;
                Serial.printf("[Network] Connection failed (%d/%d).\n",
                              consecutiveFailures, failuresBeforePortal);

                // After ~30s of failure, open the AP portal to re-provision.
                if (consecutiveFailures >= failuresBeforePortal) {
                    Serial.println("[Network] Repeated failures. Opening WiFi setup portal...");
                    Serial.println("[Network] Uploads paused; sensors & safety keep running.");

                    // Blocking portal: runs until the user submits new credentials.
                    // Sensors/safety tasks keep running on their own cores/tasks.
                    bool got = startConfigPortal(0);   // 0 = wait indefinitely

                    if (got) {
                        // Reload the freshly-saved credentials and try again immediately.
                        loadSavedWiFiCreds(activeSSID, activePASS);
                        Serial.printf("[Network] New creds loaded. Reconnecting to SSID: %s...\n",
                                      activeSSID.c_str());
                    }

                    consecutiveFailures = 0;
                    backoffMs = 2000;
                    // Loop straight back to a connect attempt with the new creds.
                } else {
                    Serial.printf("[Network] Backing off for %d ms...\n", backoffMs);
                    vTaskDelay(pdMS_TO_TICKS(backoffMs));
                    backoffMs = min(backoffMs * 2, maxBackoffMs);
                }
            }
        } else {
            wifiConnected = true;

            // Update RSSI in telemetry
            xSemaphoreTake(stateMutex, portMAX_DELAY);
            sharedTelemetry.wifi_rssi = WiFi.RSSI();
            xSemaphoreGive(stateMutex);

            vTaskDelay(pdMS_TO_TICKS(5000)); // Check link status every 5s
        }
    }
}

// Reusable HTTPS request performer (Keep-alive and single-client session reuse)
/**
 * One shared TLS client, so every caller serialises on wifiClientMutex.
 *
 * `mutexWaitMs` exists because they must not all wait forever. Telemetry is the
 * heartbeat the cloud uses to decide whether this chair is alive, so it waits
 * as long as it takes. Events and command acks are queued and retried, so they
 * would rather give up than sit on the mutex while the 1 Hz heartbeat misses
 * its slot — a burst of them used to starve telemetry for 15-20s and the
 * console reported a perfectly healthy chair as disconnected.
 */
int performHTTPSRequest(const String &url, const String &method, const String &payload, const String &sig, String &responseBody,
                        uint32_t mutexWaitMs = UINT32_MAX) {
    if (!wifiConnected) return -1;
    if (!url.startsWith("https://")) {
        Serial.println("[TLS] Rejected non-HTTPS request.");
        return -2;
    }
    if (!timeIsSynced()) {
        static uint32_t lastClockWarningMs = 0;
        if (millis() - lastClockWarningMs > 5000) {
            Serial.println("[TLS] Waiting for SNTP before certificate validation.");
            lastClockWarningMs = millis();
        }
        return -3;
    }
    if (sig.length() != 64) {
        Serial.println("[Network] Refusing request with invalid HMAC.");
        return -4;
    }

    int httpResponseCode = -1;

    const TickType_t mutexWait = (mutexWaitMs == UINT32_MAX)
        ? portMAX_DELAY
        : pdMS_TO_TICKS(mutexWaitMs);

    if (xSemaphoreTake(wifiClientMutex, mutexWait) == pdTRUE) {
        if (!secureClient.connected()) {
            Serial.printf("[TLS] Opening verified TLS session. Free Heap: %d bytes\n", ESP.getFreeHeap());
        }
        if (!httpClient.begin(secureClient, url)) {
            xSemaphoreGive(wifiClientMutex);
            return -5;
        }
        httpClient.setTimeout(HTTPS_TIMEOUT_MS);
        httpClient.addHeader("Content-Type", "application/json");
        httpClient.addHeader("x-device-id", DEVICE_ID);
        httpClient.addHeader("x-device-signature", sig);
        httpClient.addHeader("Connection", "keep-alive"); // Explicit keep-alive header

        if (method == "POST") {
            httpResponseCode = httpClient.POST(payload);
        } else {
            httpResponseCode = httpClient.GET();
        }

        if (httpResponseCode > 0) {
            responseBody = httpClient.getString();
        } else {
            Serial.printf("[Network] HTTPS %s failed: %s\n", method.c_str(), httpClient.errorToString(httpResponseCode).c_str());
            // Hard disconnect only on transport failures to allow fresh handshakes on reconnect
            httpClient.end();
            secureClient.stop();
        }

        xSemaphoreGive(wifiClientMutex);
    } else {
        // Uplink busy. The caller passed a bounded wait precisely so it could
        // be told this instead of blocking the heartbeat; its own queue retries.
        return -6;
    }

    return httpResponseCode;
}

// Forward declaration of command execution engine
void processCommands(const String &jsonResponse);

// Synchronous Event Uploader (called internally by telemetry task)
bool uploadSafetyEvent(const SafetyEvent &event) {
    static uint32_t eventSequence = networkPreferences.isKey("event_seq")
        ? networkPreferences.getUInt("event_seq", 0)
        : 0;
    const uint32_t serializeStartedAt = millis();
    JsonDocument doc;
    doc["kind"] = "event";
    doc["id"] = DEVICE_ID;
    doc["packet_type"] = "event";
    doc["seq"] = ++eventSequence;
    networkPreferences.putUInt("event_seq", eventSequence);
    doc["queue_ms"] = millis() - event.queuedAtMs;
    if (event.capturedAtMs > 0) {
        doc["captured_at_ms"] = event.capturedAtMs;
    }

    xSemaphoreTake(stateMutex, portMAX_DELAY);
    double lat = sharedTelemetry.gps_lat;
    double lng = sharedTelemetry.gps_lng;
    uint32_t uptime = sharedTelemetry.uptime_s;
    xSemaphoreGive(stateMutex);

    // Real unix epoch only when SNTP has synced; otherwise omit ts and let
    // the ingest function stamp the row server-side with now().
    if (timeIsSynced()) {
        doc["ts"] = (uint32_t)time(nullptr);
    }
    doc["up"] = uptime; // uptime is useful context but is NOT a timestamp
    doc["event"] = event.eventType;
    doc["lat"] = lat;
    doc["lng"] = lng;

    JsonDocument detailDoc;
    DeserializationError err = deserializeJson(detailDoc, event.detailJson);
    if (!err) {
        doc["detail"] = detailDoc.as<JsonObject>();
    } else {
        doc["detail"] = event.detailJson;
    }

    String jsonPayload;
    serializeJson(doc, jsonPayload);
    doc["serialize_ms"] = millis() - serializeStartedAt;
    doc["payload_bytes"] = jsonPayload.length();
    jsonPayload = "";
    serializeJson(doc, jsonPayload);
    String signature = calculateHMAC(jsonPayload, DEVICE_KEY);

    String url = String(SUPABASE_URL) + INGEST_PATH;
    String response;
    // Bounded wait: this event is already in a queue that retries, so yielding
    // to the telemetry heartbeat costs a moment's delay, whereas blocking it
    // costs the chair its "online" status in the console.
    int code = performHTTPSRequest(url, "POST", jsonPayload, signature, response, 1500);
    if (code == 200) {
        Serial.printf("[Network] Successfully reported event: %s\n", event.eventType);
        return true;
    } else {
        Serial.printf(
            "[Network] Event upload failed: %s | HTTP %d | Response: %.240s\n",
            event.eventType,
            code,
            response.c_str()
        );
        return false;
    }
}

static void setJsonFloat(JsonDocument& doc, const char* key, float value) {
    if (!isfinite(value)) {
        doc[key] = JsonVariant();
    } else {
        doc[key] = value;
    }
}

// Adaptive ingestion uploader.
void uploadTelemetryTask(void *pvParameters) {
    TickType_t lastWakeTime = xTaskGetTickCount();
    const TickType_t period = pdMS_TO_TICKS(TELEMETRY_LOOP_MS);

    Serial.println("[Tasks] Adaptive telemetry upload task started.");

    int lastUploadCode = -1;
    uint32_t packetSequence = 0;
    uint32_t nextTelemetryDueMs = 0;
    uint32_t lastFullUploadMs = 0;
    uint32_t previousHttpMs = 0;
    uint32_t previousHmacMs = 0;
    TelemetryData localData;
    localData.session_state.reserve(16);
    localData.ota_status.reserve(24);
    localData.ota_last_error.reserve(96);
    String jsonPayload;
    jsonPayload.reserve(2300);
    uint32_t lastCpuSampleMs = millis();
    double maxIdleRateCore0 = 1.0;
    double maxIdleRateCore1 = 1.0;
    uint32_t nextEventAttemptMs = 0;
    uint32_t eventRetryDelayMs = 2000;

    while (true) {
        if ((!wifiConnected || isPortalActive()) && eventFsReady) {
            SafetyEvent eventToPersist;
            uint8_t persistedThisLoop = 0;
            while (
                persistedThisLoop < 2
                && xQueuePeek(safetyEventQueue, &eventToPersist, 0) == pdTRUE
            ) {
                if (!appendPersistedEvent(eventToPersist)) break;
                xQueueReceive(safetyEventQueue, &eventToPersist, 0);
                persistedThisLoop++;
            }
        }

        if (wifiConnected && !isPortalActive()) {
            // Drain durable events first. Remove an event only after a
            // confirmed upload; failed requests remain queued for retry.
            SafetyEvent pendingEv;
            uint8_t eventsDrained = 0;
            bool eventUploadFailed = false;
            const bool eventAttemptDue =
                static_cast<int32_t>(millis() - nextEventAttemptMs) >= 0;
            while (
                eventsDrained < 2
                && eventAttemptDue
            ) {
                if (peekPersistedEvent(pendingEv)) {
                    if (!uploadSafetyEvent(pendingEv)) {
                        eventUploadFailed = true;
                        break;
                    }
                    markPersistedEventUploaded();
                    eventsDrained++;
                    continue;
                }
                if (
                    safetyEventQueue == NULL
                    || xQueuePeek(safetyEventQueue, &pendingEv, 0) != pdTRUE
                ) {
                    break;
                }
                if (!uploadSafetyEvent(pendingEv)) {
                    eventUploadFailed = true;
                    if (eventFsReady && appendPersistedEvent(pendingEv)) {
                        xQueueReceive(safetyEventQueue, &pendingEv, 0);
                    }
                    break;
                }
                xQueueReceive(safetyEventQueue, &pendingEv, 0);
                eventsDrained++;
            }
            if (eventUploadFailed) {
                nextEventAttemptMs = millis() + eventRetryDelayMs;
                eventRetryDelayMs = min<uint32_t>(eventRetryDelayMs * 2, 60000);
            } else if (eventAttemptDue) {
                nextEventAttemptMs = 0;
                eventRetryDelayMs = 2000;
            }

            const uint32_t loopNowMs = millis();
            if (
                nextTelemetryDueMs != 0
                && static_cast<int32_t>(loopNowMs - nextTelemetryDueMs) < 0
            ) {
                vTaskDelayUntil(&lastWakeTime, period);
                continue;
            }

            // 1. Copy shared state under lock
            xSemaphoreTake(stateMutex, portMAX_DELAY);
            localData = sharedTelemetry;
            xSemaphoreGive(stateMutex);

            const bool activeSession =
                localData.in_motion
                || localData.session_state == "ACTIVE"
                || localData.session_state == "EXPIRING"
                || localData.session_state == "ENDING"
                || localData.session_state == "STOPPING"
                || localData.session_state == "SAFE_FAULT"
                || localData.tamper_alarm;
            const bool otaBusy = isOTABusy();
            const uint32_t desiredIntervalMs = otaBusy
                ? TELEMETRY_OTA_MS
                : activeSession
                    ? TELEMETRY_ACTIVE_MS
                    : TELEMETRY_IDLE_MS;
            const bool fullPacket =
                lastFullUploadMs == 0
                || !activeSession
                || otaBusy
                || loopNowMs - lastFullUploadMs >= TELEMETRY_IDLE_MS;
            const uint32_t scheduledAtMs = nextTelemetryDueMs == 0
                ? loopNowMs
                : nextTelemetryDueMs;

            if (fullPacket) {
                lastFullUploadMs = loopNowMs;
            }

            // 2. Serialize to JSON matching API.md §1
            const uint32_t serializeStartedAt = millis();
            JsonDocument doc;
            doc["kind"] = "telemetry";
            doc["id"] = DEVICE_ID;
            doc["packet_type"] = fullPacket ? "full" : "fast";
            doc["seq"] = ++packetSequence;
            doc["queue_ms"] = loopNowMs - scheduledAtMs;
            doc["prev_http_ms"] = previousHttpMs;
            doc["prev_hmac_ms"] = previousHmacMs;
            // Real unix epoch only when SNTP has synced; otherwise omit ts and
            // let the ingest function stamp the row server-side with now().
            if (timeIsSynced()) {
                const uint64_t capturedAtMs = currentEpochMs();
                doc["captured_at_ms"] = capturedAtMs;
                doc["ts"] = static_cast<uint32_t>(capturedAtMs / 1000ULL);
            }
            doc["fw"] = FW_VERSION;
            doc["up"] = localData.uptime_s; // uptime, NOT a timestamp
            doc["fix"] = localData.gps_fix ? 1 : 0;
            doc["gps_simulated"] = localData.gps_simulated ? 1 : 0;
            doc["lat"] = localData.gps_lat;
            doc["lng"] = localData.gps_lng;
            // setJsonFloat emits null for NAN — speed is unknown without a
            // fix, and null says so honestly. A raw assignment would serialise
            // NaN, which is not valid JSON.
            setJsonFloat(doc, "spd", localData.gps_speed_kmh);
            doc["gps_fix"] = localData.gps_fix ? 1 : 0;
            setJsonFloat(doc, "gps_course", localData.gps_course_deg);

            if (fullPacket) {
                doc["sats"] = localData.gps_sats;
                doc["hdop"] = localData.gps_hdop;
                setJsonFloat(doc, "gps_altitude", localData.gps_altitude_m);
                doc["gps_age_ms"] = localData.gps_last_data_ms > 0
                    ? static_cast<int32_t>(millis() - localData.gps_last_data_ms)
                    : -1;
                doc["gps_chars"] = localData.gps_chars_processed;
                doc["gps_sentences"] = localData.gps_sentences_valid;
                doc["gps_checksum_failures"] = localData.gps_checksum_failures;
                // Send null, not "", when there is no sentence to report. An
                // empty string still reads as "the receiver answered" one layer
                // up; null is the only value that means "nothing was received".
                if (localData.gps_nmea_gga[0] != '\0') doc["gps_nmea_gga"] = localData.gps_nmea_gga;
                else doc["gps_nmea_gga"] = nullptr;
                if (localData.gps_nmea_rmc[0] != '\0') doc["gps_nmea_rmc"] = localData.gps_nmea_rmc;
                else doc["gps_nmea_rmc"] = nullptr;
            }

            setJsonFloat(doc, "pitch", localData.pitch);
            setJsonFloat(doc, "roll", localData.roll);
            setJsonFloat(doc, "tilt", localData.tilt);
            setJsonFloat(doc, "yaw", localData.yaw);
            setJsonFloat(doc, "imu_accel_x", localData.imu_accel_x_g);
            setJsonFloat(doc, "imu_accel_y", localData.imu_accel_y_g);
            setJsonFloat(doc, "imu_accel_z", localData.imu_accel_z_g);
            setJsonFloat(doc, "imu_gyro_x", localData.imu_gyro_x_dps);
            setJsonFloat(doc, "imu_gyro_y", localData.imu_gyro_y_dps);
            setJsonFloat(doc, "imu_gyro_z", localData.imu_gyro_z_dps);
                doc["imu_age_ms"] = localData.imu_last_sample_ms > 0
                ? static_cast<int32_t>(millis() - localData.imu_last_sample_ms)
                    : -1;
                doc["imu_valid"] = localData.imu_valid;
                doc["imu_read_failures"] = localData.imu_read_failures;
                // Lets the console distinguish "reads 2 deg because the chair
                // is on a slope" from "reads 2 deg because nobody ever told it
                // what level is".
                doc["imu_calibrated"] = imuIsLevelCalibrated();
            doc["in_motion"] = localData.in_motion ? 1 : 0;
            // Sent on every packet, not just full ones: the console needs to
            // show "muted" the moment it happens, and a muted siren is exactly
            // when an operator most needs to know the chair is still cut out.
            doc["alarm_silenced"] = isAlarmSilenced() ? 1 : 0;
            doc["tamper"] = localData.tamper_alarm ? 1 : 0;
            doc["tamper_count"] = localData.tamper_warn_count;
            // Seconds left on an operator maintenance override (0 = none), so
            // the console can show that the chair is running in degraded mode.
            doc["maint_override_s"] = maintenanceOverrideRemainingS();
            // Emergency wheel unlock. Both fields ride on EVERY packet, not
            // just full ones: free-wheeling is a physical state of the chair,
            // and the console must show it starting and ending without waiting
            // for the next full packet.
            //
            // has_emg_unlock is what lets the console offer the control on the
            // chair that actually has the relay, instead of hardcoding an id.
            doc["has_emg_unlock"] = hasEmergencyWheelUnlock() ? 1 : 0;
            doc["emg_unlock"] = isEmergencyWheelUnlocked() ? 1 : 0;
            // Retained and pinned at 0. The release no longer counts down, but
            // the field is still sent every packet on purpose: the ingest RPC
            // carries an ABSENT key forward, so simply dropping it would freeze
            // whatever the last countdown value happened to be.
            doc["emg_unlock_s"] = 0;
            // Emergency power cut. Also on every packet: a chair whose main
            // power an operator has cut must not look merely idle in the
            // console, and unlike the brake release this one latches, so the
            // console may be showing it for a long time.
            doc["has_pwr_relay"] = hasPowerRelay() ? 1 : 0;
            doc["pwr_cut"] = isPowerCut() ? 1 : 0;
            doc["power"] = localData.power_state ? 1 : 0;
            doc["locked"] = localData.locked_state ? 1 : 0;
            doc["session_state"] = localData.session_state;
            doc["time_left"] = localData.time_left_s;

            if (fullPacket) {
                setJsonFloat(doc, "temp_batt", localData.temp_battery);
                doc["batt_v"] = localData.batt_v;
                doc["batt_pct"] = localData.batt_pct;
                doc["batt_valid"] = localData.batt_valid;
                doc["batt_adc_mv"] = localData.batt_adc_mv;
                doc["temp_valid"] = localData.temp_valid;
                doc["temp_age_ms"] = localData.temp_last_sample_ms > 0
                    ? static_cast<int32_t>(millis() - localData.temp_last_sample_ms)
                    : -1;
                doc["rssi"] = localData.wifi_rssi;
                // NO WiFi.SSID() HERE. Two images died proving this:
                //
                //   1.3.5 called WiFi.SSID() while building this packet.
                //   1.3.6 called it once at connect time, storing the result in a
                //         static buffer instead.
                //
                // Different call sites, different tasks, and NEITHER image ever
                // sent a single telemetry packet — both died before the network
                // came up, with no rollback event and no panic reaching the cloud.
                // 1.3.7 removed the call and booted first time, which isolates it
                // to the WiFi.SSID() call itself rather than how its result was
                // stored. Size was ruled out too: 1.3.6 is smaller than 1.3.3,
                // which boots fine.
                //
                // To report the network name, use the activeSSID String this file
                // already holds and passes to WiFi.begin() — no driver query, so
                // nothing to crash. device_state.ssid and the console label are
                // already in place and will populate as soon as it is sent.
                doc["ota_status"] = localData.ota_status;
                doc["ota_progress"] = localData.ota_progress;
                doc["ota_last_error"] = localData.ota_last_error;
            }

            JsonObject gfObj = doc["gf"].to<JsonObject>();
            gfObj["on"] = localData.gf.on ? 1 : 0;
            gfObj["available"] = localData.gf.available ? 1 : 0;
            gfObj["in"] = localData.gf.inside ? 1 : 0;
            gfObj["dist"] = localData.gf.dist_m;
            gfObj["r"] = localData.gf.radius_m;
            gfObj["lat"] = localData.gf.center_lat;
            gfObj["lng"] = localData.gf.center_lng;

            jsonPayload = "";
            serializeJson(doc, jsonPayload);
            doc["serialize_ms"] = millis() - serializeStartedAt;
            doc["payload_bytes"] = measureJson(doc);
            jsonPayload = "";
            serializeJson(doc, jsonPayload);

            // 3. Compute HMAC-SHA256 signature
            const uint32_t hmacStartedAt = millis();
            String signature = calculateHMAC(jsonPayload, DEVICE_KEY);
            previousHmacMs = millis() - hmacStartedAt;

            // 4. HTTP POST request
            String url = String(SUPABASE_URL) + INGEST_PATH;
            String response;
            const uint32_t httpStartedAt = millis();
            lastUploadCode = performHTTPSRequest(url, "POST", jsonPayload, signature, response);
            previousHttpMs = millis() - httpStartedAt;
            nextTelemetryDueMs = millis() + desiredIntervalMs;

            // 5. Parse and execute piggybacked commands from the telemetry response (near-instant execution)
            if (lastUploadCode == 200) {
                markFirmwareValid(); // Validate boot slot target on successful telemetry POST
                if (response.length() > 0) {
                    processCommands(response);
                }
            }

            if (fullPacket) {
            // 6. Relative CPU load from measured idle-hook rates. The previous
            // code assumed exactly 1000 idle callbacks per second, which is not
            // guaranteed by FreeRTOS.
            static uint64_t lastIdle0 = 0;
            static uint64_t lastIdle1 = 0;
            uint64_t curIdle0 = idleTicksCore0;
            uint64_t curIdle1 = idleTicksCore1;
            uint64_t delta0 = curIdle0 - lastIdle0;
            uint64_t delta1 = curIdle1 - lastIdle1;
            lastIdle0 = curIdle0;
            lastIdle1 = curIdle1;
            const uint32_t cpuNowMs = millis();
            const uint32_t cpuElapsedMs = max(
                static_cast<uint32_t>(1),
                cpuNowMs - lastCpuSampleMs
            );
            lastCpuSampleMs = cpuNowMs;
            const double idleRate0 = delta0 * 1000.0 / cpuElapsedMs;
            const double idleRate1 = delta1 * 1000.0 / cpuElapsedMs;
            maxIdleRateCore0 = max(maxIdleRateCore0, idleRate0);
            maxIdleRateCore1 = max(maxIdleRateCore1, idleRate1);
            const int cpu0Load = constrain(
                static_cast<int>(100.0 - idleRate0 * 100.0 / maxIdleRateCore0),
                0,
                100
            );
            const int cpu1Load = constrain(
                static_cast<int>(100.0 - idleRate1 * 100.0 / maxIdleRateCore1),
                0,
                100
            );

            // Fetch OTA stack diagnostics
            unsigned int otaDownW = 9999, otaSchedW = 9999, otaWatchW = 9999;
            getOTATaskHighWaterMarks(otaDownW, otaSchedW, otaWatchW);

            unsigned int safetyW = (safetySupervisorTaskHandle != NULL) ? uxTaskGetStackHighWaterMark(safetySupervisorTaskHandle) : 9999;
            unsigned int pollW   = (sensorPollTaskHandle != NULL) ? uxTaskGetStackHighWaterMark(sensorPollTaskHandle) : 9999;
            unsigned int gpsW    = (gpsTaskHandle != NULL) ? uxTaskGetStackHighWaterMark(gpsTaskHandle) : 9999;
            unsigned int tempW   = (tempTaskHandle != NULL) ? uxTaskGetStackHighWaterMark(tempTaskHandle) : 9999;
            unsigned int netW    = (networkTaskHandle != NULL) ? uxTaskGetStackHighWaterMark(networkTaskHandle) : 9999;
            unsigned int telW    = (uploadTelemetryTaskHandle != NULL) ? uxTaskGetStackHighWaterMark(uploadTelemetryTaskHandle) : 9999;

            Serial.printf("[Heartbeat] Version: %s | Uptime: %ds | Free Heap: %d bytes | RSSI: %d | Last HTTP: %d | GPS: %s\n",
                          FW_VERSION, localData.uptime_s, ESP.getFreeHeap(), localData.wifi_rssi, lastUploadCode,
                          localData.gps_fix ? "FIX" : "NO_FIX");
            Serial.printf(
                "[Pipeline] seq:%lu type:%s bytes:%u serialize:%ums hmac:%ums http:%ums queue:%ums\n",
                static_cast<unsigned long>(packetSequence),
                fullPacket ? "full" : "fast",
                static_cast<unsigned int>(jsonPayload.length()),
                static_cast<unsigned int>(doc["serialize_ms"] | 0),
                previousHmacMs,
                previousHttpMs,
                loopNowMs - scheduledAtMs
            );
            Serial.printf("[Battery] Voltage: %.2fV | Percent: %d%%\n", localData.batt_v, localData.batt_pct);
            Serial.printf(
                "[Heap] free:%u min:%u largest:%u\n",
                static_cast<unsigned int>(ESP.getFreeHeap()),
                static_cast<unsigned int>(esp_get_minimum_free_heap_size()),
                static_cast<unsigned int>(
                    heap_caps_get_largest_free_block(MALLOC_CAP_8BIT)
                )
            );
            Serial.printf("[CPU Load] Core 0 (Net/IO): %d%% | Core 1 (App/RT): %d%%\n", cpu0Load, cpu1Load);
            Serial.printf("[Stack HighWater] SafetySup: %u | SensPoll: %u | GPS: %u | Temp: %u | Net: %u | Telemetry: %u | OTADown: %u | OTASched: %u | OTAWatch: %u (words)\n",
                          safetyW, pollW, gpsW, tempW, netW, telW, otaDownW, otaSchedW, otaWatchW);

            // Tamper diagnostic
            Serial.printf("[TamperDbg] state:%s locked:%d | vibration:%d | warns:%d alarm:%d\n",
                          localData.session_state.c_str(), localData.locked_state ? 1 : 0,
                          localData.vibration_state ? 1 : 0,
                          localData.tamper_warn_count, localData.tamper_alarm ? 1 : 0);
            }
        }

        vTaskDelayUntil(&lastWakeTime, period);
    }
}

// Shared command execution and acknowledgement engine
void processCommands(const String &jsonResponse) {
    JsonDocument doc;
    DeserializationError err = deserializeJson(doc, jsonResponse);
    if (err) {
        return;
    }

    JsonArray arr;
    if (doc["commands"].is<JsonArray>()) {
        arr = doc["commands"].as<JsonArray>();
    } else if (doc.is<JsonArray>()) {
        arr = doc.as<JsonArray>();
    } else {
        return;
    }

    if (arr.size() == 0) return;

    std::vector<LocalCommand> pendingCmds;
    pendingCmds.reserve(arr.size());
    for (JsonObject cmdObj : arr) {
        String cmdId = cmdObj["id"].as<String>();

        LocalCommand lc;
        lc.id = cmdId;
        lc.cmd = cmdObj["cmd"].as<String>();
        lc.reqId = cmdObj["req_id"].as<String>();

        JsonObject args = cmdObj["args"].as<JsonObject>();
        lc.duration_s = args["duration_s"] | 1200;
        lc.time_left = args["time_left"] | 120;
        lc.radius = args["radius"] | GEOFENCE_RADIUS_M;
        lc.lat = args["lat"] | 24.860048;
        lc.lng = args["lng"] | 67.063734;
        lc.use_current_location = args["use_current_location"] | false;
        lc.override_minutes = args["minutes"] | MAINT_OVERRIDE_DEFAULT_MIN;
        lc.ota_url = args["url"].as<String>();
        lc.ota_version = args["version"].as<String>();
        lc.ota_sha256 = args["sha256"].as<String>();
        lc.ota_size = args["size"] | 0;
        lc.ota_maintenance_override = args["maintenance_override"] | false;
        lc.alreadyProcessed = wasCommandProcessed(cmdId);

        pendingCmds.push_back(lc);
    }

    // Safety commands always preempt state-enabling and maintenance commands.
    std::stable_sort(pendingCmds.begin(), pendingCmds.end(), [](const LocalCommand &a, const LocalCommand &b) {
        return commandPriority(a.cmd) < commandPriority(b.cmd);
    });

    for (const auto &lc : pendingCmds) {
        String cmdId = lc.id;
        String cmd = lc.cmd;
        String reqId = lc.reqId;

        Serial.printf("[Network] Processing command: %s\n", cmd.c_str());

        bool ok = false;
        String commandError;
        uint32_t sessionStartTs = 0;
        uint32_t sessionEndTs = 0;
        bool persistGeofence = false;
        bool clearedManualSOS = false;
        bool commandShouldChirp = true;
        double geofenceToPersistLat = NAN;
        double geofenceToPersistLng = NAN;
        float geofenceToPersistRadius = 0.0f;

        const bool safetySensorsHealthy = areSafetySensorsHealthy();
        const bool safetyFaultActive = isSafetyFaultActive();
        xSemaphoreTake(stateMutex, portMAX_DELAY);
        float tempBatt = sharedTelemetry.temp_battery;
        float tilt = sharedTelemetry.tilt;
        const bool inMotion = sharedTelemetry.in_motion;

        bool hazardActive =
            !safetySensorsHealthy
            || safetyFaultActive
            || (isfinite(tempBatt) && tempBatt > TEMP_HOT_C)
            || (isfinite(tilt) && tilt > TILT_FALL_DEG);
        if (lc.alreadyProcessed) {
            ok = true;
            Serial.printf(
                "[Network] Command %s already executed; resending ACK only.\n",
                cmdId.c_str()
            );
        } else if (cmd == "POWER_ON") {
            if (hazardActive) {
                Serial.println("[Network] Rejected POWER_ON: Safety hazard still active!");
                commandError = "safety_interlock_active";
                ok = false;
            } else {
                cancelControlledStop();
                sharedTelemetry.power_state = true;
                if (sharedTelemetry.session_state == "SAFE_FAULT") {
                    sharedTelemetry.session_state = "LOCKED";
                }
                ok = true;
            }
        } else if (cmd == "POWER_OFF") {
            if (inMotion) {
                requestControlledStop(true);
                sharedTelemetry.power_state = true;
                sharedTelemetry.locked_state = false;
                sharedTelemetry.session_state = "STOPPING";
            } else {
                cancelControlledStop();
                sharedTelemetry.power_state = false;
                sharedTelemetry.locked_state = true;
                sharedTelemetry.session_state = "LOCKED";
            }
            ok = true;
        } else if (cmd == "LOCK") {
            if (inMotion) {
                requestControlledStop(false);
                sharedTelemetry.power_state = true;
                sharedTelemetry.locked_state = false;
                sharedTelemetry.session_state = "STOPPING";
            } else {
                cancelControlledStop();
                sharedTelemetry.locked_state = true;
                sharedTelemetry.session_state = "LOCKED";
            }
            ok = true;
        } else if (cmd == "UNLOCK") {
            if (hazardActive) {
                Serial.println("[Network] Rejected UNLOCK: Safety hazard still active!");
                commandError = "safety_interlock_active";
                ok = false;
            } else {
                cancelControlledStop();
                sharedTelemetry.locked_state = false;
                sharedTelemetry.session_state = "ACTIVE";
                sharedTelemetry.time_left_s = lc.duration_s;
                if (timeIsSynced()) {
                    sessionStartTs = (uint32_t)time(nullptr);
                }
                ok = true;
            }
        } else if (cmd == "SOS") {
            cancelControlledStop();
            sharedTelemetry.session_state = "SAFE_FAULT";
            sharedTelemetry.locked_state = true;
            triggerManualSOS();
            ok = true;
        } else if (cmd == "CLEAR_SOS" || cmd == "CLEAR_TAMPER") {
            clearedManualSOS = isManualSOSActive();
            commandShouldChirp = false;
            clearManualSOS();
            clearTamper();
            sharedTelemetry.tamper_alarm = false;
            sharedTelemetry.tamper_warn_count = 0;
            sharedTelemetry.session_state = isSafetyFaultActive()
                ? "SAFE_FAULT"
                : "LOCKED";
            sharedTelemetry.locked_state = true;
            ok = true;
        } else if (cmd == "MAINT_OVERRIDE") {
            // Operator override for a FAILED/MISSING safety sensor. The device
            // decides: it refuses while it can measure a real hazard, and the
            // grant always expires on its own.
            const uint32_t minutes = lc.override_minutes > 0
                ? (uint32_t)lc.override_minutes
                : MAINT_OVERRIDE_DEFAULT_MIN;
            String refusal;
            xSemaphoreGive(stateMutex);
            const bool granted = requestMaintenanceOverride(minutes, refusal);
            xSemaphoreTake(stateMutex, portMAX_DELAY);
            if (granted) {
                if (!isSafetyFaultActive()) {
                    sharedTelemetry.session_state = "LOCKED";
                }
                reportSafetyEvent(
                    "MAINT_OVERRIDE",
                    "{\"minutes\":" + String(minutes) + ",\"granted\":true}"
                );
                ok = true;
            } else {
                Serial.printf("[Safety] Maintenance override REFUSED: %s\n", refusal.c_str());
                reportSafetyEvent(
                    "MAINT_OVERRIDE_REFUSED",
                    "{\"reason\":\"" + refusal + "\"}"
                );
                ok = false;
            }
        } else if (cmd == "CANCEL_MAINT_OVERRIDE") {
            xSemaphoreGive(stateMutex);
            cancelMaintenanceOverride();
            xSemaphoreTake(stateMutex, portMAX_DELAY);
            reportSafetyEvent("MAINT_OVERRIDE_CANCELLED", "{}");
            ok = true;
        } else if (cmd == "EMERGENCY_UNLOCK") {
            // Releases the electromagnetic wheel brake so the chair can be
            // pushed by hand. Deliberately NOT gated on hazardActive: a fall,
            // an SOS or a dead sensor are precisely when somebody needs to move
            // the chair, and refusing then would make the control useless.
            //
            // What keeps it safe instead is that it is time-boxed, it
            // re-engages by itself, it never survives a reboot, and the
            // condition it was used under is recorded on the event.
            const bool wasInMotion = inMotion;
            xSemaphoreGive(stateMutex);
            String unlockResult;
            const bool released = requestEmergencyWheelUnlock(unlockResult);
            xSemaphoreTake(stateMutex, portMAX_DELAY);

            String escaped = unlockResult;
            escaped.replace("\"", "'");
            reportSafetyEvent(
                released ? "WHEEL_UNLOCK" : "WHEEL_UNLOCK_REFUSED",
                "{\"latching\":1"
                    + String(",\"in_motion\":") + String(wasInMotion ? 1 : 0)
                    + ",\"session_state\":\"" + sharedTelemetry.session_state + "\""
                    + ",\"message\":\"" + escaped + "\"}"
            );
            if (!released) commandError = unlockResult;
            ok = released;
        } else if (cmd == "EMERGENCY_POWER_OFF" || cmd == "EMERGENCY_POWER_ON") {
            // Cuts or restores the chair's MAIN power on its own relay —
            // independent of POWER_OFF/POWER_ON above, which set the logical
            // power_state that drives the motion lock. Both exist on purpose:
            // one decides whether the chair may drive, this one decides whether
            // it has any power at all.
            //
            // Not gated on hazards, for the same reason as the brake release:
            // this is what an operator reaches for WHEN something is wrong. It
            // latches rather than expiring, and the condition it was used under
            // is recorded on the event.
            const bool wantCut = (cmd == "EMERGENCY_POWER_OFF");
            const bool wasInMotion = inMotion;
            const String stateAtUse = sharedTelemetry.session_state;
            xSemaphoreGive(stateMutex);
            String powerResult;
            const bool applied = setPowerCut(wantCut, powerResult);
            xSemaphoreTake(stateMutex, portMAX_DELAY);

            String escaped = powerResult;
            escaped.replace("\"", "'");
            reportSafetyEvent(
                applied
                    ? (wantCut ? "POWER_CUT" : "POWER_RESTORED")
                    : "POWER_CUT_REFUSED",
                "{\"in_motion\":" + String(wasInMotion ? 1 : 0)
                    + ",\"session_state\":\"" + stateAtUse + "\""
                    + ",\"message\":\"" + escaped + "\"}"
            );
            if (!applied) commandError = powerResult;
            ok = applied;
        } else if (cmd == "EMERGENCY_LOCK") {
            // Re-engage early, without waiting for the hold to expire.
            xSemaphoreGive(stateMutex);
            engageEmergencyWheelLock();
            xSemaphoreTake(stateMutex, portMAX_DELAY);
            reportSafetyEvent("WHEEL_LOCK", "{\"manual\":1}");
            ok = true;
        } else if (cmd == "SILENCE_ALARM") {
            // Deliberately NOT CLEAR_SOS: the siren stops, every latch and the
            // motion cut stay exactly as they were. An operator silencing the
            // noise must not accidentally release a chair that is still tipped.
            xSemaphoreGive(stateMutex);
            String silenceResult;
            const bool silenced = silenceAlarm(silenceResult);
            xSemaphoreTake(stateMutex, portMAX_DELAY);

            String escaped = silenceResult;
            escaped.replace("\"", "'");
            reportSafetyEvent(
                silenced ? "ALARM_SILENCED" : "ALARM_SILENCE_REFUSED",
                "{\"message\":\"" + escaped + "\"}"
            );
            if (!silenced) commandError = silenceResult;
            ok = silenced;
        } else if (cmd == "CALIBRATE_IMU") {
            // Takes just over a second of sampling, so the state lock is
            // released first — holding it would stall telemetry and the
            // watchdog for the whole capture.
            xSemaphoreGive(stateMutex);
            String calibrationResult;
            const bool calibrated = calibrateImuLevel(calibrationResult);
            xSemaphoreTake(stateMutex, portMAX_DELAY);

            String escaped = calibrationResult;
            escaped.replace("\"", "'");
            reportSafetyEvent(
                calibrated ? "IMU_CALIBRATED" : "IMU_CALIBRATE_REFUSED",
                "{\"message\":\"" + escaped + "\"}"
            );
            // A refusal is an honest answer, not a transport failure: the
            // device's own reason travels back on the ack so the console can
            // show "hold it still" rather than a generic "command failed".
            if (!calibrated) commandError = calibrationResult;
            ok = calibrated;
        } else if (cmd == "DIAGNOSTIC_RUN") {
            const TelemetryData diagnostic = sharedTelemetry;
            const bool imuConnected = mpuOK && diagnostic.imu_last_sample_ms > 0;
            const int32_t gpsAgeMs = diagnostic.gps_last_data_ms > 0
                ? static_cast<int32_t>(millis() - diagnostic.gps_last_data_ms)
                : -1;
            const int32_t imuAgeMs = diagnostic.imu_last_sample_ms > 0
                ? static_cast<int32_t>(millis() - diagnostic.imu_last_sample_ms)
                : -1;
            const bool gpsConnected = gpsAgeMs >= 0 && gpsAgeMs <= 3000;

            // Release the state lock before JSON allocation and HTTPS upload.
            xSemaphoreGive(stateMutex);

            JsonDocument detailDoc;
            detailDoc["schema_version"] = 4;
            detailDoc["source"] = "esp32s3";
            detailDoc["req_id"] = reqId;
            detailDoc["captured_uptime_s"] = diagnostic.uptime_s;
            JsonObject gpsDetail = detailDoc["gps"].to<JsonObject>();
            gpsDetail["model"] = "NEO-M8N";
            gpsDetail["connected"] = gpsConnected;
            gpsDetail["fix"] = diagnostic.gps_fix;
            gpsDetail["source"] = "neo_m8n";
            gpsDetail["data_age_ms"] = gpsAgeMs;
            gpsDetail["satellites"] = diagnostic.gps_sats;
            gpsDetail["chars_processed"] = diagnostic.gps_chars_processed;
            gpsDetail["sentences_valid"] = diagnostic.gps_sentences_valid;
            gpsDetail["checksum_failures"] = diagnostic.gps_checksum_failures;
            if (isnan(diagnostic.gps_physical_lat)) gpsDetail["latitude"] = nullptr;
            else gpsDetail["latitude"] = diagnostic.gps_physical_lat;
            if (isnan(diagnostic.gps_physical_lng)) gpsDetail["longitude"] = nullptr;
            else gpsDetail["longitude"] = diagnostic.gps_physical_lng;
            gpsDetail["speed_kmh"] = diagnostic.gps_physical_speed_kmh;
            if (isnan(diagnostic.gps_hdop)) gpsDetail["hdop"] = nullptr;
            else gpsDetail["hdop"] = diagnostic.gps_hdop;
            if (isnan(diagnostic.gps_physical_course_deg)) gpsDetail["course_deg"] = nullptr;
            else gpsDetail["course_deg"] = diagnostic.gps_physical_course_deg;
            if (isnan(diagnostic.gps_physical_altitude_m)) gpsDetail["altitude_m"] = nullptr;
            else gpsDetail["altitude_m"] = diagnostic.gps_physical_altitude_m;

            JsonArray nmeaDetail = gpsDetail["nmea"].to<JsonArray>();
            if (diagnostic.gps_nmea_gga[0] != '\0') nmeaDetail.add(diagnostic.gps_nmea_gga);
            if (diagnostic.gps_nmea_rmc[0] != '\0') nmeaDetail.add(diagnostic.gps_nmea_rmc);

            JsonObject imuDetail = detailDoc["imu"].to<JsonObject>();
            imuDetail["model"] = "MPU6500";
            imuDetail["connected"] = imuConnected;
            imuDetail["data_age_ms"] = imuAgeMs;
            imuDetail["motion"] = diagnostic.vibration_state;

            JsonObject accelDetail = imuDetail["accel_g"].to<JsonObject>();
            if (isnan(diagnostic.imu_accel_x_g)) accelDetail["x"] = nullptr;
            else accelDetail["x"] = diagnostic.imu_accel_x_g;
            if (isnan(diagnostic.imu_accel_y_g)) accelDetail["y"] = nullptr;
            else accelDetail["y"] = diagnostic.imu_accel_y_g;
            if (isnan(diagnostic.imu_accel_z_g)) accelDetail["z"] = nullptr;
            else accelDetail["z"] = diagnostic.imu_accel_z_g;

            JsonObject gyroDetail = imuDetail["gyro_dps"].to<JsonObject>();
            if (isnan(diagnostic.imu_gyro_x_dps)) gyroDetail["x"] = nullptr;
            else gyroDetail["x"] = diagnostic.imu_gyro_x_dps;
            if (isnan(diagnostic.imu_gyro_y_dps)) gyroDetail["y"] = nullptr;
            else gyroDetail["y"] = diagnostic.imu_gyro_y_dps;
            if (isnan(diagnostic.imu_gyro_z_dps)) gyroDetail["z"] = nullptr;
            else gyroDetail["z"] = diagnostic.imu_gyro_z_dps;

            JsonObject orientationDetail = imuDetail["orientation_deg"].to<JsonObject>();
            if (isnan(diagnostic.pitch)) orientationDetail["pitch"] = nullptr;
            else orientationDetail["pitch"] = diagnostic.pitch;
            if (isnan(diagnostic.roll)) orientationDetail["roll"] = nullptr;
            else orientationDetail["roll"] = diagnostic.roll;
            if (isnan(diagnostic.yaw)) orientationDetail["yaw"] = nullptr;
            else orientationDetail["yaw"] = diagnostic.yaw;
            if (isnan(diagnostic.tilt)) orientationDetail["tilt"] = nullptr;
            else orientationDetail["tilt"] = diagnostic.tilt;

            JsonObject temperatureDetail = detailDoc["temperature"].to<JsonObject>();
            const int32_t temperatureAgeMs = diagnostic.temp_last_sample_ms > 0
                ? static_cast<int32_t>(millis() - diagnostic.temp_last_sample_ms)
                : -1;
            temperatureDetail["model"] = "DS18B20";
            temperatureDetail["connected"] = diagnostic.temp_valid;
            temperatureDetail["data_age_ms"] = temperatureAgeMs;
            setJsonFloat(detailDoc, "temp_batt_c", diagnostic.temp_battery);

            JsonObject batteryDetail = detailDoc["battery"].to<JsonObject>();
            batteryDetail["measurement_valid"] = diagnostic.batt_valid;
            batteryDetail["adc_mv"] = diagnostic.batt_adc_mv;
            batteryDetail["voltage"] = diagnostic.batt_v;
            batteryDetail["percent"] = diagnostic.batt_pct;
            batteryDetail["display_fallback"] = !diagnostic.batt_valid;

            String detailJson;
            serializeJson(detailDoc, detailJson);
            reportSafetyEvent("DIAGNOSTIC_RESULT", detailJson);
            xSemaphoreTake(stateMutex, portMAX_DELAY);
            ok = true;
        } else if (cmd == "WARN_EXPIRY") {
            if (sharedTelemetry.session_state == "ACTIVE") {
                sharedTelemetry.session_state = "EXPIRING";
                sharedTelemetry.time_left_s = lc.time_left;
                Serial.printf("[Network] Cloud forced state to EXPIRING (time_left: %d)\n", lc.time_left);
            } else {
                Serial.println("[Network] Ignored late WARN_EXPIRY command.");
            }
            ok = true;
        } else if (cmd == "END_SESSION") {
            if (sharedTelemetry.session_state == "ACTIVE" ||
                sharedTelemetry.session_state == "EXPIRING" ||
                sharedTelemetry.session_state == "ENDING" ||
                sharedTelemetry.session_state == "STOPPING") {
                requestControlledStop(false);
                sharedTelemetry.session_state = "STOPPING";
                sharedTelemetry.time_left_s = 0;
                if (timeIsSynced()) {
                    sessionEndTs = (uint32_t)time(nullptr);
                }
                Serial.println("[Network] Cloud forced state to ENDING.");
            } else {
                Serial.println("[Network] Ignored late END_SESSION command.");
            }
            ok = true;
        } else if (cmd == "SET_GEOFENCE") {
            double centerLat = lc.lat;
            double centerLng = lc.lng;

            if (lc.use_current_location) {
                if (sharedTelemetry.gps_fix) {
                    // Resolve the center on-device at execution time. This
                    // avoids network travel error while the chair is moving.
                    centerLat = sharedTelemetry.gps_lat;
                    centerLng = sharedTelemetry.gps_lng;
                } else {
                    commandError = "gps_fix_required";
                }
            }

            const bool coordinatesValid =
                isfinite(centerLat) &&
                isfinite(centerLng) &&
                centerLat >= -90.0 &&
                centerLat <= 90.0 &&
                centerLng >= -180.0 &&
                centerLng <= 180.0;
            const bool radiusValid =
                isfinite(lc.radius) &&
                lc.radius >= 50.0f &&
                lc.radius <= 2000.0f;

            if (!coordinatesValid) {
                commandError = "invalid_coordinates";
            } else if (!radiusValid) {
                commandError = "invalid_radius";
            }

            if (commandError.length() == 0) {
                sharedTelemetry.gf.center_lat = centerLat;
                sharedTelemetry.gf.center_lng = centerLng;
                sharedTelemetry.gf.radius_m = lc.radius;
                sharedTelemetry.gf.on = true;
                sharedTelemetry.gf.available = sharedTelemetry.gps_fix;

                // A fallback coordinate is display continuity, not geofence
                // evidence. Defer enforcement until the next physical GPS fix.
                if (sharedTelemetry.gps_fix) {
                    const double dist = calculateDistance(
                        sharedTelemetry.gps_lat,
                        sharedTelemetry.gps_lng,
                        centerLat,
                        centerLng
                    );
                    sharedTelemetry.gf.dist_m = dist;
                    sharedTelemetry.gf.inside = (dist <= lc.radius);
                } else {
                    sharedTelemetry.gf.dist_m = 0.0f;
                    sharedTelemetry.gf.inside = true;
                    // Keep the non-authoritative display position beside the
                    // requested fence while the physical receiver has no fix.
                    sharedTelemetry.gps_fallback_anchor_lat = centerLat;
                    sharedTelemetry.gps_fallback_anchor_lng = centerLng;
                    sharedTelemetry.gps_fallback_anchor_revision++;
                    if (sharedTelemetry.gps_fallback_anchor_revision == 0) {
                        sharedTelemetry.gps_fallback_anchor_revision = 1;
                    }
                    sharedTelemetry.gps_lat = centerLat;
                    sharedTelemetry.gps_lng = centerLng;
                    // Unknown, not 0.3: there is still no fix here.
                    sharedTelemetry.gps_speed_kmh = NAN;
                    sharedTelemetry.gps_simulated = true;
                }
                persistGeofence = true;
                geofenceToPersistLat = centerLat;
                geofenceToPersistLng = centerLng;
                geofenceToPersistRadius = lc.radius;
                ok = true;
            } else {
                Serial.printf(
                    "[Network] Rejected SET_GEOFENCE: %s\n",
                    commandError.c_str()
                );
            }
        } else if (cmd == "OTA") {
            xSemaphoreGive(stateMutex);
            ok = handleOTACommand(
                lc.ota_url,
                lc.ota_version,
                lc.ota_size,
                lc.ota_sha256,
                lc.ota_maintenance_override
            );
            xSemaphoreTake(stateMutex, portMAX_DELAY);
        } else if (cmd == "PING") {
            ok = true;
        } else {
            Serial.printf("[Network] Unknown command: %s\n", cmd.c_str());
        }

        bool currentPower = sharedTelemetry.power_state;
        bool currentLocked = sharedTelemetry.locked_state;
        String currentSessionState = sharedTelemetry.session_state;
        bool currentGeofenceOn = sharedTelemetry.gf.on;
        bool currentGeofenceInside = sharedTelemetry.gf.inside;
        double currentGeofenceLat = sharedTelemetry.gf.center_lat;
        double currentGeofenceLng = sharedTelemetry.gf.center_lng;
        float currentGeofenceRadius = sharedTelemetry.gf.radius_m;
        xSemaphoreGive(stateMutex);

        if (
            persistGeofence
            && !saveGeofenceConfig(
                geofenceToPersistLat,
                geofenceToPersistLng,
                geofenceToPersistRadius,
                true
            )
        ) {
            ok = false;
            commandError = "geofence_persistence_failed";
            reportSafetyEvent(
                "GEOFENCE_PERSISTENCE_FAILED",
                "{\"reason\":\"nvs_write_failed\"}"
            );
        }

        if (
            !lc.alreadyProcessed
            && ok
            && cmd == "CLEAR_SOS"
            && clearedManualSOS
        ) {
            reportSafetyEvent(
                "SAFETY_ACKNOWLEDGED",
                "{\"source\":\"operator\",\"req_id\":\"" + reqId + "\"}"
            );
        }

        if (!lc.alreadyProcessed && ok) {
            rememberProcessedCommand(cmdId);
        }

        // Apply state changes immediately, except duplicate deliveries which
        // only need their ACK retransmitted.
        if (!lc.alreadyProcessed && ok && (cmd == "POWER_ON" || cmd == "POWER_OFF" || cmd == "LOCK" || cmd == "UNLOCK" || cmd == "SOS" || cmd == "CLEAR_SOS")) {
            applyActuatorStates();
        }

        if (lc.alreadyProcessed) {
            // No duplicate audible acknowledgement.
        } else if (ok && commandShouldChirp) {
            buzzerChirp(1, 80);
        } else {
            buzzerChirp(3, 40); // error chirp
        }

        // 3. Send execution ACK POST immediately
        JsonDocument ackDoc;
        ackDoc["id"] = cmdId;
        ackDoc["req_id"] = reqId;
        ackDoc["ok"] = ok;
        if (commandError.length() > 0) {
            ackDoc["error"] = commandError;
        }
        if (sessionStartTs > 0) {
            ackDoc["session_start_ts"] = sessionStartTs;
        }
        if (sessionEndTs > 0) {
            ackDoc["session_end_ts"] = sessionEndTs;
        }

        JsonObject stateObj = ackDoc["state"].to<JsonObject>();
        stateObj["power"] = currentPower;
        stateObj["locked"] = currentLocked;
        stateObj["session_state"] = currentSessionState;
        if (cmd == "SET_GEOFENCE") {
            JsonObject geofenceObj = stateObj["geofence"].to<JsonObject>();
            geofenceObj["on"] = currentGeofenceOn;
            geofenceObj["inside"] = currentGeofenceInside;
            geofenceObj["lat"] = currentGeofenceLat;
            geofenceObj["lng"] = currentGeofenceLng;
            geofenceObj["radius"] = currentGeofenceRadius;
        }

        String ackPayload;
        serializeJson(ackDoc, ackPayload);
        String ackSig = calculateHMAC(ackPayload, DEVICE_KEY);

        String ackUrl = String(SUPABASE_URL) + COMMANDS_PATH + "/ack";
        String ackResponse;
        // Generous but bounded. An ack matters (the console waits on it), yet
        // not so much that it should hold the uplink past a heartbeat slot —
        // the command poll re-acks anything that did not land.
        performHTTPSRequest(ackUrl, "POST", ackPayload, ackSig, ackResponse, 3000);
    }
}

// Send safety alert event to Supabase queue (fully decoupled to prevent supervisor stalling)
void reportSafetyEvent(const String &eventType, const String &detailJson) {
    if (safetyEventQueue == NULL) return;

    SafetyEvent ev;
    ev.queuedAtMs = millis();
    ev.capturedAtMs = currentEpochMs();
    strncpy(ev.eventType, eventType.c_str(), sizeof(ev.eventType) - 1);
    ev.eventType[sizeof(ev.eventType) - 1] = '\0';

    if (detailJson.length() >= sizeof(ev.detailJson)) {
        // Never enqueue truncated JSON — a chopped object arrives at the cloud
        // as a bare string and corrupts the events.detail jsonb contract.
        // Send a small, valid marker object instead.
        snprintf(ev.detailJson, sizeof(ev.detailJson),
                 "{\"truncated\":true,\"orig_len\":%u}", (unsigned)detailJson.length());
        Serial.printf("[Network] Safety event detail too long (%u bytes) — sent truncation marker.\n",
                      (unsigned)detailJson.length());
    } else {
        strcpy(ev.detailJson, detailJson.c_str());
    }

    if (xQueueSend(safetyEventQueue, &ev, 0) != pdTRUE) {
        Serial.println("[Network] Safety event queue full! Event dropped.");
    }
}
