// ===========================================================================
//  config.h — single source of firmware configuration
//  Pins come from HARDWARE.md §2. Thresholds from FEATURES.md config table.
//  DO NOT commit real secrets — fill these at flash time / from a private header.
// ===========================================================================
#pragma once

// ------------------------- Identity -------------------------
#ifndef DEVICE_ID
#define DEVICE_ID          "WCHAIR-004"
#endif
// Version scheme restarted at 1.x. Kept three-part on purpose: chairs still
// running older firmware parse the target version with a strict %d.%d.%d
// reader, and a two-part string there is unparseable — which reads as
// "not newer" and silently refuses the OTA.
#define FW_VERSION         "1.2.6"

// ------------------------- WiFi & Supabase Credentials -------
#if __has_include("private_config.h")
#include "private_config.h"
#else
// No private_config.h present. Placeholders so the tree still compiles for
// inspection — not working credentials. Copy private_config.example.h.
#define WIFI_SSID          "YOUR_WIFI_SSID"
#define WIFI_PASS          "YOUR_WIFI_PASSWORD"
#define SUPABASE_URL       "https://YOUR-PROJECT.supabase.co"
#define SUPABASE_ANON_KEY  "your-anon-public-key"
#endif

#define INGEST_PATH        "/functions/v1/ingest"      // POST telemetry/events
#define COMMANDS_PATH      "/functions/v1/commands"    // POST ack; simulator also GETs pending
#define TELEMETRY_IDLE_MS   1000
#define TELEMETRY_ACTIVE_MS 250
#define TELEMETRY_OTA_MS    2000
#define TELEMETRY_LOOP_MS   25

// ------------------------- Reliability ----------------------
#define TASK_WATCHDOG_TIMEOUT_S       12
#define IMU_STALE_TIMEOUT_MS          500
#define TEMP_STALE_TIMEOUT_MS         5000
#define SENSOR_STARTUP_GRACE_MS       8000
#define CONTROLLED_STOP_CONFIRM_MS    1500
#define CONTROLLED_STOP_ALERT_MS      15000
#define STATIONARY_SPEED_KMH          0.5f
#define MOTION_ACCEL_DELTA_MPS2       0.22f
#define MOTION_GYRO_RATE_DPS          10.0f
#define MOTION_CONFIRM_SAMPLES        3
#define MOTION_HOLD_MS                3000

// ------------------------- GPS (NEO-M8N, UART1) --------------
#ifdef GPS_RX_PIN_OVERRIDE
#define GPS_RX_PIN         GPS_RX_PIN_OVERRIDE
#else
#define GPS_RX_PIN         17   // <- ESP32 RX (Switched to GPIO 17)
#endif

#ifdef GPS_TX_PIN_OVERRIDE
#define GPS_TX_PIN         GPS_TX_PIN_OVERRIDE
#else
#define GPS_TX_PIN         18   // -> ESP32 TX (Switched to GPIO 18)
#endif
#ifdef GPS_BAUD_OVERRIDE
#define GPS_BAUD           GPS_BAUD_OVERRIDE
#else
#define GPS_BAUD           9600
#endif

// ------------------------- I2C (MPU6500 6-Axis IMU) -----------
#define I2C_SDA_PIN        9
#define I2C_SCL_PIN        8
#define MPU6500_ADDR       0x68
#define MPU_ACCEL_RANGE_G  4
#define MPU_GYRO_RANGE_DPS 500
#define IMU_FAILURE_LIMIT  5

// ------------------------- Temperature ----------------------
#define ONEWIRE_PIN        10   // Single DS18B20 motor temp sensor (waterproof probe)
#ifndef TEMP_SENSOR_REQUIRED
#define TEMP_SENSOR_REQUIRED 1
#endif


// Anti-tamper (MPU6500) ------------
// Shock and vibration tamper detection. Armed only while the chair is LOCKED.
// A locked/parked chair is stationary; lifting/pushing produces linear
// acceleration and rotating/tilting it produces gyro rate — either crossing
// its threshold counts as one disturbance (same 3-warn / 4th-siren escalation).
#define TAMPER_REFRACTORY_MS     2500  // min gap between counted tamper events (longer refractory)
#define TAMPER_ALARM_AT          4     // 3 warning chirps, 4th => continuous siren
#define TAMPER_MPU_ACCEL_THRESH  4.5f  // m/s^2 deviation from 1g (~0.46g) = heavy shove/lift/shake (increased from 2.5)
#define TAMPER_MPU_GYRO_THRESH   45.0f // deg/s rotation rate = rapid tilting/turning the chair (increased from 30.0)

// ------------------------- Power sense ----------------------
#define BATT_ADC_PIN       2    // ADC1_CH1 (GPIO 2) — via divider
#define BATT_DIVIDER       11.0f
#define BATT_MIN_VALID_V   18.0f
#define BATT_MAX_VALID_V   32.0f
#define BATT_EMPTY_V       21.0f
#define BATT_FULL_V        29.4f
// Explicitly retained for the current prototype hardware. A production pilot
// must set this to 0 and provide a verified battery measurement/BMS feed.
#define ALLOW_BATTERY_DISPLAY_FALLBACK 1
#define ALLOW_UNVERIFIED_BATTERY_FOR_OTA 1

// ------------------------- Actuators ------------------------
#define RELAY_MOTION_PIN   13   // CH2 — motion lock
#define RELAY_ACTIVE_LOW   1    // most modules are active-low
#define BUZZER_PIN         1    // Piezo Buzzer
#define BUZZER_ACTIVE_LOW  0    // 0 = active-high, 1 = active-low
#define STATUS_LED_PIN     21   // Onboard status LED


// ------------------------- Thresholds (FEATURES.md) ---------
#define TEMP_HOT_C         55.0f
#define TEMP_HYSTERESIS_C  5.0f
// Operator maintenance override (degraded-mode running with a failed sensor).
#define MAINT_OVERRIDE_DEFAULT_MIN  15
#define MAINT_OVERRIDE_MAX_MIN      120

#define TILT_WARN_DEG      30.0f
#define TILT_FALL_DEG      50.0f
#define FALL_CONFIRM_MS    750
#define GEOFENCE_RADIUS_M  300.0f
#define GEOFENCE_HYSTERESIS_M 10.0f
#define GEOFENCE_CONFIRM_FIXES 3
#define GPS_FIX_TIMEOUT_MS 2000
#define GPS_MIN_FIX_SATELLITES 4
#define GPS_MAX_FIX_HDOP   8.0f

// How long the receiver may go silent before its last sentences are discarded
// rather than kept on reporting. A healthy module emits GGA/RMC at 1 Hz even
// with no satellites, so several seconds of nothing means the module itself is
// gone — unplugged, unpowered, or a broken RX line — not merely unfixed.
#define GPS_DATA_STALE_MS  6000UL
#define EXPIRY_WARN_S      120
#define OFFLINE_AFTER_S    30   // cloud marks device offline if no telemetry within this window

// ------------------------- Transport / OTA ------------------
// Bounds how long ONE request can hold the shared TLS client, and therefore
// the worst-case gap in the telemetry heartbeat. At 7000 a single stalled POST
// blocked the 1 Hz uplink long enough for the console to call a healthy chair
// disconnected; a small JSON POST that has not answered in 4s is not going to.
#define HTTPS_TIMEOUT_MS          4000
#define OTA_VALIDATION_TIMEOUT_MS 90000
#define OTA_MIN_BATTERY_PCT       30
#define OTA_REQUIRE_SHA256        1
#define OTA_EVENT_FLUSH_MS        5000
