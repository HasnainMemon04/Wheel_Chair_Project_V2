#include <Arduino.h>
#include "esp_freertos_hooks.h"
#include "sensors.h"
#include "network.h"
#include "actuators.h"
#include "ota.h"
#include "config.h"
#include <esp_system.h>
#include <esp_task_wdt.h>

// Global task handles for diagnostic stack tracking
TaskHandle_t sensorPollTaskHandle = NULL;
TaskHandle_t tempTaskHandle = NULL;
TaskHandle_t gpsTaskHandle = NULL;
TaskHandle_t safetySupervisorTaskHandle = NULL;
TaskHandle_t networkTaskHandle = NULL;
TaskHandle_t uploadTelemetryTaskHandle = NULL;

// CPU Load tracking tick counters
volatile uint64_t idleTicksCore0 = 0;
volatile uint64_t idleTicksCore1 = 0;

// Idle task hook callbacks matching esp_freertos_idle_cb_t
bool idleHookCore0() {
    idleTicksCore0++;
    return true; // Call once per tick interrupt when idle
}

bool idleHookCore1() {
    idleTicksCore1++;
    return true; // Call once per tick interrupt when idle
}

static void fatalTaskCreation(const char *taskName) {
    setMotionRelay(false);
    Serial.printf("[Fatal] Could not create critical task: %s\n", taskName);
    delay(2000);
    ESP.restart();
}

void setup() {
    // Initialize Serial Debug Monitor
    Serial.begin(115200);
    delay(1000);
    Serial.println("=================================================");
    Serial.printf(
        "[System] Firmware %s | reset_reason=%d | free_heap=%u\n",
        FW_VERSION,
        static_cast<int>(esp_reset_reason()),
        static_cast<unsigned int>(ESP.getFreeHeap())
    );
    Serial.println("   Smart Rental Wheelchair IoT System (M1)      ");
    Serial.println("=================================================");

    // NOTE: the deliberate crash-on-boot rollback test that used to live here
    // (gated on FW_VERSION == "0.3.0") has been removed — it made every
    // current-version build panic in setup(). The OTA dual-partition + NVS
    // rollback path it validated lives untouched in ota.cpp.

    // Initialize Subsystems
    initSensors();
    initActuators();
    // After initActuators has parked the relay at "powered": if an operator had
    // latched a power cut before the last reboot, put it back. A cut must not be
    // undone by the very fault that caused the restart.
    restorePersistedPowerCut();
    initOTA();
    initNetwork();
    esp_task_wdt_init(TASK_WATCHDOG_TIMEOUT_S, true);

    // Register FreeRTOS idle task hooks to monitor core usage
    esp_register_freertos_idle_hook_for_cpu(idleHookCore0, 0);
    esp_register_freertos_idle_hook_for_cpu(idleHookCore1, 1);

    // =========================================================================
    // CORE 1 Tasks: Application / Real-Time (Strictly non-blocking)
    // =========================================================================

    // 1. Safety Supervisor Task - HIGHEST priority (priority 6) to guarantee safety overrides
    if (xTaskCreatePinnedToCore(
        safetySupervisorTask,
        "SafetySupervisor",
        4096,
        NULL,
        6,
        &safetySupervisorTaskHandle,
        1
    ) != pdPASS) fatalTaskCreation("SafetySupervisor");

    // 2. Sensor Poll Task - Priority 5 (50Hz IMU read, fall/crash detection)
    if (xTaskCreatePinnedToCore(
        sensorPollTask,
        "SensorPollTask",
        4096,
        NULL,
        5,
        &sensorPollTaskHandle,
        1
    ) != pdPASS) fatalTaskCreation("SensorPollTask");

    // 3. GPS Task - Priority 4 (NMEA stream processing and geofence tracking)
    if (xTaskCreatePinnedToCore(
        gpsTask,
        "GPSTask",
        4096,
        NULL,
        4,
        &gpsTaskHandle,
        1
    ) != pdPASS) fatalTaskCreation("GPSTask");

    // 4. Temperature Poll Task - Priority 3 (0.5Hz DS18B20 1-wire polling)
    if (xTaskCreatePinnedToCore(
        tempTask,
        "TempTask",
        4096,
        NULL,
        3,
        &tempTaskHandle,
        1
    ) != pdPASS) fatalTaskCreation("TempTask");

    // =========================================================================
    // CORE 0 Tasks: Network / IO (Blocking operations)
    // =========================================================================

    // 5. Network Task - Priority 4 (WiFi/cellular connectivity management and captive portal server)
    if (xTaskCreatePinnedToCore(
        networkTask,
        "NetworkTask",
        4096,
        NULL,
        4,
        &networkTaskHandle,
        0
    ) != pdPASS) fatalTaskCreation("NetworkTask");

    // 6. Upload Telemetry Task - Priority 3 (HTTPS POST and command piggyback execution)
    if (xTaskCreatePinnedToCore(
        uploadTelemetryTask,
        "UploadTelemetry",
        12288, // 12KB stack for SSL/TLS keep-alive connection context
        NULL,
        3,
        &uploadTelemetryTaskHandle,
        0
    ) != pdPASS) fatalTaskCreation("UploadTelemetry");

    Serial.println("[System] All FreeRTOS Tasks initialized and pinned to dual cores.");
}

void loop() {
    // Nothing to do here; FreeRTOS scheduler handles all tasks
    vTaskDelay(pdMS_TO_TICKS(10000));
}
